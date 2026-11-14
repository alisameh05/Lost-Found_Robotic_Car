import type { BootstrapResponse, Error as ApiError, GetResponses } from "@/generated/api-v1";

export type ClientContext = Pick<BootstrapResponse, "backend_boot_id" | "capability" | "client_id">;

export type ReadResult<T> =
  | { kind: "ok"; data: T }
  | { kind: "api-error"; status: number; error: ApiError }
  | { kind: "unavailable" };

export type ProtectedPath = Exclude<keyof GetResponses, "/bootstrap">;

export interface ApplicationTransport {
  bootstrap(signal?: AbortSignal): Promise<ReadResult<BootstrapResponse>>;
  get<Path extends ProtectedPath>(
    path: Path,
    request: { context: ClientContext; id?: string; signal?: AbortSignal },
  ): Promise<ReadResult<GetResponses[Path]>>;
}
