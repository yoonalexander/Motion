import "client-only";
import type { TransactionDirection, TransactionType } from "@/schemas/transaction";

type KnownTransactionType = Exclude<TransactionType, "unknown">;

type Classification =
  | { type: KnownTransactionType; confident: true }
  | {
      type: "unknown";
      confident: false;
      diagnostic:
        | "unresolved_transaction_type"
        | "conflicting_transaction_labels"
        | "conflicting_transaction_type_direction";
    };

// The label text is tokenized with Unicode word boundaries before matching.
// Direction restrictions apply only to labels with a clear financial meaning.
const labels: readonly {
  type: KnownTransactionType;
  pattern: RegExp;
  direction?: TransactionDirection;
}[] = [
  {
    type: "refund",
    pattern:
      /(?:^| )(?:REFUND(?:ED)?|CHARGEBACK)(?: |$)|(?:^| )(?:AUTHORI[ZS]ED CREDIT|MERCHANT CREDIT|RETURN)$/,
    direction: "credit",
  },
  {
    type: "payment",
    pattern: /(?:^| )PAYMENT (?:RECEIVED|THANK YOU)(?: |$)/,
    direction: "credit",
  },
  {
    type: "payment",
    pattern:
      /^(?:PAYMENT|AUTOPAY)$|^(?:(?:MONTHLY )?CARD PAYMENT|ONLINE PAYMENT|AUTOMATIC PAYMENT|BILL PAYMENT|PAYMENT (?:TO|SENT))(?: |$)/,
  },
  {
    type: "fee",
    pattern:
      /^FEE$|(?:^| )(?:(?:MONTHLY|ANNUAL) (?:(?:ACCOUNT|CARD) )?FEE|(?:ACCOUNT|CARD|LATE|OVERDRAFT|FOREIGN TRANSACTION|ATM) FEE|SERVICE CHARGE)(?: |$)/,
    direction: "debit",
  },
  {
    type: "interest",
    pattern: /(?:^| )(?:INTEREST CHARGE(?:D)?|FINANCE CHARGE)(?: |$)/,
    direction: "debit",
  },
  {
    type: "interest",
    pattern: /(?:^| )INTEREST (?:EARNED|CREDIT)(?: |$)/,
    direction: "credit",
  },
  { type: "interest", pattern: /^INTEREST$/ },
  {
    type: "transfer",
    pattern:
      /^TRANSFER$|(?:^| )(?:(?:BALANCE|WIRE|FUNDS|ACH|E) TRANSFER|TRANSFER (?:TO|FROM))(?: |$)/,
  },
  {
    type: "deposit",
    pattern: /^DEPOSIT$|(?:^| )(?:(?:DIRECT|PAYROLL|CASH|MOBILE) DEPOSIT|DEPOSIT RECEIVED)(?: |$)/,
    direction: "credit",
  },
  { type: "adjustment", pattern: /(?:^| )ADJUSTMENT$/ },
  {
    type: "purchase",
    pattern: /^PURCHASE$|^(?:DEBIT |CREDIT )?CARD PURCHASE(?: |$)/,
    direction: "debit",
  },
];

const otherLedgerLabels =
  /^(?:CREDIT|DEBIT|CR|DR|REVERSAL)$|(?:^| )(?:CASH ADVANCE|(?:ATM|CASH) WITHDRAWAL|BALANCE FORWARD|PAYMENT REVERSAL|PAYMENT RETURNED)(?: |$)/;

export function inferTransactionType(
  description: string,
  direction?: TransactionDirection,
): Classification {
  const text =
    description
      .normalize("NFKC")
      .toUpperCase()
      .match(/[\p{L}\p{M}\p{N}]+/gu)
      ?.join(" ") ?? "";
  const hasOtherLedgerLabel = otherLedgerLabels.test(text);
  const matches = hasOtherLedgerLabel ? [] : labels.filter(({ pattern }) => pattern.test(text));
  const [match] = matches;
  if (match && matches.some(({ type }) => type !== match.type)) {
    return { type: "unknown", confident: false, diagnostic: "conflicting_transaction_labels" };
  }
  if (direction && matches.some((rule) => rule.direction && rule.direction !== direction)) {
    return {
      type: "unknown",
      confident: false,
      diagnostic: "conflicting_transaction_type_direction",
    };
  }
  if (match) return { type: match.type, confident: true };

  // Debit evidence supports an ordinary merchant purchase. An unidentified
  // credit may instead be a refund, payment, transfer, deposit, or adjustment.
  if (direction === "debit" && /\p{L}/u.test(text) && !hasOtherLedgerLabel) {
    return { type: "purchase", confident: true };
  }
  return { type: "unknown", confident: false, diagnostic: "unresolved_transaction_type" };
}
