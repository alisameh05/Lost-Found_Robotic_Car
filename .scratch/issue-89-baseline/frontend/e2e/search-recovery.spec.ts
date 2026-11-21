import { expect, test, type Page } from "@playwright/test";

test.use({ baseURL: "http://127.0.0.1:3100" });

const button = (page: Page, name: string) => page.getByRole("button", { name, exact: true });

async function start(page: Page, controller = false) {
  await page.goto("/objects/sample-wallet/search");
  if (controller) await page.getByRole("radio", { name: "PS4 controller" }).click();
  await button(page, "Acquire control").click();
  await button(page, "Start Search").click();
  await expect(page).toHaveURL(/\/sessions\/[^/]+\/live$/);
  await page.getByText("Workspace fixture controls", { exact: true }).click();
}

test("recovers distinct failures in either acknowledgment order before explicit Resume", async ({ page }) => {
  await start(page);
  await button(page, "Lose command link").click();
  await button(page, "Lose command link").click();
  await button(page, "Lose matching service").click();
  await button(page, "Recovery").click();
  const recovery = page.getByRole("region", { name: "Recovery" });
  await expect(recovery.getByRole("listitem")).toHaveCount(2);
  const command = recovery.getByRole("listitem").filter({ hasText: "Command link unavailable" });
  const matching = recovery.getByRole("listitem").filter({ hasText: "Matching service unavailable" });
  await command.getByRole("button", { name: "Acknowledge" }).click();
  await expect(command).toContainText("Acknowledged");
  await expect(command).toContainText("Awaiting restoration");
  await button(page, "Restore matching service").click();
  await expect(matching).toContainText("Restored");
  await matching.getByRole("button", { name: "Acknowledge" }).click();
  await expect(matching).toHaveCount(0);
  await expect(button(page, "Resume")).toBeDisabled();
  await button(page, "Restore command link").click();
  await expect(button(page, "Resume")).toBeEnabled();
  await expect(recovery).toContainText("Choose Resume");
  await button(page, "Resume").click();
  await button(page, "Hold forward").click();
  await expect(page.getByText("Motion permission · Disarmed")).toBeVisible();
  await button(page, "Release input").click();
  await button(page, "Hold forward").click();
  await expect(page.getByText("Motion permission · Armed")).toBeVisible();
});

test("PS4 Circle revokes permission, while inactive input and proximity stay advisory", async ({ page }) => {
  await start(page, true);
  await button(page, "Release input").click();
  await button(page, "Hold forward").click();
  const input = page.getByRole("region", { name: "Controller feedback" });
  await expect(input).toContainText("Motion permission · Armed");
  await button(page, "Lose webcam").click();
  await expect(input).toContainText("Motion permission · Armed");
  await expect(button(page, "Pause")).toBeEnabled();

  const proximity = page.getByRole("status", { name: "Proximity advisory" });
  await expect(proximity).toContainText("Unknown");
  await button(page, "Observe nearby obstacle").click();
  await expect(proximity).toContainText("Warning");
  await expect(proximity).toContainText("150 mm");
  await expect(proximity).toContainText("Previous obstacle warning remains active");
  await expect(proximity).toContainText("Distance unavailable");
  await button(page, "Observe clear distance").click();
  await expect(proximity).toContainText("Obstacle warning active");
  await button(page, "Send invalid proximity sample").click();
  await expect(proximity).toContainText("Unknown");
  await button(page, "Observe clear distance").evaluate((element: HTMLButtonElement) => {
    element.click();
    element.click();
    element.click();
  });
  await expect(proximity).toContainText("Proximity · Clear");
  await expect(input).toContainText("Motion permission · Armed");

  await button(page, "PS4 Circle").press("Enter");
  await expect(input).toContainText("Motion permission · Disarmed");
  await button(page, "Recovery").click();
  const recovery = page.getByRole("region", { name: "Recovery" });
  await expect(recovery).toContainText("Emergency Stop");
  await expect(recovery.getByRole("button", { name: "Acknowledge" })).toBeDisabled();
  await button(page, "Acquire control").click();
  await expect(recovery).toContainText("Restored");
  await expect(button(page, "Resume")).toBeDisabled();
  await recovery.getByRole("button", { name: "Acknowledge" }).click();
  await expect(button(page, "Resume")).toBeEnabled();
  await button(page, "Resume").click();
  await button(page, "Lose controller").click();
  await expect(recovery).toContainText("Selected input unavailable");
  await expect(button(page, "Resume")).toBeDisabled();
});

test("acknowledges effective emergency revocation independently of an ordinary pending save", async ({ page }) => {
  await start(page);
  await button(page, "Hold next search save").click();
  await button(page, "Pause").click();
  await button(page, "Hold next emergency save").click();
  await button(page, "Control Help").click();
  await button(page, "Recovery").click();
  await expect(page.getByRole("region", { name: "Control Help" })).toBeVisible();
  const emergency = button(page, "Emergency Stop");
  await emergency.focus();
  await expect(emergency).toBeInViewport();
  await page.keyboard.press("Space");
  const response = page.getByRole("status").filter({ hasText: "Motion permission revoked" });
  await expect(response).toContainText("Save pending");
  await expect(page.getByRole("region", { name: "Active search target" })).toContainText("Paused");
  await expect(page.getByRole("region", { name: "Session activity" })).toContainText("Committed session · Searching");
  await button(page, "Fail pending emergency save").click();
  await expect(response).toContainText("Save failed");
  const failure = page.getByRole("region", { name: "Recovery" }).getByRole("listitem").filter({ hasText: "Emergency Stop" });
  const occurrence = await failure.getByText("Failure ID", { exact: false }).innerText();
  await emergency.click();
  await expect(response).toContainText("Saved");
  await expect(failure).toContainText(occurrence);
  await expect(page.getByRole("region", { name: "Session activity" })).toContainText("Committed session · Paused");
  await expect(button(page, "Resume")).toBeDisabled();
});

test("an unusable owner display and a disconnected camera require deliberate recovery", async ({ page }) => {
  await start(page);
  const camera = page.getByRole("region", { name: "Robot camera" });
  await expect(camera).toContainText("Live sample");
  const style = await page.addStyleTag({ content: 'canvas[aria-label="Fixture robot camera view"] { display: none !important; }' });
  await expect(page.getByRole("region", { name: "Control ownership" })).toContainText("Control unavailable");
  await button(page, "Recovery").click();
  const recovery = page.getByRole("region", { name: "Recovery" });
  await expect(recovery).toContainText("Workspace unusable");
  await expect(button(page, "Acquire control")).toBeDisabled();
  await style.evaluate((node) => node.parentNode?.removeChild(node));
  await button(page, "Acquire control").click();
  await recovery.getByRole("button", { name: "Acknowledge" }).click();
  await button(page, "Resume").click();
  await button(page, "Lose robot camera").click();
  await expect(camera).toContainText("Not live");
  await expect(recovery).toContainText("Robot camera unavailable");
  await button(page, "Restore robot camera").click();
  await expect(camera).toContainText("Live sample");
  await expect(button(page, "Resume")).toBeDisabled();
});

test("distinguishes an unconfirmed emergency response from the authoritative pause", async ({ page }) => {
  await start(page);
  await button(page, "Lose next emergency response").click();
  const emergency = button(page, "Emergency Stop");
  await emergency.click();
  await expect(page.getByText("Emergency Stop could not be confirmed")).toBeVisible();
  await expect(page.getByRole("region", { name: "Active search target" })).toContainText("Paused");
  await button(page, "Recovery").click();
  const failure = page.getByRole("region", { name: "Recovery" }).getByRole("listitem");
  const identity = await failure.getByText("Failure ID", { exact: false }).innerText();
  await emergency.click();
  await expect(page.getByText("Motion permission revoked", { exact: true })).toBeVisible();
  await expect(failure).toContainText(identity);
});

test("a failure cancels a pending Resume without preventing a later deliberate Resume", async ({ page }) => {
  await start(page);
  await button(page, "Pause").click();
  await button(page, "Hold next search save").click();
  await button(page, "Resume").click();
  await expect(page.getByText("Session save pending")).toBeVisible();
  await button(page, "Lose command link").click();
  await expect(page.getByText("Session save pending")).toHaveCount(0);
  await button(page, "Recovery").click();
  await button(page, "Restore command link").click();
  await button(page, "Acknowledge").click();
  await expect(button(page, "Resume")).toBeEnabled();
  await expect(page.getByRole("region", { name: "Active search target" })).toContainText("Paused");
  await button(page, "Resume").click();
  await expect(button(page, "Pause")).toBeEnabled();
});
