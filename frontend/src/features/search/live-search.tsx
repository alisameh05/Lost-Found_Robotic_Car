"use client";

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Video, Webcam } from "lucide-react";
import { PageHeader } from "@/components/layout/page-header";
import { Panel } from "@/components/layout/panel";
import { Button } from "@/components/ui/button";
import { LoadingState, Notice, StatusBadge } from "@/components/ui/feedback";
import { ModeInstructions } from "@/features/control-guide";
import { devicePaths } from "@/features/devices";
import { objectHref, RecordAbsent, RecordReadFailure, RecordTime, ReferenceImage, sessionHref } from "@/features/objects";
import { recordAbsence, searchActionKey, unresolved, useRefreshRuntime, useRuntime, useRuntimeRead, useRuntimeView } from "@/features/runtime";
import type { Snapshot } from "@/generated/api-v1";
import { pendingReview } from "@/lib/match-evidence";
import { ActionFeedback } from "./action-feedback";
import { MatchReview } from "./match-review";
import { InputControls } from "./search-fixture-controls";
import { duration, searchMode } from "./session-facts";
import styles from "./session.module.css";

export function LiveSearchScreen({ sessionId }: { sessionId: string }) {
  const { snapshot, searchActions, removedOwners } = useRuntimeView();
  const router = useRouter();
  const stop = searchActions?.[searchActionKey("stop", sessionId)];
  const confirm = searchActions?.[searchActionKey("confirm", sessionId)];
  const terminal = confirm?.stage === "committed" ? confirm : stop?.stage === "committed" ? stop : undefined;
  useEffect(() => {
    if (terminal?.session?.id === sessionId) router.replace(`${sessionHref(sessionId)}/result`);
  }, [router, sessionId, terminal]);
  const active = snapshot?.active_session?.id === sessionId && snapshot.active_object && !removedOwners?.has(snapshot.active_object.id);
  const read = useRuntimeRead("/sessions/{id}", sessionId, !active);
  const refresh = useRefreshRuntime();

  if (active && snapshot) return <Workspace sessionId={sessionId} snapshot={snapshot} />;
  const absent = recordAbsence(read);
  return <div className={styles.page}>
    <PageHeader title="Live Search Workspace" />
    {terminal && !terminal.session ? <Notice title="Record removed after expiry">
      The search ended and the expired record is no longer available.
    </Notice> : absent ? <RecordAbsent status={absent} title="Session" />
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
  const { workspace, profile, searchActions } = useRuntimeView();
  const connection = useRuntime()?.connection;
  const runtime = connection?.runtime;
  const router = useRouter();
  const robot = useRef<HTMLDivElement>(null);
  const webcam = useRef<HTMLDivElement>(null);
  const [help, setHelp] = useState(false);
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
  const state = effective.effective_session_state;
  const ready = owner && workspace.previewLive && workspace.usable && connected;
  const blocked = !connected || !owner || unresolved(stop);
  const candidate = pendingReview(snapshot, snapshot.pending_candidate) ? snapshot.pending_candidate : null;
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
  const sample = owner && ready ? connection?.fixture?.search.readInput() : undefined;
  const permission = connected ? effective.motion_permission : "Unknown";
  const input = sample === "invalid" ? gestures ? "Ambiguous gesture" : "Conflicting D-pad input"
    : sample && sample !== "neutral" ? `Held ${sample}` : "No direction held";
  const searching = state === "Searching";
  const matching = searching && connected && readiness.components.some(({ component, status }) => component === "AI" && status === "Ready");
  const canAcquire = connected && !!workspace?.usable && workspace.previewLive &&
    (lease.can_acquire || !!workspace.retryAcquisition);
  const canLeavePaused = session.state === "Paused" && state === "Paused" && !effective.persistence_pending;
  const waitingToLeave = leaving && (unresolved(pause) || canLeavePaused);

  function leavePaused() {
    if (!canLeavePaused && !owner) return;
    setExitMessage(undefined);
    setLeaving(true);
    if (!canLeavePaused && !unresolved(pause)) void runtime?.submitSearch({ kind: "pause", sessionId });
  }

  return <div className={styles.page}>
    <PageHeader title="Live Search Workspace" actions={<Button onClick={() => setHelp(!help)}
      aria-expanded={help} aria-controls="live-control-help">Control Help</Button>} />
    <Panel className={styles.target} aria-label="Active search target">
      <div className={styles.thumbnail}><ReferenceImage object={object} thumbnail /></div>
      <div>
        <h2>{object.name}</h2>
        <p>{searchMode(mode)} · Target and mode locked</p>
      </div>
      <div className={styles.actions}>
        <StatusBadge tone={state === "Searching" ? "success" : "warning"}>{state ?? "Unknown"}</StatusBadge>
        <span aria-label="Elapsed time">{duration(elapsed)}</span>
        {session.state === "Searching" || unresolved(resume)
          ? <Button disabled={blocked || unresolved(pause)} onClick={() => { void runtime?.submitSearch({ kind: "pause", sessionId }); }}>Pause</Button>
          : <Button disabled={blocked || !ready || !readiness.can_resume || unresolved(resume)}
            onClick={() => { void runtime?.submitSearch({ kind: "resume", sessionId }); }}>Resume</Button>}
        {!candidate && <Button variant="destructive" disabled={blocked} onClick={stopSearch}>Stop Search</Button>}
      </div>
    </Panel>
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
    {help && <Panel id="live-control-help"><ModeInstructions mode={mode} title="Control Help" /></Panel>}
    <div role="status" className="visually-hidden">{candidate && "Potential match. Search paused for review."}</div>
    {candidate && <MatchReview key={candidate.evidence_media.id} match={candidate} object={object}
      canAct={owner && connected} canStop={!blocked} stop={stopSearch} />}
    <div className={styles.workspace}>
      <div className={styles.views}>
        <div className={styles.cameras}>
          <Panel className={styles.camera} aria-labelledby="webcam-title">
            <header><h2 id="webcam-title"><Webcam aria-hidden="true" />Laptop webcam</h2>
              <StatusBadge tone={workspace?.webcamLive ? "success" : "muted"}>{workspace?.webcamLive ? "Live sample" : "Unavailable"}</StatusBadge></header>
            <div ref={webcam} className={`${styles.surface} ${gestures ? styles.mirrored : ""}`} data-live={!!workspace?.webcamLive} />
            <p>{gestures ? input : "Gesture control inactive"}</p>
          </Panel>
          <Panel className={styles.camera} aria-labelledby="robot-title">
            <header><h2 id="robot-title"><Video aria-hidden="true" />Robot camera</h2>
              <StatusBadge tone={workspace?.previewLive ? "success" : "warning"}>{workspace?.previewLive ? "Live sample" : "Not live"}</StatusBadge></header>
            <div ref={robot} className={styles.surface} />
            <p>{matching ? "AI matching active" : "AI matching suspended"} · {snapshot.pending_candidate ? "Candidate awaiting review" : "No candidate awaiting review"}</p>
          </Panel>
        </div>
        <Panel className={styles.input} aria-label={gestures ? "Gesture feedback" : "Controller feedback"}>
          <h2>{gestures ? "Gesture input" : "PS4 controller input"}</h2>
          <div role="status">
            <p>{input}</p>
            <p>Motion permission · {permission}</p>
            {searching && ready && permission !== "Armed" && <p>{permission === "Arming" ? "Ready for a fresh hold." : "Release to neutral before holding a direction."}</p>}
          </div>
        </Panel>
      </div>
      <aside className={styles.rail} aria-label="Search status">
        <section aria-label="Connections">
          <h2>Connections</h2>
          <dl className={styles.connections}>
            {(["Command", "RobotVideo", gestures ? "Webcam" : "Controller", "AI"] as const).map((key) =>
              <div key={key}><dt>{devicePaths[key].label}</dt><dd>{readiness.components.find(({ component }) => component === key)?.status ?? "Unknown"}</dd></div>)}
          </dl>
          <p>Proximity · {snapshot.proximity.state}{snapshot.proximity.warning_latched && " · Warning active"}</p>
        </section>
        <section aria-label="Session activity">
          <h2>Session activity</h2>
          <p>Search accepted · <RecordTime value={session.started_at_ms} compact /></p>
          <p>Committed session · {session.state}</p>
          {effective.persistence_pending && <p>Session save pending</p>}
        </section>
        <section aria-label="Control ownership">
          <h2>Control ownership</h2>
          <p>{owner ? "This workspace holds control." : "Spectator · Read-only"}</p>
          {workspace?.message && <p>{workspace.message}</p>}
          {!owner && <Button disabled={!canAcquire} pending={workspace?.acquiring}
            onClick={() => { void runtime?.acquireWorkspace(); }}>Acquire control</Button>}
          {!owner && canAcquire && <p>Acquiring control consents to taking over the available lease.</p>}
          {snapshot.failures.some(({ restored, acknowledged }) => !restored || !acknowledged) && <p>Recovery required before Resume.</p>}
          {!profile && <p>A compatible qualification profile is unavailable.</p>}
        </section>
      </aside>
    </div>
    <div className={styles.feedback}>
      <ActionFeedback label="Pausing search" feedback={pause} retry={() => { void runtime?.retrySearch("pause", sessionId); }} />
      <ActionFeedback label="Resuming search" feedback={resume} retry={() => { void runtime?.retrySearch("resume", sessionId); }} />
      <ActionFeedback label="Stopping search" feedback={stop} retry={() => { void runtime?.retrySearch("stop", sessionId); }} />
    </div>
    <InputControls mode={mode} disabled={!searching || !ready ||
      !readiness.components.some(({ component, status }) => component === "DisplayedRobotVideo" && status === "Ready")} />
    <footer className={styles.actions}>
      <Link href={objectHref(object.id)} className="button button--secondary">View Object Details</Link>
      <Link href={sessionHref(sessionId)} className="button button--secondary">View Session Details</Link>
    </footer>
  </div>;
}
