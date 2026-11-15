import { expect, test, type Page } from "@playwright/test";

test.use({ baseURL: "http://127.0.0.1:3100" });

const navigation = (page: Page) => page.getByRole("navigation", { name: "Main navigation" });
const status = (page: Page, hasText: string) => page.getByRole("status").filter({ hasText });
async function review(page: Page, days: string) {
  await page.getByLabel("Proposed retention in days").fill(days);
  await page.getByRole("button", { name: "Preview Change" }).click();
  await page.getByRole("button", { name: "Review Change", exact: true }).click();
  return page.getByRole("dialog", { name: "Apply retention change?" });
}
async function controls(page: Page) {
  await page.getByText("Retention fixture controls", { exact: true }).click();
}

test("previews retention without saving and requires explicit confirmation", async ({ page }) => {
  await page.goto("/settings");
  const saved = page.getByRole("region", { name: "Saved retention" });
  await expect(saved).toContainText("7 days");
  const input = page.getByLabel("Proposed retention in days");
  const preview = page.getByRole("button", { name: "Preview Change" });
  for (const invalid of ["0", "31", "1.5", "1e1", ""]) {
    await input.fill(invalid);
    await expect(input).toHaveAttribute("aria-invalid", "true");
    await expect(preview).toBeDisabled();
  }
  await input.fill("30");
  await preview.click();
  const impact = page.getByRole("region", { name: "Immediate impact" });
  await expect(impact).toContainText("30 days");
  await expect(impact).toContainText("0 objects");
  await expect(impact).toContainText("0 sessions");
  await expect(impact).toContainText("0 matches");
  await expect(impact).toContainText("0 bytes");
  await page.getByRole("button", { name: "Cancel Change" }).click();
  await expect(saved).toContainText("7 days");
  await expect(input).toHaveValue("7");
  await input.fill("1");
  await preview.click();
  await expect(impact).toContainText("26 objects");
  await expect(impact).toContainText("1 session");
  await expect(impact).toContainText("1 match");
  await page.getByRole("button", { name: "Review Change", exact: true }).click();
  const confirmation = page.getByRole("dialog", { name: "Apply retention change?" });
  await expect(confirmation).toBeVisible();
  await expect(saved).toContainText("7 days");
  await confirmation.getByRole("button", { name: "Confirm and Apply" }).click();
  await expect(saved).toContainText("1 day");
  await expect(page.getByRole("status").filter({ hasText: "Retention saved" })).toBeVisible();
});

test("rejects edits and elapsed previews and keeps Settings in sync with cleanup and protected history", async ({ page }) => {
  await page.goto("/sessions/sample-confirmed-search");
  await expect(page.getByRole("img", { name: "Captured evidence" })).toHaveAttribute("src", /^blob:/);
  await navigation(page).getByRole("link", { name: "Settings" }).click();
  const dialog = await review(page, "1");
  await page.getByLabel("Proposed retention in days").fill("2");
  await expect(dialog).toHaveCount(0);
  await expect(status(page, "Preview outdated")).toBeVisible();
  await review(page, "1");
  await controls(page);
  await page.getByRole("button", { name: "Advance fixture clock 1 minute" }).click();
  await expect(dialog).toHaveCount(0);
  await expect(status(page, "Preview outdated")).toBeVisible();
  await expect(page.getByRole("region", { name: "Saved retention" })).toContainText("7 days");
  await (await review(page, "1")).getByRole("button", { name: "Confirm and Apply" }).click();
  const cleanup = page.getByRole("region", { name: "Deletion progress" });
  await expect(cleanup).toContainText("Deletion pending");
  await expect(cleanup).toContainText("26 objects and 27 files remaining");

  await page.goBack();
  await expect(page.getByText("Session expired", { exact: true })).toBeVisible();
  await expect(page.getByRole("img", { name: "Captured evidence" })).toHaveCount(0);
  await navigation(page).getByRole("link", { name: "Objects / History" }).click();
  await page.getByLabel("Search objects").fill("Headphones");
  await expect(page.getByText("No matching objects", { exact: true })).toBeVisible();
  await navigation(page).getByRole("link", { name: "Settings" }).click();
  await expect(page.getByRole("region", { name: "Saved retention" })).toContainText("1 day");
  const disclosure = page.locator("details").filter({ has: page.getByText("Retention fixture controls", { exact: true }) });
  if (await disclosure.getAttribute("open") === null) await controls(page);
  await page.getByRole("button", { name: "Complete sample deletion" }).click();
  await expect(cleanup).toContainText("Deletion complete");
});

test("recovers an identical pending request after a lost response, then reports a separate deletion failure", async ({ page }) => {
  await page.goto("/settings");
  await controls(page);
  const saved = page.getByRole("region", { name: "Saved retention" });
  const cleanup = page.getByRole("region", { name: "Deletion progress" });
  await page.getByRole("button", { name: "Hold next retention save" }).click();
  await (await review(page, "1")).getByRole("button", { name: "Confirm and Apply" }).click();
  await expect(status(page, "Retention save pending")).toBeVisible();
  await expect(saved).toContainText("7 days");
  await expect(page.getByRole("button", { name: "Preview Change" })).toBeDisabled();
  await page.getByRole("button", { name: "Lose retention save response" }).click();
  await page.getByRole("button", { name: "Advance fixture clock 1 minute" }).click();
  const retry = page.getByRole("button", { name: "Retry Same Request" });
  await retry.click();
  await expect(status(page, "Save outcome unknown")).toBeVisible();
  await expect(saved).toContainText("7 days");
  await retry.click();
  await expect(status(page, "Retention saved")).toBeVisible();
  await expect(saved).toContainText("1 day");
  await page.getByRole("button", { name: "Fail sample deletion" }).click();
  await expect(cleanup).toContainText("Deletion failed");
  await expect(cleanup).toContainText("27 files remaining");
  await expect(saved).toContainText("1 day");
  await expect(page.getByRole("button", { name: "Preview Change" })).toBeDisabled();
  await expect(page.getByRole("button", { name: "Review Change", exact: true })).toBeDisabled();

  await navigation(page).getByRole("link", { name: "Dashboard" }).click();
  await page.getByText("Fixture mutation requests (4)", { exact: true }).click();
  const requests = await page.getByRole("list", { name: "Fixture mutation requests" }).locator("li code").allTextContents();
  expect(JSON.parse(requests[0])).toEqual({ expected_revision: 1, retention_days: 1 });
  expect(JSON.parse(requests[1])).toEqual({ action_id: expect.stringMatching(/^[\da-f]{8}-[\da-f]{4}-4[\da-f]{3}-[89ab][\da-f]{3}-[\da-f]{12}$/i),
    expected_revision: 1, retention_days: 1, preview_id: expect.any(String), confirmed: true });
  expect(requests.slice(1)).toEqual(Array(3).fill(requests[1]));
});

test("keeps the saved period after definitive failure and disables retention in Searching and Paused", async ({ page }) => {
  await page.goto("/settings");
  await controls(page);
  await page.getByRole("button", { name: "Hold next retention save" }).click();
  await (await review(page, "30")).getByRole("button", { name: "Confirm and Apply" }).click();
  await page.getByRole("button", { name: "Fail retention save" }).click();
  await page.getByRole("button", { name: "Retry Same Request" }).click();
  await expect(status(page, "Retention save failed")).toBeVisible();
  await expect(page.getByRole("region", { name: "Saved retention" })).toContainText("7 days");
  await expect(page.getByRole("button", { name: "Retry Same Request" })).toHaveCount(0);

  const dialog = await review(page, "30");
  await page.getByRole("button", { name: "Activate Searching fixture" }).click();
  await expect(status(page, "Search is Searching")).toBeVisible();
  await expect(dialog).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Preview Change" })).toBeDisabled();
  await expect(page.getByRole("button", { name: "Review Change", exact: true })).toBeDisabled();
  await page.getByRole("button", { name: "End sample session" }).click();
  await page.getByRole("button", { name: "Activate Paused fixture" }).click();
  await expect(status(page, "Search is Paused")).toBeVisible();
  await expect(page.getByRole("button", { name: "Preview Change" })).toBeDisabled();
  const returnLink = page.getByRole("link", { name: "Return to Active Search" });
  await returnLink.focus();
  await page.keyboard.press("Tab");
  await expect(page.getByRole("button", { name: "Emergency Stop" })).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(status(page, "Motion permission revoked")).toBeVisible();
});

test("keeps an enlarged capture through grace and revokes its URL when the session ends", async ({ page }) => {
  await page.addInitScript(() => {
    const original = URL.revokeObjectURL;
    const revoked = new Set<string>();
    Object.assign(window, { testRevoked: revoked });
    URL.revokeObjectURL = (url) => {
      revoked.add(url);
      original(url);
    };
  });
  await page.goto("/sessions/sample-search");
  await controls(page);
  await page.getByRole("button", { name: "Activate Paused fixture" }).click();
  const frame = page.getByRole("img", { name: "Captured evidence" });
  await expect(frame).toHaveAttribute("src", /^blob:/);
  const url = (await frame.getAttribute("src"))!;
  await page.getByRole("button", { name: "Inspect evidence" }).click();
  const enlarged = page.getByRole("region", { name: "Enlarged captured evidence" });
  await expect(enlarged).toBeVisible();
  await page.getByRole("button", { name: "Advance fixture clock 7 days" }).click();
  await expect(page.getByText("Active-session grace", { exact: true })).toBeVisible();
  await expect(enlarged).toBeVisible();
  await expect(frame).toHaveAttribute("src", url);
  await page.getByRole("button", { name: "End sample session" }).click();
  await expect(page.getByText("Session expired", { exact: true })).toBeVisible();
  await expect(enlarged).toHaveCount(0);
  await expect(frame).toHaveCount(0);
  await expect.poll(() => page.evaluate((source) => (window as Window & { testRevoked?: Set<string> }).testRevoked?.has(source), url)).toBe(true);
});

test("supports the Settings layout and keyboard confirmation at both design sizes offline", async ({ page }, testInfo) => {
  const external: string[] = [];
  await page.route("**/*", (route) => {
    if (new URL(route.request().url()).origin === "http://127.0.0.1:3102") return route.continue();
    external.push(route.request().url());
    return route.abort();
  });
  await page.setViewportSize({ width: 1440, height: 960 });
  await page.goto("http://127.0.0.1:3102/settings");
  await page.getByLabel("Proposed retention in days").fill("3");
  await page.keyboard.press("Enter");
  await expect(page.getByRole("region", { name: "Immediate impact" })).toContainText("3 days");
  await page.evaluate(() => document.fonts.ready);
  await page.screenshot({ path: testInfo.outputPath("settings-1440x960.png") });
  await page.setViewportSize({ width: 1366, height: 768 });
  await page.getByRole("button", { name: "Review Change", exact: true }).focus();
  await page.keyboard.press("Enter");
  const dialog = page.getByRole("dialog", { name: "Apply retention change?" });
  await expect(dialog.getByRole("button", { name: "Cancel Change" })).toBeFocused();
  await page.keyboard.press("Tab");
  const confirm = dialog.getByRole("button", { name: "Confirm and Apply" });
  await expect(confirm).toBeFocused();
  expect(await confirm.evaluate((node) => getComputedStyle(node).outlineStyle)).toBe("solid");
  await page.screenshot({ path: testInfo.outputPath("settings-1366x768.png") });
  await page.addStyleTag({ content: "html { font-size: 200%; }" });
  await expect(confirm).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(1366);
  await page.screenshot({ path: testInfo.outputPath("settings-200-percent.png"), fullPage: true });
  await page.keyboard.press("Enter");
  await expect(status(page, "Retention saved")).toBeVisible();
  expect(external).toEqual([]);
});
