/**
 * Governance Flags Skill Tests
 *
 * Exercises packages/research/src/skills/governance-flags.ts:
 *   - skill identity & required params
 *   - buildPlan structure (tasks, synthesis dependency fan-in)
 *   - presence of the governance compute tool
 *   - trigger matching (positive + negative)
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { governanceFlagsSkill } from "../../../../packages/research/src/skills/governance-flags";

describe("governanceFlagsSkill", () => {
  it("has the expected name and requires the symbol param", () => {
    assert.equal(governanceFlagsSkill.name, "governance-flags");
    assert.ok(
      governanceFlagsSkill.requiredParams.includes("symbol"),
      "requiredParams should include 'symbol'"
    );
  });

  it("buildPlan returns a plan whose final synthesize_report depends on every other task", () => {
    const plan = governanceFlagsSkill.buildPlan({ symbol: "TCS" });

    assert.equal(plan.skill, "governance-flags");
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

  it("includes the governance compute tool in the plan", () => {
    const plan = governanceFlagsSkill.buildPlan({ symbol: "TCS" });
    const tools = plan.tasks.map((t) => t.tool);

    for (const tool of ["compute_governance_flags"]) {
      assert.ok(
        tools.includes(tool),
        `plan task tools should include '${tool}'`
      );
    }
  });

  it("matches governance queries but not generic analysis queries", () => {
    const positive =
      "corporate governance red flags and promoter pledge for Suzlon";
    const negative = "analyze TCS";

    const matchesPositive = governanceFlagsSkill.triggers.some((re) =>
      re.test(positive)
    );
    assert.ok(
      matchesPositive,
      `at least one trigger should match '${positive}'`
    );

    const matchesNegative = governanceFlagsSkill.triggers.some((re) =>
      re.test(negative)
    );
    assert.ok(!matchesNegative, `no trigger should match '${negative}'`);
  });
});
