import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import React from "react";

vi.mock("@/lib/pdf", () => ({
  loadPDF: vi.fn(),
  renderPageToCanvas: vi.fn(),
}));

import { loadPDF, renderPageToCanvas } from "@/lib/pdf";
import { PDFViewer } from "@/components/pdf-viewer/PDFViewer";
import type { PDFDocumentProxy } from "pdfjs-dist";

const mockLoadPDF = vi.mocked(loadPDF);
const mockRenderPageToCanvas = vi.mocked(renderPageToCanvas);

const mockDocument = {
  numPages: 3,
  getPage: vi.fn().mockResolvedValue({
    getViewport: vi.fn().mockReturnValue({ width: 600, height: 800 }),
  }),
} as unknown as PDFDocumentProxy;

beforeEach(() => {
  vi.clearAllMocks();
  mockLoadPDF.mockResolvedValue({ document: mockDocument, numPages: 3 });
  mockRenderPageToCanvas.mockResolvedValue(undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
});

function createFile(name: string = "statement.pdf"): File {
  return new File([new ArrayBuffer(8)], name, { type: "application/pdf" });
}

describe("PDFViewer", () => {
  it("renders a file input for selecting PDFs", () => {
    render(<PDFViewer />);
    expect(screen.getByLabelText(/select a pdf file/i)).toBeInTheDocument();
  });

  it("shows loading state while loading a PDF", async () => {
    mockLoadPDF.mockImplementation(() => new Promise((resolve) => setTimeout(() => resolve({ document: mockDocument, numPages: 3 }), 100)));
    render(<PDFViewer />);

    const input = screen.getByLabelText(/select a pdf file/i);
    fireEvent.change(input, { target: { files: [createFile()] } });

    expect(screen.getByText(/loading/i)).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByText(/loading/i)).not.toBeInTheDocument());
  });

  it("calls loadPDF with the selected file", async () => {
    render(<PDFViewer />);
    const input = screen.getByLabelText(/select a pdf file/i);
    const file = createFile();
    fireEvent.change(input, { target: { files: [file] } });

    await waitFor(() => expect(mockLoadPDF).toHaveBeenCalledWith(file));
  });

  it("shows page count after loading", async () => {
    render(<PDFViewer />);
    const input = screen.getByLabelText(/select a pdf file/i);
    fireEvent.change(input, { target: { files: [createFile()] } });

    await waitFor(() => expect(screen.getByText(/page 1 of 3/i)).toBeInTheDocument());
  });

  it("shows error state when loadPDF fails", async () => {
    mockLoadPDF.mockRejectedValue(new Error("Invalid PDF file"));
    render(<PDFViewer />);

    const input = screen.getByLabelText(/select a pdf file/i);
    fireEvent.change(input, { target: { files: [createFile()] } });

    await waitFor(() =>
      expect(screen.getByText(/invalid pdf file/i)).toBeInTheDocument()
    );
  });

  it("renders page 1 by default after loading", async () => {
    render(<PDFViewer />);
    const input = screen.getByLabelText(/select a pdf file/i);
    fireEvent.change(input, { target: { files: [createFile()] } });

    await waitFor(() => expect(mockRenderPageToCanvas).toHaveBeenCalled());
    const [page, canvas] = mockRenderPageToCanvas.mock.calls[0];
    expect(page).toEqual({ getViewport: expect.any(Function) });
    expect(canvas).toBeInstanceOf(HTMLCanvasElement);
  });

  it("navigates to next page", async () => {
    render(<PDFViewer />);
    const input = screen.getByLabelText(/select a pdf file/i);
    fireEvent.change(input, { target: { files: [createFile()] } });

    await waitFor(() => expect(screen.getByText(/page 1 of 3/i)).toBeInTheDocument());

    const nextButton = screen.getByRole("button", { name: /next page/i });
    fireEvent.click(nextButton);

    await waitFor(() => expect(screen.getByText(/page 2 of 3/i)).toBeInTheDocument());
  });

  it("navigates to previous page", async () => {
    render(<PDFViewer />);
    const input = screen.getByLabelText(/select a pdf file/i);
    fireEvent.change(input, { target: { files: [createFile()] } });

    await waitFor(() => expect(screen.getByText(/page 1 of 3/i)).toBeInTheDocument());

    const nextButton = screen.getByRole("button", { name: /next page/i });
    fireEvent.click(nextButton);
    await waitFor(() => expect(screen.getByText(/page 2 of 3/i)).toBeInTheDocument());

    const prevButton = screen.getByRole("button", { name: /previous page/i });
    fireEvent.click(prevButton);

    await waitFor(() => expect(screen.getByText(/page 1 of 3/i)).toBeInTheDocument());
  });

  it("disables previous button on first page", async () => {
    render(<PDFViewer />);
    const input = screen.getByLabelText(/select a pdf file/i);
    fireEvent.change(input, { target: { files: [createFile()] } });

    await waitFor(() => expect(screen.getByText(/page 1 of 3/i)).toBeInTheDocument());

    const prevButton = screen.getByRole("button", { name: /previous page/i });
    expect(prevButton).toBeDisabled();
  });

  it("disables next button on last page", async () => {
    render(<PDFViewer />);
    const input = screen.getByLabelText(/select a pdf file/i);
    fireEvent.change(input, { target: { files: [createFile()] } });

    await waitFor(() => expect(screen.getByText(/page 1 of 3/i)).toBeInTheDocument());

    const nextButton = screen.getByRole("button", { name: /next page/i });
    fireEvent.click(nextButton);
    fireEvent.click(nextButton);
    await waitFor(() => expect(screen.getByText(/page 3 of 3/i)).toBeInTheDocument());

    expect(screen.getByRole("button", { name: /next page/i })).toBeDisabled();
  });

  it("rejects non-PDF files", async () => {
    render(<PDFViewer />);
    const input = screen.getByLabelText(/select a pdf file/i);
    const textFile = new File([new ArrayBuffer(8)], "notes.txt", { type: "text/plain" });
    fireEvent.change(input, { target: { files: [textFile] } });

    await waitFor(() =>
      expect(screen.getByText(/please select a valid pdf file/i)).toBeInTheDocument()
    );
  });
});
