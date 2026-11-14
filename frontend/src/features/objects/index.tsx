"use client";

import { notFound } from "next/navigation";
import { DataUnavailable, Preview, PreviewLinks } from "@/components/layout/preview";
import { DataFeedback, LoadingState } from "@/components/ui/feedback";
import { useRuntimeRead } from "@/features/runtime";

export function ObjectLibraryScreen() {
  const objects = useRuntimeRead("/objects");
  if (objects && objects.kind !== "ok") return <DataUnavailable />;

  return (
    <Preview title="Objects / History" description="Browse the sample links. Search, filters and saved history are planned for a later phase.">
      {objects ? <>
        <PreviewLinks links={[
          { href: "/objects/new", label: "Preview registration" },
          ...objects.data.items.map((object) => ({ href: `/objects/${object.id}`, label: object.name })),
        ]} />
        {!objects.data.items.length && <DataFeedback state="empty" detail="The fixture returned no objects." />}
      </> : <LoadingState label="Loading sample objects" />}
    </Preview>
  );
}

export function ObjectDetailsScreen({ objectId }: { objectId: string }) {
  const object = useRuntimeRead("/objects/{id}", objectId);
  const sessions = useRuntimeRead("/objects/{id}/sessions", objectId, object?.kind === "ok");
  if (object?.kind === "api-error" && object.status === 404) notFound();
  const expired = object?.kind === "api-error" && object.error.code === "EXPIRED" ? object.error : undefined;
  if ((object && object.kind !== "ok" && !expired) || (sessions && sessions.kind !== "ok" && !expired)) return <DataUnavailable />;

  return (
    <Preview title="Object Details" description="Reference imagery and complete record details are planned for a later phase.">
      {expired ? <DataFeedback state="expired" detail={expired.message} />
        : object?.kind === "ok" && sessions?.kind === "ok" ? <>
          <section className="panel"><h2>Sample object</h2><p>{object.data.name} · {object.data.status}</p></section>
          <PreviewLinks links={[
            { href: `/objects/${object.data.id}/search`, label: "Preview Search Setup" },
            ...sessions.data.items.map((session) => ({ href: `/sessions/${session.id}`, label: "Sample search session" })),
          ]} />
        </> : <LoadingState label="Loading sample object" />}
    </Preview>
  );
}
