import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";

const mockGetDocument = vi.fn();
const mockPromise = vi.fn();
const mockLoadingDestroy = vi.fn();

vi.mock("pdfjs-dist", () => ({
  GlobalWorkerOptions: { workerSrc: "" },
  getDocument: (...args: unknown[]) => {
    mockGetDocument(...args);
    return { promise: mockPromise(), destroy: mockLoadingDestroy };
  },
}));

import { loadPDF, startPDFLoad } from "@/lib/pdf";

describe("loadPDF", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockLoadingDestroy.mockResolvedValue(undefined);
    mockPromise.mockResolvedValue({
      numPages: 3,
      getPage: vi.fn().mockResolvedValue({}),
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("reads the file as an ArrayBuffer and passes it to pdfjs-getDocument", async () => {
    const arrayBuffer = new ArrayBuffer(8);
    const file = {
      arrayBuffer: vi.fn().mockResolvedValue(arrayBuffer),
      name: "statement.pdf",
      type: "application/pdf",
    } as unknown as File;

    await loadPDF(file);

    expect(file.arrayBuffer).toHaveBeenCalled();
    expect(mockGetDocument).toHaveBeenCalledWith({ data: arrayBuffer });
  });

  it("returns the document and page count", async () => {
    const mockDocument = { numPages: 5, getPage: vi.fn() };
    mockPromise.mockResolvedValue(mockDocument);
    const file = {
      arrayBuffer: vi.fn().mockResolvedValue(new ArrayBuffer(8)),
      name: "statement.pdf",
      type: "application/pdf",
    } as unknown as File;

    const result = await loadPDF(file);

    expect(result).toEqual({ document: mockDocument, numPages: 5 });
  });

  it("throws when the file cannot be read", async () => {
    const file = {
      arrayBuffer: vi.fn().mockRejectedValue(new Error("Read failed")),
      name: "bad.pdf",
      type: "application/pdf",
    } as unknown as File;

    await expect(loadPDF(file)).rejects.toThrow("Read failed");
  });

  it("throws when pdfjs-getDocument fails", async () => {
    mockPromise.mockRejectedValue(new Error("Invalid PDF"));
    const file = {
      arrayBuffer: vi.fn().mockResolvedValue(new ArrayBuffer(8)),
      name: "bad.pdf",
      type: "application/pdf",
    } as unknown as File;

    await expect(loadPDF(file)).rejects.toThrow("Invalid PDF");
    expect(mockLoadingDestroy).toHaveBeenCalledTimes(1);
  });

  it("destroys a cancelled loading task only once if its promise later rejects", async () => {
    let rejectDocument!: (reason: Error) => void;
    mockPromise.mockReturnValue(
      new Promise((_resolve, reject) => {
        rejectDocument = reject;
      }),
    );
    const file = {
      arrayBuffer: vi.fn().mockResolvedValue(new ArrayBuffer(8)),
      name: "slow.pdf",
      type: "application/pdf",
    } as unknown as File;
    const load = startPDFLoad(file);
    await Promise.resolve();
    expect(mockGetDocument).toHaveBeenCalledTimes(1);

    load.cancel();
    rejectDocument(new Error("Loading cancelled"));

    await expect(load.promise).rejects.toThrow("Loading cancelled");
    expect(mockLoadingDestroy).toHaveBeenCalledTimes(1);
  });
});
