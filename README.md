# Notion Expense Importer

A free-first, privacy-conscious, browser-first web app that turns credit card statement PDFs into accurate, categorized Notion transactions, makes extraction failures easy to find, and minimizes monthly manual data entry.

## Status

**Phase 0 complete (foundations).** The repository now has a Next.js App Router + TypeScript + Tailwind application shell, lint/format/typecheck tooling, Vitest and Playwright coverage, CI with secret scanning, Zod transaction/statement schemas, three synthetic PDF fixtures, and a mock Notion workspace. PDF extraction and the review UI begin in Phase 1.

## Planned capabilities

- Upload one PDF statement per session and process text-native or scanned documents locally in the browser.
- Extract transaction date, description, amount, direction, and currency, with links back to the source PDF region.
- Highlight unmatched or uncertain PDF regions so missing transactions are easy to find.
- Reconcile extracted rows against statement totals and balances where trustworthy controls exist.
- Categorize using Notion categories, prior Notion entries, and local rules, with optional privacy-gated Gemini hints.
- Detect exact and probable duplicates, auto-skipping only very high-confidence repeats.
- Review exceptions before any write and commit approved transactions in retry-safe chunks.
- Preview and undo imports using batch metadata stored in Notion.

## Design principles

- **Notion is the sole ledger.** The app does not persist PDFs, transaction history, or a parallel finance database; only encrypted Notion connection and session settings are stored server-side.
- **Local-first extraction.** PDF bytes, page images, OCR text, and working rows stay in browser memory. Only approved structured transactions cross to the backend and Notion.
- **Financial correctness over guessing.** Amounts use integer minor units; ambiguous rows and reconciliation failures are surfaced, never silently committed.
- **Free-first.** No mandatory paid service is required for the local single-user experience. Gemini is optional and can be disabled without breaking imports.
- **Strict AI boundary.** Free-tier Gemini may only receive sanitized, nonsensitive generic merchant labels through a server-side privacy gate.

## Planned stack

| Area           | Choice                                           |
| -------------- | ------------------------------------------------ |
| Application    | Next.js App Router, TypeScript, Tailwind CSS     |
| Validation     | Zod                                              |
| PDF processing | PDF.js (`pdfjs-dist`)                            |
| OCR            | Tesseract.js in a browser worker                 |
| Testing        | Vitest, Playwright, fixture-based golden tests   |
| Notion         | Official SDK or REST API, pinned to `2026-03-11` |
| AI (optional)  | Gemini via a guarded server route                |

## Documentation

- [Software design document](docs/motion-design.md) — authoritative requirements, architecture, data model, and privacy/security rules.
- [Development roadmap](docs/motion-roadmap.md) — phases, acceptance gates, and initial implementation tickets.
- [Agent instructions](AGENTS.md) — repository constraints and working conventions for coding agents.

## Getting started

Requires Node.js 22.13+ and npm 10+.

```bash
npm install
cp .env.example .env.local   # PowerShell: Copy-Item .env.example .env.local
npm run dev
```

The app runs at <http://localhost:3000>. `.env.example` contains safe placeholders; `.env.local` is ignored by Git. Never commit real credentials, bank statements, or personal financial data.

Validation commands:

```bash
npm run format:check
npm run lint
npm run typecheck
npm test
npm run build
npm run test:e2e   # first run: npx playwright install chromium
```

Synthetic fixtures live in `tests/fixtures/synthetic/`. Regenerate them with `npm run fixtures:generate`; the generated PDFs and ground-truth JSON are committed. The mock Notion workspace is in `tests/fixtures/notion/workspace.json`.

## License

Not yet selected. An open-source license will be chosen before the first public release (roadmap Phase 8). Will do in the future. 
