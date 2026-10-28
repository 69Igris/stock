/**
 * Flows & Positioning Skill Tests
 * (packages/research/src/skills/flows-and-positioning.ts)
 *
 * Verifies:
 *   - skill identity + required params
 *   - buildPlan task graph shape (non-empty, synthesize_report terminal,
 *     dependsOn covers all other task ids)
 *   - required compute tools are present in the plan
 *   - trigger regexes match institutional-flow/positioning phrasing and not a
 *     plain symbol query
 *   - plan.skill identity
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { flowsAndPositioningSkill } from "../../../../packages/research/src/skills/flows-and-positioning";

describe("Flows & Positioning Skill", () => {
  it("has name 'flows-and-positioning' and requires the 'symbol' param", () => {
    assert.strictEqual(flowsAndPositioningSkill.name, "flows-and-positioning");
    assert.ok(
      flowsAndPositioningSkill.requiredParams.includes("symbol"),
      "requiredParams should include 'symbol'"
    );
  });

  it("buildPlan produces a non-empty plan whose last task is synthesize_report depending on every other task", () => {
    const plan = flowsAndPositioningSkill.buildPlan({ symbol: "TCS" });

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

  it("includes the compute_sector_rotation tool", () => {
    const plan = flowsAndPositioningSkill.buildPlan({ symbol: "TCS" });
    const tools = plan.tasks.map((t) => t.tool);

    assert.ok(
      tools.includes("compute_sector_rotation"),
      "plan should include compute_sector_rotation"
    );
  });

  it("triggers match institutional-flows/positioning phrasing but not a plain symbol query", () => {
    const matchesFlows = flowsAndPositioningSkill.triggers.some((re) =>
      re.test(
        "show me institutional flows and FII/DII positioning around TCS, plus sector rotation and short interest"
      )
    );
    assert.ok(
      matchesFlows,
      "at least one trigger should match the institutional flows / positioning phrasing"
    );

    const matchesPlain = flowsAndPositioningSkill.triggers.some((re) =>
      re.test("analyze TCS")
    );
    assert.ok(
      !matchesPlain,
      "no trigger should match a plain query like 'analyze TCS'"
    );
  });

  it("sets plan.skill to 'flows-and-positioning'", () => {
    const plan = flowsAndPositioningSkill.buildPlan({ symbol: "TCS" });
    assert.strictEqual(plan.skill, "flows-and-positioning");
  });
});
