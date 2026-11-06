# Notion Expense Importer

A free-first, privacy-conscious, browser-first web app that turns credit card statement PDFs into accurate, categorized Notion transactions, makes extraction failures easy to find, and minimizes monthly manual data entry.

## Status

**Planning complete; implementation not started.** This repository currently contains the design docs and an empty project skeleton matching the planned structure. There is no application logic, package manifest, CI, or test tooling yet, so there are no install, build, or test commands to run.

Implementation follows the roadmap, starting with NEI-001 (Milestone 0): scaffold the Next.js app, add TypeScript and Tailwind, then set up linting, formatting, type checking, Vitest, Playwright, and CI.

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

| Area | Choice |
|---|---|
| Application | Next.js App Router, TypeScript, Tailwind CSS |
| Validation | Zod |
| PDF processing | PDF.js (`pdfjs-dist`) |
| OCR | Tesseract.js in a browser worker |
| Testing | Vitest, Playwright, fixture-based golden tests |
| Notion | Official SDK or REST API, pinned to `2026-03-11` |
| AI (optional) | Gemini via a guarded server route |

## Documentation

- [Software design document](docs/motion-design.md) — authoritative requirements, architecture, data model, and privacy/security rules.
- [Development roadmap](docs/motion-roadmap.md) — phases, acceptance gates, and initial implementation tickets.
- [Agent instructions](AGENTS.md) — repository constraints and working conventions for coding agents.

## Getting started

Not available yet. Setup instructions, environment variables, and exact commands will be added with NEI-001. `.env.example` is currently a placeholder; never commit real credentials, bank statements, or personal financial data.

## License

Not yet selected. An open-source license will be chosen before the first public release (roadmap Phase 8).
