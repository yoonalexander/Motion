import "client-only";
import * as pdfjsLib from "pdfjs-dist";

// Configure the PDF.js worker source so it loads from our public directory.
// This keeps all PDF processing browser-local (SDD §6.2).
pdfjsLib.GlobalWorkerOptions.workerSrc = "/pdf.worker.mjs";

export interface PDFLoadResult {
  document: pdfjsLib.PDFDocumentProxy;
  numPages: number;
}

export interface PDFLoadHandle {
  promise: Promise<PDFLoadResult>;
  cancel(): void;
}

export type PDFPageViewport = ReturnType<pdfjsLib.PDFPageProxy["getViewport"]>;

export interface PDFPageRenderHandle {
  viewport: PDFPageViewport;
  promise: Promise<void>;
  cancel(): void;
}

const documentDestructions = new WeakMap<pdfjsLib.PDFDocumentProxy, Promise<void>>();

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
  type ValidatedCandidate,
  type UnresolvedCandidate,
  type ParsingStatus,
  type RawParsedFields,
  type FieldSpan,
  type ParsedFieldSpans,
  type PositionedSource,
  type ParseResult,
} from "./transaction-parser";
export { findDateSpans } from "./date-parser";
export type { DateSpan, DateParseContext, ParsedDate } from "./date-parser";

/**
 * Loads a PDF file from the browser's File object into a PDF.js document.
 * Never uploads raw PDF bytes to the backend.
 */
export function startPDFLoad(file: File): PDFLoadHandle {
  let cancelled = false;
  let loadingTask: ReturnType<typeof pdfjsLib.getDocument> | null = null;
  let loadingTaskDestruction: Promise<void> | null = null;

  const destroyLoadingTask = (): Promise<void> => {
    if (!loadingTask) return Promise.resolve();
    if (!loadingTaskDestruction) loadingTaskDestruction = loadingTask.destroy();
    return loadingTaskDestruction;
  };

  const promise = (async () => {
    const arrayBuffer = await file.arrayBuffer();
    if (cancelled) throw new DOMException("PDF load was cancelled", "AbortError");

    loadingTask = pdfjsLib.getDocument({ data: arrayBuffer });
    try {
      const document = await loadingTask.promise;
      if (cancelled) {
        await destroyPDFDocument(document);
        throw new DOMException("PDF load was cancelled", "AbortError");
      }
      return { document, numPages: document.numPages };
    } catch (error) {
      await destroyLoadingTask().catch(() => undefined);
      throw error;
    }
  })();

  return {
    promise,
    cancel() {
      if (cancelled) return;
      cancelled = true;
      void destroyLoadingTask().catch(() => undefined);
    },
  };
}

export async function loadPDF(file: File): Promise<PDFLoadResult> {
  return startPDFLoad(file).promise;
}

/** Idempotently releases a PDF document, even when multiple UI owners clean it up. */
export function destroyPDFDocument(document: pdfjsLib.PDFDocumentProxy): Promise<void> {
  const existing = documentDestructions.get(document);
  if (existing) return existing;

  const destruction = document.destroy();
  documentDestructions.set(document, destruction);
  return destruction;
}

/**
 * Renders a PDF page to an HTML canvas element at the given scale.
 */
export async function renderPageToCanvas(
  page: pdfjsLib.PDFPageProxy,
  canvas: HTMLCanvasElement,
  scale: number = 1,
): Promise<void> {
  await startPageRender(page, canvas, scale).promise;
}

/** Starts a cancellable render and exposes the exact viewport used for canvas sizing. */
export function startPageRender(
  page: pdfjsLib.PDFPageProxy,
  canvas: HTMLCanvasElement,
  scale: number = 1,
): PDFPageRenderHandle {
  const viewport = page.getViewport({ scale });
  canvas.width = Math.ceil(viewport.width);
  canvas.height = Math.ceil(viewport.height);

  const context = canvas.getContext("2d");
  if (!context) {
    throw new Error("Could not get 2D rendering context from canvas");
  }

  const renderTask = page.render({
    canvasContext: context,
    viewport,
  });
  let settled = false;
  let cancellationRequested = false;
  const promise = renderTask.promise.then(
    () => {
      settled = true;
    },
    (error: unknown) => {
      settled = true;
      throw error;
    },
  );

  return {
    viewport,
    promise,
    cancel() {
      if (!settled && !cancellationRequested) {
        cancellationRequested = true;
        renderTask.cancel();
      }
    },
  };
}
