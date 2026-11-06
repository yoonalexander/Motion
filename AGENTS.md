# AGENTS.md

## Project state

- Pre-implementation repo: planning docs plus an empty directory skeleton from `docs/motion-design.md` §18. There is no application logic, package manifest, CI, or test tooling yet — do not assume commands exist.
- Despite the directory/remote name `Motion`, the product is the **Notion Expense Importer**.
- `docs/motion-design.md` is the authoritative SDD: requirements, data model, architecture, security/privacy rules.
- `docs/motion-roadmap.md` is the execution plan with hard acceptance gates.

## Starting work

- Start at NEI-001 / Milestone 0, not with product features. One ticket or milestone per change; keep PRs scoped.
- NEI-001 must establish the foundation: Next.js App Router + TypeScript + Tailwind, lint/format/typecheck, Vitest, Playwright, and CI. Once scripts exist, record the exact commands in `README.md` and this file.
- Do not start Notion OAuth/writes until the PDF extraction and exception-review milestones are proven; do not start Gemini until the core import works (roadmap Phases 3 and 6; SDD §24).
- V1 excludes: budgeting dashboard, live bank sync, custom Notion database mapping, receipt photos, multi-statement sessions, public multi-tenant hosting, and FastAPI (SDD §2.3, §6.1).

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
