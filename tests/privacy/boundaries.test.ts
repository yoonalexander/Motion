import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";

const apiRoot = path.resolve("app/api");
const forbiddenPatterns = [
  /@\/lib\/pdf(?:[/"']|$)/,
  /@\/lib\/ocr(?:[/"']|$)/,
  /@\/workers\//,
  /from\s+["']pdfjs-dist/,
  /from\s+["']tesseract\.js/,
];

async function collectFiles(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = await Promise.all(
    entries.map((entry) => {
      const fullPath = path.join(directory, entry.name);
      return entry.isDirectory() ? collectFiles(fullPath) : Promise.resolve([fullPath]);
    }),
  );

  return files.flat();
}

describe("browser/server boundaries", () => {
  it("keeps browser-only PDF and OCR modules out of API routes", async () => {
    const files = (await collectFiles(apiRoot)).filter((file) => /\.(ts|tsx)$/.test(file));
    const violations: string[] = [];

    for (const file of files) {
      const source = await readFile(file, "utf8");
      for (const pattern of forbiddenPatterns) {
        if (pattern.test(source)) {
          violations.push(`${path.relative(process.cwd(), file)} matches ${pattern}`);
        }
      }
    }

    expect(violations).toEqual([]);
  });

  it("marks PDF and OCR entrypoints as client-only", async () => {
    for (const file of ["lib/pdf/index.ts", "lib/ocr/index.ts"]) {
      const source = await readFile(path.resolve(file), "utf8");
      expect(source).toContain('import "client-only";');
    }
  });

  it("keeps the environment example free of secret values", async () => {
    const example = await readFile(path.resolve(".env.example"), "utf8");
    const assignments = example
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line.length > 0 && !line.startsWith("#"));

    for (const assignment of assignments) {
      const [key, ...valueParts] = assignment.split("=");
      if (/(SECRET|TOKEN|PASSWORD|API_KEY|CLIENT_SECRET)/i.test(key)) {
        expect(valueParts.join("="), `${key} must stay blank in .env.example`).toBe("");
      }
    }
  });

  it("ignores local and private financial fixture paths", async () => {
    const ignoreFile = await readFile(path.resolve(".gitignore"), "utf8");
    expect(ignoreFile).toContain("/tests/fixtures/private/");
    expect(ignoreFile).toContain("*.private.pdf");
  });
});
