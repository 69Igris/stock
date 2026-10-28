/**
 * Ask FIRE chat — state bridge UNIT tests (MONEY-1049).
 *
 * `buildFireActions(getLive)` adapts the FIRE page's useState setters into
 * the chat's `FireChatActions` contract; `buildFireSnapshot(live)` builds the
 * serialisable plan snapshot (inputs + computed outcomes) sent to the model.
 *
 * This suite drives the REAL bridge over a plain-object FireLive harness
 * (functional setState semantics, like React) and pins:
 *   - all parameter setters route to the right underlying setter;
 *   - by-name/by-category mutators are case-insensitive, and report
 *     found/not-found truthfully;
 *   - the latest-value semantics: actions built ONCE keep reading the
 *     CURRENT live object (no stale closure);
 *   - snapshot mapping incl. computed rounding and the yearsToFire >= 999
 *     "never" sentinel → null.
 *
 * Source: apps/web/app/fire/lib/chat/bridge.ts
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { Dispatch, SetStateAction } from "react";

import {
  buildFireActions,
  buildFireSnapshot,
  type FireLive,
} from "@/app/fire/lib/chat/bridge";
import type {
  AssetClass,
  MonthlyExpense,
  OneTimeExpense,
} from "@/app/fire/lib/types";

/** React-like functional setState over a mutable holder. */
function setter<T>(holder: { v: T }): Dispatch<SetStateAction<T>> {
  return (update) => {
    holder.v =
      typeof update === "function"
        ? (update as (prev: T) => T)(holder.v)
        : update;
  };
}

function makeLive() {
  const assets = {
    v: [
      {
        id: "1",
        name: "Equity",
        icon: "📈",
        allocation: 60,
        expectedReturn: 12,
        color: "#3b82f6",
      },
      {
        id: "2",
        name: "Gold",
        icon: "🪙",
        allocation: 40,
        expectedReturn: 8,
        color: "#f59e0b",
      },
    ] as AssetClass[],
  };
  const expenses = {
    v: [
      { id: "e1", category: "Housing", amount: 25000, inflation: 5 },
    ] as MonthlyExpense[],
  };
  const goals = {
    v: [
      {
        id: "g1",
        name: "Europe trip",
        currentCost: 800000,
        yearsAway: 5,
        inflation: 6,
      },
    ] as OneTimeExpense[],
  };
  const params: Record<string, number> = {};
  const calls: string[] = [];
  const rec =
    (name: string) =>
    (n: number): void => {
      params[name] = n;
      calls.push(name);
    };

  const live: FireLive = {
    currentAge: 30,
    retirementAge: 50,
    lifeExpectancy: 85,
    currentCorpus: 1_800_000,
    monthlySavings: 60_000,
    withdrawalRate: 4,
    taxRate: 30,
    salaryIncrement: 10,
    savingsIncrement: 8,
    assetClasses: assets.v,
    monthlyExpenses: expenses.v,
    oneTimeExpenses: goals.v,
    savedScenarios: [{ name: "Base" }],
    fireNumber: 10_000_000.4,
    yearsToFire: 12,
    corpusAtRetire: 12_345_678.9,
    fireAchieved: true,
    surplus: 2_345_678.5,
    corpusLastsTill: 85,
    sustainableMonthly: 80_123.7,
    swrFireNumber: 9_876_543.2,
    firstShortfallAge: null,
    setCurrentAge: rec("currentAge"),
    setRetirementAge: rec("retirementAge"),
    setLifeExpectancy: rec("lifeExpectancy"),
    setCurrentCorpus: rec("currentCorpus"),
    setMonthlySavings: rec("monthlySavings"),
    setWithdrawalRate: rec("withdrawalRate"),
    setTaxRate: rec("taxRate"),
    setSalaryIncrement: rec("salaryIncrement"),
    setSavingsIncrement: rec("savingsIncrement"),
    setAssetClasses: setter(assets),
    setMonthlyExpenses: setter(expenses),
    setOneTimeExpenses: setter(goals),
    saveScenario: async () => true,
    loadScenarioByName: async (n) => n.toLowerCase() === "base",
    resetAll: () => calls.push("resetAll"),
  };

  // Keep live.* collection reads pointing at the holders' current values.
  Object.defineProperty(live, "assetClasses", { get: () => assets.v });
  Object.defineProperty(live, "monthlyExpenses", { get: () => expenses.v });
  Object.defineProperty(live, "oneTimeExpenses", { get: () => goals.v });

  return { live, assets, expenses, goals, params, calls };
}

describe("buildFireActions — parameter routing", () => {
  it("routes every scalar setter to the matching page setter", () => {
    const h = makeLive();
    const actions = buildFireActions(() => h.live);
    actions.setCurrentAge(33);
    actions.setRetirementAge(46);
    actions.setLifeExpectancy(90);
    actions.setCurrentCorpus(5_500_000);
    actions.setMonthlySavings(95_000);
    actions.setSafeWithdrawalRate(3.5);
    actions.setTaxRate(20);
    actions.setSalaryIncrement(12);
    actions.setSavingsIncrement(9);
    assert.deepEqual(h.params, {
      currentAge: 33,
      retirementAge: 46,
      lifeExpectancy: 90,
      currentCorpus: 5_500_000,
      monthlySavings: 95_000,
      withdrawalRate: 3.5,
      taxRate: 20,
      salaryIncrement: 12,
      savingsIncrement: 9,
    });
  });

  it("setSafeWithdrawalRate maps onto the page's withdrawalRate setter", () => {
    const h = makeLive();
    buildFireActions(() => h.live).setSafeWithdrawalRate(3);
    assert.deepEqual(h.calls, ["withdrawalRate"]);
  });
});

describe("buildFireActions — collections (case-insensitive, honest found flag)", () => {
  it("updateAssetAllocationByName: hit (case-insensitive) and miss", () => {
    const h = makeLive();
    const actions = buildFireActions(() => h.live);
    assert.equal(actions.updateAssetAllocationByName("equity", 70), true);
    assert.equal(h.assets.v.find((a) => a.name === "Equity")!.allocation, 70);
    assert.equal(actions.updateAssetAllocationByName("Crypto", 5), false);
  });

  it("addAssetClass appends with defaults (icon 💼) and a fresh id", () => {
    const h = makeLive();
    buildFireActions(() => h.live).addAssetClass({
      name: "Crypto",
      allocation: 5,
      expectedReturn: 20,
    });
    const added = h.assets.v.find((a) => a.name === "Crypto")!;
    assert.ok(added.id.length > 0);
    assert.equal(added.icon, "💼");
  });

  it("removeAssetClassByName removes exactly the named asset", () => {
    const h = makeLive();
    const actions = buildFireActions(() => h.live);
    assert.equal(actions.removeAssetClassByName("GOLD"), true);
    assert.deepEqual(
      h.assets.v.map((a) => a.name),
      ["Equity"]
    );
  });

  it("expense update/remove by category; goal update/remove by name", () => {
    const h = makeLive();
    const actions = buildFireActions(() => h.live);
    assert.equal(
      actions.updateExpenseByCategory("housing", { amount: 30000 }),
      true
    );
    assert.equal(h.expenses.v[0]!.amount, 30000);
    assert.equal(actions.removeExpenseByCategory("Rent"), false);
    assert.equal(
      actions.updateOneTimeGoalByName("europe TRIP", { yearsAway: 7 }),
      true
    );
    assert.equal(h.goals.v[0]!.yearsAway, 7);
    assert.equal(actions.removeOneTimeGoalByName("Yacht"), false);
  });

  it("actions built once keep reading the LATEST live object", () => {
    const h = makeLive();
    let current = h.live;
    const actions = buildFireActions(() => current);
    // swap in a fresh harness (simulates a re-render refreshing liveRef)
    const h2 = makeLive();
    current = h2.live;
    actions.setCurrentAge(41);
    assert.equal(h2.params.currentAge, 41);
    assert.equal(h.params.currentAge, undefined);
  });
});

describe("buildFireSnapshot — mapping & computed", () => {
  it("maps parameters (incl. taxRate) and collections verbatim", () => {
    const h = makeLive();
    const snap = buildFireSnapshot(h.live);
    assert.equal(snap.parameters.taxRate, 30);
    assert.equal(snap.parameters.safeWithdrawalRate, 4);
    assert.deepEqual(snap.assetClasses[0], {
      name: "Equity",
      allocation: 60,
      expectedReturn: 12,
    });
    assert.deepEqual(snap.expenses, [
      { category: "Housing", amount: 25000, inflation: 5 },
    ]);
    assert.deepEqual(snap.savedScenarios, [{ name: "Base" }]);
  });

  it("rounds computed money figures and passes flags through", () => {
    const h = makeLive();
    const c = buildFireSnapshot(h.live).computed;
    assert.equal(c.fireNumber, 10_000_000);
    assert.equal(c.corpusAtRetirement, 12_345_679);
    assert.equal(c.surplusAtRetirement, 2_345_679);
    assert.equal(c.sustainableMonthlySpend, 80_124);
    assert.equal(c.swrComparisonFireNumber, 9_876_543);
    assert.equal(c.firstShortfallAge, null);
    assert.equal(c.yearsToFire, 12);
  });

  it("yearsToFire >= 999 (the page's never sentinel) becomes null", () => {
    const h = makeLive();
    (h.live as { yearsToFire: number }).yearsToFire = 999;
    assert.equal(buildFireSnapshot(h.live).computed.yearsToFire, null);
  });
});
