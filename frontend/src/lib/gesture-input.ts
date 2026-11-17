// Count mapping and presentation only. Recognition and movement authority stay backend-owned.
export const gestureDirections = { forward: 1, backward: 2, left: 3, right: 4 } as const;
export type MovementInput = "neutral" | "invalid" | keyof typeof gestureDirections;
export type FingerObservation = number | "no-hand" | "multiple-hands" | "uncertain";

export function inputForFingers(observation: FingerObservation, stable = true): MovementInput {
  if (!stable) return "invalid";
  if (observation === 0) return "neutral";
  switch (observation) {
    case 1: return "forward";
    case 2: return "backward";
    case 3: return "left";
    case 4: return "right";
    default: return "invalid";
  }
}

export function gestureFeedback(input: MovementInput | undefined): string {
  if (input === "invalid") return "Ambiguous or unsupported gesture · stopped";
  if (input === "neutral") return "0 fingers · neutral / stop";
  if (!input) return "No validated gesture";
  const count = gestureDirections[input];
  return `Held ${input} · ${count} ${count === 1 ? "finger" : "fingers"}`;
}
