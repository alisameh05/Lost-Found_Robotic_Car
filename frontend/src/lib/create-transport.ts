import { readConfig } from "./config";
import type { ApplicationTransport, ReadResult } from "./transport";

export async function createTransport(): Promise<ApplicationTransport> {
  if (readConfig().fixtureEnabled) {
    const { createFixtureTransport } = await import("./fixtures/transport");
    return createFixtureTransport();
  }

  const unavailable = async (): Promise<ReadResult<never>> => ({ kind: "unavailable" });
  return { bootstrap: unavailable, get: unavailable };
}
