import { expect, test, type Page } from "@playwright/test";
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const frontend = "http://127.0.0.1:3103";
const backend = "http://127.0.0.1:8110/api/v1";
const repo = resolve("..");
const localPython = join(repo, ".local-runtime", "records", "Scripts", "python.exe");
const python = process.env.LAF_TEST_PYTHON ?? (existsSync(localPython) ? localPython : "python");
let parent: string;
let backendProcess: ChildProcess | undefined;

test.use({ baseURL: frontend });

async function startBackend(options: {
  initializationGate?: string; crashAfterCommit?: boolean; registrationGate?: string; clockOffset?: string;
} = {}) {
  const entry = options.initializationGate ? ["backend.tests.pause_startup", options.initializationGate]
    : options.crashAfterCommit ? ["backend.tests.crash_registration", "committed"]
    : options.registrationGate ? ["backend.tests.crash_registration", "journaled", options.registrationGate]
    : options.clockOffset ? ["backend.tests.crash_registration", "clock", options.clockOffset]
    : ["backend.app"];
  const child = spawn(python, ["-m", ...entry], {
    cwd: repo, windowsHide: true, env: {
      ...process.env, LOCALAPPDATA: parent, LAF_DATA_ROOT: join(parent, "records"),
      LAF_BACKEND_PORT: "8110", LAF_FRONTEND_PORT: "3103",
    },
  });
  backendProcess = child;
  let message = "";
  child.stderr?.on("data", (chunk) => { message += String(chunk); });
  child.on("error", (error) => { message += error.message; });
  await expect.poll(async () => {
    if (child.exitCode !== null || message.includes("ENOENT")) throw new Error(message);
    try {
      const response = await fetch(`${backend}/bootstrap`, {
        headers: { Origin: frontend }, signal: AbortSignal.timeout(850),
      });
      return response.status;
    } catch {
      return 0;
    }
  }, { timeout: 15_000, message: "Records backend did not start" }).toBe(200);
}

async function stopBackend() {
  const child = backendProcess;
  backendProcess = undefined;
  if (!child?.pid || child.exitCode !== null || child.signalCode !== null) return;
  await new Promise<void>((done) => {
    child.once("exit", () => done());
    child.kill();
  });
}

async function selectTarget(page: Page, source: string, name: string) {
  await page.goto("/objects/new");
  await page.getByRole("textbox", { name: "Object name" }).fill(name);
  await page.locator('input[type="file"]').setInputFiles(source);
  await expect(page.getByRole("img", { name: "Normalized reference preview" })).toBeVisible();
  await page.getByRole("button", { name: "Next", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Select Target" })).toBeVisible();
}

function sourceImage(name = "operator-photo.png") {
  const source = join(parent, name);
  execFileSync(python, [
    "-c", "import sys; from PIL import Image; im = Image.new('RGBA', (80, 40), (40, 120, 160, 128)); " +
      "exif = im.getexif(); exif[274] = 6; im.save(sys.argv[1], exif=exif)", source,
  ], { windowsHide: true });
  return source;
}

async function setTargetCoordinates(page: Page) {
  for (const [label, value] of [["X", "10"], ["Y", "20"], ["Width", "30"], ["Height", "60"]]) {
    await page.getByRole("textbox", { name: label + " · px", exact: true }).fill(value);
  }
}

function observe(page: Page) {
  const requests: string[] = [];
  const sockets: string[] = [];
  page.on("request", (request) => {
    if (request.url().startsWith(`${backend}/`)) {
      requests.push(`${request.method()} ${new URL(request.url()).pathname}`);
    }
  });
  page.on("websocket", (socket) => sockets.push(socket.url()));
  return { requests, sockets };
}

async function waitForStorage() {
  const bootstrap = await fetch(`${backend}/bootstrap`, { headers: { Origin: frontend } });
  const { capability } = await bootstrap.json();
  await expect.poll(async () =>
    (await fetch(`${backend}/health`, { headers: { "X-App-Capability": capability } })).status).toBe(200);
}

async function seedLibrary(items: readonly (readonly [string, string, "Lost" | "Found", number])[], referenceIds: string[] = []) {
  await waitForStorage();
  execFileSync(python, [
    "-c", [
      "from io import BytesIO", "import json, sys", "from pathlib import Path", "from PIL import Image",
      "from backend.tests.test_object_library import seed_objects",
      "image = BytesIO()", "Image.new('RGB', (1, 1), (10, 20, 30)).save(image, format='PNG')",
      "seed_objects(Path(sys.argv[1]), json.loads(sys.argv[2]), dict.fromkeys(json.loads(sys.argv[3]), image.getvalue()))",
    ].join("\n"),
    join(parent, "records"), JSON.stringify(items), JSON.stringify(referenceIds),
  ], { cwd: repo, windowsHide: true });
}

async function loopbackOnly(page: Page) {
  await page.context().route("**/*", async (route) => {
    const url = new URL(route.request().url());
    if (url.origin === frontend || url.origin === new URL(backend).origin) await route.continue();
    else await route.abort();
  });
}

function objectRows(page: Page) {
  return page.getByRole("list", { name: "Object records" }).getByRole("listitem");
}

test.beforeEach(() => { parent = mkdtempSync(join(tmpdir(), "laf-records-browser-")); });
test.afterEach(async () => {
  await stopBackend();
  await rm(parent, { recursive: true, force: true, maxRetries: 3 });
});

test("opens connected empty records and read-only settings with one page identity", async ({ page }) => {
  await startBackend();
  const { requests, sockets } = observe(page);
  await page.goto("/");
  await expect(page.getByText("Records connected · Search unavailable")).toBeVisible();
  await expect(page.getByText("No sessions for recent objects", { exact: true })).toBeVisible();
  await expect(page.getByText(/Fixture mode|Fixture scenario|Sample device observations/)).toHaveCount(0);
  await page.getByRole("link", { name: "Objects / History" }).click();
  await expect(page.getByRole("heading", { name: "No objects registered" })).toBeVisible();
  await page.getByRole("link", { name: "Settings" }).click();
  await expect(page.getByRole("region", { name: "Saved retention" }).getByText("7 days", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Preview Change" })).toHaveCount(0);
  await page.getByRole("link", { name: "Devices", exact: true }).click();
  await expect(page.getByText("Gestures requirements unavailable")).toBeVisible();
  const profile = page.locator("summary").filter({ hasText: "Qualification profile" });
  await expect(profile).toContainText("Unavailable");
  const health = page.waitForResponse((response) => response.url() === `${backend}/health` && response.status() === 200);
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await health;
  await page.getByRole("button", { name: "Refresh readiness" }).click();
  await expect(page.getByText("Gestures requirements unavailable")).toBeVisible();
  expect(requests.filter((value) => value === "GET /api/v1/bootstrap")).toHaveLength(1);
  expect(requests.every((value) => /^(GET|OPTIONS) \/api\/v1\/(bootstrap|snapshot|health|objects|settings)$/.test(value))).toBe(true);
  expect(sockets).toEqual([]);
});

test("keeps Start, Resume and acquisition unavailable on direct routes", async ({ page }) => {
  await startBackend();
  const { requests, sockets } = observe(page);
  await page.goto("/objects/example/search");
  await expect(page.getByRole("heading", { name: "Search Setup" })).toBeVisible();
  await expect(page.getByText("The application is disarmed.")).toBeVisible();
  await expect(page.getByRole("link", { name: "Check device and qualification status" })).toHaveAttribute("href", "/devices");
  await expect(page.getByRole("button", { name: /Start Search|Acquire Control/ })).toHaveCount(0);
  await page.goto("/sessions/example/live");
  await expect(page.getByRole("heading", { name: "Live Search Workspace" })).toBeVisible();
  await expect(page.getByRole("button", { name: /Resume|Acquire Control|Emergency Stop/ })).toHaveCount(0);
  await expect(page.getByText("Records connected · Search unavailable")).toBeVisible();
  expect(requests.every((value) => /^(GET|OPTIONS) \/api\/v1\/(bootstrap|snapshot|health)$/.test(value))).toBe(true);
  expect(sockets).toEqual([]);
});

test("preserves a 503 Health diagnostic during initialization", async ({ page }) => {
  const gate = join(parent, "allow-initialization");
  await startBackend({ initializationGate: gate });
  await page.goto("/devices");
  await expect(page.getByText("Initializing services", { exact: true })).toBeVisible();
  await expect(page.locator("summary").filter({ hasText: "Managed storage" })).toContainText("Initializing");
  await page.getByRole("link", { name: "Objects / History" }).click();
  await expect(page.getByText("Objects unavailable", { exact: true })).toBeVisible();
  await expect(page.getByText("No objects registered")).toHaveCount(0);
  writeFileSync(gate, "");
  await expect(page.getByText("No objects registered")).toBeVisible({ timeout: 10_000 });
});

test("shows degraded storage without presenting an empty object history", async ({ page }) => {
  const root = join(parent, "records");
  execFileSync(python, [
    "-c", "import pathlib, sqlite3, sys; p = pathlib.Path(sys.argv[1]); p.mkdir(); " +
      "sqlite3.connect(p / 'records.sqlite3').execute('PRAGMA user_version = 99').close()",
    root,
  ], { windowsHide: true });
  await startBackend();
  await page.goto("/devices");
  await expect(page.getByText("Device readiness degraded", { exact: true })).toBeVisible();
  await expect(page.getByText(/saved database schema is incompatible/)).toBeVisible();
  await page.getByRole("link", { name: "Objects / History" }).click();
  await expect(page.getByText("Objects unavailable", { exact: true })).toBeVisible();
  await expect(page.getByText("No objects registered")).toHaveCount(0);
});

test("recovers protected records after the backend dies and starts on the same port", async ({ page }) => {
  await startBackend();
  const { requests } = observe(page);
  const firstHealth = page.waitForResponse((response) => response.url() === `${backend}/health` && response.status() === 200);
  await page.goto("/settings");
  const firstBoot = (await (await firstHealth).json()).backend_boot_id;
  await expect(page.getByText("7 days", { exact: true })).toBeVisible();
  await stopBackend();
  await expect(page.getByText("Settings unavailable", { exact: true })).toBeVisible({ timeout: 12_000 });
  await startBackend();
  const replacementHealth = await page.waitForResponse((response) => response.url() === `${backend}/health` && response.status() === 200);
  expect((await replacementHealth.json()).backend_boot_id).not.toBe(firstBoot);
  await expect(page.getByText("7 days", { exact: true })).toBeVisible();
  expect(requests.filter((value) => value === "GET /api/v1/bootstrap")).toHaveLength(2);
});

test("finds and pages real registrations, opens protected references and uses Dashboard details offline", async ({ page }) => {
  test.setTimeout(60_000);
  await startBackend();
  await loopbackOnly(page);
  const registered = Date.now() - 1_000;
  const items = Array.from({ length: 26 }, (_, index) =>
    [`row-${String(index).padStart(2, "0")}`, `Spare item ${index}`, "Lost", registered - 10] as const);
  await seedLibrary([
    ...items,
    ["a", "Straße%_  Café Ᲊ", "Found", registered],
    ["Z", "Straße%_  Café Ᲊ", "Lost", registered],
    ["unicode", "a\u{1e4ec}\u0301", "Lost", registered - 5],
  ], ["a"]);

  const { requests } = observe(page);
  await page.goto("/");
  const recent = page.getByRole("list", { name: "Recent registrations" });
  await expect(recent.getByRole("listitem")).toHaveCount(3);
  await expect(recent.getByRole("link").first()).toHaveAttribute("href", "/objects/a");
  await expect(page.getByText("No sessions for recent objects", { exact: true })).toBeVisible();
  await expect(page.getByText("Search unavailable", { exact: true })).toBeVisible();
  await recent.getByRole("link").first().click();
  await expect(page.getByRole("region", { name: "Object record" }).getByRole("heading")).toHaveText("Straße%_  Café Ᲊ");
  await page.getByRole("link", { name: "Back to Objects" }).click();
  await expect(objectRows(page)).toHaveCount(25);
  await expect(objectRows(page).first().getByRole("link")).toHaveAttribute("href", "/objects/a");
  await expect(objectRows(page).nth(1).getByRole("link")).toHaveAttribute("href", "/objects/Z");
  await page.getByRole("button", { name: "Next", exact: true }).click();
  await expect(objectRows(page)).toHaveCount(4);
  await expect(objectRows(page).last().getByRole("link")).toHaveAttribute("href", "/objects/row-00");
  const focusHealth = page.waitForResponse((response) => response.url() === `${backend}/health` && response.ok());
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await focusHealth;
  await expect(page.getByText(/Page 2 · 4 objects/)).toBeVisible();
  await page.getByRole("button", { name: "Previous", exact: true }).click();
  await expect(objectRows(page)).toHaveCount(25);

  const field = page.getByRole("searchbox", { name: "Search objects" });
  await field.fill("\u0085STRASSE%_  CAFE\u0301 ᲊ\u2003");
  await expect(objectRows(page)).toHaveCount(2);
  await page.getByRole("button", { name: "Lost", exact: true }).click();
  await expect(objectRows(page)).toHaveCount(1);
  await expect(objectRows(page).first().getByRole("link")).toHaveAttribute("href", "/objects/Z");
  await expect(page.getByText("Media missing", { exact: true }).first()).toBeVisible();
  const bytesResponse = page.waitForResponse((response) => response.url() === `${backend}/media/a-reference` && response.ok());
  await page.getByRole("button", { name: "Found", exact: true }).click();
  const received = await bytesResponse;
  expect(received.headers()).toMatchObject({
    "cache-control": "no-store", "content-type": "image/png", "x-content-type-options": "nosniff", "accept-ranges": "none",
  });
  await expect(objectRows(page)).toHaveCount(1);
  const image = objectRows(page).first().getByRole("img");
  await expect(image).toHaveAttribute("src", /^blob:/);
  const objectUrl = await image.getAttribute("src");
  await page.getByRole("button", { name: "All", exact: true }).click();
  await field.fill("a\u{1e4ec}\u0301");
  await expect(objectRows(page).first().getByRole("link")).toHaveAttribute("href", "/objects/unicode");
  expect(await page.evaluate(async (url) => {
    try { await fetch(url!); return true; } catch { return false; }
  }, objectUrl)).toBe(false);
  await field.fill("🧭".repeat(121));
  await expect(page.getByText(/Enter no more than 120 characters/)).toBeVisible();
  expect(requests.filter((request) => request === "GET /api/v1/bootstrap")).toHaveLength(1);
  expect(requests).toContain("GET /api/v1/objects/a/sessions");
  expect(requests.some((request) => /\/control-lease|^POST .*\/sessions/.test(request))).toBe(false);
});

function seedStoredHistory(now: number, interrupted = false) {
  execFileSync(python, [
    "-c", [
      "import sys", "from pathlib import Path",
      "from backend.tests.test_session_history import seed_history, seed_interrupted",
      "root, now = Path(sys.argv[1]), int(sys.argv[2])",
      "seed_history(root, now)",
      "if sys.argv[3] == 'true': seed_interrupted(root, now)",
    ].join("\n"),
    join(parent, "records"), String(now), String(interrupted),
  ], { cwd: repo, windowsHide: true });
}

test("composes saved history offline and inspects the exact captured PNG with the keyboard", async ({ page }) => {
  test.setTimeout(60_000);
  await startBackend();
  await waitForStorage();
  const now = Date.now() - 1_000;
  seedStoredHistory(now);
  await loopbackOnly(page);
  const { requests, sockets } = observe(page);
  await page.goto("/");
  const sessions = page.getByRole("list", { name: "Recent session records" });
  await expect(sessions.getByRole("link").first()).toHaveAttribute("href", "/sessions/session-other");
  await sessions.getByRole("link").filter({ hasText: "Ended · Found" }).click();
  await expect(page.getByRole("heading", { name: "Session Details" })).toBeVisible();
  const record = page.getByRole("region", { name: "Session record" });
  await expect(record).toContainText("Gestures");
  await expect(record).toContainText("Match confirmed");
  await expect(record.locator("time").last()).toHaveAttribute("datetime", new Date(now - 29_000).toISOString());
  const matches = page.getByRole("region", { name: "Captured matches" });
  const captured = matches.getByRole("img", { name: "Captured evidence", exact: true });
  await expect(captured).toHaveAttribute("src", /^blob:/);
  expect(await captured.evaluate(async (element: HTMLImageElement) => {
    await element.decode();
    const canvas = document.createElement("canvas");
    canvas.width = element.naturalWidth;
    canvas.height = element.naturalHeight;
    const context = canvas.getContext("2d")!;
    context.drawImage(element, 0, 0);
    return { size: [canvas.width, canvas.height], corner: Array.from(context.getImageData(79, 39, 1, 1).data) };
  })).toEqual({ size: [80, 40], corner: [251, 37, 59, 255] });
  const box = matches.locator("img + span");
  await expect(box).toHaveCSS("position", "absolute");
  expect(await box.evaluate(({ style }: HTMLElement) =>
    [style.left, style.top, style.width, style.height])).toEqual(["12.5%", "20%", "37.5%", "40%"]);
  const inspect = matches.getByRole("button", { name: "Inspect evidence" });
  await inspect.focus();
  await page.keyboard.press("Enter");
  await expect(matches.getByRole("region", { name: "Enlarged captured evidence" })).toBeFocused();
  await expect(matches.getByRole("button", { name: "Close inspection" })).toHaveAttribute("aria-expanded", "true");
  const oldUrl = await captured.getAttribute("src");

  const diskCapture = join(parent, "records", "media", "evidence-match-confirmed.png");
  unlinkSync(diskCapture);
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await expect(matches.getByText("Media missing", { exact: true })).toBeVisible();
  await expect(captured).toHaveCount(0);
  expect(await page.evaluate(async (url) => {
    try { await fetch(url!); return true; } catch { return false; }
  }, oldUrl)).toBe(false);
  writeFileSync(diskCapture, "damaged test capture");
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await expect(matches.getByText("Media corrupt", { exact: true })).toBeVisible();
  await expect(record).toContainText("Match confirmed");

  await page.getByRole("link", { name: "View Object", exact: true }).click();
  await expect(page.getByRole("region", { name: "Object record" })).toContainText("History test · Wallet");
  await expect(page.getByRole("region", { name: "Confirmed evidence" }).getByText("Media corrupt")).toBeVisible();
  const history = page.getByRole("region", { name: "Search sessions" });
  await expect(history.getByRole("link")).toHaveCount(3);
  await expect(history.getByRole("link").nth(1)).toHaveAttribute("href", "/sessions/session-a");
  await history.getByRole("link").nth(1).click();
  await expect(matches.getByText("Rejected", { exact: true })).toBeVisible();
  await expect(matches.getByText("Not reviewed", { exact: true })).toBeVisible();
  await expect(matches.getByText("Reviewed", { exact: true })).toHaveCount(1);
  await page.getByRole("link", { name: "View Search Result" }).click();
  await expect(page.getByRole("heading", { name: "Search ended without confirmation" })).toBeVisible();
  await expect(page.getByText("This session ended before the object's later confirmation.")).toBeVisible();
  await expect(page.getByRole("button", { name: /Resume|Confirm Match|Reject Match/ })).toHaveCount(0);
  expect(requests.filter((request) => request.startsWith("POST"))).toEqual([]);
  expect(sockets).toEqual([]);
});

test("recovers interrupted history after a process restart and revokes the capture on expiry", async ({ page }) => {
  test.setTimeout(60_000);
  const offset = join(parent, "clock-offset");
  writeFileSync(offset, "0");
  await startBackend();
  await waitForStorage();
  await stopBackend();
  seedStoredHistory(Date.now() - 1_000, true);
  await startBackend({ clockOffset: offset });
  await loopbackOnly(page);
  await page.goto("/sessions/session-interrupted");
  const record = page.getByRole("region", { name: "Session record" });
  await expect(record).toContainText("Interrupted");
  const matches = page.getByRole("region", { name: "Captured matches" });
  await expect(matches.getByText("Not reviewed", { exact: true })).toBeVisible();
  await expect(matches.getByText("Reviewed", { exact: true })).toHaveCount(0);
  const image = matches.getByRole("img", { name: "Captured evidence", exact: true });
  await expect(image).toHaveAttribute("src", /^blob:/);
  const objectUrl = await image.getAttribute("src");
  expect(existsSync(join(parent, "records", "staging", "a".repeat(32) + ".part"))).toBe(false);
  expect(existsSync(join(parent, "records", "media", "a".repeat(32) + ".png"))).toBe(false);
  const expiry = page.waitForResponse((response) =>
    response.url() === `${backend}/sessions/session-interrupted` && response.status() === 410);
  writeFileSync(offset, String(7 * 86_400_000));
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  expect(await (await expiry).json()).toMatchObject({ code: "EXPIRED" });
  await expect(page.getByText("Session expired", { exact: true })).toBeVisible();
  await expect(image).toHaveCount(0);
  expect(await page.evaluate(async (url) => {
    try { await fetch(url!); return true; } catch { return false; }
  }, objectUrl)).toBe(false);
});

test("discards overtaken search reads, resets an expired cursor and restarts with a new authority", async ({ page }) => {
  test.setTimeout(60_000);
  await startBackend();
  await loopbackOnly(page);
  const registered = Date.now() - 1_000;
  const common = "abcdefghijklmnopqrstuvwxyz1234567890";
  await seedLibrary(Array.from({ length: 26 }, (_, index) => [
    `row-${String(index).padStart(2, "0")}`, `${common} ${index === 25 ? "second" : "first"}`, "Lost", registered,
  ]));
  const { requests } = observe(page);
  const initialPage = page.waitForRequest((request) => request.url() === `${backend}/objects` && request.method() === "GET");
  await page.goto("/objects");
  const { "x-app-capability": capability, "x-app-client-id": client } = await (await initialPage).allHeaders();
  const delayed = Promise.withResolvers<void>();
  const received = Promise.withResolvers<void>();
  await page.route(`${backend}/objects?name=first`, async (route) => {
    const realResponse = await route.fetch();
    received.resolve();
    await delayed.promise;
    await route.fulfill({ response: realResponse }).catch(() => {});
  });
  const field = page.getByRole("searchbox", { name: "Search objects" });
  await field.fill("first");
  await received.promise;
  await field.fill("second");
  await expect(objectRows(page)).toHaveCount(1);
  await expect(objectRows(page).first()).toContainText("second");
  delayed.resolve();
  await page.unrouteAll({ behavior: "wait" });
  await expect(objectRows(page)).toHaveCount(1);
  await expect(objectRows(page).first()).toContainText("second");

  await field.fill("");
  await expect(objectRows(page)).toHaveCount(25);
  const nextPage = page.waitForRequest((request) => request.url().includes("/objects?cursor=") && request.method() === "GET");
  await page.getByRole("button", { name: "Next", exact: true }).click();
  const oldCursorRequest = (await nextPage).url();
  await expect(page.getByText(/Page 2 · 1 object/)).toBeVisible();
  const headers = { "X-App-Capability": capability, "X-App-Client-Id": client };
  for (let i = 0; i < 32; i++) {
    const result = await page.request.get(`${backend}/objects`, { headers, params: { limit: 1, name: common.slice(i, i + 4) } });
    expect(result.ok()).toBe(true);
    expect((await result.json()).next_cursor).toBeTruthy();
  }
  expect((await (await page.request.get(oldCursorRequest, { headers })).json()).code).toBe("CURSOR_EXPIRED");
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await expect(page.getByText("Page access expired. Returned to page 1.")).toBeVisible();
  await expect(objectRows(page)).toHaveCount(25);
  await page.getByRole("button", { name: "Next", exact: true }).click();
  await expect(page.getByText(/Page 2 · 1 object/)).toBeVisible();
  await stopBackend();
  await expect(page.getByText("Objects unavailable", { exact: true })).toBeVisible({ timeout: 12_000 });
  await startBackend();
  await expect(page.getByText(/Page 1 · 25 objects/)).toBeVisible({ timeout: 12_000 });
  expect(requests.filter((request) => request === "GET /api/v1/bootstrap")).toHaveLength(2);
});

test("revokes an expired reference and keeps browsing the eligible page against the real service", async ({ page }) => {
  test.setTimeout(60_000);
  const offset = join(parent, "catalogue-clock");
  writeFileSync(offset, "0");
  await startBackend({ clockOffset: offset });
  await loopbackOnly(page);
  const registered = Date.now() - 1_000;
  const old = registered - 7 * 86_400_000 + 120_000;
  await seedLibrary([
    ...Array.from({ length: 25 }, (_, index): [string, string, "Lost", number] =>
      [`row-${index}`, `Saved item ${index}`, "Lost", registered]),
    ["old", "Due reference", "Lost", old],
  ], ["old"]);
  await page.goto("/objects");
  await expect(objectRows(page)).toHaveCount(25);
  await page.getByRole("button", { name: "Next", exact: true }).click();
  const reference = objectRows(page).getByRole("img", { name: "Reference for Due reference" });
  await expect(reference).toBeVisible();
  const localUrl = await reference.getAttribute("src");
  writeFileSync(offset, "180000");
  // Re-read this page with its original cursor after the owner's cutoff.
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await expect(page.getByText("No records on this page", { exact: true })).toBeVisible();
  await expect(page.getByText("Due reference", { exact: true })).toHaveCount(0);
  expect(await page.evaluate(async (url) => {
    try { await fetch(url!); return true; } catch { return false; }
  }, localUrl)).toBe(false);
  await page.getByRole("button", { name: "Previous", exact: true }).click();
  await expect(objectRows(page)).toHaveCount(25);
  await expect(page.getByText("Local records storage unavailable", { exact: true })).toBeVisible();
  await page.goto("/objects/old");
  await expect(page.getByText("Record expired", { exact: true })).toBeVisible();
});

test("registers an oriented reference and reopens its target after actual process restart", async ({ page }) => {
  await startBackend();
  const source = sourceImage();
  const original = readFileSync(source);
  await selectTarget(page, source, " \u2003Cafe\u0301 card ");
  await setTargetCoordinates(page);
  await expect(page.getByText("Valid rectangle · 30 × 60 px")).toBeVisible();
  await page.getByRole("button", { name: "Back", exact: true }).click();
  await expect(page.getByRole("textbox", { name: "Object name" })).toHaveValue("Café card");
  await page.getByRole("button", { name: "Next", exact: true }).click();
  await expect(page.getByRole("textbox", { name: "Height · px", exact: true })).toHaveValue("60");
  await page.getByRole("button", { name: "Back", exact: true }).click();
  await page.locator('input[type="file"]').setInputFiles(sourceImage("replacement.png"));
  await expect(page.getByText("replacement.png", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Next", exact: true }).click();
  await expect(page.getByRole("button", { name: "Register Object", exact: true })).toBeDisabled();
  await setTargetCoordinates(page);
  await page.getByRole("button", { name: "Register Object", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Object Details", exact: true })).toBeVisible();
  const reference = page.getByRole("img", { name: "Reference for Café card", exact: true });
  await expect(reference).toBeVisible();
  const location = page.url();
  expect(readFileSync(source)).toEqual(original);
  await rm(source);
  await rm(join(parent, "replacement.png"));
  await stopBackend();
  await startBackend();
  const mediaResponse = page.waitForResponse((response) =>
    response.url().startsWith(backend + "/media/") && response.status() === 200);
  await page.goto(location);
  await expect(reference).toBeVisible();
  await expect(page.getByText("Lost", { exact: true })).toBeVisible();
  expect(await reference.evaluate((image: HTMLImageElement) => [image.naturalWidth, image.naturalHeight]))
    .toEqual([40, 80]);
  const bytes = await mediaResponse;
  expect(bytes.headers()["cache-control"]).toBe("no-store");
  expect(bytes.headers()["accept-ranges"]).toBe("none");
});

test("recovers a lost committed response with the same request after restart", async ({ page }) => {
  await startBackend({ crashAfterCommit: true });
  const submissionTimes: string[] = [];
  page.on("request", (request) => {
    if (request.method() !== "POST" || request.url() !== backend + "/objects") return;
    submissionTimes.push(request.headers()["x-action-created-at-ms"]);
  });
  await selectTarget(page, sourceImage(), "Restart recovery card");
  await setTargetCoordinates(page);
  await page.getByRole("button", { name: "Register Object", exact: true }).click();
  await expect(page.getByText("Registration outcome unknown")).toBeVisible();
  await expect(page).toHaveURL(/\/objects\/new$/);
  const reopenedHealth = page.waitForResponse((reply) => reply.url() === backend + "/health" && reply.status() === 200);
  await stopBackend();
  const committedReceipt = execFileSync(python, [
    "-c", "import sqlite3,sys; db = sqlite3.connect(sys.argv[1]); " +
      "print(db.execute('SELECT response_body FROM action_receipts').fetchone()[0])",
    join(parent, "records", "records.sqlite3"),
  ], { windowsHide: true });
  await startBackend();
  await reopenedHealth;
  await expect(page.getByText("Records connected · Search unavailable")).toBeVisible();
  const response = page.waitForResponse((reply) => reply.url() === backend + "/objects" && reply.request().method() === "POST");
  await page.getByRole("button", { name: "Retry Same Request" }).click();
  await expect(page.getByRole("heading", { name: "Object Details" })).toBeVisible();
  await expect(page.getByRole("img", { name: "Reference for Restart recovery card", exact: true })).toBeVisible();
  const replay = await response;
  expect(replay.status()).toBe(201);
  expect(await replay.json()).toEqual(JSON.parse(committedReceipt.toString()));
  expect(submissionTimes).toHaveLength(2);
  expect(submissionTimes[0]).toMatch(/^[0-9]+$/);
  expect(submissionTimes[1]).toBe(submissionTimes[0]);
  await page.getByRole("link", { name: "Back to Objects" }).click();
  await expect(page.getByRole("link", { name: "View details for Restart recovery card" })).toHaveCount(1);
});

test("keeps the user in the editor while a real registration is pending", async ({ page }) => {
  const gate = join(parent, "finish-registration");
  await startBackend({ registrationGate: gate });
  await selectTarget(page, sourceImage(), "Pending card");
  await setTargetCoordinates(page);
  await page.getByRole("button", { name: "Register Object", exact: true }).click();
  await expect(page.getByText("Registration pending", { exact: true })).toBeVisible();
  await expect(page.getByRole("textbox", { name: "Width · px" })).toBeDisabled();
  await expect(page).toHaveURL(/\/objects\/new$/);
  writeFileSync(gate, "");
  await expect(page.getByRole("heading", { name: "Object Details", exact: true })).toBeVisible();
  await expect(page.getByRole("img", { name: "Reference for Pending card", exact: true })).toBeVisible();
});

test("opens a known expired object directly without retrieving its image", async ({ page }) => {
  await startBackend();
  await page.goto("/objects");
  await expect(page.getByText("Records connected · Search unavailable")).toBeVisible();
  await stopBackend();
  const database = join(parent, "records", "records.sqlite3");
  execFileSync(python, [
    "-c", "import sqlite3, sys; db = sqlite3.connect(sys.argv[1]); " +
      "db.execute('PRAGMA foreign_keys = ON'); db.execute(\"INSERT INTO objects " +
      "(id,name,status,registered_at_ms,roi_x,roi_y,roi_width,roi_height,revision,reference_media_id," +
      "reference_width,reference_height) VALUES ('old','Expired reference','Lost',1,0,0,1,1,1,'old-media',1,1)\"); " +
      "db.execute(\"INSERT INTO media VALUES ('old-media','old',NULL,'Reference','media/old-media.png'," +
      "'image/png',1,1,1,?,1,'Ready')\", ('a'*64,)); db.commit(); db.close()", database,
  ], { windowsHide: true });
  await startBackend();
  const { requests } = observe(page);
  await page.goto("/objects/old");
  await expect(page.getByText("Record expired", { exact: true })).toBeVisible();
  await expect(page.getByText("Expired reference", { exact: true })).toHaveCount(0);
  expect(requests.some((request) => request.includes("/media/"))).toBe(false);
});

test("starts a new submission from the backend clock after an expired action", async ({ page }) => {
  const offset = join(parent, "clock-offset");
  writeFileSync(offset, "0");
  await startBackend({ clockOffset: offset });
  await selectTarget(page, sourceImage(), "Clock recovery card");
  await setTargetCoordinates(page);
  await expect(page.getByText("Records connected · Search unavailable")).toBeVisible();
  writeFileSync(offset, "700000");
  const submit = page.getByRole("button", { name: "Register Object", exact: true });
  const expired = page.waitForResponse((reply) => reply.url() === backend + "/objects" && reply.request().method() === "POST");
  await submit.click();
  expect((await expired).status()).toBe(410);
  await expect(page.getByText("Registration expired", { exact: true })).toBeVisible();
  await expect(page.getByRole("textbox", { name: "Width · px" })).toHaveValue("30");
  await submit.click();
  await expect(page.getByRole("heading", { name: "Object Details", exact: true })).toBeVisible();
});
