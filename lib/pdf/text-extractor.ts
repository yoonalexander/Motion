import "client-only";
import type {
  PDFDocumentProxy,
  PDFPageProxy,
} from "pdfjs-dist";
import { normalizedBboxSchema } from "@/schemas/transaction";
import type { PdfAnchor } from "@/schemas/transaction";

export interface ExtractedToken {
  str: string;
  page: number;
  tokenId: string;
  bbox: [number, number, number, number];
  x: number;
  y: number;
  width: number;
  height: number;
  hasEOL: boolean;
}

export interface ExtractedPage {
  page: number;
  tokens: ExtractedToken[];
  width: number;
  height: number;
  rotation: number;
}

export interface ExtractionResult {
  pageCount: number;
  pages: ExtractedPage[];
  totalTokens: number;
  hasExtractableText: boolean;
}

// TextItem-like shape returned by PDF.js getTextContent(). The full types are
// internal to pdfjs-dist and not re-exported from the package root, so we
// define a minimal structural type here.
interface TextItemLike {
  str: string;
  transform: number[];
  width: number;
  height: number;
  hasEOL: boolean;
  fontName?: string;
  dir?: string;
  type?: never;
}

interface TextMarkedContentLike {
  type: "beginMarkedContent" | "beginMarkedContentProps" | "endMarkedContent";
  id?: string;
}

type TextContentLike = {
  items: Array<TextItemLike | TextMarkedContentLike>;
  styles: Record<string, unknown>;
  lang: string | null;
};

function isTextItem(
  item: TextItemLike | TextMarkedContentLike
): item is TextItemLike {
  return "str" in item;
}

function transformPoint(
  [a, b, c, d, e, f]: [number, number, number, number, number, number],
  x: number,
  y: number
): { x: number; y: number } {
  return {
    x: a * x + c * y + e,
    y: b * x + d * y + f,
  };
}

/**
 * Extracts text tokens with positional coordinates from a single PDF page.
 *
 * Coordinates are computed in PDF page space (origin bottom-left, y increases
 * upward) and normalized to [0, 1] by page width and height, matching the
 * PdfAnchor schema coordinate convention used by existing fixtures.
 *
 * Rotation is handled by transforming all four corners of each text item's
 * bounding box through the item's transform matrix, so rotated text produces
 * correct axis-aligned bounding boxes in page space.
 */
export async function extractPageText(
  page: PDFPageProxy,
  pageNumber: number
): Promise<ExtractedPage> {
  const content: TextContentLike = (await page.getTextContent()) as unknown as TextContentLike;
  const view = page.view;
  const pageWidth = view[2] - view[0];
  const pageHeight = view[3] - view[1];
  const rotation = page.rotate;

  const tokens: ExtractedToken[] = [];
  let tokenIndex = 0;

  for (const item of content.items) {
    if (!isTextItem(item)) {
      continue;
    }

    const text = item.str;
    if (!text || text.trim().length === 0) {
      continue;
    }

    const [a, b, c, d, e, f] = item.transform as unknown as [
      number,
      number,
      number,
      number,
      number,
      number,
    ];

    const corners = [
      [0, 0],
      [item.width, 0],
      [0, item.height],
      [item.width, item.height],
    ];

    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;

    for (const [cx, cy] of corners) {
      const { x, y } = transformPoint([a, b, c, d, e, f], cx, cy);
      minX = Math.min(minX, x);
      maxX = Math.max(maxX, x);
      minY = Math.min(minY, y);
      maxY = Math.max(maxY, y);
    }

    if (minX === maxX || minY === maxY) {
      continue;
    }

    const bbox: [number, number, number, number] = normalizedBboxSchema.parse([
      minX / pageWidth,
      minY / pageHeight,
      maxX / pageWidth,
      maxY / pageHeight,
    ]);

    tokens.push({
      str: text,
      page: pageNumber,
      tokenId: `p${pageNumber}-t${tokenIndex++}`,
      bbox,
      x: e / pageWidth,
      y: f / pageHeight,
      width: maxX - minX,
      height: maxY - minY,
      hasEOL: item.hasEOL,
    });
  }

  return {
    page: pageNumber,
    tokens,
    width: pageWidth,
    height: pageHeight,
    rotation,
  };
}

/**
 * Extracts text tokens with positional coordinates from every page of a PDF
 * document. Pages that contain no selectable text (scanned/image-only pages)
 * produce an empty token array and are included in the result so callers can
 * detect and report them.
 */
export async function extractDocumentText(
  document: PDFDocumentProxy
): Promise<ExtractionResult> {
  const pages: ExtractedPage[] = [];
  let totalTokens = 0;

  for (let pageNumber = 1; pageNumber <= document.numPages; pageNumber++) {
    const page = await document.getPage(pageNumber);
    const extracted = await extractPageText(page, pageNumber);
    pages.push(extracted);
    totalTokens += extracted.tokens.length;
  }

  return {
    pageCount: document.numPages,
    pages,
    totalTokens,
    hasExtractableText: totalTokens > 0,
  };
}

/**
 * Converts an ExtractedToken into a PdfAnchor value suitable for attaching to
 * a ParsedTransaction as its source provenance.
 */
export function tokenToAnchor(token: ExtractedToken): PdfAnchor {
  return {
    page: token.page,
    bbox: token.bbox,
    tokenIds: [token.tokenId],
  };
}
