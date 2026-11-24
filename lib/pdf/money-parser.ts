import "client-only";
import type { StatementContext } from "./transaction-parser";

type DecimalSeparator = "." | ",";
type AmountDirection = "credit" | "debit";

interface ParsedAmount {
  amountMinor: string | null;
  currency: string | null;
  exponent: number | null;
  signNegative: boolean;
  inParentheses: boolean;
  direction: AmountDirection | null;
  ambiguous: boolean;
  diagnostic:
    | "invalid_amount"
    | "ambiguous_separator"
    | "unsupported_precision"
    | "unresolved_currency"
    | "unsupported_currency"
    | "conflicting_currency"
    | null;
}

// SIX (ISO 4217 Maintenance Agency), List One, published 2026-09-17.
// https://www.six-group.com/dam/download/financial-information/data-center/iso-currrency/lists/list-one.xml
// Entries without a numeric minor unit (e.g. XAU, XXX) are deliberately omitted.
const codesByExponent = [
  { exponent: 0, codes: "BIF CLP DJF GNF ISK JPY KMF KRW PYG RWF UGX UYI VND VUV XAF XOF XPF" },
  {
    exponent: 2,
    codes: `AED AFN ALL AMD AOA ARS AUD AWG AZN BAM BBD BDT BMD BND BOB BOV BRL
    BSD BTN BWP BYN BZD CAD CDF CHE CHF CHW CNY COP COU CRC CUP CVE CZK
    DKK DOP DZD EGP ERN ETB EUR FJD FKP GBP GEL GHS GIP GMD GTQ GYD HKD
    HNL HTG HUF IDR ILS INR IRR JMD KES KGS KHR KPW KYD KZT LAK LBP LKR
    LRD LSL MAD MDL MGA MKD MMK MNT MOP MRU MUR MVR MWK MXN MXV MYR MZN
    NAD NGN NIO NOK NPR NZD PAB PEN PGK PHP PKR PLN QAR RON RSD RUB SAR
    SBD SCR SDG SEK SGD SHP SLE SOS SRD SSP STN SVC SYP SZL THB TJS TMT
    TOP TRY TTD TWD TZS UAH USD USN UYU UZS VED VES WST XAD XCD XCG YER
    ZAR ZMW ZWG`,
  },
  { exponent: 3, codes: "BHD IQD JOD KWD LYD OMR TND" },
  { exponent: 4, codes: "CLF UYW" },
];

const currencyExponents = new Map(
  codesByExponent.flatMap(({ exponent, codes }) =>
    codes.split(/\s+/).map((code) => [code, exponent] as const),
  ),
);

const currencySymbols: Record<string, readonly string[]> = {
  $: [
    "ARS",
    "AUD",
    "BBD",
    "BMD",
    "BND",
    "BSD",
    "BZD",
    "CAD",
    "CLP",
    "COP",
    "CUP",
    "DOP",
    "FJD",
    "GYD",
    "HKD",
    "JMD",
    "KYD",
    "LRD",
    "MXN",
    "NAD",
    "NIO",
    "NZD",
    "SBD",
    "SGD",
    "SRD",
    "TTD",
    "TWD",
    "USD",
    "UYU",
    "XCD",
  ],
  A$: ["AUD"],
  AU$: ["AUD"],
  C$: ["CAD", "NIO"],
  CA$: ["CAD"],
  HK$: ["HKD"],
  NT$: ["TWD"],
  NZ$: ["NZD"],
  R$: ["BRL"],
  SG$: ["SGD"],
  US$: ["USD"],
  "£": ["EGP", "FKP", "GBP", "GIP", "LBP", "SDG", "SHP", "SSP", "SYP"],
  "€": ["EUR"],
  "¥": ["CNY", "JPY"],
  "CN¥": ["CNY"],
  "JP¥": ["JPY"],
  "₹": ["INR"],
  "₩": ["KPW", "KRW"],
};

const codePattern = /^[A-Z]{3}$/;
const symbolPattern = /^(?:[A-Z]+)?\p{Sc}$/u;
const affixTokenPattern = /[A-Z]+\p{Sc}|[A-Z]+|\p{Sc}|[^\s]/gu;
const digitPattern = /^\d+$/;

function decimalParts(raw: string, separator: DecimalSeparator) {
  const [integer, fraction, extra] = raw.split(separator);
  if (extra !== undefined || (fraction !== undefined && !digitPattern.test(fraction))) {
    return null;
  }

  if (integer === "" && fraction !== undefined) {
    return { whole: "0", fraction };
  }

  const isGrouped = /^[1-9]\d{0,2}([., '])\d{3}(?:\1\d{3})*$/.test(integer);
  if (!digitPattern.test(integer) && !isGrouped) {
    return null;
  }

  return { whole: integer.replace(/[., ']/g, ""), fraction: fraction ?? "" };
}

/**
 * Parses one complete amount field. The magnitude and the printed sign and
 * direction are separate because institutions use different ledger conventions.
 */
export function parseAmount(raw: string, context: StatementContext): ParsedAmount {
  const unresolved: ParsedAmount = {
    amountMinor: null,
    currency: null,
    exponent: null,
    signNegative: false,
    inParentheses: false,
    direction: null,
    ambiguous: true,
    diagnostic: "invalid_amount",
  };

  const normalized = raw
    .trim()
    .toUpperCase()
    .replace(/[\u00a0\u202f]/g, " ")
    .replace(/’/g, "'")
    .replace(/−/g, "-")
    .replace(/￥/g, "¥")
    .replace(/＄/g, "$");
  const match = /^([^\d.,']*)([.,]?\d[\d., ']*)([^\d.,']*)$/.exec(normalized);
  if (!match) {
    return unresolved;
  }

  const [, before, numeric, after] = match;
  const prefix: string[] = before.match(affixTokenPattern) ?? [];
  const suffix: string[] = after.match(affixTokenPattern) ?? [];
  if (prefix.includes(")") || suffix.includes("(")) {
    return unresolved;
  }

  const markers = [...prefix, ...suffix];
  const opens = prefix.filter((token) => token === "(").length;
  const closes = suffix.filter((token) => token === ")").length;
  const signs = markers.filter((token) => token === "+" || token === "-");
  const directions = markers.filter((token) => token === "CR" || token === "DR");
  const codes = markers.filter((token) => codePattern.test(token));
  const symbols = markers.filter((token) => symbolPattern.test(token));
  const recognizedCount =
    opens + closes + signs.length + directions.length + codes.length + symbols.length;

  if (
    recognizedCount !== markers.length ||
    opens !== closes ||
    opens > 1 ||
    signs.length + opens > 1 ||
    directions.length > 1 ||
    codes.length > 1 ||
    symbols.length > 1
  ) {
    return unresolved;
  }

  unresolved.inParentheses = opens === 1;
  unresolved.signNegative = unresolved.inParentheses || signs[0] === "-";
  unresolved.direction =
    directions[0] === "CR" ? "credit" : directions[0] === "DR" ? "debit" : null;

  const [code] = codes;
  const [symbol] = symbols;
  const symbolCurrencies = symbol ? currencySymbols[symbol] : undefined;
  if ((symbol && !symbolCurrencies) || (code && !currencyExponents.has(code))) {
    return { ...unresolved, diagnostic: "unsupported_currency" };
  }
  if (code && symbolCurrencies && !symbolCurrencies.includes(code)) {
    return { ...unresolved, diagnostic: "conflicting_currency" };
  }

  const statementCurrency = context.currency?.trim().toUpperCase() ?? "";
  const currencyFromSymbol = symbolCurrencies?.length === 1 ? symbolCurrencies[0] : undefined;
  const compatibleStatementCurrency =
    !symbolCurrencies || symbolCurrencies.includes(statementCurrency) ? statementCurrency : "";
  const currency = code ?? currencyFromSymbol ?? compatibleStatementCurrency;
  if (!currency) {
    return { ...unresolved, diagnostic: "unresolved_currency" };
  }

  const exponent = currencyExponents.get(currency);
  if (exponent === undefined) {
    return { ...unresolved, diagnostic: "unsupported_currency" };
  }
  unresolved.currency = currency;
  unresolved.exponent = exponent;

  // A currency code alone does not establish a statement's decimal convention.
  const number = numeric.trim();
  const dot = context.decimalSeparator !== "," ? decimalParts(number, ".") : null;
  const comma = context.decimalSeparator !== "." ? decimalParts(number, ",") : null;
  if (dot && comma && (dot.whole !== comma.whole || dot.fraction !== comma.fraction)) {
    return { ...unresolved, diagnostic: "ambiguous_separator" };
  }

  const parts = dot ?? comma;
  if (!parts) {
    return unresolved;
  }
  if (parts.fraction.length > exponent) {
    return { ...unresolved, diagnostic: "unsupported_precision" };
  }

  const amountMinor = (parts.whole + parts.fraction.padEnd(exponent, "0")).replace(/^0+(?=\d)/, "");
  return { ...unresolved, amountMinor, ambiguous: false, diagnostic: null };
}
