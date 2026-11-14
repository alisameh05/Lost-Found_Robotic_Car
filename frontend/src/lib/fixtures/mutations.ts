import type {
  EmergencyStopRequest, EmergencyStopResponse, Error as ApiError, MutationResponse, MutationResult,
  RetentionPreview, SessionAction, Snapshot,
} from "@/generated/api-v1";
import type { ReadResult } from "../transport";
import { bootstrapFacts, foundSession, recoveryFailure, sampleObject, sampleSession, sampleTime, searching } from "./samples";

export const emptyResult: MutationResult = { object: null, session: null, match: null, settings: null, deletion: null };
export const storageError = { code: "STORAGE_UNAVAILABLE", message: "Sample save failed.", retryable: true } satisfies ApiError;
export const validationError = {
  code: "VALIDATION_FAILED", message: "A sample request field is invalid.", retryable: false,
  field_errors: [{ path: "/roi/width", code: "OUT_OF_RANGE", message: "Width must fit the normalized source image." }],
} satisfies ApiError;

export function mutation(
  action_id: string, persistence: MutationResponse["persistence"], result: MutationResult, status = 200, location?: string,
): ReadResult<MutationResponse> {
  const data: MutationResponse = persistence === "Committed" ? { action_id, persistence, result, error: null }
    : persistence === "Pending" ? { action_id, persistence, result: null, error: null }
      : { action_id, persistence, result: null, error: storageError };
  return { kind: "ok", status: persistence === "Pending" ? 202 : persistence === "Failed" ? 503 : status, data,
    ...(location && persistence === "Committed" ? { location } : {}) };
}

export function emergencyResponse(
  body: EmergencyStopRequest, snapshot: Snapshot, outcome: EmergencyStopResponse["persistence"] | "network",
): ReadResult<EmergencyStopResponse> {
  if (outcome === "network") return { kind: "unavailable" };
  const session_id = snapshot.active_session?.id ?? null;
  const base = {
    request_id: body.request_id, backend_boot_id: bootstrapFacts.backend_boot_id, permission_revoked: true,
    session_id, failure_id: session_id ? recoveryFailure.failure_id : null,
  } as const;
  return outcome === "Failed"
    ? { kind: "ok", status: 503, data: { ...base, persistence: outcome, error: storageError } }
    : { kind: "ok", status: outcome === "Pending" ? 202 : 200, data: { ...base, persistence: outcome, error: null } };
}

export function sampleRetentionPreview(
  preview_id: string, retention_days: number, revision: number, time: number, impact: RetentionPreview["impact"],
): RetentionPreview {
  return {
    preview_id, retention_days, settings_revision: revision, evaluated_at_ms: time, expires_at_ms: time + 60_000, impact,
  };
}

// Fixed receipts for later screens to inspect. These do not advance the scenario.
export const registrationReceipt = { ...emptyResult, object: sampleObject };
export const startReceipt = { ...emptyResult, session: { ...searching, id: "sample-new-search" } };
export const stopReceipt = { ...emptyResult, session: sampleSession };

export function reviewReceipt(action: SessionAction, state: Snapshot): MutationResult {
  const session = state.active_session;
  const candidate = state.pending_candidate;
  if (!session) return stopReceipt;
  const revision = session.revision + 1;
  if (candidate && state.active_object && action.action === "confirm") {
    const reviewed_at_ms = sampleTime;
    return {
      ...emptyResult,
      object: { ...state.active_object, status: "Found", found_at_ms: reviewed_at_ms, revision: state.active_object.revision + 1 },
      session: { ...foundSession, id: session.id, object_id: session.object_id, started_at_ms: session.started_at_ms,
        control_mode: session.control_mode, ended_at_ms: reviewed_at_ms, revision },
      match: { ...candidate, disposition: "Confirmed", reviewed_at_ms },
    };
  }
  if (candidate && action.action === "reject") return {
    ...emptyResult, session: {
      ...session, state: "Paused", ended_at_ms: null, end_reason: null, revision,
      pause_causes: [{ cause: "ReviewRejected", failure_id: null }],
    },
    match: { ...candidate, disposition: "Rejected", reviewed_at_ms: sampleTime },
  };
  if (action.action === "stop") return {
    ...emptyResult,
    session: { ...sampleSession, id: session.id, object_id: session.object_id, control_mode: session.control_mode,
      started_at_ms: session.started_at_ms, ended_at_ms: sampleTime, revision },
    match: candidate ? { ...candidate, disposition: "NotReviewed", reviewed_at_ms: null } : null,
  };
  if (action.action === "pause" && session.state === "Searching") return {
    ...emptyResult, session: { ...session, state: "Paused", revision, pause_causes: [{ cause: "ManualPause", failure_id: null }] },
  };
  if (action.action === "resume" && session.state === "Paused") return {
    ...emptyResult, session: { ...session, state: "Searching", revision, pause_causes: [] },
  };
  if (action.action === "acknowledge" && state.failures.some((failure) =>
    action.failure_ids.includes(failure.failure_id) && !failure.acknowledged)) return {
    ...emptyResult, session: { ...session, revision },
  };
  return { ...emptyResult, session };
}
