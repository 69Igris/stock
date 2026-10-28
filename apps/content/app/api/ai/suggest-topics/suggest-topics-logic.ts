/**
 * Pure, Next-free fallback generator for the suggest-topics route (`route.ts`).
 *
 * The default-topics list + slice logic was previously a non-exported function
 * inside the route handler module, testable only via an inline copy. It is
 * extracted here so the REAL fallback can be unit-tested directly. `route.ts`
 * imports and calls `generateFallbackTopics` (and reuses `TopicSuggestion`).
 *
 * @see apps/content/__tests__/api/ai-generation.test.ts
 */

export interface TopicSuggestion {
  topic: string;
  description: string;
  relevanceScore: number;
  relatedKeywords: string[];
}

/**
 * Curated India-specific blog topic suggestions returned when no AI key is
 * configured (or the AI call fails). `count` caps the number returned (the list
 * has 10 entries, so requesting more returns all 10).
 */
export function generateFallbackTopics(
  category?: string,
  count = 10,
): TopicSuggestion[] {
  const defaultTopics: TopicSuggestion[] = [
    {
      topic: "NIFTY 50 Analysis",
      description:
        "Understanding NIFTY 50 trends and their impact on portfolios",
      relevanceScore: 9,
      relatedKeywords: ["NIFTY", "index investing", "market trends", "BSE"],
    },
    {
      topic: "SIP vs Lumpsum",
      description:
        "Comparing systematic investment plans with lumpsum investing strategies",
      relevanceScore: 8,
      relatedKeywords: [
        "SIP",
        "mutual funds",
        "investing strategy",
        "rupee cost averaging",
      ],
    },
    {
      topic: "IPO Analysis Guide",
      description: "How to evaluate upcoming IPOs in the Indian market",
      relevanceScore: 8,
      relatedKeywords: ["IPO", "primary market", "listing gains", "DRHP"],
    },
    {
      topic: "Tax-Saving Investments",
      description: "Best tax-saving investment options under Section 80C",
      relevanceScore: 9,
      relatedKeywords: ["80C", "ELSS", "tax saving", "PPF"],
    },
    {
      topic: "Portfolio Diversification",
      description: "Building a well-diversified portfolio for Indian investors",
      relevanceScore: 7,
      relatedKeywords: [
        "diversification",
        "asset allocation",
        "risk management",
        "equity",
      ],
    },
    {
      topic: "F&O Trading Basics",
      description:
        "Introduction to futures and options trading in Indian markets",
      relevanceScore: 8,
      relatedKeywords: ["futures", "options", "derivatives", "hedging"],
    },
    {
      topic: "Mutual Fund Selection",
      description: "Framework for choosing the right mutual funds",
      relevanceScore: 8,
      relatedKeywords: [
        "mutual funds",
        "fund selection",
        "AMC",
        "expense ratio",
      ],
    },
    {
      topic: "Stock Screener Guide",
      description: "Using stock screeners to find investment opportunities",
      relevanceScore: 7,
      relatedKeywords: ["screening", "fundamentals", "PE ratio", "market cap"],
    },
    {
      topic: "FIRE Planning India",
      description: "Financial Independence Retire Early strategies for Indians",
      relevanceScore: 8,
      relatedKeywords: [
        "FIRE",
        "retirement",
        "financial independence",
        "savings rate",
      ],
    },
    {
      topic: "Budget Impact Markets",
      description: "How Union Budget affects stock market sectors",
      relevanceScore: 7,
      relatedKeywords: [
        "budget",
        "fiscal policy",
        "sector impact",
        "market reaction",
      ],
    },
  ];

  return defaultTopics.slice(0, count);
}
