# Testing

Implementation notes for fixtures, golden tests, and acceptance measurements will live here.

Authoritative requirements: [motion-design.md](motion-design.md) §16 and [motion-roadmap.md](motion-roadmap.md) §4.

# Motion golden provenance

`tests/fixtures/synthetic/motion-synthetic-credit-card-statement.json` is
grounded in the printed content of the committed fictional statement. Its PDF
SHA-256 is
`F06F37E0715FBFEDCCB83056BE0E0023DA4A83AD224EBD31E984970ABD24F744` (the copy
under `docs/` has the same digest). The golden contains 14, 18, 18, and 10 rows
from pages 1–4. Printed controls show purchases of CAD 1,943.95, fees of CAD
3.18, payments of CAD 1,000.00, refunds/adjustments of CAD 38.79, and a CAD
1,633.94 closing balance from CAD 725.60 opening balance. Transaction and
posting dates, signs, billed currency, descriptions, printed original-currency
notes, and page/row locations come from the PDF itself.

The JSON was not produced by PDF.js or by this application's parser. To
regenerate it independently, install `pypdf==6.7.4` in an offline Python
environment and run:

```powershell
python scripts/extract-motion-golden.py
```

The script checks the source digest, reads text with pypdf's visitor callback,
retains only horizontal text matrices (excluding the 36-degree watermark),
groups printed text by its vertical baseline, and reads transaction/posting
date, description, and CAD amount from their printed columns. It requires the
page counts, per-type totals, positive/negative row sums, and opening-to-closing
balance equation to match the printed statement controls before writing JSON.
Page anchors are normalized from the PDF's 612-by-792 point media box and span the printed transaction row, including a
continuation line when an original-currency note appears. Type labels are
classified from explicit printed descriptions and sign. Original-currency
notes remain separate from billed CAD amounts.

The golden regression test then takes the committed PDF bytes through real
PDF.js extraction, line/row reconstruction, and transaction parsing. It emits
a typed per-fixture report with stage counts, one-to-one page/anchor coverage,
missing/merged/duplicate/false-positive counts, field mismatch counts,
invalid anchors, review counts, and mismatch examples. Matching is one-to-one
within 0.015 normalized page-height units of the expected row center; this is
less than half the 25-point row spacing in Motion's densely spaced pages and
the roughly 30-point row spacing in Maple/Cedar. Candidate-to-truth pairing is
globally one-to-one, so one nearby candidate cannot satisfy multiple rows.
