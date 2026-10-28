/**
 * news.service — REAL exports, injected prisma + deps (MONEY-1062 P4b).
 *
 * Pins the faithful web-action behaviours (apps/web/lib/actions/news.ts):
 *   - getStockNews: symbol cleaning (strip .NS/.BO, upper), 30-min freshness
 *     short-circuit, RSS fetch + upsert on stale, error → DB fallback,
 *   - getMarketPulseNews: no-symbols → top-5 holdings → popular fallback,
 *   - getNewsFeed: earnings/corp_action keyword filter (auth-free), market vs
 *     holdings/watchlist symbol sets, the 50 upper limit clamp, empty → [],
 *   - getUpcomingEvents: user-universe + macro (symbol:null) OR, +7-day horizon,
 *     category collapse,
 *   - getDailyBrief: 1h cache hit, null when no holdings / no recent news,
 *     Gemini generate + positive-catalyst count + cache write on the happy path.
 *
 * Source: packages/services/src/news.service.ts
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  getStockNews,
  getMarketPulseNews,
  getNewsFeed,
  getUpcomingEvents,
  getDailyBrief,
  type NewsServiceDeps,
} from "../src/news.service";

// ── injected-prisma harness ──────────────────────────────────────────────────
interface Call {
  where?: Record<string, unknown>;
  data?: Record<string, unknown>;
  select?: unknown;
  orderBy?: unknown;
  take?: number;
}
function fake(delegates: Record<string, (args: Call) => unknown>): {
  prisma: NewsServiceDeps["prisma"];
  calls: Record<string, Call[]>;
} {
  const calls: Record<string, Call[]> = {};
  const db: Record<string, Record<string, (a: Call) => unknown>> = {};
  for (const key of Object.keys(delegates)) {
    const [model, method] = key.split(".");
    db[model!] ??= {};
    db[model!][method!] = async (args: Call) => {
      (calls[key] ??= []).push(args);
      return delegates[key]!(args);
    };
  }
  return { prisma: db as unknown as NewsServiceDeps["prisma"], calls };
}

function stockRow(over: Partial<Record<string, unknown>> = {}) {
  return {
    id: "sn1",
    symbol: "RELIANCE",
    title: "t",
    link: "l1",
    pubDate: new Date("2026-07-01"),
    source: "GOOGLE_NEWS",
    snippet: null,
    sentiment: null,
    fetchedAt: new Date(),
    ...over,
  };
}

// ── getStockNews ─────────────────────────────────────────────────────────────

describe("news.service getStockNews", () => {
  it("cleans the symbol (strip .NS/.BO, uppercase) and short-circuits on a fresh cache", async () => {
    let fetched = false;
    const { prisma, calls } = fake({
      "stockNews.findMany": () => [stockRow({ fetchedAt: new Date() })], // fresh
    });
    const res = await getStockNews("reliance.ns", 8, {
      prisma,
      fetchNews: async () => {
        fetched = true;
        return [];
      },
    });
    assert.equal(res.success, true);
    if (res.success) assert.equal(res.data.articles.length, 1);
    assert.equal(fetched, false); // fresh → no RSS fetch
    assert.equal(calls["stockNews.findMany"]?.[0]?.where?.symbol, "RELIANCE");
  });

  it("fetches + upserts + re-reads when the cache is stale", async () => {
    let reads = 0;
    let upserts = 0;
    const { prisma } = fake({
      "stockNews.findMany": () => {
        reads += 1;
        return reads === 1
          ? [stockRow({ fetchedAt: new Date(0) })] // stale
          : [stockRow({ id: "fresh" })]; // re-read after upsert
      },
      "stockNews.upsert": () => {
        upserts += 1;
        return {};
      },
    });
    const res = await getStockNews("RELIANCE", 8, {
      prisma,
      fetchNews: async () => [
        { title: "new", link: "l2", pubDate: "2026-07-05", snippet: "s" },
      ],
    });
    assert.equal(res.success, true);
    assert.equal(reads, 2); // initial + re-read
    assert.equal(upserts, 1);
    if (res.success) assert.equal(res.data.articles[0]?.id, "fresh");
  });

  it("degrades to a DB fallback (empty) when the read throws", async () => {
    const { prisma } = fake({
      "stockNews.findMany": () => {
        throw new Error("mongo down");
      },
    });
    const res = await getStockNews("RELIANCE", 8, {
      prisma,
      fetchNews: async () => [],
    });
    assert.equal(res.success, true);
    if (res.success) assert.deepEqual(res.data.articles, []);
  });
});

// ── getMarketPulseNews ───────────────────────────────────────────────────────

describe("news.service getMarketPulseNews", () => {
  it("with no symbols uses the caller's top-5 holdings (userId-scoped)", async () => {
    const { prisma, calls } = fake({
      "holding.findMany": () => [{ symbol: "RELIANCE" }, { symbol: "TCS" }],
      "stockNews.findMany": () => [stockRow()],
      "newsArticle.findMany": () => [],
    });
    const res = await getMarketPulseNews("u1", undefined, { prisma });
    assert.equal(res.success, true);
    const hq = calls["holding.findMany"]?.[0];
    assert.equal(hq?.where?.userId, "u1"); // ownership
    assert.equal(hq?.take, 5);
    assert.equal(
      (calls["stockNews.findMany"]?.[0]?.where?.symbol as { in: string[] }).in
        .length,
      2,
    );
  });

  it("falls back to popular large-caps when the user has no holdings", async () => {
    const { prisma, calls } = fake({
      "holding.findMany": () => [],
      "stockNews.findMany": () => [stockRow()],
      "newsArticle.findMany": () => [],
    });
    const res = await getMarketPulseNews("u1", undefined, {
      prisma,
      fetchNews: async () => [],
    });
    assert.equal(res.success, true);
    const inList = (
      calls["stockNews.findMany"]?.[0]?.where?.symbol as { in: string[] }
    ).in;
    assert.ok(inList.includes("RELIANCE") && inList.includes("ICICIBANK"));
  });

  it("degrades to empty (never throws) on an unexpected DB error", async () => {
    // symbols provided → skips the holdings read; the stockNews read throws.
    const { prisma } = fake({
      "stockNews.findMany": () => {
        throw new Error("boom");
      },
    });
    const res = await getMarketPulseNews("u1", ["RELIANCE"], { prisma });
    assert.equal(res.success, true);
    if (res.success) assert.deepEqual(res.data.articles, []);
  });
});

// ── getNewsFeed ──────────────────────────────────────────────────────────────

describe("news.service getNewsFeed", () => {
  it("earnings filter keyword-matches the RSS table (auth-free — no holdings read)", async () => {
    const { prisma, calls } = fake({
      "newsArticle.findMany": () => [
        {
          id: "a1",
          title: "Infosys Q3 earnings beat estimates",
          summary: null,
          url: "u1",
          source: "ET",
          publishedAt: new Date("2026-07-02"),
          symbols: [],
          sentiment: "positive",
        },
        {
          id: "a2",
          title: "Local cricket team wins",
          summary: null,
          url: "u2",
          source: "ET",
          publishedAt: new Date("2026-07-01"),
          symbols: [],
          sentiment: null,
        },
      ],
    });
    const res = await getNewsFeed("u1", { filter: "earnings" }, { prisma });
    assert.equal(res.success, true);
    if (res.success) {
      assert.equal(res.data.articles.length, 1); // only the earnings story
      assert.equal(res.data.articles[0]?.link, "u1");
    }
    assert.equal(calls["holding.findMany"], undefined); // never touched
  });

  it("market filter uses the large-cap set and an UNfiltered RSS query", async () => {
    const { prisma, calls } = fake({
      "stockNews.findMany": () => [],
      "newsArticle.findMany": () => [],
    });
    const res = await getNewsFeed("u1", { filter: "market" }, { prisma });
    assert.equal(res.success, true);
    // market → rss where is {} (latest market-wide), not a symbols filter
    assert.deepEqual(calls["newsArticle.findMany"]?.[0]?.where, {});
  });

  it("clamps limit to 50 (Math.min(limit, 50))", async () => {
    const { prisma, calls } = fake({
      "holding.findMany": () => [{ symbol: "RELIANCE" }],
      "stockNews.findMany": () => [],
      "newsArticle.findMany": () => [],
    });
    const res = await getNewsFeed(
      "u1",
      { filter: "holdings", limit: 999 },
      { prisma },
    );
    assert.equal(res.success, true);
    assert.equal(calls["stockNews.findMany"]?.[0]?.take, 50);
    assert.equal(calls["newsArticle.findMany"]?.[0]?.take, 50);
  });

  it("returns [] (no DB read) when the symbol set is empty", async () => {
    const { prisma, calls } = fake({
      "holding.findMany": () => [],
      "watchlistItem.findMany": () => [],
    });
    const res = await getNewsFeed("u1", { filter: "all" }, { prisma });
    assert.equal(res.success, true);
    if (res.success) assert.deepEqual(res.data.articles, []);
    assert.equal(calls["stockNews.findMany"], undefined);
  });
});

// ── getUpcomingEvents ────────────────────────────────────────────────────────

describe("news.service getUpcomingEvents", () => {
  it("scopes to the user universe + macro events and collapses categories", async () => {
    const { prisma, calls } = fake({
      "holding.findMany": () => [{ symbol: "RELIANCE" }],
      "watchlistItem.findMany": () => [{ symbol: "TCS" }],
      "upcomingEvent.findMany": () => [
        {
          date: new Date("2026-07-12T00:00:00Z"),
          title: "TCS Q4",
          category: "earnings",
          symbol: "TCS",
        },
        {
          date: new Date("2026-07-13T00:00:00Z"),
          title: "RBI policy",
          category: "macro",
          symbol: null,
        },
        {
          date: new Date("2026-07-14T00:00:00Z"),
          title: "RELIANCE dividend",
          category: "dividend",
          symbol: "RELIANCE",
        },
      ],
    });
    const res = await getUpcomingEvents("u1", { prisma });
    assert.equal(res.success, true);
    if (res.success) {
      assert.deepEqual(res.data.events, [
        {
          date: "2026-07-12",
          title: "TCS Q4",
          category: "earnings",
          symbol: "TCS",
        },
        {
          date: "2026-07-13",
          title: "RBI policy",
          category: "macro",
          symbol: undefined,
        },
        {
          date: "2026-07-14",
          title: "RELIANCE dividend",
          category: "corporate-action", // dividend collapses here
          symbol: "RELIANCE",
        },
      ]);
    }
    // OR includes macro (symbol:null) AND the user's symbols.
    const or = calls["upcomingEvent.findMany"]?.[0]?.where?.OR as unknown[];
    assert.deepEqual(or?.[0], { symbol: null });
    assert.deepEqual(or?.[1], { symbol: { in: ["RELIANCE", "TCS"] } });
  });

  it("with no held/watched symbols the OR is macro-only", async () => {
    const { prisma, calls } = fake({
      "holding.findMany": () => [],
      "watchlistItem.findMany": () => [],
      "upcomingEvent.findMany": () => [],
    });
    const res = await getUpcomingEvents("u1", { prisma });
    assert.equal(res.success, true);
    const or = calls["upcomingEvent.findMany"]?.[0]?.where?.OR as unknown[];
    assert.equal(or?.length, 1);
    assert.deepEqual(or?.[0], { symbol: null });
  });
});

// ── getDailyBrief ────────────────────────────────────────────────────────────

describe("news.service getDailyBrief", () => {
  const cached: NewsServiceDeps = {
    getCached: async () => ({
      generatedAt: "2026-07-10T00:00:00.000Z",
      summary: "cached brief",
      catalystCount: 2,
      estImpactRupees: null,
    }),
    setCached: async () => {},
  };

  it("returns the cached brief without generating", async () => {
    let generated = false;
    const { prisma, calls } = fake({});
    const res = await getDailyBrief("u1", {
      prisma,
      ...cached,
      generateBrief: async () => {
        generated = true;
        return "x";
      },
    });
    assert.equal(res.success, true);
    if (res.success) assert.equal(res.data.brief?.summary, "cached brief");
    assert.equal(generated, false);
    assert.equal(calls["holding.findMany"], undefined); // never queried
  });

  it("returns null when the caller has no holdings", async () => {
    const { prisma } = fake({ "holding.findMany": () => [] });
    const res = await getDailyBrief("u1", {
      prisma,
      getCached: async () => null,
      setCached: async () => {},
      generateBrief: async () => "x",
    });
    assert.equal(res.success, true);
    if (res.success) assert.equal(res.data.brief, null);
  });

  it("returns null when there is no recent news", async () => {
    const { prisma } = fake({
      "holding.findMany": () => [{ symbol: "RELIANCE", name: "Reliance" }],
      "stockNews.findMany": () => [],
    });
    const res = await getDailyBrief("u1", {
      prisma,
      getCached: async () => null,
      setCached: async () => {},
      generateBrief: async () => "x",
    });
    assert.equal(res.success, true);
    if (res.success) assert.equal(res.data.brief, null);
  });

  it("generates + counts positive catalysts + caches on the happy path", async () => {
    let cachedWrite = false;
    const { prisma } = fake({
      "holding.findMany": () => [{ symbol: "RELIANCE", name: "Reliance" }],
      "stockNews.findMany": () => [
        { symbol: "RELIANCE", title: "beat", sentiment: "POSITIVE" },
        { symbol: "RELIANCE", title: "downgrade", sentiment: "NEGATIVE" },
      ],
    });
    const res = await getDailyBrief("u1", {
      prisma,
      getCached: async () => null,
      setCached: async () => {
        cachedWrite = true;
      },
      generateBrief: async () => "  Net positive across top holdings.  ",
    });
    assert.equal(res.success, true);
    if (res.success) {
      assert.equal(
        res.data.brief?.summary,
        "Net positive across top holdings.",
      ); // trimmed
      assert.equal(res.data.brief?.catalystCount, 1); // one POSITIVE
      assert.equal(res.data.brief?.estImpactRupees, null);
    }
    assert.equal(cachedWrite, true);
  });
});
