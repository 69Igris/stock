/**
 * Pure math + formatting for {@link DayRangeBar} (MONEY-244), extracted from the
 * "use client" component so it can be unit-tested under node:test. The component
 * imports and renders from these — one implementation, exercised by both.
 */

/** ₹ formatter with 2 decimals; "-" for null/undefined/non-finite. */
export function formatInr(v: number | null | undefined): string {
  if (v == null || !Number.isFinite(v)) return "-";
  return `₹${v.toLocaleString("en-IN", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}

/**
 * The dot's position on the bar, 0..1. Returns 0.5 (centered) for any
 * degenerate input — missing/non-finite low/high/current, or a non-positive
 * range (high <= low). Otherwise clamps `(current - low) / (high - low)` into
 * [0, 1] so out-of-range ticks render at an extreme instead of overflowing.
 */
export function dayRangePct(
  low: number | null | undefined,
  high: number | null | undefined,
  current: number | null | undefined
): number {
  const lo = Number.isFinite(low ?? NaN) ? (low as number) : null;
  const hi = Number.isFinite(high ?? NaN) ? (high as number) : null;
  const cur = Number.isFinite(current ?? NaN) ? (current as number) : null;

  if (lo != null && hi != null && hi > lo && cur != null) {
    return Math.max(0, Math.min(1, (cur - lo) / (hi - lo)));
  }
  return 0.5;
}
