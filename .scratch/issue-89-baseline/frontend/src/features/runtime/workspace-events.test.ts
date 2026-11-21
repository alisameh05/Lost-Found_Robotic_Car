import { expect, test } from "vitest";
import type { EventEnvelope, Operation } from "@/generated/api-v1";
import { createFixtureHarness } from "@/lib/create-transport";
import { projectWorkspaceEvent } from "./workspace-events";

test("accepts a replacement snapshot at its watermark and rejects gaps, revision regressions and invalid envelopes", async ({ onTestFinished }) => {
  const harness = await createFixtureHarness();
  const { transport } = harness.open("candidate");
  onTestFinished(() => transport.dispose());
  const boot = await transport.bootstrap();
  if (boot.kind !== "ok") throw new Error("Expected the fixture bootstrap");
  const snapshot = await transport.snapshot({ context: boot.data });
  if (snapshot.kind !== "ok" || !snapshot.data.active_session) throw new Error("Expected a candidate session");
  const { active_session, backend_boot_id, event_seq } = snapshot.data;
  const envelope = { protocol_version: 1, backend_boot_id, event_seq, session_id: active_session.id,
    session_revision: active_session.revision, occurred_at_ms: boot.data.server_time_ms } as const;
  const first = { ...envelope, type: "snapshot", payload: snapshot.data } as const;
  const current = projectWorkspaceEvent(undefined, first, backend_boot_id);
  expect(current).toEqual(snapshot.data);
  const replacement = { ...first, payload: { ...snapshot.data, operations: [] } };
  expect(projectWorkspaceEvent(current, replacement, backend_boot_id)).toBe(replacement.payload);
  const resumed = { ...first, event_seq: event_seq + 7, payload: { ...snapshot.data, event_seq: event_seq + 7 } };
  expect(projectWorkspaceEvent(current, resumed, backend_boot_id, true)).toBe(resumed.payload);
  const receipt: Operation = { action_id: crypto.randomUUID(), request_id: null, persistence: "Committed", error: null,
    result: { object: null, session: active_session, match: null, settings: null, deletion: null } };
  const withReceipt = { ...snapshot.data, operations: [receipt] };
  const reordered = { deletion: null, settings: null, match: null, session: active_session, object: null };
  expect(projectWorkspaceEvent(withReceipt, { ...first, payload: { ...withReceipt,
    operations: [{ ...receipt, result: reordered }] } }, backend_boot_id)).toBeDefined();
  expect(projectWorkspaceEvent(withReceipt, { ...first, payload: { ...withReceipt,
    operations: [{ ...receipt, result: { ...receipt.result, session: null } }] } }, backend_boot_id)).toBeUndefined();
  const event = { ...envelope, event_seq: event_seq + 1, type: "proximity_warning_changed",
    payload: { proximity: snapshot.data.proximity } } as const;
  const updated = projectWorkspaceEvent(current, event, backend_boot_id);
  expect(updated?.event_seq).toBe(event.event_seq);
  expect(projectWorkspaceEvent(updated, event, backend_boot_id)).toBe(updated);
  expect(projectWorkspaceEvent(current, { ...event, event_seq: event_seq + 2 }, backend_boot_id)).toBeUndefined();
  expect(projectWorkspaceEvent(current, { ...event, session_revision: active_session.revision - 1 }, backend_boot_id)).toBeUndefined();
  expect(projectWorkspaceEvent(current, { ...event, type: "readiness_changed", payload: {
    readiness: { ...snapshot.data.readiness, can_resume: true }, runtime: snapshot.data.runtime,
  } }, backend_boot_id)).toBeUndefined();
  expect(projectWorkspaceEvent(current, { ...event, type: "readiness_changed", payload: {
    readiness: snapshot.data.readiness,
    runtime: { ...snapshot.data.runtime, control_generation: snapshot.data.runtime.control_generation + 1 },
  } }, backend_boot_id)).toBeUndefined();
  for (const invalid of [{ protocol_version: 2 }, { type: "unsupported" }, { backend_boot_id: "new-boot" }]) {
    expect(projectWorkspaceEvent(current, { ...event, ...invalid } as EventEnvelope, backend_boot_id)).toBeUndefined();
  }
});

test("projects the scoped candidate and rejects replacement evidence for the same match", async ({ onTestFinished }) => {
  const harness = await createFixtureHarness();
  const { transport } = harness.open("candidate");
  onTestFinished(() => transport.dispose());
  const boot = await transport.bootstrap();
  if (boot.kind !== "ok") throw new Error("Expected the fixture bootstrap");
  const snapshot = await transport.snapshot({ context: boot.data });
  if (snapshot.kind !== "ok" || !snapshot.data.active_session || !snapshot.data.pending_candidate) {
    throw new Error("Expected a paused fixture with prepared evidence");
  }
  const { active_session, backend_boot_id, event_seq, pending_candidate, runtime } = snapshot.data;
  const event: Extract<EventEnvelope, { type: "candidate_pending" }> = {
    type: "candidate_pending", protocol_version: 1, backend_boot_id, event_seq: event_seq + 1,
    session_id: active_session.id, session_revision: active_session.revision, occurred_at_ms: boot.data.server_time_ms,
    payload: { match: pending_candidate, control_generation: runtime.control_generation },
  };
  const before = { ...snapshot.data, pending_candidate: null };
  expect(projectWorkspaceEvent(before, {
    ...event, payload: { ...event.payload, control_generation: runtime.control_generation + 1 },
  }, backend_boot_id)).toBeUndefined();
  const accepted = projectWorkspaceEvent(before, event, backend_boot_id);
  expect(accepted?.pending_candidate).toEqual(pending_candidate);
  expect(projectWorkspaceEvent(accepted, {
    ...event, event_seq: event.event_seq + 1,
    payload: { ...event.payload, match: { ...pending_candidate, frame_id: "different-frame" } },
  }, backend_boot_id)).toBeUndefined();
});

test("an ordered removal clears the grace session and its receipts before any replacement snapshot", async ({ onTestFinished }) => {
  const harness = await createFixtureHarness();
  const { transport } = harness.open("expiry-grace");
  onTestFinished(() => transport.dispose());
  const boot = await transport.bootstrap();
  if (boot.kind !== "ok") throw new Error("Expected the fixture bootstrap");
  const snapshot = await transport.snapshot({ context: boot.data });
  if (snapshot.kind !== "ok" || !snapshot.data.active_session || !snapshot.data.active_object) throw new Error("Expected a grace session");
  const { active_session, active_object, backend_boot_id, event_seq } = snapshot.data;
  const receipt: Operation = { action_id: crypto.randomUUID(), request_id: null, persistence: "Committed", error: null,
    result: { object: active_object, session: active_session, match: null, settings: null, deletion: null } };
  const before = { ...snapshot.data, operations: [...snapshot.data.operations, receipt] };
  const next = projectWorkspaceEvent(before, {
    type: "object_removed", protocol_version: 1, backend_boot_id, event_seq: event_seq + 1,
    session_id: null, session_revision: null, occurred_at_ms: boot.data.server_time_ms,
    payload: { object_id: active_object.id, reason: "Expired" },
  }, backend_boot_id);
  expect(next).toMatchObject({ event_seq: event_seq + 1, active_session: null, active_object: null, pending_candidate: null,
    lease: { state: "Unowned" }, runtime: { effective_session_state: null, motion_permission: "Disarmed" },
    retention: { active_object_grace: false, active_object_expires_at_ms: null } });
  expect(next?.operations).not.toContainEqual(receipt);
});
