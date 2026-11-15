"use client";

import Link from "next/link";
import { useMemo } from "react";
import { PageHeader } from "@/components/layout/page-header";
import { DataUnavailable } from "@/components/layout/preview";
import { LoadingState, Notice, StatusBadge } from "@/components/ui/feedback";
import { useCursorPage, useProtectedRead, useRuntimeView } from "@/features/runtime";
import type { Match, Session } from "@/generated/api-v1";
import { CapturedEvidence, dispositionLabel } from "./captured-evidence";
import { objectHref, RecordAbsent, recordAbsence, RecordReadFailure, RecordTime, ReferenceImage, useObjectRecord } from "./record-ui";
import { HistoryPager, modeLabel, sessionHref } from "./session-history";
import styles from "./records.module.css";

const sessionOutcomes = { Confirmed: "Confirmed and ended", Stopped: "Search stopped", Interrupted: "Search interrupted" };

export function SessionDetailsScreen({ sessionId }: { sessionId: string }) {
  const scope = useMemo(() => ({ id: sessionId }), [sessionId]);
  const { result, retry } = useProtectedRead("GET /sessions/{id}", scope);
  const { disconnected, snapshot } = useRuntimeView();
  const session = result?.kind === "ok" && result.data.id === sessionId ? result.data : undefined;
  const owner = useObjectRecord(session?.object_id);
  const matchScope = useMemo(() => ({ id: sessionId, query: { limit: 5 } }), [sessionId]);
  const paging = useCursorPage("GET /sessions/{id}/matches", matchScope, Boolean(owner.object));
  const missing = recordAbsence(result) ?? owner.absence ?? recordAbsence(paging.result);
  const matches = session && paging.result?.kind === "ok" ? paging.result.data.items.filter((match) =>
    match.session_id === session.id && match.object_id === session.object_id) : undefined;
  const active = session?.state !== "Ended" && snapshot?.active_session?.id === sessionId;
  const object = missing ? undefined : owner.object;

  if (disconnected) return <DataUnavailable />;
  return <div className={styles.recordLayout}>
    <PageHeader title="Session Details" description={object?.name} actions={session && object &&
      <StatusBadge tone={session.state === "Paused" ? "warning" : "muted"}>{session.state}</StatusBadge>} />
    {missing ? <RecordAbsent status={missing} title="Session" />
      : !result || (session && !owner.result) ? <LoadingState label="Loading session details" />
      : !session ? <RecordReadFailure title="Session details unavailable" retry={retry} />
      : !object ? <RecordReadFailure title="Related object unavailable" retry={owner.retry} />
      : <>
        <div className={styles.details}>
          <div className={styles.historyColumn}>
            <section className={styles.captureSection} aria-label="Captured matches">
              <h2>Captured matches</h2>
              {!paging.result ? <LoadingState label="Loading captured matches" />
                : !matches ? <RecordReadFailure title="Captured matches unavailable" retry={paging.retry} />
                : matches.length === 0 ? <Notice role="status" title={paging.hasPrevious ? "No matches on this page" : "No captured matches"}>
                  {paging.hasPrevious ? "Use Previous to return to the preceding page." : "This session has no saved captures."}
                </Notice> : <div className={styles.captureGrid} key={paging.page}>
                  {session.end_reason === "Confirmed" && matches.some(({ disposition }) => disposition === "Confirmed") &&
                    <div className={styles.referenceTarget}><ReferenceImage object={object} target="selected" /></div>}
                  {matches.map((match) => <CapturedEvidence key={match.id} match={match} />)}
                </div>}
              <HistoryPager paging={paging} label="Match pages" ready={matches !== undefined} />
            </section>
            <section className={styles.sessionMetadata} aria-label="Session record">
              <h2>Session record</h2>
              <dl className={styles.captureTimes}>
                <div><dt>Control mode</dt><dd>{modeLabel(session.control_mode)}</dd></div>
                <div><dt>Started</dt><dd><RecordTime value={session.started_at_ms} /></dd></div>
                {session.state === "Ended" && <>
                  <div><dt>Ended</dt><dd><RecordTime value={session.ended_at_ms} /></dd></div>
                  <div><dt>End reason</dt><dd>{session.end_reason === "Confirmed" ? "Match confirmed" : session.end_reason}</dd></div>
                </>}
              </dl>
              {object.retention_grace && <Notice role="status" tone="warning" title="Active-session grace">
                This record remains available while its active search continues.
              </Notice>}
            </section>
          </div>
          <SessionActivity session={session} matches={matches ?? []} paginated={paging.hasNext || paging.hasPrevious} />
        </div>
        <footer className={styles.detailActions}>
          {active && <Link className="button button--secondary" href={`${sessionHref(sessionId)}/live`}>Return to Active Search</Link>}
          <Link className="button button--primary" href={objectHref(object.id)}>View Object</Link>
        </footer>
      </>}
  </div>;
}

function SessionActivity({ session, matches, paginated }: { session: Session; matches: Match[]; paginated: boolean }) {
  const events = [
    { key: "start", time: session.started_at_ms, label: "Search started" },
    ...matches.flatMap((match) => [
      { key: `${match.id}:capture`, time: match.captured_at_ms, label: "Match captured" },
      ...(match.reviewed_at_ms === null || (match.disposition === "Confirmed" &&
        session.end_reason === "Confirmed" && match.reviewed_at_ms === session.ended_at_ms)
        ? [] : [{ key: `${match.id}:review`, time: match.reviewed_at_ms, label: dispositionLabel(match.disposition) }]),
    ]),
    ...(session.state === "Ended" ? [{ key: "end", time: session.ended_at_ms, label: sessionOutcomes[session.end_reason] }] : []),
  ].sort((left, right) => left.time - right.time);
  return <section className={styles.activity} aria-label="Activity timeline">
    <h2>Activity timeline</h2>
    {paginated && <p className={styles.muted}>Capture and review activity for the current match page.</p>}
    <ol>
      {events.map((event) => <li key={event.key}>
        <strong>{event.label}</strong>
        <RecordTime value={event.time} />
      </li>)}
    </ol>
  </section>;
}
