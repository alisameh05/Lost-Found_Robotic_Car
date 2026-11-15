import type { Channel, FrontendProfile, LeaseAcquire, LeaseRelease, LeaseResponse, Snapshot, StartRequest } from "@/generated/api-v1";
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
  retryAcquisition?: boolean;
  message?: string;
};

function readChannel<Socket extends ReadSocket>({
  transport, context, channel, connect, lost,
}: {
  transport: ApplicationTransport;
  context: ClientContext;
  channel: Channel;
  connect(request: ProtectedRequest, offer: SocketOffer, closed: () => void): ReadResult<Socket>;
  lost(): void;
}) {
  let scope: AbortController | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let socket: Socket | undefined;
  let disposed = false;
  let backoff = 250;

  function disconnect() {
    const connection = scope;
    scope = undefined;
    connection?.abort();
    socket?.close();
    socket = undefined;
  }

  function reconnect() {
    if (disposed || !scope) return;
    disconnect();
    lost();
    if (disposed) return;
    timer = setTimeout(open, Math.min(5_000, Math.round(backoff * (0.8 + Math.random() * 0.4))));
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
      const ticket = await transport.request("POST /websocket-tickets", { ...request, body: { client_id: context.client_id, channel } });
      if (scope !== connection) return;
      if (ticket.kind !== "ok" || !conforms("TicketResponse", ticket.data)) { closed(); return; }
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
    healthy() { backoff = 250; },
    reconnect,
    dispose() { disposed = true; clearTimeout(timer); disconnect(); },
  };
}

export function openWorkspace({
  transport, context, profile, serverTime, update, snapshot, recover,
}: {
  transport: ApplicationTransport;
  context: ClientContext;
  profile: FrontendProfile;
  serverTime(): number | undefined;
  update(view: WorkspaceView): void;
  snapshot(value: Snapshot, removedOwner?: string): void;
  recover(): void;
}) {
  const robot = document.createElement("canvas");
  robot.setAttribute("role", "img");
  robot.setAttribute("aria-label", "Fixture robot camera view");
  const webcam = document.createElement("canvas");
  webcam.setAttribute("role", "img");
  webcam.setAttribute("aria-label", "Fixture laptop webcam view");
  let view: WorkspaceView = { eventsLive: false, previewLive: false, webcamLive: false, controlling: false, usable: false, acquiring: false };
  let state: Snapshot | undefined;
  let disposed = false;
  let lease: { secret: string; generation: number; session: string | null; sequence: number } | undefined;
  let acquisition: LeaseAcquire | undefined;
  let intent = 0;
  let heartbeatTimer: ReturnType<typeof setInterval> | undefined;
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

  function sendRelease(current: NonNullable<typeof lease>): Promise<ReadResult<LeaseResponse>> {
    const body: LeaseRelease = { request_id: crypto.randomUUID(), client_id: context.client_id, client_lease_id: current.secret,
      session_id: current.session, control_generation: current.generation };
    return transport.request("POST /control-lease/release", { body, context }).then<ReadResult<LeaseResponse>>((result) => {
      if (result.kind === "ok" && (!conforms("LeaseResponse", result.data) || result.data.request_id !== body.request_id)) {
        return { kind: "unavailable" };
      }
      return result;
    }).catch(() => ({ kind: "unavailable" as const }));
  }

  function clearControl(message?: string) {
    intent++;
    acquisition = undefined;
    start = undefined;
    handoffSession = undefined;
    waitingForWorkspace = false;
    const hadControl = lease !== undefined;
    forgetLease();
    report({ acquiring: false, retryAcquisition: false, ...(message && hadControl && { message }) });
  }

  function release(message?: string) {
    const result = lease ? sendRelease(lease) : undefined;
    clearControl(message);
    return result;
  }

  function matchesAuthority(next: Snapshot, current: NonNullable<typeof lease>) {
    return next.lease.owner_client_id === context.client_id && next.lease.control_generation === current.generation &&
      next.runtime.control_generation === current.generation && (next.active_session?.id ?? null) === current.session;
  }

  function matchesProfile(next: Snapshot) {
    return next.qualification_profile_id === profile.profile_id && Object.entries(profile)
      .every(([key, value]) => next.qualification_profile?.[key as keyof FrontendProfile] === value);
  }

  function apply(next: Snapshot, removedOwner?: string) {
    state = next;
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
    snapshot(next, removedOwner);
  }

  function invalidate() {
    state = undefined;
    release("Control was released when search readiness disconnected.");
    report({ eventsLive: false });
    robotVideo.reset();
    webcamVideo?.reset();
    recover();
  }

  const events = readChannel<EventSocket>({
    transport, context, channel: "events", lost: invalidate,
    connect: (request, offer, closed) => transport.connectEvents(request, offer, {
      closed,
      message(event) {
        if (disposed || request.signal?.aborted) return;
        const next = projectWorkspaceEvent(state, event, context.backend_boot_id);
        if (!next || !matchesProfile(next)) {
          events.reconnect();
          return;
        }
        if (next === state) return;
        events.healthy();
        report({ eventsLive: true });
        apply(next, event.type === "object_removed" ? event.payload.object_id : undefined);
      },
    }),
  });

  function video(surface: HTMLCanvasElement, source: "robot" | "webcam") {
    const channel: Channel = source === "robot" ? "robot-video" : "webcam-video";
    const display = openFrameDisplay({
      profile, source, serverTime, monotonic: () => performance.now(),
      decode: (jpeg) => createImageBitmap(new Blob([jpeg], { type: "image/jpeg" }), { imageOrientation: "none" }),
      present(image) {
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
        if (!live && !waitingForWorkspace && !awaitingDraw) reportIneligible("Control was released when the robot preview stopped updating.", view.usable);
        report({ previewLive: live });
      },
      epochChanged() { connection.reconnect(); },
    });
    const connection = readChannel<ReadSocket>({
      transport, context, channel, lost: display.reset,
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
    if (!frame) { reportIneligible("Control was released when the robot preview stopped updating.", view.usable); return; }
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
    // If this observation cannot arrive, the fixture independently expires the lease or displayed frame.
    if (lease) events.current()?.heartbeat({
      type: "workspace_heartbeat", protocol_version: 1, backend_boot_id: context.backend_boot_id,
      client_id: context.client_id, client_lease_id: lease.secret, session_id: lease.session,
      control_generation: lease.generation, heartbeat_seq: ++lease.sequence,
      workspace_visible: document.visibilityState === "visible", workspace_focused: focused,
      workspace_operational: operational, displayed_robot_frame: null,
    });
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

  window.addEventListener("blur", lostFocus);
  window.addEventListener("focus", checkSurface);
  window.addEventListener("offline", lostTransport);
  window.addEventListener("online", checkSurface);
  window.addEventListener("pagehide", lostFocus);
  window.addEventListener("popstate", lostFocus, true);
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
      if (!state || disposed || view.acquiring || lease || !view.eventsLive || !view.previewLive || !usable() ||
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
            result.data.client_lease_id && validSnapshot(result.data.snapshot, context.backend_boot_id) && matchesProfile(result.data.snapshot)) {
          const response = result.data;
          const acquired = { secret: result.data.client_lease_id, generation: response.control_generation, session: body.session_id, sequence: 0 };
          const fresh = state && state.event_seq > response.snapshot.event_seq ? state : response.snapshot;
          if (!matchesAuthority(fresh, acquired)) {
            if (attempt === intent) acquisition = undefined;
            return;
          }
          if (disposed || attempt !== intent || !view.eventsLive || !view.previewLive || !usable()) {
            sendRelease(acquired);
            if (attempt === intent) acquisition = undefined;
            return;
          }
          acquisition = undefined;
          lease = acquired;
          apply(fresh);
          report({ controlling: true });
          heartbeatTimer = setInterval(heartbeat, profile.heartbeat_interval_ms);
          heartbeat();
        } else if (attempt === intent && result.kind !== "unavailable") {
          acquisition = undefined;
          report({ message: "Control could not be acquired. Check the current ownership and try again." });
        } else if (attempt === intent) {
          report({ retryAcquisition: true, message: "Acquisition was unconfirmed. Select Acquire control to retry." });
        }
      } catch {
        if (attempt === intent) report({ retryAcquisition: true, message: "Acquisition was unconfirmed. Select Acquire control to retry." });
      } finally {
        if (attempt === intent) report({ acquiring: false });
      }
    },
    release,
    dispose() {
      if (disposed) return;
      disposed = true;
      release();
      // Give the protected release a chance to reach the adapter before closing its event channel.
      queueMicrotask(() => {
        events.dispose();
        robotVideo.dispose();
        webcamVideo?.dispose();
      });
      resize.disconnect();
      window.removeEventListener("blur", lostFocus);
      window.removeEventListener("focus", checkSurface);
      window.removeEventListener("offline", lostTransport);
      window.removeEventListener("online", checkSurface);
      window.removeEventListener("pagehide", lostFocus);
      window.removeEventListener("popstate", lostFocus, true);
      document.removeEventListener("visibilitychange", checkSurface);
      robot.removeEventListener("contextlost", checkSurface);
    },
  };
}
