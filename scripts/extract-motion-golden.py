"""Rebuild the Motion synthetic statement's source-grounded golden JSON.

Requires pypdf 6.7.4. This offline tool reads the committed synthetic PDF with
PDF text-matrix callbacks, ignores rotated watermark text, groups fragments by
their printed horizontal baseline, and maps the printed columns to fields.
It deliberately does not import or invoke PDF.js, the application extractor,
the reconstructor, or the transaction parser.
"""

from __future__ import annotations

import hashlib
import json
import re
from collections import defaultdict
from pathlib import Path

from pypdf import PdfReader


ROOT = Path(__file__).resolve().parents[1]
PDF = ROOT / "tests/fixtures/synthetic/motion-synthetic-credit-card-statement.pdf"
OUTPUT = ROOT / "tests/fixtures/synthetic/motion-synthetic-credit-card-statement.json"
EXPECTED_SHA256 = "f06f37e0715fbfedccb83056be0e0023da4a83ad224ebd31e984970abd24f744"
PAGE_ROW_COUNTS = [14, 18, 18, 10]


def iso_date(value: str) -> str:
    month, day = (int(part) for part in value.split("/"))
    return f"2026-{month:02d}-{day:02d}"


def amount_minor(value: str) -> str:
    negative = value.startswith("-")
    digits = re.sub(r"[^0-9.]", "", value)
    whole, _, fraction = digits.partition(".")
    cents = int((fraction + "00")[:2])
    minor = int(whole) * 100 + cents
    return str(-minor if negative else minor)


def transaction_type(description: str) -> str:
    upper = description.upper()
    if "PAYMENT" in upper:
        return "payment"
    if re.search(r"\bFEE\b", upper):
        return "fee"
    if "ADJUSTMENT" in upper:
        return "adjustment"
    if any(word in upper for word in ("REFUND", "RETURN", "CREDIT")):
        return "refund"
    return "purchase"


def main() -> None:
    digest = hashlib.sha256(PDF.read_bytes()).hexdigest()
    if digest != EXPECTED_SHA256:
        raise SystemExit(f"Unexpected source PDF SHA-256: {digest}")

    reader = PdfReader(str(PDF))
    transactions = []
    for page_number, page in enumerate(reader.pages, start=1):
        fragments: list[tuple[float, float, str]] = []

        def collect(text, _cm, tm, _font, _font_size):
            # The source has a large diagonal watermark. Retain horizontal
            # printed columns only; this also excludes page-number/footer text
            # by the transaction table's x/date/amount column filters below.
            if text.strip() and abs(tm[0] - 1) < 0.001 and abs(tm[1]) < 0.001:
                fragments.append((float(tm[4]), float(tm[5]), text.strip()))

        page.extract_text(visitor_text=collect)
        by_baseline: dict[float, list[tuple[float, str]]] = defaultdict(list)
        for x, y, text in fragments:
            # Text fragments in the same row share the exact baseline in this
            # synthetic source. Round only to absorb PDF float representation.
            by_baseline[round(y, 2)].append((x, text))

        page_rows = []
        for baseline, columns in by_baseline.items():
            date = next((s for x, s in columns if 48 <= x <= 65 and re.fullmatch(r"\d{2}/\d{2}", s)), None)
            posting_date = next((s for x, s in columns if 125 <= x <= 150 and re.fullmatch(r"\d{2}/\d{2}", s)), None)
            description = next((s for x, s in columns if 210 <= x <= 500 and not s.startswith("Original purchase:")), None)
            amount = next((s for x, s in columns if 500 <= x <= 560 and re.fullmatch(r"-?\$[\d,]+\.\d{2}", s)), None)
            if date and posting_date and description and amount:
                original_note = next(
                    (s for y, values in by_baseline.items() if abs(y - (baseline - 14)) <= 0.1
                     for x, s in values if x >= 210 and s.startswith("Original purchase:")),
                    None,
                )
                page_rows.append((baseline, date, posting_date, description, amount, original_note))

        page_rows.sort(key=lambda row: -row[0])
        if len(page_rows) != PAGE_ROW_COUNTS[page_number - 1]:
            raise SystemExit(f"Page {page_number}: expected {PAGE_ROW_COUNTS[page_number - 1]} rows, found {len(page_rows)}")

        for row_index, (baseline, date, posted, description, amount, original_note) in enumerate(page_rows, start=1):
            # Coordinates are normalized from the source PDF's 612 x 792 pt
            # media box. Vertical bounds include one continuation line where
            # an original-currency note is printed beneath a transaction.
            y0 = max(0.0, (baseline - 15) / 792)
            y1 = min(1.0, (baseline + 10) / 792)
            printed_amount_minor = amount_minor(amount)
            transaction = {
                "sourceRowId": f"motion-p{page_number:02d}-r{row_index:02d}",
                "transactionDate": iso_date(date),
                "postingDate": iso_date(posted),
                "rawDescription": description,
                "transactionType": transaction_type(description),
                "printedAmountMinor": printed_amount_minor,
                "billedAmount": {"amountMinor": str(abs(int(printed_amount_minor))), "currency": "CAD", "exponent": 2},
                "sourceAnchor": {"page": page_number, "bbox": [round(43 / 612, 4), round(y0, 4), round(569 / 612, 4), round(y1, 4)]},
            }
            if original_note:
                match = re.fullmatch(r"Original purchase: ([\d,]+\.\d{2}) ([A-Z]{3})\s+\|\s+Billed in CAD", original_note.strip())
                if not match:
                    raise SystemExit(f"Unrecognized printed original-currency note: {original_note}")
                transaction["originalAmount"] = {
                    "amountMinor": amount_minor(match.group(1)),
                    "currency": match.group(2),
                    "exponent": 2,
                }
            transactions.append(transaction)

    if len(transactions) != 60:
        raise SystemExit(f"Expected 60 source rows, found {len(transactions)}")

    positive_minor = sum(int(t["printedAmountMinor"]) for t in transactions if int(t["printedAmountMinor"]) > 0)
    negative_minor = sum(int(t["printedAmountMinor"]) for t in transactions if int(t["printedAmountMinor"]) < 0)
    if positive_minor != 194713 or negative_minor != -103879:
        raise SystemExit(f"Printed row totals disagree with summary controls: positive={positive_minor}, negative={negative_minor}")
    totals_by_type = {
        kind: sum(int(t["printedAmountMinor"]) for t in transactions if t["transactionType"] == kind)
        for kind in {t["transactionType"] for t in transactions}
    }
    expected_type_totals = {"purchase": 194395, "fee": 318, "payment": -100000, "refund": -3379, "adjustment": -500}
    if totals_by_type != expected_type_totals:
        raise SystemExit(f"Printed transaction classification totals disagree: {totals_by_type}")
    if 72560 + positive_minor + negative_minor != 163394:
        raise SystemExit("Opening + signed transaction rows does not equal the printed closing balance")

    output = {
        "schemaVersion": 1,
        "id": "motion-synthetic-credit-card-statement",
        "description": "Four-page, text-native fictional CAD statement with explicit transaction/posting dates, signed amounts, separate original-currency notes, and a 36-degree watermark.",
        "kind": "text",
        "sourceFile": "motion-synthetic-credit-card-statement.pdf",
        "bankName": "Cedarcrest Card Services (fictional)",
        "accountLabel": "Cedarcrest Credit Card",
        "periodStart": "2026-10-01",
        "periodEnd": "2026-10-31",
        "periodVerified": True,
        "dateOrder": "MDY",
        "positiveAmountDirection": "debit",
        "currency": "CAD",
        "pageCount": 4,
        "transactions": transactions,
        "controls": {
            "openingBalanceMinor": "72560",
            "closingBalanceMinor": "163394",
            "purchaseTotalMinor": "194395",
            "feeTotalMinor": "318",
            "positiveRowTotalMinor": str(positive_minor),
            "negativeRowTotalMinor": str(negative_minor),
            "transactionCount": 60,
        },
        "sourceSha256": digest,
        "provenance": "Derived offline from the source PDF's printed text and table coordinates with pypdf 6.7.4; see docs/testing.md, Motion golden provenance. Type labels are classified from printed descriptions and signed amounts. Original-currency annotations are not substituted for billed CAD amounts.",
    }
    OUTPUT.write_text(json.dumps(output, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    print(f"Wrote {OUTPUT.relative_to(ROOT)}: {len(transactions)} rows, +{positive_minor} / {negative_minor} minor units, SHA-256 {digest}")


if __name__ == "__main__":
    main()
