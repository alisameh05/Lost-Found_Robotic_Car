"use client";

import { Check, Plus, Search } from "lucide-react";
import Link from "next/link";
import { ProtectedImage } from "@/components/media/protected-image";
import { Button } from "@/components/ui/button";
import { Notice, StatusBadge } from "@/components/ui/feedback";
import { useProtectedImage, useRuntimeView } from "@/features/runtime";
import type { Object as ObjectRecord } from "@/generated/api-v1";
import { searchSetupBlockReason } from "@/lib/search-setup-context";
import styles from "./records.module.css";

export const objectHref = (id: string) => `/objects/${encodeURIComponent(id)}`;

const dateFormat = new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "medium", timeZone: "UTC" });
const compactDateFormat = new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short", timeZone: "UTC" });

export function RecordTime({ value, compact = false }: { value: number; compact?: boolean }) {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return <span>{value} ms since Unix epoch</span>;
  return <time dateTime={date.toISOString()}>{(compact ? compactDateFormat : dateFormat).format(date)} UTC</time>;
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

export function RecordAbsent({ status, title }: { status: 404 | 410; title: "Object" | "Session" }) {
  return status === 410 ? <Notice role="status" tone="warning" title={title === "Object" ? "Record expired" : "Session expired"}>
    The retention period ended and this record is unavailable.
  </Notice> : <section>
    <h2>{title} not found</h2>
    <p role="status">This record is unknown or has been removed.</p>
  </section>;
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
  const reason = searchSetupBlockReason(object, useRuntimeView());
  return reason ? <div className={styles.blockedAction}><Button disabledReason={reason}>Start Search</Button></div>
    : <Link className="button button--primary" href={`${objectHref(object.id)}/search`}>Start Search</Link>;
}
