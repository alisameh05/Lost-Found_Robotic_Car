"use client";

import { useEffect } from "react";
import type { Object as ObjectRecord, Snapshot } from "@/generated/api-v1";
import { useRuntime, useRuntimeView } from "./runtime-provider";

const largestTimeout = 2_147_483_647;

export function useEligibleObjects(
  objects: readonly ObjectRecord[], snapshotAtRead: Snapshot | undefined, retry: () => void,
) {
  const runtime = useRuntime()?.connection?.runtime;
  const { recordSnapshot, snapshot, removedOwners } = useRuntimeView();
  const now = runtime?.serverTime();
  const hasGrace = (object: ObjectRecord) => snapshot?.active_session?.object_id === object.id ||
    (object.retention_grace && snapshotAtRead === recordSnapshot);
  const eligible = objects.filter((object) => !removedOwners?.has(object.id) &&
    (now === undefined || now < object.expires_at_ms || hasGrace(object)));
  const deadline = eligible.reduce((earliest, object) =>
    hasGrace(object) ? earliest : Math.min(earliest, object.expires_at_ms), Infinity);

  useEffect(() => {
    if (!runtime || !Number.isFinite(deadline)) return;
    const currentRuntime = runtime;
    let timer: ReturnType<typeof setTimeout> | undefined;
    function recheck() {
      const time = currentRuntime.serverTime();
      if (time === undefined) return;
      clearTimeout(timer);
      if (time >= deadline) retry();
      else timer = setTimeout(recheck, Math.min(deadline - time, largestTimeout));
    }
    recheck();
    window.addEventListener("focus", recheck);
    return () => {
      clearTimeout(timer);
      window.removeEventListener("focus", recheck);
    };
  }, [deadline, retry, runtime]);

  return eligible;
}
