"use client";

import { useEffect, useMemo } from "react";
import type { ReadResult } from "@/lib/transport";
import { useRuntime, useRuntimeView } from "./runtime-provider";
import { useProtectedRead } from "./use-protected-read";

export function recordAbsence(result?: ReadResult<unknown>): 404 | 410 | undefined {
  if (result?.kind === "api-error" && (result.status === 404 || result.status === 410)) return result.status;
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

  return { result, snapshotAtRead, retry, object: expired ? undefined : record, absence: expired ? 410 as const : recordAbsence(result) };
}
