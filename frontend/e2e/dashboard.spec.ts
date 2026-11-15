import { expect, test } from "@playwright/test";

test.use({ baseURL: "http://127.0.0.1:3100" });

test("shows recent objects and their saved searches with record links", async ({ page }) => {
  await page.goto("/");
  const dashboard = page.getByRole("main");
  await expect(dashboard.getByRole("link", { name: "Register Object" }).first()).toHaveAttribute("href", "/objects/new");
  await expect(dashboard.getByRole("link", { name: "View Objects" })).toHaveAttribute("href", "/objects");
  await expect(dashboard.getByRole("link", { name: "View Devices" })).toHaveAttribute("href", "/devices");

  const objects = dashboard.getByRole("region", { name: "Recent objects" });
  await expect(objects.getByRole("list").getByRole("link")).toHaveCount(3);
  await expect(objects.getByRole("list").getByRole("link").nth(0)).toHaveAttribute("href", "/objects/sample-wallet");
  await expect(objects.getByRole("list").getByRole("link").nth(1)).toHaveAttribute("href", "/objects/sample-office-keys");
  await expect(objects.getByRole("list").getByRole("link").nth(2)).toHaveAttribute("href", "/objects/sample-headphones");

  const searches = dashboard.getByRole("region", { name: "Recent searches" });
  await expect(searches.getByText("Sessions for recent objects", { exact: false })).toBeVisible();
  const links = searches.getByRole("list").getByRole("link");
  await expect(links).toHaveCount(3);
  await expect(links.nth(0)).toHaveAttribute("href", "/sessions/sample-search");
  await expect(links.nth(1)).toHaveAttribute("href", "/sessions/sample-confirmed-search");
  await expect(links.nth(2)).toHaveAttribute("href", "/sessions/sample-interrupted-search");
  await expect(links.nth(1)).toContainText("Found");
  await links.nth(1).click();
  await expect(dashboard.getByRole("heading", { name: "Session Details" })).toBeVisible();
  await page.getByRole("navigation", { name: "Main navigation" }).getByRole("link", { name: "Dashboard" }).click();
  await expect(page.getByText("Fixture mutation requests (0)", { exact: true })).toBeVisible();
});

test("first use offers registration and confirms the session scope is empty", async ({ page }) => {
  await page.goto("/");
  await page.getByLabel("Fixture scenario").selectOption("empty");
  const objects = page.getByRole("region", { name: "Recent objects" });
  await expect(objects.getByRole("status")).toContainText("Register your first object");
  await expect(page.getByRole("region", { name: "Recent searches" }).getByRole("status")).toContainText("No sessions for recent objects");
  await objects.getByRole("link", { name: "Register Object" }).click();
  await expect(page.getByRole("heading", { name: "Register Object", exact: true })).toBeVisible();
});

test("keeps known outcomes on failure, retries, and clears expired record links", async ({ page }) => {
  await page.goto("/");
  const scenario = page.getByLabel("Fixture scenario");
  const searches = page.getByRole("region", { name: "Recent searches" });
  const links = searches.getByRole("list").getByRole("link");
  await scenario.selectOption("dashboard-recovery");
  await expect(searches.getByRole("status")).toContainText("Recent searches incomplete");
  await expect(links).toHaveCount(3);
  await expect(links.nth(0)).toHaveAttribute("href", "/sessions/sample-tied-search-a");
  await expect(links.nth(1)).toHaveAttribute("href", "/sessions/sample-tied-search-Z");
  await expect(links.nth(2)).toHaveAttribute("href", "/sessions/sample-confirmed-search");
  await searches.getByRole("button", { name: "Retry recent searches" }).click();
  await expect(searches.getByRole("button", { name: "Retry recent searches" })).toHaveCount(0);
  await expect.poll(() => links.evaluateAll((items) => items.map((item) => item.getAttribute("href")))).toEqual([
    "/sessions/sample-tied-search-a", "/sessions/sample-tied-search-Z", "/sessions/sample-search",
  ]);

  await page.getByRole("button", { name: "Inspect sample media" }).click();
  await page.getByRole("button", { name: "Expire sample media" }).click();
  const objects = page.getByRole("region", { name: "Recent objects" });
  await expect(objects.getByRole("list")).toHaveCount(0);
  await expect(searches.getByRole("status")).toContainText("No sessions for recent objects");
  await expect(links).toHaveCount(0);
});

test("uses current search identity and shares the Devices mode and readiness", async ({ page }) => {
  await page.goto("/");
  const scenario = page.getByLabel("Fixture scenario");
  const active = page.getByRole("region", { name: "Active search", exact: true });
  const devices = page.getByRole("region", { name: "Device readiness" });
  await scenario.selectOption("searching");
  await expect(active.getByRole("heading", { name: "Black wallet" })).toBeVisible();
  await expect(active.getByRole("status")).toContainText("Searching");
  await expect(active.getByText("Controller (PS4)", { exact: false })).toBeVisible();
  await expect(devices.getByRole("status")).toContainText("Controller (PS4) requirements ready");
  await expect(devices.getByRole("listitem").filter({ hasText: "Laptop webcam" })).toContainText("Inactive");
  await devices.getByRole("link", { name: "View Devices" }).click();
  await expect(page.getByRole("status").filter({ hasText: "Controller (PS4) requirements ready" })).toBeVisible();
  await page.getByRole("navigation", { name: "Main navigation" }).getByRole("link", { name: "Dashboard" }).click();

  await scenario.selectOption("active-readiness-retry");
  await expect(page.getByRole("region", { name: "Search status" }).getByRole("status")).toContainText("Health reports Paused");
  await expect(page.getByRole("link", { name: "Return to Search", exact: true })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Emergency Stop" })).toBeVisible();
  await page.getByRole("button", { name: "Retry snapshot" }).click();
  await expect(active.getByRole("status")).toContainText("Paused");
  await scenario.selectOption("expiry-grace");
  const returnLink = active.getByRole("link", { name: "Return to Search", exact: true });
  await expect(returnLink).toHaveAttribute("href", "/sessions/sample-grace-search/live");
  await returnLink.click();
  await expect(page.getByRole("heading", { name: "Search Workspace" })).toBeVisible();
  await expect(page).toHaveURL(/sample-grace-search\/live$/);
});

test("keeps Dashboard and its destinations usable when fixture controls are disabled", async ({ page }) => {
  await page.goto("http://127.0.0.1:3102/");
  await expect(page.getByRole("heading", { name: "Dashboard" })).toBeVisible();
  await expect(page.getByRole("region", { name: "Recent objects" }).getByRole("link", { name: /Black wallet/ })).toBeVisible();
  await expect(page.getByLabel("Fixture scenario")).toHaveCount(0);
  await expect(page.getByText("Fixture mode · Sample data · No robot connected", { exact: true })).toBeVisible();
  await page.getByRole("link", { name: "View Objects", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Objects / History" })).toBeVisible();
});

test("keeps navigation available while disconnected without reporting an idle or empty workspace", async ({ page }) => {
  await page.goto("http://127.0.0.1:3101/");
  await expect(page.getByRole("region", { name: "Search status" })).toContainText("Search status unavailable");
  await expect(page.getByText("Recent objects unavailable")).toBeVisible();
  await expect(page.getByText("Register your first object")).toHaveCount(0);
  await expect(page.getByRole("link", { name: "View Devices" })).toHaveAttribute("href", "/devices");
  await expect(page.getByRole("link", { name: "Register Object" })).toHaveAttribute("href", "/objects/new");
});

test("keeps keyboard order and text readable at the design sizes with external requests blocked", async ({ page }, testInfo) => {
  const external: string[] = [];
  await page.route("**/*", (route) => {
    if (new URL(route.request().url()).origin === "http://127.0.0.1:3100") return route.continue();
    external.push(route.request().url());
    return route.abort();
  });
  await page.setViewportSize({ width: 1440, height: 960 });
  await page.goto("/");
  await page.getByLabel("Fixture scenario").selectOption("paused");
  const active = page.getByRole("region", { name: "Active search", exact: true });
  await expect(active.getByRole("status")).toContainText("Paused");
  await expect(page.getByRole("region", { name: "Recent searches" }).getByRole("list")).toBeVisible();
  await page.evaluate(() => document.fonts.ready);
  await page.screenshot({ path: testInfo.outputPath("dashboard-1440x960.png") });
  await page.setViewportSize({ width: 1366, height: 768 });
  const sidebarReturn = page.getByRole("link", { name: "Return to Active Search", exact: true });
  await sidebarReturn.focus();
  await page.keyboard.press("Tab");
  const stop = page.getByRole("button", { name: "Emergency Stop" });
  await expect(stop).toBeFocused();
  expect(await stop.evaluate((node) => getComputedStyle(node).outlineStyle)).toBe("solid");
  await page.keyboard.press("Tab");
  await expect(page.getByRole("link", { name: "Register Object" })).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(active.getByRole("link", { name: "Return to Search" })).toBeFocused();
  await page.screenshot({ path: testInfo.outputPath("dashboard-1366x768.png") });
  await page.addStyleTag({ content: "html { font-size: 200%; }" });
  await expect(active.getByRole("link", { name: "Return to Search" })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(1366);
  await page.screenshot({ path: testInfo.outputPath("dashboard-200-percent.png") });
  expect(external).toEqual([]);
});
