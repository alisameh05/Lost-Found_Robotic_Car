import { notFound } from "next/navigation";
import { DataUnavailable, Preview, PreviewLinks } from "@/components/layout/preview";
import { readApplication } from "@/features/runtime";

export async function SearchSetupScreen({ objectId }: { objectId: string }) {
  const application = await readApplication();
  const object = await application.get("/objects/{id}", objectId);
  if (object.kind === "api-error" && object.status === 404) notFound();
  if (object.kind !== "ok") return <DataUnavailable />;

  return (
    <Preview title="Search Setup" description="Target setup, mode selection and starting a search are planned for a later phase.">
      <section className="panel"><h2>Sample target</h2><p>{object.data.name}</p></section>
      <PreviewLinks links={[{ href: `/objects/${object.data.id}`, label: "Back to Object Details" }]} />
    </Preview>
  );
}

const sessionPreviews = {
  details: { title: "Session Details", description: "Session history and saved evidence are planned for a later phase." },
  live: { title: "Search Workspace", description: "Camera feeds and manual controls are planned for a later phase." },
  result: { title: "Search Result", description: "Evidence review and recorded outcomes are planned for a later phase." },
};

export async function SessionScreen({ sessionId, view }: { sessionId: string; view: keyof typeof sessionPreviews }) {
  const application = await readApplication();
  const session = await application.get("/sessions/{id}", sessionId);
  if (session.kind === "api-error" && session.status === 404) notFound();
  if (session.kind !== "ok") return <DataUnavailable />;
  const snapshot = view === "live" ? await application.get("/snapshot") : null;
  if (snapshot && snapshot.kind !== "ok") return <DataUnavailable />;

  const base = `/sessions/${session.data.id}`;
  return (
    <Preview {...sessionPreviews[view]}>
      <section className="panel">
        <h2>Sample session</h2>
        <p>{session.data.state}</p>
        {snapshot?.data.active_session === null && <p>No active search</p>}
      </section>
      <PreviewLinks links={[
        { href: `/objects/${session.data.object_id}`, label: "View sample object" },
        ...(view === "details" ? [] : [{ href: base, label: "Back to Session Details" }]),
        ...(view === "live" ? [] : [{ href: `${base}/live`, label: "Preview Search Workspace" }]),
        ...(view === "result" ? [] : [{ href: `${base}/result`, label: "Preview Search Result" }]),
      ]} />
    </Preview>
  );
}
