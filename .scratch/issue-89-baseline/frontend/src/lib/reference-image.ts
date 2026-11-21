import { maxReferenceBytes, ReferenceImageError, type NormalizedReference, type ReferenceDecodeResponse } from "./reference-image-format";

export { maxReferenceBytes, ReferenceImageError, type NormalizedReference };

export async function normalizeReference(source: Blob, signal: AbortSignal, preview = false): Promise<NormalizedReference> {
  signal.throwIfAborted();
  if (source.size > maxReferenceBytes) throw new ReferenceImageError("The reference image exceeds 10 MiB.", 413);
  const worker = new Worker(new URL("./reference-image.worker.ts", import.meta.url), { type: "module" });
  const lifetime = new AbortController();
  try {
    return await new Promise<NormalizedReference>((resolve, reject) => {
      signal.addEventListener("abort", () => reject(signal.reason), { once: true, signal: lifetime.signal });
      const unreadable = () => reject(new ReferenceImageError("The reference image could not be read.", 422));
      worker.onerror = unreadable;
      worker.onmessageerror = unreadable;
      worker.onmessage = ({ data }: MessageEvent<ReferenceDecodeResponse>) => {
        if ("image" in data) resolve(data.image);
        else reject(new ReferenceImageError(data.error, data.status));
      };
      worker.postMessage({ source, preview });
    });
  } finally {
    lifetime.abort();
    worker.terminate();
  }
}
