/**
 * Planner Mode Routing - real-export tests
 * (packages/research/src/planner.ts)
 *
 * De-shadowed (MONEY-620 / task 185). The previous version reimplemented
 * `parsePlanResponse`, `buildFastFallbackPlan`, `buildAdvancedFallbackPlan`
 * and `extractSectorFromQuery` inline and asserted the copies. Auditing the
 * copy against source surfaced a release-relevant divergence the shadow hid:
 *
 *   • shadow `extractSectorFromQuery` returned "banking" as a DEFAULT when no
 *     sector keyword matched, and the shadow test asserted that. The REAL
 *     function returns `undefined` (MONEY-612 trust — never silently analyse
 *     the wrong sector). The shadow's assertion would fail against prod.
 *
 * These now drive the REAL planner functions (the same ones
 * ResearchPlanner.createPlan calls), so the production caps / fallbacks /
 * sector contract are actually under test.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  parsePlanResponse,
  buildFastFallbackPlan,
  buildAdvancedFallbackPlan,
  extractSectorFromQuery,
} from "@usemoney/research/planner";
import type { ResearchPlan } from "@usemoney/research";

function planJson(
  tasks: Array<{ id: string; tool: string; dependsOn?: string[] }>,
  extra: Record<string, unknown> = {}
): string {
  return JSON.stringify({
    symbols: ["RELIANCE"],
    tasks: tasks.map((t) => ({
      id: t.id,
      type: "data_fetch",
      tool: t.tool,
      params: {},
      dependsOn: t.dependsOn ?? [],
    })),
    ...extra,
  });
}

describe("parsePlanResponse (real)", () => {
  it("parses a plain JSON plan and resolves symbols to Yahoo format", () => {
    const plan = parsePlanResponse(
      planJson([{ id: "t1", tool: "fetch_company_profile" }]),
      "Analyse Reliance",
      "advanced"
    );
    assert.deepStrictEqual(plan.symbols, ["RELIANCE.NS"]);
    assert.strictEqual(plan.tasks.length, 1);
    assert.strictEqual(plan.tasks[0]!.status, "pending");
    assert.strictEqual(plan.estimatedSteps, 1);
  });

  it("unwraps a ```json fenced plan", () => {
    const inner = planJson([{ id: "t1", tool: "fetch_key_ratios" }]);
    const plan = parsePlanResponse(
      "```json\n" + inner + "\n```",
      "q",
      "advanced"
    );
    assert.strictEqual(plan.tasks[0]!.tool, "fetch_key_ratios");
  });

  it("fast mode keeps only allowed tools", () => {
    const plan = parsePlanResponse(
      planJson([
        { id: "a", tool: "fetch_company_profile" }, // allowed
        { id: "b", tool: "compute_dcf" }, // NOT allowed in fast
        { id: "c", tool: "synthesize_report" }, // allowed
      ]),
      "q",
      "fast"
    );
    const tools = plan.tasks.map((t) => t.tool);
    assert.ok(tools.includes("fetch_company_profile"));
    assert.ok(tools.includes("synthesize_report"));
    assert.ok(!tools.includes("compute_dcf"));
  });

  it("fast mode caps at 7 tasks, preserving the synthesis task", () => {
    const many = Array.from({ length: 10 }, (_, i) => ({
      id: `d${i}`,
      tool: "fetch_company_profile",
    }));
    many.push({ id: "syn", tool: "synthesize_report" });
    const plan = parsePlanResponse(planJson(many), "q", "fast");
    assert.ok(plan.tasks.length <= 7, `got ${plan.tasks.length}`);
    assert.ok(plan.tasks.some((t) => t.tool === "synthesize_report"));
  });

  it("advanced mode caps at 56 tasks, preserving synthesis", () => {
    const many = Array.from({ length: 80 }, (_, i) => ({
      id: `d${i}`,
      tool: "fetch_company_profile",
    }));
    many.push({ id: "syn", tool: "synthesize_report" });
    const plan = parsePlanResponse(planJson(many), "q", "advanced");
    assert.ok(plan.tasks.length <= 56, `got ${plan.tasks.length}`);
    assert.ok(plan.tasks.some((t) => t.tool === "synthesize_report"));
  });

  it("strips dangling dependsOn references to filtered/hallucinated ids", () => {
    const plan = parsePlanResponse(
      planJson([
        { id: "a", tool: "fetch_company_profile" },
        { id: "b", tool: "fetch_key_ratios", dependsOn: ["a", "ghost"] },
      ]),
      "q",
      "advanced"
    );
    const b = plan.tasks.find((t) => t.id === "b")!;
    assert.deepStrictEqual(b.dependsOn, ["a"]);
  });

  it("honours an explicit complexity, defaulting by mode otherwise", () => {
    const withComplexity = parsePlanResponse(
      planJson([{ id: "a", tool: "fetch_company_profile" }], {
        complexity: "complex",
      }),
      "q",
      "advanced"
    );
    assert.strictEqual(withComplexity.complexity, "complex");

    const fastDefault = parsePlanResponse(
      planJson([{ id: "a", tool: "fetch_company_profile" }]),
      "q",
      "fast"
    );
    assert.strictEqual(fastDefault.complexity, "simple");

    const advancedDefault = parsePlanResponse(
      planJson([{ id: "a", tool: "fetch_company_profile" }]),
      "q",
      "advanced"
    );
    assert.strictEqual(advancedDefault.complexity, "moderate");
  });

  it("on unparseable JSON, falls back when the query names a symbol", () => {
    const plan = parsePlanResponse(
      "totally not json",
      "Should I analyse RELIANCE.NS today?",
      "fast"
    );
    assert.ok(plan.tasks.length > 0);
    assert.deepStrictEqual(plan.symbols, ["RELIANCE.NS"]);
  });

  it("on unparseable JSON with NO identifiable symbol, throws (MONEY-612 trust)", () => {
    assert.throws(
      () =>
        parsePlanResponse("garbage", "tell me about the market", "advanced"),
      /could not build a plan|no stock symbol/i
    );
  });
});

describe("buildFastFallbackPlan (real)", () => {
  it("is a 6-task simple plan ending in synthesize_report", () => {
    const plan: ResearchPlan = buildFastFallbackPlan("q", "TCS.NS");
    assert.strictEqual(plan.tasks.length, 6);
    assert.strictEqual(plan.complexity, "simple");
    assert.strictEqual(plan.estimatedSteps, 6);
    assert.strictEqual(
      plan.tasks[plan.tasks.length - 1]!.tool,
      "synthesize_report"
    );
    assert.deepStrictEqual(plan.symbols, ["TCS.NS"]);
  });
});

describe("buildAdvancedFallbackPlan (real)", () => {
  it("is a 17-task moderate plan ending in synthesize_report", () => {
    const plan: ResearchPlan = buildAdvancedFallbackPlan("q", "INFY.NS");
    assert.strictEqual(plan.tasks.length, 17);
    assert.strictEqual(plan.complexity, "moderate");
    assert.strictEqual(plan.estimatedSteps, 17);
    assert.strictEqual(
      plan.tasks[plan.tasks.length - 1]!.tool,
      "synthesize_report"
    );
  });
});

describe("extractSectorFromQuery (real)", () => {
  for (const [q, expected] of [
    ["analyze the banking sector", "banking"],
    ["top it companies in India", "it"],
    ["pharma sector outlook", "pharma"],
    ["auto sector analysis", "auto"],
    ["energy stocks to watch", "energy"],
    ["fmcg stocks performance", "fmcg"],
    ["metals sector report", "metals"],
    ["realty stocks India", "realty"],
    ["finance companies outlook", "finance"],
    ["technology sector stocks", "technology"],
    ["healthcare sector growth", "healthcare"],
  ] as const) {
    it(`returns '${expected}' for: ${q}`, () => {
      assert.strictEqual(extractSectorFromQuery(q), expected);
    });
  }

  it("returns undefined when NO sector keyword is found (MONEY-612, NOT 'banking')", () => {
    assert.strictEqual(
      extractSectorFromQuery("what are the best stocks right now"),
      undefined
    );
  });
});
