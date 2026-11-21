"use client";

import { lazy, Suspense } from "react";
import { LoadingState } from "@/components/ui/feedback";
import { useRuntime } from "./runtime-provider";

const FixtureInspector = lazy(() => import("./fixture-inspector").then((module) => ({ default: module.FixtureInspector })));

export function DashboardFixtureControls() {
  const harnessEnabled = useRuntime()?.harnessEnabled;
  if (!harnessEnabled) return null;
  return <Suspense fallback={<LoadingState label="Loading fixture scenarios" />}><FixtureInspector /></Suspense>;
}
