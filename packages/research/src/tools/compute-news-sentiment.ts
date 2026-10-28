/**
 * News Sentiment & Catalyst Scoring (PURE compute)
 *
 * Scores already-fetched news (NO external API) with a finance-tuned
 * lexicon + simple negation handling. Aggregates net sentiment, momentum
 * (recent half vs older half), and tags catalyst categories by keyword.
 *
 * SEBI: descriptive observations only - no buy/sell/hold/target language.
 * News is injected from fetch_news (result array OR result.articles).
 */

import type { ResearchToolDef, ToolOutput } from "./types";

// ─── Result interface ───────────────────────────────────────

export type NewsSentimentLabel =
  | "positive"
  | "slightly positive"
  | "neutral"
  | "slightly negative"
  | "negative";

export type CatalystCategory =
  | "earnings"
  | "M&A"
  | "regulatory"
  | "management"
  | "product/order"
  | "macro"
  | "rating";

export interface ScoredNewsArticle {
  title: string;
  source: string | null;
  url: string | null;
  date: string | null;
  score: number; // [-1, 1]
  catalyst: CatalystCategory | null;
}

export interface NewsSentimentResult {
  available: boolean;
  reason?: string;
  symbol: string | null;
  articleCount?: number;
  overall?: {
    netSentiment: number; // [-1, 1], mean of article scores
    label: NewsSentimentLabel;
    momentum: number; // recent-half mean minus older-half mean, [-2, 2]
    momentumLabel: "improving" | "stable" | "deteriorating";
  };
  distribution?: {
    pctPositive: number; // 0-100
    pctNeutral: number;
    pctNegative: number;
  };
  catalystCounts?: Record<CatalystCategory, number>;
  articles?: ScoredNewsArticle[]; // capped at MAX_ARTICLES
  observations?: string[];
}

// ─── Finance lexicon ────────────────────────────────────────

const POSITIVE_TERMS: string[] = [
  "surge",
  "surges",
  "surged",
  "soar",
  "soars",
  "soared",
  "rally",
  "rallies",
  "rallied",
  "jump",
  "jumps",
  "jumped",
  "gain",
  "gains",
  "gained",
  "rise",
  "rises",
  "rose",
  "beat",
  "beats",
  "record",
  "record-high",
  "profit",
  "profits",
  "profitable",
  "upgrade",
  "upgraded",
  "expansion",
  "expands",
  "expanded",
  "growth",
  "grow",
  "grows",
  "strong",
  "robust",
  "outperform",
  "outperformed",
  "bullish",
  "win",
  "wins",
  "won",
  "approval",
  "approved",
  "dividend",
  "bonus",
  "buyback",
  "boost",
  "boosts",
  "boosted",
  "high",
  "highs",
  "tops",
  "topped",
  "exceeds",
  "exceeded",
];

const NEGATIVE_TERMS: string[] = [
  "fall",
  "falls",
  "fell",
  "drop",
  "drops",
  "dropped",
  "plunge",
  "plunges",
  "plunged",
  "slump",
  "slumps",
  "slumped",
  "decline",
  "declines",
  "declined",
  "miss",
  "misses",
  "missed",
  "downgrade",
  "downgraded",
  "probe",
  "probes",
  "fraud",
  "scam",
  "default",
  "defaults",
  "defaulted",
  "layoff",
  "layoffs",
  "recall",
  "recalls",
  "recalled",
  "loss",
  "losses",
  "weak",
  "weakens",
  "weakened",
  "slowdown",
  "cut",
  "cuts",
  "slashed",
  "warning",
  "warns",
  "warned",
  "lawsuit",
  "penalty",
  "penalties",
  "fine",
  "fined",
  "bearish",
  "underperform",
  "underperformed",
  "crash",
  "crashes",
  "crashed",
  "tumble",
  "tumbles",
  "tumbled",
  "downturn",
  "delisting",
  "resign",
  "resigns",
  "resigned",
  "quit",
  "exit",
  "exits",
  "low",
  "lows",
];

const NEGATION_TERMS = new Set<string>([
  "not",
  "no",
  "never",
  "without",
  "neither",
  "nor",
]);

// Catalyst keyword map. Ordered by category priority - first matching
// category (by iteration order below) wins for an article.
const CATALYST_KEYWORDS: Array<{ category: CatalystCategory; terms: string[] }> =
  [
    {
      category: "earnings",
      terms: [
        "earnings",
        "results",
        "revenue",
        "profit",
        "loss",
        "ebitda",
        "margin",
        "quarter",
        "quarterly",
        "q1",
        "q2",
        "q3",
        "q4",
        "guidance",
        "eps",
      ],
    },
    {
      category: "M&A",
      terms: [
        "acquisition",
        "acquire",
        "acquires",
        "acquired",
        "merger",
        "merge",
        "merges",
        "takeover",
        "stake",
        "buyout",
        "demerger",
        "divestment",
        "divest",
      ],
    },
    {
      category: "regulatory",
      terms: [
        "sebi",
        "rbi",
        "regulator",
        "regulatory",
        "probe",
        "investigation",
        "lawsuit",
        "penalty",
        "fine",
        "fraud",
        "compliance",
        "tax",
        "court",
        "tribunal",
        "ban",
      ],
    },
    {
      category: "management",
      terms: [
        "ceo",
        "cfo",
        "chairman",
        "managing director",
        "resign",
        "resigns",
        "resigned",
        "appoint",
        "appoints",
        "appointed",
        "board",
        "promoter",
        "management",
        "leadership",
      ],
    },
    {
      category: "product/order",
      terms: [
        "order",
        "orders",
        "contract",
        "deal",
        "launch",
        "launches",
        "launched",
        "product",
        "expansion",
        "capacity",
        "plant",
        "project",
        "partnership",
        "tie-up",
        "wins",
      ],
    },
    {
      category: "macro",
      terms: [
        "inflation",
        "gdp",
        "repo",
        "rate",
        "rupee",
        "crude",
        "oil",
        "fed",
        "monsoon",
        "demand",
        "economy",
        "sector",
        "tariff",
        "export",
        "import",
      ],
    },
    {
      category: "rating",
      terms: [
        "upgrade",
        "downgrade",
        "rating",
        "rated",
        "target",
        "outperform",
        "underperform",
        "buy",
        "sell",
        "hold",
        "analyst",
        "brokerage",
        "crisil",
        "icra",
        "moody",
      ],
    },
  ];

const MAX_ARTICLES = 15;

// ─── Helpers ────────────────────────────────────────────────

function asString(value: unknown): string | null {
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : null;
  }
  return null;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/**
 * Tokenise a title into lowercase word tokens (keeps hyphens for
 * compound lexicon entries like "record-high").
 */
function tokenize(title: string): string[] {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9\- ]+/g, " ")
    .split(/\s+/)
    .filter((t) => t.length > 0);
}

const POSITIVE_SET = new Set(POSITIVE_TERMS);
const NEGATIVE_SET = new Set(NEGATIVE_TERMS);

/**
 * Score one title in [-1, 1] using lexicon hits with a 1-token
 * negation flip ("did not surge" → surge counts negative).
 */
function scoreTitle(title: string): number {
  const tokens = tokenize(title);
  if (tokens.length === 0) return 0;

  let raw = 0;
  let hits = 0;

  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i]!;
    let polarity = 0;
    if (POSITIVE_SET.has(token)) polarity = 1;
    else if (NEGATIVE_SET.has(token)) polarity = -1;

    if (polarity === 0) continue;

    // Look back up to 2 tokens for a negation cue.
    const prev1 = i >= 1 ? tokens[i - 1]! : "";
    const prev2 = i >= 2 ? tokens[i - 2]! : "";
    if (NEGATION_TERMS.has(prev1) || NEGATION_TERMS.has(prev2)) {
      polarity = -polarity;
    }

    raw += polarity;
    hits += 1;
  }

  if (hits === 0) return 0;

  // Normalise by hits so a single strong word and many words land in
  // the same [-1, 1] band; clamp defensively.
  const normalized = raw / hits;
  return Math.max(-1, Math.min(1, normalized));
}

/**
 * Tag the first matching catalyst category (by priority order).
 */
function tagCatalyst(title: string): CatalystCategory | null {
  const lower = title.toLowerCase();
  for (const { category, terms } of CATALYST_KEYWORDS) {
    for (const term of terms) {
      // Word-ish boundary check to avoid sub-string false positives
      // (e.g. "rate" inside "moderate").
      const re = new RegExp(
        `(^|[^a-z])${term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}([^a-z]|$)`,
        "i",
      );
      if (re.test(lower)) return category;
    }
  }
  return null;
}

function labelFor(net: number): NewsSentimentLabel {
  if (net >= 0.4) return "positive";
  if (net >= 0.1) return "slightly positive";
  if (net <= -0.4) return "negative";
  if (net <= -0.1) return "slightly negative";
  return "neutral";
}

/**
 * Pull the article list from whatever shape the executor injects:
 * a bare array, { articles: [...] }, or { data: [...] | { articles } }.
 */
function extractArticles(params: Record<string, unknown>): unknown[] {
  const candidates: unknown[] = [
    params.articles,
    params.news,
    params.data,
    (params.data as Record<string, unknown> | undefined)?.articles,
  ];
  for (const candidate of candidates) {
    if (Array.isArray(candidate)) return candidate;
  }
  return [];
}

function emptyCatalystCounts(): Record<CatalystCategory, number> {
  return {
    earnings: 0,
    "M&A": 0,
    regulatory: 0,
    management: 0,
    "product/order": 0,
    macro: 0,
    rating: 0,
  };
}

// ─── Tool ───────────────────────────────────────────────────

export const computeNewsSentimentTool: ResearchToolDef = {
  name: "compute_news_sentiment",
  description:
    "Score sentiment & catalysts of already-fetched news using a finance lexicon (no external API) - net sentiment, momentum, and catalyst tagging. Descriptive only.",
  category: "computation",
  parameters: {
    articles: {
      type: "array",
      description:
        "News articles from fetch_news (array of { title, link/url, pubDate/date, source }). Injected upstream.",
      required: true,
    },
    symbol: {
      type: "string",
      description: "Stock symbol for attribution (optional)",
    },
  },
  execute: async (params): Promise<ToolOutput> => {
    const symbol = asString(params.symbol);

    try {
      const rawArticles = extractArticles(params);

      if (rawArticles.length === 0) {
        const result: NewsSentimentResult = {
          available: false,
          reason: "No news articles supplied to score",
          symbol,
        };
        return { success: true, data: result };
      }

      const scored: ScoredNewsArticle[] = [];

      for (const item of rawArticles) {
        if (typeof item !== "object" || item === null) continue;
        const obj = item as Record<string, unknown>;

        const title = asString(obj.title);
        if (!title) continue; // title is required to score anything

        const url = asString(obj.url) ?? asString(obj.link);
        const date = asString(obj.date) ?? asString(obj.pubDate);
        const source = asString(obj.source);

        scored.push({
          title,
          source,
          url,
          date,
          score: round2(scoreTitle(title)),
          catalyst: tagCatalyst(title),
        });
      }

      if (scored.length === 0) {
        const result: NewsSentimentResult = {
          available: false,
          reason: "Supplied articles had no usable titles to score",
          symbol,
        };
        return { success: true, data: result };
      }

      // Aggregate net sentiment
      const total = scored.reduce((acc, a) => acc + a.score, 0);
      const netSentiment = round2(total / scored.length);

      // Distribution (neutral band: |score| < 0.1)
      let pos = 0;
      let neg = 0;
      let neu = 0;
      for (const a of scored) {
        if (a.score >= 0.1) pos += 1;
        else if (a.score <= -0.1) neg += 1;
        else neu += 1;
      }
      const n = scored.length;
      const pctPositive = Math.round((pos / n) * 1000) / 10;
      const pctNegative = Math.round((neg / n) * 1000) / 10;
      const pctNeutral = Math.round((neu / n) * 1000) / 10;

      // Momentum: recent half vs older half. Articles are assumed
      // newest-first (Google News RSS ordering), so the FIRST half is
      // the recent window.
      let momentum = 0;
      let momentumLabel: "improving" | "stable" | "deteriorating" = "stable";
      if (scored.length >= 2) {
        const mid = Math.floor(scored.length / 2);
        const recent = scored.slice(0, mid);
        const older = scored.slice(mid);
        const recentMean =
          recent.reduce((acc, a) => acc + a.score, 0) /
          Math.max(1, recent.length);
        const olderMean =
          older.reduce((acc, a) => acc + a.score, 0) /
          Math.max(1, older.length);
        momentum = round2(recentMean - olderMean);
        if (momentum >= 0.15) momentumLabel = "improving";
        else if (momentum <= -0.15) momentumLabel = "deteriorating";
      }

      // Catalyst counts
      const catalystCounts = emptyCatalystCounts();
      for (const a of scored) {
        if (a.catalyst) catalystCounts[a.catalyst] += 1;
      }

      // Descriptive observations (SEBI: no advice language)
      const observations: string[] = [];
      const label = labelFor(netSentiment);
      observations.push(
        `Headline sentiment across ${n} article${n === 1 ? "" : "s"} reads ${label} (net ${netSentiment.toFixed(2)}).`,
      );
      if (momentumLabel === "improving") {
        observations.push(
          "Recent headlines skew more positive than older ones - sentiment momentum is improving.",
        );
      } else if (momentumLabel === "deteriorating") {
        observations.push(
          "Recent headlines skew more negative than older ones - sentiment momentum is deteriorating.",
        );
      }
      const topCatalyst = (
        Object.entries(catalystCounts) as Array<[CatalystCategory, number]>
      )
        .filter(([, c]) => c > 0)
        .sort((a, b) => b[1] - a[1])[0];
      if (topCatalyst) {
        observations.push(
          `Dominant news catalyst: ${topCatalyst[0]} (${topCatalyst[1]} of ${n} headlines).`,
        );
      }

      const result: NewsSentimentResult = {
        available: true,
        symbol,
        articleCount: n,
        overall: {
          netSentiment,
          label,
          momentum,
          momentumLabel,
        },
        distribution: {
          pctPositive,
          pctNeutral,
          pctNegative,
        },
        catalystCounts,
        articles: scored.slice(0, MAX_ARTICLES),
        observations,
      };

      return { success: true, data: result };
    } catch (error) {
      return {
        success: false,
        error: `News sentiment scoring failed: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  },
};
