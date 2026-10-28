/**
 * Peer Comparison Skill - Side-by-side comparison of 2+ stocks
 */

import type { ResearchPlan } from "../types";
import type { ResearchSkill } from "./types";
import { fetchTask, computeTask, synthesisTask } from "./types";
import { resolveSymbol } from "../data-sources/symbol-resolver";

export const peerComparisonSkill: ResearchSkill = {
  name: "peer-comparison",
  description: "Side-by-side comparison of 2 or more stocks",
  triggers: [
    /\b(compare|vs|versus|comparison)\b.*\b(stock|company|share)\b/i,
    /\b[A-Z]{2,}\s+(vs|versus|or|compared\s*to)\s+[A-Z]{2,}\b/i,
  ],
  requiredParams: ["symbols"],
  buildPlan: (params): ResearchPlan => {
    const rawSymbols = params.symbols as string[];
    const symbols = rawSymbols.map((s) => resolveSymbol(s));

    const tasks = [];
    const allTaskIds: string[] = [];

    for (let i = 0; i < symbols.length; i++) {
      const sym = symbols[i]!;
      const prefix = `s${i}`;

      // ── Data fetch phase ──
      const profileId = `${prefix}_profile`;
      const ratiosId = `${prefix}_ratios`;
      const priceId = `${prefix}_price`;
      const financialsId = `${prefix}_financials`;
      const peersId = `${prefix}_peers`;
      const balanceId = `${prefix}_balance`;
      const cashflowId = `${prefix}_cashflow`;
      const shareholdingId = `${prefix}_shareholding`;
      const newsId = `${prefix}_news`;
      const earningsId = `${prefix}_earnings`;
      const analystId = `${prefix}_analyst`;
      const corporateId = `${prefix}_corporate`;
      const priceHistId = `${prefix}_price_hist`;

      tasks.push(
        fetchTask(profileId, "fetch_company_profile", { symbol: sym }),
      );
      tasks.push(fetchTask(ratiosId, "fetch_key_ratios", { symbol: sym }));
      tasks.push(fetchTask(priceId, "fetch_stock_price", { symbols: [sym] }));
      tasks.push(
        fetchTask(financialsId, "fetch_income_statement", { symbol: sym }),
      );
      tasks.push(fetchTask(peersId, "fetch_peer_companies", { symbol: sym }));
      tasks.push(fetchTask(balanceId, "fetch_balance_sheet", { symbol: sym }));
      tasks.push(fetchTask(cashflowId, "fetch_cash_flow", { symbol: sym }));
      tasks.push(
        fetchTask(shareholdingId, "fetch_shareholding_pattern", {
          symbol: sym,
        }),
      );
      tasks.push(fetchTask(newsId, "fetch_news", { symbol: sym }));
      tasks.push(fetchTask(earningsId, "fetch_earnings_data", { symbol: sym }));
      tasks.push(
        fetchTask(analystId, "fetch_analyst_recommendations", { symbol: sym }),
      );
      tasks.push(
        fetchTask(corporateId, "fetch_corporate_actions", { symbol: sym }),
      );
      tasks.push(
        fetchTask(priceHistId, "fetch_price_history", {
          symbol: sym,
          period: "1y",
        }),
      );

      // ── Compute phase (depends on fetched data) ──
      const healthId = `${prefix}_health`;
      const growthId = `${prefix}_growth`;
      const technicalId = `${prefix}_technical`;
      const earningsQId = `${prefix}_earnings_quality`;
      const dcfId = `${prefix}_dcf`;

      tasks.push(
        computeTask(healthId, "compute_health_score", { symbol: sym }, [
          ratiosId,
        ]),
      );
      tasks.push(
        computeTask(growthId, "compute_growth_metrics", { symbol: sym }, [
          financialsId,
          cashflowId,
        ]),
      );
      tasks.push(
        computeTask(
          technicalId,
          "compute_technical_analysis",
          { symbol: sym },
          [priceId, priceHistId],
        ),
      );
      tasks.push(
        computeTask(earningsQId, "compute_earnings_quality", { symbol: sym }, [
          financialsId,
          cashflowId,
        ]),
      );
      tasks.push(
        computeTask(dcfId, "compute_dcf", { symbol: sym }, [
          financialsId,
          balanceId,
          ratiosId,
        ]),
      );

      allTaskIds.push(
        profileId,
        ratiosId,
        priceId,
        financialsId,
        peersId,
        balanceId,
        cashflowId,
        shareholdingId,
        newsId,
        earningsId,
        analystId,
        corporateId,
        priceHistId,
        healthId,
        growthId,
        technicalId,
        earningsQId,
        dcfId,
      );
    }

    tasks.push(
      synthesisTask(
        "compare",
        "compare_stocks",
        {
          query:
            (params.query as string) || `Compare ${rawSymbols.join(" vs ")}`,
        },
        allTaskIds,
      ),
    );

    return {
      query: (params.query as string) || `Compare ${rawSymbols.join(" vs ")}`,
      skill: "peer-comparison",
      symbols,
      tasks,
      estimatedSteps: tasks.length,
      complexity: "moderate",
    };
  },
};
