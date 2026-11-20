import type { Channel, EventEnvelope, FrontendProfile, LeaseAcquire, LeaseRelease, LeaseResponse, Snapshot, StartRequest } from "@/generated/api-v1";
import { LOCAL_GESTURES_PROFILE } from "@/lib/config";
import { conforms } from "@/lib/fixture-contracts";
import { openFrameDisplay } from "@/lib/frame-display";
import {
  socketOffer, type ApplicationTransport, type ClientContext, type EventSocket, type ProtectedRequest, type ReadResult,
  type ReadSocket, type SocketOffer,
} from "@/lib/transport";
import { projectWorkspaceEvent, validSnapshot } from "./workspace-events";

export type WorkspaceView = {
  eventsLive: boolean;
  previewLive: boolean;
  webcamLive: boolean;
  controlling: boolean;
  usable: boolean;
  acquiring: boolean;
  resynchronizing?: boolean;
  retryAcquisition?: boolean;
  releasing?: boolean;
  retryRelease?: boolean;
  releaseNotice?: string;
  message?: string;
};

export function reconnectDelay(backoff: number) {
  return Math.min(5_000, Math.round(backoff * (1 + Math.random() * 0.2)));
}

function readChannel<Socket extends ReadSocket>({
  transport, context, channel, connect, lost, calibrate,
}: {
  transport: ApplicationTransport;
  context: ClientContext;
  channel: Channel;
  connect(request: ProtectedRequest, offer: SocketOffer, closed: () => void): ReadResult<Socket>;
  lost(): void;
  calibrate?(issuedAtMs: number, requestedAt: number): void;
}) {
  let scope: AbortController | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let socket: Socket | undefined;
  let disposed = false;
  let backoff = 250;
  let stableTimer: ReturnType<typeof setTimeout> | undefined;

  function disconnect() {
    const connection = scope;
    scope = undefined;
    clearTimeout(stableTimer);
    stableTimer = undefined;
    connection?.abort();
    socket?.close();
    socket = undefined;
  }

  function reconnect() {
    if (disposed || !scope) return;
    disconnect();
    lost();
    if (disposed) return;
    timer = setTimeout(open, reconnectDelay(backoff));
    backoff = Math.min(5_000, backoff * 2);
  }

  async function open() {
    if (disposed) return;
    const connection = new AbortController();
    scope = connection;
    const request = { context, signal: connection.signal };
    const closed = () => { if (scope === connection) reconnect(); };
    try {
      if (!navigator.onLine) { closed(); return; }
      const requestedAt = performance.now();
      const ticket = await transport.request("POST /websocket-tickets", { ...request, body: { client_id: context.client_id, channel } });
      if (scope !== connection) return;
      if (ticket.kind !== "ok" || !conforms("TicketResponse", ticket.data)) { closed(); return; }
      // The v1 ticket expiry is exactly ten seconds after issuance.
      calibrate?.(ticket.data.expires_at_ms - 10_000, requestedAt);
      const result = connect(request, socketOffer(channel, ticket.data.ticket), closed);
      if (result.kind !== "ok") { closed(); return; }
      if (scope !== connection) { result.data.close(); return; }
      if (result.data.protocol !== "laf.v1") { result.data.close(); closed(); return; }
      socket = result.data;
    } catch {
      closed();
    }
  }

  void open();
  return {
    current: () => socket,
    healthy() {
      // A snapshot followed immediately by another fault is still a retry streak.
      stableTimer ??= setTimeout(() => { backoff = 250; }, 5_000);
    },
    reconnect,
    dispose() { disposed = true; clearTimeout(timer); disconnect(); },
  };
}

function matchesProfile(state: Snapshot, profile: FrontendProfile) {
  return state.qualification_profile_id === profile.profile_id && Object.entries(profile)
    .every(([key, value]) => state.qualification_profile?.[key as keyof FrontendProfile] === value);
}

export function openEventStream({
  transport, context, profile, apply, recover,
}: {
  transport: ApplicationTransport;
  context: ClientContext;
  profile: FrontendProfile;
  apply(value: Snapshot, event: EventEnvelope): void;
  recover(): void;
}) {
  let state: Snapshot | undefined;
  let previous: Snapshot | undefined;
  const events = readChannel<EventSocket>({
    transport, context, channel: "events",
    lost() {
      previous = state ?? previous;
      state = undefined;
      recover();
    },
    connect: (request, offer, closed) => transport.connectEvents(request, offer, {
      closed,
      message(event) {
        if (request.signal?.aborted) return;
        const next = projectWorkspaceEvent(state ?? previous, event, context.backend_boot_id, !state);
        if (!next || !matchesProfile(next, profile)) {
          events.reconnect();
          return;
        }
        if (next === state) return;
        previous = undefined;
        state = next;
        events.healthy();
        apply(next, event);
      },
    }),
  });
  return events;
}

export function openWorkspace({
  transport, context, profile, serverTime, update, snapshot, recover, connectedBackend = false,
}: {
  transport: ApplicationTransport;
  context: ClientContext;
  profile: FrontendProfile;
  connectedBackend?: boolean;
  serverTime(): number | undefined;
  update(view: WorkspaceView): void;
  snapshot(value: Snapshot, event: EventEnvelope): void;
  recover(): void;
}) {
  const robot = document.createElement("canvas");
  robot.setAttribute("role", "img");
  robot.setAttribute("aria-label", connectedBackend ? "Simulated robot camera view" : "Fixture robot camera view");
  const webcam = document.createElement("canvas");
  webcam.setAttribute("role", "img");
  webcam.setAttribute("aria-label", profile.profile_id === LOCAL_GESTURES_PROFILE
    ? "Mirrored webcam preview and recognition" : "Fixture laptop webcam view");
  let view: WorkspaceView = { eventsLive: false, previewLive: false, webcamLive: false, controlling: false, usable: false, acquiring: false };
  let state: Snapshot | undefined;
  let disposed = false;
  let lease: { secret: string; generation: number; session: string | null; sequence: number } | undefined;
  let offeredLease: { lease: NonNullable<typeof lease>; watermark: number } | undefined;
  let acquisition: LeaseAcquire | undefined;
  let intent = 0;
  let heartbeatTimer: ReturnType<typeof setInterval> | undefined;
  let pendingRelease: Promise<ReadResult<LeaseResponse>> | undefined;
  let retainedRelease: LeaseRelease | undefined;
  let start: Pick<StartRequest, "action_id" | "object_id" | "control_mode"> | undefined;
  let handoffSession: string | undefined;
  let waitingForWorkspace = false;
  let awaitingDraw = false;

  function report(changes: Partial<WorkspaceView>) {
    if (disposed || !Object.entries(changes).some(([key, value]) => view[key as keyof WorkspaceView] !== value)) return;
    view = { ...view, ...changes };
    update(view);
  }

  function usable() {
    const bounds = robot.getBoundingClientRect();
    return navigator.onLine && document.visibilityState === "visible" && document.hasFocus() &&
      robot.isConnected && robot.checkVisibility({ visibilityProperty: true, opacityProperty: true }) &&
      bounds.width > 0 && bounds.height > 0 && robot.getContext("2d", { alpha: false })?.isContextLost() === false;
  }

  function forgetLease() {
    lease = undefined;
    clearInterval(heartbeatTimer);
    report({ controlling: false });
  }

  function releaseBody(current: NonNullable<typeof lease>): LeaseRelease {
    return { request_id: crypto.randomUUID(), client_id: context.client_id, client_lease_id: current.secret,
      session_id: current.session, control_generation: current.generation };
  }

  function sendRelease(body: LeaseRelease): Promise<ReadResult<LeaseResponse>> {
    const channel = events.current();
    return transport.request("POST /control-lease/release", { body, context }).then<ReadResult<LeaseResponse>>((result) => {
      if (!connectedBackend && (disposed || !channel || events.current() !== channel)) return { kind: "unavailable" };
      if (result.kind === "ok" && (!conforms("LeaseResponse", result.data) || result.data.request_id !== body.request_id ||
          result.data.client_lease_id !== null)) {
        return { kind: "unavailable" };
      }
      return result;
    }).catch(() => ({ kind: "unavailable" as const }));
  }

  function clearControl(message?: string) {
    intent++;
    acquisition = undefined;
    offeredLease = undefined;
    start = undefined;
    handoffSession = undefined;
    waitingForWorkspace = false;
    const hadControl = lease !== undefined;
    forgetLease();
    report({ acquiring: false, retryAcquisition: false, ...(message && hadControl && { message }) });
  }

  function release(message?: string) {
    const current = lease ?? offeredLease?.lease;
    const body = current ? releaseBody(current) : retainedRelease;
    clearControl(message);
    if (!connectedBackend) return body ? sendRelease(body) : undefined;
    if (!body || pendingRelease) return pendingRelease;
    retainedRelease = body;
    report({ releasing: true, retryRelease: false, releaseNotice: undefined });
    pendingRelease = sendRelease(body).then((result) => {
      pendingRelease = undefined;
      const unconfirmed = result.kind === "unavailable" || (result.kind === "api-error" && result.error.retryable);
      const retryRelease = unconfirmed && !releaseObserved(body);
      retainedRelease = retryRelease ? body : undefined;
      report({ releasing: false, retryRelease, releaseNotice: retryRelease ? "Control release is unconfirmed."
        : result.kind === "api-error" && result.error.code !== "LEASE_EXPIRED" ? result.error.message : undefined });
      return result;
    });
    return pendingRelease;
  }

  function releaseObserved(body: LeaseRelease) {
    return !!state && (state.lease.owner_client_id !== context.client_id ||
      state.lease.control_generation !== body.control_generation);
  }

  function matchesAuthority(next: Snapshot, current: NonNullable<typeof lease>) {
    return next.lease.owner_client_id === context.client_id && next.lease.control_generation === current.generation &&
      next.runtime.control_generation === current.generation && (next.active_session?.id ?? null) === current.session;
  }

  function applySnapshot(next: Snapshot, event: EventEnvelope) {
    state = next;
    if (retainedRelease && view.retryRelease && releaseObserved(retainedRelease)) {
      retainedRelease = undefined;
      report({ retryRelease: false, releaseNotice: undefined });
    }
    const active = next.active_session;
    const accepted = start && next.operations.find((operation) => operation.action_id === start?.action_id &&
      operation.persistence === "Committed" && operation.result.session?.id === active?.id);
    if (lease && lease.session === null && active && accepted && active.object_id === start?.object_id &&
        active.control_mode === start.control_mode && next.lease.owner_client_id === context.client_id &&
        next.lease.control_generation >= lease.generation && next.lease.control_generation === next.runtime.control_generation) {
      lease = { ...lease, session: active.id, generation: next.lease.control_generation };
      handoffSession = active.id;
      waitingForWorkspace = true;
    } else if (lease && active?.id === lease.session && next.lease.owner_client_id === context.client_id &&
        next.lease.control_generation > lease.generation) {
      // A consecutive owner snapshot can advance permission scope without transferring the lease.
      lease = { ...lease, generation: next.lease.control_generation };
      awaitingDraw = true;
      robotVideo.forgetPresentation();
    }
    if (lease && !matchesAuthority(next, lease)) {
      clearControl("Control was released. Acquire control again when available.");
    }
    snapshot(next, event);
    if (offeredLease && next.event_seq >= offeredLease.watermark) {
      const offered = offeredLease.lease;
      offeredLease = undefined;
      if (matchesAuthority(next, offered) && view.previewLive && usable()) installLease(offered);
      else {
        if (matchesAuthority(next, offered)) void sendRelease(releaseBody(offered));
        clearControl();
      }
    }
  }

  function installLease(current: NonNullable<typeof lease>) {
    lease = current;
    report({ controlling: true, acquiring: false });
    heartbeatTimer = setInterval(heartbeat, profile.heartbeat_interval_ms);
    heartbeat();
  }

  function invalidate() {
    state = undefined;
    clearControl();
    report({ eventsLive: false, resynchronizing: true, message: "Search events disconnected. Resynchronizing with the service." });
    robotVideo.reset();
    webcamVideo?.reset();
    recover();
  }

  const events = openEventStream({
    transport, context, profile, recover: invalidate,
    apply(next, event) {
      if (disposed) return;
      applySnapshot(next, event);
      report({ eventsLive: true, resynchronizing: false, ...(view.resynchronizing && { message: undefined }) });
    },
  });

  function video(surface: HTMLCanvasElement, source: "robot" | "webcam") {
    const channel: Channel = source === "robot" ? "robot-video" : "webcam-video";
    let ticketClock: { issued: number; requested: number } | undefined;
    const display = openFrameDisplay({
      profile, source, monotonic: () => performance.now(),
      serverTime: connectedBackend ? () => ticketClock && ticketClock.issued + Math.ceil(performance.now() - ticketClock.requested) : serverTime,
      decode: (jpeg) => createImageBitmap(new Blob([jpeg], { type: "image/jpeg" }), { imageOrientation: "none" }),
      present(image) {
        if (connectedBackend && !view.eventsLive) return false;
        if (!surface.isConnected || document.visibilityState !== "visible" || !surface.checkVisibility({ visibilityProperty: true })) return false;
        const drawing = surface.getContext("2d", { alpha: false });
        if (!drawing || drawing.isContextLost() || !surface.clientWidth || !surface.clientHeight) return false;
        if (surface.width !== image.width) surface.width = image.width;
        if (surface.height !== image.height) surface.height = image.height;
        drawing.drawImage(image, 0, 0);
        if (drawing.isContextLost()) return false;
        if (source === "robot" && awaitingDraw && !waitingForWorkspace) {
          awaitingDraw = false;
          queueMicrotask(heartbeat);
        }
        return true;
      },
      changed(live) {
        if (live) connection.healthy();
        if (source === "webcam") { report({ webcamLive: live }); return; }
        if (!live && !waitingForWorkspace && !awaitingDraw) reportIneligible("Control was released when the robot preview stopped updating.", false);
        report({ previewLive: live });
      },
      epochChanged() { connection.reconnect(); },
      timingLost: connectedBackend ? (): void => { connection.reconnect(); } : undefined,
    });
    const connection = readChannel<ReadSocket>({
      transport, context, channel, lost: display.reset,
      calibrate(issued, requested) { ticketClock = { issued, requested }; },
      connect: (request, offer, closed) => transport.connectFrames(request, source, offer, {
        closed,
        message(frame) { if (!disposed && !request.signal?.aborted) display.receive(frame); },
      }),
    });
    return {
      displayed: display.displayedFrame,
      forgetPresentation: display.reset,
      reset() {
        connection.reconnect();
        display.reset();
        surface.getContext("2d")?.clearRect(0, 0, surface.width, surface.height);
      },
      dispose() { connection.dispose(); display.reset(); },
    };
  }

  const robotVideo = video(robot, "robot");
  let webcamVideo: ReturnType<typeof video> | undefined;

  function heartbeat() {
    const current = lease;
    if (!current || waitingForWorkspace || awaitingDraw) return;
    checkSurface();
    const frame = robotVideo.displayed();
    if (current !== lease) return;
    if (!frame) { reportIneligible("Control was released when the robot preview stopped updating.", false); return; }
    const accepted = events.current()?.heartbeat({
      type: "workspace_heartbeat", protocol_version: 1, backend_boot_id: context.backend_boot_id,
      client_id: context.client_id, client_lease_id: current.secret, session_id: current.session,
      control_generation: current.generation, heartbeat_seq: ++current.sequence,
      workspace_visible: document.visibilityState === "visible", workspace_focused: document.hasFocus(),
      workspace_operational: view.usable, displayed_robot_frame: frame,
    });
    if (!accepted) clearControl("The display heartbeat was rejected. Acquire control again when available.");
  }

  function checkSurface() {
    // Only the disconnected canvas is expected during handoff. Document loss still revokes immediately.
    if (waitingForWorkspace && navigator.onLine && document.visibilityState === "visible" && document.hasFocus()) return;
    const operational = usable();
    if (!operational && (lease || acquisition)) reportIneligible("Control was released when the workspace became unavailable.", false);
    report({ usable: operational });
  }

  function reportIneligible(message: string, operational: boolean, focused = document.hasFocus()) {
    // If this observation cannot arrive, the backend independently expires the lease or displayed frame.
    if (lease) events.current()?.heartbeat({
      type: "workspace_heartbeat", protocol_version: 1, backend_boot_id: context.backend_boot_id,
      client_id: context.client_id, client_lease_id: lease.secret, session_id: lease.session,
      control_generation: lease.generation, heartbeat_seq: ++lease.sequence,
      workspace_visible: document.visibilityState === "visible", workspace_focused: focused,
      workspace_operational: operational, displayed_robot_frame: null,
    });
    if (offeredLease) void sendRelease(releaseBody(offeredLease.lease));
    clearControl(message);
  }

  function lostFocus() {
    reportIneligible("Control was released when the workspace lost focus.", false, false);
    report({ usable: false });
  }

  function lostTransport() {
    lostFocus();
    events.reconnect();
  }

  function leaveWorkspace() {
    if (connectedBackend) void release();
    else lostFocus();
  }

  window.addEventListener("blur", lostFocus);
  window.addEventListener("focus", checkSurface);
  window.addEventListener("offline", lostTransport);
  window.addEventListener("online", checkSurface);
  window.addEventListener("pagehide", leaveWorkspace);
  window.addEventListener("popstate", leaveWorkspace, true);
  document.addEventListener("visibilitychange", checkSurface);
  robot.addEventListener("contextlost", checkSurface);
  const resize = new ResizeObserver(checkSurface);
  resize.observe(robot);
  checkSurface();
  update(view);

  return {
    resynchronize: events.reconnect,
    clearControl,
    mount(robotHost: HTMLElement, webcamHost?: HTMLElement, sessionId?: string) {
      robotHost.append(robot);
      if (webcamHost) {
        webcamHost.append(webcam);
        webcamVideo ??= video(webcam, "webcam");
      }
      if (sessionId && sessionId === handoffSession) {
        handoffSession = undefined;
        awaitingDraw = true;
        waitingForWorkspace = false;
        robotVideo.forgetPresentation();
      }
      checkSurface();
    },
    canHandOff(sessionId?: string) { return !!handoffSession && (!sessionId || handoffSession === sessionId); },
    actionScope(session: string | null) {
      if (lease?.session !== session || !view.controlling || !state || !matchesAuthority(state, lease)) return;
      return { client_id: context.client_id, client_lease_id: lease.secret };
    },
    expectStart(body: StartRequest) { start = body; },
    async acquire() {
      if (!state || disposed || view.acquiring || view.releasing || view.retryRelease || lease || !view.eventsLive || !view.previewLive || !usable() ||
          (!state.lease.can_acquire && !acquisition)) return;
      const attempt = ++intent;
      const session = state.active_session?.id ?? null;
      const body = acquisition ?? { request_id: crypto.randomUUID(), client_id: context.client_id, session_id: session,
        takeover: session !== null || state.lease.control_generation > 1 };
      acquisition = body;
      report({ acquiring: true, retryAcquisition: false, message: undefined });
      try {
        const result = await transport.request("POST /control-lease", { context, body });
        if (result.kind === "ok" && conforms("LeaseResponse", result.data) && result.data.request_id === body.request_id &&
            result.data.client_lease_id && validSnapshot(result.data.snapshot, context.backend_boot_id) && matchesProfile(result.data.snapshot, profile)) {
          const response = result.data;
          const acquired = { secret: result.data.client_lease_id, generation: response.control_generation, session: body.session_id, sequence: 0 };
          const fresh = state && state.event_seq >= response.snapshot.event_seq ? state : response.snapshot;
          if (!matchesAuthority(fresh, acquired)) {
            if (attempt === intent) acquisition = undefined;
            return;
          }
          if (disposed || attempt !== intent || !view.eventsLive || !view.previewLive || !usable()) {
            void sendRelease(releaseBody(acquired));
            if (attempt === intent) acquisition = undefined;
            return;
          }
          acquisition = undefined;
          if (state && state.event_seq >= response.snapshot.event_seq) installLease(acquired);
          else offeredLease = { lease: acquired, watermark: response.snapshot.event_seq };
        } else if (attempt === intent && result.kind !== "unavailable") {
          acquisition = undefined;
          report({ message: "Control could not be acquired. Check the current ownership and try again." });
        } else if (attempt === intent) {
          report({ retryAcquisition: true, message: "Acquisition was unconfirmed. Select Acquire control to retry." });
        }
      } catch {
        if (attempt === intent) report({ retryAcquisition: true, message: "Acquisition was unconfirmed. Select Acquire control to retry." });
      } finally {
        if (attempt === intent && !offeredLease) report({ acquiring: false });
      }
    },
    release,
    dispose() {
      if (disposed) return;
      disposed = true;
      const closing = release();
      // Let a deliberate release reach the server, with event loss as a bounded fallback.
      const finish = () => {
        clearTimeout(closeTimer);
        events.dispose();
        robotVideo.dispose();
        webcamVideo?.dispose();
      };
      const closeTimer = setTimeout(finish, closing && connectedBackend ? profile.heartbeat_deadline_ms : 0);
      if (closing && connectedBackend) void closing.finally(finish);
      resize.disconnect();
      window.removeEventListener("blur", lostFocus);
      window.removeEventListener("focus", checkSurface);
      window.removeEventListener("offline", lostTransport);
      window.removeEventListener("online", checkSurface);
      window.removeEventListener("pagehide", leaveWorkspace);
      window.removeEventListener("popstate", leaveWorkspace, true);
      document.removeEventListener("visibilitychange", checkSurface);
      robot.removeEventListener("contextlost", checkSurface);
    },
  };
}
