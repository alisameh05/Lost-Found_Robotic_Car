"use client";

import { Check, Plus, Search } from "lucide-react";
import Link from "next/link";
import { ProtectedImage } from "@/components/media/protected-image";
import { Button } from "@/components/ui/button";
import { Notice, StatusBadge } from "@/components/ui/feedback";
import { useProtectedImage, useRuntimeView } from "@/features/runtime";
import type { Object as ObjectRecord } from "@/generated/api-v1";
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

export function ReferenceImage({ object, thumbnail = false, target = false }: {
  object: ObjectRecord; thumbnail?: boolean; target?: boolean;
}) {
  const media = object.reference_media;
  const load = useProtectedImage(media);
  return <ProtectedImage load={load} label={thumbnail ? "Reference thumbnail" : "Reference image"}
    alt={`Reference for ${object.name}`} width={media.width} height={media.height} target={target ? object.roi : undefined} />;
}

export function StartSearch({ object }: { object: ObjectRecord }) {
  const { snapshot, health } = useRuntimeView();
  const state = snapshot?.runtime.effective_session_state ?? snapshot?.active_session?.state ?? health?.active_session_state;
  const storage = snapshot?.readiness.components.find(({ component }) => component === "Storage");
  const reason = object.status === "Found" ? "This object has already been found."
    : state === "Searching" || state === "Paused" ? `End the ${state.toLowerCase()} session before starting another search.`
    : health?.storage_integrity === "Unavailable" || storage?.status === "Unavailable" ? "Storage is unavailable."
    : health?.storage_integrity === "Reconciling" ? "Storage is being checked."
    : object.retention_grace ? "This expired record is available for its existing search only."
    : object.reference_media.availability !== "Available" ? "The reference image is unavailable."
    : undefined;
  return reason ? <div className={styles.blockedAction}><Button disabledReason={reason}>Start Search</Button></div>
    : <Link className="button button--primary" href={`${objectHref(object.id)}/search`}>Start Search</Link>;
}
