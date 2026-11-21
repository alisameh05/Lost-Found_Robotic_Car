"use client";

import type { Object as ObjectRecord, Snapshot } from "@/generated/api-v1";
import { useRuntime, useRuntimeView } from "./runtime-provider";
import { useRecordDeadline } from "./use-record-deadline";

export function useEligibleObjects(
  objects: readonly ObjectRecord[], snapshotAtRead: Snapshot | undefined, retry: () => void,
) {
  const runtime = useRuntime()?.connection?.runtime;
  const { recordSnapshot, snapshot, recordsMode, removedOwners } = useRuntimeView();
  const now = runtime?.serverTime();
  const hasGrace = (object: ObjectRecord) => snapshot?.active_session?.object_id === object.id ||
    (object.retention_grace && (recordsMode || snapshotAtRead === recordSnapshot));
  const eligible = objects.filter((object) => !removedOwners?.has(object.id) &&
    (now === undefined || now < object.expires_at_ms || hasGrace(object)));
  const deadline = eligible.reduce((earliest, object) =>
    hasGrace(object) ? earliest : Math.min(earliest, object.expires_at_ms), Infinity);

  useRecordDeadline(runtime, deadline, retry);
  return eligible;
}
