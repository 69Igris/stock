/**
 * Cache freshness helper for quote / time-stamped data.
 *
 * A cached entry is "fresh" while its age (now − updatedAt) is strictly
 * less than the TTL. This is the shared predicate behind the news cache
 * staleness check (lib/actions/news.ts) and is exported so the boundary
 * behavior (exactly-at-TTL = stale, future timestamps = fresh, TTL=0 =
 * always stale) can be unit-tested directly.
 */

/** Default cache TTL in milliseconds (60 seconds). */
export const DEFAULT_QUOTE_TTL_MS = 60 * 1000;

/**
 * True iff `updatedAt` is newer than `ttlMs` ago, i.e. the entry has not
 * yet aged past its TTL. Uses a strict `<` so an entry exactly `ttlMs` old
 * is considered stale.
 */
export function isFresh(updatedAt: Date, ttlMs: number): boolean {
  return Date.now() - updatedAt.getTime() < ttlMs;
}
