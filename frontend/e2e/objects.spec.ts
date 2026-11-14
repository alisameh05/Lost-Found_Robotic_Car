import { expect, test, type Page } from "@playwright/test";

test.use({ baseURL: "http://127.0.0.1:3100" });

const library = (page: Page) => page.getByRole("list", { name: "Object records" });
const preview = (page: Page) => page.getByRole("region", { name: "Selected object" });
const search = (page: Page) => page.getByRole("searchbox", { name: "Search objects" });
const next = (page: Page) => page.getByRole("button", { name: "Next", exact: true });
const previous = (page: Page) => page.getByRole("button", { name: "Previous", exact: true });

async function openScenario(page: Page, scenario: string) {
  await page.goto("/");
  await page.getByLabel("Fixture scenario").selectOption(scenario);
  await page.getByRole("link", { name: "Objects / History", exact: true }).click();
}

test("combines literal name search and status filters and opens a record by keyboard", async ({ page }) => {
  await page.goto("/objects");
  await expect(library(page).getByRole("listitem")).toHaveCount(25);
  await search(page).fill("\u00a0sTrAsSe%_\u00a0");
  await search(page).focus();
  await page.keyboard.press("Tab");
  await expect(page.getByRole("button", { name: "All", exact: true })).toBeFocused();
  await page.keyboard.press("Tab");
  const lost = page.getByRole("button", { name: "Lost", exact: true });
  await expect(lost).toBeFocused();
  await page.keyboard.press("Space");
  await expect(lost).toHaveAttribute("aria-pressed", "true");
  await expect(library(page).getByRole("listitem")).toHaveCount(2);
  await expect(preview(page).getByRole("heading", { name: "Straße%_ Café keys", exact: true })).toBeVisible();
  await page.keyboard.press("Tab");
  await expect(page.getByRole("button", { name: "Found", exact: true })).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("heading", { name: "No matching objects" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "No objects registered" })).toHaveCount(0);
  await lost.click();
  await lost.focus();
  await page.keyboard.press("Tab");
  await page.keyboard.press("Tab");
  await expect(page.getByRole("button", { name: "Preview Straße%_ Café keys", exact: true })).toBeFocused();
  await page.keyboard.press("Tab");
  const detail = page.getByRole("link", { name: "View details for Straße%_ Café keys", exact: true });
  await expect(detail).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(/\/objects\/sample-keys-a$/);
  await expect(page.getByRole("heading", { name: "Straße%_ Café keys", exact: true })).toBeVisible();
  await expect(page.getByRole("link", { name: "Back to Objects" })).toHaveAttribute("href", "/objects");
  await expect(page.getByRole("link", { name: "Register Another Object" })).toHaveAttribute("href", "/objects/new");
});

test("continues forward, returns to previous results and resets on filter changes", async ({ page }) => {
  await page.goto("/objects");
  await expect(page.getByText("Page 1 · 25 objects · Newest first")).toBeVisible();
  await next(page).click();
  await expect(page.getByText("Page 2 · 3 objects · Newest first")).toBeVisible();
  await expect(next(page)).toBeDisabled();
  await previous(page).click();
  await expect(page.getByText("Page 1 · 25 objects · Newest first")).toBeVisible();
  await next(page).click();
  await expect(page.getByText("Page 2 · 3 objects · Newest first")).toBeVisible();
  await search(page).fill("wallet");
  await expect(page.getByText("Page 1 · 1 object · Newest first")).toBeVisible();
  await expect(previous(page)).toBeDisabled();
  await search(page).fill("🧭".repeat(121));
  await expect(search(page)).toHaveAttribute("aria-invalid", "true");
  await expect(library(page)).toHaveCount(0);
});

test("recovers failed list and detail reads and restarts an expired cursor with the same filters", async ({ page }) => {
  await openScenario(page, "records-recovery");
  await expect(page.getByRole("main").getByRole("alert")).toContainText("Objects unavailable");
  await page.getByRole("button", { name: "Retry" }).click();
  await expect(library(page).getByRole("listitem")).toHaveCount(25);
  await page.getByRole("button", { name: "Lost", exact: true }).click();
  await next(page).click();
  await expect(page.getByText("Page 1 · 25 objects · Newest first")).toBeVisible();
  await expect(page.getByRole("button", { name: "Lost", exact: true })).toHaveAttribute("aria-pressed", "true");
  await expect(library(page).getByText("Headphones")).toHaveCount(0);
  await next(page).click();
  await expect(page.getByText("Page 2 · 2 objects · Newest first")).toBeVisible();
  await page.getByRole("link", { name: "View Object Details" }).click();
  await expect(page.getByRole("main").getByRole("alert")).toContainText("Object details unavailable");
  await page.getByRole("button", { name: "Retry" }).click();
  await expect(page.getByRole("heading", { name: "Storage tag 19", exact: true })).toBeVisible();
});

test("shows Found metadata, protected reference failures, and distinct expired and missing records", async ({ page }) => {
  await page.goto("/objects/sample-headphones");
  await expect(page.getByText("Found", { exact: true })).toBeVisible();
  await expect(page.getByText("Confirmed", { exact: true })).toBeVisible();
  await expect(page.locator("time")).toHaveCount(3);
  await expect(page.getByRole("button", { name: "Start Search" })).toHaveAccessibleDescription("This object has already been found.");
  await expect(page.getByText("Media corrupt", { exact: true })).toHaveCount(2);
  await expect(page.getByRole("img")).toHaveCount(0);
  await page.goto("/objects/sample-expired");
  await expect(page.getByText("Record expired", { exact: true })).toBeVisible();
  await page.goto("/objects/sample-purged");
  await expect(page.getByRole("heading", { name: "Object not found" })).toBeVisible();
  await expect(page.getByText("Record expired", { exact: true })).toHaveCount(0);

  await openScenario(page, "records-recovery");
  await page.getByRole("button", { name: "Retry" }).click();
  await expect(preview(page).getByRole("img", { name: "Reference for Black wallet" })).toHaveAttribute("src", /^blob:/);
  await page.getByRole("button", { name: "Preview Reading glasses" }).click();
  await expect(preview(page).getByText("Media missing", { exact: true })).toBeVisible();
  await search(page).fill("Café");
  await expect(preview(page).getByText("Media unavailable", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Preview Straße%_ Café key ring", exact: true }).click();
  await expect(preview(page).getByText("Image could not be decoded", { exact: true })).toBeVisible();
  await expect(preview(page).getByRole("img")).toHaveCount(0);
});

test("keeps search navigation read-only and blocks setup during Searching, Paused and storage failure", async ({ page }) => {
  await openScenario(page, "controller-ready");
  await preview(page).getByRole("link", { name: "Start Search" }).click();
  await expect(page).toHaveURL(/\/objects\/sample-wallet\/search$/);
  await page.getByRole("link", { name: "Dashboard", exact: true }).click();
  await expect(page.getByText("Fixture mutation requests (0)")).toBeVisible();

  const scenario = page.getByLabel("Fixture scenario");
  const objectsLink = page.getByRole("link", { name: "Objects / History", exact: true });
  for (const state of ["searching", "paused"] as const) {
    await scenario.selectOption(state);
    await objectsLink.click();
    const stop = page.getByRole("button", { name: "Emergency Stop" });
    const sidebarReturn = page.getByRole("complementary").getByRole("link", { name: "Return to Active Search" });
    await sidebarReturn.focus();
    await page.keyboard.press("Tab");
    await expect(stop).toBeFocused();
    await expect(preview(page).getByRole("button", { name: "Start Search" }))
      .toHaveAccessibleDescription(`End the ${state} session before starting another search.`);
    await page.getByRole("region", { name: "Active search", exact: true }).getByRole("link", { name: "Return to Active Search" }).click();
    await expect(page).toHaveURL(/\/sessions\/sample-search\/live$/);
    await page.getByRole("link", { name: "Dashboard", exact: true }).click();
    await expect(page.getByText("Fixture mutation requests (0)")).toBeVisible();
  }

  await scenario.selectOption("deletion-failed");
  await objectsLink.click();
  await expect(preview(page).getByRole("button", { name: "Start Search" })).toHaveAccessibleDescription("Storage is unavailable.");
});

test("renders the objects screens at design and laptop sizes with local assets and enlarged text", async ({ page }, testInfo) => {
  const external: string[] = [];
  await page.route("http{,s}://**/*", async (route) => {
    if (new URL(route.request().url()).origin === "http://127.0.0.1:3100") return route.continue();
    external.push(route.request().url());
    await route.abort();
  });
  await page.setViewportSize({ width: 1440, height: 960 });
  await openScenario(page, "paused");
  await expect(preview(page).getByRole("img", { name: "Reference for Black wallet" })).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath("objects-1440.png") });
  await preview(page).getByRole("link", { name: "View Object Details" }).click();
  const image = page.getByRole("img", { name: "Reference for Black wallet", exact: true });
  const target = page.getByRole("img", { name: "Selected target from Reference for Black wallet", exact: true });
  await expect.poll(() => image.evaluate((node: HTMLImageElement) => node.naturalWidth)).toBe(640);
  await expect(target).toHaveAttribute("src", (await image.getAttribute("src"))!);
  await page.screenshot({ path: testInfo.outputPath("object-details-1440.png") });

  await page.setViewportSize({ width: 1366, height: 768 });
  await expect(page.getByRole("button", { name: "Emergency Stop" })).toBeInViewport();
  await expect(target).toBeInViewport();
  await page.screenshot({ path: testInfo.outputPath("object-details-1366.png") });
  await page.getByRole("link", { name: "Back to Objects" }).click();
  await expect(preview(page)).toBeInViewport();
  await page.screenshot({ path: testInfo.outputPath("objects-1366.png") });

  await page.addStyleTag({ content: "html { font-size: 200%; }" });
  const noHorizontalScroll = () => page.evaluate(() => document.documentElement.scrollWidth === innerWidth);
  await expect.poll(noHorizontalScroll).toBe(true);
  await search(page).fill("Black wallet");
  const lost = page.getByRole("button", { name: "Lost", exact: true });
  await search(page).focus();
  await page.keyboard.press("Tab");
  await page.keyboard.press("Tab");
  await expect(lost).toBeFocused();
  expect(await lost.evaluate((node) => getComputedStyle(node).outlineWidth)).toBe("2px");
  await page.keyboard.press("Space");
  await expect(lost).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByText("Page 1 · 1 object · Newest first")).toHaveAttribute("role", "status");
  await page.screenshot({ path: testInfo.outputPath("objects-200-text.png"), fullPage: true });
  await preview(page).getByRole("link", { name: "View Object Details" }).click();
  await expect(target).toBeVisible();
  await expect.poll(noHorizontalScroll).toBe(true);
  await page.screenshot({ path: testInfo.outputPath("object-details-200-text.png"), fullPage: true });
  expect(external).toEqual([]);
});
