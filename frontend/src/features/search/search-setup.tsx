"use client";

import { Check, Gamepad2, Hand, Minus, TriangleAlert } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { PageHeader } from "@/components/layout/page-header";
import { Panel } from "@/components/layout/panel";
import { Button } from "@/components/ui/button";
import { LoadingState, Notice, StatusBadge } from "@/components/ui/feedback";
import { ModeInstructions } from "@/features/control-guide";
import { describeDeviceReadiness, devicePaths } from "@/features/devices";
import { ObjectStatus, objectHref, RecordAbsent, RecordReadFailure, ReferenceImage } from "@/features/objects";
import { searchActionKey, unresolved, useObjectRecord, useRefreshRuntime, useRuntime, useRuntimeView } from "@/features/runtime";
import { componentNames, type ControlMode, type Object as ObjectRecord } from "@/generated/api-v1";
import { searchSetupBlockReason, supportHref } from "@/lib/search-setup-context";
import styles from "./search-setup.module.css";
import { ActionFeedback } from "./action-feedback";
import { SearchSaveControls } from "./search-fixture-controls";

const modes = [
  { value: "Gestures", label: "Gestures", detail: "Laptop webcam required.", icon: Hand },
  { value: "Controller", label: "PS4 controller", detail: "DualShock 4 required.", icon: Gamepad2 },
] as const;

export function SearchSetupScreen({ objectId, mode = "Gestures" }: { objectId: string; mode?: ControlMode }) {
  const { object, result, absence, retry } = useObjectRecord(objectId);
  return <div className={styles.page}>
    <PageHeader title="Search Setup" description="Review the saved target, choose a control mode, and check readiness." />
    {absence ? <RecordAbsent status={absence} title="Object" />
      : object ? <Setup key={`${object.id}:${object.reference_media.id}:${mode}`} object={object} initialMode={mode} />
      : !result ? <LoadingState label="Loading saved target" />
      : <RecordReadFailure title="Target unavailable" retry={retry} />}
    {!object && <footer className={styles.actions}>
      <Link className="button button--secondary" href={absence ? "/objects" : objectHref(objectId)}>
        {absence ? "Back to Objects" : "Back to Object Details"}
      </Link>
    </footer>}
  </div>;
}

function Setup({ object, initialMode }: { object: ObjectRecord; initialMode: ControlMode }) {
  const [mode, setMode] = useState(initialMode);
  const [referenceDisplayed, setReferenceDisplayed] = useState<boolean>();
  const connection = useRuntime()?.connection;
  const runtime = connection?.runtime;
  const fixture = connection?.fixture;
  const view = useRuntimeView();
  const refresh = useRefreshRuntime();
  const router = useRouter();
  const { snapshot, health, workspace, profile } = view;
  const canvas = useRef<HTMLDivElement>(null);
  const requestedStart = useRef(false);
  useEffect(() => {
    if (canvas.current && profile) return runtime?.mountWorkspace(canvas.current);
  }, [runtime, profile]);

  const context = { objectId: object.id, mode };
  const expiry = runtime?.serverTime();
  const recordBlock = object.retention_grace || (expiry !== undefined && expiry >= object.expires_at_ms)
    ? "This expired record is available for its existing search only." : searchSetupBlockReason(object, view);
  const active = snapshot?.active_session || (view.failedRead && health?.active_session_state);
  const eligible = !recordBlock && !active && referenceDisplayed === true && !!snapshot && !view.failedRead;
  const starting = view.searchActions?.[searchActionKey("start", object.id)];
  const busy = unresolved(starting);
  const accepted = starting?.stage === "committed" ? starting.session : undefined;
  useEffect(() => {
    if (requestedStart.current && accepted && snapshot?.active_session?.id === accepted.id) {
      router.replace(`/sessions/${encodeURIComponent(accepted.id)}/live`);
    }
  }, [accepted, router, snapshot?.active_session?.id]);
  useEffect(() => {
    if (!eligible && !busy && !accepted && (workspace?.controlling || workspace?.acquiring)) void runtime?.releaseWorkspace();
  }, [eligible, busy, accepted, runtime, workspace?.controlling, workspace?.acquiring]);

  const readiness = view.failedRead ? health?.readiness : snapshot?.readiness ?? health?.readiness;
  const required = describeDeviceReadiness(readiness, mode);
  const blockedPaths = [...required.shared, ...(required.selected ? [required.selected] : [])]
    .filter(({ component, status }) => status !== "Ready" && component !== "Workspace" && component !== "DisplayedRobotVideo");
  const ready = eligible && !!workspace?.eventsLive && workspace.usable && workspace.controlling && workspace.previewLive &&
    snapshot?.readiness.can_start[mode] === true;
  const spectator = snapshot?.lease.state === "Owned" && !workspace?.controlling && !workspace?.acquiring && !workspace?.retryAcquisition;
  const acquisitionBlocked = recordBlock ?? (referenceDisplayed === false ? "The reference image is unavailable."
    : referenceDisplayed === undefined ? "Wait for the saved reference to display."
    : !profile ? "A compatible qualification profile is unavailable."
    : !workspace?.eventsLive ? "Wait for current search readiness."
    : spectator ? "Another workspace holds control."
    : !workspace.previewLive ? "Wait for a live robot preview."
    : !workspace.usable ? "Keep this workspace visible and focused."
    : !eligible || (!snapshot?.lease.can_acquire && !workspace?.retryAcquisition) ? "Control is currently unavailable." : undefined);

  let notice = recordBlock;
  if (!notice && referenceDisplayed === false) notice = "The reference image is unavailable.";
  if (!notice && !profile && !view.loading) notice = "A compatible qualification profile is unavailable.";
  if (!notice && view.failedRead) notice = "Search readiness is unavailable. Refresh readiness to check again.";
  if (!notice && blockedPaths.length) notice = blockedPaths.map(({ component }) => devicePaths[component].label).join(", ") + " must report Ready.";
  if (!notice && workspace?.eventsLive && !workspace.previewLive) notice = "Wait for a fresh robot frame.";

  return <>
    <div className={styles.columns}>
      <div className={styles.column}>
        <Panel className={styles.card} aria-label="Saved search target">
          <div className={styles.row}><h2>{object.name}</h2><ObjectStatus status={object.status} /></div>
          <ReferenceImage object={object} target="both" onDisplay={setReferenceDisplayed} />
          <p className={styles.muted}>Selected target · {object.roi.width} × {object.roi.height} px</p>
        </Panel>
        <Panel className={styles.card} aria-labelledby="robot-preview-title">
          <div className={styles.row}>
            <h2 id="robot-preview-title">Robot preview</h2>
            <StatusBadge tone={workspace?.previewLive ? "success" : "warning"}>{workspace?.previewLive ? "Live preview" : "Not live"}</StatusBadge>
          </div>
          <div ref={canvas} className={styles.preview} />
          <p className={styles.muted}>{workspace?.controlling ? "This workspace holds control." : "Read-only preview."}</p>
        </Panel>
      </div>

      <div className={styles.column}>
        <fieldset className={styles.modes} disabled={busy}>
          <legend>Control mode</legend>
          {modes.map(({ value, label, detail, icon: Icon }) => <label className={styles.mode} key={value}>
            <Icon aria-hidden="true" size={24} />
            <span><strong>{label}</strong><small>{detail}</small></span>
            <input type="radio" name="search-control-mode" value={value} checked={mode === value}
              aria-label={label} onChange={() => setMode(value)} />
          </label>)}
        </fieldset>
        <Panel className={`${styles.card} ${styles.instructions}`}>
          <ModeInstructions mode={mode} title={mode === "Gestures" ? "Gesture instructions" : "PS4 instructions"} />
          <Link href={supportHref("/control-guide", context)}>Open Control Guide</Link>
        </Panel>
        <section aria-labelledby="setup-readiness-title" className={styles.column}>
          <div className={styles.row}>
            <h2 id="setup-readiness-title">Connection readiness</h2>
            <Link className="button button--secondary" href={supportHref("/devices", context)}>View Devices</Link>
          </div>
          {health?.initialization === "Starting" && <Notice title="Initializing services" tone="warning">Checking the backend and managed storage.</Notice>}
          {health?.initialization === "Failed" && <Notice title="Backend diagnostics" tone="danger">Managed storage or startup checks failed.</Notice>}
          <Panel className={styles.card}>
            <ul className={styles.readiness}>
              {componentNames.map((name) => {
                const observation = readiness?.components.find(({ component }) => component === name);
                const inactive = name === (mode === "Gestures" ? "Controller" : "Webcam");
                const status = observation?.status ?? "Unknown";
                const Icon = inactive ? Minus : status === "Ready" ? Check : TriangleAlert;
                return <li key={name}>
                  <span><Icon className={inactive ? styles.muted : status === "Ready" ? styles.success : styles.warning}
                    size={16} aria-hidden="true" />{devicePaths[name].label}</span>
                  <span className={styles.muted}>{inactive ? "Inactive" : "Required"}</span>
                  <span className={status === "Ready" && !inactive ? styles.success : styles.muted}>{status}</span>
                </li>;
              })}
              <li><span>Proximity sensor</span><span className={styles.muted}>Advisory</span>
                <span>{snapshot?.proximity.state ?? "Unknown"}{snapshot?.proximity.state === "Unknown" && snapshot.proximity.warning_latched
                  ? " · Previous warning active" : ""}</span></li>
            </ul>
          </Panel>
          {view.failedRead && <Button onClick={refresh}>Refresh readiness</Button>}
        </section>
      </div>
    </div>
    <footer className={styles.footer}>
      <div role="status" className={styles.feedback}>
        {ready ? <Notice tone="success" title="Ready to start">Required paths are ready and the robot preview is live.</Notice>
          : notice ? <Notice tone="warning" title="Start blocked">{notice}</Notice>
          : <Notice title={spectator ? "Spectator" : workspace?.controlling ? "Checking the displayed frame" : "Preview only"}>
            {spectator ? "Another workspace holds control." : workspace?.controlling
              ? "Waiting for the fixture to acknowledge the displayed robot frame." : "Acquire control to finish checking readiness."}
          </Notice>}
        {workspace?.message && <p>{workspace.message}</p>}
        <ActionFeedback label="Starting search" feedback={starting?.stage === "committed" && !active ? undefined : starting} retry={() => {
          requestedStart.current = true;
          void runtime?.retrySearch("start", object.id);
        }} />
      </div>
      <div className={styles.actions}>
        <Link className="button button--secondary" href={objectHref(object.id)}>Back to Object Details</Link>
        {!workspace?.controlling && <Button variant="primary" pending={workspace?.acquiring}
          disabledReason={acquisitionBlocked} onClick={() => { void runtime?.acquireWorkspace(); }}>Acquire control</Button>}
        <Button variant="primary" pending={starting?.stage === "sending"} disabled={!ready || busy}
          onClick={() => {
            if (!ready) return;
            requestedStart.current = true;
            void runtime?.submitSearch({ kind: "start", object, mode });
          }}>Start Search</Button>
      </div>
      <SearchSaveControls />
      {snapshot && snapshot.lease.control_generation > 1 && snapshot.lease.can_acquire && !acquisitionBlocked &&
        <p className={styles.muted}>Selecting Acquire control consents to taking over available control.</p>}
    </footer>
    {fixture && <details className={styles.fixture}>
      <summary>Search setup fixture controls</summary>
      <div className="control-row">
        <Button onClick={() => fixture.search.changeFrames("live")}>Send fresh frames</Button>
        <Button onClick={() => fixture.search.changeFrames("frozen")}>Freeze robot frames</Button>
        <Button onClick={() => fixture.search.changeFrames("disconnected")}>Disconnect robot video</Button>
        <Button onClick={fixture.search.disconnectEvents}>Disconnect search events</Button>
      </div>
    </details>}
  </>;
}
