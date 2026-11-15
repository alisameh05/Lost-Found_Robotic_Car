import { expect, test, vi } from "vitest";
import type { MutationResponse, Operation, StartRequest } from "@/generated/api-v1";
import { createFixtureHarness } from "@/lib/create-transport";
import type { ReadResult } from "@/lib/transport";
import { openSearchActions, searchActionKey, type SearchFeedback } from "./search-actions";

test("discarded deliveries cannot restore an operation, and a fresh receipt must match the original action and resource", async ({ onTestFinished }) => {
  const harness = await createFixtureHarness();
  const { transport, search } = harness.open("searching");
  const lifetime = new AbortController();
  onTestFinished(() => { lifetime.abort(); transport.dispose(); });
  const bootstrap = await transport.bootstrap();
  if (bootstrap.kind !== "ok") throw new Error("Expected fixture authorization");
  const context = bootstrap.data;
  const status = await transport.snapshot({ context });
  if (status.kind !== "ok" || !status.data.active_session || !status.data.active_object) throw new Error("Expected a search");
  const snapshot = status.data;
  const session = status.data.active_session;
  const target = status.data.active_object;
  const body: StartRequest = { action_id: crypto.randomUUID(), object_id: target.id, expected_revision: target.revision,
    control_mode: session.control_mode, client_id: context.client_id, client_lease_id: context.capability };
  const key = searchActionKey("start", body.object_id);
  let feedback: SearchFeedback | undefined;
  const actions = openSearchActions({ transport, signal: lifetime.signal, notify: (value) => { feedback = value[key]; }, refresh() {} });
  const receipt = { action_id: body.action_id, persistence: "Committed",
    result: { object: null, session, match: null, settings: null, deletion: null }, error: null } satisfies MutationResponse;
  const delayed = Promise.withResolvers<ReadResult<MutationResponse>>();
  const request = vi.spyOn(transport, "request").mockImplementationOnce(() => delayed.promise);
  const submission = actions.submit(key, body, context, target.id);
  actions.suspend();
  actions.synchronize(snapshot, context);
  delayed.resolve({ kind: "ok", data: receipt, status: 201 });
  await submission;
  expect(feedback).toMatchObject({ stage: "unknown" });

  const operation: Operation = { ...receipt, request_id: null };
  actions.reconcile({ ...snapshot, operations: [
    { ...operation, action_id: crypto.randomUUID() },
    { ...operation, result: { ...receipt.result, session: { ...session, object_id: "other-target" } } },
  ] }, context);
  expect(feedback).toMatchObject({ stage: "unknown" });

  actions.reconcile({ ...snapshot, operations: [operation] }, context);
  expect(feedback).toEqual({ stage: "committed", session });

  const oldBootDelivery = Promise.withResolvers<ReadResult<MutationResponse>>();
  request.mockImplementationOnce(() => oldBootDelivery.promise);
  const pending = { ...body, action_id: crypto.randomUUID() };
  const pendingSubmission = actions.submit(key, pending, context, target.id);
  actions.suspend();
  actions.changeAuthority();
  search.restart();
  const fresh = await transport.bootstrap();
  if (fresh.kind !== "ok") throw new Error("Expected replacement authority");
  actions.synchronize({ ...snapshot, backend_boot_id: fresh.data.backend_boot_id, operations: [] }, fresh.data);
  oldBootDelivery.resolve({ kind: "ok", status: 201, data: { ...receipt, action_id: pending.action_id } });
  await pendingSubmission;
  expect(feedback).toMatchObject({ stage: "interrupted" });
  expect(actions.retry(key, fresh.data)).toBeUndefined();
  expect(request).toHaveBeenCalledTimes(2);
});
