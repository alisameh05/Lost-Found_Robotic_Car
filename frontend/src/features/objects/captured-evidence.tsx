"use client";

import { ProtectedImage } from "@/components/media/protected-image";
import { StatusBadge } from "@/components/ui/feedback";
import { useProtectedImage } from "@/features/runtime";
import type { Match } from "@/generated/api-v1";
import { RecordTime } from "./record-ui";
import styles from "./records.module.css";

export const dispositionLabel = (disposition: Match["disposition"]) => disposition === "NotReviewed" ? "Not reviewed" : disposition;

export function CapturedEvidence({ match }: { match: Match }) {
  const media = match.evidence_media;
  const load = useProtectedImage(media);
  return <article className={styles.capture}>
    <ProtectedImage load={load} label="Captured evidence" alt="Captured evidence"
      width={media.width} height={media.height} box={match.box} />
    <StatusBadge tone={match.disposition === "Confirmed" ? "success" : match.disposition === "Pending" ? "warning" : "muted"}>
      {dispositionLabel(match.disposition)}
    </StatusBadge>
    <dl className={styles.captureTimes}>
      <div><dt>Captured</dt><dd><RecordTime value={match.captured_at_ms} /></dd></div>
      {match.reviewed_at_ms !== null && <div><dt>Reviewed</dt><dd><RecordTime value={match.reviewed_at_ms} /></dd></div>}
    </dl>
  </article>;
}
