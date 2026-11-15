import type { ControlMode, Health, Object as ObjectRecord, Snapshot } from "@/generated/api-v1";

export type SearchSetupContext = { objectId: string; mode?: ControlMode };

export function searchSetupTargetBlockReason(object: ObjectRecord) {
  if (object.status === "Found") return "This object has already been found.";
  if (object.retention_grace) return "This expired record is available for its existing search only.";
  if (object.reference_media.availability !== "Available") return "The reference image is unavailable.";
}

export function searchSetupBlockReason(object: ObjectRecord, { snapshot, health }: { snapshot?: Snapshot; health?: Health }) {
  const state = snapshot?.runtime.effective_session_state ?? snapshot?.active_session?.state ?? health?.active_session_state;
  const storage = snapshot?.readiness.components.find(({ component }) => component === "Storage");
  if (object.status === "Found") return searchSetupTargetBlockReason(object);
  if (state === "Searching" || state === "Paused") return `End the ${state.toLowerCase()} session before starting another search.`;
  if (health?.storage_integrity === "Unavailable" || storage?.status === "Unavailable") return "Storage is unavailable.";
  if (health?.storage_integrity === "Reconciling" || storage?.status === "Initializing") return "Storage is being checked.";
  return searchSetupTargetBlockReason(object);
}

export function readSetupMode(value: string | string[] | undefined): ControlMode | undefined {
  if (value === "Gestures" || value === "Controller") return value;
}

export function readSetupContext(query: Record<string, string | string[] | undefined>): SearchSetupContext | undefined {
  if (typeof query.object === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(query.object)) {
    return { objectId: query.object, mode: readSetupMode(query.mode) };
  }
}

export function supportHref(path: "/devices" | "/control-guide", setup?: SearchSetupContext) {
  if (!setup) return path;
  const query = new URLSearchParams({ object: setup.objectId });
  if (setup.mode) query.set("mode", setup.mode);
  return `${path}?${query}`;
}

export function searchSetupHref(setup: SearchSetupContext) {
  const path = `/objects/${encodeURIComponent(setup.objectId)}/search`;
  return setup.mode ? `${path}?mode=${setup.mode}` : path;
}
