"use client";

import Link from "next/link";
import { useMemo } from "react";
import { PageHeader } from "@/components/layout/page-header";
import { Panel } from "@/components/layout/panel";
import { LoadingState, Notice, StatusBadge } from "@/components/ui/feedback";
import { CapturedEvidence, HistoryPager, RecordAbsent, RecordReadFailure, RecordTime, ReferenceImage, sessionHref } from "@/features/objects";
import { recordAbsence, useCursorPage, useObjectRecord, useProtectedRead, useRuntime, useRuntimeView } from "@/features/runtime";
import { searchSetupBlockReason, searchSetupHref } from "@/lib/search-setup-context";
import { duration, searchMode } from "./session-facts";
import styles from "./session.module.css";

export function SearchResultScreen({ sessionId }: { sessionId: string }) {
  const view = useRuntimeView();
  const runtime = useRuntime()?.connection?.runtime;
  const scope = useMemo(() => ({ id: sessionId }), [sessionId]);
  const { result, retry } = useProtectedRead("GET /sessions/{id}", scope);
  const session = result?.kind === "ok" && result.data.id === sessionId ? result.data : undefined;
  const ended = session?.state === "Ended" ? session : undefined;
  const owner = useObjectRecord(ended?.object_id);
  const object = owner.object;
  const absence = recordAbsence(result) ?? owner.absence;
  const matches = useCursorPage("GET /sessions/{id}/matches", scope, Boolean(ended && object));
  const items = matches.result?.kind === "ok" ? matches.result.data.items.filter((match) =>
    match.session_id === ended?.id && match.object_id === ended?.object_id) : undefined;
  const matchAbsence = recordAbsence(matches.result);
  const active = view.snapshot?.active_session?.id === sessionId || session && session.state !== "Ended";
  const reason = ended?.end_reason;
  const confirmed = reason === "Confirmed";
  const canSearch = object && !confirmed && !searchSetupBlockReason(object, view) &&
    (runtime?.serverTime() ?? Infinity) < object.expires_at_ms;

  return <div className={styles.page}>
    <PageHeader title="Search Result" description="Saved outcome for this session."
      actions={ended && object && !absence && !matchAbsence && <StatusBadge>Ended</StatusBadge>} />
    {absence || matchAbsence ? <RecordAbsent status={(absence ?? matchAbsence)!} title="Session" />
      : active ? <Notice title="Search still active"><Link href={`${sessionHref(sessionId)}/live`}>Return to Active Search</Link></Notice>
      : !result || (ended && !owner.result) ? <LoadingState label="Loading search result" />
      : !ended ? <RecordReadFailure title="Search result unavailable" retry={retry} />
      : !object ? <RecordReadFailure title="Related object unavailable" retry={owner.retry} />
      : <>
        <Panel className={styles.target}>
          <div><p>{object.name}</p><h2>{confirmed ? "Match confirmed and saved" : "Search ended without confirmation"}</h2></div>
        </Panel>
        <div className={styles.result}>
          <Panel className={styles.summary} aria-label="Session summary">
            <h2>Session summary</h2>
            <dl>
              <dt>Control mode</dt><dd>{searchMode(ended.control_mode)}</dd>
              <dt>Started</dt><dd><RecordTime value={ended.started_at_ms} /></dd>
              <dt>Ended</dt><dd><RecordTime value={ended.ended_at_ms} /></dd>
              <dt>Duration</dt><dd>{duration(ended.ended_at_ms - ended.started_at_ms)}</dd>
              <dt>End reason</dt><dd>{reason === "Stopped" ? "Stopped by operator" : confirmed ? "Match confirmed" : "Interrupted"}</dd>
            </dl>
          </Panel>
          <Panel className={styles.summary} aria-label="Reference target">
            <h2>Reference target</h2>
            <ReferenceImage object={object} target="selected" />
          </Panel>
        </div>
        <div className={styles.feedback}>
          {!confirmed && <Notice title="No match was confirmed">
            {object.status === "Lost" ? "The object remains Lost." : "This session ended before the object's later confirmation."}
          </Notice>}
          {!matches.result ? <LoadingState label="Loading saved matches" />
            : !items ? <RecordReadFailure title="Saved matches unavailable" retry={matches.retry} />
            : items.filter((match) => confirmed ? match.disposition === "Confirmed" && match.reviewed_at_ms === ended.ended_at_ms
                : match.disposition === "Rejected" || match.disposition === "NotReviewed")
                .map((match) => <CapturedEvidence key={match.id} match={match} />)}
          <HistoryPager paging={matches} label="Saved match pages" ready={items !== undefined} />
        </div>
      </>}
    <footer className={styles.actions}>
      <Link href="/" className="button button--secondary">Return to Dashboard</Link>
      {ended && object && !absence && !matchAbsence && <>
        <Link href={sessionHref(ended.id)} className="button button--secondary">View Session Details</Link>
        {canSearch && <Link href={searchSetupHref({ objectId: object.id, mode: ended.control_mode })}
          className="button button--primary">Search Again</Link>}
      </>}
    </footer>
  </div>;
}
