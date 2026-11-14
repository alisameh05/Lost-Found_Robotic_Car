import { createFixtureTransport } from "./transport";
import { openControlScript } from "./control-script";
import { confirmed, day, foundObject, notReviewed, sampleObject, sampleTime } from "./samples";
import { scenarioIds } from "./scenarios";

export function createScenarioHarness() {
  return {
    defaultScenario: "idle",
    openControls: openControlScript,
    scenarios: scenarioIds.map((id) => ({ id, label: id.replaceAll("-", " ") })),
    mediaExamples: [
      { id: sampleObject.reference_media.id, name: "Stale sample", label: "Not live", failure: undefined },
      { id: confirmed.evidence_media.id, name: "Saved sample", label: "Captured evidence", failure: undefined },
      { id: notReviewed.evidence_media.id, name: "Missing sample", label: "Captured evidence", failure: "missing" },
      { id: foundObject.reference_media.id, name: "Corrupt sample", label: "Sample reference", failure: "corrupt" },
    ] as const,
    open(id: string) {
      const scenario = scenarioIds.find((name) => name === id) ?? "idle";
      let now = sampleTime;
      const transport = createFixtureTransport({ scenario, now: () => now });
      return { transport, expire() { now = sampleTime + 9 * day; } };
    },
  };
}
