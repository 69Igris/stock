/**
 * Scan → ScreenFilters mapping (MONEY-795 · C2).
 *
 * Pure, dependency-light translator from an engine-native `ScreenerFilter[]`
 * (the shape carried by inline-runnable `ScanDef`s) into the `ScreenFilters`
 * band shape consumed by `screenStocksAction` — the screener engine that is
 * already wired, cached (5-min Redis), and demo-safe (falls back to the
 * instrument universe when ratios/quotes are sparse).
 *
 * Only a subset of the engine vocabulary maps onto `ScreenFilters` (the
 * fundamental bands the screener sidebar exposes: P/E, ROE, revenue growth,
 * debt/equity, dividend yield, market cap). Filters on fields outside that
 * subset (pb, roce, margins, RSI, MACD, crosses, …) are returned in
 * `unmapped` so the caller can decide whether to still run on the mapped
 * subset or treat the scan as browse-only.
 *
 * SEBI: this only narrows a data screen. No ordering by "best", no buy/sell
 * implication — just field → band translation.
 *
 * Kept out of `lib/actions/` so node:test can import it directly.
 */

import type { ScreenerFilter } from "@usemoney/core/screener/engine";
import type { ScreenFilters } from "@/lib/screener/match-score";

/** Engine fundamental fields → `{min,max}` keys on `ScreenFilters`. */
const FIELD_TO_BAND: Record<
  string,
  { min: keyof ScreenFilters; max: keyof ScreenFilters }
> = {
  pe: { min: "minPe", max: "maxPe" },
  roe: { min: "minRoe", max: "maxRoe" },
  revenueGrowth: { min: "minRevenueGrowth", max: "maxRevenueGrowth" },
  debtToEquity: { min: "minDebtToEquity", max: "maxDebtToEquity" },
  dividendYield: { min: "minDividendYield", max: "maxDividendYield" },
  // marketCap is in crores on StockRatios — same unit as the screener bands.
  marketCap: { min: "minMarketCap", max: "maxMarketCap" },
};

export interface ScanFilterMapping {
  /** Bands that the screener engine can apply. */
  filters: ScreenFilters;
  /** Count of source filters that mapped to a band. */
  mappedCount: number;
  /** Engine fields we could NOT express as a `ScreenFilters` band. */
  unmapped: string[];
}

/** Finite-number guard. Rejects NaN / ±Infinity / non-numbers so a poisoned
 *  catalog value can never reach the screener engine as a band bound (a
 *  non-finite `gte`/`lte` silently matches everything or nothing). */
function finite(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v);
}

/** Apply one engine filter onto the accumulating `ScreenFilters` bands.
 *  Returns true when it mapped, false when the field/operator/value is
 *  unsupported or non-finite. */
function applyFilter(out: ScreenFilters, f: ScreenerFilter): boolean {
  const band = FIELD_TO_BAND[f.field];
  if (!band) return false;

  const setMin = (v: number) => {
    // Keep the tighter (larger) lower bound if two filters touch the field.
    const cur = out[band.min] as number | undefined;
    (out[band.min] as number) = cur == null ? v : Math.max(cur, v);
  };
  const setMax = (v: number) => {
    const cur = out[band.max] as number | undefined;
    (out[band.max] as number) = cur == null ? v : Math.min(cur, v);
  };

  switch (f.operator) {
    case "gt":
    case "gte":
      // Reject arrays AND non-finite scalars (NaN/Infinity would poison the
      // band → the screener returns the whole universe or nothing).
      if (!finite(f.value)) return false;
      setMin(f.value);
      return true;
    case "lt":
    case "lte":
      if (!finite(f.value)) return false;
      setMax(f.value);
      return true;
    case "between":
      if (!Array.isArray(f.value) || f.value.length !== 2) return false;
      if (!finite(f.value[0]) || !finite(f.value[1])) return false;
      setMin(f.value[0]);
      setMax(f.value[1]);
      return true;
    case "eq":
      // An equality on a numeric fundamental → an EXACT-match band (min == max).
      // This is a strict equality, NOT a neighbourhood: the screener's
      // `gte == lte` clause (and `filterScore`, where min==max ⇒ zero halfWidth)
      // only admits rows whose value equals f.value exactly.
      if (!finite(f.value)) return false;
      setMin(f.value);
      setMax(f.value);
      return true;
    // cross_above / cross_below are technical-only — never a fundamental band.
    default:
      return false;
  }
}

/**
 * Translate an engine `ScreenerFilter[]` into `ScreenFilters` bands.
 * Filters on unsupported fields/operators are collected in `unmapped`.
 */
export function mapFiltersToScreenFilters(
  filters: readonly ScreenerFilter[]
): ScanFilterMapping {
  const out: ScreenFilters = {};
  let mappedCount = 0;
  const unmapped: string[] = [];

  for (const f of filters) {
    if (applyFilter(out, f)) mappedCount += 1;
    else unmapped.push(f.field);
  }

  return { filters: out, mappedCount, unmapped };
}

/**
 * A scan is screener-runnable when at least one of its filters maps to a
 * fundamental band. We deliberately allow PARTIAL mapping (some filters
 * unmapped) — running on the mapped subset still surfaces a useful,
 * narrower set, and the caller surfaces the partial-coverage note. A scan
 * with zero mappable filters is NOT runnable here (browse-only).
 */
export function isScreenerRunnable(
  filters: readonly ScreenerFilter[] | undefined
): boolean {
  if (!filters || filters.length === 0) return false;
  return mapFiltersToScreenFilters(filters).mappedCount > 0;
}
