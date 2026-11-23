import type { ControlMode, Error as ApiError, MutationResponse, MutationResult, Object as ObjectRecord, Session, SessionAction, Snapshot, StartRequest } from "@/generated/api-v1";
import { conforms } from "@/lib/fixture-contracts";
import type { ApplicationTransport, ClientContext, ReadResult } from "@/lib/transport";

export type SearchIntent = { kind: "start"; object: ObjectRecord; mode: ControlMode }
  | { kind: "pause" | "resume" | "stop"; sessionId: string }
  | { kind: "acknowledge"; sessionId: string; failureIds: [string, ...string[]] }
  | { kind: "confirm" | "reject"; sessionId: string; candidateId: string };

export type SearchFeedback = ({ stage: "sending" | "pending" | "unknown" }
  | { stage: "interrupted"; message: string }
  | { stage: "rejected"; message: string }
  | { stage: "failed"; message: string; retryable: boolean }
  | { stage: "committed"; session: Session | null }) & { candidateId?: string };

type ActionBody = StartRequest | SessionAction;
type Action = { context: ClientContext; body: ActionBody; objectId: string; feedback: SearchFeedback;
  request?: AbortController; timer?: ReturnType<typeof setTimeout>; retriedStop?: boolean };

export const searchActionKey = (kind: SearchIntent["kind"], id: string) => `${kind}:${id}`;
export function unresolved(feedback?: SearchFeedback) {
  return feedback?.stage === "sending" || feedback?.stage === "pending" || feedback?.stage === "unknown";
}

export function openSearchActions({
  transport, signal, notify, refresh, removed, ownsStopLease,
}: {
  transport: ApplicationTransport;
  signal: AbortSignal;
  notify(feedback: Readonly<Record<string, SearchFeedback>>): void;
  refresh(code?: ApiError["code"]): void;
  removed?(objectId: string, sessionId: string): void;
  ownsStopLease?(body: SessionAction, context: ClientContext): boolean;
}) {
  const actions = new Map<string, Action>();
  const interrupted = new Map<string, { objectId: string; feedback: SearchFeedback }>();
  let synchronized = true;

  function publish() {
    notify(Object.fromEntries([
      ...[...interrupted].map(([key, { feedback }]) => [key, feedback]),
      ...[...actions].map(([key, { body, feedback }]) =>
        [key, "candidate_id" in body ? { ...feedback, candidateId: body.candidate_id } : feedback]),
    ]));
  }

  function current(action: Action) {
    return synchronized && !signal.aborted && [...actions.values()].includes(action) && unresolved(action.feedback);
  }

  function cancel(action: Action) {
    action.request?.abort();
    clearTimeout(action.timer);
  }

  function resultMatches({ body, objectId }: Action, { session, match, object, settings, deletion }: MutationResult) {
    if ("control_mode" in body) {
      return !!session && session.object_id === body.object_id && session.control_mode === body.control_mode && session.state === "Searching";
    }
    if ((body.action === "stop" || body.action === "confirm") && !session) {
      return !match && !object && !settings && !deletion; // A terminal commit ended expiry grace.
    }
    if (session?.id !== body.session_id || session.object_id !== objectId || session.revision < body.expected_revision) return false;
    if (body.action === "confirm" || body.action === "reject") {
      if (!match || match.id !== body.candidate_id || match.session_id !== session.id ||
          match.object_id !== objectId || match.reviewed_at_ms === null || session.revision <= body.expected_revision) return false;
      return body.action === "confirm"
        ? match.disposition === "Confirmed" && session.end_reason === "Confirmed" && session.ended_at_ms === match.reviewed_at_ms &&
          object?.id === objectId && object.status === "Found" && object.found_at_ms === match.reviewed_at_ms
        : match.disposition === "Rejected" && session.state === "Paused" &&
          session.pause_causes.some(({ cause }) => cause === "ReviewRejected");
    }
    if (body.action === "stop") return session.end_reason === "Stopped";
    if (body.action === "acknowledge") return session.state !== "Ended";
    return session.state === (body.action === "pause" ? "Paused" : "Searching");
  }

  function accept(action: Action, data: MutationResponse) {
    if (!current(action) || data.action_id !== action.body.action_id) return false;
    if (data.persistence === "Committed") {
      if (!resultMatches(action, data.result)) return false;
      action.feedback = { stage: "committed", session: data.result.session };
      if (data.result.session === null && "session_id" in action.body) removed?.(action.objectId, action.body.session_id);
    } else if (data.persistence === "Failed") {
      action.feedback = { stage: "failed", message: data.error.message, retryable: data.error.retryable };
    } else {
      action.feedback = { stage: "pending" };
    }
    if (!unresolved(action.feedback)) clearTimeout(action.timer);
    publish();
    return true;
  }

  function reconcile(snapshot: Snapshot, context: ClientContext) {
    if (!synchronized || snapshot.backend_boot_id !== context.backend_boot_id) return;
    for (const action of actions.values()) {
      if (!current(action) || !sameContext(action.context, context)) continue;
      const receipt = snapshot.operations.find((operation) => operation.action_id === action.body.action_id && operation.request_id === null);
      if (!receipt?.action_id || (receipt.persistence === "Pending" && action.feedback.stage === "pending")) continue;
      if (receipt.persistence !== "Failed" || !retryStopAfterConflict(action, receipt.error)) accept(action, receipt);
    }
  }

  function retryStopAfterConflict(action: Action, error: ApiError): Promise<void> | undefined {
    const { body, context } = action;
    if (error.code !== "REVISION_CONFLICT" || !("action" in body) || body.action !== "stop" ||
        error.revision === undefined || error.revision <= body.expected_revision ||
        action.retriedStop || !ownsStopLease?.(body, context)) return;
    // This attempt was definitively rejected. The new revision needs its own receipt identity.
    action.retriedStop = true;
    action.body = { ...body, action_id: crypto.randomUUID(), expected_revision: error.revision };
    return send(action);
  }

  function poll(action: Action, remaining: number) {
    if (!current(action) || remaining === 0) return;
    clearTimeout(action.timer);
    action.timer = setTimeout(async () => {
      if (!current(action)) return;
      const request = action.request;
      const snapshot = await transport.snapshot({ context: action.context,
        signal: request ? AbortSignal.any([signal, request.signal]) : signal }).catch(() => undefined);
      if (!request || request.signal.aborted) return;
      if (snapshot?.kind === "ok" && conforms("Snapshot", snapshot.data)) reconcile(snapshot.data, action.context);
      poll(action, remaining - 1);
    }, 250 * (4 - remaining));
  }

  async function send(action: Action): Promise<void> {
    cancel(action);
    const request = new AbortController();
    action.request = request;
    const delivery = AbortSignal.any([signal, request.signal]);
    action.feedback = { stage: "sending" };
    publish();
    const { body, context } = action;
    let response: ReadResult<MutationResponse>;
    try {
      response = "control_mode" in body
        ? await transport.request("POST /sessions", { context, signal: delivery, body })
        : await transport.request("POST /sessions/{id}/actions", { context, signal: delivery, id: body.session_id, body });
    } catch {
      response = { kind: "unavailable" };
    }
    if (delivery.aborted || !current(action)) return;
    if (response.kind === "api-error" && response.error.action_id !== body.action_id) {
      const retry = retryStopAfterConflict(action, response.error);
      if (retry) return retry;
      action.feedback = { stage: "rejected", message: `${response.error.code} · ${response.error.message}` };
      publish();
      refresh(response.error.code);
      return;
    }
    const data = response.kind === "ok" && conforms("MutationResponse", response.data) ? response.data : undefined;
    if (data?.persistence === "Failed" && data.action_id === body.action_id) {
      const retry = retryStopAfterConflict(action, data.error);
      if (retry) return retry;
    }
    if (!data || !accept(action, data)) {
      action.feedback = { stage: "unknown" };
      publish();
    }
    poll(action, 3);
    if (data?.persistence === "Committed") refresh();
  }

  return {
    reconcile,
    synchronize(snapshot: Snapshot, context: ClientContext) {
      synchronized = true;
      reconcile(snapshot, context);
    },
    suspend() {
      synchronized = false;
      for (const action of actions.values()) {
        cancel(action);
        if (unresolved(action.feedback)) action.feedback = { stage: "unknown" };
      }
      publish();
    },
    changeAuthority() {
      for (const [key, action] of actions) {
        cancel(action);
        if (unresolved(action.feedback)) interrupted.set(key, { objectId: action.objectId,
          feedback: { stage: "interrupted", message: "The service changed before this action could be confirmed. Check the current saved records." } });
      }
      actions.clear();
      publish();
    },
    submit(key: string, body: ActionBody, context: ClientContext, objectId: string) {
      if (!synchronized || unresolved(actions.get(key)?.feedback)) return;
      interrupted.delete(key);
      const action: Action = { body, context, objectId, feedback: { stage: "sending" } };
      actions.set(key, action);
      return send(action);
    },
    retry(key: string, context: ClientContext) {
      const action = actions.get(key);
      if (synchronized && action && sameContext(action.context, context) &&
          (action.feedback.stage === "unknown" || action.feedback.stage === "pending" ||
            (action.feedback.stage === "failed" && action.feedback.retryable))) return send(action);
    },
    clear() {
      for (const action of actions.values()) cancel(action);
      actions.clear();
      interrupted.clear();
      publish();
    },
    purge(owners: readonly string[]) {
      for (const [key, action] of interrupted) if (owners.includes(action.objectId)) interrupted.delete(key);
      for (const [key, action] of actions) {
        if (!owners.includes(action.objectId)) continue;
        cancel(action);
        actions.delete(key);
      }
      publish();
    },
  };
}

function sameContext(left: ClientContext, right: ClientContext) {
  return left.backend_boot_id === right.backend_boot_id && left.client_id === right.client_id && left.capability === right.capability;
}
