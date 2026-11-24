import { pathToFileURL } from "node:url";
import path from "node:path";
import { getDocument, GlobalWorkerOptions, type PDFDocumentProxy } from "pdfjs-dist";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { extractPageText, tokenToAnchor } from "@/lib/pdf/text-extractor";
import { bboxToViewportRect } from "@/lib/pdf/coordinates";
import { createGeometryPdf } from "../fixtures/pdf-geometry";

GlobalWorkerOptions.workerSrc = pathToFileURL(path.resolve("public/pdf.worker.mjs")).href;

describe("PDF.js text geometry on a cropped PDF", () => {
  let document: PDFDocumentProxy;

  beforeAll(async () => {
    document = await getDocument({ data: await createGeometryPdf() }).promise;
  });

  afterAll(async () => {
    await document?.destroy();
  });

  it("preserves glyph advance and baseline in unrotated crop space", async () => {
    for (const pageNumber of [1, 2, 3, 4]) {
      const page = await document.getPage(pageNumber);
      const { tokens, geometryDiagnostics } = await extractPageText(page, pageNumber);

      expect(geometryDiagnostics).toEqual([]);
      expect(tokens).toHaveLength(1);
      expect(tokens[0]).toMatchObject({
        str: "Ag",
        x: 0.2,
        y: 0.5,
        baselineEnd: [0.32, 0.5],
        width: 24,
      });
      const [left, bottom, right, top] = tokenToAnchor(tokens[0]).bbox;
      expect(left).toBeCloseTo(0.2);
      expect(right).toBeCloseTo(0.32);
      expect(bottom).toBeLessThan(0.5);
      expect(bottom).toBeGreaterThan(0.44);
      expect(top).toBeGreaterThan(0.6);
      expect(top).toBeLessThan(0.72);
    }
  });

  it.each([
    [1, 0, { left: 60, top: 57, width: 36, height: 25.5 }],
    [2, 90, { left: 67.5, top: 60, width: 25.5, height: 36 }],
    [3, 180, { left: 204, top: 67.5, width: 36, height: 25.5 }],
    [4, 270, { left: 57, top: 204, width: 25.5, height: 36 }],
  ])(
    "projects page %i at %i degrees into 150%% viewport pixels",
    async (pageNumber, rotation, expected) => {
      const page = await document.getPage(pageNumber);
      const viewport = page.getViewport({ scale: 1.5 });

      expect(viewport.rotation).toBe(rotation);
      // This anchor represents [70, 85, 94, 102] in the original PDF.
      expect(bboxToViewportRect([0.2, 0.45, 0.32, 0.62], viewport)).toEqual(expected);
    },
  );
});
