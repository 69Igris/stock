/**
 * FIRE calculator math — REAL source coverage (MONEY-620, MONEY-876).
 *
 * The FIRE *projection* math is NOT in `packages/services/src/fire.service.ts`
 * (that file is pure scenario CRUD). Since MONEY-1079 it lives in the shared
 * `@usemoney/fire` package so apps/api can reuse it, with
 * `apps/web/app/fire/lib/calculations.ts` kept as a thin re-export shim. This
 * suite imports through that shim — the exact path the /fire page uses — and
 * asserts behavior on representative and adversarial inputs.
 *
 * Source: packages/fire/src/calculations.ts
 *         (via the apps/web/app/fire/lib/calculations.ts re-export)
 *
 * MONEY-876 replaced the old safe-withdrawal-rate (perpetuity) model with a
 * post-tax present-value-of-expenses model: the FIRE number is the corpus that,
 * at retirement, funds all future (inflating) spending to life expectancy
 * discounted at the post-tax return, depleting to zero. These tests pin that
 * model — including the load-bearing self-consistency property that a corpus
 * equal to the FIRE number depletes to ~0 under the projection simulation.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  computeWeightedReturn,
  computeAvgInflation,
  computePostTaxReturn,
  computeFireNumber,
  computeYearsToFire,
  computeProjectionData,
  computeFireStatus,
  computeOneTimeExpensesForFire,
  computeSustainableMonthly,
} from "@/app/fire/lib/calculations";
import type {
  AssetClass,
  MonthlyExpense,
  OneTimeExpense,
} from "@/app/fire/lib/types";

// ── computeWeightedReturn ───────────────────────────────────────────

describe("computeWeightedReturn — edge", () => {
  it("empty asset list → 10% default (avoids divide-by-zero)", () => {
    assert.equal(computeWeightedReturn([]), 10);
  });

  it("all-zero allocation → 10% default (total allocation 0)", () => {
    const acs: AssetClass[] = [
      {
        id: "1",
        name: "Equity",
        icon: "",
        allocation: 0,
        expectedReturn: 12,
        color: "",
      },
      {
        id: "2",
        name: "Debt",
        icon: "",
        allocation: 0,
        expectedReturn: 7,
        color: "",
      },
    ];
    assert.equal(computeWeightedReturn(acs), 10);
  });

  it("weights by allocation share, not raw sum", () => {
    const acs: AssetClass[] = [
      {
        id: "1",
        name: "Equity",
        icon: "",
        allocation: 50,
        expectedReturn: 12,
        color: "",
      },
      {
        id: "2",
        name: "Debt",
        icon: "",
        allocation: 50,
        expectedReturn: 6,
        color: "",
      },
    ];
    assert.equal(computeWeightedReturn(acs), 9);
  });

  it("allocations that don't sum to 100 are normalized to their own total", () => {
    const acs: AssetClass[] = [
      {
        id: "1",
        name: "A",
        icon: "",
        allocation: 30,
        expectedReturn: 10,
        color: "",
      },
      {
        id: "2",
        name: "B",
        icon: "",
        allocation: 10,
        expectedReturn: 20,
        color: "",
      },
    ];
    // total 40 → (30/40)*10 + (10/40)*20 = 7.5 + 5 = 12.5
    assert.equal(computeWeightedReturn(acs), 12.5);
  });

  it("negative expectedReturn (validator allows -20..50) flows through", () => {
    const acs: AssetClass[] = [
      {
        id: "1",
        name: "Crash",
        icon: "",
        allocation: 100,
        expectedReturn: -20,
        color: "",
      },
    ];
    assert.equal(computeWeightedReturn(acs), -20);
  });
});

// ── computeAvgInflation ─────────────────────────────────────────────

describe("computeAvgInflation — edge", () => {
  it("empty expense list → 6% default", () => {
    assert.equal(computeAvgInflation([]), 6);
  });

  it("all-zero amounts → 6% default (avoids divide-by-zero)", () => {
    const es: MonthlyExpense[] = [
      { id: "1", category: "Rent", amount: 0, inflation: 5 },
      { id: "2", category: "Food", amount: 0, inflation: 8 },
    ];
    assert.equal(computeAvgInflation(es), 6);
  });

  it("amount-weighted average", () => {
    const es: MonthlyExpense[] = [
      { id: "1", category: "Rent", amount: 30000, inflation: 5 },
      { id: "2", category: "Health", amount: 10000, inflation: 9 },
    ];
    // (5*30000 + 9*10000) / 40000 = 6
    assert.equal(computeAvgInflation(es), 6);
  });
});

// ── computePostTaxReturn ────────────────────────────────────────────

describe("computePostTaxReturn", () => {
  it("applies the tax haircut to the gross return", () => {
    assert.equal(computePostTaxReturn(10, 30), 7);
  });
  it("0% tax → unchanged", () => {
    assert.equal(computePostTaxReturn(10, 0), 10);
  });
  it("100% tax → 0", () => {
    assert.equal(computePostTaxReturn(10, 100), 0);
  });
  it("non-integer result is correct", () => {
    assert.ok(Math.abs(computePostTaxReturn(8, 40) - 4.8) < 1e-9);
  });
});

// ── computeFireNumber (post-tax PV-of-expenses model) ───────────────

describe("computeFireNumber", () => {
  // (monthly, avgInflation, weightedReturn, taxRate, retire, current, life, oneTime)

  it("zero inflation & zero return → flat sum of annual expenses over horizon", () => {
    // postTax 0, no inflation → Σ of 25 years of 600,000 = 15,000,000.
    assert.equal(computeFireNumber(50000, 0, 0, 0, 60, 30, 85, 0), 15_000_000);
  });

  it("when post-tax return equals inflation, PV factor is exactly the horizon", () => {
    // wr 10, tax 30 → postTax 7 == inflation 7 → growth/discount cancel.
    // 10 retirement years × 600,000 = 6,000,000.
    assert.equal(computeFireNumber(50000, 7, 10, 30, 50, 50, 60, 0), 6_000_000);
  });

  it("one-time expenses are added on top of the recurring PV", () => {
    const base = computeFireNumber(50000, 0, 0, 0, 60, 30, 85, 0);
    const withOneTime = computeFireNumber(
      50000,
      0,
      0,
      0,
      60,
      30,
      85,
      2_000_000
    );
    assert.equal(withOneTime - base, 2_000_000);
  });

  it("zero monthly expenses → only one-times remain", () => {
    assert.equal(computeFireNumber(0, 6, 10, 30, 60, 30, 85, 0), 0);
    assert.equal(computeFireNumber(0, 6, 10, 30, 60, 30, 85, 500_000), 500_000);
  });

  it("zero retirement horizon (retire === life) → no recurring need", () => {
    assert.equal(computeFireNumber(50000, 6, 10, 30, 85, 30, 85, 0), 0);
  });

  it("retire < current is still mathematically defined (refine blocks it in UI)", () => {
    const n = computeFireNumber(50000, 6, 4, 30, 25, 30, 85, 0);
    assert.ok(
      Number.isFinite(n) && n > 0,
      `expected finite positive, got ${n}`
    );
  });

  it("SELF-CONSISTENCY: a corpus equal to the FIRE number depletes to ~0", () => {
    const monthly = 50000,
      infl = 6,
      wr = 10,
      tax = 30,
      retire = 55,
      life = 90;
    const oneTime = computeOneTimeExpensesForFire([], retire, retire, wr, tax);
    const fire = computeFireNumber(
      monthly,
      infl,
      wr,
      tax,
      retire,
      retire,
      life,
      oneTime
    );
    // Simulate from retirement with exactly the FIRE corpus and no savings.
    // withdrawalRate 100 keeps the cap non-binding, isolating the pure
    // depletion property (a finite cap would strand a residual near the end).
    const proj = computeProjectionData(
      retire,
      retire,
      fire,
      0,
      monthly,
      infl,
      wr,
      tax,
      100,
      life,
      0,
      0,
      []
    );
    const last = proj[proj.length - 1]!;
    assert.equal(last.age, life);
    assert.ok(
      Math.abs(last.corpus) < 100,
      `corpus should deplete to ~0, got ${last.corpus}`
    );
    // The rolling target at retirement equals the headline number.
    assert.equal(proj[0]!.fireNumber, Math.round(fire));
  });
});

// ── computeYearsToFire ──────────────────────────────────────────────

describe("computeYearsToFire — edge", () => {
  const noOneTime: OneTimeExpense[] = [];
  // (corpus, savings, fire, wr, savInc, retire, current, monthly, infl, tax, withdrawalRate, oneTime)

  it("already at/above target → 0 years", () => {
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
        30,
        4,
        noOneTime
      ),
      0
    );
  });

  it("never reaches FIRE (0 savings, 0% return, corpus < target) → 999 sentinel", () => {
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
        30,
        4,
        noOneTime
      ),
      999
    );
  });

  it("negative corpus that never recovers → 999 sentinel (no infinite loop)", () => {
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
        30,
        4,
        noOneTime
      ),
      999
    );
  });

  it("0% return but positive savings still accumulates and terminates < 999", () => {
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
      30,
      4,
      noOneTime
    );
    assert.ok(y >= 1 && y < 999, `expected a finite small number, got ${y}`);
  });

  it("result never exceeds the 100-year cap (returns 999, not 100+)", () => {
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
      30,
      4,
      noOneTime
    );
    assert.ok(y === 999 || y <= 100, `out-of-range years: ${y}`);
  });
});

// ── one-time goals before retirement (MONEY-1161) ───────────────────

/**
 * Regression cover for MONEY-1154 bug #7: "changing one time cost does not
 * affect the end fire number".
 *
 * A goal falling due BEFORE retirement is deliberately excluded from the FIRE
 * number (which sizes the corpus needed AT retirement) — it is meant to bite by
 * draining the accumulating corpus instead. Two defects stopped that happening:
 * `computeYearsToFire` halted at the first crossing of the target, so a goal
 * scheduled after it was never deducted; and the due-year test was a strict
 * equality against an integer loop index, so a fractional `yearsAway` matched
 * no year at all and the expense vanished outright.
 */
describe("one-time goals before retirement — MONEY-1161", () => {
  const goal = (currentCost: number, yearsAway: number): OneTimeExpense[] => [
    {
      id: "g1",
      name: "Children's Education",
      currentCost,
      yearsAway,
      inflation: 6.5,
    },
  ];

  // Retire at 50 from 30, so goals inside 20 years are pre-retirement. The
  // target is the FIRE number this plan actually produces, and the corpus
  // crosses it around year 16 — before the year-18 goal falls due.
  const yearsFor = (oneTime: OneTimeExpense[]) =>
    computeYearsToFire(
      1_000_000,
      50_000,
      37_531_107,
      12,
      5,
      50,
      30,
      50_000,
      6,
      15,
      4,
      oneTime
    );

  it("a costlier pre-retirement goal pushes the FIRE date out", () => {
    const small = yearsFor(goal(2_000_000, 18));
    const large = yearsFor(goal(9_000_000, 18));
    assert.ok(
      large > small,
      `a 4.5x costlier goal must delay FIRE, got small=${small} large=${large}`
    );
  });

  it("a goal due AFTER the corpus first crosses the target is still paid", () => {
    const withoutGoal = yearsFor([]);
    const withGoal = yearsFor(goal(9_000_000, 18));
    assert.ok(
      withGoal > withoutGoal,
      `goal due after the crossing must still delay FIRE, got ${withGoal} with vs ${withoutGoal} without`
    );
  });

  it("pre-retirement goals stay OUT of the FIRE number (corpus-at-retirement semantics)", () => {
    assert.equal(
      computeOneTimeExpensesForFire(goal(9_000_000, 18), 50, 30, 12, 15),
      0
    );
  });

  it("post-retirement goals still scale the FIRE number with their cost", () => {
    const cheap = computeOneTimeExpensesForFire(
      goal(2_000_000, 25),
      50,
      30,
      12,
      15
    );
    const dear = computeOneTimeExpensesForFire(
      goal(9_000_000, 25),
      50,
      30,
      12,
      15
    );
    assert.ok(cheap > 0, "a post-retirement goal must have a present value");
    assert.ok(
      dear > cheap * 4,
      `PV must scale with cost, got cheap=${cheap} dear=${dear}`
    );
  });

  it("a fractional yearsAway rounds to its nearest whole year", () => {
    const noGoal = yearsFor([]);
    const at17half = yearsFor(goal(9_000_000, 17.5));
    const at18 = yearsFor(goal(9_000_000, 18));

    // Both halves round up, and each must match its rounded year exactly.
    assert.equal(at17half, at18);
    assert.equal(
      yearsFor(goal(9_000_000, 18.5)),
      yearsFor(goal(9_000_000, 19))
    );

    // Guard against the equality holding vacuously: on the pre-fix code BOTH
    // sides collapsed to the no-goal answer (17.5 matched no loop index, and
    // year 18 was never simulated because the loop stopped at the crossing),
    // so the assertions above passed while the goal did nothing at all.
    assert.ok(
      at18 > noGoal,
      `the year-18 goal must actually bite; got ${at18} vs ${noGoal} with no goal`
    );
  });

  it("a fractional goal is still paid, rather than skipped entirely", () => {
    // Strict `yearsAway === year` matching made 17.5 match no loop index, so
    // the goal was never deducted and the answer collapsed to the no-goal one.
    // A year-18 goal demonstrably delays this plan, so 17.5 must too.
    const noGoal = yearsFor([]);
    assert.ok(
      yearsFor(goal(9_000_000, 17.5)) > noGoal,
      `fractional goal must delay FIRE beyond the ${noGoal}-year no-goal case`
    );
  });

  it("a fractional goal still drains the projected corpus", () => {
    const project = (oneTime: OneTimeExpense[]) =>
      computeProjectionData(
        30,
        50,
        1_000_000,
        50_000,
        50_000,
        6,
        12,
        15,
        4,
        85,
        20,
        5,
        oneTime
      );
    const atRetirement = (rows: ReturnType<typeof project>) =>
      rows.find((r) => r.age === 50)!.corpus;

    const withoutGoal = atRetirement(project([]));
    const withGoal = atRetirement(project(goal(9_000_000, 18.5)));
    assert.ok(
      withGoal < withoutGoal,
      `fractional goal must reduce the corpus, got ${withGoal} vs ${withoutGoal}`
    );
  });
});

// ── computeProjectionData ───────────────────────────────────────────

describe("computeProjectionData — edge", () => {
  // (current, retire, corpus, savings, monthly, infl, wr, tax, withdrawalRate, life, yearsToFire, savInc, oneTime)

  it("0-year horizon (currentAge === lifeExpectancy) → exactly 1 row, then breaks", () => {
    const data = computeProjectionData(
      60,
      60,
      1_000_000,
      0,
      50_000,
      6,
      10,
      30,
      4,
      60,
      0,
      0,
      []
    );
    assert.equal(data.length, 1);
    assert.equal(data[0]!.age, 60);
  });

  it("corpus is floored at 0 each year (never goes negative)", () => {
    const data = computeProjectionData(
      64,
      90,
      10_000,
      0,
      500_000,
      6,
      10,
      30,
      4,
      90,
      0,
      0,
      []
    );
    for (const row of data) {
      assert.ok(
        row.corpus >= 0,
        `corpus went negative: ${row.corpus} at age ${row.age}`
      );
    }
  });

  it("runs to life expectancy for a young current age (no 40-year truncation)", () => {
    // Regression guard: maxYears now includes (life - current), so a 30→90 plan
    // must reach age 90, not stop at the old max(40, yearsToFire+10) cap.
    const data = computeProjectionData(
      30,
      50,
      1_000_000,
      50_000,
      50_000,
      6,
      8,
      30,
      4,
      90,
      20,
      5,
      []
    );
    assert.equal(data[data.length - 1]!.age, 90);
    assert.equal(data.length, 61); // ages 30..90 inclusive
  });

  it("inflation > return divergence: rolling FIRE target dwarfs the stalled corpus", () => {
    // 0% return (wr 0), 30% inflation, retire == current so the whole horizon is
    // drawdown → the required corpus (PV of 30 yrs of 30%-inflating spend) is
    // astronomical vs the 5,000,000 actually held.
    const data = computeProjectionData(
      60,
      60,
      5_000_000,
      0,
      100_000,
      30,
      0,
      30,
      4,
      90,
      0,
      0,
      []
    );
    assert.ok(data.length > 0);
    const first = data[0]!;
    const last = data[data.length - 1]!;
    assert.ok(
      last.expenses > first.expenses * 5,
      `expenses didn't explode: ${first.expenses} → ${last.expenses}`
    );
    assert.ok(
      first.fireNumber > first.corpus * 100,
      `fireNumber (${first.fireNumber}) should dwarf corpus (${first.corpus})`
    );
    assert.ok(Number.isFinite(last.corpus) && Number.isFinite(last.fireNumber));
  });

  it("every projection row carries finite, rounded integers", () => {
    const data = computeProjectionData(
      30,
      60,
      1_000_000,
      50_000,
      50_000,
      6,
      12,
      30,
      4,
      60,
      0,
      10,
      []
    );
    for (const row of data) {
      for (const k of [
        "corpus",
        "fireNumber",
        "savings",
        "expenses",
      ] as const) {
        assert.ok(Number.isFinite(row[k]), `${k} not finite at age ${row.age}`);
        assert.equal(
          row[k],
          Math.round(row[k]),
          `${k} not integer at age ${row.age}`
        );
      }
    }
  });
});

// ── withdrawal-rate cap & shortfall (MONEY-876) ─────────────────────

describe("computeProjectionData — withdrawal-rate cap & shortfall", () => {
  // Fund a corpus == the depletion FIRE number, then vary the withdrawal cap.
  const monthly = 50000,
    infl = 6,
    wr = 10,
    tax = 30,
    retire = 50,
    life = 85;
  const fire = computeFireNumber(
    monthly,
    infl,
    wr,
    tax,
    retire,
    retire,
    life,
    computeOneTimeExpensesForFire([], retire, retire, wr, tax)
  );

  it("a tight cap (4%) leaves an unfunded shortfall in later years", () => {
    const data = computeProjectionData(
      retire,
      retire,
      fire,
      0,
      monthly,
      infl,
      wr,
      tax,
      4,
      life,
      0,
      0,
      []
    );
    assert.ok(
      data.some((p) => (p.shortfall ?? 0) > 0),
      "expected the 4% cap to under-fund spending at some point"
    );
  });

  it("no shortfall on the death-year row (no spending after life expectancy)", () => {
    const data = computeProjectionData(
      retire,
      retire,
      fire,
      0,
      monthly,
      infl,
      wr,
      tax,
      4,
      life,
      0,
      0,
      []
    );
    const lifeRow = data[data.length - 1]!;
    assert.equal(lifeRow.age, life);
    assert.equal(lifeRow.shortfall ?? 0, 0);
  });

  it("a looser cap strands less corpus (less forced under-spending)", () => {
    const leftover = (w: number) =>
      computeProjectionData(
        retire,
        retire,
        fire,
        0,
        monthly,
        infl,
        wr,
        tax,
        w,
        life,
        0,
        0,
        []
      ).at(-1)!.corpus;
    // wr 25% permits more spending than 4%, so it depletes further → less left.
    assert.ok(
      leftover(25) < leftover(4),
      "higher withdrawal rate should leave less residual"
    );
  });

  it("shortfall is a finite, rounded integer on every row", () => {
    const data = computeProjectionData(
      retire,
      retire,
      fire,
      0,
      monthly,
      infl,
      wr,
      tax,
      4,
      life,
      0,
      0,
      []
    );
    for (const row of data) {
      const s = row.shortfall ?? 0;
      assert.ok(Number.isFinite(s), `shortfall not finite at age ${row.age}`);
      assert.equal(s, Math.round(s), `shortfall not integer at age ${row.age}`);
    }
  });
});

// ── computeFireStatus ───────────────────────────────────────────────

describe("computeFireStatus — edge", () => {
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

  it("never-reaches sentinel (999) → off-track 'increase savings'", () => {
    const r = computeFireStatus(999, 60, 30);
    assert.equal(r.status, "off-track");
    assert.match(r.message, /Increase savings/);
  });

  it("off-track with explicit years-behind when far but not 999", () => {
    const r = computeFireStatus(50, 60, 30);
    assert.equal(r.status, "off-track");
    assert.match(r.message, /20 years behind/);
  });
});

// ── computeOneTimeExpensesForFire (post-tax discounting) ────────────

describe("computeOneTimeExpensesForFire — edge", () => {
  // (oneTimes, retire, current, weightedReturn, taxRate)

  it("expenses BEFORE retirement (yearsAway < horizon) are ignored", () => {
    const expenses: OneTimeExpense[] = [
      {
        id: "1",
        name: "Car",
        currentCost: 1_000_000,
        yearsAway: 2,
        inflation: 6,
      },
    ];
    assert.equal(computeOneTimeExpensesForFire(expenses, 60, 30, 10, 30), 0);
  });

  it("expense exactly AT retirement, 0 inflation → unchanged cost", () => {
    const expenses: OneTimeExpense[] = [
      {
        id: "1",
        name: "Trip",
        currentCost: 100_000,
        yearsAway: 30,
        inflation: 0,
      },
    ];
    assert.equal(
      computeOneTimeExpensesForFire(expenses, 60, 30, 10, 30),
      100_000
    );
  });

  it("expense AFTER retirement, 0% post-tax return → no discount", () => {
    const expenses: OneTimeExpense[] = [
      {
        id: "1",
        name: "Late",
        currentCost: 1_000_000,
        yearsAway: 40,
        inflation: 0,
      },
    ];
    // postTax 0 (wr 0, tax 0) → inflate to yr40 (×1) then discount 10 yrs at 0% → unchanged.
    assert.equal(
      computeOneTimeExpensesForFire(expenses, 60, 30, 0, 0),
      1_000_000
    );
  });

  it("expense AFTER retirement is discounted at the POST-TAX return", () => {
    const expenses: OneTimeExpense[] = [
      {
        id: "1",
        name: "Late",
        currentCost: 1_000_000,
        yearsAway: 40,
        inflation: 0,
      },
    ];
    // wr 10, tax 30 → postTax 7 → discount 10 yrs: 1,000,000 / 1.07^10 ≈ 508,349.
    const v = computeOneTimeExpensesForFire(expenses, 60, 30, 10, 30);
    assert.ok(v > 505_000 && v < 512_000, `expected ~508k, got ${v}`);
  });

  it("empty list → 0", () => {
    assert.equal(computeOneTimeExpensesForFire([], 60, 30, 10, 30), 0);
  });
});

// ── computeSustainableMonthly ───────────────────────────────────────

describe("computeSustainableMonthly", () => {
  // (corpusAtRetire, avgInflation, weightedReturn, taxRate, retire, life)

  it("zero retirement horizon → 0 (no division by an empty factor)", () => {
    assert.equal(computeSustainableMonthly(1_000_000, 6, 10, 30, 85, 85), 0);
  });

  it("zero corpus → 0", () => {
    assert.equal(computeSustainableMonthly(0, 6, 10, 30, 50, 85), 0);
  });

  it("inverts computeFireNumber: a corpus == recurring FIRE supports that spend", () => {
    // postTax 7 == inflation 7 → factor = 10. corpus 6,000,000 / 10 / 12 = 50,000.
    assert.equal(
      computeSustainableMonthly(6_000_000, 7, 10, 30, 50, 60),
      50_000
    );
  });
});
