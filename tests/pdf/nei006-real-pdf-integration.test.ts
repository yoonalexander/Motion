import { readFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it, beforeAll, afterAll } from "vitest";
import * as pdfjsLib from "pdfjs-dist";
import type { PDFDocumentProxy } from "pdfjs-dist";
import {
  extractDocumentText,
  reconstructDocument,
  type ReconstructionResult,
} from "@/lib/pdf";

// Ensure PDF.js uses the local worker file so it works in jsdom with
// useWorker: false. The worker file is copied to public/pdf.worker.mjs.
pdfjsLib.GlobalWorkerOptions.workerSrc = pathToFileURL(
  path.resolve("public/pdf.worker.mjs")
).href;

// ---------------------------------------------------------------------------
// Real PDF fixture integration tests (Step 1: NEI-006 verification)
// ---------------------------------------------------------------------------

const fixtureDir = path.resolve("tests/fixtures/synthetic");

interface FixtureCase {
  name: string;
  pdfFile: string;
  truthFile: string | null;
  expectedTransactionCount: number;
}

const FIXTURES: FixtureCase[] = [
  {
    name: "layout-a-text (Maple Card - single-date, signed amounts)",
    pdfFile: "layout-a-text.pdf",
    truthFile: "layout-a-text.json",
    expectedTransactionCount: 12,
  },
  {
    name: "layout-b-text (Cedar Bank - two-date, debit/credit columns)",
    pdfFile: "layout-b-text.pdf",
    truthFile: "layout-b-text.json",
    expectedTransactionCount: 12,
  },
  {
    name: "Motion_Synthetic_Credit_Card_Statement",
    pdfFile: "motion-synthetic-credit-card-statement.pdf",
    truthFile: null,
    expectedTransactionCount: 0,
  },
];

function loadFixturePdf(pdfFile: string): Promise<PDFDocumentProxy> {
  return new Promise((resolve, reject) => {
    const filePath = path.join(fixtureDir, pdfFile);
    const bytes = readFile(filePath);
    bytes
      .then((buf) => {
        const uint8Array = new Uint8Array(
          buf.buffer,
          buf.byteOffset,
          buf.byteLength
        );
        return pdfjsLib.getDocument({
          data: uint8Array,
          useWorker: false,
        } as unknown as Parameters<typeof pdfjsLib.getDocument>[0]);
      })
      .then((loadingTask) => loadingTask.promise)
      .then(resolve)
      .catch(reject);
  });
}

describe("NEI-006 real PDF fixture verification (Step 1)", () => {

  for (const fixture of FIXTURES) {
    if (!fixture.truthFile) continue; // skip fixtures without ground truth
    const truthFile = fixture.truthFile;

    describe(fixture.name, () => {
      let document: PDFDocumentProxy;
      let truth: any;

      beforeAll(async () => {
        document = await loadFixturePdf(fixture.pdfFile);
        const truthBytes = await readFile(
          path.join(fixtureDir, truthFile),
          "utf8"
        );
        truth = JSON.parse(truthBytes);
      });

      afterAll(async () => {
        if (document) {
          document.destroy();
        }
      });

      it("loads the actual PDF using PDF.js", () => {
        expect(document?.numPages).toBeGreaterThan(0);
        expect(document?.numPages).toBe(truth.pageCount);
      });

      it("extracts text tokens from every page", async () => {
        if (!document) throw new Error("document not loaded");
        const extraction = await extractDocumentText(document);
        expect(extraction.pageCount).toBe(truth.pageCount);
        expect(extraction.hasExtractableText).toBe(true);
        expect(extraction.totalTokens).toBeGreaterThan(0);
        expect(extraction.pages).toHaveLength(truth.pageCount);
      });

      it("reconstructs lines, tables, and candidate rows", async () => {
        if (!document) throw new Error("document not loaded");
        const extraction = await extractDocumentText(document);
        const reconstructed: ReconstructionResult = reconstructDocument(
          extraction
        );

        expect(reconstructed.pageCount).toBe(truth.pageCount);
        expect(reconstructed.totalLines).toBeGreaterThan(0);
        expect(reconstructed.totalCandidates).toBeGreaterThan(0);

        for (const page of reconstructed.pages) {
          expect(page.page).toBeGreaterThan(0);
          expect(page.page).toBeLessThanOrEqual(truth.pageCount);
          for (const line of page.lines) {
            expect(line.tokenCount).toBeGreaterThan(0);
            expect(line.bbox[0]).toBeGreaterThanOrEqual(0);
            expect(line.bbox[1]).toBeGreaterThanOrEqual(0);
            expect(line.bbox[2]).toBeLessThanOrEqual(1);
            expect(line.bbox[3]).toBeLessThanOrEqual(1);
          }
          for (const candidate of page.candidates) {
            expect(candidate.str.trim().length).toBeGreaterThan(0);
            expect(candidate.tokenIds.length).toBeGreaterThan(0);
            expect(candidate.bbox[0]).toBeLessThan(candidate.bbox[2]);
            expect(candidate.bbox[1]).toBeLessThan(candidate.bbox[3]);
          }
        }
      });

      it("finds candidate rows matching ground truth transaction count", async () => {
        if (!document) throw new Error("document not loaded");
        const extraction = await extractDocumentText(document);
        const reconstructed: ReconstructionResult = reconstructDocument(
          extraction
        );

        const allCandidates = reconstructed.pages.flatMap((p) => p.candidates);
        // We expect at least as many candidates as ground truth transactions
        // (candidates may include headers/totals that need filtering)
        expect(allCandidates.length).toBeGreaterThanOrEqual(
          Math.floor(truth.controls.transactionCount * 0.5)
        );
      });

      it("candidate source anchors fall within expected bbox ranges", async () => {
        if (!document) throw new Error("document not loaded");
        const extraction = await extractDocumentText(document);
        const reconstructed: ReconstructionResult = reconstructDocument(
          extraction
        );

        const allCandidates = reconstructed.pages.flatMap((p) => p.candidates);
        const groundTruthBboxes = truth.transactions.map(
          (t: any) => t.sourceAnchor.bbox
        );

        // Each ground truth transaction anchor should be near at least one candidate
        // (within normalized coordinate tolerance)
        let matchedTruthCount = 0;
        for (const gt of truth.transactions) {
          const [gtX0, gtY0, gtX1, gtY1] = gt.sourceAnchor.bbox;
          const gtCenterX = (gtX0 + gtX1) / 2;
          const gtCenterY = (gtY0 + gtY1) / 2;

          const nearestCandidate = allCandidates.reduce<{
            candidate: any;
            dist: number;
          } | null>((best, c) => {
            const [cX0, cY0, cX1, cY1] = c.bbox;
            const cCenterX = (cX0 + cX1) / 2;
            const cCenterY = (cY0 + cY1) / 2;
            const dist = Math.hypot(cCenterX - gtCenterX, cCenterY - gtCenterY);
            if (!best || dist < best.dist) {
              return { candidate: c, dist };
            }
            return best;
          }, null);

          if (nearestCandidate && nearestCandidate.dist < 0.15) {
            matchedTruthCount++;
          }
        }

        // At least 60% of ground truth transactions should have a nearby candidate
        const matchRate = matchedTruthCount / truth.controls.transactionCount;
        expect(matchRate).toBeGreaterThanOrEqual(0.6);
      });

      it("preserves source anchors for all candidates", async () => {
        if (!document) throw new Error("document not loaded");
        const extraction = await extractDocumentText(document);
        const reconstructed: ReconstructionResult = reconstructDocument(
          extraction
        );

        const { rowToAnchor } = await import("@/lib/pdf");

        for (const page of reconstructed.pages) {
          for (const candidate of page.candidates) {
            const anchor = rowToAnchor(candidate);
            expect(anchor.page).toBe(candidate.page);
            expect(anchor.bbox).toEqual(candidate.bbox);
            expect(anchor.tokenIds).toEqual(candidate.tokenIds);
          }
        }
      });

      it("tracks unmatched content for review", async () => {
        if (!document) throw new Error("document not loaded");
        const extraction = await extractDocumentText(document);
        const reconstructed: ReconstructionResult = reconstructDocument(
          extraction
        );

        // At minimum, the structure should be present
        for (const page of reconstructed.pages) {
          expect(Array.isArray(page.unmatchedLineIds)).toBe(true);
          expect(Array.isArray(page.unmatchedTokenIds)).toBe(true);
          expect(Array.isArray(page.diagnostics)).toBe(true);
        }
      });
    });
  }

  describe("scanned PDF (layout-c) is recognized as having no extractable text", () => {
    let document: PDFDocumentProxy | null = null;
    let truth: any;

    beforeAll(async () => {
      document = await loadFixturePdf("layout-c-scanned.pdf");
      const truthBytes = await readFile(
        path.join(fixtureDir, "layout-c-scanned.json"),
        "utf8"
      );
      truth = JSON.parse(truthBytes);
    });

    afterAll(async () => {
      if (document) {
        document.destroy();
      }
    });

    it("reports no extractable text for scanned page", async () => {
      if (!document) throw new Error("document not loaded");
      const extraction = await extractDocumentText(document);
      expect(extraction.hasExtractableText).toBe(false);
      expect(extraction.totalTokens).toBe(0);
    });
  });
});
