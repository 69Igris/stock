/**
 * Cursor pagination (MONEY-402)
 *
 * Opaque, forward-only cursor pagination for the unbounded list endpoints. The
 * cursor is a base64url-encoded JSON snapshot of the sort key (e.g. `{ id }` for
 * keyset pagination, or `{ skip }` when bridging a service that only exposes an
 * offset) — opaque to the client, so the server can change what it encodes
 * without a breaking API change.
 *
 * This complements — does NOT replace — the offset {@link paginated} helper in
 * `../response` (still used by the trades list). Use cursor pagination for
 * append-only / large lists where stable forward paging matters more than random
 * page access.
 */

import type { ApiResponse } from "../response";

/**
 * Encode an opaque cursor from a sort-key snapshot.
 *
 * The value is JSON-serialised then base64url-encoded. Keep the key small and
 * stable (an id, or `{ createdAt, id }`) — it is echoed to the client verbatim.
 */
export function encodeCursor(key: Record<string, unknown>): string {
  return Buffer.from(JSON.stringify(key), "utf8").toString("base64url");
}

/**
 * Decode an opaque cursor back into its sort-key snapshot.
 *
 * Returns `null` for a missing, empty, non-base64, or non-object cursor (a
 * tampered/garbage `?cursor=` never throws — the route simply starts from the
 * first page).
 */
export function decodeCursor<T = Record<string, unknown>>(
  cursor: string | undefined | null,
): T | null {
  if (!cursor) return null;
  try {
    const json = Buffer.from(cursor, "base64url").toString("utf8");
    const parsed: unknown = JSON.parse(json);
    // Only a plain object keyset is a valid cursor — reject arrays/primitives
    // (a tampered `?cursor=` that decodes to `[…]`/`42` falls back to page 1).
    if (
      parsed !== null &&
      typeof parsed === "object" &&
      !Array.isArray(parsed)
    ) {
      return parsed as T;
    }
    return null;
  } catch {
    return null;
  }
}

/** Payload of a cursor-paginated response. */
export interface CursorPage<T> {
  /** The items in this page (already clamped to the page limit). */
  items: T[];
  /** Opaque cursor for the next page, or `null` when this is the last page. */
  nextCursor: string | null;
}

/**
 * Build a cursor-paginated success envelope:
 * `{ success: true, data: { items, nextCursor } }`.
 */
export function paginatedCursor<T>(
  items: T[],
  nextCursor: string | null,
): ApiResponse<CursorPage<T>> {
  return {
    success: true,
    data: { items, nextCursor },
  };
}
