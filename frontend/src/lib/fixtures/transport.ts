import type {
  EmergencyStopRequest, EventEnvelope, FrameMetadata, HttpResponses, LeaseAcquire, LeaseRelease, Object as LostObject, Session,
  RetentionChange, RetentionPreviewRequest,
  SessionAction, Snapshot, StartRequest, TicketRequest,
} from "@/generated/api-v1";
import { compatibleProfile, conforms } from "../fixture-contracts";
import { maxObjectNameLength, normalizeObjectName } from "../object-name";
import type {
  ApplicationTransport, Endpoint, HttpRequest, ObjectQuery, ProtectedMedia, ProtectedPath,
  ProtectedRequest, ReadResult, SocketObserver, SocketOffer,
} from "../transport";
import { sampleMediaBytes } from "./images";
import type { normalizeReference } from "../reference-image";
import { openRegistrations } from "./registration";
import { caseFold } from "./casefold";
import { emergencyResponse, emptyResult, mutation, reviewReceipt, startReceipt } from "./mutations";
import { fixturePages } from "./pages";
import { expiredObject, healthFor, leaseId, paused, recoveryFailure, sampleObject, sampleSession, sampleTime, searching } from "./samples";
import { readScenario, type ScenarioId } from "./scenarios";
import { expiryFor, openRetention, unavailableStorage } from "./retention";
import { fixtureOk as ok, fixtureError as error } from "./responses";
import { openSocketTickets } from "./socket-tickets";
import { openFixtureWorkspace, type FrameMode } from "./workspace";
import { committedSearch, openSearchSaves, type SearchDelivery } from "./search-saves";

type FixtureOptions = {
  scenario?: ScenarioId;
  now?: () => number;
  monotonic?: () => number;
  startSpecimen?: boolean;
  observeMutation?: (route: Endpoint, body: unknown) => void;
  normalizeRegistration?: typeof normalizeReference;
  scriptedRegistration?: (actionId: string, signal: AbortSignal) => Promise<"Committed" | "Failed" | undefined>;
  manualCleanup?: boolean;
};
type FixtureRequest = ProtectedRequest & {
  id?: string; query?: ObjectQuery; body?: unknown; actionCreatedAtMs?: number;
};
const missing = error(404, "NOT_FOUND", "Sample record not found.");
const expired = error(410, "EXPIRED", "Sample record expired.");
const invalid = error(422, "VALIDATION_FAILED", "A sample request field is invalid.");
const conflict = error(409, "REVISION_CONFLICT", "Sample revision has changed.");
type OrdinaryAction = Extract<SessionAction, { action: "pause" | "resume" | "stop" }>;
type SearchInput = "neutral" | "invalid" | "forward" | "backward" | "left" | "right";
const searchBusy = error(503, "CAPACITY_REACHED", "A sample search action is still saving.");

export function createFixtureTransport({
  scenario = "idle", now: fixtureNow, monotonic = () => performance.now(), startSpecimen = false,
  observeMutation, scriptedRegistration, normalizeRegistration, manualCleanup = false,
}: FixtureOptions = {}) {
  const startedAt = performance.now();
  const readClock = fixtureNow ?? (() => sampleTime + Math.floor(performance.now() - startedAt));
  let latestTime = readClock();
  let clockReversed = false;
  function now() {
    const reading = readClock();
    clockReversed = reading < latestTime;
    latestTime = Math.max(latestTime, reading);
    return latestTime;
  }
  const scene = readScenario(scenario);
  const { bootstrap } = scene;
  let { snapshot } = scene;
  const clients = new Set([bootstrap.client_id]);
  let { objects, sessions, matches } = scene;
  let snapshotError = scene.snapshotError;
  const lifetime = new AbortController();
  const pages = fixturePages();
  const retentionListeners = new Set<(owners?: readonly string[]) => void>();
  let retentionTimer: ReturnType<typeof setTimeout> | undefined;
  const healthy = () => scene.health.storage_integrity === "Healthy";
  const searchSaves = openSearchSaves(() => workspace.publish());
  let sampleInput: SearchInput | undefined;
  let neutralObserved = false;
  let dropRelease = false;
  const registrations = openRegistrations({
    now, signal: lifetime.signal, getSnapshot: () => ({ ...snapshot, retention: { ...snapshot.retention, ...retention.read() } }), healthy: healthy(),
    isExcluded: (id): boolean => retention.excluded(id),
    clockHealthy: () => { now(); return !clockReversed; },
    normalize: normalizeRegistration, recovery: scenario === "registration-recovery", scripted: scriptedRegistration,
  });
  const retention: ReturnType<typeof openRetention> = openRetention({
    now, initial: snapshot.retention, active: () => Boolean(snapshot.active_session), healthy, impactFor: retentionImpact,
    collectExpired: (settings, time) => allObjects().filter((object) =>
      !isActiveOwner(object.id) && expiryFor(object.registered_at_ms, settings.retention_days) <= time)
      .map(({ id }) => ({ id, files: 1 + matches.filter((match) => match.object_id === id).length })),
    purge(owners) {
      for (const owner of owners.keys()) searchSaves.purge(owner);
      objects = objects.filter(({ id }) => !owners.has(id));
      sessions = sessions.filter(({ object_id }) => !owners.has(object_id));
      matches = matches.filter(({ object_id }) => !owners.has(object_id));
      registrations.purge(owners);
    },
    invalidate, manualCleanup,
  });
  const storageBlocked = () => !healthy() || retention.read().deletion.status === "Failed";
  const readinessRead = (client = bootstrap.client_id) => {
    const { readiness } = snapshot;
    const { workspace: usable, displayed } = workspace.observations();
    const hasLiveOwner = snapshot.lease.owner_client_id === client && usable;
    const components = structuredClone(readiness.components);
    for (const observation of components) {
      if (observation.component === "Storage" && storageBlocked() && healthy()) {
        observation.status = "Unavailable";
        observation.cause_codes = ["STORAGE_UNAVAILABLE"];
      }
      if (observation.component === "Workspace" && (usable || workspace.hasEvents())) {
        observation.status = usable ? "Ready" : "Unavailable";
        observation.cause_codes = usable ? [] : ["NOT_READY"];
      }
      if (observation.component === "DisplayedRobotVideo" && (displayed || workspace.hasEvents())) {
        observation.status = displayed ? "Ready" : "Unavailable";
        observation.cause_codes = displayed ? [] : ["NOT_READY"];
      }
    }
    const sharedReady = !!profile && hasLiveOwner && displayed && !storageBlocked() &&
      components.every(({ component, status }) => component === "Webcam" || component === "Controller" || status === "Ready");
    const selectedReady = (mode: StartRequest["control_mode"]) =>
      components.some(({ component, status }) => component === (mode === "Gestures" ? "Webcam" : "Controller") && status === "Ready");
    const active = snapshot.active_session;
    return { components, can_start: {
      Gestures: sharedReady && !active && !searchSaves.pending() && selectedReady("Gestures"),
      Controller: sharedReady && !active && !searchSaves.pending() && selectedReady("Controller"),
    }, can_resume: sharedReady && active?.state === "Paused" && snapshot.runtime.effective_session_state === "Paused" &&
      !searchSaves.pending() && !snapshot.runtime.persistence_pending && !snapshot.pending_candidate &&
      snapshot.failures.every((failure) => failure.session_id !== active.id || (failure.restored && failure.acknowledged)) &&
      selectedReady(active.control_mode) };
  };
  const snapshotRead = (client = bootstrap.client_id): Snapshot => {
    const active_object = snapshot.active_object && projectObject(snapshot.active_object, now());
    const operations = [...snapshot.operations, ...searchSaves.operations(), ...registrations.operations().filter(({ result }) =>
      !result?.object || !retention.excluded(result.object.id)), ...retention.operations()];
    const pending = operations.filter(({ persistence }) => persistence === "Pending");
    const completed = operations.filter(({ persistence }) => persistence !== "Pending").slice(-64);
    return {
      ...snapshot, event_seq: workspace.watermark(), active_object, readiness: readinessRead(client),
      lease: snapshot.lease.state === "Owned" ? snapshot.lease : { ...snapshot.lease, can_acquire: workspace.canAcquire(client) },
      retention: { ...retention.read(), active_object_expires_at_ms: active_object?.expires_at_ms ?? null,
        active_object_grace: active_object?.retention_grace ?? false },
      operations: [...pending, ...completed],
    };
  };
  let emergencyFailure = snapshot.failures.find((failure) => failure.cause === "EmergencyStop" && !failure.restored);
  const profile = compatibleProfile(snapshot.qualification_profile) ? snapshot.qualification_profile : null;
  const tickets = openSocketTickets(monotonic, now);
  const workspace = openFixtureWorkspace({
    boot: bootstrap.backend_boot_id, profile, now, monotonic, read: snapshotRead, frameMode: scene.frameMode,
    available: (source) => snapshot.readiness.components.some(({ component, status }) =>
      component === (source === "robot" ? "RobotVideo" : "Webcam") && status === "Ready"),
    setLease(lease, pause) {
      sampleInput = undefined;
      neutralObserved = false;
      const session = snapshot.active_session;
      const pausedSession = pause && !storageBlocked() && session?.state === "Searching" ? {
        ...session, state: "Paused" as const, revision: session.revision + 1,
        pause_causes: [{ cause: "ManualPause" as const, failure_id: null }],
      } : session;
      if (pausedSession && pausedSession !== session) saveSession(pausedSession);
      snapshot = { ...snapshot, lease, active_session: pausedSession, runtime: {
        ...snapshot.runtime, effective_session_state: pause && session ? "Paused" : snapshot.runtime.effective_session_state,
        control_generation: lease.control_generation, motion_permission: "Disarmed",
      } };
    },
  });
  let failList = scene.recordsRecovery;
  let failDetail = scene.recordsRecovery;
  let expireContinuation = scene.recordsRecovery;
  let failHistory = scene.historyRecovery;
  let walletDetailsRead = false;
  let failDashboardHistory = scene.dashboardRecovery;
  let failMatches = scene.historyRecovery;
  let expireSessionCursor = scene.historyRecovery;
  let invalidateMatchCursor = scene.historyRecovery;

  function signalFor(signal?: AbortSignal) {
    return signal ? AbortSignal.any([signal, lifetime.signal]) : lifetime.signal;
  }

  function authorize({ context }: ProtectedRequest, clientRequired = true) {
    return context.backend_boot_id === bootstrap.backend_boot_id && context.capability === bootstrap.capability &&
      (!clientRequired || clients.has(context.client_id));
  }

  async function respond<T>(request: ProtectedRequest, makeResult: () => ReadResult<T> | Promise<ReadResult<T>>, clientRequired = true) {
    const signal = signalFor(request.signal);
    signal.throwIfAborted();
    await Promise.resolve();
    signal.throwIfAborted();
    if (!authorize(request, clientRequired)) return error(403, "CAPABILITY_INVALID", "Invalid sample request context.");
    retention.sweep();
    const result = await makeResult();
    scheduleRetention();
    signal.throwIfAborted();
    return structuredClone(result);
  }

  function allObjects() { return [...objects, ...registrations.records().map(({ object }) => object)]; }

  function isActiveOwner(id: string) {
    const session = snapshot.active_session;
    return session?.object_id === id && (session.state === "Searching" || session.state === "Paused");
  }

  function invalidate(owners?: string[]) {
    for (const owner of owners ?? []) searchSaves.purge(owner);
    workspace.publish();
    for (const listener of retentionListeners) listener(owners);
  }

  function scheduleRetention() {
    clearTimeout(retentionTimer);
    if (!retentionListeners.size || lifetime.signal.aborted) return;
    const { settings } = retention.read();
    const time = now();
    const deadline = allObjects().reduce((next, object) => {
      const expiry = expiryFor(object.registered_at_ms, settings.retention_days);
      return retention.excluded(object.id) || (isActiveOwner(object.id) && expiry <= time) ? next : Math.min(next, expiry);
    }, retention.nextCleanup());
    if (!Number.isFinite(deadline)) return;
    retentionTimer = setTimeout(() => { retention.sweep(); scheduleRetention(); if (now() >= deadline) invalidate(); },
      Math.min(Math.max(1, deadline - now()), 2_147_483_647));
  }

  function projectObject(object: LostObject, time: number): LostObject {
    const expires_at_ms = expiryFor(object.registered_at_ms, retention.read().settings.retention_days);
    return { ...object, expires_at_ms, retention_grace: expires_at_ms <= time && isActiveOwner(object.id) };
  }

  function eligibleObjects() {
    const time = now();
    return allObjects().filter(({ id }) => !retention.excluded(id))
      .map((object) => projectObject(object, time)).filter((object) => object.expires_at_ms > time || object.retention_grace);
  }

  function objectRead(id?: string) {
    const object = eligibleObjects().find((item) => item.id === id);
    if (object) return ok(object);
    return allObjects().some((item) => item.id === id) || (id === expiredObject.id && scenario !== "expiry-grace") ? expired : missing;
  }

  function sessionRead(id?: string) {
    const session = snapshot.active_session?.id === id && snapshot.active_session
      ? snapshot.active_session : sessions.find((item) => item.id === id);
    if (!session) return missing;
    const owner = objectRead(session.object_id);
    return owner.kind === "ok" ? ok(session) : owner;
  }

  function objectsPage(query: ObjectQuery = {}) {
    const { name, status, ...pagination } = query;
    if ((name !== undefined && typeof name !== "string") ||
        (status !== undefined && status !== "Found" && status !== "Lost")) return invalid;
    const normalizedName = normalizeObjectName(name ?? "");
    if ([...normalizedName].length > maxObjectNameLength) return invalid;
    const search = caseFold(normalizedName);
    const items = eligibleObjects().filter((object) =>
      (status === undefined || status === object.status) && caseFold(object.name).includes(search));
    return pages.read(items, (item) => item.registered_at_ms, JSON.stringify(["objects", normalizedName, status]), pagination, now());
  }

  function saveSession(session: Session) {
    sessions = sessions.some(({ id }) => id === session.id)
      ? sessions.map((value) => value.id === session.id ? session : value) : [...sessions, session];
  }

  function resetInput() {
    sampleInput = undefined;
    neutralObserved = false;
    snapshot = { ...snapshot, runtime: { ...snapshot.runtime, motion_permission: "Disarmed" } };
  }

  function advanceGeneration() {
    const control_generation = snapshot.lease.control_generation + 1;
    snapshot = { ...snapshot, lease: { ...snapshot.lease, control_generation },
      runtime: { ...snapshot.runtime, control_generation } };
    workspace.invalidateDisplayScope();
  }

  function start(body: StartRequest, client: string) {
    if (!conforms("StartRequest", body)) return invalid;
    if (body.client_id !== client) return error(403, "CLIENT_INVALID", "Unknown sample client.");
    const object = objectRead(body.object_id);
    if (object.kind !== "ok") return object;
    const fingerprint = JSON.stringify(["start", body.object_id, body.expected_revision, body.control_mode]);
    const retry = searchSaves.replay(body.action_id, fingerprint);
    if (retry) return retry;
    if (snapshot.active_session) return error(409, "ACTIVE_SESSION_EXISTS", "A sample search is already active.");
    if (searchSaves.pending()) return searchBusy;
    if (storageBlocked()) return unavailableStorage;
    if (object.data.revision !== body.expected_revision) return conflict;
    if (object.data.status !== "Lost") return error(409, "INVALID_TRANSITION", "Sample object is already Found.");
    if (startSpecimen && client === bootstrap.client_id && body.client_lease_id === leaseId) return mutation(body.action_id, "Committed", { ...startReceipt, session: {
      ...startReceipt.session, object_id: object.data.id, control_mode: body.control_mode,
    } }, 201, "/api/v1/sessions/sample-new-search");
    const owns = () => workspace.owns(client, body.client_lease_id);
    if (!owns()) return error(403, "LEASE_REQUIRED", "The current sample lease is required.");
    if (!readinessRead(client).can_start[body.control_mode]) return error(503, "NOT_READY", "Sample setup is unavailable.");
    if (object.data.reference_media.availability !== "Available") return error(503, "MEDIA_UNAVAILABLE", "The sample reference is unavailable.");
    const delivery = searchSaves.takeDelivery();
    if (delivery === "undelivered") return { kind: "unavailable" } as const;
    return searchSaves.admit("start", body.action_id, body.object_id, fingerprint, delivery, () => {
      const current = objectRead(body.object_id);
      if (current.kind !== "ok") return current;
      if (!owns() || !readinessRead(client).can_start[body.control_mode]) {
        return error(503, "NOT_READY", "The controlling setup became unavailable before Start was saved.");
      }
      if (current.data.revision !== body.expected_revision) return conflict;
      const session: Session = { id: crypto.randomUUID(), object_id: body.object_id, control_mode: body.control_mode,
        revision: 1, state: "Searching", started_at_ms: now(), ended_at_ms: null, end_reason: null, pause_causes: [] };
      resetInput();
      saveSession(session);
      snapshot = { ...snapshot, active_object: current.data, active_session: session, pending_candidate: null, failures: [],
        runtime: { ...snapshot.runtime, effective_session_state: "Searching", persistence_pending: false } };
      advanceGeneration();
      scheduleRetention();
      return committedSearch(body.action_id, { session }, `/api/v1/sessions/${session.id}`);
    });
  }

  function ordinaryAction(body: OrdinaryAction, client: string) {
    if (client !== body.client_id) return error(403, "CLIENT_INVALID", "Unknown sample client.");
    const read = sessionRead(body.session_id);
    if (read.kind !== "ok") return read;
    const fingerprint = JSON.stringify([body.action, body.session_id, body.expected_revision]);
    const retry = searchSaves.replay(body.action_id, fingerprint);
    if (retry) return retry;
    if (!workspace.owns(client, body.client_lease_id)) return error(403, "LEASE_REQUIRED", "The current sample lease is required.");
    const active = snapshot.active_session;
    if (active?.id !== body.session_id) return error(409, "INVALID_TRANSITION", "Sample session is inactive.");
    if (active.revision !== body.expected_revision) return conflict;
    if (body.action === "resume") {
      if (active.state !== "Paused") return error(409, "INVALID_TRANSITION", "Pause the search before resuming.");
      if (snapshot.pending_candidate) return error(409, "PENDING_REVIEW", "Complete the pending review first.");
      if (!readinessRead(client).can_resume) return error(409, "RECOVERY_REQUIRED", "Sample recovery or readiness is incomplete.");
    }
    const scripted = searchSaves.takeDelivery();
    if (scripted === "undelivered") return { kind: "unavailable" } as const;
    const delivery = storageBlocked() ? "fail" : scripted;
    if (body.action !== "resume") {
      const wasSearching = snapshot.runtime.effective_session_state === "Searching";
      resetInput();
      snapshot = { ...snapshot, runtime: { ...snapshot.runtime, effective_session_state: "Paused" } };
      if (wasSearching) advanceGeneration();
      // A safety action must prevent an older pending Resume from granting permission later.
      if (body.action === "stop" ? searchSaves.pending() : searchSaves.pending("resume")) searchSaves.finish(false);
    }
    if (searchSaves.pending()) {
      workspace.publish();
      return searchBusy;
    }
    snapshot = { ...snapshot, runtime: { ...snapshot.runtime, persistence_pending: delivery === "pending" } };
    return searchSaves.admit(body.action, body.action_id, active.object_id, fingerprint, delivery, () => {
      const session = snapshot.active_session;
      if (!session || session.id !== active.id || session.state === "Ended") return error(409, "INVALID_TRANSITION", "Sample session is inactive.");
      if (storageBlocked()) return unavailableStorage;
      if (body.action === "resume") {
        if (!workspace.owns(client, body.client_lease_id) || !readinessRead(client).can_resume ||
            session.revision !== body.expected_revision) return error(409, "RECOVERY_REQUIRED", "Resume conditions changed before saving.");
        resetInput();
        const resumed: Session = { ...session, state: "Searching", pause_causes: [], revision: session.revision + 1 };
        saveSession(resumed);
        snapshot = { ...snapshot, active_session: resumed,
          runtime: { ...snapshot.runtime, effective_session_state: "Searching" } };
        advanceGeneration();
        return committedSearch(body.action_id, { session: resumed });
      }
      if (body.action === "stop") {
        const candidate = snapshot.pending_candidate;
        const match = candidate && { ...candidate, disposition: "NotReviewed" as const, reviewed_at_ms: null };
        if (match) matches = matches.map((item) => item.id === match.id ? match : item);
        const grace = snapshotRead().active_object?.retention_grace;
        const ended = endFixtureSearch();
        return committedSearch(body.action_id, grace ? {} : { session: ended, match });
      }
      const paused: Session = session.state === "Paused" ? session : { ...session, state: "Paused",
        pause_causes: [{ cause: "ManualPause", failure_id: null }], revision: session.revision + 1 };
      saveSession(paused);
      snapshot = { ...snapshot, active_session: paused };
      return committedSearch(body.action_id, { session: paused });
    });
  }

  function retentionImpact(days: number, time: number) {
    const affected = eligibleObjects().filter((object) => expiryFor(object.registered_at_ms, days) <= time);
    const ownerIds = new Set(affected.map(({ id }) => id));
    const affectedSessions = sessions.filter(({ object_id }) => ownerIds.has(object_id));
    const affectedMatches = matches.filter(({ object_id }) => ownerIds.has(object_id));
    const media = [...affected.map(({ reference_media }) => reference_media), ...affectedMatches.map(({ evidence_media }) => evidence_media)];
    return {
      signature: JSON.stringify([[...ownerIds].sort(), affectedSessions.map(({ id }) => id).sort(),
        affectedMatches.map(({ id }) => id).sort(), media.map(({ id, byte_length }) => `${id}:${byte_length}`).sort()]),
      impact: { objects: affected.length, sessions: affectedSessions.length, matches: affectedMatches.length,
        managed_image_bytes: media.reduce((total, item) => total + item.byte_length, 0) },
    };
  }

  const handlers: { [Route in Endpoint]: (input: FixtureRequest) => ReadResult<HttpResponses[Route]> | Promise<ReadResult<HttpResponses[Route]>> } = {
    "GET /health": () => {
      const initialization = retention.read().deletion.status === "Failed" ? "Failed" : scene.health.initialization;
      return ok(healthFor({ ...snapshot, readiness: readinessRead() }, initialization), initialization === "Ready" ? 200 : 503);
    },
    "GET /snapshot": ({ context }) => {
      const error = snapshotError;
      if (scene.snapshotErrorOnce) snapshotError = undefined;
      return error ? { kind: "api-error", status: 503, error } : ok(snapshotRead(context.client_id));
    },
    "GET /objects": ({ query }) => {
      if (failList && query?.limit === undefined) {
        failList = false;
        return { kind: "unavailable" };
      }
      if (expireContinuation && query?.cursor) {
        expireContinuation = false;
        pages.clear();
      }
      return objectsPage(query);
    },
    "GET /objects/{id}": ({ id }) => {
      if (failDetail) {
        failDetail = false;
        return { kind: "unavailable" };
      }
      const result = objectRead(id);
      if (id === sampleObject.id && result.kind === "ok") walletDetailsRead = true;
      return result;
    },
    "GET /objects/{id}/sessions": ({ id, query }) => {
      const parent = objectRead(id);
      if (parent.kind !== "ok") return parent;
      if (id === sampleObject.id && failDashboardHistory) {
        failDashboardHistory = false;
        return { kind: "unavailable" };
      }
      // Arm the history failure after reading the wallet details.
      if (id === sampleObject.id && failHistory && walletDetailsRead) {
        failHistory = false;
        return { kind: "unavailable" };
      }
      if (id === sampleObject.id && query?.cursor && expireSessionCursor) {
        expireSessionCursor = false;
        return error(400, "CURSOR_EXPIRED", "Sample session cursor expired.");
      }
      const currentSessions = sessions.map((session) => snapshot.active_session?.id === session.id ? snapshot.active_session : session);
      return pages.read(currentSessions.filter((session) => session.object_id === id),
        (session) => session.started_at_ms, `sessions:${id}`, query ?? {}, now());
    },
    "GET /sessions/{id}": ({ id }) => sessionRead(id),
    "GET /sessions/{id}/matches": ({ id, query }) => {
      const parent = sessionRead(id);
      if (parent.kind !== "ok") return parent;
      if (id === sampleSession.id && failMatches) {
        failMatches = false;
        return { kind: "unavailable" };
      }
      if (id === sampleSession.id && query?.cursor && invalidateMatchCursor) {
        invalidateMatchCursor = false;
        return error(400, "CURSOR_INVALID", "Sample match cursor invalid.");
      }
      return pages.read(matches.filter((match) => match.session_id === id),
        (match) => match.captured_at_ms, `matches:${id}`, query ?? {}, now());
    },
    "GET /settings": () => ok(retention.read().settings),
    "POST /objects": (request) => registrations.submit(request as HttpRequest<"POST /objects">),
    "POST /sessions": ({ body, context }) => start(body as StartRequest, context.client_id),
    "POST /sessions/{id}/actions": ({ body: value, id, context }) => {
      const body = value as SessionAction;
      if (!conforms("SessionAction", body) || body.session_id !== id) return invalid;
      if (body.action === "pause" || body.action === "resume" || (body.action === "stop" && !startSpecimen)) {
        return ordinaryAction(body, context.client_id);
      }
      if (!startSpecimen) return error(409, "INVALID_TRANSITION", "This sample action is unavailable.");
      const session = sessionRead(id);
      if (session.kind !== "ok") return session;
      if (storageBlocked() && body.action !== "stop") return unavailableStorage;
      if (body.expected_revision !== session.data.revision) return conflict;
      if (snapshot.active_session?.id !== id) return error(409, "INVALID_TRANSITION", "Sample session is inactive.");
      if (snapshot.lease.state !== "Owned" || body.client_id !== bootstrap.client_id || body.client_lease_id !== leaseId) {
        return error(403, "LEASE_REQUIRED", "Invalid sample lease.");
      }
      if (body.action === "confirm" || body.action === "reject") {
        if (!matches.some(({ id }) => id === body.candidate_id)) return missing;
        if (snapshot.pending_candidate?.id !== body.candidate_id) return error(409, "OWNERSHIP_MISMATCH", "Candidate is outside the sample review.");
      }
      if (body.action === "acknowledge" && !body.failure_ids.every((id) => snapshot.failures.some((failure) => failure.failure_id === id))) return missing;
      const losesGrace = snapshotRead().active_object?.retention_grace && (body.action === "stop" || body.action === "confirm");
      if (losesGrace) endFixtureSearch(body.action === "confirm" ? "Confirmed" : "Stopped");
      return mutation(body.action_id, "Committed", losesGrace ? emptyResult : reviewReceipt(body, snapshot));
    },
    "POST /settings/retention-preview": ({ body }) => retention.preview(body as RetentionPreviewRequest),
    "PUT /settings/retention": ({ body: value }) => {
      const body = value as RetentionChange;
      const result = retention.apply(body);
      return result.kind === "ok" && retention.takeLostResponse(body.action_id) ? { kind: "unavailable" } : result;
    },
    "POST /websocket-tickets": ({ body: value, context }) => {
      const body = value as TicketRequest;
      if (!conforms("TicketRequest", body)) return invalid;
      if (body.client_id !== context.client_id) return error(403, "CLIENT_INVALID", "Unknown sample client.");
      if (!profile) return error(503, "NOT_READY", "Sample profile is unavailable.");
      return tickets.issue(context, body.channel);
    },
    "POST /control-lease": ({ body, context }) => workspace.acquire(context.client_id, body as LeaseAcquire),
    "POST /control-lease/release": ({ body, context }) => {
      if (dropRelease) { dropRelease = false; return { kind: "unavailable" }; }
      const result = workspace.release(context.client_id, body as LeaseRelease);
      if (result.kind === "ok" && result.data.snapshot.active_session?.state === "Searching" && storageBlocked()) {
        return { ...unavailableStorage, error: { ...unavailableStorage.error, permission_revoked: true } };
      }
      return result;
    },
    "POST /emergency-stop": ({ body }) => {
      if (scene.emergency === "network") return { kind: "unavailable" };
      const valid = conforms("EmergencyStopRequest", body);
      const session = snapshot.active_session;
      const committed = valid && scene.emergency === "Committed";
      const control_generation = snapshot.runtime.control_generation + 1;
      resetInput();
      if (session && !emergencyFailure) {
        const previous = snapshot.failures.find((failure) => failure.failure_id === recoveryFailure.failure_id);
        emergencyFailure = { ...recoveryFailure, session_id: session.id,
          failure_id: previous ? `${recoveryFailure.failure_id}-next` : recoveryFailure.failure_id };
      }
      const failure = session ? emergencyFailure : undefined;
      const alreadyRecorded = snapshot.failures.some(({ failure_id }) => failure_id === failure?.failure_id);
      workspace.clearOwnership();
      snapshot = {
        ...snapshot, lease: { state: "Unowned", owner_client_id: null, control_generation, can_acquire: false },
        runtime: {
          effective_session_state: session ? "Paused" : null, motion_permission: "Disarmed", control_generation,
          persistence_pending: !!session && scene.emergency === "Pending",
        },
        readiness: { ...snapshot.readiness, can_start: { Gestures: false, Controller: false }, can_resume: false },
        failures: failure && !alreadyRecorded ? [...snapshot.failures, failure] : snapshot.failures,
        active_session: committed && session && failure && !session.pause_causes.some(({ failure_id }) => failure_id === failure.failure_id) ? {
          ...session, state: "Paused", ended_at_ms: null, end_reason: null, revision: session.revision + 1,
          pause_causes: [...session.pause_causes, { cause: "RecoveryRequired", failure_id: failure.failure_id }],
        } : session,
      };
      workspace.publish();
      return valid ? emergencyResponse(body as EmergencyStopRequest, snapshot, failure?.failure_id ?? null, scene.emergency)
        : { kind: "api-error", status: 422, error: {
          code: "VALIDATION_FAILED", message: "Invalid sample emergency request.", retryable: false, permission_revoked: true,
        } };
    },
  };

  function endFixtureSearch(end_reason: Extract<Session, { state: "Ended" }>["end_reason"] = "Stopped") {
    const active = snapshot.active_session;
    if (!active) return;
    const ended: Session = { ...active, state: "Ended", end_reason, ended_at_ms: now(), revision: active.revision + 1, pause_causes: [] };
    saveSession(ended);
    resetInput();
    const control_generation = snapshot.runtime.control_generation + 1;
    workspace.clearOwnership();
    snapshot = { ...snapshot, active_object: null, active_session: null, pending_candidate: null, failures: [],
      lease: { state: "Unowned", owner_client_id: null, can_acquire: false, control_generation },
      runtime: { effective_session_state: null, motion_permission: "Disarmed", persistence_pending: false, control_generation },
      readiness: { ...snapshot.readiness, can_resume: false, can_start: { Gestures: false, Controller: false } } };
    retention.sweep();
    scheduleRetention();
    invalidate();
    return ended;
  }

  return {
    controls: {
      clockChanged() { retention.sweep(); scheduleRetention(); invalidate(); },
      save: retention.controlSave,
      isSavePending: retention.isSavePending,
      cleanup(failed: boolean) { retention.finishCleanup(failed); scheduleRetention(); },
      endSearch: endFixtureSearch,
      addClient() {
        const client_id = crypto.randomUUID();
        if (clients.size >= 64) throw new Error("Sample client capacity reached");
        clients.add(client_id);
        return { ...bootstrap, client_id };
      },
      changeFrames(mode: FrameMode) { workspace.changeFrames(mode); },
      disconnectEvents() { workspace.disconnectEvents(bootstrap.client_id); },
      scriptSearch(delivery: SearchDelivery) { searchSaves.script(delivery); },
      dropNextRelease() { dropRelease = true; },
      finishSearchSave(commit: boolean) {
        snapshot = { ...snapshot, runtime: { ...snapshot.runtime, persistence_pending: false } };
        searchSaves.finish(commit);
      },
      readInput: () => sampleInput,
      input(mode: StartRequest["control_mode"], input: SearchInput) {
        workspace.checkDeadline();
        if (snapshot.active_session?.control_mode !== mode || snapshot.runtime.effective_session_state !== "Searching" ||
            snapshot.lease.owner_client_id !== bootstrap.client_id || !workspace.observations().displayed ||
            storageBlocked() || snapshot.pending_candidate ||
            snapshot.failures.some(({ restored, acknowledged }) => !restored || !acknowledged)) return;
        const held = input !== "neutral" && input !== "invalid";
        const continuing = sampleInput === input && snapshot.runtime.motion_permission === "Armed";
        const permission = input === "neutral" ? "Arming" : held && (neutralObserved || continuing) ? "Armed" : "Disarmed";
        sampleInput = input;
        neutralObserved = input === "neutral";
        snapshot = { ...snapshot, runtime: { ...snapshot.runtime, motion_permission: permission } };
        workspace.publish("readiness_changed");
      },
      activateSearch(state: "Searching" | "Paused") {
        const result = objectRead(sampleObject.id);
        if (snapshot.active_session || storageBlocked() || result.kind !== "ok") return;
        const active_session = state === "Paused" ? paused : searching;
        snapshot = { ...snapshot, active_object: result.data, active_session,
          runtime: { ...snapshot.runtime, effective_session_state: state } };
        sessions = sessions.some(({ id }) => id === active_session.id)
          ? sessions.map((session) => session.id === active_session.id ? active_session : session) : [...sessions, active_session];
        scheduleRetention();
        invalidate();
      },
    },
    subscribeRetention(listener: (owners?: readonly string[]) => void) {
      retentionListeners.add(listener);
      scheduleRetention();
      return () => { retentionListeners.delete(listener); scheduleRetention(); };
    },
    async bootstrap(signal?: AbortSignal) {
      const scope = signalFor(signal);
      scope.throwIfAborted();
      await Promise.resolve();
      scope.throwIfAborted();
      return ok({ ...structuredClone(bootstrap), server_time_ms: now() });
    },
    request<Route extends Endpoint>(route: Route, request: HttpRequest<Route>): Promise<ReadResult<HttpResponses[Route]>> {
      return respond(request, () => {
        if (!route.startsWith("GET ") && route !== "POST /websocket-tickets") {
          observeMutation?.(route, "body" in request ? request.body : undefined);
        }
        return handlers[route](request);
      }, route !== "POST /emergency-stop");
    },
    get<Path extends ProtectedPath>(path: Path, request: ProtectedRequest & { id?: string }): Promise<ReadResult<HttpResponses[`GET ${Path}`]>> {
      return respond(request, () => handlers[`GET ${path}`](request));
    },
    snapshot: (request: ProtectedRequest) => respond(request, () => handlers["GET /snapshot"](request)),
    emergency: (body: EmergencyStopRequest, request: ProtectedRequest) => respond(request, () => {
      observeMutation?.("POST /emergency-stop", body);
      return handlers["POST /emergency-stop"]({ ...request, body });
    }, false),
    connectEvents(request: ProtectedRequest, offer: SocketOffer, observer: SocketObserver<EventEnvelope>) {
      const signal = signalFor(request.signal);
      if (signal.aborted) return { kind: "unavailable" } as const;
      if (!authorize(request)) return error(403, "TICKET_INVALID", "The channel ticket is invalid.");
      if (!profile) return error(503, "NOT_READY", "Sample profile is unavailable.");
      const redemption = tickets.redeem(request.context, "events", offer);
      if (redemption.kind !== "ok") return redemption;
      retention.sweep();
      scheduleRetention();
      return ok(workspace.connectEvents(request.context.client_id, observer, signal));
    },
    connectFrames(request: ProtectedRequest, source: FrameMetadata["source"], offer: SocketOffer, observer: SocketObserver<Uint8Array>) {
      const signal = signalFor(request.signal);
      if (signal.aborted) return { kind: "unavailable" } as const;
      if (!authorize(request)) return error(403, "TICKET_INVALID", "The channel ticket is invalid.");
      if (!profile) return error(503, "NOT_READY", "Sample profile is unavailable.");
      const redemption = tickets.redeem(request.context, source === "robot" ? "robot-video" : "webcam-video", offer);
      return redemption.kind !== "ok" ? redemption : ok(workspace.connectVideo(request.context.client_id, source, observer, signal));
    },
    media(id: string, request: ProtectedRequest) {
      return respond<ProtectedMedia>(request, () => {
        const registered = registrations.records().find(({ object }) => object.reference_media.id === id);
        const reference = registered?.object ?? objects.find(({ reference_media }) => reference_media.id === id);
        const match = matches.find(({ evidence_media }) => evidence_media.id === id);
        if (id === expiredObject.reference_media.id && !reference && scenario !== "expiry-grace") return expired;
        const media = reference?.reference_media ?? match?.evidence_media;
        if (!media) return missing;
        const owner = objectRead(reference?.id ?? match?.object_id);
        if (owner.kind !== "ok") return owner;
        if (media.availability !== "Available") return {
          kind: "api-error", status: 503,
          error: { code: "MEDIA_UNAVAILABLE", message: `Sample media is ${media.availability.toLowerCase()}.`, retryable: media.availability === "Missing" },
        };
        if ((scene.recordsRecovery && id === "sample-keys-a-reference") ||
            (scene.historyRecovery && id === "sample-earlier-evidence-4")) return { kind: "unavailable" };
        if (scene.recordsRecovery && id === "sample-usb-reference") return missing;
        const bytes = registered?.bytes ?? sampleMediaBytes(id, media.content_type);
        if ((scene.recordsRecovery && id === "sample-keys-Z-reference") ||
            (scene.historyRecovery && id === "sample-earlier-evidence-2")) bytes.fill(0);
        return ok({ bytes, headers: {
          "Content-Type": media.content_type, "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff", "Accept-Ranges": "none",
        } });
      });
    },
    dispose() {
      workspace.dispose();
      tickets.clear();
      lifetime.abort();
      clearTimeout(retentionTimer);
      retentionListeners.clear();
      pages.clear();
      registrations.clear();
    },
  } satisfies ApplicationTransport & { controls: object };
}
