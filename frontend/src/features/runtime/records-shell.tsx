"use client";

import { useCallback, type ReactNode } from "react";
import { RuntimeFrame } from "./runtime-shell";
import { Notice } from "@/components/ui/feedback";
import { PHASE_06_PROFILE } from "@/lib/config";
import { createHttpTransport } from "@/lib/http-transport";
import { RuntimeProvider, useRuntimeView } from "./runtime-provider";

function RecordsFrame({ children }: { children: ReactNode }) {
  const { connected, loading, health, failedRead, profile } = useRuntimeView();
  const connectedLabel = profile?.evidence_kind === "Device" ? "Device mode"
    : profile?.profile_id === PHASE_06_PROFILE ? "Fixture mode · Backend simulation"
    : profile ? "Backend simulation" : "Records connected · Search unavailable";
  const status = connected ? connectedLabel
    : health?.initialization === "Starting" || loading ? "Connecting to local records" : "Local records unavailable";
  return <RuntimeFrame fixtureEnabled={false} modeLabel={status}>
    {failedRead?.kind === "api-error" && failedRead.error.code === "STORAGE_UNAVAILABLE" &&
      <Notice title="Local records storage unavailable" role="alert" tone="danger">{failedRead.error.message}</Notice>}
    {children}
  </RuntimeFrame>;
}

export function RecordsShell({ backendBaseUrl, children }: { backendBaseUrl: string; children: ReactNode }) {
  const openTransport = useCallback(async () => ({ transport: createHttpTransport(backendBaseUrl) }), [backendBaseUrl]);
  return <RuntimeProvider openTransport={openTransport} recordsMode>
    <RecordsFrame>{children}</RecordsFrame>
  </RuntimeProvider>;
}
