"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import type { PageViewport, PDFDocumentProxy } from "pdfjs-dist";
import { bboxToViewportRect } from "@/lib/pdf/coordinates";
import {
  loadPDF,
  extractDocumentText,
  reconstructDocument,
  parseDocumentCandidates,
  type ExtractionResult,
  type ExtractedToken,
  type TextLine,
  type CandidateTransactionRow,
  type ParsedCandidate,
} from "@/lib/pdf";

type ViewMode =
  | "tokens"
  | "lines"
  | "tables"
  | "candidates"
  | "parsed"
  | "unmatched";

const VIEW_MODES: { value: ViewMode; label: string }[] = [
  { value: "tokens", label: "Tokens" },
  { value: "lines", label: "Lines" },
  { value: "tables", label: "Tables" },
  { value: "candidates", label: "Candidates" },
  { value: "parsed", label: "Parsed" },
  { value: "unmatched", label: "Unmatched" },
];

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
  const [reconstruction, setReconstruction] = useState<
    ReturnType<typeof reconstructDocument> | null
  >(null);
  const [currentPage, setCurrentPage] = useState(1);
  const [viewMode, setViewMode] = useState<ViewMode>("tokens");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [scale, setScale] = useState(1);
  const [renderedPage, setRenderedPage] = useState<{
    document: PDFDocumentProxy;
    page: number;
    scale: number;
    viewport: PageViewport;
  } | null>(null);
  const [selectedToken, setSelectedToken] = useState<ExtractedToken | null>(null);
  const [selectedLine, setSelectedLine] = useState<TextLine | null>(null);
  const [selectedCandidate, setSelectedCandidate] = useState<
    CandidateTransactionRow | null
  >(null);
  const [selectedParsedCandidate, setSelectedParsedCandidate] = useState<
    ParsedCandidate | null
  >(null);

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
        setReconstruction(null);
        setCurrentPage(1);
        setSelectedToken(null);
        setSelectedLine(null);
        setSelectedCandidate(null);
        setViewMode("tokens");
        return;
      }

      setFile(selectedFile);
      setError(null);
      setLoading(true);
      setCurrentPage(1);
      setViewMode("tokens");
      setPdfResult(null);
      setExtraction(null);
      setReconstruction(null);
      setSelectedToken(null);
      setSelectedLine(null);
      setSelectedCandidate(null);

      try {
        const result = await loadPDF(selectedFile);
        setPdfResult(result);

        const extractionResult = await extractDocumentText(result.document);
        setExtraction(extractionResult);

        const reconstructionResult = reconstructDocument(extractionResult);
        setReconstruction(reconstructionResult);
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
        if (!cancelled) {
          setRenderedPage({ document, page: currentPage, scale, viewport });
        }
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

  // Compute parsed transactions during render to avoid setState-in-effect issues
  const parsed = reconstruction
    ? parseDocumentCandidates(reconstruction, {})
    : null;

  const handlePrevPage = useCallback(() => {
    setCurrentPage((prev) => (prev > 1 ? prev - 1 : prev));
    setSelectedToken(null);
    setSelectedLine(null);
    setSelectedCandidate(null);
    setSelectedParsedCandidate(null);
  }, []);

  const handleNextPage = useCallback(() => {
    setCurrentPage((prev) => (prev < numPages ? prev + 1 : prev));
    setSelectedToken(null);
    setSelectedLine(null);
    setSelectedCandidate(null);
    setSelectedParsedCandidate(null);
  }, [numPages]);

  const handleZoomIn = useCallback(() => {
    setScale((s) => Math.min(s + 0.25, 3));
  }, []);

  const handleZoomOut = useCallback(() => {
    setScale((s) => Math.max(s - 0.25, 0.5));
  }, []);

  const handleSelectToken = useCallback((token: ExtractedToken | null) => {
    setSelectedToken(token);
    setSelectedLine(null);
    setSelectedCandidate(null);
    setViewMode("tokens");
  }, []);

  const handleSelectLine = useCallback((line: TextLine) => {
    setSelectedLine(line);
    setSelectedToken(null);
    setSelectedCandidate(null);
    setViewMode("lines");
  }, []);

  const handleSelectCandidate = useCallback((candidate: CandidateTransactionRow) => {
    setSelectedCandidate(candidate);
    setSelectedToken(null);
    setSelectedLine(null);
    setSelectedParsedCandidate(null);
    setViewMode("candidates");
  }, []);

  const handleSelectParsedCandidate = useCallback((parsedCandidate: ParsedCandidate) => {
    setSelectedParsedCandidate(parsedCandidate);
    setSelectedToken(null);
    setSelectedLine(null);
    setSelectedCandidate(null);
    setViewMode("parsed");
  }, []);

  const extractedPage = extraction?.pages.find((p) => p.page === currentPage);
  const pageTokens = extractedPage?.tokens ?? [];
  const geometryDiagnostics = extractedPage?.geometryDiagnostics ?? [];
  const pageReconstruction = reconstruction?.pages.find(
    (p) => p.page === currentPage
  );
  const pageLines = pageReconstruction?.lines ?? [];
  const pageTables = pageReconstruction?.tables ?? [];
  const pageCandidates = pageReconstruction?.candidates ?? [];
  const pageParsedCandidates = parsed?.candidates.filter(
    (c) => c.page === currentPage
  ) ?? [];
  const pagesWithoutText = extraction?.pages.filter((p) => p.tokens.length === 0) ?? [];

  const resetFile = useCallback(() => {
    setFile(null);
    setPdfResult(null);
    setRenderedPage(null);
    setExtraction(null);
    setReconstruction(null);
    setCurrentPage(1);
    setViewMode("tokens");
    setError(null);
    setSelectedToken(null);
    setSelectedLine(null);
    setSelectedCandidate(null);
    setSelectedParsedCandidate(null);
    if (canvasRef.current) {
      const ctx = canvasRef.current.getContext("2d");
      if (ctx) {
        ctx.clearRect(0, 0, canvasRef.current.width, canvasRef.current.height);
      }
      canvasRef.current.width = 0;
      canvasRef.current.height = 0;
    }
  }, []);

  const selection = selectedToken ?? selectedLine ?? selectedCandidate;
  const highlightClass = selectedToken
    ? "border-red-500 bg-red-500/20"
    : selectedLine
      ? "border-blue-500 bg-blue-500/20"
      : "border-green-500 bg-green-500/20";
  let highlightStyle;
  if (
    renderedPage &&
    renderedPage.document === pdfResult?.document &&
    renderedPage.page === currentPage &&
    renderedPage.scale === scale &&
    selection?.page === currentPage
  ) {
    const { viewport } = renderedPage;
    const rect = bboxToViewportRect(selection.bbox, viewport);
    // Apply viewport pixels relative to the intrinsic canvas size so the
    // highlight follows the canvas when its CSS width is constrained.
    const width = Math.ceil(viewport.width);
    const height = Math.ceil(viewport.height);
    highlightStyle = {
      left: `${(rect.left / width) * 100}%`,
      top: `${(rect.top / height) * 100}%`,
      width: `${(rect.width / width) * 100}%`,
      height: `${(rect.height / height) * 100}%`,
    };
  }

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
                <div className="bg-slate-100">
                  <div className="relative inline-block max-w-full align-top">
                    <canvas ref={canvasRef} className="block h-auto max-w-full" />
                    {highlightStyle && (
                      <div
                        aria-hidden="true"
                        data-testid="pdf-source-highlight"
                        className={`pointer-events-none absolute border-2 ${highlightClass}`}
                        style={highlightStyle}
                      />
                    )}
                  </div>
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
                    <span className="text-sm text-slate-600">
                      {Math.round(scale * 100)}%
                    </span>
                    <Button onClick={handleZoomIn} variant="secondary">
                      Zoom in
                    </Button>
                  </div>
                </div>
              </CardContent>
            </Card>
          </div>

          <div className="lg:col-span-4 flex flex-col gap-4">
            {/* Mode selector */}
            <Card>
              <CardHeader>
                <CardTitle>View Mode</CardTitle>
              </CardHeader>
              <CardContent className="p-2">
                <div className="flex gap-1">
                  {VIEW_MODES.map(({ value, label }) => (
                    <Button
                      key={value}
                      onClick={() => setViewMode(value)}
                      variant={viewMode === value ? "primary" : "secondary"}
                      className="flex-1 text-xs"
                    >
                      {label}
                    </Button>
                  ))}
                </div>
              </CardContent>
            </Card>

            {/* Extraction Summary */}
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
                  {reconstruction && (
                    <>
                      <div className="flex justify-between text-sm border-t pt-2">
                        <span className="text-slate-600">Reconstructed lines</span>
                        <span className="font-medium">{reconstruction.totalLines}</span>
                      </div>
                      <div className="flex justify-between text-sm">
                        <span className="text-slate-600">Detected tables</span>
                        <span className="font-medium">{reconstruction.totalTables}</span>
                      </div>
                      <div className="flex justify-between text-sm">
                        <span className="text-slate-600">Candidate rows</span>
                        <span className="font-medium">{reconstruction.totalCandidates}</span>
                      </div>
                      <div className={`flex justify-between text-sm ${reconstruction.hasUnmatchedContent ? "text-amber-700" : "text-slate-600"}`}>
                        <span>Has unmatched content</span>
                        <span className="font-medium">
                          {reconstruction.hasUnmatchedContent ? "Yes" : "No"}
                        </span>
                      </div>
                    </>
                  )}
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

            {/* Content list based on view mode */}
            {viewMode === "tokens" && (
              <Card>
                <CardHeader>
                  <CardTitle>Tokens on page {currentPage}</CardTitle>
                </CardHeader>
                <CardContent className="p-2 max-h-96 overflow-y-auto">
                  {geometryDiagnostics.length > 0 && (
                    <p className="p-2 text-xs text-amber-700">
                      Text geometry issues on this page:{" "}
                      {geometryDiagnostics.length}
                    </p>
                  )}
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
            )}

            {viewMode === "lines" && pageReconstruction && (
              <Card>
                <CardHeader>
                  <CardTitle>Lines on page {currentPage}</CardTitle>
                </CardHeader>
                <CardContent className="p-2 max-h-96 overflow-y-auto">
                  {pageLines.length === 0 ? (
                    <p className="text-sm text-slate-500 text-center py-4">
                      No reconstructed lines on this page
                    </p>
                  ) : (
                    <ul className="divide-y divide-slate-100">
                      {pageLines.map((line) => (
                        <li
                          key={line.lineId}
                          onClick={() => handleSelectLine(line)}
                          className={`cursor-pointer hover:bg-blue-50 p-2 rounded transition-colors group ${
                            selectedLine?.lineId === line.lineId
                              ? "bg-blue-100 border border-blue-500"
                              : ""
                          }`}
                        >
                          <div className="flex justify-between text-xs">
                            <span className="font-mono text-slate-900 truncate">
                              {line.str}
                            </span>
                            <Badge className="text-[10px]">
                              {line.tokenCount}t
                            </Badge>
                          </div>
                          <div className="text-[10px] text-slate-500 mt-0.5">
                            [{line.bbox.map((v) => v.toFixed(3)).join(", ")}]
                          </div>
                          {line.diagnostics.length > 0 && (
                            <div className="text-[10px] text-amber-600 mt-0.5">
                              {line.diagnostics.join(", ")}
                            </div>
                          )}
                        </li>
                      ))}
                    </ul>
                  )}
                </CardContent>
              </Card>
            )}

            {viewMode === "tables" && pageReconstruction && (
              <Card>
                <CardHeader>
                  <CardTitle>Tables on page {currentPage}</CardTitle>
                </CardHeader>
                <CardContent className="p-2 max-h-96 overflow-y-auto">
                  {pageTables.length === 0 ? (
                    <p className="text-sm text-slate-500 text-center py-4">
                      No tables detected on this page
                    </p>
                  ) : (
                    <ul className="divide-y divide-slate-100">
                      {pageTables.map((table) => (
                        <li key={table.tableId} className="p-2 rounded bg-slate-50">
                          <div className="flex justify-between text-xs">
                            <span className="font-mono text-slate-900 truncate">
                              {table.lineCount} lines
                            </span>
                            <Badge className="text-[10px]">
                              {table.columns.length} cols
                            </Badge>
                          </div>
                          <div className="text-[10px] text-slate-500 mt-0.5">
                            [{table.bbox.map((v) => v.toFixed(3)).join(", ")}]
                          </div>
                          <div className="text-[10px] text-indigo-600 mt-0.5">
                            cols: {table.columns.map((c) => c.toFixed(3)).join(", ")}
                          </div>
                          {table.diagnostics.length > 0 && (
                            <div className="text-[10px] text-amber-600 mt-0.5">
                              {table.diagnostics.join(", ")}
                            </div>
                          )}
                        </li>
                      ))}
                    </ul>
                  )}
                </CardContent>
              </Card>
            )}

            {viewMode === "candidates" && pageReconstruction && (
              <Card>
                <CardHeader>
                  <CardTitle>Candidates on page {currentPage}</CardTitle>
                </CardHeader>
                <CardContent className="p-2 max-h-96 overflow-y-auto">
                  {pageCandidates.length === 0 ? (
                    <p className="text-sm text-slate-500 text-center py-4">
                      No candidate rows on this page
                    </p>
                  ) : (
                    <ul className="divide-y divide-slate-100">
                      {pageCandidates.map((candidate) => (
                        <li
                          key={candidate.rowId}
                          onClick={() => handleSelectCandidate(candidate)}
                          className={`cursor-pointer hover:bg-green-50 p-2 rounded transition-colors group ${
                            selectedCandidate?.rowId === candidate.rowId
                              ? "bg-green-100 border border-green-500"
                              : ""
                          }`}
                        >
                          <div className="flex justify-between text-xs">
                            <span className="font-mono text-slate-900 truncate">
                              {candidate.str}
                            </span>
                            <Badge className="text-[10px]">
                              {candidate.multiline ? "multi" : "single"}
                            </Badge>
                          </div>
                          <div className="text-[10px] text-slate-500 mt-0.5">
                            [{candidate.bbox.map((v) => v.toFixed(3)).join(", ")}]
                          </div>
                          <div className="flex gap-1 mt-1">
                            {candidate.hasDateLikeField && (
                              <span className="text-[10px] text-green-600 font-mono">
                                📅
                              </span>
                            )}
                            {candidate.hasAmountLikeField && (
                              <span className="text-[10px] text-green-600 font-mono">
                                💰
                              </span>
                            )}
                          </div>
                          {candidate.diagnostics.length > 0 && (
                            <div className="text-[10px] text-amber-600 mt-0.5">
                              {candidate.diagnostics.join(", ")}
                            </div>
                          )}
                        </li>
                      ))}
                    </ul>
                  )}
                </CardContent>
              </Card>
            )}

            {viewMode === "parsed" && parsed && (
              <Card>
                <CardHeader>
                  <CardTitle>Parsed Transactions on page {currentPage}</CardTitle>
                </CardHeader>
                <CardContent className="p-2 max-h-96 overflow-y-auto">
                  {pageParsedCandidates.length === 0 ? (
                    <p className="text-sm text-slate-500 text-center py-4">
                      No parsed transactions on this page
                    </p>
                  ) : (
                    <ul className="divide-y divide-slate-100">
                      {pageParsedCandidates.map((parsedCandidate) => (
                        <li
                          key={parsedCandidate.rowId}
                          onClick={() => handleSelectParsedCandidate(parsedCandidate)}
                          className={`cursor-pointer hover:bg-slate-50 p-2 rounded transition-colors group ${
                            selectedParsedCandidate?.rowId === parsedCandidate.rowId
                              ? "bg-slate-100 border border-slate-500"
                              : ""
                          }`}
                        >
                          <div className="flex justify-between text-xs">
                            <span className="font-mono text-slate-900 truncate">
                              {parsedCandidate.str}
                            </span>
                            <Badge
                              className={`text-[10px] capitalize ${
                                parsedCandidate.status === "successfully_parsed"
                                  ? "border-slate-300 bg-slate-100 text-slate-700"
                                  : parsedCandidate.status === "needs_review"
                                    ? "border-amber-200 bg-amber-50 text-amber-700"
                                    : parsedCandidate.status === "partially_parsed"
                                      ? "border-slate-300 bg-slate-100 text-slate-700"
                                      : "border-red-200 bg-red-50 text-red-700"
                              }`}
                            >
                              {parsedCandidate.status.replace(/_/g, " ")}
                            </Badge>
                          </div>
                          <div className="text-[10px] text-slate-500 mt-0.5">
                            [{parsedCandidate.bbox.map((v) => v.toFixed(3)).join(", ")}]
                          </div>
                          {parsedCandidate.transaction && (
                            <div className="flex gap-1 mt-1">
                              <span className="text-[10px] text-slate-600 font-mono">
                                {parsedCandidate.transaction.transactionDate ?? "—"}
                              </span>
                              <span className="text-[10px] text-slate-600 font-mono">
                                {parsedCandidate.transaction.billedAmount.amountMinor}
                                {parsedCandidate.transaction.billedAmount.currency}
                              </span>
                              <span className="text-[10px] text-slate-600 font-mono capitalize">
                                {parsedCandidate.transaction.transactionType}
                              </span>
                            </div>
                          )}
                          {parsedCandidate.flags.length > 0 && (
                            <div className="text-[10px] text-amber-600 mt-0.5">
                              {parsedCandidate.flags.join(", ")}
                            </div>
                          )}
                        </li>
                      ))}
                    </ul>
                  )}
                  <div className="mt-2 pt-2 border-t border-slate-200">
                    <div className="flex justify-between text-sm mb-1">
                      <span className="text-slate-600">Diagnostics</span>
                      <span className="font-medium">
                        {parsed.diagnostics.filter((d) => d.startsWith(`p${currentPage}:`))
                          .length}
                      </span>
                    </div>
                  </div>
                </CardContent>
              </Card>
            )}

            {viewMode === "unmatched" && pageReconstruction && (
              <Card>
                <CardHeader>
                  <CardTitle>Unmatched on page {currentPage}</CardTitle>
                </CardHeader>
                <CardContent className="p-2 max-h-96 overflow-y-auto">
                  <div className="space-y-2">
                    <div className="flex justify-between text-sm mb-2">
                      <span className="text-slate-600">Unmatched lines</span>
                      <span className="font-medium">
                        {pageReconstruction.unmatchedLineIds.length}
                      </span>
                    </div>
                    <ul className="divide-y divide-slate-100">
                      {pageReconstruction.unmatchedLineIds.map((lineId) => {
                        const line = pageLines.find((l) => l.lineId === lineId);
                        if (!line) return null;
                        return (
                          <li
                            key={lineId}
                            onClick={() => handleSelectLine(line)}
                            className="cursor-pointer hover:bg-amber-50 p-2 rounded transition-colors group"
                          >
                            <div className="flex justify-between text-xs">
                              <span className="font-mono text-slate-900 truncate">
                                {line.str}
                              </span>
                              <Badge className="text-[10px]">
                                unmatched
                              </Badge>
                            </div>
                            <div className="text-[10px] text-slate-500 mt-0.5">
                              [{line.bbox.map((v) => v.toFixed(3)).join(", ")}]
                            </div>
                          </li>
                        );
                      })}
                    </ul>
                    {pageReconstruction.unmatchedTokenIds.length > 0 && (
                      <div className="mt-4 pt-2 border-t border-slate-200">
                        <div className="flex justify-between text-sm mb-1">
                          <span className="text-slate-600">Unmatched tokens</span>
                          <span className="font-medium">
                            {pageReconstruction.unmatchedTokenIds.length}
                          </span>
                        </div>
                        <ul className="divide-y divide-slate-100">
                          {pageReconstruction.unmatchedTokenIds.map((tokenId) => {
                            const token = pageTokens.find((t) => t.tokenId === tokenId);
                            if (!token) return null;
                            return (
                              <li
                                key={tokenId}
                                onClick={() => handleSelectToken(token)}
                                className="cursor-pointer hover:bg-amber-50 p-2 rounded transition-colors group"
                              >
                                <div className="flex justify-between text-xs">
                                  <span className="font-mono text-slate-900 truncate">
                                    {token.str}
                                  </span>
                                  <Badge className="text-[10px]">
                                    unmatched
                                  </Badge>
                                </div>
                                <div className="text-[10px] text-slate-500 mt-0.5">
                                  [{token.bbox.map((v) => v.toFixed(3)).join(", ")}]
                                </div>
                              </li>
                            );
                          })}
                        </ul>
                      </div>
                    )}
                    {pageReconstruction.unmatchedLineIds.length === 0 &&
                      pageReconstruction.unmatchedTokenIds.length === 0 && (
                      <p className="text-sm text-slate-500 text-center py-4">
                        No unmatched content on this page
                      </p>
                    )}
                  </div>
                </CardContent>
              </Card>
            )}

            {/* Selected item detail panel */}
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

            {selectedLine && (
              <Card>
                <CardHeader>
                  <CardTitle>Selected Line</CardTitle>
                </CardHeader>
                <CardContent>
                  <div className="space-y-2">
                    <div className="flex justify-between text-sm">
                      <span className="text-slate-600">Text</span>
                      <span className="font-mono">{selectedLine.str}</span>
                    </div>
                    <div className="flex justify-between text-sm">
                      <span className="text-slate-600">Page</span>
                      <span className="font-medium">{selectedLine.page}</span>
                    </div>
                    <div className="flex justify-between text-sm">
                      <span className="text-slate-600">Line ID</span>
                      <span className="font-mono text-xs">{selectedLine.lineId}</span>
                    </div>
                    <div className="flex justify-between text-sm">
                      <span className="text-slate-600">Tokens</span>
                      <span className="font-medium">{selectedLine.tokenCount}</span>
                    </div>
                    <div className="flex justify-between text-sm">
                      <span className="text-slate-600">BBox (normalized)</span>
                      <span className="font-mono text-xs">
                        [{selectedLine.bbox.map((v) => v.toFixed(3)).join(", ")}]
                      </span>
                    </div>
                    {selectedLine.diagnostics.length > 0 && (
                      <div className="flex justify-between text-sm">
                        <span className="text-slate-600">Diagnostics</span>
                        <span className="font-mono text-xs text-amber-600">
                          {selectedLine.diagnostics.join(", ")}
                        </span>
                      </div>
                    )}
                    <Button
                      onClick={() => setSelectedLine(null)}
                      variant="secondary"
                    >
                      Clear selection
                    </Button>
                  </div>
                </CardContent>
              </Card>
            )}

            {selectedCandidate && (
              <Card>
                <CardHeader>
                  <CardTitle>Selected Candidate Row</CardTitle>
                </CardHeader>
                <CardContent>
                  <div className="space-y-2">
                    <div className="flex justify-between text-sm">
                      <span className="text-slate-600">Text</span>
                      <span className="font-mono">{selectedCandidate.str}</span>
                    </div>
                    <div className="flex justify-between text-sm">
                      <span className="text-slate-600">Page</span>
                      <span className="font-medium">{selectedCandidate.page}</span>
                    </div>
                    <div className="flex justify-between text-sm">
                      <span className="text-slate-600">Row ID</span>
                      <span className="font-mono text-xs">{selectedCandidate.rowId}</span>
                    </div>
                    <div className="flex justify-between text-sm">
                      <span className="text-slate-600">Lines</span>
                      <span className="font-medium">
                        {selectedCandidate.lineIds.length}
                      </span>
                    </div>
                    <div className="flex justify-between text-sm">
                      <span className="text-slate-600">Multiline</span>
                      <span className="font-medium">
                        {selectedCandidate.multiline ? "Yes" : "No"}
                      </span>
                    </div>
                    <div className="flex justify-between text-sm">
                      <span className="text-slate-600">Date-like field</span>
                      <span className="font-medium">
                        {selectedCandidate.hasDateLikeField ? "Yes" : "No"}
                      </span>
                    </div>
                    <div className="flex justify-between text-sm">
                      <span className="text-slate-600">Amount-like field</span>
                      <span className="font-medium">
                        {selectedCandidate.hasAmountLikeField ? "Yes" : "No"}
                      </span>
                    </div>
                    <div className="flex justify-between text-sm">
                      <span className="text-slate-600">BBox (normalized)</span>
                      <span className="font-mono text-xs">
                        [{selectedCandidate.bbox.map((v) => v.toFixed(3)).join(", ")}]
                      </span>
                    </div>
                    {selectedCandidate.diagnostics.length > 0 && (
                      <div className="flex justify-between text-sm">
                        <span className="text-slate-600">Diagnostics</span>
                        <span className="font-mono text-xs text-amber-600">
                          {selectedCandidate.diagnostics.join(", ")}
                        </span>
                      </div>
                    )}
              <Button
                onClick={() => setSelectedCandidate(null)}
                variant="secondary"
              >
                Clear selection
              </Button>
            </div>
          </CardContent>
        </Card>
      )}

      {selectedParsedCandidate && (
        <Card>
          <CardHeader>
            <CardTitle>Selected Parsed Transaction</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="space-y-2">
              <div className="flex justify-between text-sm">
                <span className="text-slate-600">Text</span>
                <span className="font-mono truncate">{selectedParsedCandidate.str}</span>
              </div>
              <div className="flex justify-between text-sm">
                <span className="text-slate-600">Page</span>
                <span className="font-medium">{selectedParsedCandidate.page}</span>
              </div>
              <div className="flex justify-between text-sm">
                <span className="text-slate-600">Row ID</span>
                <span className="font-mono text-xs">{selectedParsedCandidate.rowId}</span>
              </div>
              <div className="flex justify-between text-sm">
                <span className="text-slate-600">Status</span>
                <Badge
                  className={`text-[10px] capitalize ${
                    selectedParsedCandidate.status === "successfully_parsed"
                      ? "border-slate-300 bg-slate-100 text-slate-700"
                      : selectedParsedCandidate.status === "needs_review"
                        ? "border-amber-200 bg-amber-50 text-amber-700"
                        : selectedParsedCandidate.status === "partially_parsed"
                          ? "border-slate-300 bg-slate-100 text-slate-700"
                          : "border-red-200 bg-red-50 text-red-700"
                  }`}
                >
                  {selectedParsedCandidate.status.replace(/_/g, " ")}
                </Badge>
              </div>
              {selectedParsedCandidate.transaction && (
                <>
                  <div className="flex justify-between text-sm">
                    <span className="text-slate-600">Transaction Date</span>
                    <span className="font-medium">
                      {selectedParsedCandidate.transaction.transactionDate ?? "—"}
                    </span>
                  </div>
                  <div className="flex justify-between text-sm">
                    <span className="text-slate-600">Posting Date</span>
                    <span className="font-medium">
                      {selectedParsedCandidate.transaction.postingDate ?? "—"}
                    </span>
                  </div>
                  <div className="flex justify-between text-sm">
                    <span className="text-slate-600">Raw Description</span>
                    <span className="font-mono truncate">
                      {selectedParsedCandidate.transaction.rawDescription}
                    </span>
                  </div>
                  <div className="flex justify-between text-sm">
                    <span className="text-slate-600">Normalized Merchant</span>
                    <span className="font-mono truncate">
                      {selectedParsedCandidate.transaction.normalizedMerchant ?? "—"}
                    </span>
                  </div>
                  <div className="flex justify-between text-sm">
                    <span className="text-slate-600">Transaction Type</span>
                    <span className="font-medium capitalize">
                      {selectedParsedCandidate.transaction.transactionType}
                    </span>
                  </div>
                  <div className="flex justify-between text-sm">
                    <span className="text-slate-600">Billed Amount</span>
                    <span className="font-medium">
                      {selectedParsedCandidate.transaction.billedAmount.amountMinor}
                      {selectedParsedCandidate.transaction.billedAmount.currency}
                    </span>
                  </div>
                  <div className="flex justify-between text-sm">
                    <span className="text-slate-600">Source</span>
                    <span className="font-medium">
                      {selectedParsedCandidate.transaction.source}
                    </span>
                  </div>
                  <div className="flex justify-between text-sm">
                    <span className="text-slate-600">Review Status</span>
                    <span className="font-medium capitalize">
                      {selectedParsedCandidate.transaction.reviewStatus}
                    </span>
                  </div>
                  <div className="flex justify-between text-sm">
                    <span className="text-slate-600">Temporary ID</span>
                    <span className="font-mono text-xs">
                      {selectedParsedCandidate.transaction.temporaryId}
                    </span>
                  </div>
                  {selectedParsedCandidate.transaction.sourceAnchor && (
                    <div className="flex justify-between text-sm">
                      <span className="text-slate-600">Source Anchor</span>
                      <span className="font-mono text-xs">
                        p{selectedParsedCandidate.transaction.sourceAnchor.page}
                      </span>
                    </div>
                  )}
                </>
              )}
              {selectedParsedCandidate.flags.length > 0 && (
                <div className="flex justify-between text-sm">
                  <span className="text-slate-600">Flags</span>
                  <span className="font-mono text-xs text-amber-600">
                    {selectedParsedCandidate.flags.join(", ")}
                  </span>
                </div>
              )}
              {selectedParsedCandidate.diagnostics.length > 0 && (
                <div className="flex justify-between text-sm">
                  <span className="text-slate-600">Diagnostics</span>
                  <span className="font-mono text-xs text-amber-600">
                    {selectedParsedCandidate.diagnostics.join(", ")}
                  </span>
                </div>
              )}
              <div className="flex justify-between text-sm">
                <span className="text-slate-600">Raw Fields</span>
                <Button
                  onClick={() => {
                    alert(JSON.stringify(selectedParsedCandidate.rawFields, null, 2));
                  }}
                  variant="secondary"
                  className="text-xs text-slate-600 hover:text-slate-900"
                >
                  inspect
                </Button>
              </div>
              <Button
                onClick={() => setSelectedParsedCandidate(null)}
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
