/**
 * Fund-composition pure-logic helpers (service layer).
 *
 * Side-effect-free allocation math for a single fund's portfolio composition —
 * the weights/percentages, sector/asset/cap aggregations, top-N holdings,
 * reconciliation-to-100, and pairwise portfolio overlap that the
 * `fund-composition.service.ts` surface returns and the
 * `FundCompositionSection` / `/compare` UIs render (every value flows into a
 * `.toFixed()` / `.toLocaleString()` / a Recharts `<Pie value=…>` slice).
 *
 * They are isolated here (away from the cache/DB-importing service) so they can
 * be unit-tested without pulling I/O in at import time, and — critically — so
 * the LIVE fund-composition path runs the SAME non-finite-guarded math the
 * regression tests assert. The service now derives the `FundCompositionData` it
 * caches & returns from {@link normalizeComposition} rather than passing the raw
 * DB/Gemini result straight through.
 *
 * Behaviour here is identical, for FINITE inputs, to the raw pass-through that
 * previously lived in the service's `toServiceData` (same field values, same
 * `holdings`/breakdown ordering). The only intentional behavioural differences
 * are defensive:
 *
 *   - a `NaN`/`±Infinity` `weightPercent` on one holding no longer renders as
 *     the literal `"NaN%"` and no longer poisons the `Σ weightPercent` coverage
 *     total (one corrupt row used to turn the whole "X holdings · NaN%" badge,
 *     the `100 - total` disclaimer, and a pie slice into NaN/Infinity);
 *   - a fund whose holdings/weights are all zero / all non-finite degrades to an
 *     empty-but-finite composition (0% coverage), never NaN;
 *   - sector/asset/cap weights are finite-guarded and a missing pre-aggregated
 *     breakdown is derived from the (sanitized) holdings so the chart is never
 *     fed a NaN slice;
 *   - top-N holdings are ranked by weight DESC with non-finite weights ranked
 *     LAST (never crowned the top holding by an order-unstable `NaN` sort);
 *   - `confidence` is clamped to a finite `[0,1]` (it renders as
 *     `round(confidence*100)%`); `dataAsOf` is coerced to a safe string so an
 *     Invalid-Date / non-string can never throw or render `"Invalid Date"`;
 *   - portfolio overlap (`Σ min(weightA, weightB)` over shared keys) is
 *     div-by-zero / non-finite safe and returns `0` for two funds with no
 *     common value rather than `NaN`.
 *
 * Mirrors the `finite()` precedent in `./dashboard-logic.ts`.
 */

// ---------------------------------------------------------------------------
// Non-finite guard
// ---------------------------------------------------------------------------

/**
 * Coerce a possibly-non-finite numeric to a safe finite number.
 *
 * Composition math is a mix of SUM (coverage total, sector aggregation),
 * RATIO (weight % = holdingValue/totalValue, overlap %), and ORDERING (top-N)
 * surfaces — each one a place a single `NaN`/`Infinity` silently corrupts a
 * total, spreads `Infinity` across a normalize, or flips a sort. Stored
 * weights/values are occasionally `NaN`/`Infinity` (a divide that went wrong
 * upstream, a corrupt sync/extraction row), so every value that enters a sum,
 * a ratio, a sort key, or a `.toFixed()` is funnelled through this guard first.
 * `null`/`undefined`/`NaN`/`±Infinity` all collapse to `fallback` (default 0).
 * Mirrors `./dashboard-logic.ts#finite`.
 */
export function finite(value: number | null | undefined, fallback = 0): number {
  return value != null && Number.isFinite(value) ? value : fallback;
}

/** Round to 2 dp the way the legacy validate/extract path does (matches UI). */
export function round2(n: number): number {
  return Math.round(finite(n) * 100) / 100;
}

// ---------------------------------------------------------------------------
// Structural input/output types (a narrow subset of CompositionResult, kept
// import-free of @usemoney/core so this module pulls in no I/O at load time).
// ---------------------------------------------------------------------------

/** A single fund holding (subset of `ExtractedHolding`). */
export interface CompositionHolding {
  holdingName: string;
  holdingSymbol: string | null;
  isin: string | null;
  holdingType: string;
  sector: string | null;
  industry: string | null;
  marketCap: string | null;
  weightPercent: number;
}

/** A pre-aggregated sector slice. */
export interface SectorSlice {
  sector: string;
  weight: number;
}
/** A pre-aggregated market-cap slice. */
export interface CapSlice {
  cap: string;
  weight: number;
}
/** A pre-aggregated asset-class slice. */
export interface AssetSlice {
  type: string;
  weight: number;
}

/** The raw composition shape (structurally a `CompositionResult` subset). */
export interface RawComposition {
  fundType: "MF" | "ETF" | "INDEX";
  fundId: string;
  holdings: CompositionHolding[];
  sectorBreakdown: SectorSlice[];
  capBreakdown: CapSlice[];
  assetBreakdown: AssetSlice[];
  totalHoldings: number;
  confidence: number;
  dataAsOf: string;
}

/** The sanitized composition the service returns (adds `coveragePercent`). */
export interface NormalizedComposition extends RawComposition {
  /**
   * Σ of the (finite-guarded) holding weights — the % of the portfolio the
   * listed holdings cover. Always finite, always `>= 0`. The UI badge / "covers
   * X%" disclaimer reads this; it used to be recomputed inline and could be NaN.
   */
  coveragePercent: number;
}

// ---------------------------------------------------------------------------
// Holding-level weight from value (weight % = holdingValue / totalFundValue)
// ---------------------------------------------------------------------------

/** A holding expressed as an absolute rupee value (pre-percent). */
export interface ValuedHolding {
  key: string;
  value: number;
}

/**
 * Total fund value = Σ holding values, each finite-guarded.
 *
 * A single `NaN`/`Infinity` holding value would otherwise poison the whole
 * total (and therefore EVERY weight derived from it). finite() neutralises the
 * bad addend to `0` so the denominator stays a real number.
 */
export function totalFundValue(holdings: ReadonlyArray<ValuedHolding>): number {
  if (!Array.isArray(holdings)) return 0;
  return holdings.reduce((sum, h) => sum + finite(h?.value), 0);
}

/**
 * Weight of a single holding as a percentage of the fund: `value / total * 100`.
 *
 * Returns `0` (never `NaN`/`Infinity` into a `.toFixed()` / pie slice) when the
 * fund total is `0` or non-finite (the div-by-zero case — every weight would be
 * `Infinity`/`NaN`) or when the holding value itself is non-finite. The `> 0`
 * gate on `total` is what stops the classic "total fund value 0 → every weight
 * Infinity/NaN" failure.
 */
export function weightFromValue(value: number, total: number): number {
  const safeTotal = finite(total);
  if (!(safeTotal > 0)) return 0;
  const pct = (finite(value) / safeTotal) * 100;
  return Number.isFinite(pct) ? pct : 0;
}

/**
 * Derive each holding's weight % from its absolute value, finite-safely.
 *
 * The total is computed ONCE with {@link totalFundValue} (so one poisoned value
 * cannot inflate the denominator to Infinity), then every holding is divided by
 * it via {@link weightFromValue}. With a zero / all-non-finite total every
 * weight is `0` (not `NaN`), so an all-zero composition produces no NaN.
 */
export function weightsFromValues(
  holdings: ReadonlyArray<ValuedHolding>,
): Array<{ key: string; weightPercent: number }> {
  if (!Array.isArray(holdings)) return [];
  const total = totalFundValue(holdings);
  return holdings.map((h) => ({
    key: h?.key,
    weightPercent: round2(weightFromValue(finite(h?.value), total)),
  }));
}

// ---------------------------------------------------------------------------
// Sanitize holdings (finite weights; non-finite ranked last on sort)
// ---------------------------------------------------------------------------

/**
 * Finite-guard a holding's `weightPercent` (every other field is passed through
 * unchanged). A `NaN`/`Infinity` weight becomes `0` so it can never render as
 * `"NaN%"`, poison the coverage total, or be crowned the top holding.
 */
export function sanitizeHolding(h: CompositionHolding): CompositionHolding {
  return { ...h, weightPercent: round2(h?.weightPercent) };
}

/**
 * Sanitize + sort holdings by weight DESCENDING (largest position first), the
 * order the table and "top holdings" surfaces expect.
 *
 * Sorting uses the already-finite-guarded weight, so a corrupt `NaN`/`Infinity`
 * weight (now `0`) is ranked LAST rather than surfacing as the #1 holding via an
 * order-unstable raw `NaN` comparator (the "wrong-order" failure class). Ties
 * on weight break by `holdingName` ascending for determinism regardless of
 * input order.
 */
export function sanitizeAndSortHoldings(
  holdings: ReadonlyArray<CompositionHolding>,
): CompositionHolding[] {
  if (!Array.isArray(holdings)) return [];
  return holdings
    .map(sanitizeHolding)
    .sort(
      (a, b) =>
        b.weightPercent - a.weightPercent ||
        (a.holdingName < b.holdingName
          ? -1
          : a.holdingName > b.holdingName
            ? 1
            : 0),
    );
}

/**
 * Top-N holdings by weight (sanitized + sorted DESC). `n` is clamped to a
 * non-negative integer; fewer than `n` holdings simply returns all of them
 * (never pads / throws). A non-finite-weighted holding can never appear ahead
 * of a real one (it sorts last), so the top-N is always the genuinely-largest
 * positions.
 */
export function topNHoldings(
  holdings: ReadonlyArray<CompositionHolding>,
  n: number,
): CompositionHolding[] {
  const sorted = sanitizeAndSortHoldings(holdings);
  const count = Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
  return sorted.slice(0, count);
}

// ---------------------------------------------------------------------------
// Coverage (Σ weights) + reconciliation to 100
// ---------------------------------------------------------------------------

/**
 * Σ of holding weights = the % of the portfolio the listed holdings cover.
 * Each addend is finite-guarded, so one corrupt weight contributes `0` rather
 * than turning the whole coverage total into NaN/Infinity. Always `>= 0`.
 */
export function coveragePercent(
  holdings: ReadonlyArray<CompositionHolding>,
): number {
  if (!Array.isArray(holdings)) return 0;
  return round2(holdings.reduce((sum, h) => sum + finite(h?.weightPercent), 0));
}

/** Default tolerance (in percentage points) for the Σ-weights ≈ 100 check. */
export const RECONCILE_TOLERANCE = 0.5;

/**
 * Whether a set of weights reconciles to ~100% within `tolerance` percentage
 * points. Disclosed top-holdings rarely sum to exactly 100 (rounding + the long
 * tail of small positions is omitted), so this is a *tolerance* check, not
 * equality. A non-finite total (corrupt input) is never "reconciled".
 *
 * NB this is an OBSERVATION (used to decide whether to show the "covers X%"
 * disclaimer), not a normalization — we deliberately do NOT rescale disclosed
 * weights to force a 100 sum (that would fabricate allocation the fund doesn't
 * have); see {@link normalizeWeightsTo100} for the opt-in rescale.
 */
export function reconcilesTo100(
  total: number,
  tolerance: number = RECONCILE_TOLERANCE,
): boolean {
  if (!Number.isFinite(total)) return false;
  const tol = Number.isFinite(tolerance)
    ? Math.abs(tolerance)
    : RECONCILE_TOLERANCE;
  return Math.abs(total - 100) <= tol;
}

/**
 * Rescale a set of weights so they sum to exactly 100 (opt-in normalization for
 * a pie chart that must fill the circle). `weight_i := weight_i / Σ * 100`.
 *
 * Each weight is finite-guarded first, the Σ is computed from the guarded
 * weights, and the division only runs when `Σ > 0` — so an all-zero /
 * all-non-finite input returns all-zero weights (NOT NaN), never spreading
 * `Infinity` from a `÷0` across the slices. Order is preserved.
 */
export function normalizeWeightsTo100<T extends { weight: number }>(
  slices: ReadonlyArray<T>,
): T[] {
  if (!Array.isArray(slices) || slices.length === 0) return [];
  const guarded = slices.map((s) => ({ ...s, weight: finite(s?.weight) }));
  const total = guarded.reduce((sum, s) => sum + s.weight, 0);
  if (!(total > 0)) {
    // No usable weight to normalize against → return the (zeroed) slices rather
    // than dividing by zero and spreading NaN/Infinity across every slice.
    return guarded.map((s) => ({ ...s, weight: 0 }));
  }
  return guarded.map((s) => ({
    ...s,
    weight: round2((s.weight / total) * 100),
  }));
}

// ---------------------------------------------------------------------------
// Breakdown aggregation (group holdings by sector / asset-class / cap)
// ---------------------------------------------------------------------------

/**
 * Aggregate the (finite-guarded) holding weights into per-group buckets, summing
 * the weight of every holding that shares a `groupKey`. Holdings whose key is
 * `null`/empty are bucketed under `fallbackKey` (e.g. an "Unknown" sector) so
 * their weight is never silently dropped from the chart. Buckets are returned
 * sorted by aggregated weight DESCENDING; each bucket weight is finite.
 *
 * This derives a breakdown from holdings when the pre-aggregated one is missing,
 * so the pie chart always has finite, summing-correctly data.
 */
export function aggregateByKey(
  holdings: ReadonlyArray<CompositionHolding>,
  groupKey: (h: CompositionHolding) => string | null,
  fallbackKey: string,
): Array<{ key: string; weight: number }> {
  if (!Array.isArray(holdings)) return [];
  const byKey = new Map<string, number>();
  for (const h of holdings) {
    if (!h) continue;
    const raw = groupKey(h);
    const key =
      typeof raw === "string" && raw.trim() ? raw.trim() : fallbackKey;
    byKey.set(key, finite(byKey.get(key)) + finite(h.weightPercent));
  }
  return Array.from(byKey.entries())
    .map(([key, weight]) => ({ key, weight: round2(weight) }))
    .sort((a, b) => b.weight - a.weight || (a.key < b.key ? -1 : 1));
}

/**
 * Finite-guard a pre-aggregated breakdown (sector/cap/asset) and re-sort it by
 * weight DESC. A `NaN`/`Infinity` slice weight becomes `0` (never a NaN pie
 * slice / `"NaN%"` legend). `labelKey` names the label field (`"sector"` /
 * `"cap"` / `"type"`); the weight field is always `weight`.
 */
export function sanitizeBreakdown<K extends string>(
  breakdown: ReadonlyArray<Record<K | "weight", string | number>>,
  labelKey: K,
): Array<Record<K | "weight", string | number>> {
  if (!Array.isArray(breakdown)) return [];
  return breakdown
    .filter((s): s is Record<K | "weight", string | number> => s != null)
    .map(
      (s) =>
        ({ ...s, weight: round2(s.weight as number) }) as Record<
          K | "weight",
          string | number
        >,
    )
    .sort((a, b) => (b.weight as number) - (a.weight as number));
}

// ---------------------------------------------------------------------------
// dataAsOf / confidence safety
// ---------------------------------------------------------------------------

/**
 * Coerce an arbitrary `dataAsOf` into a safe display string. A real string is
 * trimmed and returned as-is (e.g. the `"2025-12"` disclosure month). A `Date`
 * is rendered as `YYYY-MM-DD` ONLY when it is valid — an Invalid Date
 * (`new Date("garbage")`) yields `""` rather than throwing `RangeError` on
 * `.toISOString()` or rendering the literal `"Invalid Date"`. Anything else
 * (number/null/object) → `""`.
 */
export function safeDataAsOf(value: unknown): string {
  if (typeof value === "string") return value.trim();
  if (value instanceof Date) {
    return Number.isFinite(value.getTime())
      ? (value.toISOString().split("T")[0] ?? "")
      : "";
  }
  return "";
}

/**
 * Clamp `confidence` to a finite `[0,1]`. It renders as
 * `Math.round(confidence * 100)%`, so a `NaN`/`Infinity`/out-of-range value
 * would otherwise show `"NaN%"` / `">100%"`. Non-finite → `0`.
 */
export function clampConfidence(value: number | null | undefined): number {
  const v = finite(value);
  if (v < 0) return 0;
  if (v > 1) return 1;
  return v;
}

// ---------------------------------------------------------------------------
// Top-level normalization (what the service calls)
// ---------------------------------------------------------------------------

/**
 * Sanitize a raw composition into a {@link NormalizedComposition} the service
 * can safely cache & return — the single entry point the LIVE
 * `fund-composition.service.ts` calls in place of its old raw pass-through.
 *
 * Pipeline (all finite-guarded, order-preserving for finite inputs):
 *   1. holdings → finite weights, sorted by weight DESC (top holding first);
 *   2. each breakdown → finite-guarded + sorted DESC; a MISSING/empty breakdown
 *      is DERIVED from the sanitized holdings (sector / cap / asset) so the pie
 *      chart is never empty-or-NaN when holdings exist;
 *   3. `coveragePercent` = Σ guarded weights (the "covers X%" total);
 *   4. `totalHoldings` falls back to the holdings length when the stored count
 *      is non-finite;
 *   5. `confidence` clamped to `[0,1]`, `dataAsOf` coerced to a safe string.
 *
 * For a clean finite input this returns the same field values & ordering as the
 * prior raw pass-through (plus the new always-finite `coveragePercent`).
 */
export function normalizeComposition(
  raw: RawComposition,
): NormalizedComposition {
  const holdings = sanitizeAndSortHoldings(raw?.holdings ?? []);

  const sectorBreakdown =
    raw?.sectorBreakdown && raw.sectorBreakdown.length > 0
      ? (sanitizeBreakdown(raw.sectorBreakdown, "sector") as SectorSlice[])
      : (aggregateByKey(holdings, (h) => h.sector, "Unknown").map((b) => ({
          sector: b.key,
          weight: b.weight,
        })) as SectorSlice[]);

  const capBreakdown =
    raw?.capBreakdown && raw.capBreakdown.length > 0
      ? (sanitizeBreakdown(raw.capBreakdown, "cap") as CapSlice[])
      : (aggregateByKey(holdings, (h) => h.marketCap, "Unknown").map((b) => ({
          cap: b.key,
          weight: b.weight,
        })) as CapSlice[]);

  const assetBreakdown =
    raw?.assetBreakdown && raw.assetBreakdown.length > 0
      ? (sanitizeBreakdown(raw.assetBreakdown, "type") as AssetSlice[])
      : (aggregateByKey(holdings, (h) => h.holdingType, "Unknown").map((b) => ({
          type: b.key,
          weight: b.weight,
        })) as AssetSlice[]);

  const totalHoldings = Number.isFinite(raw?.totalHoldings)
    ? raw.totalHoldings
    : holdings.length;

  return {
    fundType: raw.fundType,
    fundId: raw.fundId,
    holdings,
    sectorBreakdown,
    capBreakdown,
    assetBreakdown,
    totalHoldings,
    confidence: clampConfidence(raw?.confidence),
    dataAsOf: safeDataAsOf(raw?.dataAsOf),
    coveragePercent: coveragePercent(holdings),
  };
}

// ---------------------------------------------------------------------------
// Portfolio overlap between two funds
// ---------------------------------------------------------------------------

/** A weighted holding key for overlap math. */
export interface OverlapHolding {
  key: string;
  weight: number;
}

/** Result of {@link portfolioOverlap}. */
export interface OverlapResult {
  /** number of holding keys held by BOTH funds */
  sharedCount: number;
  /** |A∩B| / |A∪B| by key, 0-100 (Jaccard) */
  jaccardPercent: number;
  /**
   * Σ min(weightA, weightB) over shared keys, 0-100 — the canonical "% overlap"
   * (how much of the two portfolios is literally the same positions). Always
   * finite; `0` when there is no common value.
   */
  weightOverlapPercent: number;
}

/**
 * Build a `key -> aggregated finite weight` map for one fund (duplicate keys
 * summed, non-finite weights neutralised to 0, empty keys dropped).
 */
function weightByKey(
  holdings: ReadonlyArray<OverlapHolding>,
): Map<string, number> {
  const map = new Map<string, number>();
  if (!Array.isArray(holdings)) return map;
  for (const h of holdings) {
    const key = typeof h?.key === "string" ? h.key.trim().toUpperCase() : "";
    if (!key) continue;
    map.set(key, finite(map.get(key)) + finite(h.weight));
  }
  return map;
}

/**
 * Pairwise portfolio overlap between two funds.
 *
 * `weightOverlapPercent = Σ min(weightA, weightB)` over the keys both funds
 * hold — every term finite-guarded, so a `NaN`/`Infinity` weight on either side
 * contributes `0` rather than poisoning the sum. `jaccardPercent = shared /
 * union * 100`, guarded so an empty union (two empty funds) yields `0`, not the
 * div-by-zero `NaN`. Two funds with NO common key / no common value both yield
 * `0` everywhere (an honest "no overlap"), never `NaN`.
 */
export function portfolioOverlap(
  fundA: ReadonlyArray<OverlapHolding>,
  fundB: ReadonlyArray<OverlapHolding>,
): OverlapResult {
  const a = weightByKey(fundA);
  const b = weightByKey(fundB);

  let sharedCount = 0;
  let weightOverlap = 0;
  for (const [key, wa] of a.entries()) {
    if (!b.has(key)) continue;
    sharedCount += 1;
    weightOverlap += Math.min(finite(wa), finite(b.get(key)));
  }

  const unionCount = a.size + b.size - sharedCount;
  const jaccard = unionCount > 0 ? (sharedCount / unionCount) * 100 : 0;

  return {
    sharedCount,
    jaccardPercent: round2(Number.isFinite(jaccard) ? jaccard : 0),
    weightOverlapPercent: round2(weightOverlap),
  };
}
