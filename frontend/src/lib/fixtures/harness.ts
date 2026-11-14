import { createFixtureTransport } from "./transport";
import { confirmed, day, foundObject, notReviewed, sampleObject, sampleTime } from "./samples";
import { scenarioIds } from "./scenarios";

export function createScenarioHarness() {
  return {
    defaultScenario: "idle",
    scenarios: scenarioIds.map((id) => ({ id, label: id.replaceAll("-", " ") })),
    mediaExamples: [
      { id: sampleObject.reference_media.id, name: "Stale sample", label: "Not live" },
      { id: confirmed.evidence_media.id, name: "Saved sample", label: "Captured evidence" },
      { id: notReviewed.evidence_media.id, name: "Missing sample", label: "Captured evidence" },
      { id: foundObject.reference_media.id, name: "Corrupt sample", label: "Sample reference" },
    ] as const,
    open(id: string) {
      const scenario = scenarioIds.find((name) => name === id) ?? "idle";
      let now = sampleTime;
      const transport = createFixtureTransport({ scenario, now: () => now });
      return { transport, expire() { now = sampleTime + 9 * day; } };
    },
  };
}
