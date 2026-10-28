/**
 * Pure formatters for the discover grids.
 *
 * Extracted from `client.tsx` (MONEY-1255) so they can be tested BEHAVIOURALLY
 * — asserting the rendered string for a real input — instead of by grepping the
 * component source for divisor literals. A regex guard would have passed
 * happily against the ten-times-low ladder this file exists to fix, because the
 * literals it asserted were the wrong ones.
 */

/** Rupees in one crore. */
const RUPEES_PER_CRORE = 10_000_000;
/** Rupees in one billion. */
const RUPEES_PER_BILLION = 1_000_000_000;
/** Rupees in one trillion. */
const RUPEES_PER_TRILLION = 1_000_000_000_000;

/**
 * Compact market cap for the discover grids. Input is RUPEES — the mutual-fund
 * call site multiplies its crores-denominated AUM by 1e7 before calling.
 *
 * ## The two defects this replaced
 *
 * 1. The `B` rung divided by 1e10 while labelling the result "B", so every
 *    B-figure read TEN TIMES LOW. Hawkins Cookers' ₹4,300 Cr printed `₹4B`
 *    when it is ₹43B.
 * 2. There were TWO `T` rungs: `>=1e13` divided by 1e13, `>=1e12` divided by
 *    1e12. The ladder was therefore NON-MONOTONIC — crossing ₹10 trillion made
 *    the displayed number DROP from `₹9.9T` to `₹1.0T`, and Reliance's ₹17.5
 *    lakh crore printed `₹1.8T`. The `>=1e13` rung is DELETED rather than
 *    corrected; the `>=1e12` rung already covers everything above it.
 *
 * ## Why the compact `₹43B` style is kept
 *
 * The stock detail page moved to `₹4,300 Cr` under decision D-b. This surface
 * renders inside a dense grid and shares the function with fund AUM, so
 * changing the notation is a layout and product decision, not part of a defect
 * fix. Both surfaces are now CORRECT; they are deliberately not yet CONSISTENT.
 *
 * The `B` rung starts at ₹1,000 Cr (1e10) rather than at ₹100 Cr (1e9) so the
 * crores rung keeps its familiar three-digit range for small caps. That is a
 * presentation choice and is monotonic either way: ₹999 Cr is followed by
 * `₹10B`, which is larger.
 */
export function formatMarketCap(marketCap: number | null | undefined): string {
  // `!marketCap` already rejects NaN (falsy) but NOT Infinity, which would
  // render "₹InfinityT". Non-finite money is this repo's most common defect
  // class, so the guard is explicit rather than incidental.
  if (!marketCap || !Number.isFinite(marketCap)) return "-";
  if (marketCap >= RUPEES_PER_TRILLION)
    return `₹${(marketCap / RUPEES_PER_TRILLION).toFixed(1)}T`;
  if (marketCap >= 10 * RUPEES_PER_BILLION)
    return `₹${(marketCap / RUPEES_PER_BILLION).toFixed(0)}B`;
  return `₹${(marketCap / RUPEES_PER_CRORE).toFixed(0)}Cr`;
}

/**
 * Compact traded volume in Indian units. Unchanged by MONEY-1255 — its rungs
 * were already correct — but moved here alongside its sibling so the pair stays
 * testable and cannot drift apart.
 */
export function formatVolume(volume: number | null | undefined): string {
  if (!volume || !Number.isFinite(volume)) return "-";
  if (volume >= 10_000_000) return `${(volume / 10_000_000).toFixed(1)}Cr`;
  if (volume >= 100_000) return `${(volume / 100_000).toFixed(1)}L`;
  if (volume >= 1_000) return `${(volume / 1_000).toFixed(1)}K`;
  return volume.toString();
}
