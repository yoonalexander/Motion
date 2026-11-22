import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";

const mockGetTextContent = vi.fn();
const mockGetPage = vi.fn();

vi.mock("pdfjs-dist", () => ({
  GlobalWorkerOptions: { workerSrc: "" },
  getDocument: vi.fn(),
  PDFDocumentProxy: class {},
  PDFPageProxy: class {},
}));

import {
  extractDocumentText,
  extractPageText,
  type ExtractedPage,
} from "@/lib/pdf";
import type { PDFDocumentProxy, PDFPageProxy } from "pdfjs-dist";

function makePage(
  view: [number, number, number, number],
  items: Array<{ str: string; transform: number[]; width: number; height: number; hasEOL?: boolean }>,
  rotation = 0
): PDFPageProxy {
  return {
    pageNumber: 1,
    rotate: rotation,
    view,
    getTextContent: mockGetTextContent.mockResolvedValue({
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

describe("extractPageText", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("extracts text tokens with normalized bounding boxes", async () => {
    const page = makePage([0, 0, 600, 800], [
      {
        str: "COFFEE HOUSE",
        transform: [1, 0, 0, 1, 39.24, 638.4],
        width: 100,
        height: 10,
        hasEOL: true,
      },
    ]);

    const result: ExtractedPage = await extractPageText(page as unknown as PDFPageProxy, 1);

    expect(result.page).toBe(1);
    expect(result.tokens).toHaveLength(1);
    expect(result.tokens[0].str).toBe("COFFEE HOUSE");
    expect(result.tokens[0].page).toBe(1);
    expect(result.tokens[0].tokenId).toBe("p1-t0");

    const [x0, y0, x1, y1] = result.tokens[0].bbox;
    expect(x0).toBeGreaterThanOrEqual(0);
    expect(y0).toBeGreaterThanOrEqual(0);
    expect(x1).toBeLessThanOrEqual(1);
    expect(y1).toBeLessThanOrEqual(1);
    expect(x0).toBeLessThan(x1);
    expect(y0).toBeLessThan(y1);

    expect(x0).toBeCloseTo(39.24 / 600, 4);
    expect(x1).toBeCloseTo((39.24 + 100) / 600, 4);
    expect(y0).toBeCloseTo(638.4 / 800, 4);
    expect(y1).toBeCloseTo((638.4 + 10) / 800, 4);
  });

  it("extracts multiple tokens from a single page", async () => {
    const page = makePage([0, 0, 600, 800], [
      { str: "Date", transform: [1, 0, 0, 1, 39.24, 638.4], width: 30, height: 10 },
      { str: "Merchant", transform: [1, 0, 0, 1, 150, 638.4], width: 60, height: 10 },
      { str: "Amount", transform: [1, 0, 0, 1, 450, 638.4], width: 45, height: 10 },
    ]);

    const result = await extractPageText(page as unknown as PDFPageProxy, 1);

    expect(result.tokens).toHaveLength(3);
    expect(result.tokens.map((t) => t.str)).toEqual(["Date", "Merchant", "Amount"]);
    expect(result.tokens[0].tokenId).toBe("p1-t0");
    expect(result.tokens[1].tokenId).toBe("p1-t1");
    expect(result.tokens[2].tokenId).toBe("p1-t2");
  });

  it("skips empty whitespace text items", async () => {
    const page = makePage([0, 0, 600, 800], [
      { str: "   ", transform: [1, 0, 0, 1, 39.24, 638.4], width: 0, height: 10 },
      { str: "REAL TEXT", transform: [1, 0, 0, 1, 39.24, 638.4], width: 60, height: 10 },
    ]);

    const result = await extractPageText(page as unknown as PDFPageProxy, 1);

    expect(result.tokens).toHaveLength(1);
    expect(result.tokens[0].str).toBe("REAL TEXT");
  });

  it("skips zero-dimension text items", async () => {
    const page = makePage([0, 0, 600, 800], [
      { str: "FLAT", transform: [1, 0, 0, 1, 39.24, 638.4], width: 0, height: 10 },
      { str: "NORMAL", transform: [1, 0, 0, 1, 39.24, 638.4], width: 40, height: 10 },
    ]);

    const result = await extractPageText(page as unknown as PDFPageProxy, 1);

    expect(result.tokens).toHaveLength(1);
    expect(result.tokens[0].str).toBe("NORMAL");
  });

  it("ignores TextMarkedContent items", async () => {
    mockGetTextContent.mockResolvedValue({
      items: [
        { type: "beginMarkedContent", id: "mc1" },
        {
          str: "VISIBLE TEXT",
          transform: [1, 0, 0, 1, 39.24, 638.4],
          width: 60,
          height: 10,
          fontName: "Helvetica",
          dir: "ltr",
          hasEOL: false,
        },
        { type: "endMarkedContent", id: "mc1" },
      ],
      styles: {},
      lang: null,
    });

    const page = {
      pageNumber: 1,
      rotate: 0,
      view: [0, 0, 600, 800],
      getTextContent: mockGetTextContent,
    } as unknown as PDFPageProxy;

    const result = await extractPageText(page, 1);

    expect(result.tokens).toHaveLength(1);
    expect(result.tokens[0].str).toBe("VISIBLE TEXT");
  });

  it("reports page dimensions and rotation", async () => {
    const page = makePage([0, 0, 600, 800], [
      { str: "TEXT", transform: [1, 0, 0, 1, 39.24, 638.4], width: 30, height: 10 },
    ], 90);

    const result = await extractPageText(page as unknown as PDFPageProxy, 1);

    expect(result.width).toBe(600);
    expect(result.height).toBe(800);
    expect(result.rotation).toBe(90);
  });
});

describe("extractDocumentText", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("extracts text from all pages of a document", async () => {
    const pageItems: Record<number, Array<{ str: string; transform: number[]; width: number; height: number }>> = {
      1: [{ str: "Page One", transform: [1, 0, 0, 1, 39.24, 638.4], width: 60, height: 10 }],
      2: [{ str: "Page Two", transform: [1, 0, 0, 1, 39.24, 638.4], width: 60, height: 10 }],
    };

    mockGetPage.mockImplementation((pageNumber: number) => {
      const items = pageItems[pageNumber] ?? [];
      const page = makePage([0, 0, 600, 800], items);
      Object.defineProperty(page, "pageNumber", { value: pageNumber });
      return Promise.resolve(page);
    });

    const document = {
      numPages: 2,
      getPage: mockGetPage,
    } as unknown as PDFDocumentProxy;

    const result = await extractDocumentText(document);

    expect(result.pageCount).toBe(2);
    expect(result.pages).toHaveLength(2);
    expect(result.totalTokens).toBe(2);
    expect(result.hasExtractableText).toBe(true);
    expect(result.pages[0].tokens[0].str).toBe("Page One");
    expect(result.pages[1].tokens[0].str).toBe("Page Two");
    expect(result.pages[0].page).toBe(1);
    expect(result.pages[1].page).toBe(2);
  });

  it("reports no extractable text for image-only pages", async () => {
    mockGetPage.mockImplementation(() =>
      Promise.resolve(makePage([0, 0, 600, 800], []))
    );

    const document = {
      numPages: 1,
      getPage: mockGetPage,
    } as unknown as PDFDocumentProxy;

    const result = await extractDocumentText(document);

    expect(result.pageCount).toBe(1);
    expect(result.pages[0].tokens).toHaveLength(0);
    expect(result.totalTokens).toBe(0);
    expect(result.hasExtractableText).toBe(false);
  });

  it("normalizes coordinates correctly across page sizes", async () => {
    mockGetPage.mockImplementation(() =>
      Promise.resolve(makePage([0, 0, 300, 400], [
        { str: "TEXT", transform: [1, 0, 0, 1, 75, 300], width: 30, height: 10 },
      ]))
    );

    const document = {
      numPages: 1,
      getPage: mockGetPage,
    } as unknown as PDFDocumentProxy;

    const result = await extractDocumentText(document);

    const [x0, y0, x1, y1] = result.pages[0].tokens[0].bbox;
    expect(x0).toBeCloseTo(75 / 300, 4);
    expect(y0).toBeCloseTo(300 / 400, 4);
    expect(x1).toBeCloseTo((75 + 30) / 300, 4);
    expect(y1).toBeCloseTo((300 + 10) / 400, 4);
  });
});
