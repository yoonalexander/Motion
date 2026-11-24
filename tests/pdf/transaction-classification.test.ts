import { describe, expect, it } from "vitest";
import {
  parseCandidateRow,
  parseDocumentCandidates,
  type CandidateTransactionRow,
} from "@/lib/pdf";

function row(description: string, amount: string): CandidateTransactionRow {
  return {
    rowId: "p1-r0",
    page: 1,
    lineIds: ["l1"],
    tokenIds: ["t1", "t2", "t3"],
    str: `01/15/2026 ${description} ${amount}`,
    bbox: [0.05, 0.78, 0.9, 0.82],
    hasDateLikeField: true,
    hasAmountLikeField: true,
    multiline: false,
    diagnostics: [],
  };
}

describe("transaction classification", () => {
  it.each(["COFFEE HOUSE", "PAYLESS SHOES", "GAP 24", "KFC", "UPS #4321"])(
    "keeps %s intact and classifies a known debit as a purchase",
    (description) => {
      const source = row(description, "45.85");
      const result = parseCandidateRow(source, {
        currency: "CAD",
        positiveAmountDirection: "debit",
      });

      expect(result.transaction).toMatchObject({
        transactionType: "purchase",
        direction: "debit",
        rawDescription: description,
        billedAmount: { amountMinor: "4585", currency: "CAD", exponent: 2 },
        sourceAnchor: { tokenIds: source.tokenIds, bbox: source.bbox, page: source.page },
      });
      expect(result.rawFields.fieldSpans?.description.map((span) => span.raw)).toEqual([
        description,
      ]);
    },
  );

  it.each([
    ["MONTHLY CARD PAYMENT", "-45.85", "payment", "credit"],
    ["ONLINE RETAILER RETURN", "45.85 CR", "refund", "credit"],
    ["MERCHANT AUTHORIZED CREDIT", "45.85 CR", "refund", "credit"],
    ["BANK SERVICE ADJUSTMENT", "45.85 CR", "adjustment", "credit"],
    ["FOREIGN TRANSACTION FEE", "45.85 DR", "fee", "debit"],
    ["FINANCE CHARGE", "45.85 DR", "interest", "debit"],
    ["INTEREST EARNED", "45.85 CR", "interest", "credit"],
    ["WIRE TRANSFER", "45.85 DR", "transfer", "debit"],
    ["DIRECT DEPOSIT", "45.85 CR", "deposit", "credit"],
  ])(
    "classifies %s using its label and financial direction",
    (description, amount, type, direction) => {
      const result = parseCandidateRow(row(description, amount), {
        currency: "CAD",
        positiveAmountDirection: "debit",
      });

      expect(result.transaction).toMatchObject({
        transactionType: type,
        direction,
        rawDescription: description,
        reviewStatus: "ready",
      });
    },
  );

  it.each(["-45.85", "(45.85)"])("keeps a bare sign in %s unresolved", (amount) => {
    const result = parseCandidateRow(row("GAP", amount), { currency: "CAD" });

    expect(result).toMatchObject({
      resolution: "unresolved",
      partial: { rawDescription: "GAP", billedAmount: { amountMinor: "4585" } },
      rawFields: { detectedType: "unknown", amountSignNegative: true },
    });
    expect(result.flags).toContain("ambiguous_direction");
    expect(result.transaction).toBeUndefined();
  });

  it.each([
    ["PAYMENT PROCESSING CO", "45.85 CR", "unresolved_transaction_type"],
    ["CARD PAYMENT REVERSAL", "45.85 CR", "unresolved_transaction_type"],
    ["STORE CREDIT", "45.85 CR", "unresolved_transaction_type"],
    ["REFUND RECEIVED", "45.85 DR", "conflicting_transaction_type_direction"],
    ["REFUND / DIRECT DEPOSIT", "45.85 CR", "conflicting_transaction_labels"],
  ])("keeps ambiguous type evidence in %s for review", (description, amount, diagnostic) => {
    const result = parseCandidateRow(row(description, amount), { currency: "CAD" });

    expect(result).toMatchObject({ resolution: "unresolved", status: "needs_review" });
    expect(result.transaction).toBeUndefined();
    expect(result.partial?.rawDescription).toBe(description);
    expect(result.flags).toContain("ambiguous_transaction_type");
    expect(result.diagnostics).toContain(diagnostic);
  });

  it("preserves two identical same-day merchant amounts as distinct source rows", () => {
    const first = row("KFC 24", "45.85 DR");
    const second: CandidateTransactionRow = {
      ...first,
      rowId: "p1-r1",
      lineIds: ["l2"],
      tokenIds: ["t4", "t5", "t6"],
      bbox: [0.05, 0.7, 0.9, 0.74],
    };
    const document = { pageCount: 1, pages: [{ candidates: [first, second], tokens: [] }] };
    const result = parseDocumentCandidates(document, { currency: "CAD" });

    expect(result.candidates.map((candidate) => candidate.transaction)).toMatchObject(
      [first, second].map((source) => ({
        temporaryId: source.rowId,
        rawDescription: "KFC 24",
        transactionDate: "2026-01-15",
        transactionType: "purchase",
        billedAmount: { amountMinor: "4585" },
        sourceAnchor: { tokenIds: source.tokenIds, bbox: source.bbox, page: 1 },
      })),
    );
  });
});
