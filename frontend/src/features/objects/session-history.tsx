"use client";

import Link from "next/link";
import { useMemo } from "react";
import { Button } from "@/components/ui/button";
import { LoadingState, Notice, StatusBadge } from "@/components/ui/feedback";
import { useCursorPage } from "@/features/runtime";
import type { ControlMode, Session } from "@/generated/api-v1";
import { RecordReadFailure, RecordTime } from "./record-ui";
import styles from "./records.module.css";

export const sessionHref = (id: string) => `/sessions/${encodeURIComponent(id)}`;
export const modeLabel = (mode: ControlMode) => mode === "Gestures" ? "Gestures" : "PS4";
export const historyPageSize = 5;

export function useObjectSessions(objectId: string, limit?: number, enabled = true) {
  const scope = useMemo(() => ({ id: objectId, query: { limit } }), [objectId, limit]);
  return useCursorPage("GET /objects/{id}/sessions", scope, enabled);
}

export function SessionSummary({ session, compact = false }: { session: Session; compact?: boolean }) {
  const outcome = session.end_reason === "Confirmed" ? "Found" : session.end_reason;
  if (compact) return <div className={styles.compactSession}>
    <span>{modeLabel(session.control_mode)} · <RecordTime value={session.started_at_ms} compact /></span>
    <span data-found={outcome === "Found" || undefined}>{session.state}{outcome && ` · ${outcome}`}</span>
  </div>;

  return <div className={styles.sessionSummary}>
    <div className={styles.sessionTimes}>
      <div>Started <RecordTime value={session.started_at_ms} /></div>
      {session.ended_at_ms !== null && <div className={styles.muted}>Ended <RecordTime value={session.ended_at_ms} /></div>}
    </div>
    <div className={styles.sessionFacts}>
      <span>{modeLabel(session.control_mode)}</span>
      <StatusBadge tone={session.state === "Paused" ? "warning" : "muted"}>{session.state}</StatusBadge>
      {outcome && <span>{outcome}</span>}
    </div>
  </div>;
}

type Pager = Pick<ReturnType<typeof useObjectSessions>, "page" | "hasPrevious" | "hasNext" | "previous" | "next">;

export function HistoryPager({ paging, label, ready }: { paging: Pager; label: string; ready: boolean }) {
  if (!paging.hasPrevious && !paging.hasNext && ready) return null;
  return <nav className={styles.paging} aria-label={label}>
    <p role="status">{ready ? `Page ${paging.page} · Newest first` : ""}</p>
    <div className="control-row">
      <Button aria-disabled={!paging.hasPrevious || !ready} onClick={paging.previous}>Previous</Button>
      <Button aria-disabled={!paging.hasNext || !ready} onClick={paging.next}>Next</Button>
    </div>
  </nav>;
}

export function ObjectSessionHistory({ objectId, paging }: { objectId: string; paging: ReturnType<typeof useObjectSessions> }) {
  const { result, retry } = paging;
  const sessions = result?.kind === "ok" ? result.data.items.filter(({ object_id }) => object_id === objectId) : undefined;
  return <section className={styles.history} aria-label="Search sessions">
    <h2>Search sessions</h2>
    {!result ? <LoadingState label="Loading search sessions" />
      : !sessions ? <RecordReadFailure title="Search sessions unavailable" retry={retry} />
      : sessions.length === 0 ? <Notice role="status" title={paging.hasPrevious ? "No sessions on this page" : "No search sessions"}>
        {paging.hasPrevious ? "Use Previous to return to the preceding page." : "Search attempts will appear here."}
      </Notice> : <ul className={styles.historyRows} aria-label="Session records">
        {sessions.map((session) => <li key={session.id}>
          <SessionSummary session={session} />
          <Link className="button button--secondary" href={sessionHref(session.id)}
            aria-label={`View session started ${new Date(session.started_at_ms).toLocaleString(undefined, { timeZone: "UTC" })} UTC`}>
            View Session
          </Link>
        </li>)}
      </ul>}
    <HistoryPager paging={paging} label="Session pages" ready={sessions !== undefined} />
  </section>;
}
