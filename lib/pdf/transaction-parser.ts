import "client-only";
import { z } from "zod";
import type { CandidateTransactionRow } from "./text-reconstructor";
import type { ExtractedPage } from "./text-extractor";
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

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface StatementContext {
  periodStart?: string; // ISO date YYYY-MM-DD
  periodEnd?: string; // ISO date YYYY-MM-DD
  currency?: string; // ISO 4217 code
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

// ---------------------------------------------------------------------------
// Date parsing
// ---------------------------------------------------------------------------

const isoDatePattern = /^(\d{4})[-\/](\d{1,2})[-\/](\d{1,2})$/;
const usDatePattern = /^(\d{1,2})[-\/](\d{1,2})[-\/](\d{2,4})$/;
const euDatePattern = /^(\d{1,2})[-\/](\d{1,2})[-\/](\d{2,4})$/;

/**
 * Parses a date string into ISO YYYY-MM-DD format.
 *
 * Handles multiple formats:
 * - YYYY-MM-DD (ISO)
 * - MM/DD/YYYY (US)
 * - DD/MM/YYYY (European)
 * - MM/DD/YY and DD/MM/YY (two-digit years)
 *
 * Ambiguity between MM/DD and DD/MM is resolved by:
 * - If first number > 12, it must be DD/MM (day first)
 * - If second number > 12, it must be MM/DD (month first)
 * - Otherwise defaults to MM/DD (US) but flags as ambiguous
 *
 * Year inference: two-digit years are expanded relative to the statement
 * period context (defaulting to 2000-2099 range).
 */
export function parseDate(
  raw: string,
  context: StatementContext
): { isoDate: string | null; ambiguous: boolean; yearInferred: boolean } {
  const trimmed = raw.trim();
  let yearInferred = false;

  // Try ISO format first: YYYY-MM-DD
  const isoMatch = trimmed.match(isoDatePattern);
  if (isoMatch) {
    const [, y, m, d] = isoMatch;
    const iso = `${y.padStart(4, "0")}-${m.padStart(2, "0")}-${d.padStart(2, "0")}`;
    if (isValidCalendarDate(iso)) {
      return { isoDate: iso, ambiguous: false, yearInferred: false };
    }
    return { isoDate: null, ambiguous: true, yearInferred: false };
  }

  // Try slash/dash separated: M/D/YYYY or D/M/YYYY
  const slashMatch = trimmed.match(
    /^(\d{1,2})[-\/](\d{1,2})[-\/](\d{2,4})$/
  );
  if (!slashMatch) {
    return { isoDate: null, ambiguous: true, yearInferred: false };
  }

  const [, n1, n2, yearStr] = slashMatch;
  const num1 = parseInt(n1, 10);
  const num2 = parseInt(n2, 10);
  let year = parseInt(yearStr, 10);

  // Two-digit year expansion
  if (yearStr.length === 2) {
    yearInferred = true;
    const currentYear = context.periodEnd
      ? parseInt(context.periodEnd.slice(0, 4), 10)
      : new Date().getFullYear();
    if (year <= 50) {
      year = 2000 + year;
    } else {
      year = 1900 + year;
    }
    // Clamp to statement period ±1 year
    if (context.periodStart) {
      const periodYear = parseInt(context.periodStart.slice(0, 4), 10);
      if (year < periodYear - 1) year = periodYear - 1;
      if (year > periodYear + 1) year = periodYear + 1;
    }
  }

  let month: number;
  let day: number;
  let ambiguous = false;

  if (num1 > 12 && num2 <= 12) {
    // Must be DD/MM (day first)
    day = num1;
    month = num2;
  } else if (num2 > 12 && num1 <= 12) {
    // Must be MM/DD (month first)
    month = num1;
    day = num2;
  } else if (num1 <= 12 && num2 <= 12) {
    // Truly ambiguous: could be MM/DD or DD/MM
    // Default to MM/DD (US convention) but flag as ambiguous
    month = num1;
    day = num2;
    ambiguous = true;
  } else {
    // Both > 12: invalid
    return { isoDate: null, ambiguous: true, yearInferred: false };
  }

  const iso = `${year}-${month.toString().padStart(2, "0")}-${day
    .toString()
    .padStart(2, "0")}`;
  if (isValidCalendarDate(iso)) {
    return { isoDate: iso, ambiguous, yearInferred };
  }
  return { isoDate: null, ambiguous: true, yearInferred: false };
}

function isValidCalendarDate(iso: string): boolean {
  const date = new Date(`${iso}T00:00:00Z`);
  return (
    !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === iso
  );
}

// ---------------------------------------------------------------------------
// Amount parsing
// ---------------------------------------------------------------------------

/**
 * Parses a monetary amount string into integer minor units.
 *
 * Handles:
 * - Thousands separators: 1,234.56
 * - European format: 1.234,56 (period as thousands, comma as decimal)
 * - Negative values: -100.00, (100.00)
 * - Parentheses indicating negative: (100.00)
 * - Debit/credit columns: sign determined by column context
 * - Currency symbols: $, £, €, ¥
 *
 * Returns null if the amount cannot be confidently parsed.
 */
export function parseAmount(
  raw: string,
  context: StatementContext
): {
  amountMinor: string | null;
  currency: string | null;
  signNegative: boolean;
  inParentheses: boolean;
  ambiguous: boolean;
} {
  let trimmed = raw.trim();
  let signNegative = false;
  let inParentheses = false;
  let ambiguous = false;

  // Detect parentheses (accounting convention for negative)
  const parenMatch = trimmed.match(/^\((.+)\)$/);
  if (parenMatch) {
    inParentheses = true;
    signNegative = true;
    trimmed = parenMatch[1].trim();
  }

  // Detect leading minus sign
  if (trimmed.startsWith("-")) {
    signNegative = true;
    trimmed = trimmed.slice(1).trim();
  }

  // Detect leading plus sign
  if (trimmed.startsWith("+")) {
    trimmed = trimmed.slice(1).trim();
  }

  // Detect currency symbols and codes
  let detectedCurrency: string | null = null;
  const currencySymbolMap: Record<string, string> = {
    "$": "USD",
    "£": "GBP",
    "€": "EUR",
    "¥": "JPY",
    "₹": "INR",
    "₩": "KRW",
    "R$": "BRL",
    "C$": "CAD",
    "A$": "AUD",
  };
  for (const [symbol, code] of Object.entries(currencySymbolMap)) {
    if (trimmed.startsWith(symbol)) {
      detectedCurrency = code;
      trimmed = trimmed.slice(symbol.length).trim();
      break;
    }
  }
  // Also check for ISO code at start or end
  const isoCodeMatch = trimmed.match(/^[A-Z]{3}\s+(.+)|(.+)\s+[A-Z]{3}$/);
  if (isoCodeMatch && !detectedCurrency) {
    detectedCurrency = isoCodeMatch[1] ?? isoCodeMatch[2];
    trimmed = trimmed.replace(/^[A-Z]{3}\s+/, "").replace(/\s+[A-Z]{3}$/, "").trim();
  }

  // Fall back to statement context currency
  if (!detectedCurrency && context.currency) {
    detectedCurrency = context.currency;
  }

  // Remove thousands separators and parse
  // Strategy: try to identify decimal separator
  // - If string contains both . and ,, the last one is the decimal separator
  // - If only ., it's the decimal separator (US/UK)
  // - If only ,, it could be decimal (European) or thousands (ambiguous)
  let numericPart = trimmed;

  const lastDot = numericPart.lastIndexOf(".");
  const lastComma = numericPart.lastIndexOf(",");

  let decimalSeparator: "." | "," | null = null;
  let thousandsSeparator: "." | "," | null = null;

  if (lastDot >= 0 && lastComma >= 0) {
    // Both present: the last one is the decimal separator
    if (lastDot > lastComma) {
      decimalSeparator = ".";
      thousandsSeparator = ",";
    } else {
      decimalSeparator = ",";
      thousandsSeparator = ".";
    }
  } else if (lastDot >= 0) {
    // Only dots: could be 1.234 (thousands) or 1.234.56 (invalid) or 1.56 (decimal)
    const parts = numericPart.split(".");
    if (parts.length === 2 && parts[1].length <= 2) {
      decimalSeparator = ".";
    } else if (parts.length > 2) {
      // Multiple dots: first are thousands, last is decimal if last part <= 2 digits
      const lastPart = parts[parts.length - 1];
      if (lastPart.length <= 2) {
        decimalSeparator = ".";
        thousandsSeparator = ".";
      } else {
        ambiguous = true;
      }
    } else {
      // Single dot: could be thousands (1.234) or decimal (1.56)
      if (parts[1].length === 3) {
        // Likely thousands separator: 1.234
        thousandsSeparator = ".";
      } else {
        // Likely decimal: 1.56
        decimalSeparator = ".";
      }
    }
  } else if (lastComma >= 0) {
    // Only commas: could be 1,234 (thousands) or 1,234.56 (no, no dots) or 1,56 (decimal European)
    const parts = numericPart.split(",");
    if (parts.length === 2 && parts[1].length <= 2) {
      decimalSeparator = ",";
    } else if (parts.length > 2) {
      // Multiple commas: thousands separators
      thousandsSeparator = ",";
    } else {
      // Single comma: ambiguous
      if (parts[1].length === 3) {
        thousandsSeparator = ",";
      } else {
        decimalSeparator = ",";
        ambiguous = true;
      }
    }
  }

  // Remove thousands separators
  if (thousandsSeparator) {
    numericPart = numericPart.split(thousandsSeparator).join("");
  }

  // Replace decimal separator with dot for parsing
  if (decimalSeparator === ",") {
    numericPart = numericPart.replace(",", ".");
  }

  // Parse the number
  const num = parseFloat(numericPart);
  if (Number.isNaN(num)) {
    return {
      amountMinor: null,
      currency: detectedCurrency,
      signNegative: false,
      inParentheses: false,
      ambiguous: true,
    };
  }

  // Determine exponent from currency
  let exponent = 2;
  if (detectedCurrency) {
    const currencyExponents: Record<string, number> = {
      JPY: 0,
      KRW: 0,
      USD: 2,
      GBP: 2,
      EUR: 2,
      CAD: 2,
      INR: 2,
    };
    exponent = currencyExponents[detectedCurrency] ?? 2;
  }

  // Convert to minor units
  const amountMinor = Math.round(num * Math.pow(10, exponent)).toString();

  return {
    amountMinor,
    currency: detectedCurrency,
    signNegative,
    inParentheses,
    ambiguous,
  };
}

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

const datePattern = /\d{1,2}[\/\-]\d{1,2}[\/\-]\d{2,4}|\d{4}[\/\-]\d{1,2}[\/\-]\d{1,2}/;
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
  const dateMatches = row.str.match(datePattern) ?? [];
  const amountMatches = row.str.match(amountPattern) ?? [];
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
  let amountMinor: string | null = null;
  let currency: string | null = context.currency ?? null;
  let amountSignNegative = false;
  let amountInParentheses = false;
  let amountAmbiguous = false;

  if (amountMatches.length >= 1) {
    const parsed = parseAmount(amountMatches[0]!, context);
    amountMinor = parsed.amountMinor;
    currency = parsed.currency ?? currency;
    amountSignNegative = parsed.signNegative;
    amountInParentheses = parsed.inParentheses;
    amountAmbiguous = parsed.ambiguous;
    rawFields.amountSignNegative = amountSignNegative;
    rawFields.amountInParentheses = amountInParentheses;
    if (parsed.amountMinor) {
      rawFields.detectedAmountMinor = parsed.amountMinor;
    }
    if (parsed.currency) {
      rawFields.detectedCurrency = parsed.currency;
    }
    if (parsed.ambiguous) {
      flags.push("ambiguous_amount");
      diagnostics.push("ambiguous_amount_format");
    }
  } else {
    flags.push("missing_amount");
    diagnostics.push("no_amount_found");
  }

  rawFields.detectedAmountMinor = amountMinor;
  rawFields.detectedCurrency = currency;

  // Infer transaction type
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
  const hasAmount = !!amountMinor;
  const hasMerchant = merchantDesc.length > 0;

  if (!hasDate && !hasAmount && !hasMerchant) {
    status = "unable_to_interpret";
    diagnostics.push("no_parsable_fields");
  } else if (!hasDate || !hasAmount) {
    status = "partially_parsed";
    diagnostics.push("missing_required_fields");
  } else if (dateAmbiguous || amountAmbiguous || !typeInfo.confident) {
    status = "needs_review";
    diagnostics.push("ambiguous_fields");
  } else {
    status = "successfully_parsed";
  }

  // Build the validated transaction if possible
  let transaction: ParsedTransaction | undefined;

  if (status === "successfully_parsed" || status === "needs_review") {
    const money: Money = {
      amountMinor: amountMinor!,
      currency: currency || "USD",
      exponent: currency === "JPY" || currency === "KRW" ? 0 : 2,
    };

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
