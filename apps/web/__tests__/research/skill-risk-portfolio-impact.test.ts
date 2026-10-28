/**
 * Risk & Portfolio Impact Skill Tests
 * (packages/research/src/skills/risk-portfolio-impact.ts)
 *
 * Verifies:
 *   - skill identity + required params
 *   - buildPlan task graph shape (non-empty, synthesize_report terminal,
 *     dependsOn covers all other task ids)
 *   - required position-VaR / portfolio-impact compute tools are present
 *   - trigger regexes match position-VaR + concentration phrasing and not a
 *     plain symbol query
 *   - plan.skill identity
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { riskPortfolioImpactSkill } from "../../../../packages/research/src/skills/risk-portfolio-impact";

describe("Risk & Portfolio Impact Skill", () => {
  it("has name 'risk-portfolio-impact' and requires the 'symbol' param", () => {
    assert.strictEqual(riskPortfolioImpactSkill.name, "risk-portfolio-impact");
    assert.ok(
      riskPortfolioImpactSkill.requiredParams.includes("symbol"),
      "requiredParams should include 'symbol'"
    );
  });

  it("buildPlan produces a non-empty plan whose last task is synthesize_report depending on every other task", () => {
    const plan = riskPortfolioImpactSkill.buildPlan({ symbol: "TCS" });

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

  it("includes the required position-VaR / portfolio-impact compute tools", () => {
    const plan = riskPortfolioImpactSkill.buildPlan({ symbol: "TCS" });
    const tools = plan.tasks.map((t) => t.tool);

    assert.ok(
      tools.includes("compute_position_var"),
      "plan should include compute_position_var"
    );
    assert.ok(
      tools.includes("compute_concentration_delta"),
      "plan should include compute_concentration_delta"
    );
    assert.ok(
      tools.includes("compute_portfolio_beta_drift"),
      "plan should include compute_portfolio_beta_drift"
    );
  });

  it("triggers match position-VaR / concentration phrasing but not a plain symbol query", () => {
    const matchesRisk = riskPortfolioImpactSkill.triggers.some((re) =>
      re.test("position VaR of TCS and its portfolio concentration impact")
    );
    assert.ok(
      matchesRisk,
      "at least one trigger should match the position-VaR / concentration query"
    );

    const matchesPlain = riskPortfolioImpactSkill.triggers.some((re) =>
      re.test("analyze TCS")
    );
    assert.ok(
      !matchesPlain,
      "no trigger should match a plain query like 'analyze TCS'"
    );
  });

  it("sets plan.skill to 'risk-portfolio-impact'", () => {
    const plan = riskPortfolioImpactSkill.buildPlan({ symbol: "TCS" });
    assert.strictEqual(plan.skill, "risk-portfolio-impact");
  });
});
