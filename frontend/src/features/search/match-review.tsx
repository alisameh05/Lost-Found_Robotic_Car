"use client";

import { useState } from "react";
import { ModelessPanel } from "@/components/layout/panel";
import { Button } from "@/components/ui/button";
import { StatusBadge } from "@/components/ui/feedback";
import { CapturedEvidence, ReferenceImage } from "@/features/objects";
import { searchActionKey, unresolved, useRuntime, useRuntimeView } from "@/features/runtime";
import type { Match, Object as ObjectRecord } from "@/generated/api-v1";
import { ActionFeedback } from "./action-feedback";
import styles from "./session.module.css";

export function MatchReview({ match, object, canAct, canStop, stop }: {
  match: Match; object: ObjectRecord; canAct: boolean; canStop: boolean; stop(): void;
}) {
  const runtime = useRuntime()?.connection?.runtime;
  const { recordsMode, searchActions, snapshot } = useRuntimeView();
  const [displayed, setDisplayed] = useState<boolean>();
  const sessionId = match.session_id;
  const confirm = searchActions?.[searchActionKey("confirm", sessionId)];
  const reject = searchActions?.[searchActionKey("reject", sessionId)];
  const blocked = !canAct || unresolved(confirm) || unresolved(reject) ||
    snapshot?.readiness.components.some(({ component, status }) => component === "Storage" && status !== "Ready");
  const canConfirm = !blocked && displayed === true && match.evidence_media.availability === "Available";

  function decide(kind: "confirm" | "reject") {
    void runtime?.submitSearch({ kind, sessionId, candidateId: match.id });
  }

  return <ModelessPanel id="match-review" title="Review potential match">
    <StatusBadge tone="warning">Paused</StatusBadge>
    <div className={styles.comparison}>
      <ReferenceImage object={object} target="selected" />
      <CapturedEvidence match={match} onDisplay={setDisplayed} />
    </div>
    <div className={styles.actions}>
      {!recordsMode && <Button disabled={blocked} onClick={() => decide("reject")}>Reject Match</Button>}
      <Button variant="primary" disabled={!canConfirm} onClick={() => decide("confirm")}>Confirm Match</Button>
      <Button variant="destructive" disabled={!canStop} onClick={stop}>Stop Search</Button>
    </div>
    <ActionFeedback label="Confirming match" feedback={confirm?.candidateId === match.id ? confirm : undefined}
      canRetryFailed={canConfirm} retry={() => { void runtime?.retrySearch("confirm", sessionId); }} />
    <ActionFeedback label="Rejecting match" feedback={reject?.candidateId === match.id ? reject : undefined}
      canRetryFailed={!blocked} retry={() => { void runtime?.retrySearch("reject", sessionId); }} />
  </ModelessPanel>;
}
