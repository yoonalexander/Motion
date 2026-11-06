import { describe, expect, it } from "vitest";
import {
  classificationFlagSchema,
  currencyCodeSchema,
  isoDateSchema,
  moneySchema,
  parsedTransactionSchema,
  pdfAnchorSchema,
} from "@/schemas/transaction";
import { statementMetadataSchema, statementSchema } from "@/schemas/statement";

const money = {
  amountMinor: "1234",
  currency: "CAD",
  exponent: 2,
};

describe("moneySchema", () => {
  it("accepts canonical integer minor units", () => {
    expect(moneySchema.parse(money)).toEqual(money);
  });

  it.each(["12.34", "-100", "001", "1e3", ""])("rejects non-canonical amount %s", (amountMinor) => {
    expect(() => moneySchema.parse({ ...money, amountMinor })).toThrow();
  });

  it("rejects invalid currency codes and exponents", () => {
    expect(() => currencyCodeSchema.parse("cad")).toThrow();
    expect(() => moneySchema.parse({ ...money, currency: "CADD" })).toThrow();
    expect(() => moneySchema.parse({ ...money, exponent: 5 })).toThrow();
  });
});

describe("dateSchema", () => {
  it("accepts real ISO dates", () => {
    expect(isoDateSchema.parse("2026-09-30")).toBe("2026-09-30");
  });

  it.each(["2026-02-30", "2026-13-01", "09/30/2026"])("rejects invalid date %s", (value) => {
    expect(() => isoDateSchema.parse(value)).toThrow();
  });
});

describe("pdfAnchorSchema", () => {
  it("accepts normalized bounds in the correct order", () => {
    expect(
      pdfAnchorSchema.parse({ page: 1, bbox: [0.1, 0.2, 0.9, 0.3], tokenIds: ["t1"] }),
    ).toMatchObject({ page: 1 });
  });

  it("rejects reversed or out-of-range bounds", () => {
    expect(() => pdfAnchorSchema.parse({ page: 1, bbox: [0.9, 0.2, 0.1, 0.3] })).toThrow();
    expect(() => pdfAnchorSchema.parse({ page: 0, bbox: [0.1, 0.2, 0.9, 0.3] })).toThrow();
    expect(() => pdfAnchorSchema.parse({ page: 1, bbox: [0.1, 0.2, 1.1, 0.3] })).toThrow();
  });
});

describe("parsedTransactionSchema", () => {
  const transaction = {
    temporaryId: "tmp-1",
    rawDescription: "COFFEE HOUSE",
    transactionType: "purchase",
    billedAmount: money,
    source: "statement_pdf",
  };

  it("applies safe review defaults", () => {
    expect(parsedTransactionSchema.parse(transaction)).toMatchObject({
      reviewStatus: "needs_review",
      flags: [],
      confidence: {},
    });
  });

  it("accepts a fully populated transaction", () => {
    const parsed = parsedTransactionSchema.parse({
      ...transaction,
      transactionDate: "2026-09-02",
      postingDate: "2026-09-03",
      normalizedMerchant: "Coffee House",
      categoryNotionOptionId: "option-dining",
      sourceAnchor: { page: 1, bbox: [0.1, 0.2, 0.9, 0.3] },
      confidence: { amount: 0.99, category: 0.8 },
      flags: ["unmatched_source"],
      sourceDocumentHash: "a".repeat(64),
      sourceRowId: "row-1",
      reviewStatus: "ready",
    });

    expect(parsed.transactionType).toBe("purchase");
    expect(parsed.flags).toEqual(["unmatched_source"]);
  });

  it("rejects unknown transaction types, flags, and review states", () => {
    expect(() =>
      parsedTransactionSchema.parse({ ...transaction, transactionType: "cash_advance" }),
    ).toThrow();
    expect(() =>
      parsedTransactionSchema.parse({ ...transaction, flags: ["made_up_flag"] }),
    ).toThrow();
    expect(() => classificationFlagSchema.parse("made_up_flag")).toThrow();
    expect(() => parsedTransactionSchema.parse({ ...transaction, reviewStatus: "done" })).toThrow();
  });
});

describe("statementSchema", () => {
  const metadata = {
    statementHash: "b".repeat(64),
    accountLast4: "4242",
    currency: "CAD",
    pageCount: 1,
  };

  it("accepts metadata with empty transactions and reconciliation controls", () => {
    expect(
      statementSchema.parse({
        ...metadata,
        transactions: [],
        controls: { debitTotalMinor: "1000", transactionCount: 0 },
      }),
    ).toMatchObject({ accountLast4: "4242" });
  });

  it("rejects malformed account and hash fields", () => {
    expect(() => statementMetadataSchema.parse({ ...metadata, accountLast4: "42" })).toThrow();
    expect(() =>
      statementMetadataSchema.parse({ ...metadata, statementHash: "not-a-hash" }),
    ).toThrow();
  });
});
