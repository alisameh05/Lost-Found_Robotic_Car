"use client";

import { useCallback, useEffect } from "react";
import { recordAbsence, useApplicationRead, useProtectedRead, useRuntime, useRuntimeView, type RuntimeProjection } from "@/features/runtime";
import type { Object as ObjectRecord, Session } from "@/generated/api-v1";

const objectLimit = 3;
const sessionLimit = 3;
const objectQuery = { query: { limit: objectLimit } };
const noObjects: readonly ObjectRecord[] = [];
const largestTimeout = 2_147_483_647;

export function useRecentRecords() {
  const runtime = useRuntime()?.connection?.runtime;
  const { snapshot, failedRead } = useRuntimeView();
  const catalogue = useProtectedRead("GET /objects", objectQuery);
  // Suppress the previous scope while its replacement is being read.
  const objectPage = catalogue.result?.kind === "ok" && catalogue.snapshotAtRead !== snapshot ? undefined : catalogue.result;
  const recentObjects = objectPage?.kind === "ok" ? objectPage.data.items : noObjects;
  const activeOwner = failedRead ? undefined : snapshot?.active_session?.object_id;
  const readSessions = useCallback(async (runtime: RuntimeProjection, signal: AbortSignal) => {
    const pages = await Promise.allSettled(recentObjects.map(({ id }) =>
      runtime.read("GET /objects/{id}/sessions", { id, query: { limit: sessionLimit } }, signal)));
    const absent = new Set<string>();
    const sessions: Session[] = [];
    let incomplete = false;
    pages.forEach((page, index) => {
      const owner = recentObjects[index].id;
      if (page.status === "fulfilled" && page.value.kind === "ok") {
        const owned = page.value.data.items.filter(({ object_id }) => object_id === owner);
        sessions.push(...owned);
        incomplete ||= owned.length !== page.value.data.items.length;
      } else {
        incomplete = true;
        if (page.status === "fulfilled" && recordAbsence(page.value)) absent.add(owner);
      }
    });
    sessions.sort((left, right) => right.started_at_ms - left.started_at_ms ||
      (left.id === right.id ? 0 : left.id > right.id ? -1 : 1));
    return { kind: "ok", status: 200, data: { sessions, incomplete, absent } } as const;
  }, [recentObjects]);
  const history = useApplicationRead(readSessions, recentObjects.length > 0, true);
  const historyData = history.result?.kind === "ok" ? history.result.data : undefined;

  const now = runtime?.serverTime();
  const hasGrace = (object: ObjectRecord) => activeOwner === object.id ||
    (!snapshot && object.retention_grace);
  const visible = recentObjects.filter((object) => !historyData?.absent.has(object.id) &&
    (now === undefined || object.expires_at_ms > now || hasGrace(object)));
  const sessionRows = historyData?.sessions.flatMap((session) => {
    const owner = visible.find(({ id }) => id === session.object_id);
    return owner ? [{ session, owner }] : [];
  }).slice(0, sessionLimit);
  const deadline = Math.min(...visible.filter((item) => !hasGrace(item)).map((item) => item.expires_at_ms));
  const { retry } = catalogue;

  useEffect(() => {
    if (!runtime || !Number.isFinite(deadline)) return;
    let timer: ReturnType<typeof setTimeout>;
    function schedule() {
      const remaining = deadline - (runtime?.serverTime() ?? deadline);
      if (remaining <= 0) retry();
      else timer = setTimeout(schedule, Math.min(remaining, largestTimeout));
    }
    function onFocus() {
      clearTimeout(timer);
      schedule();
    }
    schedule();
    window.addEventListener("focus", onFocus);
    return () => {
      clearTimeout(timer);
      window.removeEventListener("focus", onFocus);
    };
  }, [deadline, retry, runtime]);

  return {
    objectPage,
    objects: visible,
    sessions: sessionRows,
    incomplete: historyData?.incomplete || (objectPage?.kind === "ok" && recentObjects.length !== visible.length),
    retry,
  };
}
