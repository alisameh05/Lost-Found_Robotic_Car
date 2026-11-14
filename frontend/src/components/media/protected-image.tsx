"use client";

import { useEffect, useState, type CSSProperties } from "react";
import { MediaViewport } from "@/components/layout/panel";
import { DataFeedback, LoadingState } from "@/components/ui/feedback";
import type { Rect } from "@/generated/api-v1";

type MediaFailure = { kind: "expired" | "missing" | "unavailable" | "corrupt" | "decode-error"; detail?: string };
export type LoadImage = (signal: AbortSignal) => Promise<{ kind: "ok"; image: Blob } | MediaFailure>;
type ImageState = ({ kind: "ok"; url: string } | MediaFailure) & { load: LoadImage };

export function ProtectedImage({
  load, label, alt, width, height, target,
}: { load: LoadImage; label: string; alt: string; width: number; height: number; target?: Rect }) {
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

  function renderImage(crop?: Rect) {
    if (state?.load !== load) return <LoadingState label="Loading image" announce={false} />;
    if (state.kind !== "ok") return <DataFeedback state={state.kind} detail={state.detail} />;

    // Protected object URLs are local and temporary. The crop uses the same decoded source.
    const image = ( // eslint-disable-next-line @next/next/no-img-element
      <img
        alt={crop ? `Selected target from ${alt}` : alt} src={state.url} width={width} height={height}
        style={crop && {
          width: `${100 * width / crop.width}%`, left: `${-100 * crop.x / crop.width}%`, top: `${-100 * crop.y / crop.height}%`,
        }}
        onError={() => {
          URL.revokeObjectURL(state.url);
          setState((current) => current === state ? { load, kind: "decode-error" } : current);
        }}
      />
    );
    return crop ? (
      <div className="protected-crop" style={{ "--crop-ratio": crop.width / crop.height, aspectRatio: "var(--crop-ratio)" } as CSSProperties}>
        {image}
      </div>
    ) : image;
  }

  return <>
    <MediaViewport label={label}>{renderImage()}</MediaViewport>
    {target && <MediaViewport label="Selected target">{renderImage(target)}</MediaViewport>}
  </>;
}
