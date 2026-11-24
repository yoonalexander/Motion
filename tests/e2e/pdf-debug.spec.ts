import path from "node:path";
import { expect, test } from "@playwright/test";
import { createGeometryPdf } from "../fixtures/pdf-geometry";

const fixtures = path.resolve("tests/fixtures/synthetic");

function expectedGeometryRect(
  [left, bottom, right, top]: [number, number, number, number],
  rotation: number,
) {
  // The fixture crop is 200 x 100 PDF units. Equivalent PDF.js projections
  // for its four right-angle rotations at scale 1.
  const x0 = left * 200;
  const x1 = right * 200;
  const y0 = bottom * 100;
  const y1 = top * 100;
  switch (rotation) {
    case 0:
      return { left: x0, top: 100 - y1, width: x1 - x0, height: y1 - y0 };
    case 90:
      return { left: y0, top: x0, width: y1 - y0, height: x1 - x0 };
    case 180:
      return { left: 200 - x1, top: y0, width: x1 - x0, height: y1 - y0 };
    case 270:
      return { left: 100 - y1, top: 200 - x1, width: y1 - y0, height: x1 - x0 };
    default:
      throw new Error(`Unexpected PDF rotation: ${rotation}`);
  }
}

test("dev PDF debugger carries verified context, parsed selection, and reset locally", async ({
  page,
}) => {
  const pageErrors: string[] = [];
  const postedRequests: string[] = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  page.on("request", (request) => {
    if (["POST", "PUT", "PATCH"].includes(request.method())) postedRequests.push(request.url());
  });

  await page.goto("/");
  await expect(page.getByText("PDF Extraction Debug (NEI-005 · Development)")).toHaveCount(0);
  await page.goto("/debug/pdf");
  await expect(page.getByRole("heading", { name: "PDF extraction debugger" })).toBeVisible();
  await page
    .locator("#pdf-debug-file-input")
    .setInputFiles(path.join(fixtures, "layout-a-text.pdf"));
  await expect(page.getByText("Page 1 of 1", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Parsed", exact: true }).click();

  const rows = page.getByTestId("parsed-candidate-row");
  await expect(rows.first()).toBeVisible();
  await expect(page.getByTestId("statement-context-status")).toContainText(
    "Period unavailable or unverified",
  );

  await page.getByLabel("Period start").fill("2026-09-01");
  await page.getByLabel("Period end").fill("2026-09-30");
  await page.getByLabel("Statement period verified").check();
  await page.getByLabel("Date order").selectOption("MDY");
  await page.getByLabel("Statement currency").fill("CAD");
  await page.getByLabel("Positive amount means").selectOption("credit");
  await expect(page.getByTestId("statement-context-status")).toContainText("Period verified");
  await expect(page.getByTestId("statement-context-status")).toContainText("currency CAD");

  const coffee = rows.filter({ hasText: "COFFEE HOUSE DOWNTOWN" }).first();
  await expect(coffee).toBeVisible();
  await coffee.click();
  const highlight = page.getByTestId("pdf-source-highlight");
  await expect(highlight).toBeVisible();
  await expect(page.getByTestId("selected-parsed-candidate")).toContainText(
    "COFFEE HOUSE DOWNTOWN",
  );
  await expect(page.getByTestId("selected-parsed-candidate")).toContainText("2026-09-02");
  await page.getByText("inspect", { exact: true }).click();
  await expect(page.getByTestId("parsed-raw-fields")).toContainText("detectedDate");

  const beforeZoom = await highlight.boundingBox();
  await page.getByRole("button", { name: "Zoom in", exact: true }).click();
  await expect(page.getByText("125%", { exact: true })).toBeVisible();
  const afterZoom = await highlight.boundingBox();
  expect(beforeZoom).not.toBeNull();
  expect(afterZoom).not.toBeNull();
  expect(afterZoom!.width).toBeGreaterThan(beforeZoom!.width);
  await expect(page.getByTestId("reconstruction-coverage")).toContainText(
    "Verified statement transaction count: unavailable",
  );

  await page.getByRole("button", { name: "Reset document", exact: true }).click();
  await expect(page.locator("canvas")).toHaveCount(0);
  await expect(page.getByTestId("pdf-source-highlight")).toHaveCount(0);
  await expect(page.getByLabel("Statement currency")).toHaveCount(0);
  await page
    .locator("#pdf-debug-file-input")
    .setInputFiles(path.join(fixtures, "layout-a-text.pdf"));
  await expect(page.getByLabel("Statement currency")).toHaveValue("");
  expect(pageErrors).toEqual([]);
  expect(postedRequests).toEqual([]);
});

test("parsed rows and overlays follow page navigation on the real Motion PDF", async ({ page }) => {
  await page.goto("/debug/pdf");
  await page
    .locator("#pdf-debug-file-input")
    .setInputFiles(path.join(fixtures, "motion-synthetic-credit-card-statement.pdf"));
  await expect(page.getByText("Page 1 of 4", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Parsed", exact: true }).click();
  const firstRow = page.getByTestId("parsed-candidate-row").first();
  await expect(firstRow).toBeVisible();
  await firstRow.click();
  await expect(page.getByTestId("pdf-source-highlight")).toBeVisible();

  await page.getByRole("button", { name: "Next page", exact: true }).click();
  await expect(page.getByText("Page 2 of 4", { exact: true })).toBeVisible();
  await expect(page.getByTestId("pdf-source-highlight")).toHaveCount(0);
  await page.getByRole("button", { name: "Previous page", exact: true }).click();
  await expect(page.getByText("Page 1 of 4", { exact: true })).toBeVisible();
  await expect(page.getByTestId("pdf-source-highlight")).toHaveCount(0);
});

test("source overlays use the rotated cropped page viewport", async ({ page }) => {
  test.setTimeout(20_000);
  const geometryPdf = await createGeometryPdf();
  const geometryBuffer = Buffer.from(geometryPdf);
  await page.goto("/debug/pdf");
  await page.locator("#pdf-debug-file-input").setInputFiles({
    name: "cropped-rotated-geometry.pdf",
    mimeType: "application/pdf",
    buffer: geometryBuffer,
  });
  await expect(page.getByText("Page 1 of 4", { exact: true })).toBeVisible();

  for (const [index, rotation] of [0, 90, 180, 270].entries()) {
    await expect(page.getByTestId("pdf-debug-render-surface")).toHaveAttribute(
      "data-viewport-rotation",
      String(rotation),
    );
    const token = page.getByTestId("extracted-token").filter({ hasText: "Ag" }).first();
    await expect(token).toBeVisible();
    const bbox = JSON.parse((await token.getAttribute("data-token-bbox")) ?? "[]") as [
      number,
      number,
      number,
      number,
    ];
    await token.click();
    const overlay = page.getByTestId("pdf-source-highlight");
    await expect(overlay).toBeVisible();
    const canvasBox = await page.locator("canvas").boundingBox();
    const overlayBox = await overlay.boundingBox();
    const surface = page.getByTestId("pdf-debug-render-surface");
    const intrinsicWidth = Number(await surface.getAttribute("data-viewport-width"));
    const intrinsicHeight = Number(await surface.getAttribute("data-viewport-height"));
    const expected = expectedGeometryRect(bbox, rotation);
    expect(canvasBox).not.toBeNull();
    expect(overlayBox).not.toBeNull();
    const cssPerIntrinsicX = canvasBox!.width / intrinsicWidth;
    const cssPerIntrinsicY = canvasBox!.height / intrinsicHeight;
    const expectedLeft = expected.left * cssPerIntrinsicX;
    const expectedTop = expected.top * cssPerIntrinsicY;
    const expectedWidth = expected.width * cssPerIntrinsicX;
    const expectedHeight = expected.height * cssPerIntrinsicY;
    // Tailwind uses border-box sizing, so the overlay bounds map directly to
    // the projected CSS rectangle within one intrinsic canvas pixel.
    expect(Math.abs(overlayBox!.x - canvasBox!.x - expectedLeft)).toBeLessThanOrEqual(
      cssPerIntrinsicX,
    );
    expect(Math.abs(overlayBox!.y - canvasBox!.y - expectedTop)).toBeLessThanOrEqual(
      cssPerIntrinsicY,
    );
    expect(Math.abs(overlayBox!.width - expectedWidth)).toBeLessThanOrEqual(cssPerIntrinsicX);
    expect(Math.abs(overlayBox!.height - expectedHeight)).toBeLessThanOrEqual(cssPerIntrinsicY);
    if (index < 3) await page.getByRole("button", { name: "Next page", exact: true }).click();
  }
});
