/**
 * DCF Valuation Skill (v2) Tests
 *
 * Tests for packages/research/src/skills/dcf-valuation-v2.ts
 *   - skill metadata (name, requiredParams)
 *   - buildPlan structure (tasks, synthesis terminal task, dependsOn coverage)
 *   - presence of the valuation compute tools
 *   - plan.skill identity
 *   - trigger matching / non-matching
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { dcfValuationSkill } from "../../../../packages/research/src/skills/dcf-valuation-v2";

describe("DCF Valuation Skill (v2)", () => {
  it("has name 'dcf-valuation' and requires the symbol param", () => {
    assert.strictEqual(dcfValuationSkill.name, "dcf-valuation");
    assert.ok(
      dcfValuationSkill.requiredParams.includes("symbol"),
      "requiredParams should include 'symbol'"
    );
  });

  it("builds a plan whose last task is synthesize_report depending on all other tasks", () => {
    const plan = dcfValuationSkill.buildPlan({ symbol: "TCS" });

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
        `synthesis dependsOn should cover task '${id}'`
      );
    }
  });

  it("includes every required valuation compute tool", () => {
    const plan = dcfValuationSkill.buildPlan({ symbol: "TCS" });
    const tools = new Set(plan.tasks.map((t) => t.tool));

    const requiredTools = [
      "compute_wacc",
      "compute_dcf",
      "compute_ddm",
      "compute_valuation_bands",
      "compute_scenario_analysis",
      "compute_dcf_sensitivity",
    ];

    for (const tool of requiredTools) {
      assert.ok(tools.has(tool), `plan should include compute tool '${tool}'`);
    }
  });

  it("sets plan.skill to 'dcf-valuation'", () => {
    const plan = dcfValuationSkill.buildPlan({ symbol: "TCS" });
    assert.strictEqual(plan.skill, "dcf-valuation");
  });

  it("matches DCF/intrinsic-value/wacc intent and not a bare 'analyze'", () => {
    const matchQuery =
      "run a dcf valuation model on INFY and show me the intrinsic value and wacc";
    const matched = dcfValuationSkill.triggers.some((re) =>
      re.test(matchQuery)
    );
    assert.ok(
      matched,
      "at least one trigger should match a DCF/intrinsic-value/wacc query"
    );

    const noMatchQuery = "analyze TCS";
    const matchedNone = dcfValuationSkill.triggers.some((re) =>
      re.test(noMatchQuery)
    );
    assert.ok(
      !matchedNone,
      "no trigger should match a bare 'analyze TCS' query"
    );
  });
});
