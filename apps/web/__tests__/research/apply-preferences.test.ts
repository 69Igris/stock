/**
 * MONEY-222 - applyResearchPreferences contract tests.
 *
 * The agent runs every plan through this helper after the planner. The
 * helper has two jobs:
 *
 *   1. Trim compute / analysis tasks when researchStyle = custom so a user
 *      who only wants DCF doesn't pay for earnings-quality + accounting-
 *      quality + technical-analysis on every run.
 *   2. Stamp `researchFocus` onto the plan + the synthesis task params so
 *      `buildSynthesizerUserPrompt` can prepend a top-of-prompt directive.
 *
 * Both behaviours must NOT touch data-fetch tasks (cheap + always useful)
 * or synthesis tasks (the report itself).
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  applyResearchPreferences,
  augmentPlanWithSkills,
  buildAllowedToolSet,
} from "@usemoney/research";
import type { ResearchPlan, ResearchTask } from "@usemoney/research";

function task(
  id: string,
  type: ResearchTask["type"],
  tool: string,
  dependsOn: string[] = []
): ResearchTask {
  return {
    id,
    type,
    tool,
    params: {},
    dependsOn,
    status: "pending",
  };
}

function makePlan(tasks: ResearchTask[]): ResearchPlan {
  return {
    query: "Analyse RELIANCE",
    skill: "stock-analysis",
    symbols: ["RELIANCE.NS"],
    tasks,
    estimatedSteps: tasks.length,
    complexity: "complex",
  };
}

describe("applyResearchPreferences - no-op cases", () => {
  it("returns the plan untouched when no hints are provided", () => {
    const plan = makePlan([
      task("a", "data_fetch", "fetch_company_profile"),
      task("b", "computation", "compute_dcf", ["a"]),
      task("c", "synthesis", "synthesize_report", ["b"]),
    ]);
    const out = applyResearchPreferences(plan, {});
    assert.equal(out.tasks.length, 3);
    assert.equal(out.researchFocus, undefined);
    assert.equal(out.customSkills, undefined);
  });

  it("returns the plan untouched when customSkills is empty", () => {
    const plan = makePlan([
      task("a", "data_fetch", "fetch_company_profile"),
      task("b", "computation", "compute_dcf", ["a"]),
    ]);
    const out = applyResearchPreferences(plan, { customSkills: [] });
    assert.equal(out.tasks.length, 2);
  });
});

describe("applyResearchPreferences - researchFocus stamping", () => {
  it("stores trimmed focus on the plan and the synthesis task params", () => {
    const plan = makePlan([
      task("a", "data_fetch", "fetch_company_profile"),
      task("b", "synthesis", "synthesize_report", ["a"]),
    ]);
    const out = applyResearchPreferences(plan, {
      researchFocus: "  margin expansion  ",
    });
    assert.equal(out.researchFocus, "margin expansion");
    const synth = out.tasks.find((t) => t.tool === "synthesize_report")!;
    assert.equal(synth.params.researchFocus, "margin expansion");
  });

  it("does NOT stamp focus onto data-fetch / computation tasks", () => {
    const plan = makePlan([
      task("a", "data_fetch", "fetch_company_profile"),
      task("b", "computation", "compute_dcf", ["a"]),
      task("c", "synthesis", "synthesize_report", ["b"]),
    ]);
    const out = applyResearchPreferences(plan, {
      researchFocus: "AI exposure only",
    });
    const fetchTask = out.tasks.find(
      (t) => t.tool === "fetch_company_profile"
    )!;
    const computeTask = out.tasks.find((t) => t.tool === "compute_dcf")!;
    assert.equal(fetchTask.params.researchFocus, undefined);
    assert.equal(computeTask.params.researchFocus, undefined);
  });

  it("ignores empty / whitespace-only focus strings", () => {
    const plan = makePlan([task("a", "synthesis", "synthesize_report")]);
    const out = applyResearchPreferences(plan, { researchFocus: "    " });
    assert.equal(out.researchFocus, undefined);
    assert.equal(out.tasks[0]!.params.researchFocus, undefined);
  });
});

describe("applyResearchPreferences - customSkills trimming", () => {
  it("keeps all data fetches regardless of skill selection", () => {
    const plan = makePlan([
      task("a", "data_fetch", "fetch_company_profile"),
      task("b", "data_fetch", "fetch_balance_sheet"),
      task("c", "data_fetch", "fetch_news"),
      task("d", "synthesis", "synthesize_report", ["a", "b", "c"]),
    ]);
    const out = applyResearchPreferences(plan, {
      customSkills: ["dcf-valuation"],
    });
    const tools = out.tasks.map((t) => t.tool);
    assert.ok(tools.includes("fetch_company_profile"));
    assert.ok(tools.includes("fetch_balance_sheet"));
    assert.ok(tools.includes("fetch_news"));
    assert.ok(tools.includes("synthesize_report"));
  });

  it("drops compute tasks outside the selected skill's allow-list", () => {
    const plan = makePlan([
      task("a", "data_fetch", "fetch_cash_flow"),
      task("b", "computation", "compute_dcf", ["a"]),
      task("c", "computation", "compute_technical_analysis", ["a"]),
      task("d", "computation", "compute_macro_impact", []),
      task("e", "synthesis", "synthesize_report", ["b", "c", "d"]),
    ]);
    const out = applyResearchPreferences(plan, {
      customSkills: ["dcf-valuation"],
    });
    const tools = out.tasks.map((t) => t.tool);
    assert.ok(tools.includes("compute_dcf"), "DCF task must survive");
    assert.ok(
      !tools.includes("compute_technical_analysis"),
      "Technical analysis task must be trimmed when DCF-only"
    );
    assert.ok(
      !tools.includes("compute_macro_impact"),
      "Macro task must be trimmed when DCF-only"
    );
  });

  it("re-writes dependsOn so the executor doesn't deadlock on dropped deps", () => {
    const plan = makePlan([
      task("a", "data_fetch", "fetch_cash_flow"),
      task("b", "computation", "compute_technical_analysis", ["a"]),
      task("c", "synthesis", "synthesize_report", ["a", "b"]),
    ]);
    const out = applyResearchPreferences(plan, {
      customSkills: ["dcf-valuation"], // does NOT include technical-analysis
    });
    const synth = out.tasks.find((t) => t.tool === "synthesize_report")!;
    assert.deepEqual(
      synth.dependsOn,
      ["a"],
      "dependsOn must drop the trimmed compute task id"
    );
  });

  it("keeps tasks for the union of multiple selected skills", () => {
    const plan = makePlan([
      task("a", "computation", "compute_dcf"),
      task("b", "computation", "compute_macro_impact"),
      task("c", "computation", "compute_technical_analysis"),
      task("d", "computation", "compute_revenue_mix"),
    ]);
    const out = applyResearchPreferences(plan, {
      customSkills: ["dcf-valuation", "macro-analysis"],
    });
    const tools = out.tasks.map((t) => t.tool);
    assert.ok(tools.includes("compute_dcf"));
    assert.ok(tools.includes("compute_macro_impact"));
    assert.ok(
      !tools.includes("compute_technical_analysis"),
      "Tools outside both skills' allow-lists must be trimmed"
    );
    assert.ok(!tools.includes("compute_revenue_mix"));
  });

  it("never trims synthesize_report or compare_stocks", () => {
    const plan = makePlan([
      task("a", "synthesis", "synthesize_report"),
      task("b", "synthesis", "compare_stocks"),
      task("c", "computation", "compute_some_unknown_tool"),
    ]);
    const out = applyResearchPreferences(plan, {
      customSkills: ["dcf-valuation"],
    });
    const tools = out.tasks.map((t) => t.tool);
    assert.ok(tools.includes("synthesize_report"));
    assert.ok(tools.includes("compare_stocks"));
  });
});

// ─── MONEY-792 (C1a): trim-then-augment ──────────────────────────────────

describe("applyResearchPreferences - customSkills augmentation (MONEY-792)", () => {
  // A trigger-matched-style plan: regime-volatility templated its own tasks,
  // but the user's preset ALSO selected the L4-only `risk-var-stress` pack —
  // whose VaR/stress tools the matched skill never templated, so the trim
  // (which only removes) would lose them entirely. Augment must add them.
  function regimeStylePlan(): ResearchPlan {
    return makePlan([
      task("history", "data_fetch", "fetch_price_history"),
      task("price", "data_fetch", "fetch_stock_price"),
      task("vol", "computation", "compute_volatility_regime", ["history"]),
      task("dd", "computation", "compute_drawdown_profile", ["history"]),
      task("beta_dec", "computation", "compute_beta_decomposition", [
        "history",
      ]),
      task("report", "synthesis", "synthesize_report", [
        "history",
        "price",
        "vol",
        "dd",
        "beta_dec",
      ]),
    ]);
  }

  it("appends the risk-var-stress tools missing from a trigger-matched plan", () => {
    const out = applyResearchPreferences(regimeStylePlan(), {
      // regime-volatility owns the templated tasks; risk-var-stress is the
      // extra preset skill whose tools must be added.
      customSkills: ["regime-volatility", "risk-var-stress"],
    });
    const tools = out.tasks.map((t) => t.tool);
    for (const t of [
      "compute_var",
      "compute_drawdown",
      "compute_beta",
      "compute_risk_adjusted_returns",
      "compute_correlation_matrix",
    ]) {
      assert.ok(tools.includes(t), `${t} must be appended by augment`);
    }
    // Sanity: the matched skill's own tasks survived the trim.
    assert.ok(tools.includes("compute_volatility_regime"));
    assert.ok(tools.includes("compute_drawdown_profile"));
  });

  it("makes the synthesis task depend on every appended task", () => {
    const out = applyResearchPreferences(regimeStylePlan(), {
      customSkills: ["regime-volatility", "risk-var-stress"],
    });
    const synth = out.tasks.find((t) => t.tool === "synthesize_report")!;
    const appended = out.tasks.filter((t) => t.id.startsWith("aug_"));
    assert.ok(appended.length > 0, "augment should have added tasks");
    for (const a of appended) {
      assert.ok(
        synth.dependsOn.includes(a.id),
        `synthesis must wait for appended task ${a.id} (${a.tool})`
      );
    }
  });

  it("chains compute_risk_adjusted_returns onto an appended compute_drawdown", () => {
    const out = applyResearchPreferences(regimeStylePlan(), {
      customSkills: ["risk-var-stress"],
    });
    const dd = out.tasks.find((t) => t.tool === "compute_drawdown")!;
    const rar = out.tasks.find(
      (t) => t.tool === "compute_risk_adjusted_returns"
    )!;
    assert.ok(dd, "compute_drawdown must be appended");
    assert.ok(
      rar.dependsOn.includes(dd.id),
      "risk-adjusted returns must depend on the appended drawdown task"
    );
  });

  it("does NOT duplicate a tool already present in the plan", () => {
    // Plan already has compute_var; selecting risk-var-stress must not add a
    // second compute_var task.
    const plan = makePlan([
      task("price_all", "data_fetch", "fetch_stock_price"),
      task("var", "computation", "compute_var", ["price_all"]),
      task("report", "synthesis", "synthesize_report", ["var"]),
    ]);
    const out = applyResearchPreferences(plan, {
      customSkills: ["risk-var-stress"],
    });
    const varTasks = out.tasks.filter((t) => t.tool === "compute_var");
    assert.equal(varTasks.length, 1, "compute_var must not be duplicated");
    // The other risk tools are still added.
    const tools = out.tasks.map((t) => t.tool);
    assert.ok(tools.includes("compute_drawdown"));
    assert.ok(tools.includes("compute_beta"));
  });

  it("appends portfolio-context risk tools dep-free (no deadlock, degrade gracefully)", () => {
    const out = applyResearchPreferences(regimeStylePlan(), {
      customSkills: ["risk-var-stress"],
    });
    const varTask = out.tasks.find((t) => t.tool === "compute_var")!;
    const beta = out.tasks.find((t) => t.tool === "compute_beta")!;
    // VaR / beta inputs are injected by the server-action layer — no fabricated
    // upstream, so they're appended with no dependencies.
    assert.deepEqual(varTask.dependsOn, []);
    assert.deepEqual(beta.dependsOn, []);
  });

  it("gracefully skips a fetch-dependent tool when no subject symbol exists", () => {
    // No symbols on the plan → compute_factor_scores can't get its OHLCV fetch
    // satisfied, so it must be SKIPPED (never appended input-starved).
    const plan: ResearchPlan = {
      query: "factor scan",
      skill: "quant-factor-scores",
      symbols: [], // no subject symbol
      tasks: [task("report", "synthesis", "synthesize_report")],
      estimatedSteps: 1,
      complexity: "complex",
    };
    const out = applyResearchPreferences(plan, {
      customSkills: ["quant-factor-scores"],
    });
    const tools = out.tasks.map((t) => t.tool);
    assert.ok(
      !tools.includes("compute_factor_scores"),
      "fetch-dependent tool must be skipped when its data dep is unsatisfiable"
    );
  });

  it("reuses an existing fetch_price_history instead of appending a duplicate", () => {
    // regimeStylePlan already has a fetch_price_history. quant-factor-scores'
    // compute_factor_scores needs one — it must reuse the existing fetch.
    const out = applyResearchPreferences(regimeStylePlan(), {
      customSkills: ["quant-factor-scores"],
    });
    const fetches = out.tasks.filter((t) => t.tool === "fetch_price_history");
    assert.equal(
      fetches.length,
      1,
      "must reuse the existing price-history fetch, not append a duplicate"
    );
    const fs = out.tasks.find((t) => t.tool === "compute_factor_scores")!;
    assert.ok(
      fs.dependsOn.includes("history"),
      "compute_factor_scores must depend on the existing fetch task id"
    );
  });

  it("appends a fetch_price_history when a fetch-dependent tool needs one and none exists", () => {
    // Plan with a subject symbol but NO price-history fetch.
    const plan: ResearchPlan = {
      query: "factor scan of TCS",
      skill: "fundamentals-core",
      symbols: ["TCS.NS"],
      tasks: [
        task("ratios", "data_fetch", "fetch_key_ratios"),
        task("report", "synthesis", "synthesize_report", ["ratios"]),
      ],
      estimatedSteps: 2,
      complexity: "complex",
    };
    const out = applyResearchPreferences(plan, {
      customSkills: ["quant-factor-scores"],
    });
    const fetch = out.tasks.find((t) => t.tool === "fetch_price_history");
    assert.ok(fetch, "a price-history fetch must be appended for the subject");
    assert.equal(fetch!.type, "data_fetch");
    assert.equal((fetch!.params as Record<string, unknown>).symbol, "TCS.NS");
    const fs = out.tasks.find((t) => t.tool === "compute_factor_scores")!;
    assert.ok(
      fs.dependsOn.includes(fetch!.id),
      "compute_factor_scores must depend on the appended fetch"
    );
  });

  it("never appends synthesis / summariser tools even if a skill lists them", () => {
    const out = applyResearchPreferences(regimeStylePlan(), {
      customSkills: ["risk-var-stress"],
    });
    // ALWAYS_KEEP tools (compare_stocks / generate_summary) are never appended.
    const compareTasks = out.tasks.filter((t) => t.tool === "compare_stocks");
    const summaryTasks = out.tasks.filter((t) => t.tool === "generate_summary");
    assert.equal(compareTasks.length, 0);
    assert.equal(summaryTasks.length, 0);
  });

  it("updates estimatedSteps to the augmented task count", () => {
    const before = regimeStylePlan().tasks.length;
    const out = applyResearchPreferences(regimeStylePlan(), {
      customSkills: ["regime-volatility", "risk-var-stress"],
    });
    assert.equal(out.estimatedSteps, out.tasks.length);
    assert.ok(out.estimatedSteps > before, "augment should grow the plan");
  });

  it("is a no-op when every selected-skill tool is already present", () => {
    const plan = makePlan([
      task("history", "data_fetch", "fetch_price_history"),
      task("vr", "computation", "compute_volatility_regime", ["history"]),
      task("dp", "computation", "compute_drawdown_profile", ["history"]),
      task("bd", "computation", "compute_beta_decomposition", ["history"]),
      task("report", "synthesis", "synthesize_report", ["vr", "dp", "bd"]),
    ]);
    const out = applyResearchPreferences(plan, {
      customSkills: ["regime-volatility"],
    });
    // regime-volatility's three compute tools are all present → nothing added.
    assert.ok(!out.tasks.some((t) => t.id.startsWith("aug_")));
  });

  it("augmentPlanWithSkills returns plan.tasks unchanged when customSkills empty", () => {
    const plan = regimeStylePlan();
    assert.equal(augmentPlanWithSkills(plan, undefined), plan.tasks);
    assert.equal(augmentPlanWithSkills(plan, []), plan.tasks);
  });
});

describe("buildAllowedToolSet - sanity", () => {
  it("always includes the synthesis tools", () => {
    const allowed = buildAllowedToolSet(["dcf-valuation"]);
    assert.ok(allowed.has("synthesize_report"));
    assert.ok(allowed.has("compare_stocks"));
  });

  it("returns just the always-keep set for an empty selection", () => {
    const allowed = buildAllowedToolSet([]);
    assert.ok(allowed.has("synthesize_report"));
    assert.ok(!allowed.has("compute_dcf"));
  });

  it("ignores unknown skill IDs gracefully", () => {
    const allowed = buildAllowedToolSet(["does-not-exist", "dcf-valuation"]);
    assert.ok(allowed.has("compute_dcf"));
  });
});
