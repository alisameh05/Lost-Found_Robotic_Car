"use client";

import { useCallback, useState } from "react";
import type { HttpResponses, Token } from "@/generated/api-v1";
import { isInvalidCursor, type ReadEndpoint, type ReadParams } from "@/lib/transport";
import type { RuntimeProjection } from "./projection";
import { useApplicationRead, useRuntime, useRuntimeView } from "./runtime-provider";

export function useProtectedRead<Route extends ReadEndpoint>(route: Route, params: ReadParams<Route>, enabled = true) {
  const load = useCallback((runtime: RuntimeProjection, signal: AbortSignal) =>
    runtime.read(route, params, signal), [params, route]);
  return useApplicationRead(load, enabled, true, route === "GET /objects" || route === "GET /objects/{id}");
}

type PageRoute = {
  [Route in ReadEndpoint]: HttpResponses[Route] extends { next_cursor: Token | null } ? Route : never;
}[ReadEndpoint];

type Navigation = {
  scope: object;
  runtime: RuntimeProjection | undefined;
  cursorAuthority?: number;
  cursors: readonly (Token | undefined)[];
  reset?: "CURSOR_INVALID" | "CURSOR_EXPIRED";
};
const firstPage = [undefined] as const;

// Keep a stack of incoming cursors so Previous can reread a page with the same filters.
export function useCursorPage<Route extends PageRoute>(route: Route, scope: ReadParams<Route>, enabled = true) {
  const runtime = useRuntime()?.connection?.runtime;
  const { cursorAuthority } = useRuntimeView();
  const [navigation, setNavigation] = useState<Navigation>({ scope, runtime, cursorAuthority, cursors: firstPage });
  const sameScope = navigation.scope === scope && navigation.runtime === runtime && navigation.cursorAuthority === cursorAuthority;
  const cursors = sameScope ? navigation.cursors : firstPage;
  const cursor = cursors.at(-1);
  const load = useCallback((runtime: RuntimeProjection, signal: AbortSignal) =>
    runtime.read(route, { ...scope, query: { ...scope.query, cursor } }, signal), [route, scope, cursor]);
  const { result, snapshotAtRead, retry } = useApplicationRead(load, enabled, true, route === "GET /objects");
  const restart = cursor !== undefined && isInvalidCursor(result) && result?.kind === "api-error"
    ? result.error.code === "CURSOR_EXPIRED" ? "CURSOR_EXPIRED" : "CURSOR_INVALID" : undefined;

  if (!sameScope || restart) setNavigation({ scope, runtime, cursorAuthority, cursors: firstPage, reset: restart });
  const next = result?.kind === "ok" ? result.data.next_cursor : null;

  return {
    result: restart ? undefined : result,
    snapshotAtRead,
    reset: sameScope ? navigation.reset : undefined,
    retry,
    page: cursors.length,
    hasPrevious: cursors.length > 1,
    hasNext: next !== null,
    previous: () => {
      if (cursors.length > 1 && result) setNavigation({ scope, runtime, cursorAuthority, cursors: cursors.slice(0, -1) });
    },
    next: () => {
      if (next !== null) setNavigation({ scope, runtime, cursorAuthority, cursors: [...cursors, next] });
    },
  };
}
