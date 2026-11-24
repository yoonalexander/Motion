import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import React from "react";

const mockStartPDFLoad = vi.fn();
const mockDestroyPDFDocument = vi.fn();
const mockStartPageRender = vi.fn();

vi.mock("@/lib/pdf", () => ({
  startPDFLoad: (...args: unknown[]) => mockStartPDFLoad(...args),
  destroyPDFDocument: (...args: unknown[]) => mockDestroyPDFDocument(...args),
  startPageRender: (...args: unknown[]) => mockStartPageRender(...args),
}));

import { PDFViewer } from "@/components/pdf-viewer/PDFViewer";
import type { PDFDocumentProxy } from "pdfjs-dist";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function createDocument(pageCount = 3) {
  return {
    numPages: pageCount,
    getPage: vi.fn(async (pageNumber: number) => ({ pageNumber })),
    destroy: vi.fn().mockResolvedValue(undefined),
  } as unknown as PDFDocumentProxy;
}

function createLoadHandle(document: PDFDocumentProxy, numPages = 3) {
  return { promise: Promise.resolve({ document, numPages }), cancel: vi.fn() };
}

function createRenderHandle(width = 600, height = 800, pending = false) {
  const render = deferred<void>();
  const cancel = vi.fn();
  let cancelled = false;
  const cancelOnce = () => {
    if (cancelled) return;
    cancelled = true;
    cancel();
    render.resolve();
  };
  if (!pending) render.resolve();
  return {
    viewport: { width, height, scale: 1, rotation: 0 },
    promise: render.promise,
    cancel: cancelOnce,
    cancelSpy: cancel,
  };
}

function createFile(name = "statement.pdf", type = "application/pdf"): File {
  return new File([new ArrayBuffer(8)], name, { type });
}

function selectFile(file: File): void {
  fireEvent.change(screen.getByLabelText(/select a pdf file/i), { target: { files: [file] } });
}

let mockDocument: PDFDocumentProxy;

beforeEach(() => {
  vi.clearAllMocks();
  mockDocument = createDocument();
  mockStartPDFLoad.mockImplementation(() => createLoadHandle(mockDocument));
  mockDestroyPDFDocument.mockResolvedValue(undefined);
  mockStartPageRender.mockImplementation(() => createRenderHandle());
});

afterEach(() => {
  cleanup();
});

describe("PDFViewer", () => {
  it("renders a file input for selecting PDFs", () => {
    render(<PDFViewer />);
    expect(screen.getByLabelText(/select a pdf file/i)).toBeInTheDocument();
  });

  it("shows loading state while a PDF is loading", async () => {
    const pending = deferred<{ document: PDFDocumentProxy; numPages: number }>();
    mockStartPDFLoad.mockReturnValue({ promise: pending.promise, cancel: vi.fn() });
    render(<PDFViewer />);

    selectFile(createFile());
    expect(screen.getByText(/loading/i)).toBeInTheDocument();
    pending.resolve({ document: mockDocument, numPages: 3 });
    await waitFor(() => expect(screen.queryByText(/loading/i)).not.toBeInTheDocument());
  });

  it("shows page count and the exact rendered viewport", async () => {
    render(<PDFViewer />);
    selectFile(createFile());

    await screen.findByText(/page 1 of 3/i);
    const canvasFrame = document.querySelector("canvas")?.parentElement;
    await waitFor(() => expect(canvasFrame).toHaveAttribute("data-viewport-width", "600"));
    expect(canvasFrame).toHaveAttribute("data-viewport-height", "800");
  });

  it("shows a load error and allows retry after a failed load", async () => {
    const failedDocument = createDocument();
    mockStartPDFLoad
      .mockReturnValueOnce({
        promise: Promise.reject(new Error("Invalid PDF file")),
        cancel: vi.fn(),
      })
      .mockReturnValueOnce(createLoadHandle(failedDocument));
    render(<PDFViewer />);

    selectFile(createFile());
    await screen.findByText(/invalid pdf file/i);
    fireEvent.click(screen.getByRole("button", { name: /try again/i }));
    selectFile(createFile("fixed.pdf"));

    await screen.findByText(/page 1 of 3/i);
    expect(mockStartPDFLoad).toHaveBeenCalledTimes(2);
  });

  it("cancels an in-flight load on unmount and destroys a late stale result", async () => {
    const pending = deferred<{ document: PDFDocumentProxy; numPages: number }>();
    const cancel = vi.fn();
    mockStartPDFLoad.mockReturnValue({ promise: pending.promise, cancel });
    const view = render(<PDFViewer />);
    selectFile(createFile());
    await screen.findByText(/loading pdf/i);
    await waitFor(() => expect(mockStartPDFLoad).toHaveBeenCalled());

    view.unmount();
    expect(cancel).toHaveBeenCalledTimes(1);
    pending.resolve({ document: mockDocument, numPages: 3 });

    await waitFor(() => expect(mockDestroyPDFDocument).toHaveBeenCalledWith(mockDocument));
  });

  it("rejects non-PDF files with a visible recovery action", async () => {
    render(<PDFViewer />);
    selectFile(createFile("notes.txt", "text/plain"));

    await screen.findByText(/please select a valid pdf file/i);
    expect(screen.getByRole("button", { name: /try again/i })).toBeInTheDocument();
  });

  it("cancels and serializes renders during rapid page and zoom changes", async () => {
    mockStartPageRender.mockImplementation(() => createRenderHandle(600, 800, true));
    render(<PDFViewer />);
    selectFile(createFile());
    await screen.findByText(/page 1 of 3/i);
    await waitFor(() => expect(mockStartPageRender).toHaveBeenCalledTimes(1));
    const firstRender = mockStartPageRender.mock.results[0]!.value as ReturnType<
      typeof createRenderHandle
    >;

    fireEvent.click(screen.getByRole("button", { name: /next page/i }));
    await waitFor(() => expect(mockStartPageRender).toHaveBeenCalledTimes(2));
    const secondRender = mockStartPageRender.mock.results[1]!.value as ReturnType<
      typeof createRenderHandle
    >;
    expect(firstRender.cancelSpy).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByRole("button", { name: /zoom in/i }));
    await waitFor(() => expect(mockStartPageRender).toHaveBeenCalledTimes(3));
    expect(secondRender.cancelSpy).toHaveBeenCalledTimes(1);
    expect(mockDocument.getPage).toHaveBeenNthCalledWith(2, 2);
    expect(mockStartPageRender.mock.calls[2]![2]).toBe(1.25);
  });

  it("does not render a page request that resolves after navigation", async () => {
    const firstPage = deferred<{ pageNumber: number }>();
    const documentWithSlowFirstPage = createDocument();
    vi.mocked(documentWithSlowFirstPage.getPage)
      .mockReturnValueOnce(firstPage.promise as never)
      .mockResolvedValueOnce({ pageNumber: 2 } as never);
    mockStartPDFLoad.mockReturnValue(createLoadHandle(documentWithSlowFirstPage));
    render(<PDFViewer />);
    selectFile(createFile());
    await screen.findByText(/page 1 of 3/i);
    await waitFor(() => expect(documentWithSlowFirstPage.getPage).toHaveBeenCalledWith(1));

    fireEvent.click(screen.getByRole("button", { name: /next page/i }));
    await waitFor(() => expect(documentWithSlowFirstPage.getPage).toHaveBeenCalledWith(2));
    firstPage.resolve({ pageNumber: 1 });

    await waitFor(() => expect(mockStartPageRender).toHaveBeenCalledTimes(1));
    expect(mockStartPageRender.mock.calls[0]![0]).toEqual({ pageNumber: 2 });
  });

  it("shows render errors with a recovery action", async () => {
    const failedRender = deferred<void>();
    mockStartPageRender.mockReturnValue({
      viewport: { width: 600, height: 800 },
      promise: failedRender.promise,
      cancel: vi.fn(),
    });
    render(<PDFViewer />);
    selectFile(createFile());

    await waitFor(() => expect(mockStartPageRender).toHaveBeenCalled());
    failedRender.reject(new Error("Render failed"));
    await screen.findByText(/render failed/i);
    expect(screen.getByRole("button", { name: /try again/i })).toBeInTheDocument();
  });

  it("destroys a replaced document and cleans up on unmount", async () => {
    mockStartPageRender.mockImplementation(() => createRenderHandle(600, 800, true));
    const firstDocument = createDocument();
    const secondDocument = createDocument();
    mockStartPDFLoad
      .mockReturnValueOnce(createLoadHandle(firstDocument))
      .mockReturnValueOnce(createLoadHandle(secondDocument));
    const view = render(<PDFViewer />);
    selectFile(createFile("first.pdf"));
    await screen.findByText(/page 1 of 3/i);
    const firstRender = mockStartPageRender.mock.results[0]!.value as ReturnType<
      typeof createRenderHandle
    >;

    selectFile(createFile("second.pdf"));
    await waitFor(() => expect(mockDestroyPDFDocument).toHaveBeenCalledWith(firstDocument));
    expect(firstRender.cancelSpy).toHaveBeenCalledTimes(1);
    expect(mockDestroyPDFDocument.mock.invocationCallOrder[0]).toBeGreaterThan(
      firstRender.cancelSpy.mock.invocationCallOrder[0]!,
    );
    await screen.findByText(/page 1 of 3/i);
    view.unmount();

    await waitFor(() => expect(mockDestroyPDFDocument).toHaveBeenCalledWith(secondDocument));
  });

  it("cancels a running render when unmounted", async () => {
    const runningRender = createRenderHandle(600, 800, true);
    mockStartPageRender.mockReturnValue(runningRender);
    const view = render(<PDFViewer />);
    selectFile(createFile());
    await screen.findByText(/page 1 of 3/i);
    await waitFor(() => expect(mockStartPageRender).toHaveBeenCalled());

    view.unmount();

    expect(runningRender.cancelSpy).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(mockDestroyPDFDocument).toHaveBeenCalledWith(mockDocument));
  });
});
