import type { EventEnvelope, Match, Operation, Snapshot } from "@/generated/api-v1";
import { componentNames } from "@/generated/api-v1";
import { conforms } from "@/lib/fixture-contracts";
import { pendingReview } from "@/lib/match-evidence";

function completeReadiness(readiness: Snapshot["readiness"]) {
  const names = new Set(readiness.components.map(({ component }) => component));
  return names.size === readiness.components.length && componentNames.every((name) => names.has(name));
}

function consistentReadiness(state: Snapshot) {
  if (!completeReadiness(state.readiness)) return false;
  const { can_start, components } = state.readiness;
  const shared = state.qualification_profile !== null && state.lease.state === "Owned" &&
    components.every(({ component, status }) => component === "Webcam" || component === "Controller" || status === "Ready");
  const selectedReady = (mode: NonNullable<Snapshot["active_session"]>["control_mode"]) =>
    components.some(({ component, status }) => component === (mode === "Gestures" ? "Webcam" : "Controller") && status === "Ready");
  const session = state.active_session;
  return (!can_start.Gestures || (shared && !session && selectedReady("Gestures"))) &&
    (!can_start.Controller || (shared && !session && selectedReady("Controller"))) &&
    (!state.readiness.can_resume || (shared && session?.state === "Paused" && selectedReady(session.control_mode) &&
      state.runtime.effective_session_state === "Paused" && !state.runtime.persistence_pending && !state.pending_candidate &&
      state.failures.every(({ restored, acknowledged }) => restored && acknowledged)));
}

function equalJson(left: unknown, right: unknown): boolean {
  if (left === right) return true;
  if (!left || !right || typeof left !== "object" || typeof right !== "object" || Array.isArray(left) !== Array.isArray(right)) return false;
  const other = right as Record<string, unknown>;
  const entries = Object.entries(left);
  return entries.length === Object.keys(other).length && entries.every(([key, value]) =>
    Object.hasOwn(other, key) && equalJson(value, other[key]));
}

function sameOperation(left: Operation, right: Operation) {
  return left.action_id === right.action_id && left.request_id === right.request_id;
}

function conflicts(previous: Operation, operation: Operation) {
  return previous.persistence === "Committed" &&
    (operation.persistence !== "Committed" || !equalJson(previous.result, operation.result));
}

export function validSnapshot(state: Snapshot, boot: string) {
  return conforms("Snapshot", state) && state.backend_boot_id === boot && consistentReadiness(state) &&
    state.qualification_profile_id === (state.qualification_profile?.profile_id ?? null) &&
    state.active_session?.state !== "Ended" &&
    state.runtime.control_generation === state.lease.control_generation &&
    (state.runtime.effective_session_state !== null) === (state.active_session !== null) &&
    (state.runtime.motion_permission === "Disarmed" || state.runtime.effective_session_state === "Searching") &&
    state.failures.every(({ session_id }) => session_id === state.active_session?.id) &&
    (state.active_object?.id ?? null) === (state.active_session?.object_id ?? null) &&
    (!state.pending_candidate || pendingReview(state));
}

function withOperation(state: Snapshot, operation: Operation | null) {
  if (!operation) return state;
  const existing = state.operations.find((previous) => sameOperation(previous, operation));
  if (existing && conflicts(existing, operation)) return;
  const operations = state.operations.filter((previous) => !sameOperation(previous, operation));
  operations.push(operation);
  const pending = operations.filter(({ persistence }) => persistence === "Pending");
  const completed = operations.filter(({ persistence }) => persistence !== "Pending");
  if (pending.length > 64) return undefined;
  return { ...state, operations: [...pending, ...completed.slice(-64)] };
}

export function withoutRemovedOwners(snapshot: Snapshot, removed?: ReadonlySet<string>): Snapshot {
  if (!removed?.size) return snapshot;
  const operations = snapshot.operations.filter(({ result }) =>
    ![result?.session?.object_id, result?.object?.id, result?.match?.object_id].some((id) => id && removed.has(id)));
  const active = snapshot.active_session;
  if (!active || !removed.has(active.object_id)) {
    return operations.length === snapshot.operations.length ? snapshot : { ...snapshot, operations };
  }
  return { ...snapshot, operations, active_object: null, active_session: null, pending_candidate: null, failures: [],
    lease: { ...snapshot.lease, state: "Unowned", owner_client_id: null, can_acquire: false },
    runtime: { ...snapshot.runtime, effective_session_state: null, motion_permission: "Disarmed", persistence_pending: false },
    readiness: { ...snapshot.readiness, can_start: { Gestures: false, Controller: false }, can_resume: false },
    retention: { ...snapshot.retention, active_object_expires_at_ms: null, active_object_grace: false } };
}

function sameCapture(left: Match, right: Match) {
  const before = left.evidence_media;
  const after = right.evidence_media;
  return left.id === right.id && left.session_id === right.session_id && left.object_id === right.object_id &&
    left.frame_id === right.frame_id && left.stream_epoch === right.stream_epoch && left.captured_at_ms === right.captured_at_ms &&
    left.box.x === right.box.x && left.box.y === right.box.y && left.box.width === right.box.width && left.box.height === right.box.height &&
    before.id === after.id && before.width === after.width && before.height === after.height &&
    before.byte_length === after.byte_length && before.created_at_ms === after.created_at_ms;
}

// Undefined invalidates the stream. Returning the same state discards a duplicate.
export function projectWorkspaceEvent(current: Snapshot | undefined, event: EventEnvelope, boot: string, replacing = false): Snapshot | undefined {
  if (!conforms("EventEnvelope", event) || event.backend_boot_id !== boot ||
      (event.session_id === null) !== (event.session_revision === null)) return;
  if (replacing && event.type !== "snapshot") return;
  if (current && event.event_seq < current.event_seq) return replacing ? undefined : current;
  if (event.type === "snapshot") {
    const { payload } = event;
    if (!validSnapshot(payload, boot) || payload.event_seq !== event.event_seq ||
        (payload.active_session?.id ?? null) !== event.session_id ||
        (payload.active_session?.revision ?? null) !== event.session_revision) return;
  } else if (!current) {
    return;
  }
  if (current && event.event_seq === current.event_seq && event.type !== "snapshot") return current;
  if (!replacing && current && event.event_seq > current.event_seq + 1) return;
  const session = current?.active_session;
  if (session?.id === event.session_id && event.session_revision !== null && event.session_revision < session.revision) return;
  if (event.type === "snapshot") {
    const { payload } = event;
    const previous = current?.pending_candidate;
    const candidate = payload.pending_candidate;
    if (previous && candidate && (previous.id === candidate.id || session?.revision === payload.active_session?.revision) &&
        !sameCapture(previous, candidate)) return;
    if (current && (payload.runtime.control_generation < current.runtime.control_generation ||
      payload.retention.settings.revision < current.retention.settings.revision ||
      (current.active_object && current.active_object.id === payload.active_object?.id &&
        payload.active_object.revision < current.active_object.revision) ||
      (session && session.id === payload.active_session?.id && session.revision === payload.active_session.revision &&
        !equalJson(session, payload.active_session)) ||
      payload.operations.some((operation) => current.operations.some((previous) =>
        sameOperation(previous, operation) && conflicts(previous, operation))))) return;
    return payload;
  }
  if (!current) return;
  const { payload } = event;
  // A new generation needs a full public lease projection. Runtime deltas
  // alone cannot establish the identity of the owner for that generation.
  if ("runtime" in payload && payload.runtime.control_generation !== current.lease.control_generation) return;
  const next = { ...current, event_seq: event.event_seq };
  if (event.type !== "session_changed" && event.session_id !== null &&
      (event.session_id !== session?.id || event.session_revision !== session.revision)) return;
  if ("runtime" in payload && event.type !== "session_changed" &&
      ((payload.runtime.effective_session_state !== null) !== (session !== null) ||
       (payload.runtime.motion_permission !== "Disarmed" && payload.runtime.effective_session_state !== "Searching"))) return;
  switch (event.type) {
    case "readiness_changed":
      const changed = { ...next, ...event.payload };
      return consistentReadiness(changed) ? changed : undefined;
    case "session_changed": {
      const { session: changed, runtime, operation } = event.payload;
      if (changed.id !== event.session_id || changed.revision !== event.session_revision) return;
      const result = operation?.result;
      if ((result?.session && !equalJson(result.session, changed)) || (result?.object && result.object.id !== changed.object_id) ||
          (result?.match && (result.match.session_id !== changed.id || result.match.object_id !== changed.object_id))) return;
      const ended = changed.state === "Ended";
      if (session && (session.id !== changed.id || session.object_id !== changed.object_id ||
          session.control_mode !== changed.control_mode || session.started_at_ms !== changed.started_at_ms ||
          (session.revision === changed.revision && !equalJson(session, changed)))) return;
      if (session?.revision === changed.revision && equalJson(current.runtime, runtime)) return withOperation(next, operation);
      const object = next.active_object ?? result?.object;
      if ((!ended && object?.id !== changed.object_id) || ended !== (runtime.effective_session_state === null ||
          runtime.effective_session_state === "Ended") ||
          (runtime.motion_permission !== "Disarmed" && runtime.effective_session_state !== "Searching")) return;
      const reviewsCandidate = changed.state === "Paused" && changed.pause_causes.some(({ cause }) => cause === "CandidateReview");
      return withOperation({ ...next, runtime, active_session: ended ? null : changed,
        active_object: ended ? null : object ?? null, failures: ended ? [] : next.failures,
        readiness: { ...next.readiness, can_start: { Gestures: false, Controller: false }, can_resume: false },
        retention: { ...next.retention, active_object_expires_at_ms: ended ? null : object?.expires_at_ms ?? null,
          active_object_grace: !ended && !!object?.retention_grace },
        pending_candidate: reviewsCandidate ? next.pending_candidate : null }, operation);
    }
    case "candidate_pending":
      if (!session || event.session_id !== session.id || event.session_revision !== session.revision ||
          event.payload.control_generation !== next.runtime.control_generation || !pendingReview(next, event.payload.match) ||
          (next.pending_candidate && !sameCapture(next.pending_candidate, event.payload.match))) return;
      return { ...next, pending_candidate: event.payload.match };
    case "recovery_changed":
      if (event.payload.failures.some((failure) => failure.session_id !== session?.id)) return;
      return { ...next, failures: event.payload.failures, runtime: event.payload.runtime,
        readiness: { ...next.readiness, can_resume: next.readiness.can_resume &&
          event.payload.failures.every(({ restored, acknowledged }) => restored && acknowledged) } };
    case "retention_changed": {
      const { retention, operation } = event.payload;
      if (retention.settings.revision < next.retention.settings.revision ||
          (operation?.result?.settings && operation.result.settings.revision !== retention.settings.revision) ||
          (retention.active_object_expires_at_ms === null) !== (next.active_object === null)) return;
      return withOperation({ ...next, retention, active_object: next.active_object && {
        ...next.active_object, expires_at_ms: retention.active_object_expires_at_ms!, retention_grace: retention.active_object_grace,
      } }, operation);
    }
    case "object_removed":
      return withoutRemovedOwners(next, new Set([event.payload.object_id]));
    case "storage_fault": {
      const components = structuredClone(next.readiness.components);
      const storage = components.find(({ component }) => component === "Storage");
      if (!storage) return;
      storage.status = "Unavailable";
      storage.cause_codes = [event.payload.code];
      return withOperation({ ...next, runtime: event.payload.runtime, retention: { ...next.retention, deletion: event.payload.deletion },
        readiness: { components, can_start: { Gestures: false, Controller: false }, can_resume: false } }, event.payload.operation);
    }
    case "proximity_warning_changed":
      return { ...next, proximity: event.payload.proximity };
  }
}
