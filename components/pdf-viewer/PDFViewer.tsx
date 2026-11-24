"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { ChangeEvent } from "react";
import type { PDFDocumentProxy } from "pdfjs-dist";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  destroyPDFDocument,
  startPageRender,
  startPDFLoad,
  type PDFLoadHandle,
  type PDFLoadResult,
  type PDFPageRenderHandle,
} from "@/lib/pdf";

interface PDFViewerProps {
  acceptedFileTypes?: string[];
}

function isRenderCancelled(error: unknown): boolean {
  return error instanceof Error && error.name === "RenderingCancelledException";
}

export function PDFViewer({ acceptedFileTypes = ["application/pdf"] }: PDFViewerProps) {
  const [file, setFile] = useState<File | null>(null);
  const [pdfResult, setPdfResult] = useState<PDFLoadResult | null>(null);
  const [currentPage, setCurrentPage] = useState(1);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [scale, setScale] = useState(1);
  const [viewportSize, setViewportSize] = useState<{ width: number; height: number } | null>(null);

  const canvasRef = useRef<HTMLCanvasElement>(null);
  const documentRef = useRef<PDFDocumentProxy | null>(null);
  const loadHandleRef = useRef<PDFLoadHandle | null>(null);
  const renderHandleRef = useRef<PDFPageRenderHandle | null>(null);
  const loadGenerationRef = useRef(0);
  const renderGenerationRef = useRef(0);
  const mountedRef = useRef(false);
  const numPages = pdfResult?.numPages ?? 0;

  const cancelActiveRender = useCallback(async () => {
    const handle = renderHandleRef.current;
    if (!handle) return;
    handle.cancel();
    await handle.promise.catch(() => undefined);
    if (renderHandleRef.current === handle) renderHandleRef.current = null;
  }, []);

  const releaseCurrentDocument = useCallback(async () => {
    const document = documentRef.current;
    documentRef.current = null;
    await cancelActiveRender();
    if (document) await destroyPDFDocument(document).catch(() => undefined);
  }, [cancelActiveRender]);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      loadGenerationRef.current += 1;
      loadHandleRef.current?.cancel();
      void releaseCurrentDocument();
    };
  }, [releaseCurrentDocument]);

  const resetFile = useCallback(() => {
    loadGenerationRef.current += 1;
    loadHandleRef.current?.cancel();
    loadHandleRef.current = null;
    setFile(null);
    setPdfResult(null);
    setCurrentPage(1);
    setLoading(false);
    setError(null);
    setViewportSize(null);
    void releaseCurrentDocument();
  }, [releaseCurrentDocument]);

  const handleFileSelect = useCallback(
    async (event: ChangeEvent<HTMLInputElement>) => {
      const input = event.currentTarget;
      const selectedFile = input.files?.[0];
      input.value = "";
      if (!selectedFile) return;

      const request = ++loadGenerationRef.current;
      loadHandleRef.current?.cancel();
      loadHandleRef.current = null;
      setFile(selectedFile);
      setError(null);
      setLoading(true);
      setCurrentPage(1);
      setPdfResult(null);
      setViewportSize(null);

      if (!acceptedFileTypes.includes(selectedFile.type)) {
        setLoading(false);
        setError("Please select a valid PDF file.");
        await releaseCurrentDocument();
        return;
      }

      await releaseCurrentDocument();
      if (!mountedRef.current || request !== loadGenerationRef.current) return;

      const loadHandle = startPDFLoad(selectedFile);
      loadHandleRef.current = loadHandle;
      try {
        const result = await loadHandle.promise;
        if (!mountedRef.current || request !== loadGenerationRef.current) {
          await destroyPDFDocument(result.document).catch(() => undefined);
          return;
        }
        documentRef.current = result.document;
        setPdfResult(result);
      } catch (loadError) {
        if (mountedRef.current && request === loadGenerationRef.current) {
          setError(loadError instanceof Error ? loadError.message : "Failed to load PDF");
        }
      } finally {
        if (loadHandleRef.current === loadHandle) loadHandleRef.current = null;
        if (mountedRef.current && request === loadGenerationRef.current) setLoading(false);
      }
    },
    [acceptedFileTypes, releaseCurrentDocument],
  );

  useEffect(() => {
    const document = pdfResult?.document;
    const canvas = canvasRef.current;
    if (!document || !canvas || currentPage < 1 || currentPage > numPages) return;

    const request = ++renderGenerationRef.current;
    let cancelled = false;

    const renderPage = async () => {
      const previousRender = renderHandleRef.current;
      if (previousRender) {
        previousRender.cancel();
        await previousRender.promise.catch(() => undefined);
        if (renderHandleRef.current === previousRender) renderHandleRef.current = null;
      }
      if (cancelled || request !== renderGenerationRef.current || documentRef.current !== document)
        return;

      let handle: PDFPageRenderHandle | null = null;
      try {
        const page = await document.getPage(currentPage);
        if (
          cancelled ||
          request !== renderGenerationRef.current ||
          documentRef.current !== document
        )
          return;

        handle = startPageRender(page, canvas, scale);
        renderHandleRef.current = handle;
        await handle.promise;
        if (
          cancelled ||
          request !== renderGenerationRef.current ||
          documentRef.current !== document
        )
          return;
        setViewportSize({ width: handle.viewport.width, height: handle.viewport.height });
      } catch (renderError) {
        if (
          !cancelled &&
          request === renderGenerationRef.current &&
          !isRenderCancelled(renderError)
        ) {
          setError(renderError instanceof Error ? renderError.message : "Failed to render page");
        }
      } finally {
        if (handle && renderHandleRef.current === handle) renderHandleRef.current = null;
      }
    };

    void renderPage();
    return () => {
      cancelled = true;
      if (renderGenerationRef.current === request) renderGenerationRef.current += 1;
      renderHandleRef.current?.cancel();
    };
  }, [pdfResult, currentPage, numPages, scale]);

  const handlePrevPage = useCallback(() => {
    setViewportSize(null);
    setCurrentPage((page) => Math.max(1, page - 1));
  }, []);

  const handleNextPage = useCallback(() => {
    setViewportSize(null);
    setCurrentPage((page) => Math.min(numPages, page + 1));
  }, [numPages]);

  const handleZoomIn = useCallback(() => {
    if (scale >= 3) return;
    setViewportSize(null);
    setScale((value) => Math.min(value + 0.25, 3));
  }, [scale]);

  const handleZoomOut = useCallback(() => {
    if (scale <= 0.5) return;
    setViewportSize(null);
    setScale((value) => Math.max(value - 0.25, 0.5));
  }, [scale]);

  if (error) {
    return (
      <Card className="mt-8">
        <CardHeader>
          <CardTitle>Error</CardTitle>
        </CardHeader>
        <CardContent className="text-slate-600">{error}</CardContent>
        <Button onClick={resetFile} variant="secondary">
          Try again
        </Button>
      </Card>
    );
  }

  if (loading && !pdfResult) {
    return (
      <Card className="mt-8">
        <CardContent className="flex flex-col items-center justify-center py-12">
          <span className="animate-spin rounded-full h-8 w-8 border-b-2 border-slate-950" />
          <p className="mt-4 text-sm text-slate-600">Loading PDF…</p>
        </CardContent>
      </Card>
    );
  }

  return (
    <div className="mt-8">
      <Card>
        <CardHeader>
          <CardTitle>PDF Viewer</CardTitle>
        </CardHeader>
        <CardContent>
          <input
            accept={acceptedFileTypes.join(",")}
            id="pdf-file-input"
            onChange={handleFileSelect}
            type="file"
            className="sr-only"
          />
          <label htmlFor="pdf-file-input" className="button">
            Select a PDF file
          </label>
          {file && <p className="mt-2 text-sm text-slate-500">{file.name}</p>}
        </CardContent>
      </Card>

      {pdfResult && numPages > 0 && (
        <div className="mt-8">
          <Card>
            <CardHeader>
              <CardTitle>Document</CardTitle>
            </CardHeader>
            <CardContent className="p-0">
              <div className="flex flex-col">
                <div
                  className="relative w-full max-w-full aspect-auto bg-slate-100"
                  data-viewport-height={viewportSize?.height}
                  data-viewport-width={viewportSize?.width}
                  style={{
                    aspectRatio: viewportSize
                      ? `${viewportSize.width} / ${viewportSize.height}`
                      : undefined,
                  }}
                >
                  <canvas ref={canvasRef} className="block max-w-full h-auto" />
                </div>
                <div className="flex items-center justify-between px-4 py-2 border-t border-slate-200 bg-slate-50">
                  <div className="flex items-center gap-2">
                    <Button onClick={handlePrevPage} disabled={currentPage <= 1}>
                      Previous page
                    </Button>
                    <Button onClick={handleNextPage} disabled={currentPage >= numPages}>
                      Next page
                    </Button>
                    <span className="text-sm text-slate-600">
                      Page {currentPage} of {numPages}
                    </span>
                  </div>
                  <div className="flex items-center gap-2">
                    <Button onClick={handleZoomOut} variant="secondary" disabled={scale <= 0.5}>
                      Zoom out
                    </Button>
                    <span className="text-sm text-slate-600">{Math.round(scale * 100)}%</span>
                    <Button onClick={handleZoomIn} variant="secondary" disabled={scale >= 3}>
                      Zoom in
                    </Button>
                  </div>
                </div>
              </div>
            </CardContent>
          </Card>
        </div>
      )}
    </div>
  );
}
