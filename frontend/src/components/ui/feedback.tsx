import {
  ArchiveX, CircleAlert, CircleCheck, Clock, FileQuestion, Info, TriangleAlert, VideoOff,
} from "lucide-react";
import type { ReactNode } from "react";
import { Button } from "./button";

const indicators = {
  info: Info,
  success: CircleCheck,
  warning: TriangleAlert,
  danger: CircleAlert,
};
const badges = { muted: CircleAlert, ...indicators };

export function StatusBadge({
  children, tone = "muted", icon: Icon = badges[tone],
}: { children: ReactNode; tone?: keyof typeof badges; icon?: typeof Info }) {
  return <span className={`status-badge tone-${tone}`}><Icon aria-hidden="true" size={16} />{children}</span>;
}

export function Notice({
  title, children, tone = "info", role,
}: { title: ReactNode; children?: ReactNode; tone?: keyof typeof indicators; role?: "alert" | "status" }) {
  const Icon = indicators[tone];
  return (
    <div className={`notice tone-${tone}`} role={role}>
      <Icon aria-hidden="true" size={20} />
      <div><strong>{title}</strong>{children && <div className="notice-body">{children}</div>}</div>
    </div>
  );
}

export function LoadingState({ label, announce = true }: { label: string; announce?: boolean }) {
  return (
    <div className="loading-state" role={announce ? "status" : undefined}>
      <span>{label}</span>
      <div className="skeleton" aria-hidden="true"><span /><span /></div>
    </div>
  );
}

export function RetrievalFeedback({
  state, onRead, loadingLabel, failedLabel, emptyDetail,
}: {
  state: "idle" | "loading" | "unavailable" | "empty";
  onRead: () => void;
  loadingLabel: string;
  failedLabel: string;
  emptyDetail?: string;
}) {
  const readLabel = { idle: "Load data", loading: "Reading data", unavailable: "Retry read", empty: "Read again" }[state];
  return (
    <div className="feedback-stack">
      <Button onClick={onRead} pending={state === "loading"}>{readLabel}</Button>
      <div role="status" className="feedback-announcement">
        {state === "loading" && <LoadingState label={loadingLabel} announce={false} />}
        {state === "unavailable" && <Notice tone="danger" title={failedLabel} />}
        {state === "empty" && <DataFeedback state="empty" detail={emptyDetail} />}
      </div>
    </div>
  );
}
const feedback = {
  empty: { label: "No data", icon: ArchiveX, tone: "muted" },
  expired: { label: "Record expired", icon: Clock, tone: "warning" },
  missing: { label: "Media missing", icon: FileQuestion, tone: "warning" },
  corrupt: { label: "Media corrupt", icon: VideoOff, tone: "danger" },
  unavailable: { label: "Media unavailable", icon: VideoOff, tone: "danger" },
} as const;

export function DataFeedback({ state, detail }: { state: keyof typeof feedback; detail?: string }) {
  const { label, icon, tone } = feedback[state];
  return (
    <div className="data-feedback">
      <StatusBadge icon={icon} tone={tone}>{label}</StatusBadge>
      {detail && <p className="control-hint">{detail}</p>}
    </div>
  );
}

export type SaveState =
  | { kind: "pending" }
  | { kind: "committed"; detail: string }
  | { kind: "failed"; detail: string };

export function SaveFeedback({ state }: { state?: SaveState }) {
  return (
    <div role="status" className="save-feedback">
      {state?.kind === "pending" && <Notice title="Save pending" />}
      {state?.kind === "committed" && <Notice title="Saved" tone="success">{state.detail}</Notice>}
      {state?.kind === "failed" && <Notice title="Save failed" tone="danger">{state.detail}</Notice>}
    </div>
  );
}
