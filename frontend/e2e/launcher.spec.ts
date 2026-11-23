import { expect, test, type Page } from "@playwright/test";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

test.skip(process.platform !== "win32", "Windows production launcher");

const repo = resolve("..");
const defaultPython = join(repo, ".local-runtime", "venv", "Scripts", "python.exe");
const recordsPython = join(repo, ".local-runtime", "records", "Scripts", "python.exe");
const python = process.env.LAF_TEST_PYTHON ?? (existsSync(defaultPython) ? defaultPython : recordsPython);

function unusedPort(): Promise<number> {
  return new Promise((done, reject) => {
    const server = createServer();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (address && typeof address === "object") server.close(() => done(address.port));
      else server.close(() => reject(new Error("No local test port was allocated.")));
    });
  });
}

function start(parent: string, frontend: number, backend: number, mode?: "fixture") {
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (key.startsWith("LAF_")) delete env[key];
  }
  const child = spawn("pwsh", ["-NoProfile", "-File", join(repo, "launch.ps1"), "--no-browser"], {
    cwd: repo, windowsHide: true, env: {
      ...env, LOCALAPPDATA: parent, LAF_PYTHON: python, LAF_FRONTEND_PORT: String(frontend),
      LAF_BACKEND_PORT: String(backend), LAF_MODE: "fixture", LAF_BACKEND_MODE: mode, LAF_SIMULATION_PROFILE: "fixture-v1",
      LAF_YOLOE_ASSETS: join(parent, "missing-models"), LAF_GESTURE_ASSETS: join(parent, "missing-models"),
    },
  });
  let output = "";
  child.stdout.on("data", (data) => { output += String(data); });
  child.stderr.on("data", (data) => { output += String(data); });
  child.stdin.on("error", () => { /* An early failure may have closed stdin. */ });
  const finished = new Promise<number | null>((done, reject) => {
    child.on("error", reject);
    child.on("close", done);
  });
  return {
    log: () => output,
    finished,
    async ready() {
      await expect.poll(() => output, { timeout: 20_000 }).toContain("Records storage ready.");
    },
    async stop() {
      child.stdin.end("\n");
      return finished;
    },
  };
}

async function register(page: Page, origin: string, name: string) {
  await page.goto(origin);
  await page.getByRole("link", { name: "Register Object", exact: true }).click();
  await page.getByRole("textbox", { name: "Object name" }).fill(name);
  await page.locator('input[type="file"]').setInputFiles(join(repo, "backend", "app", "preview_fixture", "robot.jpg"));
  await expect(page.getByRole("img", { name: "Normalized reference preview" })).toBeVisible();
  await page.getByRole("button", { name: "Next", exact: true }).click();
  for (const [field, value] of Object.entries({ X: "10", Y: "20", Width: "30", Height: "40" })) {
    await page.getByRole("textbox", { name: field + " · px", exact: true }).fill(value);
  }
  await page.getByRole("button", { name: "Register Object", exact: true }).click();
  await expect(page.getByRole("heading", { name })).toBeVisible();
}

test("the installed Windows app registers and reopens a record through a disarmed restart", { tag: "@records-qualification" }, async ({ page }, info) => {
  test.setTimeout(90_000);
  const parent = await mkdtemp(join(tmpdir(), "laf-launcher-"));
  const [frontend, backend, secondFrontend, secondBackend] = await Promise.all(
    Array.from({ length: 4 }, unusedPort),
  );
  const origin = `http://127.0.0.1:${frontend}`;
  const api = `http://127.0.0.1:${backend}`;
  await page.context().route("**/*", (route) =>
    [origin, api].includes(new URL(route.request().url()).origin) ? route.continue() : route.abort(),
  );
  let launcher = start(parent, frontend, backend);
  const boot = async () => {
    const response = await fetch(api + "/api/v1/bootstrap", { headers: { Origin: origin } });
    expect(response.status).toBe(200);
    return response.json();
  };
  try {
    await launcher.ready();
    expect(launcher.log()).toContain("Model missing, unreadable, or invalid: yoloe-26s-seg.pt");
    expect(launcher.log()).toContain("Device qualification is unavailable");
    const first = await boot();
    expect((await fetch(api + "/api/v1/health")).status).toBe(403);
    expect((await fetch(api + "/api/v1/bootstrap", { headers: { Origin: api } })).status).toBe(403);
    await page.goto(origin + "/objects");
    await expect(page.getByRole("heading", { name: "No objects registered" })).toBeVisible();
    await page.getByRole("link", { name: "Devices", exact: true }).click();
    await expect(page.locator("summary").filter({ hasText: "Qualification profile" })).toContainText("Unavailable");
    await register(page, origin, "Launcher test wallet");
    const saved = page.url();
    const reference = page.getByRole("img", { name: "Reference for Launcher test wallet", exact: true });
    await expect(reference).toBeVisible();

    const duplicate = start(parent, secondFrontend, secondBackend);
    try {
      expect(await duplicate.finished).toBe(1);
      expect(duplicate.log()).toContain("Cannot own the records data root");
    } finally {
      await duplicate.stop();
    }
    await expect(fetch(`http://127.0.0.1:${secondFrontend}/`)).rejects.toThrow();
    expect((await boot()).backend_boot_id).toBe(first.backend_boot_id);
    await page.reload();
    await expect(page.getByRole("heading", { name: "Launcher test wallet" })).toBeVisible();

    expect(await launcher.stop()).toBe(0);
    expect(launcher.log()).toContain("Motion permission revoked. Pending saves at shutdown: 0.");
    await expect(fetch(origin)).rejects.toThrow();
    await expect(fetch(api)).rejects.toThrow();
    launcher = start(parent, frontend, backend);
    await launcher.ready();
    const next = await boot();
    expect(next.backend_boot_id).not.toBe(first.backend_boot_id);
    expect(next.capability).not.toBe(first.capability);
    expect((await fetch(api + "/api/v1/health", { headers: { "X-App-Capability": first.capability } })).status).toBe(403);
    await page.goto(origin + "/objects");
    await page.getByRole("searchbox", { name: "Search objects" }).fill("Launcher test wallet");
    await page.getByRole("link", { name: "View details for Launcher test wallet", exact: true }).click();
    await expect(page).toHaveURL(saved);
    await expect(page.getByRole("heading", { name: "Launcher test wallet" })).toBeVisible();
    await expect(reference).toBeVisible();
    await page.getByRole("link", { name: "Start Search", exact: true }).click();
    await expect(page.getByRole("button", { name: "Start Search", exact: true })).toBeDisabled();
  } finally {
    await launcher.stop();
    await info.attach("launcher-output", { body: launcher.log(), contentType: "text/plain" });
    await rm(parent, { recursive: true, force: true, maxRetries: 3 });
  }
});

test("launcher shutdown disarms an active fixture and restart shows it as Interrupted", async ({ page }, info) => {
  test.setTimeout(60_000);
  const parent = await mkdtemp(join(tmpdir(), "laf-launcher-active-"));
  const [frontend, backend] = await Promise.all([unusedPort(), unusedPort()]);
  const origin = `http://127.0.0.1:${frontend}`;
  const api = `http://127.0.0.1:${backend}`;
  await page.context().route("**/*", (route) =>
    [origin, api].includes(new URL(route.request().url()).origin) ? route.continue() : route.abort(),
  );
  let launcher = start(parent, frontend, backend, "fixture");
  try {
    await launcher.ready();
    await register(page, origin, "Shutdown fixture");
    await page.getByRole("link", { name: "Open Search Setup", exact: true }).click();
    await page.getByRole("radio", { name: "PS4 controller" }).check();
    await page.getByRole("button", { name: "Acquire control" }).click();
    await page.getByRole("button", { name: "Start Search", exact: true }).click();
    await expect(page).toHaveURL(/\/sessions\/[^/]+\/live$/);
    await expect(page.getByText("Motion permission · Armed", { exact: true })).toBeVisible({ timeout: 15_000 });
    const live = page.url();
    expect(await launcher.stop()).toBe(0);
    expect(launcher.log()).toContain("Motion permission revoked. Pending saves at shutdown: 1.");

    launcher = start(parent, frontend, backend, "fixture");
    await launcher.ready();
    await page.goto(live);
    await expect(page.getByText("Search has ended", { exact: true })).toBeVisible();
    await page.getByRole("link", { name: "View Search Result" }).click();
    await expect(page.getByText("Interrupted", { exact: true })).toBeVisible();
    await expect(page.getByText("The object remains Lost.", { exact: true })).toBeVisible();
  } finally {
    await launcher.stop();
    await info.attach("launcher-output", { body: launcher.log(), contentType: "text/plain" });
    await rm(parent, { recursive: true, force: true, maxRetries: 3 });
  }
});

test("an inaccessible data root closes both services", async ({}, info) => {
  const parent = await mkdtemp(join(tmpdir(), "laf-launcher-fault-"));
  const [frontend, backend] = await Promise.all([unusedPort(), unusedPort()]);
  const wrongFile = join(parent, "LostAndFound");
  await writeFile(wrongFile, "This path is occupied.");
  const launcher = start(parent, frontend, backend);
  try {
    expect(await launcher.finished).toBe(1);
    expect(launcher.log()).toContain("Cannot open the records data-root lock. Check LOCALAPPDATA permissions.");
    expect(await readFile(wrongFile, "utf8")).toBe("This path is occupied.");
    await expect(fetch(`http://127.0.0.1:${frontend}/`)).rejects.toThrow();
    await expect(fetch(`http://127.0.0.1:${backend}/`)).rejects.toThrow();
  } finally {
    await launcher.stop();
    await info.attach("launcher-output", { body: launcher.log(), contentType: "text/plain" });
    await rm(parent, { recursive: true, force: true, maxRetries: 3 });
  }
});

test("failed storage initialization preserves the incompatible database and closes both services", async ({}, info) => {
  const parent = await mkdtemp(join(tmpdir(), "laf-launcher-schema-"));
  const [frontend, backend] = await Promise.all([unusedPort(), unusedPort()]);
  const data = join(parent, "LostAndFound");
  await mkdir(data);
  const database = join(data, "records.sqlite3");
  const contents = "This file is not a SQLite database.";
  await writeFile(database, contents);
  const launcher = start(parent, frontend, backend);
  try {
    expect(await launcher.finished).toBe(1);
    expect(launcher.log()).toContain("Backend available. Checking records storage.");
    expect(launcher.log()).toContain("Records storage is unavailable.");
    expect(await readFile(database, "utf8")).toBe(contents);
    await expect(fetch(`http://127.0.0.1:${frontend}/`)).rejects.toThrow();
    await expect(fetch(`http://127.0.0.1:${backend}/`)).rejects.toThrow();
  } finally {
    await launcher.stop();
    await info.attach("launcher-output", { body: launcher.log(), contentType: "text/plain" });
    await rm(parent, { recursive: true, force: true, maxRetries: 3 });
  }
});

test("both services exit when the launcher process is lost", async ({}, info) => {
  const parent = await mkdtemp(join(tmpdir(), "laf-launcher-lost-"));
  const [frontend, backend] = await Promise.all([unusedPort(), unusedPort()]);
  const launcher = start(parent, frontend, backend);
  try {
    await launcher.ready();
    const pid = launcher.log().match(/Lost & Found launcher \(PID (\d+)\)/)?.[1];
    expect(pid).toBeDefined();
    process.kill(Number(pid));
    expect(await launcher.finished).not.toBe(0);
    expect(launcher.log()).toContain("Motion permission revoked.");
    await expect(fetch(`http://127.0.0.1:${frontend}/`)).rejects.toThrow();
    await expect(fetch(`http://127.0.0.1:${backend}/`)).rejects.toThrow();
  } finally {
    await launcher.stop();
    await info.attach("launcher-output", { body: launcher.log(), contentType: "text/plain" });
    await rm(parent, { recursive: true, force: true, maxRetries: 3 });
  }
});
