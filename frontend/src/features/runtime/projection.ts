import type { EmergencyStopRequest, EmergencyStopResponse, FrontendProfile, Health, RetentionChange, RetentionPreviewRequest, Snapshot } from "@/generated/api-v1";
import { compatibleProfile } from "@/lib/fixture-contracts";
import type { ApplicationTransport, HttpRequest, ProtectedPath, ProtectedRequest, ReadEndpoint, ReadParams, ReadResult } from "@/lib/transport";
import { openWorkspace, type WorkspaceView } from "./workspace";

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
  removedOwners?: ReadonlySet<string>;
  profile?: FrontendProfile;
  workspace?: WorkspaceView;
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
  let workspace: ReturnType<typeof openWorkspace> | undefined;

  function serverTime() {
    if (clock && !lifetime.signal.aborted) return clock.server + Math.ceil(performance.now() - clock.received);
  }

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
        const bootstrapStarted = performance.now();
        const bootstrap = await transport.bootstrap(signal);
        if (signal.aborted) return;
        if (bootstrap.kind !== "ok") {
          workspace?.dispose();
          workspace = undefined;
          context = undefined;
          clock = undefined;
          update({ loading: false, failedRead: bootstrap, health: undefined, snapshot: undefined, connected: false,
            profile: undefined, workspace: undefined });
          return;
        }
        const candidate = bootstrap.data.qualification_profile;
        const profile = compatibleProfile(candidate) ? candidate : undefined;
        const sameAuthority = context?.backend_boot_id === bootstrap.data.backend_boot_id &&
          context.client_id === bootstrap.data.client_id && context.capability === bootstrap.data.capability;
        const sameProfile = sameAuthority && JSON.stringify(profile) === JSON.stringify(view.profile);
        if (!sameProfile) {
          workspace?.dispose();
          workspace = undefined;
        }
        context = bootstrap.data;
        clock = { server: bootstrap.data.server_time_ms, received: bootstrapStarted };
        update({ connected: true, profile: sameProfile ? view.profile : profile,
          ...(!sameProfile && { workspace: undefined }), ...(!sameAuthority && { snapshot: undefined, removedOwners: undefined }) });
      }
      const request = { context, signal };
      const unavailable = () => ({ kind: "unavailable" } as const);
      const [status, health] = await Promise.all([
        transport.snapshot(request).catch(unavailable),
        transport.request("GET /health", request).catch(unavailable),
      ]);
      if (signal.aborted) return;
      const eventsLive = view.workspace?.eventsLive;
      update({
        snapshot: eventsLive ? view.snapshot : status.kind === "ok" ? status.data : view.snapshot,
        failedRead: status.kind === "ok" || eventsLive ? undefined : status,
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
        workspace?.release("Control was released by Emergency Stop.");
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

  let refreshQueued = false;
  const unsubscribeRetention = transport.subscribeRetention?.((owners) => {
    if (owners?.length) {
      // Immediately suppress data from protected reads that were already in flight.
      update({ removedOwners: new Set([...view.removedOwners ?? [], ...owners]) });
    }
    if (refreshQueued) return;
    refreshQueued = true;
    queueMicrotask(() => { refreshQueued = false; void refresh({ readBootstrap: true }); });
  });

  return {
    getView: () => view,
    subscribe(notify: () => void) {
      subscribers.add(notify);
      return () => { subscribers.delete(notify); };
    },
    refresh,
    emergency,
    serverTime,
    mountWorkspace(robot: HTMLCanvasElement, webcam?: HTMLCanvasElement) {
      if (!context || !view.profile || lifetime.signal.aborted) return () => {};
      workspace?.dispose();
      const active = openWorkspace({
        transport, context, profile: view.profile, robot, webcam, serverTime,
        update: (observation) => update({ workspace: observation }),
        snapshot: (next, removedOwner) => update({ snapshot: next, failedRead: undefined,
          ...(removedOwner && { removedOwners: new Set([...view.removedOwners ?? [], removedOwner]) }) }),
        recover: () => {
          update({ snapshot: undefined, failedRead: { kind: "unavailable" } });
          void refresh({ readBootstrap: true });
        },
      });
      workspace = active;
      return () => {
        active.dispose();
        if (workspace !== active) return;
        workspace = undefined;
        update({ workspace: undefined });
        queueMicrotask(() => { void refresh(); });
      };
    },
    acquireWorkspace: () => workspace?.acquire(),
    releaseWorkspace: () => workspace?.release(),
    async register(action: RegistrationAction, signal: AbortSignal) {
      if (!context) return { kind: "unavailable" } as const;
      return transport.request("POST /objects", { ...action, context, signal: AbortSignal.any([signal, lifetime.signal]) });
    },
    async previewRetention(body: RetentionPreviewRequest, signal: AbortSignal) {
      if (!context) return { kind: "unavailable" } as const;
      return transport.request("POST /settings/retention-preview", { body, context, signal: AbortSignal.any([signal, lifetime.signal]) });
    },
    async applyRetention(body: RetentionChange, signal: AbortSignal) {
      if (!context) return { kind: "unavailable" } as const;
      return transport.request("PUT /settings/retention", { body, context, signal: AbortSignal.any([signal, lifetime.signal]) });
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
      workspace?.dispose();
      lifetime.abort();
      unsubscribeRetention?.();
      subscribers.clear();
      transport.dispose();
    },
  };
}

export type RuntimeProjection = ReturnType<typeof openRuntimeProjection>;
export type { EmergencyFeedback, RuntimeView };
