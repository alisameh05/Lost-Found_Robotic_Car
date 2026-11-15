import { expect, test, type Page } from "@playwright/test";

test.use({ baseURL: "http://127.0.0.1:3100" });

async function selectScenario(page: Page, scenario: string) {
  await page.getByRole("link", { name: "Dashboard", exact: true }).click();
  await page.getByLabel("Fixture scenario").selectOption(scenario);
}

async function openDevices(page: Page) {
  await page.getByRole("navigation", { name: "Main navigation" }).getByRole("link", { name: "Devices", exact: true }).click();
  await expect(page.getByRole("heading", { level: 1, name: "Devices" })).toBeVisible();
}

test("checks both modes without blocking on the inactive input or granting control", async ({ page }) => {
  await page.goto("/");
  await selectScenario(page, "gestures-ready");
  await openDevices(page);
  const main = page.getByRole("main");
  const mode = main.getByLabel("Readiness mode");
  const required = main.getByRole("region", { name: "Required for Gestures" });
  const inactive = main.getByRole("region", { name: "Inactive in this mode" });
  await expect(main.getByRole("status")).toContainText("Gestures requirements ready");
  await expect(required.getByText("Laptop webcam", { exact: true })).toBeVisible();
  await expect(inactive).toContainText("PS4 DualShock 4");
  await expect(inactive).toContainText("Unavailable");
  await expect(main.getByRole("region", { name: "Advisory only" })).toContainText("Unknown");
  await mode.selectOption("Controller");
  await expect(main.getByRole("status")).toContainText("Controller (PS4) requirements unavailable");
  await main.getByRole("button", { name: "Refresh readiness" }).click();
  await expect(main.getByRole("status")).toContainText("Controller (PS4) requirements unavailable");
  await expect(main.getByRole("link", { name: "Return to Search Setup" })).toHaveCount(0);
  await page.getByRole("link", { name: "Dashboard", exact: true }).click();
  await expect(page.getByText("Fixture mutation requests (0)", { exact: true })).toBeVisible();

  await selectScenario(page, "controller-ready");
  await openDevices(page);
  await expect(mode).toBeVisible();
  await mode.selectOption("Controller");
  await expect(main.getByRole("status")).toContainText("Controller (PS4) requirements ready");
  await expect(main.getByRole("region", { name: "Required for Controller (PS4)" })).toContainText("PS4 DualShock 4");
  await expect(inactive).toContainText("Laptop webcam");
  await expect(inactive).toContainText("Unavailable");
});

test("reads typed startup and degraded health and retries a failed snapshot", async ({ page }) => {
  await page.goto("/");
  const status = page.getByRole("main").getByRole("status");

  await selectScenario(page, "initializing");
  await openDevices(page);
  await expect(status).toContainText("Initializing services");
  await expect(page.locator("summary").filter({ hasText: "Managed storage" })).toContainText("Initializing");

  await selectScenario(page, "failed");
  await openDevices(page);
  await expect(status).toContainText("Device readiness degraded");
  await expect(status).toContainText("Managed storage is unavailable");
  await expect(status).toContainText("Showing the reported health observations");
  await expect(page.getByRole("region", { name: "Advisory only" })).toContainText("Unavailable");

  await selectScenario(page, "camera-unavailable");
  await openDevices(page);
  await expect(status).toContainText("The snapshot is unavailable");
  const retry = page.getByRole("button", { name: "Retry readiness" });
  await retry.focus();
  await page.keyboard.press("Enter");
  await expect(status).toContainText("Gestures requirements unavailable");
  await expect(status).toContainText("Robot camera");
  await expect(page.getByRole("button", { name: "Refresh readiness" })).toBeFocused();
  const required = page.getByRole("region", { name: "Required for Gestures" });
  const camera = required.locator("summary").filter({ hasText: "Robot camera" });
  await camera.focus();
  await page.keyboard.press("Enter");
  await expect(required.getByText(/camera stream is reachable/)).toBeVisible();
  const prerequisites = required.getByRole("heading", { name: "Shared application prerequisites" }).locator("..");
  for (const name of ["Backend service", "Managed storage", "Displayed robot video", "Search workspace", "Qualification profile"]) {
    await expect(prerequisites.getByText(name, { exact: true })).toBeVisible();
  }
  await expect(required.getByText("Robot command connection", { exact: true })).toBeVisible();
  await expect(required.getByText("Local matching service", { exact: true })).toBeVisible();

  await selectScenario(page, "ended");
  await openDevices(page);
  await expect(page.getByRole("region", { name: "Advisory only" })).toContainText("valid clear reading");

  await selectScenario(page, "active-readiness-retry");
  await openDevices(page);
  await expect(page.getByText("Mode unavailable. Retry readiness to identify the locked mode.")).toBeVisible();
  await expect(page.getByLabel("Readiness mode")).toHaveCount(0);
  const active = page.getByRole("link", { name: "Return to Active Search" });
  await expect(active).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Emergency Stop" })).toBeVisible();
  await retry.click();
  await expect(active).toHaveAttribute("href", "/sessions/sample-search/live");
  await expect(page.getByText("Locked to active search · Paused")).toBeVisible();
});

test("round-trips a verified setup context through Devices and the Control Guide", async ({ page }) => {
  await page.goto("/objects/sample-wallet/search?mode=Controller");
  await page.getByRole("link", { name: "View Devices" }).click();
  await expect(page.getByText("From Search Setup", { exact: true })).toBeVisible();
  await expect(page.getByRole("region", { name: "Required for Controller (PS4)" })).toBeVisible();
  await expect(page.getByLabel("Readiness mode")).toHaveCount(0);
  await page.getByRole("link", { name: "Open Control Guide" }).click();
  const links = page.getByRole("navigation", { name: "Control Guide links" });
  const devices = links.getByRole("link", { name: "View Devices" });
  const setup = links.getByRole("link", { name: "Return to Search Setup" });
  await expect(devices).toHaveAttribute("href", "/devices?object=sample-wallet&mode=Controller");
  await expect(setup).toHaveAttribute("href", "/objects/sample-wallet/search?mode=Controller");
  await devices.focus();
  await page.keyboard.press("Tab");
  await expect(setup).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(/\/objects\/sample-wallet\/search\?mode=Controller$/);

  for (const object of ["sample-headphones", "sample-keys-a"]) {
    await page.goto(`/devices?object=${object}&mode=Controller`);
    await expect(page.getByLabel("Readiness mode")).toHaveValue("Gestures");
    await expect(page.getByRole("link", { name: "Return to Search Setup" })).toHaveCount(0);
  }
});

test("shows the actual active mode and keeps Emergency Stop keyboard-operable from the guide", async ({ page }) => {
  await page.goto("/devices?object=sample-wallet&mode=Gestures");
  await expect(page.getByText("From Search Setup", { exact: true })).toBeVisible();
  await selectScenario(page, "expiry-grace");
  await page.goBack();
  const active = page.getByRole("link", { name: "Return to Active Search" });
  await expect(active).toHaveAttribute("href", "/sessions/sample-grace-search/live");
  await expect(page.getByText("Locked to active search · Paused")).toBeVisible();
  await expect(page.getByRole("region", { name: "Required for Controller (PS4)" })).toBeVisible();
  await expect(page.getByLabel("Readiness mode")).toHaveCount(0);
  await expect(page.getByRole("link", { name: "Return to Search Setup" })).toHaveCount(0);

  await page.getByRole("link", { name: "Open Control Guide" }).click();
  const gestures = page.getByRole("region", { name: "Gesture directions and stop" });
  await expect(gestures).toContainText(/mirrored webcam view.*up for forward, down for backward, left for left, or right for right/);
  await expect(gestures).toContainText("closed fist, no hand, multiple hands, or ambiguous or invalid pointing");
  await expect(gestures).toContainText("Release the pointing gesture to stop.");
  const controller = page.getByRole("region", { name: "PS4 controller" });
  await expect(controller).toContainText("up for forward, down for backward, left for left, or right for right");
  await expect(controller).toContainText("Release the D-pad to stop. Conflicting directions also stop ordinary movement.");
  await expect(controller).toContainText("Press Circle for Emergency Stop. The UI Emergency Stop works in either mode.");
  const actions = page.getByRole("region", { name: "Pause, Stop Search and Emergency Stop" });
  await expect(actions).toContainText("Stops motion and matching while keeping the session active.");
  await expect(actions).toContainText("Stops motion and matching and ends the session.");
  await expect(actions).toContainText("pauses the session with recovery required.");
  const recovery = page.getByRole("region", { name: "Match review and recovery" });
  await expect(recovery).toContainText(/Confirm saves the evidence, commits the object as Found, and ends the session/);
  await expect(recovery).toContainText("Reject keeps the object Lost and the session Paused until you explicitly select Resume.");
  await expect(recovery.getByRole("listitem")).toHaveText([
    "Restore every required path.",
    "Acknowledge each restored cause.",
    "Select Resume explicitly.",
    "Release input to neutral, then apply a fresh hold.",
  ]);
  await expect(page.getByText("Fixture mode · Sample data · No robot connected")).toBeVisible();

  await expect(active).toHaveAttribute("href", "/sessions/sample-grace-search/live");
  await active.focus();
  await page.keyboard.press("Tab");
  const emergency = page.getByRole("button", { name: "Emergency Stop", exact: true });
  await expect(emergency).toBeFocused();
  await expect(emergency).toBeInViewport();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("status").filter({ hasText: "Motion permission revoked" })).toContainText("Saved");
  await page.getByRole("link", { name: "Dashboard", exact: true }).click();
  await expect(page.getByText("Fixture mutation requests (1)", { exact: true })).toBeVisible();
  await page.getByText("Fixture mutation requests (1)", { exact: true }).click();
  await expect(page.getByRole("list", { name: "Fixture mutation requests" }).getByRole("listitem")).toContainText("POST /emergency-stop");
});

test("reflows both screens at 200% with local assets and visible keyboard focus", async ({ page }, testInfo) => {
  const external: string[] = [];
  await page.route("**/*", async (route) => {
    if (new URL(route.request().url()).origin === "http://127.0.0.1:3100") await route.continue();
    else {
      external.push(route.request().url());
      await route.abort();
    }
  });

  for (const [name, path, next] of [
    ["devices", "/devices?object=sample-wallet&mode=Gestures", "Open Control Guide"],
    ["control-guide", "/control-guide?object=sample-wallet&mode=Gestures", "View Devices"],
  ]) {
    await page.setViewportSize({ width: 1440, height: 960 });
    await page.goto(path);
    const setup = page.getByRole("link", { name: "Return to Search Setup" });
    await expect(setup).toBeVisible();
    if (name === "devices") {
      await selectScenario(page, "camera-unavailable");
      await page.goBack();
      await page.getByRole("button", { name: "Retry readiness" }).click();
      await expect(page.getByRole("main").getByRole("status")).toContainText("Gestures requirements unavailable");
      await expect(setup).toBeVisible();
    }
    expect(await page.evaluate(async () => {
      await document.fonts.ready;
      return [...document.fonts].some((font) => font.family.includes("Instrument Sans") && font.status === "loaded");
    })).toBe(true);
    await page.screenshot({ path: testInfo.outputPath(`${name}-1440x960.png`) });
    await page.setViewportSize({ width: 1366, height: 768 });
    await page.screenshot({ path: testInfo.outputPath(`${name}-1366x768.png`) });
    await page.addStyleTag({ content: "html { font-size: 200%; }" });
    await expect(page.getByRole("heading", { level: 1 })).toHaveCSS("font-size", "60px");
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(1366);
    await page.getByRole("main").getByRole("link", { name: next }).focus();
    await page.keyboard.press("Tab");
    await expect(setup).toBeFocused();
    await expect(setup).toHaveCSS("outline-style", "solid");
    await expect(setup).toBeInViewport();
    await page.screenshot({ fullPage: true, path: testInfo.outputPath(`${name}-text-200-percent.png`) });
  }
  expect(external).toEqual([]);
});
