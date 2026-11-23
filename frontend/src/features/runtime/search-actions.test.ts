import { expect, onTestFinished, test, vi } from "vitest";
import type { Error as ApiError, MutationResponse, Operation, Session, SessionAction, StartRequest } from "@/generated/api-v1";
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

test.each(["confirm", "stop"] as const)("recognizes an all-null %s receipt from HTTP without an event", async (action) => {
  const harness = await createFixtureHarness();
  const { transport } = harness.open("candidate");
  const lifetime = new AbortController();
  onTestFinished(() => { lifetime.abort(); transport.dispose(); });
  const bootstrap = await transport.bootstrap();
  if (bootstrap.kind !== "ok") throw new Error("Expected fixture authorization");
  const context = bootstrap.data;
  const status = await transport.snapshot({ context });
  if (status.kind !== "ok" || !status.data.active_session || !status.data.pending_candidate) throw new Error("Expected a candidate");
  const { active_session: session, pending_candidate: candidate } = status.data;
  const common = { action_id: crypto.randomUUID(), client_id: context.client_id, client_lease_id: context.capability,
    session_id: session.id, expected_revision: session.revision };
  const body = action === "confirm" ? { ...common, action, candidate_id: candidate.id } : { ...common, action };
  const result = { object: null, session: null, match: null, settings: null, deletion: null };
  const request = vi.spyOn(transport, "request");
  const removed = vi.fn();
  const actions = openSearchActions({ transport, signal: lifetime.signal, removed, notify() {}, refresh() {} });
  const key = searchActionKey(action, session.id);
  request.mockResolvedValueOnce({ kind: "ok", status: 200, data: {
    action_id: crypto.randomUUID(), persistence: "Committed", result, error: null,
  } });
  await actions.submit(key, body, context, session.object_id);
  expect(removed).not.toHaveBeenCalled();
  request.mockResolvedValueOnce({ kind: "ok", status: 200, data: {
    action_id: body.action_id, persistence: "Committed", result, error: null,
  } });
  await actions.retry(key, context);
  expect(removed).toHaveBeenCalledExactlyOnceWith(session.object_id, session.id);
});

test.each(["admission", "save", "ordered save", "changed lease", "second conflict"] as const)(
  "recovers a Stop revision conflict once under the original lease (%s)", async (scenario) => {
    const harness = await createFixtureHarness();
    const { transport } = harness.open("candidate");
    const lifetime = new AbortController();
    onTestFinished(() => { lifetime.abort(); transport.dispose(); });
    const bootstrap = await transport.bootstrap();
    if (bootstrap.kind !== "ok") throw new Error("Expected fixture authorization");
    const context = bootstrap.data;
    const status = await transport.snapshot({ context });
    if (status.kind !== "ok" || !status.data.active_session) throw new Error("Expected a search");
    const session = status.data.active_session;
    const body: SessionAction = { action: "stop", action_id: crypto.randomUUID(), session_id: session.id,
      expected_revision: session.revision, client_id: context.client_id, client_lease_id: context.capability };
    const key = searchActionKey("stop", session.id);
    const error = { code: "REVISION_CONFLICT", message: "The saved record changed.", retryable: false,
      revision: session.revision + 1 } satisfies ApiError;
    const failed = { action_id: body.action_id, persistence: "Failed", result: null, error } satisfies MutationResponse;
    const saveResponse = { kind: "ok", status: 409, data: failed } satisfies ReadResult<MutationResponse>;
    const delayed = Promise.withResolvers<ReadResult<MutationResponse>>();
    const request = vi.spyOn(transport, "request");
    if (scenario === "ordered save") request.mockReturnValueOnce(delayed.promise);
    else request.mockResolvedValueOnce(scenario === "save" ? saveResponse : { kind: "api-error", status: 409, error });
    request.mockImplementationOnce(async (_operation, input) => {
      const sent = input.body as SessionAction;
      if (scenario === "second conflict") {
        return { kind: "api-error", status: 409, error: { ...error, revision: error.revision + 1 } };
      }
      const ended: Session = { ...session, state: "Ended", ended_at_ms: session.started_at_ms, end_reason: "Stopped",
        pause_causes: [], revision: error.revision + 1 };
      return { kind: "ok", status: 200, data: { action_id: sent.action_id, persistence: "Committed",
        result: { object: null, session: ended, match: null, settings: null, deletion: null }, error: null } };
    });
    const refresh = vi.fn();
    const ownsStopLease = vi.fn(() => scenario !== "changed lease");
    let feedback: SearchFeedback | undefined;
    const actions = openSearchActions({ transport, signal: lifetime.signal,
      notify: (value) => { feedback = value[key]; }, refresh, ownsStopLease });
    const submission = actions.submit(key, body, context, session.object_id);
    if (scenario === "ordered save") {
      actions.reconcile({ ...status.data, operations: [{ ...failed, request_id: null }] }, context);
      delayed.resolve(saveResponse);
    }
    await submission;
    expect(ownsStopLease).toHaveBeenCalledExactlyOnceWith(body, context);
    if (scenario === "changed lease") {
      expect(request).toHaveBeenCalledTimes(1);
      expect(feedback?.stage).toBe("rejected");
      return;
    }
    expect(request).toHaveBeenCalledTimes(2);
    const retried = request.mock.calls[1][1].body as SessionAction;
    expect(retried).toEqual({ ...body, action_id: expect.any(String), expected_revision: error.revision });
    expect(retried.action_id).not.toBe(body.action_id);
    await vi.waitFor(() => expect(feedback?.stage).toBe(scenario === "second conflict" ? "rejected" : "committed"));
  },
);
