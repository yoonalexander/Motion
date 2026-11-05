# Notion Expense Importer: Development Roadmap

**Version:** 1.0  
**Date:** November 4, 2026  
**Source:** `Notion_Expense_Importer_Design_Document.md` (SDD v1.0)  
**Developer:** Solo developer, Codex-assisted  
**Status:** Proposed execution plan

## 1. Executive plan

Build a browser-first PDF-to-Notion importer in **18 sequential weeks**, assuming **12 to 15 focused engineering hours per week** (about **215 to 270 hours total**). The calendar is a planning baseline, not a promise. Expect another **2 to 5 weeks of contingency** if unfamiliar bank layouts, OCR quality, or Notion authorization cause significant surprises. If you work only 6 to 8 hours weekly, plan for approximately 30 to 40 weeks instead of forcing the same deadlines.

**Primary outcome:** Reduce a typical 45+ minute monthly manual statement-entry process to **10 minutes or less** and auto-process at least **85% of eligible transactions without individual edits** on representative, supported statement layouts. These are test targets, not guarantees across all banks.

**Engineering order:** prove text extraction -> prove scanned extraction and missing-row visibility -> prove safe Notion connection -> make classification and duplicate detection reliable -> implement controlled writes, recovery, and undo -> optionally add Gemini -> harden and release.

**Scope guardrails:** Notion remains the sole persistent financial ledger. The website stores only encrypted connection/session settings; original PDFs, OCR text, and working financial data remain in browser memory. One statement per import in V1. The standard Notion template is required in V1. No conversational assistant, automatic bank sync, receipt parsing, multi-statement sessions, custom Notion mapping, or public multi-tenant hosting in the initial MVP.

## 2. Schedule at a glance

| Phase | Weeks | Focus | Shippable checkpoint |
|---|---:|---|---|
| 0. Foundations | 1 | Repo, schemas, fixtures, automated tests | A clean checkout runs and tests pass |
| 1. PDF text engine | 2–4 | Browser PDF rendering, generic multi-bank parsing, source positions | Text PDFs become accurate transaction tables |
| 2. OCR and exception reviewer | 5–8 | Scanned PDFs, missing-row overlays, reconciliation, manual fixes | Local PDF-to-review workflow without Notion |
| 3. Notion foundation | 9–10 | Official template, OAuth, schema validation, first write | One approved transaction reaches Notion |
| 4. Classification and duplicates | 11–12 | Notion-based categories, transaction types, repeat-import detection | Dry-run preview is safe and useful |
| 5. Reliable synchronization | 13–14 | Final approval, chunked writes, retry, recovery, undo | Full end-to-end local MVP |
| 6. Optional Gemini | 15 | Privacy-gated merchant hints and free-quota fallback | No AI dependency for core imports |
| 7. QA and optimization | 16–17 | Multi-bank benchmark, security, accessibility, review-time improvements | Acceptance gates demonstrably pass |
| 8. Release and handoff | 18 | Docs, open-source hygiene, local user pilot | Versioned local MVP release |

**Example calendar:** If you start **Monday, November 9, 2026**, the 18-week reference schedule ends **Sunday, March 14, 2027**. Dates are optional, and weeks around December holidays may need to move based on your availability. The important unit is the milestone gate, not the calendar deadline.

| Phase | Example calendar window |
|---|---|
| Foundations | Nov 9–15, 2026 |
| PDF text engine | Nov 16–Dec 6, 2026 |
| OCR + exception reviewer | Dec 7, 2026–Jan 3, 2027 |
| Notion foundation | Jan 4–17, 2027 |
| Classification + duplicates | Jan 18–31, 2027 |
| Safe synchronization | Feb 1–14, 2027 |
| Gemini optional | Feb 15–21, 2027 |
| QA + optimization | Feb 22–Mar 7, 2027 |
| Local release | Mar 8–14, 2027 |

**Major demos:** End of Week 4: text PDF parser. End of Week 8: no-Notion end-to-end review prototype. End of Week 10: Notion proof of write. End of Week 14: safe import/undo demo. End of Week 18: local MVP release.

## 3. Weekly execution plan

### Phase 0. Foundations (Week 1)

**Goal:** Establish an inspectable foundation before experimenting with banks.

- [ ] Initialize Next.js App Router, TypeScript, Tailwind and a small component library; add lint/format/typecheck.
- [ ] Configure Vitest for pure modules, Playwright for UI and a CI workflow to run all checks.
- [ ] Define `Money` (integer minor units), `ParsedTransaction`, `PdfAnchor`, `Statement`, classification flags, and Zod schemas.
- [ ] Establish browser/server module boundaries so PDF bytes cannot accidentally reach API routes.
- [ ] Create **three structurally different synthetic bank PDFs** with ground-truth JSON and bounding-box expectations; include one scanned rendition. Keep personal bank statements out of Git.
- [ ] Set up `.env.example`, local secrets guidance and automated secret scanning; add mock Notion fixtures.

**Exit gate:** A fresh clone starts locally, `typecheck`, lint, tests and build pass, and a fixture test can load expected transaction metadata. **Demo:** empty application shell plus passing fixture tests.

### Phase 1. Browser-local PDF engine (Weeks 2–4)

**Week 2: Document rendering and evidence capture**
- [ ] Render user-selected PDF with PDF.js without sending bytes to the server.
- [ ] Extract text items, page indices, bounding boxes, rotations and token IDs.
- [ ] Normalize token coordinates to a stable page-space model; implement page zoom, next/previous navigation.
- [ ] Add performance/error handling for encrypted, damaged, oversized and unsupported PDFs.

**Week 3: Transaction recognition and normalization**
- [ ] Detect tables and transaction-like line regions from repeated dates, amounts, columns and row spacing.
- [ ] Parse dates, posting vs purchase dates, multiline descriptions, currencies, amounts, debit/credit direction and transaction type.
- [ ] Use integer minor units and verify sign/currency conversion tests (do not infer FX rates).
- [ ] Preserve unparsed **candidates** instead of dropping uncertain source lines.

**Week 4: Generic multi-bank verification**
- [ ] Run the parser against at least three different synthetic layouts; add sanitized real-layout tests where available.
- [ ] Preserve row-to-PDF source anchors and visually draw a highlight around an extracted row.
- [ ] Add optional high-confidence bank-layout hints without making the generic engine depend on a named bank.
- [ ] Produce a fixture report: detection recall/precision and critical-field accuracy.

**Exit gate A:** Three text-based statement layouts produce normalized transactions, including correct source highlights. Tests cover refunds/payments, same-amount rows, multiline entries and currencies. **Demo:** upload PDF -> inspect table -> click a row -> jump to its original location.

**Do not proceed if:** amount signs, dates or row geometry are substantially unreliable on the evaluated fixtures. Fix parsing, not UI polish.

### Phase 2. Scanned PDFs, completeness checks and review UX (Weeks 5–8)

**Week 5: Local OCR**
- [ ] Render image-only pages to canvases; run Tesseract.js in a browser worker with cancellation and progress.
- [ ] Detect whether a page needs OCR; avoid unnecessary OCR of selectable text.
- [ ] Record OCR confidence and bounding boxes; normalize to the same source-anchor format as text extraction.
- [ ] Test one scanned version of each synthetic layout and one low-quality variant.

**Week 6: Independent row coverage and visual exceptions**
- [ ] Implement independent visual transaction-candidate detection and candidate-to-parsed-row matching.
- [ ] Mark source regions as matched, unmatched, ambiguous, excluded or contradictory.
- [ ] Create desktop side-by-side PDF and review panel with jump-to-exception, source highlighting and clear non-color status labels.
- [ ] Implement **Create Transaction from Selection**, prefilled from selected source text, without forcing the user to hunt for omitted rows.

**Week 7: Financial semantics and reconciliation**
- [ ] Separate purchases, refunds, credit card bill payments, transfers, interest, fees and unknowns.
- [ ] Attempt deterministic reconciliation against statement counts, debit/credit totals, and balance equations only when trustworthy controls exist.
- [ ] Distinguish *unverified completeness* from *verified reconciliation failure* and *category uncertainty*.
- [ ] Intentionally remove/mutate rows in fixtures and confirm the mismatch is visible without inspecting all other rows.

**Week 8: Review workflow and bulk edits**
- [ ] Add exception queue, table filters, keyboard navigation, editable date/amount/type/merchant/category fields and bulk category changes.
- [ ] Keep state in memory; refreshing loses the working session by design.
- [ ] Add account and statement identification with user confirmation on uncertainty.
- [ ] Create a mocked final preview: Ready / Needs Review / Excluded / Duplicate Candidate (mock only at this stage).

**Exit gate B:** For text and scanned fixtures, the app highlights suspicious/missing candidate regions directly on the PDF, enables one-click correction, and reports reconciliation limitations honestly. **Demo:** intentionally omitted two rows can be found through an exceptions panel without scanning every transaction.

**Do not proceed if:** an unrecognized row cannot be located efficiently or a reconciliation failure is silently treated as success.

### Phase 3. Notion template, authentication and schema (Weeks 9–10)

**Week 9: Template and contract**
- [ ] Design and test a public, duplicable Notion finance template with **Transactions**, **Accounts**, and **Import Batches** data sources, plus native Notion dashboard views.
- [ ] Define stable internal identifiers, source row marker, source document hash, import batch link, account, category, type, billed/original amounts and currencies.
- [ ] Validate read/write permissions and formula/rollup behavior on a Notion Free workspace.
- [ ] Build an adapter that resolves property IDs and detects missing/broken mappings without silently modifying user data.

**Week 10: OAuth and smallest vertical integration**
- [ ] Implement Notion OAuth state/callback, secure session cookies, encryption of credentials and disconnect functionality.
- [ ] Discover the authorized duplicated template, validate schema, list Notion categories/accounts.
- [ ] Implement a **single, explicitly confirmed** transaction write and return a live Notion link.
- [ ] Add API input validation, CSRF protection, redacted logs and authorization tests.

**Exit gate C:** A free Notion test account connects, the app validates its template, and a single approved entry appears in the right database with correct amount, sign, account and category. **Demo:** local preview -> explicit save -> open Notion row.

**Do not proceed if:** browser JavaScript can read Notion tokens, workspace ownership is ambiguous, or the template mapping can quietly write to the wrong destination.

### Phase 4. Categorization and duplicate safety (Weeks 11–12)

**Week 11: Classification and finance-aware defaults**
- [ ] Fetch current Notion category choices and read bounded prior records as categorization precedents.
- [ ] Add deterministic merchant cleanup, exact precedent matching, local category rules and defensible broad defaults such as Retail.
- [ ] Preserve individual statement transaction type and exclude payments/transfers from purchase expense totals as defined in the template.
- [ ] Add bulk edits to the final review flow; category corrections are reflected in Notion after commit, not in a parallel app database.

**Week 12: Duplicate and import preflight**
- [ ] Define stable source-row IDs where possible and conservative fingerprints for cross-statement matching.
- [ ] Query Notion before write, auto-skip only **very high-confidence** matches and flag plausible duplicates.
- [ ] Distinguish identical purchases from duplicates with cross-account, date, amount, type and source evidence.
- [ ] Show import breakdown: to create / already exists / probable duplicate / excluded / unresolved.
- [ ] Write tests for exact reupload, overlapping statements, manual pre-existing records and two legitimate same-amount purchases.

**Exit gate D:** A repeated or overlapping statement never silently produces obvious duplicates in the test suite, and ambiguous matches cannot be auto-skipped. **Demo:** import preview against records already in a test workspace.

### Phase 5. Controlled write, crash recovery and undo (Weeks 13–14)

**Week 13: Safe import commit**
- [ ] Gate every write behind a final confirmation; no server write is triggered by the initial upload or parsing step.
- [ ] Implement batch creation in Notion, bounded chunk requests, rate limiting, backoff and `Retry-After` handling.
- [ ] Track per-row success/failure in session memory; show honest progress and linked Notion records.
- [ ] Recheck Notion before retrying a potentially timed-out create; never assume a timeout means failure.

**Week 14: Recovery and undo**
- [ ] Make reuploading an interrupted PDF identify completed rows using Notion markers and continue pending rows safely.
- [ ] Simulate a failure after **35/100** writes and verify the resumed import creates no repeated rows.
- [ ] Build **Undo Import** from Notion Import Batches: query affected rows, preview exact consequences, require confirmation and prefer reversible trash behavior.
- [ ] Detect post-import manual edits before undo and warn rather than deleting blindly.

**Exit gate E:** A complete statement can be reviewed, approved and saved to Notion. Reupload-after-failure is safe under tested sequential conditions, and undo changes only rows belonging to the selected batch. **Demo:** full end-to-end import, forced interruption, safe resume, undo preview.

**This is the first true local MVP.** Gemini is not required to use it.

### Phase 6. Optional Gemini augmentation (Week 15)

**Goal:** Improve category suggestions without undermining privacy, correctness or the free-first design.

- [ ] Build the server-side model adapter and structured output validator; never put Gemini credentials in browser code.
- [ ] Add a **fail-closed privacy allowlist** that sends only genuinely nonsensitive generic merchant labels and allowed category names. Never send raw PDFs, OCR text, transaction amounts, dates, account identifiers or financial histories to the free API.
- [ ] Rate-limit and deduplicate requests; show whether AI classification is enabled.
- [ ] Treat model suggestions as hints only; validate categories against Notion options and keep deterministic fallback.
- [ ] Benchmark accuracy, manual edits, latency and API quota usage with AI on versus off.

**Exit gate F:** Disabling Gemini or encountering 429/errors does not stop an import. Defined privacy tests confirm disallowed payloads never leave the browser for the AI route. **Go/no-go:** Keep Gemini enabled only if it measurably improves category suggestions or review time.

### Phase 7. Validation, usability and hardening (Weeks 16–17)

**Week 16: Cross-bank accuracy and speed**
- [ ] Run anonymized real and synthetic fixtures from at least three distinct layouts, with selectable-text and scanned variants.
- [ ] Measure detection recall/precision, critical-field correctness, independent coverage verification, duplicate false skips, and review time **per layout**.
- [ ] Fix high-frequency errors, especially missed rows, incorrect sign/type and duplicate false positives.
- [ ] Run a timed realistic import with a 100-transaction statement; target **>=85% without individual edits** and **<=10 minutes active review** on supported representative layouts.

**Week 17: Privacy, UX and security**
- [ ] Inspect browser network traffic: no raw PDF, OCR text or page images on backend/API requests.
- [ ] Test OAuth/session rotation, broken Notion mappings, revoked permissions, token encryption, CSRF, and per-user request isolation assumptions.
- [ ] Improve keyboard access, contrast, progress/error states, touch usability, large PDF failure modes and clear privacy notices.
- [ ] Run typecheck, lint, unit, integration, E2E, secret scanning and production build with no critical failures.

**Exit gate G:** Accuracy and workflow targets pass on specified fixtures. Known unsupported layouts are documented rather than falsely advertised as solved. No high-severity privacy/security defects remain for the intended single-user local deployment.

### Phase 8. Release and iteration (Week 18)

- [ ] Publish README with architecture overview, setup, environment variables, Notion template setup, local run commands and troubleshooting.
- [ ] Add technical documentation for parser heuristics, fixture creation, failure recovery, data boundaries and Gemini privacy gate.
- [ ] Remove credentials and real personal financial information from repository history; choose an open-source license.
- [ ] Tag `v0.1.0-local-mvp`, capture a short demo, and create a prioritized backlog from the first real monthly import.
- [ ] Run your own actual workflow end to end and log active review time, error categories and manual work required.

**Exit gate H:** A fresh clone can be set up following the README and complete a real local PDF-to-Notion import with approved rows and safe recovery.

## 4. Hard release gates

| Gate | When | Required evidence | If it fails |
|---|---|---|---|
| A. Text PDF | Week 4 | Three layouts, normalized transaction rows and working PDF anchors | Fix parser and fixtures |
| B. Source coverage | Week 8 | Text/scanned support; direct navigation to missing candidates; clear reconciliation state | Improve candidate detection and review UX |
| C. Notion safe write | Week 10 | Free account, template validation, encrypted auth, one approved record | Fix permissions and schema adapter |
| D. Duplicate safety | Week 12 | Reimports and overlapping periods do not silently duplicate or drop valid purchases | Tighten match policy |
| E. Recovery | Week 14 | 35/100 interruption test, safe retry, precise undo preview | Fix journal and commit protocol |
| F. Gemini isolation | Week 15 | Sensitive payloads blocked; local fallback works | Turn Gemini off |
| G. User value | Week 17 | Supported fixtures: >=85% auto-processing and <=10 minutes active review; no critical-field silent failures | Do not release as accurate for that layout |
| H. Local release | Week 18 | Reproducible setup, tests, docs and a real end-to-end import | Release only a clearly labeled alpha |

Important: **85% automatic classification is not the same as 85% extraction coverage.** A statement can only pass the correctness gate when missing-row and critical-field risks have been inspected. If there is no independent PDF reconciliation control, show "not independently verified" rather than claiming complete extraction.

## 5. Weekly working rhythm for a solo developer

Use **one-week iterations** with **one demonstrable outcome** each. For a 12 to 15 hour week:

| Activity | Suggested weekly effort |
|---|---:|
| Main implementation ticket(s) | 7–9 hours |
| Unit/fixture/E2E tests | 2–3 hours |
| Integration and debugging | 1–2 hours |
| Demo, notes, backlog reprioritization | 1 hour |

Suggested issue structure: `Why / Inputs and expected behavior / In scope / Out of scope / Acceptance tests / Security or privacy constraints / Demo evidence`.

At each week end, record: **What works? What failed? What was measured? What is the next blocker?** Only mark a milestone complete if its gate passes. If a phase slips, move the dates rather than cutting the safety tests. Make PRs small, preferably one focused capability per PR, and merge only with green checks. Give Codex one ticket at a time instead of asking it to implement the entire SDD in one large prompt.

## 6. Immediate first 10 Codex tickets

| ID | Ticket | Depends on | Evidence to produce |
|---|---|---|---|
| NEI-001 | Bootstrap Next.js app, CI, lint, Vitest, Playwright | None | Green CI and working dev server |
| NEI-002 | Define transaction/money/PDF-anchor Zod schemas | 001 | Schema tests for invalid amounts, ISO currency and required fields |
| NEI-003 | Generate three synthetic PDF layouts plus expected JSON | 002 | Fixtures with 10+ cases each; zero private data |
| NEI-004 | Implement browser PDF.js viewer and page navigation | 001 | Local upload and render; no server upload |
| NEI-005 | Extract tokens with page coordinates and source anchors | 004 | Geometry tests and overlay demo |
| NEI-006 | Implement line and transaction candidate detection | 003, 005 | Rows and unmatched candidates visible |
| NEI-007 | Normalize dates, amounts, debit/credit and transaction types | 002, 006 | Golden parser tests |
| NEI-008 | Add multiline rows, currency handling and statement metadata | 007 | Fixtures from multiple layouts pass |
| NEI-009 | Build clickable transaction table linked to PDF highlights | 005, 008 | Click row -> correct page/region |
| NEI-010 | Publish extraction benchmark report for Gate A | 003, 006–009 | Detection and field-accuracy metrics per fixture |

**Suggested first Codex assignment:** "Read the SDD and this roadmap. Implement NEI-001 only. Do not scaffold financial dashboard features or touch Notion/Gemini. Add test scripts and CI, then report changed files, commands run, outcomes, and remaining issues."

## 7. Scope management and prioritization

**Must work before any real financial import:** amount/date/sign correctness; source provenance; missing-row visibility; account and currency confirmation; Notion schema validation; duplicate safety; review-before-write; retry-safe commit.

**May be reduced or delayed without breaking the core goal:** custom visual design, animations, full mobile wizard, Gemini categorization, sophisticated bank-specific parsing, receipt scanning, public hosting and a general custom-Notion mapper.

**Do not weaken:** user authorization, token confidentiality, source-to-transaction traceability, conservative duplicate matching, or visibility into unverified reconciliation. A missed/unverified financial amount matters more than an awkward loading animation.

**Schedule contingency:** The variable part is generalized PDF parsing. If Gate A or B slips more than two weeks, temporarily narrow the *tested/claimed* supported layouts while retaining the generic fallback and manual review. Do not falsely promise universal accuracy. Keep the release gate stable rather than compensating by skipping financial validation.

## 8. Post-MVP backlog, not part of the 18-week commitment

| Track | Proposed order | Prerequisite |
|---|---|---|
| Receipt photos | Next | Stable transaction model and cross-source matching |
| Receipt-vs-statement reconciliation | Next | Receipt capture and Notion dedupe |
| Multiple PDF statements in one session | Later | Account isolation and bounded import queues |
| Guided mobile exception wizard | Later | Desktop exception workflow stabilized |
| Unknown-bank interactive column mapping | Later | Evidence from rejected/uncertain real layouts |
| Share hosted app with friends | Later | Hosting/auth storage, OAuth distribution, multi-user threat model, quotas |
| Existing custom Notion database mapping | Later | Standard template schema stable |
| PWA/iPhone Shortcut | Later | Responsive flow and receipt ingestion |

**Hosting gate:** A publicly accessible, multi-user service is **not** considered safe merely because the local MVP works. Before inviting friends, independently verify encrypted credential storage, ownership checks on every endpoint, OAuth/session handling, request isolation, rate limits, secrets management, deletion/disconnect, abuse controls and privacy disclosures. Free local operation does not imply permanently free public hosting.

## 9. Definition of done for every ticket

- [ ] Implementation matches the scoped behavior and does not introduce unrelated features.
- [ ] Automated tests cover normal, malformed and relevant edge cases; regression fixtures updated.
- [ ] Privacy boundaries remain intact; no sensitive values logged, uploaded or hardcoded.
- [ ] Financial amounts and duplicate decisions are deterministic and auditable.
- [ ] UI includes actionable errors and labels for uncertain outcomes.
- [ ] Lint/typecheck/tests/build pass for affected areas.
- [ ] Short evidence is attached: screenshot, fixture results or E2E trace.
- [ ] README or feature documentation updated if setup or behavior changed.

## 10. Definition of the first successful release

The local release is successful when a user can launch the website, securely connect their own Notion finance template, upload a text or scanned credit card statement, discover uncertain or missing transaction regions without scanning the entire document, correct exceptions, see a transparent final preview, and create only approved records in Notion. Repeated and interrupted imports must not silently duplicate transactions, and a batch undo must preview exactly what will be changed. The website retains neither original documents nor an independent financial transaction ledger. Gemini may be disabled without breaking this flow.

**Next action:** Start **NEI-001**, then **NEI-002/003**. Do not begin OAuth, Gemini or elaborate Notion dashboards before the PDF engine's first proven milestone.
