/**
 * Regime & Volatility Skill Tests
 * (packages/research/src/skills/regime-volatility.ts)
 *
 * Verifies:
 *   - skill identity + required params
 *   - buildPlan task graph shape (non-empty, synthesize_report terminal,
 *     dependsOn covers all other task ids)
 *   - required compute tools are present in the plan
 *   - trigger regexes match volatility-regime phrasing and not a plain
 *     symbol query
 *   - plan.skill identity
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { regimeVolatilitySkill } from "../../../../packages/research/src/skills/regime-volatility";

describe("Regime & Volatility Skill", () => {
  it("has name 'regime-volatility' and requires the 'symbol' param", () => {
    assert.strictEqual(regimeVolatilitySkill.name, "regime-volatility");
    assert.ok(
      regimeVolatilitySkill.requiredParams.includes("symbol"),
      "requiredParams should include 'symbol'"
    );
  });

  it("buildPlan produces a non-empty plan whose last task is synthesize_report depending on every other task", () => {
    const plan = regimeVolatilitySkill.buildPlan({ symbol: "TCS" });

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

  it("includes the required regime/risk compute tools", () => {
    const plan = regimeVolatilitySkill.buildPlan({ symbol: "TCS" });
    const tools = plan.tasks.map((t) => t.tool);

    assert.ok(
      tools.includes("compute_volatility_regime"),
      "plan should include compute_volatility_regime"
    );
    assert.ok(
      tools.includes("compute_drawdown_profile"),
      "plan should include compute_drawdown_profile"
    );
    assert.ok(
      tools.includes("compute_beta_decomposition"),
      "plan should include compute_beta_decomposition"
    );
  });

  it("triggers match volatility-regime phrasing but not a plain symbol query", () => {
    const matchesRegime = regimeVolatilitySkill.triggers.some((re) =>
      re.test("volatility regime of TCS")
    );
    assert.ok(
      matchesRegime,
      "at least one trigger should match 'volatility regime of TCS'"
    );

    const matchesPlain = regimeVolatilitySkill.triggers.some((re) =>
      re.test("analyze TCS")
    );
    assert.ok(
      !matchesPlain,
      "no trigger should match a plain query like 'analyze TCS'"
    );
  });

  it("sets plan.skill to 'regime-volatility'", () => {
    const plan = regimeVolatilitySkill.buildPlan({ symbol: "TCS" });
    assert.strictEqual(plan.skill, "regime-volatility");
  });
});
