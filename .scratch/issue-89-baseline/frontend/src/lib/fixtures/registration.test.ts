import { expect, test } from "vitest";
import { createFixtureTransport } from "./transport";
import { day, sampleTime } from "./samples";
import { sampleImage } from "./images";

test("concurrent registration attempts join one receipt and current protected reads agree", async () => {
  let now = sampleTime;
  const normalized = new Blob([sampleImage("image/png")], { type: "image/png" });
  const encoded = Promise.withResolvers<{ width: number; height: number; blob: Blob }>();
  const transport = createFixtureTransport({ scenario: "searching", now: () => now, normalizeRegistration: () => encoded.promise });
  const bootstrap = await transport.bootstrap();
  if (bootstrap.kind !== "ok") throw new Error("Fixture bootstrap failed");
  const context = bootstrap.data;
  const actionCreatedAtMs = now;
  const request = { context, actionCreatedAtMs, body: {
    action_id: crypto.randomUUID(), name: "\u0085Cafe\u0301  keys\u00a0", roi: { x: 1, y: 2, width: 12, height: 11 },
    reference_image: normalized,
  } };
  const first = transport.request("POST /objects", request);
  const duplicate = transport.request("POST /objects", request);
  const list = () => transport.request("GET /objects", { context, query: { name: "CAFÉ  keys", status: "Lost" } });
  await expect(list()).resolves.toMatchObject({ data: { items: [] } });
  now += 100;
  encoded.resolve({ width: 32, height: 24, blob: normalized });
  const response = await first;
  await expect(duplicate).resolves.toEqual(response);
  if (response.kind !== "ok") throw new Error("Registration failed");
  const record = response.data.result?.object;
  if (!record) throw new Error("Registration receipt lacks an object");
  expect(record).toMatchObject({ name: "Café  keys", registered_at_ms: now, expires_at_ms: now + 7 * day, status: "Lost" });
  await expect(list()).resolves.toMatchObject({ data: { items: [record] } });
  await expect(transport.get("/objects/{id}", { context, id: record.id })).resolves.toMatchObject({ data: record });
  await expect(transport.media(record.reference_media.id, { context })).resolves.toMatchObject({
    data: { bytes: new Uint8Array(await normalized.arrayBuffer()), headers: { "Content-Type": "image/png", "Cache-Control": "no-store" } },
  });
  await expect(transport.snapshot({ context })).resolves.toMatchObject({
    data: { active_session: { state: "Searching", object_id: "sample-wallet" } },
  });
  now += 600_001;
  await expect(transport.request("POST /objects", request)).resolves.toEqual(response);
  await expect(transport.request("POST /objects", { ...request, actionCreatedAtMs: actionCreatedAtMs + 1 }))
    .resolves.toMatchObject({ error: { code: "ACTION_ID_CONFLICT" } });
  await expect(transport.request("POST /objects", { ...request, body: { ...request.body, action_id: crypto.randomUUID() } }))
    .resolves.toMatchObject({ error: { code: "ACTION_EXPIRED" } });
  now = record.expires_at_ms;
  await expect(list()).resolves.toMatchObject({ data: { items: [] } });
  await expect(transport.media(record.reference_media.id, { context })).resolves.toMatchObject({ status: 410 });
  await expect(transport.request("POST /objects", request)).resolves.toMatchObject({ error: { code: "EXPIRED" } });
  transport.dispose();
});

test.each(["failed", "deletion-failed"] as const)("blocks new registration when fixture storage is %s", async (scenario) => {
  const transport = createFixtureTransport({ scenario, now: () => sampleTime });
  const bootstrap = await transport.bootstrap();
  if (bootstrap.kind !== "ok") throw new Error("Fixture bootstrap failed");
  await expect(transport.request("POST /objects", { context: bootstrap.data, actionCreatedAtMs: sampleTime, body: {
    action_id: crypto.randomUUID(), name: "New keys", reference_image: new Blob([sampleImage("image/jpeg")]),
    roi: { x: 0, y: 0, width: 1, height: 1 },
  } })).resolves.toMatchObject({ kind: "api-error", status: 503, error: { code: "STORAGE_UNAVAILABLE" } });
  transport.dispose();
});
