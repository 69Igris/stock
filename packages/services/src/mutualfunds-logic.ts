/**
 * Mutual-funds pure-logic helpers (service layer).
 *
 * Side-effect-free MF math/aggregation used by `getMutualFunds` and
 * `createMutualFund` in `./mutualfunds.service.ts`. Isolated here (away from the
 * Prisma-importing service) so it can be unit-tested without pulling in the
 * Prisma client at import time, and — critically — so the LIVE user-facing
 * mutual-funds path runs the SAME non-finite-guarded math.
 *
 * Behavior here is identical, for FINITE inputs, to the logic that previously
 * lived inline in the service; the service now calls these helpers. The only
 * intentional behavioural difference is defensive: a `NaN`/`±Infinity` stored
 * field (a corrupt broker-sync row) can no longer
 *   - poison the whole portfolio total (`totalInvested`/`totalCurrent`/
 *     `totalPnL` → "₹NaN"),
 *   - make `pnlPercentage` the literal string "NaN"/"Infinity", or
 *   - leak a non-finite per-fund number (units / averageNav / currentNav /
 *     investedAmount / currentValue / unrealizedGain / xirr) into a downstream
 *     `.toFixed()`/`.toLocaleString()`/`Math.round()` in the holdings UI
 *     (which renders e.g. `r.units.toFixed(3)`, `₹{r.currentNav.toFixed(2)}`,
 *     `fmtINR(Math.round(r.currentValue))`, `Math.abs(pct).toFixed(2)%`).
 *
 * Mirrors the `finite()` precedent in `./dashboard-logic.ts`. This module
 * defines its OWN local `finite()` (no cross-module import) so it stays
 * self-contained and Prisma-free.
 *
 * @see apps/web/__tests__/services/mutualfunds-data-e2e.test.ts (drives the LIVE service)
 * @see apps/web/__tests__/services/mutualfunds-logic-unit.test.ts (pure-logic unit tests)
 */

import type { MutualFundFormInput } from "@usemoney/validation";

// ---------------------------------------------------------------------------
// Non-finite guard (local; mirrors ./dashboard-logic.ts#finite)
// ---------------------------------------------------------------------------

/**
 * Coerce a possibly-non-finite numeric to a safe finite number.
 *
 * MF aggregation is a SUM surface and the per-fund fields flow into UI
 * formatters: a single `NaN`/`Infinity` field poisons the portfolio total
 * (the holdings page renders "₹NaN") or yields "NaN%". Stored broker values
 * are occasionally `NaN`/`Infinity` (a divide that went wrong upstream, a
 * corrupt sync row), so every value that enters a sum, a ratio, or a
 * `.toFixed()`/`.toLocaleString()`/`Math.round()` is funnelled through this
 * guard first. `null`/`undefined`/`NaN`/`±Infinity` all collapse to `fallback`
 * (default 0).
 */
export function finite(value: number | null | undefined, fallback = 0): number {
  return value != null && Number.isFinite(value) ? value : fallback;
}

// ---------------------------------------------------------------------------
// Where-clause builder (IDOR scope)
// ---------------------------------------------------------------------------

export interface MutualFundFilters {
  search?: string;
  category?: string;
}

/** The shape of the Prisma `mutualFund` where-clause this builder emits. */
export interface MutualFundWhere {
  userId: string;
  schemeName?: { contains: string; mode: "insensitive" };
  category?: string;
}

/**
 * Build the userId-scoped where-clause for `prisma.mutualFund.findMany`.
 *
 * Invariants (security / IDOR): `userId` is ALWAYS present so a query can never
 * span users. `search` adds a case-insensitive `schemeName contains`; an
 * empty/whitespace-only-but-falsy search is treated as "no filter" (mirrors
 * `if (search)`). The sentinel category `"all"` is treated as "no category
 * filter"; any other (truthy) category is applied verbatim.
 */
export function buildMutualFundWhere(
  userId: string,
  filters: MutualFundFilters = {},
): MutualFundWhere {
  const where: MutualFundWhere = { userId };

  if (filters.search) {
    where.schemeName = { contains: filters.search, mode: "insensitive" };
  }
  if (filters.category && filters.category !== "all") {
    where.category = filters.category;
  }

  return where;
}

// ---------------------------------------------------------------------------
// Per-fund derivation (create path + read normalisation)
// ---------------------------------------------------------------------------

/**
 * Invested amount for a holding = units × averageNav. Each operand is
 * finite-guarded so a corrupt unit/NAV can't produce `NaN`/`Infinity`.
 */
export function computeMfInvested(units: number, averageNav: number): number {
  return finite(finite(units) * finite(averageNav));
}

/**
 * Current market value of a holding = units × currentNav. Finite-guarded.
 */
export function computeMfCurrentValue(
  units: number,
  currentNav: number,
): number {
  return finite(finite(units) * finite(currentNav));
}

/**
 * Unrealised gain = currentValue − investedAmount. Finite-guarded so a
 * non-finite operand collapses to a finite difference rather than NaN.
 */
export function computeMfUnrealizedGain(
  currentValue: number,
  investedAmount: number,
): number {
  return finite(finite(currentValue) - finite(investedAmount));
}

/**
 * Absolute return percentage for a single holding = gain / invested × 100,
 * as a number. Returns `0` when invested is not a usable positive number
 * (avoids divide-by-zero → ±Infinity, and a sign-flipped pct on a negative
 * invested). Never returns `NaN`/`±Infinity`.
 */
export function computeMfReturnPct(
  unrealizedGain: number,
  investedAmount: number,
): number {
  const invested = finite(investedAmount);
  if (invested <= 0) return 0;
  return finite((finite(unrealizedGain) / invested) * 100);
}

/** The fields the create path derives from a validated form input. */
export interface MutualFundDerivedCreate {
  currentNav: number;
  investedAmount: number;
  currentValue: number;
  unrealizedGain: number;
}

/**
 * Derive the stored numeric fields for a NEW mutual fund from its validated
 * form input. `currentNav` falls back to `averageNav` when not provided
 * (mirrors `data.currentNav || data.averageNav`). All products are
 * finite-guarded; the Zod schema already enforces positive+finite units/NAVs
 * at the action boundary, but the service is also consumed by apps/api and
 * workers — this keeps the math honest regardless of caller.
 */
export function deriveMutualFundCreateFields(
  data: Pick<MutualFundFormInput, "units" | "averageNav" | "currentNav">,
): MutualFundDerivedCreate {
  const currentNav = finite(data.currentNav || data.averageNav);
  const units = finite(data.units);
  const averageNav = finite(data.averageNav);
  const investedAmount = computeMfInvested(units, averageNav);
  const currentValue = computeMfCurrentValue(units, currentNav);
  const unrealizedGain = computeMfUnrealizedGain(currentValue, investedAmount);
  return { currentNav, investedAmount, currentValue, unrealizedGain };
}

/** The stored numeric fields a NAV-propagation refresh writes to a user MF row. */
export interface MfNavPatch {
  currentNav: number;
  currentValue: number;
  unrealizedGain: number;
  lastNavDate: Date | null;
}

/**
 * Decide the NAV patch for ONE user MutualFund row from its MutualFundMaster NAV
 * (MONEY-1074). User MF rows' `currentNav` is set once at creation (falling back
 * to `averageNav` → 0 gain forever) and nothing ever refreshes it, so MF total
 * return was always 0. This is the per-row decision the nightly propagation job
 * applies.
 *
 * Returns `null` = SKIP — and it NEVER zeroes a row:
 *   - master NAV missing / non-finite / <= 0  → skip (keep the stored value)
 *   - non-finite units                        → skip
 *   - nothing meaningful would change (|navΔ| < ε AND the stored currentValue
 *     already equals units×nav)                → skip (idempotent fixpoint: a
 *     re-run over an already-propagated row is a no-op, bounding write volume)
 *
 * `invested` uses the same `investedAmount || investedValue || 0` fallback chain
 * as `calculateMfAggregation`; broker-sync-owned columns are left untouched
 * beyond the derived `currentValue`/`unrealizedGain`.
 */
export function buildMfNavPatch(
  fund: {
    units: number | null;
    investedAmount: number | null;
    investedValue: number | null;
    currentNav: number | null;
    currentValue: number | null;
  },
  masterNav: number | null | undefined,
  masterNavDate: Date | null | undefined,
): MfNavPatch | null {
  if (masterNav == null || !Number.isFinite(masterNav) || masterNav <= 0) {
    return null;
  }
  const units = fund.units;
  if (units == null || !Number.isFinite(units)) return null;

  const nav = masterNav;
  const invested = finite(fund.investedAmount || fund.investedValue || 0);
  const currentValue = computeMfCurrentValue(units, nav);
  const unrealizedGain = computeMfUnrealizedGain(currentValue, invested);

  // Idempotency: skip when the NAV is effectively unchanged AND the stored
  // currentValue already reflects units×nav (re-run over a fresh row = no-op).
  const navUnchanged = Math.abs(finite(fund.currentNav) - nav) < 1e-6;
  const valueConsistent =
    Math.abs(finite(fund.currentValue) - currentValue) < 1e-6;
  if (navUnchanged && valueConsistent) return null;

  return {
    currentNav: nav,
    currentValue,
    unrealizedGain,
    lastNavDate: masterNavDate ?? null,
  };
}

/** The (finite, non-null) numeric fields a sanitised MF row carries. */
export interface MutualFundNumericFields {
  units: number;
  averageNav: number;
  currentNav: number;
  investedAmount: number;
  currentValue: number;
  unrealizedGain: number;
  xirr: number;
}

/**
 * The numeric-field shape a STORED MF row may present before sanitisation —
 * each field may be missing or `null` (Prisma typed `unrealizedGain` etc. as
 * nullable; a broker sync may also omit them).
 */
export type MutualFundNumericInput = {
  [K in keyof MutualFundNumericFields]?: number | null;
};

/**
 * Sanitise the numeric fields of a stored MF row so a corrupt broker-sync
 * value (NaN/Infinity/null) can never reach the holdings UI's
 * `.toFixed()`/`.toLocaleString()`/`Math.round()`. Every numeric field is
 * finite-guarded (null/undefined/NaN/±Infinity → 0); the (finite) shape is
 * otherwise preserved exactly, so this is behaviour-preserving for clean rows.
 *
 * Generic over the input row so callers keep all their non-numeric fields
 * (id, schemeName, dates, …) untouched — only the numeric subset is rewritten
 * (and narrowed from `number | null` to a finite `number`).
 */
export function sanitizeMutualFundNumerics<T extends MutualFundNumericInput>(
  fund: T,
): Omit<T, keyof MutualFundNumericFields> & MutualFundNumericFields {
  return {
    ...fund,
    units: finite(fund.units),
    averageNav: finite(fund.averageNav),
    currentNav: finite(fund.currentNav),
    investedAmount: finite(fund.investedAmount),
    currentValue: finite(fund.currentValue),
    unrealizedGain: finite(fund.unrealizedGain),
    xirr: finite(fund.xirr),
  };
}

// ---------------------------------------------------------------------------
// Portfolio summary aggregation
// ---------------------------------------------------------------------------

export interface MutualFundSummary {
  totalInvested: number;
  totalCurrent: number;
  totalPnL: number;
  pnlPercentage: string;
}

/** The per-fund numeric fields the summary aggregator sums over. */
export interface MutualFundSummaryInput {
  investedAmount: number | null | undefined;
  currentValue: number | null | undefined;
  unrealizedGain: number | null | undefined;
}

/**
 * Aggregate a portfolio summary from MF rows.
 *
 *  - Every addend is finite-guarded so a single corrupt fund (NaN/Infinity
 *    invested/current/gain) cannot turn the whole portfolio total into
 *    `NaN`/`Infinity` ("₹NaN"). `null` `unrealizedGain` counts as 0.
 *  - `pnlPercentage` is a 2-decimal string; when there's nothing usable
 *    invested (`totalInvested <= 0`, or non-finite) it is the literal "0"
 *    (avoids divide-by-zero → ±Infinity and a misleading percentage on an
 *    empty/zero-cost book). It is NEVER the literal string "NaN"/"Infinity".
 */
export function calculateMfSummary(
  funds: MutualFundSummaryInput[],
): MutualFundSummary {
  const totalInvested = funds.reduce(
    (sum, f) => sum + finite(f.investedAmount),
    0,
  );
  const totalCurrent = funds.reduce(
    (sum, f) => sum + finite(f.currentValue),
    0,
  );
  const totalPnL = funds.reduce(
    (sum, f) => sum + finite(f.unrealizedGain ?? 0),
    0,
  );

  return {
    totalInvested,
    totalCurrent,
    totalPnL,
    pnlPercentage: formatMfPnlPercentage(totalPnL, totalInvested),
  };
}

/**
 * Portfolio P&L percentage as a fixed(2) string, or "0" when invested is not a
 * usable positive number. Non-finite P&L/invested return "0" too — otherwise
 * `(NaN).toFixed(2)` yields the literal string "NaN", which the holdings page
 * would render verbatim. Mirrors `./dashboard-logic.ts#calculatePnLPercentage`.
 */
export function formatMfPnlPercentage(
  totalPnL: number,
  totalInvested: number,
): string {
  if (!Number.isFinite(totalInvested) || totalInvested <= 0) return "0";
  if (!Number.isFinite(totalPnL)) return "0";
  return ((totalPnL / totalInvested) * 100).toFixed(2);
}

// ---------------------------------------------------------------------------
// NAV-derived returns + 52-week range (MONEY-1205)
// ---------------------------------------------------------------------------
//
// This math used to live in a React `useMemo` in
// `apps/web/app/mf/[schemeCode]/client.tsx`, with a hard-coded +/-30-day anchor
// tolerance and NO minimum-data-points floor. Three problems followed from that
// and all three are fixed here:
//
//  1. **It was untestable and unshared.** `apps/api` returns its own numbers for
//     the same fund, so the web page and the mobile API could disagree about a
//     3-year return with nothing to reconcile them.
//  2. **"Not enough history" was indistinguishable from "failed to load".** Both
//     rendered a bare "-". A fund launched in Feb 2024 has a perfectly good
//     reason to have no 5-year return, and the UI could not say so — which is
//     also what made the 55-83s inline-backfill failure invisible: an empty
//     `navHistory` looked exactly like a young fund.
//  3. **No floor.** Two stray points a year apart produced a confident CAGR.
//
// `dataPoints` and `coverageYears` are returned precisely so a caller can tell
// those states apart: `dataPoints === 0` means we have nothing (load failed or
// backfill pending), while `coverageYears === 2.5` with `r5Y === null` means the
// fund is younger than five years and the UI should say "launched Feb 2024".

/** A NAV observation. `date` accepts an ISO string ("YYYY-MM-DD") or a Date. */
export interface NavDerivativePoint {
  date: string | Date;
  nav: number;
}

export interface NavDerivatives {
  /** Annualised 1-year return, %. null when the series does not span 1 year. */
  r1Y: number | null;
  /** Annualised 3-year return, %. */
  r3Y: number | null;
  /** Annualised 5-year return, %. */
  r5Y: number | null;
  /** Annualised return over the whole stored series, %. */
  rInception: number | null;
  /** Highest NAV in the trailing 52 weeks. */
  high52: number | null;
  /** Lowest NAV in the trailing 52 weeks. */
  low52: number | null;
  /** Usable observations after cleaning. 0 => we have no history at all. */
  dataPoints: number;
  /** Span of the stored series in years, or null when there is no series. */
  coverageYears: number | null;
}

export interface NavDerivativeOptions {
  /**
   * Upper bound for usable observations; points dated after it are dropped as
   * feed corruption. Defaults to the current time. It is NOT the anchor — see
   * the reference-date note on {@link computeNavDerivatives}.
   */
  now?: Date;
  /** Minimum observations inside a horizon window. Default 20. */
  minPointsInWindow?: number;
  /** How far from the exact anchor date a point may sit, in days. Default 30. */
  toleranceDays?: number;
}

/** Minimum observations required inside a horizon window before it yields a number. */
export const NAV_MIN_POINTS_IN_WINDOW = 20;
/** Default anchor tolerance: a NAV within 30 days of the exact horizon date. */
export const NAV_ANCHOR_TOLERANCE_DAYS = 30;

const MS_PER_DAY = 24 * 60 * 60 * 1000;
const MS_PER_YEAR = 365.25 * MS_PER_DAY;

interface CleanPoint {
  t: number;
  nav: number;
}

/**
 * Clean, sort and de-duplicate raw NAV observations.
 *
 * Absence rule: a non-finite or non-positive NAV is DROPPED, never coerced to
 * 0 — a 0 NAV would sink a min() and fabricate a -100% return. An unparseable
 * date is dropped for the same reason.
 */
function cleanNavPoints(
  points: readonly NavDerivativePoint[],
  nowMs: number,
): CleanPoint[] {
  const byDay = new Map<number, CleanPoint>();

  for (const p of points) {
    if (!p) continue;
    const raw = p.date;
    const d = raw instanceof Date ? raw : new Date(String(raw));
    const t = d.getTime();
    if (!Number.isFinite(t)) continue;
    if (t > nowMs) continue; // future-dated => feed corruption
    const nav = typeof p.nav === "number" ? p.nav : Number(p.nav);
    if (!Number.isFinite(nav) || nav <= 0) continue;
    // Last write wins for a repeated day.
    byDay.set(t, { t, nav });
  }

  return [...byDay.values()].sort((a, b) => a.t - b.t);
}

/** Annualised compound growth, as a percentage. */
function cagrPercent(startNav: number, endNav: number, years: number): number {
  return (Math.pow(endNav / startNav, 1 / years) - 1) * 100;
}

/** The observation closest to `targetMs`, if one sits within the tolerance. */
function anchorAt(
  series: readonly CleanPoint[],
  targetMs: number,
  toleranceMs: number,
): CleanPoint | null {
  let best: CleanPoint | null = null;
  let bestDiff = Infinity;
  for (const p of series) {
    const diff = Math.abs(p.t - targetMs);
    if (diff < bestDiff) {
      bestDiff = diff;
      best = p;
    }
  }
  return best !== null && bestDiff <= toleranceMs ? best : null;
}

/** Subtract whole calendar years from a timestamp (UTC). */
function minusYears(ms: number, years: number): number {
  const d = new Date(ms);
  d.setUTCFullYear(d.getUTCFullYear() - years);
  return d.getTime();
}

/**
 * Derive returns and the 52-week range from a NAV series.
 *
 * ## Reference date
 *
 * Every window is anchored on the **latest observation in the series**, not on
 * the wall clock. For a live fund those are the same day (NAV publishes daily),
 * and anchoring on the data makes the result reproducible — a test does not go
 * red because it ran at a different time, and a fund whose feed paused for a
 * week does not silently lose its 1-year return. `options.now` only bounds
 * which observations are usable.
 *
 * ## When a horizon returns null
 *
 * A horizon Y yields a number only when ALL of these hold:
 *  - the series actually reaches back Y years (`first <= reference - Y years`),
 *    so a 2.9-year-old fund gets `r3Y === null` rather than a 2.9-year CAGR
 *    presented as a 3-year one;
 *  - an observation sits within `toleranceDays` of the exact anchor date;
 *  - at least `minPointsInWindow` observations fall inside the window, so two
 *    stray points cannot produce a confident-looking number.
 *
 * `rInception` needs at least one year of span (annualising a 3-month return
 * produces a meaningless headline number) plus the same point floor.
 *
 * @param points raw NAV observations, any order
 * @returns the derivative set; `dataPoints`/`coverageYears` describe WHY a
 *          field is null, so "not enough history" and "failed to load" are
 *          distinguishable by the caller.
 */
export function computeNavDerivatives(
  points: readonly NavDerivativePoint[],
  options: NavDerivativeOptions = {},
): NavDerivatives {
  const nowMs = (options.now ?? new Date()).getTime();
  const minPoints = options.minPointsInWindow ?? NAV_MIN_POINTS_IN_WINDOW;
  const toleranceMs =
    (options.toleranceDays ?? NAV_ANCHOR_TOLERANCE_DAYS) * MS_PER_DAY;

  const empty: NavDerivatives = {
    r1Y: null,
    r3Y: null,
    r5Y: null,
    rInception: null,
    high52: null,
    low52: null,
    dataPoints: 0,
    coverageYears: null,
  };

  const series = cleanNavPoints(
    points ?? [],
    Number.isFinite(nowMs) ? nowMs : Date.now(),
  );
  if (series.length === 0) return empty;

  const first = series[0]!;
  const last = series[series.length - 1]!;
  const referenceMs = last.t;
  const coverageYears = (last.t - first.t) / MS_PER_YEAR;

  const result: NavDerivatives = {
    ...empty,
    dataPoints: series.length,
    coverageYears,
  };

  // ---- 52-week range (trailing 365 days from the reference date) ----
  // Deliberately NOT falling back to the whole series when the window is thin:
  // labelling an all-time high as a "52-week high" is a mislabel, and a single
  // observation is not a range.
  const windowStart = referenceMs - 365 * MS_PER_DAY;
  const inWindow = series.filter((p) => p.t >= windowStart);
  if (inWindow.length >= 2) {
    let high = -Infinity;
    let low = Infinity;
    for (const p of inWindow) {
      if (p.nav > high) high = p.nav;
      if (p.nav < low) low = p.nav;
    }
    result.high52 = high;
    result.low52 = low;
  }

  // ---- Horizon returns ----
  const horizons: Array<[1 | 3 | 5, "r1Y" | "r3Y" | "r5Y"]> = [
    [1, "r1Y"],
    [3, "r3Y"],
    [5, "r5Y"],
  ];

  for (const [years, key] of horizons) {
    const targetMs = minusYears(referenceMs, years);

    // The series must genuinely span the horizon.
    if (first.t > targetMs) continue;

    const anchor = anchorAt(series, targetMs, toleranceMs);
    if (!anchor || anchor.nav <= 0) continue;

    const pointsInWindow = series.reduce(
      (n, p) => (p.t >= anchor.t ? n + 1 : n),
      0,
    );
    if (pointsInWindow < minPoints) continue;

    const value = cagrPercent(anchor.nav, last.nav, years);
    if (Number.isFinite(value)) result[key] = value;
  }

  // ---- Since inception ----
  if (coverageYears >= 1 && series.length >= minPoints && first.nav > 0) {
    const value = cagrPercent(first.nav, last.nav, coverageYears);
    if (Number.isFinite(value)) result.rInception = value;
  }

  return result;
}
