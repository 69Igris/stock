/**
 * Fetch News - Google News RSS
 */

import { fetchNews } from "../data-sources/news-client";
import { toNseSymbol } from "../data-sources/symbol-resolver";
import type { ResearchToolDef, ToolOutput } from "./types";

export const fetchNewsTool: ResearchToolDef = {
  name: "fetch_news",
  description:
    "Fetch recent news articles about a stock from Google News. Every article includes a verifiable source URL (Economic Times, Mint, Business Standard, Reuters, etc.) so the synthesizer can attribute claims back to original reporting.",
  category: "data",
  parameters: {
    symbol: { type: "string", description: "Stock symbol", required: true },
    maxArticles: {
      type: "number",
      description: "Max articles to fetch",
      default: 20,
    },
  },
  cacheTTL: 1800, // 30min
  execute: async (params): Promise<ToolOutput> => {
    const symbol = toNseSymbol(params.symbol as string);
    const maxArticles = (params.maxArticles as number) || 20;

    if (!symbol) return { success: false, error: "symbol is required" };

    try {
      const articles = await fetchNews(symbol, maxArticles);
      return { success: true, data: articles };
    } catch (error) {
      return {
        success: false,
        error: `Failed to fetch news: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  },
};
