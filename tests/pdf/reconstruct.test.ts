import { describe, expect, it } from "vitest";
import {
  reconstructDocument,
  reconstructPage,
  reconstructLines,
  detectTables,
  detectCandidateRows,
  defaultConfig,
  type ReconstructionConfig,
  type ExtractedPage,
  type ExtractedToken,
  type TextLine,
  type DetectedTable,
  type CandidateTransactionRow,
  type ExtractionResult,
  lineToAnchor,
  rowToAnchor,
} from "@/lib/pdf";

function makeToken(
  str: string,
  x: number,
  y: number,
  width: number = 0.05,
  height: number = 0.015,
  page: number = 1,
  tokenId?: string,
): ExtractedToken {
  return {
    str,
    page,
    tokenId: tokenId ?? `p${page}-t${Math.random().toString(36).slice(2)}`,
    bbox: [x, y, x + width, y + height],
    x,
    y: y + height / 2,
    width,
    height,
    hasEOL: false,
  };
}

function makePage(
  tokens: ExtractedToken[],
  page: number = 1,
  width: number = 600,
  height: number = 800,
): ExtractedPage {
  return {
    page,
    tokens,
    width,
    height,
    rotation: 0,
  };
}

describe("reconstructLines", () => {
  it("groups multiple tokens on the same visual line", () => {
    const page = makePage([
      makeToken("Date", 0.05, 0.8, 0.04, 0.015, 1),
      makeToken("Merchant", 0.15, 0.8, 0.08, 0.015, 1),
      makeToken("Amount", 0.3, 0.8, 0.06, 0.015, 1),
    ]);

    const { lines } = reconstructLines(page);

    expect(lines).toHaveLength(1);
    expect(lines[0].str).toBe("Date Merchant Amount");
    expect(lines[0].tokenCount).toBe(3);
    expect(lines[0].page).toBe(1);
    expect(lines[0].tokenIds).toHaveLength(3);
  });

  it("sorts tokens left-to-right within a line regardless of input order", () => {
    const page = makePage([
      makeToken("Amount", 0.3, 0.8, 0.06, 0.015, 1, "tok-amount"),
      makeToken("Date", 0.05, 0.8, 0.04, 0.015, 1, "tok-date"),
      makeToken("Merchant", 0.15, 0.8, 0.08, 0.015, 1, "tok-merchant"),
    ]);

    const { lines } = reconstructLines(page);

    expect(lines[0].str).toBe("Date Merchant Amount");
    expect(lines[0].tokenIds).toEqual(["tok-date", "tok-merchant", "tok-amount"]);
  });

  it("creates separate lines for tokens at different Y positions", () => {
    const page = makePage([
      makeToken("Line One", 0.05, 0.8, 0.08, 0.015, 1),
      makeToken("Line Two", 0.05, 0.75, 0.08, 0.015, 1),
    ]);

    const { lines } = reconstructLines(page);

    expect(lines).toHaveLength(2);
    expect(lines[0].str).toBe("Line One");
    expect(lines[1].str).toBe("Line Two");
  });

  it("flags possible column split when tokens are widely separated horizontally", () => {
    const config: ReconstructionConfig = {
      ...defaultConfig,
      columnGapTolerance: 0.01,
    };

    const page = makePage([
      makeToken("Col1", 0.05, 0.8, 0.04, 0.015, 1),
      makeToken("Col2", 0.15, 0.8, 0.04, 0.015, 1),
    ]);

    const { lines } = reconstructLines(page, config);

    expect(lines).toHaveLength(1);
    expect(lines[0].diagnostics).toContain("possible_column_split");
  });

  it("handles empty token list", () => {
    const page = makePage([], 1);

    const { lines, unmatchedTokenIds } = reconstructLines(page);

    expect(lines).toHaveLength(0);
    expect(unmatchedTokenIds).toHaveLength(0);
  });

  it("preserves source anchors via lineToAnchor", () => {
    const page = makePage([makeToken("TEST LINE", 0.05, 0.8, 0.08, 0.015, 1, "tok-test")]);

    const { lines } = reconstructLines(page);
    const anchor = lineToAnchor(lines[0]);

    expect(anchor.page).toBe(1);
    expect(anchor.bbox).toEqual(lines[0].bbox);
    expect(anchor.tokenIds).toEqual(["tok-test"]);
  });
});

describe("detectTables", () => {
  it("detects a table from column-aligned lines", () => {
    const pageTokens: ExtractedToken[] = [
      makeToken("09/01", 0.05, 0.8, 0.05, 0.015, 1, "t1"),
      makeToken("MERCHANT", 0.15, 0.8, 0.08, 0.015, 1, "t2"),
      makeToken("A", 0.25, 0.8, 0.02, 0.015, 1, "t3"),
      makeToken("10.00", 0.85, 0.8, 0.05, 0.015, 1, "t4"),
      makeToken("09/02", 0.05, 0.77, 0.05, 0.015, 1, "t5"),
      makeToken("MERCHANT", 0.15, 0.77, 0.08, 0.015, 1, "t6"),
      makeToken("B", 0.25, 0.77, 0.02, 0.015, 1, "t7"),
      makeToken("20.00", 0.85, 0.77, 0.05, 0.015, 1, "t8"),
      makeToken("09/03", 0.05, 0.74, 0.05, 0.015, 1, "t9"),
      makeToken("MERCHANT", 0.15, 0.74, 0.08, 0.015, 1, "t10"),
      makeToken("C", 0.25, 0.74, 0.02, 0.015, 1, "t11"),
      makeToken("30.00", 0.85, 0.74, 0.05, 0.015, 1, "t12"),
    ];

    const lines: TextLine[] = [
      {
        lineId: "l1",
        str: "09/01 MERCHANT A 10.00",
        page: 1,
        bbox: [0.05, 0.8, 0.9, 0.82],
        tokenIds: ["t1", "t2", "t3", "t4"],
        tokenCount: 4,
        yCenter: 0.81,
        xStart: 0.05,
        xEnd: 0.9,
        height: 0.02,
        diagnostics: [],
      },
      {
        lineId: "l2",
        str: "09/02 MERCHANT B 20.00",
        page: 1,
        bbox: [0.05, 0.77, 0.9, 0.79],
        tokenIds: ["t5", "t6", "t7", "t8"],
        tokenCount: 4,
        yCenter: 0.78,
        xStart: 0.05,
        xEnd: 0.9,
        height: 0.02,
        diagnostics: [],
      },
      {
        lineId: "l3",
        str: "09/03 MERCHANT C 30.00",
        page: 1,
        bbox: [0.05, 0.74, 0.9, 0.76],
        tokenIds: ["t9", "t10", "t11", "t12"],
        tokenCount: 4,
        yCenter: 0.75,
        xStart: 0.05,
        xEnd: 0.9,
        height: 0.02,
        diagnostics: [],
      },
    ];

    const page = makePage(pageTokens, 1, 600, 800);
    const tables = detectTables(page as ExtractedPage, lines, defaultConfig);

    expect(tables.length).toBeGreaterThan(0);
    expect(tables[0].lineCount).toBe(3);
    expect(tables[0].page).toBe(1);
  });

  it("does not detect a table with too few lines", () => {
    const lines = [
      {
        lineId: "l1",
        str: "09/01 MERCHANT A 10.00",
        page: 1,
        bbox: [0.05, 0.8, 0.9, 0.82],
        tokenIds: ["t1"],
        tokenCount: 1,
        yCenter: 0.81,
        xStart: 0.05,
        xEnd: 0.9,
        height: 0.02,
        diagnostics: [],
      },
    ] as unknown as TextLine[];

    const page = makePage([], 1, 600, 800);
    const tables = detectTables(page as ExtractedPage, lines, defaultConfig);

    expect(tables).toHaveLength(0);
  });
});

describe("detectCandidateRows", () => {
  it("detects yearless numeric and named-month dates without starting from unrelated headers", () => {
    const lines: TextLine[] = [
      {
        lineId: "yearless",
        str: "10/01  10/02  FRESHMART  56.42",
        page: 1,
        bbox: [0.05, 0.8, 0.9, 0.82],
        tokenIds: ["t1"],
        tokenCount: 1,
        yCenter: 0.81,
        xStart: 0.05,
        xEnd: 0.9,
        height: 0.02,
        diagnostics: [],
      },
      {
        lineId: "named",
        str: "OCT 03  BOOK SHOP  8.00",
        page: 1,
        bbox: [0.05, 0.77, 0.9, 0.79],
        tokenIds: ["t2"],
        tokenCount: 1,
        yCenter: 0.78,
        xStart: 0.05,
        xEnd: 0.9,
        height: 0.02,
        diagnostics: [],
      },
      {
        lineId: "header",
        str: "STATEMENT PERIOD 10/01 - 10/31",
        page: 1,
        bbox: [0.05, 0.9, 0.9, 0.92],
        tokenIds: ["t3"],
        tokenCount: 1,
        yCenter: 0.91,
        xStart: 0.05,
        xEnd: 0.9,
        height: 0.02,
        diagnostics: [],
      },
    ];

    const { candidates, unmatchedLineIds } = detectCandidateRows(
      makePage([], 1) as ExtractedPage,
      lines,
      [],
      defaultConfig,
    );

    expect(candidates.map((candidate) => candidate.lineIds)).toEqual([["yearless"], ["named"]]);
    expect(unmatchedLineIds).toContain("header");
  });

  it("creates a candidate row from a date-like line", () => {
    const lines: TextLine[] = [
      {
        lineId: "l1",
        str: "09/01/2026 COFFEE HOUSE 4.85",
        page: 1,
        bbox: [0.05, 0.8, 0.9, 0.82],
        tokenIds: ["t1", "t2", "t3"],
        tokenCount: 3,
        yCenter: 0.81,
        xStart: 0.05,
        xEnd: 0.9,
        height: 0.02,
        diagnostics: [],
      },
    ];

    const tables: DetectedTable[] = [];

    const page = makePage([], 1, 600, 800);
    const { candidates } = detectCandidateRows(page as ExtractedPage, lines, tables, defaultConfig);

    expect(candidates).toHaveLength(1);
    expect(candidates[0].hasDateLikeField).toBe(true);
    expect(candidates[0].hasAmountLikeField).toBe(true);
    expect(candidates[0].multiline).toBe(false);
  });

  it("creates a multiline candidate row", () => {
    const lines: TextLine[] = [
      {
        lineId: "l1",
        str: "09/01/2026 COFFEE HOUSE DOWN",
        page: 1,
        bbox: [0.05, 0.8, 0.9, 0.82],
        tokenIds: ["t1"],
        tokenCount: 1,
        yCenter: 0.81,
        xStart: 0.05,
        xEnd: 0.9,
        height: 0.02,
        diagnostics: [],
      },
      {
        lineId: "l2",
        str: "TOWN",
        page: 1,
        bbox: [0.1, 0.785, 0.15, 0.8],
        tokenIds: ["t2"],
        tokenCount: 1,
        yCenter: 0.7925,
        xStart: 0.1,
        xEnd: 0.15,
        height: 0.015,
        diagnostics: [],
      },
    ];

    const tables: DetectedTable[] = [];

    const page = makePage([], 1, 600, 800);
    const { candidates } = detectCandidateRows(page as ExtractedPage, lines, tables, defaultConfig);

    expect(candidates).toHaveLength(1);
    expect(candidates[0].multiline).toBe(true);
    expect(candidates[0].lineIds).toHaveLength(2);
    expect(candidates[0].diagnostics).toContain("multiline_description");
  });

  it("tracks unmatched lines that are not date-like", () => {
    const lines: TextLine[] = [
      {
        lineId: "l1",
        str: "PAGE HEADER TEXT",
        page: 1,
        bbox: [0.05, 0.9, 0.9, 0.92],
        tokenIds: ["t1"],
        tokenCount: 1,
        yCenter: 0.91,
        xStart: 0.05,
        xEnd: 0.9,
        height: 0.02,
        diagnostics: [],
      },
    ];

    const tables: DetectedTable[] = [];

    const page = makePage([], 1, 600, 800);
    const { candidates, unmatchedLineIds } = detectCandidateRows(
      page as ExtractedPage,
      lines,
      tables,
      defaultConfig,
    );

    expect(candidates).toHaveLength(0);
    expect(unmatchedLineIds).toContain("l1");
  });

  it("does not start a candidate from a non-date line even when another candidate exists", () => {
    const lines: TextLine[] = [
      {
        lineId: "l1",
        str: "09/01/2026 COFFEE HOUSE 4.85",
        page: 1,
        bbox: [0.05, 0.8, 0.9, 0.82],
        tokenIds: ["t1"],
        tokenCount: 1,
        yCenter: 0.81,
        xStart: 0.05,
        xEnd: 0.9,
        height: 0.02,
        diagnostics: [],
      },
      {
        lineId: "l2",
        str: "TOTAL BALANCE 100.00",
        page: 1,
        bbox: [0.05, 0.77, 0.9, 0.79],
        tokenIds: ["t2"],
        tokenCount: 1,
        yCenter: 0.78,
        xStart: 0.05,
        xEnd: 0.9,
        height: 0.02,
        diagnostics: [],
      },
    ];

    const tables: DetectedTable[] = [];

    const page = makePage([], 1, 600, 800);
    const { candidates, unmatchedLineIds } = detectCandidateRows(
      page as ExtractedPage,
      lines,
      tables,
      defaultConfig,
    );

    expect(candidates).toHaveLength(1);
    expect(unmatchedLineIds).toContain("l2");
  });
});

describe("reconstructPage", () => {
  it("reconstructs a full page with lines, tables, candidates, and unmatched content", () => {
    const page = makePage([
      makeToken("09/01/2026", 0.05, 0.8, 0.07, 0.015, 1, "t1"),
      makeToken("COFFEE HOUSE", 0.15, 0.8, 0.1, 0.015, 1, "t2"),
      makeToken("4.85", 0.85, 0.8, 0.05, 0.015, 1, "t3"),
      makeToken("09/02/2026", 0.05, 0.77, 0.07, 0.015, 1, "t4"),
      makeToken("GROCERY STORE", 0.15, 0.77, 0.1, 0.015, 1, "t5"),
      makeToken("12.50", 0.85, 0.77, 0.05, 0.015, 1, "t6"),
      makeToken("ORPHAN TEXT", 0.5, 0.5, 0.08, 0.015, 1, "t7"),
    ]);

    const result = reconstructPage(page);

    expect(result.page).toBe(1);
    expect(result.lines.length).toBeGreaterThan(0);
    expect(result.candidates.length).toBeGreaterThan(0);
    // "ORPHAN TEXT" is a valid token so it gets its own line; since it has no date,
    // it ends up as an unmatched line
    expect(result.unmatchedLineIds.length).toBeGreaterThan(0);
    expect(result.diagnostics.some((d) => d.includes("unmatched"))).toBe(true);
  });
});

describe("reconstructDocument", () => {
  it("reconstructs all pages and aggregates diagnostics", () => {
    const page1 = makePage([
      makeToken("09/01/2026", 0.05, 0.8, 0.07, 0.015, 1, "t1"),
      makeToken("COFFEE HOUSE", 0.15, 0.8, 0.1, 0.015, 1, "t2"),
      makeToken("4.85", 0.85, 0.8, 0.05, 0.015, 1, "t3"),
    ]);
    const page2 = makePage(
      [
        makeToken("09/03/2026", 0.05, 0.8, 0.07, 0.015, 2, "t4"),
        makeToken("GAS STATION", 0.15, 0.8, 0.1, 0.015, 2, "t5"),
        makeToken("52.10", 0.85, 0.8, 0.05, 0.015, 2, "t6"),
      ],
      2,
    );

    const result: ExtractionResult = {
      pageCount: 2,
      pages: [page1, page2],
      totalTokens: 6,
      hasExtractableText: true,
    };

    const reconstructed = reconstructDocument(result);

    expect(reconstructed.pageCount).toBe(2);
    expect(reconstructed.pages).toHaveLength(2);
    expect(reconstructed.totalLines).toBeGreaterThan(0);
    expect(reconstructed.totalCandidates).toBeGreaterThan(0);
    expect(reconstructed.pages[0].page).toBe(1);
    expect(reconstructed.pages[1].page).toBe(2);
  });

  it("reports hasUnmatchedContent when unmatched lines exist", () => {
    const page = makePage([makeToken("ORPHAN TEXT", 0.5, 0.5, 0.08, 0.015, 1, "t-orphan")]);

    const result: ExtractionResult = {
      pageCount: 1,
      pages: [page],
      totalTokens: 1,
      hasExtractableText: true,
    };

    const reconstructed = reconstructDocument(result);

    expect(reconstructed.hasUnmatchedContent).toBe(true);
    expect(reconstructed.totalUnmatchedLines).toBe(1);
  });
});

describe("rowToAnchor", () => {
  it("converts a candidate row to a valid PdfAnchor", () => {
    const row: CandidateTransactionRow = {
      rowId: "p1-r0",
      page: 1,
      lineIds: ["l1"],
      tokenIds: ["t1", "t2"],
      str: "09/01/2026 COFFEE HOUSE 4.85",
      bbox: [0.05, 0.78, 0.9, 0.82],
      hasDateLikeField: true,
      hasAmountLikeField: true,
      multiline: false,
      diagnostics: [],
    };

    const anchor = rowToAnchor(row);

    expect(anchor.page).toBe(1);
    expect(anchor.bbox).toEqual([0.05, 0.78, 0.9, 0.82]);
    expect(anchor.tokenIds).toEqual(["t1", "t2"]);
  });
});
