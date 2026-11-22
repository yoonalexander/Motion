// workers/pdf.worker.ts
// PDF.js worker entrypoint.
// The actual worker script served to the browser is public/pdf.worker.mjs
// (a copy of pdfjs-dist's pre-built worker).
// This TypeScript file serves as the entrypoint for future custom worker logic.
// All PDF processing remains browser-local (SDD §6.2).
// See docs/motion-design.md §7.1.
import "client-only";

export type { PDFDocumentProxy, PDFPageProxy } from "pdfjs-dist";
