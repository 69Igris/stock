/**
 * Pure, Next-free fallback generator for the trending-topics route
 * (`route.ts`).
 *
 * The default-trends list + category filter was previously a non-exported
 * function inside the route handler module, testable only via an inline copy.
 * It is extracted here so the REAL fallback can be unit-tested directly.
 * `route.ts` imports and calls `generateFallbackTrends` (and reuses
 * `TrendingTopic`).
 *
 * @see apps/content/__tests__/api/ai-routes.test.ts
 */

export interface TrendingTopic {
  topic: string;
  trendScore: number;
  growth: string;
  category: string;
  searchVolume: string;
  relatedQueries: string[];
}

/**
 * Curated trending blog topics returned when no AI key is configured (or the AI
 * call fails). When `category` is supplied, results are filtered to those whose
 * category contains it (case-insensitive substring match — e.g. "finance"
 * matches both "Finance" and "Personal Finance").
 */
export function generateFallbackTrends(category?: string): TrendingTopic[] {
  const defaultTrends: TrendingTopic[] = [
    {
      topic: "NIFTY 50 All-Time High",
      trendScore: 95,
      growth: "+450%",
      category: "Stock Market",
      searchVolume: "Very High",
      relatedQueries: ["NIFTY target", "market outlook", "index investing"],
    },
    {
      topic: "Small Cap Rally",
      trendScore: 90,
      growth: "+280%",
      category: "Stock Market",
      searchVolume: "High",
      relatedQueries: ["small cap stocks", "multibagger", "penny stocks"],
    },
    {
      topic: "New Tax Regime",
      trendScore: 85,
      growth: "+150%",
      category: "Finance",
      searchVolume: "High",
      relatedQueries: ["tax saving", "old vs new regime", "80C investments"],
    },
    {
      topic: "SIP Investment Trends",
      trendScore: 82,
      growth: "+120%",
      category: "Mutual Funds",
      searchVolume: "High",
      relatedQueries: ["best SIP plans", "SIP calculator", "monthly SIP"],
    },
    {
      topic: "AI Stocks India",
      trendScore: 88,
      growth: "+200%",
      category: "Technology",
      searchVolume: "High",
      relatedQueries: ["AI companies India", "tech stocks", "IT sector"],
    },
    {
      topic: "RBI Policy Impact",
      trendScore: 80,
      growth: "+95%",
      category: "Economy",
      searchVolume: "Medium",
      relatedQueries: ["repo rate", "monetary policy", "inflation"],
    },
    {
      topic: "IPO Calendar 2026",
      trendScore: 78,
      growth: "+110%",
      category: "Stock Market",
      searchVolume: "High",
      relatedQueries: ["upcoming IPO", "IPO review", "grey market premium"],
    },
    {
      topic: "Gold Investment",
      trendScore: 75,
      growth: "+180%",
      category: "Investing",
      searchVolume: "Medium",
      relatedQueries: ["gold ETF", "sovereign gold bond", "gold price"],
    },
    {
      topic: "FIRE Movement India",
      trendScore: 72,
      growth: "+250%",
      category: "Personal Finance",
      searchVolume: "Medium",
      relatedQueries: [
        "early retirement",
        "financial independence",
        "savings rate",
      ],
    },
    {
      topic: "Algo Trading",
      trendScore: 70,
      growth: "+160%",
      category: "Trading",
      searchVolume: "Medium",
      relatedQueries: [
        "algorithmic trading",
        "trading API",
        "automated trading",
      ],
    },
    {
      topic: "EV Stocks India",
      trendScore: 85,
      growth: "+200%",
      category: "Stock Market",
      searchVolume: "High",
      relatedQueries: ["electric vehicle", "Tata Motors", "EV sector"],
    },
    {
      topic: "Demat Account Guide",
      trendScore: 68,
      growth: "+90%",
      category: "Investing",
      searchVolume: "Medium",
      relatedQueries: ["best demat account", "Zerodha", "broker comparison"],
    },
    {
      topic: "Dividend Investing",
      trendScore: 75,
      growth: "+75%",
      category: "Investing",
      searchVolume: "Medium",
      relatedQueries: ["dividend stocks", "dividend yield", "passive income"],
    },
    {
      topic: "Budget Impact Analysis",
      trendScore: 82,
      growth: "+300%",
      category: "Economy",
      searchVolume: "Very High",
      relatedQueries: ["union budget", "sector impact", "tax changes"],
    },
    {
      topic: "Crypto Regulations India",
      trendScore: 70,
      growth: "+140%",
      category: "Finance",
      searchVolume: "Medium",
      relatedQueries: [
        "crypto tax India",
        "crypto ban",
        "virtual digital assets",
      ],
    },
  ];

  if (category) {
    return defaultTrends.filter((t) =>
      t.category.toLowerCase().includes(category.toLowerCase()),
    );
  }

  return defaultTrends;
}
