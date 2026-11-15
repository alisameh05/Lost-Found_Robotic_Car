import { crc32, deflateSync } from "node:zlib";
import { expect, test, type Page } from "@playwright/test";
import { sampleImage } from "../src/lib/fixtures/images";

test.use({ baseURL: "http://127.0.0.1:3100" });

function chunk(tag: string, body: Buffer) {
  const result = Buffer.alloc(body.length + 12);
  result.writeUInt32BE(body.length);
  result.write(tag, 4);
  body.copy(result, 8);
  result.writeUInt32BE(crc32(result.subarray(4, -4)), result.length - 4);
  return result;
}

function orientation(value: number) {
  const tiff = Buffer.from("49492a0008000000010012010300010000000000000000000000", "hex");
  tiff.writeUInt16LE(value, 18);
  return tiff;
}

function progressiveJpeg() {
  const dc = Buffer.alloc(18);
  dc[1] = 1;
  const ac = Buffer.from(dc);
  ac[0] = 16;
  return Buffer.concat([
    Buffer.from("ffd8ffdb004300", "hex"), Buffer.alloc(64, 1),
    Buffer.from("ffc2000b080001000101011100ffc40026", "hex"), dc, ac,
    Buffer.from("ffda00080101000000007fffda0008010100013f007fffd9", "hex"),
  ]);
}

function png({ width = 80, height = 40, depth = 8, color = 6, rotate = false, animated = false,
  short = false, pad = 0, dimensionsOnly = false, badPaletteIndex = false } = {}) {
  const header = Buffer.from("00000000000000000806000000", "hex");
  header.writeUInt32BE(width);
  header.writeUInt32BE(height, 4);
  header[8] = depth;
  header[9] = color;
  const row = Buffer.alloc(1 + (color === 6 ? width * 4 : Math.ceil(width * depth / 8)));
  if (badPaletteIndex) row[1] = 255;
  if (color === 6) {
    for (let x = 0; x < width / 2; x++) {
      row[1 + x * 4] = 200;
      row[4 + x * 4] = 255;
    }
  }
  const pixelData = dimensionsOnly ? Buffer.alloc(0) : Buffer.alloc(row.length * height);
  if (!dimensionsOnly) for (let y = 0; y < height; y++) row.copy(pixelData, y * row.length);
  const parts = [Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", header)];
  if (color === 3) parts.push(chunk("PLTE", Buffer.from([12, 24, 48])), chunk("tRNS", Buffer.from([0])));
  if (rotate) parts.push(chunk("eXIf", orientation(6)));
  if (animated) parts.push(chunk("acTL", Buffer.from([0, 0, 0, 2, 0, 0, 0, 0])));
  parts.push(chunk("IDAT", deflateSync(short ? pixelData.subarray(0, -1) : pixelData)));
  if (pad) {
    const text = Buffer.alloc(pad - parts.reduce((size, part) => size + part.length, 0) - 24, 65);
    text[1] = 0;
    parts.push(chunk("tEXt", text));
  }
  return Buffer.concat([...parts, chunk("IEND", Buffer.alloc(0))]);
}

const nameField = (page: Page) => page.getByRole("textbox", { name: "Object name" });
const field = (page: Page, name: string) => page.getByRole("textbox", { name: `${name} · px` });
const next = (page: Page) => page.getByRole("button", { name: "Next", exact: true });
const register = (page: Page) => page.getByRole("button", { name: "Register Object", exact: true });
const picker = (page: Page) => page.locator('input[type="file"]');
const details = (page: Page) => page.getByRole("heading", { name: "Object Details", exact: true });
const search = (page: Page) => page.getByRole("searchbox", { name: "Search objects" });

async function choose(page: Page, buffer = png(), name = "camera-card.png", mimeType = "image/png") {
  await picker(page).setInputFiles({ buffer, name, mimeType });
  await expect(page.getByRole("img", { name: "Normalized reference preview" })).toBeVisible();
}

async function setCoordinates(page: Page, values: [number, number, number | string, number]) {
  for (const [index, name] of ["X", "Y", "Width", "Height"].entries()) {
    await field(page, name).fill(String(values[index]));
  }
}

async function openRegistration(page: Page, scenario?: string) {
  if (scenario) {
    await page.goto("/");
    await page.getByLabel("Fixture scenario").selectOption(scenario);
    await expect(page.getByLabel("Fixture scenario")).toHaveValue(scenario);
    await page.getByRole("link", { name: "Objects / History", exact: true }).click();
  } else await page.goto("/objects");
  await page.getByRole("link", { name: "Register Object", exact: true }).click();
  await expect(page.getByRole("heading", { level: 1, name: "Register Object" })).toBeVisible();
}

test("registers a non-catalogue image through both steps and finds the same Lost record", async ({ page }, info) => {
  test.setTimeout(60_000);
  async function capture(name: string) {
    const path = info.outputPath(`${name}.png`);
    await page.screenshot({ path, fullPage: true });
    await info.attach(name, { path, contentType: "image/png" });
  }
  await page.setViewportSize({ width: 1440, height: 960 });
  await page.route("**/*", (route) => route.request().url().startsWith("http://127.0.0.1:3100/") ? route.continue() : route.abort());
  await openRegistration(page);
  await next(page).click();
  await expect(page.getByText("Enter a name with 1 to 120 characters.")).toBeVisible();
  await nameField(page).fill("\u0085🧭".concat("🧭".repeat(119), "\u00a0"));
  const transfer = await page.evaluateHandle((bytes) => {
    const data = new DataTransfer();
    data.items.add(new File([new Uint8Array(bytes)], "camera-card.png", { type: "application/octet-stream" }));
    return data;
  }, [...png()]);
  await page.getByText("Drag and drop a reference image here").dispatchEvent("drop", { dataTransfer: transfer });
  await expect(page.getByRole("img", { name: "Normalized reference preview" })).toBeVisible();
  await next(page).click();
  await expect(page.getByRole("heading", { name: "Select Target" })).toBeVisible();
  await page.getByRole("button", { name: "Back", exact: true }).click();
  await expect(nameField(page)).toHaveValue("🧭".repeat(120));
  await nameField(page).fill(" \u0085Cafe\u0301  camera card\u00a0 ");
  await nameField(page).blur();
  await capture("registration-information-1440");
  await page.setViewportSize({ width: 1366, height: 768 });
  const enlarged = await page.addStyleTag({ content: "html { font-size: 200%; }" });
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(1366);
  await capture("registration-information-1366-enlarged");
  await enlarged.evaluate((style) => style.parentNode?.removeChild(style));
  await page.setViewportSize({ width: 1440, height: 960 });
  await next(page).click();
  await expect(field(page, "X")).toBeFocused();
  const reference = page.getByRole("img", { name: "Normalized reference for target selection" });
  const box = (await reference.boundingBox())!;
  await page.mouse.move(box.x + box.width * .75, box.y + box.height * .75);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * .125, box.y + box.height * .25, { steps: 4 });
  await page.mouse.up();
  await expect(field(page, "X")).toHaveValue("10");
  await expect(field(page, "Y")).toHaveValue("10");
  await expect(field(page, "Width")).toHaveValue("50");
  await expect(field(page, "Height")).toHaveValue("20");
  const resize = (await page.locator('[data-handle="e"]').boundingBox())!;
  await page.mouse.move(resize.x + resize.width / 2, resize.y + resize.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * .875, resize.y + resize.height / 2, { steps: 3 });
  await page.mouse.up();
  await expect(field(page, "Width")).toHaveValue("60");
  await expect(page.getByRole("img", { name: "Selected region" })).toBeVisible();
  await page.getByRole("button", { name: "Back", exact: true }).click();
  await next(page).click();
  await expect(field(page, "Width")).toHaveValue("60");
  await page.getByRole("button", { name: "Reset Selection" }).click();
  await expect(register(page)).toBeDisabled();
  await setCoordinates(page, [10, 10, 70, 30]);
  await page.getByRole("button", { name: "Back", exact: true }).click();
  await choose(page, png({ width: 120, height: 80 }), "replacement.png");
  await next(page).click();
  await expect(field(page, "Width")).toHaveValue("");
  await setCoordinates(page, [15, 12, "50.5", 44]);
  await expect(register(page)).toBeDisabled();
  await expect(field(page, "Width")).toHaveAttribute("aria-invalid", "true");
  await field(page, "Width").fill("80");
  await field(page, "Width").blur();
  await capture("registration-target-1440");
  await page.setViewportSize({ width: 1366, height: 768 });
  await page.addStyleTag({ content: "html { font-size: 200%; }" });
  await expect(page.getByRole("heading", { name: "Selection coordinates" })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(1366);
  await register(page).focus();
  await expect(register(page)).toBeFocused();
  await capture("registration-target-1366-enlarged");
  await page.keyboard.press("Enter");
  await expect(details(page)).toBeVisible();
  const created = page.url();
  await expect(page.getByRole("heading", { name: /Café\s+camera card/ })).toBeVisible();
  await expect(page.getByText("Lost", { exact: true })).toBeVisible();
  await expect(page.getByRole("img", { name: /^Reference for Café/ })).toBeVisible();
  await page.getByRole("link", { name: "Back to Objects" }).click();
  await search(page).fill("CAFÉ  CAMERA");
  await page.getByRole("button", { name: "Lost", exact: true }).click();
  const link = page.getByRole("link", { name: /View details for Café/ });
  await expect(link).toHaveCount(1);
  await link.click();
  await expect(page).toHaveURL(created);
});

test("failed and uncertain saves preserve the original intent across navigation and recover one record", async ({ page }) => {
  await openRegistration(page, "registration-recovery");
  await nameField(page).fill("Recovery reference");
  await choose(page);
  await next(page).click();
  await setCoordinates(page, [0, 0, 80, 40]);
  await register(page).click();
  await expect(page.getByRole("main").getByRole("alert")).toContainText("Registration failed");
  await expect(field(page, "Width")).toHaveValue("80");
  await expect(register(page)).toBeEnabled();
  await register(page).click();
  await expect(page.getByText("Registration pending", { exact: true })).toBeVisible();
  await expect(field(page, "Width")).toBeDisabled();
  const sameRequest = page.getByRole("button", { name: "Retry Same Request" });
  await expect(sameRequest).toHaveAttribute("aria-disabled", "true");
  await page.getByRole("link", { name: "Objects / History", exact: true }).click();
  await search(page).fill("Recovery reference");
  await expect(page.getByRole("heading", { name: "No matching objects" })).toBeVisible();
  await page.getByRole("link", { name: "Register Object", exact: true }).click();
  await expect(page.getByText("Registration outcome unknown", { exact: true })).toBeVisible();
  await sameRequest.click();
  await expect(sameRequest).toBeEnabled();
  await sameRequest.click();
  await expect(details(page)).toBeVisible();
  await page.getByRole("link", { name: "Back to Objects" }).click();
  await search(page).fill("Recovery reference");
  await expect(page.getByRole("link", { name: "View details for Recovery reference" })).toHaveCount(1);
});

for (const scenario of ["searching", "paused"]) {
  test(`registers a separate Lost object during ${scenario} without changing the active or Found record`, async ({ page }) => {
    await openRegistration(page, scenario);
    const returnLink = page.getByRole("link", { name: "Return to Active Search" });
    const active = await returnLink.getAttribute("href");
    await expect(page.getByRole("button", { name: "Emergency Stop" })).toBeVisible();
    await nameField(page).fill("Headphones");
    if (scenario === "paused") await choose(page, progressiveJpeg(), "progressive.jpg", "image/jpeg");
    else await choose(page);
    await next(page).click();
    await setCoordinates(page, scenario === "paused" ? [0, 0, 1, 1] : [0, 0, 40, 20]);
    await register(page).click();
    await expect(details(page)).toBeVisible();
    await expect(page.getByText("Lost", { exact: true })).toBeVisible();
    await expect(returnLink).toHaveAttribute("href", active!);
    const reference = page.getByRole("img", { name: "Reference for Headphones", exact: true });
    await expect(reference).toBeVisible();
    expect(await reference.evaluate(async (img: HTMLImageElement) => (await fetch(img.src)).headers.get("Content-Type")))
      .toBe(scenario === "paused" ? "image/jpeg" : "image/png");
    await page.getByRole("link", { name: "Back to Objects" }).click();
    await search(page).fill("Headphones");
    await page.getByRole("button", { name: "Found", exact: true }).click();
    await page.getByRole("link", { name: "View details for Headphones" }).click();
    await expect(page).toHaveURL(/sample-headphones$/);
    await expect(page.getByText("Found", { exact: true })).toBeVisible();
  });
}

test("validates image contents and limits, normalizes rotation and alpha, and discards canceled drafts", async ({ page }) => {
  test.setTimeout(60_000);
  await openRegistration(page);
  await nameField(page).fill("Uncommitted image");
  const jpeg = Buffer.from(sampleImage("image/jpeg"));
  const scan = jpeg.indexOf(Buffer.from([0xff, 0xda]));
  const scanStart = scan + 2 + jpeg.readUInt16BE(scan + 2);
  const invalidImages = [
    [Buffer.from("pretend PNG"), "Choose a JPEG or PNG"],
    [png({ animated: true }), "Animated PNG"],
    [png({ depth: 16 }), "Only 8-bit PNG"],
    [png({ color: 4 }), "Use a grayscale, RGB, RGBA"],
    [png({ width: 5000, height: 4001, dimensionsOnly: true }), "exceeds 20 million pixels"],
    [png({ pad: 10_485_761 }), "exceeds 10 MiB"],
    [png({ short: true }), "corrupt or unreadable"],
    [png({ color: 3, badPaletteIndex: true }), "corrupt or unreadable"],
    [Buffer.from([0xff, 0xd8, 0xff, 0xd9]), "corrupt or unreadable"],
    [Buffer.concat([jpeg.subarray(0, scanStart + 1), Buffer.from([0xff, 0xd9])]), "corrupt or unreadable"],
    // A four-component frame reaches the CMYK variant check before any decoder allocation.
    [Buffer.from("ffd8ffc00014080001000104011100021100031100041100ffd9", "hex"), "CMYK JPEG"],
  ] as const;
  for (const [buffer, message] of invalidImages) {
    await picker(page).setInputFiles({ buffer, name: "claimed.png", mimeType: "image/png" });
    await expect(page.getByRole("main").getByRole("alert")).toContainText(message);
  }
  await choose(page, png({ width: 100_000, height: 1, color: 0 }));
  await expect(page.getByText(/100000 × 1 px/)).toBeVisible();
  await choose(page, png({ width: 5000, height: 4000, color: 0 }));
  await expect(page.getByText(/5000 × 4000 px/)).toBeVisible();
  await choose(page, png({ color: 3, depth: 1, pad: 10_485_760 }));
  await choose(page, png({ rotate: true }));
  const preview = page.getByRole("img", { name: "Normalized reference preview" });
  await expect(page.getByText(/40 × 80 px/)).toBeVisible();
  await expect.poll(() => preview.evaluate(async (node: HTMLImageElement) => {
    await node.decode();
    const canvas = new OffscreenCanvas(node.naturalWidth, node.naturalHeight);
    const context = canvas.getContext("2d")!;
    context.drawImage(node, 0, 0);
    return [[...context.getImageData(0, 0, 1, 1).data], [...context.getImageData(0, 79, 1, 1).data]];
  })).toEqual([[200, 0, 0, 255], [255, 255, 255, 255]]);
  const exif = Buffer.concat([Buffer.from([0xff, 0xe1, 0, 34]), Buffer.from("Exif\0\0"), orientation(6)]);
  await choose(page, Buffer.concat([jpeg.subarray(0, 2), exif, jpeg.subarray(2)]), "rotated.jpg", "image/jpeg");
  await expect(page.getByText(/24 × 32 px/)).toBeVisible();
  await page.getByRole("button", { name: "Remove Image" }).click();
  await expect(preview).toHaveCount(0);
  await page.getByRole("link", { name: "Cancel" }).click();
  await page.getByRole("link", { name: "Register Object", exact: true }).click();
  await expect(nameField(page)).toHaveValue("");
  await expect(preview).toHaveCount(0);
});
