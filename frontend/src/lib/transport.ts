import type {
  BootstrapResponse, Channel, EmergencyStopRequest, Error as ApiError, EventEnvelope, HttpBodies,
  HttpResponses, Object as LostObject, Token,
} from "@/generated/api-v1";

export type ClientContext = Pick<BootstrapResponse, "backend_boot_id" | "capability" | "client_id">;

export type ReadResult<T> =
  | { kind: "ok"; status: number; data: T; location?: string }
  | { kind: "api-error"; status: number; error: ApiError; retryAfter?: number }
  | { kind: "unavailable" };

export type Endpoint = Exclude<keyof HttpResponses, "GET /bootstrap">;
export type ProtectedPath = {
  [Route in Endpoint]: Route extends `${infer Method} ${infer Path}` ? Method extends "GET" ? Path : never : never;
}[Endpoint];
export type PageQuery = { cursor?: Token; limit?: number };
export type ObjectQuery = PageQuery & { name?: string; status?: LostObject["status"] };
export type ProtectedRequest = { context: ClientContext; signal?: AbortSignal };
type RouteParams<Route> = Route extends `${string}{id}${string}` ? { id: string } : { id?: never };
type RouteQuery<Route> = Route extends "GET /objects" ? { query?: ObjectQuery }
  : Route extends "GET /objects/{id}/sessions" | "GET /sessions/{id}/matches" ? { query?: PageQuery } : { query?: never };
type RouteBody<Route> = Route extends "POST /objects"
  ? { body: HttpBodies["POST /objects"] & { reference_image: Blob }; actionCreatedAtMs: number }
  : Route extends keyof HttpBodies ? { body: HttpBodies[Route] } : { body?: never };
export type HttpRequest<Route extends Endpoint> = ProtectedRequest & RouteParams<Route> & RouteQuery<Route> & RouteBody<Route>;

export type ProtectedMedia = {
  bytes: Uint8Array<ArrayBuffer>;
  headers: {
    "Content-Type": "image/jpeg" | "image/png";
    "Cache-Control": "no-store";
    "X-Content-Type-Options": "nosniff";
    "Accept-Ranges": "none";
  };
};

export interface ApplicationTransport {
  bootstrap(signal?: AbortSignal): Promise<ReadResult<BootstrapResponse>>;
  request<Route extends Endpoint>(route: Route, request: HttpRequest<Route>): Promise<ReadResult<HttpResponses[Route]>>;
  get<Path extends ProtectedPath>(
    path: Path,
    request: ProtectedRequest & { id?: string },
  ): Promise<ReadResult<HttpResponses[`GET ${Path}`]>>;
  snapshot(request: ProtectedRequest): Promise<ReadResult<HttpResponses["GET /snapshot"]>>;
  subscribeEvents(request: ProtectedRequest, onEvent: (event: EventEnvelope) => void): () => void;
  subscribeFrames(request: ProtectedRequest, source: "robot" | "webcam", onFrame: (frame: Uint8Array) => void): () => void;
  media(id: string, request: ProtectedRequest): Promise<ReadResult<ProtectedMedia>>;
  emergency(body: EmergencyStopRequest, request: ProtectedRequest): Promise<ReadResult<HttpResponses["POST /emergency-stop"]>>;
  dispose(): void;
}

const clientHeaderRoutes: ReadonlySet<Endpoint> = new Set([
  "POST /objects", "GET /snapshot", "GET /objects", "GET /objects/{id}/sessions",
  "GET /sessions/{id}/matches", "POST /settings/retention-preview", "PUT /settings/retention",
]);

export function protectedHeaders<Route extends Endpoint>(route: Route, request: HttpRequest<Route>) {
  const headers = new Headers({ "X-App-Capability": request.context.capability });
  if (clientHeaderRoutes.has(route)) headers.set("X-App-Client-Id", request.context.client_id);
  if (route === "POST /objects" && "actionCreatedAtMs" in request) {
    headers.set("X-Action-Created-At-Ms", String(request.actionCreatedAtMs));
  }
  return headers;
}

export function socketOffer(channel: Channel, ticket: Token) {
  const path = { events: "/events", "robot-video": "/video/robot", "webcam-video": "/video/webcam" } as const;
  return { path: path[channel], protocols: ["laf.v1", `laf.ticket.${ticket}`] as const };
}
