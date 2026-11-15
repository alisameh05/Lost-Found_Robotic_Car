import type { MutationResponse, MutationResult, Operation } from "@/generated/api-v1";
import type { ReadResult } from "../transport";
import { emptyResult, mutation } from "./mutations";
import { fixtureError } from "./responses";

type Response = ReadResult<MutationResponse>;
export type SearchDelivery = "commit" | "pending" | "fail" | "lose-response" | "undelivered";
type SearchAction = "start" | "pause" | "resume" | "stop" | "confirm" | "reject" | "acknowledge";

export function openSearchSaves(publish: () => void) {
  const receipts = new Map<string, {
    owner: string;
    fingerprint: string;
    response: Extract<Response, { kind: "ok" }>;
    action?: SearchAction;
    settle?: (commit: boolean) => Response;
  }>();
  let delivery: SearchDelivery = "commit";

  function record(id: string, owner: string, fingerprint: string, response: Response) {
    if (response.kind === "api-error") {
      response = { kind: "ok", status: response.status, data: { action_id: id, persistence: "Failed", result: null, error: response.error } };
    }
    if (response.kind === "ok") receipts.set(id, { owner, fingerprint, response });
    return response;
  }

  function publishSaves() {
    publish();
    // An all-null terminal operation can be delivered to connected clients without retaining an expired receipt.
    for (const [id, { response: { data } }] of receipts) {
      if (data.persistence === "Committed" && Object.values(data.result).every((value) => value === null)) receipts.delete(id);
    }
  }

  return {
    replay(id: string, fingerprint: string): Response | undefined {
      const receipt = receipts.get(id);
      if (!receipt) return;
      if (receipt.fingerprint !== fingerprint) {
        return fixtureError(409, "ACTION_ID_CONFLICT", "This sample action ID was already used for another intent.");
      }
      const { data } = receipt.response;
      if (data.persistence !== "Failed" || !data.error.retryable) return receipt.response;
    },
    pending: (action?: SearchAction) => [...receipts.values()].some((entry) => !!entry.settle && (!action || entry.action === action)),
    operations(): Operation[] {
      return [...receipts.values()].map(({ response }) => ({ ...response.data, request_id: null }));
    },
    purge(owner: string) {
      for (const [id, receipt] of receipts) if (receipt.owner === owner) receipts.delete(id);
    },
    takeDelivery() {
      const next = delivery;
      delivery = "commit";
      return next;
    },
    script(next: SearchDelivery) { delivery = next; },
    finish(commit: boolean, only?: SearchAction) {
      for (const [id, receipt] of receipts) {
        if (!receipt.settle || (only && receipt.action !== only)) continue;
        receipts.delete(id);
        record(id, receipt.owner, receipt.fingerprint, receipt.settle(commit));
      }
      publishSaves();
    },
    admit(action: SearchAction, id: string, owner: string, fingerprint: string, outcome: SearchDelivery, settle: () => Response) {
      if (outcome === "pending") {
        const response = mutation(id, "Pending", emptyResult);
        receipts.set(id, { action, owner, fingerprint, response, settle: (commit) =>
          commit ? settle() : mutation(id, "Failed", emptyResult) });
        publishSaves();
        return response;
      }
      const response = record(id, owner, fingerprint, outcome === "fail" ? mutation(id, "Failed", emptyResult) : settle());
      publishSaves();
      return outcome === "lose-response" ? { kind: "unavailable" } as const : response;
    },
  };
}

export function committedSearch(id: string, result: Partial<MutationResult>, sessionLocation?: string) {
  return mutation(id, "Committed", { ...emptyResult, ...result }, sessionLocation ? 201 : 200, sessionLocation);
}
