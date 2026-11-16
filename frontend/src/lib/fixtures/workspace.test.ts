import { expect, onTestFinished, test, vi } from "vitest";
import type { Channel, EventEnvelope, SessionAction, WorkspaceHeartbeat } from "@/generated/api-v1";
import { conforms } from "../fixture-contracts";
import { parseFrameEnvelope } from "../frame-display";
import { socketOffer, type ClientContext, type ReadResult } from "../transport";
import { createFixtureTransport } from "./transport";
import { foundSession, sampleTime } from "./samples";

function data<T>(result: ReadResult<T>) {
  if (result.kind !== "ok") throw new Error(`Expected fixture success, received ${result.kind}`);
  return result.data;
}

async function ticket(transport: ReturnType<typeof createFixtureTransport>, context: ClientContext, channel: Channel) {
  const response = data(await transport.request("POST /websocket-tickets", { context, body: { client_id: context.client_id, channel } }));
  return socketOffer(channel, response.ticket);
}

const silent = { message() {}, closed() {} };

test("captures the subscription watermark before following changes and bounds slow ordered consumers", async ({ onTestFinished }) => {
  const transport = createFixtureTransport();
  onTestFinished(() => transport.dispose());
  const context = data(await transport.bootstrap());
  const spectator = transport.controls.addClient();
  const ownerOffer = await ticket(transport, context, "events");
  const spectatorOffer = await ticket(transport, spectator, "events");
  const ownerEvents: EventEnvelope[] = [];
  const spectatorEvents: EventEnvelope[] = [];
  const ownerClosed = vi.fn();
  const owner = data(transport.connectEvents({ context }, ownerOffer, { message: (event) => ownerEvents.push(event), closed: ownerClosed }));
  data(transport.connectEvents({ context: spectator }, spectatorOffer,
    { message: (event) => spectatorEvents.push(event), closed() {} }));
  transport.controls.observeProximity(150);
  await Promise.resolve();
  expect(ownerEvents.map(({ type, event_seq }) => [type, event_seq])).toEqual([["snapshot", 1], ["proximity_warning_changed", 2]]);
  expect(spectatorEvents.map(({ event_seq }) => event_seq)).toEqual([1, 2]);
  data(await transport.request("POST /control-lease", { context, body: {
    client_id: context.client_id, request_id: crypto.randomUUID(), session_id: null, takeover: false,
  } }));
  const videoClosed = vi.fn();
  data(transport.connectFrames({ context }, "robot", await ticket(transport, context, "robot-video"),
    { ...silent, closed: videoClosed }));
  for (let count = 0; count < 12; count++) transport.controls.injectGap();
  expect(ownerClosed).toHaveBeenCalledOnce();
  expect(videoClosed).not.toHaveBeenCalled();
  expect(data(await transport.snapshot({ context })).lease.state).toBe("Unowned");
  owner.close();
  const freshOffer = await ticket(transport, context, "events");
  expect(freshOffer).not.toEqual(ownerOffer);
  const resync: EventEnvelope[] = [];
  data(transport.connectEvents({ context }, freshOffer, { message: (event) => resync.push(event), closed() {} }));
  await Promise.resolve();
  expect(resync).toEqual([expect.objectContaining({ type: "snapshot", event_seq: data(await transport.snapshot({ context })).event_seq })]);
});

test("restart drops pending actions and old tickets while eligible committed receipts can still be replayed", async ({ onTestFinished }) => {
  vi.useFakeTimers();
  vi.setSystemTime(sampleTime);
  const transport = createFixtureTransport({ monotonic: () => Date.now() - sampleTime });
  onTestFinished(() => { transport.dispose(); vi.useRealTimers(); });
  const context = data(await transport.bootstrap());
  const obsoleteOffer = await ticket(transport, context, "events");
  const settings = data(await transport.request("GET /settings", { context }));
  const retentionChange = { expected_revision: settings.revision, retention_days: 8 };
  const preview = data(await transport.request("POST /settings/retention-preview", { context, body: retentionChange }));
  const journal: EventEnvelope[] = [];
  const events = data(transport.connectEvents({ context }, await ticket(transport, context, "events"),
    { message: (event) => journal.push(event), closed() {} }));
  let frame: WorkspaceHeartbeat["displayed_robot_frame"] = null;
  data(transport.connectFrames({ context }, "robot", await ticket(transport, context, "robot-video"), {
    closed() {},
    message(bytes) {
      const { frame_id, stream_epoch } = parseFrameEnvelope(bytes, context.qualification_profile!, "robot")!.metadata;
      frame = { frame_id, stream_epoch };
    },
  }));
  const acquired = data(await transport.request("POST /control-lease", { context, body: {
    request_id: crypto.randomUUID(), client_id: context.client_id, session_id: null, takeover: false,
  } }));
  expect(frame).not.toBeNull();
  const heartbeat: WorkspaceHeartbeat = { type: "workspace_heartbeat", protocol_version: 1, backend_boot_id: context.backend_boot_id,
    client_id: context.client_id, client_lease_id: acquired.client_lease_id!, session_id: null, control_generation: acquired.control_generation,
    heartbeat_seq: 1, workspace_visible: true, workspace_focused: true, workspace_operational: true, displayed_robot_frame: frame };
  expect(events.heartbeat(heartbeat)).toBe(true);
  const object = data(await transport.request("GET /objects/{id}", { context, id: "sample-wallet" }));
  const start = { action_id: crypto.randomUUID(), client_id: context.client_id, client_lease_id: acquired.client_lease_id!,
    object_id: object.id, expected_revision: object.revision, control_mode: "Gestures" } as const;
  const started = data(await transport.request("POST /sessions", { context, body: start }));
  const session = started.result!.session!;
  expect(journal).toContainEqual(expect.objectContaining({ type: "session_changed", session_id: session.id,
    payload: expect.objectContaining({ operation: expect.objectContaining({ action_id: start.action_id, persistence: "Committed" }) }) }));
  transport.controls.scriptSearch("pending");
  const body = { action: "stop", action_id: crypto.randomUUID(), session_id: session.id,
    client_id: context.client_id, client_lease_id: acquired.client_lease_id!, expected_revision: session.revision } as const;
  const pending = data(await transport.request("POST /sessions/{id}/actions", { context, id: session.id, body }));
  expect(pending.persistence).toBe("Pending");

  transport.controls.restart();
  const fresh = data(await transport.bootstrap());
  expect(fresh.backend_boot_id).not.toBe(context.backend_boot_id);
  expect(fresh.client_id).not.toBe(context.client_id);
  expect(fresh.capability).not.toBe(context.capability);
  expect(events.heartbeat(heartbeat)).toBe(false);
  expect(transport.connectEvents({ context: fresh }, obsoleteOffer, silent)).toMatchObject({ kind: "api-error" });
  expect(await transport.request("GET /health", { context: fresh })).toMatchObject({ status: 503, data: { initialization: "Starting" } });
  await vi.advanceTimersByTimeAsync(250);
  transport.controls.finishSearchSave(true);
  const state = data(await transport.snapshot({ context: fresh }));
  expect(state).toMatchObject({ active_session: null, operations: [], lease: { state: "Unowned" },
    runtime: { effective_session_state: null, motion_permission: "Disarmed", persistence_pending: false } });
  expect(data(await transport.request("GET /sessions/{id}", { context: fresh, id: session.id })))
    .toMatchObject({ id: session.id, state: "Ended", end_reason: "Interrupted" });
  expect(await transport.request("PUT /settings/retention", { context: fresh, body: {
    ...retentionChange, action_id: crypto.randomUUID(), preview_id: preview.preview_id, confirmed: true,
  } })).toMatchObject({ error: { code: "PREVIEW_STALE" } });
  const replay = (fields: Partial<typeof start> | { control_mode: "Controller" } = {}) =>
    transport.request("POST /sessions", { context: fresh, body: { ...start, ...fields, client_id: fresh.client_id } });
  expect(data(await replay())).toEqual(started);
  expect(await replay({ control_mode: "Controller" })).toMatchObject({ error: { code: "ACTION_ID_CONFLICT" } });
  expect(await transport.request("POST /sessions/{id}/actions", { context: fresh, id: session.id,
    body: { ...body, client_id: fresh.client_id } })).toMatchObject({ error: { code: "LEASE_REQUIRED" } });
});

test("redeems a ticket once for its exact boot, client, channel and protocol before the monotonic deadline", async ({ onTestFinished }) => {
  let clock = 0;
  let utc = sampleTime;
  const transport = createFixtureTransport({ monotonic: () => clock, now: () => utc });
  onTestFinished(() => transport.dispose());
  const context = data(await transport.bootstrap());
  const other = transport.controls.addClient();
  const offer = await ticket(transport, context, "events");
  const connect = (candidate = context, protocols: readonly string[] = offer.protocols) =>
    transport.connectEvents({ context: candidate }, { ...offer, protocols }, silent);
  expect(connect({ ...context, backend_boot_id: "old-boot" })).toMatchObject({ error: { code: "TICKET_INVALID" } });
  expect(connect(other)).toMatchObject({ error: { code: "TICKET_INVALID" } });
  expect(connect(context, [...offer.protocols, "laf.v1"])).toMatchObject({ error: { code: "TICKET_INVALID" } });
  expect(transport.connectFrames({ context }, "robot", { ...offer, path: "/video/robot" }, silent))
    .toMatchObject({ error: { code: "TICKET_INVALID" } });
  utc += 30_000;
  clock = 9_999;
  const connection = data(connect());
  expect(connection.protocol).toBe("laf.v1");
  expect(connect()).toMatchObject({ error: { code: "TICKET_CONSUMED" } });
  connection.close();

  const expiring = await ticket(transport, context, "events");
  clock += 10_000;
  expect(transport.connectEvents({ context }, expiring, silent)).toMatchObject({ error: { code: "TICKET_EXPIRED" } });
});

test("presents one controlling lease and derives readiness from a scoped, fresh robot acknowledgment", async ({ onTestFinished }) => {
  vi.useFakeTimers();
  const transport = createFixtureTransport({ monotonic: () => Date.now() - sampleTime });
  vi.setSystemTime(sampleTime);
  onTestFinished(() => { transport.dispose(); vi.useRealTimers(); });
  const context = data(await transport.bootstrap());
  const other = transport.controls.addClient();
  const read = async () => data(await transport.snapshot({ context }));
  const body = { client_id: context.client_id, request_id: crypto.randomUUID(), session_id: null, takeover: false };
  const acquire = () => transport.request("POST /control-lease", { context, body });
  expect(await acquire()).toMatchObject({ error: { code: "NOT_READY" } });
  const events: EventEnvelope[] = [];
  const eventSocket = data(transport.connectEvents({ context }, await ticket(transport, context, "events"),
    { message: (event) => events.push(event), closed() {} }));
  const spectatorEvents = data(transport.connectEvents({ context: other }, await ticket(transport, other, "events"), silent));
  let robot: WorkspaceHeartbeat["displayed_robot_frame"] = null;
  let webcam: WorkspaceHeartbeat["displayed_robot_frame"] = null;
  const profile = context.qualification_profile!;
  for (const source of ["robot", "webcam"] as const) {
    const offer = await ticket(transport, context, source === "robot" ? "robot-video" : "webcam-video");
    data(transport.connectFrames({ context }, source, offer, {
      message(value) {
        const { frame_id, stream_epoch } = parseFrameEnvelope(value, profile, source)!.metadata;
        if (source === "robot") robot = { frame_id, stream_epoch };
        else webcam = { frame_id, stream_epoch };
      },
      closed() {},
    }));
  }
  await vi.advanceTimersByTimeAsync(1);
  expect((await read()).lease).toMatchObject({ state: "Unowned", can_acquire: true });
  const lease = data(await acquire());
  expect(conforms("LeaseResponse", lease)).toBe(true);
  await expect(transport.request("POST /control-lease", { context: other,
    body: { ...body, client_id: other.client_id, request_id: crypto.randomUUID(), takeover: true },
  })).resolves.toMatchObject({ error: { code: "LEASE_OWNED" } });
  spectatorEvents.close();
  expect((await read()).lease.state).toBe("Owned");
  const heartbeat: WorkspaceHeartbeat = {
    type: "workspace_heartbeat", protocol_version: 1, backend_boot_id: context.backend_boot_id,
    client_id: context.client_id, client_lease_id: lease.client_lease_id!, session_id: null,
    control_generation: lease.control_generation, heartbeat_seq: 1,
    workspace_visible: true, workspace_focused: true, workspace_operational: true, displayed_robot_frame: null,
  };
  expect(eventSocket.heartbeat({ ...heartbeat, heartbeat_seq: 2 })).toBe(false);
  expect(eventSocket.heartbeat(heartbeat)).toBe(true);
  expect((await read()).readiness.can_start).toEqual({ Gestures: false, Controller: false });
  expect(eventSocket.heartbeat({ ...heartbeat, heartbeat_seq: 2, displayed_robot_frame: webcam })).toBe(false);
  expect(eventSocket.heartbeat({ ...heartbeat, heartbeat_seq: 2, displayed_robot_frame: robot, session_id: "another-search" })).toBe(false);
  expect(eventSocket.heartbeat({ ...heartbeat, heartbeat_seq: 2, displayed_robot_frame: robot, backend_boot_id: "old-boot" })).toBe(false);
  expect(eventSocket.heartbeat({ ...heartbeat, heartbeat_seq: 2, displayed_robot_frame: robot, control_generation: 1 })).toBe(false);
  expect(eventSocket.heartbeat({ ...heartbeat, heartbeat_seq: 2, displayed_robot_frame: robot })).toBe(true);
  expect(eventSocket.heartbeat({ ...heartbeat, heartbeat_seq: 2, displayed_robot_frame: robot })).toBe(false);
  const retry = data(await acquire());
  expect(retry.client_lease_id).toBe(lease.client_lease_id);
  expect(retry.snapshot.event_seq).toBeGreaterThan(lease.snapshot.event_seq);
  expect(retry.snapshot.readiness.can_start).toEqual({ Gestures: true, Controller: true });
  expect(JSON.stringify(events)).not.toContain(lease.client_lease_id);

  // Independent expiry revokes even with the event channel still connected and no release request.
  await vi.advanceTimersByTimeAsync(profile.heartbeat_deadline_ms + 1);
  expect((await read()).lease.state).toBe("Unowned");
  expect(data(await acquire())).toMatchObject({
    client_lease_id: lease.client_lease_id, lease: { state: "Owned" }, snapshot: { lease: { state: "Unowned" } },
  });
  expect(await transport.request("POST /control-lease", { context, body: { ...body, request_id: crypto.randomUUID() } }))
    .toMatchObject({ error: { code: "INVALID_TRANSITION" } });
  const takeover = data(await transport.request("POST /control-lease", { context,
    body: { ...body, request_id: crypto.randomUUID(), takeover: true } }));
  const release = { client_id: context.client_id, session_id: null, client_lease_id: takeover.client_lease_id!,
    control_generation: takeover.control_generation, request_id: body.request_id };
  await expect(transport.request("POST /control-lease/release", { context, body: release }))
    .resolves.toMatchObject({ error: { code: "REQUEST_ID_CONFLICT" } });
  const replacement = data(transport.connectEvents({ context }, await ticket(transport, context, "events"), silent));
  expect((await read()).lease.state).toBe("Unowned");
  expect(eventSocket.heartbeat({ ...heartbeat, client_lease_id: takeover.client_lease_id! })).toBe(false);
  const newLease = data(await transport.request("POST /control-lease", { context,
    body: { ...body, request_id: crypto.randomUUID(), takeover: true } }));
  const releaseBody = { ...release, client_lease_id: newLease.client_lease_id!, control_generation: newLease.control_generation,
    request_id: crypto.randomUUID() };
  const releaseOnce = () => transport.request("POST /control-lease/release", { context, body: releaseBody });
  const released = data(await releaseOnce());
  expect(released.client_lease_id).toBeNull();
  expect(data(await releaseOnce())).toEqual(released);
  replacement.close();
});

test("scopes Start and subsequent actions to one live lease and expires an abandoned session to Paused", async ({ onTestFinished }) => {
  vi.useFakeTimers();
  vi.setSystemTime(sampleTime);
  const transport = createFixtureTransport({ monotonic: () => Date.now() - sampleTime });
  onTestFinished(() => { transport.dispose(); vi.useRealTimers(); });
  const context = data(await transport.bootstrap());
  const spectator = transport.controls.addClient();
  const profile = context.qualification_profile!;
  const eventSocket = data(transport.connectEvents({ context }, await ticket(transport, context, "events"), silent));
  let frame: WorkspaceHeartbeat["displayed_robot_frame"] = null;
  data(transport.connectFrames({ context }, "robot", await ticket(transport, context, "robot-video"), {
    message(value) {
      const { frame_id, stream_epoch } = parseFrameEnvelope(value, profile, "robot")!.metadata;
      frame = { frame_id, stream_epoch };
    },
    closed() {},
  }));
  const lease = data(await transport.request("POST /control-lease", { context,
    body: { client_id: context.client_id, request_id: crypto.randomUUID(), session_id: null, takeover: false } }));
  const setup: WorkspaceHeartbeat = { type: "workspace_heartbeat", protocol_version: 1, backend_boot_id: context.backend_boot_id,
    client_id: context.client_id, client_lease_id: lease.client_lease_id!, session_id: null, control_generation: lease.control_generation,
    heartbeat_seq: 1, workspace_visible: true, workspace_focused: true, workspace_operational: true, displayed_robot_frame: frame };
  expect(eventSocket.heartbeat(setup)).toBe(true);
  const start = { client_id: context.client_id, client_lease_id: lease.client_lease_id!, object_id: "sample-wallet",
    expected_revision: 1, control_mode: "Gestures", action_id: crypto.randomUUID() } as const;
  await expect(transport.request("POST /sessions", { context, body: { ...start, expected_revision: 5 } }))
    .resolves.toMatchObject({ error: { code: "REVISION_CONFLICT" } });
  const committed = data(await transport.request("POST /sessions", { context, body: start }));
  const session = committed.result!.session!;
  const snapshot = async () => data(await transport.snapshot({ context }));
  const { control_generation } = (await snapshot()).lease;
  expect(control_generation).toBeGreaterThan(setup.control_generation);
  await expect(transport.request("POST /sessions", { context, body: start })).resolves.toMatchObject({ data: committed });
  await expect(transport.request("POST /sessions", { context, body: { ...start, action_id: crypto.randomUUID() } }))
    .resolves.toMatchObject({ error: { code: "ACTIVE_SESSION_EXISTS" } });
  expect(eventSocket.heartbeat({ ...setup, heartbeat_seq: 2 })).toBe(false);
  const current = { ...setup, session_id: session.id, control_generation, heartbeat_seq: 2 };
  expect(eventSocket.heartbeat(current)).toBe(false);
  await vi.advanceTimersByTimeAsync(80);
  expect(eventSocket.heartbeat({ ...current, displayed_robot_frame: frame })).toBe(true);

  const pause = { action: "pause", session_id: session.id, expected_revision: session.revision,
    client_id: spectator.client_id, client_lease_id: lease.client_lease_id!, action_id: crypto.randomUUID() } as const;
  await expect(transport.request("POST /sessions/{id}/actions", { id: session.id, context: spectator, body: pause }))
    .resolves.toMatchObject({ error: { code: "LEASE_REQUIRED" } });
  transport.controls.input("Gestures", "neutral");
  transport.controls.input("Gestures", "forward");
  expect((await snapshot()).runtime.motion_permission).toBe("Armed");
  const contextPause = { ...pause, client_id: context.client_id, action_id: crypto.randomUUID() };
  const paused = data(await transport.request("POST /sessions/{id}/actions", { id: session.id, context, body: contextPause })).result!.session!;
  const pauseGeneration = (await snapshot()).lease.control_generation;
  expect(pauseGeneration).toBeGreaterThan(control_generation);
  expect(eventSocket.heartbeat({ ...current, heartbeat_seq: 3, displayed_robot_frame: frame })).toBe(false);
  await vi.advanceTimersByTimeAsync(80);
  expect(eventSocket.heartbeat({ ...current, control_generation: pauseGeneration, heartbeat_seq: 3, displayed_robot_frame: frame })).toBe(true);
  const repeated = data(await transport.request("POST /sessions/{id}/actions", { id: session.id, context, body: {
    ...contextPause, action_id: crypto.randomUUID(), expected_revision: paused.revision,
  } })).result!.session;
  expect(repeated).toEqual(paused);
  const resumed = data(await transport.request("POST /sessions/{id}/actions", { id: session.id, context, body: {
    ...contextPause, action: "resume", action_id: crypto.randomUUID(), expected_revision: paused.revision,
  } })).result!.session;
  expect(resumed).toMatchObject({ id: session.id, state: "Searching" });
  const resumeGeneration = (await snapshot()).lease.control_generation;
  expect(resumeGeneration).toBeGreaterThan(pauseGeneration);
  expect(eventSocket.heartbeat({ ...current, control_generation: pauseGeneration, heartbeat_seq: 4, displayed_robot_frame: frame })).toBe(false);
  await vi.advanceTimersByTimeAsync(80);
  expect(eventSocket.heartbeat({ ...current, control_generation: resumeGeneration, heartbeat_seq: 4, displayed_robot_frame: frame })).toBe(true);
  transport.controls.input("Gestures", "neutral");
  transport.controls.input("Gestures", "left");
  expect((await snapshot()).runtime.motion_permission).toBe("Armed");
  await vi.advanceTimersByTimeAsync(profile.heartbeat_deadline_ms + 1);
  expect(await snapshot()).toMatchObject({ active_session: { id: session.id, state: "Paused" },
    lease: { state: "Unowned" }, runtime: { effective_session_state: "Paused", motion_permission: "Disarmed" } });
  const [failure] = (await snapshot()).failures;
  expect(failure).toMatchObject({ session_id: session.id, cause: "DisplayStale", restored: false, acknowledged: false });
  expect(eventSocket.heartbeat({ ...current, control_generation: resumeGeneration, heartbeat_seq: 5, displayed_robot_frame: frame })).toBe(false);
  expect((await snapshot()).runtime.control_generation).toBeGreaterThan(resumeGeneration);
  const takeover = data(await transport.request("POST /control-lease", { context,
    body: { client_id: context.client_id, request_id: crypto.randomUUID(), session_id: session.id, takeover: true } }));
  await vi.advanceTimersByTimeAsync(profile.heartbeat_deadline_ms + 1);
  expect((await snapshot()).failures).toEqual(expect.arrayContaining([
    expect.objectContaining({ cause: "HeartbeatExpired", session_id: session.id }),
  ]));
  expect((await snapshot()).runtime.control_generation).toBeGreaterThan(takeover.control_generation);
});

test("acknowledges only owned failure IDs and distinguishes recurrence from an outstanding observation", async () => {
  const transport = createFixtureTransport();
  onTestFinished(() => transport.dispose());
  const context = data(await transport.bootstrap());
  data(transport.connectEvents({ context }, await ticket(transport, context, "events"), silent));
  const snapshot = async () => data(await transport.snapshot({ context }));
  transport.controls.observePath("Command", false);
  expect((await snapshot()).failures).toEqual([]);
  transport.controls.observePath("Command", true);
  transport.controls.activateSearch("Searching");
  const session = (await snapshot()).active_session!;
  const lease = data(await transport.request("POST /control-lease", { context,
    body: { client_id: context.client_id, request_id: crypto.randomUUID(), session_id: session.id, takeover: true } }));
  const send = (expected_revision: number, ...failure_ids: [string, ...string[]]) =>
    transport.request("POST /sessions/{id}/actions", { context, id: session.id, body: { action: "acknowledge",
      action_id: crypto.randomUUID(), client_id: context.client_id, client_lease_id: lease.client_lease_id!,
      session_id: session.id, expected_revision, failure_ids } });
  transport.controls.observePath("Command", false);
  const [command] = (await snapshot()).failures;
  transport.controls.observePath("Command", false);
  expect((await snapshot()).failures).toEqual([command]);
  const paused = (await snapshot()).active_session!;
  expect(command.session_id).toBe(session.id);
  await expect(send(session.revision, command.failure_id)).resolves.toMatchObject({ error: { code: "REVISION_CONFLICT" } });
  await expect(send(paused.revision, command.failure_id, command.failure_id)).resolves.toMatchObject({ error: { code: "VALIDATION_FAILED" } });
  await expect(send(paused.revision, "unrelated-failure")).resolves.toMatchObject({ error: { code: "NOT_FOUND" } });
  await expect(transport.request("POST /sessions/{id}/actions", { context, id: foundSession.id, body: {
    action: "acknowledge", action_id: crypto.randomUUID(), client_id: context.client_id, client_lease_id: lease.client_lease_id!,
    session_id: foundSession.id, expected_revision: foundSession.revision, failure_ids: [command.failure_id],
  } })).resolves.toMatchObject({ error: { code: "OWNERSHIP_MISMATCH" } });
  const acknowledged = data(await send(paused.revision, command.failure_id)).result!.session!;
  expect((await snapshot()).failures).toEqual([{ ...command, acknowledged: true }]);
  transport.controls.observePath("Command", true);
  expect((await snapshot()).failures).toEqual([]);
  const restored = (await snapshot()).active_session!;
  expect(restored.revision).toBe(acknowledged.revision + 1);
  await expect(send(acknowledged.revision, command.failure_id)).resolves.toMatchObject({ error: { code: "REVISION_CONFLICT" } });
  expect(data(await send(restored.revision, command.failure_id)).result!.session).toEqual(restored);
  transport.controls.observePath("Command", false);
  const [next] = (await snapshot()).failures;
  expect(next).toMatchObject({ cause: "CommandUnavailable", session_id: session.id, acknowledged: false });
  expect(next.failure_id).not.toBe(command.failure_id);
});

test("protected spectator emergency stops the active scope and an idle request creates no session", async () => {
  const transport = createFixtureTransport();
  onTestFinished(() => transport.dispose());
  const context = data(await transport.bootstrap());
  const spectator = transport.controls.addClient();
  const emergency = { request_id: crypto.randomUUID(), client_id: spectator.client_id };
  const read = async () => data(await transport.snapshot({ context }));
  const stop = (body = emergency) => transport.emergency(body, { context: spectator });
  await expect(transport.emergency(emergency, { context: { ...spectator, capability: "invalid" } })).resolves.toMatchObject({
    error: { code: "CAPABILITY_INVALID" },
  });
  const idle = data(await stop());
  expect(idle).toMatchObject({ permission_revoked: true, session_id: null, failure_id: null, persistence: "Committed" });
  expect(await read()).toMatchObject({ active_session: null, failures: [] });
  transport.controls.activateSearch("Searching");
  const active = (await read()).active_session!;
  expect(data(await stop())).toEqual(idle);
  const [failure] = (await read()).failures;
  const activeRequest = { ...emergency, request_id: crypto.randomUUID() };
  transport.controls.scriptEmergency("lose-response");
  expect(await stop(activeRequest)).toEqual({ kind: "unavailable" });
  expect(data(await stop(activeRequest))).toMatchObject({ permission_revoked: true, session_id: active.id, failure_id: failure.failure_id });
  await expect(stop({ ...activeRequest, client_id: context.client_id })).resolves.toMatchObject({ status: 409,
    error: { code: "REQUEST_ID_CONFLICT", permission_revoked: true } });
  expect(await read()).toMatchObject({ active_session: { id: active.id, state: "Paused" }, failures: [failure] });
});

test.each(["confirm", "stop"] as const)("commits only %s when the other terminal action is already pending", async (winner) => {
  vi.useFakeTimers();
  vi.setSystemTime(sampleTime);
  const transport = createFixtureTransport({
    monotonic: () => Date.now() - sampleTime, now: () => Date.now(),
  });
  onTestFinished(() => { transport.dispose(); vi.useRealTimers(); });
  const context = data(await transport.bootstrap());
  const events: EventEnvelope[] = [];
  const eventSocket = data(transport.connectEvents({ context }, await ticket(transport, context, "events"), {
    ...silent, message: (event) => events.push(event),
  }));
  let frame: WorkspaceHeartbeat["displayed_robot_frame"] = null;
  data(transport.connectFrames({ context }, "robot", await ticket(transport, context, "robot-video"), {
    ...silent, message(value) {
      const { frame_id, stream_epoch } = parseFrameEnvelope(value, context.qualification_profile!, "robot")!.metadata;
      frame = { frame_id, stream_epoch };
    },
  }));
  const lease = data(await transport.request("POST /control-lease", { context,
    body: { client_id: context.client_id, request_id: crypto.randomUUID(), session_id: null, takeover: false } }));
  const owner = { client_id: context.client_id, client_lease_id: lease.client_lease_id! };
  const heartbeat: WorkspaceHeartbeat = { ...owner, type: "workspace_heartbeat", protocol_version: 1,
    backend_boot_id: context.backend_boot_id, session_id: null, control_generation: lease.control_generation,
    heartbeat_seq: 1, workspace_visible: true, workspace_focused: true, workspace_operational: true,
    displayed_robot_frame: frame };
  expect(eventSocket.heartbeat(heartbeat)).toBe(true);
  const started = data(await transport.request("POST /sessions", { context, body: {
    ...owner, action_id: crypto.randomUUID(), object_id: "sample-wallet", expected_revision: 1, control_mode: "Gestures",
  } })).result!.session!;
  const snapshot = async () => data(await transport.snapshot({ context }));
  const readObject = async () => data(await transport.request("GET /objects/{id}", { context, id: started.object_id }));
  const readMatches = async () => data(await transport.request("GET /sessions/{id}/matches", { context, id: started.id })).items;
  const searching = await snapshot();
  await vi.advanceTimersByTimeAsync(80);
  expect(eventSocket.heartbeat({ ...heartbeat, heartbeat_seq: 2, session_id: started.id,
    control_generation: searching.runtime.control_generation, displayed_robot_frame: frame })).toBe(true);
  transport.controls.input("Gestures", "neutral");
  transport.controls.input("Gestures", "forward");
  expect((await snapshot()).runtime.motion_permission).toBe("Armed");

  for (const observation of ["unprepared", "mismatched", "stale"] as const) {
    await transport.controls.observeCandidate(observation);
    expect(await readMatches()).toEqual([]);
  }
  await transport.controls.observeCandidate("visible");
  const paused = await snapshot();
  const pending = paused.pending_candidate!;
  expect({ frame_id: pending.frame_id, stream_epoch: pending.stream_epoch }).toEqual(frame);
  expect(pending).toMatchObject({ session_id: started.id, disposition: "Pending", reviewed_at_ms: null });
  expect(paused.runtime).toMatchObject({ effective_session_state: "Paused", motion_permission: "Disarmed" });
  expect(paused.runtime.control_generation).toBeGreaterThan(searching.runtime.control_generation);
  expect(events.find(({ type }) => type === "candidate_pending")).toMatchObject({
    session_id: started.id, session_revision: paused.active_session!.revision,
    payload: { match: pending, control_generation: paused.runtime.control_generation },
  });
  const evidence = data(await transport.media(pending.evidence_media.id, { context }));
  expect(evidence.headers["Content-Type"]).toBe("image/png");
  expect(evidence.bytes.length).toBe(pending.evidence_media.byte_length);

  const base = { ...owner, session_id: started.id, expected_revision: paused.active_session!.revision };
  const confirm = { ...base, action_id: crypto.randomUUID(), action: "confirm", candidate_id: pending.id } as const;
  const stop = { ...base, action_id: crypto.randomUUID(), action: "stop" } as const;
  const request = (body: SessionAction, client = context) =>
    transport.request("POST /sessions/{id}/actions", { context: client, id: started.id, body });
  const spectator = transport.controls.addClient();
  await expect(request({ ...confirm, client_id: spectator.client_id }, spectator)).resolves.toMatchObject({ error: { code: "LEASE_REQUIRED" } });
  await expect(request({ ...confirm, expected_revision: started.revision })).resolves.toMatchObject({ error: { code: "REVISION_CONFLICT" } });
  await expect(request({ ...confirm, candidate_id: "sample-confirmed" })).resolves.toMatchObject({ error: { code: "OWNERSHIP_MISMATCH" } });
  const winningAction = winner === "confirm" ? confirm : stop;
  const losingAction = winner === "confirm" ? stop : confirm;
  transport.controls.scriptSearch("fail");
  expect(data(await request(losingAction)).persistence).toBe("Failed");
  transport.controls.scriptSearch("pending");
  const pendingReceipt = data(await request(losingAction));
  expect(pendingReceipt.persistence).toBe("Pending");
  expect(data(await request(losingAction))).toEqual(pendingReceipt);
  expect((await readObject()).status).toBe("Lost");
  expect(await readMatches()).toEqual([pending]);

  const receipt = data(await request(winningAction));
  expect(receipt.persistence).toBe("Committed");
  await expect(request(losingAction)).resolves.toMatchObject({ data: { persistence: "Failed" } });
  expect(data(await request(winningAction))).toEqual(receipt);
  const session = data(await transport.request("GET /sessions/{id}", { context, id: started.id }));
  const [match] = await readMatches();
  expect(await readMatches()).toHaveLength(1);
  expect(session).toMatchObject({ state: "Ended", end_reason: winner === "confirm" ? "Confirmed" : "Stopped" });
  expect((await snapshot()).active_session).toBeNull();
  expect(data(await transport.media(pending.evidence_media.id, { context }))).toEqual(evidence);
  expect(match).toMatchObject(winner === "confirm"
    ? { disposition: "Confirmed", reviewed_at_ms: session.ended_at_ms }
    : { disposition: "NotReviewed", reviewed_at_ms: null });
  expect(await readObject()).toMatchObject(winner === "confirm"
    ? { status: "Found", found_at_ms: session.ended_at_ms }
    : { status: "Lost", found_at_ms: null });
  if (winner === "confirm") {
    expect(data(await transport.emergency({ request_id: crypto.randomUUID() }, { context: spectator })))
      .toMatchObject({ session_id: null, failure_id: null });
    expect(await readObject()).toMatchObject({ status: "Found", found_at_ms: session.ended_at_ms });
    expect(data(await transport.request("GET /sessions/{id}", { context, id: started.id }))).toEqual(session);
  }
});
