import type { Error as ApiError } from "@/generated/api-v1";
import type { ReadResult } from "../transport";

export const fixtureOk = <T>(data: T, status = 200): ReadResult<T> => ({ kind: "ok", status, data });
export const fixtureError = (status: number, code: ApiError["code"], message: string): Extract<ReadResult<never>, { kind: "api-error" }> =>
  ({ kind: "api-error", status, error: { code, message, retryable: false } });
