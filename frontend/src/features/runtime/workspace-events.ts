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
  const shared = state.qualification_profile !== null && state.lease.state === "Owned" && !state.active_session &&
    components.every(({ component, status }) => component === "Webcam" || component === "Controller" || status === "Ready");
  return (!can_start.Gestures || (shared && components.some(({ component, status }) => component === "Webcam" && status === "Ready"))) &&
    (!can_start.Controller || (shared && components.some(({ component, status }) => component === "Controller" && status === "Ready")));
}

export function validSnapshot(state: Snapshot, boot: string) {
  return conforms("Snapshot", state) && state.backend_boot_id === boot && consistentReadiness(state) &&
    state.qualification_profile_id === (state.qualification_profile?.profile_id ?? null) &&
    state.active_session?.state !== "Ended" &&
    state.runtime.control_generation === state.lease.control_generation &&
    (state.active_object?.id ?? null) === (state.active_session?.object_id ?? null) &&
    (!state.pending_candidate || pendingReview(state));
}

function withOperation(state: Snapshot, operation: Operation | null) {
  if (!operation) return state;
  const operations = state.operations.filter((existing) =>
    existing.action_id !== operation.action_id || existing.request_id !== operation.request_id);
  operations.push(operation);
  const pending = operations.filter(({ persistence }) => persistence === "Pending");
  const completed = operations.filter(({ persistence }) => persistence !== "Pending");
  if (pending.length > 64) return undefined;
  return { ...state, operations: [...pending, ...completed.slice(-64)] };
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
export function projectWorkspaceEvent(current: Snapshot | undefined, event: EventEnvelope, boot: string): Snapshot | undefined {
  if (!conforms("EventEnvelope", event) || event.backend_boot_id !== boot ||
      (event.session_id === null) !== (event.session_revision === null)) return;
  if (current && event.event_seq < current.event_seq) return current;
  if (event.type === "snapshot") {
    const { payload } = event;
    if (!validSnapshot(payload, boot) || payload.event_seq !== event.event_seq ||
        (payload.active_session?.id ?? null) !== event.session_id ||
        (payload.active_session?.revision ?? null) !== event.session_revision) return;
  } else if (!current) {
    return;
  }
  if (current && event.event_seq === current.event_seq) return current;
  if (current && event.event_seq > current.event_seq + 1) return;
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
        payload.active_object.revision < current.active_object.revision))) return;
    return payload;
  }
  if (!current) return;
  const next = { ...current, event_seq: event.event_seq };
  const { payload } = event;
  if ("runtime" in payload && payload.runtime.control_generation !== current.lease.control_generation) return;
  switch (event.type) {
    case "readiness_changed":
      const changed = { ...next, ...event.payload };
      return consistentReadiness(changed) ? changed : undefined;
    case "session_changed": {
      const { session, runtime } = event.payload;
      if (session.id !== event.session_id || session.revision !== event.session_revision) return;
      // A new active record needs the matching object from a fresh snapshot.
      if (session.state !== "Ended" && session.object_id !== next.active_object?.id) return;
      return withOperation({ ...next, runtime, active_session: session.state === "Ended" ? null : session,
        active_object: session.state === "Ended" ? null : next.active_object,
        pending_candidate: session.state === "Paused" && session.pause_causes.some(({ cause }) => cause === "CandidateReview")
          ? next.pending_candidate : null }, event.payload.operation);
    }
    case "candidate_pending":
      if (!session || event.session_id !== session.id || event.session_revision !== session.revision ||
          event.payload.control_generation !== next.runtime.control_generation || !pendingReview(next, event.payload.match) ||
          (next.pending_candidate && !sameCapture(next.pending_candidate, event.payload.match))) return;
      return { ...next, pending_candidate: event.payload.match };
    case "recovery_changed":
      if (event.payload.failures.some((failure) => failure.session_id !== session?.id)) return;
      return { ...next, failures: event.payload.failures, runtime: event.payload.runtime };
    case "retention_changed":
      if (event.payload.retention.settings.revision < next.retention.settings.revision) return;
      return withOperation({ ...next, retention: event.payload.retention }, event.payload.operation);
    case "object_removed":
      if (next.active_object?.id === event.payload.object_id) return;
      return { ...next, operations: next.operations.filter(({ result }) =>
        result?.object?.id !== event.payload.object_id && result?.session?.object_id !== event.payload.object_id &&
        result?.match?.object_id !== event.payload.object_id) };
    case "storage_fault":
      return withOperation({ ...next, runtime: event.payload.runtime, retention: { ...next.retention, deletion: event.payload.deletion },
        readiness: { ...next.readiness, can_start: { Gestures: false, Controller: false }, can_resume: false } }, event.payload.operation);
    case "proximity_warning_changed":
      return { ...next, proximity: event.payload.proximity };
  }
}
