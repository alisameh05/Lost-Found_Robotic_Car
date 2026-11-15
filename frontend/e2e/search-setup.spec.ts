import { expect, test, type Page } from "@playwright/test";
import { sampleImage } from "../src/lib/fixtures/images";

test.use({ baseURL: "http://127.0.0.1:3100" });

const preview = (page: Page) => page.getByRole("region", { name: "Robot preview" });
const ready = (page: Page) => page.getByRole("status").filter({ hasText: "Ready to start" });
const acquire = (page: Page) => page.getByRole("button", { name: "Acquire control" });
const setupControls = (page: Page) => page.getByText("Search setup fixture controls", { exact: true });

async function scenario(page: Page, value: string, object = "sample-wallet") {
  await page.goto(`/objects/${object}/search`);
  await page.getByRole("link", { name: "Dashboard", exact: true }).click();
  await page.getByLabel("Fixture scenario").selectOption(value);
  await expect(page.getByLabel("Fixture scenario")).toHaveValue(value);
  await page.goBack();
}

test("previews an existing Lost target and requires deliberate control after support navigation", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 960 });
  await page.route("**/*", (route) => route.request().url().startsWith("http://127.0.0.1:3100/") ? route.continue() : route.abort());
  await page.goto("/objects/sample-wallet");
  await page.getByRole("link", { name: "Start Search" }).click();
  await expect(page.getByRole("heading", { name: "Black wallet" })).toBeVisible();
  await expect(preview(page)).toContainText("Live preview");
  await expect(preview(page)).toContainText("Read-only preview");
  await expect(ready(page)).toHaveCount(0);
  const gestures = page.getByRole("radio", { name: "Gestures" });
  await gestures.focus();
  await page.keyboard.press("ArrowDown");
  await expect(page.getByRole("radio", { name: "PS4 controller" })).toBeChecked();
  await expect(acquire(page)).toBeEnabled();
  await acquire(page).focus();
  await page.keyboard.press("Enter");
  await expect(ready(page)).toBeVisible();
  await page.getByRole("link", { name: "View Devices" }).click();
  await page.getByRole("link", { name: "Open Control Guide" }).click();
  await page.getByRole("link", { name: "Return to Search Setup" }).click();
  await expect(page.getByRole("radio", { name: "PS4 controller" })).toBeChecked();
  await expect(acquire(page)).toBeEnabled();
  await expect(ready(page)).toHaveCount(0);
  await page.getByRole("link", { name: "Back to Object Details" }).click();
  await expect(page).toHaveURL(/\/objects\/sample-wallet$/);
});

test("registers a Lost target and requires the selected input while proximity stays advisory", async ({ page }, info) => {
  await page.goto("/objects/new");
  await page.getByRole("textbox", { name: "Object name" }).fill("Registered search target");
  await page.locator('input[type="file"]').setInputFiles({
    buffer: Buffer.from(sampleImage("image/png")), name: "reference.png", mimeType: "image/png",
  });
  await expect(page.getByRole("img", { name: "Normalized reference preview" })).toBeVisible();
  await page.getByRole("button", { name: "Next", exact: true }).click();
  for (const [coordinate, value] of [["X", "2"], ["Y", "3"], ["Width", "24"], ["Height", "16"]]) {
    await page.getByRole("textbox", { name: `${coordinate} · px` }).fill(value);
  }
  await page.getByRole("button", { name: "Register Object", exact: true }).click();
  await page.getByRole("link", { name: "Start Search" }).click();
  const target = page.getByRole("region", { name: "Saved search target" });
  await expect(target).toContainText("Registered search target");
  await expect(target).toContainText("Lost");
  await expect(target.getByRole("img")).toHaveCount(2);
  await expect(target).toContainText("24 × 16 px");
  await expect(page.getByRole("region", { name: "Connection readiness" }).getByRole("listitem")).toHaveCount(11);
  await expect(page.getByRole("listitem").filter({ hasText: "Proximity sensor" })).toContainText("Advisory");
  await acquire(page).click();
  await expect(ready(page)).toBeVisible();
  await page.setViewportSize({ width: 1440, height: 960 });
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.screenshot({ path: info.outputPath("search-setup-ready.png"), fullPage: true });
  await page.setViewportSize({ width: 1366, height: 768 });
  await page.addStyleTag({ content: "html { font-size: 200%; }" });
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(1366);
  await expect(page.getByRole("button", { name: "Emergency Stop" })).toBeVisible();

  await scenario(page, "setup-ps4");
  await acquire(page).click();
  await expect(page.getByRole("status").filter({ hasText: "Start blocked" })).toContainText("Laptop webcam");
  await page.getByRole("radio", { name: "PS4 controller" }).check();
  await expect(page.getByRole("listitem").filter({ hasText: "Laptop webcam" })).toContainText("Inactive");
  await expect(ready(page)).toBeVisible();
  await page.setViewportSize({ width: 1440, height: 960 });
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.screenshot({ path: info.outputPath("search-setup-ps4.png"), fullPage: true });
});

test("withholds readiness on zero or failed frames and revokes on a freeze or loss of events", async ({ page }, info) => {
  for (const value of ["setup-empty", "setup-corrupt"]) {
    await scenario(page, value);
    await expect(preview(page)).toContainText("Not live");
    await expect(acquire(page)).toBeDisabled();
    await expect(ready(page)).toHaveCount(0);
  }
  await scenario(page, "setup-blocked");
  await acquire(page).click();
  await expect(page.getByRole("status").filter({ hasText: "Start blocked" })).toContainText("Local matching service");
  await page.setViewportSize({ width: 1440, height: 960 });
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.screenshot({ path: info.outputPath("search-setup-blocked.png"), fullPage: true });

  await scenario(page, "idle");
  await acquire(page).click();
  await expect(ready(page)).toBeVisible();
  await setupControls(page).click();
  await page.getByRole("button", { name: "Freeze robot frames" }).click();
  await expect(preview(page)).toContainText("Not live");
  await expect(ready(page)).toHaveCount(0);
  await page.getByRole("button", { name: "Send fresh frames" }).click();
  await expect(preview(page)).toContainText("Live preview");
  await expect(acquire(page)).toBeEnabled();
  await expect(ready(page)).toHaveCount(0);
  await acquire(page).click();
  await expect(ready(page)).toBeVisible();
  await page.getByRole("button", { name: "Disconnect search events" }).click();
  await expect(ready(page)).toHaveCount(0);
  await expect(acquire(page)).toBeEnabled();
  await expect(preview(page)).toContainText("Read-only preview");
  await acquire(page).click();
  await expect(ready(page)).toBeVisible();
  await page.evaluate(() => window.dispatchEvent(new Event("blur")));
  await expect(ready(page)).toHaveCount(0);
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await expect(acquire(page)).toBeEnabled();
  await expect(preview(page)).toContainText("Read-only preview");
});

test("keeps protection and diagnostic feedback available when a record or profile is ineligible", async ({ page }) => {
  for (const [object, message] of [["missing", "Object not found"], ["sample-expired", "Record expired"],
    ["sample-headphones", "This object has already been found."], ["sample-office-keys", "The reference image is unavailable."]]) {
    await page.goto(`/objects/${object}/search`);
    await expect(page.getByText(message, { exact: true }).first()).toBeVisible();
    await expect(ready(page)).toHaveCount(0);
  }
  for (const value of ["searching", "paused"]) {
    await scenario(page, value);
    await expect(page.getByRole("link", { name: "Return to Active Search" })).toBeVisible();
    await expect(acquire(page)).toBeDisabled();
  }
  await scenario(page, "expiry-grace", "sample-expired");
  await expect(page.getByRole("link", { name: "Return to Active Search" })).toHaveAttribute("href", "/sessions/sample-grace-search/live");
  await expect(acquire(page)).toHaveAccessibleDescription(/expired record/);
  await scenario(page, "initializing");
  await expect(page.getByText("Initializing services", { exact: true })).toBeVisible();
  await expect(acquire(page)).toBeDisabled();
  await scenario(page, "no-profile");
  await expect(acquire(page)).toHaveAccessibleDescription(/qualification profile/);
  await page.getByRole("button", { name: "Emergency Stop" }).click();
  await expect(page.getByText("Motion permission revoked", { exact: true })).toBeVisible();
  await scenario(page, "setup-spectator");
  await expect(preview(page)).toContainText("Live preview");
  await expect(acquire(page)).toHaveAccessibleDescription("Another workspace holds control.");
  await expect(page.getByText("Spectator", { exact: true })).toBeVisible();
  await expect(ready(page)).toHaveCount(0);
});
