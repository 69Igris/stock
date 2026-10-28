/**
 * V1 query helpers
 *
 * Pagination bounds (page ≥ 1, limit clamped to [1, 100], skip saturated at
 * MAX_SKIP = 1e6) and the truthy-only
 * filter builder were duplicated inline across the v1 route handlers
 * (`trades.ts`, `paired.ts`, `holdings.ts`, `positions.ts`). They're extracted
 * here so the bounds-validation contract — which prevents an unbounded
 * `?limit=999999` from issuing a huge DB query — is tested against the real
 * source and shared by every route. These are imported & called by the route
 * handlers; there are NO dead exports.
 *
 * @see apps/api/__tests__/routes/v1.test.ts
 * @see apps/api/__tests__/routes/v1-helpers.test.ts
 */

import { decodeCursor, encodeCursor } from "@usemoney/api-utils/pagination";

/** Default page when `?page` is absent. */
export const DEFAULT_PAGE = 1;
/** Default page size when `?limit` is absent. */
export const DEFAULT_LIMIT = 50;
/** Hard ceiling on page size; protects the DB from unbounded reads. */
export const MAX_LIMIT = 100;
/**
 * Hard ceiling on the computed `skip` offset. `parsePage` clamps only the
 * LOWER bound, so `?page=99999999999&limit=100` used to produce
 * `skip ≈ 1e13` — past Prisma's 32-bit Int, which throws ("Unable to fit
 * value") and turned a stray query string into a 500 on every
 * offset-paginated family (trades, learning, quiz, roast, credits,
 * chat-history, documents, feedback). Consistent with `MAX_PAIRED_SKIP`
 * (paired.ts) and `MAX_NOTIFICATION_SKIP`
 * (packages/services/src/notifications-pagination.ts) — the same 1e6 bound.
 * Page/limit semantics are otherwise unchanged: `page` still echoes the
 * client's (≥1-clamped) value; only the derived offset saturates, so an
 * absurdly deep page degrades to the deepest servable slice instead of a 500.
 */
export const MAX_SKIP = 1_000_000;

/**
 * Parse `?page`, clamping to a minimum of 1.
 *
 * A non-numeric value (e.g. `"abc"`) must fall back to `defaultPage`, NOT NaN.
 * A NaN page propagates as `skip = (page - 1) * limit = NaN`, which Prisma
 * rejects ("Expected Int") — turning a stray `?page=abc` query into a 500 on
 * every offset-paginated list endpoint (credits/usage, feedback, quizzes,
 * roast). Mirrors the NaN-safety already applied to {@link parseLimit}.
 */
export function parsePage(
  value: string | undefined,
  defaultPage: number = DEFAULT_PAGE,
): number {
  const n = parseInt(value ?? "", 10);
  return Number.isFinite(n) ? Math.max(n, 1) : defaultPage;
}

/**
 * Parse `?limit`, clamping to `[1, max]` (default max {@link MAX_LIMIT}).
 */
export function parseLimit(
  value: string | undefined,
  defaultLimit: number = DEFAULT_LIMIT,
  max: number = MAX_LIMIT,
): number {
  // A non-numeric ?limit (e.g. "abc") must fall back to the default, NOT NaN —
  // a NaN limit silently produces an empty page (slice(start, NaN)) or a
  // single-page cap, making the caller's own data look absent.
  const parsed = parseInt(value ?? "", 10);
  const n = Number.isFinite(parsed) ? parsed : defaultLimit;
  return Math.min(Math.max(n, 1), max);
}

/**
 * `skip` (offset) for a 1-based page, saturated at {@link MAX_SKIP} so a huge
 * `?page` can never overflow Prisma's Int argument (see MAX_SKIP rationale).
 */
export function calculateSkip(page: number, limit: number): number {
  return Math.min((page - 1) * limit, MAX_SKIP);
}

/** Parsed pagination triple. */
export interface Pagination {
  page: number;
  limit: number;
  skip: number;
}

/**
 * Parse `page`/`limit` query strings into a clamped `{ page, limit, skip }`.
 */
export function parsePagination(query: {
  page?: string;
  limit?: string;
}): Pagination {
  const page = parsePage(query.page);
  const limit = parseLimit(query.limit);
  return { page, limit, skip: calculateSkip(page, limit) };
}

/**
 * Build a filter object from query params, dropping `undefined`/empty-string
 * values (mirrors the `{ ...(symbol && { symbol }) }` spread used in routes).
 */
export function buildFilter(
  params: Record<string, string | undefined>,
): Record<string, string> {
  const filter: Record<string, string> = {};
  for (const [key, value] of Object.entries(params)) {
    if (value) filter[key] = value;
  }
  return filter;
}

/** Default an exchange query param to `"NSE"` (used by watchlist routes). */
export function getExchangeDefault(exchange: string | undefined): string {
  return exchange || "NSE";
}

// ── Keyset (cursor) pagination for the portfolio list endpoints (MONEY-402) ──

/** An optional keyset page passed through to the list services. */
export interface ListPage {
  limit: number;
  cursorId?: string;
}

/**
 * Parse `?limit` + `?cursor` into an optional {@link ListPage} for the portfolio
 * list routes (holdings / positions / mutual funds).
 *
 * ADDITIVE CONTRACT: when `?limit` is ABSENT (or unparseable → NaN) this returns
 * `undefined`, so the route calls the service WITHOUT a page and gets the FULL,
 * unbounded list — the pre-pagination behaviour the web app depends on. When
 * `?limit` is present, the limit is clamped to `[1, MAX_LIMIT]` and the opaque
 * `?cursor` is decoded to its `{ id }` keyset (a garbage/stale cursor decodes to
 * `undefined` → first page). Pagination is OPT-IN via the presence of `?limit`.
 */
export function parseListPage(
  limitRaw: string | undefined,
  cursorRaw: string | undefined,
): ListPage | undefined {
  if (limitRaw === undefined) return undefined;
  const limit = parseLimit(limitRaw);
  if (!Number.isFinite(limit)) return undefined;
  const cursor = decodeCursor<{ id: string }>(cursorRaw);
  return { limit, cursorId: cursor?.id };
}

/**
 * Encode a service-returned keyset id into the opaque `nextCursor` a client
 * echoes back. `null`/`undefined` (last page / unbounded) → `null`.
 */
export function encodeIdCursor(id: string | null | undefined): string | null {
  return id ? encodeCursor({ id }) : null;
}
