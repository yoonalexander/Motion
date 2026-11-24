import path from "node:path";
import { expect, test } from "@playwright/test";

const fixtures = path.resolve("tests/fixtures/synthetic");

test("recovers from a damaged PDF and renders the latest page, zoom, and replacement", async ({
  page,
}) => {
  const pageErrors: string[] = [];
  const postedRequests: string[] = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  page.on("request", (request) => {
    if (["POST", "PUT", "PATCH"].includes(request.method())) {
      postedRequests.push(request.url());
    }
  });
  await page.goto("/");

  const fileInput = page.locator("#pdf-file-input");
  await fileInput.setInputFiles({
    name: "damaged.pdf",
    mimeType: "application/pdf",
    buffer: Buffer.from("Invalid synthetic PDF contents"),
  });
  await page.getByRole("button", { name: "Try again", exact: true }).click();

  await fileInput.setInputFiles(path.join(fixtures, "motion-synthetic-credit-card-statement.pdf"));
  await expect(page.getByText("Page 1 of 4", { exact: true })).toBeVisible();
  const next = page.getByRole("button", { name: "Next page", exact: true });
  const zoom = page.getByRole("button", { name: "Zoom in", exact: true });
  await next.click();
  await zoom.click();
  await next.click();
  await zoom.click();

  await expect(page.getByText("Page 3 of 4", { exact: true })).toBeVisible();
  await expect(page.getByText("150%", { exact: true })).toBeVisible();
  await expect(page.locator("[data-viewport-width]")).toHaveAttribute("data-viewport-width", "918");

  await fileInput.setInputFiles(path.join(fixtures, "layout-c-scanned.pdf"));
  await expect(page.getByText("Page 1 of 1", { exact: true })).toBeVisible();
  await expect(page.locator("[data-viewport-width]")).toBeVisible();
  await expect(next).toBeDisabled();
  await expect(page.locator("canvas")).toBeVisible();
  expect(pageErrors).toEqual([]);
  expect(postedRequests).toEqual([]);
});
