import Ajv2020 from "ajv/dist/2020";
import { expect, test } from "vitest";
import seed from "@/generated/api-v1.seed.json";
import { createFixtureTransport } from "./transport";
import { clientId, day, leaseId, sampleTime } from "./samples";
import { sampleImage } from "./images";

const ajv = new Ajv2020({ allErrors: true, strict: false });
ajv.addSchema(seed, "api-v1");

test("fixture bootstrap, snapshot and sample reads conform to the approved API definitions", async () => {
  const transport = createFixtureTransport();
  const bootstrap = await transport.bootstrap();
  expect(bootstrap.kind).toBe("ok");
  if (bootstrap.kind !== "ok") throw new Error("Fixture bootstrap failed");
  expect(ajv.validate("api-v1#/$defs/BootstrapResponse", bootstrap.data), ajv.errorsText()).toBe(true);

  const context = bootstrap.data;
  const responses = [
    ["Snapshot", await transport.get("/snapshot", { context })],
    ["ObjectPage", await transport.get("/objects", { context })],
    ["Object", await transport.get("/objects/{id}", { context, id: "sample-wallet" })],
    ["SessionPage", await transport.get("/objects/{id}/sessions", { context, id: "sample-wallet" })],
    ["Session", await transport.get("/sessions/{id}", { context, id: "sample-search" })],
  ] as const;

  for (const [definition, response] of responses) {
    expect(response.kind).toBe("ok");
    if (response.kind !== "ok") throw new Error(`Fixture read failed for ${definition}`);
    const valid = ajv.validate(`api-v1#/$defs/${definition}`, response.data);
    expect(valid, ajv.errorsText()).toBe(true);
  }
  expect(ajv.validate("api-v1#/$defs/BootstrapResponse", { ...context, capability: "" })).toBe(false);
});

test("the adapter rejects invalid context and supports cancelled reads", async () => {
  const first = createFixtureTransport();
  const bootstrap = await first.bootstrap();
  if (bootstrap.kind !== "ok") throw new Error("Fixture bootstrap failed");
  await expect(first.get("/snapshot", { context: { ...bootstrap.data, capability: "invalid" } })).resolves.toMatchObject({
    kind: "api-error", error: { code: "CAPABILITY_INVALID" },
  });
  const signal = AbortSignal.abort();
  await expect(first.get("/snapshot", { context: bootstrap.data, signal })).rejects.toMatchObject({ name: "AbortError" });
});

test("retention commits a new revision and denies affected history and evidence before cleanup", async () => {
  const transport = createFixtureTransport({ now: () => sampleTime });
  const bootstrap = await transport.bootstrap();
  if (bootstrap.kind !== "ok") throw new Error("Fixture bootstrap failed");
  const context = bootstrap.data;
  const sessions = await transport.request("GET /objects/{id}/sessions", { context, id: "sample-headphones", query: { limit: 1 } });
  expect(sessions.kind).toBe("ok");
  const matches = await transport.request("GET /sessions/{id}/matches", { context, id: "sample-confirmed-search" });
  if (matches.kind !== "ok") throw new Error("Fixture match read failed");
  const media = matches.data.items[0].evidence_media.id;
  await expect(transport.media(media, { context })).resolves.toMatchObject({ status: 200 });
  const body = { retention_days: 1, expected_revision: 1 };
  const preview = await transport.request("POST /settings/retention-preview", { context, body });
  if (preview.kind !== "ok") throw new Error("Fixture preview failed");
  expect(preview.data.impact).toMatchObject({ objects: 26, sessions: 1, matches: 1 });
  const committed = await transport.request("PUT /settings/retention", { context, body: {
    ...body, preview_id: preview.data.preview_id, action_id: "f9202810-dc25-4573-990e-c7b018342584", confirmed: true,
  } });
  expect(committed).toMatchObject({ data: { persistence: "Committed", result: { deletion: { status: "Pending" } } } });
  await expect(transport.request("GET /settings", { context })).resolves.toMatchObject({ data: { retention_days: 1, revision: 2 } });
  await expect(transport.snapshot({ context })).resolves.toMatchObject({ data: { retention: { settings: { retention_days: 1 } } } });
  await expect(transport.request("GET /objects/{id}/sessions", { context, id: "sample-headphones" })).resolves.toMatchObject({ status: 410 });
  await expect(transport.request("GET /sessions/{id}/matches", { context, id: "sample-confirmed-search" })).resolves.toMatchObject({ status: 410 });
  await expect(transport.media("sample-headphones-reference", { context })).resolves.toMatchObject({ status: 410 });
  await expect(transport.media(media, { context })).resolves.toMatchObject({ status: 410 });
  transport.controls.cleanup(true);
  await expect(transport.request("GET /health", { context })).resolves.toMatchObject({ data: { storage_integrity: "Unavailable" } });
  await expect(transport.request("POST /sessions", { context, body: {
    action_id: crypto.randomUUID(), expected_revision: 1, object_id: "sample-wallet", client_id: clientId,
    client_lease_id: leaseId, control_mode: "Controller",
  } })).resolves.toMatchObject({ error: { code: "STORAGE_UNAVAILABLE" } });
  await expect(transport.request("POST /settings/retention-preview", { context, body: { ...body, expected_revision: 2 } }))
    .resolves.toMatchObject({ error: { code: "STORAGE_UNAVAILABLE" } });
  await expect(transport.emergency({ request_id: crypto.randomUUID() }, { context })).resolves.toMatchObject({ data: { permission_revoked: true } });
  transport.dispose();
});

test("invalidates changed impact and handles an active-session race at commit", async () => {
  let now = sampleTime + day - 3_600_000 - 1;
  const transport = createFixtureTransport({ now: () => now });
  const bootstrap = await transport.bootstrap();
  if (bootstrap.kind !== "ok") throw new Error("Fixture bootstrap failed");
  const context = bootstrap.data;
  const body = { retention_days: 1, expected_revision: 1 };
  const preview = async () => {
    const response = await transport.request("POST /settings/retention-preview", { context, body });
    if (response.kind !== "ok") throw new Error("Fixture preview failed");
    return { ...body, preview_id: response.data.preview_id, action_id: crypto.randomUUID(), confirmed: true } as const;
  };
  const stale = await preview();
  now++;
  await expect(transport.request("PUT /settings/retention", { context, body: stale })).resolves.toMatchObject({
    error: { code: "PREVIEW_STALE" },
  });
  const confirm = await preview();
  transport.controls.activateSearch("Paused");
  await expect(transport.request("PUT /settings/retention", { context, body: confirm })).resolves.toMatchObject({
    error: { code: "ACTIVE_SESSION_EXISTS" },
  });
  transport.controls.endSearch();
  const alternative = await transport.request("POST /settings/retention-preview", { context, body: { ...body, retention_days: 2 } });
  if (alternative.kind !== "ok") throw new Error("Fixture preview failed");
  await expect(transport.request("PUT /settings/retention", { context, body: {
    ...confirm, action_id: crypto.randomUUID(), preview_id: alternative.data.preview_id, retention_days: 2,
  } })).resolves.toMatchObject({ data: { persistence: "Committed" } });
  await expect(transport.request("PUT /settings/retention", { context, body: confirm })).resolves.toMatchObject({
    error: { code: "REVISION_CONFLICT" },
  });
  transport.dispose();
});

test("preserves an unaffected preview after registration and expires the new object at its original cutoff", async () => {
  let now = sampleTime;
  const image = new Blob([sampleImage("image/png")], { type: "image/png" });
  const transport = createFixtureTransport({ scenario: "empty", now: () => now, manualCleanup: true,
    normalizeRegistration: async () => ({ width: 32, height: 24, blob: image }) });
  const bootstrap = await transport.bootstrap();
  if (bootstrap.kind !== "ok") throw new Error("Fixture bootstrap failed");
  const context = bootstrap.data;
  const body = { retention_days: 1, expected_revision: 1 };
  const preview = await transport.request("POST /settings/retention-preview", { context, body });
  if (preview.kind !== "ok") throw new Error("Fixture preview failed");
  expect(preview.data.impact).toEqual({ objects: 0, sessions: 0, matches: 0, managed_image_bytes: 0 });
  now += 100;
  const originalRegistration = now;
  const registration = { context, actionCreatedAtMs: now, body: { action_id: crypto.randomUUID(), name: "Reading glasses",
    reference_image: image, roi: { x: 0, y: 0, width: 1, height: 1 } } };
  const registered = await transport.request("POST /objects", registration);
  const object = registered.kind === "ok" ? registered.data.result?.object : undefined;
  if (!object) throw new Error("Fixture registration failed");
  now += 100;
  await expect(transport.request("PUT /settings/retention", { context, body: {
    ...body, preview_id: preview.data.preview_id, confirmed: true, action_id: crypto.randomUUID(),
  } })).resolves.toMatchObject({ data: { persistence: "Committed" } });
  const detail = () => transport.request("GET /objects/{id}", { context, id: object.id });
  now = originalRegistration + day - 1;
  await expect(detail()).resolves.toMatchObject({ data: { registered_at_ms: originalRegistration, expires_at_ms: originalRegistration + day } });
  now++;
  await expect(detail()).resolves.toMatchObject({ status: 410 });
  await expect(transport.request("POST /objects", registration)).resolves.toMatchObject({ error: { code: "EXPIRED" } });
  transport.controls.cleanup(false);
  await expect(detail()).resolves.toMatchObject({ status: 404 });
  await expect(transport.media(object.reference_media.id, { context })).resolves.toMatchObject({ status: 404 });
  now = originalRegistration + 100;
  await expect(transport.request("POST /objects", registration)).resolves.toMatchObject({ error: { code: "NOT_READY" } });
  transport.dispose();
});

test("a held retention save reports a stale preview when delivery crosses the deadline", async () => {
  let now = sampleTime;
  const transport = createFixtureTransport({ now: () => now });
  const bootstrap = await transport.bootstrap();
  if (bootstrap.kind !== "ok") throw new Error("Fixture bootstrap failed");
  const context = bootstrap.data;
  const proposal = { retention_days: 30, expected_revision: 1 };
  const preview = await transport.request("POST /settings/retention-preview", { context, body: proposal });
  if (preview.kind !== "ok") throw new Error("Fixture preview failed");
  const request = { context, body: { ...proposal, action_id: crypto.randomUUID(), preview_id: preview.data.preview_id, confirmed: true } } as const;
  transport.controls.save("Hold");
  await expect(transport.request("PUT /settings/retention", request)).resolves.toMatchObject({ data: { persistence: "Pending" } });
  now = preview.data.expires_at_ms;
  transport.controls.save("Commit");
  await expect(transport.request("PUT /settings/retention", request)).resolves.toMatchObject({
    status: 409, data: { action_id: request.body.action_id, persistence: "Failed", error: { code: "PREVIEW_STALE" } },
  });
  await expect(transport.request("GET /settings", { context })).resolves.toMatchObject({ data: { retention_days: 7, revision: 1 } });
  transport.dispose();
});
