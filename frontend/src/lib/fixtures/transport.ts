import type {
  EmergencyStopRequest, EventEnvelope, FrameMetadata, HttpResponses, Object as LostObject, Session,
  RetentionChange, RetentionPreviewRequest,
  SessionAction, StartRequest, TicketRequest,
} from "@/generated/api-v1";
import { compatibleProfile, conforms } from "../fixture-contracts";
import { maxObjectNameLength, normalizeObjectName } from "../object-name";
import type {
  ApplicationTransport, Endpoint, HttpRequest, ObjectQuery, ProtectedMedia, ProtectedPath,
  ProtectedRequest, ReadResult,
} from "../transport";
import { sampleMediaBytes } from "./images";
import type { normalizeReference } from "../reference-image";
import { openRegistrations } from "./registration";
import { caseFold } from "./casefold";
import { emergencyResponse, emptyResult, mutation, reviewReceipt, startReceipt } from "./mutations";
import { fixturePages } from "./pages";
import { expiredObject, healthFor, leaseId, paused, recoveryFailure, requestId, sampleObject, sampleSession, sampleTime, searching } from "./samples";
import { readScenario, type ScenarioId } from "./scenarios";
import { eventVectors, frameVector, snapshotEvent } from "./vectors";
import { expiryFor, openRetention, unavailableStorage } from "./retention";
import { fixtureOk as ok, fixtureError as error } from "./responses";

type FixtureOptions = {
  scenario?: ScenarioId;
  now?: () => number;
  eventScript?: "catalogue";
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

export function createFixtureTransport({
  scenario = "idle", now: fixtureNow, eventScript, observeMutation, scriptedRegistration, normalizeRegistration, manualCleanup = false,
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
  let { objects, sessions, matches } = scene;
  let snapshotError = scene.snapshotError;
  const lifetime = new AbortController();
  const pages = fixturePages();
  const retentionListeners = new Set<(owners?: readonly string[]) => void>();
  let retentionTimer: ReturnType<typeof setTimeout> | undefined;
  const healthy = () => scene.health.storage_integrity === "Healthy";
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
      objects = objects.filter(({ id }) => !owners.has(id));
      sessions = sessions.filter(({ object_id }) => !owners.has(object_id));
      matches = matches.filter(({ object_id }) => !owners.has(object_id));
      registrations.purge(owners);
    },
    invalidate, manualCleanup,
  });
  const storageBlocked = () => !healthy() || retention.read().deletion.status === "Failed";
  const readinessRead = () => {
    const { readiness } = snapshot;
    if (!healthy() || !storageBlocked()) return readiness;
    const blocked = structuredClone(readiness);
    const storage = blocked.components.find(({ component }) => component === "Storage");
    if (storage) { storage.status = "Unavailable"; storage.cause_codes = ["STORAGE_UNAVAILABLE"]; }
    return { ...blocked, can_start: { Gestures: false, Controller: false }, can_resume: false };
  };
  const snapshotRead = () => {
    const active_object = snapshot.active_object && projectObject(snapshot.active_object, now());
    const operations = [...snapshot.operations, ...registrations.operations().filter(({ result }) =>
      !result?.object || !retention.excluded(result.object.id)), ...retention.operations()];
    const pending = operations.filter(({ persistence }) => persistence === "Pending");
    const completed = operations.filter(({ persistence }) => persistence !== "Pending").slice(-64);
    return {
      ...snapshot, active_object, readiness: readinessRead(),
      retention: { ...retention.read(), active_object_expires_at_ms: active_object?.expires_at_ms ?? null,
        active_object_grace: active_object?.retention_grace ?? false },
      operations: [...pending, ...completed],
    };
  };
  let ticketSequence = 0;
  let emergencyFailure = snapshot.failures.find((failure) => failure.cause === "EmergencyStop" && !failure.restored);
  const profile = compatibleProfile(snapshot.qualification_profile) ? snapshot.qualification_profile : null;
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
      (!clientRequired || context.client_id === bootstrap.client_id);
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

  function start(body: StartRequest) {
    if (!conforms("StartRequest", body)) return invalid;
    const object = objectRead(body.object_id);
    if (object.kind !== "ok") return object;
    if (snapshot.active_session) return error(409, "ACTIVE_SESSION_EXISTS", "A sample search is already active.");
    if (storageBlocked()) return unavailableStorage;
    if (object.data.revision !== body.expected_revision) return conflict;
    if (object.data.status !== "Lost") return error(409, "INVALID_TRANSITION", "Sample object is already Found.");
    if (body.client_id !== bootstrap.client_id || body.client_lease_id !== leaseId) return error(403, "LEASE_REQUIRED", "Invalid sample lease.");
    if (!snapshot.readiness.can_start[body.control_mode]) return error(503, "NOT_READY", "Sample setup is unavailable.");
    return mutation(body.action_id, "Committed", { ...startReceipt, session: {
      ...startReceipt.session, object_id: object.data.id, control_mode: body.control_mode,
    } }, 201, "/api/v1/sessions/sample-new-search");
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
    "GET /snapshot": () => {
      const error = snapshotError;
      if (scene.snapshotErrorOnce) snapshotError = undefined;
      return error ? { kind: "api-error", status: 503, error } : ok(snapshotRead());
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
    "POST /sessions": ({ body }) => start(body as StartRequest),
    "POST /sessions/{id}/actions": ({ body: value, id }) => {
      const body = value as SessionAction;
      if (!conforms("SessionAction", body) || body.session_id !== id) return invalid;
      const session = sessionRead(id);
      if (session.kind !== "ok") return session;
      if (storageBlocked() && body.action !== "pause" && body.action !== "stop") return unavailableStorage;
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
      if (body.action === "resume" && !snapshot.readiness.can_resume) return error(409, "RECOVERY_REQUIRED", "Sample recovery is incomplete.");
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
    "POST /websocket-tickets": ({ body: value }) => {
      const body = value as TicketRequest;
      if (!conforms("TicketRequest", body)) return invalid;
      if (body.client_id !== bootstrap.client_id) return error(403, "CLIENT_INVALID", "Unknown sample client.");
      if (!profile) return error(503, "NOT_READY", "Sample profile is unavailable.");
      const sampleTicket = (++ticketSequence).toString(16).padStart(42, "E") + "A";
      return ok({ ticket: sampleTicket, expires_at_ms: now() + 10_000 });
    },
    "POST /control-lease": ({ body: value }) => {
      if (!conforms("LeaseAcquire", value)) return invalid;
      const body = value as HttpRequest<"POST /control-lease">["body"];
      if (body.client_id !== bootstrap.client_id) return error(403, "CLIENT_INVALID", "Unknown sample client.");
      if (!profile || scene.snapshot.lease.state !== "Owned") return error(503, "NOT_READY", "No sample lease is available.");
      if (body.request_id !== requestId) return snapshot.lease.state === "Owned"
        ? error(403, "LEASE_OWNED", "The sample lease is already owned.")
        : error(503, "NOT_READY", "No sample lease is available.");
      if (body.session_id !== (snapshot.active_session?.id ?? null)) return error(409, "OWNERSHIP_MISMATCH", "Wrong sample session.");
      if (body.takeover !== (body.session_id !== null)) return error(409, "REQUEST_ID_CONFLICT", "Sample acquisition differs from the original request.");
      return ok({ request_id: body.request_id, client_lease_id: leaseId, control_generation: scene.snapshot.lease.control_generation,
        lease: scene.snapshot.lease, snapshot: snapshotRead() });
    },
    "POST /control-lease/release": ({ body: value }) => {
      if (!conforms("LeaseRelease", value)) return invalid;
      const body = value as HttpRequest<"POST /control-lease/release">["body"];
      if (!profile || snapshot.lease.state !== "Owned" || body.client_id !== bootstrap.client_id ||
          body.client_lease_id !== leaseId || body.control_generation !== snapshot.lease.control_generation ||
          body.session_id !== (snapshot.active_session?.id ?? null)) return error(403, "LEASE_REQUIRED", "Invalid sample lease.");
      const control_generation = snapshot.lease.control_generation + 1;
      const lease = { state: "Unowned", owner_client_id: null, control_generation, can_acquire: false } as const;
      const released = { ...snapshotRead(), lease, runtime: { ...snapshot.runtime, control_generation, motion_permission: "Disarmed" } } satisfies typeof snapshot;
      if (released.active_session?.state === "Searching") {
        const session = released.active_session;
        released.active_session = { ...session, state: "Paused", revision: session.revision + 1,
          pause_causes: [{ cause: "ManualPause", failure_id: null }] };
        released.runtime.effective_session_state = "Paused";
      }
      released.readiness = { ...released.readiness, can_start: { Controller: false, Gestures: false }, can_resume: false };
      return ok({ request_id: body.request_id, client_lease_id: null, control_generation, lease, snapshot: released });
    },
    "POST /emergency-stop": ({ body }) => {
      if (scene.emergency === "network") return { kind: "unavailable" };
      const valid = conforms("EmergencyStopRequest", body);
      const session = snapshot.active_session;
      const committed = valid && scene.emergency === "Committed";
      const control_generation = snapshot.runtime.control_generation + 1;
      if (session && !emergencyFailure) {
        const previous = snapshot.failures.find((failure) => failure.failure_id === recoveryFailure.failure_id);
        emergencyFailure = { ...recoveryFailure, session_id: session.id,
          failure_id: previous ? `${recoveryFailure.failure_id}-next` : recoveryFailure.failure_id };
      }
      const failure = session ? emergencyFailure : undefined;
      const alreadyRecorded = snapshot.failures.some(({ failure_id }) => failure_id === failure?.failure_id);
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
      return valid ? emergencyResponse(body as EmergencyStopRequest, snapshot, failure?.failure_id ?? null, scene.emergency)
        : { kind: "api-error", status: 422, error: {
          code: "VALIDATION_FAILED", message: "Invalid sample emergency request.", retryable: false, permission_revoked: true,
        } };
    },
  };

  function subscribe(request: ProtectedRequest, deliver: () => void) {
    const signal = signalFor(request.signal);
    if (signal.aborted || !authorize(request) || !profile) return () => {};
    let active = true;
    queueMicrotask(() => { if (active && !signal.aborted) deliver(); });
    return () => { active = false; };
  }

  function endFixtureSearch(end_reason: Extract<Session, { state: "Ended" }>["end_reason"] = "Stopped") {
    const active = snapshot.active_session;
    if (!active) return;
    const ended: Session = { ...active, state: "Ended", end_reason, ended_at_ms: now(), revision: active.revision + 1, pause_causes: [] };
    sessions = sessions.map((session) => session.id === ended.id ? ended : session);
    const control_generation = snapshot.runtime.control_generation + 1;
    snapshot = { ...snapshot, active_object: null, active_session: null, pending_candidate: null, failures: [],
      lease: { state: "Unowned", owner_client_id: null, can_acquire: false, control_generation },
      runtime: { effective_session_state: null, motion_permission: "Disarmed", persistence_pending: false, control_generation },
      readiness: { ...snapshot.readiness, can_resume: false, can_start: { Gestures: false, Controller: false } } };
    retention.sweep();
    scheduleRetention();
    invalidate();
  }

  return {
    controls: {
      clockChanged() { retention.sweep(); scheduleRetention(); invalidate(); },
      save: retention.controlSave,
      isSavePending: retention.isSavePending,
      cleanup(failed: boolean) { retention.finishCleanup(failed); scheduleRetention(); },
      endSearch: endFixtureSearch,
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
        if (!route.startsWith("GET ")) observeMutation?.(route, "body" in request ? request.body : undefined);
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
    subscribeEvents(request: ProtectedRequest, onEvent: (event: EventEnvelope) => void) {
      const signal = signalFor(request.signal);
      let subscribed = true;
      const unsubscribe = subscribe(request, () => {
        retention.sweep();
        scheduleRetention();
        const events = eventScript === "catalogue" ? eventVectors : [snapshotEvent(snapshotRead())];
        for (const event of events) {
          if (!subscribed || signal.aborted) break;
          onEvent(structuredClone<EventEnvelope>(event));
        }
      });
      return () => { subscribed = false; unsubscribe(); };
    },
    subscribeFrames(request: ProtectedRequest, source: FrameMetadata["source"], onFrame: (frame: Uint8Array) => void) {
      return subscribe(request, () => {
        const frame = frameVector(source, profile);
        if (frame) onFrame(frame);
      });
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
    dispose() { lifetime.abort(); clearTimeout(retentionTimer); retentionListeners.clear(); pages.clear(); registrations.clear(); },
  } satisfies ApplicationTransport & { controls: object };
}
