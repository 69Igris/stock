/**
 * Forward Scenarios Skill Tests
 * (packages/research/src/skills/forward-scenarios.ts)
 *
 * Verifies:
 *   - skill identity + required params
 *   - buildPlan task graph shape (non-empty, synthesize_report terminal,
 *     dependsOn covers all other task ids)
 *   - required compute tools are present in the plan
 *   - trigger regexes match a monte-carlo/probability phrasing and not a plain
 *     symbol query
 *   - plan.skill identity
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { forwardScenariosSkill } from "../../../../packages/research/src/skills/forward-scenarios";

describe("Forward Scenarios Skill", () => {
  it("has name 'forward-scenarios' and requires the 'symbol' param", () => {
    assert.strictEqual(forwardScenariosSkill.name, "forward-scenarios");
    assert.ok(
      forwardScenariosSkill.requiredParams.includes("symbol"),
      "requiredParams should include 'symbol'"
    );
  });

  it("buildPlan produces a non-empty plan whose last task is synthesize_report depending on every other task", () => {
    const plan = forwardScenariosSkill.buildPlan({ symbol: "TCS" });

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

  it("includes the required forward-scenario compute tools", () => {
    const plan = forwardScenariosSkill.buildPlan({ symbol: "TCS" });
    const tools = plan.tasks.map((t) => t.tool);

    assert.ok(
      tools.includes("compute_forward_scenarios"),
      "plan should include compute_forward_scenarios"
    );
    assert.ok(
      tools.includes("compute_monte_carlo_returns"),
      "plan should include compute_monte_carlo_returns"
    );
  });

  it("triggers match a monte-carlo / probability projection phrasing but not a plain symbol query", () => {
    const matchesMonteCarlo = forwardScenariosSkill.triggers.some((re) =>
      re.test(
        "run a monte carlo price projection and show me the probability of TCS hitting 4500"
      )
    );
    assert.ok(
      matchesMonteCarlo,
      "at least one trigger should match the monte-carlo projection phrasing"
    );

    const matchesPlain = forwardScenariosSkill.triggers.some((re) =>
      re.test("analyze TCS")
    );
    assert.ok(
      !matchesPlain,
      "no trigger should match a plain query like 'analyze TCS'"
    );
  });

  it("sets plan.skill to 'forward-scenarios'", () => {
    const plan = forwardScenariosSkill.buildPlan({ symbol: "TCS" });
    assert.strictEqual(plan.skill, "forward-scenarios");
  });
});
