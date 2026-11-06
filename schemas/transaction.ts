import { z } from "zod";

export const currencyCodeSchema = z
  .string()
  .regex(/^[A-Z]{3}$/, "Expected a three-letter uppercase ISO 4217 currency code");

export const minorUnitAmountSchema = z
  .string()
  .regex(/^(0|[1-9]\d*)$/, "Expected a nonnegative integer string of minor units");

export const moneySchema = z
  .object({
    amountMinor: minorUnitAmountSchema,
    currency: currencyCodeSchema,
    exponent: z.number().int().min(0).max(4),
  })
  .strict();

export const isoDateSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "Expected an ISO date (YYYY-MM-DD)")
  .refine((value) => {
    const date = new Date(`${value}T00:00:00Z`);
    return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
  }, "Invalid calendar date");

export const sha256Schema = z
  .string()
  .regex(/^[a-f0-9]{64}$/, "Expected a lowercase 64-character SHA-256 hex digest");

export const normalizedBboxSchema = z
  .tuple([
    z.number().min(0).max(1),
    z.number().min(0).max(1),
    z.number().min(0).max(1),
    z.number().min(0).max(1),
  ])
  .refine(([x0, y0, x1, y1]) => x0 < x1 && y0 < y1, {
    message: "Expected normalized [x0, y0, x1, y1] bounds with x0 < x1 and y0 < y1",
  });

export const pdfAnchorSchema = z
  .object({
    page: z.number().int().positive(),
    bbox: normalizedBboxSchema,
    tokenIds: z.array(z.string().min(1)).optional(),
  })
  .strict();

export const transactionTypeSchema = z.enum([
  "purchase",
  "refund",
  "payment",
  "transfer",
  "fee",
  "interest",
  "deposit",
  "adjustment",
  "unknown",
]);

export const transactionSourceSchema = z.enum(["statement_pdf", "receipt", "manual_fix"]);

export const reviewStatusSchema = z.enum(["ready", "needs_review", "skip", "approved"]);

export const classificationFlagSchema = z.enum([
  "ambiguous_date",
  "ambiguous_direction",
  "ambiguous_amount",
  "missing_amount",
  "unmatched_source",
  "low_ocr_confidence",
  "reconciliation_mismatch",
  "possible_duplicate",
  "unsupported_layout",
  "manual_correction",
]);

export const confidenceSchema = z.record(z.string().min(1), z.number().min(0).max(1));

export const parsedTransactionSchema = z
  .object({
    temporaryId: z.string().min(1),
    accountNotionPageId: z.string().min(1).optional(),
    transactionDate: isoDateSchema.optional(),
    postingDate: isoDateSchema.optional(),
    rawDescription: z.string().min(1),
    normalizedMerchant: z.string().min(1).optional(),
    transactionType: transactionTypeSchema,
    billedAmount: moneySchema,
    originalAmount: moneySchema.optional(),
    categoryNotionOptionId: z.string().min(1).optional(),
    source: transactionSourceSchema,
    sourceAnchor: pdfAnchorSchema.optional(),
    confidence: confidenceSchema.default({}),
    flags: z.array(classificationFlagSchema).default([]),
    sourceDocumentHash: sha256Schema.optional(),
    sourceRowId: z.string().min(1).optional(),
    dedupeFingerprint: z.string().min(1).optional(),
    reviewStatus: reviewStatusSchema.default("needs_review"),
  })
  .strict();

export type Money = z.infer<typeof moneySchema>;
export type PdfAnchor = z.infer<typeof pdfAnchorSchema>;
export type TransactionType = z.infer<typeof transactionTypeSchema>;
export type TransactionSource = z.infer<typeof transactionSourceSchema>;
export type ReviewStatus = z.infer<typeof reviewStatusSchema>;
export type ClassificationFlag = z.infer<typeof classificationFlagSchema>;
export type ParsedTransaction = z.infer<typeof parsedTransactionSchema>;
