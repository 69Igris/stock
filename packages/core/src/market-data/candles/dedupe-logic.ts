/**
 * Which duplicate `candles` row survives. MONEY-1482.
 *
 * ## WHY THIS IS IN `packages/core` AND NOT IN THE SCRIPT
 *
 * It decides which row gets DELETED, and a delete rule that nothing can execute
 * is a delete rule that nothing can check. `scripts/**` compiles as CommonJS
 * here, so a named export from a script is invisible to an ESM test import
 * (`exports: ['default']`, measured) — the pure half has to live where a test
 * can reach it. Same `<name>-logic.ts` (pure) + shell split the workers use.
 *
 * ## THE BUG THAT SHIPPED AND RAN BEFORE THIS EXISTED
 *
 * The tie-break was `String(b._id).localeCompare(String(a._id))`. But
 * `$runCommandRaw` returns ObjectIds as EXTENDED JSON — `{ "$oid": "6a91…" }`,
 * never a string — so `String()` yields `"[object Object]"` for EVERY row, the
 * comparator returned 0 universally, and the stable sort kept whichever row was
 * pushed FIRST: the OLDER one, the exact opposite of the documented rule.
 *
 * It decided every deletion rather than an edge case: all 59 QA duplicates were
 * `TIINGO_RT` vs `TIINGO_RT`, so authority tied on every group and the id was
 * the only discriminator. `localeCompare` returns a number for any input, so
 * nothing failed — it simply chose wrong, silently, 59 times.
 */
import {
  PRICE_SOURCE_AUTHORITY,
  UNKNOWN_SOURCE_AUTHORITY,
} from "../price-source-authority";

/** One candidate row, as `$runCommandRaw` hands it back. */
export interface DedupeRow {
  _id: unknown;
  source?: string | null;
}

export function candleSourceAuthority(
  source: string | null | undefined,
): number {
  if (!source) return UNKNOWN_SOURCE_AUTHORITY;
  return (
    PRICE_SOURCE_AUTHORITY[source.toUpperCase()] ?? UNKNOWN_SOURCE_AUTHORITY
  );
}

/**
 * A comparable id string, or null when the row has none.
 *
 * Accepts BOTH shapes on purpose: a driver that hands back a plain string and
 * one that hands back extended JSON are both legitimate, and assuming either
 * is how the original defect happened.
 */
export function candleIdKey(id: unknown): string | null {
  if (typeof id === "string") return id;
  if (id && typeof id === "object") {
    const oid = (id as { $oid?: unknown }).$oid;
    if (typeof oid === "string") return oid;
  }
  return null;
}

/**
 * The rows to DELETE, or null when the group cannot be ranked.
 *
 * Null means "authorities tie AND the ids cannot be ordered" — there is no
 * ground to prefer a survivor, so the caller reports and skips rather than
 * guessing. The previous form returned `n-1` losers unconditionally, which made
 * that refusal unreachable and the safety promise false for every group.
 */
export function candleDedupeLosers(
  rows: readonly DedupeRow[],
): DedupeRow[] | null {
  if (rows.length < 2) return [];
  const keyed = rows.map((r) => ({ row: r, key: candleIdKey(r._id) }));
  const authorities = new Set(rows.map((r) => candleSourceAuthority(r.source)));
  if (authorities.size === 1 && keyed.some((k) => k.key === null)) return null;
  const ranked = [...keyed].sort((a, b) => {
    const d =
      candleSourceAuthority(b.row.source) - candleSourceAuthority(a.row.source);
    if (d !== 0) return d;
    // Same authority: the LATER write is the correction. An ObjectId's hex is
    // monotonic in its leading 4-byte timestamp, so a string compare orders
    // them — but only once it IS a string.
    return (b.key ?? "").localeCompare(a.key ?? "");
  });
  return ranked.slice(1).map((k) => k.row);
}
