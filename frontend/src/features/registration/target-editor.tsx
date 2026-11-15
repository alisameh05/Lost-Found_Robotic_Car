import { useRef, type CSSProperties, type PointerEvent } from "react";
import type { Rect } from "@/generated/api-v1";
import { dragRect, pixelPoint, type Point, type Size } from "./selection";
import styles from "./registration.module.css";

type Image = Size & { url: string };
const handles = ["nw", "n", "ne", "e", "se", "s", "sw", "w"] as const;

export function TargetEditor({ image, rect, disabled, onSelection }: {
  image: Image; rect: Rect | null; disabled: boolean; onSelection: (rect: Rect) => void;
}) {
  const gesture = useRef<{ id: number; start: Point; handle?: string } | undefined>(undefined);
  function begin(event: PointerEvent<HTMLDivElement>) {
    if (disabled || event.button !== 0 || gesture.current) return;
    const point = pixelPoint(event.currentTarget.getBoundingClientRect(), image, event.clientX, event.clientY);
    const handle = (event.target as HTMLElement).dataset.handle;
    if (!point && !handle) return;
    const start = rect && handle ? {
      x: handle.includes("w") ? rect.x + rect.width : rect.x,
      y: handle.includes("n") ? rect.y + rect.height : rect.y,
    } : point!;
    gesture.current = { id: event.pointerId, start, handle };
    event.currentTarget.setPointerCapture(event.pointerId);
  }
  function move(event: PointerEvent<HTMLDivElement>) {
    const drag = gesture.current;
    if (!drag || drag.id !== event.pointerId) return;
    const point = pixelPoint(event.currentTarget.getBoundingClientRect(), image, event.clientX, event.clientY, true);
    if (!point) return;
    const next = dragRect(drag.start, point);
    if (rect && drag.handle?.length === 1) {
      if (drag.handle === "n" || drag.handle === "s") { next.x = rect.x; next.width = rect.width; }
      else { next.y = rect.y; next.height = rect.height; }
    }
    if (next.width && next.height) onSelection(next);
  }
  const derivedSize = { "--ratio": image.width / image.height } as CSSProperties;
  return (
    <div className={`${styles.stage} ${styles.editor}`} style={derivedSize} data-testid="target-editor"
      onPointerDown={begin} onPointerMove={move}
      onPointerUp={(event) => { move(event); gesture.current = undefined; }}
      onLostPointerCapture={() => { gesture.current = undefined; }}>
      <div className={styles.fitted}>
        {/* eslint-disable-next-line @next/next/no-img-element -- Local, temporary normalized preview. */}
        <img src={image.url} alt="Normalized reference for target selection" draggable={false} />
        {rect && <div className={styles.selection} style={{
          left: `${100 * rect.x / image.width}%`, top: `${100 * rect.y / image.height}%`,
          width: `${100 * rect.width / image.width}%`, height: `${100 * rect.height / image.height}%`,
        }} aria-hidden="true">
          {handles.map((handle) => <span key={handle} data-handle={handle} />)}
        </div>}
      </div>
    </div>
  );
}

export function RegionPreview({ image, rect }: { image: Image; rect: Rect | null }) {
  return (
    <div className={`${styles.stage} ${styles.crop}`} style={{ "--ratio": rect ? rect.width / rect.height : 1 } as CSSProperties}>
      {rect ? (
        <div className={styles.fitted}>
          {/* eslint-disable-next-line @next/next/no-img-element -- Crop of the normalized local preview. */}
          <img src={image.url} alt="Selected region" style={{
            width: `${100 * image.width / rect.width}%`, height: `${100 * image.height / rect.height}%`,
            left: `${-100 * rect.x / rect.width}%`, top: `${-100 * rect.y / rect.height}%`,
          }} />
        </div>
      ) : <p>Draw a rectangle or enter its coordinates.</p>}
    </div>
  );
}
