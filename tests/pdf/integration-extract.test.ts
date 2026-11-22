import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import type { PDFDocumentProxy, PDFPageProxy } from "pdfjs-dist";
import {
  extractDocumentText,
  tokenToAnchor,
  type ExtractionResult,
} from "@/lib/pdf";

const mockGetDocument = vi.fn();
const mockGetPage = vi.fn();

vi.mock("pdfjs-dist", () => ({
  GlobalWorkerOptions: { workerSrc: "" },
  getDocument: (...args: unknown[]) => {
    mockGetDocument(...args);
    return { promise: Promise.resolve(mockDocument) };
  },
}));

import { loadPDF } from "@/lib/pdf";

const mockDocument = {
  numPages: 2,
  getPage: mockGetPage,
  destroy: vi.fn(),
} as unknown as PDFDocumentProxy;

function makePage(
  pageNumber: number,
  view: [number, number, number, number],
  items: Array<{
    str: string;
    transform: number[];
    width: number;
    height: number;
    hasEOL?: boolean;
  }>
): PDFPageProxy {
  return {
    pageNumber,
    rotate: 0,
    view,
    getTextContent: vi.fn().mockResolvedValue({
      items: items.map((item) => ({
        ...item,
        fontName: "Helvetica",
        dir: "ltr",
      })),
      styles: {},
      lang: null,
    }),
  } as unknown as PDFPageProxy;
}

describe("Motion_Synthetic_Credit_Card_Statement.pdf integration", () => {
  beforeEach(() => {
    vi.clearAllMocks();

    mockGetPage.mockImplementation((pageNumber: number) => {
      const items =
        pageNumber === 1
          ? [
              { str: "09/02/2026", transform: [1, 0, 0, 1, 39.24, 638.4], width: 70, height: 10 },
              { str: "COFFEE HOUSE DOWNTOWN", transform: [1, 0, 0, 1, 150, 638.4], width: 150, height: 10 },
              { str: "4.85", transform: [1, 0, 0, 1, 450, 638.4], width: 30, height: 10 },
              { str: "09/05/2026", transform: [1, 0, 0, 1, 39.24, 600], width: 70, height: 10 },
              { str: "STREAMING SUBSCRIPTION", transform: [1, 0, 0, 1, 150, 600], width: 140, height: 10 },
              { str: "16.99", transform: [1, 0, 0, 1, 450, 600], width: 35, height: 10 },
            ]
          : [
              { str: "09/03/2026", transform: [1, 0, 0, 1, 39.24, 600], width: 70, height: 10 },
              { str: "METRO GROCERY #142", transform: [1, 0, 0, 1, 150, 600], width: 130, height: 10 },
              { str: "86.42", transform: [1, 0, 0, 1, 450, 600], width: 35, height: 10 },
              { str: "09/07/2026", transform: [1, 0, 0, 1, 39.24, 560], width: 70, height: 10 },
              { str: "GAS STATION 24", transform: [1, 0, 0, 1, 150, 560], width: 100, height: 10 },
              { str: "52.10", transform: [1, 0, 0, 1, 450, 560], width: 30, height: 10 },
            ];

      return Promise.resolve(makePage(pageNumber, [0, 0, 600, 800], items));
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("loads the PDF successfully using the existing implementation", async () => {
    const arrayBuffer = new ArrayBuffer(8);
    const file = {
      arrayBuffer: vi.fn().mockResolvedValue(arrayBuffer),
      name: "statement.pdf",
      type: "application/pdf",
    } as unknown as File;

    await loadPDF(file);

    expect(file.arrayBuffer).toHaveBeenCalled();
    expect(mockGetDocument).toHaveBeenCalledWith({ data: arrayBuffer });
  });

  it("extracts text from every page containing selectable text", async () => {
    const result: ExtractionResult = await extractDocumentText(mockDocument);

    expect(result.pageCount).toBe(2);
    expect(result.pages).toHaveLength(2);
    expect(result.hasExtractableText).toBe(true);
    expect(result.totalTokens).toBe(12);
    expect(result.pages[0].page).toBe(1);
    expect(result.pages[1].page).toBe(2);
  });

  it("extracts tokens with normalized coordinates on all pages", async () => {
    const result: ExtractionResult = await extractDocumentText(mockDocument);

    for (const page of result.pages) {
      for (const token of page.tokens) {
        const [x0, y0, x1, y1] = token.bbox;
        expect(x0).toBeGreaterThanOrEqual(0);
        expect(y0).toBeGreaterThanOrEqual(0);
        expect(x1).toBeLessThanOrEqual(1);
        expect(y1).toBeLessThanOrEqual(1);
        expect(x0).toBeLessThan(x1);
        expect(y0).toBeLessThan(y1);
        expect(token.page).toBe(page.page);
        expect(token.str.trim().length).toBeGreaterThan(0);
      }
    }
  });

  it("extracts transaction-like content (dates, merchants, amounts)", async () => {
    const result: ExtractionResult = await extractDocumentText(mockDocument);

    const allText = result.pages.flatMap((p) => p.tokens.map((t) => t.str)).join(" ");

    expect(/\d{2}\/\d{2}\/\d{4}/.test(allText)).toBe(true);
    expect(/\d[\d,]+\.\d{2}/.test(allText)).toBe(true);
    expect(allText.length).toBeGreaterThan(100);
  });

  it("preserves source page association for every token", async () => {
    const result: ExtractionResult = await extractDocumentText(mockDocument);

    for (const page of result.pages) {
      for (const token of page.tokens) {
        expect(token.page).toBeGreaterThan(0);
        expect(token.page).toBeLessThanOrEqual(2);
      }
    }
  });

  it("produces tokens that convert to valid PdfAnchor values", async () => {
    const result: ExtractionResult = await extractDocumentText(mockDocument);

    for (const page of result.pages) {
      for (const token of page.tokens) {
        const anchor = tokenToAnchor(token);
        expect(anchor.page).toBe(token.page);
        expect(anchor.bbox).toEqual(token.bbox);
        expect(anchor.tokenIds).toEqual([token.tokenId]);
      }
    }
  });

  it("yields substantial token coverage across the statement", async () => {
    const result: ExtractionResult = await extractDocumentText(mockDocument);

    expect(result.totalTokens).toBeGreaterThan(10);
  });
});
