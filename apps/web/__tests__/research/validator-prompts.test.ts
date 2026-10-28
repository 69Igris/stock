/**
 * Research validator parsing + prompt builders — REAL source (MONEY-620 de-shadow).
 *
 * Previously this file inlined `parseValidationResponse` and every prompt
 * builder and asserted the copies. Two divergences were masked:
 *   1. The inline `parseValidationResponse` fallback returned
 *      `{ score: 0.7, passed: true }`; the REAL function now returns
 *      `{ score: 0.5, passed: false }` on a parse failure (MONEY-612: never
 *      fabricate a passing "verified" stamp). ~10 fallback assertions were
 *      asserting the obsolete passing value.
 *   2. The inline prompts were the OLD single-mode versions; the real
 *      `getPlannerPrompt` / `getSynthesizerPrompt` take a `mode`, and
 *      `buildPlannerUserPrompt` / `buildSynthesizerUserPrompt` now append much
 *      richer instructions (a default-comprehensive-plan block, a JSON-only
 *      tail, …).
 *
 * It now imports the REAL `parseValidationResponse` from
 * `packages/research/src/validator-logic.ts` (extracted from `validator.ts`,
 * which calls it) and the REAL prompt exports from
 * `packages/research/src/prompts.ts`, asserting current behaviour.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { parseValidationResponse } from "@usemoney/research/validator-logic";
import {
  getPlannerPrompt,
  buildPlannerUserPrompt,
  getSynthesizerPrompt,
  buildSynthesizerUserPrompt,
  getValidatorPrompt,
  buildValidatorUserPrompt,
  getSummaryPrompt,
} from "@usemoney/research/prompts";
import type { ResearchPlan, ResearchTask } from "@usemoney/research/types";

function makeTask(
  overrides: Partial<ResearchTask> & { id: string; tool: string }
): ResearchTask {
  return {
    type: "data_fetch",
    params: {},
    dependsOn: [],
    status: "pending",
    ...overrides,
  };
}

function makePlan(overrides: Partial<ResearchPlan> = {}): ResearchPlan {
  return {
    query: "test query",
    symbols: ["RELIANCE.NS"],
    tasks: [],
    estimatedSteps: 5,
    complexity: "moderate",
    ...overrides,
  };
}

// ═════════════════════════════════════════════════════════════════════════
// parseValidationResponse (REAL)
// ═════════════════════════════════════════════════════════════════════════

describe("parseValidationResponse — valid JSON", () => {
  it("parses plain JSON with all fields", () => {
    const r = parseValidationResponse(
      JSON.stringify({ score: 0.8, passed: true, gaps: [], suggestions: [] })
    );
    assert.strictEqual(r.score, 0.8);
    assert.strictEqual(r.passed, true);
    assert.deepStrictEqual(r.gaps, []);
    assert.deepStrictEqual(r.suggestions, []);
  });

  it("parses JSON inside a ```json code block", () => {
    const r = parseValidationResponse(
      '```json\n{"score": 0.9, "passed": true, "gaps": [], "suggestions": []}\n```'
    );
    assert.strictEqual(r.score, 0.9);
    assert.strictEqual(r.passed, true);
  });

  it("parses JSON inside a bare ``` code block (gaps/suggestions preserved)", () => {
    const r = parseValidationResponse(
      '```\n{"score": 0.75, "passed": true, "gaps": ["g1"], "suggestions": ["s1"]}\n```'
    );
    assert.strictEqual(r.score, 0.75);
    assert.deepStrictEqual(r.gaps, ["g1"]);
    assert.deepStrictEqual(r.suggestions, ["s1"]);
  });

  it("uses the first code block when several exist", () => {
    const r = parseValidationResponse(
      '```json\n{"score": 0.1}\n```\ntext\n```json\n{"score": 0.99}\n```'
    );
    assert.strictEqual(r.score, 0.1);
  });

  it("ignores extra properties", () => {
    const r = parseValidationResponse(
      JSON.stringify({ score: 0.82, passed: true, extra: "ignored", n: 42 })
    );
    assert.strictEqual(r.score, 0.82);
    assert.strictEqual(r.passed, true);
  });
});

describe("parseValidationResponse — score handling", () => {
  it("returns a mid-range score as-is", () => {
    assert.strictEqual(parseValidationResponse('{"score":0.85}').score, 0.85);
  });

  it("`score: 0` becomes 0.5 (0 || 0.5)", () => {
    assert.strictEqual(parseValidationResponse('{"score":0}').score, 0.5);
  });

  it("clamps score > 1 to 1", () => {
    assert.strictEqual(parseValidationResponse('{"score":1.5}').score, 1);
    assert.strictEqual(parseValidationResponse('{"score":999}').score, 1);
  });

  it("clamps a negative score to 0", () => {
    assert.strictEqual(parseValidationResponse('{"score":-0.5}').score, 0);
    assert.strictEqual(parseValidationResponse('{"score":-100}').score, 0);
  });

  it("defaults a missing/null score to 0.5", () => {
    assert.strictEqual(parseValidationResponse('{"passed":true}').score, 0.5);
    assert.strictEqual(parseValidationResponse('{"score":null}').score, 0.5);
  });

  it("score=1 stays 1 (max boundary)", () => {
    assert.strictEqual(parseValidationResponse('{"score":1}').score, 1);
  });
});

describe("parseValidationResponse — passed field", () => {
  it("respects an explicit passed:true / passed:false", () => {
    assert.strictEqual(
      parseValidationResponse('{"score":0.4,"passed":true}').passed,
      true
    );
    assert.strictEqual(
      parseValidationResponse('{"score":0.9,"passed":false}').passed,
      false
    );
  });

  it("derives passed from score >= 0.7 when absent", () => {
    assert.strictEqual(parseValidationResponse('{"score":0.8}').passed, true);
    assert.strictEqual(parseValidationResponse('{"score":0.7}').passed, true);
    assert.strictEqual(parseValidationResponse('{"score":0.69}').passed, false);
  });

  it("nullish-coalesces passed: null is treated as absent", () => {
    assert.strictEqual(
      parseValidationResponse('{"score":0.8,"passed":null}').passed,
      true
    );
  });

  it("score=0 → 0.5 → passed false (0.5 < 0.7)", () => {
    assert.strictEqual(parseValidationResponse('{"score":0}').passed, false);
  });
});

describe("parseValidationResponse — gaps & suggestions", () => {
  it("returns gaps/suggestions as-is when arrays", () => {
    const r = parseValidationResponse(
      JSON.stringify({ score: 0.8, gaps: ["g1", "g2"], suggestions: ["s1"] })
    );
    assert.deepStrictEqual(r.gaps, ["g1", "g2"]);
    assert.deepStrictEqual(r.suggestions, ["s1"]);
  });

  it("defaults undefined/null gaps & suggestions to []", () => {
    const r1 = parseValidationResponse('{"score":0.8}');
    assert.deepStrictEqual(r1.gaps, []);
    assert.deepStrictEqual(r1.suggestions, []);
    const r2 = parseValidationResponse(
      '{"score":0.8,"gaps":null,"suggestions":null}'
    );
    assert.deepStrictEqual(r2.gaps, []);
    assert.deepStrictEqual(r2.suggestions, []);
  });
});

describe("parseValidationResponse — parse failure (MONEY-612 honest fallback)", () => {
  // The REAL fallback is an HONEST un-passed 0.5 — NOT the old 0.7/passed:true
  // that the shadow asserted. Pinned so a regression back to a fabricated
  // passing stamp is caught.
  const FALLBACK = {
    score: 0.5,
    passed: false,
    suggestion: "Could not parse validation response",
  };

  for (const [label, input] of [
    ["invalid JSON", "{invalid json}"],
    ["empty string", ""],
    ["plain text", "this is not json at all"],
    ["HTML", "<html><body>Not JSON</body></html>"],
    ["truncated JSON", '{"score": 0.8, "passed":'],
    ["lone opening brace", "{"],
    ["markdown without a code block", "# Validation Report\n\nGood."],
    ["JSON null (accessing null.score throws)", "null"],
  ] as const) {
    it(`${label} → honest 0.5/not-passed fallback`, () => {
      const r = parseValidationResponse(input);
      assert.strictEqual(r.score, FALLBACK.score);
      assert.strictEqual(r.passed, FALLBACK.passed);
      assert.deepStrictEqual(r.gaps, []);
      assert.deepStrictEqual(r.suggestions, [FALLBACK.suggestion]);
    });
  }

  it("a JSON array parses (no throw) → score defaults to 0.5, passed false", () => {
    const r = parseValidationResponse("[1, 2, 3]");
    assert.strictEqual(r.score, 0.5);
    assert.strictEqual(r.passed, false);
  });

  it("a JSON number/string/bool parses → score 0.5 (no .score property)", () => {
    assert.strictEqual(parseValidationResponse("42").score, 0.5);
    assert.strictEqual(parseValidationResponse('"hello"').score, 0.5);
    assert.strictEqual(parseValidationResponse("true").score, 0.5);
  });
});

describe("parseValidationResponse — shape", () => {
  it("always returns score:number, passed:boolean, gaps:[], suggestions:[]", () => {
    const r = parseValidationResponse(
      JSON.stringify({ score: 0.8, passed: true, gaps: [], suggestions: [] })
    );
    assert.strictEqual(typeof r.score, "number");
    assert.strictEqual(typeof r.passed, "boolean");
    assert.ok(Array.isArray(r.gaps));
    assert.ok(Array.isArray(r.suggestions));
  });
});

// ═════════════════════════════════════════════════════════════════════════
// Prompt builders (REAL) — assert stable invariants, not full text
// ═════════════════════════════════════════════════════════════════════════

describe("getPlannerPrompt (REAL)", () => {
  it("returns a string and lists the available tools as bullets", () => {
    const r = getPlannerPrompt([
      "fetch_stock_price",
      "fetch_news",
      "compute_dcf",
    ]);
    assert.strictEqual(typeof r, "string");
    assert.ok(r.includes("- fetch_stock_price"));
    assert.ok(r.includes("- fetch_news"));
    assert.ok(r.includes("- compute_dcf"));
  });

  it("mentions NSE/BSE, the .NS/.BO suffixes, dependsOn and synthesize_report", () => {
    const r = getPlannerPrompt([]);
    assert.ok(r.includes("NSE/BSE"));
    assert.ok(r.includes(".NS"));
    assert.ok(r.includes(".BO"));
    assert.ok(r.includes("dependsOn"));
    assert.ok(r.includes("synthesize_report"));
  });

  it("fast and advanced modes produce different prompts", () => {
    assert.notStrictEqual(
      getPlannerPrompt([], "fast"),
      getPlannerPrompt([], "advanced")
    );
  });
});

describe("buildPlannerUserPrompt (REAL)", () => {
  it("starts with the quoted research query", () => {
    assert.ok(
      buildPlannerUserPrompt("Analyze RELIANCE").startsWith(
        'Research query: "Analyze RELIANCE"'
      )
    );
  });

  it("omits the skill line when no skill is given", () => {
    assert.ok(
      !buildPlannerUserPrompt("test").includes("Research skill/template:")
    );
  });

  it("includes the skill line when a skill is given", () => {
    assert.ok(
      buildPlannerUserPrompt("q", "stock_analysis").includes(
        "Research skill/template: stock_analysis"
      )
    );
  });

  it("treats an empty skill string as absent", () => {
    assert.ok(
      !buildPlannerUserPrompt("q", "").includes("Research skill/template:")
    );
  });
});

describe("getSynthesizerPrompt (REAL)", () => {
  it("returns a non-trivial string", () => {
    const r = getSynthesizerPrompt();
    assert.strictEqual(typeof r, "string");
    assert.ok(r.length > 100);
  });
});

describe("buildSynthesizerUserPrompt (REAL)", () => {
  it("includes the query and a 'Gathered data' section", () => {
    const r = buildSynthesizerUserPrompt("test query", []);
    assert.ok(r.includes('Research query: "test query"'));
    assert.ok(r.includes("Gathered data:"));
  });

  it("includes ONLY completed tasks, formatted as '--- tool (id) ---'", () => {
    const tasks: ResearchTask[] = [
      makeTask({ id: "t1", tool: "fetch_price", status: "pending" }),
      makeTask({
        id: "t2",
        tool: "fetch_news",
        status: "completed",
        result: { data: "news" },
      }),
      makeTask({ id: "t3", tool: "compute_dcf", status: "failed" }),
    ];
    const r = buildSynthesizerUserPrompt("q", tasks);
    assert.ok(r.includes("--- fetch_news (t2) ---"));
    assert.ok(!r.includes("fetch_price"));
    assert.ok(!r.includes("compute_dcf"));
  });

  it("serializes a completed task result (values surfaced under the task header)", () => {
    // The real builder runs the result through truncateTaskResult(), so the
    // exact JSON.stringify(_, null, 2) layout is not guaranteed — assert the
    // values appear after the task header instead.
    const r = buildSynthesizerUserPrompt("q", [
      makeTask({
        id: "t1",
        tool: "fetch_price",
        status: "completed",
        result: { price: 2500, change: 1.5 },
      }),
    ]);
    assert.ok(r.includes("--- fetch_price (t1) ---"));
    assert.ok(r.includes("2500"));
    assert.ok(r.includes("1.5"));
  });

  it("produces no task blocks for an empty / all-incomplete task list", () => {
    assert.ok(!buildSynthesizerUserPrompt("q", []).includes("---"));
    const r = buildSynthesizerUserPrompt("q", [
      makeTask({ id: "t1", tool: "a", status: "pending" }),
      makeTask({ id: "t2", tool: "b", status: "running" }),
    ]);
    assert.ok(!r.includes("--- a"));
    assert.ok(!r.includes("--- b"));
  });
});

describe("getValidatorPrompt (REAL)", () => {
  it("describes the quality-checker role with a JSON-only output format", () => {
    const r = getValidatorPrompt();
    assert.ok(r.toLowerCase().includes("quality"));
    assert.ok(r.includes("JSON only"));
  });

  it("contains the SCORING and CHECK FOR sections and the key metrics", () => {
    const r = getValidatorPrompt();
    assert.ok(r.includes("SCORING"));
    assert.ok(r.includes("CHECK FOR"));
    assert.ok(r.includes("PE"));
    assert.ok(r.includes("PB"));
    assert.ok(r.includes("ROE"));
  });
});

describe("buildValidatorUserPrompt (REAL)", () => {
  it("includes the query, the task count and the comma-joined symbols", () => {
    const plan = makePlan({
      symbols: ["RELIANCE.NS", "TCS.NS", "INFY.NS"],
      tasks: [
        makeTask({ id: "t1", tool: "a" }),
        makeTask({ id: "t2", tool: "b" }),
        makeTask({ id: "t3", tool: "c" }),
      ],
    });
    const r = buildValidatorUserPrompt("Analyze TCS", plan, "Report text");
    assert.ok(r.includes('Original query: "Analyze TCS"'));
    assert.ok(r.includes("executed 3 tasks"));
    assert.ok(r.includes("RELIANCE.NS, TCS.NS, INFY.NS"));
    assert.ok(r.includes("Report text"));
  });

  it("handles a single symbol and an empty task list", () => {
    const r = buildValidatorUserPrompt(
      "q",
      makePlan({ symbols: ["HDFC.NS"], tasks: [] }),
      "report"
    );
    assert.ok(r.includes("across HDFC.NS"));
    assert.ok(r.includes("executed 0 tasks"));
  });
});

describe("getSummaryPrompt (REAL)", () => {
  it("embeds the report text under a 'Report:' header", () => {
    const r = getSummaryPrompt("RELIANCE is trading at PE of 25x.");
    assert.ok(r.includes("RELIANCE is trading at PE of 25x."));
    assert.ok(r.includes("Report:"));
  });

  it("mentions a concise 3-4 sentence summary and the NSE/BSE context", () => {
    const r = getSummaryPrompt("any report");
    assert.ok(r.includes("3-4 sentences"));
    assert.ok(r.includes("NSE/BSE"));
    assert.ok(r.includes("concise"));
  });
});
