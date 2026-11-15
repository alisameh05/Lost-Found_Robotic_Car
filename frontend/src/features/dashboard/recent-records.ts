"use client";

import { useEffect, useMemo } from "react";
import { recordAbsence, useProtectedRead, useRuntime, useRuntimeView } from "@/features/runtime";
import type { Object as ObjectRecord } from "@/generated/api-v1";

const objectLimit = 3;
const sessionLimit = 3;
const objectQuery = { query: { limit: objectLimit } };
const largestTimeout = 2_147_483_647;

function useRecentSessionPage(owner?: ObjectRecord) {
  const id = owner?.id;
  const params = useMemo(() => ({ id: id ?? "", query: { limit: sessionLimit } }), [id]);
  return useProtectedRead("GET /objects/{id}/sessions", params, !!owner).result;
}

export function useRecentRecords() {
  const runtime = useRuntime()?.connection?.runtime;
  const { snapshot, failedRead, removedOwners } = useRuntimeView();
  const catalogue = useProtectedRead("GET /objects", objectQuery);
  // Suppress the previous scope while its replacement is being read.
  const objectPage = catalogue.result?.kind === "ok" && catalogue.snapshotAtRead !== snapshot ? undefined : catalogue.result;
  const recentObjects = objectPage?.kind === "ok" ? objectPage.data.items.slice(0, objectLimit) : [];
  const activeOwner = failedRead ? undefined : snapshot?.active_session?.object_id;
  // The catalogue page has three slots. Each owner settles and invalidates independently.
  const [first, second, third] = recentObjects;
  const histories = [useRecentSessionPage(first), useRecentSessionPage(second), useRecentSessionPage(third)];
  const owners = recentObjects.map((owner, index) => ({ owner, history: histories[index] }));

  const now = runtime?.serverTime();
  const hasGrace = (object: ObjectRecord) => object.retention_grace || activeOwner === object.id;
  const visible = owners.filter(({ owner, history }) => !removedOwners?.has(owner.id) && !recordAbsence(history) &&
    (now === undefined || owner.expires_at_ms > now || hasGrace(owner)));
  const sessions = visible.flatMap(({ owner, history }) => history?.kind === "ok"
    ? history.data.items.filter(({ object_id }) => object_id === owner.id).map((session) => ({ session, owner }))
    : []);
  sessions.sort(({ session: left }, { session: right }) => right.started_at_ms - left.started_at_ms ||
    (left.id === right.id ? 0 : left.id > right.id ? -1 : 1));
  const deadline = Math.min(...visible.filter(({ owner }) => !hasGrace(owner)).map(({ owner }) => owner.expires_at_ms));
  const { retry } = catalogue;

  useEffect(() => {
    if (!runtime || !Number.isFinite(deadline)) return;
    let timer: ReturnType<typeof setTimeout>;
    function schedule() {
      const remaining = deadline - (runtime?.serverTime() ?? deadline);
      if (remaining <= 0) retry();
      else timer = setTimeout(schedule, Math.min(remaining, largestTimeout));
    }
    schedule();
    return () => {
      clearTimeout(timer);
    };
  }, [deadline, retry, runtime]);

  return {
    objectPage,
    objects: visible.map(({ owner }) => owner),
    sessions: sessions.slice(0, sessionLimit),
    loadingSessions: visible.some(({ history }) => !history),
    incomplete: recentObjects.length !== visible.length || visible.some(({ owner, history }) => history &&
      (history.kind !== "ok" || history.data.items.some(({ object_id }) => object_id !== owner.id))),
    retry,
  };
}
