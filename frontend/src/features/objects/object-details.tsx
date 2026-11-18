"use client";

import Link from "next/link";
import { PageHeader } from "@/components/layout/page-header";
import { DataUnavailable } from "@/components/layout/preview";
import { LoadingState, Notice } from "@/components/ui/feedback";
import { DeletionNotice, recordAbsence, useObjectRecord, useRuntimeView } from "@/features/runtime";
import type { Object as ObjectRecord } from "@/generated/api-v1";
import { ConfirmedEvidence } from "./confirmed-evidence";
import { ObjectStatus, RecordAbsent, RecordReadFailure, RecordTime, ReferenceImage, RegisterLink, StartSearch } from "./record-ui";
import { historyPageSize, ObjectSessionHistory, useObjectSessions } from "./session-history";
import styles from "./records.module.css";

export function ObjectDetailsScreen({ objectId }: { objectId: string }) {
  const { result, retry, object, absence } = useObjectRecord(objectId);
  const { disconnected, recordsMode, recordSnapshot } = useRuntimeView();
  const retention = recordsMode ? recordSnapshot?.retention : undefined;
  const history = useObjectSessions(objectId, historyPageSize, Boolean(object));
  const missing = absence ?? recordAbsence(history.result);
  if (disconnected) return <DataUnavailable />;
  return <div className={styles.recordLayout}>
    <PageHeader title="Object Details" description={missing ? undefined : object?.name}
      actions={object && !missing && <ObjectStatus status={object.status} />} />
    {missing ? <RecordAbsent status={missing} title="Object" />
      : object ? <RecordDetails object={object} history={history} retentionDays={retention?.settings.retention_days} />
      : !result ? <LoadingState label="Loading object details" />
      : <RecordReadFailure title="Object details unavailable" retry={retry} />}
    {retention && (retention.deletion.status !== "Complete" || missing === 410) &&
      <div role="status"><DeletionNotice status={retention.deletion} /></div>}
    <footer className={styles.detailActions}>
      <Link className="button button--secondary" href="/objects">Back to Objects</Link>
      <RegisterLink another />
    </footer>
  </div>;
}

function RecordDetails({ object, history, retentionDays }: {
  object: ObjectRecord; history: ReturnType<typeof useObjectSessions>; retentionDays?: number;
}) {
  return <div className={styles.details}>
    <div className={styles.historyColumn}>
      <section className={styles.reference} aria-label="Object reference and selected target">
        <ReferenceImage object={object} target="both" />
      </section>
      <ObjectSessionHistory objectId={object.id} paging={history} />
    </div>
    <section className={styles.recordSummary} aria-label="Object record">
      <h2>{object.name}</h2>
      <dl>
        <div><dt>Registered</dt><dd><RecordTime value={object.registered_at_ms} /></dd></div>
        <div><dt>Expires</dt><dd><RecordTime value={object.expires_at_ms} /></dd></div>
        {object.status === "Found" && <div><dt>Confirmed</dt><dd><RecordTime value={object.found_at_ms} /></dd></div>}
        {retentionDays !== undefined && <div><dt>Retention</dt>
          <dd>{retentionDays} {retentionDays === 1 ? "day" : "days"} from registration</dd></div>}
      </dl>
      {object.retention_grace && <Notice role="status" tone="warning" title="Active-session grace">
        This record remains available while its active search continues.
      </Notice>}
      <StartSearch object={object} />
      {object.status === "Found" && <ConfirmedEvidence objectId={object.id} />}
    </section>
  </div>;
}
