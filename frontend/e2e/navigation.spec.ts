import { expect, test } from "@playwright/test";

const routes = [
  ["/", "Dashboard", "Dashboard"],
  ["/objects", "Objects / History", "Objects / History"],
  ["/objects/new", "Register Object", "Objects / History"],
  ["/objects/sample-wallet", "Object Details", "Objects / History"],
  ["/objects/sample-wallet/search", "Search Setup", "Objects / History"],
  ["/sessions/sample-search", "Session Details", "Objects / History"],
  ["/sessions/sample-search/live", "Search Workspace", "Objects / History"],
  ["/sessions/sample-search/result", "Search Result", "Objects / History"],
  ["/devices", "Devices", "Devices"],
  ["/control-guide", "Control Guide", "Control Guide"],
  ["/settings", "Settings", "Settings"],
] as const;

const fixtureLabel = "Fixture mode · Sample data · No robot connected";

test.describe("fixture preview", () => {
  test.use({ baseURL: "http://127.0.0.1:3100" });

  for (const [path, title, section] of routes) {
    test(`opens and refreshes ${path}`, async ({ page }) => {
      const response = await page.goto(path);
      expect(response?.ok()).toBeTruthy();
      for (const navigation of ["entry", "refresh"]) {
        if (navigation === "refresh") await page.reload();
        await expect(page.getByRole("heading", { level: 1, name: title })).toBeVisible();
        await expect(page.getByText(fixtureLabel, { exact: true })).toBeVisible();
        await expect(page.getByText("Phase 01 preview", { exact: true })).toBeVisible();
        await expect(page.getByRole("navigation", { name: "Main navigation" }).getByRole("link", { name: section, exact: true }))
          .toHaveAttribute("aria-current", path.startsWith("/sessions") || path.split("/").length > 2 ? "location" : "page");
      }
    });
  }

  test("follows contextual links, supports history and never starts or resumes a search", async ({ page }) => {
    const unexpectedRequests: string[] = [];
    const sockets: string[] = [];
    page.on("request", (request) => {
      if (request.method() !== "GET" || !request.url().startsWith("http://127.0.0.1:3100/")) {
        unexpectedRequests.push(`${request.method()} ${request.url()}`);
      }
    });
    page.on("websocket", (socket) => sockets.push(socket.url()));

    await page.goto("/");
    await page.keyboard.press("Tab");
    await expect(page.getByRole("link", { name: "Skip to content" })).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(page.getByRole("main")).toBeFocused();
    await page.getByRole("navigation").getByRole("link", { name: "Objects / History" }).click();
    await page.getByRole("link", { name: "Black wallet" }).click();
    await page.getByRole("link", { name: "Sample search session" }).click();
    await page.getByRole("link", { name: "Preview Search Workspace" }).click();
    await expect(page.getByRole("heading", { name: "Search Workspace" })).toBeVisible();
    await expect(page.getByText("No active search", { exact: true })).toBeVisible();
    await page.goBack();
    await expect(page.getByRole("heading", { name: "Session Details" })).toBeVisible();
    await page.goForward();
    await expect(page.getByRole("heading", { name: "Search Workspace" })).toBeVisible();
    await expect(page.getByText("No active search", { exact: true })).toBeVisible();
    expect(unexpectedRequests).toEqual([]);
    expect(sockets).toEqual([]);
    expect(await page.evaluate(() => [localStorage.length, sessionStorage.length])).toEqual([0, 0]);
  });

  for (const route of ["/unknown", "/objects/missing", "/objects/invalid.id/search", "/sessions/missing/live", "/sessions"]) {
    test(`shows a labeled not-found page at ${route}`, async ({ page }) => {
      await page.goto(route);
      await expect(page.getByRole("heading", { name: /not found/i })).toBeVisible();
      await expect(page.getByText(fixtureLabel, { exact: true })).toBeVisible();
      await expect(page.getByText("Black wallet")).toHaveCount(0);
    });
  }
});

test("non-fixture startup keeps sample data unavailable", async ({ page }) => {
  await page.goto("http://127.0.0.1:3101/objects/sample-wallet");
  await expect(page.getByRole("heading", { name: "Application data unavailable" })).toBeVisible();
  await expect(page.getByText(fixtureLabel, { exact: true })).toHaveCount(0);
  await expect(page.getByText("Black wallet")).toHaveCount(0);
});
