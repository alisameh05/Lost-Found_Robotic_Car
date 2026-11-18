"use client";

import { ArrowRight } from "lucide-react";
import { useEffect, useId, useRef } from "react";
import { PageHeader } from "@/components/layout/page-header";
import { Panel } from "@/components/layout/panel";
import support from "@/components/layout/support-page.module.css";
import { Button } from "@/components/ui/button";
import { Field } from "@/components/ui/field";
import { LoadingState, Notice } from "@/components/ui/feedback";
import { DeletionNotice, useRefreshRuntime, useRuntime, useRuntimeView } from "@/features/runtime";
import type { DeletionProgress, RetentionPreview } from "@/generated/api-v1";
import { useRetention } from "./use-retention";
import styles from "./settings.module.css";

const count = (value: number, noun: string, plural = `${noun}s`) => `${value.toLocaleString()} ${value === 1 ? noun : plural}`;

export function RetentionSettingsScreen() {
  const generation = useRuntime()?.selection.generation;
  return <SettingsEditor key={generation} />;
}

function SettingsEditor() {
  const state = useRetention();
  const { recordSnapshot } = useRuntimeView();
  const refresh = useRefreshRuntime();
  const { read, blocked, active, ready, reviewing, busy, held } = state;
  const saved = state.saved ?? recordSnapshot?.retention.settings;
  const confirmationTitle = useId();
  const confirmationDescription = useId();
  const review = useRef<HTMLButtonElement>(null);
  const preview = useRef<HTMLButtonElement>(null);
  const cancelConfirmation = useRef<HTMLButtonElement>(null);
  const feedback = useRef<HTMLDivElement>(null);
  const previousReview = useRef(false);
  useEffect(() => {
    if (reviewing) cancelConfirmation.current?.focus();
    else if (previousReview.current) {
      const target = !ready || blocked ? preview.current : review.current;
      if (target && !target.disabled && !held) target.focus();
      else feedback.current?.focus();
    }
    previousReview.current = reviewing;
  }, [blocked, held, ready, reviewing]);

  return <div className={support.page}>
    <PageHeader title="Settings" description="Manage how long registered objects and their evidence are kept." />
    {!saved ? read.result && read.result.kind !== "ok" ? <div className={styles.feedback}>
      <Notice role="alert" title="Settings unavailable" tone="danger">The saved retention period could not be read.</Notice>
      <Button onClick={read.retry}>Retry settings</Button>
    </div> : <LoadingState label="Loading saved retention" /> : <>
      <div className={`${support.columns} ${styles.columns}`}>
        <div className={styles.editor}>
          <section aria-label="Saved retention" className={styles.policy}>
            <h2>Current saved retention</h2>
            <p className={styles.saved}>{count(saved.retention_days, "day")}</p>
            <p>Each object expires at its original registration time plus retention days × 86,400,000 ms.
              That registration time stays the same after searches and policy changes.</p>
            <p>Expiry removes the object, related sessions and matches, and managed references and screenshots.
              The original file you selected stays where you saved it.</p>
          </section>
          <form noValidate className={styles.proposal} onSubmit={(event) => { event.preventDefault(); void state.previewChange(); }}>
            <Field label="Proposed retention in days" inputMode="numeric" value={state.value}
              description="1–30 whole days. Initial setting is 7 days."
              error={state.valid ? undefined : "Enter a whole number from 1 to 30."}
              disabled={blocked || !!held} onChange={(event) => state.setValue(event.target.value)} />
            <Button ref={preview} type="submit" disabled={blocked || !state.valid || !!held} pending={busy === "preview"}>Preview Change</Button>
          </form>
          {active ? <Notice role="status" tone="warning" title={`Search ${active === "Searching" ? "is Searching" : "is Paused"}`}>
            End the active search before previewing or applying a retention change.
          </Notice> : !blocked && <Notice title="No active session">
            Searching and Paused sessions both lock retention changes.
          </Notice>}
          {state.storageBlocked && <Notice role="status" tone="danger" title="Storage unavailable">
            Retention changes are blocked while storage integrity is unavailable.
          </Notice>}
          {blocked && !active && !state.storageBlocked && <Notice role="status" tone="warning" title="Search or storage status unavailable">
            <Button onClick={() => { read.retry(); refresh(); }}>Retry settings and status</Button>
          </Notice>}
          <div ref={feedback} tabIndex={-1} className={styles.feedback}>
            {busy === "apply" && <Notice role="status" title="Saving retention" />}
            {state.notice && <Notice role="status" title={state.notice.title} tone={state.notice.tone}>{state.notice.detail}</Notice>}
            {held && <Button onClick={state.retrySave} pending={busy === "apply"}>Retry Same Request</Button>}
          </div>
        </div>
        <div className={styles.side}>
          {reviewing && ready ? <Panel role="dialog" aria-labelledby={confirmationTitle} aria-describedby={confirmationDescription}
            className={`${styles.impact} ${styles.confirmation}`} onKeyDown={(event) => {
              if (event.key === "Escape") state.closeReview();
            }}>
            <h2 id={confirmationTitle}>Apply retention change?</h2>
            <p id={confirmationDescription}>Review the immediate removals below. Expired records and images cannot be recovered.</p>
            <Impact savedDays={saved.retention_days} preview={ready} />
            <div className="control-row">
              <Button ref={cancelConfirmation} onClick={state.cancel}>Cancel Change</Button>
              <Button variant="primary" disabled={blocked} onClick={state.confirm}>Confirm and Apply</Button>
            </div>
          </Panel> : <Panel aria-label="Immediate impact" className={styles.impact}>
            <h2>{ready ? "Preview ready" : "Immediate impact"}</h2>
            {busy === "preview" ? <LoadingState label="Checking immediate impact" />
              : ready ? <><p className={styles.announcement} role="status">Preview ready for {count(ready.retention_days, "day")}.</p>
                <Impact savedDays={saved.retention_days} preview={ready} /></>
              : <p>Preview a proposed period to see which managed records and images would expire immediately.</p>}
          </Panel>}
          <Deletion status={state.deletion} />
        </div>
      </div>
      {!reviewing && !held && <footer className={support.footer}>
        <Button disabled={state.value === String(saved.retention_days) && !ready && !state.notice && !busy} onClick={state.cancel}>Cancel Change</Button>
        <Button ref={review} variant="primary" disabled={!ready || blocked || !!busy} onClick={state.review}>
          <ArrowRight aria-hidden="true" size={18} /> Review Change
        </Button>
      </footer>}
    </>}
  </div>;
}

function Impact({ savedDays, preview }: { savedDays: number; preview: RetentionPreview }) {
  const { objects, sessions, matches, managed_image_bytes } = preview.impact;
  return <>
    <dl className={styles.periods}>
      <div><dt>Saved period</dt><dd>{count(savedDays, "day")}</dd></div>
      <div><dt>Proposed period</dt><dd>{count(preview.retention_days, "day")}</dd></div>
    </dl>
    <ul className={styles.counts}>
      <li>{count(objects, "object")}</li><li>{count(sessions, "session")}</li><li>{count(matches, "match", "matches")}</li>
      <li>{count(managed_image_bytes, "byte")} of managed images</li>
    </ul>
  </>;
}

function Deletion({ status }: { status?: DeletionProgress }) {
  return <Panel aria-label="Deletion progress" className={styles.impact}>
    <h2>Deletion progress</h2>
    <div role="status">
      {status ? <DeletionNotice status={status} /> : <p>Deletion status unavailable.</p>}
    </div>
  </Panel>;
}
