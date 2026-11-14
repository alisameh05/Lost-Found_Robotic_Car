import { notFound } from "next/navigation";
import { DataUnavailable, Preview, PreviewLinks } from "@/components/layout/preview";
import { readApplication } from "@/features/runtime";

export async function ObjectLibraryScreen() {
  const application = await readApplication();
  const objects = await application.get("/objects");
  if (objects.kind !== "ok") return <DataUnavailable />;

  return (
    <Preview title="Objects / History" description="Browse the sample links. Search, filters and saved history are planned for a later phase.">
      <PreviewLinks links={[
        { href: "/objects/new", label: "Preview registration" },
        ...objects.data.items.map((object) => ({ href: `/objects/${object.id}`, label: object.name })),
      ]} />
    </Preview>
  );
}

export async function ObjectDetailsScreen({ objectId }: { objectId: string }) {
  const application = await readApplication();
  const object = await application.get("/objects/{id}", objectId);
  if (object.kind === "api-error" && object.status === 404) notFound();
  if (object.kind !== "ok") return <DataUnavailable />;
  const sessions = await application.get("/objects/{id}/sessions", objectId);
  if (sessions.kind !== "ok") return <DataUnavailable />;

  return (
    <Preview title="Object Details" description="Reference imagery and complete record details are planned for a later phase.">
      <section className="panel"><h2>Sample object</h2><p>{object.data.name} · {object.data.status}</p></section>
      <PreviewLinks links={[
        { href: `/objects/${object.data.id}/search`, label: "Preview Search Setup" },
        ...sessions.data.items.map((session) => ({ href: `/sessions/${session.id}`, label: "Sample search session" })),
      ]} />
    </Preview>
  );
}
