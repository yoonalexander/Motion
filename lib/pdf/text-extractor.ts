import "client-only";
import type { PDFDocumentProxy, PDFPageProxy } from "pdfjs-dist";
import { normalizedBboxSchema } from "@/schemas/transaction";
import type { PdfAnchor } from "@/schemas/transaction";

export interface ExtractedToken {
  str: string;
  page: number;
  tokenId: string;
  bbox: PdfAnchor["bbox"];
  /** Baseline origin in the same crop-relative space as bbox, before clipping. */
  x: number;
  y: number;
  baselineEnd?: [number, number];
  width: number;
  height: number;
  hasEOL: boolean;
}

export interface TextGeometryDiagnostic {
  itemIndex: number;
  code: "invalid_text_geometry" | "outside_page_view" | "clipped_to_page_view";
}

export interface ExtractedPage {
  page: number;
  tokens: ExtractedToken[];
  width: number;
  height: number;
  rotation: number;
  geometryDiagnostics?: TextGeometryDiagnostic[];
}

export interface ExtractionResult {
  pageCount: number;
  pages: ExtractedPage[];
  totalTokens: number;
  hasExtractableText: boolean;
}

type TextContent = Awaited<ReturnType<PDFPageProxy["getTextContent"]>>;
type TextItem = Extract<TextContent["items"][number], { str: string }>;
type TextStyle = TextContent["styles"][string];

function textItemGeometry(item: TextItem, style: TextStyle | undefined) {
  const [a, b, c, d, x, y]: number[] = item.transform;
  if (![a, b, c, d, x, y, item.width, item.height].every(Number.isFinite)) {
    return null;
  }

  const scaleX = Math.hypot(a, b);
  const scaleY = Math.hypot(c, d);
  if (!scaleX || !scaleY || item.width <= 0 || item.height <= 0) {
    return null;
  }

  // PDF.js already reports advance and font dimensions in page units. Use
  // the text transform for direction and shear without applying scale again.
  const vertical = style?.vertical ?? item.dir === "ttb";
  const [advanceX, advanceY, fontX, fontY] = vertical
    ? [
        (-c / scaleY) * item.height,
        (-d / scaleY) * item.height,
        (a / scaleX) * item.width,
        (b / scaleX) * item.width,
      ]
    : [
        (a / scaleX) * item.width,
        (b / scaleX) * item.width,
        (c / scaleY) * item.height,
        (d / scaleY) * item.height,
      ];
  const ascent = style?.ascent;
  const descent = style?.descent;
  const top = ascent !== undefined && Number.isFinite(ascent) && ascent > 0 ? ascent : 0.8;
  const bottom = descent !== undefined && Number.isFinite(descent) && descent <= 0 ? descent : -0.2;
  const endX = x + advanceX;
  const endY = y + advanceY;
  const [lowX, highX] = [fontX * bottom, fontX * top];
  const [lowY, highY] = [fontY * bottom, fontY * top];
  const bounds = [
    Math.min(x, endX) + Math.min(lowX, highX),
    Math.min(y, endY) + Math.min(lowY, highY),
    Math.max(x, endX) + Math.max(lowX, highX),
    Math.max(y, endY) + Math.max(lowY, highY),
  ] as const;
  const [left, lower, right, upper] = bounds;
  if (
    !bounds.every(Number.isFinite) ||
    !(left < right && lower < upper) ||
    (a / scaleX) * (d / scaleY) === (b / scaleX) * (c / scaleY)
  ) {
    return null;
  }

  return { bounds, x, y, endX, endY };
}

/**
 * Extracts text tokens with positional coordinates from a single PDF page.
 *
 * Bounds are measured in unrotated PDF user space and clipped to page.view.
 * PdfAnchor uses that visible area's lower-left origin, with y increasing
 * upward. Page rotation is applied only when mapping the anchor to a viewport.
 */
export async function extractPageText(
  page: PDFPageProxy,
  pageNumber: number,
): Promise<ExtractedPage> {
  const [viewLeft, viewBottom, viewRight, viewTop] = page.view;
  const pageWidth = viewRight - viewLeft;
  const pageHeight = viewTop - viewBottom;
  if (
    !Number.isFinite(pageWidth) ||
    !Number.isFinite(pageHeight) ||
    pageWidth <= 0 ||
    pageHeight <= 0
  ) {
    throw new Error("Invalid PDF page view");
  }

  const { items, styles } = await page.getTextContent();
  const normalizeX = (x: number) => (x - viewLeft) / pageWidth;
  const normalizeY = (y: number) => (y - viewBottom) / pageHeight;
  const tokens: ExtractedToken[] = [];
  const geometryDiagnostics: TextGeometryDiagnostic[] = [];

  for (const [itemIndex, item] of items.entries()) {
    if (!("str" in item) || !item.str.trim()) {
      continue;
    }

    const geometry = textItemGeometry(item, styles[item.fontName]);
    if (!geometry) {
      geometryDiagnostics.push({ itemIndex, code: "invalid_text_geometry" });
      continue;
    }

    const [left, bottom, right, top] = geometry.bounds;
    const bbox = normalizedBboxSchema.safeParse([
      normalizeX(Math.max(left, viewLeft)),
      normalizeY(Math.max(bottom, viewBottom)),
      normalizeX(Math.min(right, viewRight)),
      normalizeY(Math.min(top, viewTop)),
    ]);
    if (!bbox.success) {
      geometryDiagnostics.push({ itemIndex, code: "outside_page_view" });
      continue;
    }
    if (left < viewLeft || bottom < viewBottom || right > viewRight || top > viewTop) {
      geometryDiagnostics.push({ itemIndex, code: "clipped_to_page_view" });
    }

    tokens.push({
      str: item.str,
      page: pageNumber,
      tokenId: `p${pageNumber}-t${tokens.length}`,
      bbox: bbox.data,
      x: normalizeX(geometry.x),
      y: normalizeY(geometry.y),
      baselineEnd: [normalizeX(geometry.endX), normalizeY(geometry.endY)],
      width: right - left,
      height: top - bottom,
      hasEOL: item.hasEOL,
    });
  }

  return {
    page: pageNumber,
    tokens,
    width: pageWidth,
    height: pageHeight,
    rotation: page.rotate,
    geometryDiagnostics,
  };
}

/**
 * Extracts text tokens with positional coordinates from every page of a PDF
 * document. Pages that contain no selectable text (scanned/image-only pages)
 * produce an empty token array and are included in the result so callers can
 * detect and report them.
 */
export async function extractDocumentText(document: PDFDocumentProxy): Promise<ExtractionResult> {
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
