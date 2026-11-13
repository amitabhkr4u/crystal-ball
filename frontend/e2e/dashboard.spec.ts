import { test, expect } from "@playwright/test";

test("command centre renders the operations dashboard and tenant sign-in", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Operations overview" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "IoT alert intelligence" })).toBeVisible();
  await expect(page.getByRole("textbox", { name: "Tenant slug" })).toBeVisible();
  await expect(page.getByRole("link", { name: /API docs/ })).toBeVisible();
});
