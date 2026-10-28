/**
 * Ask FIRE chat — tool-input CLAMPING tests (MONEY-1049, code-review fix).
 *
 * Gemini emits raw numbers, so without a guard the chat could drive the plan
 * into states the UI sliders forbid (age 5, negative corpus, SWR 0,
 * allocation 200…) and feed nonsensical values into the projection math. The
 * executor clamps every numeric arg to FIRE_BOUNDS — the SAME limits the
 * sliders enforce — and flags the correction in the ToolResult so the model
 * can re-plan. This suite pins that: the VALUE reaching each setter is the
 * clamped one, and the message says so; in-range values pass through untouched.
 *
 * Sources: apps/web/app/fire/lib/chat/toolExecutor.ts + app/fire/lib/bounds.ts
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { executeFireTool } from "@/app/fire/lib/chat/toolExecutor";
import { FIRE_BOUNDS } from "@/app/fire/lib/bounds";
import type { FireChatActions } from "@/app/fire/lib/chat/actions";

/** Mock that records the numeric value actually handed to each setter. */
function makeCapturingActions() {
  const v: Record<string, number> = {};
  const n = (name: string) => (val: number) => {
    v[name] = val;
  };
  const byName =
    (name: string) =>
    (_key: string, val: number): boolean => {
      v[name] = val;
      return true;
    };
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
    setCurrentAge: n("setCurrentAge"),
    setRetirementAge: n("setRetirementAge"),
    setLifeExpectancy: n("setLifeExpectancy"),
    setCurrentCorpus: n("setCurrentCorpus"),
    setMonthlySavings: n("setMonthlySavings"),
    setSafeWithdrawalRate: n("setSafeWithdrawalRate"),
    setTaxRate: n("setTaxRate"),
    setSalaryIncrement: n("setSalaryIncrement"),
    setSavingsIncrement: n("setSavingsIncrement"),
    addAssetClass: (a) => {
      v["addAssetClass.allocation"] = a.allocation;
      v["addAssetClass.expectedReturn"] = a.expectedReturn;
    },
    updateAssetAllocationByName: byName("updateAssetAllocationByName"),
    updateAssetReturnByName: byName("updateAssetReturnByName"),
    removeAssetClassByName: () => true,
    addExpense: (e) => {
      v["addExpense.amount"] = e.amount;
      v["addExpense.inflation"] = e.inflation;
    },
    updateExpenseByCategory: (_c, u) => {
      if (u.amount !== undefined) v["updateExpense.amount"] = u.amount;
      if (u.inflation !== undefined) v["updateExpense.inflation"] = u.inflation;
      return true;
    },
    removeExpenseByCategory: () => true,
    addOneTimeGoal: (g) => {
      v["addGoal.currentCost"] = g.currentCost;
      v["addGoal.yearsAway"] = g.yearsAway;
      v["addGoal.inflation"] = g.inflation;
    },
    updateOneTimeGoalByName: (_n, u) => {
      if (u.currentCost !== undefined)
        v["updateGoal.currentCost"] = u.currentCost;
      if (u.yearsAway !== undefined) v["updateGoal.yearsAway"] = u.yearsAway;
      return true;
    },
    removeOneTimeGoalByName: () => true,
    saveScenario: (async () => true) as FireChatActions["saveScenario"],
    loadScenarioByName: (async () =>
      true) as FireChatActions["loadScenarioByName"],
    resetAll: (() => {}) as FireChatActions["resetAll"],
  };
  return { actions, v };
}

describe("executor clamps out-of-range parameter inputs", () => {
  it("retirement age below the floor → clamped up, and flagged", async () => {
    const { actions, v } = makeCapturingActions();
    const r = await executeFireTool("setRetirementAge", { age: 5 }, actions);
    assert.equal(v.setRetirementAge, FIRE_BOUNDS.retirementAge.min);
    assert.ok(r.ok);
    assert.match(r.message ?? "", /clamped/);
  });

  it("current age above the ceiling → clamped down", async () => {
    const { actions, v } = makeCapturingActions();
    await executeFireTool("setCurrentAge", { age: 200 }, actions);
    assert.equal(v.setCurrentAge, FIRE_BOUNDS.currentAge.max);
  });

  it("negative corpus → clamped to 0 (no negative corpus)", async () => {
    const { actions, v } = makeCapturingActions();
    await executeFireTool("setCurrentCorpus", { amount: -500000 }, actions);
    assert.equal(v.setCurrentCorpus, FIRE_BOUNDS.currentCorpus.min);
  });

  it("negative monthly savings → clamped to 0", async () => {
    const { actions, v } = makeCapturingActions();
    await executeFireTool("setMonthlySavings", { amount: -1 }, actions);
    assert.equal(v.setMonthlySavings, 0);
  });

  it("SWR 0 → clamped to the floor (avoids a zero withdrawal cap)", async () => {
    const { actions, v } = makeCapturingActions();
    await executeFireTool("setSafeWithdrawalRate", { percent: 0 }, actions);
    assert.equal(v.setSafeWithdrawalRate, FIRE_BOUNDS.withdrawalRate.min);
  });

  it("SWR above the ceiling → clamped down", async () => {
    const { actions, v } = makeCapturingActions();
    await executeFireTool("setSafeWithdrawalRate", { percent: 50 }, actions);
    assert.equal(v.setSafeWithdrawalRate, FIRE_BOUNDS.withdrawalRate.max);
  });

  it("tax rate over 100 → clamped to 100", async () => {
    const { actions, v } = makeCapturingActions();
    await executeFireTool("setTaxRate", { percent: 150 }, actions);
    assert.equal(v.setTaxRate, FIRE_BOUNDS.taxRate.max);
  });
});

describe("executor clamps out-of-range collection inputs", () => {
  it("allocation over 100 → clamped to 100", async () => {
    const { actions, v } = makeCapturingActions();
    const r = await executeFireTool(
      "updateAssetAllocation",
      { name: "Equity", allocation: 250 },
      actions
    );
    assert.equal(v.updateAssetAllocationByName, FIRE_BOUNDS.allocation.max);
    assert.ok(r.ok);
    assert.match(r.message ?? "", /clamped/);
  });

  it("negative allocation → clamped to 0", async () => {
    const { actions, v } = makeCapturingActions();
    await executeFireTool(
      "updateAssetAllocation",
      { name: "Gold", allocation: -10 },
      actions
    );
    assert.equal(v.updateAssetAllocationByName, 0);
  });

  it("addAssetClass clamps BOTH allocation and expected return", async () => {
    const { actions, v } = makeCapturingActions();
    await executeFireTool(
      "addAssetClass",
      { name: "Crypto", allocation: 500, expectedReturn: 9999 },
      actions
    );
    assert.equal(v["addAssetClass.allocation"], FIRE_BOUNDS.allocation.max);
    assert.equal(
      v["addAssetClass.expectedReturn"],
      FIRE_BOUNDS.expectedReturn.max
    );
  });

  it("negative expense amount → clamped to 0", async () => {
    const { actions, v } = makeCapturingActions();
    await executeFireTool(
      "addExpense",
      { category: "Rent", amount: -100, inflation: 5 },
      actions
    );
    assert.equal(v["addExpense.amount"], 0);
  });

  it("negative goal years-away → clamped to 0", async () => {
    const { actions, v } = makeCapturingActions();
    await executeFireTool(
      "addOneTimeGoal",
      { name: "Car", currentCost: 500000, yearsAway: -3, inflation: 6 },
      actions
    );
    assert.equal(v["addGoal.yearsAway"], 0);
  });
});

describe("executor leaves in-range inputs untouched", () => {
  it("passes a valid retirement age through with NO clamp note", async () => {
    const { actions, v } = makeCapturingActions();
    const r = await executeFireTool("setRetirementAge", { age: 45 }, actions);
    assert.equal(v.setRetirementAge, 45);
    assert.ok(r.ok);
    assert.doesNotMatch(r.message ?? "", /clamped/);
  });

  it("passes a valid allocation through with NO clamp note", async () => {
    const { actions, v } = makeCapturingActions();
    const r = await executeFireTool(
      "updateAssetAllocation",
      { name: "Equity", allocation: 60 },
      actions
    );
    assert.equal(v.updateAssetAllocationByName, 60);
    assert.ok(r.ok);
    assert.doesNotMatch(r.message ?? "", /clamped/);
  });
});
