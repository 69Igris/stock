/**
 * Macro Sensitivities Skill Tests
 * (packages/research/src/skills/macro-sensitivities.ts)
 *
 * Verifies:
 *   - skill identity + required params
 *   - buildPlan task graph shape (non-empty, synthesize_report terminal,
 *     dependsOn covers all other task ids)
 *   - required compute tools are present in the plan
 *   - trigger regexes match macro/rate phrasing and not a plain symbol query
 *   - plan.skill identity
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { macroSensitivitiesSkill } from "../../../../packages/research/src/skills/macro-sensitivities";

describe("Macro Sensitivities Skill", () => {
  it("has name 'macro-sensitivities' and requires the 'symbol' param", () => {
    assert.strictEqual(macroSensitivitiesSkill.name, "macro-sensitivities");
    assert.ok(
      macroSensitivitiesSkill.requiredParams.includes("symbol"),
      "requiredParams should include 'symbol'"
    );
  });

  it("buildPlan produces a non-empty plan whose last task is synthesize_report depending on every other task", () => {
    const plan = macroSensitivitiesSkill.buildPlan({ symbol: "TCS" });

    assert.ok(plan.tasks.length > 0, "tasks should be non-empty");

    const last = plan.tasks[plan.tasks.length - 1]!;
    assert.strictEqual(
      last.tool,
      "synthesize_report",
      "last task tool should be synthesize_report"
    );

    const otherIds = plan.tasks.slice(0, -1).map((t) => t.id);
    for (const id of otherIds) {
      assert.ok(
        last.dependsOn.includes(id),
        `synthesize_report dependsOn should cover task '${id}'`
      );
    }
  });

  it("includes the required macro compute tools", () => {
    const plan = macroSensitivitiesSkill.buildPlan({ symbol: "TCS" });
    const tools = plan.tasks.map((t) => t.tool);

    assert.ok(
      tools.includes("compute_macro_impact"),
      "plan should include compute_macro_impact"
    );
    assert.ok(
      tools.includes("compute_commodity_correlation"),
      "plan should include compute_commodity_correlation"
    );
    assert.ok(
      tools.includes("compute_rate_sensitivity"),
      "plan should include compute_rate_sensitivity"
    );
  });

  it("triggers match rate-sensitivity phrasing but not a plain symbol query", () => {
    const matchesRate = macroSensitivitiesSkill.triggers.some((re) =>
      re.test("interest rate sensitivity of SBI")
    );
    assert.ok(
      matchesRate,
      "at least one trigger should match 'interest rate sensitivity of SBI'"
    );

    const matchesPlain = macroSensitivitiesSkill.triggers.some((re) =>
      re.test("analyze TCS")
    );
    assert.ok(
      !matchesPlain,
      "no trigger should match a plain query like 'analyze TCS'"
    );
  });

  it("sets plan.skill to 'macro-sensitivities'", () => {
    const plan = macroSensitivitiesSkill.buildPlan({ symbol: "TCS" });
    assert.strictEqual(plan.skill, "macro-sensitivities");
  });
});
