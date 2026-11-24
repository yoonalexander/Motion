import { readFile } from "node:fs/promises";
import { PDFDocument, StandardFonts } from "pdf-lib";
import { getDocument } from "pdfjs-dist";
import { describe, expect, it } from "vitest";
import { extractDocumentText } from "@/lib/pdf/text-extractor";
import {
  parseCandidateRow,
  parseDocumentCandidates,
  type StatementContext,
} from "@/lib/pdf/transaction-parser";
import { reconstructDocument, type CandidateTransactionRow } from "@/lib/pdf/text-reconstructor";

function row(str: string, multiline = false): CandidateTransactionRow {
  return {
    rowId: "p1-r0",
    page: 1,
    lineIds: [],
    tokenIds: [],
    bbox: [0.1, 0.75, 0.9, 0.8],
    str,
    hasDateLikeField: true,
    hasAmountLikeField: true,
    multiline,
    diagnostics: [],
  };
}

describe("extracting exact statement fields", () => {
  it("keeps a merchant acronym and store number in a date-first row", () => {
    const str = "01/15/2026 GAP 24 45.85";
    const result = parseCandidateRow(row(str), { currency: "USD" });

    expect((result.transaction ?? result.partial).billedAmount).toEqual({
      amountMinor: "4585",
      currency: "USD",
      exponent: 2,
    });
    expect(result.rawFields.fieldSpans?.billedAmount).toMatchObject({
      raw: "45.85",
      start: 18,
      end: 23,
    });
    expect(result.rawFields.detectedMerchant).toBe("GAP 24");
  });

  it("retains ambiguous monetary source spans without choosing a billed amount", () => {
    const str = "01/15/2026 MARKET 25.00 49.00";
    const result = parseCandidateRow(row(str), { currency: "USD" });

    expect(result.transaction).toBeUndefined();
    expect(result.rawFields.fieldSpans?.amounts.map((span) => span.raw)).toEqual([
      "25.00",
      "49.00",
    ]);
    expect(result.rawFields.fieldSpans?.billedAmount).toBeUndefined();
    expect(result.flags).toContain("ambiguous_amount");
  });

  it("retains a possible currency prefix for review when no money cell disambiguates it", () => {
    const str = "01/15/2026 STORE USD 45.85";
    const result = parseCandidateRow(row(str), { currency: "CAD" });

    expect(result.flags).toContain("ambiguous_amount");
    expect(result.transaction).toBeUndefined();
    expect(result.rawFields.fieldSpans?.amounts).toEqual([
      expect.objectContaining({ raw: "USD 45.85" }),
    ]);
  });

  it("keeps an original FX amount distinct from the billed amount", () => {
    const str = "01/15/2026 01/16/2026 GAP $22.00 | Original purchase: 15.99 USD | Billed in CAD";
    const result = parseCandidateRow(row(str, true), { dateOrder: "MDY", currency: "CAD" });

    expect(result.transaction ?? result.partial).toMatchObject({
      transactionDate: "2026-01-15",
      postingDate: "2026-01-16",
      billedAmount: { amountMinor: "2200", currency: "CAD" },
      originalAmount: { amountMinor: "1599", currency: "USD" },
      rawDescription: "GAP",
    });
    const fields = result.rawFields.fieldSpans;
    expect(fields?.originalAmount?.raw).toBe("15.99 USD");
    expect(fields?.description.map((span) => span.raw)).toEqual(["GAP"]);
  });
});

async function parsePdf(data: Uint8Array, context: StatementContext) {
  const task = getDocument({ data, useSystemFonts: true });
  try {
    const extracted = await extractDocumentText(await task.promise);
    return parseDocumentCandidates(reconstructDocument(extracted), context).candidates;
  } finally {
    await task.destroy();
  }
}

async function parseFixture(name: string, context: StatementContext) {
  const bytes = await readFile(`tests/fixtures/synthetic/${name}`);
  return parsePdf(new Uint8Array(bytes), context);
}

describe("positioned fields from real PDFs", () => {
  it("uses reordered headers and keeps the complete printed currency field", async () => {
    const document = await PDFDocument.create();
    const font = await document.embedFont(StandardFonts.Helvetica);
    const page = document.addPage([600, 800]);
    for (const [x, header, value] of [
      [48, "POST DATE", "01/16/2026"],
      [130, "TRANS DATE", "01/15/2026"],
      [230, "DESCRIPTION", "STORE 24"],
      [460, "AMOUNT", "USD 125.50"],
    ] as const) {
      page.drawText(header, { x, y: 625, font, size: 10 });
      page.drawText(value, { x, y: 600, font, size: 10 });
    }

    const [parsed] = await parsePdf(await document.save(), { currency: "CAD" });

    expect(parsed.transaction ?? parsed.partial).toMatchObject({
      transactionDate: "2026-01-15",
      postingDate: "2026-01-16",
      billedAmount: { amountMinor: "12550", currency: "USD" },
      rawDescription: "STORE 24",
    });
    expect(parsed.rawFields.fieldSpans?.billedAmount).toMatchObject({
      raw: "USD 125.50",
      anchor: { tokenIds: [expect.any(String)] },
    });
  });

  it("retains an unreadable value printed under the posting date header for review", async () => {
    const document = await PDFDocument.create();
    const font = await document.embedFont(StandardFonts.Helvetica);
    const page = document.addPage([600, 800]);
    for (const [x, header, value] of [
      [48, "TRANS DATE", "01/15/2026"],
      [145, "POST DATE", "UNCLEAR"],
      [245, "DESCRIPTION", "REFUND RECEIVED"],
      [460, "AMOUNT", "32.00 CR"],
    ] as const) {
      page.drawText(header, { x, y: 625, font, size: 10 });
      page.drawText(value, { x, y: 600, font, size: 10 });
    }

    const [parsed] = await parsePdf(await document.save(), { currency: "USD" });

    expect(parsed.resolution).toBe("unresolved");
    expect(parsed.transaction).toBeUndefined();
    expect(parsed.partial?.rawDescription).toBe("REFUND RECEIVED");
    expect(parsed.rawFields.fieldSpans?.postingDate).toMatchObject({
      raw: "UNCLEAR",
      anchor: { tokenIds: [expect.any(String)] },
    });
    expect(parsed.diagnostics).toContain("ambiguous_posting_date_format");
  });

  it("uses Cedar Bank's debit and credit columns while retaining two date anchors", async () => {
    const rows = await parseFixture("layout-b-text.pdf", { currency: "GBP", dateOrder: "DMY" });
    const order = rows.find((entry) => entry.str.includes("ORDER 88421"));
    const refund = rows.find((entry) => entry.str.includes("REFUND - CLOTHING STORE"));

    expect(order?.transaction).toMatchObject({
      transactionDate: "2026-09-06",
      postingDate: "2026-09-08",
      billedAmount: { amountMinor: "4599", currency: "GBP" },
      rawDescription: "ONLINE RETAILER ORDER 88421",
      transactionType: "purchase",
      direction: "debit",
    });
    expect(order?.rawFields.amountDirection).toBe("debit");
    expect(refund?.rawFields.amountDirection).toBe("credit");
    expect(refund?.transaction?.billedAmount.amountMinor).toBe("3200");
    const fields = order?.rawFields.fieldSpans;
    expect(fields?.description.map((span) => span.raw)).toEqual(["ONLINE RETAILER", "ORDER 88421"]);
    for (const span of [fields?.transactionDate, fields?.postingDate, fields?.billedAmount]) {
      expect(span?.anchor?.page).toBe(1);
      expect(span?.anchor?.tokenIds).toHaveLength(1);
      expect(order?.str.slice(span?.start, span?.end)).toBe(span?.raw);
    }
    expect(
      new Set(
        [fields?.transactionDate, fields?.postingDate, fields?.billedAmount].flatMap(
          (span) => span?.anchor?.tokenIds ?? [],
        ),
      ).size,
    ).toBe(3);
  });

  it("keeps a signed Maple Card amount and its numeric merchant name", async () => {
    const rows = await parseFixture("layout-a-text.pdf", {
      currency: "CAD",
      dateOrder: "MDY",
      positiveAmountDirection: "credit",
    });
    const gas = rows.find((entry) => entry.str.includes("GAS STATION 24"));
    const coffee = rows.find((entry) => entry.str.includes("COFFEE HOUSE DOWNTOWN"));

    expect(gas?.transaction).toMatchObject({
      rawDescription: "GAS STATION 24",
      transactionType: "purchase",
      direction: "debit",
    });
    expect(coffee?.transaction?.transactionType).toBe("purchase");
    expect(gas?.rawFields.amountSignNegative).toBe(true);
    expect(gas?.rawFields.fieldSpans?.billedAmount).toMatchObject({
      raw: "-52.10",
      anchor: { page: 1, tokenIds: [expect.any(String)] },
    });
  });

  it("classifies printed Motion statement labels with the documented sign convention", async () => {
    const rows = await parseFixture("motion-synthetic-credit-card-statement.pdf", {
      dateOrder: "MDY",
      periodStart: "2026-10-01",
      periodEnd: "2026-10-31",
      periodVerified: true,
      positiveAmountDirection: "debit",
    });

    for (const [description, transactionType, direction] of [
      ["MONTHLY CARD PAYMENT", "payment", "credit"],
      ["PAYMENT RECEIVED - THANK YOU", "payment", "credit"],
      ["ONLINE RETAILER RETURN", "refund", "credit"],
      ["RESTAURANT AUTHORIZED CREDIT", "refund", "credit"],
      ["BANK SERVICE ADJUSTMENT", "adjustment", "credit"],
      ["FOREIGN TRANSACTION FEE", "fee", "debit"],
    ] as const) {
      const candidate = rows.find((entry) => entry.str.includes(description));
      expect(candidate?.transaction).toMatchObject({
        rawDescription: description,
        transactionType,
        direction,
      });
    }
  });

  it("retains all printed Motion original amounts outside the billed column", async () => {
    const rows = await parseFixture("motion-synthetic-credit-card-statement.pdf", {
      dateOrder: "MDY",
    });
    const foreign = rows.filter((entry) => entry.str.includes("Original purchase:"));

    expect(foreign.map((entry) => entry.rawFields.detectedOriginalAmount)).toEqual([
      { amountMinor: "1599", currency: "USD", exponent: 2 },
      { amountMinor: "11500", currency: "USD", exponent: 2 },
      { amountMinor: "1095", currency: "GBP", exponent: 2 },
    ]);
    for (const { rawFields } of foreign) {
      expect(rawFields.detectedCurrency).toBe("CAD");
      expect(rawFields.fieldSpans?.billedAmount?.anchor?.tokenIds).toHaveLength(1);
      expect(rawFields.fieldSpans?.originalAmount?.anchor?.tokenIds?.length).toBeGreaterThan(0);
      expect(rawFields.detectedMerchant).not.toContain("Original purchase");
    }
  });
});
