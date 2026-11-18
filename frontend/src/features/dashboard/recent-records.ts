"use client";

import { useMemo } from "react";
import { recordAbsence, useEligibleObjects, useProtectedRead, useRuntimeView } from "@/features/runtime";
import type { Object as ObjectRecord } from "@/generated/api-v1";

const objectLimit = 3;
const sessionLimit = 3;
const objectQuery = { query: { limit: objectLimit } };
function useRecentSessionPage(owner: ObjectRecord | undefined, enabled: boolean) {
  const id = owner?.id;
  const params = useMemo(() => ({ id: id ?? "", query: { limit: sessionLimit } }), [id]);
  return useProtectedRead("GET /objects/{id}/sessions", params, enabled && !!owner).result;
}

export function useRecentRecords() {
  const { recordSnapshot, recordsMode } = useRuntimeView();
  const catalogue = useProtectedRead("GET /objects", objectQuery);
  // Suppress the previous scope while its replacement is being read.
  const objectPage = catalogue.result?.kind === "ok" && catalogue.snapshotAtRead !== recordSnapshot ? undefined : catalogue.result;
  const recentObjects = objectPage?.kind === "ok" ? objectPage.data.items.slice(0, objectLimit) : [];
  const eligible = useEligibleObjects(recentObjects, catalogue.snapshotAtRead, catalogue.retry);
  const [first, second, third] = eligible;
  const histories = [useRecentSessionPage(first, !recordsMode), useRecentSessionPage(second, !recordsMode),
    useRecentSessionPage(third, !recordsMode)];
  const owners = eligible.map((owner, index) => ({ owner, history: histories[index] }));
  const visible = owners.filter(({ history }) => !recordAbsence(history));
  const sessions = visible.flatMap(({ owner, history }) => history?.kind === "ok"
    ? history.data.items.filter(({ object_id }) => object_id === owner.id).map((session) => ({ session, owner }))
    : []);
  sessions.sort(({ session: left }, { session: right }) => right.started_at_ms - left.started_at_ms ||
    (left.id === right.id ? 0 : left.id > right.id ? -1 : 1));
  return {
    objectPage,
    objects: visible.map(({ owner }) => owner),
    sessions: sessions.slice(0, sessionLimit),
    loadingSessions: visible.some(({ history }) => !history),
    incomplete: recentObjects.length !== visible.length || visible.some(({ owner, history }) => history &&
      (history.kind !== "ok" || history.data.items.some(({ object_id }) => object_id !== owner.id))),
    retry: catalogue.retry,
  };
}
