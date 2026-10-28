/**
 * Ask FIRE — scenario mapping + targeting tests (StockSage integration).
 *
 * Locks the FireScenario ⇄ ServerFirePlan round-trip and the off-page
 * targeting decisions (name → default/single → disambiguate/recency → create/
 * defaults) exactly as agreed, so a dashboard edit never silently mutates the
 * wrong plan.
 *
 * Source: apps/web/app/fire/lib/chat/scenarioTarget.ts
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  scenarioToServerPlan,
  serverPlanToScenarioInput,
  resolveTargetScenario,
  stripTargetingPrefix,
} from "@/app/fire/lib/chat/scenarioTarget";
import { defaultServerFirePlan } from "@/app/fire/lib/chat/serverActions";
import type { FireScenario } from "@usemoney/services";

let seq = 0;
function scenario(over: Partial<FireScenario> = {}): FireScenario {
  seq += 1;
  return {
    id: `s${seq}`,
    userId: "u1",
    name: `Plan ${seq}`,
    description: null,
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
        id: "a1",
        name: "Equity",
        icon: "📈",
        allocation: 60,
        expectedReturn: 12,
        color: "#3b82f6",
      },
      {
        id: "a2",
        name: "Gold",
        icon: "🪙",
        allocation: 40,
        expectedReturn: 8,
        color: "#f59e0b",
      },
    ],
    expenses: [{ id: "e1", category: "Housing", amount: 25_000, inflation: 5 }],
    oneTimeExpenses: [],
    fireNumber: null,
    yearsToFire: null,
    monthlyExpenses: null,
    avgInflation: null,
    weightedReturn: null,
    chatHistory: [],
    isDefault: false,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...over,
  } as FireScenario;
}

describe("scenario ⇄ plan mapping", () => {
  it("maps a stored scenario into a working plan (typed arrays intact)", () => {
    const plan = scenarioToServerPlan(scenario({ retirementAge: 45 }));
    assert.equal(plan.retirementAge, 45);
    assert.equal(plan.assetClasses.length, 2);
    assert.equal(plan.assetClasses[0]?.name, "Equity");
    assert.equal(plan.monthlyExpenses[0]?.category, "Housing");
  });

  it("defaults a null stored taxRate", () => {
    const plan = scenarioToServerPlan(scenario({ taxRate: null }));
    assert.equal(plan.taxRate, 30);
  });

  it("round-trips plan → input → plan without value loss", () => {
    const start = defaultServerFirePlan();
    start.monthlySavings = 123_456;
    start.assetClasses[0]!.allocation = 55;
    const input = serverPlanToScenarioInput(start, "My FIRE Plan", "notes");
    assert.equal(input.name, "My FIRE Plan");
    assert.equal(input.monthlySavings, 123_456);
    // Re-hydrate as if read back from the DB.
    const back = scenarioToServerPlan(
      scenario({
        monthlySavings: input.monthlySavings,
        assetClasses: input.assetClasses,
        expenses: input.expenses,
        oneTimeExpenses: input.oneTimeExpenses,
        taxRate: input.taxRate ?? null,
      })
    );
    assert.equal(back.monthlySavings, 123_456);
    assert.equal(back.assetClasses[0]?.allocation, 55);
  });
});

describe("resolveTargetScenario — targeting decisions", () => {
  it("an explicit name wins (exact and partial)", () => {
    const list = [
      scenario({ name: "Base" }),
      scenario({ name: "Aggressive Plan" }),
    ];
    const exact = resolveTargetScenario(list, {
      nameHint: "Base",
      isMutation: true,
    });
    assert.equal(exact.kind === "found" && exact.scenario.name, "Base");
    const partial = resolveTargetScenario(list, {
      nameHint: "aggressive",
      isMutation: true,
    });
    assert.equal(
      partial.kind === "found" && partial.scenario.name,
      "Aggressive Plan"
    );
  });

  it("no scenarios: a mutation creates, a read uses defaults", () => {
    assert.equal(
      resolveTargetScenario([], { isMutation: true }).kind,
      "create"
    );
    assert.equal(
      resolveTargetScenario([], { isMutation: false }).kind,
      "defaults"
    );
  });

  it("a single scenario is unambiguous even if not default", () => {
    const r = resolveTargetScenario([scenario({ name: "Only" })], {
      isMutation: true,
    });
    assert.equal(r.kind === "found" && r.scenario.name, "Only");
  });

  it("the isDefault scenario wins among several", () => {
    const list = [
      scenario({ name: "A" }),
      scenario({ name: "B", isDefault: true }),
      scenario({ name: "C" }),
    ];
    const r = resolveTargetScenario(list, { isMutation: true });
    assert.equal(r.kind === "found" && r.scenario.name, "B");
  });

  it("several non-default + mutation + no name → disambiguate (never guess)", () => {
    const list = [scenario({ name: "A" }), scenario({ name: "B" })];
    const r = resolveTargetScenario(list, { isMutation: true });
    assert.equal(r.kind, "disambiguate");
    assert.equal(r.kind === "disambiguate" && r.candidates.length, 2);
  });

  it("several non-default + READ + no name → most-recently-updated (list[0])", () => {
    const list = [scenario({ name: "Newest" }), scenario({ name: "Older" })];
    const r = resolveTargetScenario(list, { isMutation: false });
    assert.equal(r.kind === "found" && r.scenario.name, "Newest");
  });

  it("an unmatched name falls through to the default/disambiguate logic", () => {
    const list = [
      scenario({ name: "A" }),
      scenario({ name: "B", isDefault: true }),
    ];
    const r = resolveTargetScenario(list, {
      nameHint: "Nonexistent",
      isMutation: true,
    });
    assert.equal(r.kind === "found" && r.scenario.name, "B");
  });
});

describe("stripTargetingPrefix — leaves a clean command for the parser", () => {
  it("strips 'on <name>,' so the command hits the deterministic parser", () => {
    assert.equal(
      stripTargetingPrefix("on master22, increase my sip to 80k", "Master22"),
      "increase my sip to 80k"
    );
  });

  it("strips 'update my <name> to'", () => {
    assert.equal(
      stripTargetingPrefix("update my master22 to retire at 45", "Master22"),
      "retire at 45"
    );
  });

  it("strips a multi-word plan name", () => {
    assert.equal(
      stripTargetingPrefix(
        "on Sustainable FIRE at 50, set equity to 70%",
        "Sustainable FIRE at 50"
      ),
      "set equity to 70%"
    );
  });

  it("neutralizes an inline plan name to 'my plan' (so the LLM answers, not 'load it first')", () => {
    assert.equal(
      stripTargetingPrefix("is master22 on track?", "Master22"),
      "is my plan on track?"
    );
  });

  it("never strips down to nothing", () => {
    assert.equal(
      stripTargetingPrefix("on Master22", "Master22"),
      "on Master22"
    );
  });
});
