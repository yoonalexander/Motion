import "client-only";
import type { PdfAnchor } from "@/schemas/transaction";
import { findDateSpans } from "./date-parser";
import { isSupportedCurrencyCode } from "./money-parser";
import type { ExtractedToken } from "./text-extractor";
import type { CandidateTransactionRow, TextLine } from "./text-reconstructor";

interface Range {
  start: number;
  end: number;
}

export interface FieldSpan extends Range {
  raw: string;
  /** Covers the contributing PDF text runs, which may extend past this span. */
  anchor?: PdfAnchor;
}

export interface ParsedFieldSpans {
  dates: FieldSpan[];
  amounts: FieldSpan[];
  transactionDate?: FieldSpan;
  postingDate?: FieldSpan;
  billedAmount?: FieldSpan;
  originalAmount?: FieldSpan;
  description: FieldSpan[];
  fxMetadata: FieldSpan[];
}

export interface PositionedSource {
  tokens: readonly ExtractedToken[];
  lines?: readonly TextLine[];
  width?: number;
  height?: number;
}

type Column = "transactionDate" | "postingDate" | "description" | "amount" | "debit" | "credit";
type AmountEvidence = FieldSpan & {
  explicit: boolean;
  spaceGrouped: boolean;
  ambiguousCurrencyPrefix: boolean;
  column?: Column;
};

function locateTokens(str: string, ids: string[], tokens: ReadonlyMap<string, ExtractedToken>) {
  const located: (Range & { token: ExtractedToken })[] = [];
  let cursor = 0;
  for (const id of ids) {
    const token = tokens.get(id);
    if (!token) continue;
    const start = str.indexOf(token.str, cursor);
    if (start === -1) continue;
    cursor = start + token.str.length;
    located.push({ start, end: cursor, token });
  }
  return located;
}

function overlaps(first: Range, second: Range): boolean {
  return first.start < second.end && second.start < first.end;
}

function isLedgerColumn(kind: Column | undefined): boolean {
  return kind === "amount" || kind === "debit" || kind === "credit";
}

const amountHeaderPattern = /^(?:(?:([A-Z]{3})|BILLED) )?AMOUNT(?: ([A-Z]{3}))?$/;

function columnKind(label: string): Column | undefined {
  if (/^(?:DATE|PURCHASE(?: DATE)?|TRANS(?:ACTION)? DATE)$/.test(label)) return "transactionDate";
  if (/^(?:POST(?:ED|ING)?(?: DATE)?|PROCESS(?:ED|ING)? DATE)$/.test(label)) return "postingDate";
  if (/^(?:DESCRIPTION|DETAILS|MERCHANT|PAYEE|TRANSACTION DESCRIPTION)$/.test(label)) {
    return "description";
  }
  if (/^DEBITS?(?: AMOUNT)?$/.test(label)) return "debit";
  if (/^CREDITS?(?: AMOUNT)?$/.test(label)) return "credit";
  if (amountHeaderPattern.test(label)) return "amount";
}

function headerColumns(
  source: PositionedSource | undefined,
  tokens: ReadonlyMap<string, ExtractedToken>,
  firstLine: TextLine | undefined,
) {
  if (!source?.lines || !firstLine) return [];
  const rowY = firstLine.baselineY ?? firstLine.yCenter;
  const earlier = source.lines
    .filter((line) => (line.baselineY ?? line.yCenter) > rowY)
    .sort((left, right) => (left.baselineY ?? left.yCenter) - (right.baselineY ?? right.yCenter));
  for (const line of earlier) {
    // A geometry-bearing header must identify independent date, description,
    // and money cells. Arbitrary prose mentioning one of those is insufficient.
    const columns = line.tokenIds.flatMap((id) => {
      const token = tokens.get(id);
      if (!token) return [];
      const label = token.str.trim().replace(/[.:]/g, "").replace(/\s+/g, " ").toUpperCase();
      const kind = columnKind(label);
      if (!kind) return [];
      const currencies = (amountHeaderPattern.exec(label)?.slice(1) ?? []).filter(Boolean);
      return [{ kind, center: (token.bbox[0] + token.bbox[2]) / 2, currencies }];
    });
    if (
      columns.some(({ kind }) => kind === "transactionDate" || kind === "postingDate") &&
      columns.some(({ kind }) => kind === "description") &&
      columns.some(({ kind }) => isLedgerColumn(kind))
    ) {
      return columns;
    }
    if (
      columns.length >= 2 ||
      /^(?:transactions?|(?:account|card|transaction) (?:activity|summary)|payments and credits|balance summary)$/i.test(
        line.str.trim().replace(/:$/, ""),
      )
    ) {
      break;
    }
  }
  return [];
}

const numberPattern =
  /(?<![\p{L}\d#.,/])(?:\(?\s*[+−-]?\s*(?:(?:[A-Z]{1,3})?\p{Sc}\s*)?[+−-]?\s*)(?:\d{1,3}(?:[ \u00a0\u202f'’]\d{3})+(?:[.,]\d+)?|[.,]?\d+(?:[.,]\d+)*)(?:\s*[+−-])?(?:\s*\p{Sc})?(?:\s*(?:CR|DR)\b)?(?:\s*\))?(?![\p{L}\d.,/])/giu;

function amountRanges(
  str: string,
  dates: readonly Range[],
  cellBoundaries: readonly number[],
  inLedgerColumn: (range: Range) => boolean,
) {
  // Keep source offsets and prevent a recognized date from being read as
  // part of a grouped number or money affix.
  const buffer = str.split("");
  for (const date of dates) {
    buffer.fill("\0", date.start, date.end);
  }
  for (const boundary of cellBoundaries) buffer[boundary] = "\0";
  const source = buffer.join("");
  let previousEnd = 0;
  const ranges: (Range & {
    explicit: boolean;
    spaceGrouped: boolean;
    ambiguousCurrencyPrefix: boolean;
  })[] = [];
  for (const match of source.matchAll(numberPattern)) {
    const inner = match[0].trim();
    let start = match.index + match[0].indexOf(inner);
    let end = start + inner.length;
    const prefixCode = /(?:^|[\s\0])([A-Z]{3})\s+$/i.exec(source.slice(0, start));
    const suffixCode = /^\s+([A-Z]{3})(?![\p{L}\d])/iu.exec(source.slice(end));
    let ambiguousCurrencyPrefix = false;
    // A positioned currency affix is evidence even when its code is
    // unsupported. Preserve the exact text for money validation.
    const suffixEnd = end + (suffixCode?.[0].length ?? 0);
    const prefixStart = prefixCode
      ? start - prefixCode[0].length + prefixCode[0].indexOf(prefixCode[1])
      : start;
    if (
      suffixCode &&
      (isSupportedCurrencyCode(suffixCode[1]) || inLedgerColumn({ start, end: suffixEnd }))
    ) {
      end = suffixEnd;
    } else if (prefixCode && prefixStart >= previousEnd) {
      const positioned = inLedgerColumn({ start: prefixStart, end });
      if (positioned || isSupportedCurrencyCode(prefixCode[1])) {
        start = prefixStart;
        // In unpositioned prose an ISO code can also be a merchant word.
        // Keep the whole span but require review before interpreting it.
        ambiguousCurrencyPrefix =
          !positioned && Boolean(source.slice(0, prefixStart).replaceAll("\0", " ").trim());
      }
    }
    const raw = str.slice(start, end);
    ranges.push({
      start,
      end,
      explicit: !/^\d+$/.test(raw),
      spaceGrouped: /^\d{1,3}(?: \d{3})+(?:[.,]\d+)?$/.test(raw),
      ambiguousCurrencyPrefix,
    });
    previousEnd = end;
  }
  return ranges;
}

function lineRanges(row: CandidateTransactionRow, lines: readonly TextLine[] | undefined): Range[] {
  const available = new Map(lines?.map((line) => [line.lineId, line]));
  const sourceLines = row.lineIds.map((id) => available.get(id));
  if (sourceLines.length && sourceLines.every((line) => line !== undefined)) {
    let start = 0;
    return sourceLines.map((line) => {
      const range = { start, end: start + line.str.length };
      start = range.end + " | ".length;
      return range;
    });
  }
  let start = 0;
  return (row.multiline ? row.str.split(" | ") : [row.str]).map((line) => {
    const range = { start, end: start + line.length };
    start = range.end + " | ".length;
    return range;
  });
}

const originalLabel = /^\s*original\s+(?:purchase|amount)\s*:/i;
const billedCurrencyLabel = /^\s*billed\s+in\s+([A-Z]{3})\s*$/i;

export function extractStatementFields(row: CandidateTransactionRow, source?: PositionedSource) {
  const { str } = row;
  const tokens = new Map(source?.tokens.map((token) => [token.tokenId, token]));
  const located = locateTokens(str, row.tokenIds, tokens);
  const firstLine = source?.lines?.find((line) => line.lineId === row.lineIds[0]);
  const columns = headerColumns(source, tokens, firstLine);
  const layout = lineRanges(row, source?.lines);
  const main = layout[0];

  function field(range: Range): FieldSpan {
    const raw = str.slice(range.start, range.end);
    const matching = located
      .filter((position) => overlaps(position, range))
      .map(({ token }) => token);
    if (!matching.length) return { ...range, raw };
    const bbox: PdfAnchor["bbox"] = [...matching[0].bbox];
    for (const { bbox: bounds } of matching.slice(1)) {
      bbox[0] = Math.min(bbox[0], bounds[0]);
      bbox[1] = Math.min(bbox[1], bounds[1]);
      bbox[2] = Math.max(bbox[2], bounds[2]);
      bbox[3] = Math.max(bbox[3], bounds[3]);
    }
    return {
      ...range,
      raw,
      anchor: { page: row.page, bbox, tokenIds: matching.map((token) => token.tokenId) },
    };
  }

  function column(span: FieldSpan): Column | undefined {
    if (!span.anchor || !columns.length) return undefined;
    // A span inside a wider text run cannot establish its own column.
    if (
      located.some(
        (position) =>
          overlaps(position, span) &&
          (str.slice(position.start, Math.max(position.start, span.start)).trim() ||
            str.slice(Math.min(span.end, position.end), position.end).trim()),
      )
    )
      return undefined;
    const [left, , right] = span.anchor.bbox;
    const center = (left + right) / 2;
    return columns.reduce((nearest, cell) =>
      Math.abs(cell.center - center) < Math.abs(nearest.center - center) ? cell : nearest,
    ).kind;
  }

  const dates = findDateSpans(str).map(({ start, end }) => field({ start, end }));
  const aspect = source?.width && source.height ? source.height / source.width : 1;
  const cellBoundaries: number[] = [];
  for (let index = 1; index < located.length; index++) {
    const previous = located[index - 1];
    const next = located[index];
    const left = previous.token.bbox;
    const right = next.token.bbox;
    const fontWidth = Math.max(left[3] - left[1], right[3] - right[1]) * aspect;
    if (next.start > previous.end && right[0] - left[2] > fontWidth * 1.5) {
      cellBoundaries.push(previous.end);
    }
  }
  const amounts: AmountEvidence[] = amountRanges(str, dates, cellBoundaries, (range) =>
    isLedgerColumn(column(field(range))),
  ).map(({ explicit, spaceGrouped, ambiguousCurrencyPrefix, ...range }) => {
    const span = field(range);
    return { ...span, explicit, spaceGrouped, ambiguousCurrencyPrefix, column: column(span) };
  });

  const notes = layout.slice(1).filter((line) => {
    const text = str.slice(line.start, line.end);
    return originalLabel.test(text) || billedCurrencyLabel.test(text);
  });
  const billedNoteCurrencies = notes.flatMap(({ start, end }) => {
    const note = str.slice(start, end);
    const clauses = originalLabel.test(note) ? note.split("|") : [note];
    return clauses.flatMap((clause) => {
      const match = billedCurrencyLabel.exec(clause);
      return match ? [match[1].toUpperCase()] : [];
    });
  });
  const printedLedgerCurrencies = [
    ...new Set([...columns.flatMap(({ currencies }) => currencies), ...billedNoteCurrencies]),
  ];
  const original = amounts.filter((span) =>
    notes.some(
      (note) => originalLabel.test(str.slice(note.start, note.end)) && overlaps(span, note),
    ),
  );
  const originalAmount = original.length === 1 ? original[0] : undefined;
  const mainAmounts = amounts.filter((span) => overlaps(span, main));
  const hasPositionedAmounts = mainAmounts.some((span) => span.column !== undefined);
  const mainDates = dates.filter((span) => overlaps(span, main));
  const billed = hasPositionedAmounts
    ? mainAmounts.filter((span) => isLedgerColumn(span.column))
    : mainAmounts.filter((span) => span.explicit);
  const soleAmount = billed.length === 1 ? billed[0] : undefined;
  function followsOnlyDates(span: FieldSpan): boolean {
    let cursor = main.start;
    for (const date of mainDates) {
      if (date.end > span.start) break;
      if (str.slice(cursor, date.start).trim()) return false;
      cursor = date.end;
    }
    return !str.slice(cursor, span.start).trim();
  }
  const billedAmount =
    soleAmount &&
    !soleAmount.ambiguousCurrencyPrefix &&
    (hasPositionedAmounts ||
      (!soleAmount.spaceGrouped &&
        (!str.slice(soleAmount.end, main.end).trim() || followsOnlyDates(soleAmount))))
      ? soleAmount
      : undefined;

  const positionedDates = mainDates.map((span) => ({ span, kind: column(span) }));
  const firstDates = positionedDates.filter(({ kind }) => kind === "transactionDate");
  const secondDates = positionedDates.filter(({ kind }) => kind === "postingDate");
  let transactionDate = firstDates.length === 1 ? firstDates[0].span : undefined;
  let postingDate = secondDates.length === 1 ? secondDates[0].span : undefined;
  let ambiguousDates = firstDates.length > 1 || secondDates.length > 1;
  if (!positionedDates.some(({ kind }) => kind !== undefined)) {
    let cursor = billedAmount && !str.slice(0, billedAmount.start).trim() ? billedAmount.end : 0;
    const leadingDates: FieldSpan[] = [];
    for (const span of mainDates) {
      if (span.start < cursor || str.slice(cursor, span.start).trim()) break;
      leadingDates.push(span);
      cursor = span.end;
    }
    ambiguousDates = leadingDates.length > 2;
    if (!ambiguousDates) {
      [transactionDate, postingDate] = leadingDates;
    }
  }

  // A populated posting-date cell is evidence even if its text is unreadable.
  if (!postingDate && !ambiguousDates && columns.some(({ kind }) => kind === "postingDate")) {
    const postingCells = located.filter(
      (range) => overlaps(range, main) && column(field(range)) === "postingDate",
    );
    const start = postingCells[0]?.start;
    const end = postingCells.at(-1)?.end;
    if (start !== undefined && end !== undefined) {
      postingDate = field({ start, end });
    }
  }

  const removed = [transactionDate, postingDate, billedAmount, ...notes]
    .filter((span) => span !== undefined)
    .sort((a, b) => a.start - b.start);
  const description = layout.flatMap((line) => {
    let cursor = line.start;
    const spans: FieldSpan[] = [];
    function addText(end: number) {
      const original = str.slice(cursor, end);
      const text = original.trim();
      if (text) {
        const start = cursor + original.indexOf(text);
        spans.push(field({ start, end: start + text.length }));
      }
    }
    for (const span of removed.filter((span) => overlaps(span, line))) {
      addText(Math.max(cursor, span.start));
      cursor = Math.min(line.end, span.end);
    }
    addText(line.end);
    return spans;
  });

  const fields: ParsedFieldSpans = {
    dates,
    amounts,
    transactionDate,
    postingDate,
    billedAmount,
    originalAmount,
    description,
    fxMetadata: notes.map(field),
  };
  return {
    fields,
    ambiguousDates,
    ambiguousBilledAmount: !billedAmount && mainAmounts.length > 0,
    ambiguousOriginalAmount: original.length > 1,
    columnDirection:
      billedAmount?.column === "credit" || billedAmount?.column === "debit"
        ? billedAmount.column
        : null,
    printedLedgerCurrencies,
  };
}
