"use client";

import { createContext, useCallback, useContext, useEffect, useState, useSyncExternalStore, type ReactNode } from "react";
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
const disconnected: RuntimeView = { ...unavailable, disconnected: true };
const noSubscription = () => () => {};
const initialView = () => loading;

export function RuntimeProvider({ openTransport, harnessEnabled = false, children }: {
  openTransport?: OpenTransport; harnessEnabled?: boolean; children: ReactNode;
}) {
  const [selection, setSelection] = useState<Selection>({ id: "idle", generation: 0 });
  const [current, setCurrent] = useState<Connection>();
  const [harness, setHarness] = useState<Harness>();
  const [failed, setFailed] = useState<number>();
  const select = useCallback((id: string) =>
    setSelection((previous) => ({ id, generation: previous.generation + 1 })), []);

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
  const runtime = connection?.runtime;
  useEffect(() => {
    if (!runtime) return;
    const wake = () => {
      if (document.visibilityState === "visible" && !runtime.getView().loading) void runtime.refresh({ readBootstrap: true });
    };
    window.addEventListener("focus", wake);
    window.addEventListener("online", wake);
    document.addEventListener("visibilitychange", wake);
    return () => {
      window.removeEventListener("focus", wake);
      window.removeEventListener("online", wake);
      document.removeEventListener("visibilitychange", wake);
    };
  }, [runtime]);
  const view = useSyncExternalStore(
    connection?.runtime.subscribe ?? noSubscription,
    connection?.runtime.getView ?? (!openTransport ? () => disconnected : failed === selection.generation ? () => unavailable : initialView),
    initialView,
  );

  return (
    <RuntimeContext value={{ connection, harnessEnabled, harness, selection, select }}>
      <RuntimeViewContext value={view}>{children}</RuntimeViewContext>
    </RuntimeContext>
  );
}

const RuntimeViewContext = createContext(loading);
export const useRuntimeView = () => useContext(RuntimeViewContext);
export const useRuntime = () => useContext(RuntimeContext);

export function useRefreshRuntime() {
  const state = useRuntime();
  const runtime = state?.connection?.runtime;
  const select = state?.select;
  const scenario = state?.selection.id;
  return useCallback(() => {
    if (runtime) void runtime.refresh();
    else if (scenario !== undefined) select?.(scenario);
  }, [runtime, scenario, select]);
}

export function useRuntimeRead<Path extends ProtectedPath>(path: Path, id?: string, enabled = true) {
  const load = useCallback((runtime: RuntimeProjection, signal: AbortSignal) => runtime.get(path, id, signal), [path, id]);
  return useApplicationRead(load, enabled).result;
}

export function useApplicationRead<T>(load: (runtime: RuntimeProjection, signal: AbortSignal) => Promise<ReadResult<T>>,
  enabled = true, waitForRuntime = false) {
  const runtime = useRuntime()?.connection?.runtime;
  const refresh = useRefreshRuntime();
  const { snapshot, connected, failedRead, loading } = useRuntimeView();
  const ready = connected && (!waitForRuntime || snapshot !== undefined || !loading);
  const [attempt, setAttempt] = useState(0);
  const [read, setRead] = useState<{
    runtime: RuntimeProjection; load: typeof load; attempt: number; result: ReadResult<T>; snapshot: RuntimeView["snapshot"];
  }>();

  useEffect(() => {
    if (!runtime || !ready || !enabled) return;
    const currentRuntime = runtime;
    const lifetime = new AbortController();
    function publish(result: ReadResult<T>) {
      if (!lifetime.signal.aborted) setRead({ runtime: currentRuntime, load, attempt, result, snapshot });
    }
    void load(currentRuntime, lifetime.signal).then(publish).catch(() => publish({ kind: "unavailable" }));
    return () => lifetime.abort();
  }, [runtime, load, attempt, snapshot, ready, enabled]);

  const current = enabled && read?.runtime === runtime && read?.load === load && read.attempt === attempt;
  const retry = useCallback(() => {
    if (connected) setAttempt((previous) => previous + 1);
    else refresh();
  }, [connected, refresh]);
  return {
    result: current ? read.result : connected ? undefined : failedRead,
    snapshotAtRead: current ? read.snapshot : undefined,
    retry,
  };
}
