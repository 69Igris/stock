/**
 * OHLC invariants for `DailyPrice` — MONEY-1175 step 3.
 *
 * A candle is drawable only when `low <= min(open, close)`,
 * `high >= max(open, close)`, `low <= high`, and every price is positive.
 * TradingView does not reject a malformed bar; it DRAWS it, so `close < low`
 * renders as a wick pointing the wrong way. Nothing errors, nothing logs — the
 * chart is just quietly wrong, which is why these need a guard at the writer
 * rather than a dashboard.
 *
 * The prod census (scripts/data/audit-ohlc-violations.ts) found 53,069 such
 * rows in two distinct shapes that need OPPOSITE repairs:
 *
 *   DEGENERATE_FLAT (46,573, YAHOO 2026)
 *     open == high == low, close different. Yahoo reported a single price for
 *     o/h/l and a separate close. Both numbers are REAL prices from that
 *     session; what is missing is the range between them. Repair by WIDENING
 *     the range to span what we observed — no invented price.
 *
 *   OPEN_OUT (6,253, BHAVCOPY_HIST 1995-96)
 *     `open` outside [low, high]. Verified against the archived bytes: NSE's
 *     own 1995 files set OPEN == PREVCLOSE verbatim (ACC 3338.35/3338.35,
 *     BHEL 106.45/106.45) and only started publishing a real open in 1997.
 *     Here `open` is a KNOWN-BOGUS field carrying yesterday's number, so
 *     widening the range would assert a trade at a price that never happened
 *     that day. Repair by CLAMPING open into the real [low, high] instead.
 *
 * Same symptom, different cause, different correct repair — which is the whole
 * reason this module classifies before it fixes.
 */

export interface Candle {
  open: number;
  high: number;
  low: number;
  close: number;
}

export type CandleDefect =
  | "OK"
  | "NON_POSITIVE"
  | "DEGENERATE_FLAT"
  | "LOW_GT_HIGH"
  | "OPEN_OUT"
  | "CLOSE_OUT";

/** First matching defect, most diagnostic shape first. Mirrors the audit script. */
export function classifyCandle(c: Candle): CandleDefect {
  if (
    !(c.open > 0) ||
    !(c.high > 0) ||
    !(c.low > 0) ||
    !(c.close > 0) ||
    !Number.isFinite(c.open) ||
    !Number.isFinite(c.high) ||
    !Number.isFinite(c.low) ||
    !Number.isFinite(c.close)
  ) {
    return "NON_POSITIVE";
  }
  if (c.open === c.high && c.high === c.low && c.close !== c.open) {
    return "DEGENERATE_FLAT";
  }
  if (c.low > c.high) return "LOW_GT_HIGH";
  if (c.open < c.low || c.open > c.high) return "OPEN_OUT";
  if (c.close < c.low || c.close > c.high) return "CLOSE_OUT";
  return "OK";
}

export function isDrawableCandle(c: Candle): boolean {
  return classifyCandle(c) === "OK";
}

/**
 * Widen `low`/`high` so the range spans every observed price.
 *
 * For a source that under-reports the RANGE but reports real PRICES (Yahoo's
 * degenerate bars). Never invents a value: the new bounds are always prices
 * that appear in the input.
 *
 * Returns null when the candle cannot be rescued (a non-positive price is
 * garbage, not an under-reported range).
 */
export function widenCandleRange(c: Candle): Candle | null {
  if (classifyCandle(c) === "NON_POSITIVE") return null;
  return {
    open: c.open,
    close: c.close,
    low: Math.min(c.open, c.high, c.low, c.close),
    high: Math.max(c.open, c.high, c.low, c.close),
  };
}

/**
 * Apply the repair appropriate to the defect. ONE dispatch table, used by both
 * the ingest path (scripts/jobs/feed-parse.ts) and the backfill migration
 * (scripts/migrations/repair-daily-price-candles.ts) so the two cannot drift —
 * if they disagreed, every re-parse would undo the migration.
 *
 * Returns the input unchanged when it is already drawable, and null when the
 * row cannot be rescued (high/low/close themselves unusable). A caller that
 * gets null should DROP the row rather than store an undrawable one.
 */
export function repairCandle(c: Candle): Candle | null {
  const defect = classifyCandle(c);
  if (defect === "OK") return c;
  // `open` is the wrong quantity (NSE prev-close, Yahoo's literal 0) -> rebuild
  // it from the range. Anything else is an under-reported range -> widen.
  const fixed =
    defect === "OPEN_OUT" || defect === "NON_POSITIVE"
      ? clampCandleOpen(c)
      : widenCandleRange(c);
  // A "repair" that does not actually yield a drawable candle is worse than
  // none — it rewrites the row and leaves the defect in place.
  if (fixed && isDrawableCandle(fixed)) return fixed;

  // Last resort: only the CLOSE survived (`o=h=l=0, c=64.4` — 197 such rows in
  // prod, oldest 1999). There is no range to rebuild from, so represent it as
  // what it actually is: a session for which we know one price. Collapsing to
  // a flat bar at the close is the same shape `udf/history` already synthesizes
  // for mutual funds (`o=h=l=c=nav`), and it is strictly better than the
  // alternatives — a zero open draws a bar down to the axis, and dropping the
  // row leaves a gap the Yahoo backfill would refill with adjusted data.
  return closeIsUsable(c)
    ? { open: c.close, high: c.close, low: c.close, close: c.close }
    : null;
}

const closeIsUsable = (c: Candle): boolean =>
  Number.isFinite(c.close) && c.close > 0;

/**
 * Rebuild `open` from the real range, leaving high/low/close untouched.
 *
 * For a source whose `open` is known to be a DIFFERENT QUANTITY rather than a
 * noisy price: NSE's 1995-96 PREVCLOSE, or Yahoo's literal `0`. Snapping to
 * the nearest bound picks a price that genuinely traded that session, which is
 * the least-wrong open available once the real one was never published.
 *
 * `open` is deliberately NOT required to be positive or finite — it is the
 * field being replaced, so its current value cannot disqualify the repair.
 * high/low/close still must be sane; if they are not, there is no trustworthy
 * range to clamp into and the caller gets null.
 */
export function clampCandleOpen(c: Candle): Candle | null {
  const usable = (v: number): boolean => Number.isFinite(v) && v > 0;
  if (!usable(c.high) || !usable(c.low) || !usable(c.close)) return null;
  if (c.low > c.high) return null;

  const low = Math.min(c.low, c.close);
  const high = Math.max(c.high, c.close);
  const open = Number.isFinite(c.open)
    ? Math.min(Math.max(c.open, low), high)
    : low;
  return { open, high, low, close: c.close };
}
