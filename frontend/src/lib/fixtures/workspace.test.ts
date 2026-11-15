import { expect, test, vi } from "vitest";
import type { Channel, EventEnvelope, WorkspaceHeartbeat } from "@/generated/api-v1";
import { conforms } from "../fixture-contracts";
import { parseFrameEnvelope } from "../frame-display";
import { socketOffer, type ClientContext, type ReadResult } from "../transport";
import { createFixtureTransport } from "./transport";
import { sampleTime } from "./samples";

function data<T>(result: ReadResult<T>) {
  if (result.kind !== "ok") throw new Error(`Expected fixture success, received ${result.kind}`);
  return result.data;
}

async function ticket(transport: ReturnType<typeof createFixtureTransport>, context: ClientContext, channel: Channel) {
  const response = data(await transport.request("POST /websocket-tickets", { context, body: { client_id: context.client_id, channel } }));
  return socketOffer(channel, response.ticket);
}

const silent = { message() {}, closed() {} };

test("redeems a ticket once for its exact boot, client, channel and protocol before the monotonic deadline", async ({ onTestFinished }) => {
  let clock = 0;
  let utc = sampleTime;
  const transport = createFixtureTransport({ monotonic: () => clock, now: () => utc });
  onTestFinished(() => transport.dispose());
  const context = data(await transport.bootstrap());
  const other = transport.controls.addClient();
  const offer = await ticket(transport, context, "events");
  const connect = (candidate = context, protocols: readonly string[] = offer.protocols) =>
    transport.connectEvents({ context: candidate }, { ...offer, protocols }, silent);
  expect(connect({ ...context, backend_boot_id: "old-boot" })).toMatchObject({ error: { code: "TICKET_INVALID" } });
  expect(connect(other)).toMatchObject({ error: { code: "TICKET_INVALID" } });
  expect(connect(context, [...offer.protocols, "laf.v1"])).toMatchObject({ error: { code: "TICKET_INVALID" } });
  expect(transport.connectFrames({ context }, "robot", { ...offer, path: "/video/robot" }, silent))
    .toMatchObject({ error: { code: "TICKET_INVALID" } });
  utc += 30_000;
  clock = 9_999;
  const connection = data(connect());
  expect(connection.protocol).toBe("laf.v1");
  expect(connect()).toMatchObject({ error: { code: "TICKET_CONSUMED" } });
  connection.close();

  const expiring = await ticket(transport, context, "events");
  clock += 10_000;
  expect(transport.connectEvents({ context }, expiring, silent)).toMatchObject({ error: { code: "TICKET_EXPIRED" } });
});

test("presents one controlling lease and derives readiness from a scoped, fresh robot acknowledgment", async ({ onTestFinished }) => {
  vi.useFakeTimers();
  const transport = createFixtureTransport({ monotonic: () => Date.now() - sampleTime });
  vi.setSystemTime(sampleTime);
  onTestFinished(() => { transport.dispose(); vi.useRealTimers(); });
  const context = data(await transport.bootstrap());
  const other = transport.controls.addClient();
  const read = async () => data(await transport.snapshot({ context }));
  const body = { client_id: context.client_id, request_id: crypto.randomUUID(), session_id: null, takeover: false };
  const acquire = () => transport.request("POST /control-lease", { context, body });
  expect(await acquire()).toMatchObject({ error: { code: "NOT_READY" } });
  const events: EventEnvelope[] = [];
  const eventSocket = data(transport.connectEvents({ context }, await ticket(transport, context, "events"),
    { message: (event) => events.push(event), closed() {} }));
  const spectatorEvents = data(transport.connectEvents({ context: other }, await ticket(transport, other, "events"), silent));
  let robot: WorkspaceHeartbeat["displayed_robot_frame"] = null;
  let webcam: WorkspaceHeartbeat["displayed_robot_frame"] = null;
  const profile = context.qualification_profile!;
  for (const source of ["robot", "webcam"] as const) {
    const offer = await ticket(transport, context, source === "robot" ? "robot-video" : "webcam-video");
    data(transport.connectFrames({ context }, source, offer, {
      message(value) {
        const { frame_id, stream_epoch } = parseFrameEnvelope(value, profile, source)!.metadata;
        if (source === "robot") robot = { frame_id, stream_epoch };
        else webcam = { frame_id, stream_epoch };
      },
      closed() {},
    }));
  }
  await vi.advanceTimersByTimeAsync(1);
  expect((await read()).lease).toMatchObject({ state: "Unowned", can_acquire: true });
  const lease = data(await acquire());
  expect(conforms("LeaseResponse", lease)).toBe(true);
  await expect(transport.request("POST /control-lease", { context: other,
    body: { ...body, client_id: other.client_id, request_id: crypto.randomUUID(), takeover: true },
  })).resolves.toMatchObject({ error: { code: "LEASE_OWNED" } });
  spectatorEvents.close();
  expect((await read()).lease.state).toBe("Owned");
  const heartbeat: WorkspaceHeartbeat = {
    type: "workspace_heartbeat", protocol_version: 1, backend_boot_id: context.backend_boot_id,
    client_id: context.client_id, client_lease_id: lease.client_lease_id!, session_id: null,
    control_generation: lease.control_generation, heartbeat_seq: 1,
    workspace_visible: true, workspace_focused: true, workspace_operational: true, displayed_robot_frame: null,
  };
  expect(eventSocket.heartbeat({ ...heartbeat, heartbeat_seq: 2 })).toBe(false);
  expect(eventSocket.heartbeat(heartbeat)).toBe(true);
  expect((await read()).readiness.can_start).toEqual({ Gestures: false, Controller: false });
  expect(eventSocket.heartbeat({ ...heartbeat, heartbeat_seq: 2, displayed_robot_frame: webcam })).toBe(false);
  expect(eventSocket.heartbeat({ ...heartbeat, heartbeat_seq: 2, displayed_robot_frame: robot, session_id: "another-search" })).toBe(false);
  expect(eventSocket.heartbeat({ ...heartbeat, heartbeat_seq: 2, displayed_robot_frame: robot, backend_boot_id: "old-boot" })).toBe(false);
  expect(eventSocket.heartbeat({ ...heartbeat, heartbeat_seq: 2, displayed_robot_frame: robot, control_generation: 1 })).toBe(false);
  expect(eventSocket.heartbeat({ ...heartbeat, heartbeat_seq: 2, displayed_robot_frame: robot })).toBe(true);
  expect(eventSocket.heartbeat({ ...heartbeat, heartbeat_seq: 2, displayed_robot_frame: robot })).toBe(false);
  const retry = data(await acquire());
  expect(retry.client_lease_id).toBe(lease.client_lease_id);
  expect(retry.snapshot.event_seq).toBeGreaterThan(lease.snapshot.event_seq);
  expect(retry.snapshot.readiness.can_start).toEqual({ Gestures: true, Controller: true });
  expect(JSON.stringify(events)).not.toContain(lease.client_lease_id);

  // Independent expiry revokes even with the event channel still connected and no release request.
  await vi.advanceTimersByTimeAsync(profile.heartbeat_deadline_ms + 1);
  expect((await read()).lease.state).toBe("Unowned");
  expect(data(await acquire())).toMatchObject({
    client_lease_id: lease.client_lease_id, lease: { state: "Owned" }, snapshot: { lease: { state: "Unowned" } },
  });
  expect(await transport.request("POST /control-lease", { context, body: { ...body, request_id: crypto.randomUUID() } }))
    .toMatchObject({ error: { code: "INVALID_TRANSITION" } });
  const takeover = data(await transport.request("POST /control-lease", { context,
    body: { ...body, request_id: crypto.randomUUID(), takeover: true } }));
  const release = { client_id: context.client_id, session_id: null, client_lease_id: takeover.client_lease_id!,
    control_generation: takeover.control_generation, request_id: body.request_id };
  await expect(transport.request("POST /control-lease/release", { context, body: release }))
    .resolves.toMatchObject({ error: { code: "REQUEST_ID_CONFLICT" } });
  const replacement = data(transport.connectEvents({ context }, await ticket(transport, context, "events"), silent));
  expect((await read()).lease.state).toBe("Unowned");
  expect(eventSocket.heartbeat({ ...heartbeat, client_lease_id: takeover.client_lease_id! })).toBe(false);
  const newLease = data(await transport.request("POST /control-lease", { context,
    body: { ...body, request_id: crypto.randomUUID(), takeover: true } }));
  const releaseBody = { ...release, client_lease_id: newLease.client_lease_id!, control_generation: newLease.control_generation,
    request_id: crypto.randomUUID() };
  const releaseOnce = () => transport.request("POST /control-lease/release", { context, body: releaseBody });
  const released = data(await releaseOnce());
  expect(released.client_lease_id).toBeNull();
  expect(data(await releaseOnce())).toEqual(released);
  replacement.close();
});
