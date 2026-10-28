/**
 * Cash Flow Quality Skill Tests
 *
 * Exercises packages/research/src/skills/cash-flow-quality.ts:
 *   - skill identity & required params
 *   - buildPlan structure (tasks, synthesis dependency fan-in)
 *   - presence of the cash-flow compute tools
 *   - trigger matching (positive + negative)
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { cashFlowQualitySkill } from "../../../../packages/research/src/skills/cash-flow-quality";

describe("cashFlowQualitySkill", () => {
  it("has the expected name and requires the symbol param", () => {
    assert.equal(cashFlowQualitySkill.name, "cash-flow-quality");
    assert.ok(
      cashFlowQualitySkill.requiredParams.includes("symbol"),
      "requiredParams should include 'symbol'"
    );
  });

  it("buildPlan returns a plan whose final synthesize_report depends on every other task", () => {
    const plan = cashFlowQualitySkill.buildPlan({ symbol: "TCS" });

    assert.equal(plan.skill, "cash-flow-quality");
    assert.ok(Array.isArray(plan.tasks), "tasks should be an array");
    assert.ok(plan.tasks.length > 0, "tasks should be non-empty");

    const lastTask = plan.tasks[plan.tasks.length - 1];
    assert.equal(
      lastTask.tool,
      "synthesize_report",
      "last task tool should be synthesize_report"
    );

    // The synthesis task must depend on the ids of all other tasks.
    const otherIds = plan.tasks
      .slice(0, plan.tasks.length - 1)
      .map((t) => t.id);
    for (const id of otherIds) {
      assert.ok(
        lastTask.dependsOn.includes(id),
        `synthesize_report dependsOn should cover task id '${id}'`
      );
    }
  });

  it("includes each of the cash-flow compute tools in the plan", () => {
    const plan = cashFlowQualitySkill.buildPlan({ symbol: "TCS" });
    const tools = plan.tasks.map((t) => t.tool);

    for (const tool of [
      "compute_cash_flow_quality",
      "compute_capex_intensity",
      "compute_fcf_yield",
      "compute_working_capital_drag",
    ]) {
      assert.ok(
        tools.includes(tool),
        `plan task tools should include '${tool}'`
      );
    }
  });

  it("matches cash-flow queries but not generic analysis queries", () => {
    const positive = "cash flow quality and fcf yield of TCS";
    const negative = "analyze TCS";

    const matchesPositive = cashFlowQualitySkill.triggers.some((re) =>
      re.test(positive)
    );
    assert.ok(
      matchesPositive,
      `at least one trigger should match '${positive}'`
    );

    const matchesNegative = cashFlowQualitySkill.triggers.some((re) =>
      re.test(negative)
    );
    assert.ok(!matchesNegative, `no trigger should match '${negative}'`);
  });
});
