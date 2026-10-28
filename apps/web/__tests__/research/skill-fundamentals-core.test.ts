/**
 * Fundamentals Core Skill Tests
 *
 * Tests for packages/research/src/skills/fundamentals-core.ts
 *   - skill metadata (name, requiredParams)
 *   - buildPlan structure (tasks, synthesis terminal task, dependsOn coverage)
 *   - presence of core fundamental compute tools
 *   - trigger matching / non-matching
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { fundamentalsCoreSkill } from "../../../../packages/research/src/skills/fundamentals-core";

describe("Fundamentals Core Skill", () => {
  it("has name 'fundamentals-core' and requires the symbol param", () => {
    assert.strictEqual(fundamentalsCoreSkill.name, "fundamentals-core");
    assert.ok(
      fundamentalsCoreSkill.requiredParams.includes("symbol"),
      "requiredParams should include 'symbol'"
    );
  });

  it("builds a plan whose last task is synthesize_report depending on all other tasks", () => {
    const plan = fundamentalsCoreSkill.buildPlan({ symbol: "TCS" });

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

  it("includes the required core fundamental compute tools", () => {
    const plan = fundamentalsCoreSkill.buildPlan({ symbol: "TCS" });
    const tools = plan.tasks.map((t) => t.tool);

    for (const tool of [
      "compute_health_score",
      "compute_growth_metrics",
      "compute_accounting_quality",
      "compute_revenue_mix",
      "compute_investment_score",
    ]) {
      assert.ok(tools.includes(tool), `plan should include ${tool}`);
    }
  });

  it("sets plan.skill to 'fundamentals-core'", () => {
    const plan = fundamentalsCoreSkill.buildPlan({ symbol: "TCS" });
    assert.strictEqual(plan.skill, "fundamentals-core");
  });

  it("triggers on a fundamental-health query but not on a generic analyze query", () => {
    const fundamentalQuery =
      "do a fundamental analysis of TCS and tell me how financially healthy it is";
    const matches = fundamentalsCoreSkill.triggers.some((re) =>
      re.test(fundamentalQuery)
    );
    assert.ok(
      matches,
      "at least one trigger should match the fundamental-health query"
    );

    const genericQuery = "analyze TCS";
    const genericMatches = fundamentalsCoreSkill.triggers.some((re) =>
      re.test(genericQuery)
    );
    assert.ok(
      !genericMatches,
      "no trigger should match the generic 'analyze TCS' query"
    );
  });
});
