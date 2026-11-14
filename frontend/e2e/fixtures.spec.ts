import { expect, test } from "@playwright/test";

test("resets the fixture transport and projects its snapshot and health into the dashboard", async ({ page }) => {
  await page.goto("http://127.0.0.1:3100/");
  const scenario = page.getByLabel("Fixture scenario");
  await scenario.selectOption("initializing");
  await expect(page.getByText("Initializing fixture application", { exact: true })).toBeVisible();
  await scenario.selectOption("searching");
  await expect(page.getByText("Searching", { exact: true })).toBeVisible();
  await scenario.selectOption("paused");
  await expect(page.getByText("Paused", { exact: true })).toBeVisible();
  await scenario.selectOption("pause-saving");
  await expect(page.getByText("Paused", { exact: true })).toBeVisible();
  await expect(page.getByText(/Save pending/)).toBeVisible();
  await scenario.selectOption("failed");
  await expect(page.getByRole("region", { name: "Search status" }).getByRole("alert")).toContainText("STORAGE_UNAVAILABLE");
  await scenario.selectOption("controller-ready");
  await expect(page.getByText("Gestures unavailable · Controller ready")).toBeVisible();
  await scenario.selectOption("ended");
  await expect(page.getByText("No active search", { exact: true })).toBeVisible();
  await page.reload();
  await expect(scenario).toHaveValue("idle");
  await expect(page.getByText("No active search", { exact: true })).toBeVisible();
});

test("releases protected sample images on replacement, expiry, reset and navigation", async ({ page }) => {
  await page.addInitScript(() => {
    const create = URL.createObjectURL.bind(URL);
    const revoke = URL.revokeObjectURL.bind(URL);
    const active = new Set<string>();
    Object.assign(window, { activeFixtureUrls: active });
    URL.createObjectURL = (blob) => {
      const url = create(blob);
      active.add(url);
      return url;
    };
    URL.revokeObjectURL = (url) => {
      active.delete(url);
      revoke(url);
    };
  });
  const activeUrls = () => page.evaluate(() => [...(window as Window & { activeFixtureUrls?: Set<string> }).activeFixtureUrls!]);
  await page.goto("http://127.0.0.1:3100/");
  const media = page.getByLabel("Sample media", { exact: true });
  await expect(page.getByText("Sample image · Not live")).toBeVisible();
  const image = page.getByRole("img", { name: "Synthetic geometric swatch" });
  await expect.poll(() => image.evaluate((node: HTMLImageElement) => [node.naturalWidth, node.naturalHeight])).toEqual([32, 24]);
  const original = await image.getAttribute("src");
  await media.selectOption("sample-confirmed-evidence");
  await expect(page.getByText("Sample image · Captured evidence")).toBeVisible();
  await expect.poll(() => image.evaluate((node: HTMLImageElement) => node.naturalWidth)).toBe(32);
  expect(await activeUrls()).toEqual([await image.getAttribute("src")]);
  expect(await activeUrls()).not.toContain(original);
  await media.selectOption("sample-missing-evidence");
  await expect(page.getByText("Sample media is missing.")).toBeVisible();
  expect(await activeUrls()).toEqual([]);
  await media.selectOption("sample-headphones-reference");
  await expect(page.getByText("Sample media is corrupt.")).toBeVisible();
  await media.selectOption("sample-wallet-reference");
  await expect(image).toBeVisible();
  await page.getByRole("button", { name: "Expire sample media" }).click();
  await expect(page.getByText("Sample record expired.")).toBeVisible();
  expect(await activeUrls()).toEqual([]);
  await page.getByRole("button", { name: "Reset scenario" }).click();
  await expect(image).toBeVisible();
  expect(await activeUrls()).toHaveLength(1);
  await page.getByRole("link", { name: "Settings" }).click();
  await expect(page.getByRole("heading", { name: "Settings" })).toBeVisible();
  expect(await activeUrls()).toEqual([]);
});

test("disconnected mode hides the harness even when requested", async ({ page }) => {
  await page.goto("http://127.0.0.1:3101/");
  await expect(page.getByRole("heading", { name: "Application data unavailable" })).toBeVisible();
  await expect(page.getByLabel("Fixture scenario")).toHaveCount(0);
  await expect(page.getByRole("heading", { name: "Sample media preview" })).toHaveCount(0);
});
