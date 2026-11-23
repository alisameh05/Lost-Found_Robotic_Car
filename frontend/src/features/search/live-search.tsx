"use client";

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Video, Webcam } from "lucide-react";
import { PageHeader } from "@/components/layout/page-header";
import { ModelessPanel, Panel } from "@/components/layout/panel";
import { Button } from "@/components/ui/button";
import { LoadingState, Notice, StatusBadge } from "@/components/ui/feedback";
import { ModeInstructions } from "@/features/control-guide";
import { devicePaths } from "@/features/devices";
import { objectHref, RecordAbsent, RecordReadFailure, RecordTime, ReferenceImage, sessionHref } from "@/features/objects";
import { recordAbsence, searchActionKey, unresolved, useRefreshRuntime, useRuntime, useRuntimeRead, useRuntimeView } from "@/features/runtime";
import type { Snapshot } from "@/generated/api-v1";
import { localSearchPaths } from "@/lib/config";
import { pendingReview } from "@/lib/match-evidence";
import { gestureFeedback } from "@/lib/gesture-input";
import { ActionFeedback } from "./action-feedback";
import { MatchReview } from "./match-review";
import { ProximityAdvisory, RecoveryPanel } from "./recovery-panel";
import { InputControls } from "./search-fixture-controls";
import { SearchUnavailable } from "./search-unavailable";
import { duration, searchMode } from "./session-facts";
import styles from "./session.module.css";

export function LiveSearchScreen({ sessionId }: { sessionId: string }) {
  const { recordsMode, profile } = useRuntimeView();
  return recordsMode && !profile ? <SearchUnavailable title="Live Search Workspace" /> : <LiveSearch sessionId={sessionId} />;
}

function LiveSearch({ sessionId }: { sessionId: string }) {
  const { health, snapshot, searchActions, removedSessionId, workspace } = useRuntimeView();
  const router = useRouter();
  const stop = searchActions?.[searchActionKey("stop", sessionId)];
  const confirm = searchActions?.[searchActionKey("confirm", sessionId)];
  const terminal = confirm?.stage === "committed" ? confirm : stop?.stage === "committed" ? stop : undefined;
  const removed = removedSessionId === sessionId;
  useEffect(() => {
    if (removed || (!workspace?.resynchronizing && terminal?.session?.id === sessionId)) router.replace(`${sessionHref(sessionId)}/result`);
  }, [removed, router, sessionId, terminal, workspace?.resynchronizing]);
  const active = snapshot?.active_session?.id === sessionId && snapshot.active_object && !removed;
  const read = useRuntimeRead("/sessions/{id}", sessionId, !active && !removed);
  const refresh = useRefreshRuntime();

  if (active && snapshot) return <Workspace sessionId={sessionId} snapshot={snapshot} />;
  const absent = recordAbsence(read);
  const unknown = (["pause", "resume", "stop", "confirm", "reject", "acknowledge"] as const)
    .map((kind) => searchActions?.[searchActionKey(kind, sessionId)]).find((action) => action?.stage === "interrupted");
  return <div className={styles.page}>
    <PageHeader title="Live Search Workspace" />
    {unknown && <ActionFeedback label="Search action" feedback={unknown} />}
    {removed ? <LoadingState label="Opening search result" />
      : health?.initialization === "Starting" ? <Notice title="Initializing services">Checking the service and saved search records.</Notice>
      : absent ? <RecordAbsent status={absent} title="Session" />
      : !read ? <LoadingState label="Loading search session" />
      : read.kind !== "ok" ? <RecordReadFailure title="Search workspace unavailable" retry={refresh} />
      : read.data.state === "Ended" ? <Notice title="Search has ended">
        <Link href={`${sessionHref(sessionId)}/result`}>View Search Result</Link>
      </Notice> : <Notice title="Current search state unavailable">Refresh to reconnect to the active search.</Notice>}
    <Link href="/" className="button button--secondary">Return to Dashboard</Link>
  </div>;
}

function Workspace({ sessionId, snapshot }: { sessionId: string; snapshot: Snapshot }) {
  const { active_session: session, active_object: object, runtime: effective, lease, readiness } = snapshot;
  const { workspace, profile, searchActions, recordsMode, emergency } = useRuntimeView();
  const connection = useRuntime()?.connection;
  const runtime = connection?.runtime;
  const router = useRouter();
  const robot = useRef<HTMLDivElement>(null);
  const webcam = useRef<HTMLDivElement>(null);
  const [help, setHelp] = useState(false);
  const [recovery, setRecovery] = useState<boolean>();
  const [elapsed, setElapsed] = useState(0);
  const [destination, setDestination] = useState<string>();
  const [leaving, setLeaving] = useState(false);
  const [exitMessage, setExitMessage] = useState<string>();
  const [unconfirmedRelease, setUnconfirmedRelease] = useState(false);
  const releaseInFlight = useRef(false);
  const exitNavigation = useRef({ attempt: 0 });
  const exitLink = useRef<HTMLAnchorElement>(null);
  const stay = useRef<HTMLButtonElement>(null);
  const owner = !!workspace?.controlling;
  const connected = !!workspace?.eventsLive;
  const pause = searchActions?.[searchActionKey("pause", sessionId)];
  const resume = searchActions?.[searchActionKey("resume", sessionId)];
  const stop = searchActions?.[searchActionKey("stop", sessionId)];
  const acknowledgment = searchActions?.[searchActionKey("acknowledge", sessionId)];
  const state = effective.effective_session_state;
  const ready = owner && workspace.previewLive && workspace.usable && connected;
  const blocked = !connected || !owner || unresolved(stop);
  const candidate = connected && pendingReview(snapshot, snapshot.pending_candidate) ? snapshot.pending_candidate : null;
  const failures = snapshot.failures.filter((failure) => failure.session_id === sessionId);
  const recoveryOpen = recovery ?? (recordsMode && failures.length > 0);
  const stopSearch = () => { void runtime?.submitSearch({ kind: "stop", sessionId }); };

  useEffect(() => {
    if (robot.current && webcam.current && profile) return runtime?.mountWorkspace(robot.current, webcam.current, sessionId);
  }, [runtime, sessionId, profile]);
  useEffect(() => {
    const started = session?.started_at_ms;
    if (started === undefined || !runtime) return;
    const tick = () => setElapsed(Math.max(0, (runtime.serverTime() ?? started) - started));
    const timer = setInterval(tick, 1_000);
    return () => clearInterval(timer);
  }, [runtime, session?.started_at_ms]);
  useLayoutEffect(() => {
    const navigation = exitNavigation.current;
    const invalidateExit = () => { navigation.attempt++; };
    function confirmExit(event: MouseEvent) {
      if (event.button !== 0 || event.defaultPrevented || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return;
      const link = (event.target as Element | null)?.closest("a[href]");
      if (!(link instanceof HTMLAnchorElement) || link.target || link.hasAttribute("download")) return;
      const url = new URL(link.href);
      if (url.origin !== location.origin || url.pathname === location.pathname) return;
      event.preventDefault();
      navigation.attempt++;
      exitLink.current = link;
      setDestination(url.pathname + url.search + url.hash);
      setLeaving(false);
      setExitMessage(undefined);
    }
    document.addEventListener("click", confirmExit, true);
    window.addEventListener("popstate", invalidateExit, true);
    return () => {
      invalidateExit();
      document.removeEventListener("click", confirmExit, true);
      window.removeEventListener("popstate", invalidateExit, true);
    };
  }, []);
  useEffect(() => { if (destination) stay.current?.focus(); }, [destination]);
  useEffect(() => {
    if (!leaving || !destination || session?.state !== "Paused" || state !== "Paused" ||
        effective.persistence_pending || unresolved(pause) || releaseInFlight.current) return;
    releaseInFlight.current = true;
    const navigation = exitNavigation.current;
    const attempt = navigation.attempt;
    const release = runtime?.releaseWorkspace();
    void Promise.resolve(release).then((result) => {
      releaseInFlight.current = false;
      if (attempt !== navigation.attempt) return;
      if ((!result && !owner && (!unconfirmedRelease || lease.state === "Unowned")) || (result?.kind === "ok" && result.status === 200 &&
          result.data.snapshot.lease.state === "Unowned" && result.data.snapshot.active_session?.id === sessionId &&
          result.data.snapshot.active_session.state === "Paused" && !result.data.snapshot.runtime.persistence_pending)) {
        router.push(destination);
      } else {
        setLeaving(false);
        setUnconfirmedRelease(true);
        setExitMessage(result?.kind === "api-error" ? `Release rejected · ${result.error.message}` :
          "Release could not be confirmed. Check the current search state before leaving.");
      }
    });
  }, [destination, effective.persistence_pending, lease.state, leaving, owner, pause, router, runtime, session?.state, sessionId, state, unconfirmedRelease]);

  if (!session || !object) return null;
  const mode = session.control_mode;
  const gestures = mode === "Gestures";
  const { integrated, localMatching, localGestures, localController } = localSearchPaths(profile);
  const deviceMode = profile?.evidence_kind === "Device";
  const usesLocalGestures = deviceMode || localGestures;
  const usesLocalController = deviceMode || localController;
  const gestureInactive = !gestures && (usesLocalGestures || usesLocalController);
  const webcamLive = !!workspace?.webcamLive && !gestureInactive;
  const recognitionReady = connected && readiness.components.some(
    ({ component, status }) => component === "Webcam" && status === "Ready",
  );
  const sample = owner && ready ? connection?.fixture?.search.readInput() : undefined;
  const permission = connected ? effective.motion_permission : "Unknown";
  const connectedInput = permission === "Armed" ? "Simulated direction held"
    : permission === "Arming" ? "Neutral accepted · waiting for a fresh hold"
    : state === "Paused" ? "Simulated movement stopped"
    : "Waiting for neutral simulated input";
  const localGestureInput = !recognitionReady ? "Gesture recognition unavailable"
    : webcamLive ? "Recognition shown on the mirrored preview" : "Webcam preview unavailable";
  const controllerReady = connected && readiness.components.some(
    ({ component, status }) => component === "Controller" && status === "Ready",
  );
  const localControllerInput = controllerReady ? "Selected USB DualShock 4 ready" : "Selected USB DualShock 4 unavailable";
  const controllerInstruction = state === "Searching" && owner && ready && permission === "Disarmed"
    ? "Release the D-pad to neutral, then hold a direction."
    : "Hold a D-pad direction to move. Release to stop.";
  const input = usesLocalGestures && gestures ? localGestureInput
    : usesLocalController && !gestures ? localControllerInput
    : recordsMode ? connectedInput : gestures ? gestureFeedback(sample) : sample === "invalid" ? "Conflicting D-pad input"
    : sample && sample !== "neutral" ? `Held ${sample}` : "No direction held";
  const searching = state === "Searching";
  const matching = searching && connected && readiness.components.some(({ component, status }) => component === "AI" && status === "Ready");
  const matchingLabel = localMatching || deviceMode
    ? matching ? "Offline YOLOE matching active" : "Offline YOLOE matching suspended"
    : matching ? recordsMode ? "Simulated AI matching active" : "AI matching active"
      : localGestures || localController ? "Simulated AI matching suspended" : "AI matching suspended";
  const robotLive = workspace?.previewLive && readiness.components.some(({ component, status }) =>
    component === "RobotVideo" && status === "Ready");
  const canAcquire = connected && !!workspace?.usable && workspace.previewLive &&
    (lease.can_acquire || !!workspace.retryAcquisition);
  const canLeavePaused = session.state === "Paused" && state === "Paused" && !effective.persistence_pending;
  const waitingToLeave = leaving && (unresolved(pause) || canLeavePaused);
  const saving = effective.persistence_pending || snapshot.operations.some(({ persistence }) => persistence === "Pending");
  const unsavedEmergency = failures.some(({ cause, failure_id }) => cause === "EmergencyStop" &&
    !session.pause_causes.some((pauseCause) => pauseCause.failure_id === failure_id));
  const emergencySaveFailed = unsavedEmergency && (recordsMode
    ? emergency?.kind === "result" && emergency.response.persistence === "Failed" && emergency.response.session_id === sessionId
    : !saving);
  const requiredUnavailable = readiness.components.filter(({ component, status }) => status !== "Ready" &&
    component !== (gestures ? "Controller" : "Webcam"));
  const recoveryBlockers = [
    !owner && "Acquire available control.",
    !connected && "Reconnect to search events.",
    !workspace?.usable && "Return to a visible, focused workspace with a usable robot camera display.",
    !workspace?.previewLive && "Wait for a live robot camera view.",
    requiredUnavailable.length > 0 && `Required paths unavailable: ${requiredUnavailable.map(({ component }) => devicePaths[component].label).join(", ")}.`,
    failures.some(({ restored }) => !restored) && "Restore the failed paths.",
    failures.some(({ acknowledged }) => !acknowledged) && "Acknowledge each outstanding failure.",
    saving && "Wait for the pending save.",
    session.state !== "Paused" && state === "Paused" && !saving && "Save the pause before resuming.",
    candidate && "Complete the pending match review.",
    !candidate && snapshot.pending_candidate && "Wait for the current candidate review to become available.",
  ].filter((item): item is string => typeof item === "string");

  function leavePaused() {
    if (!canLeavePaused && !owner) return;
    setExitMessage(undefined);
    setLeaving(true);
    if (!canLeavePaused && !unresolved(pause)) void runtime?.submitSearch({ kind: "pause", sessionId });
  }

  return <div className={styles.page}>
    <PageHeader title="Live Search Workspace" description={integrated
      ? `${gestures ? "Local webcam gestures" : "Selected USB DualShock 4"} · Recorded robot video and simulated commands`
      : localGestures
      ? `${gestures ? "Local webcam gestures" : "Simulated controller"} · Simulated robot video and commands`
        : localController
        ? `${gestures ? "Simulated gestures" : "Selected USB DualShock 4"} · Simulated robot video and commands`
      : localMatching
      ? `Simulated robot video, commands and input · ${permission}`
      : deviceMode ? `Device mode · ${permission}` : recordsMode ? `Backend simulation · ${permission}` : undefined} actions={<>
      <Button onClick={() => setHelp(!help)} aria-expanded={help} aria-controls={help ? "live-control-help" : undefined}>Control Help</Button>
      {(state === "Paused" || recoveryOpen) && <Button onClick={() => setRecovery(!recoveryOpen)}
        aria-expanded={recoveryOpen} aria-controls={recoveryOpen ? "search-recovery" : undefined}>Recovery</Button>}
    </>} />
    <Panel className={styles.target} aria-label="Active search target">
      <div className={styles.thumbnail}><ReferenceImage object={object} thumbnail /></div>
      <div>
        <h2>{object.name}</h2>
        <p>{searchMode(mode)} · Target and mode locked</p>
      </div>
      <div className={styles.actions}>
        <StatusBadge tone={connected && state === "Searching" ? "success" : "warning"}>{connected ? state ?? "Unknown" : "Disconnected"}</StatusBadge>
        <span aria-label="Elapsed time">{duration(elapsed)}</span>
        {session.state === "Searching" || unresolved(resume)
          ? <Button disabled={blocked || unresolved(pause)} onClick={() => { void runtime?.submitSearch({ kind: "pause", sessionId }); }}>Pause</Button>
          : <Button disabled={blocked || !ready || !readiness.can_resume || unresolved(resume)}
            onClick={() => { void runtime?.submitSearch({ kind: "resume", sessionId }); }}>Resume</Button>}
        {!candidate && <Button variant="destructive" disabled={blocked} onClick={stopSearch}>Stop Search</Button>}
      </div>
    </Panel>
    {object.retention_grace && <Notice role="status" tone="warning" title="Active-session grace">
      The retention deadline has passed. The target and evidence remain available until this search ends.
    </Notice>}
    {destination && <Panel className={styles.exit} aria-label="Leave search workspace">
      <h2>Leave search workspace?</h2>
      <p>Leaving paused keeps the current target and session available in Return to Active Search.</p>
      {exitMessage && <Notice role="alert" title={exitMessage} tone="danger" />}
      {!canLeavePaused && !owner && <p>This read-only view cannot pause the search.</p>}
      <div className="control-row">
        <Button ref={stay} onClick={() => {
          exitNavigation.current.attempt++;
          setDestination(undefined);
          setLeaving(false);
          exitLink.current?.focus();
        }}>Stay</Button>
        {owner || canLeavePaused ? <Button pending={waitingToLeave} onClick={leavePaused}>Leave Paused</Button> :
          <Button onClick={() => router.push(destination)}>Leave read-only view</Button>}
        <Button variant="destructive" disabled={blocked} onClick={() => { void runtime?.submitSearch({ kind: "stop", sessionId }); }}>Stop Search</Button>
      </div>
    </Panel>}
    {help && <ModelessPanel id="live-control-help" title="Control Help"><ModeInstructions mode={mode} heading="h3" /></ModelessPanel>}
    {recoveryOpen && <RecoveryPanel failures={failures} blockers={recoveryBlockers} searching={searching}
      manuallyPaused={session.pause_causes.some(({ cause }) => cause === "ManualPause")}
      canAcknowledge={owner && connected && readiness.components.some(({ component, status }) => component === "Storage" && status === "Ready")}
      feedback={acknowledgment} acknowledge={(id) => {
        if (recordsMode) setRecovery(true);
        void runtime?.submitSearch({ kind: "acknowledge", sessionId, failureIds: [id] });
      }}
      retry={() => { void runtime?.retrySearch("acknowledge", sessionId); }} />}
    <div role="status" className="visually-hidden">{candidate && "Potential match. Search paused for review."}</div>
    {candidate && <MatchReview key={candidate.evidence_media.id} match={candidate} object={object}
      canAct={owner && connected} canStop={!blocked} stop={stopSearch} />}
    <div className={styles.workspace}>
      <div className={styles.views}>
        <div className={styles.cameras}>
          <Panel className={styles.camera} aria-labelledby="webcam-title">
            <header><h2 id="webcam-title"><Webcam aria-hidden="true" />Laptop webcam</h2>
              <StatusBadge tone={webcamLive ? "success" : "muted"}>{webcamLive ? usesLocalGestures ? "Live • Mirrored" : "Live sample"
                : gestureInactive ? "Inactive" : "Unavailable"}</StatusBadge></header>
            <div ref={webcam} className={`${styles.surface} ${gestures && !usesLocalGestures ? styles.mirrored : ""}`}
              data-live={webcamLive} aria-hidden={gestureInactive || undefined} />
            {(!usesLocalGestures || !gestures) && <p>{gestures ? input : "Gesture control inactive"}</p>}
          </Panel>
          <Panel className={styles.camera} aria-labelledby="robot-title">
            <header><h2 id="robot-title"><Video aria-hidden="true" />Robot camera</h2>
              <StatusBadge tone={robotLive ? "success" : "warning"}>{robotLive ? deviceMode ? "Live" : "Live sample" : "Not live"}</StatusBadge></header>
            <div ref={robot} className={styles.surface} />
            <p>{matchingLabel} · {snapshot.pending_candidate ? "Candidate awaiting review" : "No candidate awaiting review"}</p>
          </Panel>
        </div>
        <Panel className={styles.input} aria-label={gestures ? "Gesture feedback" : "Controller feedback"}>
          <h2>{gestures ? "Gesture input" : "PS4 controller input"}</h2>
          <div role="status">
            <p>{input}</p>
            <p>Motion permission · {permission}</p>
            {usesLocalController && !gestures && <p>{controllerInstruction} Press Circle for Emergency Stop.</p>}
            {!recordsMode && searching && ready && permission !== "Armed" && <p>{permission === "Arming" ? "Ready for a fresh hold." : "Release to neutral before holding a direction."}</p>}
          </div>
        </Panel>
      </div>
      <aside className={styles.rail} aria-label="Search status">
        <section aria-label="Connections">
          <h2>Connections</h2>
          <dl className={styles.connections}>
            {(["Command", "RobotVideo", "DisplayedRobotVideo", "Workspace", gestures ? "Webcam" : "Controller", "AI", "Storage"] as const).map((key) =>
              <div key={key}><dt>{devicePaths[key].label}</dt><dd>{readiness.components.find(({ component }) => component === key)?.status ?? "Unknown"}</dd></div>)}
          </dl>
          <ProximityAdvisory proximity={snapshot.proximity} />
        </section>
        <section aria-label="Session activity">
          <h2>Session activity</h2>
          <p>Search accepted · <RecordTime value={session.started_at_ms} compact /></p>
          <p>Committed session · {session.state}</p>
          {effective.persistence_pending && <p>Session save pending</p>}
          {emergencySaveFailed && <p>Emergency pause save failed. Retry Emergency Stop to save it.</p>}
        </section>
        <section aria-label="Control ownership">
          <h2>Control ownership</h2>
          <p>{owner ? "This workspace holds control." : "Spectator · Read-only"}</p>
          {!workspace?.usable && <p>Control unavailable while the workspace is hidden, unfocused, or unable to display robot video.</p>}
          {workspace?.message && <p role="status">{workspace.message}</p>}
          {!owner && <Button disabled={!canAcquire} pending={workspace?.acquiring}
            onClick={() => { void runtime?.acquireWorkspace(); }}>Acquire control</Button>}
          {!owner && canAcquire && <p>Acquiring control consents to taking over the available lease.</p>}
          <p role="status">{failures.length > 0 && `Recovery required before Resume. ${failures.length} outstanding ${failures.length === 1 ? "failure" : "failures"}.`}</p>
          {!profile && <p>A compatible qualification profile is unavailable.</p>}
        </section>
      </aside>
    </div>
    <div className={styles.feedback}>
      <ActionFeedback label="Pausing search" feedback={pause} retry={connected ? () => { void runtime?.retrySearch("pause", sessionId); } : undefined} />
      <ActionFeedback label="Resuming search" feedback={resume} canRetryFailed={recordsMode && ready && readiness.can_resume}
        retry={connected ? () => { void runtime?.retrySearch("resume", sessionId); } : undefined} />
      <ActionFeedback label="Stopping search" feedback={stop} retry={connected ? () => { void runtime?.retrySearch("stop", sessionId); } : undefined} />
    </div>
    <InputControls mode={mode} disabled={!searching || !ready ||
      !readiness.components.some(({ component, status }) => component === "DisplayedRobotVideo" && status === "Ready")} />
    <footer className={styles.actions}>
      <Link href={objectHref(object.id)} className="button button--secondary">View Object Details</Link>
      <Link href={sessionHref(sessionId)} className="button button--secondary">View Session Details</Link>
    </footer>
  </div>;
}
