import { expect, test } from "@playwright/test";

test("renders the Phase 0 application shell", async ({ page }) => {
  await page.goto("/");

  await expect(page.getByRole("heading", { name: "Notion Expense Importer" })).toBeVisible();
  await expect(page.getByText("Phase 0 · Foundations complete")).toBeVisible();
  await expect(page.getByText("Synthetic PDF fixtures")).toBeVisible();
  await expect(page.getByText("PDF extraction and review workflow")).toBeVisible();
});
