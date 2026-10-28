/**
 * Relative Valuation Skill - Plan builder & trigger tests
 *
 * Source of truth: packages/research/src/skills/relative-valuation.ts
 *
 * The skill reports where a stock trades vs its peers & sector (peer
 * multiple table, sector-aggregate medians, premium/discount, and
 * historical valuation bands). This suite imports the real skill and
 * validates its identity, trigger regexes, and the shape of the plan
 * produced by buildPlan().
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { relativeValuationSkill } from "../../../../packages/research/src/skills/relative-valuation";

describe("relativeValuationSkill", () => {
  // ──────────────────────────────────────────────────────────────
  // 1. Identity + required params
  // ──────────────────────────────────────────────────────────────
  describe("identity", () => {
    it("has name 'relative-valuation'", () => {
      assert.strictEqual(relativeValuationSkill.name, "relative-valuation");
    });

    it("requires the 'symbol' param", () => {
      assert.ok(
        relativeValuationSkill.requiredParams.includes("symbol"),
        "requiredParams should include 'symbol'"
      );
    });
  });

  // ──────────────────────────────────────────────────────────────
  // 2. Plan shape: non-empty, synthesis last, deps cover all others
  // ──────────────────────────────────────────────────────────────
  describe("buildPlan({ symbol: 'TCS' })", () => {
    const plan = relativeValuationSkill.buildPlan({ symbol: "TCS" });

    it("returns a plan with a non-empty task list", () => {
      assert.ok(Array.isArray(plan.tasks), "tasks must be an array");
      assert.ok(plan.tasks.length > 0, "tasks must be non-empty");
    });

    it("tags the plan skill as 'relative-valuation'", () => {
      assert.strictEqual(plan.skill, "relative-valuation");
    });

    it("ends with a synthesize_report task whose dependsOn covers every other task id", () => {
      const lastTask = plan.tasks[plan.tasks.length - 1]!;
      assert.strictEqual(
        lastTask.tool,
        "synthesize_report",
        "the final task must be the synthesize_report tool"
      );

      const otherIds = plan.tasks
        .slice(0, plan.tasks.length - 1)
        .map((t) => t.id);
      const deps = new Set(lastTask.dependsOn);

      for (const id of otherIds) {
        assert.ok(
          deps.has(id),
          `synthesize_report.dependsOn should cover task '${id}'`
        );
      }
    });
  });

  // ──────────────────────────────────────────────────────────────
  // 3. Required compute tools are present in the plan
  // ──────────────────────────────────────────────────────────────
  describe("plan compute tools", () => {
    const plan = relativeValuationSkill.buildPlan({ symbol: "TCS" });
    const tools = plan.tasks.map((t) => t.tool);

    const requiredComputeTools = [
      "compute_comparative_valuation",
      "compute_relative_valuation",
      "compute_sector_aggregates",
      "compute_valuation_bands",
    ];

    for (const tool of requiredComputeTools) {
      it(`includes the ${tool} compute task`, () => {
        assert.ok(
          tools.includes(tool),
          `plan should include compute tool '${tool}'`
        );
      });
    }
  });

  // ──────────────────────────────────────────────────────────────
  // 4. Triggers: peer-valuation query matches, bare "analyze" does not
  // ──────────────────────────────────────────────────────────────
  describe("triggers", () => {
    const matchQuery =
      "How does TCS look on a relative valuation vs peers — is it cheaper or more expensive than its peers on sector multiples?";
    const noMatchQuery = "analyze TCS";

    it("at least one trigger matches a relative-valuation-vs-peers query", () => {
      const matched = relativeValuationSkill.triggers.some((re) =>
        re.test(matchQuery)
      );
      assert.ok(
        matched,
        "a peer relative-valuation query should match a trigger"
      );
    });

    it("no trigger matches a bare 'analyze TCS' query", () => {
      const matched = relativeValuationSkill.triggers.some((re) =>
        re.test(noMatchQuery)
      );
      assert.ok(
        !matched,
        "'analyze TCS' should not match any relative-valuation trigger"
      );
    });
  });
});
