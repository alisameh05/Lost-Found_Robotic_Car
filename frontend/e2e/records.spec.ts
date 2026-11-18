import { expect, test, type Page } from "@playwright/test";
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
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

async function startBackend(initializationGate?: string) {
  const entry = initializationGate ? ["backend.tests.pause_startup", initializationGate] : ["backend.app"];
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
  await startBackend(gate);
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
