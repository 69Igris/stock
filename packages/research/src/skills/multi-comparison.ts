/**
 * Multi-Stock Comparison Skill (L3)
 *
 * For comparing 3+ stocks in detail. Each stock gets a full L2 analysis,
 * then a synthesis segment ranks them side-by-side.
 *
 * Triggers: "Compare TCS vs INFY vs WIPRO vs HCL in detail"
 * Output: Per-stock analysis + side-by-side comparison + comparative
 *   ranking by quality score. MONEY-457 SEBI compliance: no "if you can
 *   only buy one" verdict — UseMoney is not SEBI-registered as a
 *   Research Analyst. Each stock is described neutrally; no winner is
 *   named.
 *
 * MONEY-551: each compared stock is enriched with the MONEY-498
 *   institutional toolset — factor scores + composite quant, relative
 *   valuation vs peers, governance flags, and a volatility/risk regime —
 *   so the side-by-side ranking reflects multi-factor evidence, not just
 *   headline ratios. Depth-aware: "deep" stays lean (factors + relative
 *   valuation); "comprehensive"/"advanced" runs the full institutional
 *   set. Still observations/scores/flags only — never a winner.
 */

import type { ResearchPlan, ResearchTask } from "../types";
import type { ResearchSkill } from "./types";
import { fetchTask, computeTask, synthesisTask } from "./types";
import { resolveSymbol } from "../data-sources/symbol-resolver";

export const multiComparisonSkill: ResearchSkill = {
  name: "multi-comparison",
  description:
    "Deep multi-stock comparison with per-stock analysis and side-by-side ranking",
  triggers: [
    // This skill is triggered programmatically by L3 classifier, not by regex
    /\b__NEVER_MATCH__\b/,
  ],
  requiredParams: ["symbols"],
  optionalParams: ["exchange", "depth"],
  buildPlan: (params): ResearchPlan => {
    const symbols = (params.symbols as string[]).map((s) =>
      resolveSymbol(s, (params.exchange as string) || "NSE"),
    );

    // Depth-aware enrichment.
    //   Lean (factors + relative valuation only) ≈ 11 tasks/stock.
    //   Full (factors + composite quant + relative valuation + governance
    //   + volatility regime) ≈ 16 tasks/stock.
    // Plan total = per-stock × N + comparative + report.
    //
    // "deep" → always lean (kept fast on demand).
    // "comprehensive" / "advanced" → explicitly opted-in to the full set.
    // Unknown / absent depth → default to full, but only when the comparison
    //   is small enough that the total task count stays under ~56 (the
    //   executor's practical ceiling). Full fits within ~56 only up to 3
    //   stocks (16·3 + 2 = 50); 4–5 stocks fall back to lean to stay capped.
    const depthRaw =
      typeof params.depth === "string" ? params.depth.toLowerCase() : undefined;
    const explicitFull =
      depthRaw === "comprehensive" || depthRaw === "advanced";
    const explicitLean = depthRaw === "deep";
    const defaultFull = depthRaw === undefined && symbols.length <= 3;
    const includeFull = !explicitLean && (explicitFull || defaultFull);

    const tasks: ResearchTask[] = [];

    // Per-stock data fetch and analysis
    for (let i = 0; i < symbols.length; i++) {
      const sym = symbols[i]!;
      const prefix = `stock_${i}`;

      // Data fetch
      tasks.push(
        fetchTask(`${prefix}_profile`, "fetch_company_profile", {
          symbol: sym,
        }),
      );
      tasks.push(
        fetchTask(`${prefix}_ratios`, "fetch_key_ratios", { symbol: sym }),
      );
      tasks.push(
        fetchTask(`${prefix}_financials`, "fetch_income_statement", {
          symbol: sym,
        }),
      );
      tasks.push(
        fetchTask(`${prefix}_price`, "fetch_stock_price", { symbols: [sym] }),
      );
      tasks.push(
        fetchTask(`${prefix}_cashflow`, "fetch_cash_flow", { symbol: sym }),
      );

      // MONEY-498 institutional data fetch
      tasks.push(
        fetchTask(`${prefix}_history`, "fetch_price_history", {
          symbol: sym,
          period: "1y",
        }),
      );
      tasks.push(
        fetchTask(`${prefix}_peers`, "fetch_peer_companies", { symbol: sym }),
      );
      if (includeFull) {
        tasks.push(
          fetchTask(`${prefix}_balance`, "fetch_balance_sheet", {
            symbol: sym,
          }),
        );
        tasks.push(
          fetchTask(`${prefix}_shareholding`, "fetch_shareholding_pattern", {
            symbol: sym,
          }),
        );
      }

      // Computations
      tasks.push(
        computeTask(`${prefix}_health`, "compute_health_score", {}, [
          `${prefix}_ratios`,
          `${prefix}_profile`,
        ]),
      );
      tasks.push(
        computeTask(`${prefix}_growth`, "compute_growth_metrics", {}, [
          `${prefix}_financials`,
        ]),
      );

      // MONEY-498 institutional computations.
      // Factor scores + relative valuation run for every depth (lean set).
      tasks.push(
        computeTask(`${prefix}_factors`, "compute_factor_scores", {}, [
          `${prefix}_ratios`,
          `${prefix}_history`,
        ]),
      );
      tasks.push(
        computeTask(`${prefix}_relval`, "compute_relative_valuation", {}, [
          `${prefix}_ratios`,
          `${prefix}_peers`,
          `${prefix}_price`,
        ]),
      );
      // Composite quant, governance, and volatility regime only on full depth.
      if (includeFull) {
        tasks.push(
          computeTask(`${prefix}_quant`, "compute_composite_quant_score", {}, [
            `${prefix}_factors`,
          ]),
        );
        tasks.push(
          computeTask(`${prefix}_gov`, "compute_governance_flags", {}, [
            `${prefix}_shareholding`,
          ]),
        );
        tasks.push(
          computeTask(`${prefix}_vol`, "compute_volatility_regime", {}, [
            `${prefix}_history`,
          ]),
        );
      }
    }

    // Comparative valuation using all stocks (depends on per-stock ratios —
    // unchanged so the existing compare_stocks contract keeps working).
    tasks.push(
      computeTask(
        "comparative",
        "compare_stocks",
        {
          symbols,
        },
        symbols.map((_, i) => `stock_${i}_ratios`),
      ),
    );

    // Synthesis: rank all stocks. Every enriched task feeds the synthesis so
    // the side-by-side ranking reflects the full institutional evidence base.
    const allDeps: string[] = [];
    for (let i = 0; i < symbols.length; i++) {
      const prefix = `stock_${i}`;
      allDeps.push(
        `${prefix}_profile`,
        `${prefix}_ratios`,
        `${prefix}_financials`,
        `${prefix}_price`,
        `${prefix}_cashflow`,
        `${prefix}_history`,
        `${prefix}_peers`,
        `${prefix}_health`,
        `${prefix}_growth`,
        `${prefix}_factors`,
        `${prefix}_relval`,
      );
      if (includeFull) {
        allDeps.push(
          `${prefix}_balance`,
          `${prefix}_shareholding`,
          `${prefix}_quant`,
          `${prefix}_gov`,
          `${prefix}_vol`,
        );
      }
    }
    allDeps.push("comparative");

    tasks.push(
      synthesisTask(
        "report",
        "synthesize_report",
        {
          query: params.query || `Compare ${symbols.join(" vs ")}`,
          outputFormat: "multi_comparison",
        },
        allDeps,
      ),
    );

    return {
      query:
        (params.query as string) ||
        `Deep comparison of ${symbols.join(" vs ")}`,
      skill: "multi-comparison",
      symbols,
      tasks,
      estimatedSteps: tasks.length,
      complexity: "complex",
    };
  },
};
