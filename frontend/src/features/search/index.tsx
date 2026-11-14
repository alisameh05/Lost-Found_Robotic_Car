"use client";

import { notFound } from "next/navigation";
import { DataUnavailable, Preview, PreviewLinks } from "@/components/layout/preview";
import { DataFeedback, LoadingState } from "@/components/ui/feedback";
import { useRuntimeRead, useRuntimeView } from "@/features/runtime";

export function SearchSetupScreen({ objectId }: { objectId: string }) {
  const object = useRuntimeRead("/objects/{id}", objectId);
  if (object?.kind === "api-error" && object.status === 404) notFound();
  if (object && object.kind !== "ok") return <DataUnavailable />;

  return (
    <Preview title="Search Setup" description="Target setup, mode selection and starting a search are planned for a later phase.">
      {object ? <>
        <section className="panel"><h2>Sample target</h2><p>{object.data.name}</p></section>
        <PreviewLinks links={[{ href: `/objects/${object.data.id}`, label: "Back to Object Details" }]} />
      </> : <LoadingState label="Loading sample target" />}
    </Preview>
  );
}

const sessionPreviews = {
  details: { title: "Session Details", description: "Session history and saved evidence are planned for a later phase." },
  live: { title: "Search Workspace", description: "Camera feeds and manual controls are planned for a later phase." },
  result: { title: "Search Result", description: "Evidence review and recorded outcomes are planned for a later phase." },
};

export function SessionScreen({ sessionId, view }: { sessionId: string; view: keyof typeof sessionPreviews }) {
  const { snapshot } = useRuntimeView();
  const active = view === "live" && snapshot?.active_session?.id === sessionId ? snapshot.active_session : undefined;
  const result = useRuntimeRead("/sessions/{id}", sessionId, !active);
  const session = active ?? (result?.kind === "ok" ? result.data : undefined);
  if (!session && result?.kind === "api-error" && result.status === 404) notFound();
  const expired = result?.kind === "api-error" && result.error.code === "EXPIRED" ? result.error : undefined;
  if (!session && result && !expired) return <DataUnavailable />;
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
          ...(view === "details" ? [] : [{ href: base, label: "Back to Session Details" }]),
          ...(view === "live" ? [] : [{ href: `${base}/live`, label: "Preview Search Workspace" }]),
          ...(view === "result" ? [] : [{ href: `${base}/result`, label: "Preview Search Result" }]),
        ]} />
      </> : expired ? <DataFeedback state="expired" detail={expired.message} />
        : <LoadingState label="Loading sample session" />}
    </Preview>
  );
}
