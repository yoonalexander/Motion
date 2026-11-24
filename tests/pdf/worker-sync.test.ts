import { execFileSync } from "node:child_process";
import path from "node:path";
import { describe, expect, it } from "vitest";

describe("PDF.js worker synchronization", () => {
  it("matches the installed worker from the pinned pdfjs-dist package", () => {
    expect(() =>
      execFileSync(process.execPath, [path.resolve("scripts/verify-pdf-worker.mjs")]),
    ).not.toThrow();
  });
});
