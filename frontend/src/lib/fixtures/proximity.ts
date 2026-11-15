import type { Proximity } from "@/generated/api-v1";
import { qualification } from "./vectors";

export function openFixtureProximity(initial: Proximity, now: () => number, monotonic: () => number, publish: () => void) {
  const { proximity_sample_deadline_ms: deadline, proximity_warning_mm: warning,
    proximity_clear_mm: clear, proximity_clear_samples: required, proximity_max_distance_mm: maximum } = qualification;
  let value = initial;
  let consecutive = 0;
  let captured: number | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;

  function unknown() {
    clearTimeout(timer);
    captured = undefined;
    consecutive = 0;
    if (value.state === "Unknown") return;
    value = { ...value, state: "Unknown", distance_mm: null };
    publish();
  }

  function checkDeadline() {
    if (captured === undefined) return;
    const remaining = captured + deadline - monotonic();
    clearTimeout(timer);
    if (remaining <= 0) unknown();
    else timer = setTimeout(checkDeadline, Math.ceil(remaining));
  }

  return {
    read: () => value,
    observe(distance: number | null) {
      checkDeadline();
      if (distance === null || !Number.isInteger(distance) || distance < 0 || distance > maximum) {
        unknown();
        return;
      }
      captured = monotonic();
      consecutive = distance >= clear ? consecutive + 1 : 0;
      const latched = distance <= warning || (value.warning_latched && consecutive < required);
      const state = latched ? "Warning" : consecutive >= required || value.state === "Clear" ? "Clear" : "Unknown";
      value = { state, warning_latched: latched, distance_mm: state === "Unknown" ? null : distance,
        sample_seq: (value.sample_seq ?? 0) + 1, source_epoch: "fixture-proximity", observed_at_ms: now() };
      checkDeadline();
      publish();
    },
    checkDeadline,
    dispose() { clearTimeout(timer); },
  };
}
