/**
 * Research Skills registry, skill buildPlans & ResearchToolRegistry —
 * REAL source (MONEY-620 de-shadow).
 *
 * This file previously inlined a 6-skill registry, an inline `ResearchToolRegistry`
 * with 21 mock tools, inline `SECTOR_STOCKS` / `NIFTY50`, and hard-coded
 * skill-plan shapes (stock-analysis = 16 tasks, dcf-valuation = 7 tasks,
 * `moderate`, …) — and asserted the copies. Every one of those numbers was
 * obsolete: the real registry has 36 skills and 111 tools, stock-analysis now
 * emits 29 tasks, the registered `dcf-valuation` is the v2 institutional skill
 * (13 tasks, `complex`), peer-comparison emits 37 tasks for two symbols, etc.
 * The shadow stayed green through all of it.
 *
 * It now imports the REAL exports — `matchSkill` / `getSkill` / `getAllSkills` /
 * `fetchTask` / `computeTask` / `synthesisTask` from
 * `packages/research/src/skills/index.ts` and `ResearchToolRegistry` from the
 * package root — and asserts the ACTUAL behaviour: real routing, real plan
 * shapes (current counts + structural invariants), and the real registry's
 * category bookkeeping.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { ResearchToolRegistry } from "@usemoney/research";
import {
  matchSkill,
  getSkill,
  getAllSkills,
  fetchTask,
  computeTask,
  synthesisTask,
} from "@usemoney/research/skills";
import type { ResearchPlan } from "@usemoney/research/types";

// ─── Task helper functions ──────────────────────────────────────────────────

describe("fetchTask / computeTask / synthesisTask helpers", () => {
  it("fetchTask: data_fetch, pending, default empty deps, preserves fields", () => {
    const params = { symbol: "RELIANCE.NS", quarterly: true };
    const t = fetchTask("my_id", "fetch_company_profile", params);
    assert.strictEqual(t.type, "data_fetch");
    assert.strictEqual(t.status, "pending");
    assert.deepStrictEqual(t.dependsOn, []);
    assert.strictEqual(t.id, "my_id");
    assert.strictEqual(t.tool, "fetch_company_profile");
    assert.deepStrictEqual(t.params, params);
  });

  it("fetchTask passes dependsOn through", () => {
    assert.deepStrictEqual(
      fetchTask("id", "tool", {}, ["d1", "d2"]).dependsOn,
      ["d1", "d2"]
    );
  });

  it("computeTask: computation, pending, preserves deps + params", () => {
    const t = computeTask("c", "compute_dcf", { discountRate: 0.1 }, [
      "cashflow",
      "price",
      "ratios",
    ]);
    assert.strictEqual(t.type, "computation");
    assert.strictEqual(t.status, "pending");
    assert.deepStrictEqual(t.dependsOn, ["cashflow", "price", "ratios"]);
    assert.deepStrictEqual(t.params, { discountRate: 0.1 });
  });

  it("synthesisTask: synthesis, pending, preserves deps + params", () => {
    const t = synthesisTask(
      "s",
      "synthesize_report",
      { query: "Analyze TCS" },
      ["a", "b"]
    );
    assert.strictEqual(t.type, "synthesis");
    assert.strictEqual(t.status, "pending");
    assert.deepStrictEqual(t.dependsOn, ["a", "b"]);
    assert.deepStrictEqual(t.params, { query: "Analyze TCS" });
  });
});

// ─── getSkill / getAllSkills ────────────────────────────────────────────────

describe("getSkill", () => {
  for (const name of [
    "stock-analysis",
    "peer-comparison",
    "dcf-valuation",
    "sector-analysis",
    "stock-screener",
    "portfolio-analysis",
  ]) {
    it(`returns the "${name}" skill by name`, () => {
      const skill = getSkill(name);
      assert.ok(skill);
      assert.strictEqual(skill.name, name);
    });
  }

  it("returns undefined for an unknown name / empty string / wrong case", () => {
    assert.strictEqual(getSkill("unknown-skill"), undefined);
    assert.strictEqual(getSkill(""), undefined);
    assert.strictEqual(getSkill("STOCK-ANALYSIS"), undefined);
  });
});

describe("getAllSkills", () => {
  it("registers >= 30 skills (16 v2 institutional + the v1 set)", () => {
    assert.ok(
      getAllSkills().length >= 30,
      `expected >= 30 skills, got ${getAllSkills().length}`
    );
  });

  it("registers v2 institutional skills BEFORE the generic v1 stock-analysis", () => {
    const names = getAllSkills().map((s) => s.name);
    assert.ok(
      names.indexOf("fundamentals-core") < names.indexOf("stock-analysis"),
      "v2 skills must precede stock-analysis (specific triggers win)"
    );
  });

  it("includes the key v2 institutional skill names", () => {
    const names = new Set(getAllSkills().map((s) => s.name));
    for (const n of [
      "fundamentals-core",
      "cash-flow-quality",
      "earnings-deep-dive",
      "relative-valuation",
      "technical-trend",
      "chart-pattern-detection",
      "governance-flags",
      "news-sentiment-catalysts",
    ]) {
      assert.ok(names.has(n), `missing v2 skill: ${n}`);
    }
  });

  it("every skill is well-formed (name, description, triggers, requiredParams, buildPlan)", () => {
    for (const skill of getAllSkills()) {
      assert.ok(typeof skill.name === "string" && skill.name.length > 0);
      assert.ok(
        typeof skill.description === "string" && skill.description.length > 0
      );
      assert.ok(Array.isArray(skill.triggers) && skill.triggers.length > 0);
      assert.ok(skill.triggers.every((t) => t instanceof RegExp));
      assert.ok(Array.isArray(skill.requiredParams));
      assert.ok(typeof skill.buildPlan === "function");
    }
  });

  it("all skill names are unique", () => {
    const names = getAllSkills().map((s) => s.name);
    assert.strictEqual(new Set(names).size, names.length);
  });
});

// ─── matchSkill — REAL routing (post-v2) ────────────────────────────────────

describe("matchSkill — routing", () => {
  const cases: Array<[string, string]> = [
    ["Analyse RELIANCE stock", "stock-analysis"],
    ["research TCS share", "stock-analysis"],
    ["deep dive into HDFC stock", "stock-analysis"],
    ["evaluate INFY company", "stock-analysis"],
    ["should I buy RELIANCE", "stock-analysis"],
    ["should i invest in HDFC", "stock-analysis"],
    ["is TCS a good stock", "stock-analysis"],
    ["is RELIANCE overvalued", "stock-analysis"],
    ["compare RELIANCE vs TCS stock", "peer-comparison"],
    ["TCS versus INFY", "peer-comparison"],
    ["calculate dcf for RELIANCE", "dcf-valuation"],
    ["intrinsic value of TCS", "dcf-valuation"],
    // v2 sector-deep-dive is registered before sector-analysis → it wins.
    ["banking sector analysis", "sector-deep-dive"],
    ["how is the banking sector", "sector-deep-dive"],
    ["screen stocks with PE below 15", "stock-screener"],
    ["filter companies by ROE", "stock-screener"],
    ["review my portfolio", "portfolio-analysis"],
    ["portfolio risk analysis", "portfolio-analysis"],
  ];
  for (const [q, expected] of cases) {
    it(`${JSON.stringify(q)} → ${expected}`, () => {
      assert.strictEqual(matchSkill(q)?.name, expected);
    });
  }

  it("'analyse my portfolio' → stock-analysis (documents a real routing divergence)", () => {
    // The old shadow asserted portfolio-analysis; with the real v2-first
    // registry the stock-analysis trigger matches first. Pinned to reality so a
    // future fix is caught, not masked.
    assert.strictEqual(
      matchSkill("analyse my portfolio")?.name,
      "stock-analysis"
    );
  });

  it("'are HDFC shares undervalued' → undefined (no trigger matches the phrasing)", () => {
    assert.strictEqual(matchSkill("are HDFC shares undervalued"), undefined);
  });

  for (const q of [
    "hello how are you",
    "",
    "what is the weather",
    "tell me about RELIANCE",
    "RELIANCE",
    "12345",
  ]) {
    it(`returns undefined for ${JSON.stringify(q)}`, () => {
      assert.strictEqual(matchSkill(q), undefined);
    });
  }

  it("the matched skill is always a member of getAllSkills()", () => {
    const all = new Set(getAllSkills());
    for (const q of cases.map(([q]) => q)) {
      const skill = matchSkill(q);
      assert.ok(skill && all.has(skill), `match for ${q} not in registry`);
    }
  });

  it("case-insensitive: 'ANALYSE RELIANCE STOCK' still matches stock-analysis", () => {
    assert.strictEqual(
      matchSkill("ANALYSE RELIANCE STOCK")?.name,
      "stock-analysis"
    );
  });

  it("'DCF' alone matches dcf-valuation (case-insensitive)", () => {
    assert.strictEqual(matchSkill("DCF")?.name, "dcf-valuation");
    assert.strictEqual(matchSkill("dcf")?.name, "dcf-valuation");
  });
});

// ─── Real skill buildPlans (current counts + structural invariants) ─────────

/** Every dependsOn id must reference a real task id in the same plan. */
function assertDependencyIntegrity(plan: ResearchPlan): void {
  const ids = new Set(plan.tasks.map((t) => t.id));
  for (const t of plan.tasks) {
    for (const dep of t.dependsOn) {
      assert.ok(ids.has(dep), `task ${t.id} depends on missing id ${dep}`);
    }
  }
}

/** Structural invariants that should hold for any well-formed plan. */
function assertPlanInvariants(plan: ResearchPlan): void {
  assert.strictEqual(plan.estimatedSteps, plan.tasks.length);
  assert.ok(plan.tasks.every((t) => t.status === "pending"));
  const ids = plan.tasks.map((t) => t.id);
  assert.strictEqual(new Set(ids).size, ids.length, "task ids must be unique");
  assertDependencyIntegrity(plan);
}

describe("stock-analysis buildPlan (real)", () => {
  const plan = getSkill("stock-analysis")!.buildPlan({ symbol: "TCS" });

  it("is a complex plan that resolves the symbol to Yahoo format", () => {
    assert.strictEqual(plan.skill, "stock-analysis");
    assert.strictEqual(plan.complexity, "complex");
    assert.deepStrictEqual(plan.symbols, ["TCS.NS"]);
  });

  it("respects the exchange param (BSE → .BO)", () => {
    const bse = getSkill("stock-analysis")!.buildPlan({
      symbol: "RELIANCE",
      exchange: "BSE",
    });
    assert.deepStrictEqual(bse.symbols, ["RELIANCE.BO"]);
  });

  it("emits the current task count and ends with a single synthesis task", () => {
    assert.strictEqual(plan.tasks.length, 29);
    const synth = plan.tasks.filter((t) => t.type === "synthesis");
    assert.strictEqual(synth.length, 1);
    assert.strictEqual(plan.tasks[plan.tasks.length - 1]!.type, "synthesis");
  });

  it("uses a custom query when provided", () => {
    const p = getSkill("stock-analysis")!.buildPlan({
      symbol: "TCS",
      query: "Is TCS a good buy?",
    });
    assert.strictEqual(p.query, "Is TCS a good buy?");
  });

  it("satisfies the structural invariants", () => assertPlanInvariants(plan));
});

describe("peer-comparison buildPlan (real)", () => {
  it("is moderate and resolves all symbols to Yahoo format", () => {
    const plan = getSkill("peer-comparison")!.buildPlan({
      symbols: ["TCS", "RELIANCE"],
    });
    assert.strictEqual(plan.complexity, "moderate");
    assert.deepStrictEqual(plan.symbols, ["TCS.NS", "RELIANCE.NS"]);
    assertPlanInvariants(plan);
  });

  it("emits the current per-symbol task count (2 symbols → 37 tasks)", () => {
    const plan = getSkill("peer-comparison")!.buildPlan({
      symbols: ["TCS", "INFY"],
    });
    assert.strictEqual(plan.tasks.length, 37);
  });
});

describe("dcf-valuation (v2) buildPlan (real)", () => {
  const plan = getSkill("dcf-valuation")!.buildPlan({ symbol: "TCS" });

  it("is the v2 institutional plan: complex, 13 tasks", () => {
    // The old shadow asserted the v1 shape (7 tasks, moderate). The registered
    // skill is now dcf-valuation-v2.
    assert.strictEqual(plan.complexity, "complex");
    assert.strictEqual(plan.tasks.length, 13);
  });

  it("resolves the symbol and satisfies the invariants", () => {
    assert.deepStrictEqual(plan.symbols, ["TCS.NS"]);
    assertPlanInvariants(plan);
  });
});

describe("sector-analysis buildPlan (real)", () => {
  it("maps 'banking' to the banking constituent list and is well-formed", () => {
    const plan = getSkill("sector-analysis")!.buildPlan({ sector: "banking" });
    assert.deepStrictEqual(plan.symbols, [
      "HDFCBANK.NS",
      "ICICIBANK.NS",
      "SBIN.NS",
      "KOTAKBANK.NS",
      "AXISBANK.NS",
    ]);
    assert.strictEqual(plan.tasks.length, 9);
    assert.strictEqual(plan.tasks[0]!.tool, "fetch_stock_price");
    assertPlanInvariants(plan);
  });

  it("returns NO coverage for an unknown sector — never a substitute", () => {
    // This asserted the banking fallback as correct. That fallback meant an
    // unmatched sector produced a fully-rendered analysis of five private banks
    // under someone else's heading, with nothing indicating a substitution —
    // "Real Estate" was one such sector until its alias was added.
    const unknown = getSkill("sector-analysis")!.buildPlan({
      sector: "space_exploration",
    });
    assert.deepStrictEqual(unknown.symbols, []);
  });

  it("resolves Real Estate to realty stocks, not banks", () => {
    const plan = getSkill("sector-analysis")!.buildPlan({
      sector: "Real Estate",
    });
    assert.ok(
      plan.symbols.some((s: string) => s.startsWith("OBEROIRLTY")),
      `expected realty constituents, got ${JSON.stringify(plan.symbols)}`
    );
    assert.ok(!plan.symbols.some((s: string) => s.startsWith("HDFCBANK")));
  });
});

describe("stock-screener buildPlan (real)", () => {
  it("defaults to a 50-symbol universe and a simple 2-task screen→report plan", () => {
    const plan = getSkill("stock-screener")!.buildPlan({});
    assert.strictEqual(plan.symbols.length, 50);
    assert.strictEqual(plan.complexity, "simple");
    assert.strictEqual(plan.tasks.length, 2);
    assert.strictEqual(plan.tasks[0]!.type, "computation");
    assert.strictEqual(plan.tasks[0]!.tool, "screen_stocks");
    assert.strictEqual(plan.tasks[1]!.type, "synthesis");
    assert.deepStrictEqual(plan.tasks[1]!.dependsOn, ["screen"]);
    assertPlanInvariants(plan);
  });

  it("uses custom symbols and passes filter params to the screen task", () => {
    const plan = getSkill("stock-screener")!.buildPlan({
      symbols: ["TCS.NS", "INFY.NS"],
      maxPE: 15,
      minPE: 5,
    });
    assert.deepStrictEqual(plan.symbols, ["TCS.NS", "INFY.NS"]);
    assert.strictEqual(plan.tasks[0]!.params.maxPE, 15);
    assert.strictEqual(plan.tasks[0]!.params.minPE, 5);
  });
});

describe("portfolio-analysis buildPlan (real)", () => {
  it("returns an empty plan for empty / null / undefined holdings", () => {
    for (const holdings of [[], null, undefined]) {
      const plan = getSkill("portfolio-analysis")!.buildPlan({ holdings });
      assert.strictEqual(plan.tasks.length, 0);
      assert.strictEqual(plan.estimatedSteps, 0);
    }
  });

  it("builds a price+ratios+report plan and resolves symbols", () => {
    const plan = getSkill("portfolio-analysis")!.buildPlan({
      holdings: [{ symbol: "RELIANCE", quantity: 10, avgPrice: 2500 }],
    });
    assert.strictEqual(plan.tasks.length, 3);
    assert.deepStrictEqual(plan.symbols, ["RELIANCE.NS"]);
    assert.strictEqual(plan.complexity, "moderate");
    assertPlanInvariants(plan);
  });

  it("includes ALL holdings in symbols (even past the per-task ratios cap)", () => {
    const holdings = Array.from({ length: 15 }, (_, i) => ({
      symbol: `STOCK${i}`,
      quantity: 10,
      avgPrice: 100,
    }));
    const plan = getSkill("portfolio-analysis")!.buildPlan({ holdings });
    assert.strictEqual(plan.symbols.length, 15);
  });

  it("preserves symbols that already carry an exchange suffix", () => {
    const plan = getSkill("portfolio-analysis")!.buildPlan({
      holdings: [{ symbol: "RELIANCE.NS", quantity: 10, avgPrice: 2500 }],
    });
    assert.deepStrictEqual(plan.symbols, ["RELIANCE.NS"]);
  });
});

// ─── ResearchToolRegistry (real) ────────────────────────────────────────────

describe("ResearchToolRegistry (real)", () => {
  it("registers the full default tool set (>= 100 tools)", () => {
    const reg = new ResearchToolRegistry();
    assert.ok(
      reg.getToolNames().length >= 100,
      `expected >= 100 tools, got ${reg.getToolNames().length}`
    );
  });

  it("has the core data/computation/synthesis tools", () => {
    const reg = new ResearchToolRegistry();
    assert.ok(reg.has("fetch_company_profile"));
    assert.ok(reg.has("fetch_stock_price"));
    assert.ok(reg.has("fetch_news"));
    assert.ok(reg.has("compute_dcf"));
    assert.ok(reg.has("synthesize_report"));
    assert.ok(reg.has("compare_stocks"));
  });

  it("returns undefined / false for unknown tools", () => {
    const reg = new ResearchToolRegistry();
    assert.strictEqual(reg.get("nonexistent"), undefined);
    assert.ok(!reg.has("nonexistent_tool"));
    assert.ok(!reg.has(""));
  });

  it("get() returns the tool with its declared category", () => {
    const reg = new ResearchToolRegistry();
    assert.strictEqual(reg.get("fetch_company_profile")!.category, "data");
    assert.strictEqual(reg.get("compute_dcf")!.category, "computation");
    assert.strictEqual(reg.get("synthesize_report")!.category, "synthesis");
  });

  it("execute() returns an error for an unknown tool", async () => {
    const reg = new ResearchToolRegistry();
    const result = await reg.execute("unknown_tool", {});
    assert.strictEqual(result.success, false);
    assert.strictEqual(result.error, "Unknown tool: unknown_tool");
  });

  it("data + computation + synthesis tool counts sum to the total", () => {
    const reg = new ResearchToolRegistry();
    const total =
      reg.getDataTools().length +
      reg.getComputationTools().length +
      reg.getSynthesisTools().length;
    assert.strictEqual(total, reg.getToolNames().length);
  });

  it("getDataTools / getComputationTools / getSynthesisTools filter by category", () => {
    const reg = new ResearchToolRegistry();
    assert.ok(reg.getDataTools().every((t) => t.category === "data"));
    assert.ok(
      reg.getComputationTools().every((t) => t.category === "computation")
    );
    assert.ok(reg.getSynthesisTools().every((t) => t.category === "synthesis"));
  });

  it("getToolDescriptions follow the 'name: desc [category]' format", () => {
    const reg = new ResearchToolRegistry();
    const descs = reg.getToolDescriptions();
    assert.strictEqual(descs.length, reg.getToolNames().length);
    for (const desc of descs) {
      assert.ok(desc.includes(":"), `missing colon in: ${desc}`);
      assert.ok(
        /\[(data|computation|synthesis)\]$/.test(desc),
        `bad format: ${desc}`
      );
    }
  });

  it("register() adds a custom tool; multiple registries are independent", () => {
    const r1 = new ResearchToolRegistry();
    const r2 = new ResearchToolRegistry();
    const before = r1.getToolNames().length;
    r1.register({
      name: "custom_tool",
      description: "Custom",
      category: "data",
      parameters: {},
      execute: async () => ({ success: true, data: { ok: true } }),
    });
    assert.ok(r1.has("custom_tool"));
    assert.strictEqual(r1.getToolNames().length, before + 1);
    assert.ok(!r2.has("custom_tool"));
  });

  it("register() overwrites a tool of the same name without changing the count", () => {
    const reg = new ResearchToolRegistry();
    const before = reg.getToolNames().length;
    reg.register({
      name: "fetch_news",
      description: "Replaced news tool",
      category: "computation",
      parameters: {},
      execute: async () => ({ success: true, data: "replaced" }),
    });
    const tool = reg.get("fetch_news")!;
    assert.strictEqual(tool.description, "Replaced news tool");
    assert.strictEqual(tool.category, "computation");
    assert.strictEqual(reg.getToolNames().length, before);
  });
});
