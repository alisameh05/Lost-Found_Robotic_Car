"use client";

import { useCallback } from "react";
import { LoadingState, Notice } from "@/components/ui/feedback";
import { useApplicationRead, type RuntimeProjection } from "@/features/runtime";
import type { Match, Session, Token } from "@/generated/api-v1";
import { isInvalidCursor, type ReadResult } from "@/lib/transport";
import { CapturedEvidence } from "./captured-evidence";
import { RecordReadFailure } from "./record-ui";
import { historyPageSize } from "./session-history";
import styles from "./records.module.css";

function found<T>(data: T): ReadResult<T> {
  return { kind: "ok", status: 200, data };
}

async function findInPages<T>(
  read: (cursor?: Token) => Promise<ReadResult<{ items: T[]; next_cursor: Token | null }>>,
  matches: (item: T) => boolean,
  signal: AbortSignal,
): Promise<ReadResult<T | null>> {
  const visited = new Set<Token>();
  let cursor: Token | undefined;
  let restarted = false;
  do {
    signal.throwIfAborted();
    const page = await read(cursor);
    if (page.kind !== "ok") {
      if (!restarted && cursor && isInvalidCursor(page)) {
        restarted = true;
        cursor = undefined;
        visited.clear();
        continue;
      }
      return page;
    }
    const item = page.data.items.find(matches);
    if (item) return found(item);
    cursor = page.data.next_cursor ?? undefined;
    if (!cursor) return found(null);
    if (visited.has(cursor)) return { kind: "unavailable" };
    visited.add(cursor);
  } while (true);
}

export function ConfirmedEvidence({ objectId }: { objectId: string }) {
  const load = useCallback(async (runtime: RuntimeProjection, signal: AbortSignal): Promise<ReadResult<Match | null>> => {
    const session = await findInPages<Session>(
      (cursor) => runtime.read("GET /objects/{id}/sessions", { id: objectId, query: { limit: historyPageSize, cursor } }, signal),
      (item) => item.object_id === objectId && item.end_reason === "Confirmed",
      signal,
    );
    if (session.kind !== "ok") return session;
    if (!session.data) return found(null);
    const sessionId = session.data.id;
    return findInPages<Match>(
      (cursor) => runtime.read("GET /sessions/{id}/matches", { id: sessionId, query: { limit: historyPageSize, cursor } }, signal),
      (item) => item.session_id === sessionId && item.object_id === objectId &&
        item.disposition === "Confirmed",
      signal,
    );
  }, [objectId]);
  const { result, retry } = useApplicationRead(load, true, true);
  return <section className={styles.confirmedEvidence} aria-label="Confirmed evidence">
    <h3>Confirmed evidence</h3>
    {!result ? <LoadingState label="Loading confirmation evidence" />
      : result.kind !== "ok" ? <RecordReadFailure title="Confirmation evidence unavailable" retry={retry} />
      : result.data ? <CapturedEvidence key={result.data.id} match={result.data} />
      : <Notice role="status" tone="warning" title="Confirmation evidence unavailable">
        The saved confirmation time remains in the object record.
      </Notice>}
  </section>;
}
