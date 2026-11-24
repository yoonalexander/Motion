import "client-only";
import { z } from "zod";
import { parseAmount } from "./money-parser";
import type { CandidateTransactionRow } from "./text-reconstructor";
import type { ExtractedPage } from "./text-extractor";
import { findDateSpans, parseDate } from "./date-parser";
export { findDateSpans, parseDate } from "./date-parser";
export type { DateSpan } from "./date-parser";
import {
  parsedTransactionSchema,
  moneySchema,
  isoDateSchema,
  currencyCodeSchema,
  transactionTypeSchema,
  classificationFlagSchema,
  reviewStatusSchema,
  pdfAnchorSchema,
  type ParsedTransaction,
  type Money,
  type PdfAnchor,
  type ClassificationFlag,
} from "@/schemas/transaction";

export { parseAmount } from "./money-parser";

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
  accountLabel?: string;
  accountLast4?: string;
  bankName?: string;
}

export interface ParsedCandidate {
  rowId: string;
  page: number;
  str: string;
  bbox: [number, number, number, number];
  tokenIds: string[];
  status: ParsingStatus;
  transaction?: ParsedTransaction;
  flags: ClassificationFlag[];
  diagnostics: string[];
  rawFields: RawParsedFields;
}

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
  detectedType: string | null; // transaction type or null
  detectedMerchant: string | null; // raw description text or null
  yearInferred: boolean;
  amountSignNegative: boolean;
  amountInParentheses: boolean;
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
// Transaction type inference
// ---------------------------------------------------------------------------

const typeKeywords: Record<string, string[]> = {
  refund: ["refund", "return", "reversal", "chargeback"],
  payment: ["payment", "pay", "thank you", "autopay", "online payment"],
  fee: ["fee", "annual fee", "late fee", "service charge", "account fee"],
  interest: ["interest", "finance charge"],
  transfer: ["transfer", "balance transfer", "wire transfer"],
  deposit: ["deposit", "credit", "direct deposit"],
};

export function inferTransactionType(
  description: string,
  amountSignNegative: boolean,
  inParentheses: boolean
): { type: string; confident: boolean } {
  const upper = description.toUpperCase();

  // Check for explicit type keywords
  for (const [type, keywords] of Object.entries(typeKeywords)) {
    for (const kw of keywords) {
      if (upper.includes(kw.toUpperCase())) {
        return { type, confident: true };
      }
    }
  }

  // Negative amount without explicit type → likely purchase or adjustment
  if (amountSignNegative || inParentheses) {
    return { type: "purchase", confident: false };
  }

  // Positive amount → could be payment, deposit, or refund
  return { type: "unknown", confident: false };
}

// ---------------------------------------------------------------------------
// Merchant description extraction
// ---------------------------------------------------------------------------

/**
 * Extracts a merchant description from a candidate row string.
 * Removes date and amount tokens, preserving multiline content.
 */
export function extractMerchantDescription(
  rowStr: string,
  rawFields: RawParsedFields
): string {
  let desc = rowStr;

  // Remove detected date strings
  for (const dateStr of rawFields.dateLikeMatches) {
    desc = desc.replace(dateStr, " ").trim();
  }

  // Remove detected amount strings
  for (const amountStr of rawFields.amountLikeMatches) {
    desc = desc.replace(amountStr, " ").trim();
  }

  // Remove currency codes
  desc = desc.replace(/\b[A-Z]{3}\b/g, " ").trim();

  // Collapse whitespace
  desc = desc.replace(/\s+/g, " ").trim();

  return desc;
}

// ---------------------------------------------------------------------------
// Main parser
// ---------------------------------------------------------------------------

const amountPattern = /-?\d[\d,]*(?:\.\d{1,2})?|\(-?\d[\d,]*(?:\.\d{1,2})?\)/;

/**
 * Parses a CandidateTransactionRow into a validated financial record.
 *
 * Returns a ParsedCandidate with status, parsed transaction (if successful),
 * flags, diagnostics, and raw extracted fields.
 */
export function parseCandidateRow(
  row: CandidateTransactionRow,
  context: StatementContext,
  pageTokens?: ExtractedPage
): ParsedCandidate {
  const rawFields: RawParsedFields = {
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

  const flags: ClassificationFlag[] = [];
  const diagnostics: string[] = [];

  // Extract date-like and amount-like matches from the row string
  const dateSpans = findDateSpans(row.str);
  const dateMatches = dateSpans.map((span) => span.raw);
  const amountSearch = row.str.split("");
  for (const span of [...dateSpans].sort((a, b) => b.start - a.start)) {
    amountSearch.splice(span.start, span.end - span.start, ..." ".repeat(span.end - span.start));
  }
  const amountMatches = [...(amountSearch.join("").match(amountPattern) ?? [])];
  rawFields.dateLikeMatches = dateMatches;
  rawFields.amountLikeMatches = amountMatches;

  // Parse dates
  let transactionDate: string | null = null;
  let postingDate: string | null = null;
  let dateAmbiguous = false;

  if (dateMatches.length >= 1) {
    const first = parseDate(dateMatches[0]!, context);
    transactionDate = first.isoDate;
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

  if (dateMatches.length >= 2) {
    const second = parseDate(dateMatches[1]!, context);
    postingDate = second.isoDate;
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

  if (!transactionDate) {
    flags.push("ambiguous_date");
    diagnostics.push("no_date_found");
  }

  // Parse amount
  let money: Money | undefined;

  if (amountMatches.length >= 1) {
    const { amountMinor, currency, exponent, signNegative, inParentheses, diagnostic } =
      parseAmount(amountMatches[0]!, context);
    rawFields.amountSignNegative = signNegative;
    rawFields.amountInParentheses = inParentheses;
    rawFields.detectedAmountMinor = amountMinor;
    rawFields.detectedCurrency = currency;
    if (amountMinor !== null && currency !== null && exponent !== null) {
      money = { amountMinor, currency, exponent };
    }
    if (diagnostic) {
      flags.push("ambiguous_amount");
      diagnostics.push(diagnostic);
    }
  } else {
    flags.push("missing_amount");
    diagnostics.push("no_amount_found");
  }

  // Infer transaction type
  const { amountSignNegative, amountInParentheses } = rawFields;
  const merchantDesc = extractMerchantDescription(row.str, rawFields);
  rawFields.detectedMerchant = merchantDesc;
  const typeInfo = inferTransactionType(
    merchantDesc,
    amountSignNegative,
    amountInParentheses
  );
  rawFields.detectedType = typeInfo.type;

  let transactionType = typeInfo.type;
  if (!typeInfo.confident) {
    if (merchantDesc.toUpperCase().includes("REFUND")) {
      transactionType = "refund";
    } else if (merchantDesc.toUpperCase().includes("PAYMENT")) {
      transactionType = "payment";
    } else if (merchantDesc.toUpperCase().includes("FEE")) {
      transactionType = "fee";
    } else if (merchantDesc.toUpperCase().includes("INTEREST")) {
      transactionType = "interest";
    } else if (amountSignNegative || amountInParentheses) {
      transactionType = "purchase";
    } else {
      transactionType = "unknown";
    }
  }

  // Determine parsing status
  let status: ParsingStatus;
  const hasDate = !!transactionDate;
  const hasAmount = money !== undefined;
  const hasMerchant = merchantDesc.length > 0;

  if (!hasDate && !hasAmount && !hasMerchant) {
    status = "unable_to_interpret";
    diagnostics.push("no_parsable_fields");
  } else if (!hasDate || !hasAmount) {
    status = "partially_parsed";
    diagnostics.push("missing_required_fields");
  } else if (dateAmbiguous || !typeInfo.confident) {
    status = "needs_review";
    diagnostics.push("ambiguous_fields");
  } else {
    status = "successfully_parsed";
  }

  // Build the validated transaction if possible
  let transaction: ParsedTransaction | undefined;

  if (money && (status === "successfully_parsed" || status === "needs_review")) {
    const candidateTransaction: Partial<ParsedTransaction> = {
      temporaryId: row.rowId,
      transactionDate: transactionDate || undefined,
      postingDate: postingDate || undefined,
      rawDescription: merchantDesc || row.str,
      normalizedMerchant: merchantDesc || undefined,
      transactionType: transactionType as z.infer<typeof transactionTypeSchema>,
      billedAmount: money,
      source: "statement_pdf",
      sourceAnchor: {
        page: row.page,
        bbox: row.bbox,
        tokenIds: row.tokenIds,
      },
      confidence: {},
      flags,
      reviewStatus: status === "successfully_parsed" ? "ready" : "needs_review",
    };

    // Validate against Zod schema
    const validationResult = parsedTransactionSchema.safeParse(
      candidateTransaction
    );

    if (validationResult.success) {
      transaction = validationResult.data;
    } else {
      // Schema validation failed - downgrade status
      status = "partially_parsed";
      diagnostics.push("schema_validation_failed");
      flags.push("ambiguous_amount");
      // Still create a partial transaction without strict validation
      transaction = {
        temporaryId: row.rowId,
        rawDescription: merchantDesc || row.str,
        transactionType: "unknown" as z.infer<typeof transactionTypeSchema>,
        billedAmount: money,
        source: "statement_pdf",
        sourceAnchor: {
          page: row.page,
          bbox: row.bbox,
          tokenIds: row.tokenIds,
        },
        confidence: {},
        flags,
        reviewStatus: "needs_review",
      } as unknown as ParsedTransaction;
    }
  }

  if (status === "unable_to_interpret") {
    flags.push("unmatched_source");
  }

  return {
    rowId: row.rowId,
    page: row.page,
    str: row.str,
    bbox: row.bbox,
    tokenIds: row.tokenIds,
    status,
    transaction,
    flags,
    diagnostics,
    rawFields,
  };
}

/**
 * Parses all candidate rows from a ReconstructionResult into parsed candidates.
 */
export function parseDocumentCandidates(
  reconstruction: any, // ReconstructionResult
  context: StatementContext
): ParseResult {
  const candidates: ParsedCandidate[] = [];
  const notATransactionIds: string[] = [];
  const unableToInterpretIds: string[] = [];
  const diagnostics: string[] = [];

  for (const page of reconstruction.pages) {
    for (const candidate of page.candidates) {
      const parsed = parseCandidateRow(candidate, context);
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
