"use client";

import { useCallback } from "react";
import type { LoadImage } from "@/components/media/protected-image";
import type { Media } from "@/generated/api-v1";
import { useRuntime, useRuntimeView } from "./runtime-provider";

export function useProtectedImage({ id, availability, role }: Media) {
  const runtime = useRuntime()?.connection?.runtime;
  const { authority } = useRuntimeView();
  return useCallback<LoadImage>(async (signal) => {
    if (authority === undefined) return { kind: "unavailable" };
    if (availability === "Missing") return { kind: "missing" };
    if (availability === "Corrupt") return { kind: "corrupt" };
    const result = await runtime?.media(id, signal);
    if (result?.kind === "ok") {
      const { bytes, headers } = result.data;
      return { kind: "ok", image: new Blob([bytes], { type: headers["Content-Type"] }) };
    }
    if (result?.kind === "api-error" && result.status === 410) {
      return { kind: "expired", detail: "Access to this image has ended." };
    }
    if (result?.kind === "api-error" && result.status === 404) return { kind: "not-found" };
    return { kind: "unavailable", detail: role === "Evidence"
      ? "The captured evidence could not be retrieved." : "The reference image could not be retrieved." };
  }, [authority, availability, id, role, runtime]);
}
