import { expect, test } from "vitest";
import type { EventEnvelope } from "@/generated/api-v1";
import { createFixtureHarness } from "@/lib/create-transport";
import { projectWorkspaceEvent } from "./workspace-events";

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
