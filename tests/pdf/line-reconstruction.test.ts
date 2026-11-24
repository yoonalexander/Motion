import { readFile } from "node:fs/promises";
import { getDocument } from "pdfjs-dist";
import { describe, expect, it } from "vitest";
import {
  extractDocumentText,
  type ExtractedPage,
  type ExtractedToken,
} from "@/lib/pdf/text-extractor";
import { lineToAnchor, reconstructDocument, reconstructPage } from "@/lib/pdf/text-reconstructor";
import { parseDocumentCandidates } from "@/lib/pdf/transaction-parser";

function statementPage(height: number, rotation = 0) {
  const width = 600;
  const tokens: ExtractedToken[] = [];

  function draw(id: string, str: string, x: number, y: number, advance: number, size = 10) {
    tokens.push({
      tokenId: id,
      page: 1,
      str,
      x: x / width,
      y: y / height,
      bbox: [
        x / width,
        (y - size * 0.2) / height,
        (x + advance) / width,
        (y + size * 0.8) / height,
      ],
      baselineEnd: [(x + advance) / width, y / height],
      width: advance,
      height: size,
      hasEOL: false,
    });
  }

  return { draw, page: { page: 1, width, height, rotation, tokens } satisfies ExtractedPage };
}

function parsePage(page: ReturnType<typeof reconstructPage>) {
  return parseDocumentCandidates(
    { pageCount: 1, pages: [page] },
    { currency: "CAD", dateOrder: "MDY", positiveAmountDirection: "debit" },
  ).candidates;
}

describe("visual line reconstruction", () => {
  it.each([
    { height: 800, spacing: 10, rotation: 0 },
    { height: 800, spacing: 12, rotation: 90 },
    { height: 1200, spacing: 16, rotation: 0 },
  ])(
    "separates rows $spacing points apart on a $height-point page",
    ({ height, spacing, rotation }) => {
      const { page, draw } = statementPage(height, rotation);

      // Deliberately draw out of order, with mixed fonts and slightly offset baselines.
      draw("amount-2", "22.00", 510, 600 - spacing, 34, 8);
      draw("merchant-1", "COFFEE HOUSE", 154, 601, 95, 14);
      draw("date-2", "09/02/2026", 48, 600 - spacing, 58);
      draw("amount-1", "10.00", 432, 600, 30, 9);
      draw("merchant-2", "BOOKSTORE", 154, 600 - spacing, 80);
      draw("date-1", "09/01/2026", 48, 600, 58);

      const result = reconstructPage(page);

      expect(result.lines.map((line) => line.str)).toEqual([
        "09/01/2026 COFFEE HOUSE 10.00",
        "09/02/2026 BOOKSTORE 22.00",
      ]);
      expect(result.candidates.map((row) => row.tokenIds)).toEqual([
        ["date-1", "merchant-1", "amount-1"],
        ["date-2", "merchant-2", "amount-2"],
      ]);
      expect(lineToAnchor(result.lines[0])).toMatchObject({
        page: 1,
        tokenIds: ["date-1", "merchant-1", "amount-1"],
      });
    },
  );

  it("follows consecutive description baselines and leaves totals outside transactions", () => {
    const { page, draw } = statementPage(800);
    draw("date-1", "09/01/2026", 48, 600, 58);
    draw("posted-1", "09/02/2026", 118, 600, 58);
    draw("merchant-1", "ONLINE RETAILER", 188, 600, 90);
    draw("amount-1", "17.99", 442, 600, 28);
    draw("wrap-1", "ORDER 88421", 188, 587, 65, 9);
    draw("wrap-2", "Original purchase: 15.99 USD | Billed in CAD", 194, 574, 202, 9);
    draw("total", "Closing balance 240.00", 188, 561, 145);
    draw("date-2", "09/04/2026", 48, 545, 58);
    draw("posted-2", "09/05/2026", 118, 545, 58);
    draw("merchant-2", "BOOKSTORE", 188, 545, 70);
    draw("amount-2", "22.00", 508, 545, 28);

    const result = reconstructPage(page);
    expect(result.candidates).toHaveLength(2);
    const [first, second] = result.candidates;
    const total = result.lines.find((line) => line.tokenIds.includes("total"));

    expect(first.tokenIds).toEqual([
      "date-1",
      "posted-1",
      "merchant-1",
      "amount-1",
      "wrap-1",
      "wrap-2",
    ]);
    expect(first.lineIds).toHaveLength(3);
    expect(first.diagnostics).toContain("multiline_description");
    expect(first.diagnostics).toContain("long_multiline");
    expect(first.diagnostics).toContain("outside_detected_table");
    expect(parsePage(result)[0].transaction?.reviewStatus).toBe("ready");
    expect(second.tokenIds).toEqual(["date-2", "posted-2", "merchant-2", "amount-2"]);
    expect(result.unmatchedLineIds).toContain(total?.lineId);
  });

  it("keeps angled text separately reviewable without interrupting an aligned wrap", () => {
    const { page, draw } = statementPage(800);
    draw("date", "09/01/2026", 48, 600, 58);
    draw("merchant", "ONLINE RETAILER", 188, 600, 90);
    draw("amount", "17.99", 442, 600, 28);
    draw("wrap", "ORDER 88421", 188, 587, 65, 9);
    draw("watermark", "SYNTHETIC TEST DATA", 260, 621, 77, 14);
    page.tokens[4].baselineEnd = [337 / 600, 565 / 800];
    page.tokens[4].bbox = [255 / 600, 562 / 800, 341 / 600, 636 / 800];

    const result = reconstructPage(page);
    const watermark = result.lines.find((line) => line.tokenIds.includes("watermark"));

    expect(result.candidates.map((row) => row.tokenIds)).toEqual([
      ["date", "merchant", "amount", "wrap"],
    ]);
    expect(watermark?.diagnostics).toContain("non_horizontal_baseline");
    expect(result.unmatchedLineIds).toContain(watermark?.lineId);
  });

  it("leaves a nearby line outside the description column for review", () => {
    const { page, draw } = statementPage(800);
    draw("date", "09/01/2026", 48, 600, 58);
    draw("merchant", "ONLINE RETAILER", 188, 600, 90);
    draw("amount", "17.99", 442, 600, 28);
    draw("unknown", "UNCLASSIFIED NOTE", 375, 587, 90);

    const result = reconstructPage(page);

    expect(result.candidates[0].tokenIds).toEqual(["date", "merchant", "amount"]);
    expect(result.candidates[0].diagnostics).toContain("ambiguous_continuation");
    expect(result.unmatchedLineIds).toEqual([result.lines[1].lineId]);
    const [parsed] = parsePage(result);
    expect(parsed).toMatchObject({
      resolution: "unresolved",
      status: "needs_review",
      partial: { billedAmount: { amountMinor: "1799" }, rawDescription: "ONLINE RETAILER" },
      sourceAnchor: { tokenIds: ["date", "merchant", "amount"] },
    });
    expect(parsed.transaction).toBeUndefined();
    expect(parsed.diagnostics).toContain("ambiguous_continuation");
  });

  it("holds a candidate with an uncertain baseline grouping for review", () => {
    const { page, draw } = statementPage(800);
    draw("date", "09/01/2026", 48, 600, 58);
    draw("merchant", "BOOKSTORE", 188, 600, 70);
    draw("amount", "17.99", 442, 600, 28);
    draw("overlap", "REFERENCE", 48, 598, 58);

    const [parsed] = parsePage(reconstructPage(page));
    expect(parsed.diagnostics).toContain("uncertain_line_grouping");
    expect(parsed.resolution).toBe("unresolved");
    expect(parsed.transaction).toBeUndefined();
    expect(parsed.partial?.billedAmount?.amountMinor).toBe("1799");
  });

  it("holds an attached wrap when its description column could not be identified", () => {
    const { page, draw } = statementPage(800);
    draw("row", "09/01/2026 BOOKSTORE 17.99", 48, 600, 422);
    draw("wrap", "ORDER 88421", 188, 587, 65);

    const [parsed] = parsePage(reconstructPage(page));
    expect(parsed.diagnostics).toContain("uncertain_description_column");
    expect(parsed.resolution).toBe("unresolved");
    expect(parsed.transaction).toBeUndefined();
    expect(parsed.partial?.rawDescription).toBe("BOOKSTORE ORDER 88421");
  });
});

describe("real statement reconstruction", () => {
  async function reconstructFixture(file: string) {
    const bytes = await readFile(`tests/fixtures/synthetic/${file}`);
    const task = getDocument({ data: new Uint8Array(bytes), useSystemFonts: true });
    try {
      const document = await task.promise;
      return reconstructDocument(await extractDocumentText(document));
    } finally {
      await task.destroy();
    }
  }

  it("associates the Cedar Bank order details with the transaction's two-date row", async () => {
    const reconstruction = await reconstructFixture("layout-b-text.pdf");
    const multiline = reconstruction.pages[0].candidates.find((row) =>
      row.str.includes("ORDER 88421"),
    );

    expect(multiline).toMatchObject({ multiline: true });
    expect(multiline?.str).toMatch(/ONLINE RETAILER .* \| ORDER 88421$/);
    expect(multiline?.lineIds).toHaveLength(2);
  });

  it("preserves diagonal watermarks independently of transaction text", async () => {
    const reconstruction = await reconstructFixture("motion-synthetic-credit-card-statement.pdf");

    for (const page of reconstruction.pages) {
      const watermarks = page.lines.filter((line) => line.str === "SYNTHETIC TEST DATA");
      expect(watermarks).toHaveLength(1);
      expect(watermarks[0].diagnostics).toContain("non_horizontal_baseline");
      expect(page.unmatchedLineIds).toContain(watermarks[0].lineId);
    }
  });
});
