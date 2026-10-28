/**
 * CAGR - Compound Annual Growth Rate from *actuals*.
 *
 * Unlike `calcLumpsum` (which projects a future value from an assumed
 * rate), this back-solves the realised annualised rate from a known
 * start value, end value, and elapsed time:
 *
 *   CAGR = (endValue / startValue)^(1 / years) − 1
 *
 * Returns a decimal rate (0.187 = 18.7%). Returns `null` when the inputs
 * cannot produce a meaningful rate:
 *   - startValue ≤ 0 (can't divide / no capital deployed)
 *   - endValue < 0 (nonsensical for a portfolio value)
 *   - years ≤ 0 (no elapsed holding period)
 *   - any non-finite input
 *
 * NEVER returns a fabricated/zero rate for missing data - callers rely on
 * `null` to render an honest "—" placeholder.
 */
export function calcCagr(
  startValue: number,
  endValue: number,
  years: number,
): number | null {
  if (
    !Number.isFinite(startValue) ||
    !Number.isFinite(endValue) ||
    !Number.isFinite(years)
  ) {
    return null;
  }
  if (startValue <= 0 || endValue < 0 || years <= 0) return null;

  const cagr = Math.pow(endValue / startValue, 1 / years) - 1;
  return Number.isFinite(cagr) ? cagr : null;
}
