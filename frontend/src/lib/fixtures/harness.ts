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
      const startedAt = performance.now();
      let offset = 0;
      const now = () => sampleTime + offset + Math.floor(performance.now() - startedAt);
      const controls = openControlScript();
      let requests: readonly ObservedMutation[] = [];
      const observers = new Set<() => void>();
      const transport = createFixtureTransport({ scenario, now, manualCleanup: true,
        scriptedRegistration: controls.waitForDelivery, observeMutation(route, body) {
        requests = [...requests, { route, ...(["POST /emergency-stop", "POST /settings/retention-preview", "PUT /settings/retention"].includes(route)
          ? { body: structuredClone(body) } : {}) }];
        for (const notify of observers) notify();
      } });
      return {
        transport,
        retention: transport.controls,
        advanceTime(ms: number) { offset += ms; transport.controls.clockChanged(); },
        async submitSample(label: string, outcome: "Committed" | "Failed", signal: AbortSignal) {
          const bootstrap = await transport.bootstrap(signal);
          if (bootstrap.kind !== "ok") return "Failed";
          return controls.submit(transport, { context: bootstrap.data, signal }, label, outcome, now());
        },
        readSample: controls.read,
        deliverSample: controls.deliver,
        expire() { offset = Math.max(offset, 9 * day); transport.controls.clockChanged(); },
        readRequests: () => requests,
        subscribeRequests(notify: () => void) {
          observers.add(notify);
          return () => { observers.delete(notify); };
        },
      };
    },
  };
}
