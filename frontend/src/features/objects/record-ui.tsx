"use client";

import { Check, Plus, Search } from "lucide-react";
import Link from "next/link";
import { useEffect, useMemo } from "react";
import { ProtectedImage } from "@/components/media/protected-image";
import { Button } from "@/components/ui/button";
import { Notice, StatusBadge } from "@/components/ui/feedback";
import { useProtectedImage, useProtectedRead, useRuntime, useRuntimeView } from "@/features/runtime";
import type { Object as ObjectRecord } from "@/generated/api-v1";
import type { ReadResult } from "@/lib/transport";
import styles from "./records.module.css";

export const objectHref = (id: string) => `/objects/${encodeURIComponent(id)}`;

const dateFormat = new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "medium", timeZone: "UTC" });

export function RecordTime({ value }: { value: number }) {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return <span>{value} ms since Unix epoch</span>;
  return <time dateTime={date.toISOString()}>{dateFormat.format(date)} UTC</time>;
}

export function ObjectStatus({ status }: { status: ObjectRecord["status"] }) {
  return <StatusBadge tone={status === "Found" ? "success" : "muted"} icon={status === "Found" ? Check : Search}>{status}</StatusBadge>;
}

export function RegisterLink({ another = false }: { another?: boolean }) {
  return <Link href="/objects/new" className="button button--primary">
    <Plus size={18} aria-hidden="true" />{another ? "Register Another Object" : "Register Object"}
  </Link>;
}

export function RecordReadFailure({ title, retry }: { title: string; retry: () => void }) {
  return <div className="feedback-stack">
    <Notice title={title} tone="danger" role="alert">Saved records could not be retrieved.</Notice>
    <Button onClick={retry}>Retry</Button>
  </div>;
}

export function recordAbsence(result?: ReadResult<unknown>): 404 | 410 | undefined {
  if (result?.kind === "api-error" && (result.status === 404 || result.status === 410)) return result.status;
}

export function RecordAbsent({ status, title }: { status: 404 | 410; title: "Object" | "Session" }) {
  return status === 410 ? <Notice role="status" tone="warning" title={title === "Object" ? "Record expired" : "Session expired"}>
    The retention period ended and this record is unavailable.
  </Notice> : <section>
    <h2>{title} not found</h2>
    <p role="status">This record is unknown or has been removed.</p>
  </section>;
}

export function useObjectRecord(id: string | undefined) {
  const params = useMemo(() => ({ id: id ?? "" }), [id]);
  const { result, snapshotAtRead, retry } = useProtectedRead("GET /objects/{id}", params, id !== undefined);
  const runtime = useRuntime()?.connection?.runtime;
  const { snapshot } = useRuntimeView();
  const record = result?.kind === "ok" && result.data.id === id ? result.data : undefined;
  const { expires_at_ms: expiresAt, retention_grace: grace } = record ?? {};
  const activeOwner = Boolean(id && snapshot?.active_session?.object_id === id);
  // A fresh detail read can report grace before the snapshot catches up.
  const canUseGrace = activeOwner || (grace && snapshot === snapshotAtRead);
  const now = runtime?.serverTime();
  const expired = !canUseGrace && expiresAt !== undefined && now !== undefined && now >= expiresAt;

  useEffect(() => {
    if (expiresAt === undefined || !runtime || grace) return;
    const currentRuntime = runtime;
    const deadline = expiresAt;
    const revalidate = () => {
      // Refresh both the snapshot and its protected reads at an active owner's cutoff.
      if (activeOwner) void currentRuntime.refresh();
      else retry();
    };
    const check = () => { if ((currentRuntime.serverTime() ?? 0) >= deadline) revalidate(); };
    // Retention can exceed the maximum browser timer interval. Recheck on wake as well.
    const delay = Math.min(Math.max(0, deadline - (currentRuntime.serverTime() ?? deadline)), 2_147_483_647);
    let timer = window.setTimeout(tick, delay);
    function tick() {
      const time = currentRuntime.serverTime();
      if (time === undefined) return;
      if (time >= deadline) revalidate();
      else timer = window.setTimeout(tick, Math.min(deadline - time, 2_147_483_647));
    }
    window.addEventListener("focus", check);
    return () => {
      window.clearTimeout(timer);
      window.removeEventListener("focus", check);
    };
  }, [activeOwner, expiresAt, grace, retry, runtime]);

  return { result, retry, object: expired ? undefined : record, absence: expired ? 410 as const : recordAbsence(result) };
}

export function ReferenceImage({ object, thumbnail = false, target }: {
  object: ObjectRecord; thumbnail?: boolean; target?: "both" | "selected";
}) {
  const media = object.reference_media;
  const load = useProtectedImage(media);
  return <ProtectedImage load={load} label={thumbnail ? "Reference thumbnail" : "Reference image"}
    alt={`Reference for ${object.name}`} width={media.width} height={media.height}
    target={target ? object.roi : undefined} targetOnly={target === "selected"} />;
}

export function StartSearch({ object }: { object: ObjectRecord }) {
  const { snapshot, health } = useRuntimeView();
  const state = snapshot?.runtime.effective_session_state ?? snapshot?.active_session?.state ?? health?.active_session_state;
  const storage = snapshot?.readiness.components.find(({ component }) => component === "Storage");
  const reason = object.status === "Found" ? "This object has already been found."
    : state === "Searching" || state === "Paused" ? `End the ${state.toLowerCase()} session before starting another search.`
    : health?.storage_integrity === "Unavailable" || storage?.status === "Unavailable" ? "Storage is unavailable."
    : health?.storage_integrity === "Reconciling" || storage?.status === "Initializing" ? "Storage is being checked."
    : object.retention_grace ? "This expired record is available for its existing search only."
    : object.reference_media.availability !== "Available" ? "The reference image is unavailable."
    : undefined;
  return reason ? <div className={styles.blockedAction}><Button disabledReason={reason}>Start Search</Button></div>
    : <Link className="button button--primary" href={`${objectHref(object.id)}/search`}>Start Search</Link>;
}
