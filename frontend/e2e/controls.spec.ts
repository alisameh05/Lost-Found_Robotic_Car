import { expect, test } from "@playwright/test";

test.use({ baseURL: "http://127.0.0.1:3100" });

test("validates a sample by keyboard and waits for one scripted outcome", async ({ page }) => {
  await page.goto("/");
  const form = page.getByRole("region", { name: "Sample submission" });
  const label = form.getByRole("textbox", { name: "Sample label" });
  const save = form.getByRole("button", { name: "Save sample" });
  await save.focus();
  await page.keyboard.press("Enter");
  await expect(label).toBeFocused();
  await expect(label).toHaveAttribute("aria-invalid", "true");
  await expect(label).toHaveAccessibleDescription("Enter any label to try the sample submission. Enter a sample label.");
  await page.keyboard.type("Demo note");
  await expect(label).not.toHaveAttribute("aria-invalid", "true");

  await page.keyboard.press("Tab");
  await expect(form.getByRole("searchbox")).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(form.getByRole("spinbutton")).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(form.getByRole("checkbox")).toBeFocused();
  await page.keyboard.press("Space");
  await expect(form.getByRole("checkbox")).toBeChecked();
  await page.keyboard.press("Tab");
  await expect(form.getByRole("radio", { name: "Commit" })).toBeFocused();
  await page.keyboard.press("ArrowRight");
  await expect(form.getByRole("radio", { name: "Fail" })).toBeChecked();
  await page.keyboard.press("Tab");
  await expect(save).toBeFocused();
  expect(await save.evaluate((button) => {
    const style = getComputedStyle(button);
    return [style.outlineWidth, style.outlineOffset, style.outlineColor];
  })).toEqual(["2px", "2px", "rgb(232, 189, 116)"]);

  await page.keyboard.press("Enter");
  await expect(save).toBeDisabled();
  await expect(save).toBeFocused();
  await expect(form.getByRole("status")).toContainText("Save pending");
  await page.keyboard.press("Enter");
  await expect(form.getByRole("status")).toContainText("Save pending");
  await expect(form.getByText("Saved", { exact: true })).toHaveCount(0);
  await page.keyboard.press("Tab");
  await expect(form.getByRole("button", { name: "Deliver save result" })).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(form.getByRole("status")).toContainText("Save failed");
  await expect(save).toBeFocused();

  await form.getByRole("radio", { name: "Commit" }).check();
  await save.click();
  await expect(form.getByRole("status")).toContainText("Save pending");
  await form.getByRole("button", { name: "Deliver save result" }).click();
  await expect(form.getByRole("status")).toContainText("Saved");
});

test("deliberately retries an unavailable sample read without dispatching an action", async ({ page }) => {
  const unexpected: string[] = [];
  page.on("request", (request) => {
    if (request.method() !== "GET") unexpected.push(request.method());
  });
  page.on("websocket", (socket) => unexpected.push(socket.url()));
  await page.goto("/");
  const read = page.getByRole("region", { name: "Sample retrieval" });
  await read.getByRole("button", { name: "Load data" }).click();
  await expect(read.getByText("Loading sample data", { exact: true })).toBeVisible();
  await expect(read.getByRole("status")).toContainText("Sample data unavailable");
  await expect(read.getByText("No data", { exact: true })).toHaveCount(0);
  const retry = read.getByRole("button", { name: "Retry read" });
  await retry.focus();
  await page.keyboard.press("Enter");
  await expect(read.getByText("No data", { exact: true })).toBeVisible();
  await expect(read.getByRole("button", { name: "Read again" })).toBeFocused();
  await expect(page.getByText("Saved", { exact: true })).toHaveCount(0);
  expect(unexpected).toEqual([]);
});

test("keeps local assets, visible focus and modeless access through the laptop and text checks", async ({ page }, testInfo) => {
  const external: string[] = [];
  const fonts: string[] = [];
  await page.route("**/*", async (route) => {
    const url = new URL(route.request().url());
    if (url.origin !== "http://127.0.0.1:3100") {
      external.push(url.origin);
      await route.abort();
      return;
    }
    if (route.request().resourceType() === "font") fonts.push(url.pathname);
    await route.continue();
  });

  await page.setViewportSize({ width: 1440, height: 960 });
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto("/");
  const nav = page.getByRole("navigation", { name: "Main navigation" });
  const form = page.getByRole("region", { name: "Sample submission" });
  const field = form.getByRole("textbox", { name: "Sample label" });
  const toggle = page.getByRole("button", { name: "Inspect sample media" });
  const slot = page.getByRole("button", { name: "Check reserved action slot" });
  const save = form.getByRole("button", { name: "Save sample" });
  const heading = page.getByRole("heading", { level: 1 });
  await expect(field).toBeVisible();
  const loadedLocalFont = await page.evaluate(async () => {
    await document.fonts.ready;
    return [...document.fonts].some((face) => face.family.includes("Instrument Sans") && face.status === "loaded" && face.weight === "400 700");
  });
  expect(loadedLocalFont).toBe(true);
  expect(fonts.length).toBeGreaterThan(0);
  expect(fonts.every((path) => path.endsWith(".woff2"))).toBe(true);
  const dashboard = nav.getByRole("link", { name: "Dashboard" });
  await expect(dashboard.locator("svg")).toBeVisible();
  expect((await field.boundingBox())?.height).toBe(44);
  expect((await save.boundingBox())?.height).toBe(44);
  expect((await slot.boundingBox())?.height).toBe(56);

  function contrast(foreground: string, background: string) {
    function luminance(color: string) {
      const channels = color.match(/\d+/g)!.map((value) => Number(value) / 255);
      const [r, g, b] = channels.map((value) => value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4);
      return r * 0.2126 + g * 0.7152 + b * 0.0722;
    }
    const values = [luminance(foreground), luminance(background)].sort((a, b) => b - a);
    return (values[0] + 0.05) / (values[1] + 0.05);
  }
  const ink = await heading.evaluate((node) => getComputedStyle(node).color);
  const canvas = await page.locator("html").evaluate((node) => getComputedStyle(node).backgroundColor);
  const surface = await form.evaluate((node) => getComputedStyle(node).backgroundColor);
  const controlBorder = await field.evaluate((node) => getComputedStyle(node).borderTopColor);
  const button = await save.evaluate((node) => {
    const style = getComputedStyle(node);
    return { ink: style.color, fill: style.backgroundColor, animation: style.animationName, transition: style.transitionDuration };
  });
  const muted = await form.getByText("Enter any label to try the sample submission.").evaluate((node) => getComputedStyle(node).color);
  const pairs = {
    "page text on canvas": contrast(ink, canvas),
    "description on panel": contrast(muted, surface),
    "primary label on fill": contrast(button.ink, button.fill),
    "field border on panel": contrast(controlBorder, surface),
  };
  expect(pairs["page text on canvas"]).toBeGreaterThanOrEqual(4.5);
  expect(pairs["description on panel"]).toBeGreaterThanOrEqual(4.5);
  expect(pairs["primary label on fill"]).toBeGreaterThanOrEqual(4.5);
  expect(pairs["field border on panel"]).toBeGreaterThanOrEqual(3);
  expect(button.animation).toBe("none");
  expect(button.transition).toBe("0s");

  await field.focus();
  await page.keyboard.press("Tab");
  await page.keyboard.press("Shift+Tab");
  await expect(field).toBeFocused();
  const ring = await field.evaluate((node) => getComputedStyle(node).outlineColor);
  const ringContrast = contrast(ring, surface);
  expect(ringContrast).toBeGreaterThanOrEqual(3);
  await testInfo.attach("runtime contrast", {
    body: JSON.stringify({ ...pairs, "focus ring on panel": ringContrast }, null, 2),
    contentType: "application/json",
  });
  async function capture(name: string) {
    const path = testInfo.outputPath(`${name}.png`);
    await page.screenshot({ path });
    await testInfo.attach(name, { path, contentType: "image/png" });
  }
  await capture("1440x960-controls");

  await page.setViewportSize({ width: 1366, height: 768 });
  await toggle.focus();
  await page.keyboard.press("Enter");
  await page.keyboard.press("Tab");
  await expect(slot).toBeFocused();
  await expect(slot).toBeInViewport();
  await page.keyboard.press("Enter");
  await expect(page.getByText("Sample action slot reached.")).toBeVisible();
  const media = page.getByRole("region", { name: "Sample media preview" });
  await expect(media.getByText("Sample image · Not live")).toBeVisible();
  const image = media.getByRole("img", { name: "Synthetic geometric swatch" });
  await expect.poll(() => image.evaluate((node: HTMLImageElement) => node.naturalWidth)).toBe(32);
  await capture("1366x768-media");
  await media.getByLabel("Sample media", { exact: true }).selectOption("sample-confirmed-evidence");
  await expect(media.getByText("Sample image · Captured evidence")).toBeVisible();
  await expect.poll(() => image.evaluate((node: HTMLImageElement) => node.naturalWidth)).toBe(32);

  await page.addStyleTag({ content: "html { font-size: 200%; }" });
  await expect(heading).toHaveCSS("font-size", "60px");
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(1366);
  await expect(dashboard).toBeVisible();
  await expect(nav.getByRole("link", { name: "Settings" })).toBeVisible();
  await page.getByRole("button", { name: "Hide sample media" }).focus();
  await page.keyboard.press("Tab");
  await expect(slot).toBeFocused();
  await expect(slot).toBeInViewport();
  await capture("1366x768-text-200-percent");
  await page.keyboard.press("Tab");
  await expect(media.getByLabel("Sample media", { exact: true })).toBeFocused();
  await page.keyboard.press("Shift+Tab");
  await expect(slot).toBeFocused();
  expect(external).toEqual([]);
});
