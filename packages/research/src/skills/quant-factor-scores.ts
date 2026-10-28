/**
 * Quant Factor Scores Skill - Multi-factor exposure & composite quant ranking
 *
 * Triggers: "factor analysis", "factor exposure", "quant score", "factor rank",
 *           "value/quality/momentum/low-vol factor", "multi-factor model"
 * Output: per-factor raw scores (value, quality, momentum, low-volatility),
 *         peer-relative z-scores, and a composite quant score / rank.
 *
 * SEBI: observation-only. Surfaces factor exposures and a composite score for
 * informational purposes; no buy/sell recommendation is implied.
 */

import type { ResearchPlan } from "../types";
import type { ResearchSkill } from "./types";
import { fetchTask, computeTask, synthesisTask } from "./types";
import { resolveSymbol } from "../data-sources/symbol-resolver";

export const quantFactorScoresSkill: ResearchSkill = {
  name: "quant-factor-scores",
  description:
    "Multi-factor quant analysis - value, quality, momentum & low-volatility factor scores, peer-relative z-scores, and a composite quant score / rank",
  triggers: [
    // factor analysis / score / exposure / model
    /\bfactor\s*(analysis|scores?|exposures?|model|loadings?|tilts?)\b/i,
    // quant score / quant rank / quant model
    /\bquant\s*(score|scores|rank|ranking|model|analysis)\b/i,
    // named factors: value / quality / momentum / low-vol(atility)
    /\b(value|quality|momentum|low.?vol(atility)?)\s*factor(s)?\b/i,
    // multi-factor framing
    /\bmulti.?factor\b/i,
    // composite quant scoring
    /\bcomposite\s*(quant|factor)\s*(score|rank)\b/i,
  ],
  requiredParams: ["symbol"],
  optionalParams: ["exchange"],
  buildPlan: (params): ResearchPlan => {
    const symbol = resolveSymbol(
      params.symbol as string,
      (params.exchange as string) || "NSE",
    );

    const tasks = [
      // Phase 1: Data fetch (parallel, no deps)
      fetchTask("ratios", "fetch_key_ratios", { symbol }),
      fetchTask("history", "fetch_price_history", { symbol, period: "2y" }),
      fetchTask("peers", "fetch_peer_companies", { symbol }),
      fetchTask("profile", "fetch_company_profile", { symbol }),
      fetchTask("price", "fetch_stock_price", { symbols: [symbol] }),

      // Phase 2: Factor computations
      // Raw per-factor scores need fundamentals (ratios) + price series (history).
      computeTask("factor_scores", "compute_factor_scores", {}, [
        "ratios",
        "history",
      ]),
      // Peer-relative z-scores need the raw factor scores + the peer set.
      computeTask("factor_zscore", "compute_factor_zscore", {}, [
        "factor_scores",
        "peers",
      ]),
      // Composite quant score blends raw factor scores + their z-scores.
      computeTask("composite_quant", "compute_composite_quant_score", {}, [
        "factor_scores",
        "factor_zscore",
      ]),

      // Phase 3: Synthesis (depends on ALL prior task ids)
      synthesisTask(
        "report",
        "synthesize_report",
        {
          query:
            (params.query as string) ||
            `Quant factor scores of ${params.symbol}`,
        },
        [
          "ratios",
          "history",
          "peers",
          "profile",
          "price",
          "factor_scores",
          "factor_zscore",
          "composite_quant",
        ],
      ),
    ];

    return {
      query:
        (params.query as string) || `Quant factor scores of ${params.symbol}`,
      skill: "quant-factor-scores",
      symbols: [symbol],
      tasks,
      estimatedSteps: tasks.length,
      complexity: "complex",
    };
  },
};
