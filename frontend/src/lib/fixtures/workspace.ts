import type {
  EventEnvelope, FrameMetadata, FrontendProfile, LeaseAcquire, LeaseRelease, LeaseResponse, Match, PublicLease, Snapshot, WorkspaceHeartbeat,
} from "@/generated/api-v1";
import { conforms } from "../fixture-contracts";
import type { EventSocket, ReadSocket, SocketObserver } from "../transport";
import { imageHeight, imageWidth, sampleImage } from "./images";
import { fixtureError as error, fixtureOk as ok } from "./responses";
import { qualification, encodeFrame, snapshotEvent } from "./vectors";
import { runtimeToken } from "./socket-tickets";
import designFrames from "./workspace-frames.json";

export type FrameMode = "live" | "empty" | "corrupt" | "frozen" | "disconnected";
type Source = FrameMetadata["source"];
type Frame = { metadata: FrameMetadata; captured: number; payload: Uint8Array };
type EventConnection = { enqueue(event: EventEnvelope): void; close(): void };
type VideoConnection = { close(): void; latest?: Frame; issued: Map<string, Frame> };
type Owner = {
  client: string; secret: string; sequence: number; deadline: number;
  acknowledged?: Frame; workspace: boolean;
};

const eventShift = new TextEncoder();
const cameraInterval = 75;
const invalid = () => error(422, "VALIDATION_FAILED", "Invalid sample workspace request.");
const leaseRequired = () => error(403, "LEASE_REQUIRED", "The current sample lease is required.");

export function openFixtureWorkspace({
  boot, profile, now, monotonic, read, setLease, available, frameMode = "live",
}: {
  boot: string;
  profile: FrontendProfile | null;
  now: () => number;
  monotonic: () => number;
  read: (client: string) => Snapshot;
  setLease: (lease: PublicLease, pause: boolean) => void;
  available: (source: Source) => boolean;
  frameMode?: FrameMode;
}) {
  const events = new Map<string, EventConnection>();
  const video = { robot: new Map<string, VideoConnection>(), webcam: new Map<string, VideoConnection>() };
  const receipts = new Map<string, { fingerprint: string; outcome: Omit<LeaseResponse, "snapshot"> }>();
  let previousOwner = false;
  let owner: Owner | undefined;
  let watermark = 1;
  let timer: ReturnType<typeof setTimeout> | undefined;
  // Local design camera illustrations from generated-3.png and generated-4.png.
  function cameraFrame(source: Source) {
    const asset = designFrames[source];
    if (profile && asset.width <= profile.max_frame_width && asset.height <= profile.max_frame_height &&
        asset.width * asset.height <= profile.max_frame_pixels && asset.byte_length + profile.max_header_bytes + 4 <= profile.max_frame_bytes) {
      return { width: asset.width, height: asset.height, jpeg: Uint8Array.from(atob(asset.base64), (byte) => byte.charCodeAt(0)) };
    }
    return { width: imageWidth, height: imageHeight, jpeg: sampleImage("image/jpeg") };
  }
  const frames = { robot: cameraFrame("robot"), webcam: cameraFrame("webcam") };
  const modeBySource = { robot: frameMode, webcam: "live" } satisfies Record<Source, FrameMode> as Record<Source, FrameMode>;

  function emit(project: (state: Snapshot, envelope: EventEnvelope) => EventEnvelope) {
    watermark++;
    for (const [client, connection] of events) {
      const state = read(client);
      connection.enqueue(project(state, { ...snapshotEvent(state), occurred_at_ms: now() }));
    }
  }

  function publish(kind: "snapshot" | "readiness_changed" = "snapshot", candidate?: Match) {
    emit((state, envelope) => kind === "snapshot"
      ? { ...envelope, type: "snapshot", payload: candidate ? { ...state, pending_candidate: null } : state }
      : { ...envelope, type: kind, payload: { readiness: state.readiness, runtime: state.runtime } });
    if (candidate) emit((state, envelope) => ({ ...envelope, type: "candidate_pending",
      payload: { match: candidate, control_generation: state.runtime.control_generation } }));
  }

  function frameFresh(frame: Frame, time: number) {
    return !!profile && time - frame.captured < Math.min(profile.capture_age_limit_ms, profile.display_deadline_ms);
  }

  function revoke() {
    if (!owner) return;
    const state = read(owner.client);
    owner = undefined;
    clearTimeout(timer);
    setLease({ state: "Unowned", owner_client_id: null, can_acquire: false,
      control_generation: state.lease.control_generation + 1 }, true);
    publish();
  }

  function checkDeadline() {
    if (!owner || !profile) return;
    const time = monotonic();
    const displayDeadline = owner.acknowledged
      ? owner.acknowledged.captured + Math.min(profile.capture_age_limit_ms, profile.display_deadline_ms) : Infinity;
    const deadline = Math.min(owner.deadline, displayDeadline);
    clearTimeout(timer);
    if (time >= deadline) revoke();
    else timer = setTimeout(checkDeadline, Math.ceil(deadline - time));
  }

  function connectEvents(client: string, observer: SocketObserver<EventEnvelope>, signal: AbortSignal): EventSocket {
    events.get(client)?.close();
    const queue: { event: EventEnvelope; size: number }[] = [];
    let queuedBytes = 0;
    let closed = false;
    let scheduled = false;
    const connection: EventConnection = {
      enqueue(event) {
        if (closed || !profile) return;
        const size = eventShift.encode(JSON.stringify(event)).byteLength;
        if (size > profile.max_event_message_bytes || queue.length >= qualification.event_queue_messages ||
            queuedBytes + size > qualification.event_queue_bytes) {
          connection.close();
          return;
        }
        queue.push({ event: structuredClone(event), size });
        queuedBytes += size;
        if (scheduled) return;
        scheduled = true;
        queueMicrotask(() => {
          scheduled = false;
          while (!closed && queue.length) {
            const next = queue.shift()!;
            queuedBytes -= next.size;
            observer.message(next.event);
          }
        });
      },
      close() {
        if (closed) return;
        closed = true;
        queue.length = 0;
        signal.removeEventListener("abort", connection.close);
        if (events.get(client) === connection) {
          events.delete(client);
          if (owner?.client === client) revoke();
        }
        observer.closed();
      },
    };
    events.set(client, connection);
    signal.addEventListener("abort", connection.close, { once: true });
    connection.enqueue(snapshotEvent(read(client)));
    return { protocol: "laf.v1", close: connection.close, heartbeat: (body) => !closed && heartbeat(client, body) };
  }

  function connectVideo(client: string, source: Source, observer: SocketObserver<Uint8Array>, signal: AbortSignal): ReadSocket {
    const connections = video[source];
    connections.get(client)?.close();
    let closed = false;
    let sequence = 0;
    const stream = crypto.randomUUID();
    let nextCapture: ReturnType<typeof setTimeout> | undefined;
    const connection: VideoConnection = {
      issued: new Map(),
      close() {
        if (closed) return;
        closed = true;
        clearTimeout(nextCapture);
        signal.removeEventListener("abort", connection.close);
        if (connections.get(client) === connection) connections.delete(client);
        if (source === "robot" && owner?.client === client) revoke();
        observer.closed();
      },
    };
    function capture() {
      if (closed) return;
      const mode = modeBySource[source];
      if (mode === "disconnected") { connection.close(); return; }
      nextCapture = setTimeout(capture, cameraInterval);
      if (mode === "empty" || !available(source)) return;
      if (mode !== "frozen" || !connection.latest) {
        const { width, height, jpeg } = frames[source];
        const payload = mode === "corrupt" ? Uint8Array.of(255, 216, 0, 255, 217) : jpeg;
        const metadata: FrameMetadata = {
          protocol_version: 1, source, stream_epoch: stream, frame_id: crypto.randomUUID(), capture_seq: ++sequence,
          width, height,
          received_at_ms: now(), capture_age_bound_ms: 5, source_capture_us: Math.floor(monotonic() * 1_000),
          source_clock_epoch: `fixture-${source}-clock`,
        };
        const frame = { metadata, captured: monotonic() - metadata.capture_age_bound_ms, payload };
        connection.latest = frame;
        for (const [id, old] of connection.issued) if (!frameFresh(old, monotonic())) connection.issued.delete(id);
        if (source === "robot" && mode !== "corrupt") connection.issued.set(metadata.frame_id, frame);
      }
      const frame = connection.latest;
      observer.message(encodeFrame(frame.metadata, frame.payload));
    }
    connections.set(client, connection);
    signal.addEventListener("abort", connection.close, { once: true });
    queueMicrotask(capture);
    return { protocol: "laf.v1", close: connection.close };
  }

  function heartbeat(client: string, body: WorkspaceHeartbeat): boolean {
    checkDeadline();
    if (!profile || !owner || owner.client !== client || !conforms("WorkspaceHeartbeat", body) ||
        eventShift.encode(JSON.stringify(body)).byteLength > profile.max_client_message_bytes) return false;
    const state = read(client);
    if (body.client_id !== client || body.backend_boot_id !== boot || body.client_lease_id !== owner.secret ||
        body.control_generation !== state.lease.control_generation || body.session_id !== (state.active_session?.id ?? null) ||
        body.heartbeat_seq <= owner.sequence || (!owner.sequence && body.heartbeat_seq !== 1)) return false;
    if (!body.workspace_visible || !body.workspace_focused || !body.workspace_operational) { revoke(); return false; }
    const time = monotonic();
    const indication = body.displayed_robot_frame;
    const frame = indication && video.robot.get(client)?.issued.get(indication.frame_id);
    if (indication && (!frame || indication.stream_epoch !== frame.metadata.stream_epoch || !frameFresh(frame, time) ||
      (owner.acknowledged && frame.metadata.capture_seq < owner.acknowledged.metadata.capture_seq))) return false;
    if (!indication && owner.acknowledged) { revoke(); return false; }
    const changed = !owner.workspace || (!!frame && !owner.acknowledged);
    owner.sequence = body.heartbeat_seq;
    owner.deadline = time + profile.heartbeat_deadline_ms;
    owner.workspace = true;
    if (frame) owner.acknowledged = frame;
    if (changed) publish("readiness_changed");
    checkDeadline();
    return true;
  }

  function replay(client: string, requestId: string, fingerprint: string) {
    const receipt = receipts.get(requestId);
    if (!receipt) return;
    if (receipt.fingerprint !== fingerprint) return error(409, "REQUEST_ID_CONFLICT", "This runtime request ID was already used.");
    return ok({ ...receipt.outcome, snapshot: read(client) });
  }

  function finish(client: string, fingerprint: string, outcome: Omit<LeaseResponse, "snapshot">) {
    receipts.set(outcome.request_id, { fingerprint, outcome });
    return ok({ ...outcome, snapshot: read(client) });
  }

  function acquire(client: string, body: LeaseAcquire) {
    checkDeadline();
    if (!conforms("LeaseAcquire", body)) return invalid();
    if (body.client_id !== client) return error(403, "CLIENT_INVALID", "Unknown sample client.");
    const fingerprint = JSON.stringify(["acquire", client, body.session_id, body.takeover]);
    const retry = replay(client, body.request_id, fingerprint);
    if (retry) return retry;
    const state = read(client);
    if (state.lease.state === "Owned") return error(403, "LEASE_OWNED", "Control is already held.");
    if (!profile || !state.lease.can_acquire || !events.has(client)) return error(503, "NOT_READY", "Control is unavailable.");
    if (body.session_id !== (state.active_session?.id ?? null)) return error(409, "OWNERSHIP_MISMATCH", "The active search changed.");
    if (!body.takeover && (previousOwner || body.session_id !== null)) {
      return error(409, "INVALID_TRANSITION", "Confirm takeover to acquire available control.");
    }
    if (receipts.size >= 8192) return error(503, "CAPACITY_REACHED", "Too many sample lease requests.");
    const control_generation = state.lease.control_generation + 1;
    const lease = { state: "Owned", owner_client_id: client, control_generation, can_acquire: false } as const;
    const secret = runtimeToken();
    owner = { client, secret, sequence: 0, deadline: monotonic() + profile.heartbeat_deadline_ms, workspace: false };
    previousOwner = true;
    setLease(lease, false);
    publish();
    checkDeadline();
    return finish(client, fingerprint, { request_id: body.request_id, client_lease_id: secret, control_generation, lease });
  }

  return {
    publish,
    publishRemoval: (object_id: string) => emit((_state, envelope) => ({
      ...envelope, type: "object_removed", payload: { object_id, reason: "Expired" },
    })),
    watermark: () => watermark,
    hasEvents: () => events.size > 0,
    canAcquire: (client: string) => !!profile && events.has(client),
    observations: () => ({ workspace: !!owner?.workspace, displayed: !!owner?.acknowledged && frameFresh(owner.acknowledged, monotonic()) }),
    captureEvidence() {
      checkDeadline();
      const client = owner?.client;
      const frame = owner?.acknowledged;
      const connection = client && video.robot.get(client);
      if (!client || !connection || !frame || modeBySource.robot !== "live" || !available("robot") || !frameFresh(frame, monotonic())) return;
      return { metadata: frame.metadata, bytes: frame.payload.slice(), isFresh: () => modeBySource.robot === "live" &&
        video.robot.get(client) === connection && available("robot") && frameFresh(frame, monotonic()) };
    },
    owns(client: string, secret: string) {
      checkDeadline();
      return owner?.client === client && owner.secret === secret && events.has(client);
    },
    invalidateDisplayScope() {
      if (!owner) return;
      video.robot.get(owner.client)?.issued.clear();
      owner.acknowledged = undefined;
      owner.workspace = false;
      checkDeadline();
    },
    connectEvents,
    connectVideo,
    acquire,
    release(client: string, body: LeaseRelease) {
      if (!conforms("LeaseRelease", body)) return invalid();
      if (body.client_id !== client) return error(403, "CLIENT_INVALID", "Unknown sample client.");
      const fingerprint = JSON.stringify(["release", client, body.client_lease_id, body.session_id, body.control_generation]);
      const retry = replay(client, body.request_id, fingerprint);
      if (retry) return retry;
      const state = read(client);
      if (!owner || owner.client !== client || body.client_lease_id !== owner.secret ||
          body.session_id !== (state.active_session?.id ?? null) || body.control_generation !== state.lease.control_generation) return leaseRequired();
      revoke();
      const snapshot = read(client);
      if (receipts.size >= 8192) return error(503, "CAPACITY_REACHED", "Control was revoked. The release receipt could not be recorded.");
      return finish(client, fingerprint, { request_id: body.request_id, client_lease_id: null, control_generation: snapshot.lease.control_generation,
        lease: snapshot.lease });
    },
    changeFrames(mode: FrameMode) { modeBySource.robot = mode; },
    disconnectEvents(client: string) { events.get(client)?.close(); },
    checkDeadline,
    clearOwnership() { clearTimeout(timer); owner = undefined; },
    dispose() {
      clearTimeout(timer);
      owner = undefined;
      for (const connection of events.values()) connection.close();
      for (const socket of [...video.robot.values(), ...video.webcam.values()]) socket.close();
      receipts.clear();
    },
  };
}
