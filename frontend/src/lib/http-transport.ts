import type { BootstrapResponse, Error as ApiError, EventEnvelope, HttpResponses, MutationResponse } from "@/generated/api-v1";
import { protectedHeaders, type ApplicationTransport, type Endpoint, type HttpRequest, type ProtectedMedia, type ProtectedRequest, type ReadResult, type SocketObserver, type SocketOffer } from "./transport";
import { conforms, type Definition } from "./wire-contracts";

const responses = {
  "GET /health": "Health",
  "GET /objects": "ObjectPage",
  "GET /objects/{id}": "Object",
  "GET /objects/{id}/sessions": "SessionPage",
  "GET /sessions/{id}": "Session",
  "GET /sessions/{id}/matches": "MatchPage",
  "GET /settings": "Settings",
  "GET /snapshot": "Snapshot",
} as const satisfies Partial<Record<Endpoint, Definition>>;

const unavailable = { kind: "unavailable" } as const;
const deferred = { kind: "api-error", status: 503, error: {
  code: "NOT_READY", message: "This operation is unavailable in the records application.", retryable: false,
} } as const;

export function createHttpTransport(base: string): ApplicationTransport {
  const lifetime = new AbortController();

  function localFetch(path: string, signal?: AbortSignal, options?: RequestInit) {
    const scope = AbortSignal.any([lifetime.signal, AbortSignal.timeout(5_000), ...(signal ? [signal] : [])]);
    return fetch(base + path, {
      ...options, signal: scope, cache: "no-store", redirect: "error", credentials: "omit",
    });
  }

  async function readJson<T>(path: string, definition: Definition, signal?: AbortSignal, options?: RequestInit): Promise<ReadResult<T>> {
    try {
      const response = await localFetch(path, signal, options);
      if (!response.headers.get("content-type")?.startsWith("application/json")) return unavailable;
      const data: unknown = await response.json();
      if (definition === "MutationResponse" && conforms("MutationResponse", data)) {
        const mutation = data as MutationResponse;
        const object = mutation.result?.object;
        const location = response.headers.get("Location");
        if (response.status === 201 && mutation.persistence === "Committed" && object &&
            path === "/objects" &&
            location === "/api/v1/objects/" + encodeURIComponent(object.id)) {
          return { kind: "ok", status: response.status, data: data as T, location };
        }
        if (path === "/settings/retention" && response.status === 200 && mutation.persistence === "Committed" &&
            mutation.result?.settings && mutation.result.deletion && !location &&
            !object && !mutation.result.session && !mutation.result.match) {
          return { kind: "ok", status: response.status, data: data as T };
        }
        if ((response.status === 202 && mutation.persistence === "Pending") ||
            (response.status >= 400 && mutation.persistence === "Failed")) {
          return { kind: "ok", status: response.status, data: data as T };
        }
        return unavailable;
      }
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
    if (route === "POST /objects") {
      const registration = input as HttpRequest<"POST /objects">;
      const form = new FormData();
      form.set("action_id", registration.body.action_id);
      form.set("name", registration.body.name);
      form.set("roi", JSON.stringify(registration.body.roi));
      form.set("reference_image", registration.body.reference_image, "reference");
      return readJson("/objects", "MutationResponse", input.signal, {
        method: "POST", headers: protectedHeaders("POST /objects", registration), body: form,
      });
    }
    if (route === "POST /websocket-tickets" || route === "POST /settings/retention-preview" || route === "PUT /settings/retention") {
      const request = input as HttpRequest<typeof route>;
      const headers = protectedHeaders(route, request);
      headers.set("Content-Type", "application/json");
      return readJson(route.slice(route.indexOf(" ") + 1),
        route === "PUT /settings/retention" ? "MutationResponse" : route === "POST /websocket-tickets" ? "TicketResponse" : "RetentionPreview", input.signal, {
          method: route === "PUT /settings/retention" ? "PUT" : "POST", body: JSON.stringify(request.body), headers,
        });
    }
    if (!Object.hasOwn(responses, route)) return deferred;
    const definition = responses[route as keyof typeof responses];
    const query = new URLSearchParams();
    for (const [name, value] of Object.entries(input.query ?? {})) {
      if (value !== undefined) query.set(name, String(value));
    }
    const path = route.slice(4).replace("{id}", () => encodeURIComponent(input.id ?? ""));
    return readJson(path + (query.size ? "?" + query.toString() : ""), definition, input.signal, { headers: protectedHeaders(route, input) });
  }

  function connect<Message>(
    input: ProtectedRequest, offer: SocketOffer, observer: SocketObserver<Message>, parse: (value: unknown) => Message | undefined,
  ) {
    const signal = AbortSignal.any([lifetime.signal, ...(input.signal ? [input.signal] : [])]);
    if (signal.aborted) return unavailable;
    const url = new URL(base + offer.path);
    url.protocol = "ws:";
    const socket = new WebSocket(url, [...offer.protocols]);
    socket.binaryType = "arraybuffer";
    const timeout = setTimeout(failed, 5_000);
    let disposed = false;

    function close() {
      if (disposed) return;
      disposed = true;
      clearTimeout(timeout);
      signal.removeEventListener("abort", close);
      socket.close();
    }
    function failed() {
      if (disposed) return;
      close();
      observer.closed();
    }

    signal.addEventListener("abort", close, { once: true });
    socket.onopen = () => {
      clearTimeout(timeout);
      if (socket.protocol !== "laf.v1") failed();
    };
    socket.onerror = failed;
    socket.onclose = failed;
    socket.onmessage = ({ data }) => {
      if (disposed) return;
      const message = parse(data);
      if (message === undefined) failed();
      else observer.message(message);
    };
    return { kind: "ok", status: 200, data: {
      protocol: "laf.v1",
      close,
      heartbeat: () => false,
    } } as const;
  }

  return {
    request,
    bootstrap: (signal) => readJson<BootstrapResponse>("/bootstrap", "BootstrapResponse", signal),
    get: (path, input) => request(`GET ${path}`, input as HttpRequest<`GET ${typeof path}`>),
    snapshot: (input) => request("GET /snapshot", input),
    connectEvents: (input, offer, observer) => {
      const limit = input.context.qualification_profile?.max_event_message_bytes;
      if (!limit) return deferred;
      return connect(input, offer, observer, (value) => {
        if (typeof value !== "string" || value.length > limit || new TextEncoder().encode(value).length > limit) return;
        try {
          const event: unknown = JSON.parse(value);
          return conforms("EventEnvelope", event) ? event as EventEnvelope : undefined;
        } catch {
          return;
        }
      });
    },
    connectFrames: (input, _source, offer, observer) => {
      const limit = input.context.qualification_profile?.max_frame_bytes;
      if (!limit) return deferred;
      return connect(input, offer, observer, (value) =>
        value instanceof ArrayBuffer && value.byteLength <= limit ? new Uint8Array(value) : undefined);
    },
    async media(id, input): Promise<ReadResult<ProtectedMedia>> {
      try {
        const response = await localFetch("/media/" + encodeURIComponent(id), input.signal, {
          headers: { "X-App-Capability": input.context.capability },
        });
        const contentType = response.headers.get("Content-Type");
        if (!response.ok && contentType?.startsWith("application/json")) {
          const error: unknown = await response.json();
          if (conforms("Error", error)) return { kind: "api-error", status: response.status, error: error as ApiError };
        }
        if (response.status === 200 && (contentType === "image/png" || contentType === "image/jpeg") &&
            response.headers.get("Cache-Control") === "no-store" &&
            response.headers.get("X-Content-Type-Options") === "nosniff" && response.headers.get("Accept-Ranges") === "none") {
          return { kind: "ok", status: 200, data: {
            bytes: new Uint8Array(await response.arrayBuffer()),
            headers: { "Content-Type": contentType, "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff", "Accept-Ranges": "none" },
          } };
        }
      } catch {
        return unavailable;
      }
      return unavailable;
    },
    emergency: async () => deferred,
    dispose: () => lifetime.abort(),
  };
}
