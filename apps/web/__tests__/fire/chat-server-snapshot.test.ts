/**
 * Ask FIRE — SERVER-side snapshot builder tests (StockSage integration).
 *
 * buildFireSnapshotFromPlan recomputes the model-facing FireSnapshot from raw
 * plan values off /fire, using the SAME calculations.ts the page uses. These
 * tests lock:
 *   - GOLDEN outcomes for the factory-default plan (regression guard on the
 *     arg-order wiring — a single mis-ordered positional arg silently changes
 *     the numbers);
 *   - that firstShortfallAge (the withdrawal-cap sustainability signal absent
 *     from the older service math) is actually computed server-side;
 *   - the full loop: an edit applied through the REAL executor + ServerFireActions
 *     flows into a recomputed snapshot (the goal-seeking feedback the off-page
 *     model relies on).
 *
 * Sources: apps/web/app/fire/lib/chat/serverSnapshot.ts + serverActions.ts
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { executeFireTool } from "@/app/fire/lib/chat/toolExecutor";
import {
  ServerFireActions,
  defaultServerFirePlan,
} from "@/app/fire/lib/chat/serverActions";
import { buildFireSnapshotFromPlan } from "@/app/fire/lib/chat/serverSnapshot";

describe("buildFireSnapshotFromPlan — shape + static blocks", () => {
  it("maps parameters and collections and passes through saved names", () => {
    const snap = buildFireSnapshotFromPlan(defaultServerFirePlan(), [
      "Base",
      "Aggressive",
    ]);
    assert.equal(snap.parameters.safeWithdrawalRate, 4); // withdrawalRate → safeWithdrawalRate
    assert.equal(snap.parameters.taxRate, 30);
    assert.equal(snap.assetClasses.length, 5);
    assert.equal(snap.expenses.length, 8);
    assert.equal(snap.oneTimeGoals.length, 1);
    assert.deepEqual(snap.savedScenarios, [
      { name: "Base" },
      { name: "Aggressive" },
    ]);
    // computed block has exactly the 8 expected keys (no dead/removed fields).
    assert.deepEqual(Object.keys(snap.computed).sort(), [
      "corpusAtRetirement",
      "fireAchievedAtRetirement",
      "fireNumber",
      "firstShortfallAge",
      "surplusAtRetirement",
      "sustainableMonthlySpend",
      "swrComparisonFireNumber",
      "yearsToFire",
    ]);
  });
});

describe("buildFireSnapshotFromPlan — golden outcomes (default plan)", () => {
  it("matches the /fire page math for the factory defaults", () => {
    const c = buildFireSnapshotFromPlan(defaultServerFirePlan()).computed;
    assert.equal(c.fireNumber, 68_111_403);
    assert.equal(c.yearsToFire, 19);
    assert.equal(c.corpusAtRetirement, 79_070_604);
    assert.equal(c.fireAchievedAtRetirement, true);
    assert.equal(c.surplusAtRetirement, 10_959_201);
    assert.equal(c.sustainableMonthlySpend, 239_040);
    assert.equal(c.swrComparisonFireNumber, 61_772_650);
    // The default plan reaches its FIRE number but overdraws from age 62 —
    // proof the withdrawal-cap shortfall (missing from fire-logic.ts) runs here.
    assert.equal(c.firstShortfallAge, 62);
  });
});

describe("buildFireSnapshotFromPlan — reacts to plan changes", () => {
  it("larger monthly savings shortens yearsToFire", () => {
    const base = buildFireSnapshotFromPlan(defaultServerFirePlan()).computed;
    const richer = defaultServerFirePlan();
    richer.monthlySavings = 300_000;
    const c = buildFireSnapshotFromPlan(richer).computed;
    assert.ok(
      (c.yearsToFire ?? 999) < (base.yearsToFire ?? 999),
      `expected faster FIRE, got ${c.yearsToFire} vs ${base.yearsToFire}`
    );
  });

  it("an edit via the executor flows into a recomputed snapshot", async () => {
    const a = new ServerFireActions(defaultServerFirePlan());
    const before = buildFireSnapshotFromPlan(a.plan).computed.yearsToFire;
    await executeFireTool("setMonthlySavings", { amount: 250_000 }, a);
    const after = buildFireSnapshotFromPlan(a.plan);
    assert.equal(after.parameters.monthlySavings, 250_000);
    assert.ok(
      (after.computed.yearsToFire ?? 999) <= (before ?? 999),
      "snapshot must reflect the edited plan (goal-seeking feedback)"
    );
  });

  it("removing all expenses drops the FIRE number sharply", () => {
    const plan = defaultServerFirePlan();
    plan.monthlyExpenses = [];
    const c = buildFireSnapshotFromPlan(plan).computed;
    const baseline = buildFireSnapshotFromPlan(
      defaultServerFirePlan()
    ).computed;
    assert.ok(
      c.fireNumber < baseline.fireNumber,
      "no recurring expenses → smaller target corpus"
    );
  });
});
