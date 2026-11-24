import { readFile } from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { pathToFileURL } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import * as pdfjsLib from "pdfjs-dist";
import type { PDFDocumentProxy } from "pdfjs-dist";
import {
  extractDocumentText,
  parseDocumentCandidates,
  reconstructDocument,
  type ParsedCandidate,
  type ReconstructionResult,
} from "@/lib/pdf";

pdfjsLib.GlobalWorkerOptions.workerSrc = pathToFileURL(path.resolve("public/pdf.worker.mjs")).href;

const fixtureDir = path.resolve("tests/fixtures/synthetic");
const MAX_ANCHOR_CENTER_DELTA = 0.015;

interface GoldenMoney {
  amountMinor: string;
  currency: string;
  exponent: number;
}

interface GoldenTransaction {
  sourceRowId: string;
  transactionDate: string;
  postingDate?: string;
  rawDescription: string;
  transactionType: string;
  billedAmount: GoldenMoney;
  originalAmount?: GoldenMoney;
  sourceAnchor: { page: number; bbox: [number, number, number, number] };
}

interface GoldenFixture {
  schemaVersion: number;
  id: string;
  description: string;
  kind: "text" | "scanned";
  sourceFile: string;
  bankName: string;
  accountLabel: string;
  periodStart: string;
  periodEnd: string;
  currency: string;
  pageCount: number;
  transactions: GoldenTransaction[];
  controls: { transactionCount: number };
  sourceSha256?: string;
  provenance?: string;
}

interface FixtureDefinition {
  name: string;
  pdfFile: string;
  truthFile: string;
  expectedKind: "text" | "scanned";
}

type CriticalField =
  "transactionDate" | "postingDate" | "amountMinor" | "currency" | "transactionType";

interface GoldenExample {
  sourceRowId: string;
  page: number;
  field: CriticalField | "row";
  source: string;
  parsed: string | null;
}

interface GoldenReport {
  fixture: string;
  sourceSha256: string;
  pages: number;
  stageCounts: {
    pdfJsTokens: number;
    reconstructedLines: number;
    reconstructedCandidates: number;
    parsedCandidates: number;
    parsedTransactions: number;
    readyTransactions: number;
    reviewRequired: number;
    readyWithUnresolvedFields: number;
  };
  groundTruthRows: number;
  anchorAlignedRows: number;
  anchorAlignmentRate: number;
  missingRows: number;
  mergedRows: number;
  duplicateCandidates: number;
  falsePositiveCandidates: number;
  invalidSourceAnchors: number;
  criticalFieldMismatches: Record<CriticalField, number>;
  examples: GoldenExample[];
}

const FIXTURES: FixtureDefinition[] = [
  {
    name: "Maple signed-amount text layout",
    pdfFile: "layout-a-text.pdf",
    truthFile: "layout-a-text.json",
    expectedKind: "text",
  },
  {
    name: "Cedar two-date debit-credit text layout",
    pdfFile: "layout-b-text.pdf",
    truthFile: "layout-b-text.json",
    expectedKind: "text",
  },
  {
    name: "Motion four-page CAD text statement",
    pdfFile: "motion-synthetic-credit-card-statement.pdf",
    truthFile: "motion-synthetic-credit-card-statement.json",
    expectedKind: "text",
  },
  {
    name: "Harbour scanned no-text layout",
    pdfFile: "layout-c-scanned.pdf",
    truthFile: "layout-c-scanned.json",
    expectedKind: "scanned",
  },
];

const openDocuments: PDFDocumentProxy[] = [];

async function loadFixturePdf(pdfFile: string): Promise<{
  document: PDFDocumentProxy;
  bytes: Uint8Array;
}> {
  const buffer = await readFile(path.join(fixtureDir, pdfFile));
  const bytes = new Uint8Array(buffer);
  const task = pdfjsLib.getDocument({
    data: bytes.slice(),
    useWorker: false,
  } as unknown as Parameters<typeof pdfjsLib.getDocument>[0]);
  const document = await task.promise;
  openDocuments.push(document);
  return { document, bytes };
}

async function loadTruth(truthFile: string): Promise<GoldenFixture> {
  const json = await readFile(path.join(fixtureDir, truthFile), "utf8");
  return JSON.parse(json) as GoldenFixture;
}

function centerY(bbox: [number, number, number, number]): number {
  return (bbox[1] + bbox[3]) / 2;
}

function validAnchor(candidate: ParsedCandidate, pageCount: number): boolean {
  const [x0, y0, x1, y1] = candidate.bbox;
  return (
    Number.isInteger(candidate.page) &&
    candidate.page >= 1 &&
    candidate.page <= pageCount &&
    [x0, y0, x1, y1].every(Number.isFinite) &&
    x0 >= 0 &&
    y0 >= 0 &&
    x1 <= 1 &&
    y1 <= 1 &&
    x0 < x1 &&
    y0 < y1
  );
}

function rowHasExactMatch(
  truth: GoldenTransaction,
  candidate: ParsedCandidate,
): { exact: boolean; mismatches: CriticalField[]; examples: GoldenExample[] } {
  const transaction = candidate.transaction;
  const mismatches: CriticalField[] = [];
  const examples: GoldenExample[] = [];
  const compare = (field: CriticalField, expected: string, actual: string | null | undefined) => {
    if (actual !== expected) {
      mismatches.push(field);
      examples.push({
        sourceRowId: truth.sourceRowId,
        page: truth.sourceAnchor.page,
        field,
        source: expected,
        parsed: actual ?? null,
      });
    }
  };

  compare("transactionDate", truth.transactionDate, transaction?.transactionDate);
  if (truth.postingDate) {
    compare("postingDate", truth.postingDate, transaction?.postingDate);
  }
  compare("amountMinor", truth.billedAmount.amountMinor, transaction?.billedAmount.amountMinor);
  compare("currency", truth.billedAmount.currency, transaction?.billedAmount.currency);
  compare("transactionType", truth.transactionType, transaction?.transactionType);
  return { exact: mismatches.length === 0, mismatches, examples };
}

async function buildReport(
  fixture: FixtureDefinition,
  truth: GoldenFixture,
  bytes: Uint8Array,
  reconstruction: ReconstructionResult,
  parsed: ReturnType<typeof parseDocumentCandidates>,
  tokenCount: number,
): Promise<GoldenReport> {
  const candidates = parsed.candidates;
  const assigned = new Set<number>();
  const alignedTruth = new Set<number>();
  const mismatches: Record<CriticalField, number> = {
    transactionDate: 0,
    postingDate: 0,
    amountMinor: 0,
    currency: 0,
    transactionType: 0,
  };
  const examples: GoldenExample[] = [];
  let anchorAlignedRows = 0;
  let missingRows = 0;
  let mergedRows = 0;

  const pairs = truth.transactions
    .flatMap((expected, truthIndex) =>
      candidates.flatMap((candidate, candidateIndex) => {
        if (candidate.page !== expected.sourceAnchor.page) return [];
        return [
          {
            expected,
            truthIndex,
            candidate,
            candidateIndex,
            delta: Math.abs(centerY(candidate.bbox) - centerY(expected.sourceAnchor.bbox)),
          },
        ];
      }),
    )
    .sort((a, b) => a.delta - b.delta);
  const matchByTruth = new Map<number, (typeof pairs)[number]>();
  for (const pair of pairs) {
    if (pair.delta > MAX_ANCHOR_CENTER_DELTA) break;
    if (assigned.has(pair.candidateIndex) || alignedTruth.has(pair.truthIndex)) continue;
    assigned.add(pair.candidateIndex);
    alignedTruth.add(pair.truthIndex);
    matchByTruth.set(pair.truthIndex, pair);
  }

  truth.transactions.forEach((expected, truthIndex) => {
    const match = matchByTruth.get(truthIndex);
    if (!match) {
      missingRows++;
      const nearby = candidates.filter(
        (candidate) =>
          candidate.page === expected.sourceAnchor.page &&
          Math.abs(centerY(candidate.bbox) - centerY(expected.sourceAnchor.bbox)) <=
            MAX_ANCHOR_CENTER_DELTA,
      );
      if (nearby.length > 0) mergedRows++;
      mismatches.transactionDate++;
      if (expected.postingDate) mismatches.postingDate++;
      mismatches.amountMinor++;
      mismatches.currency++;
      mismatches.transactionType++;
      const closest = candidates
        .filter((candidate) => candidate.page === expected.sourceAnchor.page)
        .map((candidate) => ({
          candidate,
          delta: Math.abs(centerY(candidate.bbox) - centerY(expected.sourceAnchor.bbox)),
        }))
        .sort((a, b) => a.delta - b.delta)[0];
      examples.push({
        sourceRowId: expected.sourceRowId,
        page: expected.sourceAnchor.page,
        field: "row",
        source: `${expected.transactionDate} ${expected.rawDescription} ${expected.billedAmount.amountMinor}`,
        parsed: closest ? `delta=${closest.delta.toFixed(4)}: ${closest.candidate.str}` : null,
      });
      return;
    }

    anchorAlignedRows++;
    const result = rowHasExactMatch(expected, match.candidate);
    for (const field of result.mismatches) mismatches[field]++;
    examples.push(...result.examples);
  });
  const duplicateCandidates = candidates.filter(
    (candidate, index) =>
      !assigned.has(index) &&
      truth.transactions.some(
        (expected) =>
          expected.sourceAnchor.page === candidate.page &&
          Math.abs(centerY(candidate.bbox) - centerY(expected.sourceAnchor.bbox)) <=
            MAX_ANCHOR_CENTER_DELTA,
      ),
  ).length;
  const invalidSourceAnchors = candidates.filter(
    (candidate) => !validAnchor(candidate, truth.pageCount),
  ).length;
  const parsedTransactions = candidates.filter((candidate) => candidate.transaction);
  const readyTransactions = parsedTransactions.filter(
    (candidate) => candidate.transaction?.reviewStatus === "ready",
  ).length;
  const readyWithUnresolvedFields = candidates.filter((candidate) => {
    if (candidate.transaction?.reviewStatus !== "ready") return false;
    const transaction = candidate.transaction;
    return (
      !transaction.transactionDate ||
      !transaction.billedAmount.amountMinor ||
      !transaction.billedAmount.currency ||
      transaction.transactionType === "unknown" ||
      candidate.flags.some((flag) => String(flag).startsWith("ambiguous_")) ||
      (candidate.rawFields.dateLikeMatches.length > 1 && !transaction.postingDate)
    );
  }).length;
  const digest = createHash("sha256").update(bytes).digest("hex");

  return {
    fixture: fixture.pdfFile,
    sourceSha256: digest,
    pages: reconstruction.pageCount,
    stageCounts: {
      pdfJsTokens: tokenCount,
      reconstructedLines: reconstruction.totalLines,
      reconstructedCandidates: reconstruction.totalCandidates,
      parsedCandidates: candidates.length,
      parsedTransactions: parsedTransactions.length,
      readyTransactions,
      reviewRequired: candidates.length - readyTransactions,
      readyWithUnresolvedFields,
    },
    groundTruthRows: truth.transactions.length,
    anchorAlignedRows,
    anchorAlignmentRate: Number((anchorAlignedRows / truth.transactions.length).toFixed(4)),
    missingRows,
    mergedRows,
    duplicateCandidates,
    falsePositiveCandidates: candidates.length - assigned.size - duplicateCandidates,
    invalidSourceAnchors,
    criticalFieldMismatches: mismatches,
    examples: examples.slice(0, 12),
  };
}

afterAll(async () => {
  await Promise.all(openDocuments.map((document) => document.destroy()));
});

describe("NEI-006 real-PDF golden regression pipeline", () => {
  it("reports strict one-to-one transaction and critical-field correctness", async () => {
    const reports: GoldenReport[] = [];

    for (const fixture of FIXTURES.filter((item) => item.expectedKind === "text")) {
      const truth = await loadTruth(fixture.truthFile);
      const { document, bytes } = await loadFixturePdf(fixture.pdfFile);
      const sourceHash = createHash("sha256").update(bytes).digest("hex");
      if (truth.sourceSha256) expect(sourceHash).toBe(truth.sourceSha256);

      // These inputs give the parser verified statement context. Maple and
      // Cedar date-order resolution is exercised by the downstream issue #2
      // update; until then, ambiguous source dates remain visible as failures.
      const extraction = await extractDocumentText(document);
      const reconstruction = reconstructDocument(extraction);
      const parsed = parseDocumentCandidates(reconstruction, {
        periodStart: truth.periodStart,
        periodEnd: truth.periodEnd,
        currency: truth.currency,
        bankName: truth.bankName,
        accountLabel: truth.accountLabel,
      });
      const report = await buildReport(
        fixture,
        truth,
        bytes,
        reconstruction,
        parsed,
        extraction.totalTokens,
      );
      reports.push(report);
      console.info("[pdf-golden-report]", JSON.stringify(report));
      expect(extraction.pageCount, fixture.name).toBe(truth.pageCount);
      expect(extraction.hasExtractableText, fixture.name).toBe(true);
      expect(reconstruction.pageCount, fixture.name).toBe(truth.pageCount);
    }

    expect(reports).toHaveLength(3);
    for (const report of reports) {
      expect(report.stageCounts.parsedCandidates, report.fixture).toBe(
        report.stageCounts.reconstructedCandidates,
      );
      expect(report.groundTruthRows, report.fixture).toBe(
        report.fixture === "layout-a-text.pdf" || report.fixture === "layout-b-text.pdf" ? 12 : 60,
      );
      expect(report.anchorAlignedRows, report.fixture).toBe(report.groundTruthRows);
      expect(report.missingRows, report.fixture).toBe(0);
      expect(report.mergedRows, report.fixture).toBe(0);
      expect(report.duplicateCandidates, report.fixture).toBe(0);
      expect(report.falsePositiveCandidates, report.fixture).toBe(0);
      expect(report.invalidSourceAnchors, report.fixture).toBe(0);
      expect(report.stageCounts.readyWithUnresolvedFields, report.fixture).toBe(0);
      expect(Object.values(report.criticalFieldMismatches), report.fixture).toEqual([
        0, 0, 0, 0, 0,
      ]);
    }
  });

  it("detects the scanned Harbour PDF as having no embedded text", async () => {
    const fixture = FIXTURES.find((item) => item.expectedKind === "scanned");
    if (!fixture) throw new Error("Scanned fixture is missing");
    const truth = await loadTruth(fixture.truthFile);
    const { document } = await loadFixturePdf(fixture.pdfFile);
    const extraction = await extractDocumentText(document);

    expect(document.numPages).toBe(truth.pageCount);
    expect(extraction.pageCount).toBe(truth.pageCount);
    expect(extraction.hasExtractableText).toBe(false);
    expect(extraction.totalTokens).toBe(0);
    expect(extraction.pages.every((page) => page.tokens.length === 0)).toBe(true);
  });
});
