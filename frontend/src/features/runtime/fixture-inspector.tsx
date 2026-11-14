"use client";

import { useCallback, useEffect, useState } from "react";
import { ProtectedImage } from "@/components/layout/protected-image";
import type { BootstrapResponse, Health, Snapshot } from "@/generated/api-v1";
import { createFixtureHarness } from "@/lib/create-transport";
import type { ApplicationTransport, ReadResult } from "@/lib/transport";
import { RuntimeStatus } from "./status";

type Harness = Awaited<ReturnType<typeof createFixtureHarness>>;
type View = {
  transport: ApplicationTransport;
  context: BootstrapResponse;
  status: ReadResult<Snapshot>;
  health: ReadResult<Health>;
  expire: () => void;
};

export function FixtureInspector() {
  const [harness, setHarness] = useState<Harness>();
  const [failed, setFailed] = useState(false);
  const [selection, setSelection] = useState<{ id: string; generation: number }>();
  useEffect(() => {
    let disposed = false;
    void createFixtureHarness().then((value) => {
      if (!disposed) {
        setHarness(value);
        setSelection({ id: value.defaultScenario, generation: 0 });
      }
    }).catch(() => {
      if (!disposed) setFailed(true);
    });
    return () => { disposed = true; };
  }, []);

  if (!harness || !selection) return failed ? <p role="alert">Fixture scenarios unavailable</p> : <p role="status">Loading fixture scenarios</p>;
  return (
    <>
      <section className="panel" aria-label="Development fixture controls">
        <label htmlFor="fixture-scenario">Fixture scenario</label>{" "}
        <select id="fixture-scenario" value={selection.id} onChange={(event) =>
          setSelection({ id: event.target.value, generation: selection.generation + 1 })}>
          {harness.scenarios.map(({ id, label }) => <option key={id} value={id}>{label}</option>)}
        </select>{" "}
        <button type="button" onClick={() => setSelection({ ...selection, generation: selection.generation + 1 })}>Reset scenario</button>
      </section>
      <ScenarioView key={selection.generation} harness={harness} id={selection.id} />
    </>
  );
}

function ScenarioView({ harness, id }: { harness: Harness; id: string }) {
  const [view, setView] = useState<View>();
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    const lifetime = new AbortController();
    const { transport, expire } = harness.open(id);

    async function load() {
      const bootstrap = await transport.bootstrap(lifetime.signal);
      if (bootstrap.kind !== "ok") {
        if (!lifetime.signal.aborted) setFailed(true);
        return;
      }
      const request = { context: bootstrap.data, signal: lifetime.signal };
      const [status, health] = await Promise.all([transport.snapshot(request), transport.request("GET /health", request)]);
      if (!lifetime.signal.aborted) setView({ transport, context: bootstrap.data, status, health, expire });
    }

    void load().catch(() => {
      if (!lifetime.signal.aborted) setFailed(true);
    });
    return () => { lifetime.abort(); transport.dispose(); };
  }, [harness, id]);

  if (!view) return failed ? <p role="alert">Fixture bootstrap unavailable</p> : <p role="status">Loading fixture snapshot</p>;
  return (
    <>
      <RuntimeStatus status={view.status} health={view.health} />
      <MediaInspector view={view} mediaExamples={harness.mediaExamples} />
    </>
  );
}

function MediaInspector({ view, mediaExamples }: { view: View; mediaExamples: Harness["mediaExamples"] }) {
  const [selected, setSelected] = useState<string>(mediaExamples[0].id);
  const [revision, setRevision] = useState(0);
  const example = mediaExamples.find(({ id }) => id === selected) ?? mediaExamples[0];
  const load = useCallback((signal: AbortSignal) => view.transport.media(selected, { context: view.context, signal }), [view, selected]);
  return (
    <section className="panel" aria-labelledby="media-preview">
      <h2 id="media-preview">Sample media preview</h2>
      <label htmlFor="fixture-media">Sample media</label>{" "}
      <select id="fixture-media" value={selected} onChange={(event) => setSelected(event.target.value)}>
        {mediaExamples.map(({ id, name }) => <option key={id} value={id}>{name}</option>)}
      </select>{" "}
      <button type="button" onClick={() => { view.expire(); setRevision(revision + 1); }}>Expire sample media</button>
      <ProtectedImage key={revision} load={load} label={example.label} />
    </section>
  );
}
