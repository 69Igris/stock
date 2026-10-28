/**
 * News Sentiment & Catalyst Scoring Tool Tests
 * (packages/research/src/tools/compute-news-sentiment.ts)
 *
 * PURE compute tool — no network/db/io, fully deterministic.
 *
 * Coverage:
 *   - Tool metadata sanity (name / category / execute)
 *   - Happy path (success:true, available:true, field presence + types)
 *   - Known-value numeric assertion (runtime-verified expected values)
 *   - Graceful degradation: available:false when no articles supplied OR
 *     no supplied article has a usable title (still success:true, with a
 *     `reason` string — NOT success:false)
 *   - Edge cases: empty / zero / negative / short series / missing optional
 *     fields / negation handling / alternate article-list shapes — must not
 *     throw and must keep success:true
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { computeNewsSentimentTool } from "../../../../packages/research/src/tools/compute-news-sentiment";

// ── Shape of result.data (mirrors NewsSentimentResult) ───────────────
type NewsSentimentLabel =
  | "positive"
  | "slightly positive"
  | "neutral"
  | "slightly negative"
  | "negative";

type CatalystCategory =
  | "earnings"
  | "M&A"
  | "regulatory"
  | "management"
  | "product/order"
  | "macro"
  | "rating";

interface ScoredNewsArticle {
  title: string;
  source: string | null;
  url: string | null;
  date: string | null;
  score: number;
  catalyst: CatalystCategory | null;
}

interface NewsSentimentResult {
  available: boolean;
  reason?: string;
  symbol: string | null;
  articleCount?: number;
  overall?: {
    netSentiment: number;
    label: NewsSentimentLabel;
    momentum: number;
    momentumLabel: "improving" | "stable" | "deteriorating";
  };
  distribution?: {
    pctPositive: number;
    pctNeutral: number;
    pctNegative: number;
  };
  catalystCounts?: Record<CatalystCategory, number>;
  articles?: ScoredNewsArticle[];
  observations?: string[];
}

const EPS = 1e-9;

async function run(args: Record<string, unknown>) {
  return computeNewsSentimentTool.execute(args);
}

function asData(r: { success: boolean; data?: unknown }): NewsSentimentResult {
  assert.ok(r.data, "expected data on tool output");
  return r.data as NewsSentimentResult;
}

// ── 1. Tool metadata sanity ──────────────────────────────────────────
test("tool is wired with name + category + execute", () => {
  assert.equal(computeNewsSentimentTool.name, "compute_news_sentiment");
  assert.equal(computeNewsSentimentTool.category, "computation");
  assert.equal(typeof computeNewsSentimentTool.execute, "function");
});

// ── 2. Happy path: success:true, available:true, field types ─────────
test("happy path returns success:true, available:true with typed fields", async () => {
  const r = await run({
    symbol: "TCS",
    articles: [
      {
        title: "TCS profit jumps, revenue beats estimates this quarter",
        source: "Mint",
        url: "https://example.com/a",
        date: "2026-05-01",
      },
      {
        title: "TCS shares fall after weak guidance and margin slump",
        source: "ET",
        link: "https://example.com/b",
        pubDate: "2026-04-28",
      },
      {
        title: "Brokerage upgrades TCS rating to outperform",
        source: "BS",
      },
    ],
  });

  assert.equal(r.success, true);
  const d = asData(r);

  assert.equal(d.available, true);
  assert.equal(d.symbol, "TCS");
  assert.equal(d.articleCount, 3);

  // overall block + types
  assert.ok(d.overall, "expected overall block");
  assert.equal(typeof d.overall.netSentiment, "number");
  assert.ok(Number.isFinite(d.overall.netSentiment));
  assert.ok(
    d.overall.netSentiment >= -1 - EPS && d.overall.netSentiment <= 1 + EPS
  );
  assert.equal(typeof d.overall.label, "string");
  assert.ok(
    [
      "positive",
      "slightly positive",
      "neutral",
      "slightly negative",
      "negative",
    ].includes(d.overall.label)
  );
  assert.equal(typeof d.overall.momentum, "number");
  assert.ok(Number.isFinite(d.overall.momentum));
  assert.ok(
    ["improving", "stable", "deteriorating"].includes(d.overall.momentumLabel)
  );

  // distribution block + types, sums to ~100
  assert.ok(d.distribution, "expected distribution block");
  assert.equal(typeof d.distribution.pctPositive, "number");
  assert.equal(typeof d.distribution.pctNeutral, "number");
  assert.equal(typeof d.distribution.pctNegative, "number");
  const pctSum =
    d.distribution.pctPositive +
    d.distribution.pctNeutral +
    d.distribution.pctNegative;
  assert.ok(
    Math.abs(pctSum - 100) < 0.5,
    `distribution should sum ~100, got ${pctSum}`
  );

  // catalystCounts present with all 7 keys
  assert.ok(d.catalystCounts, "expected catalystCounts");
  for (const k of [
    "earnings",
    "M&A",
    "regulatory",
    "management",
    "product/order",
    "macro",
    "rating",
  ] as CatalystCategory[]) {
    assert.equal(typeof d.catalystCounts[k], "number");
  }

  // articles array, typed entries
  assert.ok(Array.isArray(d.articles));
  assert.equal(d.articles.length, 3);
  for (const a of d.articles) {
    assert.equal(typeof a.title, "string");
    assert.equal(typeof a.score, "number");
    assert.ok(a.score >= -1 - EPS && a.score <= 1 + EPS);
    // optional fields are string | null
    assert.ok(a.source === null || typeof a.source === "string");
    assert.ok(a.url === null || typeof a.url === "string");
    assert.ok(a.date === null || typeof a.date === "string");
    assert.ok(a.catalyst === null || typeof a.catalyst === "string");
  }

  // observations array of strings
  assert.ok(Array.isArray(d.observations));
  assert.ok(d.observations.length >= 1);
  for (const o of d.observations) assert.equal(typeof o, "string");
});

// ── 3. KNOWN-VALUE numeric assertion (spec-pinned) ───────────────────
test("known-value: single bullish headline scores +1, catalyst earnings, label positive", async () => {
  const r = await run({
    symbol: "RELIANCE",
    articles: [
      { title: "Company posts record profit, stock surges on big order win" },
    ],
  });

  assert.equal(r.success, true);
  const d = asData(r);

  assert.equal(d.available, true);
  assert.equal(d.symbol, "RELIANCE");
  assert.equal(d.articleCount, 1);

  assert.ok(d.articles);
  assert.equal(d.articles.length, 1);
  // score in [-1,1], pinned to exactly 1 (tight float tolerance)
  assert.ok(Math.abs(d.articles[0]!.score - 1) < EPS);
  assert.equal(d.articles[0]!.catalyst, "earnings");

  assert.ok(d.overall);
  assert.equal(d.overall.label, "positive");
  assert.ok(Math.abs(d.overall.netSentiment - 1) < EPS);
  // single article → no momentum window → stable / 0
  assert.ok(Math.abs(d.overall.momentum - 0) < EPS);
  assert.equal(d.overall.momentumLabel, "stable");

  // distribution for a single positive article
  assert.ok(d.distribution);
  assert.ok(Math.abs(d.distribution.pctPositive - 100) < EPS);
  assert.ok(Math.abs(d.distribution.pctNeutral - 0) < EPS);
  assert.ok(Math.abs(d.distribution.pctNegative - 0) < EPS);
});

test("known-value: empty articles array → available:false (still success:true)", async () => {
  const r = await run({ articles: [] });

  assert.equal(r.success, true);
  const d = asData(r);
  assert.equal(d.available, false);
  assert.equal(typeof d.reason, "string");
  assert.ok((d.reason as string).length > 0);
});

test("known-value: bearish-only headline scores -1, label negative", async () => {
  const r = await run({
    articles: [{ title: "Shares crash as company reports massive loss" }],
  });

  assert.equal(r.success, true);
  const d = asData(r);
  assert.equal(d.available, true);
  assert.ok(d.articles);
  // crash(-1) + loss(-1) → raw -2 / hits 2 → -1
  assert.ok(Math.abs(d.articles[0]!.score - -1) < EPS);
  assert.ok(d.overall);
  assert.equal(d.overall.label, "negative");
  assert.ok(Math.abs(d.overall.netSentiment - -1) < EPS);
});

test("known-value: no-lexicon headline scores 0, label neutral, catalyst null", async () => {
  const r = await run({
    articles: [{ title: "Company holds annual general meeting in Mumbai" }],
  });

  assert.equal(r.success, true);
  const d = asData(r);
  assert.equal(d.available, true);
  assert.ok(d.articles);
  assert.ok(Math.abs(d.articles[0]!.score - 0) < EPS);
  assert.equal(d.articles[0]!.catalyst, null);
  assert.ok(d.overall);
  assert.equal(d.overall.label, "neutral");
});

// ── 4. Graceful degradation ──────────────────────────────────────────
test("graceful: missing articles param → available:false with reason (not success:false)", async () => {
  const r = await run({ symbol: "INFY" });

  assert.equal(r.success, true);
  const d = asData(r);
  assert.equal(d.available, false);
  assert.equal(d.symbol, "INFY");
  assert.equal(typeof d.reason, "string");
  assert.match(d.reason as string, /no news articles/i);
});

test("graceful: articles present but none have usable titles → available:false with reason", async () => {
  const r = await run({
    articles: [
      { title: "" },
      { title: "   " },
      { source: "ET" }, // no title at all
      { title: 42 }, // non-string title
      "not an object",
      null,
    ],
  });

  assert.equal(r.success, true);
  const d = asData(r);
  assert.equal(d.available, false);
  assert.equal(typeof d.reason, "string");
  assert.match(d.reason as string, /no usable titles/i);
});

// ── 5. Edge cases — must not throw, keep success:true ────────────────
test("edge: skips malformed entries but scores the valid ones", async () => {
  const r = await run({
    articles: [
      null,
      "junk",
      123,
      { title: "" },
      { title: "Strong order win boosts growth" },
    ],
  });

  assert.equal(r.success, true);
  const d = asData(r);
  assert.equal(d.available, true);
  // only the one valid title scored
  assert.equal(d.articleCount, 1);
  assert.ok(d.articles);
  assert.equal(d.articles.length, 1);
});

test("edge: missing optional fields default to null", async () => {
  const r = await run({
    articles: [{ title: "Profit beats estimates" }],
  });

  assert.equal(r.success, true);
  const d = asData(r);
  assert.equal(d.available, true);
  assert.ok(d.articles);
  const a = d.articles[0]!;
  assert.equal(a.source, null);
  assert.equal(a.url, null);
  assert.equal(a.date, null);
});

test("edge: negation flips polarity (did not surge → negative)", async () => {
  const r = await run({
    articles: [{ title: "Stock did not surge despite the order" }],
  });

  assert.equal(r.success, true);
  const d = asData(r);
  assert.equal(d.available, true);
  assert.ok(d.articles);
  // "surge" is positive but preceded (within 2 tokens) by "not" → flips to -1
  assert.ok(d.articles[0]!.score < 0);
});

test("edge: accepts alternate list shapes (news / data / data.articles)", async () => {
  const viaNews = await run({ news: [{ title: "Profit surges sharply" }] });
  assert.equal(viaNews.success, true);
  assert.equal(asData(viaNews).available, true);

  const viaData = await run({ data: [{ title: "Profit surges sharply" }] });
  assert.equal(viaData.success, true);
  assert.equal(asData(viaData).available, true);

  const viaDataArticles = await run({
    data: { articles: [{ title: "Profit surges sharply" }] },
  });
  assert.equal(viaDataArticles.success, true);
  assert.equal(asData(viaDataArticles).available, true);
});

test("edge: caps articles list at MAX_ARTICLES (15) while counting all", async () => {
  const articles = Array.from({ length: 25 }, (_, i) => ({
    title: `Company headline number ${i} with growth and profit`,
  }));
  const r = await run({ articles });

  assert.equal(r.success, true);
  const d = asData(r);
  assert.equal(d.available, true);
  // articleCount reflects all scored articles
  assert.equal(d.articleCount, 25);
  // but the returned list is capped
  assert.ok(d.articles);
  assert.equal(d.articles.length, 15);
});

test("edge: missing symbol → null, does not throw", async () => {
  const r = await run({ articles: [{ title: "Profit beats" }] });
  assert.equal(r.success, true);
  const d = asData(r);
  assert.equal(d.symbol, null);
});
