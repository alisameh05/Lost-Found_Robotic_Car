import type { ControlMode, Readiness } from "@/generated/api-v1";

export const modeLabels = { Gestures: "Gestures", Controller: "Controller (PS4)" } satisfies Record<ControlMode, string>;

export function describeDeviceReadiness(readiness: Readiness | undefined, mode: ControlMode) {
  const selectedInput = mode === "Gestures" ? "Webcam" : "Controller";
  const inactiveInput = mode === "Gestures" ? "Controller" : "Webcam";
  const shared = readiness?.components.filter(({ component }) => component !== selectedInput && component !== inactiveInput) ?? [];
  const selected = readiness?.components.find(({ component }) => component === selectedInput);
  const inactive = readiness?.components.find(({ component }) => component === inactiveInput);
  const required = selected ? [...shared, selected] : shared;
  const unavailable = required.filter(({ status }) => status === "Unavailable").map(({ component }) => component);
  const status = unavailable.length > 0 ? "Unavailable" : required.some(({ status }) => status === "Initializing") ? "Initializing"
    : shared.length === 8 && selected ? "Ready" : "Unknown";
  return { status, shared, selected, inactive, unavailable };
}

/** Summarize component observations for one mode. Start and Resume have separate eligibility gates. */
export function summarizeDeviceReadiness(readiness: Readiness | undefined, mode: ControlMode) {
  const { status, unavailable } = describeDeviceReadiness(readiness, mode);
  return { status, unavailable };
}
