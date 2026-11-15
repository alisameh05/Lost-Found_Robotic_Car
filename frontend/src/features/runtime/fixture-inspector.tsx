"use client";

import { useCallback, useState, useSyncExternalStore, type ComponentProps } from "react";
import { Panel } from "@/components/layout/panel";
import { ProtectedImage } from "@/components/media/protected-image";
import { Button } from "@/components/ui/button";
import { LoadingState, Notice } from "@/components/ui/feedback";
import type { RuntimeProjection } from "./projection";
import { useRuntime, useRuntimeView } from "./runtime-provider";
import { ControlSpecimens } from "./control-specimens";

export function FixtureInspector() {
  const state = useRuntime();
  const view = useRuntimeView();
  const { harness, selection, connection, select } = state ?? {};
  if (!harness || !selection || !select) return view.failedRead
    ? <Notice tone="danger" title="Fixture scenarios unavailable" role="alert" />
    : <LoadingState label="Loading fixture scenarios" />;

  return (
    <>
      <Panel aria-label="Development fixture controls">
        <div className="control-row">
          <label htmlFor="fixture-scenario">Fixture scenario</label>
          <select id="fixture-scenario" value={selection.id} onChange={(event) => select(event.target.value)}>
            {harness.scenarios.map(({ id, label }) => <option key={id} value={id}>{label}</option>)}
          </select>
          <Button onClick={() => select(selection.id)}>Reset scenario</Button>
        </div>
        {connection?.fixture && <FixtureRequests fixture={connection.fixture} />}
      </Panel>
      {connection?.fixture && (view.snapshot || view.failedRead) && (
        <ControlSpecimens key={selection.generation} operations={connection.fixture} media={
          <MediaInspector runtime={connection.runtime} expire={connection.fixture.expire} mediaExamples={harness.mediaExamples} />
        } />
      )}
    </>
  );
}

type RuntimeContext = NonNullable<ReturnType<typeof useRuntime>>;
type Fixture = NonNullable<NonNullable<RuntimeContext["connection"]>["fixture"]>;
const emptyRequests = () => emptyRequestList;
const emptyRequestList = [] as const;

function FixtureRequests({ fixture }: { fixture: Fixture }) {
  const requests = useSyncExternalStore(fixture.subscribeRequests, fixture.readRequests, emptyRequests);
  return (
    <details>
      <summary>Fixture mutation requests ({requests.length})</summary>
      <ol aria-label="Fixture mutation requests">
        {requests.map(({ route, body }, index) => (
          <li key={index}>{route}{body !== undefined && <code> {JSON.stringify(body)}</code>}</li>
        ))}
      </ol>
    </details>
  );
}

type MediaExamples = NonNullable<RuntimeContext["harness"]>["mediaExamples"];

function MediaInspector({ runtime, expire, mediaExamples }: {
  runtime: RuntimeProjection; expire: () => void; mediaExamples: MediaExamples;
}) {
  const [selected, setSelected] = useState<string>(mediaExamples[0].id);
  const [revision, setRevision] = useState(0);
  const example = mediaExamples.find(({ id }) => id === selected) ?? mediaExamples[0];
  const load = useCallback<ComponentProps<typeof ProtectedImage>["load"]>(async (signal) => {
    const result = await runtime.media(selected, signal);
    if (result.kind === "ok") {
      const { bytes, headers } = result.data;
      return { kind: "ok", image: new Blob([bytes], { type: headers["Content-Type"] }) };
    }
    if (result.kind === "unavailable") return { kind: "unavailable", detail: "Sample media request unavailable." };
    const { code, message } = result.error;
    if (code === "EXPIRED") return { kind: "expired", detail: message };
    const kind = code === "MEDIA_UNAVAILABLE" ? example.failure ?? "unavailable" : "unavailable";
    return { kind, detail: message };
  }, [runtime, selected, example]);
  return (
    <>
      <div className="control-row">
        <label htmlFor="fixture-media">Sample media</label>
        <select id="fixture-media" value={selected} onChange={(event) => setSelected(event.target.value)}>
          {mediaExamples.map(({ id, name }) => <option key={id} value={id}>{name}</option>)}
        </select>
        <Button onClick={() => { expire(); setRevision(revision + 1); }}>Expire sample media</Button>
      </div>
      <ProtectedImage
        key={revision} load={load} label={`Sample image · ${example.label}`}
        alt="Synthetic fixture image" width={160} height={120}
      />
    </>
  );
}
