import type { PageViewport } from "pdfjs-dist";
import type { PdfAnchor } from "@/schemas/transaction";

/**
 * Maps crop-relative, unrotated y-up bounds to pixels for the viewport used
 * to render that page. PDF.js applies crop offsets, page rotation and zoom.
 */
export function bboxToViewportRect(
  [left, bottom, right, top]: PdfAnchor["bbox"],
  viewport: PageViewport,
) {
  const [pageX, pageY, pageRight, pageTop] = viewport.viewBox;
  const pageWidth = pageRight - pageX;
  const pageHeight = pageTop - pageY;
  const [x0, y0, x1, y1] = viewport.convertToViewportRectangle([
    pageX + left * pageWidth,
    pageY + bottom * pageHeight,
    pageX + right * pageWidth,
    pageY + top * pageHeight,
  ]);

  return {
    left: Math.min(x0, x1),
    top: Math.min(y0, y1),
    width: Math.abs(x1 - x0),
    height: Math.abs(y1 - y0),
  };
}
