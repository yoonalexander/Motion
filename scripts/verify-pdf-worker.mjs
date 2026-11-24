import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const installedWorker = fileURLToPath(import.meta.resolve("pdfjs-dist/build/pdf.worker.mjs"));
const checkedInWorker = path.join(root, "public", "pdf.worker.mjs");
const [installedBytes, checkedInBytes] = await Promise.all([
  readFile(installedWorker),
  readFile(checkedInWorker),
]);

if (!installedBytes.equals(checkedInBytes)) {
  console.error(
    "public/pdf.worker.mjs does not match the pinned pdfjs-dist worker. Copy the installed build/pdf.worker.mjs into public/ and rerun this check.",
  );
  process.exitCode = 1;
}
