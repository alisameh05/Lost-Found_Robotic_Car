import type { PageQuery, ReadResult } from "../transport";
import { conforms } from "../fixture-contracts";

export const defaultLimit = 25;
export const maxLimit = 100;
const cursorLifetime = 30 * 60_000;

type PageKey = { id: string; time: number };
type Cursor = { scope: string; boundary: PageKey; expires: number };
const descending = (left: PageKey, right: PageKey) => right.time - left.time ||
  (right.id === left.id ? 0 : right.id > left.id ? 1 : -1);

export function fixturePages() {
  const cursors = new Map<string, Cursor>();
  let sequence = 0;
  return {
    clear: () => cursors.clear(),
    read<T extends { id: string }>(items: readonly T[], timeOf: (item: T) => number, scope: string, query: PageQuery, now: number):
      ReadResult<{ items: T[]; next_cursor: string | null }> {
      const { limit = defaultLimit, cursor } = query;
      if (!Number.isInteger(limit) || limit < 1 || limit > maxLimit) {
        return { kind: "api-error", status: 422, error: {
          code: "VALIDATION_FAILED", message: "Invalid page limit.", retryable: false,
          field_errors: [{ path: "/limit", code: "OUT_OF_RANGE", message: "Use an integer from 1 to 100." }],
        } };
      }
      const pageScope = JSON.stringify([scope, limit]);
      const key = (item: T): PageKey => ({ id: item.id, time: timeOf(item) });
      let eligible = [...items].sort((left, right) => descending(key(left), key(right)));
      if (cursor !== undefined) {
        const entry = cursors.get(cursor);
        if (!conforms("Token", cursor) || (entry && entry.scope !== pageScope)) {
          return { kind: "api-error", status: 400, error: { code: "CURSOR_INVALID", message: "Invalid sample cursor.", retryable: false } };
        }
        if (!entry || entry.expires <= now) {
          return { kind: "api-error", status: 400, error: { code: "CURSOR_EXPIRED", message: "Sample cursor expired.", retryable: false } };
        }
        eligible = eligible.filter((item) => descending(key(item), entry.boundary) > 0);
      }
      const page = eligible.slice(0, limit);
      let next_cursor = null;
      const last = page.at(-1);
      if (last && limit < eligible.length) {
        // Fixture tokens are opaque references to private in-memory entries. Never encode an ID or filter.
        next_cursor = (++sequence).toString(16).padStart(42, "D") + "A";
        for (const [token, entry] of cursors) if (entry.expires <= now) cursors.delete(token);
        const oldest = cursors.keys().next().value;
        if (cursors.size >= 32 && oldest !== undefined) cursors.delete(oldest);
        cursors.set(next_cursor, { scope: pageScope, boundary: key(last), expires: now + cursorLifetime });
      }
      return { kind: "ok", status: 200, data: { items: page, next_cursor } };
    },
  };
}
