"use client";

import { useEffect, useId, useRef, useState, type CSSProperties } from "react";
import { MediaViewport } from "@/components/layout/panel";
import { Button } from "@/components/ui/button";
import { DataFeedback, LoadingState } from "@/components/ui/feedback";
import type { Rect } from "@/generated/api-v1";
import styles from "./protected-image.module.css";

type MediaFailure = { kind: "expired" | "missing" | "not-found" | "unavailable" | "corrupt" | "decode-error"; detail?: string };
export type LoadImage = (signal: AbortSignal) => Promise<{ kind: "ok"; image: Blob } | MediaFailure>;
type ImageState = ({ kind: "ok"; url: string } | MediaFailure) & { load: LoadImage };

export function ProtectedImage({
  load, label, alt, width, height, target, box, targetOnly, zoom, onDisplay,
}: { load: LoadImage; label: string; alt: string; width: number; height: number; target?: Rect; box?: Rect; targetOnly?: boolean;
  zoom?: boolean;
  onDisplay?: (available: boolean | undefined) => void }) {
  const [state, setState] = useState<ImageState>();
  const [inspection, setInspection] = useState<{ image: ImageState; scale: number }>();
  const frameId = useId();
  const evidenceViewport = useRef<HTMLDivElement>(null);
  const evidenceBox = useRef<HTMLSpanElement>(null);
  const available = state?.load === load && state.kind === "ok";
  const scale = available && inspection?.image === state ? inspection.scale : 1;
  const enlarged = scale > 1;

  useEffect(() => {
    const viewport = evidenceViewport.current;
    const outline = evidenceBox.current;
    if (!enlarged || !viewport || !outline) return;
    const centerBox = () => viewport.scrollTo({
      left: outline.offsetLeft + (outline.offsetWidth - viewport.clientWidth) / 2,
      top: outline.offsetTop + (outline.offsetHeight - viewport.clientHeight) / 2,
    });
    centerBox();
    const resize = new ResizeObserver(centerBox);
    resize.observe(viewport);
    return () => resize.disconnect();
  }, [enlarged, scale]);

  useEffect(() => {
    if (enlarged) evidenceViewport.current?.focus({ preventScroll: true });
  }, [enlarged]);

  function setScale(next: number) {
    if (available) setInspection({ image: state, scale: next });
  }

  useEffect(() => {
    const lifetime = new AbortController();
    let url: string | undefined;
    onDisplay?.(undefined);
    void load(lifetime.signal).then((result) => {
      if (lifetime.signal.aborted) return;
      if (result.kind === "ok") {
        url = URL.createObjectURL(result.image);
        setState({ load, kind: "ok", url });
      } else {
        onDisplay?.(false);
        setState({ load, ...result });
      }
    }).catch(() => {
      if (!lifetime.signal.aborted) {
        onDisplay?.(false);
        setState({ load, kind: "unavailable", detail: "The image request failed." });
      }
    });
    return () => {
      lifetime.abort();
      if (url) URL.revokeObjectURL(url);
    };
  }, [load, onDisplay]);

  function renderImage(crop?: Rect) {
    if (state?.load !== load) return <LoadingState label="Loading image" announce={false} />;
    if (state.kind !== "ok") return <DataFeedback state={state.kind} detail={state.detail} />;

    function failedDecode() {
      if (state?.kind !== "ok") return;
      onDisplay?.(false);
      URL.revokeObjectURL(state.url);
      setState((current) => current === state ? { load, kind: "decode-error" } : current);
    }
    // Protected object URLs are local and temporary. The crop uses the same decoded source.
    const image = ( // eslint-disable-next-line @next/next/no-img-element
      <img
        alt={crop ? `Selected target from ${alt}` : alt} src={state.url} width={width} height={height}
        style={crop && {
          width: `${100 * width / crop.width}%`, left: `${-100 * crop.x / crop.width}%`, top: `${-100 * crop.y / crop.height}%`,
        }}
        onError={failedDecode}
        onLoad={box || onDisplay ? ({ currentTarget }) => {
          if (currentTarget.naturalWidth !== width || currentTarget.naturalHeight !== height) failedDecode();
          else if (!crop || targetOnly) onDisplay?.(true);
        } : undefined}
      />
    );
    if (box && !crop) return <div ref={evidenceViewport} id={frameId} className={styles.evidenceViewport} data-enlarged={enlarged}
      role={enlarged ? "region" : undefined} aria-label={enlarged ? "Enlarged captured evidence" : undefined}
      tabIndex={enlarged ? 0 : undefined}>
      <div className={styles.evidenceFrame} style={{ width: `${100 * scale}%` }}>
        {image}
        <span ref={evidenceBox} aria-hidden="true" className={styles.box} style={{
          left: `${100 * box.x / width}%`, top: `${100 * box.y / height}%`,
          width: `${100 * box.width / width}%`, height: `${100 * box.height / height}%`,
        }} />
      </div>
    </div>;
    return crop ? (
      <div className="protected-crop" style={{ "--crop-ratio": crop.width / crop.height, aspectRatio: "var(--crop-ratio)" } as CSSProperties}>
        {image}
      </div>
    ) : image;
  }

  return <>
    {!targetOnly && <MediaViewport label={label}>{renderImage()}</MediaViewport>}
    {box && available && <Button className={styles.inspect}
      aria-expanded={enlarged} aria-controls={frameId}
      onClick={() => setScale(enlarged ? 1 : 2)}>
      {enlarged ? "Close inspection" : "Inspect evidence"}
    </Button>}
    {box && zoom && available && <div className="control-row" role="group" aria-label="Captured evidence zoom">
      <Button disabled={scale === 1} onClick={() => setScale(scale - 1)}>Zoom out</Button>
      <output aria-label="Zoom level">{scale}×</output>
      <Button disabled={scale === 4} onClick={() => setScale(scale + 1)}>Zoom in</Button>
      <Button disabled={scale === 1} onClick={() => setScale(1)}>Reset view</Button>
    </div>}
    {target && <MediaViewport label="Selected target">{renderImage(target)}</MediaViewport>}
  </>;
}
