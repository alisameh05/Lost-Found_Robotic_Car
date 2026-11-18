"use client";

import { useEffect } from "react";
import type { RuntimeProjection } from "./projection";

const largestTimeout = 2_147_483_647;

export function useRecordDeadline(runtime: RuntimeProjection | undefined, deadline: number, revalidate: () => void) {
  useEffect(() => {
    if (!runtime || !Number.isFinite(deadline)) return;
    const currentRuntime = runtime;
    let timer: ReturnType<typeof setTimeout> | undefined;
    function recheck() {
      clearTimeout(timer);
      const time = currentRuntime.serverTime();
      if (time === undefined) return;
      if (time >= deadline) revalidate();
      else timer = setTimeout(recheck, Math.min(deadline - time, largestTimeout));
    }
    recheck();
    window.addEventListener("focus", recheck);
    document.addEventListener("visibilitychange", recheck);
    return () => {
      clearTimeout(timer);
      window.removeEventListener("focus", recheck);
      document.removeEventListener("visibilitychange", recheck);
    };
  }, [deadline, revalidate, runtime]);
}
