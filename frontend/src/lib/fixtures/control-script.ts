import type { ApplicationTransport, ProtectedRequest } from "../transport";
import { sampleImage } from "./images";
import { sampleSwatchRect } from "./samples";

type Outcome = "Committed" | "Failed";
type SampleRead = "unavailable" | "empty";

export function openControlScript() {
  let reads = 0;
  let pending: { outcome: Outcome; delivery: ReturnType<typeof Promise.withResolvers<void>> } | undefined;

  return {
    async read(signal: AbortSignal): Promise<SampleRead> {
      const outcome = ++reads === 1 ? "unavailable" : "empty";
      // Let the loading specimen be inspected before the scripted response arrives.
      await new Promise<void>((resolve, reject) => {
        signal.throwIfAborted();
        const timer = setTimeout(() => {
          signal.removeEventListener("abort", abort);
          resolve();
        }, 350);
        function abort() {
          clearTimeout(timer);
          reject(signal.reason);
        }
        signal.addEventListener("abort", abort, { once: true });
      });
      return outcome;
    },
    async submit(transport: ApplicationTransport, request: ProtectedRequest & { signal: AbortSignal },
      label: string, outcome: Outcome, createdAt: number) {
      request.signal.throwIfAborted();
      if (pending) throw new Error("A sample request is already pending.");
      pending = { outcome, delivery: Promise.withResolvers<void>() };
      try {
        const result = await transport.request("POST /objects", {
          ...request, actionCreatedAtMs: createdAt,
          body: { action_id: crypto.randomUUID(), name: label, roi: sampleSwatchRect,
            reference_image: new Blob([sampleImage("image/jpeg")], { type: "image/jpeg" }) },
        });
        return result.kind === "ok" ? result.data.persistence : "Failed";
      } finally {
        pending = undefined;
      }
    },
    async waitForDelivery(signal: AbortSignal): Promise<Outcome | undefined> {
      signal.throwIfAborted();
      const submission = pending;
      if (!submission) return;
      const abort = () => submission.delivery.reject(signal.reason);
      signal.addEventListener("abort", abort, { once: true });
      try {
        await submission.delivery.promise;
        return submission.outcome;
      } finally {
        signal.removeEventListener("abort", abort);
      }
    },
    deliver() { pending?.delivery.resolve(); },
  };
}
