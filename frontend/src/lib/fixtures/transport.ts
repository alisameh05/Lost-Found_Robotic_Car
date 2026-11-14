import { randomBytes, randomUUID } from "node:crypto";
import type { BootstrapResponse, GetResponses } from "@/generated/api-v1";
import type { ApplicationTransport } from "../transport";
import { bootstrapFacts, snapshot, sampleObject, sampleSession } from "./samples";

export function createFixtureTransport(): ApplicationTransport {
  const bootstrap: BootstrapResponse = {
    ...bootstrapFacts,
    capability: randomBytes(32).toString("base64url"),
    client_id: randomUUID(),
  };
  const responses: GetResponses = {
    "/bootstrap": bootstrap,
    "/snapshot": snapshot,
    "/objects": { items: [sampleObject], next_cursor: null },
    "/objects/{id}": sampleObject,
    "/objects/{id}/sessions": { items: [sampleSession], next_cursor: null },
    "/sessions/{id}": sampleSession,
  };

  return {
    async bootstrap(signal) {
      signal?.throwIfAborted();
      return { kind: "ok", data: structuredClone(bootstrap) };
    },
    async get(path, { context, id, signal }) {
      signal?.throwIfAborted();
      if (context.backend_boot_id !== bootstrap.backend_boot_id || context.client_id !== bootstrap.client_id ||
          context.capability !== bootstrap.capability) {
        return { kind: "api-error", status: 403, error: { code: "CAPABILITY_INVALID", message: "Invalid fixture request context.", retryable: false } };
      }

      const missingObject = (path === "/objects/{id}" || path === "/objects/{id}/sessions") && id !== sampleObject.id;
      const missingSession = path === "/sessions/{id}" && id !== sampleSession.id;
      if (missingObject || missingSession) {
        return { kind: "api-error", status: 404, error: { code: "NOT_FOUND", message: "Sample record not found.", retryable: false } };
      }
      return { kind: "ok", data: structuredClone(responses[path]) };
    },
  };
}
