type Outcome = "committed" | "failed";
type SampleRead = "unavailable" | "empty";

export function openControlScript() {
  let reads = 0;
  let pending: ReturnType<typeof Promise.withResolvers<void>> | undefined;

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
    async submit(outcome: Outcome, signal: AbortSignal): Promise<Outcome> {
      signal.throwIfAborted();
      if (pending) throw new Error("A sample request is already pending.");
      const result = Promise.withResolvers<void>();
      pending = result;
      const abort = () => result.reject(signal.reason);
      signal.addEventListener("abort", abort, { once: true });
      try {
        await result.promise;
        return outcome;
      } finally {
        signal.removeEventListener("abort", abort);
        pending = undefined;
      }
    },
    deliver() { pending?.resolve(); },
  };
}
