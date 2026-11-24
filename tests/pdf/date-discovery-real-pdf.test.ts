import { readFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import * as pdfjsLib from "pdfjs-dist";
import type { PDFDocumentProxy } from "pdfjs-dist";
import { extractDocumentText, findDateSpans, reconstructDocument } from "@/lib/pdf";

pdfjsLib.GlobalWorkerOptions.workerSrc = pathToFileURL(path.resolve("public/pdf.worker.mjs")).href;

describe("yearless date discovery in the Motion synthetic PDF", () => {
  let document: PDFDocumentProxy;

  beforeAll(async () => {
    const bytes = await readFile(
      path.resolve("tests/fixtures/synthetic/motion-synthetic-credit-card-statement.pdf"),
    );
    const data = new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const loadingTask = pdfjsLib.getDocument({
      data,
      useWorker: false,
    } as unknown as Parameters<typeof pdfjsLib.getDocument>[0]);
    document = await loadingTask.promise;
  });

  afterAll(async () => {
    if (document) await document.destroy();
  });

  it("discovers transaction candidates with yearless date spans", async () => {
    const extraction = await extractDocumentText(document);
    const reconstructed = reconstructDocument(extraction);
    const spans = reconstructed.pages
      .flatMap((page) => page.candidates)
      .flatMap((candidate) => findDateSpans(candidate.str));

    expect(spans.some((span) => !span.hasExplicitYear)).toBe(true);
  });
});
