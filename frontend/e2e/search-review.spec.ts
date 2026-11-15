import { expect, test, type Page } from "@playwright/test";

test.use({ baseURL: "http://127.0.0.1:3100" });

const action = (page: Page, name: string) => page.getByRole("button", { name, exact: true });
const review = (page: Page) => page.getByRole("region", { name: "Review potential match" });

async function start(page: Page, ps4 = false) {
  if (ps4) {
    await page.goto("/");
    await page.getByLabel("Fixture scenario").selectOption("setup-ps4");
    await page.getByRole("link", { name: "Objects / History" }).click();
    await page.getByRole("link", { name: "View details for Black wallet" }).click();
    await page.getByRole("link", { name: "Start Search" }).click();
    await page.getByRole("radio", { name: "PS4 controller" }).check();
  } else await page.goto("/objects/sample-wallet/search");
  await action(page, "Acquire control").click();
  await action(page, "Start Search").click();
  await expect(page).toHaveURL(/\/sessions\/[^/]+\/live$/);
  await expect(page.getByRole("region", { name: "Robot camera" })).toContainText("Live sample");
  await page.getByText("Workspace fixture controls", { exact: true }).click();
}

test("rejects a candidate, resumes through uncertain continuity, and confirms after exit and re-entry", async ({ page }, info) => {
  await page.setViewportSize({ width: 1440, height: 960 });
  await start(page);
  const resultUrl = page.url().replace(/live$/, "result");
  await action(page, "Show sample candidate").click();
  await expect(review(page)).toContainText("Paused");
  await expect(page.getByRole("region", { name: "Robot camera" })).toContainText("AI matching suspended");
  await review(page).getByRole("button", { name: "Inspect evidence" }).press("Enter");
  await expect(review(page).getByRole("region", { name: "Enlarged captured evidence" })).toBeFocused();
  await expect(action(page, "Emergency Stop")).toBeVisible();
  await page.screenshot({ path: info.outputPath("match-review.png") });
  await action(page, "Reject Match").press("Enter");
  await expect(review(page)).toHaveCount(0);
  await expect(page.getByRole("region", { name: "Session activity" })).toContainText("Committed session · Paused");
  await action(page, "Mark sample continuity uncertain").click();
  await action(page, "Resume").click();
  await action(page, "Show sample candidate").click();
  await expect(review(page)).toHaveCount(0);
  await action(page, "Mark sample continuity uncertain").click();
  await action(page, "Show sample candidate").click();
  await expect(review(page)).toHaveCount(0);
  await action(page, "Observe sample candidate exit").click();
  await action(page, "Show sample candidate").click();
  await expect(action(page, "Confirm Match")).toBeEnabled();
  await action(page, "Confirm Match").click();
  await expect(page).toHaveURL(resultUrl);
  await expect(page.getByRole("heading", { name: "Match confirmed and saved" })).toBeVisible();
  await expect(page.getByRole("img", { name: "Captured evidence", exact: true })).toBeVisible();
  await expect(page.getByRole("link", { name: "Search Again" })).toHaveCount(0);
  await action(page, "Zoom in").press("Enter");
  await expect(page.getByRole("region", { name: "Enlarged captured evidence" })).toBeFocused();
  await action(page, "Reset view").press("Enter");
  await page.screenshot({ path: info.outputPath("found-result.png"), fullPage: true });
  await expect(page.getByRole("link", { name: "View Object Details" })).toHaveAttribute("href", "/objects/sample-wallet");
  await page.getByRole("link", { name: "View Session Details" }).click();
  const history = page.getByRole("region", { name: "Captured matches" });
  await expect(history.getByText("Rejected", { exact: true })).toBeVisible();
  await expect(history.getByText("Confirmed", { exact: true })).toBeVisible();
  await expect(history.getByText("Reviewed", { exact: true })).toHaveCount(2);
});

test("keeps history unreviewed until commit and lets Stop win against a pending confirmation", async ({ page }) => {
  await start(page, true);
  const resultUrl = page.url().replace(/live$/, "result");
  await action(page, "Show sample candidate").click();
  await action(page, "Hold next search save").click();
  await action(page, "Confirm Match").click();
  await expect(review(page).getByText("Save pending", { exact: true })).toBeVisible();
  await expect(action(page, "Confirm Match")).toBeDisabled();
  await expect(action(page, "Reject Match")).toBeDisabled();
  await expect(review(page).getByText("Reviewed", { exact: true })).toHaveCount(0);
  await action(page, "Retry original action").click();
  await expect(review(page).getByText("Save pending", { exact: true })).toBeVisible();
  await expect(page).toHaveURL(/\/live$/);
  await action(page, "Stop Search").click();
  await expect(page).toHaveURL(resultUrl);
  await expect(page.getByText("The object remains Lost.")).toBeVisible();
  await expect(page.getByRole("region", { name: "Session summary" })).toContainText("PS4 DualShock 4");
  await expect(page.getByText("Not reviewed", { exact: true })).toBeVisible();
  await expect(page.getByText("Reviewed", { exact: true })).toHaveCount(0);
  await page.getByRole("link", { name: "View Session Details" }).click();
  const captured = page.getByRole("region", { name: "Captured matches" });
  await expect(captured.getByText("Not reviewed", { exact: true })).toBeVisible();
  await expect(captured.getByRole("img", { name: "Captured evidence" })).toBeVisible();
  await expect(captured.locator("time")).toHaveCount(1);
});

test("recovers from failed and undelivered review saves", async ({ page }) => {
  await start(page);
  await action(page, "Show sample candidate").click();
  await action(page, "Fail next search save").click();
  await action(page, "Confirm Match").click();
  await expect(review(page).getByText("Save failed", { exact: true })).toBeVisible();
  await expect(page).toHaveURL(/\/live$/);
  await action(page, "Drop next search request").click();
  await action(page, "Confirm Match").click();
  await expect(review(page).getByText("Action outcome unconfirmed")).toBeVisible();
  await expect(action(page, "Confirm Match")).toBeDisabled();
  await action(page, "Retry original action").click();
  await expect(page).toHaveURL(/\/result$/);
  await expect(page.getByRole("heading", { name: "Match confirmed and saved" })).toBeVisible();
});

test("keeps keyboard Emergency Stop available during inspection and a pending review save", async ({ page }) => {
  await start(page);
  await action(page, "Show sample candidate").click();
  await action(page, "Hold next search save").click();
  await action(page, "Confirm Match").click();
  await expect(review(page).getByText("Save pending", { exact: true })).toBeVisible();
  await action(page, "Inspect evidence").press("Enter");
  await expect(page.getByRole("region", { name: "Enlarged captured evidence" })).toBeFocused();
  await page.getByRole("complementary").getByRole("link", { name: "Return to Active Search" }).focus();
  await page.keyboard.press("Tab");
  await expect(action(page, "Emergency Stop")).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(page.getByText(/Motion permission revoked/)).toBeVisible();
  await action(page, "Commit pending search save").click();
  await expect(review(page).getByText("Save failed", { exact: true })).toBeVisible();
  await expect(page).toHaveURL(/\/live$/);
  await expect(action(page, "Confirm Match")).toBeDisabled();
  await expect(review(page).getByText("Reviewed", { exact: true })).toHaveCount(0);
});

for (const [fault, feedback] of [["missing", "Media not found"], ["corrupt", "Image could not be decoded"]] as const) {
  test(`blocks confirmation of ${fault} evidence and keeps Emergency Stop operable`, async ({ page }) => {
    await start(page);
    await action(page, "Try unprepared sample candidate").click();
    await expect(review(page)).toHaveCount(0);
    await action(page, `Show sample with ${fault} evidence`).click();
    await expect(review(page).getByText(feedback, { exact: true })).toBeVisible();
    await expect(action(page, "Confirm Match")).toBeDisabled();
    await expect(action(page, "Stop Search")).toBeEnabled();
    await page.addStyleTag({ content: "html { font-size: 200%; }" });
    await page.getByRole("complementary").getByRole("link", { name: "Return to Active Search" }).focus();
    await page.keyboard.press("Tab");
    await expect(action(page, "Emergency Stop")).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(page.getByText(/Motion permission revoked/)).toBeVisible();
    await expect(review(page)).toBeVisible();
  });
}

test("reads a direct Found result across match pages and preserves saved times with missing media", async ({ page }) => {
  await page.goto("/sessions/sample-confirmed-search/result");
  await expect(page.getByRole("region", { name: "Confirmed evidence" }).getByRole("img", { name: "Captured evidence" })).toBeVisible();
  await page.getByRole("link", { name: "Return to Dashboard" }).click();
  await page.getByLabel("Fixture scenario").selectOption("missing-confirmation-media");
  await page.getByRole("link", { name: "Objects / History", exact: true }).click();
  await page.getByRole("link", { name: "View details for Headphones" }).click();
  const sessions = page.getByRole("region", { name: "Search sessions" });
  await sessions.getByRole("button", { name: "Next" }).click();
  await sessions.getByRole("listitem").filter({ hasText: "Found" }).getByRole("link").click();
  await page.getByRole("link", { name: "View Search Result" }).click();
  await expect(page).toHaveURL(/\/sessions\/sample-confirmed-search\/result$/);
  const evidence = page.getByRole("region", { name: "Confirmed evidence" });
  await expect(evidence.getByText("Media missing", { exact: true })).toBeVisible();
  await expect(evidence.locator("time").last()).toHaveAttribute("datetime", "2026-11-13T11:56:59.998Z");
  await expect(page.getByRole("region", { name: "Session summary" })).toContainText("Match confirmed");
  await expect(action(page, "Zoom in")).toHaveCount(0);
  await expect(page.getByRole("link", { name: "View Object Details" })).toBeVisible();
  await page.goto("/sessions/sample-expired-search/result");
  await expect(page.getByText("Session expired", { exact: true })).toBeVisible();
  await page.goto("/sessions/sample-purged-search/result");
  await expect(page.getByRole("heading", { name: "Session not found" })).toBeVisible();
});
