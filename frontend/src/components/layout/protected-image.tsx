"use client";

import { useEffect, useState } from "react";
import type { ReadResult, ProtectedMedia } from "@/lib/transport";

type LoadImage = (signal: AbortSignal) => Promise<ReadResult<ProtectedMedia>>;
type ImageState =
  | { load: LoadImage; url: string }
  | { load: LoadImage; message: string };

export function ProtectedImage({ load, label }: { load: LoadImage; label: string }) {
  const [state, setState] = useState<ImageState>();

  useEffect(() => {
    const lifetime = new AbortController();
    let url: string | undefined;
    void load(lifetime.signal).then((result) => {
      if (lifetime.signal.aborted) return;
      if (result.kind === "ok") {
        const blob = new Blob([result.data.bytes], { type: result.data.headers["Content-Type"] });
        url = URL.createObjectURL(blob);
        setState({ load, url });
      } else {
        setState({ load, message: result.kind === "api-error" ? result.error.message : "Sample media request unavailable." });
      }
    }).catch(() => {
      if (!lifetime.signal.aborted) setState({ load, message: "Sample media request unavailable." });
    });
    return () => {
      lifetime.abort();
      if (url) URL.revokeObjectURL(url);
    };
  }, [load]);

  if (state?.load !== load) return <p role="status">Loading sample image</p>;
  if ("message" in state) return <p role="status">{state.message}</p>;
  return (
    <figure className="sample-image">
      {/* Protected object URLs are local and temporary. */}
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img alt="Synthetic geometric swatch" src={state.url} width={160} height={120} />
      <figcaption>Sample image · {label}</figcaption>
    </figure>
  );
}
