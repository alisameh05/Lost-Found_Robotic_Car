import { createFixtureTransport } from "./transport";
import { openControlScript } from "./control-script";
import { confirmed, day, foundObject, notReviewed, sampleObject, sampleTime } from "./samples";
import { scenarioIds } from "./scenarios";

type ObservedMutation = { route: string; body?: unknown };

export function createScenarioHarness() {
  return {
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
      const controls = openControlScript();
      let requests: readonly ObservedMutation[] = [];
      const observers = new Set<() => void>();
      const transport = createFixtureTransport({ scenario, now: () => now, scriptedRegistration: controls.waitForDelivery, observeMutation(route, body) {
        requests = [...requests, { route, ...(route === "POST /emergency-stop" ? { body: structuredClone(body) } : {}) }];
        for (const notify of observers) notify();
      } });
      return {
        transport,
        async submitSample(label: string, outcome: "Committed" | "Failed", signal: AbortSignal) {
          const bootstrap = await transport.bootstrap(signal);
          if (bootstrap.kind !== "ok") return "Failed";
          return controls.submit(transport, { context: bootstrap.data, signal }, label, outcome, now);
        },
        readSample: controls.read,
        deliverSample: controls.deliver,
        expire() { now = sampleTime + 9 * day; },
        readRequests: () => requests,
        subscribeRequests(notify: () => void) {
          observers.add(notify);
          return () => { observers.delete(notify); };
        },
      };
    },
  };
}
