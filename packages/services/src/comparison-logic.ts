/**
 * Comparison pure-logic helpers (service layer).
 *
 * Side-effect-free comparison math shared by the fund-comparison surface
 * (`./fund-comparison.service.ts`) and the `/compare` client. These are the
 * relative-metric calculations the compare UI renders:
 *
 *   - rebased / indexed price series (NAV normalized to base 100),
 *   - relative return % and raw percent-change,
 *   - peer-relative best-in-row selection (`isBest`),
 *   - deterministic ranking / winner selection.
 *
 * They are isolated here (away from the Prisma-importing service) so they can
 * be unit-tested without pulling the Prisma client in at import time, and —
 * critically — so the LIVE comparison path runs the SAME non-finite-guarded
 * math the regression tests assert.
 *
 * Behaviour here is identical, for FINITE inputs, to the normalization logic
 * that previously lived inline in `apps/web/app/compare/client.tsx`
 * (`computeChartData` / `isBest`); the service now derives its
 * `normalizedSeries` from `buildNormalizedComparison`. The only intentional
 * behavioural differences are defensive:
 *
 *   - a `NaN`/`±Infinity` value in one instrument's series no longer poisons
 *     the rebased series of the OTHER instruments (each series is independent)
 *     nor the ranking (a `NaN` total can sort unpredictably → wrong "winner");
 *   - rebasing when the BASE point is `0` / missing no longer spreads
 *     `Infinity`/`NaN` across the whole series (the point is dropped instead);
 *   - an Invalid-Date in a series never throws on `.toISOString()`;
 *   - ranking with all-equal or `NaN`/missing values is stable & deterministic,
 *     with non-finite values ranked LAST (never first).
 *
 * Mirrors the `finite()` precedent in `./dashboard-logic.ts`.
 */

// ---------------------------------------------------------------------------
// Non-finite guard
// ---------------------------------------------------------------------------

/**
 * Coerce a possibly-non-finite numeric to a safe finite number.
 *
 * Comparison math is full of division (rebasing, relative return) and ordering
 * (ranking) surfaces where a single `NaN`/`Infinity` value silently corrupts an
 * entire derived series or flips a sort. Stored NAV/return/ratio values are
 * occasionally `NaN`/`Infinity` (a divide that went wrong upstream, a corrupt
 * sync row), so every value that enters a ratio, a normalized series, or a sort
 * key is funnelled through this guard first. `null`/`undefined`/`NaN`/`±Infinity`
 * all collapse to `fallback` (default 0). Mirrors `./dashboard-logic.ts#finite`.
 */
export function finite(value: number | null | undefined, fallback = 0): number {
  return value != null && Number.isFinite(value) ? value : fallback;
}

// ---------------------------------------------------------------------------
// Structural input types
// ---------------------------------------------------------------------------

/** A single point in a price/NAV series. `date` is an ISO `YYYY-MM-DD` string. */
export interface SeriesPoint {
  date: string;
  value: number;
}

/** One instrument's labelled raw series (the shape the service holds per fund). */
export interface NamedSeries {
  /** Stable key, e.g. `"MF:119551"` / `"ETF:NIFTYBEES"`. */
  key: string;
  points: SeriesPoint[];
}

/** A rebased (indexed-to-100) point: `value` is the index, `raw` the original. */
export interface RebasedPoint {
  date: string;
  /** Index value, base point == 100. */
  value: number;
  /** The original (finite-guarded) value, for tooltips / downstream math. */
  raw: number;
}

// ---------------------------------------------------------------------------
// Rebase a single series to base 100
// ---------------------------------------------------------------------------

/**
 * Rebase (index) a price/NAV series to a base of 100 at its first usable point.
 *
 * `index = value / base * 100`, where `base` is the first point whose value is
 * finite and non-zero. Each subsequent point is `finite()`-guarded so a single
 * corrupt mid-series value (NaN/Infinity) becomes `0`-indexed for THAT point
 * only rather than propagating; the base itself is chosen to be finite & non
 * zero so the whole series can never become `Infinity`/`NaN` from a `÷0`.
 *
 * Edge handling:
 *   - empty input → `[]`;
 *   - if NO point has a finite, non-zero value (all zero / all NaN / first
 *     point missing-and-rest-zero) there is no valid base → `[]` (the caller
 *     renders "no data" rather than a flat-`Infinity` line);
 *   - leading zero/NaN points before the first valid base are skipped, so a
 *     missing/zero first point does not force a `÷0`. The base is the first
 *     USABLE point; points before it are dropped (they cannot be indexed
 *     against a not-yet-seen base without inventing data).
 *
 * Rounding matches the legacy client exactly: `round(index * 100) / 100`
 * (2 dp) so finite inputs reproduce the prior chart values bit-for-bit.
 */
export function rebaseSeriesTo100(points: SeriesPoint[]): RebasedPoint[] {
  if (!Array.isArray(points) || points.length === 0) return [];

  // Find the first point with a finite, non-zero value to use as the base.
  let base: number | null = null;
  let baseIdx = -1;
  for (let i = 0; i < points.length; i++) {
    const v = points[i]?.value;
    if (v != null && Number.isFinite(v) && v !== 0) {
      base = v;
      baseIdx = i;
      break;
    }
  }
  // No usable base ⇒ cannot rebase without dividing by zero / spreading NaN.
  if (base === null) return [];

  const out: RebasedPoint[] = [];
  for (let i = baseIdx; i < points.length; i++) {
    const p = points[i];
    if (!p) continue;
    const raw = finite(p.value);
    // base is finite & non-zero by construction, so this division is always
    // finite when `raw` is finite; finite() on `raw` already neutralised any
    // ±Infinity/NaN value into 0 → indexes to 0 for that point only.
    const index = Math.round((raw / base) * 10000) / 100;
    out.push({ date: p.date, value: finite(index), raw });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Multi-instrument normalized comparison (the /compare chart builder)
// ---------------------------------------------------------------------------

/** One row of the normalized overlay chart: `date` + per-instrument index. */
export type NormalizedRow = Record<string, string | number>;

/**
 * Build the normalized (base-100) overlay-chart rows for N instruments — the
 * service-side equivalent of the client's `computeChartData`.
 *
 * For each instrument, its window is rebased to 100 at ITS OWN first usable
 * point (so all lines start together at 100), then the rows are emitted on the
 * union of dates, sorted ascending. A missing date for an instrument simply
 * omits that instrument's key on that row (the chart bridges gaps), exactly as
 * before. Critically, each instrument is rebased INDEPENDENTLY, so a corrupt /
 * empty series for one fund can never alter another fund's line.
 *
 * `keyPrefix` controls the per-instrument column name (`${keyPrefix}${i}` —
 * default `"fund"`, matching the client's `fund0`, `fund1`, …). The legacy
 * client built `firstValue = history[0]?.value ?? 1` and divided by it
 * (so a `0` or missing first value silently produced `Infinity`/garbage). Here
 * the base is the first FINITE NON-ZERO value, fixing that whole class of bug,
 * while finite series reproduce the same numbers.
 */
export function buildNormalizedComparison(
  series: NamedSeries[],
  keyPrefix = "fund",
): NormalizedRow[] {
  if (!Array.isArray(series) || series.length === 0) return [];

  // Rebase each instrument independently → date→index map per instrument.
  const rebased: Array<Map<string, number>> = series.map((s) => {
    const map = new Map<string, number>();
    for (const pt of rebaseSeriesTo100(s?.points ?? [])) {
      map.set(pt.date, pt.value);
    }
    return map;
  });

  // Union of all dates across all instruments, sorted ascending (lexicographic
  // sort is correct for `YYYY-MM-DD`).
  const allDates = new Set<string>();
  for (const map of rebased) {
    for (const d of map.keys()) allDates.add(d);
  }
  const sortedDates = Array.from(allDates).sort();
  if (sortedDates.length === 0) return [];

  return sortedDates.map((date) => {
    const row: NormalizedRow = { date };
    for (let i = 0; i < rebased.length; i++) {
      const v = rebased[i]!.get(date);
      if (v !== undefined) row[`${keyPrefix}${i}`] = v;
    }
    return row;
  });
}

// ---------------------------------------------------------------------------
// Percent-change & relative return
// ---------------------------------------------------------------------------

/**
 * Raw percent change between two values: `(to - from) / from * 100`.
 *
 * Returns `null` (an honest "—", never `NaN`/`Infinity` into a `.toFixed()`)
 * when `from` is non-finite or zero, or `to` is non-finite. This is the
 * div-by-zero / non-finite guard for the "return %" surface.
 */
export function percentChange(
  from: number | null | undefined,
  to: number | null | undefined,
): number | null {
  if (from == null || !Number.isFinite(from) || from === 0) return null;
  if (to == null || !Number.isFinite(to)) return null;
  const pct = ((to - from) / from) * 100;
  return Number.isFinite(pct) ? pct : null;
}

/**
 * Total return % of a series = percent change from the first usable
 * (finite, non-zero) point to the last finite point. Mirrors how the rebased
 * chart's end value (relative to its base of 100) reads as cumulative return.
 *
 * Returns `null` when there is no usable base point or no finite end point
 * (empty series, single non-finite point, all-zero series, etc.).
 */
export function seriesReturnPct(points: SeriesPoint[]): number | null {
  if (!Array.isArray(points) || points.length === 0) return null;

  let base: number | null = null;
  for (const p of points) {
    const v = p?.value;
    if (v != null && Number.isFinite(v) && v !== 0) {
      base = v;
      break;
    }
  }
  if (base === null) return null;

  let last: number | null = null;
  for (let i = points.length - 1; i >= 0; i--) {
    const v = points[i]?.value;
    if (v != null && Number.isFinite(v)) {
      last = v;
      break;
    }
  }
  if (last === null) return null;

  return percentChange(base, last);
}

/**
 * Relative return of `a` versus `b` in percentage points: `aPct - bPct`.
 * Either side being `null` (un-computable return) yields `null` rather than
 * letting a `NaN` leak into the "A out/under-performed B by X%" copy.
 */
export function relativeReturnPct(
  aPct: number | null,
  bPct: number | null,
): number | null {
  if (aPct == null || !Number.isFinite(aPct)) return null;
  if (bPct == null || !Number.isFinite(bPct)) return null;
  const diff = aPct - bPct;
  return Number.isFinite(diff) ? diff : null;
}

// ---------------------------------------------------------------------------
// Best-in-row selection (peer-relative highlight)
// ---------------------------------------------------------------------------

/**
 * Whether the value at `index` is the best among `values` (peer-relative
 * highlight for a metrics-table row). `higher === true` ⇒ larger is better
 * (returns); `false` ⇒ smaller is better (expense ratio).
 *
 * Ports the client's `isBest` and additionally treats `NaN`/`±Infinity` as
 * "not a value" (same as `null`/`undefined`): a corrupt entry can neither WIN
 * the row (a `NaN` must not be highlighted as best) nor poison the comparison
 * (`Math.max(..., NaN)` is `NaN`, which would make every cell fail to win).
 * With no other comparable value present, returns `false` (nothing to be
 * "best" against). All-equal values each return `true` (`>=` / `<=`).
 */
export function isBest(
  values: ReadonlyArray<number | null | undefined>,
  index: number,
  higher = true,
): boolean {
  const val = values[index];
  if (val == null || !Number.isFinite(val)) return false;
  const others = values.filter(
    (v, i): v is number => i !== index && v != null && Number.isFinite(v),
  );
  if (others.length === 0) return false;
  return higher ? val >= Math.max(...others) : val <= Math.min(...others);
}

// ---------------------------------------------------------------------------
// Deterministic ranking / winner selection
// ---------------------------------------------------------------------------

/** A rankable instrument: a label + a numeric score (possibly non-finite/null). */
export interface RankableItem {
  /** Stable identity (symbol / key) — also the tie-breaker for determinism. */
  label: string;
  score: number | null | undefined;
}

/** A ranked row: 1-based `rank`, the `label`, and the finite-guarded `score`. */
export interface RankedItem {
  rank: number;
  label: string;
  /** The original score if finite, else `null` (it did not participate). */
  score: number | null;
}

/**
 * Rank instruments by score, deterministically and NaN-safely.
 *
 * Ordering rules:
 *   - `higher === true` (default): larger score ranks first; else smaller.
 *   - Non-finite / missing scores (`NaN`/`±Infinity`/`null`/`undefined`) are
 *     ALWAYS ranked LAST, never first. (Raw `Array.sort` with a `NaN`
 *     comparator is order-unstable and can surface a corrupt row as the
 *     "winner" — the exact failure this guards.)
 *   - Ties (including all-equal scores, and the all-non-finite block) break by
 *     `label` ascending, so the result is fully deterministic regardless of
 *     input order.
 *
 * `rank` is 1-based and dense by position (ties still occupy distinct slots,
 * ordered by label) so the output is a stable, predictable list.
 */
export function rankInstruments(
  items: ReadonlyArray<RankableItem>,
  higher = true,
): RankedItem[] {
  if (!Array.isArray(items) || items.length === 0) return [];

  const normalized = items.map((it) => {
    const raw = it?.score;
    const isFin = raw != null && Number.isFinite(raw);
    return {
      label: it?.label ?? "",
      score: isFin ? (raw as number) : null,
      isFin,
    };
  });

  normalized.sort((a, b) => {
    // Finite values always precede non-finite ones.
    if (a.isFin !== b.isFin) return a.isFin ? -1 : 1;
    if (a.isFin && b.isFin && a.score !== b.score) {
      return higher
        ? (b.score as number) - (a.score as number)
        : (a.score as number) - (b.score as number);
    }
    // Tie (equal finite scores, or both non-finite): deterministic by label.
    return a.label < b.label ? -1 : a.label > b.label ? 1 : 0;
  });

  return normalized.map((it, i) => ({
    rank: i + 1,
    label: it.label,
    score: it.score,
  }));
}

/**
 * The single best instrument, or `null` when none can win.
 *
 * Returns `null` when the list is empty OR when NO item has a finite score
 * (a comparison where every score is `NaN`/missing has no honest winner — we
 * must not crown a corrupt row). Otherwise returns the rank-1 item from
 * `rankInstruments`, which is finite by construction (finite always sorts
 * ahead of non-finite). Ties resolve to the lexicographically-smallest label.
 */
export function pickWinner(
  items: ReadonlyArray<RankableItem>,
  higher = true,
): RankedItem | null {
  const ranked = rankInstruments(items, higher);
  const top = ranked[0];
  if (!top || top.score === null) return null;
  return top;
}
