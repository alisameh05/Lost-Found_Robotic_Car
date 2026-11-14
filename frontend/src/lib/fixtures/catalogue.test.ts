import { expect, test } from "vitest";
import { compatibleProfile, compatibleQualification, conforms, type Definition } from "../fixture-contracts";
import { parseFrame } from "./frame";
import { protectedHeaders, socketOffer, type ReadResult } from "../transport";
import type { SessionAction, WorkspaceHeartbeat } from "@/generated/api-v1";
import { sampleImage } from "./images";
import { storageError } from "./mutations";
import { readScenario, scenarioIds } from "./scenarios";
import { follows, validEvent, validMatch, validObject, validSession, validSnapshot } from "./semantics";
import {
  actionId, bootstrapFacts, clientId, day, fixtureProfile, foundObject, leaseId, requestId, sampleObject,
  sampleSession, sampleTime, snapshot,
} from "./samples";
import { createFixtureTransport } from "./transport";
import { eventVectors, frameVector, invalidEventVectors, invalidFrameVectors, qualification } from "./vectors";

function data<T>(result: ReadResult<T>, status = 200) {
  expect(result).toMatchObject({ kind: "ok", status });
  if (result.kind !== "ok") throw new Error("Expected a typed HTTP body");
  return result.data;
}

function contract(definition: Definition, value: unknown) {
  expect(conforms(definition, value), definition).toBe(true);
}

test.each(scenarioIds)("validates the %s fixture's bootstrap, snapshot, health and owned records", async (scenario) => {
  const transport = createFixtureTransport({ scenario });
  const bootstrap = data(await transport.bootstrap());
  const scene = readScenario(scenario);
  const health = data(await transport.request("GET /health", { context: bootstrap }), scene.health.initialization === "Ready" ? 200 : 503);
  contract("Health", health);
  expect(health.readiness).toEqual(scene.snapshot.readiness);
  expect(validSnapshot(scene.snapshot, bootstrap)).toBe(true);
  const snapshotRead = await transport.snapshot({ context: bootstrap });
  if (scene.snapshotError) {
    expect(snapshotRead).toMatchObject({ kind: "api-error", status: 503, error: scene.snapshotError });
  } else {
    expect(data(snapshotRead)).toEqual(scene.snapshot);
  }

  const listed = data(await transport.request("GET /objects", { context: bootstrap }));
  contract("ObjectPage", listed);
  for (const owner of listed.items) {
    expect(validObject(owner)).toBe(true);
    const sessions = data(await transport.request("GET /objects/{id}/sessions", { id: owner.id, context: bootstrap }));
    contract("SessionPage", sessions);
    for (const session of sessions.items) {
      expect(validSession(session, owner)).toBe(true);
      const matches = data(await transport.request("GET /sessions/{id}/matches", { id: session.id, context: bootstrap }));
      contract("MatchPage", matches);
      for (const match of matches.items) expect(validMatch(match, session)).toBe(true);
    }
  }
  transport.dispose();
});

test("required input follows the selected mode, independently of proximity", () => {
  const controller = readScenario("controller-ready").snapshot;
  const gestures = readScenario("gestures-ready").snapshot;
  expect(controller.readiness.can_start).toEqual({ Gestures: false, Controller: true });
  expect(controller.readiness.components.find(({ component }) => component === "Webcam")?.status).toBe("Unavailable");
  expect(gestures.readiness.can_start).toEqual({ Gestures: true, Controller: false });
  expect(readScenario("paused").snapshot.readiness).toEqual(readScenario("searching").snapshot.readiness);
  expect(readScenario("restored").snapshot.readiness.can_resume).toBe(false);
  expect(readScenario("acknowledged").snapshot.readiness.can_resume).toBe(true);
  const invalid = { ...controller, readiness: { ...controller.readiness,
    components: structuredClone(controller.readiness.components) } };
  invalid.readiness.components[9] = invalid.readiness.components[0];
  expect(validSnapshot(invalid, readScenario("controller-ready").bootstrap)).toBe(false);
});

test("rejects invalid enum, types, UUID, safe integers, field nullability, dimensions, ownership and profile limits", () => {
  const malformed: [Definition, unknown][] = [
    ["Object", { ...sampleObject, status: "lost" }], ["Object", { ...foundObject, found_at_ms: null }],
    ["Object", { ...sampleObject, revision: Number.MAX_SAFE_INTEGER + 1 }], ["Object", { ...sampleObject, revision: "1" }],
    ["Object", { ...sampleObject, reference_media: { ...sampleObject.reference_media, role: "Evidence" } }],
    ["Session", { ...sampleSession, end_reason: null }], ["RequestId", "10000000-0000-1000-8000-000000000001"],
    ["SessionAction", { action: "resume", candidate_id: "forbidden", action_id: actionId,
      client_id: clientId, client_lease_id: leaseId, session_id: sampleSession.id, expected_revision: 1 }],
    ["Snapshot", { ...snapshot, protocol_version: 2 }], ["FrontendProfile", { ...fixtureProfile, max_frame_width: 0 }],
    ["ObjectPage", { items: [], next_cursor: null, total: 0 }],
  ];
  for (const [definition, value] of malformed) expect(conforms(definition, value), definition).toBe(false);
  const candidate = readScenario("candidate").snapshot.pending_candidate!;
  const active = readScenario("candidate").snapshot.active_session!;
  expect(validMatch({ ...candidate, object_id: foundObject.id }, active)).toBe(false);
  expect(validMatch({ ...candidate, box: { ...candidate.box, width: candidate.evidence_media.width + 1 } }, active)).toBe(false);
  expect(validObject({ ...sampleObject, roi: { ...sampleObject.roi, x: 32 } })).toBe(false);
  expect(validSession(sampleSession, foundObject)).toBe(false);
  expect(compatibleProfile({ ...fixtureProfile, heartbeat_deadline_ms: fixtureProfile.heartbeat_interval_ms })).toBe(false);
  expect(compatibleProfile({ ...fixtureProfile, evidence_kind: "Device" })).toBe(false);
  expect(compatibleQualification(qualification)).toBe(true);
  expect(compatibleQualification({ ...qualification, proximity_clear_mm: qualification.proximity_warning_mm })).toBe(false);
});

test("keeps page limits, continuations and errors scoped without exposing owner data", async () => {
  let now = sampleTime;
  const transport = createFixtureTransport({ now: () => now });
  const context = data(await transport.bootstrap());
  const first = data(await transport.request("GET /objects", { context, query: { limit: 1 } }));
  const cursor = first.next_cursor!;
  expect(first.items.map(({ id }) => id)).toEqual(["sample-wallet"]);
  contract("Token", cursor);
  expect(cursor).not.toContain("sample");
  expect(data(await transport.request("GET /objects", { context, query: { limit: 1, cursor } })))
    .toMatchObject({ items: [{ id: "sample-headphones" }], next_cursor: null });
  expect(data(await transport.request("GET /objects", { context, query: { limit: 100 } })).items).toHaveLength(2);
  await expect(transport.request("GET /objects", { context, query: { limit: 101 } })).resolves.toMatchObject({ status: 422 });
  await expect(transport.request("GET /objects/{id}/sessions", { context, id: "sample-wallet", query: { limit: 1, cursor } }))
    .resolves.toMatchObject({ status: 400, error: { code: "CURSOR_INVALID" } });
  await expect(transport.request("GET /sessions/{id}/matches", { context, id: "missing" })).resolves.toMatchObject({ status: 404 });
  now += 30 * 60_000;
  await expect(transport.request("GET /objects", { context, query: { limit: 1, cursor } }))
    .resolves.toMatchObject({ status: 400, error: { code: "CURSOR_EXPIRED" } });
  now += 8 * day;
  await expect(transport.request("GET /objects/{id}/sessions", { context, id: "sample-wallet" })).resolves.toMatchObject({ status: 410 });
});

test("checks bootstrap protection headers, channel offers, and workspace heartbeat shape", async () => {
  const transport = createFixtureTransport({ scenario: "controller-ready" });
  const context = data(await transport.bootstrap());
  const registration = { context, actionCreatedAtMs: sampleTime, body: {
    action_id: actionId, name: sampleObject.name, roi: sampleObject.roi, reference_image: new Blob([sampleImage("image/jpeg")], { type: "image/jpeg" }),
  } };
  const headers = protectedHeaders("POST /objects", registration);
  expect(headers.get("X-App-Capability")).toBe(context.capability);
  expect(headers.get("X-App-Client-Id")).toBe(context.client_id);
  expect(headers.get("X-Action-Created-At-Ms")).toBe(String(sampleTime));
  expect(protectedHeaders("GET /health", { context }).has("X-App-Client-Id")).toBe(false);
  const tickets = new Set<string>();
  for (const channel of ["events", "robot-video", "webcam-video"] as const) {
    const body = { client_id: clientId, channel };
    contract("TicketRequest", body);
    const result = data(await transport.request("POST /websocket-tickets", { context, body }));
    contract("TicketResponse", result);
    const offer = socketOffer(channel, result.ticket);
    expect(offer.path).not.toContain(result.ticket);
    expect(offer.protocols).toEqual(["laf.v1", "laf.ticket." + result.ticket]);
    tickets.add(result.ticket);
  }
  expect(tickets.size).toBe(3);
  const heartbeat: WorkspaceHeartbeat = {
    type: "workspace_heartbeat", protocol_version: 1, backend_boot_id: context.backend_boot_id,
    client_id: clientId, client_lease_id: leaseId, session_id: null, control_generation: 1,
    heartbeat_seq: 1, workspace_visible: true, workspace_focused: true, workspace_operational: true, displayed_robot_frame: null,
  };
  contract("WorkspaceHeartbeat", heartbeat);
});

test("keeps pending, committed and failed mutations distinct from plain validation and conflict errors", async () => {
  for (const [scenario, status, persistence] of [
    ["idle", 201, "Committed"], ["initializing", 202, "Pending"], ["failed", 503, "Failed"],
  ] as const) {
    const transport = createFixtureTransport({ scenario });
    const context = data(await transport.bootstrap());
    const fields = { action_id: actionId, name: sampleObject.name, roi: sampleObject.roi };
    contract("RegistrationFields", fields);
    const request = { context, actionCreatedAtMs: sampleTime, body: {
      ...fields, reference_image: new Blob([sampleImage("image/jpeg")], { type: "image/jpeg" }),
    } };
    const response = await transport.request("POST /objects", request);
    const mutation = data(response, status);
    contract("MutationResponse", mutation);
    expect(mutation.persistence).toBe(persistence);
    if (persistence === "Committed") expect(response).toHaveProperty("location", "/api/v1/objects/sample-new-object");
    const error = await transport.request("POST /objects", { ...request, body: { ...request.body, roi: { ...fields.roi, width: 99 } } });
    expect(error).toMatchObject({ kind: "api-error", status: 422, error: {
      retryable: false, field_errors: [{ path: "/roi/width" }],
    } });
    if (error.kind === "api-error") {
      contract("Error", error.error);
      contract("FieldError", error.error.field_errors?.[0]);
    }
  }
  const body = { action_id: actionId, object_id: sampleObject.id, expected_revision: 1, control_mode: "Controller", client_id: clientId, client_lease_id: leaseId } as const;
  contract("StartRequest", body);
  const active = createFixtureTransport({ scenario: "searching" });
  const controller = createFixtureTransport({ scenario: "controller-ready" });
  await expect(active.request("POST /sessions", { context: data(await active.bootstrap()), body }))
    .resolves.toMatchObject({ status: 409, error: { code: "ACTIVE_SESSION_EXISTS" } });
  const context = data(await controller.bootstrap());
  await expect(controller.request("POST /sessions", { context, body: { ...body, expected_revision: 9 } }))
    .resolves.toMatchObject({ status: 409, error: { code: "REVISION_CONFLICT" } });
  contract("MutationResponse", data(await controller.request("POST /sessions", { context, body }), 201));
  expect(data(await controller.snapshot({ context })).active_session).toBeNull();
});

test("serializes review receipts, recovery failures, and retention outcomes", async () => {
  const transport = createFixtureTransport({ scenario: "candidate" });
  const context = data(await transport.bootstrap());
  const base = { action_id: actionId, session_id: sampleSession.id, expected_revision: 2, client_id: clientId, client_lease_id: leaseId };
  const candidate = data(await transport.snapshot({ context })).pending_candidate!;
  for (const [body, disposition] of [
    [{ ...base, action: "confirm", candidate_id: candidate.id }, "Confirmed"],
    [{ ...base, action: "reject", candidate_id: candidate.id }, "Rejected"],
    [{ ...base, action: "stop" }, "NotReviewed"],
  ] as const) {
    contract("SessionAction", body);
    const result = data(await transport.request("POST /sessions/{id}/actions", { id: sampleSession.id, context, body }));
    contract("MutationResponse", result);
    expect(result.result?.match?.disposition).toBe(disposition);
    expect(validMatch(result.result!.match!, result.result!.session!)).toBe(true);
  }
  const recovery = createFixtureTransport({ scenario: "restored" });
  const recoveryContext = data(await recovery.bootstrap());
  const restored = data(await recovery.snapshot({ context: recoveryContext }));
  const ack: SessionAction = { ...base, action: "acknowledge", expected_revision: 3, failure_ids: [restored.failures[0].failure_id] };
  contract("SessionAction", ack);
  contract("MutationResponse", data(await recovery.request("POST /sessions/{id}/actions", { id: base.session_id, context: recoveryContext, body: ack })));

  let now = sampleTime;
  const idle = createFixtureTransport({ now: () => now });
  const idleContext = data(await idle.bootstrap());
  expect(data(await idle.request("GET /settings", { context: idleContext })).retention_days).toBe(7);
  for (const retention_days of [1, 30]) {
    const request = { expected_revision: 1, retention_days };
    contract("RetentionPreviewRequest", request);
    const preview = data(await idle.request("POST /settings/retention-preview", { context: idleContext, body: request }));
    contract("RetentionPreview", preview);
    const action_id = retention_days === 1 ? actionId : requestId;
    const body = { ...request, action_id, preview_id: preview.preview_id, confirmed: true } as const;
    contract("RetentionChange", body);
    const committed = data(await idle.request("PUT /settings/retention", { context: idleContext, body }));
    contract("MutationResponse", committed);
    expect(committed.result?.deletion?.status).toBe(retention_days === 1 ? "Pending" : "Complete");
    now += 60_000;
    expect(data(await idle.request("PUT /settings/retention", { context: idleContext, body }))).toEqual(committed);
    await expect(idle.request("PUT /settings/retention", { context: idleContext, body: {
      ...body, action_id: "10000000-0000-4000-8000-000000000004",
    } })).resolves.toMatchObject({
      status: 409, error: { code: "PREVIEW_STALE" },
    });
  }
  const grace = createFixtureTransport({ scenario: "expiry-grace" });
  const graceContext = data(await grace.bootstrap());
  expect(data(await grace.request("GET /objects/{id}", { context: graceContext, id: "sample-expired" })).retention_grace).toBe(true);
});

test("reports every scripted emergency outcome, including a 503 that acknowledges revocation", async () => {
  for (const [scenario, status, persistence] of [
    ["searching", 200, "Committed"], ["emergency-pending", 202, "Pending"], ["emergency-failed", 503, "Failed"], ["idle", 200, "Committed"],
  ] as const) {
    const transport = createFixtureTransport({ scenario });
    const body = { request_id: requestId };
    contract("EmergencyStopRequest", body);
    const context = data(await transport.bootstrap());
    const result = data(await transport.emergency(body, { context }), status);
    contract("EmergencyStopResponse", result);
    expect(result).toMatchObject({ permission_revoked: true, persistence, session_id: scenario === "idle" ? null : sampleSession.id });
    expect(result.error).toEqual(persistence === "Failed" ? storageError : null);
    const updated = data(await transport.snapshot({ context }));
    expect(updated.lease.state).toBe("Unowned");
    expect(updated.runtime.effective_session_state).toBe(scenario === "idle" ? null : "Paused");
    expect(updated.runtime.persistence_pending).toBe(persistence === "Pending");
    expect(validSnapshot(updated, context)).toBe(true);
  }
  const network = createFixtureTransport({ scenario: "emergency-network" });
  await expect(network.emergency({ request_id: requestId }, { context: data(await network.bootstrap()) }))
    .resolves.toEqual({ kind: "unavailable" });
});

test("validates all event types and distinguishes invalid sequencing from invalid schema", () => {
  expect(new Set(eventVectors.map(({ type }) => type)).size).toBe(9);
  for (const event of eventVectors) expect(validEvent(event)).toBe(true);
  for (let index = 1; index < eventVectors.length; index++) expect(follows(eventVectors[index - 1], eventVectors[index])).toBe(true);
  for (const { previous, next } of Object.values(invalidEventVectors)) {
    expect(follows(previous, next as typeof previous)).toBe(false);
  }
  expect(conforms("EventEnvelope", { ...eventVectors[0], type: "unsupported" })).toBe(false);
  expect(conforms("EventEnvelope", { ...eventVectors[0], payload: {} })).toBe(false);
});

test("parses only bounded UTF-8 frame envelopes with matching source and JPEG dimensions", () => {
  for (const source of ["robot", "webcam"] as const) {
    const frame = frameVector(source, fixtureProfile)!;
    const size = new DataView(frame.buffer).getUint32(0, false);
    expect(size).toBeGreaterThan(0);
    const parsed = parseFrame(frame, fixtureProfile, source);
    expect(parsed?.metadata).toMatchObject({ protocol_version: 1, source, width: 32, height: 24, capture_seq: 1 });
    contract("FrameMetadata", parsed?.metadata);
    expect(parsed?.jpeg).toEqual(frame.slice(4 + size));
    expect(parseFrame(frame, fixtureProfile, source === "robot" ? "webcam" : "robot")).toBeNull();
    expect(parseFrame(frame, null, source)).toBeNull();
  }
  for (const [name, value] of Object.entries(invalidFrameVectors())) {
    expect(parseFrame(value, fixtureProfile, "robot"), name).toBeNull();
  }
});

test("isolates fixtures, cancels outstanding reads, and removes subscriptions on abort and dispose", async () => {
  const first = createFixtureTransport({ scenario: "controller-ready", eventScript: "catalogue" });
  const second = createFixtureTransport({ scenario: "controller-ready", eventScript: "catalogue" });
  const context = data(await first.bootstrap());
  expect(data(await second.bootstrap())).toEqual(context);
  const detached = data(await first.snapshot({ context }));
  detached.readiness.components[0].status = "Unavailable";
  expect(data(await first.snapshot({ context }))).toEqual(data(await second.snapshot({ context })));
  const page = data(await first.request("GET /objects", { context, query: { limit: 1 } }));
  await expect(second.request("GET /objects", { context, query: { limit: 1, cursor: page.next_cursor! } }))
    .resolves.toMatchObject({ error: { code: "CURSOR_EXPIRED" } });

  const events: string[] = [];
  const stop = first.subscribeEvents({ context }, ({ type }) => { events.push(type); stop(); });
  const frames: Uint8Array[] = [];
  const signal = new AbortController();
  second.subscribeFrames({ context, signal: signal.signal }, "webcam", (frame) => frames.push(frame));
  const inFlight = first.media("sample-wallet-reference", { context, signal: signal.signal });
  signal.abort();
  await expect(inFlight).rejects.toMatchObject({ name: "AbortError" });
  expect(events).toEqual(["snapshot"]);
  expect(frames).toHaveLength(0);

  second.subscribeEvents({ context }, ({ type }) => { events.push(type); });
  const pending = second.snapshot({ context });
  second.dispose();
  await expect(pending).rejects.toMatchObject({ name: "AbortError" });
  expect(events).toEqual(["snapshot"]);
  const noProfile = createFixtureTransport();
  noProfile.subscribeFrames({ context }, "robot", (frame) => frames.push(frame));
  await Promise.resolve();
  expect(frames).toHaveLength(0);
  first.subscribeFrames({ context }, "robot", (frame) => frames.push(frame));
  await Promise.resolve();
  expect(frames).toHaveLength(1);
  expect(parseFrame(frames[0], fixtureProfile, "robot")).not.toBeNull();

  const image = data(await first.media("sample-wallet-reference", { context }));
  expect(image.headers).toMatchObject({ "Cache-Control": "no-store", "Accept-Ranges": "none" });
  expect(image.bytes).toEqual(sampleImage("image/jpeg"));
  contract("BootstrapResponse", bootstrapFacts);
});

test("validates acquired and released lease specimens without opening a socket", async () => {
  const transport = createFixtureTransport({ scenario: "searching" });
  const context = data(await transport.bootstrap());
  const body = { request_id: requestId, client_id: context.client_id, session_id: sampleSession.id };
  const acquire = { ...body, takeover: true };
  contract("LeaseAcquire", acquire);
  const lease = data(await transport.request("POST /control-lease", { context, body: acquire }));
  contract("LeaseResponse", lease);
  expect(lease.client_lease_id).toBe(leaseId);
  await expect(transport.request("POST /control-lease", { context, body: { ...acquire, request_id: actionId } }))
    .resolves.toMatchObject({ status: 403, error: { code: "LEASE_OWNED" } });
  const release = { ...body, request_id: "10000000-0000-4000-8000-000000000003",
    client_lease_id: leaseId, control_generation: lease.control_generation };
  contract("LeaseRelease", release);
  const released = data(await transport.request("POST /control-lease/release", { context, body: release }));
  contract("LeaseResponse", released);
  expect(released.snapshot.active_session?.state).toBe("Paused");
  expect(released.snapshot.lease.state).toBe("Unowned");
  expect(validSnapshot(released.snapshot, context)).toBe(true);
});
