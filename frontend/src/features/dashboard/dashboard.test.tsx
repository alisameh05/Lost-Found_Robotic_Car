// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, test, vi } from "vitest";
import { RuntimeProvider, useRuntime } from "@/features/runtime";
import type { Object as ObjectRecord, Session, SessionPage } from "@/generated/api-v1";
import type { ApplicationTransport, Endpoint, HttpRequest, ReadResult } from "@/lib/transport";
import { DashboardScreen } from "./index";

afterEach(cleanup);

const serverTime = 1_800_000_000_000;
const unavailable = { kind: "unavailable" } as const;
const ok = <T,>(data: T) => ({ kind: "ok", status: 200, data } as const);

function object(id: string): ObjectRecord {
  return {
    id, name: `Object ${id}`, status: "Lost", registered_at_ms: serverTime - 2000, expires_at_ms: serverTime + 604_798_000,
    found_at_ms: null, revision: 1, retention_grace: false, roi: { x: 0, y: 0, width: 1, height: 1 },
    reference_media: {
      id: `media-${id}`, role: "Reference", content_type: "image/png", width: 1, height: 1, byte_length: 64,
      created_at_ms: serverTime - 2000, availability: "Missing",
    },
  };
}

function stoppedSession(id: string, objectId: string): Session {
  return {
    id, object_id: objectId, state: "Ended", end_reason: "Stopped", control_mode: "Controller",
    started_at_ms: serverTime - 1000, ended_at_ms: serverTime - 500, revision: 2, pause_causes: [],
  };
}

function transport(owners: ObjectRecord[], history: (owner: string) => Promise<ReadResult<SessionPage>>) {
  const request = vi.fn(async (route: Endpoint, params: HttpRequest<Endpoint>) => {
    if (route === "GET /objects") return ok({ items: owners, next_cursor: "more-objects" });
    if (route === "GET /objects/{id}/sessions" && params.id) return history(params.id);
    return unavailable;
  });
  const adapter: ApplicationTransport = {
    bootstrap: async () => ok({
      backend_boot_id: "boot", client_id: "client", capability: "capability", server_time_ms: serverTime, qualification_profile: null,
    }),
    get: vi.fn(async () => unavailable),
    request: request as ApplicationTransport["request"],
    snapshot: async () => unavailable,
    connectEvents: vi.fn(() => ({ kind: "unavailable" as const })),
    connectFrames: vi.fn(() => ({ kind: "unavailable" as const })),
    emergency: vi.fn(async () => unavailable),
    media: vi.fn(async () => unavailable),
    dispose: () => {},
  };
  return { adapter, request };
}

function SwitchScope() {
  const runtime = useRuntime();
  return <button onClick={() => runtime?.select("replacement")}>Switch sample scope</button>;
}

test("reads only bounded pages, cancels obsolete reads and removes a missing owner and its links", async () => {
  const deferred = Promise.withResolvers<ReadResult<SessionPage>>();
  const pending = Promise.withResolvers<ReadResult<SessionPage>>();
  const first = transport([object("c"), object("b"), object("a")], () => deferred.promise);
  const second = transport([object("removed"), object("current"), object("pending")], async (owner) => {
    if (owner === "pending") return pending.promise;
    if (owner === "removed") return { kind: "api-error", status: 410, error: { code: "EXPIRED", message: "Expired", retryable: false } };
    return ok({ items: [stoppedSession("current-session", owner)], next_cursor: "more-sessions" });
  });
  const openTransport = async (id: string) => ({ transport: id === "idle" ? first.adapter : second.adapter });
  render(<RuntimeProvider openTransport={openTransport}><SwitchScope /><DashboardScreen /></RuntimeProvider>);

  const objects = screen.getByRole("region", { name: "Recent objects" });
  const searches = screen.getByRole("region", { name: "Recent searches" });
  await within(objects).findByRole("link", { name: /Object c/ });
  expect(within(searches).getByRole("status").textContent).toContain("Loading recent searches");
  await waitFor(() => expect(first.request.mock.calls.map(([route, { id, query }]) => ({ route, id, query }))).toEqual([
    { route: "GET /health" },
    { route: "GET /objects", query: { limit: 3 } },
    { route: "GET /objects/{id}/sessions", id: "c", query: { limit: 3 } },
    { route: "GET /objects/{id}/sessions", id: "b", query: { limit: 3 } },
    { route: "GET /objects/{id}/sessions", id: "a", query: { limit: 3 } },
  ]));
  expect(first.adapter.get).not.toHaveBeenCalled();
  expect(first.adapter.media).not.toHaveBeenCalled();
  expect(first.adapter.emergency).not.toHaveBeenCalled();

  await userEvent.click(screen.getByRole("button", { name: "Switch sample scope" }));
  await within(searches).findByRole("link", { name: /Object current/ });
  expect(first.request.mock.calls.filter(([route]) => route.endsWith("/sessions"))
    .every(([, params]) => params.signal?.aborted)).toBe(true);
  await act(async () => deferred.resolve(ok({ items: [stoppedSession("stale-session", "c")], next_cursor: null })));
  expect(within(objects).queryByRole("link", { name: /Object removed|Object c\b/ })).toBeNull();
  expect(within(searches).queryByRole("link", { name: /Object c\b/ })).toBeNull();
  expect(within(searches).getByRole("status").textContent).toContain("Recent searches incomplete");
  await act(async () => pending.resolve(ok({ items: [], next_cursor: null })));
});

test("uses current reported grace and revalidates an expired grace owner on wake", async () => {
  const owners = [{ ...object("grace"), expires_at_ms: serverTime - 1, retention_grace: true }];
  const fixture = transport(owners, async (owner) => ok({ items: [stoppedSession("grace-session", owner)], next_cursor: null }));
  const openTransport = async () => ({ transport: fixture.adapter });
  render(<RuntimeProvider openTransport={openTransport}><DashboardScreen /></RuntimeProvider>);

  const objects = screen.getByRole("region", { name: "Recent objects" });
  const searches = screen.getByRole("region", { name: "Recent searches" });
  await within(searches).findByRole("link", { name: /Object grace/ });
  expect(within(objects).getByRole("link", { name: /Object grace/ })).toBeTruthy();
  owners.length = 0;
  fireEvent.focus(window);
  await waitFor(() => expect(within(objects).queryByRole("link", { name: /Object grace/ })).toBeNull());
  expect(within(searches).queryByRole("link", { name: /Object grace/ })).toBeNull();
});
