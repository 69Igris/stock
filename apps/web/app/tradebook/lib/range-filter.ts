/**
 * Pure helpers for the Tradebook period-range filter.
 * Extracted out of the client component so they can be unit-tested
 * without spinning up React.
 *
 * MONEY-847: the `fy`/`pfy` windows are no longer hard-coded to 2025/2024 —
 * they are computed from a year param, and `matchesRange`/`rangeToDates` derive
 * "current FY" / "previous FY" from `now` on the IST (Asia/Kolkata) calendar so
 * a trade stamped just after the 1-Apr midnight IST boundary buckets correctly.
 * The dynamic FY DROPDOWN (every FY the user actually has) is built server-side
 * from real trade dates; these helpers still power the rolling quick pills and
 * the convenience current/previous-FY mapping.
 */

export type RangeId = "7d" | "30d" | "3m" | "fy" | "pfy" | "all";

/** IST is a fixed UTC+05:30 offset (no DST). */
const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;

/**
 * The Indian financial-year START calendar year for an instant, on the IST
 * calendar. The FY runs 1 Apr → 31 Mar, so Jan/Feb/Mar belong to the FY that
 * STARTED the previous April. Returns `null` for an Invalid Date.
 */
export function fyStartYear(value: Date): number | null {
  const ms = value.getTime();
  if (!Number.isFinite(ms)) return null;
  const ist = new Date(ms + IST_OFFSET_MS);
  const year = ist.getUTCFullYear();
  const month = ist.getUTCMonth(); // 0 = Jan … 2 = Mar, 3 = Apr
  return month >= 3 ? year : year - 1;
}

/**
 * The precise UTC instant bounds of an Indian FY, IST-anchored — the same window
 * `packages/services` `tax-logic.ts#fyWindowUtc` / `trades-logic.ts` compute and
 * the DB query keys off (MONEY-846). The FY runs 1-Apr 00:00:00.000 IST →
 * 31-Mar 23:59:59.999 IST; because the stored trade timestamps are UTC instants
 * the bounds are those IST wall-clock edges minus the +5:30 offset. Both bounds
 * INCLUSIVE.
 *
 *   year=2025 → gte 2025-03-31T18:30:00.000Z … lte 2026-03-31T18:29:59.999Z
 *
 * `fyWindowUtc` itself lives in `@usemoney/services`, but that package's root
 * barrel drags Prisma/server-only deps into the client bundle (standing rule:
 * no root-barrel import from client code) and `tax-logic` has no subpath export,
 * so this client-side helper replicates the (tiny, DST-free) arithmetic. The
 * shared boundary test asserts both windows agree at the seam instant.
 */
export function fyWindowUtc(startYear: number): { gte: Date; lte: Date } {
  // Date.UTC gives the UTC instant of an IST wall-clock time; subtract the
  // offset so it represents that IST moment. Months are 0-indexed (Apr=3, Mar=2).
  const gte = new Date(Date.UTC(startYear, 3, 1, 0, 0, 0, 0) - IST_OFFSET_MS);
  const lte = new Date(
    Date.UTC(startYear + 1, 2, 31, 23, 59, 59, 999) - IST_OFFSET_MS
  );
  return { gte, lte };
}

/**
 * Indian Financial Year runs 1 April → 31 March, anchored to IST (MONEY-846).
 * `year=2025` covers 1-Apr-2025 00:00 IST through 31-Mar-2026 23:59:59.999 IST.
 *
 * Previously the bounds were `new Date("2025-04-01")` (UTC midnight), so a trade
 * in the +5:30 sliver after 1-Apr IST midnight (e.g. 2025-03-31T20:30Z =
 * 1-Apr 02:00 IST) was wrongly excluded from FY 2025. Both bounds are inclusive.
 */
export function isInFY(d: Date, year: number): boolean {
  const { gte, lte } = fyWindowUtc(year);
  return d >= gte && d <= lte;
}

/** Whole-day difference (positive when `to` is after `from`). */
export function daysBetween(from: Date, to: Date): number {
  return (to.getTime() - from.getTime()) / 86_400_000;
}

/** True if a trade date falls within the selected range, anchored to `now`. */
export function matchesRange(
  tradeDate: Date,
  range: RangeId,
  now: Date = new Date()
): boolean {
  if (range === "all") return true;
  const days = daysBetween(tradeDate, now);
  if (range === "7d") return days <= 7;
  if (range === "30d") return days <= 30;
  if (range === "3m") return days <= 92;
  // Current / previous FY derived from `now` (IST), not hard-coded.
  const currentFY = fyStartYear(now);
  if (currentFY === null) return true;
  if (range === "fy") return isInFY(tradeDate, currentFY);
  if (range === "pfy") return isInFY(tradeDate, currentFY - 1);
  return true;
}

/** Inclusive ISO (`yyyy-mm-dd`) bounds for an FY by its start calendar year. */
export function fyBounds(startYear: number): {
  fromDate: string;
  toDate: string;
} {
  return {
    fromDate: `${startYear}-04-01`,
    toDate: `${startYear + 1}-03-31`,
  };
}

/**
 * Server-side counterpart of `matchesRange`: maps a RangeId to inclusive
 * fromDate/toDate bounds the Tradebook passes to getTradesAction, so the period
 * filter runs in the DB query across ALL trades rather than only the loaded
 * page. Kept in lock-step with `matchesRange` (same FY anchors, same
 * rolling-window day counts).
 *
 * MONEY-846: the fy/pfy bounds are now full IST-anchored UTC INSTANTS (from
 * `fyWindowUtc`), not date-only `yyyy-mm-dd`. The previous date-only bounds let
 * the server build a naive-UTC / LOCAL-`setHours` window that dropped or
 * mis-bucketed trades in the +5:30 IST sliver around the 1-Apr boundary. The
 * service's `buildTradeWhereClause`/`istDayBound` accepts either form, but
 * emitting the exact instant here removes all ambiguity. Rolling windows stay
 * date-only (the service anchors them to IST day bounds).
 */
export function rangeToDates(
  range: RangeId,
  now: Date = new Date()
): { fromDate?: string; toDate?: string } {
  const iso = (d: Date) => d.toISOString().slice(0, 10);
  if (range === "all") return {};
  if (range === "fy" || range === "pfy") {
    const currentFY = fyStartYear(now);
    if (currentFY === null) return {};
    const { gte, lte } = fyWindowUtc(
      range === "fy" ? currentFY : currentFY - 1
    );
    return { fromDate: gte.toISOString(), toDate: lte.toISOString() };
  }
  const days = range === "7d" ? 7 : range === "30d" ? 30 : 92;
  return {
    fromDate: iso(new Date(now.getTime() - days * 86_400_000)),
    toDate: iso(now),
  };
}
