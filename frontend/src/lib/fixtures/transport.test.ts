import Ajv2020 from "ajv/dist/2020";
import { expect, test } from "vitest";
import seed from "@/generated/api-v1.seed.json";
import { createFixtureTransport } from "./transport";

const ajv = new Ajv2020({ allErrors: true, strict: false });
ajv.addSchema(seed, "api-v1");

test("fixture bootstrap, snapshot and sample reads conform to the approved API definitions", async () => {
  const transport = createFixtureTransport();
  const bootstrap = await transport.bootstrap();
  expect(bootstrap.kind).toBe("ok");
  if (bootstrap.kind !== "ok") throw new Error("Fixture bootstrap failed");
  expect(ajv.validate("api-v1#/$defs/BootstrapResponse", bootstrap.data), ajv.errorsText()).toBe(true);

  const context = bootstrap.data;
  const responses = [
    ["Snapshot", await transport.get("/snapshot", { context })],
    ["ObjectPage", await transport.get("/objects", { context })],
    ["Object", await transport.get("/objects/{id}", { context, id: "sample-wallet" })],
    ["SessionPage", await transport.get("/objects/{id}/sessions", { context, id: "sample-wallet" })],
    ["Session", await transport.get("/sessions/{id}", { context, id: "sample-search" })],
  ] as const;

  for (const [definition, response] of responses) {
    expect(response.kind).toBe("ok");
    if (response.kind !== "ok") throw new Error(`Fixture read failed for ${definition}`);
    const valid = ajv.validate(`api-v1#/$defs/${definition}`, response.data);
    expect(valid, ajv.errorsText()).toBe(true);
  }
  expect(ajv.validate("api-v1#/$defs/BootstrapResponse", { ...context, capability: "" })).toBe(false);
});

test("the adapter binds bootstrap credentials to each instance and supports cancelled reads", async () => {
  const first = createFixtureTransport();
  const second = createFixtureTransport();
  const bootstrap = await first.bootstrap();
  if (bootstrap.kind !== "ok") throw new Error("Fixture bootstrap failed");
  await expect(second.get("/snapshot", { context: bootstrap.data })).resolves.toMatchObject({
    kind: "api-error", error: { code: "CAPABILITY_INVALID" },
  });
  const signal = AbortSignal.abort();
  await expect(first.get("/snapshot", { context: bootstrap.data, signal })).rejects.toMatchObject({ name: "AbortError" });
});
