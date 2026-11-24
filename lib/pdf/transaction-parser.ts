import "client-only";
import { z } from "zod";
import { isSupportedCurrencyCode, parseAmount } from "./money-parser";
import type { CandidateTransactionRow, PageReconstruction } from "./text-reconstructor";
import { parseDate } from "./date-parser";
import { inferTransactionType } from "./transaction-classifier";
import {
  extractStatementFields,
  type ParsedFieldSpans,
  type PositionedSource,
} from "./statement-fields";
export { findDateSpans, parseDate } from "./date-parser";
export type { DateSpan } from "./date-parser";
export type { FieldSpan, ParsedFieldSpans, PositionedSource } from "./statement-fields";
import {
  isoDateSchema,
  parsedTransactionSchema,
  pdfAnchorSchema,
  transactionDirectionSchema,
  transactionTypeSchema,
  type Money,
  type PdfAnchor,
  type TransactionDirection,
  type TransactionType,
  type ClassificationFlag,
} from "@/schemas/transaction";

export { parseAmount } from "./money-parser";
export { inferTransactionType } from "./transaction-classifier";

const parsedStatementTransactionSchema = parsedTransactionSchema.extend({
  transactionDate: isoDateSchema,
  transactionType: transactionTypeSchema.exclude(["unknown"]),
  direction: transactionDirectionSchema,
  source: z.literal("statement_pdf"),
  sourceAnchor: pdfAnchorSchema,
  reviewStatus: z.literal("ready"),
});

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface StatementContext {
  periodStart?: string; // ISO date YYYY-MM-DD
  periodEnd?: string; // ISO date YYYY-MM-DD
  /** Set only after statement dates have been verified from source/context. */
  periodVerified?: boolean;
  dateOrder?: "MDY" | "DMY";
  currency?: string; // ISO 4217 code
  decimalSeparator?: "." | ",";
  /** Set only when the statement's unsigned and signed amounts share a known convention. */
  positiveAmountDirection?: TransactionDirection;
  accountLabel?: string;
  accountLast4?: string;
  bankName?: string;
}

interface CandidateEvidence extends CandidateTransactionRow {
  sourceAnchor: PdfAnchor;
  flags: ClassificationFlag[];
  rawFields: RawParsedFields;
}

export interface ValidatedCandidate extends CandidateEvidence {
  resolution: "validated";
  status: "successfully_parsed";
  transaction: z.infer<typeof parsedStatementTransactionSchema>;
  partial?: never;
}

export interface UnresolvedCandidate extends CandidateEvidence {
  resolution: "unresolved";
  status: Exclude<ParsingStatus, "successfully_parsed">;
  transaction?: never;
  partial: {
    transactionDate?: string;
    postingDate?: string;
    billedAmount?: Money;
    originalAmount?: Money;
    rawDescription?: string;
    transactionType?: Exclude<TransactionType, "unknown">;
    direction?: TransactionDirection;
  };
}

export type ParsedCandidate = ValidatedCandidate | UnresolvedCandidate;

export type ParsingStatus =
  | "successfully_parsed"
  | "partially_parsed"
  | "needs_review"
  | "not_a_transaction"
  | "unable_to_interpret";

export interface RawParsedFields {
  dateLikeMatches: string[];
  amountLikeMatches: string[];
  detectedDate: string | null; // ISO YYYY-MM-DD or null
  detectedPostingDate: string | null; // ISO YYYY-MM-DD or null
  detectedAmountMinor: string | null; // integer minor units or null
  detectedCurrency: string | null; // ISO 4217 or null
  printedLedgerCurrencies?: string[];
  detectedType: string | null; // transaction type or null
  detectedMerchant: string | null; // raw description text or null
  yearInferred: boolean;
  amountSignNegative: boolean;
  amountInParentheses: boolean;
  fieldSpans?: ParsedFieldSpans;
  amountDirection?: TransactionDirection | null;
  detectedOriginalAmount?: Money | null;
}

export interface ParseResult {
  page: number;
  candidates: ParsedCandidate[];
  notATransactionIds: string[];
  unableToInterpretIds: string[];
  diagnostics: string[];
}

// Date discovery/resolution lives in date-parser.ts so candidate detection and
// parser assembly share the same source spans.

// ---------------------------------------------------------------------------
// Merchant description extraction
// ---------------------------------------------------------------------------

/**
 * Joins the verified description spans in source order, including continuations.
 */
export function extractMerchantDescription(rowStr: string, rawFields: RawParsedFields): string {
  return rawFields.fieldSpans?.description.map((span) => span.raw).join(" ") ?? rowStr.trim();
}

// ---------------------------------------------------------------------------
// Main parser
// ---------------------------------------------------------------------------

/**
 * Parses a CandidateTransactionRow into a validated financial record.
 *
 * Returns a ParsedCandidate with status, parsed transaction (if successful),
 * flags, diagnostics, and raw extracted fields.
 */
export function parseCandidateRow(
  row: CandidateTransactionRow,
  context: StatementContext,
  source?: PositionedSource,
): ParsedCandidate {
  const {
    fields,
    ambiguousDates,
    ambiguousBilledAmount,
    ambiguousOriginalAmount,
    columnDirection,
    printedLedgerCurrencies,
  } = extractStatementFields(row, source);
  const rawFields: RawParsedFields = {
    dateLikeMatches: fields.dates.map((span) => span.raw),
    amountLikeMatches: fields.amounts.map((span) => span.raw),
    detectedDate: null,
    detectedPostingDate: null,
    detectedAmountMinor: null,
    detectedCurrency: null,
    printedLedgerCurrencies,
    detectedType: null,
    detectedMerchant: null,
    yearInferred: false,
    amountSignNegative: false,
    amountInParentheses: false,
    fieldSpans: fields,
    amountDirection: null,
    detectedOriginalAmount: null,
  };

  const flags: ClassificationFlag[] = [];
  const diagnostics = [...row.diagnostics];

  // Parse dates
  let transactionDate: string | null = null;
  let postingDate: string | null = null;
  let dateAmbiguous = ambiguousDates;
  if (ambiguousDates) {
    flags.push("ambiguous_date");
    diagnostics.push("ambiguous_date_columns");
  }

  if (fields.transactionDate) {
    const first = parseDate(fields.transactionDate.raw, context);
    transactionDate = first.ambiguous ? null : first.isoDate;
    dateAmbiguous = dateAmbiguous || first.ambiguous;
    rawFields.yearInferred = rawFields.yearInferred || first.yearInferred;
    if (first.isoDate) {
      rawFields.detectedDate = first.isoDate;
    }
    if (first.ambiguous) {
      flags.push("ambiguous_date");
      diagnostics.push("ambiguous_date_format");
    }
  }

  if (fields.postingDate) {
    const second = parseDate(fields.postingDate.raw, context);
    postingDate = second.ambiguous ? null : second.isoDate;
    dateAmbiguous = dateAmbiguous || second.ambiguous;
    rawFields.yearInferred = rawFields.yearInferred || second.yearInferred;
    if (second.isoDate) {
      rawFields.detectedPostingDate = second.isoDate;
    }
    if (second.ambiguous) {
      flags.push("ambiguous_date");
      diagnostics.push("ambiguous_posting_date_format");
    }
  }

  if (!fields.transactionDate) {
    flags.push("ambiguous_date");
    diagnostics.push("no_date_found");
  }

  // Parse amount
  let money: Money | undefined;

  if (fields.billedAmount) {
    const enteredCurrency = context.currency?.trim().toUpperCase();
    const [printedCurrency] = printedLedgerCurrencies;
    const multiplePrintedCurrencies = printedLedgerCurrencies.length > 1;
    const { amountMinor, currency, exponent, signNegative, inParentheses, diagnostic, direction } =
      parseAmount(fields.billedAmount.raw, {
        ...context,
        currency: multiplePrintedCurrencies ? undefined : (printedCurrency ?? enteredCurrency),
      });
    rawFields.amountSignNegative = signNegative;
    rawFields.amountInParentheses = inParentheses;
    rawFields.detectedAmountMinor = amountMinor;
    rawFields.detectedCurrency = currency;
    if (direction && columnDirection && direction !== columnDirection) {
      flags.push("ambiguous_direction");
      diagnostics.push("conflicting_amount_direction");
    } else {
      rawFields.amountDirection = direction ?? columnDirection;
    }
    const unsupportedPrintedCurrency = printedLedgerCurrencies.some(
      (code) => !isSupportedCurrencyCode(code),
    );
    const conflictingPrintedCurrencies =
      multiplePrintedCurrencies ||
      (printedCurrency !== undefined && currency !== null && currency !== printedCurrency);
    const resolvedLedgerCurrency = printedCurrency ?? currency;
    const conflictingEnteredCurrency =
      enteredCurrency && resolvedLedgerCurrency && enteredCurrency !== resolvedLedgerCurrency;

    if (
      !unsupportedPrintedCurrency &&
      !conflictingPrintedCurrencies &&
      amountMinor !== null &&
      currency !== null &&
      exponent !== null
    ) {
      money = { amountMinor, currency, exponent };
    }
    if (
      diagnostic ||
      unsupportedPrintedCurrency ||
      conflictingPrintedCurrencies ||
      conflictingEnteredCurrency
    ) {
      flags.push("ambiguous_amount");
    }
    if (unsupportedPrintedCurrency) {
      diagnostics.push("unsupported_statement_currency");
    }
    if (conflictingPrintedCurrencies || conflictingEnteredCurrency) {
      diagnostics.push("conflicting_statement_currency");
    }
    if (diagnostic) {
      diagnostics.push(diagnostic);
    }
  } else if (ambiguousBilledAmount) {
    flags.push("ambiguous_amount");
    diagnostics.push("ambiguous_billed_amount");
  } else {
    flags.push("missing_amount");
    diagnostics.push("no_amount_found");
  }

  let originalAmount: Money | undefined;
  if (fields.originalAmount) {
    const original = parseAmount(fields.originalAmount.raw, { ...context, currency: undefined });
    if (original.amountMinor !== null && original.currency !== null && original.exponent !== null) {
      originalAmount = {
        amountMinor: original.amountMinor,
        currency: original.currency,
        exponent: original.exponent,
      };
      rawFields.detectedOriginalAmount = originalAmount;
    } else if (original.diagnostic) {
      flags.push("ambiguous_amount");
      diagnostics.push(`original_${original.diagnostic}`);
    }
  } else if (ambiguousOriginalAmount) {
    flags.push("ambiguous_amount");
    diagnostics.push("ambiguous_original_amount");
  }

  const merchantDesc = extractMerchantDescription(row.str, rawFields);
  rawFields.detectedMerchant = merchantDesc;

  let direction = rawFields.amountDirection ?? undefined;
  if (!direction && money && !flags.includes("ambiguous_direction")) {
    const positiveDirection = context.positiveAmountDirection;
    if (positiveDirection && money.amountMinor !== "0") {
      const negativeDirection = positiveDirection === "credit" ? "debit" : "credit";
      direction = rawFields.amountSignNegative ? negativeDirection : positiveDirection;
    } else {
      flags.push("ambiguous_direction");
      diagnostics.push("unresolved_amount_direction");
    }
  }

  const typeInfo = inferTransactionType(merchantDesc, direction);
  rawFields.detectedType = typeInfo.type;
  const transactionType = typeInfo.confident ? typeInfo.type : undefined;
  if (!merchantDesc) {
    diagnostics.push("missing_source_description");
  } else if (!typeInfo.confident) {
    flags.push("ambiguous_transaction_type");
    diagnostics.push(typeInfo.diagnostic);
  }

  const sourceAnchor = { page: row.page, bbox: row.bbox, tokenIds: row.tokenIds };
  const evidence: CandidateEvidence = {
    rowId: row.rowId,
    page: row.page,
    str: row.str,
    lineIds: row.lineIds,
    tokenIds: row.tokenIds,
    bbox: row.bbox,
    hasDateLikeField: row.hasDateLikeField,
    hasAmountLikeField: row.hasAmountLikeField,
    multiline: row.multiline,
    sourceAnchor,
    flags,
    diagnostics,
    rawFields,
  };
  const partial: UnresolvedCandidate["partial"] = {
    transactionDate: transactionDate ?? undefined,
    postingDate: postingDate ?? undefined,
    billedAmount: money,
    originalAmount,
    rawDescription: merchantDesc || undefined,
    transactionType,
    direction,
  };

  let status: UnresolvedCandidate["status"] = "partially_parsed";
  if (!transactionDate && !money && !merchantDesc) {
    status = "unable_to_interpret";
    diagnostics.push("no_parsable_fields");
    flags.push("unmatched_source");
  } else if (!transactionDate || !money || !merchantDesc) {
    diagnostics.push("missing_required_fields");
  } else if (
    dateAmbiguous ||
    (fields.postingDate && !postingDate) ||
    flags.includes("ambiguous_amount") ||
    !direction ||
    !transactionType
  ) {
    status = "needs_review";
    diagnostics.push("ambiguous_fields");
  } else {
    const validation = parsedStatementTransactionSchema.safeParse({
      temporaryId: row.rowId,
      transactionDate,
      postingDate: postingDate ?? undefined,
      rawDescription: merchantDesc,
      normalizedMerchant: merchantDesc.replace(/\s+/g, " "),
      transactionType,
      direction,
      billedAmount: money,
      originalAmount,
      source: "statement_pdf",
      sourceAnchor,
      flags,
      reviewStatus: "ready",
    });
    if (validation.success) {
      return {
        ...evidence,
        resolution: "validated",
        status: "successfully_parsed",
        transaction: validation.data,
      };
    }

    diagnostics.push("schema_validation_failed");
    for (const issue of validation.error.issues) {
      diagnostics.push("schema_validation_failed:" + issue.path.join("."));
    }
  }

  return { ...evidence, resolution: "unresolved", status, partial };
}

/**
 * Parses all candidate rows from a ReconstructionResult into parsed candidates.
 */
interface CandidateDocument {
  pageCount: number;
  pages: readonly (PositionedSource & Pick<PageReconstruction, "candidates">)[];
}

export function parseDocumentCandidates(
  reconstruction: CandidateDocument,
  context: StatementContext,
): ParseResult {
  const candidates: ParsedCandidate[] = [];
  const notATransactionIds: string[] = [];
  const unableToInterpretIds: string[] = [];
  const diagnostics: string[] = [];

  for (const page of reconstruction.pages) {
    for (const candidate of page.candidates) {
      const parsed = parseCandidateRow(candidate, context, page);
      candidates.push(parsed);

      switch (parsed.status) {
        case "not_a_transaction":
          notATransactionIds.push(parsed.rowId);
          break;
        case "unable_to_interpret":
          unableToInterpretIds.push(parsed.rowId);
          break;
      }

      diagnostics.push(...parsed.diagnostics.map((d) => `p${parsed.page}: ${d}`));
    }
  }

  return {
    page: reconstruction.pageCount,
    candidates,
    notATransactionIds,
    unableToInterpretIds,
    diagnostics,
  };
}
