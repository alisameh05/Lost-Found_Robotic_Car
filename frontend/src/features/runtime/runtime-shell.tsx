"use client";

import { Octagon } from "lucide-react";
import Link from "next/link";
import type { ReactNode } from "react";
import { AppShell } from "@/components/layout/app-shell";
import { Notice } from "@/components/ui/feedback";
import type { EmergencyFeedback } from "./projection";
import { useRuntime, useRuntimeView } from "./runtime-provider";

export function RuntimeFrame({ children }: { children: ReactNode }) {
  const runtime = useRuntime()?.connection?.runtime;
  const { snapshot, health, failedRead, emergency } = useRuntimeView();
  const session = snapshot?.active_session;
  const active = session?.state === "Searching" || session?.state === "Paused";
  const offerEmergency = active || !!health?.active_session_state;

  return (
    <AppShell fixtureEnabled activeSearch={snapshot && active && !failedRead && (
      <div className="active-search">
        <p>{snapshot.runtime.effective_session_state ?? session.state}{snapshot.active_object && ` · ${snapshot.active_object.name}`}</p>
        <Link href={`/sessions/${encodeURIComponent(session.id)}/live`}>Return to Active Search</Link>
      </div>
    )} priorityAction={(offerEmergency || emergency) && (
      <div className="emergency-bar">
        {offerEmergency && (
          <button className="button emergency-button" type="button"
            aria-disabled={emergency?.kind === "sending" || undefined}
            onClick={() => { void runtime?.emergency(); }}>
            <Octagon aria-hidden="true" size={20} /> Emergency Stop
          </button>
        )}
        <div role="status" className="emergency-feedback">
          {emergency && <EmergencyNotice feedback={emergency} />}
        </div>
      </div>
    )}>
      {children}
    </AppShell>
  );
}

function EmergencyNotice({ feedback }: { feedback: EmergencyFeedback }) {
  switch (feedback.kind) {
    case "sending": return <Notice title="Sending Emergency Stop request" />;
    case "unavailable": return <Notice title="Emergency Stop could not be confirmed" tone="danger">
      Press Emergency Stop again to retry the same request.
    </Notice>;
    case "api-error": return <Notice tone="danger" title={feedback.error.permission_revoked
      ? "Motion permission revoked · Emergency request rejected"
      : "Emergency Stop could not be confirmed"}>
      {feedback.error.code} · {feedback.error.message}
    </Notice>;
    case "result": {
      const result = feedback.response;
      const saving = result.persistence === "Failed" ? "Save failed" : result.persistence === "Pending" ? "Save pending" : "Saved";
      return <Notice title="Motion permission revoked" tone={result.persistence === "Failed" ? "danger" : "info"}>
        {result.session_id === null ? "No active session" : saving}
        {result.error && <> · {result.error.code} · {result.error.message}</>}
      </Notice>;
    }
  }
}
