import type { DeletionProgress, Operation, RetentionChange, RetentionPreview, RetentionPreviewRequest, Settings } from "@/generated/api-v1";
import { conforms } from "../fixture-contracts";
import { emptyResult, mutation } from "./mutations";
import { day } from "./samples";
import { fixtureError, fixtureOk } from "./responses";

type Impact = { signature: string; impact: RetentionPreview["impact"] };
type Entry = { fingerprint: string; response: ReturnType<typeof mutation> };
type SaveControl = "Hold" | "Commit" | "Lose response" | "Fail";

export const expiryFor = (registeredAtMs: number, days: number) => registeredAtMs + days * day;
const complete: DeletionProgress = { status: "Complete", remaining_objects: 0, remaining_files: 0, error_code: null };
const outdated = fixtureError(409, "PREVIEW_STALE", "The sample impact preview expired or changed.");
const conflict = fixtureError(409, "REVISION_CONFLICT", "The saved sample retention revision changed.");
export const unavailableStorage = fixtureError(503, "STORAGE_UNAVAILABLE", "Sample storage is unavailable.");

export function openRetention({ now, initial, active, healthy, impactFor, collectExpired, purge, invalidate, manualCleanup }: {
  now: () => number;
  initial: { settings: Settings; deletion: DeletionProgress };
  active: () => boolean;
  healthy: () => boolean;
  impactFor: (days: number, time: number) => Impact;
  collectExpired: (settings: Settings, time: number) => { id: string; files: number }[];
  purge: (owners: ReadonlyMap<string, number>) => void;
  invalidate: (owners?: string[]) => void;
  manualCleanup: boolean;
}) {
  const previews = new Map<string, { value: RetentionPreview; signature: string }>();
  const receipts = new Map<string, Entry>();
  const completions = new Set<string>();
  const reportedFailures = new Set<string>();
  const excluded = new Map<string, number>();
  let { settings, deletion } = initial;
  let cleanupDue = Infinity;
  let holdSave = false;
  let pending: RetentionChange | undefined;
  let lostResponse: string | undefined;

  function finishCleanup(failed: boolean) {
    if (deletion.status !== "Pending") return;
    cleanupDue = Infinity;
    if (failed) {
      deletion = { ...deletion, status: "Failed", error_code: "STORAGE_UNAVAILABLE" };
    } else {
      purge(excluded);
      excluded.clear();
      deletion = complete;
    }
    invalidate();
  }

  function sweep(time = now()) {
    const removed = collectExpired(settings, time).filter(({ id }) => !excluded.has(id));
    if (removed.length) {
      for (const { id, files } of removed) excluded.set(id, files);
      const counts = {
        remaining_objects: deletion.remaining_objects + removed.length,
        remaining_files: deletion.remaining_files + removed.reduce((sum, { files }) => sum + files, 0),
      };
      deletion = deletion.status === "Failed" ? { ...deletion, ...counts } : { status: "Pending", ...counts, error_code: null };
      if (!manualCleanup && deletion.status === "Pending" && cleanupDue === Infinity) cleanupDue = time + 2_000;
      invalidate(removed.map(({ id }) => id));
    }
    if (time >= cleanupDue) finishCleanup(false);
  }

  function guard() {
    if (active()) return fixtureError(409, "ACTIVE_SESSION_EXISTS", "End the Searching or Paused session before changing retention.");
    if (!healthy() || deletion.status === "Failed") return unavailableStorage;
  }

  function preview(body: RetentionPreviewRequest) {
    if (!conforms("RetentionPreviewRequest", body)) return fixtureError(422, "VALIDATION_FAILED", "Use 1–30 whole days.");
    const blocked = guard();
    if (blocked) return blocked;
    if (body.expected_revision !== settings.revision) return conflict;
    const time = now();
    const { impact, signature } = impactFor(body.retention_days, time);
    const value = { preview_id: `sample-retention-${crypto.randomUUID()}`, settings_revision: settings.revision,
      retention_days: body.retention_days, evaluated_at_ms: time, expires_at_ms: time + 60_000, impact };
    for (const [id, entry] of previews) if (entry.value.expires_at_ms <= time) previews.delete(id);
    const oldest = previews.keys().next().value;
    if (previews.size >= 32 && oldest !== undefined) previews.delete(oldest);
    previews.set(value.preview_id, { value, signature });
    return fixtureOk(value);
  }

  function fingerprint(body: RetentionChange) {
    return JSON.stringify([body.expected_revision, body.retention_days, body.preview_id, body.confirmed]);
  }

  function remember(body: RetentionChange, response: Entry["response"]) {
    receipts.set(body.action_id, { fingerprint: fingerprint(body), response });
    if (response.data.persistence !== "Pending") {
      completions.add(body.action_id);
      if (completions.size > 64) completions.delete(completions.values().next().value!);
    }
    return response;
  }

  function save(body: RetentionChange, time: number) {
    if (body.retention_days !== settings.retention_days) {
      settings = { retention_days: body.retention_days, revision: settings.revision + 1, updated_at_ms: time };
    }
    sweep(time);
    const response = remember(body, mutation(body.action_id, "Committed", { ...emptyResult, settings, deletion }));
    previews.delete(body.preview_id);
    invalidate();
    return response;
  }

  function checkPreview(body: RetentionChange, time: number) {
    const entry = previews.get(body.preview_id);
    if (!entry || entry.value.expires_at_ms <= time || entry.value.retention_days !== body.retention_days ||
        entry.value.settings_revision !== body.expected_revision) return outdated;
    if (body.expected_revision !== settings.revision) return conflict;
    if (entry.signature !== impactFor(body.retention_days, time).signature) return outdated;
  }

  function apply(body: RetentionChange) {
    if (!conforms("RetentionChange", body)) return fixtureError(422, "VALIDATION_FAILED", "Confirm a valid sample retention preview.");
    const receipt = receipts.get(body.action_id);
    if (receipt) {
      if (receipt.fingerprint !== fingerprint(body)) return fixtureError(409, "ACTION_ID_CONFLICT", "The sample action ID belongs to a different request.");
      const { data } = receipt.response;
      if (data.persistence !== "Failed" || !data.error.retryable) return receipt.response;
      if (!reportedFailures.has(body.action_id)) {
        reportedFailures.add(body.action_id);
        return receipt.response;
      }
    }
    const blocked = guard();
    if (blocked) return blocked;
    if (pending) return fixtureError(409, "INVALID_TRANSITION", "A sample retention save is already pending.");
    const time = now();
    const stale = checkPreview(body, time);
    if (stale) return stale;
    reportedFailures.delete(body.action_id);
    completions.delete(body.action_id);
    if (holdSave) {
      holdSave = false;
      pending = body;
      const response = remember(body, mutation(body.action_id, "Pending", emptyResult));
      invalidate();
      return response;
    }
    return save(body, time);
  }

  return {
    preview, apply, sweep, finishCleanup,
    read: () => ({ settings, deletion }),
    nextCleanup: () => cleanupDue,
    isSavePending: () => pending !== undefined,
    excluded: (id: string) => excluded.has(id),
    operations(): Operation[] {
      const ids = pending ? [pending.action_id, ...completions] : [...completions];
      return ids.map((id) => ({ ...receipts.get(id)!.response.data, request_id: null }));
    },
    controlSave(control: SaveControl) {
      if (control === "Hold") { holdSave = true; return; }
      if (!pending) return;
      const body = pending;
      pending = undefined;
      const time = now();
      sweep(time);
      const rejected = guard() ?? checkPreview(body, time);
      if (rejected) {
        remember(body, { kind: "ok", status: rejected.status,
          data: { action_id: body.action_id, persistence: "Failed", result: null, error: rejected.error } });
      } else if (control === "Fail") {
        remember(body, mutation(body.action_id, "Failed", emptyResult));
      } else {
        save(body, time);
        if (control === "Lose response") lostResponse = body.action_id;
        return;
      }
      invalidate();
    },
    takeLostResponse(id: string) {
      if (lostResponse !== id) return false;
      lostResponse = undefined;
      return true;
    },
  };
}
