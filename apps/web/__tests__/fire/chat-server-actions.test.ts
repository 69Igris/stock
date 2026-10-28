/**
 * Ask FIRE — SERVER-side actions tests (StockSage integration).
 *
 * Proves the "supreme god" off-page path: the SAME pure executeFireTool that
 * drives the /fire page's React state (bridge.ts) also drives a plain
 * in-memory plan via ServerFireActions, with NO executor changes. If this
 * passes, the full 26-tool editing surface works from the main chat off /fire.
 *
 * Sources: apps/web/app/fire/lib/chat/serverActions.ts + toolExecutor.ts
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { executeFireTool } from "@/app/fire/lib/chat/toolExecutor";
import {
  ServerFireActions,
  defaultServerFirePlan,
  type ServerFirePlan,
  type ServerScenarioOps,
} from "@/app/fire/lib/chat/serverActions";

function fresh(ops?: ServerScenarioOps): ServerFireActions {
  return new ServerFireActions(defaultServerFirePlan(), ops);
}

describe("ServerFireActions — parameter setters via the real executor", () => {
  it("applies numeric params to the in-memory plan", async () => {
    const a = fresh();
    await executeFireTool("setRetirementAge", { age: 45 }, a);
    await executeFireTool("setMonthlySavings", { amount: 90_000 }, a);
    await executeFireTool("setTaxRate", { percent: 20 }, a);
    assert.equal(a.plan.retirementAge, 45);
    assert.equal(a.plan.monthlySavings, 90_000);
    assert.equal(a.plan.taxRate, 20);
  });

  it("applies the executor's clamp server-side too (retire 5 → floor)", async () => {
    const a = fresh();
    const r = await executeFireTool("setRetirementAge", { age: 5 }, a);
    assert.ok(r.ok);
    assert.equal(a.plan.retirementAge, 20); // FIRE_BOUNDS.retirementAge.min
  });
});

describe("ServerFireActions — collections via the real executor", () => {
  it("updates an existing asset allocation by name", async () => {
    const a = fresh();
    const r = await executeFireTool(
      "updateAssetAllocation",
      { name: "Equity", allocation: 70 },
      a
    );
    assert.ok(r.ok);
    assert.equal(
      a.plan.assetClasses.find((x) => x.name === "Equity")?.allocation,
      70
    );
  });

  it("reports not-found (ok:false) for an unknown asset", async () => {
    const a = fresh();
    const r = await executeFireTool(
      "updateAssetAllocation",
      { name: "Dogecoin", allocation: 50 },
      a
    );
    assert.equal(r.ok, false);
  });

  it("adds and removes an asset class", async () => {
    const a = fresh();
    await executeFireTool(
      "addAssetClass",
      { name: "Crypto", allocation: 5, expectedReturn: 15 },
      a
    );
    assert.ok(a.plan.assetClasses.some((x) => x.name === "Crypto"));
    const rm = await executeFireTool("removeAssetClass", { name: "Crypto" }, a);
    assert.ok(rm.ok);
    assert.ok(!a.plan.assetClasses.some((x) => x.name === "Crypto"));
  });

  it("adds, updates and removes an expense by category", async () => {
    const a = fresh();
    await executeFireTool(
      "addExpense",
      { category: "Travel", amount: 12_000, inflation: 7 },
      a
    );
    await executeFireTool(
      "updateExpense",
      { category: "Travel", amount: 15_000 },
      a
    );
    assert.equal(
      a.plan.monthlyExpenses.find((x) => x.category === "Travel")?.amount,
      15_000
    );
    const rm = await executeFireTool(
      "removeExpense",
      { category: "Travel" },
      a
    );
    assert.ok(rm.ok);
    assert.ok(!a.plan.monthlyExpenses.some((x) => x.category === "Travel"));
  });

  it("adds and removes a one-time goal by name", async () => {
    const a = fresh();
    await executeFireTool(
      "addOneTimeGoal",
      { name: "Wedding", currentCost: 1_500_000, yearsAway: 3, inflation: 6 },
      a
    );
    assert.ok(a.plan.oneTimeExpenses.some((x) => x.name === "Wedding"));
    const rm = await executeFireTool(
      "removeOneTimeGoal",
      { name: "Wedding" },
      a
    );
    assert.ok(rm.ok);
    assert.ok(!a.plan.oneTimeExpenses.some((x) => x.name === "Wedding"));
  });
});

describe("ServerFireActions — reset + scenario ops", () => {
  it("resetAll restores the factory-default plan in place", async () => {
    const a = fresh();
    await executeFireTool("setMonthlySavings", { amount: 5_000 }, a);
    const ref = a.plan; // handler holds this reference
    await executeFireTool("resetAll", {}, a);
    assert.equal(a.plan, ref, "plan reference must be preserved");
    assert.equal(a.plan.monthlySavings, defaultServerFirePlan().monthlySavings);
  });

  it("saveScenario reports failure when no ops are injected", async () => {
    const a = fresh();
    const r = await executeFireTool("saveScenario", { name: "Aggressive" }, a);
    assert.equal(r.ok, false);
  });

  it("saveScenario delegates to the injected op with the live plan", async () => {
    let savedName = "";
    let savedSavings = 0;
    const a = fresh({
      saveScenario: async (plan: ServerFirePlan, name: string) => {
        savedName = name;
        savedSavings = plan.monthlySavings;
        return true;
      },
    });
    await executeFireTool("setMonthlySavings", { amount: 88_000 }, a);
    const r = await executeFireTool("saveScenario", { name: "Plan B" }, a);
    assert.ok(r.ok);
    assert.equal(savedName, "Plan B");
    assert.equal(savedSavings, 88_000);
  });

  it("loadScenarioByName swaps the plan contents in place", async () => {
    const swapped: ServerFirePlan = {
      ...defaultServerFirePlan(),
      retirementAge: 60,
      currentCorpus: 9_999_999,
    };
    const a = fresh({
      loadScenarioByName: async (name: string) =>
        name.toLowerCase() === "conservative" ? swapped : null,
    });
    const ref = a.plan;
    const r = await executeFireTool(
      "loadScenario",
      { name: "Conservative" },
      a
    );
    assert.ok(r.ok);
    assert.equal(a.plan, ref, "plan reference preserved across load");
    assert.equal(a.plan.retirementAge, 60);
    assert.equal(a.plan.currentCorpus, 9_999_999);
  });

  it("loadScenarioByName reports not-found for an unknown name", async () => {
    const a = fresh({ loadScenarioByName: async () => null });
    const r = await executeFireTool("loadScenario", { name: "Ghost" }, a);
    assert.equal(r.ok, false);
  });
});
