import type { BootstrapResponse, Error as ApiError, HttpResponses } from "@/generated/api-v1";
import { conforms, type Definition } from "./fixture-contracts";
import { protectedHeaders, type ApplicationTransport, type Endpoint, type HttpRequest, type ReadResult } from "./transport";

const responses = {
  "GET /health": "Health",
  "GET /objects": "ObjectPage",
  "GET /settings": "Settings",
  "GET /snapshot": "Snapshot",
} as const satisfies Partial<Record<Endpoint, Definition>>;

const unavailable = { kind: "unavailable" } as const;
const deferred = { kind: "api-error", status: 503, error: {
  code: "NOT_READY", message: "This operation is unavailable in the records application.", retryable: false,
} } as const;

export function createHttpTransport(base: string): ApplicationTransport {
  const lifetime = new AbortController();

  async function getJson<T>(path: string, definition: Definition, headers?: Headers, signal?: AbortSignal): Promise<ReadResult<T>> {
    const scope = AbortSignal.any([lifetime.signal, AbortSignal.timeout(5_000), ...(signal ? [signal] : [])]);
    try {
      const response = await fetch(`${base}${path}`, {
        headers, signal: scope, cache: "no-store", redirect: "error", credentials: "omit",
      });
      if (!response.headers.get("content-type")?.startsWith("application/json")) return unavailable;
      const data: unknown = await response.json();
      if ((response.status === 200 || (definition === "Health" && response.status === 503)) && conforms(definition, data)) {
        return { kind: "ok", status: response.status, data: data as T };
      }
      if (!response.ok && conforms("Error", data)) {
        return { kind: "api-error", status: response.status, error: data as ApiError };
      }
    } catch {
      return unavailable;
    }
    return unavailable;
  }

  async function request<Route extends Endpoint>(route: Route, input: HttpRequest<Route>): Promise<ReadResult<HttpResponses[Route]>> {
    if (!Object.hasOwn(responses, route)) return deferred;
    const definition = responses[route as keyof typeof responses];
    const query = new URLSearchParams();
    for (const [name, value] of Object.entries(input.query ?? {})) {
      if (value !== undefined) query.set(name, String(value));
    }
    return getJson(route.slice(4) + (query.size ? `?${query}` : ""), definition, protectedHeaders(route, input), input.signal);
  }

  return {
    request,
    bootstrap: (signal) => getJson<BootstrapResponse>("/bootstrap", "BootstrapResponse", undefined, signal),
    get: (path, input) => request(`GET ${path}`, input as HttpRequest<`GET ${typeof path}`>),
    snapshot: (input) => request("GET /snapshot", input),
    connectEvents: () => deferred,
    connectFrames: () => deferred,
    media: async () => deferred,
    emergency: async () => deferred,
    dispose: () => lifetime.abort(),
  };
}
