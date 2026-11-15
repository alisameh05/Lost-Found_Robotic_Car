"use client";

import { Archive, ArrowRight, ChevronRight, History, Plug, ScanSearch } from "lucide-react";
import Link from "next/link";
import { PageHeader } from "@/components/layout/page-header";
import { Button } from "@/components/ui/button";
import { LoadingState, Notice, StatusBadge } from "@/components/ui/feedback";
import { devicePaths, deviceReadinessView, modeLabels, ReadinessNotice } from "@/features/devices";
import { objectHref, ObjectStatus, RecordTime, RegisterLink, sessionHref, SessionSummary } from "@/features/objects";
import { DashboardFixtureControls, useRuntime, useRuntimeView, type RuntimeView } from "@/features/runtime";
import type { ComponentName } from "@/generated/api-v1";
import { useRecentRecords } from "./recent-records";
import styles from "./dashboard.module.css";

type Readiness = ReturnType<typeof deviceReadinessView>;
type RecentRecords = ReturnType<typeof useRecentRecords>;

export function DashboardScreen() {
  const view = useRuntimeView();
  const state = useRuntime();
  const readiness = deviceReadinessView(view);
  const recent = useRecentRecords();

  function refresh() {
    if (state?.connection) void state.connection.runtime.refresh();
    else if (state) state.select(state.selection.id);
  }

  return <>
    <PageHeader title="Dashboard" description="Your objects, searches and device readiness." actions={<RegisterLink />} />
    <div className={styles.layout}>
      <div className={styles.dashboard}>
        <SearchStatus view={view} readiness={readiness} retry={refresh} />
        <RecentObjects recent={recent} disconnected={view.disconnected} />
        <DeviceReadiness view={view} readiness={readiness} refresh={refresh} />
        <RecentSearches recent={recent} />
      </div>
    </div>
    <DashboardFixtureControls />
  </>;
}

function SearchStatus({ view, readiness: { snapshot, active, mode }, retry }: {
  view: RuntimeView; readiness: Readiness; retry: () => void;
}) {
  const target = snapshot?.active_object?.id === active?.object_id ? snapshot?.active_object : undefined;
  const sessionState = snapshot?.runtime.effective_session_state ?? active?.state;
  return <section className={active ? styles.active : styles.searchStatus} aria-labelledby="dashboard-search-status">
    <div className={styles.sectionHeading}>
      <h2 id="dashboard-search-status"><ScanSearch size={19} aria-hidden="true" />{active ? "Active search" : "Search status"}</h2>
      {active && <span role="status"><StatusBadge tone={sessionState === "Paused" ? "warning" : "info"}>{sessionState}</StatusBadge></span>}
    </div>
    {active ? <>
      <h3>{target?.name ?? "Target unavailable"}</h3>
      <p className={styles.muted}>{modeLabels[mode]} · Target and mode locked</p>
      {snapshot?.runtime.persistence_pending && <p role="status">Save pending · Committed session {active.state}</p>}
      <div className={styles.activeActions}>
        <Link className="button button--primary" href={`${sessionHref(active.id)}/live`}>
          <ArrowRight size={17} aria-hidden="true" /> Return to Search
        </Link>
        <p>{sessionState === "Paused" ? "The search stays active until you end it." : "End this session before starting another."}</p>
      </div>
    </> : view.loading ? <LoadingState label="Loading search status" />
      : snapshot ? <p role="status">No active search</p>
      : <>
        <Notice title="Search status unavailable" tone="warning" role="status">
          {view.health?.active_session_state ? `Health reports ${view.health.active_session_state}. The current target and workspace could not be retrieved.`
            : "The current session could not be retrieved."}
        </Notice>
        {!view.disconnected && <Button onClick={retry}>Retry snapshot</Button>}
      </>}
  </section>;
}

const featuredPaths: readonly ComponentName[] = ["Command", "RobotVideo", "Webcam", "Controller", "AI"];

function DeviceReadiness({ view, readiness, refresh }: {
  view: RuntimeView; readiness: Readiness; refresh: () => void;
}) {
  const { snapshot, active, activeModeUnavailable, mode, summary } = readiness;
  const observations = readiness.readiness?.components;
  const unavailable = activeModeUnavailable
    ? observations?.filter(({ status }) => status === "Unavailable").map(({ component }) => component) ?? []
    : summary.unavailable;
  const extraUnavailable = unavailable.filter((component) => !featuredPaths.includes(component));

  return <section className={styles.devices} aria-labelledby="dashboard-readiness">
    <h2 id="dashboard-readiness">Device readiness</h2>
    {observations && <p className={styles.muted}>{activeModeUnavailable ? "Active control mode unavailable"
      : `${modeLabels[mode]} · ${active ? "Active search mode" : "Readiness preview"}`}</p>}
    <div role="status">
      <ReadinessNotice loading={view.loading} disconnected={view.disconnected} health={view.health}
        snapshotFailed={!!view.failedRead} summary={summary} mode={mode} compact />
    </div>
    {observations && <ul className={styles.deviceList} aria-label="Device observations">
      {[...featuredPaths, ...extraUnavailable].map((component) => {
        const observation = observations.find((item) => item.component === component);
        const { label, icon: Icon } = devicePaths[component];
        const inactive = summary.inactive?.component === component;
        const status = inactive ? "Inactive" : observation?.status ?? "Unknown";
        const name = <><Icon size={17} aria-hidden="true" />{label}</>;
        return <li key={component}>
          {observation?.status === "Unavailable" ? <Link href="/devices">{name}</Link> : <span>{name}</span>}
          <span data-observation={status}>{status}</span>
        </li>;
      })}
      <li>
        <span>Proximity sensor</span>
        <span data-observation={snapshot?.proximity.state}>{snapshot?.proximity.state ?? "Unavailable"} · Advisory</span>
      </li>
    </ul>}
    <div className={styles.deviceActions}>
      <Link className="button button--secondary" href="/devices"><Plug size={17} aria-hidden="true" /> View Devices</Link>
      {!view.disconnected && (view.failedRead || !view.health) && <Button onClick={refresh} pending={view.loading}>Retry readiness</Button>}
    </div>
  </section>;
}

function RecentObjects({ recent: { objectPage, objects, retry }, disconnected }: {
  recent: RecentRecords; disconnected?: boolean;
}) {
  return <section className={styles.objects} aria-labelledby="dashboard-objects">
    <div className={styles.sectionHeading}>
      <h2 id="dashboard-objects">Recent objects</h2>
      <Link href="/objects">View Objects <ArrowRight size={16} aria-hidden="true" /></Link>
    </div>
    {!objectPage ? <LoadingState label="Loading recent objects" />
      : objectPage.kind !== "ok" ? <div className="feedback-stack">
        <Notice title="Recent objects unavailable" tone="warning" role="status">Saved registrations could not be retrieved.</Notice>
        {!disconnected && <Button onClick={retry}>Retry recent objects</Button>}
      </div> : objectPage.data.items.length === 0 ? <div className="feedback-stack">
        <Notice title="Register your first object" role="status">Recent registrations will appear here.</Notice>
        <div><RegisterLink /></div>
      </div> : objects.length === 0 ? <div className="feedback-stack">
        <Notice title="Recent records are no longer available" role="status" tone="warning" />
        <Button onClick={retry}>Refresh recent objects</Button>
      </div> : <>
        <p className={styles.muted}>Counts for the registrations shown</p>
        <dl className={styles.counts}>
          <div><dt>Registered</dt><dd>{objects.length}</dd></div>
          <div><dt>Lost</dt><dd>{objects.filter(({ status }) => status === "Lost").length}</dd></div>
          <div><dt>Found</dt><dd>{objects.filter(({ status }) => status === "Found").length}</dd></div>
        </dl>
        <ul className={styles.rows} aria-label="Recent registrations">
          {objects.map((object) => <li key={object.id}>
            <Link href={objectHref(object.id)} className={styles.objectRow}>
              <span className={styles.recordIcon}><Archive size={20} aria-hidden="true" /></span>
              <span><strong>{object.name}</strong><span className={styles.muted}><RecordTime value={object.registered_at_ms} compact /></span></span>
              <ObjectStatus status={object.status} />
              <ChevronRight size={17} aria-hidden="true" />
            </Link>
          </li>)}
        </ul>
      </>}
  </section>;
}

function RecentSearches({ recent: { objectPage, sessions, incomplete, retry } }: { recent: RecentRecords }) {
  return <section className={styles.searches} aria-labelledby="dashboard-sessions">
    <h2 id="dashboard-sessions">Recent searches</h2>
    <p className={styles.muted}>Sessions for recent objects · Up to 3, newest starts first</p>
    {!objectPage ? <LoadingState label="Loading recent searches" />
      : objectPage.kind !== "ok" ? <Notice title="Recent searches unavailable" tone="warning" role="status">
        Retry recent objects to retrieve their searches.
      </Notice> : incomplete ? <div className="feedback-stack">
        <Notice title="Recent searches incomplete" tone="warning" role="status">Some sessions for recent objects could not be retrieved.</Notice>
        <Button onClick={retry}>Retry recent searches</Button>
      </div> : objectPage.data.items.length === 0 || sessions?.length === 0 ? <Notice title="No sessions for recent objects" role="status" />
      : !sessions ? <LoadingState label="Loading recent searches" />
      : null}
    {!!sessions?.length && <ul className={styles.rows} aria-label="Recent session records">
      {sessions.map(({ session, owner }) => <li key={session.id}>
        <Link href={sessionHref(session.id)} className={styles.sessionRow}>
          <History size={19} aria-hidden="true" />
          <div><strong>{owner.name}</strong><SessionSummary session={session} compact /></div>
        </Link>
      </li>)}
    </ul>}
  </section>;
}
