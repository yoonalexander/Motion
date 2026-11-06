# AGENTS.md

## Project state

- Phase 0 (foundations) is complete: Next.js 16 App Router shell, TypeScript, Tailwind 4, Vitest/Playwright, CI, Zod schemas, synthetic PDF fixtures, and a mock Notion workspace.
- Despite the directory/remote name `Motion`, the product is the **Notion Expense Importer**.
- `docs/motion-design.md` is the authoritative SDD: requirements, data model, architecture, security/privacy rules.
- `docs/motion-roadmap.md` is the execution plan with hard acceptance gates.

## Commands

- `npm run dev`, `npm run build`, `npm run start`
- `npm run format:check`, `npm run lint`, `npm run typecheck`, `npm test`, `npm run test:e2e`
- `npm run fixtures:generate` regenerates `tests/fixtures/synthetic/`; commit the generated PDFs and JSON.
- First E2E run only: `npx playwright install chromium`.
- Before handoff, run format check, lint, typecheck, unit tests, and build. CI runs those first, then Playwright.

## Starting work

- Phase 0 is done. Start Phase 1 (NEI-004/005), not product features outside the current roadmap gate. One ticket or milestone per change; keep PRs scoped.
- Do not start Notion OAuth/writes until the PDF extraction and exception-review milestones are proven; do not start Gemini until the core import works (roadmap Phases 3 and 6; SDD §24).
- V1 excludes: budgeting dashboard, live bank sync, custom Notion database mapping, receipt photos, multi-statement sessions, public multi-tenant hosting, and FastAPI (SDD §2.3, §6.1).
- Next.js 16 differs from older versions. Read the relevant guide under `node_modules/next/dist/docs/` before using unfamiliar APIs or changing app structure.

## Non-negotiable constraints

- PDF.js and Tesseract.js run in the browser. Raw PDFs, page images, OCR text, and working transaction rows must never reach the backend; only approved structured JSON crosses to the server/Notion.
- Notion is the sole persistent ledger. Keep no app-side financial database, transaction history, or PDF storage; persist only encrypted OAuth/session configuration.
- Money uses integer minor units (`amountMinor`) with ISO 4217 currency — no floating point. Keep billed and original currencies separate and never invent FX rates.
- Pin the Notion API to `2026-03-11`, use the data-source model, resolve property IDs, and validate the schema before import. Never silently alter a user's Notion schema.
- Never write to Notion before explicit final user confirmation. Auto-skip duplicates only at very high confidence; flag ambiguous matches for review.
- Free-tier Gemini must never receive PDFs, OCR text, amounts, dates, accounts, or personal transaction data. Only sanitized generic merchant labels may pass through the server-side privacy gate, and local fallback must always work.

## Verification

- Use Vitest for pure modules and Playwright for UI/E2E, backed by synthetic or properly anonymized fixtures.
- Never commit real bank statements, account numbers, names, or transaction histories; `.env.example` must contain placeholders only.
- Treat the roadmap's milestone gates as the acceptance bar. Do not claim a gate passed without fixture results, E2E traces, or other reproducible evidence.

<!-- BEGIN:nextjs-agent-rules -->

## This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->
