import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";

const mockGetViewport = vi.fn();
const mockRender = vi.fn();

vi.mock("pdfjs-dist", () => ({
  GlobalWorkerOptions: { workerSrc: "" },
}));

import { destroyPDFDocument, renderPageToCanvas, startPageRender } from "@/lib/pdf";

describe("renderPageToCanvas", () => {
  const mockContext = {
    fillRect: vi.fn(),
    clearRect: vi.fn(),
    drawImage: vi.fn(),
  };

  const mockCanvas = {
    width: 0,
    height: 0,
    getContext: vi.fn(() => mockContext),
  } as unknown as HTMLCanvasElement;

  const mockPage = {
    getViewport: mockGetViewport.mockReturnValue({ width: 600, height: 800 }),
    render: mockRender.mockReturnValue({ promise: Promise.resolve(), cancel: vi.fn() }),
  } as unknown;

  beforeEach(() => {
    vi.clearAllMocks();
    mockGetViewport.mockReturnValue({ width: 600, height: 800 });
    mockRender.mockReturnValue({ promise: Promise.resolve(), cancel: vi.fn() });
    mockCanvas.width = 0;
    mockCanvas.height = 0;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("sets canvas dimensions from the page viewport", async () => {
    await renderPageToCanvas(mockPage as never, mockCanvas, 1.5);

    expect(mockGetViewport).toHaveBeenCalledWith({ scale: 1.5 });
    expect(mockCanvas.width).toBe(600);
    expect(mockCanvas.height).toBe(800);
  });

  it("gets the 2D rendering context from the canvas", async () => {
    await renderPageToCanvas(mockPage as never, mockCanvas, 1);

    expect(mockCanvas.getContext).toHaveBeenCalledWith("2d");
  });

  it("renders the page to the canvas context with the viewport", async () => {
    await renderPageToCanvas(mockPage as never, mockCanvas, 2);

    expect(mockRender).toHaveBeenCalledWith({
      canvasContext: mockContext,
      viewport: { width: 600, height: 800 },
    });
  });

  it("throws when the canvas has no 2D context", async () => {
    const noContextCanvas = {
      width: 0,
      height: 0,
      getContext: vi.fn(() => null),
    } as unknown as HTMLCanvasElement;

    await expect(renderPageToCanvas(mockPage as never, noContextCanvas, 1)).rejects.toThrow(
      "Could not get 2D rendering context from canvas",
    );
  });

  it("propagate render errors", async () => {
    mockRender.mockReturnValue({
      promise: Promise.reject(new Error("Render failed")),
      cancel: vi.fn(),
    });

    await expect(renderPageToCanvas(mockPage as never, mockCanvas, 1)).rejects.toThrow(
      "Render failed",
    );
  });

  it("exposes the exact viewport and a cancel handle for each render task", async () => {
    let finishRender: (() => void) | undefined;
    const taskPromise = new Promise<void>((resolve) => {
      finishRender = resolve;
    });
    const cancel = vi.fn();
    mockRender.mockReturnValue({ promise: taskPromise, cancel });

    const handle = startPageRender(mockPage as never, mockCanvas, 1.5);

    expect(handle.viewport).toEqual({ width: 600, height: 800 });
    expect(mockCanvas.width).toBe(600);
    expect(mockCanvas.height).toBe(800);
    handle.cancel();
    handle.cancel();
    expect(cancel).toHaveBeenCalledTimes(1);

    finishRender?.();
    await handle.promise;
    handle.cancel();
    expect(cancel).toHaveBeenCalledTimes(1);
  });

  it("destroys a document only once even when multiple owners release it", async () => {
    const destroy = vi.fn().mockResolvedValue(undefined);
    const document = { destroy } as never;

    await Promise.all([destroyPDFDocument(document), destroyPDFDocument(document)]);

    expect(destroy).toHaveBeenCalledTimes(1);
  });
});
