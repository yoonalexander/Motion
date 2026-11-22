import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";

const mockGetViewport = vi.fn();
const mockRender = vi.fn();

vi.mock("pdfjs-dist", () => ({
  GlobalWorkerOptions: { workerSrc: "" },
}));

import { renderPageToCanvas } from "@/lib/pdf";

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
    render: mockRender.mockResolvedValue(undefined),
  } as unknown;

  beforeEach(() => {
    vi.clearAllMocks();
    mockGetViewport.mockReturnValue({ width: 600, height: 800 });
    mockRender.mockResolvedValue(undefined);
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

    await expect(
      renderPageToCanvas(mockPage as never, noContextCanvas, 1)
    ).rejects.toThrow("Could not get 2D rendering context from canvas");
  });

  it("propagate render errors", async () => {
    mockRender.mockReturnValue({ promise: Promise.reject(new Error("Render failed")) });

    await expect(
      renderPageToCanvas(mockPage as never, mockCanvas, 1)
    ).rejects.toThrow("Render failed");
  });
});
