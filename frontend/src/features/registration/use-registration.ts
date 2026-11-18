import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import type { Error as ApiError, MutationResponse } from "@/generated/api-v1";
import type { RegistrationAction, RuntimeProjection } from "@/features/runtime";

type Save = { kind: "sending" | "pending" | "uncertain" } | { kind: "failed"; error: ApiError };
const polls = [250, 500, 1000, 2000];
// A route change discards editable drafts, but an unresolved action belongs to
// the current adapter lifetime and remains recoverable on return.
const unresolved = new WeakMap<RuntimeProjection, RegistrationAction>();

export function pendingRegistration(runtime?: RuntimeProjection) {
  return runtime && unresolved.get(runtime);
}

function wait(ms: number, signal: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    signal.throwIfAborted();
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", abort);
      resolve();
    }, ms);
    function abort() {
      clearTimeout(timer);
      reject(signal.reason);
    }
    signal.addEventListener("abort", abort, { once: true });
  });
}

export function useRegistration(runtime?: RuntimeProjection) {
  const router = useRouter();
  const [save, setSave] = useState<Save | undefined>(() => pendingRegistration(runtime) ? { kind: "uncertain" } : undefined);
  const [failedAction, setFailedAction] = useState<RegistrationAction>();
  const request = useRef<AbortController | undefined>(undefined);
  useEffect(() => () => request.current?.abort(), []);

  async function send(action: RegistrationAction) {
    if (!runtime || request.current) return;
    const controller = new AbortController();
    request.current = controller;
    const { signal } = controller;
    setSave({ kind: "sending" });

    function complete() {
      if (unresolved.get(runtime!) === action) unresolved.delete(runtime!);
    }
    function fail(error: ApiError) {
      complete();
      setFailedAction(error.retryable ? action : undefined);
      setSave({ kind: "failed", error });
    }
    function apply(response: MutationResponse): "pending" | "finished" {
      if (response.action_id === action.body.action_id) {
        if (response.persistence === "Pending") return "pending";
        if (response.persistence === "Failed" && response.error) {
          fail(response.error);
          return "finished";
        }
        const object = response.result?.object;
        if (response.persistence === "Committed" && object) {
          complete();
          void runtime!.refresh();
          router.replace(`/objects/${encodeURIComponent(object.id)}`);
          return "finished";
        }
      }
      setSave({ kind: "uncertain" });
      return "finished";
    }
    try {
      const result = await runtime.register(action, AbortSignal.any([signal, AbortSignal.timeout(8000)]));
      signal.throwIfAborted();
      if (result.kind === "api-error" && (!result.error.action_id || result.error.action_id === action.body.action_id)) {
        if (result.error.code === "CAPABILITY_INVALID" || result.error.code === "CLIENT_INVALID" ||
            result.error.code === "INITIALIZING" || result.error.code === "INTERNAL_ERROR") {
          setSave({ kind: "uncertain" });
        } else {
          fail(result.error);
        }
        return;
      }
      if (result.kind !== "ok") {
        setSave({ kind: "uncertain" });
        return;
      }
      if (apply(result.data) === "finished") return;
      setSave({ kind: "pending" });
      for (const ms of polls) {
        await wait(ms, signal);
        const snapshot = await runtime.read("GET /snapshot", {}, AbortSignal.any([signal, AbortSignal.timeout(1500)]));
        signal.throwIfAborted();
        if (snapshot.kind !== "ok") continue;
        const operation = snapshot.data.operations.find(({ action_id }) => action_id === action.body.action_id);
        if (operation && apply({ ...operation, action_id: action.body.action_id }) === "finished") return;
      }
    } catch {
      if (!signal.aborted) setSave({ kind: "uncertain" });
    } finally {
      if (request.current === controller) request.current = undefined;
      if (!signal.aborted) setBusy(false);
    }
  }

  const [busy, setBusy] = useState(false);
  function dispatch(action?: RegistrationAction) {
    if (!action || request.current) return;
    setBusy(true);
    void send(action);
  }
  return {
    save, busy, locked: Boolean(save && save.kind !== "failed"),
    submit(fields: Omit<RegistrationAction["body"], "action_id">) {
      if (!runtime || unresolved.has(runtime) || request.current) return;
      const previous = failedAction?.body;
      if (failedAction && previous?.name === fields.name && previous.reference_image === fields.reference_image &&
          previous.roi.x === fields.roi.x && previous.roi.y === fields.roi.y &&
          previous.roi.width === fields.roi.width && previous.roi.height === fields.roi.height) {
        unresolved.set(runtime, failedAction);
        dispatch(failedAction);
        return;
      }
      const actionCreatedAtMs = runtime.serverTime();
      if (actionCreatedAtMs === undefined) return;
      const action = { actionCreatedAtMs, body: { ...fields, action_id: crypto.randomUUID() } };
      unresolved.set(runtime, action);
      dispatch(action);
    },
    retry() { dispatch(pendingRegistration(runtime)); },
    clearFailure() { setSave((current) => current?.kind === "failed" ? undefined : current); },
  };
}
