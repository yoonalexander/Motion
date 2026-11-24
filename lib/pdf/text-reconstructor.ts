import "client-only";
import { findDateSpans } from "./date-parser";
import type { ExtractionResult, ExtractedPage, ExtractedToken } from "./text-extractor";
import type { PdfAnchor } from "@/schemas/transaction";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface TextLine {
  str: string;
  page: number;
  lineId: string;
  bbox: [number, number, number, number];
  tokenIds: string[];
  tokenCount: number;
  yCenter: number;
  baselineY?: number;
  xStart: number;
  xEnd: number;
  height: number;
  diagnostics: string[];
}

export interface DetectedTable {
  page: number;
  tableId: string;
  bbox: [number, number, number, number];
  columns: number[]; // x positions of detected column boundaries
  lineIds: string[];
  lineCount: number;
  diagnostics: string[];
}

export interface CandidateTransactionRow {
  rowId: string;
  page: number;
  lineIds: string[];
  tokenIds: string[];
  str: string;
  bbox: [number, number, number, number];
  hasDateLikeField: boolean;
  hasAmountLikeField: boolean;
  multiline: boolean;
  diagnostics: string[];
}

export interface PageReconstruction {
  page: number;
  width: number;
  height: number;
  tokens: ExtractedToken[];
  lines: TextLine[];
  tables: DetectedTable[];
  candidates: CandidateTransactionRow[];
  unmatchedTokenIds: string[];
  unmatchedLineIds: string[];
  suspectedUnmatchedLines: SuspectedUnmatchedLine[];
  coverage: ReconstructionCoverage;
  diagnostics: string[];
}

export interface SuspectedUnmatchedLine {
  lineId: string;
  reason: "amount_in_transaction_region";
}

export interface ReconstructionCoverage {
  tokensAssignedToLines: { assigned: number; extracted: number };
  // The denominator includes only candidates and independently flagged lines, not all transactions.
  transactionCandidates: { detected: number; suspected: number };
  // Reconstruction has no independent count of the transactions printed on the statement.
  verifiedTransactions: null;
}

export interface ReconstructionResult {
  pageCount: number;
  pages: PageReconstruction[];
  totalLines: number;
  totalTables: number;
  totalCandidates: number;
  totalUnmatchedTokens: number;
  totalUnmatchedLines: number;
  hasUnmatchedContent: boolean;
  coverage: ReconstructionCoverage;
}

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

export interface ReconstructionConfig {
  // Upper bound on baseline separation for grouping tokens (normalized units).
  lineYTolerance: number;
  // Minimum height ratio for a token to be considered part of a line
  minTokenHeightRatio: number;
  // X-proximity threshold for considering two tokens in different columns (normalized)
  columnGapTolerance: number;
  // Minimum number of lines required to detect a table
  minTableLines: number;
  // Maximum X-difference for tokens to be considered in the same column (normalized)
  columnXTolerance: number;
}

export const defaultConfig: ReconstructionConfig = {
  lineYTolerance: 0.02,
  minTokenHeightRatio: 0.3,
  columnGapTolerance: 0.03,
  minTableLines: 2,
  columnXTolerance: 0.015,
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function bboxUnion(
  a: [number, number, number, number] | null,
  b: [number, number, number, number],
): [number, number, number, number] {
  if (!a) return b;
  return [Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.max(a[2], b[2]), Math.max(a[3], b[3])];
}

function bboxHeight(bbox: [number, number, number, number]): number {
  return bbox[3] - bbox[1];
}

// ---------------------------------------------------------------------------
// Line Reconstruction
// ---------------------------------------------------------------------------

/**
 * Groups horizontal tokens on the same visual baseline. Nearby text that
 * repeats an occupied horizontal position is evidence of a separate line.
 * All tokens retain their source IDs, including non-horizontal text.
 */
export function reconstructLines(
  page: ExtractedPage,
  config: ReconstructionConfig = defaultConfig,
): { lines: TextLine[]; unmatchedTokenIds: string[] } {
  const sortedTokens = [...page.tokens].sort(
    (a, b) => b.y - a.y || a.bbox[0] - b.bbox[0] || a.tokenId.localeCompare(b.tokenId),
  );
  const groups: {
    anchor: ExtractedToken;
    tokens: ExtractedToken[];
    diagnostics: Set<string>;
  }[] = [];
  for (const token of sortedTokens) {
    const diagnostics = new Set<string>();
    if (token.baselineEnd) {
      const dx = (token.baselineEnd[0] - token.x) * page.width;
      const dy = (token.baselineEnd[1] - token.y) * page.height;
      if (dx <= 0 || Math.abs(dy) > dx * 0.1) {
        diagnostics.add("non_horizontal_baseline");
        groups.push({ anchor: token, tokens: [token], diagnostics });
        continue;
      }
    }

    let closest: (typeof groups)[number] | undefined;
    for (let index = groups.length - 1; index >= 0; index--) {
      const group = groups[index];
      const gap = group.anchor.y - token.y;
      if (gap > config.lineYTolerance) break;
      if (group.diagnostics.has("non_horizontal_baseline")) continue;

      const shorterFont = Math.min(bboxHeight(group.anchor.bbox), bboxHeight(token.bbox));
      if (gap > shorterFont * 0.35) continue;
      if (
        gap > shorterFont * 0.1 &&
        group.tokens.some((other) => {
          const overlap =
            Math.min(other.bbox[2], token.bbox[2]) - Math.max(other.bbox[0], token.bbox[0]);
          const narrower = Math.min(other.bbox[2] - other.bbox[0], token.bbox[2] - token.bbox[0]);
          return overlap > narrower * 0.5;
        })
      ) {
        group.diagnostics.add("nearby_overlapping_baselines");
        diagnostics.add("nearby_overlapping_baselines");
        continue;
      }
      if (closest) {
        group.diagnostics.add("ambiguous_baseline_group");
        diagnostics.add("ambiguous_baseline_group");
      } else {
        closest = group;
      }
    }
    if (closest) {
      closest.tokens.push(token);
      for (const diagnostic of diagnostics) closest.diagnostics.add(diagnostic);
    } else {
      groups.push({ anchor: token, tokens: [token], diagnostics });
    }
  }

  const lines = groups.map(
    ({ anchor, tokens: lineTokens, diagnostics: groupDiagnostics }, lineIndex) => {
      // Sort line tokens left-to-right
      lineTokens.sort((a, b) => a.bbox[0] - b.bbox[0]);

      // Build combined line string
      const str = lineTokens.map((t) => t.str).join(" ");

      // Compute union bounding box
      let unionBbox: [number, number, number, number] | null = null;
      for (const t of lineTokens) {
        unionBbox = bboxUnion(unionBbox, t.bbox);
      }
      const bbox = unionBbox!;

      const yCenter = (bbox[1] + bbox[3]) / 2;
      const height = bboxHeight(bbox);

      const diagnostics = [...groupDiagnostics];
      if (lineTokens.length > 1) {
        const xGaps: number[] = [];
        for (let i = 1; i < lineTokens.length; i++) {
          xGaps.push(lineTokens[i].bbox[0] - lineTokens[i - 1].bbox[2]);
        }
        const maxGap = Math.max(...xGaps);
        if (maxGap > config.columnGapTolerance) {
          diagnostics.push("possible_column_split");
        }
      }
      if (lineTokens.length === 1) {
        diagnostics.push("single_token_line");
      }

      return {
        str,
        page: page.page,
        lineId: `p${page.page}-l${lineIndex}`,
        bbox,
        tokenIds: lineTokens.map((t) => t.tokenId),
        tokenCount: lineTokens.length,
        yCenter,
        baselineY: anchor.y,
        xStart: bbox[0],
        xEnd: bbox[2],
        height,
        diagnostics,
      };
    },
  );

  return { lines, unmatchedTokenIds: [] };
}

// ---------------------------------------------------------------------------
// Table Detection
// ---------------------------------------------------------------------------

const amountCellPattern =
  /^(?=.*\d)(?:[A-Z]{3}\s+)?[+−(\-]?\s*\p{Sc}?\s*[.,]?\d(?:[\d., '’]*\d)?\s*[-)]?\s*(?:\p{Sc}|CR|DR|[A-Z]{3})?$/u;

function lastAmountCell(tokens: ExtractedToken[]): ExtractedToken | undefined {
  for (let index = tokens.length - 1; index >= Math.max(0, tokens.length - 3); index--) {
    const text = tokens
      .slice(index)
      .map((token) => token.str.trim())
      .join(" ");
    if (amountCellPattern.test(text)) return tokens[index];
  }
}

function getLineTokens(line: TextLine, tokensById: ReadonlyMap<string, ExtractedToken>) {
  return line.tokenIds.flatMap((id) => {
    const token = tokensById.get(id);
    return token ? [token] : [];
  });
}

interface TableRowPattern {
  line: TextLine;
  columnStarts: number[];
}

function rowPattern(
  line: TextLine,
  tokensById: ReadonlyMap<string, ExtractedToken>,
  config: ReconstructionConfig,
): TableRowPattern | undefined {
  if (
    line.diagnostics.includes("non_horizontal_baseline") ||
    !findDateSpans(line.str.trim()).some((span) => span.start === 0)
  ) {
    return;
  }

  const tokens = getLineTokens(line, tokensById);
  const amount = lastAmountCell(tokens);
  if (!amount || amount === tokens[0]) return;

  const columnStarts = tokens
    .filter(
      (token, index) =>
        index === 0 ||
        token === amount ||
        token.bbox[0] - tokens[index - 1].bbox[2] >= config.columnGapTolerance,
    )
    .map((token) => token.bbox[0]);
  if (columnStarts.length >= 2) return { line, columnStarts };
}

function matchingColumns(left: number[], right: number[], tolerance: number): number {
  let matches = 0;
  let rightIndex = 0;
  for (const column of left) {
    while (rightIndex < right.length && right[rightIndex] < column - tolerance) rightIndex++;
    if (rightIndex === right.length) break;
    if (Math.abs(right[rightIndex] - column) <= tolerance) {
      matches++;
      rightIndex++;
    }
  }
  return matches;
}

function repeatedColumns(rows: TableRowPattern[], tolerance: number): number[] {
  const clusters: { start: number; observations: Map<string, number> }[] = [];
  for (const { line, columnStarts } of rows) {
    for (const start of columnStarts) {
      const cluster = clusters.find((entry) => Math.abs(entry.start - start) <= tolerance);
      if (cluster) {
        if (!cluster.observations.has(line.lineId)) cluster.observations.set(line.lineId, start);
      } else {
        clusters.push({ start, observations: new Map([[line.lineId, start]]) });
      }
    }
  }
  return clusters
    .filter(({ observations }) => observations.size >= 2)
    .map(
      ({ observations }) =>
        [...observations.values()].reduce((sum, value) => sum + value, 0) / observations.size,
    )
    .sort((left, right) => left - right);
}

/** Detects locally repeated dated, multi-column rows with monetary-looking tails. */
export function detectTables(
  page: ExtractedPage,
  lines: TextLine[],
  config: ReconstructionConfig = defaultConfig,
): DetectedTable[] {
  const tokensById = new Map(page.tokens.map((token) => [token.tokenId, token]));
  const orderedLines = [...lines].sort((a, b) => lineBaseline(b) - lineBaseline(a));
  const tables: DetectedTable[] = [];
  let group: TableRowPattern[] = [];

  const finishGroup = () => {
    if (group.length >= Math.max(2, config.minTableLines)) {
      const columns = repeatedColumns(group, config.columnXTolerance);
      if (columns.length >= 2) {
        const [first, ...rest] = group;
        const bbox = rest.reduce(
          (bounds, { line }) => bboxUnion(bounds, line.bbox),
          first.line.bbox,
        );
        tables.push({
          page: page.page,
          tableId: `p${page.page}-t${tables.length}`,
          bbox,
          columns,
          lineIds: group.map(({ line }) => line.lineId),
          lineCount: group.length,
          diagnostics: ["repeated_date_and_amount_columns"],
        });
      }
    }
    group = [];
  };

  for (const line of orderedLines) {
    if (controlLabelPattern.test(line.str.trim())) {
      finishGroup();
      continue;
    }
    const row = rowPattern(line, tokensById, config);
    if (!row) continue;
    const previous = group.at(-1);
    if (previous) {
      const distance = lineBaseline(previous.line) - lineBaseline(line);
      const localSpacing = 6 * Math.max(previous.line.height, line.height);
      if (
        distance > localSpacing ||
        Math.abs(previous.line.xStart - line.xStart) > config.columnXTolerance ||
        matchingColumns(previous.columnStarts, row.columnStarts, config.columnXTolerance) < 2
      ) {
        finishGroup();
      }
    }
    group.push(row);
  }
  finishGroup();
  return tables;
}
// ---------------------------------------------------------------------------
// Candidate Row Detection
// ---------------------------------------------------------------------------

const amountLikePattern = /-?\d[\d,]*(?:\.\d{1,2})?/;
const amountOnlyPattern = /^(?=.*\d)[\d\s,.'’()+−\-\p{Sc}]+(?:\s*(?:CR|DR))?$/iu;
const controlLabelPattern =
  /^(?:(?:opening|closing|previous|new|current|statement|outstanding|available)\s+balance\b|(?:minimum\s+)?payment\s+due\b|amount\s+due\b|credit\s+limit\b|(?:sub)?total\s+(?:balance|debits|credits|payments|purchases|fees|interest)\b|(?:(?:sub)?total|debits|credits)\s*(?=[:\p{Sc}\d]|$))/iu;

function descriptionColumn(line: TextLine, tokensById: ReadonlyMap<string, ExtractedToken>) {
  const tokens = getLineTokens(line, tokensById);
  const index = tokens.findIndex((token) => {
    const text = token.str.trim();
    let end = 0;
    for (const span of findDateSpans(text)) {
      if (text.slice(end, span.start).trim()) return true;
      end = span.end;
    }
    return end === 0 || Boolean(text.slice(end).trim());
  });
  const description = tokens[index];
  if (index <= 0 || !description || amountOnlyPattern.test(description.str.trim())) return null;

  const amount = tokens.slice(index + 1).find((token) => amountOnlyPattern.test(token.str.trim()));
  return { start: description.bbox[0], end: amount?.bbox[0] };
}

function lineBaseline(line: TextLine): number {
  return line.baselineY ?? line.yCenter;
}

/**
 * Groups reconstructed lines into candidate transaction rows.
 *
 * A candidate row starts with a line that looks like a transaction
 * (typically begins with a date-like token) and may include continuation
 * lines that wrap at the description column on adjacent baselines.
 *
 * Lines that cannot be confidently assigned remain as unmatched lines.
 */
export function detectCandidateRows(
  page: ExtractedPage,
  lines: TextLine[],
  tables: DetectedTable[],
  config: ReconstructionConfig = defaultConfig,
): { candidates: CandidateTransactionRow[]; unmatchedLineIds: string[] } {
  const tableLineIds = new Set(tables.flatMap((t) => t.lineIds));
  const assignedLineIds = new Set<string>();
  const candidates: CandidateTransactionRow[] = [];
  const tokensById = new Map(page.tokens.map((token) => [token.tokenId, token]));

  const sortedLines = lines
    .filter((line) => !line.diagnostics.includes("non_horizontal_baseline"))
    .sort((a, b) => lineBaseline(b) - lineBaseline(a) || a.xStart - b.xStart);

  let rowIndex = 0;

  for (let i = 0; i < sortedLines.length; i++) {
    const line = sortedLines[i];
    if (assignedLineIds.has(line.lineId)) continue;

    // A candidate row starts from a line that looks like a transaction
    // (typically begins with a date-like field). Table membership is a
    // strong hint but not required — tables help filter noise, not gate detection.
    const startsWithDate = findDateSpans(line.str.trim()).some((span) => span.start === 0);
    if (!startsWithDate) {
      continue;
    }

    const rowLines: TextLine[] = [line];
    assignedLineIds.add(line.lineId);

    const diagnostics: string[] = [];
    const column = descriptionColumn(line, tokensById);
    // Derive horizontal slack from the row's text size, in normalized x units.
    const indentTolerance = (line.height * page.height) / page.width;
    for (let j = i + 1; j < sortedLines.length; j++) {
      const nextLine = sortedLines[j];
      if (assignedLineIds.has(nextLine.lineId)) break;

      const previous = rowLines[rowLines.length - 1];
      const gap = lineBaseline(previous) - lineBaseline(nextLine);
      const maxGap = Math.min(
        config.lineYTolerance * 3,
        Math.max(previous.height, nextLine.height) * 1.9,
      );
      const text = nextLine.str.trim();
      if (
        gap <= 0 ||
        gap > maxGap ||
        findDateSpans(text).some((span) => span.start === 0) ||
        controlLabelPattern.test(text)
      ) {
        break;
      }

      const inDescriptionColumn = column
        ? nextLine.xStart >= column.start - indentTolerance &&
          nextLine.xStart <= column.start + 3 * indentTolerance &&
          (column.end === undefined || nextLine.xEnd <= column.end + indentTolerance)
        : nextLine.xStart > line.xStart + indentTolerance &&
          nextLine.xEnd <= line.xEnd + indentTolerance;
      if (!inDescriptionColumn || amountOnlyPattern.test(text)) {
        if (nextLine.xStart > line.xStart + indentTolerance) {
          diagnostics.push("ambiguous_continuation");
        }
        break;
      }
      assignedLineIds.add(nextLine.lineId);
      rowLines.push(nextLine);
    }

    const str = rowLines.map((l) => l.str).join(" | ");
    const tokenIds = rowLines.flatMap((l) => l.tokenIds);

    let unionBbox: [number, number, number, number] | null = null;
    for (const l of rowLines) {
      unionBbox = bboxUnion(unionBbox, l.bbox);
    }
    const bbox = unionBbox!;

    const hasDateLikeField = findDateSpans(str).length > 0;
    const hasAmountLikeField = amountLikePattern.test(str);
    const multiline = rowLines.length > 1;

    if (
      rowLines.some((rowLine) =>
        rowLine.diagnostics.some(
          (diagnostic) =>
            diagnostic === "ambiguous_baseline_group" ||
            diagnostic === "nearby_overlapping_baselines",
        ),
      )
    ) {
      diagnostics.push("uncertain_line_grouping");
    }
    if (multiline) {
      diagnostics.push("multiline_description");
      if (!column) diagnostics.push("uncertain_description_column");
    }
    if (!hasDateLikeField) {
      diagnostics.push("no_date_field");
    }
    if (!hasAmountLikeField) {
      diagnostics.push("no_amount_field");
    }
    if (rowLines.length > 2) {
      diagnostics.push("long_multiline");
    }
    if (!tableLineIds.has(line.lineId)) {
      diagnostics.push("outside_detected_table");
    }

    candidates.push({
      rowId: `p${page.page}-r${rowIndex++}`,
      page: page.page,
      lineIds: rowLines.map((l) => l.lineId),
      tokenIds,
      str,
      bbox,
      hasDateLikeField,
      hasAmountLikeField,
      multiline,
      diagnostics,
    });
  }

  // Unmatched lines: lines that were not assigned to any candidate.
  // Lines inside detected tables that lack date-like fields are especially
  // noteworthy — they may be headers, totals, or missed transaction rows.
  const unmatchedLineIds = lines.map((l) => l.lineId).filter((id) => !assignedLineIds.has(id));

  return { candidates, unmatchedLineIds };
}

// ---------------------------------------------------------------------------
// Full Page Reconstruction
// ---------------------------------------------------------------------------

function findSuspectedUnmatchedLines(
  page: ExtractedPage,
  lines: TextLine[],
  unmatchedLineIds: string[],
  tables: DetectedTable[],
  config: ReconstructionConfig,
): SuspectedUnmatchedLine[] {
  const unmatched = new Set(unmatchedLineIds);
  const tokensById = new Map(page.tokens.map((token) => [token.tokenId, token]));
  const suspected: SuspectedUnmatchedLine[] = [];

  for (const line of lines) {
    if (
      !unmatched.has(line.lineId) ||
      line.diagnostics.includes("non_horizontal_baseline") ||
      controlLabelPattern.test(line.str.trim())
    ) {
      continue;
    }
    const tokens = getLineTokens(line, tokensById);
    const amount = lastAmountCell(tokens);
    if (!amount || amount === tokens[0]) continue;
    const matchingTable = tables.some(({ bbox, columns }) => {
      const baseline = lineBaseline(line);
      return (
        baseline >= bbox[1] &&
        baseline <= bbox[3] &&
        columns
          .slice(1)
          .some((column) => Math.abs(amount.bbox[0] - column) <= config.columnXTolerance)
      );
    });
    if (matchingTable)
      suspected.push({ lineId: line.lineId, reason: "amount_in_transaction_region" });
  }
  return suspected;
}

/**
 * Reconstructs a full page: tokens → lines → tables → candidate rows,
 * tracking unmatched tokens and lines at each stage.
 */
export function reconstructPage(
  page: ExtractedPage,
  config: ReconstructionConfig = defaultConfig,
): PageReconstruction {
  const { lines, unmatchedTokenIds } = reconstructLines(page, config);
  const tables = detectTables(page, lines, config);
  const { candidates, unmatchedLineIds } = detectCandidateRows(page, lines, tables, config);
  const suspectedUnmatchedLines = findSuspectedUnmatchedLines(
    page,
    lines,
    unmatchedLineIds,
    tables,
    config,
  );

  const pageDiagnostics: string[] = [];
  if (page.tokens.length === 0) {
    pageDiagnostics.push("no_extractable_text");
  }
  if (unmatchedTokenIds.length > 0) {
    pageDiagnostics.push(`${unmatchedTokenIds.length} unmatched tokens`);
  }
  if (unmatchedLineIds.length > 0) {
    pageDiagnostics.push(`${unmatchedLineIds.length} unmatched lines`);
  }
  if (suspectedUnmatchedLines.length > 0) {
    pageDiagnostics.push(
      `${suspectedUnmatchedLines.length} suspected transaction lines need review`,
    );
  }
  if (candidates.length === 0 && lines.length > 0) {
    pageDiagnostics.push("no candidate rows detected");
  }

  return {
    page: page.page,
    width: page.width,
    height: page.height,
    tokens: page.tokens,
    lines,
    tables,
    candidates,
    unmatchedTokenIds,
    unmatchedLineIds,
    suspectedUnmatchedLines,
    coverage: {
      tokensAssignedToLines: {
        assigned: page.tokens.length - unmatchedTokenIds.length,
        extracted: page.tokens.length,
      },
      transactionCandidates: {
        detected: candidates.length,
        suspected: candidates.length + suspectedUnmatchedLines.length,
      },
      verifiedTransactions: null,
    },
    diagnostics: pageDiagnostics,
  };
}

/**
 * Reconstructs all pages of an extraction result.
 */
export function reconstructDocument(
  result: ExtractionResult,
  config: ReconstructionConfig = defaultConfig,
): ReconstructionResult {
  const pages = result.pages.map((page) => reconstructPage(page, config));

  const totalLines = pages.reduce<number>((sum, p) => sum + p.lines.length, 0);
  const totalTables = pages.reduce<number>((sum, p) => sum + p.tables.length, 0);
  const totalCandidates = pages.reduce<number>((sum, p) => sum + p.candidates.length, 0);
  const totalUnmatchedTokens = pages.reduce<number>(
    (sum, p) => sum + p.unmatchedTokenIds.length,
    0,
  );
  const totalUnmatchedLines = pages.reduce<number>((sum, p) => sum + p.unmatchedLineIds.length, 0);
  const totalSuspected = pages.reduce((sum, page) => sum + page.suspectedUnmatchedLines.length, 0);

  return {
    pageCount: result.pageCount,
    pages,
    totalLines,
    totalTables,
    totalCandidates,
    totalUnmatchedTokens,
    totalUnmatchedLines,
    hasUnmatchedContent: totalUnmatchedTokens > 0 || totalUnmatchedLines > 0,
    coverage: {
      tokensAssignedToLines: {
        assigned: result.totalTokens - totalUnmatchedTokens,
        extracted: result.totalTokens,
      },
      transactionCandidates: {
        detected: totalCandidates,
        suspected: totalCandidates + totalSuspected,
      },
      verifiedTransactions: null,
    },
  };
}

// ---------------------------------------------------------------------------
// Anchor conversion
// ---------------------------------------------------------------------------

/**
 * Converts a CandidateTransactionRow into a PdfAnchor value.
 */
export function rowToAnchor(row: CandidateTransactionRow): PdfAnchor {
  return {
    page: row.page,
    bbox: row.bbox,
    tokenIds: row.tokenIds,
  };
}

/**
 * Converts a TextLine into a PdfAnchor value.
 */
export function lineToAnchor(line: TextLine): PdfAnchor {
  return {
    page: line.page,
    bbox: line.bbox,
    tokenIds: line.tokenIds,
  };
}
