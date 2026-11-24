"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import type { PageViewport, PDFDocumentProxy } from "pdfjs-dist";
import { bboxToViewportRect } from "@/lib/pdf/coordinates";
import {
  startPDFLoad,
  destroyPDFDocument,
  startPageRender,
  extractDocumentText,
  reconstructDocument,
  parseDocumentCandidates,
  type ExtractionResult,
  type ExtractedToken,
  type TextLine,
  type CandidateTransactionRow,
  type ParsedCandidate,
  type StatementContext,
} from "@/lib/pdf";
import { isSupportedCurrencyCode } from "@/lib/pdf/money-parser";
import { isoDateSchema } from "@/schemas/transaction";

type ViewMode = "tokens" | "lines" | "tables" | "candidates" | "parsed" | "unmatched";

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
  const [pdfResult, setPdfResult] = useState<{
    document: PDFDocumentProxy;
    numPages: number;
  } | null>(null);
  const [extraction, setExtraction] = useState<ExtractionResult | null>(null);
  const [reconstruction, setReconstruction] = useState<ReturnType<
    typeof reconstructDocument
  > | null>(null);
  const [currentPage, setCurrentPage] = useState(1);
  const [viewMode, setViewMode] = useState<ViewMode>("tokens");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [scale, setScale] = useState(1);
  const [periodStart, setPeriodStart] = useState("");
  const [periodEnd, setPeriodEnd] = useState("");
  const [periodVerified, setPeriodVerified] = useState(false);
  const [dateOrder, setDateOrder] = useState<StatementContext["dateOrder"]>();
  const [currencyDraft, setCurrencyDraft] = useState("");
  const [positiveAmountDirection, setPositiveAmountDirection] =
    useState<StatementContext["positiveAmountDirection"]>();
  const [renderedPage, setRenderedPage] = useState<{
    document: PDFDocumentProxy;
    page: number;
    scale: number;
    viewport: PageViewport;
  } | null>(null);
  const [selectedToken, setSelectedToken] = useState<ExtractedToken | null>(null);
  const [selectedLine, setSelectedLine] = useState<TextLine | null>(null);
  const [selectedCandidate, setSelectedCandidate] = useState<CandidateTransactionRow | null>(null);
  const [selectedParsedRowId, setSelectedParsedRowId] = useState<string | null>(null);

  const canvasRef = useRef<HTMLCanvasElement>(null);
  const loadHandleRef = useRef<ReturnType<typeof startPDFLoad> | null>(null);
  const renderHandleRef = useRef<ReturnType<typeof startPageRender> | null>(null);
  const renderSettlementRef = useRef<Promise<void>>(Promise.resolve());
  const documentRef = useRef<PDFDocumentProxy | null>(null);
  const requestIdRef = useRef(0);
  const numPages = pdfResult?.numPages ?? 0;

  const clearContext = useCallback(() => {
    setPeriodStart("");
    setPeriodEnd("");
    setPeriodVerified(false);
    setDateOrder(undefined);
    setCurrencyDraft("");
    setPositiveAmountDirection(undefined);
  }, []);

  const releaseDocumentAfterRender = useCallback((document: PDFDocumentProxy | null) => {
    renderHandleRef.current?.cancel();
    if (!document) return;
    const settlement = renderSettlementRef.current;
    void settlement
      .catch(() => undefined)
      .then(() => destroyPDFDocument(document))
      .catch(() => undefined);
  }, []);

  const handleFileSelect = useCallback(
    async (event: React.ChangeEvent<HTMLInputElement>) => {
      const selectedFile = event.target.files?.[0];
      if (!selectedFile) return;
      event.currentTarget.value = "";

      if (!acceptedFileTypes.includes(selectedFile.type)) {
        requestIdRef.current += 1;
        loadHandleRef.current?.cancel();
        loadHandleRef.current = null;
        const activeDocument = documentRef.current;
        documentRef.current = null;
        releaseDocumentAfterRender(activeDocument);
        setError("Please select a valid PDF file.");
        setFile(null);
        setPdfResult(null);
        setRenderedPage(null);
        setExtraction(null);
        setReconstruction(null);
        setCurrentPage(1);
        setSelectedToken(null);
        setSelectedLine(null);
        setSelectedCandidate(null);
        setSelectedParsedRowId(null);
        setViewMode("tokens");
        clearContext();
        return;
      }

      const requestId = ++requestIdRef.current;
      loadHandleRef.current?.cancel();
      loadHandleRef.current = null;
      const previousDocument = documentRef.current;
      documentRef.current = null;
      releaseDocumentAfterRender(previousDocument);

      setFile(selectedFile);
      setError(null);
      setLoading(true);
      setCurrentPage(1);
      setViewMode("tokens");
      setPdfResult(null);
      setRenderedPage(null);
      setExtraction(null);
      setReconstruction(null);
      setSelectedToken(null);
      setSelectedLine(null);
      setSelectedCandidate(null);
      setSelectedParsedRowId(null);
      clearContext();

      const loadHandle = startPDFLoad(selectedFile);
      loadHandleRef.current = loadHandle;
      try {
        const result = await loadHandle.promise;
        if (requestId !== requestIdRef.current) {
          await destroyPDFDocument(result.document);
          return;
        }
        documentRef.current = result.document;
        setPdfResult(result);

        const extractionResult = await extractDocumentText(result.document);
        if (requestId !== requestIdRef.current) return;
        setExtraction(extractionResult);

        const reconstructionResult = reconstructDocument(extractionResult);
        if (requestId !== requestIdRef.current) return;
        setReconstruction(reconstructionResult);
      } catch (err) {
        if (requestId === requestIdRef.current) {
          setError(err instanceof Error ? err.message : "Failed to load PDF");
          const failedDocument = documentRef.current;
          documentRef.current = null;
          releaseDocumentAfterRender(failedDocument);
        }
      } finally {
        if (requestId === requestIdRef.current) {
          loadHandleRef.current = null;
          setLoading(false);
        }
      }
    },
    [acceptedFileTypes, clearContext, releaseDocumentAfterRender],
  );

  useEffect(() => {
    const document = pdfResult?.document;
    const canvas = canvasRef.current;
    if (!document || !canvas || currentPage < 1 || currentPage > numPages) {
      return;
    }

    let cancelled = false;
    let renderHandle: ReturnType<typeof startPageRender> | null = null;

    (async () => {
      try {
        await renderSettlementRef.current.catch(() => undefined);
        if (cancelled || documentRef.current !== document) return;
        const page = await document.getPage(currentPage);
        if (cancelled) return;
        renderHandle = startPageRender(page, canvas, scale);
        renderHandleRef.current = renderHandle;
        renderSettlementRef.current = renderHandle.promise.then(
          () => undefined,
          () => undefined,
        );
        void renderSettlementRef.current.then(() => {
          if (renderHandleRef.current === renderHandle) renderHandleRef.current = null;
        });
        await renderHandle.promise;
        if (!cancelled && documentRef.current === document) {
          setRenderedPage({ document, page: currentPage, scale, viewport: renderHandle.viewport });
        }
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : "Failed to render page");
        }
      }
    })();

    return () => {
      cancelled = true;
      renderHandle?.cancel();
    };
  }, [pdfResult, currentPage, numPages, scale]);

  useEffect(
    () => () => {
      requestIdRef.current += 1;
      loadHandleRef.current?.cancel();
      renderHandleRef.current?.cancel();
      const document = documentRef.current;
      documentRef.current = null;
      releaseDocumentAfterRender(document);
    },
    [releaseDocumentAfterRender],
  );

  // Compute parsed transactions during render to avoid setState-in-effect issues
  const validPeriod =
    isoDateSchema.safeParse(periodStart).success &&
    isoDateSchema.safeParse(periodEnd).success &&
    periodStart <= periodEnd;
  const normalizedCurrency = currencyDraft.trim().toUpperCase();
  const currencyValid =
    normalizedCurrency.length === 0 || isSupportedCurrencyCode(normalizedCurrency);
  const context: StatementContext = {
    ...(validPeriod ? { periodStart, periodEnd, periodVerified } : {}),
    ...(dateOrder ? { dateOrder } : {}),
    ...(currencyValid && normalizedCurrency ? { currency: normalizedCurrency } : {}),
    ...(positiveAmountDirection ? { positiveAmountDirection } : {}),
  };
  const parsed = reconstruction ? parseDocumentCandidates(reconstruction, context) : null;
  const selectedParsedCandidate =
    parsed?.candidates.find((candidate) => candidate.rowId === selectedParsedRowId) ?? null;

  const handlePrevPage = useCallback(() => {
    setCurrentPage((prev) => (prev > 1 ? prev - 1 : prev));
    setSelectedToken(null);
    setSelectedLine(null);
    setSelectedCandidate(null);
    setSelectedParsedRowId(null);
  }, []);

  const handleNextPage = useCallback(() => {
    setCurrentPage((prev) => (prev < numPages ? prev + 1 : prev));
    setSelectedToken(null);
    setSelectedLine(null);
    setSelectedCandidate(null);
    setSelectedParsedRowId(null);
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
    setSelectedParsedRowId(null);
    setViewMode("candidates");
  }, []);

  const handleSelectParsedCandidate = useCallback((parsedCandidate: ParsedCandidate) => {
    setSelectedParsedRowId(parsedCandidate.rowId);
    setSelectedToken(null);
    setSelectedLine(null);
    setSelectedCandidate(null);
    setViewMode("parsed");
  }, []);

  const extractedPage = extraction?.pages.find((p) => p.page === currentPage);
  const pageTokens = extractedPage?.tokens ?? [];
  const geometryDiagnostics = extractedPage?.geometryDiagnostics ?? [];
  const pageReconstruction = reconstruction?.pages.find((p) => p.page === currentPage);
  const pageLines = pageReconstruction?.lines ?? [];
  const pageTables = pageReconstruction?.tables ?? [];
  const pageCandidates = pageReconstruction?.candidates ?? [];
  const pageParsedCandidates = parsed?.candidates.filter((c) => c.page === currentPage) ?? [];
  const pagesWithoutText = extraction?.pages.filter((p) => p.tokens.length === 0) ?? [];

  const resetFile = useCallback(() => {
    requestIdRef.current += 1;
    loadHandleRef.current?.cancel();
    loadHandleRef.current = null;
    const pdfDocument = documentRef.current;
    documentRef.current = null;
    releaseDocumentAfterRender(pdfDocument);
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
    setSelectedParsedRowId(null);
    clearContext();
    if (canvasRef.current) {
      const fileInput = window.document.getElementById("pdf-debug-file-input");
      if (fileInput instanceof HTMLInputElement) fileInput.value = "";
    }
  }, [clearContext, releaseDocumentAfterRender]);

  const parsedAnchor = selectedParsedCandidate?.sourceAnchor;
  const selection =
    selectedToken ??
    selectedLine ??
    selectedCandidate ??
    (parsedAnchor ? { page: parsedAnchor.page, bbox: parsedAnchor.bbox } : null);
  const highlightClass = selectedParsedCandidate
    ? "border-purple-600 bg-purple-500/20"
    : selectedToken
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
          {file && <p className="mt-2 text-sm text-slate-500">{file.name}</p>}
          <Button onClick={resetFile} variant="secondary" className="ml-3">
            Reset document
          </Button>
        </CardContent>
      </Card>

      {pdfResult && numPages > 0 && (
        <div className="mt-8 grid grid-cols-1 lg:grid-cols-12 gap-8">
          <div className="lg:col-span-8">
            <Card className="mb-6">
              <CardHeader>
                <CardTitle>Statement context</CardTitle>
              </CardHeader>
              <CardContent className="grid gap-4 sm:grid-cols-2">
                <label className="grid gap-1 text-sm">
                  <span>Period start</span>
                  <input
                    aria-label="Period start"
                    type="date"
                    value={periodStart}
                    onChange={(event) => {
                      setPeriodStart(event.target.value);
                      setPeriodVerified(false);
                    }}
                    className="rounded border border-slate-300 bg-white px-2 py-1"
                  />
                </label>
                <label className="grid gap-1 text-sm">
                  <span>Period end</span>
                  <input
                    aria-label="Period end"
                    type="date"
                    value={periodEnd}
                    onChange={(event) => {
                      setPeriodEnd(event.target.value);
                      setPeriodVerified(false);
                    }}
                    className="rounded border border-slate-300 bg-white px-2 py-1"
                  />
                </label>
                <label className="flex items-center gap-2 text-sm sm:col-span-2">
                  <input
                    aria-label="Statement period verified"
                    type="checkbox"
                    checked={periodVerified}
                    disabled={!validPeriod}
                    onChange={(event) => setPeriodVerified(event.target.checked)}
                  />
                  I verified this statement period from the document
                </label>
                {periodStart && periodEnd && !validPeriod && (
                  <p className="text-sm text-red-700 sm:col-span-2">
                    Enter valid dates with the start on or before the end.
                  </p>
                )}
                <label className="grid gap-1 text-sm">
                  <span>Date order</span>
                  <select
                    aria-label="Date order"
                    value={dateOrder ?? ""}
                    onChange={(event) =>
                      setDateOrder(
                        (event.target.value || undefined) as StatementContext["dateOrder"],
                      )
                    }
                    className="rounded border border-slate-300 bg-white px-2 py-1"
                  >
                    <option value="">Unavailable</option>
                    <option value="MDY">Month / day / year</option>
                    <option value="DMY">Day / month / year</option>
                  </select>
                </label>
                <label className="grid gap-1 text-sm">
                  <span>Statement currency (ISO 4217)</span>
                  <input
                    aria-label="Statement currency"
                    value={currencyDraft}
                    maxLength={3}
                    onChange={(event) => setCurrencyDraft(event.target.value)}
                    placeholder="Unavailable"
                    className="rounded border border-slate-300 bg-white px-2 py-1 uppercase"
                  />
                </label>
                <label className="grid gap-1 text-sm">
                  <span>Positive amount means</span>
                  <select
                    aria-label="Positive amount means"
                    value={positiveAmountDirection ?? ""}
                    onChange={(event) =>
                      setPositiveAmountDirection(
                        (event.target.value ||
                          undefined) as StatementContext["positiveAmountDirection"],
                      )
                    }
                    className="rounded border border-slate-300 bg-white px-2 py-1"
                  >
                    <option value="">Unavailable</option>
                    <option value="debit">Debit / expense</option>
                    <option value="credit">Credit / payment</option>
                  </select>
                </label>
                <div
                  role="status"
                  data-testid="statement-context-status"
                  className="text-sm text-slate-600 sm:col-span-2"
                >
                  Period {validPeriod && periodVerified ? "verified" : "unavailable or unverified"};
                  currency{" "}
                  {currencyValid && normalizedCurrency ? normalizedCurrency : "unavailable"}; date
                  order {dateOrder ?? "unavailable"}; positive sign{" "}
                  {positiveAmountDirection ?? "unavailable"}.
                  {!currencyValid && (
                    <span className="ml-1 text-red-700">
                      Enter a supported ISO 4217 currency code.
                    </span>
                  )}
                </div>
              </CardContent>
            </Card>
            <Card>
              <CardHeader>
                <CardTitle>Document</CardTitle>
              </CardHeader>
              <CardContent className="p-0">
                <div className="bg-slate-100">
                  <div
                    className="relative inline-block max-w-full align-top"
                    data-testid="pdf-debug-render-surface"
                    data-viewport-width={renderedPage?.viewport.width}
                    data-viewport-height={renderedPage?.viewport.height}
                    data-viewport-rotation={renderedPage?.viewport.rotation}
                    data-rendered-page={renderedPage?.page}
                  >
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
                    <span
                      className={`font-medium ${extraction?.hasExtractableText ? "text-green-700" : "text-red-700"}`}
                    >
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
                      <div
                        className={`flex justify-between text-sm ${reconstruction.hasUnmatchedContent ? "text-amber-700" : "text-slate-600"}`}
                      >
                        <span>Has unmatched content</span>
                        <span className="font-medium">
                          {reconstruction.hasUnmatchedContent ? "Yes" : "No"}
                        </span>
                      </div>
                      <div
                        className="mt-2 rounded bg-slate-50 p-2 text-xs text-slate-600"
                        data-testid="reconstruction-coverage"
                      >
                        <p className="font-medium text-slate-800">
                          Reconstruction coverage evidence
                        </p>
                        <p>
                          Tokens assigned to lines:{" "}
                          {reconstruction.coverage.tokensAssignedToLines.assigned} /{" "}
                          {reconstruction.coverage.tokensAssignedToLines.extracted}
                        </p>
                        <p>
                          Candidate rows detected:{" "}
                          {reconstruction.coverage.transactionCandidates.detected}
                        </p>
                        <p>
                          Candidate or suspected rows:{" "}
                          {reconstruction.coverage.transactionCandidates.suspected}
                        </p>
                        <p>Verified statement transaction count: unavailable</p>
                        <p className="mt-1">
                          These are reconstruction measures, not transaction recall.
                        </p>
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
                      Text geometry issues on this page: {geometryDiagnostics.length}
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
                          data-testid="extracted-token"
                          data-token-bbox={JSON.stringify(token.bbox)}
                          onClick={() => handleSelectToken(token)}
                          className="cursor-pointer hover:bg-slate-50 p-2 rounded transition-colors group"
                        >
                          <div className="flex justify-between text-xs">
                            <span className="font-mono text-slate-900 truncate">{token.str}</span>
                            <Badge className="text-[10px]">p{token.page}</Badge>
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
                            <span className="font-mono text-slate-900 truncate">{line.str}</span>
                            <Badge className="text-[10px]">{line.tokenCount}t</Badge>
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
                            <Badge className="text-[10px]">{table.columns.length} cols</Badge>
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
                              <span className="text-[10px] text-green-600 font-mono">📅</span>
                            )}
                            {candidate.hasAmountLikeField && (
                              <span className="text-[10px] text-green-600 font-mono">💰</span>
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
                          data-testid="parsed-candidate-row"
                          data-row-id={parsedCandidate.rowId}
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
                        {parsed.diagnostics.filter((d) => d.startsWith(`p${currentPage}:`)).length}
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
                    {pageReconstruction.suspectedUnmatchedLines.length > 0 && (
                      <div
                        className="rounded bg-amber-50 p-2 text-xs text-amber-900"
                        data-testid="suspected-unmatched-lines"
                      >
                        <p className="font-medium">Suspected transaction-like lines</p>
                        {pageReconstruction.suspectedUnmatchedLines.map(({ lineId, reason }) => (
                          <p key={lineId}>
                            {pageLines.find((line) => line.lineId === lineId)?.str ?? lineId}:{" "}
                            {reason}
                          </p>
                        ))}
                      </div>
                    )}
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
                              <span className="font-mono text-slate-900 truncate">{line.str}</span>
                              <Badge className="text-[10px]">unmatched</Badge>
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
                                  <Badge className="text-[10px]">unmatched</Badge>
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
                      <span className="font-mono text-xs">{selectedToken.tokenId}</span>
                    </div>
                    <div className="flex justify-between text-sm">
                      <span className="text-slate-600">BBox (normalized)</span>
                      <span className="font-mono text-xs">
                        [{selectedToken.bbox.map((v) => v.toFixed(3)).join(", ")}]
                      </span>
                    </div>
                    <div className="flex justify-between text-sm">
                      <span className="text-slate-600">Has EOL</span>
                      <span className="font-medium">{selectedToken.hasEOL ? "Yes" : "No"}</span>
                    </div>
                    <Button onClick={() => handleSelectToken(null)} variant="secondary">
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
                    <Button onClick={() => setSelectedLine(null)} variant="secondary">
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
                      <span className="font-medium">{selectedCandidate.lineIds.length}</span>
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
                    <Button onClick={() => setSelectedCandidate(null)} variant="secondary">
                      Clear selection
                    </Button>
                  </div>
                </CardContent>
              </Card>
            )}

            {selectedParsedCandidate && (
              <Card data-testid="selected-parsed-candidate">
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
                    {selectedParsedCandidate.resolution === "unresolved" && (
                      <div
                        className="rounded bg-amber-50 p-3 text-sm"
                        data-testid="parsed-partial-fields"
                      >
                        <p className="font-medium text-amber-900">Partial fields</p>
                        <dl className="mt-2 grid grid-cols-2 gap-1 text-xs">
                          {Object.entries(selectedParsedCandidate.partial).map(([field, value]) => (
                            <div key={field} className="contents">
                              <dt className="text-slate-600">{field}</dt>
                              <dd className="font-mono break-all">
                                {value && typeof value === "object"
                                  ? JSON.stringify(value)
                                  : (value ?? "unavailable")}
                              </dd>
                            </div>
                          ))}
                        </dl>
                      </div>
                    )}
                    <div className="rounded bg-slate-50 p-3 text-xs">
                      <p className="font-medium text-slate-700">Validation diagnostics</p>
                      <ul className="mt-1 list-disc pl-4">
                        {selectedParsedCandidate.diagnostics.length > 0 ? (
                          selectedParsedCandidate.diagnostics.map((diagnostic) => (
                            <li key={diagnostic}>{diagnostic}</li>
                          ))
                        ) : (
                          <li>No parser diagnostics.</li>
                        )}
                      </ul>
                      {selectedParsedCandidate.flags.length > 0 && (
                        <p className="mt-1 text-amber-700">
                          Uncertain fields: {selectedParsedCandidate.flags.join(", ")}
                        </p>
                      )}
                    </div>
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
                      <details className="text-xs">
                        <summary className="cursor-pointer text-slate-700">inspect</summary>
                        <pre
                          data-testid="parsed-raw-fields"
                          className="mt-2 max-h-64 overflow-auto whitespace-pre-wrap rounded bg-slate-50 p-2"
                        >
                          {JSON.stringify(selectedParsedCandidate.rawFields, null, 2)}
                        </pre>
                      </details>
                    </div>
                    <Button onClick={() => setSelectedParsedRowId(null)} variant="secondary">
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
