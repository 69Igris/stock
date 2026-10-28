/**
 * MF Comparison Skill Tests
 *
 * Exercises packages/research/src/skills/mf-comparison.ts:
 *   - skill identity & required params
 *   - buildPlan structure: per-fund overview/holdings/analysis tasks,
 *     a cross-fund overlap task depending on both holdings tasks, and a
 *     final synthesize_report depending on every other task
 *   - plan.skill identity
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { mfComparisonSkill } from "../../../../packages/research/src/skills/mf-comparison";

describe("mfComparisonSkill", () => {
  it("has the expected name and requires the symbols param", () => {
    assert.equal(mfComparisonSkill.name, "mf-comparison");
    assert.ok(
      mfComparisonSkill.requiredParams.includes("symbols"),
      "requiredParams should include 'symbols'"
    );
  });

  it("buildPlan emits per-fund overview, holdings, and analysis tasks for every fund", () => {
    const plan = mfComparisonSkill.buildPlan({
      symbols: ["120503", "118989"],
    });

    assert.equal(plan.skill, "mf-comparison");
    assert.equal(plan.complexity, "complex");
    assert.deepEqual(plan.symbols, ["120503", "118989"]);
    assert.ok(Array.isArray(plan.tasks), "tasks should be an array");
    assert.equal(
      plan.estimatedSteps,
      plan.tasks.length,
      "estimatedSteps should equal task count"
    );

    for (let i = 0; i < 2; i++) {
      const prefix = `fund_${i}`;

      const overview = plan.tasks.find((t) => t.id === `${prefix}_overview`);
      assert.ok(overview, `plan should contain ${prefix}_overview`);
      assert.equal(overview.tool, "fetch_mf_overview");
      assert.equal(
        (overview.params as { symbol?: string }).symbol,
        i === 0 ? "120503" : "118989"
      );

      const holdings = plan.tasks.find((t) => t.id === `${prefix}_holdings`);
      assert.ok(holdings, `plan should contain ${prefix}_holdings`);
      assert.equal(holdings.tool, "fetch_mf_holdings");

      const analysis = plan.tasks.find((t) => t.id === `${prefix}_analysis`);
      assert.ok(analysis, `plan should contain ${prefix}_analysis`);
      assert.equal(analysis.tool, "compute_mf_analysis");
      assert.deepEqual(
        analysis.dependsOn,
        [`${prefix}_overview`, `${prefix}_holdings`],
        `${prefix}_analysis should depend on its overview + holdings`
      );
    }
  });

  it("emits a single cross-fund overlap task depending on every fund's holdings", () => {
    const plan = mfComparisonSkill.buildPlan({
      symbols: ["120503", "118989"],
    });

    const overlap = plan.tasks.find((t) => t.id === "overlap");
    assert.ok(overlap, "plan should contain an 'overlap' task");
    assert.equal(overlap.tool, "compute_holdings_overlap");
    assert.equal(overlap.type, "computation");
    assert.deepEqual(
      overlap.dependsOn,
      ["fund_0_holdings", "fund_1_holdings"],
      "overlap should depend on both funds' holdings tasks"
    );
  });

  it("ends with a synthesize_report that depends on all other tasks", () => {
    const plan = mfComparisonSkill.buildPlan({
      symbols: ["120503", "118989"],
    });

    const lastTask = plan.tasks[plan.tasks.length - 1];
    assert.equal(
      lastTask.tool,
      "synthesize_report",
      "last task tool should be synthesize_report"
    );
    assert.equal(
      (lastTask.params as { outputFormat?: string }).outputFormat,
      "mf_comparison"
    );

    const otherIds = plan.tasks
      .slice(0, plan.tasks.length - 1)
      .map((t) => t.id);
    for (const id of otherIds) {
      assert.ok(
        lastTask.dependsOn.includes(id),
        `synthesize_report dependsOn should cover task id '${id}'`
      );
    }
    assert.ok(
      lastTask.dependsOn.includes("overlap"),
      "synthesize_report should depend on the overlap task"
    );
  });

  it("does not regex-match raw user text (programmatic routing only)", () => {
    const queries = [
      "compare HDFC Flexi Cap vs Parag Parikh Flexi Cap",
      "120503 vs 118989",
      "which fund is better",
    ];
    for (const q of queries) {
      const matches = mfComparisonSkill.triggers.some((re) => re.test(q));
      assert.ok(!matches, `no trigger should match '${q}'`);
    }
  });
});
