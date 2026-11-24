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
  type StatementContext,
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
  /** Signed value exactly as printed; omitted where the source has magnitude/columns only. */
  printedAmountMinor?: string;
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
  periodVerified: boolean;
  dateOrder?: "MDY" | "DMY";
  positiveAmountDirection?: "debit" | "credit";
  amountDirectionSource?: "debit_credit_columns";
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
  context: {
    periodVerified: true;
    dateOrder: "MDY" | "DMY";
    positiveAmountDirection?: "debit" | "credit";
    amountDirectionSource: "signed_amount_column" | "debit_credit_columns";
    truthAmountsAreSigned: boolean;
  };
}

type CriticalField =
  | "transactionDate"
  | "postingDate"
  | "amountMinor"
  | "currency"
  | "transactionType"
  | "billedExponent"
  | "merchantText"
  | "originalAmountMinor"
  | "originalCurrency"
  | "originalExponent"
  | "amountDirection"
  | "printedSign"
  | "sourceAnchor";

type GoldenParserContext = StatementContext;

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
  fullyCorrectMatchedRows: number;
  fullyCorrectMatchedRate: number;
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
    context: {
      periodVerified: true,
      dateOrder: "MDY",
      positiveAmountDirection: "credit",
      amountDirectionSource: "signed_amount_column",
      truthAmountsAreSigned: false,
    },
  },
  {
    name: "Cedar two-date debit-credit text layout",
    pdfFile: "layout-b-text.pdf",
    truthFile: "layout-b-text.json",
    expectedKind: "text",
    context: {
      periodVerified: true,
      dateOrder: "DMY",
      amountDirectionSource: "debit_credit_columns",
      truthAmountsAreSigned: false,
    },
  },
  {
    name: "Motion four-page CAD text statement",
    pdfFile: "motion-synthetic-credit-card-statement.pdf",
    truthFile: "motion-synthetic-credit-card-statement.json",
    expectedKind: "text",
    context: {
      periodVerified: true,
      dateOrder: "MDY",
      positiveAmountDirection: "debit",
      amountDirectionSource: "signed_amount_column",
      truthAmountsAreSigned: true,
    },
  },
  {
    name: "Harbour scanned no-text layout",
    pdfFile: "layout-c-scanned.pdf",
    truthFile: "layout-c-scanned.json",
    expectedKind: "scanned",
    context: {
      periodVerified: true,
      dateOrder: "MDY",
      positiveAmountDirection: "debit",
      amountDirectionSource: "signed_amount_column",
      truthAmountsAreSigned: true,
    },
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
  fixtureDefinition: FixtureDefinition,
): { exact: boolean; mismatches: CriticalField[]; examples: GoldenExample[] } {
  const transaction = candidate.transaction;
  const mismatches: CriticalField[] = [];
  const examples: GoldenExample[] = [];
  const compare = (
    field: CriticalField,
    expected: string | null,
    actual: string | null | undefined,
  ) => {
    if (actual !== expected) {
      mismatches.push(field);
      examples.push({
        sourceRowId: truth.sourceRowId,
        page: truth.sourceAnchor.page,
        field,
        source: expected ?? "<none>",
        parsed: actual ?? null,
      });
    }
  };

  compare("transactionDate", truth.transactionDate, transaction?.transactionDate);
  compare("postingDate", truth.postingDate ?? null, transaction?.postingDate ?? null);
  const expectedMagnitude = BigInt(truth.printedAmountMinor ?? truth.billedAmount.amountMinor);
  compare(
    "amountMinor",
    (expectedMagnitude < 0n ? -expectedMagnitude : expectedMagnitude).toString(),
    transaction?.billedAmount.amountMinor,
  );
  compare("currency", truth.billedAmount.currency, transaction?.billedAmount.currency);
  compare("transactionType", truth.transactionType, transaction?.transactionType);
  compare(
    "amountDirection",
    expectedAmountDirection(truth, fixtureDefinition),
    candidate.resolution === "validated" ? candidate.transaction.direction : null,
  );
  const expectedSign = expectedPrintedSign(truth, fixtureDefinition);
  if (expectedSign) {
    compare(
      "printedSign",
      expectedSign,
      candidate.rawFields.amountSignNegative ? "negative" : "positive",
    );
  }
  const actualAnchor = transaction?.sourceAnchor
    ? JSON.stringify([
        transaction.sourceAnchor.page,
        transaction.sourceAnchor.bbox,
        transaction.sourceAnchor.tokenIds ?? [],
      ])
    : null;
  const normalizedExpectedAnchor = JSON.stringify([
    candidate.page,
    candidate.bbox,
    candidate.tokenIds,
  ]);
  compare("sourceAnchor", normalizedExpectedAnchor, actualAnchor);
  compare(
    "billedExponent",
    String(truth.billedAmount.exponent),
    transaction?.billedAmount.exponent === undefined
      ? undefined
      : String(transaction.billedAmount.exponent),
  );
  compare(
    "merchantText",
    normalizeMerchant(truth.rawDescription),
    transaction?.rawDescription ? normalizeMerchant(transaction.rawDescription) : undefined,
  );
  if (truth.originalAmount) {
    compare(
      "originalAmountMinor",
      truth.originalAmount.amountMinor,
      transaction?.originalAmount?.amountMinor,
    );
    compare(
      "originalCurrency",
      truth.originalAmount.currency,
      transaction?.originalAmount?.currency,
    );
    compare(
      "originalExponent",
      String(truth.originalAmount.exponent),
      transaction?.originalAmount?.exponent === undefined
        ? undefined
        : String(transaction.originalAmount.exponent),
    );
  }
  return { exact: mismatches.length === 0, mismatches, examples };
}

function expectedAmountDirection(
  transaction: GoldenTransaction,
  fixtureDefinition: FixtureDefinition,
): "debit" | "credit" {
  if (fixtureDefinition.context.amountDirectionSource === "debit_credit_columns") {
    return ["refund", "payment", "deposit"].includes(transaction.transactionType)
      ? "credit"
      : "debit";
  }
  const positiveDirection = fixtureDefinition.context.positiveAmountDirection;
  if (!positiveDirection) {
    throw new Error(`${transaction.sourceRowId} is missing its printed sign convention`);
  }
  if (!fixtureDefinition.context.truthAmountsAreSigned) {
    return ["refund", "payment", "deposit"].includes(transaction.transactionType)
      ? "credit"
      : "debit";
  }
  return BigInt(transaction.printedAmountMinor ?? transaction.billedAmount.amountMinor) < 0n
    ? positiveDirection === "debit"
      ? "credit"
      : "debit"
    : positiveDirection;
}

function expectedPrintedSign(
  transaction: GoldenTransaction,
  fixture: FixtureDefinition,
): "negative" | "positive" | null {
  if (fixture.context.amountDirectionSource === "debit_credit_columns") return null;
  if (fixture.context.truthAmountsAreSigned && transaction.printedAmountMinor) {
    return BigInt(transaction.printedAmountMinor) < 0n ? "negative" : "positive";
  }
  const positiveDirection = fixture.context.positiveAmountDirection;
  if (!positiveDirection) return null;
  return expectedAmountDirection(transaction, fixture) === positiveDirection
    ? "positive"
    : "negative";
}

function normalizeMerchant(value: string): string {
  return value.trim().replace(/\s+/g, " ");
}

function makeVerifiedContext(
  fixture: FixtureDefinition,
  truth: GoldenFixture,
): GoldenParserContext {
  if (fixture.context.periodVerified !== true || !fixture.context.dateOrder) {
    throw new Error(`${fixture.name} is missing verified date context`);
  }
  if (
    fixture.context.amountDirectionSource === "signed_amount_column" &&
    !fixture.context.positiveAmountDirection
  ) {
    throw new Error(`${fixture.name} is missing a verified signed-amount convention`);
  }
  if (truth.periodStart > truth.periodEnd || !truth.currency) {
    throw new Error(`${fixture.name} ground truth has invalid statement context`);
  }
  if (
    truth.periodVerified !== undefined &&
    truth.periodVerified !== fixture.context.periodVerified
  ) {
    throw new Error(`${fixture.name} context does not match its source truth`);
  }
  if (truth.dateOrder !== undefined && truth.dateOrder !== fixture.context.dateOrder) {
    throw new Error(`${fixture.name} date order disagrees with its source truth`);
  }
  if (
    truth.positiveAmountDirection !== undefined &&
    truth.positiveAmountDirection !== fixture.context.positiveAmountDirection
  ) {
    throw new Error(`${fixture.name} signed amount convention disagrees with its source truth`);
  }

  const common: GoldenParserContext = {
    periodStart: truth.periodStart,
    periodEnd: truth.periodEnd,
    periodVerified: fixture.context.periodVerified,
    dateOrder: fixture.context.dateOrder,
    currency: truth.currency,
    bankName: truth.bankName,
    accountLabel: truth.accountLabel,
    positiveAmountDirection: fixture.context.positiveAmountDirection,
  };
  return common;
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
    billedExponent: 0,
    merchantText: 0,
    originalAmountMinor: 0,
    originalCurrency: 0,
    originalExponent: 0,
    amountDirection: 0,
    printedSign: 0,
    sourceAnchor: 0,
  };
  const examples: GoldenExample[] = [];
  let anchorAlignedRows = 0;
  let fullyCorrectMatchedRows = 0;
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
      const missingFields: CriticalField[] = [
        "transactionDate",
        "amountMinor",
        "currency",
        "transactionType",
        "amountDirection",
        "sourceAnchor",
        "billedExponent",
        "merchantText",
      ];
      if (expectedPrintedSign(expected, fixture)) missingFields.push("printedSign");
      if (expected.postingDate) missingFields.push("postingDate");
      if (expected.originalAmount) {
        missingFields.push("originalAmountMinor", "originalCurrency", "originalExponent");
      }
      for (const field of missingFields) mismatches[field]++;
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
    const result = rowHasExactMatch(expected, match.candidate, fixture);
    if (result.exact) fullyCorrectMatchedRows++;
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
    if (candidate.resolution !== "validated") return false;
    const transaction = candidate.transaction;
    return (
      !transaction.transactionDate ||
      !transaction.billedAmount.amountMinor ||
      !transaction.billedAmount.currency ||
      !transaction.direction ||
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
    fullyCorrectMatchedRows,
    fullyCorrectMatchedRate: Number(
      (fullyCorrectMatchedRows / truth.transactions.length).toFixed(4),
    ),
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

      const extraction = await extractDocumentText(document);
      const reconstruction = reconstructDocument(extraction);
      const context = makeVerifiedContext(fixture, truth);
      const parsed = parseDocumentCandidates(reconstruction, context);
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
      expect(report.fullyCorrectMatchedRows, report.fixture).toBe(report.groundTruthRows);
      expect(report.fullyCorrectMatchedRate, report.fixture).toBe(1);
      expect(report.missingRows, report.fixture).toBe(0);
      expect(report.mergedRows, report.fixture).toBe(0);
      expect(report.duplicateCandidates, report.fixture).toBe(0);
      expect(report.falsePositiveCandidates, report.fixture).toBe(0);
      expect(report.invalidSourceAnchors, report.fixture).toBe(0);
      expect(report.stageCounts.readyWithUnresolvedFields, report.fixture).toBe(0);
      expect(Object.values(report.criticalFieldMismatches), report.fixture).toEqual(
        Array(Object.keys(report.criticalFieldMismatches).length).fill(0),
      );
    }
  });

  it("keeps real PDF rows unresolved without verified statement and direction context", async () => {
    const fixture = FIXTURES.find((item) => item.pdfFile === "layout-a-text.pdf");
    if (!fixture) throw new Error("Maple text fixture is missing");
    const truth = await loadTruth(fixture.truthFile);
    const { document } = await loadFixturePdf(fixture.pdfFile);
    const extraction = await extractDocumentText(document);
    const reconstruction = reconstructDocument(extraction);
    const parsed = parseDocumentCandidates(reconstruction, {});

    expect(parsed.candidates).toHaveLength(truth.transactions.length);
    expect(parsed.candidates.every((candidate) => candidate.resolution === "unresolved")).toBe(
      true,
    );
    expect(parsed.candidates.every((candidate) => candidate.status !== "successfully_parsed")).toBe(
      true,
    );
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
