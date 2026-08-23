import { test, expect } from "@playwright/test";

test("home page offers hosting and joining", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Quiz Live" })).toBeVisible();
  await expect(page.getByRole("link", { name: "I'm Hosting" })).toBeVisible();
  await expect(page.getByRole("link", { name: "I'm Joining" })).toBeVisible();
});

test("join page accepts a PIN and nickname", async ({ page }) => {
  await page.goto("/join");
  await expect(page.getByRole("heading", { name: "Enter the game" })).toBeVisible();
  await page.getByPlaceholder("Game PIN").fill("123456");
  await page.getByPlaceholder("Nickname").fill("Test Player");
  await expect(page.getByRole("button", { name: "Join" })).toBeEnabled();
});

test("host login page requires a passcode", async ({ page }) => {
  await page.goto("/host/login");
  await expect(page.getByRole("heading", { name: "Enter the host passcode" })).toBeVisible();
  await page.getByRole("button", { name: "Enter" }).click();
  await expect(page.getByPlaceholder("Passcode")).toHaveJSProperty("validity.valueMissing", true);
});
