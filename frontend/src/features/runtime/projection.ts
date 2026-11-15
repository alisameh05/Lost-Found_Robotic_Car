import type { EmergencyStopRequest, EmergencyStopResponse, Health, Snapshot } from "@/generated/api-v1";
import type { ApplicationTransport, HttpRequest, ProtectedPath, ProtectedRequest, ReadEndpoint, ReadParams, ReadResult } from "@/lib/transport";

type EmergencyFeedback =
  | { kind: "sending" }
  | { kind: "result"; status: number; response: EmergencyStopResponse }
  | Exclude<ReadResult<never>, { kind: "ok" }>;

type RuntimeView = {
  disconnected?: boolean;
  snapshot?: Snapshot;
  failedRead?: Exclude<ReadResult<never>, { kind: "ok" }>;
  loading: boolean;
  connected?: boolean;
  health?: Health;
  emergency?: EmergencyFeedback;
};

export type RegistrationAction = Pick<HttpRequest<"POST /objects">, "body" | "actionCreatedAtMs">;

export function openRuntimeProjection(transport: ApplicationTransport) {
  const lifetime = new AbortController();
  const subscribers = new Set<() => void>();
  let view: RuntimeView = { loading: true };
  let context: ProtectedRequest["context"] | undefined;
  let clock: { server: number; received: number } | undefined;
  let readRequest: AbortController | undefined;
  let uncertainRequest: EmergencyStopRequest | undefined;

  function acknowledgedSnapshot(response: EmergencyStopResponse) {
    const snapshot = view.snapshot;
    if (!snapshot || response.backend_boot_id !== snapshot.backend_boot_id ||
        response.session_id === null || response.session_id !== snapshot.active_session?.id) return snapshot;
    return { ...snapshot, runtime: { ...snapshot.runtime, effective_session_state: "Paused", motion_permission: "Disarmed",
      persistence_pending: response.persistence === "Pending" } } satisfies Snapshot;
  }

  function update(changes: Partial<RuntimeView>) {
    if (lifetime.signal.aborted) return;
    view = { ...view, ...changes };
    for (const notify of subscribers) notify();
  }

  async function refresh({ readBootstrap = false } = {}) {
    if (lifetime.signal.aborted) return;
    readRequest?.abort();
    readRequest = new AbortController();
    const signal = AbortSignal.any([lifetime.signal, readRequest.signal]);
    update({ loading: true });
    try {
      if (!context || readBootstrap) {
        const bootstrap = await transport.bootstrap(signal);
        if (signal.aborted) return;
        if (bootstrap.kind !== "ok") {
          update({ loading: false, failedRead: bootstrap, health: undefined });
          return;
        }
        context = bootstrap.data;
        clock = { server: bootstrap.data.server_time_ms, received: performance.now() };
        update({ connected: true });
      }
      const request = { context, signal };
      const unavailable = () => ({ kind: "unavailable" } as const);
      const [status, health] = await Promise.all([
        transport.snapshot(request).catch(unavailable),
        transport.request("GET /health", request).catch(unavailable),
      ]);
      if (signal.aborted) return;
      update({
        snapshot: status.kind === "ok" ? status.data : view.snapshot,
        failedRead: status.kind === "ok" ? undefined : status,
        health: health.kind === "ok" ? health.data : undefined,
        loading: false,
      });
    } catch {
      if (!signal.aborted) update({ loading: false, failedRead: { kind: "unavailable" }, health: undefined });
    }
  }

  async function emergency() {
    if (!context || lifetime.signal.aborted || view.emergency?.kind === "sending") return;
    const request = { context, signal: lifetime.signal };
    const body = uncertainRequest ?? { request_id: crypto.randomUUID() };
    uncertainRequest = body;
    update({ emergency: { kind: "sending" } });
    try {
      const result = await transport.emergency(body, request);
      if (result.kind === "ok" && result.data.request_id === body.request_id &&
          result.data.backend_boot_id === request.context.backend_boot_id) {
        uncertainRequest = undefined;
        update({ emergency: { kind: "result", status: result.status, response: result.data }, snapshot: acknowledgedSnapshot(result.data) });
        void refresh();
      } else if (result.kind === "api-error") {
        uncertainRequest = undefined;
        update({ emergency: result });
        if (result.error.permission_revoked) void refresh();
      } else {
        update({ emergency: { kind: "unavailable" } });
      }
    } catch {
      update({ emergency: { kind: "unavailable" } });
    }
  }

  return {
    getView: () => view,
    subscribe(notify: () => void) {
      subscribers.add(notify);
      return () => { subscribers.delete(notify); };
    },
    refresh,
    emergency,
    serverTime() {
      if (clock && !lifetime.signal.aborted) return clock.server + Math.floor(performance.now() - clock.received);
    },
    async register(action: RegistrationAction, signal: AbortSignal) {
      if (!context) return { kind: "unavailable" } as const;
      return transport.request("POST /objects", { ...action, context, signal: AbortSignal.any([signal, lifetime.signal]) });
    },
    async get<Path extends ProtectedPath>(path: Path, id: string | undefined, signal: AbortSignal) {
      if (!context) return { kind: "unavailable" } as const;
      return transport.get(path, { id, context, signal: AbortSignal.any([signal, lifetime.signal]) });
    },
    async read<Route extends ReadEndpoint>(route: Route, params: ReadParams<Route>, signal: AbortSignal) {
      if (!context) return { kind: "unavailable" } as const;
      // GET routes have no body. Keep the protected context at the runtime boundary.
      const request = { ...params, context, signal: AbortSignal.any([signal, lifetime.signal]) } as HttpRequest<Route>;
      return transport.request(route, request);
    },
    async media(id: string, signal: AbortSignal) {
      if (!context) return { kind: "unavailable" } as const;
      return transport.media(id, { context, signal: AbortSignal.any([signal, lifetime.signal]) });
    },
    dispose() {
      lifetime.abort();
      subscribers.clear();
      transport.dispose();
    },
  };
}

export type RuntimeProjection = ReturnType<typeof openRuntimeProjection>;
export type { EmergencyFeedback, RuntimeView };
