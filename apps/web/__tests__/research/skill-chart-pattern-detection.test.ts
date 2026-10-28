/**
 * Chart Pattern Detection Skill Tests
 * (packages/research/src/skills/chart-pattern-detection.ts)
 *
 * Verifies the skill metadata, plan shape, compute-tool coverage, and trigger
 * matching for the chart-pattern-detection research skill.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { chartPatternDetectionSkill } from "../../../../packages/research/src/skills/chart-pattern-detection";

describe("chart-pattern-detection skill", () => {
  it("has the correct name and requires the symbol param", () => {
    assert.strictEqual(
      chartPatternDetectionSkill.name,
      "chart-pattern-detection"
    );
    assert.ok(
      chartPatternDetectionSkill.requiredParams.includes("symbol"),
      "requiredParams should include 'symbol'"
    );
  });

  it("buildPlan returns a well-formed plan ending in synthesize_report", () => {
    const plan = chartPatternDetectionSkill.buildPlan({ symbol: "TCS" });

    assert.ok(Array.isArray(plan.tasks), "plan.tasks should be an array");
    assert.ok(plan.tasks.length > 0, "plan.tasks should be non-empty");

    const lastTask = plan.tasks[plan.tasks.length - 1]!;
    assert.strictEqual(
      lastTask.tool,
      "synthesize_report",
      "last task tool should be synthesize_report"
    );

    // The synthesis task must depend on every other task in the plan.
    const otherTaskIds = plan.tasks
      .slice(0, plan.tasks.length - 1)
      .map((t) => t.id);
    for (const id of otherTaskIds) {
      assert.ok(
        lastTask.dependsOn.includes(id),
        `synthesize_report dependsOn should cover task id '${id}'`
      );
    }
  });

  it("plan includes the expected pattern-detection compute tools", () => {
    const plan = chartPatternDetectionSkill.buildPlan({ symbol: "TCS" });
    const tools = plan.tasks.map((t) => t.tool);

    assert.ok(
      tools.includes("detect_chart_patterns"),
      "plan should include detect_chart_patterns"
    );
    assert.ok(
      tools.includes("detect_candlestick_patterns"),
      "plan should include detect_candlestick_patterns"
    );
    assert.ok(
      tools.includes("detect_breakout_setups"),
      "plan should include detect_breakout_setups"
    );
  });

  it("plan.skill identifies the chart-pattern-detection skill", () => {
    const plan = chartPatternDetectionSkill.buildPlan({ symbol: "TCS" });
    assert.strictEqual(plan.skill, "chart-pattern-detection");
  });

  it("triggers match a pattern-detection query but not a generic analyze query", () => {
    const matching =
      "show me chart patterns and any cup and handle or head and shoulders breakout setup on TCS";
    const nonMatching = "analyze TCS";

    const matchesQuery = (query: string): boolean =>
      chartPatternDetectionSkill.triggers.some((re) => re.test(query));

    assert.ok(
      matchesQuery(matching),
      "at least one trigger should match the pattern-detection query"
    );
    assert.ok(
      !matchesQuery(nonMatching),
      "no trigger should match the generic 'analyze TCS' query"
    );
  });
});
