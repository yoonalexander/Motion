import "client-only";
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
  diagnostics: string[];
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

/**
 * Detects likely transaction-table regions on a page.
 *
 * A table is identified when multiple consecutive lines show consistent
 * column alignment (tokens appearing at similar X positions across lines).
 * Column boundaries are inferred from the distribution of token X-starts
 * across lines, not from hardcoded positions.
 *
 * Pages with fewer than minTableLines lines are not considered tables.
 */
export function detectTables(
  page: ExtractedPage,
  lines: TextLine[],
  config: ReconstructionConfig = defaultConfig
): DetectedTable[] {
  if (lines.length < config.minTableLines) {
    return [];
  }

  // Collect all token X-start positions across all lines to find column clusters.
  // Column boundaries are inferred from the distribution of token X positions,
  // not from line start positions (all transaction lines start at the same margin).
  const tokenXStarts: number[] = [];
  const tokensByLine = new Map<string, ExtractedToken[]>();
  for (const line of lines) {
    tokensByLine.set(line.lineId, page.tokens.filter((t) => line.tokenIds.includes(t.tokenId)));
  }
  for (const lineTokens of tokensByLine.values()) {
    for (const t of lineTokens) {
      tokenXStarts.push(t.x);
    }
  }
  tokenXStarts.sort((a, b) => a - b);

  // Cluster X positions into columns
  const clusters: number[] = [];
  let currentCluster: number[] = [];
  for (const x of tokenXStarts) {
    if (currentCluster.length === 0 || x - currentCluster[currentCluster.length - 1] <= config.columnXTolerance) {
      currentCluster.push(x);
    } else {
      clusters.push(currentCluster.reduce((sum, v) => sum + v, 0) / currentCluster.length);
      currentCluster = [x];
    }
  }
  if (currentCluster.length > 0) {
    clusters.push(currentCluster.reduce((sum, v) => sum + v, 0) / currentCluster.length);
  }

  // A table needs at least 2 distinct columns
  if (clusters.length < 2) {
    return [];
  }

  // Group consecutive lines that have tokens in detected columns
  const tables: DetectedTable[] = [];
  const tableLineGroups: TextLine[][] = [];
  let currentGroup: TextLine[] = [];

  for (const line of lines) {
    const lineTokens = tokensByLine.get(line.lineId) ?? [];
    const hasColumnAlignment = lineTokens.some((t) =>
      clusters.some((cx) => Math.abs(t.x - cx) <= config.columnXTolerance)
    );
    if (hasColumnAlignment) {
      currentGroup.push(line);
    } else {
      if (currentGroup.length >= config.minTableLines) {
        tableLineGroups.push(currentGroup);
      }
      currentGroup = [];
    }
  }
  if (currentGroup.length >= config.minTableLines) {
    tableLineGroups.push(currentGroup);
  }

  let tableIndex = 0;
  for (const group of tableLineGroups) {
    const lineIds = group.map((l) => l.lineId);
    let unionBbox: [number, number, number, number] | null = null;
    for (const line of group) {
      unionBbox = bboxUnion(unionBbox, line.bbox);
    }
    const bbox = unionBbox!;

    const diagnostics: string[] = [];
    if (group.length >= 5) {
      diagnostics.push("multi_line_table");
    }
    if (clusters.length > 3) {
      diagnostics.push("multi_column_table");
    }

    tables.push({
      page: page.page,
      tableId: `p${page.page}-t${tableIndex++}`,
      bbox,
      columns: clusters,
      lineIds,
      lineCount: group.length,
      diagnostics,
    });
  }

  return tables;
}

// ---------------------------------------------------------------------------
// Candidate Row Detection
// ---------------------------------------------------------------------------

const dateLikePattern = /\d{1,2}[\/\-]\d{1,2}[\/\-]\d{2,4}|\d{4}[\/\-]\d{1,2}[\/\-]\d{1,2}/;
const amountLikePattern = /-?\d[\d,]*(?:\.\d{1,2})?/;
const amountOnlyPattern = /^(?=.*\d)[\d\s,.'’()+−\-\p{Sc}]+(?:\s*(?:CR|DR))?$/iu;
const controlLabelPattern =
  /^(?:(?:opening|closing|previous|new|current|statement|outstanding|available)\s+balance\b|(?:minimum\s+)?payment\s+due\b|amount\s+due\b|credit\s+limit\b|(?:sub)?total\s+(?:balance|debits|credits|payments|purchases|fees|interest)\b|(?:(?:sub)?total|debits|credits)\s*(?=[:\p{Sc}\d]|$))/iu;

function descriptionColumn(line: TextLine, tokensById: ReadonlyMap<string, ExtractedToken>) {
  const tokens = line.tokenIds.flatMap((id) => {
    const token = tokensById.get(id);
    return token ? [token] : [];
  });
  const index = tokens.findIndex(
    (token) =>
      !token.str
        .trim()
        .split(/\s+/)
        .every((part) => dateLikePattern.test(part)),
  );
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
    const startsWithDate = dateLikePattern.test(line.str.trim());
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
        dateLikePattern.test(text) ||
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

    const hasDateLikeField = dateLikePattern.test(str);
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

/**
 * Reconstructs a full page: tokens → lines → tables → candidate rows,
 * tracking unmatched tokens and lines at each stage.
 */
export function reconstructPage(
  page: ExtractedPage,
  config: ReconstructionConfig = defaultConfig
): PageReconstruction {
  const { lines, unmatchedTokenIds } = reconstructLines(page, config);
  const tables = detectTables(page, lines, config);
  const { candidates, unmatchedLineIds } = detectCandidateRows(page, lines, tables, config);

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
    diagnostics: pageDiagnostics,
  };
}

/**
 * Reconstructs all pages of an extraction result.
 */
export function reconstructDocument(
  result: ExtractionResult,
  config: ReconstructionConfig = defaultConfig
): ReconstructionResult {
  const pages = result.pages.map((page) => reconstructPage(page, config));

  const totalLines = pages.reduce<number>((sum, p) => sum + p.lines.length, 0);
  const totalTables = pages.reduce<number>((sum, p) => sum + p.tables.length, 0);
  const totalCandidates = pages.reduce<number>(
    (sum, p) => sum + p.candidates.length,
    0
  );
  const totalUnmatchedTokens = pages.reduce<number>(
    (sum, p) => sum + p.unmatchedTokenIds.length,
    0
  );
  const totalUnmatchedLines = pages.reduce<number>(
    (sum, p) => sum + p.unmatchedLineIds.length,
    0
  );

  return {
    pageCount: result.pageCount,
    pages,
    totalLines,
    totalTables,
    totalCandidates,
    totalUnmatchedTokens,
    totalUnmatchedLines,
    hasUnmatchedContent: totalUnmatchedTokens > 0 || totalUnmatchedLines > 0,
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
