import { expect, test, type Page } from "@playwright/test";

test.use({ baseURL: "http://127.0.0.1:3100" });

const uuidV4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const fixtureLabel = "Fixture mode · Sample data · No robot connected";

function emergencyControl(page: Page) {
  return page.getByRole("button", { name: "Emergency Stop", exact: true });
}

async function emergencyRequests(page: Page, count: number, ordinary = false) {
  const total = count + Number(ordinary);
  const summary = page.getByText(`Fixture mutation requests (${total})`, { exact: true });
  await expect(summary).toBeVisible();
  if (!await summary.evaluate((node) => node.closest("details")?.open)) await summary.click();
  const log = page.getByRole("list", { name: "Fixture mutation requests" });
  const requests = await log.getByRole("listitem").allTextContents();
  expect(requests).toHaveLength(total);
  if (ordinary) expect(requests.shift()).toBe("POST /objects");
  return requests.map((entry) => {
    expect(entry).toMatch(/^POST \/emergency-stop /);
    const body: unknown = JSON.parse(entry.slice("POST /emergency-stop ".length));
    expect(body).toEqual({ request_id: expect.stringMatching(uuidV4) });
    return body;
  });
}

test("follows the active identity supplied by the fixture across previews", async ({ page }) => {
  await page.goto("/");
  const scenario = page.getByLabel("Fixture scenario");
  const active = page.getByRole("link", { name: "Return to Active Search" });
  await expect(active).toHaveCount(0);
  await emergencyRequests(page, 0);
  await scenario.selectOption("searching");
  await expect(active).toHaveAttribute("href", "/sessions/sample-search/live");
  await page.getByRole("link", { name: "Settings" }).click();
  await expect(page.getByRole("heading", { name: "Settings" })).toBeVisible();
  await active.click();
  await expect(page.getByRole("heading", { name: "Search Workspace" })).toBeVisible();
  await expect(page.getByText("Committed session · Searching")).toBeVisible();
  await page.getByRole("link", { name: "Dashboard" }).click();
  await emergencyRequests(page, 0);
  await scenario.selectOption("paused");
  await expect(active).toHaveAttribute("href", "/sessions/sample-search/live");
  await scenario.selectOption("expiry-grace");
  await expect(active).toHaveAttribute("href", "/sessions/sample-grace-search/live");
  await active.click();
  await expect(page).toHaveURL(/\/sessions\/sample-grace-search\/live$/);
  await expect(page.getByRole("heading", { name: "Search Workspace" })).toBeVisible();
  await expect(page.getByText("Committed session · Paused")).toBeVisible();
  await page.getByRole("link", { name: "Dashboard" }).click();
  await emergencyRequests(page, 0);
  await scenario.selectOption("ended");
  await expect(active).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Emergency Stop" })).toHaveCount(0);
  await scenario.selectOption("failed");
  await page.getByRole("button", { name: "Retry snapshot" }).click();
  await expect(page.getByRole("region", { name: "Search status" }).getByRole("status")).toContainText("Search status unavailable");
  await emergencyRequests(page, 0);
});

for (const [scenario, input, panel, result] of [
  ["searching", "mouse", false, "Saved"],
  ["emergency-pending", "keyboard", false, "Save pending"],
  ["emergency-failed", "mouse", true, "Save failed · STORAGE_UNAVAILABLE"],
  ["emergency-pending", "keyboard", true, "Save pending"],
] as const) {
  test(`dispatches by ${input} with a save outstanding (${scenario}${panel ? ", panel and error" : ""})`, async ({ page }) => {
    page.on("dialog", async (dialog) => {
      await dialog.dismiss();
      throw new Error("Emergency Stop opened a confirmation dialog");
    });
    await page.goto("/");
    const selector = page.getByLabel("Fixture scenario");
    await selector.selectOption(scenario);
    const save = page.getByRole("region", { name: "Sample submission" });
    await save.getByRole("textbox", { name: "Sample label" }).fill("Sample request held open");
    await save.getByRole("button", { name: "Save sample" }).click();
    await expect(save.getByRole("status")).toContainText("Save pending");
    await emergencyRequests(page, 0, true);
    const retrieval = page.getByRole("region", { name: "Sample retrieval" });
    if (panel) {
      await page.getByRole("button", { name: "Inspect sample media" }).click();
      await retrieval.getByRole("button", { name: "Load data" }).click();
      await expect(retrieval.getByText("Loading sample data")).toBeVisible();
      await expect(emergencyControl(page)).toBeInViewport();
      await expect(retrieval.getByText("Sample data unavailable")).toBeVisible();
      await expect(page.getByRole("region", { name: "Sample media preview" })).toBeVisible();
    }

    const stop = emergencyControl(page);
    if (input === "keyboard") {
      await page.getByRole("link", { name: "Return to Active Search" }).focus();
      await page.keyboard.press("Tab");
      await expect(stop).toBeFocused();
      await page.keyboard.press("Space");
    } else {
      await stop.click();
    }
    const response = page.getByRole("status").filter({ hasText: "Motion permission revoked" });
    await expect(response).toContainText(result);
    const search = page.getByRole("region", { name: "Active search", exact: true });
    await expect(search.getByText("Paused", { exact: true })).toBeVisible();
    if (scenario === "emergency-pending") await expect(search.getByText("Save pending · Committed session Searching")).toBeVisible();
    await expect(save.getByRole("status")).toContainText("Save pending");
    await expect(save.getByRole("button", { name: "Deliver save result" })).toBeVisible();
    await emergencyRequests(page, 1, true);

    if (panel) {
      await retrieval.getByRole("button", { name: "Retry read" }).click();
      await expect(retrieval.getByText("No data")).toBeVisible();
      await expect(response).toContainText(result);
      await expect(save.getByRole("status")).toContainText("Save pending");
      await emergencyRequests(page, 1, true);
    }
    await selector.selectOption("restored");
    await expect(search.getByText("Paused", { exact: true })).toBeVisible();
    await emergencyRequests(page, 0);
    await page.getByRole("link", { name: "Return to Active Search" }).click();
    await expect(page.getByText("Committed session · Paused")).toBeVisible();
    await expect(page.getByText(fixtureLabel, { exact: true })).toBeVisible();
    await page.getByRole("link", { name: "Dashboard" }).click();
    await emergencyRequests(page, 0);
  });
}

test("retries the identical unconfirmed request and creates a new ID after acknowledgment", async ({ page }) => {
  await page.goto("/");
  const scenario = page.getByLabel("Fixture scenario");
  await scenario.selectOption("emergency-network");
  const stop = emergencyControl(page);
  await stop.click();
  const unconfirmed = page.getByRole("status").filter({ hasText: "Emergency Stop could not be confirmed" });
  await expect(unconfirmed).toBeVisible();
  await expect(page.getByText("Motion permission revoked", { exact: true })).toHaveCount(0);
  const [first] = await emergencyRequests(page, 1);
  await stop.click();
  await expect(unconfirmed).toBeVisible();
  expect(await emergencyRequests(page, 2)).toEqual([first, first]);

  await scenario.selectOption("searching");
  await stop.click();
  await expect(page.getByRole("status").filter({ hasText: "Motion permission revoked" })).toContainText("Saved");
  await stop.click();
  const [next, another] = await emergencyRequests(page, 2);
  expect(next).not.toEqual(first);
  expect(another).not.toEqual(next);
});
