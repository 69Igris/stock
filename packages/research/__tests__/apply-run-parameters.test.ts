/**
 * MONEY-794 (C1c) — institutional run-parameter stamping (pure) — REAL imports.
 *
 * `applyRunParameters` is the mechanism `agent.run` uses (right after
 * `applyResearchPreferences`) to push the new optional run-parameters onto the
 * plan's task params — mirroring the existing `researchFocus` → synthesis-param
 * stamping. These tests assert the REAL exported symbol from
 * `packages/research/src/agent-logic.ts`:
 *   - horizon       → every `fetch_price_history` task's `params.period`
 *                     + horizon onto synthesis-task params (prompt framing)
 *   - benchmark     → mapped to an index symbol on the benchmark fetch ONLY
 *                     (the single source of truth; beta reads that series — no
 *                     inert `params.benchmark` stamp, MONEY-807)
 *   - assumptions   → compute_dcf params ONLY (compute_wacc /
 *                     compute_scenario_analysis no longer get an inert
 *                     `params.assumptions` stamp, MONEY-807)
 *   - reportLength  → synthesis-task params
 *   - varConfig     → compute_var / compute_position_var params
 *
 * Backward-compat invariant: an EMPTY run-param set leaves every task's params
 * byte-identical to the input plan.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  applyRunParameters,
  resolveBenchmarkSymbol,
  type RunParameters,
} from "../src/agent-logic";
import type { ResearchPlan, ResearchTask } from "../src/types";

function task(
  id: string,
  type: ResearchTask["type"],
  tool: string,
  params: Record<string, unknown> = {},
): ResearchTask {
  return { id, type, tool, params, dependsOn: [], status: "pending" };
}

function basePlan(): ResearchPlan {
  return {
    query: "Analyse TCS",
    symbols: ["TCS.NS"],
    estimatedSteps: 6,
    complexity: "moderate",
    tasks: [
      task("hist", "data_fetch", "fetch_price_history", {
        symbol: "TCS.NS",
        period: "1y",
      }),
      task("bench", "data_fetch", "fetch_price_history", {
        symbol: "^NSEI",
        period: "1y",
      }),
      task("beta", "computation", "compute_beta_decomposition", {
        symbol: "TCS.NS",
      }),
      task("wacc", "computation", "compute_wacc", { symbol: "TCS.NS" }),
      task("dcf", "computation", "compute_dcf", { symbol: "TCS.NS" }),
      task("scenario", "computation", "compute_scenario_analysis", {
        symbol: "TCS.NS",
      }),
      task("pvar", "computation", "compute_position_var", { symbol: "TCS.NS" }),
      task("var", "computation", "compute_var", {}),
      task("synth", "synthesis", "synthesize_report", { query: "Analyse TCS" }),
    ],
  };
}

const byId = (plan: ResearchPlan, id: string) =>
  plan.tasks.find((t) => t.id === id)!;

describe("applyRunParameters - backward compatibility", () => {
  it("empty run-params leave every task's params unchanged", () => {
    const plan = basePlan();
    const out = applyRunParameters(plan, {});
    assert.equal(out.tasks.length, plan.tasks.length);
    for (let i = 0; i < plan.tasks.length; i++) {
      assert.deepEqual(out.tasks[i]!.params, plan.tasks[i]!.params);
    }
  });

  it("does not mutate the input plan's tasks", () => {
    const plan = basePlan();
    const before = JSON.parse(JSON.stringify(plan.tasks));
    applyRunParameters(plan, { horizon: "5y", benchmark: "SENSEX" });
    assert.deepEqual(plan.tasks, before);
  });
});

describe("applyRunParameters - horizon", () => {
  it("stamps horizon onto every fetch_price_history.period", () => {
    const out = applyRunParameters(basePlan(), { horizon: "5y" });
    assert.equal(byId(out, "hist").params.period, "5y");
    assert.equal(byId(out, "bench").params.period, "5y");
  });

  it("stamps horizon onto synthesis-task params (prompt framing)", () => {
    const out = applyRunParameters(basePlan(), { horizon: "3y" });
    assert.equal(byId(out, "synth").params.horizon, "3y");
  });

  it("leaves non-fetch tasks' period untouched", () => {
    const out = applyRunParameters(basePlan(), { horizon: "5y" });
    assert.equal(byId(out, "dcf").params.period, undefined);
  });
});

describe("applyRunParameters - benchmark", () => {
  it("maps a known benchmark id to its index symbol on the benchmark fetch", () => {
    const out = applyRunParameters(basePlan(), { benchmark: "SENSEX" });
    assert.equal(byId(out, "bench").params.symbol, "^BSESN");
    // Subject fetch (TCS) is NOT a benchmark series — keep its symbol.
    assert.equal(byId(out, "hist").params.symbol, "TCS.NS");
  });

  // MONEY-807 — the benchmark fetch rewrite is the single source of truth.
  // compute_beta_decomposition reads the rewritten benchmark fetch SERIES, so
  // the old `params.benchmark` stamp on the beta task was inert and is dropped.
  it("does NOT stamp an inert params.benchmark onto compute_beta_decomposition", () => {
    const out = applyRunParameters(basePlan(), { benchmark: "NIFTY500" });
    assert.equal(byId(out, "beta").params.benchmark, undefined);
    // The benchmark is applied via the benchmark fetch task instead.
    assert.equal(byId(out, "bench").params.symbol, "^CRSLDX");
  });

  it("a free-text sector benchmark still rewrites the benchmark fetch only", () => {
    const out = applyRunParameters(basePlan(), { benchmark: "Nifty Bank" });
    // Free-text passes through resolveBenchmarkSymbol untouched onto the fetch.
    assert.equal(byId(out, "bench").params.symbol, "Nifty Bank");
    assert.equal(byId(out, "beta").params.benchmark, undefined);
  });

  // MONEY-779 — BENCHMARK_FETCH_RE used to loosely match the substring
  // `NIFTY`, so a real ETF subject like NIFTYBEES had its OWN OHLCV fetch
  // symbol overwritten with the benchmark index. The regex is now anchored to
  // exact index tickers (^NSEI/^BSESN/^CRSLDX) so only the benchmark fetch task
  // is ever rewritten.
  it("does NOT rewrite a NIFTYBEES subject fetch when a benchmark is set", () => {
    const plan: ResearchPlan = {
      query: "Analyse NIFTYBEES",
      symbols: ["NIFTYBEES.NS"],
      estimatedSteps: 3,
      complexity: "simple",
      tasks: [
        // Subject fetch — its symbol contains "NIFTY" but is a tradable ETF.
        task("subj", "data_fetch", "fetch_price_history", {
          symbol: "NIFTYBEES.NS",
          period: "1y",
        }),
        // Benchmark fetch — an actual index symbol.
        task("bench", "data_fetch", "fetch_price_history", {
          symbol: "^NSEI",
          period: "1y",
        }),
      ],
    };
    const out = applyRunParameters(plan, { benchmark: "SENSEX" });
    // Subject ETF keeps its own symbol — NOT clobbered with the benchmark.
    assert.equal(byId(out, "subj").params.symbol, "NIFTYBEES.NS");
    // Only the benchmark fetch task is rewritten to the chosen index.
    assert.equal(byId(out, "bench").params.symbol, "^BSESN");
  });

  it("rewrites benchmark fetches given as a bare (caret-less) index ticker", () => {
    const plan: ResearchPlan = {
      query: "Analyse RELIANCE",
      symbols: ["RELIANCE.NS"],
      estimatedSteps: 2,
      complexity: "simple",
      tasks: [
        task("bench", "data_fetch", "fetch_price_history", {
          symbol: "NSEI",
          period: "1y",
        }),
        // Another ETF subject whose ticker embeds an index name.
        task("subj", "data_fetch", "fetch_price_history", {
          symbol: "SENSEXBEES.BO",
          period: "1y",
        }),
      ],
    };
    const out = applyRunParameters(plan, { benchmark: "NIFTY500" });
    assert.equal(byId(out, "bench").params.symbol, "^CRSLDX");
    assert.equal(byId(out, "subj").params.symbol, "SENSEXBEES.BO");
  });
});

describe("applyRunParameters - assumptions", () => {
  it("maps assumption overrides onto compute_dcf's tool param names", () => {
    const out = applyRunParameters(basePlan(), {
      assumptions: { wacc: 0.11, terminalGrowth: 0.04, growthOverride: 0.15 },
    });
    const dcf = byId(out, "dcf").params;
    assert.equal(dcf.wacc, 0.11);
    assert.equal(dcf.terminalGrowthRate, 0.04);
    assert.equal(dcf.growthRate, 0.15);
    assert.deepEqual(dcf.assumptions, {
      wacc: 0.11,
      terminalGrowth: 0.04,
      growthOverride: 0.15,
    });
  });

  // MONEY-807 — no tool reads `params.assumptions` on compute_wacc /
  // compute_scenario_analysis, so the inert stamp is dropped. compute_dcf
  // (asserted above) is the only tool that consumes the assumption overrides.
  it("does NOT stamp an inert params.assumptions onto wacc + scenario tasks", () => {
    const out = applyRunParameters(basePlan(), {
      assumptions: { wacc: 0.12 },
    });
    assert.equal(byId(out, "wacc").params.assumptions, undefined);
    assert.equal(byId(out, "scenario").params.assumptions, undefined);
  });

  it("an empty assumptions object is a no-op", () => {
    const out = applyRunParameters(basePlan(), { assumptions: {} });
    assert.equal(byId(out, "dcf").params.wacc, undefined);
    assert.equal(byId(out, "dcf").params.assumptions, undefined);
  });
});

describe("applyRunParameters - reportLength", () => {
  it("stamps reportLength onto synthesis-task params", () => {
    const out = applyRunParameters(basePlan(), { reportLength: "full" });
    assert.equal(byId(out, "synth").params.reportLength, "full");
  });
});

describe("applyRunParameters - varConfig", () => {
  it("maps horizonDays onto compute_var.period and carries raw varConfig", () => {
    const out = applyRunParameters(basePlan(), {
      varConfig: { confidence: 99, horizonDays: 10 },
    });
    assert.equal(byId(out, "var").params.period, "10-day");
    assert.deepEqual(byId(out, "var").params.varConfig, {
      confidence: 99,
      horizonDays: 10,
    });
  });

  it("carries varConfig onto compute_position_var", () => {
    const out = applyRunParameters(basePlan(), {
      varConfig: { confidence: 95 },
    });
    assert.deepEqual(byId(out, "pvar").params.varConfig, { confidence: 95 });
  });

  it("horizonDays=1 → 1-day period", () => {
    const out = applyRunParameters(basePlan(), {
      varConfig: { horizonDays: 1 },
    });
    assert.equal(byId(out, "var").params.period, "1-day");
  });
});

describe("resolveBenchmarkSymbol (research package copy)", () => {
  it("maps known ids and defaults to ^NSEI", () => {
    assert.equal(resolveBenchmarkSymbol("NIFTY50"), "^NSEI");
    assert.equal(resolveBenchmarkSymbol("SENSEX"), "^BSESN");
    assert.equal(resolveBenchmarkSymbol(), "^NSEI");
    assert.equal(resolveBenchmarkSymbol("Custom Index"), "Custom Index");
  });
});

// Sanity: the RunParameters interface is exported and structurally usable.
const _typecheck: RunParameters = {
  horizon: "1y",
  benchmark: "NIFTY50",
  assumptions: { wacc: 0.1 },
  reportLength: "standard",
  varConfig: { confidence: 95, horizonDays: 1 },
};
void _typecheck;
