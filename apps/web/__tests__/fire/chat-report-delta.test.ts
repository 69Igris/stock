/**
 * Ask FIRE chat — before/after change reporting (MONEY-1079 regression).
 *
 * THE BUG: "save ₹20k more" on a ₹60,000 plan updated monthly savings to
 * ₹80,000 (correct) but the reply said ₹1 lakh. The turn loop re-snapshots the
 * plan after every tool call, so the model's NEXT hop saw the already-updated
 * ₹80,000 as "current" and re-applied the user's +₹20k in prose.
 *
 * THE FIX: the executor now reads the pre-mutation value from
 * `actions.readValues()` and reports the change as a FACT — "Changed monthly
 * savings from ₹60,000 to ₹80,000" — so the model quotes the delta instead of
 * recomputing it. This suite pins that message against a STATEFUL mock (setters
 * actually move the value `readValues` returns), which is what makes the
 * before/after real rather than a zeroed stub.
 *
 * fmtINR(100000) === "₹1.00 L", so the buggy narrative would literally contain
 * "1.00 L" / "1 L" — the negative assertions below catch exactly that.
 *
 * Source: packages/fire/src/toolExecutor.ts (via the apps/web shim).
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { executeFireTool } from "@/app/fire/lib/chat/toolExecutor";
import type {
  FireChatActions,
  FireCurrentValues,
} from "@/app/fire/lib/chat/actions";

/**
 * A stateful FireChatActions whose numeric setters mutate an in-memory plan and
 * whose `readValues()` returns that live plan — so `before` reflects prior
 * state exactly as the real page/server twins do. Only the members these
 * scenarios touch carry behaviour; the rest satisfy the contract as no-ops.
 */
function makeStatefulActions(initial: Partial<FireCurrentValues> = {}) {
  const plan: FireCurrentValues = {
    currentAge: 30,
    retirementAge: 50,
    lifeExpectancy: 85,
    currentCorpus: 1_800_000,
    monthlySavings: 60_000,
    withdrawalRate: 4,
    taxRate: 30,
    salaryIncrement: 10,
    savingsIncrement: 8,
    ...initial,
  };
  const noop = () => {};
  const miss = () => false;

  const actions: FireChatActions = {
    readValues: () => ({ ...plan }),
    setCurrentAge: (n) => {
      plan.currentAge = n;
    },
    setRetirementAge: (n) => {
      plan.retirementAge = n;
    },
    setLifeExpectancy: (n) => {
      plan.lifeExpectancy = n;
    },
    setCurrentCorpus: (n) => {
      plan.currentCorpus = n;
    },
    setMonthlySavings: (n) => {
      plan.monthlySavings = n;
    },
    setSafeWithdrawalRate: (n) => {
      plan.withdrawalRate = n;
    },
    setTaxRate: (n) => {
      plan.taxRate = n;
    },
    setSalaryIncrement: (n) => {
      plan.salaryIncrement = n;
    },
    setSavingsIncrement: (n) => {
      plan.savingsIncrement = n;
    },
    addAssetClass: noop,
    updateAssetAllocationByName: miss,
    updateAssetReturnByName: miss,
    removeAssetClassByName: miss,
    addExpense: noop,
    updateExpenseByCategory: miss,
    removeExpenseByCategory: miss,
    addOneTimeGoal: noop,
    updateOneTimeGoalByName: miss,
    removeOneTimeGoalByName: miss,
    saveScenario: async () => true,
    loadScenarioByName: async () => true,
    resetAll: noop,
  };
  return { actions, plan };
}

function messageOf(r: Awaited<ReturnType<typeof executeFireTool>>): string {
  assert.equal(r.ok, true, r.ok ? "" : r.error);
  return r.ok ? r.message : "";
}

describe("MONEY-1079 — executor reports the true before/after (no double-count)", () => {
  it('"save ₹20k more" on ₹60,000 → "from ₹60,000 to ₹80,000", NEVER ₹1 lakh', async () => {
    const { actions, plan } = makeStatefulActions({ monthlySavings: 60_000 });

    const msg = messageOf(
      await executeFireTool("setMonthlySavings", { amount: 80_000 }, actions)
    );

    // The reported change is the real delta …
    assert.equal(msg, "Changed monthly savings from ₹60,000 to ₹80,000.");
    // … and the plan actually moved to ₹80,000 (not ₹1,00,000).
    assert.equal(plan.monthlySavings, 80_000);

    // The exact bug: the reply must NOT contain the double-counted ₹1 lakh in
    // ANY of its rendered forms. fmtINR(100000) === "₹1.00 L".
    for (const doubleCounted of ["1.00 L", "1,00,000", "100000", "100,000"]) {
      assert.ok(
        !msg.includes(doubleCounted),
        `reply double-counted: contained "${doubleCounted}" → ${msg}`
      );
    }
  });

  it("the OLD value comes from readValues(), not from the tool arg", async () => {
    // If the executor derived `before` from anything but the live plan, an
    // initial value the user never mentioned could not appear in the message.
    const { actions } = makeStatefulActions({ monthlySavings: 45_000 });

    const msg = messageOf(
      await executeFireTool("setMonthlySavings", { amount: 90_000 }, actions)
    );

    assert.equal(msg, "Changed monthly savings from ₹45,000 to ₹90,000.");
  });

  it("setting a parameter to the value it already has → honest no-op, not a fake change", async () => {
    const { actions, plan } = makeStatefulActions({ monthlySavings: 60_000 });

    const msg = messageOf(
      await executeFireTool("setMonthlySavings", { amount: 60_000 }, actions)
    );

    assert.equal(msg, "monthly savings is already ₹60,000 — no change.");
    assert.ok(!msg.startsWith("Changed"), "no-op must not read as a change");
    assert.equal(plan.monthlySavings, 60_000);
  });

  it("the before/after pattern holds for lakh/crore-scale corpus too", async () => {
    // ₹18,00,000 → ₹25,00,000 exercises the ≥1e5 fmtINR branch on BOTH ends.
    const { actions } = makeStatefulActions({ currentCorpus: 1_800_000 });

    const msg = messageOf(
      await executeFireTool("setCurrentCorpus", { amount: 2_500_000 }, actions)
    );

    assert.equal(msg, "Changed current corpus from ₹18.00 L to ₹25.00 L.");
  });

  it("percent-formatted setters report the delta with a % unit, from live state", async () => {
    const { actions } = makeStatefulActions({ savingsIncrement: 8 });

    const msg = messageOf(
      await executeFireTool("setSavingsIncrement", { percent: 12 }, actions)
    );

    assert.equal(msg, "Changed savings increment from 8% to 12%.");
  });
});
