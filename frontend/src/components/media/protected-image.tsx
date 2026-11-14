"use client";

import { useEffect, useState } from "react";
import { MediaViewport } from "@/components/layout/panel";
import { DataFeedback, LoadingState } from "@/components/ui/feedback";

type MediaFailure = { kind: "expired" | "missing" | "unavailable" | "corrupt"; detail: string };
type LoadImage = (signal: AbortSignal) => Promise<{ kind: "ok"; image: Blob } | MediaFailure>;
type ImageState = ({ kind: "ok"; url: string } | MediaFailure) & { load: LoadImage };

export function ProtectedImage({
  load, label, alt, width, height,
}: { load: LoadImage; label: string; alt: string; width: number; height: number }) {
  const [state, setState] = useState<ImageState>();

  useEffect(() => {
    const lifetime = new AbortController();
    let url: string | undefined;
    void load(lifetime.signal).then((result) => {
      if (lifetime.signal.aborted) return;
      if (result.kind === "ok") {
        url = URL.createObjectURL(result.image);
        setState({ load, kind: "ok", url });
      } else {
        setState({ load, ...result });
      }
    }).catch(() => {
      if (!lifetime.signal.aborted) setState({ load, kind: "unavailable", detail: "The image request failed." });
    });
    return () => {
      lifetime.abort();
      if (url) URL.revokeObjectURL(url);
    };
  }, [load]);

  return (
    <MediaViewport label={label}>
      {state?.load !== load ? <LoadingState label="Loading image" announce={false} />
        : state.kind !== "ok" ? <DataFeedback state={state.kind} detail={state.detail} />
        // Protected object URLs are local and temporary.
        // eslint-disable-next-line @next/next/no-img-element
        : <img
            alt={alt} src={state.url} width={width} height={height}
            onError={() => {
              URL.revokeObjectURL(state.url);
              setState({ load, kind: "corrupt", detail: "The image could not be decoded." });
            }}
          />}
    </MediaViewport>
  );
}
