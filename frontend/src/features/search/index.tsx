"use client";

import { notFound } from "next/navigation";
import { DataUnavailable, Preview, PreviewLinks } from "@/components/layout/preview";
import { DataFeedback, LoadingState } from "@/components/ui/feedback";
import { useRuntimeRead, useRuntimeView } from "@/features/runtime";
export { SearchSetupScreen } from "./search-setup";

const sessionPreviews = {
  live: { title: "Search Workspace", description: "Camera feeds and manual controls are planned for a later phase." },
  result: { title: "Search Result", description: "Evidence review and recorded outcomes are planned for a later phase." },
};

export function SessionScreen({ sessionId, view }: { sessionId: string; view: keyof typeof sessionPreviews }) {
  const { snapshot, removedOwners } = useRuntimeView();
  const active = view === "live" && snapshot?.active_session?.id === sessionId ? snapshot.active_session : undefined;
  const result = useRuntimeRead("/sessions/{id}", sessionId, !active);
  const candidate = active ?? (result?.kind === "ok" ? result.data : undefined);
  const removed = candidate && removedOwners?.has(candidate.object_id);
  const session = removed ? undefined : candidate;
  if (!session && result?.kind === "api-error" && result.status === 404) notFound();
  const expired = result?.kind === "api-error" && result.error.code === "EXPIRED" ? result.error : undefined;
  if (!session && result && !expired && !removed) return <DataUnavailable />;
  const base = `/sessions/${encodeURIComponent(sessionId)}`;
  return (
    <Preview {...sessionPreviews[view]}>
      {session ? <>
        <section className="panel">
          <h2>Sample session</h2>
          <p>Committed session · {session.state}</p>
          {view === "live" && active && snapshot && (
            <p>Effective state · {snapshot.runtime.effective_session_state} · {snapshot.runtime.motion_permission}</p>
          )}
          {view === "live" && snapshot?.active_session === null && <p>No active search</p>}
        </section>
        <PreviewLinks links={[
          { href: `/objects/${session.object_id}`, label: "View sample object" },
          { href: base, label: "Back to Session Details" },
          ...(view === "live" ? [] : [{ href: `${base}/live`, label: "Preview Search Workspace" }]),
          ...(view === "result" ? [] : [{ href: `${base}/result`, label: "Preview Search Result" }]),
        ]} />
      </> : expired || removed ? <DataFeedback state="expired" detail={expired?.message} />
        : <LoadingState label="Loading sample session" />}
    </Preview>
  );
}
