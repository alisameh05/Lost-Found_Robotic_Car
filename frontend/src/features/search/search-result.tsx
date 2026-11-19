"use client";

import Link from "next/link";
import { useMemo } from "react";
import { PageHeader } from "@/components/layout/page-header";
import { Panel } from "@/components/layout/panel";
import { LoadingState, Notice, StatusBadge } from "@/components/ui/feedback";
import { CapturedEvidence, HistoryPager, objectHref, RecordAbsent, RecordReadFailure, RecordTime, ReferenceImage, sessionHref, useConfirmedMatch } from "@/features/objects";
import { recordAbsence, useCursorPage, useObjectRecord, useProtectedRead, useRuntime, useRuntimeView } from "@/features/runtime";
import { searchSetupBlockReason, searchSetupHref } from "@/lib/search-setup-context";
import { duration, searchMode } from "./session-facts";
import styles from "./session.module.css";

export function SearchResultScreen({ sessionId }: { sessionId: string }) {
  if (useRuntimeView().removedSessionId === sessionId) return <div className={styles.page}>
    <PageHeader title="Search Result" />
    <Notice role="status" tone="warning" title="Record removed after expiry">
      The search ended and the expired record is no longer available.
    </Notice>
    <footer className={styles.actions}>
      <Link href="/" className="button button--secondary">Return to Dashboard</Link>
    </footer>
  </div>;
  return <SavedSearchResult sessionId={sessionId} />;
}

function SavedSearchResult({ sessionId }: { sessionId: string }) {
  const view = useRuntimeView();
  const runtime = useRuntime()?.connection?.runtime;
  const scope = useMemo(() => ({ id: sessionId }), [sessionId]);
  const { result, retry } = useProtectedRead("GET /sessions/{id}", scope);
  const session = result?.kind === "ok" && result.data.id === sessionId ? result.data : undefined;
  const ended = session?.state === "Ended" ? session : undefined;
  const owner = useObjectRecord(ended?.object_id);
  const object = owner.object;
  const confirmed = ended?.end_reason === "Confirmed";
  const absence = recordAbsence(result) ?? owner.absence;
  const matches = useCursorPage("GET /sessions/{id}/matches", scope, Boolean(ended && object && !confirmed));
  const confirmation = useConfirmedMatch(sessionId, confirmed ? object?.id : undefined);
  const confirmedMatch = confirmation.result?.kind === "ok" ? confirmation.result.data : undefined;
  const items = matches.result?.kind === "ok" ? matches.result.data.items.filter((match) =>
    match.session_id === ended?.id && match.object_id === ended?.object_id) : undefined;
  const matchAbsence = recordAbsence(matches.result);
  const active = view.snapshot?.active_session?.id === sessionId || session && session.state !== "Ended";
  const reason = ended?.end_reason;
  const canSearch = object && !confirmed && !searchSetupBlockReason(object, view) &&
    (runtime?.serverTime() ?? Infinity) < object.expires_at_ms;

  return <div className={styles.page}>
    <PageHeader title="Search Result" description={view.recordsMode && view.profile ? "Saved outcome · Backend simulation" : "Saved outcome for this session."}
      actions={ended && object && !absence && !matchAbsence && <StatusBadge>Ended</StatusBadge>} />
    {absence || matchAbsence ? <RecordAbsent status={(absence ?? matchAbsence)!} title="Session" />
      : active ? <Notice title="Search still active"><Link href={`${sessionHref(sessionId)}/live`}>Return to Active Search</Link></Notice>
      : !result || (ended && !owner.result) ? <LoadingState label="Loading search result" />
      : !ended ? <RecordReadFailure title="Search result unavailable" retry={retry} />
      : !object ? <RecordReadFailure title="Related object unavailable" retry={owner.retry} />
      : <>
        <Panel className={confirmed ? `${styles.target} ${styles.found}` : styles.target}>
          <div><p>{object.name}</p><h2>{confirmed ? "Match confirmed and saved" : "Search ended without confirmation"}</h2></div>
          {confirmed && <StatusBadge tone="success">Found</StatusBadge>}
        </Panel>
        <div className={styles.result}>
          <Panel className={styles.summary} aria-label="Reference target">
            <h2>Reference target</h2>
            <ReferenceImage object={object} target="selected" />
          </Panel>
          {confirmed && <Panel className={styles.summary} aria-label="Confirmed evidence">
            <h2>Confirmed evidence</h2>
            {!confirmation.result ? <LoadingState label="Loading confirmed evidence" />
              : confirmedMatch ? <CapturedEvidence key={confirmedMatch.id} match={confirmedMatch} zoom />
              : confirmation.result.kind !== "ok"
                ? <RecordReadFailure title="Confirmed evidence unavailable" retry={confirmation.retry} />
                : <Notice tone="warning" title="Confirmed evidence missing" />}
          </Panel>}
        </div>
        <Panel className={styles.summary} aria-label="Session summary">
          <h2>Session summary</h2>
          <dl className={styles.facts}>
            <div><dt>Control mode</dt><dd>{searchMode(ended.control_mode)}</dd></div>
            <div><dt>Started</dt><dd><RecordTime value={ended.started_at_ms} /></dd></div>
            <div><dt>Ended</dt><dd><RecordTime value={ended.ended_at_ms} /></dd></div>
            <div><dt>Duration</dt><dd>{duration(ended.ended_at_ms - ended.started_at_ms)}</dd></div>
            <div><dt>End reason</dt><dd>{reason === "Stopped" ? "Stopped by operator" : confirmed ? "Match confirmed" : "Interrupted"}</dd></div>
            {confirmed && <div><dt>Confirmed</dt><dd><RecordTime value={confirmedMatch?.reviewed_at_ms ?? ended.ended_at_ms} /></dd></div>}
          </dl>
        </Panel>
        {!confirmed && <div className={styles.feedback}>
          <Notice title="No match was confirmed">
            {object.status === "Lost" ? "The object remains Lost." : "This session ended before the object's later confirmation."}
          </Notice>
          {!matches.result ? <LoadingState label="Loading saved matches" />
            : !items ? <RecordReadFailure title="Saved matches unavailable" retry={matches.retry} />
            : items.filter((match) => match.disposition === "Rejected" || match.disposition === "NotReviewed")
                .map((match) => <CapturedEvidence key={match.id} match={match} />)}
          <HistoryPager paging={matches} label="Saved match pages" ready={items !== undefined} />
        </div>}
      </>}
    <footer className={styles.actions}>
      <Link href="/" className="button button--secondary">Return to Dashboard</Link>
      {ended && object && !absence && !matchAbsence && <>
        <Link href={sessionHref(ended.id)} className="button button--secondary">View Session Details</Link>
        {confirmed && <Link href={objectHref(object.id)} className="button button--primary">View Object Details</Link>}
        {canSearch && <Link href={searchSetupHref({ objectId: object.id, mode: ended.control_mode })}
          className="button button--primary">Search Again</Link>}
      </>}
    </footer>
  </div>;
}
