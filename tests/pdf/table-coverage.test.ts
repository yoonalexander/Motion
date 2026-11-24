import { readFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { expect, it } from "vitest";
import { getDocument, GlobalWorkerOptions } from "pdfjs-dist";
import {
  extractDocumentText,
  type ExtractedPage,
  type ExtractedToken,
} from "@/lib/pdf/text-extractor";
import { reconstructDocument, reconstructPage } from "@/lib/pdf/text-reconstructor";

GlobalWorkerOptions.workerSrc = pathToFileURL(path.resolve("public/pdf.worker.mjs")).href;

function statementPage(): ExtractedPage {
  const tokens: ExtractedToken[] = [];
  const row = (y: number, cells: [text: string, left: number, right: number][]) => {
    for (const [str, left, right] of cells) {
      tokens.push({
        str,
        page: 1,
        tokenId: `t${tokens.length}`,
        x: left,
        y,
        bbox: [left, y - 0.003, right, y + 0.009],
        width: (right - left) * 600,
        height: 9.6,
        hasEOL: false,
      });
    }
  };
  row(0.84, [
    ["Account overview", 0.06, 0.24],
    ["Statement", 0.7, 0.82],
  ]);
  row(0.81, [
    ["Account limit", 0.06, 0.2],
    ["5000.00", 0.75, 0.82],
  ]);
  row(0.74, [
    ["DATE", 0.06, 0.11],
    ["DESCRIPTION", 0.23, 0.42],
    ["AMOUNT", 0.75, 0.83],
  ]);
  row(0.71, [
    ["09/01", 0.06, 0.11],
    ["COFFEE SHOP", 0.23, 0.38],
    ["5.00", 0.78, 0.83],
  ]);
  row(0.68, [
    ["UNKNOWN ROW DATE", 0.23, 0.44],
    ["42.50", 0.77, 0.83],
  ]);
  row(0.65, [
    ["09/02", 0.06, 0.11],
    ["GROCERY", 0.23, 0.34],
    ["8.00", 0.78, 0.83],
  ]);
  row(0.62, [
    ["09/03", 0.06, 0.11],
    ["BOOK SHOP", 0.23, 0.37],
    ["21.50", 0.77, 0.83],
  ]);
  row(0.54, [
    ["Closing balance", 0.06, 0.23],
    ["120.00", 0.76, 0.83],
  ]);
  row(0.51, [
    ["Notes", 0.06, 0.12],
    ["Thank you", 0.7, 0.82],
  ]);
  return { page: 1, width: 600, height: 800, rotation: 0, tokens };
}

it("separates non-transaction sections and reports unverified coverage", () => {
  const page = statementPage();
  const reconstructed = reconstructPage(page);
  const tableLines = reconstructed.tables.flatMap(({ lineIds }) =>
    reconstructed.lines.filter(({ lineId }) => lineIds.includes(lineId)).map(({ str }) => str),
  );
  expect(tableLines).toEqual([
    "09/01 COFFEE SHOP 5.00",
    "09/02 GROCERY 8.00",
    "09/03 BOOK SHOP 21.50",
  ]);
  expect(reconstructed.suspectedUnmatchedLines).toEqual([
    {
      lineId: reconstructed.lines.find(({ str }) => str === "UNKNOWN ROW DATE 42.50")?.lineId,
      reason: "amount_in_transaction_region",
    },
  ]);
  expect(reconstructed.coverage).toEqual({
    tokensAssignedToLines: { assigned: page.tokens.length, extracted: page.tokens.length },
    transactionCandidates: { detected: 3, suspected: 4 },
    verifiedTransactions: null,
  });
});

it.each(["layout-a-text", "layout-b-text"])(
  "%s isolates the transactions from headers and balance controls",
  async (name) => {
    const bytes = await readFile(path.resolve("tests/fixtures/synthetic", `${name}.pdf`));
    const task = getDocument({ data: new Uint8Array(bytes) });
    try {
      const reconstructed = reconstructDocument(await extractDocumentText(await task.promise));
      expect(reconstructed.pages[0].tables.map(({ lineCount }) => lineCount)).toEqual([12]);
      expect(reconstructed.coverage.transactionCandidates).toEqual({ detected: 12, suspected: 12 });
      expect(reconstructed.coverage.verifiedTransactions).toBeNull();
    } finally {
      await task.destroy();
    }
  },
);
