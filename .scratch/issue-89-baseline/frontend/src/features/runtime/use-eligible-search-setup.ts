"use client";

import { searchSetupTargetBlockReason, type SearchSetupContext } from "@/lib/search-setup-context";
import { useRuntimeView } from "./runtime-provider";
import { useObjectRecord } from "./use-object-record";

export function useEligibleSearchSetup(setup?: SearchSetupContext) {
  const { recordSnapshot, connected, loading } = useRuntimeView();
  const canCheck = !!setup && connected && !loading;
  const { object, result, snapshotAtRead } = useObjectRecord(canCheck ? setup.objectId : undefined);
  const current = canCheck && !!result && snapshotAtRead === recordSnapshot;
  const eligible = current && object && !searchSetupTargetBlockReason(object);
  return { context: eligible ? setup : undefined, checking: !!setup && (loading || (canCheck && !current)) };
}
