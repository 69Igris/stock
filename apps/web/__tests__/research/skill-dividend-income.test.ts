/**
 * Dividend Income Skill Tests
 *
 * Tests for packages/research/src/skills/dividend-income.ts
 *   - skill metadata (name, requiredParams)
 *   - buildPlan structure (tasks, synthesis terminal task, dependsOn coverage)
 *   - presence of dividend compute tools (ddm, dividend_analysis, payout_coverage)
 *   - plan.skill identifier
 *   - trigger matching / non-matching
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { dividendIncomeSkill } from "../../../../packages/research/src/skills/dividend-income";

describe("Dividend Income Skill", () => {
  it("has name 'dividend-income' and requires the symbol param", () => {
    assert.strictEqual(dividendIncomeSkill.name, "dividend-income");
    assert.ok(
      dividendIncomeSkill.requiredParams.includes("symbol"),
      "requiredParams should include 'symbol'"
    );
  });

  it("builds a plan whose last task is synthesize_report depending on all other tasks", () => {
    const plan = dividendIncomeSkill.buildPlan({ symbol: "TCS" });

    assert.ok(plan.tasks.length > 0, "tasks should be non-empty");

    const lastTask = plan.tasks[plan.tasks.length - 1]!;
    assert.strictEqual(
      lastTask.tool,
      "synthesize_report",
      "last task tool should be synthesize_report"
    );

    // dependsOn of the synthesis task must cover every other task id.
    const otherIds = plan.tasks
      .slice(0, plan.tasks.length - 1)
      .map((t) => t.id);
    for (const id of otherIds) {
      assert.ok(
        lastTask.dependsOn.includes(id),
        `synthesize_report dependsOn should include "${id}"`
      );
    }
  });

  it("includes the required dividend compute tools", () => {
    const plan = dividendIncomeSkill.buildPlan({ symbol: "TCS" });
    const tools = plan.tasks.map((t) => t.tool);

    assert.ok(tools.includes("compute_ddm"), "plan should include compute_ddm");
    assert.ok(
      tools.includes("compute_dividend_analysis"),
      "plan should include compute_dividend_analysis"
    );
    assert.ok(
      tools.includes("compute_payout_coverage"),
      "plan should include compute_payout_coverage"
    );
  });

  it("sets plan.skill to 'dividend-income'", () => {
    const plan = dividendIncomeSkill.buildPlan({ symbol: "TCS" });
    assert.strictEqual(plan.skill, "dividend-income");
  });

  it("triggers on a dividend-safety/payout query but not on a generic analyze query", () => {
    const dividendQuery =
      "Is the dividend safe and sustainable for ITC? Show payout ratio and coverage.";
    const matches = dividendIncomeSkill.triggers.some((re) =>
      re.test(dividendQuery)
    );
    assert.ok(
      matches,
      "at least one trigger should match the dividend safety/payout query"
    );

    const genericQuery = "analyze TCS";
    const genericMatches = dividendIncomeSkill.triggers.some((re) =>
      re.test(genericQuery)
    );
    assert.ok(
      !genericMatches,
      "no trigger should match the generic 'analyze TCS' query"
    );
  });
});
