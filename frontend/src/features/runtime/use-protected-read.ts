"use client";

import { useCallback, useState } from "react";
import type { HttpResponses, Token } from "@/generated/api-v1";
import { isInvalidCursor, type ReadEndpoint, type ReadParams } from "@/lib/transport";
import type { RuntimeProjection } from "./projection";
import { useApplicationRead, useRuntime } from "./runtime-provider";

export function useProtectedRead<Route extends ReadEndpoint>(route: Route, params: ReadParams<Route>, enabled = true) {
  const load = useCallback((runtime: RuntimeProjection, signal: AbortSignal) =>
    runtime.read(route, params, signal), [params, route]);
  return useApplicationRead(load, enabled, true);
}

type PageRoute = {
  [Route in ReadEndpoint]: HttpResponses[Route] extends { next_cursor: Token | null } ? Route : never;
}[ReadEndpoint];

type Navigation = {
  scope: object;
  runtime: RuntimeProjection | undefined;
  cursors: readonly (Token | undefined)[];
};
const firstPage = [undefined] as const;

// Keep a stack of incoming cursors so Previous can reread a page with the same filters.
export function useCursorPage<Route extends PageRoute>(route: Route, scope: ReadParams<Route>, enabled = true) {
  const runtime = useRuntime()?.connection?.runtime;
  const [navigation, setNavigation] = useState<Navigation>({ scope, runtime, cursors: firstPage });
  const sameScope = navigation.scope === scope && navigation.runtime === runtime;
  const cursors = sameScope ? navigation.cursors : firstPage;
  const cursor = cursors.at(-1);
  const load = useCallback((runtime: RuntimeProjection, signal: AbortSignal) =>
    runtime.read(route, { ...scope, query: { ...scope.query, cursor } }, signal), [route, scope, cursor]);
  const { result, retry } = useApplicationRead(load, enabled, true);
  const restart = cursor !== undefined && isInvalidCursor(result);

  if (!sameScope || restart) setNavigation({ scope, runtime, cursors: firstPage });
  const next = result?.kind === "ok" ? result.data.next_cursor : null;

  return {
    result: restart ? undefined : result,
    retry,
    page: cursors.length,
    hasPrevious: cursors.length > 1,
    hasNext: next !== null,
    previous: () => {
      if (cursors.length > 1) setNavigation({ scope, runtime, cursors: cursors.slice(0, -1) });
    },
    next: () => {
      if (next !== null) setNavigation({ scope, runtime, cursors: [...cursors, next] });
    },
  };
}
