"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { loadPDF, renderPageToCanvas, type PDFLoadResult } from "@/lib/pdf";

interface PDFViewerProps {
  acceptedFileTypes?: string[];
}

export function PDFViewer({ acceptedFileTypes = ["application/pdf"] }: PDFViewerProps) {
  const [file, setFile] = useState<File | null>(null);
  const [pdfResult, setPdfResult] = useState<PDFLoadResult | null>(null);
  const [currentPage, setCurrentPage] = useState(1);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [scale, setScale] = useState(1);

  const canvasRef = useRef<HTMLCanvasElement>(null);
  const numPages = pdfResult?.numPages ?? 0;

  const handleFileSelect = useCallback(
    async (event: React.ChangeEvent<HTMLInputElement>) => {
      const selectedFile = event.target.files?.[0];
      if (!selectedFile) return;

      if (!acceptedFileTypes.includes(selectedFile.type)) {
        setError("Please select a valid PDF file.");
        setPdfResult(null);
        setCurrentPage(1);
        return;
      }

      setFile(selectedFile);
      setError(null);
      setLoading(true);
      setCurrentPage(1);
      setPdfResult(null);

      try {
        const result = await loadPDF(selectedFile);
        setPdfResult(result);
      } catch (err) {
        setError(err instanceof Error ? err.message : "Failed to load PDF");
      } finally {
        setLoading(false);
      }
    },
    [acceptedFileTypes]
  );

  useEffect(() => {
    const document = pdfResult?.document;
    const canvas = canvasRef.current;
    if (!document || !canvas || currentPage < 1 || currentPage > numPages) {
      return;
    }

    let cancelled = false;

    (async () => {
      try {
        const page = await document.getPage(currentPage);
        await renderPageToCanvas(page, canvas, scale);
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : "Failed to render page");
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [pdfResult, currentPage, numPages, scale]);

  const handlePrevPage = useCallback(() => {
    setCurrentPage((prev) => (prev > 1 ? prev - 1 : prev));
  }, []);

  const handleNextPage = useCallback(() => {
    setCurrentPage((prev) => (prev < numPages ? prev + 1 : prev));
  }, [numPages]);

  const handleZoomIn = useCallback(() => {
    setScale((s) => Math.min(s + 0.25, 3));
  }, []);

  const handleZoomOut = useCallback(() => {
    setScale((s) => Math.max(s - 0.25, 0.5));
  }, []);

  const resetFile = useCallback(() => {
    setFile(null);
    setPdfResult(null);
    setCurrentPage(1);
    setError(null);
    if (canvasRef.current) {
      const ctx = canvasRef.current.getContext("2d");
      if (ctx) {
        ctx.clearRect(0, 0, canvasRef.current.width, canvasRef.current.height);
      }
      canvasRef.current.width = 0;
      canvasRef.current.height = 0;
    }
  }, []);

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
          <span className="animate-spin rounded-full h-8 w-8 border-b-2 border-slate-950"></span>
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
          {file && (
            <p className="mt-2 text-sm text-slate-500">{file.name}</p>
          )}
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
                    <Button onClick={handleZoomOut} variant="secondary">
                      Zoom out
                    </Button>
                    <span className="text-sm text-slate-600">{Math.round(scale * 100)}%</span>
                    <Button onClick={handleZoomIn} variant="secondary">
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
