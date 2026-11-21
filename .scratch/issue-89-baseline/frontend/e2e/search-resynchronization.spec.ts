import { expect, test, type Page } from "@playwright/test";

test.use({ baseURL: "http://127.0.0.1:3100" });

const button = (page: Page, name: string) => page.getByRole("button", { name, exact: true });

async function start(page: Page) {
  await page.goto("/objects/sample-wallet/search");
  await button(page, "Acquire control").click();
  await button(page, "Start Search").click();
  await expect(page).toHaveURL(/\/sessions\/[^/]+\/live$/);
  await expect(page.getByRole("region", { name: "Robot camera" })).toContainText("Live sample");
  await page.getByText("Workspace fixture controls", { exact: true }).click();
}

test("an event gap revokes the owner and requires deliberate same-boot recovery", async ({ page }) => {
  await start(page);
  const liveUrl = page.url();
  await button(page, "Release input").click();
  await button(page, "Hold forward").click();
  await expect(page.getByText("Motion permission · Armed")).toBeVisible();
  await button(page, "Inject event sequence gap").evaluate((element: HTMLButtonElement) => element.click());
  await expect(page.getByText("Search events disconnected. Resynchronizing with the service.")).toBeVisible();
  await expect(page.getByText("Not live", { exact: true })).toBeVisible();
  await expect(button(page, "Emergency Stop")).toBeEnabled();
  await expect(button(page, "Acquire control")).toBeEnabled();
  await expect(button(page, "Resume")).toBeDisabled();
  await expect(page).toHaveURL(liveUrl);
  await button(page, "Acquire control").click();
  await expect(button(page, "Resume")).toBeDisabled();
  await button(page, "Recovery").click();
  const recovery = page.getByRole("region", { name: "Recovery" });
  await expect(recovery).toContainText("Workspace disconnected");
  await recovery.getByRole("button", { name: "Acknowledge" }).click();
  await button(page, "Resume").click();
  await button(page, "Hold forward").click();
  await expect(page.getByText("Motion permission · Disarmed")).toBeVisible();
  await button(page, "Release input").click();
  await button(page, "Hold forward").click();
  await expect(page.getByText("Motion permission · Armed")).toBeVisible();
});

for (const prepared of [true, false]) {
  test(`restart saves an Interrupted search with ${prepared ? "prepared" : "no unsaved"} evidence`, async ({ page }) => {
    await start(page);
    const sessionUrl = page.url().replace(/\/live$/, "");
    const review = page.getByRole("region", { name: "Review potential match" });
    if (prepared) {
      await button(page, "Show sample candidate").click();
      await button(page, "Hold next search save").click();
      await button(page, "Hold next search action response until restart").click();
      await button(page, "Confirm Match").click();
      await expect(review.getByText("Save pending", { exact: true })).toBeVisible();
    } else {
      await button(page, "Hold sample evidence preparation").click();
      await expect(page.getByRole("region", { name: "Session activity" })).toContainText("Committed session · Paused");
      await expect(review).toHaveCount(0);
    }
    await button(page, "Restart fixture service").click();
    if (prepared) await expect(page.getByText("Action outcome unconfirmed")).toBeVisible();
    await expect(page.getByRole("link", { name: "View Search Result" })).toBeVisible();
    await expect(button(page, "Retry original action")).toHaveCount(0);
    await expect(button(page, "Resume")).toHaveCount(0);
    await expect(page.getByRole("link", { name: "Return to Active Search" })).toHaveCount(0);
    await page.getByRole("link", { name: "View Search Result" }).click();
    await expect(page).toHaveURL(`${sessionUrl}/result`);
    const summary = page.getByRole("region", { name: "Session summary" });
    await expect(summary).toContainText("Interrupted");
    await expect(summary).toContainText("Gestures");
    await expect(summary.locator("time")).toHaveCount(2);
    await expect(page.getByRole("link", { name: "Search Again" })).toBeVisible();
    await expect(page.getByText("The object remains Lost.")).toBeVisible();
    await page.getByRole("link", { name: "View Session Details" }).click();
    await expect(page).toHaveURL(sessionUrl);
    await expect(page.getByText("Search interrupted", { exact: true }).first()).toBeVisible();
    const history = page.getByRole("region", { name: "Captured matches" });
    if (prepared) {
      await expect(history.getByText("Not reviewed", { exact: true })).toBeVisible();
      await expect(history.getByRole("img", { name: "Captured evidence" })).toBeVisible();
      await expect(history.locator("time")).toHaveCount(1);
    } else {
      await expect(history.getByText(/No .*matches/i)).toBeVisible();
      await expect(history.locator("time")).toHaveCount(0);
    }
  });
}
