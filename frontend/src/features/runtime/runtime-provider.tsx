"use client";

import { createContext, useContext, useEffect, useState, useSyncExternalStore, type ReactNode } from "react";
import type { HttpResponses } from "@/generated/api-v1";
import type { ApplicationTransport, ProtectedPath, ReadResult } from "@/lib/transport";
import type { createFixtureHarness } from "@/lib/create-transport";
import { openRuntimeProjection, type RuntimeProjection, type RuntimeView } from "./projection";

type Harness = Awaited<ReturnType<typeof createFixtureHarness>>;
type Fixture = ReturnType<Harness["open"]>;
type Selection = { id: string; generation: number };
type Connection = { runtime: RuntimeProjection; fixture?: Fixture; generation: number };
type OpenTransport = (id: string) => Promise<{ transport: ApplicationTransport; harness?: Harness; fixture?: Fixture }>;

const RuntimeContext = createContext<{
  connection?: Connection;
  harnessEnabled: boolean;
  harness?: Harness;
  selection: Selection;
  select: (id: string) => void;
} | null>(null);

const loading: RuntimeView = { loading: true };
const unavailable: RuntimeView = { loading: false, failedRead: { kind: "unavailable" } };
const noSubscription = () => () => {};
const initialView = () => loading;

export function RuntimeProvider({ openTransport, harnessEnabled = false, children }: {
  openTransport?: OpenTransport; harnessEnabled?: boolean; children: ReactNode;
}) {
  const [selection, setSelection] = useState<Selection>({ id: "idle", generation: 0 });
  const [current, setCurrent] = useState<Connection>();
  const [harness, setHarness] = useState<Harness>();
  const [failed, setFailed] = useState<number>();

  useEffect(() => {
    if (!openTransport) return;
    let disposed = false;
    let runtime: RuntimeProjection | undefined;

    void openTransport(selection.id).then(({ transport, harness, fixture }) => {
      if (disposed) {
        transport.dispose();
        return;
      }
      runtime = openRuntimeProjection(transport);
      setHarness(harness);
      setCurrent({ runtime, fixture, generation: selection.generation });
      void runtime.refresh();
    }).catch(() => { if (!disposed) setFailed(selection.generation); });
    return () => { disposed = true; runtime?.dispose(); };
  }, [openTransport, selection]);

  const connection = current?.generation === selection.generation ? current : undefined;
  const view = useSyncExternalStore(
    connection?.runtime.subscribe ?? noSubscription,
    connection?.runtime.getView ?? (!openTransport || failed === selection.generation ? () => unavailable : initialView),
    initialView,
  );

  return (
    <RuntimeContext value={{
      connection, harnessEnabled, harness, selection,
      select: (id) => setSelection((previous) => ({ id, generation: previous.generation + 1 })),
    }}>
      <RuntimeViewContext value={view}>{children}</RuntimeViewContext>
    </RuntimeContext>
  );
}

const RuntimeViewContext = createContext(loading);
export const useRuntimeView = () => useContext(RuntimeViewContext);
export const useRuntime = () => useContext(RuntimeContext);

export function useRuntimeRead<Path extends ProtectedPath>(path: Path, id?: string, enabled = true) {
  const runtime = useRuntime()?.connection?.runtime;
  const { snapshot, connected, failedRead } = useRuntimeView();
  const [read, setRead] = useState<{
    runtime: RuntimeProjection; path: Path; id?: string; result: ReadResult<HttpResponses[`GET ${Path}`]>;
  }>();

  useEffect(() => {
    if (!runtime || !connected || !enabled) return;
    const currentRuntime = runtime;
    const lifetime = new AbortController();
    function publish(result: ReadResult<HttpResponses[`GET ${Path}`]>) {
      if (!lifetime.signal.aborted) setRead({ runtime: currentRuntime, path, id, result });
    }
    void currentRuntime.get(path, id, lifetime.signal).then(publish).catch(() => publish({ kind: "unavailable" }));
    return () => lifetime.abort();
  }, [runtime, path, id, snapshot, connected, enabled]);

  if (enabled && read && read.runtime === runtime && read.path === path && read.id === id) return read.result;
  return connected ? undefined : failedRead;
}
