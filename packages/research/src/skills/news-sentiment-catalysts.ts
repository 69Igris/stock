/**
 * News, Sentiment & Catalysts Skill - Recent developments and event-driven signals
 *
 * Triggers: "news sentiment / analysis", "sentiment analysis / score", "catalysts",
 * "recent news / developments", "positive / negative news".
 *
 * Output: a digest of recent news with a sentiment read (positive/negative/neutral
 * with a score), upcoming or recent corporate actions, and the catalysts that could
 * move the story.
 *
 * SEBI: observation-only. The report summarises what was reported and how it reads;
 * it does NOT recommend trades or predict price direction.
 */

import type { ResearchPlan } from "../types";
import type { ResearchSkill } from "./types";
import { fetchTask, computeTask, synthesisTask } from "./types";
import { resolveSymbol } from "../data-sources/symbol-resolver";
import { isLakeQueryConfigured } from "../tools/query-lake";

export const newsSentimentCatalystsSkill: ResearchSkill = {
  name: "news-sentiment-catalysts",
  description:
    "News, sentiment & catalysts - recent news/developments, a sentiment read (score + positive/negative skew), corporate actions, and event-driven catalysts around a stock (observation-only)",
  triggers: [
    // News sentiment / news analysis (the sentiment-of-news sense, not bare "analyze X")
    /\bnews\s*(sentiment|analysis|sentiment\s*analysis|tone)\b/i,
    // Sentiment analysis / sentiment score
    /\bsentiment\s*(analysis|score|read|check)\b/i,
    /\banaly[sz]e?d?\s*(the\s*)?sentiment\b/i,
    // Catalysts
    /\b(catalysts?|catalyst\s*(map|watch|calendar))\b/i,
    // Recent news / developments
    /\b(recent|latest)\s*(news|developments?|updates?|headlines?)\b/i,
    /\bnews\s*(flow|digest|roundup|round[\s-]?up)\b/i,
    // Positive / negative news
    /\b(positive|negative|good|bad|bullish|bearish)\s*news\b/i,
  ],
  requiredParams: ["symbol"],
  optionalParams: ["exchange"],
  buildPlan: (params): ResearchPlan => {
    const symbol = resolveSymbol(
      params.symbol as string,
      (params.exchange as string) || "NSE",
    );

    const lake = isLakeQueryConfigured();
    const tasks = [
      // Phase 1: Data fetch (parallel, no deps)
      fetchTask("news", "fetch_news", { symbol }),
      fetchTask("corporate_actions", "fetch_corporate_actions", { symbol }),
      // MONEY-1597 (C5b) - what the price did AFTER this listing's past
      // events: 1/5/20-session returns and abnormal returns, point-in-time,
      // each citable by event_id. Empty (not failed) for a listing the lake
      // holds no events or bars for. Planned ONLY where the tool can run: an
      // unconfigured deployment would otherwise fail it in every report.
      ...(lake
        ? [
            // The RAW symbol and its exchange, never the Yahoo form:
            // resolveSymbol spells M&M as M%26M and gives a bare US ticker
            // a .NS suffix (MONEY-1597 re-review).
            fetchTask("event_reactions", "query_lake", {
              template: "events_for_listing",
              symbol: String(params.symbol).trim(),
              exchange: (params.exchange as string) || "NSE",
            }),
          ]
        : []),

      // Phase 2: Compute (sentiment reads the fetched news)
      computeTask("news_sentiment", "compute_news_sentiment", {}, ["news"]),

      // Phase 3: Synthesis (depends on every prior task)
      synthesisTask(
        "report",
        "synthesize_report",
        {
          query:
            (params.query as string) ||
            `News, sentiment & catalysts of ${params.symbol}`,
        },
        [
          "news",
          "corporate_actions",
          ...(lake ? ["event_reactions"] : []),
          "news_sentiment",
        ],
      ),
    ];

    return {
      query:
        (params.query as string) ||
        `News, sentiment & catalysts of ${params.symbol}`,
      skill: "news-sentiment-catalysts",
      symbols: [symbol],
      tasks,
      estimatedSteps: tasks.length,
      complexity: "complex",
    };
  },
};
