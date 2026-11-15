import type { ControlMode } from "@/generated/api-v1";

export type SearchSetupContext = { objectId: string; mode?: ControlMode };

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
