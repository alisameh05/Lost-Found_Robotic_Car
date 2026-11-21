import { expect, test, type Page } from "@playwright/test";

test.use({ baseURL: "http://127.0.0.1:3100" });

const action = (page: Page, name: string) => page.getByRole("button", { name, exact: true });

async function setup(page: Page) {
  await page.goto("/objects/sample-wallet/search");
  await expect(action(page, "Start Search")).toBeDisabled();
  await action(page, "Acquire control").click();
}

test("maps finger counts and stops changing or invalid gestures without bypassing neutral", async ({ page }) => {
  await setup(page);
  await action(page, "Start Search").click();
  await expect(page).toHaveURL(/\/live$/);
  await page.getByText("Workspace fixture controls", { exact: true }).click();
  const feedback = page.getByRole("region", { name: "Gesture feedback" });
  for (const [direction, count] of [["forward", 1], ["backward", 2], ["left", 3], ["right", 4]] as const) {
    await action(page, "Release input").click();
    await expect(feedback).toContainText("0 fingers · neutral / stop");
    await action(page, `Hold ${direction}`).click();
    await expect(feedback).toContainText(`Held ${direction} · ${count} ${count === 1 ? "finger" : "fingers"}`);
    await expect(feedback).toContainText("Motion permission · Armed");
  }
  // A different count immediately stops the old direction, without silently rearming.
  await action(page, "Hold backward").click();
  await expect(feedback).toContainText("Motion permission · Disarmed");
  for (const observation of ["Observe five fingers", "Observe no hand", "Observe multiple hands", "Observe changing count", "Ambiguous gesture"]) {
    await action(page, "Release input").click();
    await action(page, "Hold forward").click();
    await expect(feedback).toContainText("Motion permission · Armed");
    await action(page, observation).click();
    await expect(feedback).toContainText("Motion permission · Disarmed");
    await expect(feedback).toContainText("Ambiguous or unsupported gesture · stopped");
    await action(page, "Hold forward").click();
    await expect(feedback).toContainText("Motion permission · Disarmed");
  }
  await action(page, "Pause").click();
  await action(page, "Resume").click();
  await action(page, "Observe five fingers").click();
  await action(page, "Hold forward").click();
  await expect(feedback).toContainText("Motion permission · Disarmed");
  await action(page, "Release input").click();
  await action(page, "Hold forward").click();
  await expect(feedback).toContainText("Motion permission · Armed");
  await action(page, "Control Help").click();
  const help = page.getByRole("region", { name: "Gesture directions and stop" });
  await expect(help).toContainText("1 finger for forward, 2 fingers for backward, 3 fingers for left, or 4 fingers for right");
  await expect(help).toContainText("0 fingers (a closed fist) for neutral / stop");
  await expect(action(page, "Emergency Stop")).toBeEnabled();
});

test("starts a single search and saves the stopped session without changing Lost", async ({ page }) => {
  await setup(page);
  await expect(action(page, "Start Search")).toBeEnabled();
  await action(page, "Start Search").press("Enter");
  await expect(page).toHaveURL(/\/sessions\/[^/]+\/live$/);
  const live = page.url();
  await expect(page.getByRole("heading", { name: "Live Search Workspace" })).toBeVisible();
  await action(page, "Pause").click();
  await expect(action(page, "Resume")).toBeEnabled();
  await action(page, "Resume").click();
  await expect(action(page, "Pause")).toBeEnabled();
  expect(page.url()).toBe(live);
  await action(page, "Stop Search").click();
  await expect(page).toHaveURL(live.replace(/live$/, "result"));
  await expect(page.getByRole("heading", { name: "Search ended without confirmation" })).toBeVisible();
  await expect(page.getByRole("link", { name: "Search Again" })).toBeVisible();
  await page.getByRole("link", { name: "View Session Details" }).click();
  await expect(page.getByRole("heading", { name: "Session Details" })).toBeVisible();
  await expect(page.getByRole("region", { name: "Session record" })).toContainText("Stopped");
});

async function chooseScenario(page: Page, scenario: string) {
  await page.goto("/");
  await page.getByLabel("Fixture scenario").selectOption(scenario);
  await page.getByRole("link", { name: "Objects / History" }).click();
  await page.getByRole("link", { name: "View details for Black wallet" }).click();
  await page.getByRole("link", { name: "Start Search" }).click();
}

for (const mode of ["Gestures", "PS4"] as const) {
  test(`${mode} requires neutral and fresh holds, stops ordinary input, and revokes on a stale display`, async ({ page }, info) => {
    await page.setViewportSize({ width: 1440, height: 960 });
    await page.route("**/*", (route) => route.request().url().startsWith("http://127.0.0.1:3100/") ? route.continue() : route.abort());
    if (mode === "PS4") {
      await chooseScenario(page, "setup-ps4");
      await action(page, "Acquire control").click();
      await expect(action(page, "Start Search")).toBeDisabled();
      await page.getByRole("radio", { name: "Gestures", exact: true }).press("ArrowDown");
      await expect(page.getByRole("radio", { name: "PS4 controller" })).toBeChecked();
    } else await setup(page);

    await expect(action(page, "Start Search")).toBeEnabled();
    await action(page, "Start Search").press("Enter");
    const owner = page.getByRole("region", { name: "Control ownership" });
    await expect(owner).toContainText("This workspace holds control");
    const camera = page.getByRole("region", { name: "Robot camera" });
    const webcam = page.getByRole("region", { name: "Laptop webcam" });
    await expect(camera).toContainText("Live sample");
    await expect(webcam).toContainText(mode === "PS4" ? "Gesture control inactive" : "Live sample");
    if (mode === "PS4") await expect(webcam).toContainText("Unavailable");
    const cameraLeft = await webcam.boundingBox();
    const cameraRight = await camera.boundingBox();
    expect(cameraLeft!.x).toBeLessThan(cameraRight!.x);
    await page.screenshot({ path: info.outputPath(`workspace-${mode}.png`) });

    await page.getByText("Workspace fixture controls", { exact: true }).click();
    const feedback = page.getByRole("region", { name: mode === "PS4" ? "Controller feedback" : "Gesture feedback" });
    await action(page, "Hold forward").click();
    await expect(feedback).toContainText("Motion permission · Disarmed");
    for (const direction of ["forward", "backward", "left", "right"]) {
      await action(page, "Release input").click();
      await expect(feedback).toContainText("Motion permission · Arming");
      await expect(camera).toContainText("AI matching active");
      await action(page, `Hold ${direction}`).click();
      await expect(feedback).toContainText(`Held ${direction}`);
      await expect(feedback).toContainText("Motion permission · Armed");
    }
    await action(page, mode === "PS4" ? "Conflicting D-pad input" : "Ambiguous gesture").click();
    await expect(feedback).toContainText("Motion permission · Disarmed");
    await action(page, "Pause").press("Enter");
    await expect(camera).toContainText("AI matching suspended");
    await expect(action(page, "Resume")).toBeEnabled();
    await action(page, "Resume").press("Enter");
    await action(page, "Hold right").click();
    await expect(feedback).toContainText("Motion permission · Disarmed");
    await action(page, "Release input").click();
    await action(page, "Hold right").click();
    await expect(feedback).toContainText("Motion permission · Armed");

    await action(page, "Freeze robot frames").click();
    await expect(camera).toContainText("Not live");
    await expect(owner).toContainText("Spectator");
    await expect(action(page, "Resume")).toBeDisabled();
    await action(page, "Send fresh frames").click();
    await expect(camera).toContainText("Live sample");
    await expect(action(page, "Resume")).toBeDisabled();

    await page.setViewportSize({ width: 1366, height: 768 });
    await page.addStyleTag({ content: "html { font-size: 200%; }" });
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(1366);
    const emergency = action(page, "Emergency Stop");
    await emergency.focus();
    await expect(emergency).toBeFocused();
    await page.keyboard.press("Space");
    await expect(page.getByText("Motion permission revoked", { exact: true })).toBeVisible();
  });
}

test("keeps one unresolved Start and reconciles pending, failed, and unknown requests", async ({ page }) => {
  await setup(page);
  await page.getByText("Search setup fixture controls", { exact: true }).click();
  await action(page, "Hold next search save").click();
  await action(page, "Start Search").click();
  await expect(page.getByText("Save pending", { exact: true })).toBeVisible();
  await expect(action(page, "Start Search")).toBeDisabled();
  await action(page, "Retry original action").click();
  await expect(page.getByText("Save pending", { exact: true })).toBeVisible();
  await action(page, "Fail pending search save").click();
  await expect(page.getByText("Save failed", { exact: true })).toBeVisible();
  await action(page, "Drop next search request").click();
  await action(page, "Start Search").click();
  await expect(page.getByText("Action outcome unconfirmed", { exact: true })).toBeVisible();
  await expect(action(page, "Start Search")).toBeDisabled();
  await action(page, "Hold next search save").click();
  await action(page, "Retry original action").click();
  await expect(page.getByText("Save pending", { exact: true })).toBeVisible();
  await action(page, "Commit pending search save").click();
  await expect(page).toHaveURL(/\/sessions\/[^/]+\/live$/);
  await expect(page.getByRole("region", { name: "Control ownership" })).toContainText("This workspace holds control");
});

test("offers Stay, leaves a committed Paused search, and ends it only on explicit Stop", async ({ page }) => {
  await setup(page);
  await action(page, "Start Search").click();
  await expect(page).toHaveURL(/\/live$/);
  const sessionUrl = page.url();
  const dashboard = page.getByRole("link", { name: "Dashboard", exact: true });
  const choices = page.getByRole("region", { name: "Leave search workspace" });
  await dashboard.click();
  await choices.getByRole("button", { name: "Stay" }).press("Enter");
  expect(page.url()).toBe(sessionUrl);
  await expect(action(page, "Pause")).toBeEnabled();
  await page.getByText("Workspace fixture controls", { exact: true }).click();
  await action(page, "Drop next search request").click();
  await dashboard.click();
  await choices.getByRole("button", { name: "Leave Paused" }).click();
  await expect(page.getByText("Action outcome unconfirmed")).toBeVisible();
  await expect(page).toHaveURL(sessionUrl);
  await expect(page.getByText("Committed session · Searching")).toBeVisible();
  await action(page, "Retry original action").click();
  await expect(page).toHaveURL("/");
  await page.getByRole("link", { name: "Return to Active Search" }).first().click();
  await expect(page).toHaveURL(sessionUrl);
  await expect(page.getByText("Committed session · Paused")).toBeVisible();
  await expect(action(page, "Resume")).toBeDisabled();
  await action(page, "Acquire control").click();
  await expect(action(page, "Resume")).toBeEnabled();
  await dashboard.click();
  await choices.getByRole("button", { name: "Stop Search" }).click();
  await expect(page).toHaveURL(sessionUrl.replace(/live$/, "result"));
  await expect(page.getByText("The object remains Lost.")).toBeVisible();
  await expect(page.getByRole("link", { name: "Return to Active Search" })).toHaveCount(0);
});

test("keeps Emergency Stop independent of a pending ordinary save", async ({ page }) => {
  await setup(page);
  await action(page, "Start Search").click();
  await page.getByText("Workspace fixture controls", { exact: true }).click();
  await action(page, "Hold next search save").click();
  await action(page, "Pause").click();
  await expect(page.getByText("Session save pending")).toBeVisible();
  await expect(page.getByText("Committed session · Searching")).toBeVisible();
  await action(page, "Emergency Stop").press("Space");
  await expect(page.getByText("Motion permission revoked", { exact: true })).toBeVisible();
  await expect(page.getByRole("region", { name: "Gesture feedback" })).toContainText("Disarmed");
});

test("leaves only after an unconfirmed release is reconciled by lease expiry", async ({ page }) => {
  await setup(page);
  await action(page, "Start Search").click();
  await page.getByText("Workspace fixture controls", { exact: true }).click();
  await action(page, "Drop next lease release").click();
  await page.getByRole("link", { name: "Dashboard", exact: true }).click();
  await action(page, "Leave Paused").click();
  await expect(page.getByText("Release could not be confirmed.", { exact: false })).toBeVisible();
  await expect(page).toHaveURL(/\/live$/);
  await expect(page.getByText("Committed session · Paused")).toBeVisible();
  await expect(action(page, "Acquire control")).toBeEnabled();
  await action(page, "Leave Paused").click();
  await expect(page).toHaveURL("/");
});

test("keeps effective Paused on reacquisition when an emergency pause failed to save", async ({ page }) => {
  await page.goto("/");
  await page.getByLabel("Fixture scenario").selectOption("emergency-failed");
  await page.getByRole("link", { name: "Return to Active Search" }).first().click();
  await action(page, "Emergency Stop").click();
  await expect(page.getByText(/Save failed · STORAGE_UNAVAILABLE/)).toBeVisible();
  const target = page.getByRole("region", { name: "Active search target" });
  await expect(target).toContainText("Paused");
  await expect(page.getByText("Committed session · Searching")).toBeVisible();
  await action(page, "Acquire control").click();
  await expect(page.getByRole("region", { name: "Control ownership" })).toContainText("This workspace holds control");
  await expect(target).toContainText("Paused");
  await expect(page.getByRole("region", { name: "Controller feedback" })).toContainText("Motion permission · Disarmed");
});

test("a deliberate Pause supersedes an unresolved Resume", async ({ page }) => {
  await setup(page);
  await action(page, "Start Search").click();
  await action(page, "Pause").click();
  await page.getByText("Workspace fixture controls", { exact: true }).click();
  await action(page, "Hold next search save").click();
  await action(page, "Resume").click();
  await expect(page.getByText("Session save pending")).toBeVisible();
  await action(page, "Pause").click();
  await expect(page.getByText("Save failed", { exact: true })).toBeVisible();
  await action(page, "Commit pending search save").click();
  await expect(page.getByText("Committed session · Paused")).toBeVisible();
  await expect(action(page, "Resume")).toBeEnabled();
});

test("browser history departure revokes control and keeps the active search Paused", async ({ page }) => {
  await chooseScenario(page, "idle");
  await action(page, "Acquire control").click();
  await action(page, "Start Search").click();
  await expect(page.getByRole("region", { name: "Control ownership" })).toContainText("This workspace holds control");
  await page.goBack();
  await expect(page.getByRole("heading", { name: "Object Details" })).toBeVisible();
  const sidebar = page.getByRole("complementary").filter({ has: page.getByRole("navigation", { name: "Main navigation" }) });
  await expect(sidebar).toContainText("Paused · Black wallet");
  await sidebar.getByRole("link", { name: "Return to Active Search" }).click();
  await expect(page.getByRole("region", { name: "Control ownership" })).toContainText("Spectator");
  await expect(action(page, "Resume")).toBeDisabled();
});
