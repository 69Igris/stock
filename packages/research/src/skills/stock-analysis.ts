/**
 * Stock Analysis Skill - Full company analysis report
 *
 * Triggers: "Analyze RELIANCE", "Should I buy TCS?", "Research HDFC Bank"
 * Output: Profile + financials + ratios + DCF + peers + observation-based
 *   analysis (NOT a buy/sell/hold verdict — UseMoney is not SEBI-registered
 *   as a Research Analyst).
 */

import type { ResearchPlan } from "../types";
import type { ResearchSkill } from "./types";
import { fetchTask, computeTask, synthesisTask } from "./types";
import { resolveSymbol } from "../data-sources/symbol-resolver";

export const stockAnalysisSkill: ResearchSkill = {
  name: "stock-analysis",
  description:
    "Comprehensive stock analysis with financials, valuation, and observation-based commentary (no buy/sell/hold verdict — MONEY-457 SEBI compliance)",
  triggers: [
    /\b(analyz|analyse|research|deep\s*dive|evaluate)\b.*\b(stock|share|company)\b/i,
    /\b(analyz|analyse|research|deep\s*dive|evaluate)\b\s+[A-Z][A-Z0-9&]{1,14}\b/i,
    /\bshould\s*i\s*(buy|sell|invest\s*in|hold)\b/i,
    /\b(is|are)\s+[A-Z]{2,}\s+(a\s+)?(good|bad|worth|overvalued|undervalued)\b/i,
  ],
  requiredParams: ["symbol"],
  optionalParams: ["exchange"],
  buildPlan: (params): ResearchPlan => {
    const symbol = resolveSymbol(
      params.symbol as string,
      (params.exchange as string) || "NSE",
    );

    const tasks = [
      // Phase 1: Data fetch (parallel)
      fetchTask("profile", "fetch_company_profile", { symbol }),
      fetchTask("financials", "fetch_income_statement", {
        symbol,
        quarterly: true,
      }),
      fetchTask("balance", "fetch_balance_sheet", { symbol }),
      fetchTask("cashflow", "fetch_cash_flow", { symbol }),
      fetchTask("ratios", "fetch_key_ratios", { symbol }),
      fetchTask("earnings", "fetch_earnings", { symbol }),
      fetchTask("recommendations", "fetch_analyst_recommendations", { symbol }),
      fetchTask("price", "fetch_stock_price", { symbols: [symbol] }),
      fetchTask("history", "fetch_price_history", { symbol, period: "1y" }),
      fetchTask("peers", "fetch_peer_companies", { symbol }),
      fetchTask("news", "fetch_news", { symbol }),
      fetchTask("shareholding", "fetch_shareholding_pattern", { symbol }),
      // MONEY-613: vector RAG over the embedded filing corpus — grounds the
      // synthesis in primary documents. Degrades to available:false when the
      // corpus isn't indexed / no GCP creds.
      fetchTask("doc_context", "fetch_document_context", { symbol }),

      // Phase 2: Core computations
      computeTask("health", "compute_health_score", {}, ["ratios", "profile"]),
      computeTask("growth", "compute_growth_metrics", {}, ["financials"]),
      computeTask("wacc", "compute_wacc", {}, ["ratios", "price"]),
      computeTask("dcf", "compute_dcf", {}, [
        "cashflow",
        "financials", // adds netIncome as a 3rd-tier FCF fallback (compute_dcf approximates FCF ≈ 0.7 × net income for capital-light businesses when both FCF and OCF/capex are missing)
        "price",
        "ratios",
        "wacc",
      ]),
      computeTask("valuation", "compute_comparative_valuation", {}, [
        "ratios",
        "peers",
        "price",
      ]),

      // Phase 3: Enhanced analysis
      computeTask("cashflow_quality", "compute_cash_flow_quality", {}, [
        "cashflow",
        "financials",
        "price",
      ]),
      computeTask("earnings_quality", "compute_earnings_quality", {}, [
        "financials",
        "cashflow",
        "balance",
      ]),
      computeTask("technicals", "compute_technical_analysis", {}, ["history"]),
      computeTask("dividends", "compute_dividend_analysis", {}, [
        "ratios",
        "cashflow",
        "price",
      ]),
      computeTask("scenarios", "compute_scenario_analysis", {}, [
        "dcf",
        "wacc",
        "price",
      ]),

      // MONEY-613: academic factor scores + news sentiment — built + input-bound
      // but never invoked by any L3/L4 segment. stock-analysis powers the L4
      // business / revenue_mix / shareholding / forward_scenarios segments, so
      // wiring here surfaces them across all four.
      computeTask("factor_scores", "compute_factor_scores", {}, [
        "ratios",
        "history",
      ]),
      computeTask("factor_zscore", "compute_factor_zscore", {}, [
        "factor_scores",
        "peers",
      ]),
      computeTask("composite_quant", "compute_composite_quant_score", {}, [
        "factor_zscore",
        "factor_scores",
      ]),
      computeTask("news_sentiment", "compute_news_sentiment", {}, ["news"]),
      computeTask("earnings_surprise", "compute_earnings_surprise", {}, [
        "earnings",
      ]),

      // Phase 4: Synthesis
      synthesisTask(
        "report",
        "synthesize_report",
        { query: params.query || `Analyze ${params.symbol}` },
        [
          "profile",
          "financials",
          "balance",
          "cashflow",
          "ratios",
          "earnings",
          "recommendations",
          "price",
          "history",
          "peers",
          "news",
          "shareholding",
          "doc_context",
          "health",
          "growth",
          "wacc",
          "dcf",
          "valuation",
          "cashflow_quality",
          "earnings_quality",
          "technicals",
          "dividends",
          "scenarios",
          "factor_scores",
          "factor_zscore",
          "composite_quant",
          "news_sentiment",
          "earnings_surprise",
        ],
      ),
    ];

    return {
      query:
        (params.query as string) ||
        `Comprehensive analysis of ${params.symbol}`,
      skill: "stock-analysis",
      symbols: [symbol],
      tasks,
      estimatedSteps: tasks.length,
      complexity: "complex",
    };
  },
};
