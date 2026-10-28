import type { FireSnapshot } from "./systemPrompt";
import type { ServerFirePlan } from "./serverActions";
import {
  computeWeightedReturn,
  computeAvgInflation,
  computeOneTimeExpensesForFire,
  computeFireNumber,
  computeSwrFireNumber,
  computeYearsToFire,
  computeProjectionData,
  computeSustainableMonthly,
} from "./calculations";

/* =====================================================================
   FIRE chat — SERVER-side snapshot builder  (StockSage integration)
   ---------------------------------------------------------------------
   The server twin of bridge.ts's `buildFireSnapshot`. On /fire the page
   has already computed the outcome numbers (fireNumber, yearsToFire,
   firstShortfallAge …) in client.tsx and bridge.ts just reads them off
   `FireLive`. Off /fire there is no live render, so this recomputes them
   from raw plan values — deliberately calling the SAME pure functions in
   `../calculations.ts`, in the SAME argument order as client.tsx's derived
   memos, so the model goal-seeks against the EXACT numbers the /fire page
   would show. That parity is the whole point: the withdrawal cap, tax
   rate, and `firstShortfallAge` (the sustainability verdict) all live in
   calculations.ts, and fire-logic.ts (the older service mirror) lacks
   them — so we reuse calculations.ts, not the service math.

   The output shape mirrors buildFireSnapshot's exactly (same rounding,
   same `yearsToFire >= 999 → null` sentinel) so both paths feed the model
   an identical FireSnapshot.
   ===================================================================== */

/**
 * The derived outcome numbers of a plan (MONEY-1079).
 *
 * Extracted so the SNAPSHOT (what the model reasons over) and the PERSISTED
 * ROW (`fireNumber` / `yearsToFire` / `avgInflation` / `weightedReturn`, the
 * denormalized headline fields `serverPlanToScenarioInput` writes) are computed
 * ONCE, from the same functions in the same order. Duplicating this chain would
 * let the two silently disagree — the /fire page and the mobile API would then
 * show different headline numbers for an identical plan.
 */
export interface FirePlanOutcomes {
  monthlyExpToday: number;
  avgInflation: number;
  weightedReturn: number;
  oneTimeForFire: number;
  fireNumber: number;
  swrFireNumber: number;
  /** Raw value — 999 is the "never reaches FIRE" sentinel, NOT a real year. */
  yearsToFire: number;
  projection: ReturnType<typeof computeProjectionData>;
}

export function computeFirePlanOutcomes(
  plan: ServerFirePlan,
): FirePlanOutcomes {
  const {
    currentAge,
    retirementAge,
    lifeExpectancy,
    currentCorpus,
    monthlySavings,
    withdrawalRate,
    taxRate,
    savingsIncrement,
    assetClasses,
    monthlyExpenses,
    oneTimeExpenses,
  } = plan;

  // ── derived intermediates (mirror client.tsx's useMemo chain) ────────
  const monthlyExpToday = monthlyExpenses.reduce((s, e) => s + e.amount, 0);
  const avgInflation = computeAvgInflation(monthlyExpenses);
  const weightedReturn = computeWeightedReturn(assetClasses);
  const oneTimeForFire = computeOneTimeExpensesForFire(
    oneTimeExpenses,
    retirementAge,
    currentAge,
    weightedReturn,
    taxRate,
  );
  const fireNumber = computeFireNumber(
    monthlyExpToday,
    avgInflation,
    weightedReturn,
    taxRate,
    retirementAge,
    currentAge,
    lifeExpectancy,
    oneTimeForFire,
  );
  const swrFireNumber = computeSwrFireNumber(
    monthlyExpToday,
    avgInflation,
    withdrawalRate,
    retirementAge,
    currentAge,
    oneTimeForFire,
  );
  const yearsToFire = computeYearsToFire(
    currentCorpus,
    monthlySavings,
    fireNumber,
    weightedReturn,
    savingsIncrement,
    retirementAge,
    currentAge,
    monthlyExpToday,
    avgInflation,
    taxRate,
    withdrawalRate,
    oneTimeExpenses,
  );
  const projection = computeProjectionData(
    currentAge,
    retirementAge,
    currentCorpus,
    monthlySavings,
    monthlyExpToday,
    avgInflation,
    weightedReturn,
    taxRate,
    withdrawalRate,
    lifeExpectancy,
    yearsToFire,
    savingsIncrement,
    oneTimeExpenses,
  );

  return {
    monthlyExpToday,
    avgInflation,
    weightedReturn,
    oneTimeForFire,
    fireNumber,
    swrFireNumber,
    yearsToFire,
    projection,
  };
}

export function buildFireSnapshotFromPlan(
  plan: ServerFirePlan,
  savedScenarioNames: string[] = [],
): FireSnapshot {
  const {
    currentAge,
    retirementAge,
    lifeExpectancy,
    currentCorpus,
    monthlySavings,
    withdrawalRate,
    taxRate,
    salaryIncrement,
    savingsIncrement,
    assetClasses,
    monthlyExpenses,
    oneTimeExpenses,
  } = plan;

  const {
    avgInflation,
    weightedReturn,
    fireNumber,
    swrFireNumber,
    yearsToFire,
    projection,
  } = computeFirePlanOutcomes(plan);

  // ── outcomes read off the projection (mirror client.tsx) ─────────────
  const atRetire = projection.find((p) => p.age === retirementAge);
  const corpusAtRetire = atRetire?.corpus ?? 0;
  const fireNumAtRetire = atRetire?.fireNumber ?? fireNumber;
  const fireAchieved = corpusAtRetire >= fireNumAtRetire;
  const surplus = corpusAtRetire - fireNumAtRetire;
  const firstShortfallAge =
    projection.find((p) => (p.shortfall ?? 0) > 0)?.age ?? null;
  const sustainableMonthly = computeSustainableMonthly(
    corpusAtRetire,
    avgInflation,
    weightedReturn,
    taxRate,
    retirementAge,
    lifeExpectancy,
  );

  return {
    parameters: {
      currentAge,
      retirementAge,
      lifeExpectancy,
      currentCorpus,
      monthlySavings,
      safeWithdrawalRate: withdrawalRate,
      taxRate,
      salaryIncrement,
      savingsIncrement,
    },
    assetClasses: assetClasses.map((a) => ({
      name: a.name,
      allocation: a.allocation,
      expectedReturn: a.expectedReturn,
    })),
    expenses: monthlyExpenses.map((e) => ({
      category: e.category,
      amount: e.amount,
      inflation: e.inflation,
    })),
    oneTimeGoals: oneTimeExpenses.map((o) => ({
      name: o.name,
      currentCost: o.currentCost,
      yearsAway: o.yearsAway,
      inflation: o.inflation,
    })),
    savedScenarios: savedScenarioNames.map((name) => ({ name })),
    computed: {
      fireNumber: Math.round(fireNumber),
      yearsToFire: yearsToFire >= 999 ? null : yearsToFire,
      corpusAtRetirement: Math.round(corpusAtRetire),
      fireAchievedAtRetirement: fireAchieved,
      surplusAtRetirement: Math.round(surplus),
      sustainableMonthlySpend: Math.round(sustainableMonthly),
      swrComparisonFireNumber: Math.round(swrFireNumber),
      firstShortfallAge,
    },
  };
}
