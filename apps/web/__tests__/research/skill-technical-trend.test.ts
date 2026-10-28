/**
 * Technical Trend Skill Tests
 * (packages/research/src/skills/technical-trend.ts)
 *
 * Verifies the skill metadata, plan shape, compute-tool coverage, and trigger
 * matching for the technical-trend research skill.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { technicalTrendSkill } from "../../../../packages/research/src/skills/technical-trend";

describe("technical-trend skill", () => {
  it("has the correct name and requires the symbol param", () => {
    assert.strictEqual(technicalTrendSkill.name, "technical-trend");
    assert.ok(
      technicalTrendSkill.requiredParams.includes("symbol"),
      "requiredParams should include 'symbol'"
    );
  });

  it("buildPlan returns a well-formed plan ending in synthesize_report", () => {
    const plan = technicalTrendSkill.buildPlan({ symbol: "TCS" });

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

  it("plan includes the expected technical compute tools", () => {
    const plan = technicalTrendSkill.buildPlan({ symbol: "TCS" });
    const tools = plan.tasks.map((t) => t.tool);

    assert.ok(
      tools.includes("compute_technical_analysis"),
      "plan should include compute_technical_analysis"
    );
    assert.ok(
      tools.includes("compute_volume_profile"),
      "plan should include compute_volume_profile"
    );
    assert.ok(
      tools.includes("compute_trend_strength"),
      "plan should include compute_trend_strength"
    );
  });

  it("plan.skill identifies the technical-trend skill", () => {
    const plan = technicalTrendSkill.buildPlan({ symbol: "TCS" });
    assert.strictEqual(plan.skill, "technical-trend");
  });

  it("triggers match a technical/trend query but not a generic analyze query", () => {
    const matching = "technical analysis and trend strength of TCS";
    const nonMatching = "analyze TCS";

    const matchesQuery = (query: string): boolean =>
      technicalTrendSkill.triggers.some((re) => re.test(query));

    assert.ok(
      matchesQuery(matching),
      "at least one trigger should match the technical/trend query"
    );
    assert.ok(
      !matchesQuery(nonMatching),
      "no trigger should match the generic 'analyze TCS' query"
    );
  });
});
