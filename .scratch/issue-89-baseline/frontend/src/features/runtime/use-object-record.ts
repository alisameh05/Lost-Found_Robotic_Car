"use client";

import { useCallback, useMemo } from "react";
import type { ReadResult } from "@/lib/transport";
import { useRuntime, useRuntimeView } from "./runtime-provider";
import { useProtectedRead } from "./use-protected-read";
import { useRecordDeadline } from "./use-record-deadline";

export function recordAbsence(result?: ReadResult<unknown>): 404 | 410 | undefined {
  if (result?.kind === "api-error" && (result.status === 404 || result.status === 410)) return result.status;
}

export function useObjectRecord(id: string | undefined) {
  const params = useMemo(() => ({ id: id ?? "" }), [id]);
  const { result, snapshotAtRead, retry } = useProtectedRead("GET /objects/{id}", params, id !== undefined);
  const runtime = useRuntime()?.connection?.runtime;
  const { snapshot, recordSnapshot, recordsMode, removedOwners } = useRuntimeView();
  const record = result?.kind === "ok" && result.data.id === id ? result.data : undefined;
  const { expires_at_ms: expiresAt, retention_grace: grace } = record ?? {};
  const activeOwner = Boolean(id && snapshot?.active_session?.object_id === id);
  // Records HTTP has no ordered grace-end event. Keep the last authorized
  // detail until it is reread, invalidated by owner, or cleared on wake.
  const canUseGrace = activeOwner || (grace && (recordsMode || recordSnapshot === snapshotAtRead));
  const now = runtime?.serverTime();
  const expired = !canUseGrace && expiresAt !== undefined && now !== undefined && now >= expiresAt;
  const removed = Boolean(record && id && removedOwners?.has(id));

  const revalidate = useCallback(() => {
    // An active owner needs a fresh snapshot at the cutoff to establish grace.
    if (activeOwner) void runtime?.refresh();
    else retry();
  }, [activeOwner, retry, runtime]);
  useRecordDeadline(runtime, grace ? Infinity : expiresAt ?? Infinity, revalidate);

  return { result, snapshotAtRead, retry, object: expired || removed ? undefined : record,
    absence: expired || removed ? 410 as const : recordAbsence(result) };
}
