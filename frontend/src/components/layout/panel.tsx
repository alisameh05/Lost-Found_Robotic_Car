import type { ComponentProps, ReactNode } from "react";

export function Panel({ className, ...props }: ComponentProps<"section">) {
  return <section {...props} className={className ? `panel ${className}` : "panel"} />;
}

export function ModelessPanel({ id, title, children }: { id: string; title: string; children: ReactNode }) {
  return (
    <Panel id={id} aria-labelledby={`${id}-title`} className="modeless-panel">
      <h3 id={`${id}-title`}>{title}</h3>
      {children}
    </Panel>
  );
}

export function MediaViewport({ label, children }: { label: string; children: ReactNode }) {
  return (
    <figure className="media-viewport">
      <figcaption>{label}</figcaption>
      <div className="media-frame" role="status">{children}</div>
    </figure>
  );
}
