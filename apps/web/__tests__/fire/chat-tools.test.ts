/**
 * Ask FIRE chat — tool executor (MONEY-1049).
 *
 * `executeFireTool` maps a Gemini function call (name + args) onto a
 * `FireChatActions` method. This suite runs the REAL executor against a
 * recording mock of the actions contract and asserts:
 *   - args are coerced/validated (string→number, missing → error);
 *   - by-name/by-category mutators surface "not found" as an error;
 *   - INR amounts are echoed with ₹ lakh/crore formatting;
 *   - scenario ops (async) resolve; unknown tools error.
 *
 * Source: apps/web/app/fire/lib/chat/toolExecutor.ts
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { executeFireTool } from "@/app/fire/lib/chat/toolExecutor";
import type { FireChatActions } from "@/app/fire/lib/chat/actions";

interface Call {
  name: string;
  args: unknown[];
}

interface MockSets {
  assets?: string[];
  expenses?: string[];
  goals?: string[];
  scenarios?: string[];
}

function makeMock(sets: MockSets = {}) {
  const calls: Call[] = [];
  const rec =
    (name: string) =>
    (...args: unknown[]) => {
      calls.push({ name, args });
    };
  const has = (list: string[] | undefined, n: string) =>
    (list ?? []).some((x) => x.toLowerCase() === n.toLowerCase());

  const actions: FireChatActions = {
    // MONEY-1079 — contract gained readValues() so the executor can report a
    // change as "from <old> to <new>". These suites assert the value handed to
    // each setter, so a zeroed baseline is sufficient here.
    readValues: () => ({
      currentAge: 0,
      retirementAge: 0,
      lifeExpectancy: 0,
      currentCorpus: 0,
      monthlySavings: 0,
      withdrawalRate: 0,
      taxRate: 0,
      salaryIncrement: 0,
      savingsIncrement: 0,
    }),
    setCurrentAge: rec("setCurrentAge"),
    setRetirementAge: rec("setRetirementAge"),
    setLifeExpectancy: rec("setLifeExpectancy"),
    setCurrentCorpus: rec("setCurrentCorpus"),
    setMonthlySavings: rec("setMonthlySavings"),
    setSafeWithdrawalRate: rec("setSafeWithdrawalRate"),
    setTaxRate: rec("setTaxRate"),
    setSalaryIncrement: rec("setSalaryIncrement"),
    setSavingsIncrement: rec("setSavingsIncrement"),
    addAssetClass: rec("addAssetClass"),
    updateAssetAllocationByName: (n, a) => {
      calls.push({ name: "updateAssetAllocationByName", args: [n, a] });
      return has(sets.assets, n);
    },
    updateAssetReturnByName: (n, r) => {
      calls.push({ name: "updateAssetReturnByName", args: [n, r] });
      return has(sets.assets, n);
    },
    removeAssetClassByName: (n) => {
      calls.push({ name: "removeAssetClassByName", args: [n] });
      return has(sets.assets, n);
    },
    addExpense: rec("addExpense"),
    updateExpenseByCategory: (c, u) => {
      calls.push({ name: "updateExpenseByCategory", args: [c, u] });
      return has(sets.expenses, c);
    },
    removeExpenseByCategory: (c) => {
      calls.push({ name: "removeExpenseByCategory", args: [c] });
      return has(sets.expenses, c);
    },
    addOneTimeGoal: rec("addOneTimeGoal"),
    updateOneTimeGoalByName: (n, u) => {
      calls.push({ name: "updateOneTimeGoalByName", args: [n, u] });
      return has(sets.goals, n);
    },
    removeOneTimeGoalByName: (n) => {
      calls.push({ name: "removeOneTimeGoalByName", args: [n] });
      return has(sets.goals, n);
    },
    saveScenario: async (n) => {
      calls.push({ name: "saveScenario", args: [n] });
      return true;
    },
    loadScenarioByName: async (n) => {
      calls.push({ name: "loadScenarioByName", args: [n] });
      return has(sets.scenarios, n);
    },
    resetAll: rec("resetAll"),
  };

  return { actions, calls };
}

// ── Parameter setters ─────────────────────────────────────────────────

describe("executeFireTool — parameters", () => {
  it("setCurrentAge dispatches and confirms", async () => {
    const { actions, calls } = makeMock();
    const r = await executeFireTool("setCurrentAge", { age: 50 }, actions);
    assert.equal(r.ok, true);
    assert.equal(calls[0]?.name, "setCurrentAge");
    assert.deepEqual(calls[0]?.args, [50]);
  });

  it("coerces stringified numbers (Gemini sometimes sends '45')", async () => {
    const { actions, calls } = makeMock();
    const r = await executeFireTool("setRetirementAge", { age: "45" }, actions);
    assert.equal(r.ok, true);
    assert.deepEqual(calls[0]?.args, [45]);
  });

  it("missing/NaN arg → error, no dispatch", async () => {
    const { actions, calls } = makeMock();
    const r = await executeFireTool("setCurrentAge", {}, actions);
    assert.equal(r.ok, false);
    if (!r.ok) assert.match(r.error, /age/);
    assert.equal(calls.length, 0);
  });

  it("formats corpus as ₹ lakh/crore in the confirmation", async () => {
    const { actions } = makeMock();
    const r = await executeFireTool(
      "setCurrentCorpus",
      { amount: 5_000_000 },
      actions
    );
    assert.equal(r.ok, true);
    if (r.ok) assert.match(r.message, /₹50\.00 L/);
  });

  it("setTaxRate (MONEY-876) dispatches and confirms", async () => {
    const { actions, calls } = makeMock();
    const r = await executeFireTool("setTaxRate", { percent: 20 }, actions);
    assert.equal(r.ok, true);
    if (r.ok) assert.match(r.message, /tax rate.*20%/i);
    assert.equal(calls[0]?.name, "setTaxRate");
    assert.deepEqual(calls[0]?.args, [20]);
  });
});

// ── Asset allocation (by-name) ────────────────────────────────────────

describe("executeFireTool — assets by name", () => {
  it("updateAssetAllocation on an existing asset → ok", async () => {
    const { actions, calls } = makeMock({ assets: ["Equity"] });
    const r = await executeFireTool(
      "updateAssetAllocation",
      { name: "equity", allocation: 70 },
      actions
    );
    assert.equal(r.ok, true);
    assert.equal(calls[0]?.name, "updateAssetAllocationByName");
  });

  it("updateAssetAllocation on a missing asset → not-found error", async () => {
    const { actions } = makeMock({ assets: ["Equity"] });
    const r = await executeFireTool(
      "updateAssetAllocation",
      { name: "Crypto", allocation: 10 },
      actions
    );
    assert.equal(r.ok, false);
    if (!r.ok) assert.match(r.error, /Crypto/);
  });
});

// ── Expenses ──────────────────────────────────────────────────────────

describe("executeFireTool — expenses", () => {
  it("addExpense passes parsed fields", async () => {
    const { actions, calls } = makeMock();
    const r = await executeFireTool(
      "addExpense",
      { category: "Travel", amount: "8000", inflation: 6 },
      actions
    );
    assert.equal(r.ok, true);
    assert.deepEqual(calls[0]?.args, [
      { category: "Travel", amount: 8000, inflation: 6 },
    ]);
  });

  it("addExpense with a bad amount → error", async () => {
    const { actions, calls } = makeMock();
    const r = await executeFireTool(
      "addExpense",
      { category: "Travel", amount: "abc", inflation: 6 },
      actions
    );
    assert.equal(r.ok, false);
    assert.equal(calls.length, 0);
  });

  it("removeExpense on a missing category → not-found error", async () => {
    const { actions } = makeMock({ expenses: ["Groceries"] });
    const r = await executeFireTool(
      "removeExpense",
      { category: "Rent" },
      actions
    );
    assert.equal(r.ok, false);
  });
});

// ── Scenarios + reset + unknown ───────────────────────────────────────

describe("executeFireTool — scenarios & control", () => {
  it("saveScenario awaits the async action", async () => {
    const { actions, calls } = makeMock();
    const r = await executeFireTool(
      "saveScenario",
      { name: "Aggressive" },
      actions
    );
    assert.equal(r.ok, true);
    assert.equal(calls[0]?.name, "saveScenario");
  });

  it("loadScenario on an unknown name → not-found", async () => {
    const { actions } = makeMock({ scenarios: ["Base"] });
    const r = await executeFireTool("loadScenario", { name: "Nope" }, actions);
    assert.equal(r.ok, false);
  });

  it("resetAll dispatches", async () => {
    const { actions, calls } = makeMock();
    const r = await executeFireTool("resetAll", {}, actions);
    assert.equal(r.ok, true);
    assert.equal(calls[0]?.name, "resetAll");
  });

  it("unknown tool → error", async () => {
    const { actions } = makeMock();
    const r = await executeFireTool("frobnicate", {}, actions);
    assert.equal(r.ok, false);
    if (!r.ok) assert.match(r.error, /Unknown tool/);
  });
});
