import { describe, expect, it } from "vitest";
import {
  parseCandidateRow,
  parseDocumentCandidates,
  parseDate,
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

  it("clamps two-digit year <= 50 to statement period + 1 year", () => {
    const result = parseDate("01/15/30", baseContext);
    // 2030 clamped to 2027 (periodEnd 2026 + 1)
    expect(result.isoDate).toBe("2027-01-15");
    expect(result.yearInferred).toBe(true);
  });

  it("clamps two-digit year > 50 to statement period - 1 year", () => {
    const result = parseDate("01/15/75", baseContext);
    // 1975 clamped to 2025 (periodStart 2026 - 1)
    expect(result.isoDate).toBe("2025-01-15");
    expect(result.yearInferred).toBe(true);
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
    const result = inferTransactionType("REFUND RECEIVED", false, false);
    expect(result.type).toBe("refund");
    expect(result.confident).toBe(true);
  });

  it("classifies payment from keyword", () => {
    const result = inferTransactionType("PAYMENT THANK YOU", false, false);
    expect(result.type).toBe("payment");
    expect(result.confident).toBe(true);
  });

  it("classifies fee from keyword", () => {
    const result = inferTransactionType("LATE FEE", false, false);
    expect(result.type).toBe("fee");
    expect(result.confident).toBe(true);
  });

  it("classifies deposit from keyword", () => {
    const result = inferTransactionType("DIRECT DEPOSIT", false, false);
    expect(result.type).toBe("deposit");
    expect(result.confident).toBe(true);
  });

  it("defaults negative amount to purchase (not confident)", () => {
    const result = inferTransactionType("STORE NAME", true, false);
    expect(result.type).toBe("purchase");
    expect(result.confident).toBe(false);
  });

  it("defaults parentheses amount to purchase (not confident)", () => {
    const result = inferTransactionType("STORE NAME", false, true);
    expect(result.type).toBe("purchase");
    expect(result.confident).toBe(false);
  });

  it("defaults positive amount with no keyword to unknown (not confident)", () => {
    const result = inferTransactionType("STORE NAME", false, false);
    expect(result.type).toBe("unknown");
    expect(result.confident).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// extractMerchantDescription
// ---------------------------------------------------------------------------

describe("extractMerchantDescription", () => {
  it("removes date and amount from row string", () => {
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
    };
    const desc = extractMerchantDescription(
      "01/15/2026 STORE NAME 45.85",
      rawFields
    );
    expect(desc).toContain("STORE NAME");
    expect(desc).not.toContain("01/15/2026");
    expect(desc).not.toContain("45.85");
  });

  it("returns trimmed description", () => {
    const rawFields = {
      dateLikeMatches: [],
      amountLikeMatches: [],
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
    const desc = extractMerchantDescription("  STORE NAME  ", rawFields);
    expect(desc).toBe("STORE NAME");
  });
});

// ---------------------------------------------------------------------------
// parseCandidateRow
// ---------------------------------------------------------------------------

describe("parseCandidateRow", () => {
  it("successfully parses a complete transaction row", () => {
    // Amount first so date digits aren't picked up as the amount match
    const row = makeRow("45.85 01/15/2026 PAYMENT RECEIVED");
    const result = parseCandidateRow(row, baseContext);

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
    const result = parseCandidateRow(row, baseContext);

    expect(result.transaction!.temporaryId).toBe("p1-r0");
  });

  it("sets source as statement_pdf", () => {
    const row = makeRow("45.85 01/15/2026 PAYMENT RECEIVED");
    const result = parseCandidateRow(row, baseContext);

    expect(result.transaction!.source).toBe("statement_pdf");
  });

  it("sets reviewStatus to ready for successfully_parsed", () => {
    const row = makeRow("45.85 01/15/2026 PAYMENT RECEIVED");
    const result = parseCandidateRow(row, baseContext);

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

    const result = parseDocumentCandidates(reconstruction, baseContext);

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
