import { describe, expect, it } from "vitest";
import {
  parseCandidateRow,
  parseDocumentCandidates,
  parseDate,
  findDateSpans,
  parseAmount,
  inferTransactionType,
  extractMerchantDescription,
  type CandidateTransactionRow,
  type StatementContext,
  type ParsingStatus,
} from "@/lib/pdf";

const baseContext: StatementContext = {
  periodStart: "2026-01-01",
  periodEnd: "2026-01-31",
  currency: "USD",
};
const creditContext: StatementContext = { ...baseContext, positiveAmountDirection: "credit" };

function makeRow(
  str: string,
  overrides: Partial<CandidateTransactionRow> = {}
): CandidateTransactionRow {
  return {
    rowId: "p1-r0",
    page: 1,
    lineIds: ["l1"],
    tokenIds: ["t1", "t2"],
    str,
    bbox: [0.05, 0.78, 0.9, 0.82],
    hasDateLikeField: true,
    hasAmountLikeField: true,
    multiline: false,
    diagnostics: [],
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// parseDate
// ---------------------------------------------------------------------------

describe("parseDate", () => {
  it("parses ISO format YYYY-MM-DD", () => {
    const result = parseDate("2026-01-15", baseContext);
    expect(result.isoDate).toBe("2026-01-15");
    expect(result.ambiguous).toBe(false);
    expect(result.yearInferred).toBe(false);
  });

  it("parses ISO format with single-digit month and day", () => {
    const result = parseDate("2026-1-5", baseContext);
    expect(result.isoDate).toBe("2026-01-05");
    expect(result.ambiguous).toBe(false);
  });

  it("parses US format MM/DD/YYYY", () => {
    const result = parseDate("01/15/2026", baseContext);
    expect(result.isoDate).toBe("2026-01-15");
    expect(result.ambiguous).toBe(false);
  });

  it("parses US format M/D/YY with two-digit year", () => {
    const result = parseDate("1/15/26", baseContext);
    expect(result.isoDate).toBe("2026-01-15");
    expect(result.yearInferred).toBe(true);
  });

  it("flags ambiguous MM/DD when both numbers <= 12", () => {
    const result = parseDate("01/02/2026", baseContext);
    expect(result.isoDate).toBe("2026-01-02");
    expect(result.ambiguous).toBe(true);
  });

  it("resolves DD/MM when first number > 12", () => {
    const result = parseDate("15/01/2026", baseContext);
    expect(result.isoDate).toBe("2026-01-15");
    expect(result.ambiguous).toBe(false);
  });

  it("resolves MM/DD when second number > 12", () => {
    const result = parseDate("01/15/2026", baseContext);
    expect(result.isoDate).toBe("2026-01-15");
    expect(result.ambiguous).toBe(false);
  });

  it("returns null and ambiguous for invalid calendar date", () => {
    const result = parseDate("2026-02-30", baseContext);
    expect(result.isoDate).toBeNull();
    expect(result.ambiguous).toBe(true);
  });

  it("returns null and ambiguous for non-date string", () => {
    const result = parseDate("not a date", baseContext);
    expect(result.isoDate).toBeNull();
    expect(result.ambiguous).toBe(true);
  });

  it("expands two-digit years with a stable pivot and never clamps an explicit year", () => {
    const result = parseDate("01/15/30", baseContext);
    expect(result.isoDate).toBe("2030-01-15");
    expect(result.yearInferred).toBe(true);
  });

  it("expands two-digit years above the pivot to the 1900s", () => {
    const result = parseDate("01/15/75", baseContext);
    expect(result.isoDate).toBe("1975-01-15");
    expect(result.yearInferred).toBe(true);
  });

  it("requires a verified period to resolve a yearless date", () => {
    expect(parseDate("10/01", baseContext)).toMatchObject({ isoDate: null, ambiguous: true, yearInferred: true });
    expect(parseDate("10/01", { periodStart: "2026-10-01", periodEnd: "2026-10-31", periodVerified: true })).toMatchObject({ isoDate: "2026-10-01", ambiguous: false, yearInferred: true });
  });

  it("handles December and January dates in a verified cross-year period", () => {
    const context = { periodStart: "2025-12-01", periodEnd: "2026-01-31", periodVerified: true };
    expect(parseDate("12/31", context).isoDate).toBe("2025-12-31");
    expect(parseDate("01/02", context).isoDate).toBe("2026-01-02");
  });

  it("uses a verified period to resolve numeric date order when only one interpretation fits", () => {
    const context = { periodStart: "2026-09-01", periodEnd: "2026-09-30", periodVerified: true };
    expect(parseDate("01/09/2026", context)).toMatchObject({ isoDate: "2026-09-01", ambiguous: false });
    expect(parseDate("09/02/2026", context)).toMatchObject({ isoDate: "2026-09-02", ambiguous: false });
    expect(parseDate("09/09/2026", context)).toMatchObject({ isoDate: "2026-09-09", ambiguous: false });
  });

  it.each(["OCT 01", "01 OCT", "October 1", "1 October"])("parses named yearless date %s", (raw) => {
    expect(parseDate(raw, { periodStart: "2026-10-01", periodEnd: "2026-10-31", periodVerified: true })).toMatchObject({ isoDate: "2026-10-01", ambiguous: false, yearInferred: true });
  });

  it("finds non-overlapping date spans and retains their source offsets", () => {
    const text = "10/01  10/02  FRESHMART  56.42; posted OCT 03";
    const spans = findDateSpans(text);
    expect(spans.map(({ raw, start, end }) => ({ raw, source: text.slice(start, end) }))).toEqual([
      { raw: "10/01", source: "10/01" },
      { raw: "10/02", source: "10/02" },
      { raw: "OCT 03", source: "OCT 03" },
    ]);
    expect(spans[1]!.start).toBeGreaterThanOrEqual(spans[0]!.end);
  });

  it("does not consume amount digits or a second named date as a two-digit year", () => {
    for (const text of ["OCT 01 56.42", "OCT 01 02 OCT"]) {
      const spans = findDateSpans(text);
      expect(spans.map((span) => text.slice(span.start, span.end))).toEqual(
        text === "OCT 01 02 OCT" ? ["OCT 01", "02 OCT"] : ["OCT 01"],
      );
      expect(spans.every((span) => !span.hasExplicitYear)).toBe(true);
    }
    expect(findDateSpans("OCT. 01").map((span) => span.raw)).toEqual(["OCT. 01"]);
  });
});

// ---------------------------------------------------------------------------
// parseAmount
// ---------------------------------------------------------------------------

describe("parseAmount", () => {
  it("parses positive amount with currency symbol", () => {
    const result = parseAmount("$45.85", baseContext);
    expect(result.amountMinor).toBe("4585");
    expect(result.currency).toBe("USD");
    expect(result.signNegative).toBe(false);
    expect(result.inParentheses).toBe(false);
    expect(result.ambiguous).toBe(false);
  });

  it("parses negative amount with minus sign", () => {
    const result = parseAmount("-45.85", baseContext);
    expect(result.amountMinor).toBe("4585");
    expect(result.signNegative).toBe(true);
  });

  it("parses parentheses as negative (accounting convention)", () => {
    const result = parseAmount("(45.85)", baseContext);
    expect(result.amountMinor).toBe("4585");
    expect(result.signNegative).toBe(true);
    expect(result.inParentheses).toBe(true);
  });

  it("parses amount with thousands separator", () => {
    const result = parseAmount("$1,234.56", baseContext);
    expect(result.amountMinor).toBe("123456");
  });

  it("parses whole number amount", () => {
    const result = parseAmount("100", baseContext);
    expect(result.amountMinor).toBe("10000");
  });

  it("resolves the pound symbol with GBP statement evidence", () => {
    const result = parseAmount("£45.85", { ...baseContext, currency: "GBP" });
    expect(result.currency).toBe("GBP");
  });

  it("detects EUR from euro symbol", () => {
    const result = parseAmount("€45.85", { ...baseContext, currency: undefined });
    expect(result.currency).toBe("EUR");
  });

  it("returns null amount for non-numeric string", () => {
    const result = parseAmount("not an amount", baseContext);
    expect(result.amountMinor).toBeNull();
    expect(result.ambiguous).toBe(true);
  });

  it("uses context currency when no symbol present", () => {
    const result = parseAmount("45.85", baseContext);
    expect(result.currency).toBe("USD");
  });
});

// ---------------------------------------------------------------------------
// inferTransactionType
// ---------------------------------------------------------------------------

describe("inferTransactionType", () => {
  it("classifies refund from keyword", () => {
    const result = inferTransactionType("REFUND RECEIVED");
    expect(result.type).toBe("refund");
    expect(result.confident).toBe(true);
  });

  it("classifies payment from keyword", () => {
    const result = inferTransactionType("PAYMENT THANK YOU");
    expect(result.type).toBe("payment");
    expect(result.confident).toBe(true);
  });

  it("classifies fee from keyword", () => {
    const result = inferTransactionType("LATE FEE");
    expect(result.type).toBe("fee");
    expect(result.confident).toBe(true);
  });

  it("classifies deposit from keyword", () => {
    const result = inferTransactionType("DIRECT DEPOSIT");
    expect(result.type).toBe("deposit");
    expect(result.confident).toBe(true);
  });

  it("leaves an ordinary description unresolved when financial direction is absent", () => {
    const result = inferTransactionType("STORE NAME");
    expect(result.type).toBe("unknown");
    expect(result.confident).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// extractMerchantDescription
// ---------------------------------------------------------------------------

describe("extractMerchantDescription", () => {
  it("uses verified spans instead of replacing repeated date or amount text", () => {
    const rawFields = {
      dateLikeMatches: ["01/15/2026"],
      amountLikeMatches: ["45.85"],
      detectedDate: "2026-01-15",
      detectedPostingDate: null,
      detectedAmountMinor: "4585",
      detectedCurrency: "USD",
      detectedType: null,
      detectedMerchant: null,
      yearInferred: false,
      amountSignNegative: false,
      amountInParentheses: false,
      fieldSpans: {
        dates: [{ start: 0, end: 10, raw: "01/15/2026" }],
        amounts: [{ start: 27, end: 32, raw: "45.85" }],
        description: [{ start: 11, end: 26, raw: "STORE 45.85 GAP" }],
        fxMetadata: [],
      },
    };
    const desc = extractMerchantDescription("01/15/2026 STORE 45.85 GAP 45.85", rawFields);
    expect(desc).toBe("STORE 45.85 GAP");
  });

  it("preserves text matches when verified source spans are absent", () => {
    const rawFields = {
      dateLikeMatches: [],
      amountLikeMatches: ["45.85"],
      detectedDate: null,
      detectedPostingDate: null,
      detectedAmountMinor: null,
      detectedCurrency: null,
      detectedType: null,
      detectedMerchant: null,
      yearInferred: false,
      amountSignNegative: false,
      amountInParentheses: false,
    };
    const desc = extractMerchantDescription("  STORE 45.85 GAP  ", rawFields);
    expect(desc).toBe("STORE 45.85 GAP");
  });
});

// ---------------------------------------------------------------------------
// parseCandidateRow
// ---------------------------------------------------------------------------

describe("parseCandidateRow", () => {
  it("preserves failed source evidence without exposing an invalid transaction", () => {
    const row = makeRow("01/15/2026 PAYMENT RECEIVED 45.85 CR", {
      bbox: [0.8, 0.7, 0.2, 0.9],
      diagnostics: ["reconstruction_example"],
    });
    const result = parseCandidateRow(row, baseContext);

    expect(result).toMatchObject({
      resolution: "unresolved",
      status: "partially_parsed",
      sourceAnchor: { page: row.page, bbox: row.bbox, tokenIds: row.tokenIds },
      partial: {
        transactionDate: "2026-01-15",
        rawDescription: "PAYMENT RECEIVED",
        direction: "credit",
        billedAmount: { amountMinor: "4585", currency: "USD", exponent: 2 },
      },
    });
    expect(result).not.toHaveProperty("transaction");
    expect(result.diagnostics).toContain("schema_validation_failed");
    expect(result.diagnostics).toContain("reconstruction_example");
    expect(result.rawFields.fieldSpans?.billedAmount?.raw).toBe("45.85 CR");
  });

  it("retains dated credit evidence when currency is unresolved", () => {
    const result = parseCandidateRow(makeRow("01/15/2026 PAYMENT RECEIVED $45.85 CR"), {});

    expect(result).toMatchObject({
      resolution: "unresolved",
      status: "partially_parsed",
      partial: { transactionDate: "2026-01-15", direction: "credit" },
    });
    expect(result.transaction).toBeUndefined();
    expect(result.partial?.billedAmount).toBeUndefined();
    expect(result.diagnostics).toContain("unresolved_currency");
  });

  it("keeps a classified payment unresolved when its direction has no evidence", () => {
    const result = parseCandidateRow(makeRow("01/15/2026 PAYMENT RECEIVED 45.85"), baseContext);

    expect(result).toMatchObject({
      resolution: "unresolved",
      status: "needs_review",
      partial: { transactionType: "payment", billedAmount: { amountMinor: "4585" } },
    });
    expect(result.partial?.direction).toBeUndefined();
    expect(result.transaction).toBeUndefined();
    expect(result.flags).toContain("ambiguous_direction");
  });

  it.each([
    [
      "01/02/2026 PAYMENT RECEIVED 45.85 CR",
      ["01/02/2026"],
      "ambiguous_date_format",
      "detectedDate",
      undefined,
    ],
    [
      "01/15/2026 01/02/2026 PAYMENT RECEIVED 45.85 CR",
      ["01/15/2026", "01/02/2026"],
      "ambiguous_posting_date_format",
      "detectedPostingDate",
      "2026-01-15",
    ],
  ] as const)(
    "keeps date evidence for review from %s",
    (str, printedDates, diagnostic, tentativeField, resolvedTransactionDate) => {
      const result = parseCandidateRow(makeRow(str), baseContext);

      expect(result.resolution).toBe("unresolved");
      expect(result.transaction).toBeUndefined();
      expect(result.rawFields.dateLikeMatches).toEqual(printedDates);
      expect(result.rawFields[tentativeField]).toBe("2026-01-02");
      expect(result.partial?.transactionDate).toBe(resolvedTransactionDate);
      expect(result.partial?.postingDate).toBeUndefined();
      expect(result.diagnostics).toContain(diagnostic);
    },
  );

  it("keeps a date and credit amount without a merchant description unresolved", () => {
    const result = parseCandidateRow(makeRow("01/15/2026 45.85 CR"), baseContext);

    expect(result.resolution).toBe("unresolved");
    expect(result.transaction).toBeUndefined();
    expect(result.partial?.rawDescription).toBeUndefined();
    expect(result.diagnostics).toContain("missing_source_description");
  });

  it("emits a validated transaction with printed credit and resolved type", () => {
    const result = parseCandidateRow(
      makeRow("01/15/2026 PAYMENT RECEIVED 45.85 CR"),
      { ...baseContext, positiveAmountDirection: "debit" }
    );

    expect(result).toMatchObject({
      resolution: "validated",
      status: "successfully_parsed",
      transaction: {
        direction: "credit",
        transactionDate: "2026-01-15",
        rawDescription: "PAYMENT RECEIVED",
        transactionType: "payment",
        billedAmount: { amountMinor: "4585", currency: "USD", exponent: 2 },
        reviewStatus: "ready",
      },
    });
    expect(result).not.toHaveProperty("partial");
  });

  it("uses the inverse of a documented positive convention for a printed minus sign", () => {
    const result = parseCandidateRow(
      makeRow("01/15/2026 LATE FEE -45.85"),
      { ...baseContext, positiveAmountDirection: "credit" }
    );

    expect(result.transaction).toMatchObject({
      direction: "debit",
      transactionType: "fee",
      billedAmount: { amountMinor: "4585" },
    });
  });

  it("drops a prior transaction when reparsing the row without its currency evidence", () => {
    const row = makeRow("01/15/2026 PAYMENT RECEIVED 45.85 CR");
    const original = parseCandidateRow(row, baseContext);
    expect(original.resolution).toBe("validated");

    const reparsed = parseCandidateRow(original, {});

    expect(reparsed.resolution).toBe("unresolved");
    expect(reparsed).not.toHaveProperty("transaction");
    expect(reparsed.diagnostics).toContain("unresolved_currency");
  });

  it("keeps both yearless date spans while excluding their digits from amount matching", () => {
    const result = parseCandidateRow(
      makeRow("10/01  10/02  FRESHMART  56.42"),
      { periodStart: "2026-10-01", periodEnd: "2026-10-31", periodVerified: true, currency: "USD" }
    );

    expect(result.rawFields.dateLikeMatches).toEqual(["10/01", "10/02"]);
    expect(result.rawFields.amountLikeMatches).toEqual(["56.42"]);
    expect((result.transaction ?? result.partial)?.transactionDate).toBe("2026-10-01");
    expect(result.rawFields.detectedPostingDate).toBe("2026-10-02");
  });

  it("successfully parses a complete transaction row", () => {
    const row = makeRow("45.85 01/15/2026 PAYMENT RECEIVED");
    const result = parseCandidateRow(row, creditContext);

    expect(result.rowId).toBe("p1-r0");
    expect(result.page).toBe(1);
    expect(result.str).toBe("45.85 01/15/2026 PAYMENT RECEIVED");
    expect(result.status).toBe("successfully_parsed");
    expect(result.transaction).toBeDefined();
    expect(result.transaction!.transactionDate).toBe("2026-01-15");
    expect(result.transaction!.billedAmount.amountMinor).toBe("4585");
    expect(result.transaction!.billedAmount.currency).toBe("USD");
    expect(result.transaction!.transactionType).toBe("payment");
    expect(result.transaction!.reviewStatus).toBe("ready");
    expect(result.transaction!.temporaryId).toBe("p1-r0");
    expect(result.flags).not.toContain("missing_amount");
  });

  it("flags missing amount when row has no digits", () => {
    const row = makeRow("STORE NAME");
    const result = parseCandidateRow(row, baseContext);

    expect(result.status).toBe("partially_parsed");
    expect(result.flags).toContain("missing_amount");
    expect(result.transaction).toBeUndefined();
  });

  it("flags ambiguous date when format is ambiguous", () => {
    const row = makeRow("45.85 01/02/2026 STORE NAME");
    const result = parseCandidateRow(row, baseContext);

    expect(result.flags).toContain("ambiguous_date");
    expect(result.diagnostics).toContain("ambiguous_date_format");
  });

  it("marks unable_to_interpret when row is empty", () => {
    const row = makeRow("");
    const result = parseCandidateRow(row, baseContext);

    expect(result.status).toBe("unable_to_interpret");
    expect(result.flags).toContain("unmatched_source");
  });

  it("sets temporaryId to rowId", () => {
    const row = makeRow("45.85 01/15/2026 PAYMENT RECEIVED");
    const result = parseCandidateRow(row, creditContext);

    expect(result.transaction!.temporaryId).toBe("p1-r0");
  });

  it("sets source as statement_pdf", () => {
    const row = makeRow("45.85 01/15/2026 PAYMENT RECEIVED");
    const result = parseCandidateRow(row, creditContext);

    expect(result.transaction!.source).toBe("statement_pdf");
  });

  it("sets reviewStatus to ready for successfully_parsed", () => {
    const row = makeRow("45.85 01/15/2026 PAYMENT RECEIVED");
    const result = parseCandidateRow(row, creditContext);

    expect(result.transaction!.reviewStatus).toBe("ready");
  });
});

// ---------------------------------------------------------------------------
// parseDocumentCandidates
// ---------------------------------------------------------------------------

describe("parseDocumentCandidates", () => {
  it("parses multiple candidate rows into a document result", () => {
    const rows: CandidateTransactionRow[] = [
      makeRow("45.85 01/15/2026 PAYMENT RECEIVED", { rowId: "p1-r0" }),
      makeRow("120.00 01/16/2026 DEPOSIT", { rowId: "p1-r1" }),
      makeRow("", { rowId: "p1-r2" }),
    ];

    const reconstruction = {
      pageCount: 1,
      pages: [
        {
          page: 1,
          width: 600,
          height: 800,
          tokens: [],
          lines: [],
          tables: [],
          candidates: rows,
          unmatchedTokenIds: [],
          unmatchedLineIds: [],
          diagnostics: [],
        },
      ],
      totalLines: 0,
      totalTables: 0,
      totalCandidates: 3,
      totalUnmatchedTokens: 0,
      totalUnmatchedLines: 0,
      hasUnmatchedContent: false,
    };

    const result = parseDocumentCandidates(reconstruction, creditContext);

    expect(result.page).toBe(1);
    expect(result.candidates).toHaveLength(3);
    expect(result.candidates[0].status).toBe("successfully_parsed");
    expect(result.candidates[1].status).toBe("successfully_parsed");
    expect(result.candidates[2].status).toBe("unable_to_interpret");
    expect(result.unableToInterpretIds).toContain("p1-r2");
  });
});

// ---------------------------------------------------------------------------
// ParsingStatus type
// ---------------------------------------------------------------------------

describe("ParsingStatus type", () => {
  const statuses: ParsingStatus[] = [
    "successfully_parsed",
    "partially_parsed",
    "needs_review",
    "not_a_transaction",
    "unable_to_interpret",
  ];

  it("includes all five status values", () => {
    expect(statuses).toHaveLength(5);
    expect(statuses).toContain("successfully_parsed");
    expect(statuses).toContain("unable_to_interpret");
  });
});
