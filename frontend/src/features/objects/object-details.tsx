"use client";

import Link from "next/link";
import { useMemo } from "react";
import { PageHeader } from "@/components/layout/page-header";
import { DataUnavailable } from "@/components/layout/preview";
import { LoadingState, Notice } from "@/components/ui/feedback";
import { useProtectedRead, useRuntimeView } from "@/features/runtime";
import type { Object as ObjectRecord } from "@/generated/api-v1";
import { ObjectStatus, RecordReadFailure, RecordTime, ReferenceImage, RegisterLink, StartSearch } from "./record-ui";
import styles from "./records.module.css";

export function ObjectDetailsScreen({ objectId }: { objectId: string }) {
  const params = useMemo(() => ({ id: objectId }), [objectId]);
  const { result, retry } = useProtectedRead("GET /objects/{id}", params);
  const { disconnected } = useRuntimeView();
  const object = result?.kind === "ok" ? result.data : undefined;
  if (disconnected) return <DataUnavailable />;
  return <div className={styles.recordLayout}>
    <PageHeader title="Object Details" description={object?.name} actions={object && <ObjectStatus status={object.status} />} />
    {!result ? <LoadingState label="Loading object details" />
      : result.kind === "ok" ? <RecordDetails object={result.data} />
      : result.kind === "api-error" && result.status === 410 ? <Notice role="status" tone="warning" title="Record expired">
        The retention period ended and this record is unavailable.
      </Notice> : result.kind === "api-error" && result.status === 404 ? <section>
        <h2>Object not found</h2><p role="status">This record is unknown or has been removed.</p>
      </section> : <RecordReadFailure title="Object details unavailable" retry={retry} />}
    <footer className={styles.detailActions}>
      <Link className="button button--secondary" href="/objects">Back to Objects</Link>
      <RegisterLink another />
    </footer>
  </div>;
}

function RecordDetails({ object }: { object: ObjectRecord }) {
  return <div className={styles.details}>
    <section className={styles.reference} aria-label="Object reference and selected target">
      <ReferenceImage object={object} target />
    </section>
    <section className={styles.recordSummary} aria-label="Object record">
      <h2>{object.name}</h2>
      <dl>
        <div><dt>Registered</dt><dd><RecordTime value={object.registered_at_ms} /></dd></div>
        <div><dt>Expires</dt><dd><RecordTime value={object.expires_at_ms} /></dd></div>
        {object.status === "Found" && <div><dt>Confirmed</dt><dd><RecordTime value={object.found_at_ms} /></dd></div>}
      </dl>
      {object.retention_grace && <Notice role="status" tone="warning" title="Active-session grace">
        This record remains available while its active search continues.
      </Notice>}
      <StartSearch object={object} />
    </section>
  </div>;
}
