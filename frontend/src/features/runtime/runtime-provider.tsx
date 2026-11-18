"use client";

import { createContext, useCallback, useContext, useEffect, useState, useSyncExternalStore, type ReactNode } from "react";
import { usePathname } from "next/navigation";
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

export function RuntimeProvider({ openTransport, harnessEnabled = false, recordsMode = false, children }: {
  openTransport?: OpenTransport; harnessEnabled?: boolean; recordsMode?: boolean; children: ReactNode;
}) {
  const pathname = usePathname();
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
      runtime = openRuntimeProjection(transport, recordsMode);
      setHarness(harness);
      setCurrent({ runtime, fixture, generation: selection.generation });
      void runtime.refresh();
    }).catch(() => { if (!disposed) setFailed(selection.generation); });
    return () => { disposed = true; runtime?.dispose(); };
  }, [openTransport, recordsMode, selection]);

  const connection = current?.generation === selection.generation ? current : undefined;
  const runtime = connection?.runtime;
  useEffect(() => {
    if (!runtime) return;
    const wake = () => {
      if (document.visibilityState === "visible" && !runtime.getView().loading) {
        void runtime.refresh(recordsMode ? { revalidate: true } : { readBootstrap: true });
      }
    };
    const visibility = () => {
      if (recordsMode && document.visibilityState === "hidden") runtime.suspendRecords();
      else wake();
    };
    const suspend = () => runtime.suspendRecords();
    const restore = (event: PageTransitionEvent) => { if (event.persisted) wake(); };
    let lastPoll = Date.now();
    let lastTick = performance.now();
    const poll = recordsMode ? setInterval(() => {
      const wall = Date.now();
      const tick = performance.now();
      const clockChanged = Math.abs((wall - lastPoll) - (tick - lastTick)) > 2_000;
      const resumed = tick - lastTick > 8_000;
      lastPoll = wall;
      lastTick = tick;
      if (document.visibilityState === "visible") {
        if (clockChanged || resumed) wake();
        else void runtime.refresh({ background: true });
      }
    }, 4_000) : undefined;
    window.addEventListener("focus", wake);
    window.addEventListener("online", wake);
    document.addEventListener("visibilitychange", visibility);
    if (recordsMode) {
      window.addEventListener("pageshow", restore);
      window.addEventListener("pagehide", suspend);
      document.addEventListener("freeze", suspend);
      document.addEventListener("resume", wake);
    }
    return () => {
      clearInterval(poll);
      window.removeEventListener("focus", wake);
      window.removeEventListener("online", wake);
      document.removeEventListener("visibilitychange", visibility);
      window.removeEventListener("pageshow", restore);
      window.removeEventListener("pagehide", suspend);
      document.removeEventListener("freeze", suspend);
      document.removeEventListener("resume", wake);
    };
  }, [recordsMode, runtime]);
  useEffect(() => {
    if (recordsMode && pathname && runtime && !runtime.getView().loading) void runtime.refresh();
  }, [pathname, recordsMode, runtime]);
  const view = useSyncExternalStore(
    connection?.runtime.subscribe ?? noSubscription,
    connection?.runtime.getView ?? (!openTransport ? () => disconnected : failed === selection.generation ? () => unavailable : initialView),
    initialView,
  );

  return (
    <RuntimeContext value={{ connection, harnessEnabled, harness, selection, select }}>
      <RuntimeViewContext value={recordsMode && !view.recordsMode ? { ...view, recordsMode } : view}>{children}</RuntimeViewContext>
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

function ownerRemoved(record: unknown, removed: ReadonlySet<string>) {
  if (!record || typeof record !== "object") return false;
  if ("object_id" in record && typeof record.object_id === "string") return removed.has(record.object_id);
  return "registered_at_ms" in record && "id" in record && typeof record.id === "string" && removed.has(record.id);
}

function eligibleRead<T>(result: ReadResult<T>, removed?: ReadonlySet<string>): ReadResult<T> | undefined {
  if (result.kind !== "ok" || !removed?.size) return result;
  const data = result.data;
  if (ownerRemoved(data, removed)) return;
  if (data && typeof data === "object" && "items" in data && Array.isArray(data.items)) {
    const items = data.items.filter((item) => !ownerRemoved(item, removed));
    if (items.length !== data.items.length) return { ...result, data: { ...data, items } };
  }
  return result;
}

export function useApplicationRead<T>(load: (runtime: RuntimeProjection, signal: AbortSignal) => Promise<ReadResult<T>>,
  enabled = true, waitForRuntime = false, allowCleanupRead = false) {
  const runtime = useRuntime()?.connection?.runtime;
  const refresh = useRefreshRuntime();
  const { authority, recordSnapshot: snapshot, connected, failedRead, loading, removedOwners } = useRuntimeView();
  const cleanupDiagnostic = allowCleanupRead && failedRead?.kind === "api-error" &&
    failedRead.error.snapshot !== null && failedRead.error.snapshot !== undefined &&
    failedRead.error.snapshot.retention.deletion.status !== "Complete";
  const ready = (connected || cleanupDiagnostic) && (!waitForRuntime || snapshot !== undefined || !loading);
  const [attempt, setAttempt] = useState(0);
  const [read, setRead] = useState<{
    runtime: RuntimeProjection; load: typeof load; attempt: number; result: ReadResult<T>;
    snapshot: RuntimeView["snapshot"]; authority: RuntimeView["authority"]; removedOwners: RuntimeView["removedOwners"];
  }>();
  let visibleRead = read;
  if (read && read.authority !== authority) visibleRead = undefined;
  else if (read && read.removedOwners !== removedOwners) {
    const result = eligibleRead(read.result, removedOwners);
    visibleRead = result && { ...read, result, removedOwners };
  }
  if (visibleRead !== read) setRead(visibleRead);

  useEffect(() => {
    if (!runtime || !ready || !enabled) return;
    const currentRuntime = runtime;
    const lifetime = new AbortController();
    function publish(result: ReadResult<T>) {
      const eligible = eligibleRead(result, removedOwners);
      const currentView = currentRuntime.getView();
      if (!lifetime.signal.aborted && eligible &&
          currentView.authority === authority && currentView.removedOwners === removedOwners) {
        setRead({ runtime: currentRuntime, load, attempt, result: eligible, snapshot, authority, removedOwners });
      }
    }
    void load(currentRuntime, lifetime.signal).then(publish).catch((error: unknown) => {
      if (!(error instanceof DOMException && error.name === "AbortError")) publish({ kind: "unavailable" });
    });
    return () => lifetime.abort();
  }, [runtime, load, attempt, snapshot, authority, removedOwners, ready, enabled]);

  const current = ready && enabled && visibleRead && visibleRead.runtime === runtime && visibleRead.load === load &&
    visibleRead.attempt === attempt ? visibleRead : undefined;
  const retry = useCallback(() => {
    if (ready) setAttempt((previous) => previous + 1);
    else refresh();
  }, [ready, refresh]);
  return {
    result: current?.result ?? (ready ? undefined : failedRead),
    snapshotAtRead: current?.snapshot,
    retry,
  };
}
