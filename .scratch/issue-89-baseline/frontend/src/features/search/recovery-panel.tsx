import { ModelessPanel } from "@/components/layout/panel";
import { Button } from "@/components/ui/button";
import { RecordTime } from "@/features/objects";
import { unresolved, type SearchFeedback } from "@/features/runtime";
import type { Failure, FailureCause, Proximity } from "@/generated/api-v1";
import { ActionFeedback } from "./action-feedback";
import styles from "./session.module.css";

const causeLabels: Record<FailureCause, string> = {
  EmergencyStop: "Emergency Stop",
  WorkspaceDisconnected: "Workspace disconnected",
  WorkspaceHidden: "Workspace hidden",
  WorkspaceUnfocused: "Workspace lost focus",
  WorkspaceUnusable: "Workspace unusable",
  HeartbeatExpired: "Workspace heartbeat expired",
  DisplayStale: "Displayed robot video stale",
  RobotVideoUnavailable: "Robot camera unavailable",
  CameraEpochChanged: "Robot camera stream changed",
  CommandUnavailable: "Command link unavailable",
  CommandExpired: "Command permission expired",
  InputUnavailable: "Selected input unavailable",
  AIUnavailable: "Matching service unavailable",
  StorageFault: "Storage unavailable",
  ProtocolMismatch: "Service protocol incompatible",
};

export function RecoveryPanel({ failures, blockers, searching, manuallyPaused, canAcknowledge, feedback, acknowledge, retry }: {
  failures: Failure[]; blockers: string[]; searching: boolean; canAcknowledge: boolean;
  manuallyPaused: boolean;
  feedback?: SearchFeedback; acknowledge(id: string): void; retry(): void;
}) {
  return <ModelessPanel id="search-recovery" title="Recovery">
    {manuallyPaused && <p>Paused by operator.</p>}
    <p role="status">{searching ? "Search is running." : blockers.length ?
      `Resume unavailable. ${blockers.join(" ")}` : "Recovery complete. Choose Resume, then release to neutral and hold a direction again."}</p>
    {failures.length > 0 && <ul className={styles.recoveryList}>
      {failures.map((failure) => <li key={failure.failure_id}>
        <strong>{causeLabels[failure.cause]}</strong>
        <span>Observed <RecordTime value={failure.observed_at_ms} /></span>
        <small className={styles.failureId}>Failure ID {failure.failure_id}</small>
        <span>{failure.restored ? "Restored" : "Awaiting restoration"} · {failure.acknowledged ? "Acknowledged" : "Awaiting acknowledgment"}</span>
        {!failure.acknowledged && <Button disabled={!canAcknowledge || unresolved(feedback)}
          aria-describedby={`cause-${failure.failure_id}`} onClick={() => acknowledge(failure.failure_id)}>Acknowledge</Button>}
        <span className="visually-hidden" id={`cause-${failure.failure_id}`}>{causeLabels[failure.cause]}</span>
      </li>)}
    </ul>}
    <ActionFeedback label="Acknowledging failure" feedback={feedback} canRetryFailed={canAcknowledge} retry={retry} />
  </ModelessPanel>;
}

export function ProximityAdvisory({ proximity }: { proximity: Proximity }) {
  return <div className={styles.proximity} data-warning={proximity.warning_latched} role="status" aria-label="Proximity advisory">
    <p>Proximity · {proximity.state} · Advisory only</p>
    <p>{proximity.distance_mm === null ? "Distance unavailable" : `Distance ${proximity.distance_mm} mm`}</p>
    {proximity.warning_latched && <p>{proximity.state === "Unknown" ? "Previous obstacle warning remains active" : "Obstacle warning active"}</p>}
  </div>;
}
