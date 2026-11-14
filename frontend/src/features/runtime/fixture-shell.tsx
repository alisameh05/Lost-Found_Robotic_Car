"use client";

import type { ReactNode } from "react";
import { createFixtureAdapter, createFixtureHarness } from "@/lib/create-transport";
import { RuntimeProvider } from "./runtime-provider";
import { RuntimeFrame } from "./runtime-shell";

async function openFixture() {
  return { transport: await createFixtureAdapter() };
}

async function openScenario(id: string) {
  const harness = await createFixtureHarness();
  const fixture = harness.open(id);
  return { harness, fixture, transport: fixture.transport };
}

export function FixtureShell({ harnessEnabled, children }: { harnessEnabled: boolean; children: ReactNode }) {
  return (
    <RuntimeProvider harnessEnabled={harnessEnabled} openTransport={harnessEnabled ? openScenario : openFixture}>
      <RuntimeFrame>{children}</RuntimeFrame>
    </RuntimeProvider>
  );
}
