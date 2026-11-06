import { z } from "zod";
import {
  currencyCodeSchema,
  isoDateSchema,
  minorUnitAmountSchema,
  moneySchema,
  parsedTransactionSchema,
  pdfAnchorSchema,
  sha256Schema,
  transactionTypeSchema,
} from "./transaction";

export const reconciliationControlsSchema = z
  .object({
    openingBalanceMinor: minorUnitAmountSchema.optional(),
    closingBalanceMinor: minorUnitAmountSchema.optional(),
    debitTotalMinor: minorUnitAmountSchema.optional(),
    creditTotalMinor: minorUnitAmountSchema.optional(),
    transactionCount: z.number().int().nonnegative().optional(),
  })
  .strict();

export const statementMetadataSchema = z
  .object({
    statementHash: sha256Schema,
    bankName: z.string().min(1).optional(),
    accountLabel: z.string().min(1).optional(),
    accountLast4: z.string().regex(/^\d{4}$/, "Expected the last four account digits"),
    periodStart: isoDateSchema.optional(),
    periodEnd: isoDateSchema.optional(),
    currency: currencyCodeSchema,
    pageCount: z.number().int().positive(),
  })
  .strict();

export const statementSchema = statementMetadataSchema
  .extend({
    transactions: z.array(parsedTransactionSchema).default([]),
    controls: reconciliationControlsSchema.optional(),
  })
  .strict();

export const statementFixtureTransactionSchema = z
  .object({
    sourceRowId: z.string().min(1),
    transactionDate: isoDateSchema,
    postingDate: isoDateSchema.optional(),
    rawDescription: z.string().min(1),
    normalizedMerchant: z.string().min(1).optional(),
    transactionType: transactionTypeSchema,
    billedAmount: moneySchema,
    sourceAnchor: pdfAnchorSchema,
  })
  .strict();

export const statementFixtureControlsSchema = z
  .object({
    openingBalanceMinor: minorUnitAmountSchema,
    closingBalanceMinor: minorUnitAmountSchema,
    debitTotalMinor: minorUnitAmountSchema,
    creditTotalMinor: minorUnitAmountSchema,
    transactionCount: z.number().int().positive(),
  })
  .strict();

export const statementFixtureSchema = z
  .object({
    schemaVersion: z.literal(1),
    id: z.string().regex(/^[a-z0-9-]+$/, "Expected a lowercase fixture id"),
    description: z.string().min(1),
    kind: z.enum(["text", "scanned"]),
    sourceFile: z.string().regex(/^[a-z0-9-]+\.pdf$/, "Expected a PDF filename"),
    statementHash: sha256Schema,
    bankName: z.string().min(1),
    accountLabel: z.string().min(1),
    accountLast4: z.string().regex(/^\d{4}$/, "Expected the last four account digits"),
    periodStart: isoDateSchema,
    periodEnd: isoDateSchema,
    currency: currencyCodeSchema,
    pageCount: z.number().int().positive(),
    transactions: z.array(statementFixtureTransactionSchema).min(10),
    controls: statementFixtureControlsSchema,
  })
  .strict()
  .superRefine((fixture, context) => {
    if (fixture.periodStart > fixture.periodEnd) {
      context.addIssue({
        code: "custom",
        message: "periodStart must not be after periodEnd",
        path: ["periodStart"],
      });
    }

    if (fixture.controls.transactionCount !== fixture.transactions.length) {
      context.addIssue({
        code: "custom",
        message: "controls.transactionCount must match the transaction list length",
        path: ["controls", "transactionCount"],
      });
    }

    fixture.transactions.forEach((transaction, index) => {
      if (
        transaction.transactionDate < fixture.periodStart ||
        transaction.transactionDate > fixture.periodEnd
      ) {
        context.addIssue({
          code: "custom",
          message: "Transaction date must fall within the statement period",
          path: ["transactions", index, "transactionDate"],
        });
      }

      if (transaction.billedAmount.currency !== fixture.currency) {
        context.addIssue({
          code: "custom",
          message: "Transaction currency must match the statement currency",
          path: ["transactions", index, "billedAmount", "currency"],
        });
      }
    });
  });

export type ReconciliationControls = z.infer<typeof reconciliationControlsSchema>;
export type StatementMetadata = z.infer<typeof statementMetadataSchema>;
export type Statement = z.infer<typeof statementSchema>;
export type StatementFixture = z.infer<typeof statementFixtureSchema>;
export type StatementFixtureTransaction = z.infer<typeof statementFixtureTransactionSchema>;
