import { describe, expect, it } from "vitest";
import { parseAmount, parseCandidateRow, type CandidateTransactionRow } from "@/lib/pdf";

describe("parseAmount", () => {
  it("preserves all digits in amounts beyond JavaScript's safe integer range", () => {
    expect(parseAmount("9,007,199,254,740,993.01", { currency: "CAD" })).toMatchObject({
      amountMinor: "900719925474099301",
      currency: "CAD",
      ambiguous: false,
    });
  });

  it.each(["12abc", "12.34 trailing", "1e2", "1,23,456.78", "1.234.56", "1234."])(
    "rejects malformed amount %s in its entirety",
    (raw) => {
      expect(parseAmount(raw, { currency: "CAD" })).toMatchObject({
        amountMinor: null,
        ambiguous: true,
      });
    },
  );

  it("preserves a separator ambiguity until the statement provides decimal evidence", () => {
    expect(parseAmount("1,234", { currency: "CAD" })).toMatchObject({
      amountMinor: null,
      ambiguous: true,
    });
    expect(parseAmount("1,234", { currency: "CAD", decimalSeparator: "." })).toMatchObject({
      amountMinor: "123400",
      ambiguous: false,
    });
  });

  it.each([
    ["1.234,56", "123456"],
    ["1\u202f234,56", "123456"],
    ["1,234,567", "123456700"],
    ["0000,00", "0"],
    ["12.5", "1250"],
  ])("converts %s without rounding", (raw, expected) => {
    expect(parseAmount(raw, { currency: "CAD" })).toMatchObject({
      amountMinor: expected,
      ambiguous: false,
    });
  });

  it.each([
    ["CAD 45.85", {}, "CAD", "4585", 2],
    ["45.85 CAD", { currency: "USD" }, "CAD", "4585", 2],
    ["$45.85", { currency: "CAD" }, "CAD", "4585", 2],
    ["$45.85 USD", { currency: "CAD" }, "USD", "4585", 2],
    ["A$45.85", {}, "AUD", "4585", 2],
    ["¥ 500", { currency: "JPY" }, "JPY", "500", 0],
    ["¥ 500", { currency: "CNY" }, "CNY", "50000", 2],
    ["KRW 1,000", { decimalSeparator: "." }, "KRW", "1000", 0],
    ["KWD 0.125", {}, "KWD", "125", 3],
    ["1.234 KWD", { decimalSeparator: "." }, "KWD", "1234", 3],
    ["0.1234 CLF", {}, "CLF", "1234", 4],
  ] as const)("uses currency evidence in %s", (raw, context, currency, amountMinor, exponent) => {
    expect(parseAmount(raw, context)).toMatchObject({
      currency,
      amountMinor,
      exponent,
      ambiguous: false,
    });
  });

  it.each([
    ["12.50", {}, "unresolved_currency"],
    ["$12.50", {}, "unresolved_currency"],
    ["$12.50", { currency: "EUR" }, "unresolved_currency"],
    ["¥12", {}, "unresolved_currency"],
    ["€12.50 CAD", {}, "conflicting_currency"],
    ["12.50 ABC", { currency: "USD" }, "unsupported_currency"],
    ["12.50 XAU", {}, "unsupported_currency"],
    ["12.50", { currency: "ABC" }, "unsupported_currency"],
  ] as const)("leaves currency unresolved for %s", (raw, context, diagnostic) => {
    expect(parseAmount(raw, context)).toMatchObject({
      currency: null,
      amountMinor: null,
      ambiguous: true,
      diagnostic,
    });
  });

  it.each([
    ["JPY 2.50", "JPY"],
    ["CAD 1000.125", "CAD"],
  ])("rejects unsupported precision in %s", (raw, currency) => {
    expect(parseAmount(raw, {})).toMatchObject({
      currency,
      amountMinor: null,
      ambiguous: true,
      diagnostic: "unsupported_precision",
    });
  });

  it.each([
    ["− CAD $ 45.85", true, false, null],
    ["45.85 CAD -", true, false, null],
    ["CAD ($ 45.85) CR", true, true, "credit"],
    ["CAD 45.85DR", false, false, "debit"],
    ["+45.85 CAD", false, false, null],
  ] as const)(
    "keeps the magnitude and records printed markers in %s",
    (raw, signNegative, inParentheses, direction) => {
      expect(parseAmount(raw, {})).toMatchObject({
        amountMinor: "4585",
        signNegative,
        inParentheses,
        direction,
        ambiguous: false,
      });
    },
  );

  it.each(["(-10.00)", "++10.00", "10.00 CR DR", "(10.00", "10.00)"])(
    "leaves conflicting or unmatched markers unresolved in %s",
    (raw) => {
      expect(parseAmount(raw, { currency: "CAD" })).toMatchObject({
        amountMinor: null,
        ambiguous: true,
      });
    },
  );
});

describe("monetary evidence in candidate rows", () => {
  const row: CandidateTransactionRow = {
    rowId: "p1-r0",
    page: 1,
    lineIds: ["l1"],
    tokenIds: ["t1", "t2"],
    str: "45.85 01/15/2026 PAYMENT RECEIVED",
    bbox: [0.05, 0.78, 0.9, 0.82],
    hasDateLikeField: true,
    hasAmountLikeField: true,
    multiline: false,
    diagnostics: [],
  };

  it("keeps unresolved currency in the candidate with a diagnostic", () => {
    const result = parseCandidateRow(row, {});
    expect(result.transaction).toBeUndefined();
    expect(result.status).toBe("partially_parsed");
    expect(result.rawFields.detectedCurrency).toBeNull();
    expect(result.diagnostics).toContain("unresolved_currency");
    expect(result.tokenIds).toEqual(row.tokenIds);
  });

  it("carries the resolved currency's exponent into the transaction", () => {
    const result = parseCandidateRow(row, { currency: "KWD", positiveAmountDirection: "credit" });
    expect(result.transaction?.billedAmount).toEqual({
      amountMinor: "45850",
      currency: "KWD",
      exponent: 3,
    });
  });
});
