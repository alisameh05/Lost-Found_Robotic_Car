import { expect, test, type Page, type TestInfo } from "@playwright/test";
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { appendFileSync, existsSync, linkSync, mkdtempSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { FrameMetadata, Match, MatchPage, Object as ObjectRecord, SessionAction } from "../src/generated/api-v1";

const frontend = "http://127.0.0.1:3103";
const backend = "http://127.0.0.1:8110/api/v1";
const repo = resolve("..");
const localPython = join(repo, ".local-runtime", "records", "Scripts", "python.exe");
const python = process.env.LAF_TEST_PYTHON ?? (existsSync(localPython) ? localPython : "python");
let parent: string;
let backendProcess: ChildProcess | undefined;
let backendLog: string;

test.use({ baseURL: frontend });

async function startBackend(options: {
  initializationGate?: string; crashAfterCommit?: boolean; registrationGate?: string; clockOffset?: string;
  cleanupFault?: string; settingsGate?: string; stopGate?: string; simulation?: boolean;
  reviewSimulation?: boolean; crashCandidate?: boolean; noWebcam?: boolean; crashSearch?: "start" | "resume";
  yoloe?: { assets: string; robot?: string };
  gestures?: { assets?: string; devicePath?: string };
  localController?: boolean;
  controllerSamples?: string;
  phase06?: "gestures" | "controller" | "native-landmarker" | "production";
  device?: boolean;
  cameraReplay?: boolean;
  proximityReplay?: string;
} = {}) {
  const entry = options.initializationGate ? ["backend.tests.pause_startup", options.initializationGate]
    : options.cameraReplay ? ["backend.tests.camera_preview_replay"]
    : options.proximityReplay ? ["backend.tests.proximity_replay", options.proximityReplay]
    : options.phase06 && options.phase06 !== "production" ? ["backend.tests.phase06_replay", parent, options.phase06]
    : options.controllerSamples ? ["backend.tests.crash_registration", "controller", options.controllerSamples]
    : options.crashAfterCommit ? ["backend.tests.crash_registration", "committed"]
    : options.registrationGate ? ["backend.tests.crash_registration", "journaled", options.registrationGate]
    : options.settingsGate ? ["backend.tests.crash_registration", "retention_before_commit", options.settingsGate]
    : options.stopGate ? ["backend.tests.crash_registration", "before_stop_commit", options.stopGate]
    : options.crashCandidate ? ["backend.tests.crash_registration", "candidate_promoted"]
    : options.crashSearch ? ["backend.tests.crash_registration", `before_${options.crashSearch}_commit`]
    : options.clockOffset ? ["backend.tests.crash_registration", "clock", options.clockOffset,
      ...(options.cleanupFault ? ["deny-purge", options.cleanupFault] : [])]
    : ["backend.app"];
  const child = spawn(python, ["-m", ...entry], {
    cwd: repo, windowsHide: true, env: {
      ...process.env, LOCALAPPDATA: parent, LAF_DATA_ROOT: join(parent, "records"),
      LAF_BACKEND_PORT: "8110", LAF_FRONTEND_PORT: "3103",
      LAF_BACKEND_MODE: options.device || options.cameraReplay ? "device" : options.phase06 ? "fixture" : undefined,
      LAF_SIMULATION_PROFILE: options.phase06 ? "phase-06-v1" : options.yoloe ? "local-yoloe-v1"
        : options.gestures ? "local-gestures-v1"
          : options.localController || options.controllerSamples ? "local-controller-v1"
          : options.reviewSimulation ? "fixture-review-v1" : options.simulation ? "fixture-v1" : undefined,
      LAF_YOLOE_ASSETS: options.yoloe?.assets, LAF_RECORDED_ROBOT_JPEG: options.yoloe?.robot,
      LAF_WEBCAM_DEVICE_PATH: options.gestures?.devicePath, LAF_GESTURE_ASSETS: options.gestures?.assets,
      LAF_CONTROLLER_SERIAL: undefined,
      LAF_TEST_NO_WEBCAM: options.noWebcam ? "1" : undefined,
    },
  });
  backendProcess = child;
  backendLog = "";
  child.stderr?.on("data", (chunk) => { backendLog += String(chunk); });
  child.stdout?.resume();
  child.on("error", (error) => { backendLog += error.message; });
  await expect.poll(async () => {
    if (child.exitCode !== null || backendLog.includes("ENOENT")) throw new Error(backendLog);
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

test("shows Uno proximity advice in the protected live workspace without changing held control", async ({ page }) => {
  const scenario = join(parent, "proximity-replay.jsonl");
  let delivery = 0;
  let holding = false;
  function replay(sample?: { sequence: number; distance: number; age_ms?: number; valid?: number }) {
    appendFileSync(scenario, JSON.stringify({ holding, delivery: sample ? ++delivery : delivery, sample }) + "\n");
  }
  replay();
  await startBackend({ proximityReplay: scenario });
  await loopbackOnly(page);
  await seedLibrary([["proximity-target", "Proximity target", "Lost", Date.now() - 1000]], ["proximity-target"]);
  await page.goto("/objects/proximity-target/search");
  await page.getByRole("radio", { name: "PS4 controller" }).check();
  await page.getByRole("button", { name: "Acquire control" }).click();
  await page.getByRole("button", { name: "Start Search", exact: true }).click();
  const advisory = page.getByRole("status", { name: "Proximity advisory" });
  const feedback = page.getByRole("region", { name: "Controller feedback" });
  await expect(advisory).toContainText("Proximity · Unknown");
  await expect(feedback).toContainText("Motion permission · Arming");
  holding = true;
  replay();
  await expect(feedback).toContainText("Motion permission · Armed");

  async function seeSample(sequence: number, distance: number, state: "Warning" | "Clear") {
    replay({ sequence, distance });
    await expect(advisory).toContainText(`Proximity · ${state}`);
    await expect(advisory).toContainText(`Distance ${distance} mm`);
  }
  await seeSample(1, 200, "Warning");
  await seeSample(2, 250, "Warning");
  await seeSample(3, 300, "Warning");
  replay({ sequence: 4, distance: 0, valid: 0 });
  await expect(advisory).toContainText("Proximity · Unknown");
  await expect(advisory).toContainText("Previous obstacle warning remains active");
  await expect(advisory).toContainText("Distance unavailable");
  await seeSample(5, 301, "Warning");
  await seeSample(6, 302, "Warning");
  await seeSample(7, 300, "Clear");
  await expect(advisory).toContainText("Proximity · Unknown");
  await expect(advisory).not.toContainText("Previous obstacle warning");
  await expect(feedback).toContainText("Motion permission · Armed");
  await expect(page.getByText("Committed session · Searching", { exact: true })).toBeVisible();
});

async function setTargetCoordinates(page: Page, coordinates = ["10", "20", "30", "60"]) {
  for (const [index, label] of ["X", "Y", "Width", "Height"].entries()) {
    await page.getByRole("textbox", { name: label + " · px", exact: true }).fill(coordinates[index]);
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
test.afterEach(async ({ page }, info) => {
  if (info.title.startsWith("Phase 06") && info.status !== info.expectedStatus) {
    const trace = join(parent, "trace.jsonl");
    if (existsSync(trace)) {
      await info.attach("failure-replay-trace", { path: trace, contentType: "application/x-ndjson" });
    }
    if (backendLog) await info.attach("failure-backend-stderr", { body: backendLog, contentType: "text/plain" });
    const text = await page.locator("body").innerText({ timeout: 2_000 }).catch(() => "");
    if (text) await info.attach("failure-page-text", { body: text, contentType: "text/plain" });
  }
  await stopBackend();
  await rm(parent, { recursive: true, force: true, maxRetries: 3 });
});

test("default startup opens connected empty records and editable settings with one page identity", { tag: "@records-qualification" }, async ({ page }) => {
  await startBackend();
  await loopbackOnly(page);
  const { requests, sockets } = observe(page);
  await page.goto("/");
  await expect(page.getByText("Records connected · Search unavailable")).toBeVisible();
  await expect(page.getByText("No sessions for recent objects", { exact: true })).toBeVisible();
  await expect(page.getByText(/Fixture mode|Fixture scenario|Sample device observations/)).toHaveCount(0);
  const release = Promise.withResolvers<void>();
  await page.route(backend + "/objects", async (route) => {
    const response = await route.fetch();
    await release.promise;
    await route.fulfill({ response });
  }, { times: 1 });
  try {
    await page.getByRole("link", { name: "Objects / History" }).click();
    await expect(page.getByText("Loading objects", { exact: true })).toBeVisible();
  } finally {
    release.resolve();
  }
  await expect(page.getByRole("heading", { name: "No objects registered" })).toBeVisible();
  await page.getByRole("link", { name: "Settings" }).click();
  await expect(page.getByRole("region", { name: "Saved retention" }).getByText("7 days", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Preview Change" })).toBeEnabled();
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

for (const configured of [false, true]) {
  test("opens disarmed Device diagnostics " + (configured ? "with a validated profile" : "without a profile"), async ({ page }) => {
    if (configured) {
      execFileSync(python, ["-c", [
        "import sys",
        "from pathlib import Path",
        "from backend.tests.device_documents import device_documents, write_device_documents",
        "write_device_documents(Path(sys.argv[1]), *device_documents())",
      ].join("\n"), join(parent, "records")], { cwd: repo, windowsHide: true });
    }
    // A stale fixture selection must not start preview or simulated commands in Device mode.
    await startBackend({ device: true, simulation: true });
    await loopbackOnly(page);
    await seedLibrary([["test-device-target", "Device test target", "Lost", Date.now() - 1_000]], ["test-device-target"]);
    await page.goto("/objects/test-device-target/search");
    const readiness = page.getByRole("region", { name: "Connection readiness" });
    const webcam = readiness.getByRole("listitem").filter({ hasText: "Laptop webcam" });
    await expect(webcam).toContainText("Required");
    await expect(webcam).toContainText("Unavailable");
    await expect(readiness.getByRole("listitem").filter({ hasText: "PS4 DualShock 4" })).toContainText("Inactive");
    await expect(readiness.getByRole("listitem").filter({ hasText: "Qualification profile" }))
      .toContainText(configured ? "Ready" : "Unavailable");
    await expect(readiness.getByRole("listitem").filter({ hasText: "Robot command connection" }))
      .toContainText(configured ? "Unavailable · Unsupported protocol" : "Unavailable");
    if (configured) {
      await expect(page.getByText("Device mode", { exact: true })).toBeVisible();
      await expect(page.getByRole("region", { name: "Robot preview" })).toContainText("Not live");
      await expect(page.getByRole("img", { name: "Robot camera view", exact: true })).toBeVisible();
    }
    await expect(page.getByText(/Backend simulation|Fixture mode/)).toHaveCount(0);
    const start = page.getByRole("button", { name: "Start Search" });
    await expect(start).toBeDisabled();
    await page.getByRole("radio", { name: "PS4 controller" }).check();
    await expect(readiness.getByRole("listitem").filter({ hasText: "Laptop webcam" })).toContainText("Inactive");
    await expect(readiness.getByRole("listitem").filter({ hasText: "PS4 DualShock 4" })).toContainText("Required");
    await expect(start).toBeDisabled();
    await page.getByRole("link", { name: "View Devices" }).click();
    await expect(page.getByRole("heading", { name: "Required for Controller (PS4)" })).toBeVisible();
    const camera = page.locator("summary").filter({ hasText: "Robot camera" });
    await expect(camera).toContainText("Unavailable");
    await camera.click();
    await expect(page.getByText(/selected ESP32-CAM configuration/)).toBeVisible();
    await expect(page.getByText("Proximity feedback is for the operator’s awareness only.")).toBeVisible();
    await page.getByRole("button", { name: "Emergency Stop" }).click();
    await expect(page.getByText("Motion permission revoked", { exact: true })).toBeVisible();
    await page.getByRole("link", { name: "Open Control Guide" }).click();
    await expect(page.getByRole("heading", { name: "Control Guide", exact: true })).toBeVisible();
    await page.getByRole("link", { name: "Return to Search Setup" }).click();
    await expect(page.getByRole("radio", { name: "PS4 controller" })).toBeChecked();
    await expect(page.getByRole("heading", { name: "Device test target" })).toBeVisible();
  });
}

test("keeps the explicit Phase 06 fixture labeled with simulated robot paths", async ({ page }) => {
  const robot = join(repo, "backend", "app", "preview_fixture", "robot.jpg");
  await startBackend({ phase06: "production", yoloe: { assets: "", robot } });
  await loopbackOnly(page);
  await page.goto("/devices");
  await expect(page.getByText("Fixture mode · Backend simulation", { exact: true })).toBeVisible();
  await expect(page.getByText(/Recorded robot video and simulated commands/)).toBeVisible();
  for (const name of ["Robot command connection", "Robot camera"]) {
    await expect(page.locator("summary").filter({ hasText: name })).toContainText("Ready");
  }
});

test("renders the selected camera adapter in Search Setup and retains the last image after link loss", async ({ page }) => {
  await startBackend({ cameraReplay: true });
  await loopbackOnly(page);
  await seedLibrary([["camera-target", "Camera target", "Lost", Date.now() - 1_000]], ["camera-target"]);
  await page.goto("/objects/camera-target/search");
  const preview = page.getByRole("region", { name: "Robot preview" });
  await expect(preview.getByText("Live preview", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Start Search" })).toBeDisabled();
  const canvas = preview.getByRole("img", { name: "Robot camera view", exact: true });
  const displayed = await canvas.evaluate((element: HTMLCanvasElement) => element.toDataURL());
  const dropped = join(parent, "records", "replay-drop-camera");
  writeFileSync(dropped, "offline");
  await expect(preview.getByText("Not live", { exact: true })).toBeVisible();
  expect(await canvas.evaluate((element: HTMLCanvasElement) => element.toDataURL())).toBe(displayed);
  unlinkSync(dropped);
  await expect(preview.getByText("Live preview", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Start Search" })).toBeDisabled();
});

type PreviewProbe = { events?: WebSocket; initialSnapshot?: string; repeatFrames: boolean };
type PreviewWindow = Window & { previewProbe: PreviewProbe };

async function observePreviewFrames(page: Page) {
  await page.addInitScript(() => {
    const probe: PreviewProbe = { repeatFrames: false };
    (window as unknown as PreviewWindow).previewProbe = probe;
    const NativeSocket = window.WebSocket;
    window.WebSocket = class extends NativeSocket {
      constructor(url: string | URL, protocols?: string | string[]) {
        super(url, protocols);
        const path = new URL(url).pathname;
        if (path === "/api/v1/events") {
          probe.events = this;
          this.addEventListener("message", ({ data }) => {
            if (typeof data === "string" && JSON.parse(data).type === "snapshot") probe.initialSnapshot = data;
          });
        } else if (path === "/api/v1/video/robot") {
          let previous: ArrayBuffer | undefined;
          this.addEventListener("message", (event) => {
            if (!event.isTrusted) return;
            if (probe.repeatFrames && previous) {
              event.stopImmediatePropagation();
              this.dispatchEvent(new MessageEvent("message", { data: previous }));
            } else if (event.data instanceof ArrayBuffer) {
              previous = event.data;
            }
          });
        }
      }
    };
  });
}

test("watches a protected simulated preview from a saved Lost target across tabs and restart", async ({ page, context }) => {
  test.setTimeout(60_000);
  const clockOffset = join(parent, "preview-clock-offset");
  writeFileSync(clockOffset, "0");
  await startBackend({ simulation: true, clockOffset });
  await observePreviewFrames(page);
  const source = sourceImage();
  await selectTarget(page, source, "Preview registration");
  await setTargetCoordinates(page);
  await page.getByRole("button", { name: "Register Object" }).click();
  await expect(page.getByRole("heading", { name: "Object Details" })).toBeVisible();
  const { requests, sockets } = observe(page);
  await page.getByRole("link", { name: "Open Search Setup" }).click();
  const preview = page.getByRole("region", { name: "Simulated robot preview" });
  await expect(preview.getByText("Live preview", { exact: true })).toBeVisible();
  await expect(preview.getByText("Backend simulation · Disarmed")).toBeVisible();
  await expect(preview.locator("canvas")).toHaveAttribute("width", "480");
  await expect(page.getByRole("button", { name: "Acquire control" })).toBeEnabled();
  await expect(page.getByRole("button", { name: "Start Search" })).toBeDisabled();
  await page.getByRole("radio", { name: "PS4 controller" }).check();
  await expect(page.getByRole("listitem").filter({ hasText: "Laptop webcam" }).getByText("Inactive")).toBeVisible();
  expect(sockets).toEqual(expect.arrayContaining([
    "ws://127.0.0.1:8110/api/v1/events", "ws://127.0.0.1:8110/api/v1/video/robot",
  ]));

  const screenshot = await preview.locator("canvas").evaluate((element: HTMLCanvasElement) => element.toDataURL());
  await page.evaluate(() => { (window as unknown as PreviewWindow).previewProbe.repeatFrames = true; });
  await expect(preview.getByText("Not live", { exact: true })).toBeVisible();
  expect(await preview.locator("canvas").evaluate((element: HTMLCanvasElement) => element.toDataURL())).toBe(screenshot);
  await page.evaluate(() => { (window as unknown as PreviewWindow).previewProbe.repeatFrames = false; });
  await expect(preview.getByText("Live preview", { exact: true })).toBeVisible();

  const eventSockets = () => sockets.filter((url) => url.endsWith("/events")).length;
  const connectedEvents = eventSockets();
  await page.evaluate(() => {
    const { events, initialSnapshot } = (window as unknown as PreviewWindow).previewProbe;
    if (!events || !initialSnapshot) throw new Error("The event channel has no initial snapshot");
    const snapshot = JSON.parse(initialSnapshot);
    events.dispatchEvent(new MessageEvent("message", { data: JSON.stringify({
      ...snapshot, event_seq: snapshot.event_seq + 2, type: "readiness_changed",
      payload: { readiness: snapshot.payload.readiness, runtime: snapshot.payload.runtime },
    }) }));
  });
  await expect.poll(eventSockets).toBeGreaterThan(connectedEvents);
  await expect(preview.getByText("Live preview", { exact: true })).toBeVisible();

  const videoSockets = () => sockets.filter((url) => url.endsWith("/video/robot")).length;
  const connectedVideo = videoSockets();
  writeFileSync(clockOffset, "5000");
  await expect.poll(videoSockets).toBeGreaterThan(connectedVideo);
  await expect(preview.getByText("Live preview", { exact: true })).toBeVisible();

  const spectator = await context.newPage();
  const spectatorTraffic = observe(spectator);
  await spectator.goto(page.url());
  await expect(spectator.getByText("Backend simulation · Disarmed")).toBeVisible();
  await expect(spectator.getByText("Live preview", { exact: true })).toBeVisible();
  await spectator.reload();
  await expect(spectator.getByText("Live preview", { exact: true })).toBeVisible();
  await expect(spectator.getByRole("button", { name: "Acquire control" })).toBeEnabled();
  await spectator.close();
  await page.bringToFront();

  await stopBackend();
  await expect(preview.getByText("Live preview", { exact: true })).toHaveCount(0);
  await startBackend({ simulation: true, clockOffset });
  await expect(preview.getByText("Live preview", { exact: true })).toBeVisible({ timeout: 20_000 });
  await expect(page.getByRole("region", { name: "Saved search target" }).getByText("Preview registration")).toBeVisible();
  await expect(page.getByRole("button", { name: "Start Search" })).toBeDisabled();
  for (const traffic of [requests, spectatorTraffic.requests]) {
    expect(traffic.filter((request) => request.startsWith("POST ")).every(
      (request) => request === "POST /api/v1/websocket-tickets",
    )).toBe(true);
  }
});

test("acquires, demonstrates readiness, and releases control in connected Search Setup", async ({ page, context }) => {
  test.setTimeout(60_000);
  await startBackend({ simulation: true });
  await page.goto("/");
  await expect(page.getByRole("region", { name: "Search status" })).toContainText("No active search");
  await observePreviewFrames(page);
  await selectTarget(page, sourceImage(), "Workspace control");
  await setTargetCoordinates(page);
  await page.getByRole("button", { name: "Register Object" }).click();
  await expect(page.getByRole("heading", { name: "Object Details" })).toBeVisible();
  await page.getByRole("link", { name: "Open Search Setup" }).click();
  const preview = page.getByRole("region", { name: "Simulated robot preview" });
  await expect(preview.getByText("Live preview", { exact: true })).toBeVisible();
  const other = await context.newPage();
  await other.goto(page.url());
  await expect(other.getByText("Live preview", { exact: true })).toBeVisible();
  const { requests } = observe(page);
  await page.bringToFront();
  await expect(page.getByText("Ready to start", { exact: true })).toHaveCount(0);
  await page.getByRole("button", { name: "Acquire control" }).click();
  await expect(page.getByText("Ready to start", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Start Search" })).toBeEnabled();
  await expect(other.getByRole("button", { name: "Acquire control" })).toHaveAccessibleDescription("Another workspace holds control.");
  await expect(other.getByText("Ready to start", { exact: true })).toHaveCount(0);

  const pixels = await preview.locator("canvas").evaluate((element: HTMLCanvasElement) => element.toDataURL());
  await page.evaluate(() => { (window as unknown as PreviewWindow).previewProbe.repeatFrames = true; });
  await expect(preview.getByText("Not live", { exact: true })).toBeVisible();
  await expect(page.getByText("Ready to start", { exact: true })).toHaveCount(0);
  expect(await preview.locator("canvas").evaluate((element: HTMLCanvasElement) => element.toDataURL())).toBe(pixels);
  await page.evaluate(() => { (window as unknown as PreviewWindow).previewProbe.repeatFrames = false; });
  await expect(preview.getByText("Live preview", { exact: true })).toBeVisible();
  await expect(page.getByText("Ready to start", { exact: true })).toHaveCount(0);

  await other.bringToFront();
  await expect(other.getByText("Selecting Acquire control consents to taking over available control.")).toBeVisible();
  await other.getByRole("button", { name: "Acquire control" }).click();
  await expect(other.getByText("Ready to start", { exact: true })).toBeVisible();
  await other.evaluate(() => dispatchEvent(new Event("blur")));
  await expect(other.getByText("Ready to start", { exact: true })).toHaveCount(0);
  await expect(other.getByRole("button", { name: "Release control" })).toHaveCount(0);

  await page.bringToFront();
  await page.getByRole("button", { name: "Acquire control" }).click();
  await expect(page.getByText("Ready to start", { exact: true })).toBeVisible();
  const released = page.waitForResponse((response) =>
    response.request().method() === "POST" && response.url().endsWith("/api/v1/control-lease/release"), { timeout: 5_000 });
  await page.getByRole("button", { name: "Release control" }).click();
  expect((await released).status()).toBe(200);
  await expect(page.getByText("Ready to start", { exact: true })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Acquire control" })).toBeEnabled();
  await page.getByRole("button", { name: "Acquire control" }).click();
  await expect(page.getByText("Ready to start", { exact: true })).toBeVisible();
  const left = page.waitForResponse((response) =>
    response.request().method() === "POST" && response.url().endsWith("/api/v1/control-lease/release"), { timeout: 5_000 });
  await page.getByRole("link", { name: "Back to Object Details" }).click();
  expect((await left).status()).toBe(200);
  await expect(page.getByRole("heading", { name: "Object Details" })).toBeVisible();
  expect(requests).not.toContain("POST /api/v1/sessions");
});

test("keeps Start, Resume and acquisition unavailable on direct routes", async ({ page }) => {
  await startBackend();
  const { requests, sockets } = observe(page);
  await page.goto("/objects/example/search");
  await expect(page.getByRole("heading", { name: "Search Setup" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Object not found" })).toBeVisible();
  await expect(page.getByRole("button", { name: /Start Search|Acquire Control/ })).toHaveCount(0);
  await page.goto("/sessions/example/live");
  await expect(page.getByRole("heading", { name: "Live Search Workspace" })).toBeVisible();
  await expect(page.getByText("The application is disarmed.")).toBeVisible();
  await expect(page.getByRole("link", { name: "Check device and qualification status" })).toHaveAttribute("href", "/devices");
  await expect(page.getByRole("button", { name: /Resume|Acquire Control|Emergency Stop/ })).toHaveCount(0);
  await expect(page.getByText("Records connected · Search unavailable")).toBeVisible();
  expect(requests.every((value) => /^(GET|OPTIONS) \/api\/v1\/(bootstrap|snapshot|health|objects\/example)$/.test(value))).toBe(true);
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

test("shows degraded storage without presenting an empty object history", { tag: "@records-qualification" }, async ({ page }) => {
  const root = join(parent, "records");
  execFileSync(python, [
    "-c", "import pathlib, sqlite3, sys; p = pathlib.Path(sys.argv[1]); p.mkdir(); " +
      "sqlite3.connect(p / 'records.sqlite3').execute('PRAGMA user_version = 99').close()",
    root,
  ], { windowsHide: true });
  await startBackend();
  await loopbackOnly(page);
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

test("finds and pages real registrations, opens protected references and uses Dashboard details offline", { tag: "@records-qualification" }, async ({ page }) => {
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
  await expect(page.getByRole("region", { name: "Object record" }).getByRole("heading", { level: 2 })).toHaveText("Straße%_  Café Ᲊ");
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
  await field.fill("No matching belonging");
  await expect(page.getByRole("heading", { name: "No matching objects" })).toBeVisible();
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

test("previews and cancels, rejects a changed impact, and retains the saved period", { tag: "@records-qualification" }, async ({ page }) => {
  test.setTimeout(60_000);
  const clock = join(parent, "retention-clock");
  writeFileSync(clock, "0");
  await startBackend({ clockOffset: clock });
  await seedLibrary([
    ["about-to-expire", "Boundary record", "Lost", Date.now() - 86_400_000 + 120_000],
  ], ["about-to-expire"]);
  await loopbackOnly(page);
  const { requests } = observe(page);
  await page.goto("/settings");
  const saved = page.getByRole("region", { name: "Saved retention" });
  const proposed = page.getByRole("textbox", { name: "Proposed retention in days" });
  const preview = page.getByRole("button", { name: "Preview Change" });
  const review = page.getByRole("button", { name: "Review Change", exact: true });
  await expect(saved).toContainText("7 days");
  await proposed.fill("1");
  await preview.click();
  await expect(page.getByRole("region", { name: "Immediate impact" })).toContainText("0 objects");
  await review.click();
  await page.getByRole("dialog").getByRole("button", { name: "Cancel Change" }).click();
  await expect(proposed).toHaveValue("7");
  expect(requests.filter((request) => request.startsWith("PUT"))).toEqual([]);

  await proposed.fill("1");
  await preview.click();
  await review.click();
  writeFileSync(clock, "180000");
  await page.getByRole("button", { name: "Confirm and Apply" }).click();
  await expect(page.getByText("Preview outdated", { exact: true })).toBeVisible();
  await expect(saved).toContainText("7 days");
  await preview.click();
  await expect(page.getByRole("region", { name: "Immediate impact" })).toContainText("1 object");
});

test("lengthens the original deadline and denies expired media even with the browser cache enabled", { tag: "@records-qualification" }, async ({ page }) => {
  test.setTimeout(60_000);
  const clock = join(parent, "retention-clock");
  const fault = join(parent, "deny-cleanup");
  const day = 86_400_000;
  const registered = Date.now() - 6 * day;
  writeFileSync(clock, "0");
  writeFileSync(fault, "test fault");
  await startBackend({ clockOffset: clock, cleanupFault: fault });
  await seedLibrary([["old", "Kept reference", "Lost", registered]], ["old"]);
  // Playwright routing disables Chromium's HTTP cache. Observe requests without routing here.
  const origins = new Set<string>();
  page.on("request", (request) => origins.add(new URL(request.url()).origin));
  await page.goto("/settings");
  const saved = page.getByRole("region", { name: "Saved retention" });
  const proposed = page.getByRole("textbox", { name: "Proposed retention in days" });
  const preview = page.getByRole("button", { name: "Preview Change" });
  await expect(saved).toContainText("7 days");
  for (const invalid of ["0", "1.5", "31"]) {
    await proposed.fill(invalid);
    await expect(page.getByText("Enter a whole number from 1 to 30.")).toBeVisible();
    await expect(preview).toBeDisabled();
  }
  await proposed.fill("30");
  await preview.click();
  await expect(page.getByRole("region", { name: "Immediate impact" })).toContainText("0 objects");
  await page.getByRole("button", { name: "Review Change", exact: true }).click();
  await expect(saved).toContainText("7 days");
  await page.getByRole("button", { name: "Confirm and Apply" }).click();
  await expect(saved).toContainText("30 days");

  writeFileSync(clock, String(2 * day));
  const mediaUrl = backend + "/media/old-reference";
  const mediaResponse = page.waitForResponse((response) => response.url() === mediaUrl && response.ok());
  await page.goto("/objects/old");
  const image = page.getByRole("img", { name: "Reference for Kept reference", exact: true });
  await expect(image).toBeVisible();
  const record = page.getByRole("region", { name: "Object record" });
  await expect(record.getByText("30 days from registration")).toBeVisible();
  await expect(record.locator("time").first()).toHaveAttribute("datetime", new Date(registered).toISOString());
  await expect(record.locator("time").nth(1)).toHaveAttribute("datetime", new Date(registered + 30 * day).toISOString());
  const received = await mediaResponse;
  expect(received.headers()["cache-control"]).toBe("no-store");
  const headers = { "X-App-Capability": (await received.request().allHeaders())["x-app-capability"] };
  const fetchReference = (cache: RequestCache) => page.evaluate(async ({ mediaUrl, headers, cache }) => {
    const response = await fetch(mediaUrl, { headers, cache });
    return { status: response.status, type: (await response.blob()).type };
  }, { mediaUrl, headers, cache });
  expect(await fetchReference("default")).toEqual({ status: 200, type: "image/png" });

  writeFileSync(clock, String(25 * day));
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await expect(page.getByText("Record expired", { exact: true })).toBeVisible();
  await expect(image).toHaveCount(0);
  await expect(page.getByText("Deletion failed", { exact: true })).toBeVisible();
  const file = join(parent, "records", "media", "old-reference.png");
  expect(existsSync(file)).toBe(true);
  expect(await fetchReference("force-cache")).toEqual({ status: 410, type: "application/json" });
  unlinkSync(fault);
  await expect.poll(() => existsSync(file), { timeout: 12_000 }).toBe(false);
  expect(origins).toEqual(new Set([frontend, new URL(backend).origin]));
});

test("observes a pending settings transaction settle through a protected snapshot", { tag: "@records-qualification" }, async ({ page }) => {
  const gate = join(parent, "allow-settings-commit");
  await startBackend({ settingsGate: gate });
  await loopbackOnly(page);
  await page.goto("/settings");
  const saved = page.getByRole("region", { name: "Saved retention" });
  await page.getByRole("textbox", { name: "Proposed retention in days" }).fill("14");
  await page.getByRole("button", { name: "Preview Change" }).click();
  await page.getByRole("button", { name: "Review Change", exact: true }).click();
  const pending = page.waitForResponse((response) => response.url() === backend + "/settings/retention" &&
    response.request().method() === "PUT" && response.status() === 202);
  await page.getByRole("button", { name: "Confirm and Apply" }).click();
  await pending;
  await expect(page.getByText("Retention save pending", { exact: true })).toBeVisible();
  await expect(saved).toContainText("7 days");
  await page.getByRole("link", { name: "Devices", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Devices" })).toBeVisible();
  await page.getByRole("link", { name: "Settings", exact: true }).click();
  await expect(page.getByText("Retention save pending", { exact: true })).toBeVisible();
  writeFileSync(gate, "commit");
  await expect(page.getByText("Retention saved", { exact: true })).toBeVisible({ timeout: 12_000 });
  await expect(saved).toContainText("14 days");
  await expect(page.getByRole("button", { name: "Retry Same Request" })).toHaveCount(0);
});

test("recovers a lost settings response and removes records and open evidence through failed cleanup and repair", { tag: "@records-qualification" }, async ({ page, context }) => {
  test.setTimeout(90_000);
  const clock = join(parent, "retention-clock");
  const fault = join(parent, "deny-cleanup");
  writeFileSync(clock, "0");
  writeFileSync(fault, "test fault");
  await startBackend({ clockOffset: clock, cleanupFault: fault });
  await waitForStorage();
  seedStoredHistory(Date.now() - 2 * 86_400_000);
  await seedLibrary([["kept", "Recent reference", "Lost", Date.now() - 1_000]], ["kept"]);
  await loopbackOnly(page);
  const { requests, sockets } = observe(page);
  const historyTab = await context.newPage();
  await historyTab.goto(frontend + "/sessions/session-confirmed");
  const evidence = historyTab.getByRole("img", { name: "Captured evidence", exact: true });
  await expect(evidence).toHaveAttribute("src", /^blob:/);
  const url = await evidence.getAttribute("src");
  await page.goto("/settings");
  const proposed = page.getByRole("textbox", { name: "Proposed retention in days" });
  const saved = page.getByRole("region", { name: "Saved retention" });
  await proposed.fill("1");
  await page.getByRole("button", { name: "Preview Change" }).click();
  const impact = page.getByRole("region", { name: "Immediate impact" });
  await expect(impact).toContainText("4 sessions");
  await expect(impact).toContainText("3 matches");
  await expect(impact).toContainText(/\d+ bytes of managed images/);
  await page.getByRole("button", { name: "Review Change", exact: true }).click();
  const payloads: string[] = [];
  await page.route(backend + "/settings/retention", async (route) => {
    if (route.request().method() !== "PUT") return route.fallback();
    payloads.push(route.request().postData() ?? "");
    if (payloads.length === 1) {
      const response = await route.fetch();
      expect(response.status()).toBe(200);
      expect((await response.json()).result.deletion.status).toBe("Pending");
      await route.abort();
    } else await route.fallback();
  });
  await page.getByRole("button", { name: "Confirm and Apply" }).click();
  await expect(page.getByText("Save outcome unknown", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Retry Same Request" }).click();
  await expect(page.getByText("Retention saved", { exact: true })).toBeVisible();
  expect(payloads).toHaveLength(2);
  expect(payloads[1]).toBe(payloads[0]);
  await expect(saved).toContainText("1 day");
  await expect(page.getByText("Deletion failed", { exact: true })).toBeVisible({ timeout: 15_000 });
  expect(existsSync(join(parent, "records", "media", "evidence-match-confirmed.png"))).toBe(true);
  await historyTab.evaluate(() => window.dispatchEvent(new Event("online")));
  await expect(evidence).toHaveCount(0);
  await expect(historyTab.getByText(/^(Session expired|Session not found)$/)).toBeVisible({ timeout: 15_000 });
  expect(await historyTab.evaluate(async (url) => {
    try { await fetch(url!); return true; } catch { return false; }
  }, url)).toBe(false);
  await historyTab.close();

  unlinkSync(fault);
  await expect(page.getByText("Deletion complete", { exact: true })).toBeVisible({ timeout: 15_000 });
  expect(existsSync(join(parent, "records", "media", "evidence-match-confirmed.png"))).toBe(false);
  await page.getByRole("link", { name: "Objects / History" }).click();
  await expect(objectRows(page)).toHaveCount(1);
  await expect(objectRows(page).first()).toContainText("Recent reference");
  await page.getByRole("link", { name: "Dashboard" }).click();
  await expect(page.getByText("No sessions for recent objects", { exact: true })).toBeVisible();
  await page.goto("/objects/history-owner");
  await expect(page.getByText("Object not found", { exact: true })).toBeVisible();
  expect(requests).not.toContain("GET /api/v1/sessions");
  expect(requests).not.toContain("GET /api/v1/history");
  expect(sockets).toEqual([]);
  await expect(page.getByText(/Fixture mode|Fixture scenario/)).toHaveCount(0);
});

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
    response.url() === `${backend}/sessions/session-interrupted` && [404, 410].includes(response.status()));
  writeFileSync(offset, String(7 * 86_400_000));
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  expect(["EXPIRED", "NOT_FOUND"]).toContain((await (await expiry).json()).code);
  await expect(page.getByText(/^(Session expired|Session not found)$/)).toBeVisible();
  await expect(image).toHaveCount(0);
  expect(await page.evaluate(async (url) => {
    try { await fetch(url!); return true; } catch { return false; }
  }, objectUrl)).toBe(false);
});

test("discards overtaken search reads, resets an expired cursor and restarts with a new authority", { tag: "@records-qualification" }, async ({ page }) => {
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

test("revokes an expired reference and keeps browsing the eligible page against the real service", { tag: "@records-qualification" }, async ({ page }) => {
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
  await expect.poll(() => existsSync(join(parent, "records", "media", "old-reference.png"))).toBe(false);
  await page.goto("/objects/old");
  await expect(page.getByText("Object not found", { exact: true })).toBeVisible();
});

test("rejects an invalid image and out-of-bounds target without creating a record", { tag: "@records-qualification" }, async ({ page }) => {
  await startBackend();
  await loopbackOnly(page);
  await page.goto("/");
  await page.getByRole("link", { name: "Register Object", exact: true }).click();
  await page.getByRole("textbox", { name: "Object name" }).fill("Invalid reference");
  const picker = page.getByLabel("Reference image", { exact: true });
  await picker.setInputFiles({ name: "bad.png", mimeType: "image/png", buffer: Buffer.from("not a PNG") });
  await expect(page.getByRole("alert").filter({ hasText: "Choose a JPEG or PNG" })).toBeVisible();
  await page.getByRole("button", { name: "Next", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Select Target" })).toHaveCount(0);
  await picker.setInputFiles(sourceImage());
  await expect(page.getByRole("img", { name: "Normalized reference preview" })).toBeVisible();
  await page.getByRole("button", { name: "Next", exact: true }).click();
  await setTargetCoordinates(page, ["10", "20", "31", "60"]);
  await expect(page.getByText("Width extends past the image.")).toBeVisible();
  await expect(page.getByRole("button", { name: "Register Object", exact: true })).toBeDisabled();
  await page.getByRole("link", { name: "Objects / History" }).click();
  await expect(page.getByRole("heading", { name: "No objects registered" })).toBeVisible();
  expect(await readdir(join(parent, "records", "media"))).toEqual([]);
});

test("registers an oriented reference and reopens its target after actual process restart", { tag: "@records-qualification" }, async ({ page }) => {
  await startBackend();
  await loopbackOnly(page);
  const source = sourceImage();
  const original = readFileSync(source);
  await selectTarget(page, source, " \u2003Cafe\u0301 card ");
  const expectedRoi = { x: 10, y: 20, width: 30, height: 60 };
  const preview = page.getByRole("img", { name: "Normalized reference for target selection" });
  await expect(preview).toBeVisible();
  const box = (await preview.boundingBox())!;
  // Reverse drag from the inclusive far edge of the 40 × 80 oriented image.
  await page.mouse.move(box.x + box.width - 1, box.y + box.height - 1);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 4, box.y + box.height / 4, { steps: 4 });
  await page.mouse.up();
  await expect(page.getByText("Valid rectangle · 30 × 60 px")).toBeVisible();
  for (const [coordinate, value] of Object.entries(expectedRoi)) {
    const label = coordinate[0].toUpperCase() + coordinate.slice(1) + " · px";
    await expect(page.getByRole("textbox", { name: label, exact: true })).toHaveValue(String(value));
  }
  await page.getByRole("button", { name: "Back", exact: true }).click();
  await expect(page.getByRole("textbox", { name: "Object name" })).toHaveValue("Café card");
  await page.getByRole("button", { name: "Next", exact: true }).click();
  await expect(page.getByRole("textbox", { name: "Height · px", exact: true })).toHaveValue("60");
  await page.getByRole("button", { name: "Back", exact: true }).click();
  await page.locator('input[type="file"]').setInputFiles(sourceImage("replacement.png"));
  await expect(page.getByText("replacement.png", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Next", exact: true }).click();
  await expect(page.getByRole("button", { name: "Register Object", exact: true })).toBeDisabled();
  await expect(page.getByRole("textbox", { name: "X · px" })).toBeFocused();
  for (const [index, value] of Object.values(expectedRoi).entries()) {
    if (index > 0) await page.keyboard.press("Tab");
    await page.keyboard.type(String(value));
  }
  const registration = page.waitForResponse((response) => response.url() === backend + "/objects" &&
    response.request().method() === "POST" && response.status() === 201);
  await page.getByRole("button", { name: "Register Object", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Object Details", exact: true })).toBeVisible();
  const reference = page.getByRole("img", { name: "Reference for Café card", exact: true });
  await expect(reference).toBeVisible();
  const saved = (await (await registration).json()).result.object as ObjectRecord;
  expect(saved.roi).toEqual(expectedRoi);
  const registered = page.getByRole("region", { name: "Object record" }).locator("time").first();
  const registeredAt = new Date(saved.registered_at_ms).toISOString();
  await expect(registered).toHaveAttribute("datetime", registeredAt);
  const managed = join(parent, "records", "media", saved.reference_media.id + ".png");
  const managedBytes = readFileSync(managed);
  const location = page.url();
  expect(readFileSync(source)).toEqual(original);
  await rm(source);
  await rm(join(parent, "replacement.png"));
  await stopBackend();
  await startBackend();
  const detailResponse = page.waitForResponse((response) => response.url() === backend + "/objects/" + saved.id && response.ok());
  const mediaResponse = page.waitForResponse((response) =>
    response.url() === backend + "/media/" + saved.reference_media.id && response.ok());
  await page.goto(location);
  await expect(reference).toBeVisible();
  await expect(page.getByRole("img", { name: "Selected target from Reference for Café card", exact: true })).toBeVisible();
  expect((await (await detailResponse).json()).roi).toEqual(expectedRoi);
  await expect(registered).toHaveAttribute("datetime", registeredAt);
  await expect(page.getByText("Lost", { exact: true })).toBeVisible();
  expect(await reference.evaluate((image: HTMLImageElement) => [image.naturalWidth, image.naturalHeight]))
    .toEqual([40, 80]);
  const bytes = await mediaResponse;
  expect(await bytes.body()).toEqual(managedBytes);
  expect(bytes.headers()["cache-control"]).toBe("no-store");
  expect(bytes.headers()["accept-ranges"]).toBe("none");
});

test("recovers a lost committed response with the same request after restart", { tag: "@records-qualification" }, async ({ page }) => {
  await startBackend({ crashAfterCommit: true });
  await loopbackOnly(page);
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

test("keeps the user in the editor while a real registration is pending", { tag: "@records-qualification" }, async ({ page }) => {
  const gate = join(parent, "finish-registration");
  await startBackend({ registrationGate: gate });
  await loopbackOnly(page);
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

test("purges an expired object on startup before a direct link can fetch its image", { tag: "@records-qualification" }, async ({ page }) => {
  const clock = join(parent, "startup-clock");
  const managed = join(parent, "records", "media", "old-reference.png");
  writeFileSync(clock, "0");
  await startBackend({ clockOffset: clock });
  await loopbackOnly(page);
  await seedLibrary([["old", "Expired reference", "Lost", Date.now() - 7 * 86_400_000 + 120_000]], ["old"]);
  expect(existsSync(managed)).toBe(true);
  await stopBackend();
  writeFileSync(clock, "180000");
  await startBackend({ clockOffset: clock });
  await waitForStorage();
  expect(existsSync(managed)).toBe(false);
  const { requests } = observe(page);
  await page.goto("/objects/old");
  await expect(page.getByText("Object not found", { exact: true })).toBeVisible();
  await expect(page.getByText("Expired reference", { exact: true })).toHaveCount(0);
  expect(requests.some((request) => request.includes("/media/"))).toBe(false);
});

test("clears expired media on wake and reports failed cleanup through restart and repair", { tag: "@records-qualification" }, async ({ page }) => {
  test.setTimeout(60_000);
  await loopbackOnly(page);
  const clock = join(parent, "retention-clock");
  writeFileSync(clock, "0");
  await startBackend({ clockOffset: clock });
  await seedLibrary([["old", "Due reference", "Lost", Date.now() - 7 * 86_400_000 + 120_000]], ["old"]);

  await page.goto("/objects/old");
  const reference = page.getByRole("img", { name: "Reference for Due reference", exact: true });
  await expect(reference).toHaveAttribute("src", /^blob:/);
  const url = await reference.getAttribute("src");
  await expect(page.getByText("7 days from registration")).toBeVisible();

  const managed = join(parent, "records", "media", "old-reference.png");
  const source = sourceImage();
  const original = readFileSync(source);
  unlinkSync(managed);
  linkSync(source, managed);
  await page.evaluate(() => dispatchEvent(new PageTransitionEvent("pagehide", { persisted: true })));
  await expect(reference).toHaveCount(0);
  expect(await page.evaluate(async (url) => {
    try { await fetch(url!); return true; } catch { return false; }
  }, url)).toBe(false);

  writeFileSync(clock, "180000");
  await page.evaluate(() => dispatchEvent(new PageTransitionEvent("pageshow", { persisted: true })));
  await expect(page.getByText("Record expired", { exact: true })).toBeVisible();
  await expect(page.getByText("Deletion failed", { exact: true })).toBeVisible();
  await expect(page.getByText(/1 object and 1 file remaining/)).toBeVisible();
  await expect(reference).toHaveCount(0);
  await page.goto("/settings");
  await expect(page.getByText("Deletion failed", { exact: true })).toBeVisible();
  await expect(page.getByText("7 days", { exact: true })).toBeVisible();

  await stopBackend();
  await startBackend({ clockOffset: clock });
  await page.goto("/devices");
  await expect(page.getByText("Deletion failed", { exact: true })).toBeVisible();
  expect(existsSync(managed)).toBe(true);
  unlinkSync(managed);
  await expect(page.getByText("Deletion complete", { exact: true })).toBeVisible({ timeout: 12_000 });
  expect(readFileSync(source)).toEqual(original);
  await page.goto("/objects/old");
  await expect(page.getByText("Object not found", { exact: true })).toBeVisible();
  await expect(reference).toHaveCount(0);
});

test("preserves grace during a slow refresh and rejects its stale response after session end", { tag: "@records-qualification" }, async ({ page }) => {
  test.setTimeout(60_000);
  const clock = join(parent, "grace-clock");
  writeFileSync(clock, "0");
  await startBackend({ clockOffset: clock });
  await loopbackOnly(page);
  const started = Date.now() - 1000;
  await seedLibrary([["old", "Graced reference", "Lost", started - 7 * 86_400_000 + 120_000]], ["old"]);
  await page.goto("/settings");
  await page.getByRole("textbox", { name: "Proposed retention in days" }).fill("30");
  await page.getByRole("button", { name: "Preview Change" }).click();
  await page.getByRole("button", { name: "Review Change", exact: true }).click();
  const confirmation = page.getByRole("dialog", { name: "Apply retention change?" });
  await expect(confirmation.getByRole("button", { name: "Confirm and Apply" })).toBeEnabled();

  const database = join(parent, "records", "records.sqlite3");
  execFileSync(python, [
    "-c", "import sqlite3, sys; db = sqlite3.connect(sys.argv[1]); " +
      "db.execute(\"INSERT INTO sessions VALUES ('active','old','Controller','Searching',?,NULL,NULL,'[]',1)\", " +
      "(int(sys.argv[2]),)); db.commit()",
    database, String(started),
  ], { windowsHide: true });
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await expect(page.getByText("Search is Searching", { exact: true })).toBeVisible();
  await expect(confirmation).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Preview Change" })).toBeDisabled();

  execFileSync(python, [
    "-c", "import sqlite3, sys; db = sqlite3.connect(sys.argv[1]); " +
      "db.execute(\"UPDATE sessions SET state='Paused', pause_causes=?, revision=2 WHERE id='active'\", " +
      "('[{\"cause\":\"ManualPause\",\"failure_id\":null}]',)); db.commit()", database,
  ], { windowsHide: true });
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await expect(page.getByText("Search is Paused", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Preview Change" })).toBeDisabled();
  writeFileSync(clock, "180000");
  await page.goto("/objects/old");
  const image = page.getByRole("img", { name: "Reference for Graced reference", exact: true });
  await expect(page.getByText("Active-session grace", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Start Search" })).toBeDisabled();
  await expect(image).toHaveAttribute("src", /^blob:/);
  const url = await image.getAttribute("src");

  let readHeld = false;
  let releaseRead = () => {};
  const held = new Promise<void>((resolve) => { releaseRead = resolve; });
  await page.route(`${backend}/objects/old`, async (route) => {
    const response = await route.fetch();
    readHeld = response.ok();
    await held;
    await route.fulfill({ response }).catch(() => {});
  }, { times: 1 });
  try {
    await expect.poll(() => readHeld, { timeout: 12_000 }).toBe(true);
    await expect(image).toHaveAttribute("src", url!);
    await expect(page.getByText("Active-session grace", { exact: true })).toBeVisible();

    execFileSync(python, [
      "-c", "import sqlite3, sys; db = sqlite3.connect(sys.argv[1]); " +
        "db.execute(\"UPDATE sessions SET state='Ended', end_reason='Stopped', ended_at_ms=?, pause_causes='[]' " +
        "WHERE id='active'\", (int(sys.argv[2]),)); db.commit()",
      database, String(Date.now() + 180_000),
    ], { windowsHide: true });
    await expect(page.getByText(/^(Record expired|Object not found)$/)).toBeVisible({ timeout: 12_000 });
  } finally {
    releaseRead();
  }
  await expect(image).toHaveCount(0);
  expect(await page.evaluate(async (url) => {
    try { await fetch(url!); return true; } catch { return false; }
  }, url)).toBe(false);
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

test("persists both simulated modes and recovers an interrupted search after service restart", async ({ page }) => {
  test.setTimeout(75_000);
  await startBackend({ simulation: true });
  await selectTarget(page, sourceImage(), "Saved search target");
  await setTargetCoordinates(page);
  await page.getByRole("button", { name: "Register Object" }).click();
  await expect(page.getByRole("heading", { name: "Object Details" })).toBeVisible();
  const objectPath = new URL(page.url()).pathname;
  const { requests } = observe(page);

  async function search(mode: "Gestures" | "PS4 controller") {
    await page.getByRole("link", { name: "Open Search Setup", exact: true }).click();
    await page.getByRole("radio", { name: new RegExp(mode, "i") }).check();
    await page.getByRole("button", { name: "Acquire control" }).click();
    const start = page.getByRole("button", { name: "Start Search" });
    await expect(start).toBeEnabled();
    await start.click();
    await expect(page).toHaveURL(/\/sessions\/[^/]+\/live$/);
    await expect(page.getByRole("heading", { name: "Live Search Workspace" })).toBeVisible();
    await expect(page.getByText(/^Backend simulation · (Disarmed|Arming|Armed)$/)).toBeVisible();
    await expect(page.getByRole("link", { name: "Return to Active Search", exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "Pause", exact: true })).toBeEnabled();
    return new URL(page.url()).pathname.replace(/\/live$/, "");
  }

  // Drop the first HTTP response after the service commits. The ordered operation resolves it.
  await page.route(`${backend}/sessions`, async (route) => {
    const result = await route.fetch();
    expect(result.status()).toBe(201);
    await route.abort();
  }, { times: 1 });
  const first = await search("Gestures");
  await expect(page.getByText("Gestures · Target and mode locked", { exact: true })).toBeVisible();
  const gestureFeedback = page.getByRole("region", { name: "Gesture feedback" });
  await expect(gestureFeedback.getByText("Motion permission · Armed")).toBeVisible();
  await expect(gestureFeedback.getByText("Simulated direction held")).toBeVisible();
  await expect(page.getByRole("status", { name: "Proximity advisory" }).getByText("Obstacle warning active")).toBeVisible();
  await expect(gestureFeedback.getByText("Motion permission · Arming")).toBeVisible();
  await expect(page.getByText("Committed session · Searching")).toBeVisible();
  await page.getByRole("link", { name: "Dashboard", exact: true }).click();
  const leave = page.getByRole("region", { name: "Leave search workspace" });
  await expect(leave.getByRole("button", { name: "Stay", exact: true })).toBeFocused();
  await leave.getByRole("button", { name: "Stay", exact: true }).click();
  await expect(leave).toHaveCount(0);
  await page.getByRole("link", { name: "Dashboard", exact: true }).click();
  await leave.getByRole("button", { name: "Leave Paused", exact: true }).click();
  await expect(page).toHaveURL(frontend + "/");
  await page.getByRole("link", { name: "Return to Active Search", exact: true }).first().click();
  await expect(page).toHaveURL(frontend + first + "/live");
  await expect(page.getByRole("button", { name: "Resume", exact: true })).toBeDisabled();
  await expect(page.getByRole("button", { name: "Stop Search", exact: true })).toBeDisabled();
  await page.getByRole("button", { name: "Acquire control" }).click();
  await page.getByRole("button", { name: "Stop Search", exact: true }).click();
  await expect(page).toHaveURL(frontend + first + "/result");
  await expect(page.getByText("Stopped by operator", { exact: true })).toBeVisible();
  await expect(page.getByText("The object remains Lost.", { exact: true })).toBeVisible();

  await page.goto(objectPath);
  const second = await search("PS4 controller");
  await expect(page.getByText("PS4 DualShock 4 · Target and mode locked", { exact: true })).toBeVisible();
  await expect(page.getByRole("heading", { name: "PS4 controller input" })).toBeVisible();
  await expect(page.getByText("Gesture control inactive")).toBeVisible();
  await expect(page.getByRole("region", { name: "Controller feedback" }).getByText("Motion permission · Armed")).toBeVisible();
  const emergency = page.getByRole("button", { name: "Emergency Stop", exact: true });
  await emergency.focus();
  await page.keyboard.press("Enter");
  await expect(page.getByText("Motion permission revoked", { exact: true })).toBeVisible();
  await expect(page.getByText("Simulated movement stopped", { exact: true })).toBeVisible();
  await expect(page.getByText("Saved", { exact: true })).toBeVisible();

  await stopBackend();
  await startBackend({ simulation: true });
  await page.reload();
  await expect(page.getByText("Search has ended", { exact: true })).toBeVisible();
  await page.getByRole("link", { name: "View Search Result" }).click();
  await expect(page).toHaveURL(frontend + second + "/result");
  await expect(page.getByText("Interrupted", { exact: true })).toBeVisible();
  await expect(page.getByText("The object remains Lost.", { exact: true })).toBeVisible();
  await page.goto(objectPath);
  await expect(page.locator(`a[href="${first}"]`)).toBeVisible();
  await expect(page.locator(`a[href="${second}"]`)).toBeVisible();
  expect(requests.filter((request) => request === "POST /api/v1/sessions")).toHaveLength(2);
});

test("recovers the same saved search deliberately after an emergency, reload and an event gap", async ({ page }) => {
  test.setTimeout(75_000);
  const stopGate = join(parent, "finish-stop");
  await startBackend({ simulation: true, stopGate });
  await observePreviewFrames(page);
  const { requests, sockets } = observe(page);
  await selectTarget(page, sourceImage(), "Recovery target");
  await setTargetCoordinates(page);
  await page.getByRole("button", { name: "Register Object" }).click();
  await page.getByRole("link", { name: "Open Search Setup" }).click();
  await page.getByRole("radio", { name: /PS4 controller/i }).check();
  const button = (name: string) => page.getByRole("button", { name, exact: true });
  await button("Acquire control").click();
  await button("Start Search").click();
  await expect(page).toHaveURL(/\/sessions\/[^/]+\/live$/);
  const url = page.url();
  const resume = button("Resume");
  const recovery = page.getByRole("region", { name: "Recovery" });
  const activity = page.getByRole("region", { name: "Session activity" });
  const feedback = page.getByRole("region", { name: "Controller feedback" });
  const count = (suffix: string) => requests.filter((request) => request.startsWith("POST ") && request.endsWith(suffix)).length;
  async function resumeSavedSearch() {
    const saved = page.waitForResponse((response) => response.url().endsWith("/actions") &&
      response.request().method() === "POST" && response.request().postDataJSON()?.action === "resume",
    { timeout: 10_000 });
    await resume.click();
    const response = await saved;
    expect(response.ok(), await response.text()).toBe(true);
    await expect(activity).toContainText("Committed session · Searching");
  }

  await button("Pause").click();
  await expect(activity).toContainText("Committed session · Paused");
  await button("Recovery").click();
  await expect(recovery).toContainText("Paused by operator.");
  await resumeSavedSearch();
  await expect(feedback.getByText("Motion permission · Armed")).toBeVisible();
  await button("Emergency Stop").focus();
  await page.keyboard.press("Enter");
  await expect(activity).toContainText("Committed session · Paused");
  await expect(feedback).toContainText("Motion permission · Disarmed");

  await page.reload();
  await expect(page).toHaveURL(url);
  await expect(button("Acquire control")).toBeEnabled();
  await expect(resume).toBeDisabled();
  await expect(recovery.getByText("Awaiting restoration · Awaiting acknowledgment")).toBeVisible();
  expect(count("/control-lease")).toBe(1);
  expect(count("/actions")).toBe(2);
  await button("Acquire control").click();
  await expect(recovery.getByText("Restored · Awaiting acknowledgment")).toBeVisible();
  await expect(resume).toBeDisabled();
  await recovery.getByRole("button", { name: "Acknowledge", exact: true }).click();
  await resumeSavedSearch();

  const eventConnections = () => sockets.filter((socket) => socket.endsWith("/events")).length;
  const beforeGap = eventConnections();
  await page.evaluate(() => {
    const probe = (window as unknown as PreviewWindow).previewProbe;
    const recent = JSON.parse(probe.initialSnapshot!);
    probe.events!.dispatchEvent(new MessageEvent("message", { data: JSON.stringify({
      ...recent, type: "readiness_changed", event_seq: recent.event_seq + 100_000,
      session_id: null, session_revision: null,
      payload: { readiness: recent.payload.readiness, runtime: recent.payload.runtime },
    }) }));
  });
  await expect(button("Acquire control")).toBeEnabled();
  await expect.poll(eventConnections).toBeGreaterThan(beforeGap);
  await expect(activity).toContainText("Committed session · Paused");
  await expect(resume).toBeDisabled();
  await expect(button("Emergency Stop")).toBeEnabled();
  await expect(button("Control Help")).toBeEnabled();
  expect(count("/control-lease")).toBe(2);
  expect(count("/actions")).toBe(4);
  await button("Acquire control").click();
  // A gap tears down the event stream and its display together. Either required
  // path can reach the backend first and revoke the same lease.
  await expect(recovery.getByRole("strong").filter({
    hasText: /^(Workspace disconnected|Robot camera unavailable|Displayed robot video stale)$/,
  }).first()).toBeVisible();
  await expect(recovery.getByText("Restored · Awaiting acknowledgment")).toBeVisible();
  await recovery.getByRole("button", { name: "Acknowledge", exact: true }).click();
  await resumeSavedSearch();
  await expect(page).toHaveURL(url);
  await expect(page.getByRole("region", { name: "Active search target" })).toContainText("Recovery target");
  await expect(page.getByText("PS4 DualShock 4 · Target and mode locked")).toBeVisible();
  expect(requests.filter((request) => request === "POST /api/v1/sessions")).toHaveLength(1);
  await button("Pause").click();
  await expect(activity).toContainText("Committed session · Paused");
  await button("Stop Search").click();
  try {
    await expect(page.getByText("Save pending", { exact: true })).toBeVisible();
    await expect(page.getByRole("region", { name: "Control ownership" })).toContainText("This workspace holds control.");
    await expect(resume).toBeDisabled();
    await page.route(`${backend}/emergency-stop`, (route) => route.abort("failed"), { times: 1 });
    await button("Emergency Stop").press("Enter");
    await expect(page.getByText("Emergency Stop could not be confirmed", { exact: true })).toBeVisible();
    let delivered = false;
    let releaseEmergency = () => {};
    const held = new Promise<void>((resolve) => { releaseEmergency = resolve; });
    await page.route(`${backend}/emergency-stop`, async (route) => {
      const response = await route.fetch();
      delivered = (await response.json()).permission_revoked;
      await held;
      await route.fulfill({ response });
    }, { times: 1 });
    try {
      await button("Emergency Stop").press("Enter");
      await expect.poll(() => delivered).toBe(true);
      await page.evaluate(() => window.dispatchEvent(new Event("online")));
      await expect(page.getByText("Sending Emergency Stop request", { exact: true })).toBeVisible();
    } finally {
      releaseEmergency();
    }
    await expect(page.getByText("Motion permission revoked", { exact: true })).toBeVisible();
    await expect(feedback).toContainText("Motion permission · Disarmed");
  } finally {
    writeFileSync(stopGate, "");
  }
  await button("Acquire control").click();
  await button("Stop Search").click();
  await expect(page).toHaveURL(url.replace(/\/live$/, "/result"));
});

test("marks the last connected Workspace frame Not live and stops a held command", async ({ page }) => {
  test.setTimeout(45_000);
  await startBackend({ simulation: true });
  await observePreviewFrames(page);
  await selectTarget(page, sourceImage(), "Stale display target");
  await setTargetCoordinates(page);
  await page.getByRole("button", { name: "Register Object" }).click();
  await page.getByRole("link", { name: "Open Search Setup" }).click();
  await page.getByRole("button", { name: "Acquire control" }).click();
  await page.getByRole("button", { name: "Start Search" }).click();
  const feedback = page.getByRole("region", { name: "Gesture feedback" });
  await expect(feedback.getByText("Motion permission · Armed")).toBeVisible();
  const robot = page.getByRole("region", { name: "Robot camera" });
  const canvas = robot.locator("canvas");
  const pixels = await canvas.evaluate((element: HTMLCanvasElement) => element.toDataURL());
  await page.evaluate(() => { (window as unknown as PreviewWindow).previewProbe.repeatFrames = true; });
  await expect(robot.getByText("Not live", { exact: true })).toBeVisible();
  expect(await canvas.evaluate((element: HTMLCanvasElement) => element.toDataURL())).toBe(pixels);
  await expect(feedback.getByText("Motion permission · Disarmed", { exact: true })).toBeVisible();
  await expect(page.getByText("Committed session · Paused")).toBeVisible();
  await expect(page.getByRole("strong").filter({ hasText: /^(Displayed robot video stale|Workspace unusable)$/ })).toBeVisible();
  await page.evaluate(() => { (window as unknown as PreviewWindow).previewProbe.repeatFrames = false; });
  await expect(robot.getByText("Live sample", { exact: true })).toBeVisible();
  await expect(feedback.getByText("Motion permission · Disarmed", { exact: true })).toBeVisible();
});

async function startReviewSearch(page: Page, mode: "Gestures" | "PS4 controller") {
  await selectTarget(page, sourceImage(), "Review target");
  await setTargetCoordinates(page);
  await page.getByRole("button", { name: "Register Object" }).click();
  return startSavedSearch(page, mode);
}

async function startSavedSearch(page: Page, mode: "Gestures" | "PS4 controller") {
  await page.getByRole("link", { name: "Open Search Setup" }).click();
  await page.getByRole("radio", { name: mode }).check();
  await page.getByRole("button", { name: "Acquire control" }).click();
  await page.getByRole("button", { name: "Start Search" }).click();
  await expect(page).toHaveURL(/\/sessions\/[^/]+\/live$/);
  return new URL(page.url()).pathname.replace(/\/live$/, "");
}

test("blocks Gestures without the selected webcam and keeps Controller available", async ({ page }) => {
  await startBackend({ gestures: {} });
  await selectTarget(page, sourceImage(), "Webcam readiness");
  await setTargetCoordinates(page);
  await page.getByRole("button", { name: "Register Object" }).click();
  await page.getByRole("link", { name: "Open Search Setup" }).click();
  await page.getByRole("radio", { name: "Gestures" }).check();
  await page.getByRole("button", { name: "Acquire control" }).click();
  const start = page.getByRole("button", { name: "Start Search" });
  await expect(page.getByText("Local webcam gestures · Simulated robot video, commands and matching")).toBeVisible();
  await expect(start).toBeDisabled();
  await page.getByRole("radio", { name: "PS4 controller" }).check();
  await start.click();
  await expect(page.getByText("Gesture control inactive")).toBeVisible();
  await expect(page.getByText("Simulated controller · Simulated robot video and commands")).toBeVisible();
  await expect(page.getByRole("button", { name: "Emergency Stop", exact: true })).toBeEnabled();
});

test("reports unavailable local DualShock 4 without gating Gestures", async ({ page }) => {
  await startBackend({ localController: true });
  await selectTarget(page, sourceImage(), "Controller readiness");
  await setTargetCoordinates(page);
  await page.getByRole("button", { name: "Register Object" }).click();
  await page.getByRole("link", { name: "Open Search Setup" }).click();
  await page.getByRole("radio", { name: "PS4 controller" }).check();
  await page.getByRole("button", { name: "Acquire control" }).click();
  const start = page.getByRole("button", { name: "Start Search" });
  await expect(page.getByText("Selected USB DualShock 4 · Simulated robot video, commands, matching and gestures")).toBeVisible();
  await expect(page.getByText("Connect the configured DualShock 4 by USB and check that Windows recognizes it.")).toBeVisible();
  await expect(start).toBeDisabled();
  await page.getByRole("link", { name: "View Devices" }).click();
  await expect(page.getByRole("heading", { name: "Selected-mode input" }).locator(".."))
    .toContainText(/PS4 DualShock 4\s*Unavailable/);
  await page.getByRole("link", { name: "Return to Search Setup" }).click();
  await page.getByRole("radio", { name: "Gestures" }).check();
  await page.getByRole("button", { name: "Acquire control" }).click();
  await expect(start).toBeEnabled();
  await start.click();
  await expect(page.getByText("Simulated gestures · Simulated robot video and commands")).toBeVisible();
  await expect(page.getByRole("button", { name: "Emergency Stop", exact: true })).toBeEnabled();
});

test("shows selected DualShock 4 input and emergency recovery in a connected workspace", async ({ page }) => {
  const controllerSamples = join(parent, "controller.txt");
  function sample(...buttons: number[]) {
    const next = `${controllerSamples}.next`;
    writeFileSync(next, [1, ...buttons].join(" "));
    renameSync(next, controllerSamples);
  }
  sample();
  await startBackend({ controllerSamples });
  await selectTarget(page, sourceImage(), "Selected controller replay");
  await setTargetCoordinates(page);
  await page.getByRole("button", { name: "Register Object" }).click();
  await page.getByRole("link", { name: "Open Search Setup" }).click();
  await page.getByRole("radio", { name: "PS4 controller" }).check();
  await page.getByRole("button", { name: "Acquire control" }).click();
  await page.getByRole("button", { name: "Start Search" }).click();
  const input = page.getByRole("region", { name: "Controller feedback" });
  await expect(page.getByText("Selected USB DualShock 4 · Simulated robot video and commands")).toBeVisible();
  await expect(page.getByText("Gesture control inactive")).toBeVisible();
  await expect(input).toContainText("Selected USB DualShock 4 ready");
  await expect(input).toContainText("Motion permission · Arming");
  sample(11);
  await expect(input).toContainText("Motion permission · Armed");
  sample();
  await expect(input).toContainText("Motion permission · Arming");
  sample(12);
  await expect(input).toContainText("Motion permission · Armed");
  sample(12, 1);
  await expect(input).toContainText("Motion permission · Disarmed");
  await expect(input).toContainText("Selected USB DualShock 4 ready");
  await expect(page.getByText("Committed session · Paused")).toBeVisible();
  await expect(page.getByText(/Recovery required before Resume/)).toBeVisible();
  await expect(page.getByRole("button", { name: "Emergency Stop", exact: true })).toBeEnabled();
});

test("receives the selected Windows webcam through the protected mirrored workspace", async ({ page }) => {
  const assets = process.env.LAF_TEST_GESTURE_ASSETS;
  const devicePath = process.env.LAF_TEST_WEBCAM_DEVICE_PATH;
  test.skip(!assets || !devicePath, "Requires the selected Windows camera and pinned Hand Landmarker asset");
  test.setTimeout(45_000);
  await startBackend({ gestures: { assets, devicePath } });
  const { requests, sockets } = observe(page);
  let webcamFrames = 0;
  page.on("websocket", (socket) => {
    if (socket.url().endsWith("/video/webcam")) socket.on("framereceived", () => { webcamFrames++ });
  });
  await page.addInitScript(() => {
    if (navigator.mediaDevices) Object.defineProperty(navigator.mediaDevices, "getUserMedia", {
      value: () => Promise.reject(new Error("Webcam access belongs to the backend")),
    });
  });
  await selectTarget(page, sourceImage(), "Local webcam preview");
  await setTargetCoordinates(page);
  await page.getByRole("button", { name: "Register Object" }).click();
  await page.getByRole("link", { name: "Open Search Setup" }).click();
  await page.getByRole("radio", { name: "Gestures" }).check();
  await page.getByRole("button", { name: "Acquire control" }).click();
  const start = page.getByRole("button", { name: "Start Search" });
  await expect(start).toBeEnabled({ timeout: 20_000 });
  await start.click();
  await expect(page).toHaveURL(/\/sessions\/[^/]+\/live$/);
  const preview = page.getByRole("img", { name: "Mirrored webcam preview and recognition" });
  await expect(preview).toHaveAttribute("width", "640");
  await expect(page.getByText("Live • Mirrored")).toBeVisible();
  await expect(page.getByText("Recognition shown on the mirrored preview", { exact: true })).toBeVisible();
  await expect(page.getByText(/^Motion permission · /)).toBeVisible();
  await expect(page.getByText(/Simulated AI matching active/)).toBeVisible();
  await expect(page.getByRole("button", { name: "Emergency Stop", exact: true })).toBeEnabled();
  expect(sockets).toContain("ws://127.0.0.1:8110/api/v1/video/webcam");
  expect(requests.filter((request) => request.includes("/video/webcam"))).toEqual([]);
  await expect.poll(() => webcamFrames).toBeGreaterThanOrEqual(8);
  await expect(page.getByText("Committed session · Searching")).toBeVisible();
});

test("shows unavailable offline assets in Search Setup and Devices", async ({ page }) => {
  await startBackend({ yoloe: { assets: join(parent, "missing-assets") } });
  await selectTarget(page, sourceImage(), "Matcher diagnostics");
  await setTargetCoordinates(page);
  await page.getByRole("button", { name: "Register Object" }).click();
  await page.getByRole("link", { name: "Open Search Setup" }).click();
  const diagnostic = "Check the local YOLOE checkpoint or saved reference.";
  await expect(page.getByText(diagnostic, { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Start Search", exact: true })).toBeDisabled();
  await page.getByRole("link", { name: "View Devices" }).click();
  const matcher = page.locator("summary").filter({ hasText: "Local matching service" });
  await expect(matcher).toContainText("Unavailable");
  await matcher.click();
  await expect(page.getByText(diagnostic, { exact: true })).toBeVisible();
});

test("Phase 06 reports an unavailable recording without losing local records", async ({ page }) => {
  await startBackend({ phase06: "production" });
  await page.goto("/devices");
  await expect(page.getByText("Offline YOLOE and local input devices · Recorded robot video and simulated commands")).toBeVisible();
  const camera = page.locator("summary").filter({ hasText: "Robot camera" });
  await expect(camera).toContainText("Unavailable");
  await camera.click();
  await expect(camera.locator("..")).toContainText("Check that the configured robot recording is valid and readable");
  await page.getByRole("link", { name: "Objects / History" }).click();
  await expect(page.getByRole("link", { name: "Register Object", exact: true }).first()).toBeVisible();
});

test("reviews and confirms an offline YOLOE match from a recorded robot frame", async ({ page }, info) => {
  const selection = process.env.LAF_TEST_YOLOE_ASSETS;
  test.skip(!selection, "Requires the pinned Windows CUDA environment and local probe assets");
  if (!selection) return;
  test.setTimeout(155_000);
  const assets = resolve(selection);
  const matches: Match[] = [];
  page.on("websocket", (socket) => {
    if (!socket.url().endsWith("/events")) return;
    socket.on("framereceived", ({ payload }) => {
      if (typeof payload !== "string") return;
      const event = JSON.parse(payload);
      if (event.type === "candidate_pending") matches.push(event.payload.match);
    });
  });
  const robot = join(parent, "recorded-robot.jpg");
  execFileSync(python, ["-c",
    "import sys; from PIL import Image; im = Image.open(sys.argv[1]); im.thumbnail((640, 480)); im.save(sys.argv[2], quality=88)",
    join(assets, "zidane.jpg"), robot,
  ], { windowsHide: true });
  await loopbackOnly(page);
  await startBackend({ yoloe: { assets, robot } });
  await selectTarget(page, join(assets, "bus.jpg"), "Recorded visual prompt");
  await setTargetCoordinates(page, ["50", "390", "190", "510"]);
  await page.getByRole("button", { name: "Register Object" }).click();
  await page.getByRole("link", { name: "Open Search Setup" }).click();
  await expect(page.getByText("Offline YOLOE · Simulated robot video, commands and input")).toBeVisible();
  await page.getByRole("radio", { name: "PS4 controller" }).check();
  await page.getByRole("button", { name: "Acquire control" }).click();
  const start = page.getByRole("button", { name: "Start Search", exact: true });
  await expect(start).toBeEnabled({ timeout: 100_000 });
  await start.click();
  await expect(page).toHaveURL(/\/sessions\/[^/]+\/live$/);
  const panel = page.getByRole("region", { name: "Review potential match" });
  const evidence = panel.getByRole("img", { name: "Captured evidence", exact: true });
  await expect(evidence).toBeVisible({ timeout: 10_000 });
  expect(matches).toHaveLength(1);
  const { box, evidence_media: media } = matches[0];
  const overlay = await evidence.locator("+ span").evaluate((element) =>
    ["left", "top", "width", "height"].map((property) =>
      parseFloat((element as HTMLElement).style.getPropertyValue(property))));
  expect(overlay[0]).toBeCloseTo(100 * box.x / media.width, 3);
  expect(overlay[1]).toBeCloseTo(100 * box.y / media.height, 3);
  expect(overlay[2]).toBeCloseTo(100 * box.width / media.width, 3);
  expect(overlay[3]).toBeCloseTo(100 * box.height / media.height, 3);
  await expect(page.getByText("Motion permission · Disarmed", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Emergency Stop" })).toBeVisible();
  const pixels = await evidence.evaluate(async (img: HTMLImageElement) => {
    const canvas = document.createElement("canvas");
    canvas.width = img.naturalWidth;
    canvas.height = img.naturalHeight;
    const context = canvas.getContext("2d");
    if (!context) throw new Error("Canvas unavailable");
    context.drawImage(img, 0, 0);
    const data = context.getImageData(0, 0, canvas.width, canvas.height);
    return Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", data.data)));
  });
  const expected = execFileSync(python, ["-c",
    "import hashlib, json, sys; from PIL import Image; print(json.dumps(list(hashlib.sha256(Image.open(sys.argv[1]).convert('RGBA').tobytes()).digest())))",
    robot,
  ], { encoding: "utf8", windowsHide: true });
  expect(pixels).toEqual(JSON.parse(expected));
  await page.screenshot({ path: info.outputPath("offline-yoloe-review.png") });
  await panel.getByRole("button", { name: "Confirm Match" }).click();
  await expect(page.getByRole("heading", { name: "Match confirmed and saved" })).toBeVisible();
  await stopBackend();
  await startBackend();
  await page.reload();
  await expect(page.getByRole("heading", { name: "Match confirmed and saved" })).toBeVisible();
  await expect(page.getByRole("img", { name: "Captured evidence", exact: true })).toBeVisible();
});

type Phase06State = {
  scene: string | null;
  sequence?: number;
  frames?: string[];
  buttons?: number[] | null;
  mask?: number | null;
  worker_stalled?: "exchange" | "reply" | false;
  writer_stalled?: boolean;
  evidence_stalled?: boolean;
};
type ReplayTrace = {
  kind: string; at: number; event?: string; output?: string | null; cause?: string;
  scene?: string; frame?: number; frame_id?: string; stream?: string; match?: boolean;
  box?: [number, number, number, number] | null;
  reentered?: boolean;
};

function phase06Trace(): ReplayTrace[] {
  const path = join(parent, "trace.jsonl");
  if (!existsSync(path)) return [];
  const lines = readFileSync(path, "utf8").split("\n");
  return lines.slice(0, -1).map((line) => JSON.parse(line) as ReplayTrace);
}

async function openPhase06(page: Page, assets: string, mode: "gestures" | "controller" | "native-landmarker") {
  const positive = join(parent, "positive.jpg");
  execFileSync(python, ["-c", [
    "import sys", "from pathlib import Path", "from PIL import Image",
    "source, directory = map(Path, sys.argv[1:])",
    "recorded = Image.open(source).convert('RGB')",
    "recorded.thumbnail((640, 480))",
    "recorded.save(directory / 'positive.jpg', quality=88)",
    "Image.new('RGB', recorded.size, (45, 45, 45)).save(directory / 'negative.jpg', quality=88)",
    "target = recorded.crop((360, 0, 584, 360))",
    "clear = recorded.copy()",
    "clear.paste((45, 45, 45), (360, 0, 584, 360))",
    "clear.save(directory / 'clear.jpg', quality=88)",
    "for offset in (32, 64, 96, 128, 160, 208):",
    "    scene = clear.copy()",
    "    scene.paste(target, (360 + offset, 0))",
    "    scene.save(directory / f'shift{offset}.jpg', quality=88)",
  ].join("\n"), join(assets, "zidane.jpg"), parent], { windowsHide: true });
  const state: Phase06State = { scene: "negative", mask: 0, buttons: [] };
  function replay(change: Partial<Phase06State> = {}) {
    Object.assign(state, change);
    appendFileSync(join(parent, "state.jsonl"), JSON.stringify(state) + "\n");
  }
  replay();
  await loopbackOnly(page);
  await observePreviewFrames(page);
  await page.addInitScript(() => {
    const draw = CanvasRenderingContext2D.prototype.drawImage;
    let frames = 0;
    CanvasRenderingContext2D.prototype.drawImage = function (...args: unknown[]) {
      Reflect.apply(draw, this, args);
      if (this.canvas.getAttribute("aria-label") === "Recorded robot camera view") frames++;
    };
    Object.defineProperty(window, "phase06DrawCount", { get: () => frames });
  });
  const matches: Match[] = [];
  const frames = new Map<string, FrameMetadata>();
  page.on("websocket", (socket) => {
    if (socket.url().endsWith("/events")) {
      socket.on("framereceived", ({ payload }) => {
        if (typeof payload !== "string") return;
        const event = JSON.parse(payload);
        if (event.type === "candidate_pending") matches.push(event.payload.match);
      });
    } else if (socket.url().endsWith("/video/robot")) {
      socket.on("framereceived", ({ payload }) => {
        if (typeof payload === "string" || payload.length < 4) return;
        const size = payload.readUInt32BE(0);
        const metadata = JSON.parse(payload.subarray(4, 4 + size).toString("utf8")) as FrameMetadata;
        frames.set(metadata.frame_id, metadata);
      });
    }
  });
  await startBackend({ phase06: mode, yoloe: { assets, robot: positive }, gestures: { assets } });
  await selectTarget(page, join(assets, "bus.jpg"), `Integrated ${mode} search`);
  await setTargetCoordinates(page, ["50", "390", "190", "510"]);
  await page.getByRole("button", { name: "Register Object" }).click();
  await page.getByRole("link", { name: "Open Search Setup" }).click();
  await expect(page.getByText("Offline YOLOE · Recorded robot video and simulated commands")).toBeVisible();
  const selected = mode === "controller" ? "PS4 controller" : "Gestures";
  await page.getByRole("radio", { name: selected === "Gestures" ? "PS4 controller" : "Gestures" }).check();
  const start = page.getByRole("button", { name: "Start Search", exact: true });
  await expect.poll(() => phase06Trace().some(({ kind }) => kind === "ready"), { timeout: 100_000 }).toBe(true);
  await expect(page.getByText(selected === "Gestures"
    ? "Connect the configured DualShock 4 by USB and check that Windows recognizes it."
    : "Check the selected Windows webcam, camera access, and the local Hand Landmarker installation.",
  { exact: true })).toBeVisible();
  await expect(start).toBeDisabled();
  await page.getByRole("radio", { name: selected }).check();
  await page.getByRole("button", { name: "Acquire control", exact: true }).click();
  await expect(start).toBeEnabled({ timeout: 20_000 });
  await start.click();
  await expect(page).toHaveURL(/\/sessions\/[^/]+\/live$/);
  return { replay, matches, frames, positive, session: new URL(page.url()).pathname.replace(/\/live$/, "") };
}

async function recordPhase06Workload(page: Page, info: TestInfo, duration: number) {
  const clock = () => page.evaluate(() => ({
    at: performance.now(),
    displayed: (window as unknown as { phase06DrawCount: number }).phase06DrawCount,
  }));
  const firstDrawing = await clock();
  const firstSample = phase06Trace().at(-1)?.at ?? 0;
  await expect.poll(() => page.evaluate(() => performance.now()), { timeout: duration + 4000, intervals: [1000] })
    .toBeGreaterThanOrEqual(firstDrawing.at + duration);
  const lastDrawing = await clock();
  const trace = phase06Trace();
  const window = trace.filter(({ at }) => at >= firstSample);
  expect(window.filter(({ kind }) => kind === "inference").length).toBeGreaterThan(10);
  expect(lastDrawing.displayed - firstDrawing.displayed).toBeGreaterThan(10);
  const path = join(parent, "combined-workload.json");
  writeFileSync(path, JSON.stringify({ firstDrawing, lastDrawing, firstSample, lastSample: trace.at(-1)?.at }));
  await info.attach("combined-workload", { path, contentType: "application/json" });
}

for (const mode of ["gestures", "controller"] as const) {
  test(`Phase 06 ${mode} replay runs the integrated saved search offline`, async ({ page }, info) => {
    const assetPath = process.env.LAF_TEST_PHASE06_ASSETS;
    test.skip(!assetPath, "Requires the pinned local Windows CUDA and MediaPipe assets");
    if (!assetPath) return;
    test.setTimeout(230_000);
    const assets = resolve(assetPath);
    const { replay, matches, frames, positive, session } = await openPhase06(page, assets, mode);
    const button = (name: string) => page.getByRole("button", { name, exact: true });
    const permission = (value: string) => page.getByText(`Motion permission · ${value}`, { exact: true });
    const searching = page.getByText("Committed session · Searching", { exact: true });
    const paused = page.getByText("Committed session · Paused", { exact: true });
    const robot = page.getByRole("region", { name: "Robot camera" });
    const review = page.getByRole("region", { name: "Review potential match" });
    const gestures = mode === "gestures";
    const neutral = gestures ? { mask: 0 } : { buttons: [] };
    const held = (index: number) => gestures ? { mask: [1, 3, 7, 15][index] } : { buttons: [11 + index] };
    const logicalOutput = () => phase06Trace().filter(({ kind }) => kind === "command").at(-1)?.output;
    const stoppedFor = (cause: string) => phase06Trace().some((row) =>
      row.kind === "command" && row.event === "stop" && row.cause === cause);
    const emergencyWhileBlocked = async (barrier: "worker_stalled" | "writer_stalled", offset: number, deadline: number) => {
      const current = () => phase06Trace().slice(offset);
      await expect.poll(() => current().some(({ kind }) => kind === barrier)).toBe(true);
      if (gestures) await button("Emergency Stop").press("Enter");
      else replay({ buttons: [13, 1] });
      await expect.poll(() => current().some(({ kind, event, cause }) =>
        kind === "command" && event === "stop" && cause === "EmergencyStop")).toBe(true);
      const rows = current();
      const entered = rows.find(({ kind }) => kind === barrier)!;
      const stop = rows.find(({ kind, event, cause }) =>
        kind === "command" && event === "stop" && cause === "EmergencyStop")!;
      expect(stop.at - entered.at).toBeGreaterThanOrEqual(0);
      expect(stop.at - entered.at).toBeLessThan(deadline);
      expect(rows.some(({ kind, at }) => kind === `${barrier}_released` && at <= stop.at)).toBe(false);
      await expect(permission("Disarmed")).toBeVisible();
      await expect.poll(logicalOutput).toBe(null);
    };
    const hold = async (index: number) => {
      replay(neutral);
      await expect(permission("Arming")).toBeVisible();
      const samples = () => phase06Trace().filter(({ kind }) => kind === (gestures ? "gesture" : "capture")).length;
      const initial = samples();
      await expect.poll(samples, { intervals: [80] }).toBeGreaterThanOrEqual(initial + (gestures ? 6 : 2));
      replay(held(index));
      await expect.poll(logicalOutput).toBe(["forward", "backward", "left", "right"][index]);
      await expect(permission("Armed")).toBeVisible();
    };
    const recover = async () => {
      await expect(robot.getByText("Live sample", { exact: true })).toBeVisible();
      if (await button("Acquire control").isVisible()) await button("Acquire control").click();
      await expect(button("Acknowledge")).toBeEnabled();
      await button("Acknowledge").click();
      await expect(button("Resume")).toBeEnabled();
      await button("Resume").click();
      await expect(searching).toBeVisible();
      await expect(permission("Disarmed")).toBeVisible();
      expect(logicalOutput()).toBe(null);
    };
    try {
      await expect(robot.getByRole("img", { name: "Recorded robot camera view" })).toBeVisible();
      await expect(page.getByText(/Offline YOLOE matching active/)).toBeVisible();
      if (gestures) {
        await expect(page.getByRole("img", { name: "Mirrored webcam preview and recognition" })).toBeVisible();
      } else {
        await expect(page.getByText("Gesture control inactive", { exact: true })).toBeVisible();
      }
      await button("Control Help").click();

      if (!gestures) await recordPhase06Workload(page, info, 10_000);
      await expect(page.getByRole("region", { name: "Control Help" })).toBeVisible();
      await expect(button("Emergency Stop")).toBeEnabled();
      await button("Control Help").click();

      for (const index of [0, 1, 2, 3]) {
        await hold(index);
        replay(neutral);
        await expect.poll(logicalOutput).toBe(null);
      }
      await hold(0);
      await button("Pause").click();
      await expect(paused).toBeVisible();
      await expect.poll(logicalOutput).toBe(null);
      await button("Resume").click();
      await expect(searching).toBeVisible();
      await expect(permission("Disarmed")).toBeVisible();
      await hold(0);

      replay(gestures ? { mask: null } : { buttons: null });
      await expect(paused).toBeVisible();
      await expect.poll(logicalOutput).toBe(null);
      await expect(permission("Disarmed")).toBeVisible();
      replay(held(0));
      await recover();
      await hold(1);

      if (gestures) {
        replay({ scene: null });
        await expect(paused).toBeVisible();
        await expect.poll(() => stoppedFor("RobotVideoLost")).toBe(true);
        replay({ scene: "negative" });
        await recover();
        await hold(1);
      }
      await page.evaluate(() => { (window as unknown as PreviewWindow).previewProbe.repeatFrames = true; });
      await expect(robot.getByText("Not live", { exact: true })).toBeVisible();
      await expect(paused).toBeVisible();
      await expect.poll(logicalOutput).toBe(null);
      await page.evaluate(() => { (window as unknown as PreviewWindow).previewProbe.repeatFrames = false; });
      await recover();
      await hold(2);

      if (!gestures) {
        // Block a worker exchange for a known positive frame. The deadline
        // must revoke permission while the exchange remains blocked.
        replay({ worker_stalled: "exchange", scene: "positive" });
        await expect.poll(() => phase06Trace().some(({ kind }) => kind === "worker_stalled")).toBe(true);
        await expect(paused).toBeVisible();
        await expect.poll(() => stoppedFor("AIUnavailable")).toBe(true);
        expect(matches).toHaveLength(0);
        replay({ worker_stalled: false, scene: "negative" });
        await expect(page.getByText("Restored · Awaiting acknowledgment")).toBeVisible({ timeout: 100_000 });
        await recover();
        await hold(2);
        await page.evaluate(() => window.dispatchEvent(new Event("blur")));
        await expect(paused).toBeVisible();
        await expect.poll(() => stoppedFor("WorkspaceUnfocused")).toBe(true);
        await page.evaluate(() => window.dispatchEvent(new Event("focus")));
        await recover();
        await hold(2);
      }

      // Hold an ordinary registration writer independently of the active search.
      const boot = await page.request.get(`${backend}/bootstrap`, { headers: { Origin: frontend } });
      const { capability, client_id } = await boot.json();
      const writerOffset = phase06Trace().length;
      replay({ writer_stalled: true });
      const writing = page.request.post(`${backend}/objects`, {
        headers: { Origin: frontend, "X-App-Capability": capability, "X-App-Client-Id": client_id,
          "X-Action-Created-At-Ms": String(Date.now()) },
        multipart: {
          action_id: crypto.randomUUID(), name: "Writer replay", roi: JSON.stringify({ x: 10, y: 20, width: 40, height: 50 }),
          reference_image: { name: "reference.jpg", mimeType: "image/jpeg", buffer: readFileSync(positive) },
        },
      });
      try {
        const accepted = await writing;
        expect(accepted.status(), await accepted.text()).toBe(202);
        await emergencyWhileBlocked("writer_stalled", writerOffset, 4);
        if (gestures) await expect(page.getByText("Save pending", { exact: true })).toBeVisible();
      } finally {
        replay({ ...held(2), writer_stalled: false });
      }
      await expect(paused).toBeVisible();
      await recover();

      await hold(2);
      const replyOffset = phase06Trace().length;
      replay({ worker_stalled: "reply", scene: "positive" });
      try {
        await emergencyWhileBlocked("worker_stalled", replyOffset, 2.5);
      } finally {
        replay({ ...held(2), scene: "negative", worker_stalled: false });
      }
      await expect.poll(() => phase06Trace().slice(replyOffset).some(({ kind }) => kind === "worker_returned")).toBe(true);
      await expect(paused).toBeVisible();
      await expect(review).toHaveCount(0);
      expect(matches).toHaveLength(0);
      await recover();

      await hold(0);
      const reviewStarted = performance.now();
      const candidateOffset = phase06Trace().length;
      replay({ scene: "positive", evidence_stalled: true });
      try {
        await expect.poll(() => phase06Trace().slice(candidateOffset).some(({ kind }) => kind === "evidence_stalled")).toBe(true);
        await expect.poll(logicalOutput).toBe(null);
        await expect(review).toHaveCount(0);
        replay({ scene: "negative" });
        await expect.poll(() => phase06Trace().slice(candidateOffset).some(({ kind, scene }) =>
          kind === "capture" && scene === "negative")).toBe(true);
        await expect.poll(() => robot.locator("canvas").evaluate((canvas: HTMLCanvasElement) => {
          const pixel = canvas.getContext("2d")!.getImageData(320, 180, 1, 1).data;
          return Array.from(pixel);
        })).toEqual([45, 45, 45, 255]);
      } finally {
        replay({ evidence_stalled: false });
      }
      const evidence = review.getByRole("img", { name: "Captured evidence", exact: true });
      await expect(evidence).toBeVisible({ timeout: 12_000 });
      const reviewTiming = join(parent, "candidate-timing.json");
      writeFileSync(reviewTiming, JSON.stringify({ firstVisibleMs: performance.now() - reviewStarted }));
      await info.attach("candidate-timing", { path: reviewTiming, contentType: "application/json" });
      expect(matches).toHaveLength(1);
      await expect(permission("Disarmed")).toBeVisible();
      await expect(button("Emergency Stop")).toBeEnabled();
      const firstMatch = matches[0];
      const { evidence_media: media, box } = firstMatch;
      const analyzed = phase06Trace().find(({ kind, frame_id }) => kind === "inference" && frame_id === firstMatch.frame_id);
      expect(analyzed).toEqual(expect.objectContaining({ stream: firstMatch.stream_epoch, match: true }));
      expect(analyzed?.box).toBeTruthy();
      const [left, top, right, bottom] = analyzed!.box!;
      expect(box).toEqual({
        x: Math.floor(left), y: Math.floor(top),
        width: Math.ceil(right) - Math.floor(left), height: Math.ceil(bottom) - Math.floor(top),
      });
      await expect.poll(() => frames.has(firstMatch.frame_id)).toBe(true);
      const metadata = frames.get(firstMatch.frame_id)!;
      expect(metadata).toMatchObject({ width: media.width, height: media.height, stream_epoch: firstMatch.stream_epoch });
      // The header derives elapsed age from the Windows monotonic clock,
      // while both public timestamps sample the wall clock separately.
      const transportCaptureTime = metadata.received_at_ms - metadata.capture_age_bound_ms;
      expect(Math.abs(transportCaptureTime - firstMatch.captured_at_ms)).toBeLessThanOrEqual(32);
      const overlay = await evidence.locator("+ span").evaluate((element) =>
        ["left", "top", "width", "height"].map((property) =>
          parseFloat((element as HTMLElement).style.getPropertyValue(property))));
      for (const [index, value] of [box.x / media.width, box.y / media.height, box.width / media.width, box.height / media.height].entries()) {
        expect(overlay[index]).toBeCloseTo(100 * value, 3);
      }
      const denied = await page.request.get(`${backend}/media/${media.id}`, { headers: { Origin: frontend } });
      expect(denied.status()).toBe(403);
      const actual = await evidence.evaluate(async (image: HTMLImageElement) => {
        const canvas = document.createElement("canvas");
        canvas.width = image.naturalWidth;
        canvas.height = image.naturalHeight;
        const context = canvas.getContext("2d")!;
        context.drawImage(image, 0, 0);
        const rgba = context.getImageData(0, 0, canvas.width, canvas.height).data;
        return Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", rgba)));
      });
      const expected = execFileSync(python, ["-c",
        "import hashlib,json,sys; from PIL import Image; print(json.dumps(list(hashlib.sha256(Image.open(sys.argv[1]).convert('RGBA').tobytes()).digest())))",
        positive,
      ], { encoding: "utf8", windowsHide: true });
      expect(actual).toEqual(JSON.parse(expected));
      if (gestures) await review.getByRole("button", { name: "Confirm Match", exact: true }).click();
      else {
        replay({ scene: "positive" });
        await review.getByRole("button", { name: "Reject Match", exact: true }).click();
        await expect(review).toHaveCount(0);
        await button("Resume").click();
        await expect(searching).toBeVisible();
        const inferenceBefore = phase06Trace().filter(({ kind }) => kind === "inference").length;
        await expect.poll(() => phase06Trace().filter(({ kind }) => kind === "inference").length)
          .toBeGreaterThanOrEqual(inferenceBefore + 4);
        expect(matches).toHaveLength(1);
        await button("Pause").click();
        await expect(paused).toBeVisible();
        const shifts = [32, 64, 96, 128, 160, 208].map((offset) => `shift${offset}`);
        const twice = (frames: string[]) => frames.flatMap((frame) => [frame, frame]);
        const witnessedReturn = () => phase06Trace().some(({ reentered }) => reentered === true);
        for (const pass of [1, 2, 3]) {
          const first = phase06Trace().length;
          const captures = (scene: string) => phase06Trace().slice(first)
            .filter((row) => row.kind === "capture" && row.scene === scene).length;
          replay({ sequence: pass * 2 - 1, frames: twice(["positive", ...shifts]), scene: "clear" });
          await expect.poll(() => captures("clear")).toBeGreaterThanOrEqual(3);
          expect(matches).toHaveLength(1);
          replay({ sequence: pass * 2, frames: twice([...shifts].reverse()), scene: "positive" });
          await expect.poll(() => captures("positive")).toBeGreaterThanOrEqual(6);
          // A dropped acquisition can invalidate one crossing. Start a fresh
          // complete pass while disarmed if the tracker had to stay suppressed.
          if (witnessedReturn()) break;
        }
        expect(witnessedReturn()).toBe(true);
        expect(matches).toHaveLength(1);
        await button("Resume").click();
        await expect(review).toBeVisible({ timeout: 15_000 });
        expect(matches).toHaveLength(2);
        expect(matches[1].id).not.toBe(matches[0].id);
        await review.getByRole("button", { name: "Stop Search", exact: true }).click();
      }
      const outcome = page.getByRole("heading", {
        name: gestures ? "Match confirmed and saved" : "Search ended without confirmation",
      });
      await expect(outcome).toBeVisible();
      await stopBackend();
      await startBackend({ phase06: "production", yoloe: { assets, robot: positive }, gestures: { assets } });
      await page.goto(`${session}/result`);
      await expect(outcome).toBeVisible();
      await expect(page.getByRole("img", { name: "Captured evidence", exact: true }).first()).toBeVisible();
      const restarted = await (await page.request.get(`${backend}/bootstrap`, { headers: { Origin: frontend } })).json();
      expect(restarted.qualification_profile.profile_id).toBe("phase-06-v1");
      const saved = await page.request.get(`${backend}${session}/matches`, { headers: {
        Origin: frontend, "X-App-Capability": restarted.capability, "X-App-Client-Id": restarted.client_id,
      } });
      expect(saved.ok()).toBe(true);
      const history = await saved.json() as MatchPage;
      expect(history.items).toContainEqual(expect.objectContaining({
        id: firstMatch.id,
        frame_id: firstMatch.frame_id,
        captured_at_ms: firstMatch.captured_at_ms,
        stream_epoch: firstMatch.stream_epoch,
        box,
        evidence_media: media,
        disposition: gestures ? "Confirmed" : "Rejected",
      }));
    } finally {
      await info.attach(`phase06-${mode}-trace`, { path: join(parent, "trace.jsonl"), contentType: "application/x-ndjson" });
      if (backendLog) await info.attach("backend-stderr", { body: backendLog, contentType: "text/plain" });
    }
  });
}

test("Phase 06 measures the native MediaPipe and CUDA workload with recorded video", async ({ page }, info) => {
  const assets = process.env.LAF_TEST_PHASE06_ASSETS;
  test.skip(!assets, "Requires the pinned local Windows CUDA and MediaPipe assets");
  if (!assets) return;
  test.setTimeout(150_000);
  await openPhase06(page, resolve(assets), "native-landmarker");
  try {
    await expect(page.getByRole("img", { name: "Mirrored webcam preview and recognition" })).toBeVisible();
    await recordPhase06Workload(page, info, 10_000);
    expect(phase06Trace().filter(({ kind }) => kind === "gesture").length).toBeGreaterThan(30);
    await expect(page.getByText("Committed session · Searching")).toBeVisible();
    await page.getByRole("button", { name: "Stop Search", exact: true }).click();
    await expect(page.getByRole("heading", { name: "Search ended without confirmation" })).toBeVisible();
  } finally {
    await info.attach("phase06-native-trace", { path: join(parent, "trace.jsonl"), contentType: "application/x-ndjson" });
    if (backendLog) await info.attach("backend-stderr", { body: backendLog, contentType: "text/plain" });
  }
});

for (const action of ["start", "resume"] as const) {
  test(`a process exit before ${action} commit never replays the unfinished request`, async ({ page }) => {
    test.setTimeout(55_000);
    await startBackend({ simulation: true, crashSearch: action });
    await selectTarget(page, sourceImage(), "Restart target");
    await setTargetCoordinates(page);
    await page.getByRole("button", { name: "Register Object" }).click();
    await expect(page.getByRole("heading", { name: "Object Details", exact: true })).toBeVisible();
    const target = new URL(page.url()).pathname;
    let session: string | undefined;
    if (action === "start") {
      await page.getByRole("link", { name: "Open Search Setup" }).click();
      await page.getByRole("button", { name: "Acquire control" }).click();
      await page.getByRole("button", { name: "Start Search" }).click();
    } else {
      session = await startSavedSearch(page, "PS4 controller");
      await page.getByRole("button", { name: "Pause", exact: true }).click();
      await expect(page.getByText("Committed session · Paused", { exact: true })).toBeVisible();
      await page.getByRole("button", { name: "Resume", exact: true }).click();
    }
    await expect.poll(() => backendProcess?.exitCode).toBe(84);
    await startBackend({ simulation: true });
    await waitForStorage();
    await page.goto(session ?? target);
    await expect(page.getByRole("link", { name: "Return to Active Search" })).toHaveCount(0);
    if (session) {
      await expect(page.getByText("Search interrupted", { exact: true })).toBeVisible();
      await expect(page.getByRole("button", { name: "Resume", exact: true })).toHaveCount(0);
    } else {
      await expect(page.getByText("No search sessions", { exact: true })).toBeVisible();
    }
  });
}

test("ends expired review and clears connected records before failed cleanup is repaired", async ({ page, context }) => {
  test.setTimeout(80_000);
  const day = 86_400_000;
  const clock = join(parent, "retention-clock");
  const cleanupFault = join(parent, "deny-cleanup");
  const source = sourceImage();
  const original = readFileSync(source);
  writeFileSync(clock, String(-7 * day));
  await startBackend({ clockOffset: clock });
  await selectTarget(page, source, "Expiring review target");
  await setTargetCoordinates(page);
  await page.getByRole("button", { name: "Register Object" }).click();
  await expect(page.getByRole("heading", { name: "Object Details", exact: true })).toBeVisible();
  const target = new URL(page.url()).pathname;
  await stopBackend();

  writeFileSync(clock, "-18000");
  writeFileSync(cleanupFault, "");
  await startBackend({ reviewSimulation: true, clockOffset: clock, cleanupFault, noWebcam: true });
  await waitForStorage();
  const boot = await fetch(`${backend}/bootstrap`, { headers: { Origin: frontend } }).then((reply) => reply.json());
  const health = await fetch(`${backend}/health`, { headers: { "X-App-Capability": boot.capability } })
    .then((reply) => reply.json());
  expect(health.readiness.components).toContainEqual(expect.objectContaining({ component: "Webcam", status: "Unavailable" }));
  await page.goto(target);
  const session = await startSavedSearch(page, "PS4 controller");
  const review = page.getByRole("region", { name: "Review potential match" });
  await expect(review.getByRole("img", { name: "Captured evidence", exact: true })).toBeVisible();
  const history = await context.newPage();
  const library = await context.newPage();
  const dashboard = await context.newPage();
  const details = await context.newPage();
  const removed: Record<string, number> = {};
  const watchRemoval = (tab: Page, label: string) => tab.on("websocket", (socket) => {
    if (!socket.url().endsWith("/events")) return;
    socket.on("framereceived", ({ payload }) => {
      if (typeof payload !== "string") return;
      const event = JSON.parse(payload);
      if (event.type === "object_removed" && event.payload.object_id === target.split("/").at(-1)) {
        removed[label] = event.event_seq;
      }
    });
  });
  watchRemoval(history, "history");
  watchRemoval(library, "library");
  watchRemoval(dashboard, "dashboard");
  watchRemoval(details, "details");
  await Promise.all([history.goto(session), library.goto("/objects"), dashboard.goto("/"), details.goto(target)]);
  const capture = history.getByRole("region", { name: "Captured matches" });
  const evidence = capture.getByRole("img", { name: "Captured evidence", exact: true });
  await expect(evidence).toHaveAttribute("src", /^blob:/);
  const evidenceUrl = await evidence.getAttribute("src");
  await capture.getByRole("button", { name: "Inspect evidence" }).press("Enter");
  await expect(capture.getByRole("region", { name: "Enlarged captured evidence" })).toBeFocused();
  await expect(objectRows(library).getByText("Expiring review target", { exact: true })).toBeVisible();
  await expect(dashboard.getByRole("link", { name: /Expiring review target/ }).first()).toBeVisible();
  await expect(details.getByText("Active-session grace", { exact: true })).toBeVisible({ timeout: 23_000 });
  await expect(evidence).toHaveAttribute("src", evidenceUrl!);

  await page.bringToFront();
  const confirm = review.getByRole("button", { name: "Confirm Match" });
  if (!(await confirm.isEnabled())) await page.getByRole("button", { name: "Acquire control", exact: true }).click();
  let terminal: { status: number; result: unknown } | undefined;
  await page.route(`${backend}${session}/actions`, async (route) => {
    const response = await route.fetch();
    terminal = { status: response.status(), result: (await response.json()).result };
    // The ordered removal can cancel the browser read before the reply arrives.
    await route.fulfill({ response }).catch(() => {});
  }, { times: 1 });
  await confirm.click();
  await expect.poll(() => terminal?.status).toBeGreaterThan(0);
  expect([200, 202]).toContain(terminal?.status);
  if (terminal?.status === 200) {
    expect(terminal.result).toEqual({ object: null, session: null, match: null, settings: null, deletion: null });
  }
  await expect(page.getByText("Record removed after expiry", { exact: true })).toBeVisible();
  await expect.poll(() => Object.keys(removed).sort()).toEqual(["dashboard", "details", "history", "library"]);
  expect(new Set(Object.values(removed)).size).toBe(1);
  await expect(evidence).toHaveCount(0);
  await expect(capture.getByRole("region", { name: "Enlarged captured evidence" })).toHaveCount(0);
  expect(await history.evaluate(async (url) => fetch(url!).then(() => true, () => false), evidenceUrl)).toBe(false);
  await expect(objectRows(library).getByText("Expiring review target", { exact: true })).toHaveCount(0);
  await expect(dashboard.getByRole("link", { name: /Expiring review target/ })).toHaveCount(0);
  await expect(details.getByText("Record expired", { exact: true })).toBeVisible();
  await details.goto("/settings");
  await expect(details.getByText("Deletion failed", { exact: true })).toBeVisible();
  await history.goto(`${session}/result`);
  await expect(history.getByText("Session expired", { exact: true })).toBeVisible();
  expect(await readdir(join(parent, "records", "media"))).toHaveLength(2);

  await stopBackend();
  unlinkSync(cleanupFault);
  await startBackend({ reviewSimulation: true, clockOffset: clock });
  await expect.poll(() => readdir(join(parent, "records", "media"))).toEqual([]);
  expect(await readdir(join(parent, "records", "staging"))).toEqual([]);
  expect(readFileSync(source)).toEqual(original);
  await history.reload();
  await expect(history.getByText("Session not found", { exact: true })).toBeVisible();
});

async function replayReviewAction(page: Page, action: SessionAction) {
  return page.evaluate(async ({ backend, action }) => {
    const bootstrap = await fetch(`${backend}/bootstrap`).then((response) => response.json());
    const client_id = bootstrap.client_id;
    const post = (path: string, body: object) => fetch(backend + path, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-App-Client-Id": client_id,
        "X-App-Capability": bootstrap.capability,
      },
      body: JSON.stringify(body),
    });
    const { ticket } = await post("/websocket-tickets", { client_id, channel: "events" }).then((response) => response.json());
    const events = new URL(`${backend}/events`);
    events.protocol = "ws:";
    const socket = new WebSocket(events, ["laf.v1", `laf.ticket.${ticket}`]);
    try {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("The replacement event connection timed out")), 5_000);
        socket.onmessage = () => { clearTimeout(timer); resolve(); };
        socket.onclose = () => { clearTimeout(timer); reject(new Error("The replacement event connection closed")); };
      });
      const lease = await post("/control-lease", {
        request_id: crypto.randomUUID(), client_id, session_id: null, takeover: false,
      });
      if (!lease.ok) throw new Error("The replacement client could not acquire control");
      const { client_lease_id } = await lease.json();
      const same = await post(`/sessions/${action.session_id}/actions`, { ...action, client_id, client_lease_id });
      return {
        status: same.status,
        receipt: await same.text(),
        replacedClient: client_id !== action.client_id,
        replacedLease: client_lease_id !== action.client_lease_id,
      };
    } finally {
      socket.close();
    }
  }, { backend, action });
}

test("rejects a connected match, resumes across a fault, and reviews only after fixture re-entry", async ({ page }) => {
  test.setTimeout(60_000);
  const alerts: { id: string; captured_at_ms: number }[] = [];
  page.on("websocket", (socket) => {
    if (!socket.url().endsWith("/events")) return;
    socket.on("framereceived", ({ payload }) => {
      if (typeof payload !== "string") return;
      const event = JSON.parse(payload);
      if (event.type === "candidate_pending") alerts.push(event.payload.match);
    });
  });
  await startBackend({ reviewSimulation: true });
  const session = await startReviewSearch(page, "PS4 controller");
  const panel = page.getByRole("region", { name: "Review potential match" });
  const reject = panel.getByRole("button", { name: "Reject Match" });
  const button = (name: string) => page.getByRole("button", { name, exact: true });
  const resume = button("Resume");
  const emergency = button("Emergency Stop");
  const paused = page.getByText("Committed session · Paused", { exact: true });
  const searching = page.getByText("Committed session · Searching", { exact: true });
  const disarmed = page.getByText("Motion permission · Disarmed", { exact: true });
  const evidence = panel.getByRole("img", { name: "Captured evidence", exact: true });
  await expect(evidence).toBeVisible();
  await expect(resume).toBeDisabled();
  const decision = page.waitForResponse((response) => response.url() === `${backend}${session}/actions` &&
    response.request().method() === "POST" && response.request().postDataJSON().action === "reject", { timeout: 8_000 });
  await reject.click();
  expect((await decision).ok()).toBe(true);
  await expect(panel).toHaveCount(0);
  await expect(paused).toBeVisible();
  await expect(disarmed).toBeVisible();
  await resume.click();
  await expect(searching).toBeVisible();
  expect(alerts).toHaveLength(1);
  await emergency.focus();
  await page.keyboard.press("Enter");
  await expect(paused).toBeVisible();
  await expect(disarmed).toBeVisible();
  await expect(resume).toBeDisabled();
  await button("Acquire control").click();
  const recovery = page.getByRole("region", { name: "Recovery", exact: true });
  await expect(recovery.getByText("Restored · Awaiting acknowledgment")).toBeVisible();
  await button("Acknowledge").click();
  await resume.click();
  await expect(searching).toBeVisible();
  expect(alerts).toHaveLength(1);
  await expect(panel).toBeVisible({ timeout: 23_000 });
  expect(alerts).toHaveLength(2);
  expect(alerts[1].id).not.toBe(alerts[0].id);
  expect(alerts[1].captured_at_ms - alerts[0].captured_at_ms).toBeGreaterThan(12_000);
  await expect(paused).toBeVisible();
  await expect(resume).toBeDisabled();
  await expect(emergency).toBeEnabled();
  await panel.getByRole("button", { name: "Stop Search" }).click();
  await expect(page).toHaveURL(`${frontend}${session}/result`);
  await stopBackend();
  await startBackend({ reviewSimulation: true });
  await page.goto(session);
  const history = page.getByRole("region", { name: "Captured matches" });
  await expect(history.getByText("Rejected", { exact: true })).toBeVisible();
  await expect(history.getByText("Reviewed", { exact: true })).toBeVisible();
  await expect(history.getByText("Not reviewed", { exact: true })).toBeVisible();
  await expect(history.getByRole("img", { name: "Captured evidence", exact: true })).toHaveCount(2);
});

for (const outcome of ["confirm", "stop", "interrupted", "uncommitted"] as const) {
  test(`saved candidate review recovers ${outcome} through a backend restart`, async ({ page }) => {
    test.setTimeout(60_000);
    await startBackend({ reviewSimulation: true, crashCandidate: outcome === "uncommitted" });
    const session = await startReviewSearch(page, outcome === "confirm" ? "Gestures" : "PS4 controller");
    const panel = page.getByRole("region", { name: "Review potential match" });
    let confirm: SessionAction | undefined;
    let receipt: string | undefined;
    if (outcome === "uncommitted") {
      await expect.poll(() => backendProcess?.exitCode).toBe(84);
      await expect(panel).toHaveCount(0);
    } else {
      await expect(panel.getByText("Paused", { exact: true })).toBeVisible();
      await expect(panel.getByRole("img", { name: "Selected target from Reference for Review target" })).toBeVisible();
      await expect(panel.getByText("Captured", { exact: true })).toBeVisible();
      const image = panel.getByRole("img", { name: "Captured evidence", exact: true });
      await expect(image).toBeVisible();
      await expect(image.locator("+ span")).toBeAttached();
      const overlay = await image.locator("+ span").evaluate((box) => ({
        left: box.style.left, top: box.style.top, width: box.style.width, height: box.style.height,
      }));
      expect(parseFloat(overlay.left)).toBeCloseTo(100 * 303 / 480, 4);
      expect(parseFloat(overlay.width)).toBeCloseTo(100 * 83 / 480, 4);
      expect(parseFloat(overlay.top)).toBeCloseTo(100 * 203 / 262, 4);
      expect(parseFloat(overlay.height)).toBeCloseTo(100 * 41 / 262, 4);
      await expect(panel.getByRole("button", { name: "Reject Match" })).toBeEnabled();
      await expect(page.getByRole("button", { name: "Resume", exact: true })).toBeDisabled();
      await expect(page.getByRole("button", { name: "Emergency Stop", exact: true })).toBeEnabled();
      if (outcome === "confirm") {
        await page.route(`${backend}${session}/actions`, async (route) => {
          confirm = route.request().postDataJSON();
          let response = await route.fetch();
          if (response.status() === 202) {
            await expect.poll(async () => {
              response = await route.fetch();
              return response.status();
            }).toBe(200);
          }
          expect(response.ok()).toBe(true);
          receipt = await response.text();
          await route.abort("connectionreset");
        }, { times: 1 });
        await panel.getByRole("button", { name: "Confirm Match" }).click();
      } else if (outcome === "stop") {
        await panel.getByRole("button", { name: "Stop Search" }).click();
      }
      if (outcome === "confirm" || outcome === "stop") {
        await expect(page).toHaveURL(`${frontend}${session}/result`);
        await expect(page.getByRole("heading", { name: outcome === "confirm"
          ? "Match confirmed and saved" : "Search ended without confirmation" })).toBeVisible();
      }
    }
    if (outcome === "confirm") await expect.poll(() => receipt).toBeDefined();

    await stopBackend();
    await startBackend({ reviewSimulation: true });
    await page.goto(`${session}/result`);
    const summary = page.getByRole("region", { name: "Session summary" });
    await expect(summary).toContainText(outcome === "confirm" ? "Match confirmed" :
      outcome === "stop" ? "Stopped by operator" : "Interrupted");
    if (outcome === "confirm") {
      await expect(page.getByText("Found", { exact: true })).toBeVisible();
      expect(await replayReviewAction(page, confirm!)).toEqual({
        status: 200, receipt, replacedClient: true, replacedLease: true,
      });
    } else {
      await expect(page.getByText("The object remains Lost.", { exact: true })).toBeVisible();
    }
    await page.getByRole("link", { name: "View Session Details" }).click();
    const history = page.getByRole("region", { name: "Captured matches" });
    if (outcome === "uncommitted") {
      await expect(history.getByText("No captured matches", { exact: true })).toBeVisible();
      expect(await readdir(join(parent, "records", "media"))).toHaveLength(1);
      expect(await readdir(join(parent, "records", "staging"))).toHaveLength(0);
    } else {
      await expect(history.getByText(outcome === "confirm" ? "Confirmed" : "Not reviewed", { exact: true })).toBeVisible();
      await expect(history.getByRole("img", { name: "Captured evidence", exact: true })).toBeVisible();
    }
  });
}
