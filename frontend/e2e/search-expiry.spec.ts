import { expect, test, type Page } from "@playwright/test";

test.use({ baseURL: "http://127.0.0.1:3100" });

const action = (page: Page, name: string) => page.getByRole("button", { name, exact: true });
const review = (page: Page) => page.getByRole("region", { name: "Review potential match" });
const nav = (page: Page, name: string) => page.getByRole("complementary").getByRole("link", { name, exact: true });
const retentionControls = (page: Page) => page.getByText("Retention fixture controls", { exact: true });

async function openRetention(page: Page) {
  const summary = retentionControls(page);
  if (!(await summary.evaluate((element) => element.parentElement?.hasAttribute("open")))) await summary.click();
}

async function openBoundarySetup(page: Page) {
  await page.goto("/");
  await page.getByLabel("Fixture scenario").selectOption("retention-boundary");
  await nav(page, "Objects / History").click();
  await page.getByRole("link", { name: "View details for Black wallet" }).click();
  await page.getByRole("link", { name: "Start Search", exact: true }).click();
}

async function start(page: Page) {
  await action(page, "Acquire control").click();
  await action(page, "Start Search").click();
  await expect(page).toHaveURL(/\/sessions\/[^/]+\/live$/);
  await expect(page.getByRole("region", { name: "Robot camera" })).toContainText("Live sample");
  await page.getByText("Workspace fixture controls", { exact: true }).click();
}

async function prepareRegistration(page: Page, name: string) {
  await nav(page, "Objects / History").click();
  await page.getByRole("link", { name: "Register Object", exact: true }).click();
  await page.getByLabel("Object name").fill(name);
  const image = await page.evaluate(() => {
    const canvas = document.createElement("canvas");
    canvas.width = 80;
    canvas.height = 40;
    const context = canvas.getContext("2d")!;
    context.fillStyle = "#d2b48c";
    context.fillRect(0, 0, 80, 40);
    context.fillStyle = "#193449";
    context.fillRect(10, 8, 50, 24);
    return canvas.toDataURL("image/png").split(",")[1];
  });
  await page.locator('input[type="file"]').setInputFiles({ name: "fixture-reference.png", mimeType: "image/png",
    buffer: Buffer.from(image, "base64") });
  await expect(page.getByRole("img", { name: "Normalized reference preview" })).toBeVisible();
  await action(page, "Next").click();
  await expect(page.getByRole("heading", { name: "Select Target" })).toBeVisible();
  for (const [label, value] of Object.entries({ X: "10", Y: "8", Width: "50", Height: "24" })) {
    await page.getByRole("textbox", { name: `${label} · px`, exact: true }).fill(value);
  }
}

test.beforeEach(async ({ page }) => {
  await page.route("**/*", (route) => route.request().url().startsWith("http://127.0.0.1:3100/") ? route.continue() : route.abort());
});

for (const terminal of ["Confirm Match", "Stop Search"]) {
  test(`${terminal} finishes an expired search and clears open evidence`, async ({ page }, info) => {
    await openBoundarySetup(page);
    await start(page);
    const result = page.url().replace(/live$/, "result");
    await action(page, "Show sample candidate").click();
    await review(page).getByRole("button", { name: "Inspect evidence" }).press("Enter");
    const enlarged = review(page).getByRole("region", { name: "Enlarged captured evidence" });
    await expect(enlarged).toBeVisible();
    const evidenceUrl = await enlarged.getByRole("img").getAttribute("src");
    expect(evidenceUrl).toMatch(/^blob:/);

    if (terminal === "Confirm Match") {
      await action(page, "Hold next search save").click();
      await action(page, "Confirm Match").click();
      await expect(review(page).getByText("Save pending", { exact: true })).toBeVisible();
    }
    await openRetention(page);
    await action(page, "Advance fixture clock 1 minute").click();
    await expect(page.getByRole("status").filter({ hasText: "Active-session grace" }).first()).toBeVisible();
    await expect(enlarged).toBeVisible();
    await action(page, terminal === "Confirm Match" ? "Commit pending search save" : terminal).click();
    await expect(page).toHaveURL(result);
    await expect(page.getByText("Record removed after expiry", { exact: true })).toBeVisible();
    await expect(page.getByText("Black wallet", { exact: true })).toHaveCount(0);
    await expect(page.getByRole("img")).toHaveCount(0);
    await expect(page.getByRole("link", { name: /Return to Active Search|View Object Details|View Session Details|Search Again/ })).toHaveCount(0);
    expect(await page.evaluate((url) => fetch(url!).then(() => false, () => true), evidenceUrl)).toBe(true);
    await retentionControls(page).click();
    await page.screenshot({ path: info.outputPath("record-removed.png") });
    await page.getByRole("link", { name: "Return to Dashboard" }).click();
    await expect(page.getByRole("heading", { name: "Dashboard", exact: true })).toBeVisible();
    if (terminal === "Stop Search") {
      await page.goBack();
      await expect(page.getByText("Session expired", { exact: true })).toBeVisible();
      await openRetention(page);
      await action(page, "Complete sample deletion").click();
      await expect(page.getByRole("heading", { name: "Session not found", exact: true })).toBeVisible();
    }
  });
}

test("grace survives wake and reconnect, and late evidence stays hidden through failed cleanup", async ({ page }, info) => {
  test.setTimeout(60_000);
  await openBoundarySetup(page);
  await start(page);
  const live = page.url();
  const session = live.replace(/\/live$/, "");
  await nav(page, "Settings").click();
  await action(page, "Leave Paused").click();
  await expect(page.getByText("Search is Paused", { exact: true })).toBeVisible();
  await expect(action(page, "Preview Change")).toBeDisabled();

  await prepareRegistration(page, "Surviving camera case");
  await action(page, "Register Object").click();
  await expect(page.getByRole("heading", { name: "Object Details" })).toBeVisible();
  const survivor = page.url();
  await nav(page, "Return to Active Search").click();
  await expect(page).toHaveURL(live);
  await action(page, "Acquire control").click();
  await action(page, "Resume").click();
  await openRetention(page);
  await action(page, "Advance fixture clock 1 minute").click();
  const grace = page.getByRole("status").filter({ hasText: "Active-session grace" });
  await expect(grace.first()).toBeVisible();
  await page.evaluate(() => window.dispatchEvent(new Event("online")));
  await page.getByText("Workspace fixture controls", { exact: true }).click();
  await action(page, "Disconnect search events").click();
  await expect(page.getByRole("region", { name: "Control ownership" })).toContainText("Spectator");
  await expect(grace.first()).toBeVisible();
  await expect(action(page, "Resume")).toBeDisabled();
  await action(page, "Acquire control").click();
  await action(page, "Recovery").click();
  await page.getByRole("region", { name: "Recovery", exact: true }).getByRole("button", { name: "Acknowledge", exact: true }).click();
  await action(page, "Resume").click();
  await expect(grace.first()).toBeVisible();
  await action(page, "Hold next captured evidence read").click();
  await action(page, "Show sample candidate").click();
  await expect(review(page)).toBeVisible();
  await expect(action(page, "Confirm Match")).toBeDisabled();
  await expect(review(page).getByRole("img", { name: "Captured evidence", exact: true })).toHaveCount(0);
  await action(page, "Stop Search").click();
  await expect(page).toHaveURL(`${session}/result`);
  await expect(page.getByText("Record removed after expiry", { exact: true })).toBeVisible();
  await openRetention(page);
  await action(page, "Deliver held evidence read").click();
  await page.evaluate(() => window.dispatchEvent(new Event("online")));
  await expect(page.getByRole("img")).toHaveCount(0);
  await expect(page.getByRole("link", { name: "Return to Active Search" })).toHaveCount(0);

  await nav(page, "Settings").click();
  const deletion = page.getByRole("region", { name: "Deletion progress" });
  await expect(deletion).toContainText("Deletion pending");
  await openRetention(page);
  await action(page, "Fail sample deletion").click();
  await expect(deletion).toContainText("Deletion failed");
  await expect(action(page, "Preview Change")).toBeDisabled();
  await page.screenshot({ path: info.outputPath("cleanup-failed.png") });
  await nav(page, "Dashboard").click();
  await expect(page.getByText("Black wallet", { exact: true })).toHaveCount(0);
  await nav(page, "Objects / History").click();
  await expect(page.getByRole("link", { name: "View details for Black wallet" })).toHaveCount(0);
  await page.getByRole("link", { name: "View details for Surviving camera case" }).click();
  await expect(page).toHaveURL(survivor);
  await expect(page.getByRole("img", { name: "Reference for Surviving camera case", exact: true })).toBeVisible();
  await expect(action(page, "Start Search")).toBeDisabled();
  await prepareRegistration(page, "Blocked registration");
  await action(page, "Register Object").click();
  await expect(page.getByRole("alert").filter({ hasText: "Registration failed" })).toContainText(/storage/i);
});

test("demonstrates the registered Gestures target through saved evidence and history", async ({ page }, info) => {
  test.setTimeout(60_000);
  await page.setViewportSize({ width: 1440, height: 960 });
  await page.goto("/");
  await prepareRegistration(page, "Gesture demo case");
  await action(page, "Register Object").click();
  await expect(page.getByRole("heading", { name: "Object Details", exact: true })).toBeVisible();
  await page.getByRole("link", { name: "Start Search", exact: true }).click();
  await expect(page.getByRole("radio", { name: "Gestures", exact: true })).toBeChecked();
  await expect(page.getByRole("img", { name: "Selected target from Reference for Gesture demo case" })).toBeVisible();
  await page.screenshot({ path: info.outputPath("gestures-setup.png"), fullPage: true });
  await start(page);
  await expect(page.getByRole("region", { name: "Laptop webcam" })).toContainText("Live sample");
  await action(page, "Show sample candidate").click();
  await action(page, "Reject Match").press("Enter");
  await expect(review(page)).toHaveCount(0);
  await expect(page.getByRole("region", { name: "Session activity" })).toContainText("Committed session · Paused");
  await action(page, "Resume").press("Enter");
  await action(page, "Observe sample candidate exit").click();
  await action(page, "Show sample candidate").click();
  await action(page, "Confirm Match").click();
  await expect(page.getByRole("heading", { name: "Match confirmed and saved" })).toBeVisible();
  await expect(page.getByRole("region", { name: "Confirmed evidence" }).getByRole("img", { name: "Captured evidence" })).toBeVisible();
  await page.screenshot({ path: info.outputPath("gestures-result.png"), fullPage: true });
  await page.setViewportSize({ width: 1366, height: 768 });
  await page.addStyleTag({ content: "html { font-size: 200%; }" });
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(1366);
  await page.getByRole("link", { name: "View Session Details" }).press("Enter");
  const history = page.getByRole("region", { name: "Captured matches" });
  await expect(history.getByText("Confirmed", { exact: true })).toBeVisible();
  await expect(history.getByText("Rejected", { exact: true })).toBeVisible();
  await expect(history.getByText("Reviewed", { exact: true })).toHaveCount(2);
});

test("demonstrates PS4 without a webcam through Circle, deliberate recovery, and saved Stop", async ({ page }, info) => {
  test.setTimeout(60_000);
  await page.setViewportSize({ width: 1440, height: 960 });
  await page.goto("/");
  await page.getByLabel("Fixture scenario").selectOption("setup-ps4");
  await nav(page, "Objects / History").click();
  await page.getByRole("link", { name: "View details for Black wallet" }).click();
  await page.getByRole("link", { name: "Start Search", exact: true }).click();
  await expect(action(page, "Start Search")).toBeDisabled();
  await page.getByRole("radio", { name: "PS4 controller" }).check();
  await start(page);
  const webcam = page.getByRole("region", { name: "Laptop webcam" });
  await expect(webcam).toContainText("Unavailable");
  await expect(webcam).toContainText("Gesture control inactive");
  await page.screenshot({ path: info.outputPath("ps4-live.png"), fullPage: true });
  const input = page.getByRole("region", { name: "Controller feedback" });
  await action(page, "Release input").click();
  await action(page, "Hold forward").click();
  await expect(input).toContainText("Motion permission · Armed");
  await action(page, "PS4 Circle").press("Enter");
  await expect(input).toContainText("Motion permission · Disarmed");
  await action(page, "Recovery").click();
  const recovery = page.getByRole("region", { name: "Recovery", exact: true });
  await expect(recovery).toContainText("Emergency Stop");
  await action(page, "Acquire control").click();
  await expect(action(page, "Resume")).toBeDisabled();
  await recovery.getByRole("button", { name: "Acknowledge", exact: true }).click();
  await action(page, "Resume").press("Enter");
  await action(page, "Release input").click();
  await action(page, "Hold right").click();
  await expect(input).toContainText("Motion permission · Armed");
  await action(page, "Show sample candidate").click();
  await expect(review(page)).toBeVisible();
  await review(page).getByRole("button", { name: "Stop Search", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Search ended without confirmation" })).toBeVisible();
  await expect(page.getByText("The object remains Lost.", { exact: true })).toBeVisible();
  await expect(page.getByRole("link", { name: "Search Again", exact: true })).toBeVisible();
  await page.getByRole("link", { name: "View Session Details", exact: true }).click();
  const evidence = page.getByRole("region", { name: "Captured matches" });
  await expect(evidence.getByText("Not reviewed", { exact: true })).toBeVisible();
  await expect(evidence.getByText("Reviewed", { exact: true })).toHaveCount(0);
});
