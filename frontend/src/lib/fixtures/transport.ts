import type {
  EmergencyStopRequest, Error as ApiError, EventEnvelope, FrameMetadata, HttpResponses,
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
import {
  emergencyResponse, emptyResult, mutation, reviewReceipt,
  sampleRetentionPreview, startReceipt,
} from "./mutations";
import { fixturePages } from "./pages";
import { day, expiredObject, healthFor, leaseId, recoveryFailure, requestId, sampleObject, sampleSession, sampleTime } from "./samples";
import { readScenario, type ScenarioId } from "./scenarios";
import { eventVectors, frameVector, snapshotEvent } from "./vectors";

type FixtureOptions = {
  scenario?: ScenarioId;
  now?: () => number;
  eventScript?: "catalogue";
  observeMutation?: (route: Endpoint, body: unknown) => void;
  normalizeRegistration?: typeof normalizeReference;
  scriptedRegistration?: (actionId: string, signal: AbortSignal) => Promise<"Committed" | "Failed" | undefined>;
};
type FixtureRequest = ProtectedRequest & {
  id?: string; query?: ObjectQuery; body?: unknown; actionCreatedAtMs?: number;
};
const ok = <T>(data: T, status = 200): ReadResult<T> => ({ kind: "ok", status, data });
const error = (status: number, code: ApiError["code"], message: string): ReadResult<never> =>
  ({ kind: "api-error", status, error: { code, message, retryable: false } });
const missing = error(404, "NOT_FOUND", "Sample record not found.");
const expired = error(410, "EXPIRED", "Sample record expired.");
const invalid = error(422, "VALIDATION_FAILED", "A sample request field is invalid.");
const conflict = error(409, "REVISION_CONFLICT", "Sample revision has changed.");

export function createFixtureTransport({
  scenario = "idle", now: fixtureNow, eventScript, observeMutation, scriptedRegistration, normalizeRegistration,
}: FixtureOptions = {}): ApplicationTransport {
  const startedAt = performance.now();
  const now = fixtureNow ?? (() => sampleTime + Math.floor(performance.now() - startedAt));
  const scene = readScenario(scenario);
  const { bootstrap } = scene;
  let { snapshot } = scene;
  const lifetime = new AbortController();
  const pages = fixturePages();
  const registrations = openRegistrations({
    now, signal: lifetime.signal, getSnapshot: () => snapshot, healthy: scene.health.storage_integrity === "Healthy",
    normalize: normalizeRegistration, recovery: scenario === "registration-recovery", scripted: scriptedRegistration,
  });
  const snapshotRead = () => ({ ...snapshot, operations: [...snapshot.operations, ...registrations.operations()] });
  const previews = new Map<string, { value: ReturnType<typeof sampleRetentionPreview>; owners: string }>();
  const retentionReceipts = new Map<string, { fingerprint: string; response: ReturnType<typeof mutation> }>();
  let previewSequence = 0;
  let ticketSequence = 0;
  let emergencyFailure = snapshot.failures.find((failure) => failure.cause === "EmergencyStop" && !failure.restored);
  const profile = compatibleProfile(snapshot.qualification_profile) ? snapshot.qualification_profile : null;
  let failList = scene.recordsRecovery;
  let failDetail = scene.recordsRecovery;
  let expireContinuation = scene.recordsRecovery;
  let failHistory = scene.historyRecovery;
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
    const result = await makeResult();
    signal.throwIfAborted();
    return structuredClone(result);
  }

  function eligibleObjects() {
    const time = now();
    return [...scene.objects.filter((object) => object.expires_at_ms > time ||
        (object.retention_grace && snapshot.active_session?.object_id === object.id)),
      ...registrations.records().map(({ object }) => object)];
  }

  function objectRead(id?: string) {
    const object = eligibleObjects().find((item) => item.id === id);
    if (object) return ok(object);
    return scene.objects.some((item) => item.id === id) || id === expiredObject.id || registrations.isExpired(id) ? expired : missing;
  }

  function sessionRead(id?: string) {
    const session = snapshot.active_session?.id === id && snapshot.active_session
      ? snapshot.active_session : scene.sessions.find((item) => item.id === id);
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
    if (scene.snapshot.retention.deletion.status === "Failed") return error(503, "STORAGE_UNAVAILABLE", "Sample deletion is incomplete.");
    if (object.data.revision !== body.expected_revision) return conflict;
    if (object.data.status !== "Lost") return error(409, "INVALID_TRANSITION", "Sample object is already Found.");
    if (body.client_id !== bootstrap.client_id || body.client_lease_id !== leaseId) return error(403, "LEASE_REQUIRED", "Invalid sample lease.");
    if (!snapshot.readiness.can_start[body.control_mode]) return error(503, "NOT_READY", "Sample setup is unavailable.");
    return mutation(body.action_id, "Committed", { ...startReceipt, session: {
      ...startReceipt.session, object_id: object.data.id, control_mode: body.control_mode,
    } }, 201, "/api/v1/sessions/sample-new-search");
  }

  function retentionImpact(days: number, time: number) {
    const affected = eligibleObjects().filter((object) => object.registered_at_ms + days * day <= time);
    const ownerIds = new Set(affected.map(({ id }) => id));
    const sessions = scene.sessions.filter(({ object_id }) => ownerIds.has(object_id));
    const matches = scene.matches.filter(({ object_id }) => ownerIds.has(object_id));
    const media = [...affected.map(({ reference_media }) => reference_media), ...matches.map(({ evidence_media }) => evidence_media)];
    return {
      owners: JSON.stringify([...ownerIds]),
      impact: { objects: affected.length, sessions: sessions.length, matches: matches.length,
        managed_image_bytes: media.reduce((total, item) => total + item.byte_length, 0) },
    };
  }

  const handlers: { [Route in Endpoint]: (input: FixtureRequest) => ReadResult<HttpResponses[Route]> | Promise<ReadResult<HttpResponses[Route]>> } = {
    "GET /health": () => ok(healthFor(snapshot, scene.health.initialization), scene.health.initialization === "Ready" ? 200 : 503),
    "GET /snapshot": () => scene.snapshotError ? { kind: "api-error", status: 503, error: scene.snapshotError } : ok(snapshotRead()),
    "GET /objects": ({ query }) => {
      if (failList) {
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
      return objectRead(id);
    },
    "GET /objects/{id}/sessions": ({ id, query }) => {
      const parent = objectRead(id);
      if (parent.kind !== "ok") return parent;
      if (id === sampleObject.id && failHistory) {
        failHistory = false;
        return { kind: "unavailable" };
      }
      if (id === sampleObject.id && query?.cursor && expireSessionCursor) {
        expireSessionCursor = false;
        return error(400, "CURSOR_EXPIRED", "Sample session cursor expired.");
      }
      const sessions = scene.sessions.map((session) => snapshot.active_session?.id === session.id ? snapshot.active_session : session);
      return pages.read(sessions.filter((session) => session.object_id === id),
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
      return pages.read(scene.matches.filter((match) => match.session_id === id),
        (match) => match.captured_at_ms, `matches:${id}`, query ?? {}, now());
    },
    "GET /settings": () => ok(snapshot.retention.settings),
    "POST /objects": (request) => registrations.submit(request as HttpRequest<"POST /objects">),
    "POST /sessions": ({ body }) => start(body as StartRequest),
    "POST /sessions/{id}/actions": ({ body: value, id }) => {
      const body = value as SessionAction;
      if (!conforms("SessionAction", body) || body.session_id !== id) return invalid;
      const session = sessionRead(id);
      if (session.kind !== "ok") return session;
      if (body.expected_revision !== session.data.revision) return conflict;
      if (snapshot.active_session?.id !== id) return error(409, "INVALID_TRANSITION", "Sample session is inactive.");
      if (snapshot.lease.state !== "Owned" || body.client_id !== bootstrap.client_id || body.client_lease_id !== leaseId) {
        return error(403, "LEASE_REQUIRED", "Invalid sample lease.");
      }
      if (body.action === "confirm" || body.action === "reject") {
        if (!scene.matches.some(({ id }) => id === body.candidate_id)) return missing;
        if (snapshot.pending_candidate?.id !== body.candidate_id) return error(409, "OWNERSHIP_MISMATCH", "Candidate is outside the sample review.");
      }
      if (body.action === "acknowledge" && !body.failure_ids.every((id) => snapshot.failures.some((failure) => failure.failure_id === id))) return missing;
      if (body.action === "resume" && !snapshot.readiness.can_resume) return error(409, "RECOVERY_REQUIRED", "Sample recovery is incomplete.");
      const losesGrace = snapshot.active_object?.retention_grace && (body.action === "stop" || body.action === "confirm");
      return mutation(body.action_id, "Committed", losesGrace ? emptyResult : reviewReceipt(body, snapshot));
    },
    "POST /settings/retention-preview": ({ body: value }) => {
      const body = value as RetentionPreviewRequest;
      if (!conforms("RetentionPreviewRequest", body)) return invalid;
      if (snapshot.active_session) return error(409, "ACTIVE_SESSION_EXISTS", "A sample search is already active.");
      if (body.expected_revision !== snapshot.retention.settings.revision) return conflict;
      const time = now();
      const { owners, impact } = retentionImpact(body.retention_days, time);
      const preview = sampleRetentionPreview(`sample-retention-preview-${++previewSequence}`,
        body.retention_days, body.expected_revision, time, impact);
      const oldest = previews.keys().next().value;
      if (previews.size >= 32 && oldest !== undefined) previews.delete(oldest);
      previews.set(preview.preview_id, { value: preview, owners });
      return ok(preview);
    },
    "PUT /settings/retention": ({ body: value }) => {
      const body = value as RetentionChange;
      if (!conforms("RetentionChange", body)) return invalid;
      const fingerprint = JSON.stringify([body.expected_revision, body.retention_days, body.preview_id]);
      const receipt = retentionReceipts.get(body.action_id);
      if (receipt) return receipt.fingerprint === fingerprint ? receipt.response
        : error(409, "ACTION_ID_CONFLICT", "Sample action ID was used for a different request.");
      if (snapshot.active_session) return error(409, "ACTIVE_SESSION_EXISTS", "A sample search is already active.");
      if (body.expected_revision !== snapshot.retention.settings.revision) return conflict;
      const entry = previews.get(body.preview_id);
      const preview = entry?.value;
      const time = now();
      if (!preview || preview.expires_at_ms <= time || preview.retention_days !== body.retention_days ||
          entry.owners !== retentionImpact(body.retention_days, time).owners) {
        return error(409, "PREVIEW_STALE", "Sample retention preview expired or changed.");
      }
      const previous = snapshot.retention.settings;
      const settings = previous.retention_days === body.retention_days ? previous
        : { retention_days: body.retention_days, revision: previous.revision + 1, updated_at_ms: time };
      const deletion = preview.impact.objects > 0 ? {
        status: "Pending", remaining_objects: preview.impact.objects, remaining_files: preview.impact.matches + preview.impact.objects, error_code: null,
      } as const : snapshot.retention.deletion;
      if (retentionReceipts.size >= 64) return error(503, "CAPACITY_REACHED", "Sample receipt capacity reached.");
      const response = mutation(body.action_id, "Committed", { ...emptyResult, settings, deletion });
      retentionReceipts.set(body.action_id, { fingerprint, response });
      return response;
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
        lease: scene.snapshot.lease, snapshot });
    },
    "POST /control-lease/release": ({ body: value }) => {
      if (!conforms("LeaseRelease", value)) return invalid;
      const body = value as HttpRequest<"POST /control-lease/release">["body"];
      if (!profile || snapshot.lease.state !== "Owned" || body.client_id !== bootstrap.client_id ||
          body.client_lease_id !== leaseId || body.control_generation !== snapshot.lease.control_generation ||
          body.session_id !== (snapshot.active_session?.id ?? null)) return error(403, "LEASE_REQUIRED", "Invalid sample lease.");
      const control_generation = snapshot.lease.control_generation + 1;
      const lease = { state: "Unowned", owner_client_id: null, control_generation, can_acquire: false } as const;
      const released = { ...snapshot, lease, runtime: { ...snapshot.runtime, control_generation, motion_permission: "Disarmed" } } satisfies typeof snapshot;
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

  return {
    async bootstrap(signal) {
      const scope = signalFor(signal);
      scope.throwIfAborted();
      await Promise.resolve();
      scope.throwIfAborted();
      return ok({ ...structuredClone(bootstrap), server_time_ms: now() });
    },
    request<Route extends Endpoint>(route: Route, request: HttpRequest<Route>) {
      return respond(request, () => {
        if (!route.startsWith("GET ")) observeMutation?.(route, "body" in request ? request.body : undefined);
        return handlers[route](request);
      }, route !== "POST /emergency-stop");
    },
    get<Path extends ProtectedPath>(path: Path, request: ProtectedRequest & { id?: string }) {
      return respond(request, () => handlers[`GET ${path}`](request));
    },
    snapshot: (request) => respond(request, () => handlers["GET /snapshot"](request)),
    emergency: (body, request) => respond(request, () => {
      observeMutation?.("POST /emergency-stop", body);
      return handlers["POST /emergency-stop"]({ ...request, body });
    }, false),
    subscribeEvents(request, onEvent) {
      const events = eventScript === "catalogue" ? eventVectors : [snapshotEvent(snapshotRead())];
      const signal = signalFor(request.signal);
      let subscribed = true;
      const unsubscribe = subscribe(request, () => {
        for (const event of events) {
          if (!subscribed || signal.aborted) break;
          onEvent(structuredClone<EventEnvelope>(event));
        }
      });
      return () => { subscribed = false; unsubscribe(); };
    },
    subscribeFrames(request, source: FrameMetadata["source"], onFrame) {
      return subscribe(request, () => {
        const frame = frameVector(source, profile);
        if (frame) onFrame(frame);
      });
    },
    media(id, request) {
      return respond<ProtectedMedia>(request, () => {
        const registered = registrations.records().find(({ object }) => object.reference_media.id === id);
        const reference = registered?.object ?? scene.objects.find(({ reference_media }) => reference_media.id === id);
        const match = scene.matches.find(({ evidence_media }) => evidence_media.id === id);
        if (id === expiredObject.reference_media.id && !reference) return expired;
        const media = reference?.reference_media ?? match?.evidence_media;
        if (!media) return registrations.isExpired(id) ? expired : missing;
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
    dispose() { lifetime.abort(); pages.clear(); previews.clear(); retentionReceipts.clear(); registrations.clear(); },
  };
}
