/**
 * News, Sentiment & Catalysts Skill Tests
 *
 * Exercises packages/research/src/skills/news-sentiment-catalysts.ts:
 *   - skill identity & required params
 *   - buildPlan structure (tasks, synthesis dependency fan-in)
 *   - presence of the news-sentiment compute tool
 *   - trigger matching (positive + negative)
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { newsSentimentCatalystsSkill } from "../../../../packages/research/src/skills/news-sentiment-catalysts";

describe("newsSentimentCatalystsSkill", () => {
  it("has the expected name and requires the symbol param", () => {
    assert.equal(newsSentimentCatalystsSkill.name, "news-sentiment-catalysts");
    assert.ok(
      newsSentimentCatalystsSkill.requiredParams.includes("symbol"),
      "requiredParams should include 'symbol'"
    );
  });

  it("buildPlan returns a plan whose final synthesize_report depends on every other task", () => {
    const plan = newsSentimentCatalystsSkill.buildPlan({ symbol: "TCS" });

    assert.equal(plan.skill, "news-sentiment-catalysts");
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

  it("includes the news-sentiment compute tool in the plan", () => {
    const plan = newsSentimentCatalystsSkill.buildPlan({ symbol: "TCS" });
    const tools = plan.tasks.map((t) => t.tool);

    for (const tool of ["compute_news_sentiment"]) {
      assert.ok(
        tools.includes(tool),
        `plan task tools should include '${tool}'`
      );
    }
  });

  it("matches news-sentiment queries but not generic analysis queries", () => {
    const positive = "news sentiment analysis for TCS";
    const negative = "analyze TCS";

    const matchesPositive = newsSentimentCatalystsSkill.triggers.some((re) =>
      re.test(positive)
    );
    assert.ok(
      matchesPositive,
      `at least one trigger should match '${positive}'`
    );

    const matchesNegative = newsSentimentCatalystsSkill.triggers.some((re) =>
      re.test(negative)
    );
    assert.ok(!matchesNegative, `no trigger should match '${negative}'`);
  });
});
