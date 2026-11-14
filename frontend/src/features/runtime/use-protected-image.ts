"use client";

import { useCallback } from "react";
import type { LoadImage } from "@/components/media/protected-image";
import type { Media } from "@/generated/api-v1";
import { useRuntime } from "./runtime-provider";

export function useProtectedImage({ id, availability }: Media) {
  const runtime = useRuntime()?.connection?.runtime;
  return useCallback<LoadImage>(async (signal) => {
    if (availability === "Missing") return { kind: "missing" };
    if (availability === "Corrupt") return { kind: "corrupt" };
    const result = await runtime?.media(id, signal);
    if (result?.kind === "ok") {
      const { bytes, headers } = result.data;
      return { kind: "ok", image: new Blob([bytes], { type: headers["Content-Type"] }) };
    }
    if (result?.kind === "api-error" && result.status === 410) {
      return { kind: "expired", detail: "Access to this reference has ended." };
    }
    if (result?.kind === "api-error" && result.status === 404) return { kind: "not-found" };
    return { kind: "unavailable", detail: "The reference image could not be retrieved." };
  }, [availability, id, runtime]);
}
