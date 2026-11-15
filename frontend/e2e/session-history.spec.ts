import { expect, test, type Page } from "@playwright/test";

test.use({ baseURL: "http://127.0.0.1:3100" });

async function openWallet(page: Page, scenario: string) {
  await page.goto("/");
  await page.getByLabel("Fixture scenario").selectOption(scenario);
  await page.getByRole("link", { name: "Objects / History", exact: true }).click();
  await page.getByRole("link", { name: "View details for Black wallet" }).click();
}

async function trackRevocations(page: Page) {
  await page.addInitScript(() => {
    const revoke = URL.revokeObjectURL;
    const revoked = new Set<string>();
    Object.defineProperty(window, "revokedEvidenceUrls", { value: revoked });
    URL.revokeObjectURL = (url) => { revoked.add(String(url)); revoke(url); };
  });
  return (url: string) => page.evaluate((value) =>
    (window as Window & { revokedEvidenceUrls: Set<string> }).revokedEvidenceUrls.has(value), url);
}

test("opens a stopped search from the owning object and shows saved review facts", async ({ page }) => {
  await page.goto("/objects/sample-wallet");
  const history = page.getByRole("region", { name: "Search sessions" });
  await expect(history.getByText("Stopped", { exact: true })).toBeVisible();
  await history.getByRole("link", { name: /View session/ }).first().click();
  await expect(page).toHaveURL(/\/sessions\/sample-search$/);
  await expect(page.getByRole("heading", { name: "Session Details" })).toBeVisible();
  await expect(page.getByRole("link", { name: "View Object" })).toHaveAttribute("href", "/objects/sample-wallet");
  const matches = page.getByRole("region", { name: "Captured matches" });
  const unreviewed = matches.getByRole("article").filter({ hasText: "Not reviewed" });
  await expect(unreviewed.getByText("Media missing", { exact: true })).toBeVisible();
  await expect(unreviewed.locator("time")).toHaveCount(1);
  const rejected = matches.getByRole("article").filter({ hasText: "Rejected" });
  await expect(rejected.locator("time")).toHaveCount(2);
  await expect(rejected.getByRole("img", { name: "Captured evidence" })).toBeVisible();
  await expect(page.getByText("Movement input released")).toHaveCount(0);
});

test("restarts rejected cursors and separates unavailable reads from empty history", async ({ page }) => {
  await openWallet(page, "history-recovery");
  const history = page.getByRole("region", { name: "Search sessions" });
  await expect(history.getByRole("alert")).toContainText("Search sessions unavailable");
  await history.getByRole("button", { name: "Retry" }).click();
  const sessions = history.getByRole("navigation", { name: "Session pages" });
  await expect(sessions.getByRole("status")).toContainText("Page 1");
  const nextSession = sessions.getByRole("button", { name: "Next" });
  await nextSession.click();
  await expect(sessions.getByRole("status")).toContainText("Page 1");
  await nextSession.click();
  await expect(sessions.getByRole("status")).toContainText("Page 2");
  await expect(nextSession).toBeDisabled();
  await expect(history.getByRole("listitem")).toHaveCount(2);
  await sessions.getByRole("button", { name: "Previous" }).click();
  await expect(sessions.getByRole("status")).toContainText("Page 1");
  await history.getByRole("listitem").filter({ hasText: "Interrupted" }).getByRole("link").click();
  await expect(page.getByText("Search interrupted", { exact: true })).toBeVisible();
  await expect(page.getByText("No captured matches", { exact: true })).toBeVisible();
  await page.getByRole("link", { name: "View Object" }).click();
  await history.getByRole("link", { name: /View session/ }).first().click();
  const captures = page.getByRole("region", { name: "Captured matches" });
  await expect(captures.getByRole("alert")).toContainText("Captured matches unavailable");
  await expect(captures.getByText("No captured matches")).toHaveCount(0);
  await captures.getByRole("button", { name: "Retry" }).click();
  const pages = captures.getByRole("navigation", { name: "Match pages" });
  const nextMatch = pages.getByRole("button", { name: "Next" });
  await expect(captures.getByText("Media unavailable", { exact: true })).toBeVisible();
  await expect(captures.getByText("Media corrupt", { exact: true })).toBeVisible();
  await expect(captures.getByText("Image could not be decoded", { exact: true })).toBeVisible();
  await nextMatch.click();
  await expect(pages.getByRole("status")).toContainText("Page 1");
  await nextMatch.click();
  await expect(pages.getByRole("status")).toContainText("Page 2");
  await expect(captures.getByRole("article")).toHaveCount(2);
  await expect(captures.getByRole("article").first().locator("time").first())
    .toHaveAttribute("datetime", "2026-11-13T11:58:05.000Z");
  await expect(nextMatch).toBeDisabled();
  await page.getByRole("link", { name: "Dashboard", exact: true }).click();
  await expect(page.getByText("Fixture mutation requests (0)")).toBeVisible();
  await page.goto("/objects/sample-office-keys");
  await expect(page.getByText("No search sessions", { exact: true })).toBeVisible();
});

test("loads the exact Found frame and keeps its saved box aligned during inspection", async ({ page }, testInfo) => {
  const revoked = await trackRevocations(page);
  const external: string[] = [];
  await page.route("http{,s}://**/*", async (route) => {
    if (new URL(route.request().url()).origin === "http://127.0.0.1:3100") return route.continue();
    external.push(route.request().url());
    await route.abort();
  });
  await page.setViewportSize({ width: 1440, height: 960 });
  await openWallet(page, "found-evidence");
  const evidence = page.getByRole("region", { name: "Confirmed evidence", exact: true });
  const history = page.getByRole("region", { name: "Search sessions" });
  const image = evidence.getByRole("img", { name: "Captured evidence", exact: true });
  await expect(image).toHaveAttribute("src", /^blob:/);
  await expect.poll(() => image.evaluate((node: HTMLImageElement) => [node.naturalWidth, node.naturalHeight])).toEqual([480, 262]);
  await page.screenshot({ path: testInfo.outputPath("object-details-1440.png") });
  await history.getByRole("button", { name: "Next" }).click();
  await expect(history.getByRole("status")).toContainText("Page 2");
  await expect(history.getByText("Found", { exact: true })).toHaveCount(0);
  await expect(evidence.getByText("Confirmed", { exact: true })).toBeVisible();
  const objectUrl = (await image.getAttribute("src"))!;
  await history.getByRole("button", { name: "Previous" }).click();
  await history.getByRole("link", { name: /View session/ }).first().click();
  await expect(page).toHaveURL(/\/sessions\/sample-wallet-confirmed-search$/);
  await expect.poll(() => revoked(objectUrl)).toBe(true);
  const captures = page.getByRole("region", { name: "Captured matches" });
  const frame = captures.getByRole("img", { name: "Captured evidence", exact: true });
  const digest = await frame.evaluate(async (node: HTMLImageElement) => {
    const bytes = await (await fetch(node.src)).arrayBuffer();
    const hash = await crypto.subtle.digest("SHA-256", bytes);
    return new Uint8Array(hash).toHex();
  });
  expect(digest).toBe("905e9dec4db0ff9d1546d0ee3ea9e93575f314114ca0f486fc854c782b776a03");
  async function checkBox() {
    return frame.evaluate((node) => {
      const image = node.getBoundingClientRect();
      const box = node.nextElementSibling!.getBoundingClientRect();
      expectBox((box.x - image.x) / image.width, 303 / 480);
      expectBox((box.y - image.y) / image.height, 204 / 262);
      expectBox(box.width / image.width, 84 / 480);
      expectBox(box.height / image.height, 38 / 262);
      return image.width;
      function expectBox(actual: number, expected: number) {
        if (Math.abs(actual - expected) > 0.002) throw new Error(`Box ratio ${actual}, expected ${expected}`);
      }
    });
  }
  await frame.scrollIntoViewIfNeeded();
  const inlineWidth = await checkBox();
  await page.screenshot({ path: testInfo.outputPath("session-details-1440.png") });
  const inspect = captures.getByRole("button", { name: "Inspect evidence" });
  await inspect.focus();
  await page.keyboard.press("Enter");
  const enlarged = captures.getByRole("region", { name: "Enlarged captured evidence" });
  await expect(enlarged).toBeFocused();
  expect(await checkBox()).toBeGreaterThan(inlineWidth * 1.8);
  await expect.poll(() => enlarged.evaluate((node) => node.scrollLeft)).toBeGreaterThan(0);
  await page.setViewportSize({ width: 1366, height: 768 });
  await checkBox();
  await page.screenshot({ path: testInfo.outputPath("session-inspection-1366.png") });
  await page.keyboard.press("Tab");
  await expect(captures.getByRole("button", { name: "Close inspection" })).toBeFocused();
  await page.keyboard.press("Space");
  await expect(enlarged).toHaveCount(0);
  await page.addStyleTag({ content: "html { font-size: 200%; }" });
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth)).toBe(1366);
  await checkBox();
  await page.screenshot({ path: testInfo.outputPath("session-details-200-text.png"), fullPage: true });
  await page.getByRole("link", { name: "View Object" }).click();
  await expect(evidence.getByRole("img", { name: "Captured evidence" })).toBeVisible();
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth)).toBe(1366);
  await page.screenshot({ path: testInfo.outputPath("object-details-200-text.png"), fullPage: true });
  expect(external).toEqual([]);
});

test("shows confirmed facts without media and distinguishes expired and missing session links", async ({ page }) => {
  await page.goto("/");
  await page.getByLabel("Fixture scenario").selectOption("missing-confirmation-media");
  await page.getByRole("link", { name: "Objects / History", exact: true }).click();
  await page.getByRole("link", { name: "View details for Headphones" }).click();
  const evidence = page.getByRole("region", { name: "Confirmed evidence" });
  await expect(evidence.getByText("Media missing", { exact: true })).toBeVisible();
  await expect(evidence.getByText("Confirmed", { exact: true })).toBeVisible();
  await expect(evidence.locator("time").last()).toHaveAttribute("datetime", "2026-11-13T11:57:00.000Z");
  await expect(evidence.getByRole("img")).toHaveCount(0);
  await page.goto("/sessions/sample-expired-search");
  await expect(page.getByText("Session expired", { exact: true })).toBeVisible();
  await page.goto("/sessions/sample-purged-search");
  await expect(page.getByRole("heading", { name: "Session not found" })).toBeVisible();
});

test("revokes an open inspection when the owner expires", async ({ page }) => {
  const revoked = await trackRevocations(page);
  await page.clock.install();
  await page.goto("/sessions/sample-search");
  const frame = page.getByRole("img", { name: "Captured evidence" });
  await expect(frame).toHaveAttribute("src", /^blob:/);
  const url = (await frame.getAttribute("src"))!;
  await page.getByRole("button", { name: "Inspect evidence" }).click();
  await expect(page.getByRole("region", { name: "Enlarged captured evidence" })).toBeVisible();
  await page.clock.fastForward(8 * 86_400_000);
  await expect(page.getByText("Session expired", { exact: true })).toBeVisible();
  await expect(frame).toHaveCount(0);
  await expect.poll(() => revoked(url)).toBe(true);
});

test("keeps grace evidence and keyboard Emergency Stop available during active inspection", async ({ page }) => {
  await page.goto("/");
  await page.getByLabel("Fixture scenario").selectOption("expiry-grace");
  const workspace = page.getByRole("complementary").getByRole("link", { name: "Return to Active Search" });
  await workspace.click();
  await page.getByRole("link", { name: "Back to Session Details" }).click();
  await expect(page.getByText("Active-session grace", { exact: true })).toBeVisible();
  const view = page.getByRole("main");
  const activeLink = view.getByRole("link", { name: "Return to Active Search" });
  await expect(activeLink).toHaveAttribute("href", "/sessions/sample-grace-search/live");
  await view.getByRole("button", { name: "Inspect evidence" }).click();
  await expect(page.getByRole("region", { name: "Enlarged captured evidence" })).toBeFocused();
  await workspace.focus();
  await page.keyboard.press("Tab");
  await expect(page.getByRole("button", { name: "Emergency Stop" })).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(page.getByText(/Motion permission revoked/)).toBeVisible();
  await expect(page.getByRole("img", { name: "Captured evidence" })).toBeVisible();
  await activeLink.click();
  await expect(page).toHaveURL(/\/sessions\/sample-grace-search\/live$/);
  await page.getByRole("link", { name: "Dashboard", exact: true }).click();
  await expect(page.getByText("Fixture mutation requests (1)")).toBeVisible();
  await page.getByLabel("Fixture scenario").selectOption("candidate");
  await workspace.click();
  await page.getByRole("link", { name: "Back to Session Details" }).click();
  const pending = page.getByRole("article").filter({ hasText: "Pending" });
  await expect(pending.locator("time")).toHaveCount(1);
  await expect(pending.getByRole("img", { name: "Captured evidence" })).toBeVisible();
});
