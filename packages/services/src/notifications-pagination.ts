/**
 * Notifications pagination — pure clamping logic (no Prisma / no I/O).
 *
 * Extracted from `notifications.service.ts#getNotifications` so the take/skip
 * bounds are an EXPORTED, unit-testable symbol the real service CALLS — not an
 * inline expression. Both untrusted entrypoints reach this:
 *   - web  `getNotificationsAction(limit, skip)` forwards its params verbatim.
 *   - api  `GET /v1/notifications` does `parseInt(query("limit"))` → can be NaN.
 *
 * Without clamping, a `NaN` / negative / absurd `take`|`skip` flows straight to
 * `prisma.notification.findMany`. Prisma 5 THROWS on a non-finite or negative
 * `take`/`skip` (`Invalid value … Expected Int`), turning a stray query string
 * into a 500. `clampPagination` makes those inputs safe + deterministic.
 *
 * @see apps/web/__tests__/notifications/pagination-logic.test.ts
 */

/** Default page size when `limit` is omitted/unusable. */
export const DEFAULT_NOTIFICATION_LIMIT = 20;

/**
 * Hard ceiling on a single page. Bounds memory + payload regardless of what a
 * caller (or a hand-crafted `?limit=` query) asks for.
 */
export const MAX_NOTIFICATION_LIMIT = 100;

/**
 * Hard ceiling on `skip`. A forged/absurd cursor (`{ skip: 1e300 }`) survives the
 * finite check yet exceeds Prisma's 32-bit `Int` for `skip`, which THROWS
 * ("Unable to fit value … into a 32-bit signed integer") → a 500. Capping keeps a
 * deep but sane offset intact while neutralising the overflow. 1e6 is far beyond
 * any real notification page depth.
 */
export const MAX_NOTIFICATION_SKIP = 1_000_000;

export interface PaginationBounds {
  /** Safe `take`: integer in [1, MAX_NOTIFICATION_LIMIT]. */
  take: number;
  /** Safe `skip`: non-negative integer in [0, MAX_NOTIFICATION_SKIP]. */
  skip: number;
}

/**
 * Coerce a possibly-untrusted numeric input to a finite integer, or `null` when
 * it can't be (NaN, ±Infinity, non-number). Floats are truncated toward zero.
 */
function toFiniteInt(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  return Math.trunc(value);
}

/**
 * Clamp a (limit, skip) pair into safe Prisma `take`/`skip` bounds.
 *
 * - `limit`: NaN / Infinity / non-number / ≤ 0 → DEFAULT_NOTIFICATION_LIMIT;
 *   anything above MAX_NOTIFICATION_LIMIT is capped to it; floats truncated.
 * - `skip`: NaN / Infinity / non-number / negative → 0; anything above
 *   MAX_NOTIFICATION_SKIP is capped to it (Prisma 32-bit Int overflow guard);
 *   floats truncated.
 *
 * Pure + total: never throws, always returns finite positive `take` and a
 * non-negative `skip` in [0, MAX_NOTIFICATION_SKIP].
 */
export function clampPagination(
  limit: unknown = DEFAULT_NOTIFICATION_LIMIT,
  skip: unknown = 0,
): PaginationBounds {
  const rawLimit = toFiniteInt(limit);
  const take =
    rawLimit === null || rawLimit <= 0
      ? DEFAULT_NOTIFICATION_LIMIT
      : Math.min(rawLimit, MAX_NOTIFICATION_LIMIT);

  const rawSkip = toFiniteInt(skip);
  const safeSkip =
    rawSkip === null || rawSkip < 0
      ? 0
      : Math.min(rawSkip, MAX_NOTIFICATION_SKIP);

  return { take, skip: safeSkip };
}
