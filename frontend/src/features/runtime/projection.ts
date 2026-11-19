import type { EmergencyStopRequest, EmergencyStopResponse, FrontendProfile, Health, RetentionChange, RetentionPreviewRequest, Snapshot } from "@/generated/api-v1";
import { compatibleProfile } from "@/lib/fixture-contracts";
import { pendingReview } from "@/lib/match-evidence";
import type { ApplicationTransport, HttpRequest, ProtectedPath, ProtectedRequest, ReadEndpoint, ReadParams, ReadResult } from "@/lib/transport";
import { conforms } from "@/lib/wire-contracts";
import { openWorkspace, reconnectDelay, type WorkspaceView } from "./workspace";
import { openSearchActions, searchActionKey, type SearchFeedback, type SearchIntent, unresolved } from "./search-actions";
import { validSnapshot, withoutRemovedOwners } from "./workspace-events";

type EmergencyFeedback =
  | { kind: "sending" }
  | { kind: "result"; status: number; response: EmergencyStopResponse }
  | Exclude<ReadResult<never>, { kind: "ok" }>;

type RuntimeView = {
  disconnected?: boolean;
  recordsMode?: boolean;
  snapshot?: Snapshot;
  recordSnapshot?: Snapshot;
  recordPoll?: number;
  failedRead?: Exclude<ReadResult<never>, { kind: "ok" }>;
  loading: boolean;
  connected?: boolean;
  health?: Health;
  emergency?: EmergencyFeedback;
  removedOwners?: ReadonlySet<string>;
  removedSessionId?: string;
  profile?: FrontendProfile;
  workspace?: WorkspaceView;
  searchActions?: Readonly<Record<string, SearchFeedback>>;
  authority?: number;
  cursorAuthority?: number;
  recovering?: boolean;
  reconnectingSessionId?: string;
};

export type RegistrationAction = Pick<HttpRequest<"POST /objects">, "body" | "actionCreatedAtMs">;

export function openRuntimeProjection(transport: ApplicationTransport, recordsMode = false) {
  const lifetime = new AbortController();
  const subscribers = new Set<() => void>();
  let view: RuntimeView = { loading: true, recordsMode };
  let context: ProtectedRequest["context"] | undefined;
  let clock: { server: number; received: number } | undefined;
  let readRequest: AbortController | undefined;
  let protectedScope = new AbortController();
  let recordReads = new AbortController();
  const mediaReads = new Set<{ ownerId: string; controller: AbortController }>();
  let lastActiveSearch: { sessionId: string; objectId: string; sequence: number; grace: boolean } | undefined;
  let recoveryTimer: ReturnType<typeof setTimeout> | undefined;
  let recoveryDelay = 250;
  let uncertainRequest: EmergencyStopRequest | undefined;
  let workspace: ReturnType<typeof openWorkspace> | undefined;
  let surface: HTMLElement | undefined;
  let handoffTimer: ReturnType<typeof setTimeout> | undefined;
  const searchActions = openSearchActions({ transport, signal: lifetime.signal,
    removed: (objectId, sessionId) => removeRecords([objectId], sessionId),
    notify: (feedback) => update({ searchActions: feedback }), refresh: (code) => {
      if (code === "REVISION_CONFLICT") workspace?.resynchronize();
      else void refresh();
    } });

  function serverTime() {
    if (clock && !lifetime.signal.aborted) {
      const elapsed = performance.now() - clock.received;
      return clock.server + (recordsMode ? Math.floor(elapsed) : Math.ceil(elapsed));
    }
  }

  function acknowledgedSnapshot(response: EmergencyStopResponse) {
    const snapshot = view.snapshot;
    if (!snapshot || response.backend_boot_id !== snapshot.backend_boot_id ||
        response.session_id === null || response.session_id !== snapshot.active_session?.id) return snapshot;
    return { ...snapshot, runtime: { ...snapshot.runtime, effective_session_state: "Paused", motion_permission: "Disarmed",
      persistence_pending: snapshot.runtime.persistence_pending || response.persistence === "Pending" } } satisfies Snapshot;
  }

  function update(changes: Partial<RuntimeView>) {
    if (lifetime.signal.aborted) return;
    view = { ...view, ...changes };
    for (const notify of subscribers) notify();
  }

  function reconcileEmergency(snapshot: Snapshot) {
    const feedback = view.emergency;
    if (feedback?.kind !== "result" || feedback.response.persistence !== "Pending" ||
        feedback.response.backend_boot_id !== snapshot.backend_boot_id) return;
    const response = feedback.response;
    const receipt = snapshot.operations.find(({ request_id }) => request_id === response.request_id);
    if (receipt?.persistence === "Failed") {
      update({ emergency: { kind: "result", status: 503, response: { ...response, persistence: "Failed", error: receipt.error } } });
    } else if ((receipt?.persistence === "Committed" && receipt.result.session?.id === response.session_id &&
        receipt.result.session.pause_causes.some(({ failure_id }) => failure_id === response.failure_id)) ||
        (response.session_id === snapshot.active_session?.id && snapshot.active_session?.pause_causes.some(
          ({ failure_id }) => failure_id === response.failure_id))) {
      update({ emergency: { kind: "result", status: 200, response: { ...response, persistence: "Committed", error: null } } });
    }
  }

  function clearRecordsView(loading: boolean) {
    resetProtectedScope();
    update({ connected: false, snapshot: undefined, recordSnapshot: undefined, failedRead: undefined, loading,
      authority: (view.authority ?? 0) + 1 });
  }

  function loseRecordsAuthority() {
    workspace?.dispose();
    workspace = undefined;
    surface = undefined;
    context = undefined;
    clock = undefined;
    resetProtectedScope();
    update({ loading: false, connected: false, health: undefined, snapshot: undefined, recordSnapshot: undefined,
      removedOwners: undefined, profile: undefined, workspace: undefined, failedRead: { kind: "unavailable" },
      authority: (view.authority ?? 0) + 1, cursorAuthority: (view.cursorAuthority ?? 0) + 1 });
  }

  async function refresh({ readBootstrap = false, revalidate = false, background = false, renewClock = false } = {}) {
    if (lifetime.signal.aborted || (background && readRequest)) return;
    readRequest?.abort();
    const controller = new AbortController();
    readRequest = controller;
    const signal = AbortSignal.any([lifetime.signal, controller.signal]);
    if (recordsMode && revalidate && !workspace) {
      clearRecordsView(true);
    } else if (!recordsMode || !view.connected) update({ loading: true });
    try {
      if (!context || renewClock || (readBootstrap && !recordsMode)) {
        const bootstrapStarted = performance.now();
        const bootstrap = await transport.bootstrap(signal);
        const bootstrapReceived = performance.now();
        if (signal.aborted) return;
        if (bootstrap.kind !== "ok") {
          if (renewClock && context) return;
          if (view.recovering) {
            update({ loading: false, failedRead: bootstrap });
            retryBootstrap();
            return;
          }
          workspace?.dispose();
          workspace = undefined;
          resetProtectedScope();
          context = undefined;
          clock = undefined;
          update({ loading: false, failedRead: bootstrap, health: undefined, snapshot: undefined, recordSnapshot: undefined, connected: false,
            profile: undefined, workspace: undefined, authority: (view.authority ?? 0) + 1 });
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
        const authorityChanged = !sameAuthority && context !== undefined;
        if (authorityChanged) {
          resetProtectedScope();
          searchActions.changeAuthority();
          uncertainRequest = undefined;
          lastActiveSearch = undefined;
        }
        context = bootstrap.data;
        clock = { server: bootstrap.data.server_time_ms, received: recordsMode ? bootstrapReceived : bootstrapStarted };
        update({ connected: !recordsMode, profile: sameProfile ? view.profile : profile,
          ...(!sameProfile && { workspace: undefined }), ...(!sameAuthority && { snapshot: undefined, recordSnapshot: undefined,
            removedOwners: undefined, removedSessionId: undefined,
            emergency: undefined, authority: (view.authority ?? 0) + 1,
            cursorAuthority: (view.cursorAuthority ?? 0) + 1 }),
          ...(authorityChanged && { recovering: true,
            reconnectingSessionId: view.snapshot?.active_session?.id ?? view.reconnectingSessionId }) });
      }
      const request = { context, signal };
      const unavailable = () => ({ kind: "unavailable" } as const);
      const [status, health] = await Promise.all([
        transport.snapshot(request).catch(unavailable),
        transport.request("GET /health", request).catch(unavailable),
      ]);
      if (signal.aborted) return;
      if (recordsMode && (invalidAuthority(status) || invalidAuthority(health))) {
        loseRecordsAuthority();
        retryBootstrap();
        return;
      }
      const ordered = workspace !== undefined;
      const next = status.kind === "ok" && validSnapshot(status.data, request.context.backend_boot_id)
        ? withoutRemovedOwners(status.data, view.removedOwners) : undefined;
      if (next && !ordered) {
        observeActiveSearch(next);
        searchActions.synchronize(next, request.context);
        reconcileEmergency(next);
      }
      const diagnostics = health.kind === "ok" && health.data.backend_boot_id === request.context.backend_boot_id
        ? health.data : undefined;
      if (recordsMode && (!next || diagnostics?.storage_integrity !== "Healthy")) {
        const deletionSnapshot = status.kind === "api-error" && status.error.code === "STORAGE_UNAVAILABLE"
          ? status.error.snapshot : undefined;
        const cleanup = deletionSnapshot?.backend_boot_id === request.context.backend_boot_id &&
          deletionSnapshot.retention.deletion.status !== "Complete" ? deletionSnapshot : undefined;
        const recordSnapshot = cleanup && !recordsChanged(view.recordSnapshot, cleanup)
          ? view.recordSnapshot : cleanup;
        if (view.connected) resetProtectedScope();
        update({ connected: false, snapshot: undefined, recordSnapshot, health: diagnostics, loading: false,
          failedRead: status.kind === "api-error" ? status : unavailable(),
          ...(cleanup && background && { recordPoll: (view.recordPoll ?? 0) + 1 }),
          ...(view.connected && { authority: (view.authority ?? 0) + 1 }) });
        return;
      }
      const retentionChanged = recordsMode && next && view.recordSnapshot &&
        view.recordSnapshot.retention.settings.revision !== next.retention.settings.revision;
      if (retentionChanged) resetProtectedScope();
      const refreshRecords = !recordsMode || (next && (
        view.recordSnapshot?.event_seq !== next.event_seq || recordsChanged(view.recordSnapshot, next)
      ));
      update({
        snapshot: ordered ? view.snapshot : next ?? view.snapshot,
        recordSnapshot: ordered || !refreshRecords ? view.recordSnapshot : next ?? view.recordSnapshot,
        failedRead: next || view.workspace?.eventsLive ? undefined : status.kind === "ok" ? unavailable() : status,
        health: diagnostics,
        ...(recordsMode && { connected: true }),
        ...(retentionChanged && { authority: (view.authority ?? 0) + 1 }),
        ...(recordsMode && background && { recordPoll: (view.recordPoll ?? 0) + 1 }),
        loading: false,
        ...(next && !ordered && { recovering: false, reconnectingSessionId: undefined }),
      });
      if (view.recovering && !next) retryBootstrap();
      else if (next && !ordered) recoveryComplete();
    } catch {
      if (!signal.aborted) {
        if (recordsMode) clearRecordsView(false);
        update({ loading: false, failedRead: { kind: "unavailable" }, health: undefined });
        if (view.recovering) retryBootstrap();
      }
    } finally {
      if (readRequest === controller) readRequest = undefined;
    }
  }

  function invalidAuthority(result: ReadResult<unknown>) {
    return result.kind === "api-error" && (result.error.code === "CAPABILITY_INVALID" || result.error.code === "CLIENT_INVALID");
  }

  function retryBootstrap() {
    clearTimeout(recoveryTimer);
    recoveryTimer = setTimeout(() => void refresh({ readBootstrap: true }), reconnectDelay(recoveryDelay));
    recoveryDelay = Math.min(5_000, recoveryDelay * 2);
  }

  function recoveryComplete() {
    clearTimeout(recoveryTimer);
    recoveryDelay = 250;
  }

  function resetProtectedScope() {
    protectedScope.abort();
    protectedScope = new AbortController();
  }

  function observeActiveSearch(snapshot: Snapshot) {
    const session = snapshot.active_session;
    if (session) {
      lastActiveSearch = { sessionId: session.id, objectId: session.object_id,
        sequence: snapshot.event_seq, grace: snapshot.retention.active_object_grace };
      return;
    }
    if (!lastActiveSearch) return;
    const { sessionId, sequence, grace } = lastActiveSearch;
    const saved = snapshot.operations.some(({ result }) => result?.session?.id === sessionId && result.session.state === "Ended");
    // A terminal checkpoint may arrive immediately before removal at the cutoff.
    if (saved || (!grace && snapshot.event_seq > sequence + 1)) lastActiveSearch = undefined;
  }

  function removeRecords(owners: readonly string[], sessionId?: string) {
    const previous = view.removedOwners;
    const active = view.snapshot?.active_session;
    const search = active ? { objectId: active.object_id, sessionId: active.id } : lastActiveSearch;
    const saved = !active && search && (["confirm", "stop"] as const).some((kind) => {
      const action = view.searchActions?.[searchActionKey(kind, search.sessionId)];
      return action?.stage === "committed" && action.session?.id === search.sessionId;
    });
    const removedSessionId = sessionId ?? (!saved && search && owners.includes(search.objectId) ? search.sessionId : undefined);
    if (lastActiveSearch && owners.includes(lastActiveSearch.objectId)) lastActiveSearch = undefined;
    if (owners.every((id) => previous?.has(id)) && (!removedSessionId || removedSessionId === view.removedSessionId)) return;
    recordReads.abort();
    recordReads = new AbortController();
    for (const { ownerId, controller } of mediaReads) if (owners.includes(ownerId)) controller.abort();
    const removedOwners = new Set([...previous ?? [], ...owners]);
    const snapshot = view.snapshot;
    const recordSnapshot = view.recordSnapshot;
    const emergency = view.emergency;
    // Publish the filtered snapshot and action feedback together.
    view = { ...view, removedOwners,
      ...(removedSessionId && { removedSessionId }),
      ...(removedSessionId === view.reconnectingSessionId && { reconnectingSessionId: undefined }),
      ...(emergency?.kind === "result" && emergency.response.session_id === removedSessionId && { emergency: undefined }),
      snapshot: snapshot && withoutRemovedOwners(snapshot, removedOwners),
      recordSnapshot: recordSnapshot && withoutRemovedOwners(recordSnapshot, removedOwners),
    };
    searchActions.purge(owners);
  }

  async function protectedRead<T>(signal: AbortSignal, load: (request: ProtectedRequest) => Promise<ReadResult<T>>,
    scope = recordReads.signal) {
    if (!context) return { kind: "unavailable" } as const;
    const scoped = AbortSignal.any([signal, scope, protectedScope.signal, lifetime.signal]);
    const result = await load({ context, signal: scoped });
    scoped.throwIfAborted();
    if (recordsMode && invalidAuthority(result)) {
      loseRecordsAuthority();
      void refresh();
      scoped.throwIfAborted();
    }
    return result;
  }

  async function emergency() {
    if (!context || lifetime.signal.aborted || view.emergency?.kind === "sending") return;
    const request = { context, signal: AbortSignal.any([protectedScope.signal, lifetime.signal]) };
    const generation = view.snapshot?.runtime.control_generation;
    const ownerId = view.snapshot?.active_session?.object_id;
    const body = uncertainRequest ?? { request_id: crypto.randomUUID() };
    uncertainRequest = body;
    update({ emergency: { kind: "sending" } });
    try {
      const result = await transport.emergency(body, request);
      if (request.signal.aborted) return;
      if (result.kind === "ok" && conforms("EmergencyStopResponse", result.data) && result.data.request_id === body.request_id &&
          result.data.backend_boot_id === request.context.backend_boot_id) {
        uncertainRequest = undefined;
        if ((ownerId && view.removedOwners?.has(ownerId)) ||
            (result.data.session_id !== null && result.data.session_id === view.removedSessionId)) {
          update({ emergency: undefined });
          return;
        }
        const unchanged = view.snapshot?.runtime.control_generation === generation;
        if (unchanged) workspace?.clearControl("Control was released by Emergency Stop.");
        update({ emergency: { kind: "result", status: result.status, response: result.data },
          ...(unchanged && { snapshot: acknowledgedSnapshot(result.data) }) });
        if (view.snapshot) reconcileEmergency(view.snapshot);
        void refresh();
      } else if (result.kind === "api-error") {
        uncertainRequest = undefined;
        update({ emergency: result });
        if (result.error.permission_revoked) void refresh();
      } else {
        update({ emergency: { kind: "unavailable" } });
      }
    } catch {
      if (!request.signal.aborted) update({ emergency: { kind: "unavailable" } });
    }
  }

  let refreshQueued = false;
  const unsubscribeRetention = transport.subscribeRetention?.((owners) => {
    if (owners?.length) removeRecords(owners);
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
    suspendRecords() {
      readRequest?.abort();
      clearRecordsView(false);
    },
    emergency,
    serverTime,
    clearRemovedResult(sessionId: string) {
      if (view.removedSessionId === sessionId) update({ removedSessionId: undefined });
    },
    mountWorkspace(robot: HTMLElement, webcam?: HTMLElement, sessionId?: string) {
      if (!context || !view.profile || lifetime.signal.aborted) return () => {};
      clearTimeout(handoffTimer);
      const reusable = sessionId && workspace?.canHandOff(sessionId) ? workspace : undefined;
      if (!reusable) workspace?.dispose();
      const active = reusable ?? openWorkspace({
        transport, context, profile: view.profile, serverTime, connectedBackend: recordsMode,
        update: (observation) => update({ workspace: observation }),
        snapshot: (next, removedOwner) => {
          if (removedOwner) removeRecords([removedOwner]);
          next = withoutRemovedOwners(next, view.removedOwners);
          observeActiveSearch(next);
          const refreshRecords = removedOwner || view.recovering || recordsChanged(view.snapshot, next);
          recoveryComplete();
          update({ snapshot: next, failedRead: undefined, recovering: false, reconnectingSessionId: undefined,
            ...(refreshRecords && { recordSnapshot: next }) });
          if (context) searchActions.synchronize(next, context);
          reconcileEmergency(next);
        },
        recover: () => {
          update({ recovering: true, reconnectingSessionId: view.snapshot?.active_session?.id,
            ...(recordsMode && { snapshot: undefined }) });
          searchActions.suspend();
          if (!recordsMode) resetProtectedScope();
          if (view.emergency?.kind === "sending") update({ emergency: { kind: "unavailable" } });
          void refresh({ readBootstrap: true });
        },
      });
      workspace = active;
      surface = robot;
      active.mount(robot, webcam, sessionId);
      function unmount() {
        if (workspace !== active || surface !== robot) return;
        active.dispose();
        workspace = undefined;
        surface = undefined;
        update({ workspace: undefined });
        queueMicrotask(() => { void refresh(); });
      }
      return () => {
        if (surface === robot && active.canHandOff()) {
          handoffTimer = setTimeout(unmount, view.profile?.heartbeat_deadline_ms ?? 0);
        } else unmount();
      };
    },
    acquireWorkspace: () => workspace?.acquire(),
    releaseWorkspace: () => workspace?.release(),
    submitSearch(intent: SearchIntent) {
      if (recordsMode && intent.kind !== "start" && intent.kind !== "pause" && intent.kind !== "stop") return;
      const state = view.snapshot;
      if (!context || !workspace || !state || !view.workspace?.eventsLive) return;
      const active = state.active_session;
      const id = intent.kind === "start" ? intent.object.id : intent.sessionId;
      const key = searchActionKey(intent.kind, id);
      if (unresolved(view.searchActions?.[key])) return;
      const scope = workspace.actionScope(intent.kind === "start" ? null : id);
      if (!scope) return;
      if (intent.kind === "start") {
        if (active || !view.workspace.previewLive || !view.workspace.usable || !state.readiness.can_start[intent.mode] ||
            intent.object.status !== "Lost" || intent.object.retention_grace ||
            (serverTime() ?? Infinity) >= intent.object.expires_at_ms) return;
        const body = { ...scope, action_id: crypto.randomUUID(), object_id: id,
          expected_revision: intent.object.revision, control_mode: intent.mode };
        workspace.expectStart(body);
        return searchActions.submit(key, body, context, id);
      }
      if (active?.id !== id || (intent.kind === "resume" && (!state.readiness.can_resume ||
          !view.workspace.previewLive || !view.workspace.usable))) return;
      const body = { ...scope, action_id: crypto.randomUUID(), session_id: id, expected_revision: active.revision };
      if (intent.kind === "acknowledge") {
        const action = { ...body, action: intent.kind, failure_ids: intent.failureIds };
        if (!conforms("SessionAction", action) || !intent.failureIds.every((id) =>
          state.failures.some((failure) => failure.session_id === active.id && failure.failure_id === id))) return;
        return searchActions.submit(key, action, context, active.object_id);
      }
      if (intent.kind === "confirm" || intent.kind === "reject") {
        const candidate = state.pending_candidate;
        if (!pendingReview(state, candidate) || candidate.id !== intent.candidateId ||
            unresolved(view.searchActions?.[searchActionKey("confirm", id)]) ||
            unresolved(view.searchActions?.[searchActionKey("reject", id)]) ||
            (intent.kind === "confirm" && candidate.evidence_media.availability !== "Available")) return;
        return searchActions.submit(key, { ...body, action: intent.kind, candidate_id: candidate.id }, context, active.object_id);
      }
      return searchActions.submit(key, { ...body, action: intent.kind }, context, active.object_id);
    },
    retrySearch(kind: SearchIntent["kind"], id: string) {
      if (context && view.workspace?.eventsLive) return searchActions.retry(searchActionKey(kind, id), context);
    },
    async register(action: RegistrationAction, signal: AbortSignal) {
      if (!context) return { kind: "unavailable" } as const;
      const result = await transport.request("POST /objects", { ...action, context, signal: AbortSignal.any([signal, lifetime.signal]) });
      if (recordsMode && invalidAuthority(result)) void refresh({ readBootstrap: true });
      if (recordsMode && result.kind === "api-error" && result.error.code === "ACTION_EXPIRED") {
        await refresh({ renewClock: true });
      }
      return result;
    },
    async previewRetention(body: RetentionPreviewRequest, signal: AbortSignal) {
      return protectedRead(signal, (request) => transport.request("POST /settings/retention-preview", { ...request, body }));
    },
    async applyRetention(body: RetentionChange, signal: AbortSignal) {
      if (!context) return { kind: "unavailable" } as const;
      const result = await transport.request("PUT /settings/retention", { body, context,
        signal: AbortSignal.any([signal, lifetime.signal]) });
      if (recordsMode && invalidAuthority(result)) {
        loseRecordsAuthority();
        void refresh();
      } else if (recordsMode && result.kind === "ok" && result.data.persistence === "Committed" &&
          result.data.action_id === body.action_id) {
        void refresh({ revalidate: true });
      }
      return result;
    },
    async get<Path extends ProtectedPath>(path: Path, id: string | undefined, signal: AbortSignal) {
      return protectedRead(signal, (request) => transport.get(path, { ...request, id }));
    },
    async read<Route extends ReadEndpoint>(route: Route, params: ReadParams<Route>, signal: AbortSignal) {
      // GET routes have no body. Keep the protected context at the runtime boundary.
      return protectedRead(signal, (request) => transport.request(route, { ...params, ...request } as HttpRequest<Route>));
    },
    async media(id: string, signal: AbortSignal, ownerId: string) {
      const load = (request: ProtectedRequest) => transport.media(id, request);
      if (view.removedOwners?.has(ownerId)) return { kind: "unavailable" } as const;
      const read = { ownerId, controller: new AbortController() };
      mediaReads.add(read);
      try {
        return await protectedRead(signal, load, read.controller.signal);
      } finally {
        mediaReads.delete(read);
      }
    },
    dispose() {
      clearTimeout(handoffTimer);
      clearTimeout(recoveryTimer);
      workspace?.dispose();
      lifetime.abort();
      searchActions.clear();
      unsubscribeRetention?.();
      subscribers.clear();
      transport.dispose();
    },
  };
}

function recordsChanged(before: Snapshot | undefined, after: Snapshot) {
  const session = after.active_session;
  const object = after.active_object;
  const previousObject = before?.active_object;
  return !before || before.active_session?.id !== session?.id || before.active_session?.revision !== session?.revision ||
    previousObject?.id !== object?.id || previousObject?.revision !== object?.revision ||
    previousObject?.expires_at_ms !== object?.expires_at_ms || previousObject?.retention_grace !== object?.retention_grace ||
    before.pending_candidate?.id !== after.pending_candidate?.id ||
    before.retention.settings.revision !== after.retention.settings.revision ||
    before.retention.deletion.status !== after.retention.deletion.status ||
    before.retention.deletion.remaining_objects !== after.retention.deletion.remaining_objects ||
    before.retention.deletion.remaining_files !== after.retention.deletion.remaining_files ||
    before.operations.length !== after.operations.length ||
    after.operations.some((operation) => operation.persistence === "Committed" && !before.operations.some((previous) =>
      previous.action_id === operation.action_id && previous.request_id === operation.request_id && previous.persistence === "Committed"));
}

export type RuntimeProjection = ReturnType<typeof openRuntimeProjection>;
export type { EmergencyFeedback, RuntimeView };
