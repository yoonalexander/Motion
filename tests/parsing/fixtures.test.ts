import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { statementFixtureSchema, type StatementFixture } from "@/schemas/statement";

const fixtureDir = path.resolve("tests/fixtures/synthetic");

type LoadedFixture = {
  jsonFile: string;
  fixture: StatementFixture;
};

let fixtures: LoadedFixture[] = [];

async function loadFixtures(): Promise<LoadedFixture[]> {
  const files = (await readdir(fixtureDir)).filter((file) => file.endsWith(".json")).sort();

  return Promise.all(
    files.map(async (file) => {
      const contents = await readFile(path.join(fixtureDir, file), "utf8");
      return {
        jsonFile: file,
        fixture: statementFixtureSchema.parse(JSON.parse(contents)),
      };
    }),
  );
}

beforeAll(async () => {
  fixtures = await loadFixtures();
});

describe("synthetic statement fixtures", () => {
  it("ships three structurally different fixtures including one scanned rendition", () => {
    expect(fixtures).toHaveLength(3);
    expect(fixtures.filter(({ fixture }) => fixture.kind === "text")).toHaveLength(2);
    expect(fixtures.filter(({ fixture }) => fixture.kind === "scanned")).toHaveLength(1);
    expect(new Set(fixtures.map(({ fixture }) => fixture.bankName)).size).toBe(3);
  });

  it("loads ground-truth transaction metadata and normalized anchors", () => {
    for (const { fixture } of fixtures) {
      expect(fixture.transactions.length).toBeGreaterThanOrEqual(10);
      expect(fixture.controls.transactionCount).toBe(fixture.transactions.length);

      for (const transaction of fixture.transactions) {
        expect(transaction.billedAmount.currency).toBe(fixture.currency);
        expect(transaction.sourceAnchor.page).toBeLessThanOrEqual(fixture.pageCount);

        const [x0, y0, x1, y1] = transaction.sourceAnchor.bbox;
        expect(x0).toBeGreaterThanOrEqual(0);
        expect(y0).toBeGreaterThanOrEqual(0);
        expect(x1).toBeLessThanOrEqual(1);
        expect(y1).toBeLessThanOrEqual(1);
        expect(x0).toBeLessThan(x1);
        expect(y0).toBeLessThan(y1);
      }
    }
  });

  it("matches each ground-truth hash to the committed PDF bytes", async () => {
    for (const { fixture } of fixtures) {
      const bytes = await readFile(path.join(fixtureDir, fixture.sourceFile));
      const hash = createHash("sha256").update(bytes).digest("hex");
      expect(hash).toBe(fixture.statementHash);
    }
  });

  it("covers purchases, refunds, payments, fees, and interest", () => {
    const types = new Set(
      fixtures.flatMap(({ fixture }) => fixture.transactions.map((item) => item.transactionType)),
    );

    expect([...types]).toEqual(
      expect.arrayContaining(["purchase", "refund", "payment", "fee", "interest"]),
    );
  });
});
