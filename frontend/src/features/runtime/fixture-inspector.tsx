"use client";

import { useCallback, useEffect, useState, type ComponentProps } from "react";
import { Panel } from "@/components/layout/panel";
import { ProtectedImage } from "@/components/media/protected-image";
import { Button } from "@/components/ui/button";
import { LoadingState, Notice } from "@/components/ui/feedback";
import type { BootstrapResponse, Health, Snapshot } from "@/generated/api-v1";
import { createFixtureHarness } from "@/lib/create-transport";
import type { ApplicationTransport, ReadResult } from "@/lib/transport";
import { RuntimeStatus } from "./status";
import { ControlSpecimens } from "./control-specimens";

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

  if (!harness || !selection) return failed
    ? <Notice tone="danger" title="Fixture scenarios unavailable" role="alert" />
    : <LoadingState label="Loading fixture scenarios" />;
  return (
    <>
      <Panel aria-label="Development fixture controls">
        <div className="control-row">
          <label htmlFor="fixture-scenario">Fixture scenario</label>
          <select id="fixture-scenario" value={selection.id} onChange={(event) =>
            setSelection({ id: event.target.value, generation: selection.generation + 1 })}>
            {harness.scenarios.map(({ id, label }) => <option key={id} value={id}>{label}</option>)}
          </select>
          <Button onClick={() => setSelection({ ...selection, generation: selection.generation + 1 })}>Reset scenario</Button>
        </div>
      </Panel>
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

  if (!view) return failed
    ? <Notice title="Fixture bootstrap unavailable" tone="danger" role="alert" />
    : <LoadingState label="Loading fixture snapshot" />;
  return (
    <>
      <ControlSpecimens open={harness.openControls} media={<MediaInspector view={view} mediaExamples={harness.mediaExamples} />} />
      <RuntimeStatus status={view.status} health={view.health} />
    </>
  );
}

function MediaInspector({ view, mediaExamples }: { view: View; mediaExamples: Harness["mediaExamples"] }) {
  const [selected, setSelected] = useState<string>(mediaExamples[0].id);
  const [revision, setRevision] = useState(0);
  const example = mediaExamples.find(({ id }) => id === selected) ?? mediaExamples[0];
  const load = useCallback<ComponentProps<typeof ProtectedImage>["load"]>(async (signal) => {
    const result = await view.transport.media(selected, { context: view.context, signal });
    if (result.kind === "ok") {
      const { bytes, headers } = result.data;
      return { kind: "ok", image: new Blob([bytes], { type: headers["Content-Type"] }) };
    }
    if (result.kind === "unavailable") return { kind: "unavailable", detail: "Sample media request unavailable." };
    const { code, message } = result.error;
    if (code === "EXPIRED") return { kind: "expired", detail: message };
    // The harness supplies presentation labels for its known unavailable examples.
    const kind = code === "MEDIA_UNAVAILABLE" ? example.failure ?? "unavailable" : "unavailable";
    return { kind, detail: message };
  }, [view, selected, example]);
  return (
    <>
      <div className="control-row">
        <label htmlFor="fixture-media">Sample media</label>
        <select id="fixture-media" value={selected} onChange={(event) => setSelected(event.target.value)}>
          {mediaExamples.map(({ id, name }) => <option key={id} value={id}>{name}</option>)}
        </select>
        <Button onClick={() => { view.expire(); setRevision(revision + 1); }}>Expire sample media</Button>
      </div>
      <ProtectedImage
        key={revision} load={load} label={`Sample image · ${example.label}`}
        alt="Synthetic geometric swatch" width={160} height={120}
      />
    </>
  );
}
