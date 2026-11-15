import type { Match, Snapshot } from "@/generated/api-v1";

export function pendingReview(state: Snapshot, match: Match | null = state.pending_candidate): match is Match {
  const { active_session: session, active_object: object, runtime } = state;
  if (!match || !session || !object || session.state !== "Paused" || runtime.effective_session_state !== "Paused" ||
      runtime.motion_permission !== "Disarmed" || !session.pause_causes.some(({ cause }) => cause === "CandidateReview") ||
      match.session_id !== session.id || match.object_id !== object.id || match.disposition !== "Pending" ||
      match.reviewed_at_ms !== null || match.captured_at_ms < session.started_at_ms) return false;
  const { evidence_media: media, box } = match;
  return media.role === "Evidence" && media.created_at_ms >= match.captured_at_ms &&
    box.width > 0 && box.height > 0 && box.x >= 0 && box.y >= 0 &&
    box.x + box.width <= media.width && box.y + box.height <= media.height;
}
