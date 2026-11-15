"use client";

import { searchSetupBlockReason, type SearchSetupContext } from "@/lib/search-setup-context";
import { useRuntimeView } from "./runtime-provider";
import { useObjectRecord } from "./use-object-record";

export function useEligibleSearchSetup(setup?: SearchSetupContext) {
  const view = useRuntimeView();
  const { snapshot, failedRead, loading } = view;
  const canCheck = !!setup && snapshot?.active_session === null && !failedRead && !loading;
  const { object, result, snapshotAtRead } = useObjectRecord(canCheck ? setup.objectId : undefined);
  const current = canCheck && !!result && snapshotAtRead === snapshot;
  const eligible = current && object && !searchSetupBlockReason(object, view);
  return { context: eligible ? setup : undefined, checking: !!setup && (loading || (canCheck && !current)) };
}
