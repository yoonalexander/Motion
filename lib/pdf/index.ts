import "client-only";
import * as pdfjsLib from "pdfjs-dist";

// Configure the PDF.js worker source so it loads from our public directory.
// This keeps all PDF processing browser-local (SDD §6.2).
pdfjsLib.GlobalWorkerOptions.workerSrc = "/pdf.worker.mjs";

export interface PDFLoadResult {
  document: pdfjsLib.PDFDocumentProxy;
  numPages: number;
}

export {
  extractDocumentText,
  extractPageText,
  tokenToAnchor,
  type ExtractionResult,
  type ExtractedPage,
  type ExtractedToken,
} from "./text-extractor";
export {
  reconstructDocument,
  reconstructPage,
  reconstructLines,
  detectTables,
  detectCandidateRows,
  rowToAnchor,
  lineToAnchor,
  type TextLine,
  type DetectedTable,
  type CandidateTransactionRow,
  type PageReconstruction,
  type ReconstructionResult,
  type ReconstructionConfig,
  defaultConfig,
} from "./text-reconstructor";
export {
  parseCandidateRow,
  parseDocumentCandidates,
  parseDate,
  parseAmount,
  inferTransactionType,
  extractMerchantDescription,
  type StatementContext,
  type ParsedCandidate,
  type ParsingStatus,
  type RawParsedFields,
  type ParseResult,
} from "./transaction-parser";
export { findDateSpans } from "./date-parser";
export type { DateSpan, DateParseContext, ParsedDate } from "./date-parser";

/**
 * Loads a PDF file from the browser's File object into a PDF.js document.
 * Never uploads raw PDF bytes to the backend.
 */
export async function loadPDF(file: File): Promise<PDFLoadResult> {
  const arrayBuffer = await file.arrayBuffer();
  const loadingTask = pdfjsLib.getDocument({ data: arrayBuffer });
  const document = await loadingTask.promise;
  return { document, numPages: document.numPages };
}

/**
 * Renders a PDF page to an HTML canvas element at the given scale.
 */
export async function renderPageToCanvas(
  page: pdfjsLib.PDFPageProxy,
  canvas: HTMLCanvasElement,
  scale: number = 1
): Promise<void> {
  const viewport = page.getViewport({ scale });
  canvas.width = Math.ceil(viewport.width);
  canvas.height = Math.ceil(viewport.height);

  const context = canvas.getContext("2d");
  if (!context) {
    throw new Error("Could not get 2D rendering context from canvas");
  }

  await page.render({
    canvasContext: context,
    viewport,
  }).promise;
}
