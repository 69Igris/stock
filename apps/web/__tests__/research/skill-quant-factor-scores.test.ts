/**
 * Quant Factor Scores Skill Tests
 *
 * Tests for packages/research/src/skills/quant-factor-scores.ts
 *   - skill metadata (name, requiredParams)
 *   - buildPlan structure (tasks, synthesis terminal task, dependsOn coverage)
 *   - presence of factor compute tools
 *   - trigger matching / non-matching
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { quantFactorScoresSkill } from "../../../../packages/research/src/skills/quant-factor-scores";

describe("Quant Factor Scores Skill", () => {
  it("has name 'quant-factor-scores' and requires the symbol param", () => {
    assert.strictEqual(quantFactorScoresSkill.name, "quant-factor-scores");
    assert.ok(
      quantFactorScoresSkill.requiredParams.includes("symbol"),
      "requiredParams should include 'symbol'"
    );
  });

  it("builds a plan whose last task is synthesize_report depending on all other tasks", () => {
    const plan = quantFactorScoresSkill.buildPlan({ symbol: "TCS" });

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

  it("includes the required factor compute tools", () => {
    const plan = quantFactorScoresSkill.buildPlan({ symbol: "TCS" });
    const tools = plan.tasks.map((t) => t.tool);

    assert.ok(
      tools.includes("compute_factor_scores"),
      "plan should include compute_factor_scores"
    );
    assert.ok(
      tools.includes("compute_factor_zscore"),
      "plan should include compute_factor_zscore"
    );
    assert.ok(
      tools.includes("compute_composite_quant_score"),
      "plan should include compute_composite_quant_score"
    );
  });

  it("sets plan.skill to 'quant-factor-scores'", () => {
    const plan = quantFactorScoresSkill.buildPlan({ symbol: "TCS" });
    assert.strictEqual(plan.skill, "quant-factor-scores");
  });

  it("triggers on a multi-factor quant query but not on a generic analyze query", () => {
    const factorQuery =
      "run a multi-factor quant score on TCS — value, quality and momentum factor exposure";
    const matches = quantFactorScoresSkill.triggers.some((re) =>
      re.test(factorQuery)
    );
    assert.ok(
      matches,
      "at least one trigger should match the multi-factor quant query"
    );

    const genericQuery = "analyze TCS";
    const genericMatches = quantFactorScoresSkill.triggers.some((re) =>
      re.test(genericQuery)
    );
    assert.ok(
      !genericMatches,
      "no trigger should match the generic 'analyze TCS' query"
    );
  });
});
