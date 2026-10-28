/**
 * Risk pure-logic helpers (service layer).
 *
 * These are the side-effect-free aggregation/orchestration calculations that
 * `getPortfolioRisk` in `./risk.service.ts` performs ON ITS OWN — i.e. the math
 * that is NOT delegated to the `@usemoney/research` compute tools (VaR,
 * drawdown, concentration, correlation, Sharpe/Sortino, beta). Those tools are
 * already individually guarded + tested; what was previously naked of any guard
 * was the service's own glue:
 *
 *   - mapping each holding to a value `(currentPrice || averagePrice) * quantity`
 *   - the portfolio `totalValue` reduce
 *   - per-holding `weight = value / totalValue`
 *   - the daily portfolio-value series (`Σ close × weight`)
 *   - the daily portfolio returns `(v[i] - v[i-1]) / v[i-1]`
 *   - the benchmark (NIFTY) daily returns `(curr - prev) / prev`
 *
 * They are isolated here (away from the Prisma-/cache-coupled service) so they
 * can be unit-tested without opening a Prisma connection at import time, and —
 * critically — so the LIVE `/risk` path runs the SAME non-finite-guarded math
 * the regression tests assert.
 *
 * Behaviour here is identical, for FINITE inputs, to the logic that previously
 * lived inline in `getPortfolioRisk`; the service now calls these helpers. The
 * intentional behavioural differences (all defensive) are:
 *
 *   - a `NaN`/`±Infinity` `currentPrice`/`averagePrice`/`quantity` on a corrupt
 *     sync row can no longer poison the holding `value`, the portfolio
 *     `totalValue`, or every downstream `weight` (which a single NaN turns into
 *     NaN, blanking concentration/correlation/VaR/drawdown);
 *   - a zero (or non-finite) `totalValue` no longer yields an `Infinity`/`NaN`
 *     `weight` (division-by-zero) — it collapses to `0`;
 *   - a single non-finite daily return no longer makes the entire returns array
 *     fail the compute tools' `Number.isFinite` gate (which silently nulls VaR,
 *     risk-adjusted-returns AND beta from one bad day) — the bad day is dropped;
 *   - a non-finite benchmark close is dropped from the paired series rather than
 *     poisoning beta.
 *
 * Local `finite()` (mirrors `./dashboard-logic.ts#finite`) — kept LOCAL on
 * purpose so this module has no cross-logic-file coupling.
 */

// ---------------------------------------------------------------------------
// Non-finite guard
// ---------------------------------------------------------------------------

/**
 * Coerce a possibly-non-finite numeric to a safe finite number.
 *
 * Risk aggregation is a SUM/RATIO surface: a single `NaN`/`Infinity` addend
 * poisons the portfolio `totalValue` reduce, and a NaN `totalValue` then turns
 * EVERY holding weight into NaN — which blanks concentration, correlation, VaR
 * and drawdown together. Stored broker values are occasionally `NaN`/`Infinity`
 * (a divide that went wrong upstream, a corrupt sync row), so every value that
 * enters a sum, a ratio, or a returns series is funnelled through this guard
 * first. `null`/`undefined`/`NaN`/`±Infinity` all collapse to `fallback`
 * (default 0). Mirrors `./dashboard-logic.ts#finite`.
 */
export function finite(value: number | null | undefined, fallback = 0): number {
  return value != null && Number.isFinite(value) ? value : fallback;
}

// ---------------------------------------------------------------------------
// Structural input/output types (narrow subset of the Prisma Holding selection
// the service uses, plus the price-history shape returned by the fetch tool).
// ---------------------------------------------------------------------------

/** Raw holding fields the service selects from Prisma for risk. */
export interface RiskHoldingInput {
  symbol: string;
  sector: string | null;
  quantity: number;
  averagePrice: number;
  currentPrice: number | null;
}

/** Normalised holding the compute tools + the rest of the service consume. */
export interface RiskHoldingData {
  symbol: string;
  value: number;
  sector: string;
}

/** One OHLC-ish price point as returned by the price-history fetch tool. */
export interface PricePoint {
  date: string;
  close: number;
}

/** One point of the derived daily portfolio-value series. */
export interface ValuePoint {
  date: string;
  value: number;
}

// ---------------------------------------------------------------------------
// Holdings normalisation
// ---------------------------------------------------------------------------

/**
 * Map raw Prisma holdings to `{ symbol, value, sector }`.
 *
 * `value = (currentPrice || averagePrice) * quantity`. The `||` fallback chain
 * is load-bearing (a holding with no live `currentPrice` falls back to the
 * `averagePrice` book value; `0`/`null` `currentPrice` is falsy and falls
 * through). `finite()` wraps the PRODUCT so a NaN/Infinity price OR quantity on
 * a corrupt sync row yields `0` for that holding rather than a non-finite value
 * that would poison `totalValue` and every downstream weight. Sector defaults
 * to `"Unknown"`.
 */
export function mapHoldingsData(
  holdings: RiskHoldingInput[],
): RiskHoldingData[] {
  return holdings.map((h) => ({
    symbol: h.symbol,
    value: finite((h.currentPrice || h.averagePrice) * h.quantity),
    sector: h.sector || "Unknown",
  }));
}

/**
 * MONEY-1121 - key a holding to its instrument. Symbol alone is ambiguous:
 * the same ticker is listed on both NSE and BSE, so the exchange is part of
 * the identity.
 */
export function holdingSectorKey(
  symbol: string,
  exchange: string | null | undefined,
): string {
  return `${symbol.toUpperCase()}|${(exchange ?? "").toUpperCase()}`;
}

/**
 * MONEY-1121 - fill each holding's missing `sector` from an instrument lookup.
 *
 * Reported in the MONEY-1095 bug doc as item 10: `/risk` rendered a single
 * "Unknown 100%" slice for the whole portfolio. `Holding.sector` is null on
 * every row (the broker sync never writes it), and the risk service read that
 * column directly — while `InstrumentMapping` had the sector all along
 * (ADANIPOWER=Utilities, IDEA=Telecommunication, IRB=Industrials). The data
 * was one join away.
 *
 * Pure: the caller does the query and passes the resulting map, so the merge
 * is unit-testable without a database. A holding that already carries a sector
 * keeps it — the sync is authoritative when it does populate the column.
 */
export function mergeHoldingSectors<
  T extends {
    symbol: string;
    exchange?: string | null;
    sector?: string | null;
  },
>(holdings: T[], sectorByKey: ReadonlyMap<string, string | null>): T[] {
  return holdings.map((h) => {
    if (h.sector) return h;
    const resolved = sectorByKey.get(holdingSectorKey(h.symbol, h.exchange));
    return isInformativeSector(resolved) ? { ...h, sector: resolved } : h;
  });
}

/**
 * Some InstrumentMapping rows carry a placeholder instead of a real sector
 * (the live data has TMCV = "N/A"). Adopting one would put an "N/A" slice
 * beside the "Unknown" slice `mapHoldingsData` already produces — two labels
 * for the same "we don't know". Treat placeholders as absent so everything
 * unclassified lands in one bucket.
 */
function isInformativeSector(
  value: string | null | undefined,
): value is string {
  if (!value) return false;
  const normalized = value.trim().toUpperCase();
  return (
    normalized.length > 0 &&
    normalized !== "N/A" &&
    normalized !== "NA" &&
    normalized !== "-" &&
    normalized !== "UNKNOWN"
  );
}

/**
 * Sum holding values into the portfolio total. Each addend is finite-guarded so
 * one corrupt holding cannot turn the whole `totalValue` into NaN/Infinity
 * (which would then make every `weight` NaN). Callers pass already-mapped
 * `RiskHoldingData`, whose `value` is finite by construction; the guard here is
 * defence-in-depth for any other caller.
 */
export function sumHoldingsValue(holdings: Array<{ value: number }>): number {
  return holdings.reduce((sum, h) => sum + finite(h.value), 0);
}

/**
 * The top `cap` holdings by value, descending. Values are finite-guarded inside
 * the comparator so a NaN value (which makes every `a - b` comparison `NaN`,
 * leaving the sort order undefined) sinks to the bottom instead of corrupting
 * the ordering. Returns a new array; does not mutate the input.
 */
export function topHoldingsByValue<T extends { value: number }>(
  holdings: T[],
  cap: number,
): T[] {
  return [...holdings]
    .sort((a, b) => finite(b.value) - finite(a.value))
    .slice(0, cap);
}

// ---------------------------------------------------------------------------
// Weights
// ---------------------------------------------------------------------------

/**
 * A single holding's portfolio weight = `value / totalValue`, clamped to a
 * finite `[0, …]`.
 *
 * Division-by-zero guard: an empty / all-zero portfolio (or one whose values
 * summed to a non-finite total) has `totalValue <= 0` or non-finite, which would
 * make `value / totalValue` `Infinity`/`NaN`. We return `0` in that case. The
 * numerator is finite-guarded too so a stray non-finite `value` yields `0`, not
 * NaN.
 */
export function computeWeight(value: number, totalValue: number): number {
  if (!Number.isFinite(totalValue) || totalValue <= 0) return 0;
  return finite(value) / totalValue;
}

// ---------------------------------------------------------------------------
// Date union
// ---------------------------------------------------------------------------

/**
 * Union of all dates across every symbol's price history, sorted ascending.
 * (Ordering by ISO date string is chronological.) Used to build the aligned
 * daily portfolio-value series.
 */
export function collectSortedDates(
  priceHistories: Record<string, PricePoint[]>,
): string[] {
  const all = new Set<string>();
  for (const prices of Object.values(priceHistories)) {
    for (const p of prices) all.add(p.date);
  }
  return Array.from(all).sort();
}

// ---------------------------------------------------------------------------
// Daily portfolio value series
// ---------------------------------------------------------------------------

/**
 * Build the weighted daily portfolio-value series.
 *
 * For each date, `dayValue = Σ (close_on_date × weight)` over the top holdings
 * that have a price on that date. The weight is `computeWeight`-clamped (so a
 * zero/non-finite `totalValue` contributes 0, never an Infinity that would
 * dominate the sum), and each `close × weight` term is finite-guarded (so a
 * corrupt NaN close on ONE holding does not blank the whole day — the other
 * holdings still contribute). Only finite, strictly-positive `dayValue`s are
 * emitted (a 0 or non-finite day would break the subsequent return divisor).
 */
export function buildDailyValueSeries(
  topHoldings: RiskHoldingData[],
  priceHistories: Record<string, PricePoint[]>,
  totalValue: number,
  sortedDates: string[],
): ValuePoint[] {
  const series: ValuePoint[] = [];
  for (const date of sortedDates) {
    let dayValue = 0;
    for (const h of topHoldings) {
      const history = priceHistories[h.symbol];
      const dayPrice = history?.find((p) => p.date === date);
      if (dayPrice) {
        const weight = computeWeight(h.value, totalValue);
        dayValue += finite(dayPrice.close * weight);
      }
    }
    if (Number.isFinite(dayValue) && dayValue > 0) {
      series.push({ date, value: dayValue });
    }
  }
  return series;
}

// ---------------------------------------------------------------------------
// Returns
// ---------------------------------------------------------------------------

/**
 * Daily simple returns from a value series: `(v[i] - v[i-1]) / v[i-1]`.
 *
 * `buildDailyValueSeries` only emits finite `value > 0`, so the divisor is
 * normally safe; but this helper is also reachable with arbitrary series, so we
 * skip any step whose previous value is non-finite or `<= 0` (division-by-zero
 * → Infinity) and drop any non-finite computed return. Dropping a single bad day
 * matters because the downstream compute tools (`compute_var`,
 * `compute_risk_adjusted_returns`, `compute_beta`) REJECT the ENTIRE array if it
 * contains one non-finite element — i.e. one corrupt day would silently null out
 * every risk metric, not just that day.
 */
export function computeReturnsFromSeries(series: ValuePoint[]): number[] {
  const returns: number[] = [];
  for (let i = 1; i < series.length; i++) {
    const prev = series[i - 1]!.value;
    const curr = series[i]!.value;
    if (!Number.isFinite(prev) || prev <= 0) continue;
    const ret = (curr - prev) / prev;
    if (Number.isFinite(ret)) returns.push(ret);
  }
  return returns;
}

/**
 * Benchmark (e.g. NIFTY 50) daily returns aligned to the portfolio's value
 * series dates.
 *
 * Walks consecutive `valueSeries` date pairs and computes the benchmark return
 * from its close-by-date map: `(curr - prev) / prev`. A date with no benchmark
 * close, a non-finite/`<= 0` previous close (division-by-zero guard), or a
 * non-finite computed return is skipped — so a single bad benchmark close does
 * not poison the whole paired series and null out beta. Keeping the walk on the
 * portfolio's dates (rather than the benchmark's own) preserves the original
 * pairing semantics used by the service.
 */
export function computeBenchmarkReturns(
  valueSeries: ValuePoint[],
  closeByDate: Map<string, number>,
): number[] {
  const returns: number[] = [];
  for (let i = 1; i < valueSeries.length; i++) {
    const prev = closeByDate.get(valueSeries[i - 1]!.date);
    const curr = closeByDate.get(valueSeries[i]!.date);
    if (prev == null || curr == null) continue;
    if (!Number.isFinite(prev) || prev <= 0) continue;
    const ret = (curr - prev) / prev;
    if (Number.isFinite(ret)) returns.push(ret);
  }
  return returns;
}

/**
 * Build a `date → close` lookup map from a benchmark price history. Non-finite
 * closes are still recorded (the return helpers skip them) — kept faithful to
 * the original `closeByDate` build, but exported for testability.
 */
export function buildCloseByDate(prices: PricePoint[]): Map<string, number> {
  const map = new Map<string, number>();
  for (const p of prices) map.set(p.date, p.close);
  return map;
}
