/**
 * FIRE service + projection math — REAL exports, no shadows (MONEY-620).
 *
 * DE-SHADOWED: this file previously declared its OWN `calculateMonthlyExpenses`
 * / `calculateWeightedReturn` / `calculateAvgInflation` / `validateAllocations`
 * / `getCacheInvalidationKeys` / `findDemoScenario` + a copy of `demoScenarios`
 * under "mirrors fire.ts" comments and asserted the COPIES — a textbook shadow
 * (the copies were even mathematically DIFFERENT from the live code:
 * `calculateAvgInflation([])` returned 0 while the live `computeAvgInflation([])`
 * returns 6, and `calculateWeightedReturn` used `allocation/100` instead of the
 * allocation-share normalisation). It imported nothing from source, so it stayed
 * green no matter what the real FIRE code did.
 *
 * It now:
 *   1. Imports the REAL guarded projection math from the service-layer source of
 *      truth `packages/services/src/fire-logic.ts` (the module
 *      `fire.service.ts` CALLS) and asserts THOSE — including an exhaustive
 *      non-finite / overflow / divide-by-zero bug-hunt (FIRE compounding is the
 *      high-yield surface for those).
 *   2. Drives the LIVE `@usemoney/services` FIRE functions through the
 *      require.cache recording-prisma seam (the established pattern from
 *      `services-data-e2e.test.ts` / `webhooks-dodo-e2e.test.ts`): proves
 *      `getFireScenarios`'s `withMonthlyExpenses` delegates to the guarded
 *      `computeMonthlyExpenses` (a NaN stored amount no longer poisons it) and
 *      that `computeFireScenarioProjection` runs the guarded projection.
 *   3. Pins the FIRE Zod schema (`FireParametersSchema`) — the validator that is
 *      load-bearing for the rate/age bounds the math itself does not enforce.
 *
 * Source: packages/services/src/fire-logic.ts + packages/services/src/fire.service.ts
 * Runs under `node --import tsx --test` (CJS) — CWD must be `apps/web`.
 */

import { describe, it, before, beforeEach, after } from "node:test";
import assert from "node:assert/strict";

import {
  finite,
  safePowFactor,
  computeMonthlyExpenses,
  computeWeightedReturn,
  computeAvgInflation,
  computeSipFutureValue,
  computeLumpsumFutureValue,
  computeInflationAdjusted,
  computeOneTimeExpensesForFire,
  computeFireNumber,
  computeYearsToFire,
  computeAnnualSafeWithdrawal,
  computeYearsOfCorpus,
  computeProjectionSeries,
  computeFireStatus,
  computeFireProjection,
  YEARS_TO_FIRE_UNREACHABLE,
  YEARS_TO_FIRE_MAX,
} from "../../../../packages/services/src/fire-logic";
import type {
  FireAssetClass,
  FireMonthlyExpense,
  FireOneTimeExpense,
  FireScenarioProjectionInput,
  FireProjectionInput,
} from "../../../../packages/services/src/fire-logic";
import { FireParametersSchema } from "@usemoney/validation";

const NO_ONE_TIME: FireOneTimeExpense[] = [];

// Every non-finite value the production inputs can carry.
const NON_FINITE = [NaN, Infinity, -Infinity] as const;

// ════════════════════════════════════════════════════════════════════════════
// PART 1 — pure guarded math (REAL exports from fire-logic.ts)
// ════════════════════════════════════════════════════════════════════════════

// ── finite() / safePowFactor() ──────────────────────────────────────────────

describe("finite() guard", () => {
  it("passes through finite numbers (incl. 0 and negatives)", () => {
    assert.equal(finite(0), 0);
    assert.equal(finite(-42.5), -42.5);
    assert.equal(finite(1e12), 1e12);
  });
  it("collapses NaN/±Infinity/null/undefined to the fallback (default 0)", () => {
    for (const v of NON_FINITE) assert.equal(finite(v), 0);
    assert.equal(finite(null), 0);
    assert.equal(finite(undefined), 0);
    assert.equal(finite(NaN, 7), 7);
    assert.equal(finite(Infinity, -1), -1);
  });
});

describe("safePowFactor()", () => {
  it("matches Math.pow for ordinary finite factors", () => {
    assert.equal(safePowFactor(1.1, 10), Math.pow(1.1, 10));
    assert.equal(safePowFactor(1, 50), 1);
  });
  it("BUG-GUARD: Math.pow(negative, fractional) → NaN is neutralised to fallback (1)", () => {
    // 1 + rate = 1 + (-2) = -1; a non-integer exponent → NaN in raw Math.pow.
    assert.ok(Number.isNaN(Math.pow(-1.5, 2.5)));
    assert.equal(safePowFactor(-1.5, 2.5), 1);
    assert.equal(safePowFactor(-1.5, 2.5, 0), 0);
  });
  it("BUG-GUARD: overflow to Infinity is neutralised to fallback", () => {
    assert.equal(Math.pow(10, 400), Infinity);
    assert.equal(safePowFactor(10, 400), 1);
  });
  it("BUG-GUARD: non-finite base or exponent → fallback (never NaN)", () => {
    assert.equal(safePowFactor(NaN, 5), 1);
    assert.equal(safePowFactor(1.1, Infinity), 1);
  });
});

// ── computeMonthlyExpenses (the de-shadowed service math) ────────────────────

describe("computeMonthlyExpenses — REAL (service's withMonthlyExpenses delegate)", () => {
  it("sums amounts; matches the old inline reduce for finite inputs", () => {
    assert.equal(
      computeMonthlyExpenses([
        { amount: 25000 },
        { amount: 15000 },
        { amount: 5000 },
      ]),
      45000
    );
  });
  it("empty / null / undefined → null (column stays 'unknown', not 0)", () => {
    assert.equal(computeMonthlyExpenses([]), null);
    assert.equal(computeMonthlyExpenses(null), null);
    assert.equal(computeMonthlyExpenses(undefined), null);
  });
  it("all-zero amounts → null (preserves the prior `|| null`)", () => {
    assert.equal(computeMonthlyExpenses([{ amount: 0 }, { amount: 0 }]), null);
  });
  it("BUG-GUARD: a NaN/Infinity stored amount contributes 0, never poisons the sum", () => {
    assert.equal(
      computeMonthlyExpenses([{ amount: 10000 }, { amount: NaN }]),
      10000
    );
    assert.equal(
      computeMonthlyExpenses([{ amount: Infinity }, { amount: 5000 }]),
      5000
    );
    // null amount also coerces to 0 (no throw).
    assert.equal(
      computeMonthlyExpenses([{ amount: null }, { amount: 3000 }]),
      3000
    );
  });
});

// ── computeWeightedReturn ────────────────────────────────────────────────────

describe("computeWeightedReturn — REAL", () => {
  const mk = (allocation: number, expectedReturn: number): FireAssetClass => ({
    allocation,
    expectedReturn,
  });
  it("empty → 10% default; all-zero allocation → 10% default", () => {
    assert.equal(computeWeightedReturn([]), 10);
    assert.equal(computeWeightedReturn([mk(0, 12), mk(0, 7)]), 10);
  });
  it("normalises by allocation share (50/50 of 12 & 6 = 9)", () => {
    assert.equal(computeWeightedReturn([mk(50, 12), mk(50, 6)]), 9);
  });
  it("allocations not summing to 100 are normalised to their own total", () => {
    // 30/40*10 + 10/40*20 = 7.5 + 5 = 12.5
    assert.equal(computeWeightedReturn([mk(30, 10), mk(10, 20)]), 12.5);
  });
  it("negative expectedReturn (validator allows -20..50) flows through", () => {
    assert.equal(computeWeightedReturn([mk(100, -20)]), -20);
  });
  it("BUG-GUARD: a NaN allocation/return can't poison the weighted sum", () => {
    const r = computeWeightedReturn([mk(NaN, 12), mk(50, 8)]);
    assert.ok(Number.isFinite(r), `weighted return must be finite, got ${r}`);
    // NaN allocation → 0 contribution; only the 50/8 asset remains (50/50 ⇒ 8).
    assert.equal(r, 8);
  });
});

// ── computeAvgInflation ──────────────────────────────────────────────────────

describe("computeAvgInflation — REAL", () => {
  const mk = (amount: number, inflation: number): FireMonthlyExpense => ({
    amount,
    inflation,
  });
  it("empty → 6% default; all-zero amount → 6% default (NOT 0 — the old shadow was wrong)", () => {
    assert.equal(computeAvgInflation([]), 6);
    assert.equal(computeAvgInflation([mk(0, 5), mk(0, 8)]), 6);
  });
  it("amount-weighted average", () => {
    // (5*30000 + 9*10000)/40000 = 240000/40000 = 6
    assert.equal(computeAvgInflation([mk(30000, 5), mk(10000, 9)]), 6);
  });
  it("BUG-GUARD: a NaN amount/inflation stays finite", () => {
    const r = computeAvgInflation([mk(NaN, 5), mk(10000, 8)]);
    assert.ok(Number.isFinite(r));
    assert.equal(r, 8); // NaN-amount row drops out
  });
});

// ── computeSipFutureValue (SIP closed-form, the singularity minefield) ───────

describe("computeSipFutureValue — REAL", () => {
  it("canonical: ₹0 (n=0 years) → 0", () => {
    assert.equal(computeSipFutureValue(10000, 0, 12), 0);
  });
  it("BUG-GUARD: 0% rate is the 0/0 case → special-cased to n × annual PMT", () => {
    // raw (pow-1)/r = (1-1)/0 = 0/0 = NaN; must be 12mo*10y*10000 = 1,200,000.
    const v = computeSipFutureValue(10000, 10, 0);
    assert.ok(Number.isFinite(v));
    assert.equal(v, 1_200_000);
  });
  it("positive growth accumulates above the sum of contributions", () => {
    // 12% annual-step: FV = 120000 * ((1.12^10 - 1)/0.12) ≈ 2,106,... > invested.
    const v = computeSipFutureValue(10000, 10, 12);
    assert.ok(Number.isFinite(v));
    assert.ok(v > 1_200_000, `expected > invested, got ${v}`);
    // Spot-check against the closed form.
    const expected = (120000 * (Math.pow(1.12, 10) - 1)) / 0.12;
    assert.ok(Math.abs(v - expected) < 1e-6);
  });
  it("BUG-GUARD: rate = -100% (1+r=0) divide-by-zero stays finite", () => {
    // r = -1 → factor (1+r)^n = 0; (0-1)/-1 = 1 → FV = annual PMT * 1.
    const v = computeSipFutureValue(10000, 10, -100);
    assert.ok(Number.isFinite(v), `rate=-100% must stay finite, got ${v}`);
    assert.equal(v, 120000);
  });
  it("BUG-GUARD: rate < -100% (negative base) never yields NaN", () => {
    const v = computeSipFutureValue(10000, 7, -250);
    assert.ok(Number.isFinite(v), `rate<-100% must stay finite, got ${v}`);
  });
  it("BUG-GUARD: non-finite monthlyInvestment / years / rate → finite (never NaN/Infinity)", () => {
    for (const bad of NON_FINITE) {
      assert.ok(Number.isFinite(computeSipFutureValue(bad, 10, 12)));
      assert.ok(Number.isFinite(computeSipFutureValue(10000, bad, 12)));
      assert.ok(Number.isFinite(computeSipFutureValue(10000, 10, bad)));
    }
  });
  it("BUG-GUARD: enormous years/rate that overflow Math.pow stay finite", () => {
    const v = computeSipFutureValue(10000, 5000, 99);
    assert.ok(Number.isFinite(v), `overflow must be neutralised, got ${v}`);
  });
  it("negative years floor to 0 (no accidental fractional/negative exponent)", () => {
    assert.equal(computeSipFutureValue(10000, -5, 12), 0);
  });
});

// ── computeLumpsumFutureValue ────────────────────────────────────────────────

describe("computeLumpsumFutureValue — REAL", () => {
  it("present × (1+r)^n for finite inputs", () => {
    assert.ok(
      Math.abs(
        computeLumpsumFutureValue(100000, 10, 12) - 100000 * Math.pow(1.12, 10)
      ) < 1e-6
    );
  });
  it("0 years → unchanged present value", () => {
    assert.equal(computeLumpsumFutureValue(100000, 0, 12), 100000);
  });
  it("BUG-GUARD: non-finite inputs and Math.pow overflow stay finite", () => {
    for (const bad of NON_FINITE) {
      assert.ok(Number.isFinite(computeLumpsumFutureValue(bad, 10, 12)));
      assert.ok(Number.isFinite(computeLumpsumFutureValue(100000, bad, 12)));
      assert.ok(Number.isFinite(computeLumpsumFutureValue(100000, 10, bad)));
    }
    assert.ok(Number.isFinite(computeLumpsumFutureValue(100000, 5000, 99)));
  });
  it("BUG-GUARD: negative real rate (negative base, fractional-safe) stays finite", () => {
    assert.ok(Number.isFinite(computeLumpsumFutureValue(100000, 10, -250)));
  });
});

// ── computeInflationAdjusted ─────────────────────────────────────────────────

describe("computeInflationAdjusted — REAL", () => {
  it("cost × (1+infl)^years", () => {
    assert.ok(
      Math.abs(
        computeInflationAdjusted(1000, 5, 6) - 1000 * Math.pow(1.06, 5)
      ) < 1e-9
    );
  });
  it("BUG-GUARD: non-finite + overflow stay finite", () => {
    for (const bad of NON_FINITE) {
      assert.ok(Number.isFinite(computeInflationAdjusted(bad, 5, 6)));
      assert.ok(Number.isFinite(computeInflationAdjusted(1000, bad, 6)));
      assert.ok(Number.isFinite(computeInflationAdjusted(1000, 5, bad)));
    }
    assert.ok(Number.isFinite(computeInflationAdjusted(1000, 9999, 30)));
  });
});

// ── computeOneTimeExpensesForFire ────────────────────────────────────────────

describe("computeOneTimeExpensesForFire — REAL", () => {
  const mk = (
    currentCost: number,
    yearsAway: number,
    inflation: number,
    id = "x"
  ): FireOneTimeExpense => ({ id, currentCost, yearsAway, inflation });

  it("expense BEFORE retirement (yearsAway < horizon) is ignored", () => {
    assert.equal(
      computeOneTimeExpensesForFire([mk(1_000_000, 2, 6)], 60, 30, 10),
      0
    );
  });
  it("expense AT retirement is inflated to future value", () => {
    assert.equal(
      computeOneTimeExpensesForFire([mk(100_000, 30, 0)], 60, 30, 10),
      100_000
    );
  });
  it("expense AFTER retirement is discounted back to retirement PV", () => {
    const v = computeOneTimeExpensesForFire([mk(1_000_000, 40, 0)], 60, 30, 10);
    assert.ok(v > 380_000 && v < 390_000, `expected ~385k, got ${v}`);
  });
  it("empty list → 0", () => {
    assert.equal(computeOneTimeExpensesForFire([], 60, 30, 10), 0);
  });
  it("BUG-GUARD: non-finite cost/yearsAway/inflation/return stay finite", () => {
    assert.ok(
      Number.isFinite(
        computeOneTimeExpensesForFire([mk(NaN, 40, 5)], 60, 30, 10)
      )
    );
    assert.ok(
      Number.isFinite(
        computeOneTimeExpensesForFire([mk(1_000_000, 40, Infinity)], 60, 30, 10)
      )
    );
    assert.ok(
      Number.isFinite(
        computeOneTimeExpensesForFire([mk(1_000_000, 40, 5)], 60, 30, NaN)
      )
    );
  });
});

// ── computeFireNumber ────────────────────────────────────────────────────────

describe("computeFireNumber — REAL", () => {
  it("standard 4% rule: ₹50k/mo, 0 inflation, retire now → 25× annual = 15,000,000", () => {
    assert.equal(computeFireNumber(50000, 0, 4, 30, 30, 0), 15_000_000);
  });
  it("one-time expenses add on top of the base", () => {
    const base = computeFireNumber(50000, 0, 4, 30, 30, 0);
    assert.equal(
      computeFireNumber(50000, 0, 4, 30, 30, 2_000_000) - base,
      2_000_000
    );
  });
  it("zero monthly expenses → only one-times remain", () => {
    assert.equal(computeFireNumber(0, 6, 4, 60, 30, 0), 0);
    assert.equal(computeFireNumber(0, 6, 4, 60, 30, 500_000), 500_000);
  });
  it("BUG-FIX: 0% withdrawal rate NO LONGER divides by zero to Infinity (returns one-time PV)", () => {
    // The old client math returned Infinity here (validator min(1) was the only
    // guard). The guarded service math returns the still-meaningful one-time term.
    const v = computeFireNumber(50000, 6, 0, 60, 30, 0);
    assert.ok(
      Number.isFinite(v),
      `0%% withdrawalRate must NOT be Infinity, got ${v}`
    );
    assert.equal(v, 0);
    assert.equal(computeFireNumber(50000, 6, 0, 60, 30, 750_000), 750_000);
  });
  it("retirement age <= current age → negative horizon SHRINKS the number (finite, no throw)", () => {
    const n = computeFireNumber(50000, 6, 4, 25, 30, 0);
    assert.ok(
      Number.isFinite(n) && n > 0,
      `expected finite positive, got ${n}`
    );
    assert.ok(n < computeFireNumber(50000, 6, 4, 30, 30, 0));
  });
  it("BUG-GUARD: non-finite expenses/inflation/ages stay finite", () => {
    assert.ok(Number.isFinite(computeFireNumber(NaN, 6, 4, 60, 30, 0)));
    assert.ok(
      Number.isFinite(computeFireNumber(50000, Infinity, 4, 60, 30, 0))
    );
    assert.ok(Number.isFinite(computeFireNumber(50000, 6, 4, NaN, 30, 0)));
    assert.ok(
      Number.isFinite(computeFireNumber(50000, 6, 4, 60, 30, Infinity))
    );
  });
});

// ── computeYearsToFire (iterative — must ALWAYS terminate, never NaN) ─────────

describe("computeYearsToFire — REAL", () => {
  it("already at/above target → 0", () => {
    assert.equal(
      computeYearsToFire(
        10_000_000,
        50_000,
        5_000_000,
        10,
        5,
        60,
        30,
        50_000,
        6,
        NO_ONE_TIME
      ),
      0
    );
  });
  it("never reaches FIRE (0 savings, 0 return) → unreachable sentinel", () => {
    assert.equal(
      computeYearsToFire(
        100_000,
        0,
        5_000_000,
        0,
        0,
        60,
        30,
        50_000,
        6,
        NO_ONE_TIME
      ),
      YEARS_TO_FIRE_UNREACHABLE
    );
  });
  it("negative corpus that never recovers → sentinel (no infinite loop)", () => {
    assert.equal(
      computeYearsToFire(
        -1_000_000,
        0,
        5_000_000,
        0,
        0,
        60,
        30,
        50_000,
        6,
        NO_ONE_TIME
      ),
      YEARS_TO_FIRE_UNREACHABLE
    );
  });
  it("0% return but positive savings terminates < sentinel", () => {
    const y = computeYearsToFire(
      0,
      100_000,
      500_000,
      0,
      0,
      60,
      30,
      50_000,
      6,
      NO_ONE_TIME
    );
    assert.ok(y >= 1 && y < YEARS_TO_FIRE_UNREACHABLE, `got ${y}`);
  });
  it("result never exceeds the 100-year cap (returns sentinel, not 100+)", () => {
    const y = computeYearsToFire(
      1,
      1,
      1e15,
      1,
      0,
      90,
      18,
      50_000,
      6,
      NO_ONE_TIME
    );
    assert.ok(
      y === YEARS_TO_FIRE_UNREACHABLE || y <= YEARS_TO_FIRE_MAX,
      `got ${y}`
    );
  });
  it("BUG-GUARD: an Infinity target (e.g. from a 0-rate fireNumber) → sentinel, never NaN/loops forever", () => {
    const y = computeYearsToFire(
      100_000,
      50_000,
      Number.POSITIVE_INFINITY,
      10,
      5,
      60,
      30,
      50_000,
      6,
      NO_ONE_TIME
    );
    assert.ok(Number.isFinite(y));
    assert.equal(y, YEARS_TO_FIRE_UNREACHABLE);
  });
  it("BUG-GUARD: a NaN return/corpus can't make corpus NaN and exit at year 0 falsely", () => {
    // If corpus went NaN, `corpus < target` is false → the OLD code would return 0
    // (a bogus "already FIRE!"). Guarded: NaN return ⇒ 0 growth, terminates honestly.
    const y = computeYearsToFire(
      100_000,
      50_000,
      5_000_000,
      NaN,
      5,
      60,
      30,
      50_000,
      6,
      NO_ONE_TIME
    );
    assert.ok(Number.isFinite(y));
    assert.ok(
      y > 0,
      `must not falsely report 0 years on a NaN return, got ${y}`
    );
  });
  it("BUG-GUARD: a NaN corpus input does not short-circuit to a false 0", () => {
    const y = computeYearsToFire(
      NaN,
      50_000,
      5_000_000,
      10,
      5,
      60,
      30,
      50_000,
      6,
      NO_ONE_TIME
    );
    assert.ok(Number.isFinite(y));
    assert.ok(y > 0, `NaN corpus must not report 'already FIRE', got ${y}`);
  });
});

// ── safe-withdrawal-rate helpers ─────────────────────────────────────────────

describe("computeAnnualSafeWithdrawal — REAL", () => {
  it("corpus × rate%", () => {
    assert.equal(computeAnnualSafeWithdrawal(10_000_000, 4), 400_000);
  });
  it("BUG-GUARD: non-finite corpus/rate → finite (never NaN)", () => {
    assert.equal(computeAnnualSafeWithdrawal(NaN, 4), 0);
    assert.equal(computeAnnualSafeWithdrawal(10_000_000, Infinity), 0);
  });
});

describe("computeYearsOfCorpus — REAL", () => {
  it("corpus / annual draw", () => {
    assert.equal(computeYearsOfCorpus(1_000_000, 100_000), 10);
  });
  it("BUG-GUARD: 0 / negative withdrawal → explicit +Infinity (renderable '∞'), never raw NaN", () => {
    assert.equal(computeYearsOfCorpus(1_000_000, 0), Number.POSITIVE_INFINITY);
    assert.equal(computeYearsOfCorpus(1_000_000, -5), Number.POSITIVE_INFINITY);
  });
  it("corpus <= 0 → 0 years", () => {
    assert.equal(computeYearsOfCorpus(0, 100_000), 0);
    assert.equal(computeYearsOfCorpus(-100, 100_000), 0);
  });
  it("BUG-GUARD: non-finite corpus → 0/Infinity, never NaN", () => {
    assert.equal(computeYearsOfCorpus(NaN, 100_000), 0);
    assert.ok(Number.isFinite(computeYearsOfCorpus(1_000_000, 100_000)));
  });
});

// ── computeProjectionSeries (every point finite, loop bounded) ────────────────

function projInput(
  over: Partial<FireProjectionInput> = {}
): FireProjectionInput {
  return {
    currentAge: 30,
    retirementAge: 60,
    currentCorpus: 1_000_000,
    monthlySavings: 50_000,
    totalMonthlyExpenses: 50_000,
    avgInflation: 6,
    withdrawalRate: 4,
    weightedReturn: 12,
    lifeExpectancy: 60,
    yearsToFire: 10,
    savingsIncrement: 5,
    oneTimeExpenses: [],
    ...over,
  };
}

describe("computeProjectionSeries — REAL", () => {
  it("0-year horizon (currentAge === lifeExpectancy) → exactly 1 row then breaks", () => {
    const data = computeProjectionSeries(
      projInput({
        currentAge: 60,
        retirementAge: 60,
        lifeExpectancy: 60,
        monthlySavings: 0,
        yearsToFire: 0,
      })
    );
    assert.equal(data.length, 1);
    assert.equal(data[0]!.age, 60);
  });
  it("corpus is floored at 0 each year (never negative)", () => {
    const data = computeProjectionSeries(
      projInput({
        currentAge: 64,
        retirementAge: 90,
        currentCorpus: 10_000,
        monthlySavings: 0,
        totalMonthlyExpenses: 500_000,
        weightedReturn: 8,
        lifeExpectancy: 90,
        yearsToFire: 0,
      })
    );
    for (const row of data)
      assert.ok(row.corpus >= 0, `negative corpus ${row.corpus} @ ${row.age}`);
  });
  it("loop bounded by max(40, yearsToFire+10) and the lifeExpectancy break", () => {
    // lifeExpectancy 200 (above schema max) must NOT run away: maxYears=40 → 41 rows.
    const data = computeProjectionSeries(
      projInput({ retirementAge: 200, lifeExpectancy: 200, yearsToFire: 0 })
    );
    assert.equal(data.length, 41);
    assert.equal(data[data.length - 1]!.age, 70);
  });
  it("every row is a finite, rounded integer", () => {
    const data = computeProjectionSeries(projInput({ yearsToFire: 10 }));
    for (const row of data) {
      for (const k of [
        "corpus",
        "fireNumber",
        "savings",
        "expenses",
      ] as const) {
        assert.ok(Number.isFinite(row[k]), `${k} not finite @ ${row.age}`);
        assert.equal(
          row[k],
          Math.round(row[k]),
          `${k} not integer @ ${row.age}`
        );
      }
      // year is a finite calendar year, age a finite integer.
      assert.ok(Number.isFinite(row.year) && Number.isFinite(row.age));
    }
  });
  it("inflation > return divergence: fireNumber explodes but stays finite, corpus stalls", () => {
    const data = computeProjectionSeries(
      projInput({
        currentAge: 60,
        retirementAge: 90,
        currentCorpus: 5_000_000,
        monthlySavings: 0,
        totalMonthlyExpenses: 100_000,
        avgInflation: 30,
        weightedReturn: 0,
        lifeExpectancy: 90,
        yearsToFire: 0,
      })
    );
    const last = data[data.length - 1]!;
    assert.ok(Number.isFinite(last.fireNumber) && Number.isFinite(last.corpus));
    assert.ok(last.expenses > data[0]!.expenses * 5);
  });
  it("BUG-FIX: 0% withdrawalRate does NOT make the per-row fireNumber Infinity", () => {
    // 100/withdrawalRate divides by zero at rate 0 in the raw client math.
    const data = computeProjectionSeries(
      projInput({ withdrawalRate: 0, yearsToFire: 0 })
    );
    for (const row of data) {
      assert.ok(
        Number.isFinite(row.fireNumber),
        `fireNumber Infinity @ ${row.age}`
      );
    }
  });
  it("BUG-GUARD: a non-finite yearsToFire does NOT make maxYears NaN / the loop no-op", () => {
    for (const bad of [Infinity, -Infinity, NaN]) {
      const data = computeProjectionSeries(projInput({ yearsToFire: bad }));
      assert.ok(data.length >= 1, `empty series for yearsToFire=${bad}`);
      assert.ok(
        data.length <= 121,
        `unbounded series (${data.length}) for yearsToFire=${bad}`
      );
      for (const row of data) assert.ok(Number.isFinite(row.corpus));
    }
  });
  it("BUG-GUARD: a huge finite yearsToFire is capped (no unbounded array)", () => {
    const data = computeProjectionSeries(
      projInput({
        retirementAge: 90,
        lifeExpectancy: 120,
        yearsToFire: 1_000_000,
      })
    );
    assert.ok(data.length <= 121, `expected capped, got ${data.length}`);
  });
  it("BUG-GUARD: non-finite corpus/savings/return/inflation keep EVERY row finite", () => {
    const variants: Array<Partial<FireProjectionInput>> = [
      { currentCorpus: NaN },
      { monthlySavings: Infinity },
      { weightedReturn: Infinity },
      { avgInflation: NaN },
      { totalMonthlyExpenses: -Infinity },
    ];
    for (const v of variants) {
      const data = computeProjectionSeries(projInput({ ...v, yearsToFire: 5 }));
      for (const row of data) {
        for (const k of [
          "corpus",
          "fireNumber",
          "savings",
          "expenses",
        ] as const) {
          assert.ok(
            Number.isFinite(row[k]),
            `${k} non-finite for ${JSON.stringify(v)} @ ${row.age}`
          );
        }
      }
    }
  });
});

// ── computeFireStatus ────────────────────────────────────────────────────────

describe("computeFireStatus — REAL", () => {
  it("on-track when yearsToFire <= targetYears", () => {
    const r = computeFireStatus(3, 60, 30);
    assert.equal(r.status, "on-track");
    assert.match(r.message, /age 33/);
  });
  it("close when within 5 years of target", () => {
    const r = computeFireStatus(32, 60, 30);
    assert.equal(r.status, "close");
    assert.match(r.message, /2 years behind/);
  });
  it("unreachable sentinel → off-track 'increase savings'", () => {
    const r = computeFireStatus(YEARS_TO_FIRE_UNREACHABLE, 60, 30);
    assert.equal(r.status, "off-track");
    assert.match(r.message, /Increase savings/);
  });
  it("off-track with explicit years-behind when far but not the sentinel", () => {
    const r = computeFireStatus(50, 60, 30);
    assert.equal(r.status, "off-track");
    assert.match(r.message, /20 years behind/);
  });
  it("BUG-GUARD: a non-finite yearsToFire never renders 'NaN' in the message", () => {
    for (const bad of NON_FINITE) {
      const r = computeFireStatus(bad, 60, 30);
      assert.ok(
        !r.message.includes("NaN"),
        `"${r.message}" leaked NaN for ${bad}`
      );
    }
  });
});

// ── computeFireProjection (the aggregate the SERVICE calls) ──────────────────

describe("computeFireProjection — REAL aggregate", () => {
  // The demo scenario's real parameters (mirrors apps/web/lib/demo/data.ts) —
  // used here ONLY as INPUT to the real function (not to assert a shadow copy).
  const demoInput: FireScenarioProjectionInput = {
    currentAge: 25,
    retirementAge: 50,
    lifeExpectancy: 85,
    currentCorpus: 500_000,
    monthlySavings: 75_000,
    withdrawalRate: 4,
    savingsIncrement: 12,
    assetClasses: [
      { allocation: 70, expectedReturn: 12 },
      { allocation: 20, expectedReturn: 7 },
      { allocation: 10, expectedReturn: 8 },
    ],
    expenses: [
      { amount: 25000, inflation: 5 },
      { amount: 15000, inflation: 6 },
      { amount: 5000, inflation: 5 },
      { amount: 8000, inflation: 5 },
      { amount: 5000, inflation: 8 },
      { amount: 7000, inflation: 4 },
    ],
    oneTimeExpenses: [
      { id: "1", currentCost: 2_500_000, yearsAway: 18, inflation: 8 },
    ],
  };

  it("derives weightedReturn / avgInflation / monthlyExpenses and a finite plan", () => {
    const r = computeFireProjection(demoInput);
    // weighted return = 0.7*12+0.2*7+0.1*8 = 10.6
    assert.ok(Math.abs(r.weightedReturn - 10.6) < 1e-9);
    // monthlyExpenses = sum = 65000
    assert.equal(r.monthlyExpenses, 65000);
    assert.ok(Number.isFinite(r.avgInflation));
    assert.ok(Number.isFinite(r.fireNumber) && r.fireNumber > 0);
    assert.ok(Number.isFinite(r.yearsToFire));
    assert.ok(r.series.length > 0);
    for (const row of r.series) {
      assert.ok(Number.isFinite(row.corpus) && Number.isFinite(row.fireNumber));
    }
    assert.ok(["on-track", "close", "off-track"].includes(r.status.status));
  });

  it("BUG-GUARD: an adversarial scenario (NaN corpus, Infinity return, 0 withdrawal) → fully finite plan", () => {
    const r = computeFireProjection({
      ...demoInput,
      currentCorpus: NaN,
      withdrawalRate: 0,
      assetClasses: [{ allocation: 100, expectedReturn: Infinity }],
      expenses: [{ amount: Infinity, inflation: NaN }],
    });
    assert.ok(Number.isFinite(r.fireNumber), `fireNumber: ${r.fireNumber}`);
    assert.ok(Number.isFinite(r.yearsToFire), `yearsToFire: ${r.yearsToFire}`);
    assert.ok(
      Number.isFinite(r.weightedReturn) && Number.isFinite(r.avgInflation)
    );
    for (const row of r.series) {
      for (const k of [
        "corpus",
        "fireNumber",
        "savings",
        "expenses",
      ] as const) {
        assert.ok(Number.isFinite(row[k]), `${k} non-finite @ ${row.age}`);
      }
    }
    assert.ok(!r.status.message.includes("NaN"));
  });
});

// ════════════════════════════════════════════════════════════════════════════
// PART 2 — FIRE Zod validator (load-bearing for the bounds the math omits)
// ════════════════════════════════════════════════════════════════════════════

describe("FireParametersSchema — REAL (the load-bearing guard)", () => {
  const VALID = {
    currentAge: 30,
    retirementAge: 60,
    lifeExpectancy: 85,
    currentCorpus: 500000,
    monthlySavings: 50000,
    withdrawalRate: 4,
    salaryIncrement: 10,
    savingsIncrement: 12,
  };
  it("accepts a sane scenario", () => {
    assert.equal(FireParametersSchema.safeParse(VALID).success, true);
  });
  it("rejects withdrawalRate < 1 (this is what keeps the 0%-rate divide unreachable in the UI)", () => {
    assert.equal(
      FireParametersSchema.safeParse({ ...VALID, withdrawalRate: 0 }).success,
      false
    );
  });
  it("rejects a non-finite currentCorpus / monthlySavings (.finite())", () => {
    assert.equal(
      FireParametersSchema.safeParse({ ...VALID, currentCorpus: Infinity })
        .success,
      false
    );
    assert.equal(
      FireParametersSchema.safeParse({ ...VALID, monthlySavings: NaN }).success,
      false
    );
  });
  it("rejects retirementAge < currentAge (refine)", () => {
    assert.equal(
      FireParametersSchema.safeParse({
        ...VALID,
        currentAge: 65,
        retirementAge: 60,
      }).success,
      false
    );
  });
});

// ════════════════════════════════════════════════════════════════════════════
// PART 3 — LIVE @usemoney/services FIRE path (recording-prisma require.cache seam)
// ════════════════════════════════════════════════════════════════════════════
//
// Proves the SERVICE actually calls the guarded math: `getFireScenarios`'s
// `withMonthlyExpenses` now delegates to `computeMonthlyExpenses` (a NaN stored
// amount can't poison the surfaced monthlyExpenses), and
// `computeFireScenarioProjection` runs the guarded projection end-to-end. Seam
// pattern mirrors services-data-e2e.test.ts.

interface RecordedCall {
  model: string;
  method: string;
  args: unknown;
}

class RecordingPrisma {
  readonly calls: RecordedCall[] = [];
  private readonly queues = new Map<string, unknown[]>();
  queue(model: string, method: string, result: unknown): void {
    const key = `${model}.${method}`;
    const q = this.queues.get(key) ?? [];
    q.push(result);
    this.queues.set(key, q);
  }
  private next(model: string, method: string): unknown {
    const q = this.queues.get(`${model}.${method}`);
    if (q && q.length > 0) return q.shift();
    if (method === "count") return 0;
    if (method === "findFirst" || method === "findUnique") return null;
    if (method === "updateMany" || method === "deleteMany") return { count: 0 };
    return [];
  }
  readonly client: Record<
    string,
    Record<string, (args?: unknown) => Promise<unknown>>
  >;
  constructor() {
    const self = this;
    this.client = new Proxy(
      {},
      {
        get(target: Record<string, unknown>, model: string) {
          if (typeof model !== "string") return undefined;
          if (!(model in target)) {
            target[model] = new Proxy(
              {},
              {
                get(_m, method: string) {
                  return (args?: unknown) => {
                    self.calls.push({ model, method, args });
                    return Promise.resolve(self.next(model, method));
                  };
                },
              }
            );
          }
          return target[model];
        },
      }
    ) as RecordingPrisma["client"];
  }
}

type ModuleCache = Record<string, { exports: unknown } | undefined>;
function moduleCache(): ModuleCache {
  return (require as unknown as { cache: ModuleCache }).cache;
}

const SILENT_LOGGER = {
  debug() {},
  error() {},
  info() {},
  warn() {},
  trace() {},
  fatal() {},
  child() {
    return SILENT_LOGGER;
  },
};
function makeLoggerStub(): Record<string, unknown> {
  const factory = () => SILENT_LOGGER;
  return new Proxy(
    { __esModule: true },
    {
      get(_t, k: string) {
        if (k === "__esModule") return true;
        if (k === "getLogger" || k === "default" || k === "createModuleLoggers")
          return factory;
        if (k === "initLogger" || k === "flushLogs")
          return async () => undefined;
        return SILENT_LOGGER;
      },
    }
  );
}

let activePrisma: RecordingPrisma = new RecordingPrisma();
const STABLE_PRISMA = new Proxy(
  {},
  {
    get(target: Record<string, unknown>, model: string) {
      if (typeof model !== "string") return undefined;
      if (model === "then") return undefined;
      if (!(model in target)) {
        target[model] = new Proxy(
          {},
          {
            get(_m, method: string) {
              return (args?: unknown) =>
                activePrisma.client[model]![method]!(args);
            },
          }
        );
      }
      return target[model];
    },
  }
);

// A no-op @usemoney/core cache stub (getCached always misses → DB path runs).
function makeCoreStub(): Record<string, unknown> {
  return new Proxy(
    { __esModule: true },
    {
      get(_t, k: string) {
        if (k === "__esModule") return true;
        if (k === "getCached") return async () => null;
        return async () => {};
      },
    }
  );
}

interface FireServicesModule {
  getFireScenarios: (userId: string) => Promise<{
    success: boolean;
    data?: Array<Record<string, unknown>>;
    error?: string;
  }>;
  computeFireScenarioProjection: (input: FireScenarioProjectionInput) => {
    success: boolean;
    data?: { fireNumber: number; yearsToFire: number; series: unknown[] };
    error?: string;
  };
}

let servicesSingleton: FireServicesModule | null = null;
const priorCacheEntries: Array<[string, { exports: unknown } | undefined]> = [];

function installServices(): FireServicesModule {
  if (servicesSingleton) return servicesSingleton;
  const cache = moduleCache();
  const stub = (path: string, exports: unknown) => {
    priorCacheEntries.push([path, cache[path]]);
    cache[path] = { exports };
  };
  stub(require.resolve("@usemoney/database"), {
    __esModule: true,
    prisma: STABLE_PRISMA,
    default: STABLE_PRISMA,
  });
  stub(require.resolve("@usemoney/core"), makeCoreStub());
  stub(require.resolve("@usemoney/logger"), makeLoggerStub());
  for (const key of Object.keys(cache)) {
    if (
      key.includes("/packages/services/src/") &&
      (key.endsWith(".service.ts") || key.endsWith("/index.ts"))
    ) {
      priorCacheEntries.push([key, cache[key]]);
      delete cache[key];
    }
  }
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  servicesSingleton = require("@usemoney/services") as FireServicesModule;
  return servicesSingleton;
}

function uninstallServices(): void {
  const cache = moduleCache();
  for (const [path, prior] of priorCacheEntries) {
    if (prior === undefined) delete cache[path];
    else cache[path] = prior;
  }
  priorCacheEntries.length = 0;
  servicesSingleton = null;
}

describe("MONEY-620 — LIVE FIRE service runs the guarded math (recording prisma)", () => {
  let svc: FireServicesModule;
  before(() => {
    svc = installServices();
  });
  beforeEach(() => {
    activePrisma = new RecordingPrisma();
  });
  after(() => {
    uninstallServices();
  });

  it("getFireScenarios is scoped to userId and derives monthlyExpenses via the guarded delegate", async () => {
    activePrisma.queue("fireScenario", "findMany", [
      {
        id: "s1",
        userId: "u-fire",
        name: "Plan",
        expenses: [{ amount: 25000 }, { amount: 15000 }],
        chatHistory: [],
      },
    ]);
    const res = await svc.getFireScenarios("u-fire");
    assert.equal(res.success, true);
    const find = activePrisma.calls.find(
      (c) => c.model === "fireScenario" && c.method === "findMany"
    );
    assert.ok(find, "expected fireScenario.findMany");
    // IDOR guard: query scoped to the caller's userId.
    assert.equal(
      (find.args as { where: { userId: string } }).where.userId,
      "u-fire"
    );
    // monthlyExpenses computed by the (real) guarded helper.
    assert.equal(res.data![0]!.monthlyExpenses, 40000);
  });

  it("BUG-GUARD (LIVE): a NaN stored expense amount no longer poisons monthlyExpenses", async () => {
    activePrisma.queue("fireScenario", "findMany", [
      {
        id: "s2",
        userId: "u-fire2",
        name: "Plan",
        expenses: [{ amount: 30000 }, { amount: NaN }, { amount: null }],
        chatHistory: [],
      },
    ]);
    const res = await svc.getFireScenarios("u-fire2");
    assert.equal(res.success, true);
    const me = res.data![0]!.monthlyExpenses;
    assert.ok(
      me === 30000,
      `monthlyExpenses must be 30000 (NaN→0), got ${String(me)}`
    );
    assert.notEqual(me, null);
    // It must never be the literal NaN that a downstream toLocaleString renders.
    assert.equal(Number.isNaN(me as number), false);
  });

  it("computeFireScenarioProjection (LIVE) returns a fully finite plan via ServiceResult", () => {
    const res = svc.computeFireScenarioProjection({
      currentAge: 30,
      retirementAge: 60,
      lifeExpectancy: 85,
      currentCorpus: 500_000,
      monthlySavings: 50_000,
      withdrawalRate: 4,
      savingsIncrement: 12,
      assetClasses: [{ allocation: 100, expectedReturn: 12 }],
      expenses: [{ amount: 50_000, inflation: 6 }],
      oneTimeExpenses: [],
    });
    assert.equal(res.success, true);
    assert.ok(Number.isFinite(res.data!.fireNumber));
    assert.ok(Number.isFinite(res.data!.yearsToFire));
    assert.ok(res.data!.series.length > 0);
  });

  it("computeFireScenarioProjection (LIVE) stays finite on an adversarial scenario", () => {
    const res = svc.computeFireScenarioProjection({
      currentAge: 30,
      retirementAge: 60,
      lifeExpectancy: 85,
      currentCorpus: NaN,
      monthlySavings: Infinity,
      withdrawalRate: 0,
      savingsIncrement: 12,
      assetClasses: [{ allocation: 100, expectedReturn: Infinity }],
      expenses: [{ amount: NaN, inflation: Infinity }],
      oneTimeExpenses: [
        { id: "x", currentCost: Infinity, yearsAway: 99999, inflation: 99 },
      ],
    });
    assert.equal(res.success, true);
    assert.ok(
      Number.isFinite(res.data!.fireNumber),
      `fireNumber: ${res.data!.fireNumber}`
    );
    assert.ok(
      Number.isFinite(res.data!.yearsToFire),
      `yearsToFire: ${res.data!.yearsToFire}`
    );
  });
});
