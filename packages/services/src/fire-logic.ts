/**
 * FIRE pure-logic helpers (service layer).
 *
 * The FIRE *projection* math (SIP/compound future value, target corpus, years-
 * to-FIRE, safe-withdrawal years, inflation adjustment, the year-by-year
 * projection series) historically lived ONLY client-side in
 * `apps/web/app/fire/lib/calculations.ts` and was UNGUARDED: a non-finite
 * input (`NaN`/`±Infinity` corpus / rate / years), a `Math.pow` overflow, a
 * `Math.pow(negative, fractional)` (negative real return), a `rate = -100%`
 * (`1 + rate = 0`) divide-by-zero in the SIP closed form, or a `0`-rate `0/0`
 * in `(pow - 1)/rate` could turn the projected corpus — or any chart point —
 * into `NaN`/`Infinity`, which then flows straight into `.toFixed()` /
 * `.toLocaleString()` / a Recharts series (the dashboard renders "₹NaN", or an
 * Invalid-Date `.toISOString()` throws and 500s the page).
 *
 * This module is the SERVICE-LAYER source of truth for that math. It is
 * isolated here (away from the Prisma-importing `fire.service.ts`) so it can be
 * unit-tested without pulling in the Prisma client at import time, and — like
 * `./dashboard-logic.ts` — so the LIVE service path runs the SAME
 * non-finite-guarded math. `fire.service.ts` CALLS these helpers (they are NOT
 * dead exports): `withMonthlyExpenses` delegates to `computeMonthlyExpenses`,
 * and `computeFireProjection` runs the full guarded projection.
 *
 * Behaviour here is identical, for FINITE / in-range inputs, to the logic in
 * `apps/web/app/fire/lib/calculations.ts`; the only intentional differences are
 * the defensive non-finite/overflow/div-by-zero guards documented per-function.
 *
 * Mirrors `apps/web/app/fire/lib/calculations.ts`.
 */

// ---------------------------------------------------------------------------
// Non-finite guard (LOCAL — see dashboard-logic.ts#finite for the precedent).
// ---------------------------------------------------------------------------

/**
 * Coerce a possibly-non-finite numeric to a safe finite number.
 *
 * FIRE projection is a COMPOUNDING surface: a single `NaN`/`±Infinity` value
 * (`Math.pow` overflow, a `0/0` SIP term, a corrupt stored corpus) poisons
 * every subsequent year and ultimately a `.toFixed()`/`.toLocaleString()`/chart
 * point ("₹NaN"). Every value that enters the compounding loop, a ratio, or a
 * rounded output is funnelled through this guard. `null`/`undefined`/`NaN`/
 * `±Infinity` all collapse to `fallback` (default 0). Local by design so this
 * module has no cross-file coupling. Mirrors `dashboard-logic.ts#finite`.
 */
export function finite(value: number | null | undefined, fallback = 0): number {
  return value != null && Number.isFinite(value) ? value : fallback;
}

/**
 * Safe `Math.pow` for a growth/inflation factor `base = 1 + rate%`.
 *
 * Guards the two ways `Math.pow` produces a non-finite/NaN result that the raw
 * `Math.pow(1 + r/100, n)` in `calculations.ts` does NOT:
 *   - `Math.pow(negative, fractional)` → `NaN` (a real rate < -100% makes the
 *     factor negative; a fractional/own exponent then yields `NaN`).
 *   - overflow to `±Infinity` for an enormous exponent × factor.
 * Any non-finite result collapses to `fallback` (default 1 — a no-growth
 * factor, the neutral element for the multiply it feeds).
 */
export function safePowFactor(
  base: number,
  exponent: number,
  fallback = 1,
): number {
  if (!Number.isFinite(base) || !Number.isFinite(exponent)) return fallback;
  const result = Math.pow(base, exponent);
  return Number.isFinite(result) ? result : fallback;
}

// ---------------------------------------------------------------------------
// Structural input types (mirror apps/web/app/fire/lib/types.ts).
// ---------------------------------------------------------------------------

export interface FireAssetClass {
  allocation: number;
  expectedReturn: number;
}

export interface FireMonthlyExpense {
  amount: number;
  inflation: number;
}

export interface FireOneTimeExpense {
  id: string;
  currentCost: number;
  yearsAway: number;
  inflation: number;
}

export interface FireProjectionPoint {
  year: number;
  age: number;
  corpus: number;
  fireNumber: number;
  savings: number;
  expenses: number;
}

// ---------------------------------------------------------------------------
// Monthly expenses (the ONLY math the FIRE service previously inlined, in
// `withMonthlyExpenses`). Sum of each expense's amount; non-finite amounts
// contribute 0 rather than poisoning the total.
// ---------------------------------------------------------------------------

/**
 * Sum the monthly expense amounts. A `null` is returned when there are no
 * expenses (matching the service's historical `|| null` so the column stays
 * "unknown" rather than a misleading 0). Each addend is finite-guarded so a
 * corrupt stored `amount` (`NaN`/`Infinity`) can't make `monthlyExpenses` NaN.
 */
export function computeMonthlyExpenses(
  expenses: ReadonlyArray<{ amount?: number | null }> | null | undefined,
): number | null {
  if (!expenses || expenses.length === 0) return null;
  const total = expenses.reduce((sum, e) => sum + finite(e?.amount ?? 0), 0);
  // Preserve the service's prior `... || null`: an all-zero/empty sum is null.
  return total || null;
}

// ---------------------------------------------------------------------------
// Weighted return & average inflation (mirror calculations.ts, guarded).
// ---------------------------------------------------------------------------

/**
 * Allocation-weighted expected return (%). Mirrors `computeWeightedReturn`:
 * an empty list or zero total allocation defaults to 10. Each term is
 * finite-guarded so a corrupt allocation/return can't poison the weighted sum,
 * and the final result is guarded back to the 10 default if it still went
 * non-finite.
 */
export function computeWeightedReturn(
  assetClasses: ReadonlyArray<FireAssetClass>,
): number {
  const totalAllocation = assetClasses.reduce(
    (sum, ac) => sum + finite(ac.allocation),
    0,
  );
  if (totalAllocation === 0) return 10;
  const weighted = assetClasses.reduce(
    (sum, ac) =>
      sum +
      (finite(ac.allocation) / totalAllocation) * finite(ac.expectedReturn),
    0,
  );
  return finite(weighted, 10);
}

/**
 * Amount-weighted average inflation (%). Mirrors `computeAvgInflation`: an
 * empty list or zero total amount defaults to 6. Finite-guarded throughout.
 */
export function computeAvgInflation(
  expenses: ReadonlyArray<FireMonthlyExpense>,
): number {
  const totalAmount = expenses.reduce((sum, e) => sum + finite(e.amount), 0);
  if (totalAmount === 0) return 6;
  const weighted = expenses.reduce(
    (sum, e) => sum + (finite(e.inflation) * finite(e.amount)) / totalAmount,
    0,
  );
  return finite(weighted, 6);
}

// ---------------------------------------------------------------------------
// SIP future value & lump-sum compound growth.
// ---------------------------------------------------------------------------

/**
 * Future value of a recurring monthly SIP (end-of-period contributions),
 * compounded `years` times at `annualRatePercent` per year, contributing
 * `12 × monthlyInvestment` each year (the annual-step model the FIRE
 * projection uses — NOT monthly compounding).
 *
 * Closed form: `FV = PMT_annual × ((1+r)^n − 1) / r`, with the singularities
 * the raw formula in `calculations.ts` never handled:
 *   - `r = 0` → `(1+0)^n − 1 = 0`, `0/0` ⇒ NaN. Special-cased to `n × PMT`
 *     (zero-growth SIP is just the sum of contributions).
 *   - `r = -100%` (`1 + r = 0`) → divide-by-zero. `safePowFactor` makes the
 *     numerator finite and the explicit `r === 0` guard never divides by 0;
 *     for `r = -1` exactly the result reduces to `-PMT_annual` (one period of
 *     contributions instantly wiped), kept finite.
 *   - overflow / negative-base `Math.pow` ⇒ non-finite, collapsed by
 *     `safePowFactor` + a final `finite()`.
 * Non-finite `monthlyInvestment`/`years`/`rate` are neutralised up-front.
 */
export function computeSipFutureValue(
  monthlyInvestment: number,
  years: number,
  annualRatePercent: number,
): number {
  const pmtAnnual = finite(monthlyInvestment) * 12;
  const n = Math.max(0, Math.floor(finite(years)));
  if (n === 0) return 0;
  const r = finite(annualRatePercent) / 100;
  // Zero-growth: closed form is 0/0; the value is simply the contributions.
  if (r === 0) return finite(pmtAnnual * n);
  const factor = safePowFactor(1 + r, n);
  return finite((pmtAnnual * (factor - 1)) / r);
}

/**
 * Future value of a one-off lump sum compounded `years` times at
 * `annualRatePercent`. `present × (1+r)^n`, with `safePowFactor` guarding
 * overflow / negative-base `NaN` and `finite()` neutralising a corrupt input.
 */
export function computeLumpsumFutureValue(
  presentValue: number,
  years: number,
  annualRatePercent: number,
): number {
  const pv = finite(presentValue);
  const n = Math.max(0, Math.floor(finite(years)));
  const r = finite(annualRatePercent) / 100;
  return finite(pv * safePowFactor(1 + r, n));
}

/**
 * Inflation-adjusted future value of a cost. `cost × (1 + inflation%)^years`.
 * Mirrors `calculations.ts#calculateFutureValue`, but guarded so a non-finite
 * input or a `Math.pow` overflow can't propagate.
 */
export function computeInflationAdjusted(
  presentCost: number,
  years: number,
  inflationPercent: number,
): number {
  const cost = finite(presentCost);
  const n = finite(years);
  return finite(cost * safePowFactor(1 + finite(inflationPercent) / 100, n));
}

// ---------------------------------------------------------------------------
// One-time expenses contribution to the FIRE number.
// ---------------------------------------------------------------------------

/**
 * Present-value-at-retirement of one-time expenses that fall AT or AFTER
 * retirement. Mirrors `computeOneTimeExpensesForFire`:
 *   - `yearsAway === horizon` → inflate to its future value at retirement.
 *   - `yearsAway  >  horizon` → inflate to its own year, then discount back to
 *     retirement at the weighted return.
 *   - `yearsAway  <  horizon` (before retirement) → ignored here.
 * Every factor is `safePowFactor`-guarded; the discount denominator can't be
 * `Infinity` (which would silently zero the term) without being flagged.
 */
export function computeOneTimeExpensesForFire(
  oneTimeExpenses: ReadonlyArray<FireOneTimeExpense>,
  retirementAge: number,
  currentAge: number,
  weightedReturnPercent: number,
): number {
  const yearsFromNow = finite(retirementAge) - finite(currentAge);
  const wr = finite(weightedReturnPercent);
  let total = 0;

  for (const expense of oneTimeExpenses) {
    const yearsAway = finite(expense.yearsAway);
    const infl = finite(expense.inflation);
    const cost = finite(expense.currentCost);
    if (yearsAway < yearsFromNow) continue;

    if (yearsAway === yearsFromNow) {
      total += finite(cost * safePowFactor(1 + infl / 100, yearsFromNow));
    } else {
      const yearsAfterRetirement = yearsAway - yearsFromNow;
      const inflatedAtExpense = cost * safePowFactor(1 + infl / 100, yearsAway);
      const discount = safePowFactor(1 + wr / 100, yearsAfterRetirement);
      // discount is a (1+r)^k factor: guard a 0 denominator before dividing.
      const pvAtRetirement = discount !== 0 ? inflatedAtExpense / discount : 0;
      total += finite(pvAtRetirement);
    }
  }

  return finite(total);
}

// ---------------------------------------------------------------------------
// Target FIRE corpus (the FIRE number).
// ---------------------------------------------------------------------------

/**
 * The corpus required to retire: inflated annual expenses divided by the safe
 * withdrawal rate, plus any one-time-expense present value. Mirrors
 * `computeFireNumber`, with the divide-by-zero the raw formula never handled:
 *
 *   `baseFireNumber = annualExpenses / (withdrawalRate/100)`
 *
 * A `withdrawalRate` of 0 (validator enforces ≥1, but the math is otherwise
 * unguarded) divides by zero → `Infinity`. This guard returns
 * `oneTimeExpensesForFire` (the only still-meaningful term) instead of an
 * Infinity that would render "₹Infinity" / poison `yearsToFire`. All factors
 * are `safePowFactor`/`finite`-guarded.
 */
export function computeFireNumber(
  totalMonthlyExpenses: number,
  avgInflationPercent: number,
  withdrawalRatePercent: number,
  retirementAge: number,
  currentAge: number,
  oneTimeExpensesForFire: number,
): number {
  const yearsFromNow = finite(retirementAge) - finite(currentAge);
  const inflatedMonthly =
    finite(totalMonthlyExpenses) *
    safePowFactor(1 + finite(avgInflationPercent) / 100, yearsFromNow);
  const annualExpenses = inflatedMonthly * 12;
  const wr = finite(withdrawalRatePercent) / 100;
  const oneTime = finite(oneTimeExpensesForFire);
  // Guard the divide-by-zero (withdrawalRate 0). Negative wr (nonsensical but
  // finite) would yield a negative base number; finite() still keeps it sane.
  if (wr === 0) return oneTime;
  const baseFireNumber = annualExpenses / wr;
  return finite(baseFireNumber + oneTime);
}

// ---------------------------------------------------------------------------
// Years to FIRE (iterative, capped).
// ---------------------------------------------------------------------------

/** The sentinel `computeYearsToFire` returns when FIRE is never reached. */
export const YEARS_TO_FIRE_UNREACHABLE = 999;
/** Hard cap on the year-by-year accumulation loop (termination guarantee). */
export const YEARS_TO_FIRE_MAX = 100;

/**
 * Years until `corpus` reaches `fireNumber`, simulating year-by-year growth +
 * savings (pre-retirement) or growth − expenses (post-retirement). Mirrors
 * `computeYearsToFire`, hardened so it ALWAYS terminates and never returns a
 * non-finite value:
 *   - already at/above target → 0.
 *   - an unreachable target (corpus stalls/falls) → the loop is bounded by
 *     `YEARS_TO_FIRE_MAX` and returns `YEARS_TO_FIRE_UNREACHABLE`.
 *   - a non-finite `targetCorpus` (e.g. Infinity from a 0 withdrawal-rate
 *     fireNumber) would make `corpus < target` loop the full cap then return
 *     the sentinel — never NaN.
 *   - every compounding step is `finite()`-guarded so a `Math.pow`/expense
 *     blow-up can't make `corpus` NaN and silently break the `<` comparison
 *     (NaN `<` anything is false → it would otherwise exit at year 0 with a
 *     misleading "already FIRE").
 */
export function computeYearsToFire(
  currentCorpus: number,
  monthlySavings: number,
  fireNumber: number,
  weightedReturnPercent: number,
  savingsIncrementPercent: number,
  retirementAge: number,
  currentAge: number,
  totalMonthlyExpenses: number,
  avgInflationPercent: number,
  oneTimeExpenses: ReadonlyArray<FireOneTimeExpense>,
): number {
  const targetCorpus = finite(fireNumber, Number.POSITIVE_INFINITY);
  const wr = finite(weightedReturnPercent);
  const savingsIncrement = finite(savingsIncrementPercent);
  const retAge = finite(retirementAge);
  const curAge = finite(currentAge);
  const monthlyExp = finite(totalMonthlyExpenses);
  const avgInfl = finite(avgInflationPercent);

  let corpus = finite(currentCorpus);
  let years = 0;
  let currentMonthlySavings = finite(monthlySavings);
  const paidExpenses = new Set<string>();

  while (corpus < targetCorpus && years < YEARS_TO_FIRE_MAX) {
    const age = curAge + years;

    if (age < retAge) {
      corpus = finite(corpus * (1 + wr / 100) + currentMonthlySavings * 12);

      for (const expense of oneTimeExpenses) {
        if (
          finite(expense.yearsAway) === years &&
          !paidExpenses.has(expense.id)
        ) {
          const inflatedCost = finite(
            finite(expense.currentCost) *
              safePowFactor(
                1 + finite(expense.inflation) / 100,
                finite(expense.yearsAway),
              ),
          );
          corpus = finite(corpus - inflatedCost);
          paidExpenses.add(expense.id);
        }
      }

      if (age + 1 < retAge) {
        currentMonthlySavings = finite(
          currentMonthlySavings * (1 + savingsIncrement / 100),
        );
      }
    } else {
      const yearlyExpense = finite(
        monthlyExp * 12 * safePowFactor(1 + avgInfl / 100, years),
      );
      corpus = finite(corpus * (1 + wr / 100) - yearlyExpense);
    }

    years++;
  }

  return years >= YEARS_TO_FIRE_MAX ? YEARS_TO_FIRE_UNREACHABLE : years;
}

// ---------------------------------------------------------------------------
// Safe-withdrawal-rate helpers.
// ---------------------------------------------------------------------------

/**
 * Sustainable annual withdrawal from a corpus at a given withdrawal rate.
 * `corpus × withdrawalRate%`. Pure ratio, finite-guarded (no division → no
 * divide-by-zero here).
 */
export function computeAnnualSafeWithdrawal(
  corpus: number,
  withdrawalRatePercent: number,
): number {
  return finite(finite(corpus) * (finite(withdrawalRatePercent) / 100));
}

/**
 * How many years a corpus lasts when drawing a fixed `annualWithdrawal`, with
 * NO growth (the conservative floor). `corpus / annualWithdrawal`.
 *   - `annualWithdrawal <= 0` → divide-by-zero / non-positive draw: the corpus
 *     lasts "forever" → `Infinity` is meaningless to a UI, so return
 *     `Number.POSITIVE_INFINITY` explicitly and let callers render it as "∞"
 *     rather than letting a raw `x/0` NaN/Infinity leak unlabelled.
 *   - `corpus <= 0` → 0 years.
 * Always finite-or-explicit-Infinity, never NaN.
 */
export function computeYearsOfCorpus(
  corpus: number,
  annualWithdrawal: number,
): number {
  const c = finite(corpus);
  const w = finite(annualWithdrawal);
  if (c <= 0) return 0;
  if (w <= 0) return Number.POSITIVE_INFINITY;
  return finite(c / w, Number.POSITIVE_INFINITY);
}

// ---------------------------------------------------------------------------
// Year-by-year projection series.
// ---------------------------------------------------------------------------

/** Inputs for the full FIRE projection (mirrors the client.tsx call site). */
export interface FireProjectionInput {
  currentAge: number;
  retirementAge: number;
  currentCorpus: number;
  monthlySavings: number;
  totalMonthlyExpenses: number;
  avgInflation: number;
  withdrawalRate: number;
  weightedReturn: number;
  lifeExpectancy: number;
  yearsToFire: number;
  savingsIncrement: number;
  oneTimeExpenses: ReadonlyArray<FireOneTimeExpense>;
}

/**
 * The year-by-year corpus / fireNumber / savings / expenses series. Mirrors
 * `computeProjectionData`, hardened so EVERY emitted point is a finite, rounded
 * integer (never `NaN`/`Infinity` into a Recharts axis or a `.toLocaleString()`)
 * and the loop always terminates:
 *   - `maxYears = max(40, yearsToFire + 10)` with `yearsToFire` finite-guarded
 *     (an Infinity/NaN yearsToFire would otherwise make `maxYears` non-finite →
 *     an unbounded / `for (… <= NaN)` no-op loop). Also hard-capped so a huge
 *     finite `yearsToFire` can't emit an unbounded array.
 *   - the `year` field uses `new Date().getFullYear()` (always a finite int) —
 *     no Invalid-Date `.toISOString()` is ever called (that bug lives in the
 *     dashboard series, guarded there; this series never parses a date string).
 *   - every compounding step + the withdrawal-rate divide (`100 / withdrawalRate`
 *     → divide-by-zero at rate 0) is guarded; a 0 rate yields a 0 base FIRE
 *     target for the point rather than an Infinity bar.
 *   - corpus is floored at 0 each year (cannot go negative), matching source.
 */
export function computeProjectionSeries(
  input: FireProjectionInput,
): FireProjectionPoint[] {
  const currentAge = finite(input.currentAge);
  const retirementAge = finite(input.retirementAge);
  const totalMonthlyExpenses = finite(input.totalMonthlyExpenses);
  const avgInflation = finite(input.avgInflation);
  const withdrawalRate = finite(input.withdrawalRate);
  const weightedReturn = finite(input.weightedReturn);
  const lifeExpectancy = finite(input.lifeExpectancy);
  const savingsIncrement = finite(input.savingsIncrement);
  const oneTimeExpenses = input.oneTimeExpenses ?? [];

  const data: FireProjectionPoint[] = [];
  let corpus = finite(input.currentCorpus);
  let currentSavings = finite(input.monthlySavings);

  // Bound the loop. yearsToFire can be the 999 sentinel, Infinity, or NaN;
  // finite() + an absolute cap keep maxYears a sane finite integer so the loop
  // can never run away or no-op on a NaN comparison.
  const yearsToFire = finite(input.yearsToFire);
  const PROJECTION_HARD_CAP = 120; // a human life-span ceiling of rows
  const maxYears = Math.min(
    PROJECTION_HARD_CAP,
    Math.max(40, Math.floor(yearsToFire) + 10),
  );

  const baseYear = new Date().getFullYear();
  const paidExpenses = new Set<string>();

  for (let year = 0; year <= maxYears; year++) {
    const age = currentAge + year;
    const yearsFromNow = year;

    const annualExpensesAtThisAge =
      totalMonthlyExpenses *
      12 *
      safePowFactor(1 + avgInflation / 100, yearsFromNow);
    // 100 / withdrawalRate divides by zero at rate 0 → guard to a 0 multiplier.
    const wrMultiplier = withdrawalRate !== 0 ? 100 / withdrawalRate : 0;
    const baseFireNumAtThisAge = annualExpensesAtThisAge * wrMultiplier;

    let oneTimeExpensesAtThisAge = 0;
    for (const expense of oneTimeExpenses) {
      const yearsAway = finite(expense.yearsAway);
      const infl = finite(expense.inflation);
      const cost = finite(expense.currentCost);
      if (yearsAway >= yearsFromNow && !paidExpenses.has(expense.id)) {
        if (yearsAway === yearsFromNow) {
          oneTimeExpensesAtThisAge += finite(
            cost * safePowFactor(1 + infl / 100, yearsFromNow),
          );
        } else {
          const yearsAfterThisAge = yearsAway - yearsFromNow;
          const inflatedAtExpense =
            cost * safePowFactor(1 + infl / 100, yearsAway);
          const discount = safePowFactor(
            1 + weightedReturn / 100,
            yearsAfterThisAge,
          );
          oneTimeExpensesAtThisAge += finite(
            discount !== 0 ? inflatedAtExpense / discount : 0,
          );
        }
      }
    }

    const totalFireNumber = finite(
      baseFireNumAtThisAge + oneTimeExpensesAtThisAge,
    );

    data.push({
      year: baseYear + year,
      age,
      corpus: Math.round(finite(corpus)),
      fireNumber: Math.round(totalFireNumber),
      savings: Math.round(finite(currentSavings) * 12),
      expenses: Math.round(
        finite(
          totalMonthlyExpenses *
            12 *
            safePowFactor(1 + avgInflation / 100, year),
        ),
      ),
    });

    if (age < retirementAge) {
      corpus = finite(
        corpus * (1 + weightedReturn / 100) + currentSavings * 12,
      );

      for (const expense of oneTimeExpenses) {
        if (
          finite(expense.yearsAway) === year &&
          !paidExpenses.has(expense.id)
        ) {
          const inflatedCost = finite(
            finite(expense.currentCost) *
              safePowFactor(
                1 + finite(expense.inflation) / 100,
                finite(expense.yearsAway),
              ),
          );
          corpus = finite(corpus - inflatedCost);
          paidExpenses.add(expense.id);
        }
      }

      if (age + 1 < retirementAge) {
        currentSavings = finite(currentSavings * (1 + savingsIncrement / 100));
      }
    } else {
      const yearlyExpense = finite(
        totalMonthlyExpenses * 12 * safePowFactor(1 + avgInflation / 100, year),
      );
      corpus = finite(corpus * (1 + weightedReturn / 100) - yearlyExpense);
    }

    corpus = Math.max(0, finite(corpus));
    if (age >= lifeExpectancy) break;
  }

  return data;
}

// ---------------------------------------------------------------------------
// FIRE status badge.
// ---------------------------------------------------------------------------

export interface FireStatus {
  status: "on-track" | "close" | "off-track";
  message: string;
  color: string;
}

/**
 * On-track / close / off-track badge from years-to-FIRE vs the target horizon.
 * Mirrors `computeFireStatus`; ages/years finite-guarded so the rendered
 * "age N" / "N years behind" strings never contain "NaN".
 */
export function computeFireStatus(
  yearsToFire: number,
  retirementAge: number,
  currentAge: number,
): FireStatus {
  const y = finite(yearsToFire);
  const targetYears = finite(retirementAge) - finite(currentAge);
  if (y <= targetYears) {
    return {
      status: "on-track",
      message: `You can retire by age ${finite(currentAge) + y}!`,
      color: "text-emerald-500",
    };
  } else if (y < targetYears + 5) {
    return {
      status: "close",
      message: `You're ${y - targetYears} years behind target`,
      color: "text-yellow-500",
    };
  } else if (y >= YEARS_TO_FIRE_UNREACHABLE) {
    return {
      status: "off-track",
      message: "Increase savings to reach FIRE",
      color: "text-red-500",
    };
  } else {
    return {
      status: "off-track",
      message: `${y - targetYears} years behind target`,
      color: "text-red-500",
    };
  }
}

// ---------------------------------------------------------------------------
// Full projection (the function the LIVE service calls).
// ---------------------------------------------------------------------------

/** Aggregate result of a complete FIRE projection. */
export interface FireProjectionResult {
  monthlyExpenses: number;
  avgInflation: number;
  weightedReturn: number;
  fireNumber: number;
  yearsToFire: number;
  series: FireProjectionPoint[];
  status: FireStatus;
}

/** A scenario's raw projection inputs (mirror the persisted FireScenario). */
export interface FireScenarioProjectionInput {
  currentAge: number;
  retirementAge: number;
  lifeExpectancy: number;
  currentCorpus: number;
  monthlySavings: number;
  withdrawalRate: number;
  savingsIncrement: number;
  assetClasses: ReadonlyArray<FireAssetClass>;
  expenses: ReadonlyArray<FireMonthlyExpense>;
  oneTimeExpenses: ReadonlyArray<FireOneTimeExpense>;
}

/**
 * Run the COMPLETE guarded FIRE projection for a scenario — the single entry
 * point the service exposes so the live server-side path executes this module's
 * guarded math (not a dead export). Derives weightedReturn / avgInflation /
 * monthlyExpenses from the scenario, then the fireNumber, yearsToFire, the
 * year-by-year series, and the status badge. Every output is finite by
 * construction (each helper guards its own surface).
 */
export function computeFireProjection(
  input: FireScenarioProjectionInput,
): FireProjectionResult {
  const weightedReturn = computeWeightedReturn(input.assetClasses);
  const avgInflation = computeAvgInflation(input.expenses);
  const monthlyExpenses = computeMonthlyExpenses(input.expenses) ?? 0;

  const oneTimeForFire = computeOneTimeExpensesForFire(
    input.oneTimeExpenses,
    input.retirementAge,
    input.currentAge,
    weightedReturn,
  );

  const fireNumber = computeFireNumber(
    monthlyExpenses,
    avgInflation,
    input.withdrawalRate,
    input.retirementAge,
    input.currentAge,
    oneTimeForFire,
  );

  const yearsToFire = computeYearsToFire(
    input.currentCorpus,
    input.monthlySavings,
    fireNumber,
    weightedReturn,
    input.savingsIncrement,
    input.retirementAge,
    input.currentAge,
    monthlyExpenses,
    avgInflation,
    input.oneTimeExpenses,
  );

  const series = computeProjectionSeries({
    currentAge: input.currentAge,
    retirementAge: input.retirementAge,
    currentCorpus: input.currentCorpus,
    monthlySavings: input.monthlySavings,
    totalMonthlyExpenses: monthlyExpenses,
    avgInflation,
    withdrawalRate: input.withdrawalRate,
    weightedReturn,
    lifeExpectancy: input.lifeExpectancy,
    yearsToFire,
    savingsIncrement: input.savingsIncrement,
    oneTimeExpenses: input.oneTimeExpenses,
  });

  const status = computeFireStatus(
    yearsToFire,
    input.retirementAge,
    input.currentAge,
  );

  return {
    monthlyExpenses,
    avgInflation,
    weightedReturn,
    fireNumber,
    yearsToFire,
    series,
    status,
  };
}
