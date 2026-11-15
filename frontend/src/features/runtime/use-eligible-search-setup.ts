"use client";

import { useCallback } from "react";
import type { SearchSetupContext } from "@/lib/search-setup-context";
import type { RuntimeProjection } from "./projection";
import { useApplicationRead, useRuntimeView } from "./runtime-provider";

export function useEligibleSearchSetup(setup?: SearchSetupContext) {
  const { snapshot, failedRead } = useRuntimeView();
  const objectId = setup?.objectId;
  const load = useCallback((runtime: RuntimeProjection, signal: AbortSignal) =>
    runtime.get("/objects/{id}", objectId, signal), [objectId]);
  const { result, snapshotAtRead } = useApplicationRead(load,
    !!setup && snapshot?.active_session === null && !failedRead);
  if (snapshotAtRead === snapshot && result?.kind === "ok" && result.data.id === objectId && result.data.status === "Lost") {
    return setup;
  }
}
