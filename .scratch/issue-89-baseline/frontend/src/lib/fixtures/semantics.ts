import { componentNames, type BootstrapResponse, type EventEnvelope, type Match, type Media,
  type Object as LostObject, type Readiness, type Rect, type Session, type Snapshot,
} from "@/generated/api-v1";
import { compatibleProfile, conforms } from "../fixture-contracts";

function fits(rect: Rect, image: Media) {
  return rect.width <= image.width - rect.x && rect.height <= image.height - rect.y;
}

export function validObject(owner: LostObject) {
  return conforms("Object", owner) && fits(owner.roi, owner.reference_media) &&
    owner.expires_at_ms > owner.registered_at_ms &&
    (owner.found_at_ms === null || owner.found_at_ms >= owner.registered_at_ms);
}

export function validSession(session: Session, owner: LostObject) {
  return conforms("Session", session) && session.object_id === owner.id && session.started_at_ms >= owner.registered_at_ms &&
    (session.ended_at_ms === null || session.ended_at_ms >= session.started_at_ms);
}

export function validMatch(match: Match, session: Session) {
  return conforms("Match", match) && match.session_id === session.id && match.object_id === session.object_id &&
    match.captured_at_ms >= session.started_at_ms && (session.ended_at_ms === null || match.captured_at_ms <= session.ended_at_ms) &&
    (match.reviewed_at_ms === null || (match.reviewed_at_ms >= match.captured_at_ms &&
      (session.ended_at_ms === null || match.reviewed_at_ms <= session.ended_at_ms))) &&
    (match.disposition !== "Pending" || session.state === "Paused") &&
    fits(match.box, match.evidence_media);
}

function validReadiness(readiness: Readiness, state: Snapshot) {
  const status = new Map(readiness.components.map(({ component, status }) => [component, status]));
  if (status.size !== componentNames.length || !componentNames.every((name) => status.has(name))) return false;
  const shared = state.qualification_profile !== null && state.lease.state === "Owned" &&
    componentNames.every((name) => name === "Webcam" || name === "Controller" || status.get(name) === "Ready");
  const gestures = shared && status.get("Webcam") === "Ready";
  const controller = shared && status.get("Controller") === "Ready";
  return (!readiness.can_start.Gestures || (!state.active_session && gestures)) &&
    (!readiness.can_start.Controller || (!state.active_session && controller)) &&
    (!readiness.can_resume || (state.active_session?.state === "Paused" &&
      (state.active_session.control_mode === "Gestures" ? gestures : controller) &&
      !state.pending_candidate && state.failures.every((failure) => failure.restored && failure.acknowledged)));
}

export function validSnapshot(state: Snapshot, bootstrap: BootstrapResponse) {
  if (!conforms("Snapshot", state) || !conforms("BootstrapResponse", bootstrap) ||
      state.backend_boot_id !== bootstrap.backend_boot_id || !validReadiness(state.readiness, state) ||
      state.lease.control_generation !== state.runtime.control_generation) return false;
  const { qualification_profile: profile, active_object: owner, active_session: session } = state;
  if (profile ? !compatibleProfile(profile) || state.qualification_profile_id !== profile.profile_id ||
    !bootstrap.qualification_profile || Object.keys(profile).some((key) =>
      profile[key as keyof typeof profile] !== bootstrap.qualification_profile?.[key as keyof typeof profile])
    : state.qualification_profile_id !== null || bootstrap.qualification_profile !== null) return false;
  if (!profile && state.runtime.motion_permission !== "Disarmed") return false;
  if (!owner || !session) return !owner && !session && state.runtime.effective_session_state === null &&
    !state.pending_candidate && state.retention.active_object_expires_at_ms === null && !state.retention.active_object_grace;
  return validObject(owner) && validSession(session, owner) && session.state !== "Ended" &&
    (state.runtime.effective_session_state === session.state ||
      (state.runtime.effective_session_state === "Paused" && state.runtime.motion_permission === "Disarmed")) &&
    (!state.pending_candidate || (state.pending_candidate.disposition === "Pending" && validMatch(state.pending_candidate, session))) &&
    state.failures.every((failure) => failure.session_id === session.id) &&
    session.pause_causes.every((cause) => !cause.failure_id || state.failures.some((failure) => failure.failure_id === cause.failure_id)) &&
    state.retention.active_object_expires_at_ms === owner.expires_at_ms && state.retention.active_object_grace === owner.retention_grace;
}

export function validEvent(event: EventEnvelope) {
  if (!conforms("EventEnvelope", event) || (event.session_id === null) !== (event.session_revision === null)) return false;
  switch (event.type) {
    case "snapshot":
      return event.backend_boot_id === event.payload.backend_boot_id && event.event_seq === event.payload.event_seq &&
        event.session_id === (event.payload.active_session?.id ?? null) &&
        event.session_revision === (event.payload.active_session?.revision ?? null);
    case "session_changed":
      return event.session_id === event.payload.session.id && event.session_revision === event.payload.session.revision;
    case "candidate_pending":
      return event.session_id === event.payload.match.session_id && event.payload.match.disposition === "Pending";
    case "recovery_changed":
      return event.payload.failures.every((failure) => failure.session_id === event.session_id);
    default:
      return true;
  }
}

export function follows(previous: EventEnvelope, next: EventEnvelope) {
  return validEvent(next) && next.backend_boot_id === previous.backend_boot_id &&
    next.event_seq === previous.event_seq + 1 && next.occurred_at_ms >= previous.occurred_at_ms &&
    (previous.session_id !== next.session_id || next.session_revision === null ||
      (previous.session_revision !== null && next.session_revision >= previous.session_revision));
}
