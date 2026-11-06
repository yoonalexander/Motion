import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PDFDocument, StandardFonts, rgb } from "pdf-lib";
import sharp from "sharp";

const rootDir = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const outputDir = path.join(rootDir, "tests", "fixtures", "synthetic");
const pageWidth = 612;
const pageHeight = 792;

const layoutATransactions = [
  ["a-001", "2026-09-02", "COFFEE HOUSE DOWNTOWN", 485, "debit", "purchase"],
  ["a-002", "2026-09-03", "METRO GROCERY #142", 8642, "debit", "purchase"],
  ["a-003", "2026-09-05", "STREAMING SUBSCRIPTION", 1699, "debit", "purchase"],
  ["a-004", "2026-09-07", "GAS STATION 24", 5210, "debit", "purchase"],
  ["a-005", "2026-09-09", "PHARMACY", 2375, "debit", "purchase"],
  ["a-006", "2026-09-11", "BOOKSTORE", 3150, "debit", "purchase"],
  ["a-007", "2026-09-13", "RESTAURANT", 6420, "debit", "purchase"],
  ["a-008", "2026-09-15", "MONTHLY CARD FEE", 1200, "debit", "fee"],
  ["a-009", "2026-09-18", "REFUND - SPORTS STORE", 4500, "credit", "refund"],
  ["a-010", "2026-09-20", "ONLINE MARKETPLACE", 3899, "debit", "purchase"],
  ["a-011", "2026-09-24", "PAYMENT THANK YOU", 50000, "credit", "payment"],
  ["a-012", "2026-09-28", "INTEREST CHARGE", 325, "debit", "interest"],
].map(
  ([sourceRowId, transactionDate, rawDescription, amountMinor, direction, transactionType]) => ({
    sourceRowId,
    transactionDate,
    rawDescription,
    amountMinor,
    direction,
    transactionType,
  }),
);

const layoutBTransactions = [
  ["b-001", "2026-09-01", "2026-09-02", ["TESCO EXPRESS"], 2345, "debit", "purchase"],
  ["b-002", "2026-09-02", "2026-09-03", ["WATERSTONE CAFE"], 875, "debit", "purchase"],
  ["b-003", "2026-09-04", "2026-09-05", ["LONDON TRANSIT"], 1560, "debit", "purchase"],
  [
    "b-004",
    "2026-09-06",
    "2026-09-08",
    ["ONLINE RETAILER", "ORDER 88421"],
    4599,
    "debit",
    "purchase",
  ],
  ["b-005", "2026-09-09", "2026-09-10", ["PHARMACY PLUS"], 1899, "debit", "purchase"],
  ["b-006", "2026-09-11", "2026-09-12", ["COUNCIL TAX"], 12500, "debit", "purchase"],
  ["b-007", "2026-09-14", "2026-09-15", ["REFUND - CLOTHING STORE"], 3200, "credit", "refund"],
  ["b-008", "2026-09-17", "2026-09-18", ["MOBILE PHONE BILL"], 2200, "debit", "purchase"],
  ["b-009", "2026-09-19", "2026-09-20", ["SUPERMARKET"], 5634, "debit", "purchase"],
  ["b-010", "2026-09-22", "2026-09-23", ["CINEMA TICKETS"], 1850, "debit", "purchase"],
  [
    "b-011",
    "2026-09-25",
    "2026-09-26",
    ["PAYMENT RECEIVED - THANK YOU"],
    40000,
    "credit",
    "payment",
  ],
  ["b-012", "2026-09-28", "2026-09-29", ["ANNUAL ACCOUNT FEE"], 2500, "debit", "fee"],
].map(
  ([
    sourceRowId,
    transactionDate,
    postingDate,
    descriptionLines,
    amountMinor,
    direction,
    transactionType,
  ]) => ({
    sourceRowId,
    transactionDate,
    postingDate,
    descriptionLines,
    rawDescription: descriptionLines.join(" "),
    amountMinor,
    direction,
    transactionType,
  }),
);

const layoutCTransactions = [
  ["c-001", "2026-10-02", "HARBOUR COFFEE", 425, "debit", "purchase"],
  ["c-002", "2026-10-03", "CITY MARKET", 7810, "debit", "purchase"],
  ["c-003", "2026-10-05", "WEB SERVICES", 1499, "debit", "purchase"],
  ["c-004", "2026-10-06", "FUEL STOP 18", 4875, "debit", "purchase"],
  ["c-005", "2026-10-08", "CORNER PHARMACY", 2140, "debit", "purchase"],
  ["c-006", "2026-10-10", "HARDWARE STORE", 6799, "debit", "purchase"],
  ["c-007", "2026-10-12", "BISTRO", 9220, "debit", "purchase"],
  ["c-008", "2026-10-14", "LATE PAYMENT FEE", 3500, "debit", "fee"],
  ["c-009", "2026-10-17", "REFUND - HOME GOODS", 2750, "credit", "refund"],
  ["c-010", "2026-10-19", "ONLINE BOOKS", 1899, "debit", "purchase"],
  ["c-011", "2026-10-23", "PAYMENT THANK YOU", 60000, "credit", "payment"],
  ["c-012", "2026-10-27", "INTEREST CHARGE", 410, "debit", "interest"],
].map(
  ([sourceRowId, transactionDate, rawDescription, amountMinor, direction, transactionType]) => ({
    sourceRowId,
    transactionDate,
    rawDescription,
    amountMinor,
    direction,
    transactionType,
  }),
);

const monthNames = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
];

function formatMinorUnits(amountMinor) {
  return (amountMinor / 100).toFixed(2);
}

function formatUsDate(isoDate) {
  const [year, month, day] = isoDate.split("-");
  return `${month}/${day}/${year}`;
}

function formatUkDate(isoDate) {
  const [year, month, day] = isoDate.split("-");
  return `${day}/${month}/${year}`;
}

function formatLongDate(isoDate) {
  const [year, month, day] = isoDate.split("-");
  return `${monthNames[Number(month) - 1]} ${day}, ${year}`;
}

function summarize(transactions, openingBalanceMinor) {
  const debitTotalMinor = transactions
    .filter((transaction) => transaction.direction === "debit")
    .reduce((total, transaction) => total + transaction.amountMinor, 0);
  const creditTotalMinor = transactions
    .filter((transaction) => transaction.direction === "credit")
    .reduce((total, transaction) => total + transaction.amountMinor, 0);

  return {
    openingBalanceMinor: String(openingBalanceMinor),
    closingBalanceMinor: String(openingBalanceMinor + debitTotalMinor - creditTotalMinor),
    debitTotalMinor: String(debitTotalMinor),
    creditTotalMinor: String(creditTotalMinor),
    transactionCount: transactions.length,
  };
}

function round(value) {
  return Number(value.toFixed(4));
}

function textRowAnchor(y, lineCount = 1) {
  const bottom = y - 4 - (lineCount - 1) * 13;
  return {
    page: 1,
    bbox: [
      round(40 / pageWidth),
      round(bottom / pageHeight),
      round((pageWidth - 40) / pageWidth),
      round((y + 14) / pageHeight),
    ],
  };
}

function svgRowAnchor(top, height) {
  return {
    page: 1,
    bbox: [
      round(40 / pageWidth),
      round((pageHeight - (top + height)) / pageHeight),
      round((pageWidth - 40) / pageWidth),
      round((pageHeight - top) / pageHeight),
    ],
  };
}

function fixtureTransaction(transaction, currency, anchor) {
  return {
    sourceRowId: transaction.sourceRowId,
    transactionDate: transaction.transactionDate,
    ...(transaction.postingDate ? { postingDate: transaction.postingDate } : {}),
    rawDescription: transaction.rawDescription,
    transactionType: transaction.transactionType,
    billedAmount: {
      amountMinor: String(transaction.amountMinor),
      currency,
      exponent: 2,
    },
    sourceAnchor: anchor,
  };
}

async function writeFixture({ bytes, ...fixture }) {
  const hash = createHash("sha256").update(bytes).digest("hex");
  const completeFixture = { schemaVersion: 1, ...fixture, statementHash: hash };

  await writeFile(path.join(outputDir, fixture.sourceFile), bytes);
  await writeFile(
    path.join(outputDir, `${fixture.id}.json`),
    `${JSON.stringify(completeFixture, null, 2)}\n`,
  );
}

async function createLayoutA() {
  const pdf = await PDFDocument.create();
  pdf.setTitle("Synthetic statement - Maple Card");
  pdf.setAuthor("Motion synthetic fixtures");
  pdf.setSubject("Synthetic credit card statement");

  const page = pdf.addPage([pageWidth, pageHeight]);
  const regular = await pdf.embedFont(StandardFonts.Helvetica);
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold);
  const ink = rgb(0.12, 0.14, 0.18);
  const muted = rgb(0.35, 0.38, 0.43);

  page.drawText("MAPLE CARD", { x: 48, y: 744, size: 18, font: bold, color: ink });
  page.drawText("Synthetic credit card statement", {
    x: 48,
    y: 724,
    size: 10,
    font: regular,
    color: muted,
  });
  page.drawText("Account: **** 4242", { x: 48, y: 706, size: 10, font: regular, color: muted });
  page.drawText("Statement period: 2026-09-01 to 2026-09-30", {
    x: 48,
    y: 692,
    size: 10,
    font: regular,
    color: muted,
  });
  page.drawText("CAD", { x: 540, y: 706, size: 10, font: bold, color: ink });

  const headerY = 660;
  page.drawText("DATE", { x: 48, y: headerY, size: 9, font: bold, color: ink });
  page.drawText("DESCRIPTION", { x: 140, y: headerY, size: 9, font: bold, color: ink });
  page.drawText("AMOUNT", { x: 492, y: headerY, size: 9, font: bold, color: ink });
  page.drawLine({
    start: { x: 48, y: headerY - 8 },
    end: { x: 564, y: headerY - 8 },
    thickness: 1,
    color: ink,
  });

  let y = 636;
  const transactions = [];

  for (const transaction of layoutATransactions) {
    page.drawText(formatUsDate(transaction.transactionDate), {
      x: 48,
      y,
      size: 10,
      font: regular,
      color: ink,
    });
    page.drawText(transaction.rawDescription, {
      x: 140,
      y,
      size: 10,
      font: regular,
      color: ink,
    });

    const sign = transaction.direction === "debit" ? "-" : "+";
    page.drawText(`${sign}${formatMinorUnits(transaction.amountMinor)}`, {
      x: 500,
      y,
      size: 10,
      font: regular,
      color: ink,
    });

    transactions.push(fixtureTransaction(transaction, "CAD", textRowAnchor(y)));
    y -= 24;
  }

  const controls = summarize(layoutATransactions, 100000);
  const totalsY = 320;
  page.drawLine({
    start: { x: 48, y: totalsY + 14 },
    end: { x: 564, y: totalsY + 14 },
    thickness: 1,
    color: ink,
  });
  page.drawText("Opening balance", { x: 48, y: totalsY, size: 10, font: regular, color: muted });
  page.drawText(formatMinorUnits(Number(controls.openingBalanceMinor)), {
    x: 500,
    y: totalsY,
    size: 10,
    font: regular,
    color: ink,
  });
  page.drawText("Debits", { x: 48, y: totalsY - 18, size: 10, font: regular, color: muted });
  page.drawText(formatMinorUnits(Number(controls.debitTotalMinor)), {
    x: 500,
    y: totalsY - 18,
    size: 10,
    font: regular,
    color: ink,
  });
  page.drawText("Credits", { x: 48, y: totalsY - 36, size: 10, font: regular, color: muted });
  page.drawText(formatMinorUnits(Number(controls.creditTotalMinor)), {
    x: 500,
    y: totalsY - 36,
    size: 10,
    font: regular,
    color: ink,
  });
  page.drawText("Closing balance", { x: 48, y: totalsY - 54, size: 10, font: bold, color: ink });
  page.drawText(formatMinorUnits(Number(controls.closingBalanceMinor)), {
    x: 500,
    y: totalsY - 54,
    size: 10,
    font: bold,
    color: ink,
  });

  return {
    id: "layout-a-text",
    description: "Single-date text statement with signed amounts and a simple three-column table.",
    kind: "text",
    sourceFile: "layout-a-text.pdf",
    bankName: "Maple Card",
    accountLabel: "Maple Card Visa",
    accountLast4: "4242",
    periodStart: "2026-09-01",
    periodEnd: "2026-09-30",
    currency: "CAD",
    pageCount: 1,
    transactions,
    controls,
    bytes: await pdf.save(),
  };
}

async function createLayoutB() {
  const pdf = await PDFDocument.create();
  pdf.setTitle("Synthetic statement - Cedar Bank");
  pdf.setAuthor("Motion synthetic fixtures");
  pdf.setSubject("Synthetic credit card statement");

  const page = pdf.addPage([pageWidth, pageHeight]);
  const regular = await pdf.embedFont(StandardFonts.Helvetica);
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold);
  const ink = rgb(0.12, 0.14, 0.18);
  const muted = rgb(0.35, 0.38, 0.43);

  page.drawText("CEDAR BANK", { x: 48, y: 744, size: 18, font: bold, color: ink });
  page.drawText("Synthetic credit card statement", {
    x: 48,
    y: 724,
    size: 10,
    font: regular,
    color: muted,
  });
  page.drawText("Account: **** 1881", { x: 48, y: 706, size: 10, font: regular, color: muted });
  page.drawText("Statement period: 2026-09-01 to 2026-09-30", {
    x: 48,
    y: 692,
    size: 10,
    font: regular,
    color: muted,
  });
  page.drawText("GBP", { x: 540, y: 706, size: 10, font: bold, color: ink });

  const headerY = 660;
  page.drawText("PURCHASE", { x: 48, y: headerY, size: 9, font: bold, color: ink });
  page.drawText("POSTED", { x: 118, y: headerY, size: 9, font: bold, color: ink });
  page.drawText("DESCRIPTION", { x: 188, y: headerY, size: 9, font: bold, color: ink });
  page.drawText("DEBIT", { x: 434, y: headerY, size: 9, font: bold, color: ink });
  page.drawText("CREDIT", { x: 500, y: headerY, size: 9, font: bold, color: ink });
  page.drawLine({
    start: { x: 48, y: headerY - 8 },
    end: { x: 564, y: headerY - 8 },
    thickness: 1,
    color: ink,
  });

  let y = 636;
  const transactions = [];

  for (const transaction of layoutBTransactions) {
    page.drawText(formatUkDate(transaction.transactionDate), {
      x: 48,
      y,
      size: 9,
      font: regular,
      color: ink,
    });
    page.drawText(formatUkDate(transaction.postingDate), {
      x: 118,
      y,
      size: 9,
      font: regular,
      color: ink,
    });

    transaction.descriptionLines.forEach((line, lineIndex) => {
      page.drawText(line, {
        x: 188,
        y: y - lineIndex * 13,
        size: 9,
        font: regular,
        color: ink,
      });
    });

    const amount = formatMinorUnits(transaction.amountMinor);
    page.drawText(transaction.direction === "debit" ? amount : "", {
      x: 442,
      y,
      size: 9,
      font: regular,
      color: ink,
    });
    page.drawText(transaction.direction === "credit" ? amount : "", {
      x: 508,
      y,
      size: 9,
      font: regular,
      color: ink,
    });

    transactions.push(
      fixtureTransaction(transaction, "GBP", textRowAnchor(y, transaction.descriptionLines.length)),
    );

    y -= transaction.descriptionLines.length > 1 ? 31 : 24;
  }

  const controls = summarize(layoutBTransactions, 50000);
  const totalsY = 320;
  page.drawLine({
    start: { x: 48, y: totalsY + 14 },
    end: { x: 564, y: totalsY + 14 },
    thickness: 1,
    color: ink,
  });
  page.drawText("Opening balance", { x: 48, y: totalsY, size: 10, font: regular, color: muted });
  page.drawText(formatMinorUnits(Number(controls.openingBalanceMinor)), {
    x: 500,
    y: totalsY,
    size: 10,
    font: regular,
    color: ink,
  });
  page.drawText("Debits", { x: 48, y: totalsY - 18, size: 10, font: regular, color: muted });
  page.drawText(formatMinorUnits(Number(controls.debitTotalMinor)), {
    x: 500,
    y: totalsY - 18,
    size: 10,
    font: regular,
    color: ink,
  });
  page.drawText("Credits", { x: 48, y: totalsY - 36, size: 10, font: regular, color: muted });
  page.drawText(formatMinorUnits(Number(controls.creditTotalMinor)), {
    x: 500,
    y: totalsY - 36,
    size: 10,
    font: regular,
    color: ink,
  });
  page.drawText("Closing balance", { x: 48, y: totalsY - 54, size: 10, font: bold, color: ink });
  page.drawText(formatMinorUnits(Number(controls.closingBalanceMinor)), {
    x: 500,
    y: totalsY - 54,
    size: 10,
    font: bold,
    color: ink,
  });

  return {
    id: "layout-b-text",
    description:
      "Two-date text statement with debit and credit columns, DD/MM/YYYY dates, and a multi-line description.",
    kind: "text",
    sourceFile: "layout-b-text.pdf",
    bankName: "Cedar Bank",
    accountLabel: "Cedar Bank Travel Card",
    accountLast4: "1881",
    periodStart: "2026-09-01",
    periodEnd: "2026-09-30",
    currency: "GBP",
    pageCount: 1,
    transactions,
    controls,
    bytes: await pdf.save(),
  };
}

async function createLayoutC() {
  const openingBalanceMinor = 250000;
  let runningBalanceMinor = openingBalanceMinor;
  const rows = layoutCTransactions.map((transaction, index) => {
    runningBalanceMinor +=
      transaction.direction === "debit" ? transaction.amountMinor : -transaction.amountMinor;

    return {
      ...transaction,
      balanceMinor: runningBalanceMinor,
      top: 184 + index * 34,
    };
  });

  const rowMarkup = rows
    .map((transaction) => {
      const debit =
        transaction.direction === "debit" ? formatMinorUnits(transaction.amountMinor) : "";
      const credit =
        transaction.direction === "credit" ? formatMinorUnits(transaction.amountMinor) : "";
      const balance = formatMinorUnits(transaction.balanceMinor);

      return `
        <text x="45" y="${transaction.top + 14}" class="mono">${formatLongDate(transaction.transactionDate)}</text>
        <text x="160" y="${transaction.top + 14}" class="mono">${escapeXml(transaction.rawDescription)}</text>
        <text x="440" y="${transaction.top + 14}" class="mono" text-anchor="end">${debit}</text>
        <text x="505" y="${transaction.top + 14}" class="mono" text-anchor="end">${credit}</text>
        <text x="580" y="${transaction.top + 14}" class="mono" text-anchor="end">${balance}</text>
        <line x1="40" y1="${transaction.top + 24}" x2="580" y2="${transaction.top + 24}" stroke="#d6d3c8" stroke-width="1" />
      `;
    })
    .join("\n");

  const svg = `
    <svg xmlns="http://www.w3.org/2000/svg" width="${pageWidth * 2}" height="${pageHeight * 2}" viewBox="0 0 ${pageWidth} ${pageHeight}">
      <rect width="${pageWidth}" height="${pageHeight}" fill="#fbf9f1" />
      <rect x="24" y="24" width="${pageWidth - 48}" height="${pageHeight - 48}" fill="none" stroke="#c8c4b8" stroke-width="1" />
      <text x="45" y="60" class="title">HARBOUR CREDIT UNION</text>
      <text x="45" y="82" class="label">Synthetic scanned statement</text>
      <text x="45" y="100" class="label">Account: **** 7310</text>
      <text x="45" y="118" class="label">Statement period: 2026-10-01 to 2026-10-31</text>
      <text x="580" y="100" class="label" text-anchor="end">USD</text>
      <text x="45" y="145" class="heading">DATE</text>
      <text x="160" y="145" class="heading">DETAILS</text>
      <text x="440" y="145" class="heading" text-anchor="end">DEBIT</text>
      <text x="505" y="145" class="heading" text-anchor="end">CREDIT</text>
      <text x="580" y="145" class="heading" text-anchor="end">BALANCE</text>
      <line x1="40" y1="154" x2="580" y2="154" stroke="#3f3a32" stroke-width="1.5" />
      ${rowMarkup}
      <line x1="40" y1="620" x2="580" y2="620" stroke="#3f3a32" stroke-width="1.5" />
      <text x="45" y="650" class="heading">Opening balance</text>
      <text x="580" y="650" class="mono" text-anchor="end">${formatMinorUnits(openingBalanceMinor)}</text>
      <text x="45" y="672" class="heading">Debits</text>
      <text x="580" y="672" class="mono" text-anchor="end">${formatMinorUnits(Number(summarize(layoutCTransactions, openingBalanceMinor).debitTotalMinor))}</text>
      <text x="45" y="694" class="heading">Credits</text>
      <text x="580" y="694" class="mono" text-anchor="end">${formatMinorUnits(Number(summarize(layoutCTransactions, openingBalanceMinor).creditTotalMinor))}</text>
      <text x="45" y="716" class="heading">Closing balance</text>
      <text x="580" y="716" class="mono" text-anchor="end">${formatMinorUnits(Number(summarize(layoutCTransactions, openingBalanceMinor).closingBalanceMinor))}</text>
      <text x="45" y="760" class="label">SCANNED COPY - image-only test fixture</text>
      <style>
        .title { font-family: 'Courier New', monospace; font-size: 20px; font-weight: bold; fill: #27231d; }
        .label { font-family: 'Courier New', monospace; font-size: 11px; fill: #4b463e; }
        .heading { font-family: 'Courier New', monospace; font-size: 11px; font-weight: bold; fill: #27231d; }
        .mono { font-family: 'Courier New', monospace; font-size: 10px; fill: #27231d; }
      </style>
    </svg>
  `;

  const png = await sharp(Buffer.from(svg)).grayscale().png({ compressionLevel: 9 }).toBuffer();
  const pdf = await PDFDocument.create();
  pdf.setTitle("Synthetic statement - Harbour Credit Union");
  pdf.setAuthor("Motion synthetic fixtures");
  pdf.setSubject("Synthetic scanned credit card statement");

  const page = pdf.addPage([pageWidth, pageHeight]);
  const image = await pdf.embedPng(png);
  page.drawImage(image, { x: 0, y: 0, width: pageWidth, height: pageHeight });

  const transactions = rows.map((transaction) =>
    fixtureTransaction(transaction, "USD", svgRowAnchor(transaction.top, 30)),
  );

  return {
    id: "layout-c-scanned",
    description: "Image-only scanned statement with a running balance and no embedded text layer.",
    kind: "scanned",
    sourceFile: "layout-c-scanned.pdf",
    bankName: "Harbour Credit Union",
    accountLabel: "Harbour Credit Union Visa",
    accountLast4: "7310",
    periodStart: "2026-10-01",
    periodEnd: "2026-10-31",
    currency: "USD",
    pageCount: 1,
    transactions,
    controls: summarize(layoutCTransactions, openingBalanceMinor),
    bytes: await pdf.save(),
  };
}

function escapeXml(value) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

await mkdir(outputDir, { recursive: true });

for (const createFixture of [createLayoutA, createLayoutB, createLayoutC]) {
  const fixture = await createFixture();
  await writeFixture(fixture);
  console.log(`Generated ${fixture.sourceFile} and ${fixture.id}.json`);
}
