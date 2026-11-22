"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import type { PDFDocumentProxy } from "pdfjs-dist";
import {
  loadPDF,
  extractDocumentText,
  type ExtractionResult,
  type ExtractedToken,
} from "@/lib/pdf";

interface TextExtractionDebugProps {
  acceptedFileTypes?: string[];
}

export function TextExtractionDebug({
  acceptedFileTypes = ["application/pdf"],
}: TextExtractionDebugProps) {
  const [file, setFile] = useState<File | null>(null);
  const [pdfResult, setPdfResult] = useState<
    { document: PDFDocumentProxy; numPages: number } | null
  >(null);
  const [extraction, setExtraction] = useState<ExtractionResult | null>(null);
  const [currentPage, setCurrentPage] = useState(1);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [scale, setScale] = useState(1);
  const [extracting, setExtracting] = useState(false);
  const [selectedToken, setSelectedToken] = useState<ExtractedToken | null>(null);

  const canvasRef = useRef<HTMLCanvasElement>(null);
  const numPages = pdfResult?.numPages ?? 0;

  const handleFileSelect = useCallback(
    async (event: React.ChangeEvent<HTMLInputElement>) => {
      const selectedFile = event.target.files?.[0];
      if (!selectedFile) return;

      if (!acceptedFileTypes.includes(selectedFile.type)) {
        setError("Please select a valid PDF file.");
        setPdfResult(null);
        setExtraction(null);
        setCurrentPage(1);
        setSelectedToken(null);
        return;
      }

      setFile(selectedFile);
      setError(null);
      setLoading(true);
      setExtracting(false);
      setCurrentPage(1);
      setPdfResult(null);
      setExtraction(null);
      setSelectedToken(null);

      try {
        const result = await loadPDF(selectedFile);
        setPdfResult(result);

        setExtracting(true);
        const extractionResult = await extractDocumentText(result.document);
        setExtraction(extractionResult);
      } catch (err) {
        setError(err instanceof Error ? err.message : "Failed to load PDF");
      } finally {
        setLoading(false);
        setExtracting(false);
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
        const viewport = page.getViewport({ scale });
        canvas.width = Math.ceil(viewport.width);
        canvas.height = Math.ceil(viewport.height);

        const context = canvas.getContext("2d");
        if (!context) {
          throw new Error("Could not get 2D rendering context from canvas");
        }

        await page
          .render({
            canvasContext: context,
            viewport,
          })
          .promise;
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
    setSelectedToken(null);
  }, []);

  const handleNextPage = useCallback(() => {
    setCurrentPage((prev) => (prev < numPages ? prev + 1 : prev));
    setSelectedToken(null);
  }, [numPages]);

  const handleZoomIn = useCallback(() => {
    setScale((s) => Math.min(s + 0.25, 3));
  }, []);

  const handleZoomOut = useCallback(() => {
    setScale((s) => Math.max(s - 0.25, 0.5));
  }, []);

  const handleSelectToken = useCallback((token: ExtractedToken | null) => {
    setSelectedToken(token);
  }, []);

  const pageTokens = extraction?.pages.find((p) => p.page === currentPage)?.tokens ?? [];
  const pagesWithoutText = extraction?.pages.filter((p) => p.tokens.length === 0) ?? [];

  const resetFile = useCallback(() => {
    setFile(null);
    setPdfResult(null);
    setExtraction(null);
    setCurrentPage(1);
    setError(null);
    setSelectedToken(null);
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

  if (extracting && pdfResult && !extraction) {
    return (
      <Card className="mt-8">
        <CardContent className="flex flex-col items-center justify-center py-12">
          <span className="animate-spin rounded-full h-8 w-8 border-b-2 border-slate-950"></span>
          <p className="mt-4 text-sm text-slate-600">Extracting text…</p>
        </CardContent>
      </Card>
    );
  }

  return (
    <div className="mt-8">
      <Card>
        <CardHeader>
          <CardTitle>PDF Extraction Debug</CardTitle>
        </CardHeader>
        <CardContent>
          <input
            accept={acceptedFileTypes.join(",")}
            id="pdf-debug-file-input"
            onChange={handleFileSelect}
            type="file"
            className="sr-only"
          />
          <label htmlFor="pdf-debug-file-input" className="button">
            Select a PDF file
          </label>
          {file && (
            <p className="mt-2 text-sm text-slate-500">{file.name}</p>
          )}
        </CardContent>
      </Card>

      {pdfResult && numPages > 0 && (
        <div className="mt-8 grid grid-cols-1 lg:grid-cols-12 gap-8">
          <div className="lg:col-span-8">
            <Card>
              <CardHeader>
                <CardTitle>Document</CardTitle>
              </CardHeader>
              <CardContent className="p-0">
                <div className="relative w-full max-w-full aspect-auto bg-slate-100">
                  <canvas ref={canvasRef} className="block max-w-full h-auto" />
                  {selectedToken && (
                    <div
                      className="absolute pointer-events-none border-2 border-red-500 bg-red-500/20 shadow-[0_0_0_1px_rgba(239,68,68,0.4)]"
                      style={{
                        left: `${selectedToken.bbox[0] * 100}%`,
                        top: `${(1 - selectedToken.bbox[3]) * 100}%`,
                        width: `${(selectedToken.bbox[2] - selectedToken.bbox[0]) * 100}%`,
                        height: `${(selectedToken.bbox[3] - selectedToken.bbox[1]) * 100}%`,
                      }}
                    />
                  )}
                </div>
                <div className="flex items-center justify-between px-4 py-2 border-t border-slate-200 bg-slate-50">
                  <div className="flex items-center gap-2">
                    <Button
                      onClick={handlePrevPage}
                      disabled={currentPage <= 1}
                      variant="secondary"
                    >
                      Previous page
                    </Button>
                    <Button
                      onClick={handleNextPage}
                      disabled={currentPage >= numPages}
                      variant="secondary"
                    >
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
              </CardContent>
            </Card>
          </div>

          <div className="lg:col-span-4 flex flex-col gap-4">
            <Card>
              <CardHeader>
                <CardTitle>Extraction Summary</CardTitle>
              </CardHeader>
              <CardContent>
                <div className="space-y-2">
                  <div className="flex justify-between text-sm">
                    <span className="text-slate-600">Total pages</span>
                    <span className="font-medium">{extraction?.pageCount ?? 0}</span>
                  </div>
                  <div className="flex justify-between text-sm">
                    <span className="text-slate-600">Total tokens</span>
                    <span className="font-medium">{extraction?.totalTokens ?? 0}</span>
                  </div>
                  <div className="flex justify-between text-sm">
                    <span className="text-slate-600">Has extractable text</span>
                    <span className={`font-medium ${extraction?.hasExtractableText ? "text-green-700" : "text-red-700"}`}>
                      {extraction?.hasExtractableText ? "Yes" : "No"}
                    </span>
                  </div>
                  {pagesWithoutText.length > 0 && (
                    <div className="flex justify-between text-sm text-red-700">
                      <span>Pages without text</span>
                      <span className="font-medium">
                        {pagesWithoutText.map((p) => p.page).join(", ")}
                      </span>
                    </div>
                  )}
                </div>
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle>Tokens on page {currentPage}</CardTitle>
              </CardHeader>
              <CardContent className="p-2">
                {pageTokens.length === 0 ? (
                  <p className="text-sm text-slate-500 text-center py-4">
                    No extractable text on this page
                  </p>
                ) : (
                  <ul className="divide-y divide-slate-100">
                    {pageTokens.map((token) => (
                      <li
                        key={token.tokenId}
                        onClick={() => handleSelectToken(token)}
                        className="cursor-pointer hover:bg-slate-50 p-2 rounded transition-colors group"
                      >
                        <div className="flex justify-between text-xs">
                          <span className="font-mono text-slate-900 truncate">
                            {token.str}
                          </span>
                          <Badge className="text-[10px]">
                            p{token.page}
                          </Badge>
                        </div>
                        <div className="text-[10px] text-slate-500 mt-0.5">
                          [{token.bbox.map((v) => v.toFixed(3)).join(", ")}]
                        </div>
                      </li>
                    ))}
                  </ul>
                )}
              </CardContent>
            </Card>

            {selectedToken && (
              <Card>
                <CardHeader>
                  <CardTitle>Selected Token</CardTitle>
                </CardHeader>
                <CardContent>
                  <div className="space-y-2">
                    <div className="flex justify-between text-sm">
                      <span className="text-slate-600">Text</span>
                      <span className="font-mono">{selectedToken.str}</span>
                    </div>
                    <div className="flex justify-between text-sm">
                      <span className="text-slate-600">Page</span>
                      <span className="font-medium">{selectedToken.page}</span>
                    </div>
                    <div className="flex justify-between text-sm">
                      <span className="text-slate-600">Token ID</span>
                      <span className="font-mono text-xs">
                        {selectedToken.tokenId}
                      </span>
                    </div>
                    <div className="flex justify-between text-sm">
                      <span className="text-slate-600">BBox (normalized)</span>
                      <span className="font-mono text-xs">
                        [{selectedToken.bbox.map((v) => v.toFixed(3)).join(", ")}]
                      </span>
                    </div>
                    <div className="flex justify-between text-sm">
                      <span className="text-slate-600">Has EOL</span>
                      <span className="font-medium">
                        {selectedToken.hasEOL ? "Yes" : "No"}
                      </span>
                    </div>
                    <Button
                      onClick={() => handleSelectToken(null)}
                      variant="secondary"
                    >
                      Clear selection
                    </Button>
                  </div>
                </CardContent>
              </Card>
            )}
          </div>
        </div>
      )}

      <Button onClick={resetFile} variant="secondary" className="mt-8">
        Reset
      </Button>
    </div>
  );
}
