import type { ApplicationTransport } from "./transport";

export async function createFixtureAdapter(): Promise<ApplicationTransport> {
  const { createFixtureTransport } = await import("./fixtures/transport");
  return createFixtureTransport();
}

export async function createFixtureHarness() {
  const { createScenarioHarness } = await import("./fixtures/harness");
  return createScenarioHarness();
}
