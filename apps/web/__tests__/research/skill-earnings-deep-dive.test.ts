/**
 * Earnings Deep Dive Skill Tests
 *
 * Exercises packages/research/src/skills/earnings-deep-dive.ts:
 *   - skill identity & required params
 *   - buildPlan structure (tasks, synthesis dependency fan-in)
 *   - presence of the earnings compute tools
 *   - trigger matching (positive + negative)
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { earningsDeepDiveSkill } from "../../../../packages/research/src/skills/earnings-deep-dive";

describe("earningsDeepDiveSkill", () => {
  it("has the expected name and requires the symbol param", () => {
    assert.equal(earningsDeepDiveSkill.name, "earnings-deep-dive");
    assert.ok(
      earningsDeepDiveSkill.requiredParams.includes("symbol"),
      "requiredParams should include 'symbol'"
    );
  });

  it("buildPlan returns a plan whose final synthesize_report depends on every other task", () => {
    const plan = earningsDeepDiveSkill.buildPlan({ symbol: "TCS" });

    assert.equal(plan.skill, "earnings-deep-dive");
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

  it("includes each of the earnings compute tools in the plan", () => {
    const plan = earningsDeepDiveSkill.buildPlan({ symbol: "TCS" });
    const tools = plan.tasks.map((t) => t.tool);

    for (const tool of [
      "compute_earnings_quality",
      "compute_earnings_estimates",
      "compute_earnings_surprise",
      "compute_guidance_sensitivity",
      "compute_growth_metrics",
    ]) {
      assert.ok(
        tools.includes(tool),
        `plan task tools should include '${tool}'`
      );
    }
  });

  it("matches earnings deep dive queries but not generic analysis queries", () => {
    const positive =
      "earnings deep dive of TCS with guidance sensitivity and EPS surprise history";
    const negative = "analyze TCS";

    const matchesPositive = earningsDeepDiveSkill.triggers.some((re) =>
      re.test(positive)
    );
    assert.ok(
      matchesPositive,
      `at least one trigger should match '${positive}'`
    );

    const matchesNegative = earningsDeepDiveSkill.triggers.some((re) =>
      re.test(negative)
    );
    assert.ok(!matchesNegative, `no trigger should match '${negative}'`);
  });
});
