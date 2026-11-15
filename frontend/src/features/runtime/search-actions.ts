import type { ControlMode, Error as ApiError, MutationResponse, Object as ObjectRecord, Session, SessionAction, Snapshot, StartRequest } from "@/generated/api-v1";
import { conforms } from "@/lib/fixture-contracts";
import type { ApplicationTransport, ClientContext, ReadResult } from "@/lib/transport";

export type SearchIntent = { kind: "start"; object: ObjectRecord; mode: ControlMode }
  | { kind: "pause" | "resume" | "stop"; sessionId: string };

export type SearchFeedback = { stage: "sending" | "pending" | "unknown" }
  | { stage: "rejected" | "failed"; message: string }
  | { stage: "committed"; session: Session | null };

type ActionBody = StartRequest | Extract<SessionAction, { action: "pause" | "resume" | "stop" }>;
type Action = { context: ClientContext; body: ActionBody; objectId: string; feedback: SearchFeedback; timer?: ReturnType<typeof setTimeout> };

export const searchActionKey = (kind: SearchIntent["kind"], id: string) => `${kind}:${id}`;
export function unresolved(feedback?: SearchFeedback) {
  return feedback?.stage === "sending" || feedback?.stage === "pending" || feedback?.stage === "unknown";
}

export function openSearchActions({
  transport, signal, notify, refresh,
}: {
  transport: ApplicationTransport;
  signal: AbortSignal;
  notify(feedback: Readonly<Record<string, SearchFeedback>>): void;
  refresh(code?: ApiError["code"]): void;
}) {
  const actions = new Map<string, Action>();

  function publish() {
    notify(Object.fromEntries([...actions].map(([key, action]) => [key, action.feedback])));
  }

  function current(action: Action) {
    return !signal.aborted && [...actions.values()].includes(action) && unresolved(action.feedback);
  }

  function resultMatches(body: ActionBody, session: Session | null) {
    if ("control_mode" in body) {
      return !!session && session.object_id === body.object_id && session.control_mode === body.control_mode && session.state === "Searching";
    }
    if (body.action === "stop" && session === null) return true; // Expiry grace ended with the committed Stop.
    return session?.id === body.session_id && session.revision >= body.expected_revision &&
      session.state === (body.action === "pause" ? "Paused" : body.action === "resume" ? "Searching" : "Ended") &&
      (body.action !== "stop" || session.end_reason === "Stopped");
  }

  function accept(action: Action, data: MutationResponse) {
    if (!current(action) || data.action_id !== action.body.action_id) return false;
    if (data.persistence === "Committed") {
      if (!resultMatches(action.body, data.result.session)) return false;
      action.feedback = { stage: "committed", session: data.result.session };
    } else if (data.persistence === "Failed") {
      action.feedback = { stage: "failed", message: data.error.message };
    } else {
      action.feedback = { stage: "pending" };
    }
    if (!unresolved(action.feedback)) clearTimeout(action.timer);
    publish();
    return true;
  }

  function reconcile(snapshot: Snapshot, context: ClientContext) {
    if (snapshot.backend_boot_id !== context.backend_boot_id) return;
    for (const action of actions.values()) {
      if (!current(action) || !sameContext(action.context, context)) continue;
      const receipt = snapshot.operations.find((operation) => operation.action_id === action.body.action_id && operation.request_id === null);
      if (receipt?.action_id && (receipt.persistence !== "Pending" || action.feedback.stage !== "pending")) accept(action, receipt);
    }
  }

  function poll(action: Action, remaining: number) {
    if (!current(action) || remaining === 0) return;
    clearTimeout(action.timer);
    action.timer = setTimeout(async () => {
      if (!current(action)) return;
      const snapshot = await transport.snapshot({ context: action.context, signal }).catch(() => undefined);
      if (snapshot?.kind === "ok" && conforms("Snapshot", snapshot.data)) reconcile(snapshot.data, action.context);
      poll(action, remaining - 1);
    }, 250 * (4 - remaining));
  }

  async function send(action: Action) {
    clearTimeout(action.timer);
    action.feedback = { stage: "sending" };
    publish();
    const { body, context } = action;
    let response: ReadResult<MutationResponse>;
    try {
      response = "control_mode" in body
        ? await transport.request("POST /sessions", { context, signal, body })
        : await transport.request("POST /sessions/{id}/actions", { context, signal, id: body.session_id, body });
    } catch {
      response = { kind: "unavailable" };
    }
    if (!current(action)) return; // An ordered event may already have resolved this action.
    if (response.kind === "api-error") {
      action.feedback = { stage: "rejected", message: `${response.error.code} · ${response.error.message}` };
      publish();
      refresh(response.error.code);
      return;
    }
    if (response.kind !== "ok" || !conforms("MutationResponse", response.data) || !accept(action, response.data)) {
      action.feedback = { stage: "unknown" };
      publish();
    }
    poll(action, 3);
    if (response.kind === "ok" && response.data.persistence === "Committed") refresh();
  }

  return {
    reconcile,
    submit(key: string, body: ActionBody, context: ClientContext, objectId: string) {
      if (unresolved(actions.get(key)?.feedback)) return;
      const action: Action = { body, context, objectId, feedback: { stage: "sending" } };
      actions.set(key, action);
      return send(action);
    },
    retry(key: string, context: ClientContext) {
      const action = actions.get(key);
      if (action && sameContext(action.context, context) &&
          (action.feedback.stage === "unknown" || action.feedback.stage === "pending")) return send(action);
    },
    clear() {
      for (const action of actions.values()) clearTimeout(action.timer);
      actions.clear();
      publish();
    },
    purge(owners: readonly string[]) {
      for (const [key, action] of actions) {
        if (!owners.includes(action.objectId) || (unresolved(action.feedback) &&
            "action" in action.body && action.body.action === "stop")) continue;
        clearTimeout(action.timer);
        actions.delete(key);
      }
      publish();
    },
  };
}

function sameContext(left: ClientContext, right: ClientContext) {
  return left.backend_boot_id === right.backend_boot_id && left.client_id === right.client_id && left.capability === right.capability;
}
