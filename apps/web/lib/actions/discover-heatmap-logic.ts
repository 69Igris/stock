/**
 * Pure date-math for the heatmap timeframe cutoff (MONEY-242).
 *
 * Extracted from `getHeatmapDataAction` (discover-heatmap.ts) so the
 * IST-calendar cutoff computation has a real, importable unit under test
 * instead of an inline shadow. The action imports `heatmapCutoffFor` — there
 * is no dead duplicate.
 *
 * Semantics:
 *   - "1D"  → null (intraday; the action uses LatestQuote.changePercent).
 *   - "1W"  → UTC-midnight of the IST calendar day 7 days ago.
 *   - "1M"  → UTC-midnight of the IST calendar day one month ago
 *             (JS month arithmetic; Mar 31 → Mar 3 edge is preserved
 *             intentionally — documented in tests).
 *   - "YTD" → UTC-midnight of Jan 1 of the current IST year.
 *
 * The returned instant is UTC-midnight of the IST cutoff DATE (not 00:00
 * IST) on purpose: the DailyPrice query uses `gte: cutoff`, and rows are
 * keyed at UTC midnight of the trading day.
 */

export type HeatmapTimeframeForCutoff = "1D" | "1W" | "1M" | "YTD";

/** IST is UTC+5:30. */
const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;

/**
 * Compute the DailyPrice cutoff instant for a heatmap timeframe, given the
 * current instant `now` (defaults to `new Date()`).
 *
 * Returns `null` for "1D" (no historical diff needed).
 */
export function heatmapCutoffFor(
  timeframe: HeatmapTimeframeForCutoff,
  now: Date = new Date()
): Date | null {
  if (timeframe === "1D") return null;

  const ist = new Date(now.getTime() + IST_OFFSET_MS);
  const c = new Date(ist);
  if (timeframe === "1W") c.setUTCDate(c.getUTCDate() - 7);
  else if (timeframe === "1M") c.setUTCMonth(c.getUTCMonth() - 1);
  else if (timeframe === "YTD") {
    c.setUTCMonth(0);
    c.setUTCDate(1);
  }

  return new Date(
    Date.UTC(c.getUTCFullYear(), c.getUTCMonth(), c.getUTCDate())
  );
}
