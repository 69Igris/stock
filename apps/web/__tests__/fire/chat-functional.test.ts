/**
 * Ask FIRE chat — FUNCTIONAL tests (MONEY-1049).
 *
 * Integration of the real layers below the UI: Gemini-style tool calls run
 * through the REAL `executeFireTool` → REAL `buildFireActions` → a
 * React-like FireLive harness (functional setState over plain objects) —
 * then the panel's post-turn `rebalanceAssetAllocations` invariant.
 *
 * Scenarios mirror actual chat turns:
 *   - a multi-tool "life event" turn mutating params + expenses + goals;
 *   - the "make my plan more conservative" allocation turn, ending with
 *     the panel's rebalance → mix totals exactly 100% with the model's
 *     explicit values preserved;
 *   - by-name misses reported back (not silently applied);
 *   - scenario save/load plumbing and resetAll reaching the page.
 *
 * Sources: apps/web/app/fire/lib/chat/{toolExecutor,bridge}.ts
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { Dispatch, SetStateAction } from "react";

import { executeFireTool } from "@/app/fire/lib/chat/toolExecutor";
import {
  buildFireActions,
  rebalanceAssetAllocations,
  type FireLive,
} from "@/app/fire/lib/chat/bridge";
import type {
  AssetClass,
  MonthlyExpense,
  OneTimeExpense,
} from "@/app/fire/lib/types";

/** Minimal page-state harness with React-like functional setState. */
function makePage() {
  const state = {
    currentAge: 30,
    retirementAge: 50,
    lifeExpectancy: 85,
    currentCorpus: 1_800_000,
    monthlySavings: 60_000,
    withdrawalRate: 4,
    taxRate: 30,
    salaryIncrement: 10,
    savingsIncrement: 8,
    assetClasses: [
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
        name: "Cash",
        icon: "💵",
        allocation: 5,
        expectedReturn: 4,
        color: "#22c55e",
      },
      {
        id: "3",
        name: "Gold",
        icon: "🪙",
        allocation: 10,
        expectedReturn: 8,
        color: "#f59e0b",
      },
      {
        id: "4",
        name: "Fixed Deposits",
        icon: "🏦",
        allocation: 15,
        expectedReturn: 7,
        color: "#10b981",
      },
      {
        id: "5",
        name: "Real Estate",
        icon: "🏠",
        allocation: 10,
        expectedReturn: 9,
        color: "#8b5cf6",
      },
    ] as AssetClass[],
    monthlyExpenses: [
      { id: "e1", category: "Housing", amount: 25000, inflation: 5 },
      { id: "e2", category: "Healthcare", amount: 8000, inflation: 8 },
    ] as MonthlyExpense[],
    oneTimeExpenses: [] as OneTimeExpense[],
    savedScenarios: [{ name: "Base" }],
    resetCalls: 0,
    savedNames: [] as string[],
    loadedNames: [] as string[],
  };

  const num =
    <K extends keyof typeof state>(key: K) =>
    (n: number) => {
      (state as Record<string, unknown>)[key as string] = n;
    };
  const coll =
    <T>(key: "assetClasses" | "monthlyExpenses" | "oneTimeExpenses") =>
    (update: SetStateAction<T[]>) => {
      const prev = state[key] as unknown as T[];
      (state as Record<string, unknown>)[key] =
        typeof update === "function"
          ? (update as (p: T[]) => T[])(prev)
          : update;
    };

  const live = {
    get currentAge() {
      return state.currentAge;
    },
    get retirementAge() {
      return state.retirementAge;
    },
    get lifeExpectancy() {
      return state.lifeExpectancy;
    },
    get currentCorpus() {
      return state.currentCorpus;
    },
    get monthlySavings() {
      return state.monthlySavings;
    },
    get withdrawalRate() {
      return state.withdrawalRate;
    },
    get taxRate() {
      return state.taxRate;
    },
    get salaryIncrement() {
      return state.salaryIncrement;
    },
    get savingsIncrement() {
      return state.savingsIncrement;
    },
    get assetClasses() {
      return state.assetClasses;
    },
    get monthlyExpenses() {
      return state.monthlyExpenses;
    },
    get oneTimeExpenses() {
      return state.oneTimeExpenses;
    },
    get savedScenarios() {
      return state.savedScenarios;
    },
    fireNumber: 0,
    yearsToFire: 0,
    corpusAtRetire: 0,
    fireAchieved: false,
    surplus: 0,
    corpusLastsTill: 85,
    sustainableMonthly: 0,
    swrFireNumber: 0,
    firstShortfallAge: null,
    setCurrentAge: num("currentAge"),
    setRetirementAge: num("retirementAge"),
    setLifeExpectancy: num("lifeExpectancy"),
    setCurrentCorpus: num("currentCorpus"),
    setMonthlySavings: num("monthlySavings"),
    setWithdrawalRate: num("withdrawalRate"),
    setTaxRate: num("taxRate"),
    setSalaryIncrement: num("salaryIncrement"),
    setSavingsIncrement: num("savingsIncrement"),
    setAssetClasses: coll<AssetClass>("assetClasses") as Dispatch<
      SetStateAction<AssetClass[]>
    >,
    setMonthlyExpenses: coll<MonthlyExpense>("monthlyExpenses") as Dispatch<
      SetStateAction<MonthlyExpense[]>
    >,
    setOneTimeExpenses: coll<OneTimeExpense>("oneTimeExpenses") as Dispatch<
      SetStateAction<OneTimeExpense[]>
    >,
    saveScenario: async (name: string) => {
      state.savedNames.push(name);
      return true;
    },
    loadScenarioByName: async (name: string) => {
      state.loadedNames.push(name);
      return name.toLowerCase() === "base";
    },
    resetAll: () => {
      state.resetCalls++;
    },
  } as FireLive;

  const actions = buildFireActions(() => live);
  return { state, actions };
}

type Call = { name: string; args: Record<string, unknown> };

async function runTurn(
  page: ReturnType<typeof makePage>,
  calls: Call[]
): Promise<string[]> {
  const summaries: string[] = [];
  const touched: string[] = [];
  let allocationChanged = false;
  for (const c of calls) {
    if (c.name === "updateAssetAllocation" || c.name === "addAssetClass") {
      allocationChanged = true;
      if (typeof c.args.name === "string") touched.push(c.args.name);
    } else if (c.name === "removeAssetClass") {
      allocationChanged = true;
    }
    const r = await executeFireTool(c.name, c.args, page.actions);
    summaries.push(r.ok ? r.message : `⚠️ ${r.error}`);
  }
  // The panel's deterministic invariant after allocation-changing turns.
  if (allocationChanged) {
    page.state.assetClasses = rebalanceAssetAllocations(
      page.state.assetClasses,
      touched
    );
  }
  return summaries;
}

describe("functional — multi-tool life-event turn", () => {
  it("applies params, expenses and goals in one batch", async () => {
    const page = makePage();
    const summaries = await runTurn(page, [
      { name: "setCurrentAge", args: { age: 33 } },
      { name: "setCurrentCorpus", args: { amount: 5_500_000 } },
      { name: "setMonthlySavings", args: { amount: 95_000 } },
      { name: "setRetirementAge", args: { age: 46 } },
      { name: "setSafeWithdrawalRate", args: { percent: 3.5 } },
      { name: "setTaxRate", args: { percent: 20 } },
      {
        name: "addExpense",
        args: { category: "Childcare", amount: 18000, inflation: 8 },
      },
      {
        name: "addOneTimeGoal",
        args: {
          name: "Europe trip",
          currentCost: 800000,
          yearsAway: 5,
          inflation: 6,
        },
      },
      { name: "saveScenario", args: { name: "Master plan" } },
    ]);
    assert.equal(page.state.currentAge, 33);
    assert.equal(page.state.currentCorpus, 5_500_000);
    assert.equal(page.state.monthlySavings, 95_000);
    assert.equal(page.state.retirementAge, 46);
    assert.equal(page.state.withdrawalRate, 3.5);
    assert.equal(page.state.taxRate, 20);
    assert.equal(
      page.state.monthlyExpenses.find((e) => e.category === "Childcare")
        ?.amount,
      18000
    );
    assert.equal(page.state.oneTimeExpenses[0]?.name, "Europe trip");
    assert.deepEqual(page.state.savedNames, ["Master plan"]);
    assert.equal(summaries.length, 9);
    assert.ok(summaries.every((s) => !s.startsWith("⚠️")));
    // string args from the model coerce (₹55 L arrives as "5500000" sometimes)
  });

  it("coerces string-typed numbers from the model", async () => {
    const page = makePage();
    await runTurn(page, [
      { name: "setMonthlySavings", args: { amount: "120000" } },
    ]);
    assert.equal(page.state.monthlySavings, 120000);
  });
});

describe("functional — the conservative-allocation turn ends at exactly 100%", () => {
  it("model sets Equity 40 + FD 30; untouched assets absorb the gap", async () => {
    const page = makePage();
    await runTurn(page, [
      {
        name: "updateAssetAllocation",
        args: { name: "Equity", allocation: 40 },
      },
      {
        name: "updateAssetAllocation",
        args: { name: "Fixed Deposits", allocation: 30 },
      },
    ]);
    const total = page.state.assetClasses.reduce((s, a) => s + a.allocation, 0);
    assert.equal(total, 100);
    assert.equal(
      page.state.assetClasses.find((a) => a.name === "Equity")!.allocation,
      40
    );
    assert.equal(
      page.state.assetClasses.find((a) => a.name === "Fixed Deposits")!
        .allocation,
      30
    );
  });

  it("adding a new asset rebalances the others down to fit", async () => {
    const page = makePage();
    await runTurn(page, [
      {
        name: "addAssetClass",
        args: { name: "Crypto", allocation: 10, expectedReturn: 20 },
      },
    ]);
    const total = page.state.assetClasses.reduce((s, a) => s + a.allocation, 0);
    assert.equal(total, 100);
    assert.equal(
      page.state.assetClasses.find((a) => a.name === "Crypto")!.allocation,
      10
    );
  });

  it("removing an asset rebalances the rest back up to 100", async () => {
    const page = makePage();
    await runTurn(page, [
      { name: "removeAssetClass", args: { name: "Real Estate" } },
    ]);
    const total = page.state.assetClasses.reduce((s, a) => s + a.allocation, 0);
    assert.equal(total, 100);
    assert.equal(page.state.assetClasses.length, 4);
  });
});

describe("functional — honest misses and page-level ops", () => {
  it("a by-name miss reports an error and applies no allocation change", async () => {
    const page = makePage();
    const before = JSON.stringify(page.state.assetClasses);
    const summaries = await runTurn(page, [
      {
        name: "updateAssetAllocation",
        args: { name: "Dogecoin", allocation: 10 },
      },
    ]);
    assert.ok(summaries[0]!.startsWith("⚠️"));
    assert.ok(!page.state.assetClasses.some((a) => a.name === "Dogecoin"));
    // Mix was already 100%, the miss changed nothing → rebalance is a no-op.
    assert.equal(JSON.stringify(page.state.assetClasses), before);
  });

  it("loadScenario resolves by name; unknown scenario reports not-found", async () => {
    const page = makePage();
    const ok = await runTurn(page, [
      { name: "loadScenario", args: { name: "Base" } },
    ]);
    assert.ok(!ok[0]!.startsWith("⚠️"));
    const miss = await runTurn(page, [
      { name: "loadScenario", args: { name: "Nope" } },
    ]);
    assert.ok(miss[0]!.startsWith("⚠️"));
    assert.deepEqual(page.state.loadedNames, ["Base", "Nope"]);
  });

  it("resetAll reaches the page exactly once", async () => {
    const page = makePage();
    await runTurn(page, [{ name: "resetAll", args: {} }]);
    assert.equal(page.state.resetCalls, 1);
  });
});
