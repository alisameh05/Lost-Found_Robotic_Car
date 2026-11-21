import type { ControlMode } from "@/generated/api-v1";

export const searchMode = (mode: ControlMode) => mode === "Gestures" ? "Gestures" : "PS4 DualShock 4";

export function duration(ms: number) {
  const seconds = Math.floor(ms / 1_000);
  const minutes = Math.floor(seconds / 60);
  return minutes ? `${minutes} min ${seconds % 60} sec` : `${seconds} sec`;
}
