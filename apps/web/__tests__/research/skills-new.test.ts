/**
 * "New" research skills — REAL source (MONEY-620 de-shadow).
 *
 * This file used to inline *simplified* plan builders (earnings = 8 tasks,
 * financial-deep-dive = 12, investment-thesis = 4) and assert those copies. The
 * real registered skills are far richer — financial-deep-dive now emits 18
 * tasks (adds Piotroski / Altman-Z / Beneish-M / working-capital-drag / FCF-yield
 * / capex-intensity), investment-thesis 17, multi-comparison 50 (per-symbol
 * blocks + compare_stocks). The shadow stayed green regardless.
 *
 * It now drives the REAL skills via `getSkill(name).buildPlan(...)` from
 * `packages/research/src/skills/index.ts` and asserts the actual plan shape
 * (current task counts + the structural invariants every plan must satisfy).
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { getSkill } from "@usemoney/research/skills";
import type { ResearchPlan } from "@usemoney/research/types";

function assertPlanInvariants(plan: ResearchPlan): void {
  assert.strictEqual(plan.estimatedSteps, plan.tasks.length);
  assert.ok(plan.tasks.every((t) => t.status === "pending"));
  const ids = plan.tasks.map((t) => t.id);
  assert.strictEqual(new Set(ids).size, ids.length, "task ids must be unique");
  // every dependsOn id references a real task id
  const idSet = new Set(ids);
  for (const t of plan.tasks) {
    for (const dep of t.dependsOn) {
      assert.ok(idSet.has(dep), `task ${t.id} depends on missing id ${dep}`);
    }
  }
  // ends with a synthesis task
  assert.strictEqual(plan.tasks[plan.tasks.length - 1]!.type, "synthesis");
}

const tools = (plan: ResearchPlan) => plan.tasks.map((t) => t.tool);

describe("earnings-analysis skill (real)", () => {
  const plan = getSkill("earnings-analysis")!.buildPlan({ symbol: "TCS" });

  it("is a moderate plan named earnings-analysis on the resolved symbol", () => {
    assert.strictEqual(plan.skill, "earnings-analysis");
    assert.strictEqual(plan.complexity, "moderate");
    assert.deepStrictEqual(plan.symbols, ["TCS.NS"]);
  });

  it("includes the earnings fetch + earnings-surprise computation", () => {
    assert.ok(tools(plan).includes("fetch_earnings"));
    const surprise = plan.tasks.find(
      (t) => t.tool === "compute_earnings_surprise"
    );
    assert.ok(surprise);
    assert.ok(surprise.dependsOn.includes("earnings"));
  });

  it("emits 8 tasks and satisfies the invariants", () => {
    assert.strictEqual(plan.tasks.length, 8);
    assertPlanInvariants(plan);
  });
});

describe("financial-deep-dive skill (real)", () => {
  const plan = getSkill("financial-deep-dive")!.buildPlan({
    symbol: "RELIANCE",
  });

  it("is a complex plan named financial-deep-dive", () => {
    assert.strictEqual(plan.skill, "financial-deep-dive");
    assert.strictEqual(plan.complexity, "complex");
    assert.deepStrictEqual(plan.symbols, ["RELIANCE.NS"]);
  });

  it("fetches all three financial statements", () => {
    const t = tools(plan);
    assert.ok(t.includes("fetch_income_statement"));
    assert.ok(t.includes("fetch_balance_sheet"));
    assert.ok(t.includes("fetch_cash_flow"));
  });

  it("includes the institutional quality computations (accounting/Altman-Z/Beneish-M)", () => {
    const t = tools(plan);
    assert.ok(t.includes("compute_accounting_quality"));
    assert.ok(t.includes("compute_altman_z"));
    assert.ok(t.includes("compute_beneish_m"));
  });

  it("emits 18 tasks (the real richer plan, not the old 12-task shadow)", () => {
    assert.strictEqual(plan.tasks.length, 18);
    assertPlanInvariants(plan);
  });
});

describe("investment-thesis skill (real)", () => {
  const plan = getSkill("investment-thesis")!.buildPlan({ symbol: "INFY" });

  it("is a complex plan named investment-thesis", () => {
    assert.strictEqual(plan.skill, "investment-thesis");
    assert.strictEqual(plan.complexity, "complex");
    assert.deepStrictEqual(plan.symbols, ["INFY.NS"]);
  });

  it("includes valuation (WACC + DCF) and a peer comparison", () => {
    const t = tools(plan);
    assert.ok(t.includes("compute_wacc"));
    assert.ok(t.includes("compute_dcf"));
    assert.ok(t.includes("fetch_peer_companies"));
  });

  it("emits 17 tasks and satisfies the invariants", () => {
    assert.strictEqual(plan.tasks.length, 17);
    assertPlanInvariants(plan);
  });
});

describe("multi-comparison skill (real)", () => {
  const plan = getSkill("multi-comparison")!.buildPlan({
    symbols: ["TCS", "INFY", "WIPRO"],
  });

  it("is a complex plan resolving every symbol to Yahoo format", () => {
    assert.strictEqual(plan.skill, "multi-comparison");
    assert.strictEqual(plan.complexity, "complex");
    assert.deepStrictEqual(plan.symbols, ["TCS.NS", "INFY.NS", "WIPRO.NS"]);
  });

  it("ends with compare_stocks → synthesize_report", () => {
    const t = tools(plan);
    assert.ok(t.includes("compare_stocks"));
    assert.strictEqual(
      plan.tasks[plan.tasks.length - 1]!.tool,
      "synthesize_report"
    );
  });

  it("emits a per-symbol block plan (3 symbols → 50 tasks)", () => {
    assert.strictEqual(plan.tasks.length, 50);
    assertPlanInvariants(plan);
  });
});

describe("portfolio-optimization skill (real)", () => {
  const plan = getSkill("portfolio-optimization")!.buildPlan({
    holdings: [
      { symbol: "TCS", quantity: 10, avgPrice: 3500 },
      { symbol: "INFY", quantity: 20, avgPrice: 1500 },
    ],
  });

  it("is a complex risk-optimisation plan", () => {
    assert.strictEqual(plan.skill, "portfolio-optimization");
    assert.strictEqual(plan.complexity, "complex");
  });

  it("includes concentration / correlation / VaR / rebalancing computations", () => {
    const t = tools(plan);
    assert.ok(t.includes("compute_portfolio_concentration"));
    assert.ok(t.includes("compute_correlation_matrix"));
    assert.ok(t.includes("compute_var"));
    assert.ok(t.includes("compute_rebalancing"));
  });

  it("emits 7 tasks and satisfies the invariants", () => {
    assert.strictEqual(plan.tasks.length, 7);
    assertPlanInvariants(plan);
  });
});
