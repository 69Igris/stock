/**
 * News Service (MONEY-1062 P4b)
 *
 * News & Events reads for apps/api mobile-parity. NEW service file — no prior
 * service touched the `StockNews` / `NewsArticle` / `UpcomingEvent` models (the
 * web actions drove Prisma + the cache directly).
 *
 * Source: apps/web/lib/actions/news.ts
 *   :66  getStockNewsAction        → getStockNews        (per-symbol, DB-first)
 *   :189 getMarketPulseNewsAction  → getMarketPulseNews  (top holdings + RSS)
 *   :412 getNewsFeedAction         → getNewsFeed         (filter-aware feed)
 *   :514 getUpcomingEventsAction   → getUpcomingEvents   (next-7-day calendar)
 *   :621 getDailyBriefAction       → getDailyBrief       (Gemini brief, 1h cache)
 *
 * Faithful to the web reads: same Prisma filters, the 30-min StockNews staleness
 * threshold, the RSS blend (de-dupe by link, newest-first, capped), the
 * earnings/corp-action keyword heuristics, the +7-day event horizon, and the
 * per-user 1h daily-brief cache (module "chat").
 *
 * STRIPPED web/next glue:
 *   - `isDemoSession()` demo branches — the API is always a real authenticated
 *     Bearer session (no demo cookies); the route owns auth.
 *   - `getAuthenticatedUser()` — the route resolves the Mongo userId and passes
 *     it in. getNewsFeed's `!authUser` → market-pulse fallback (news.ts:427-430)
 *     is therefore dead here: the route always has a resolved userId. getStockNews
 *     stays symbol-only (public per-symbol news; no userId), matching the action.
 *
 * Heavy deps (`@usemoney/research` fetchNews, `@usemoney/core/gemini`) are lazy-
 * imported behind injectable seams, mirroring the actions' `await import(...)`.
 *
 * @see packages/services/__tests__/news-service.test.ts
 */

import { prisma } from "@usemoney/database";
import { dbLogger as logger } from "@usemoney/logger";
import {
  getCached as defaultGetCached,
  setCached as defaultSetCached,
} from "@usemoney/core/cache";
import type { ServiceResult } from "./types";

/** Page-facing article shape (identical to the web action's NewsArticle). */
export interface NewsArticle {
  id: string;
  symbol: string;
  title: string;
  link: string;
  pubDate: Date | null;
  source: string;
  snippet: string | null;
  sentiment: string | null;
}

/** Shape returned by the RSS fetcher (`@usemoney/research` fetchNews). */
export interface FetchedArticle {
  title: string;
  link: string;
  pubDate?: string | null;
  snippet?: string | null;
}

export type NewsFeedFilter =
  | "all"
  | "holdings"
  | "watchlists"
  | "market"
  | "earnings"
  | "corp_action";

export interface UpcomingEvent {
  date: string; // ISO date (YYYY-MM-DD)
  title: string;
  category: "earnings" | "macro" | "corporate-action";
  symbol?: string;
}

export interface DailyBrief {
  generatedAt: string;
  summary: string;
  catalystCount: number;
  estImpactRupees: number | null;
}

// ── Constants (copied verbatim from news.ts) ────────────────────────────────

/** 30-minute staleness threshold for the StockNews cache (news.ts:60). */
const NEWS_STALE_MS = 30 * 60 * 1000;

/** Popular large-caps used as a broad-market proxy (news.ts). */
const POPULAR_SYMBOLS = ["RELIANCE", "TCS", "HDFCBANK", "INFY", "ICICIBANK"];
const MARKET_SYMBOLS = [...POPULAR_SYMBOLS, "SBIN"];

// news.ts:346 — Earnings / Corp-action keyword heuristics for content filters.
const EARNINGS_KEYWORDS = [
  "earnings",
  "net profit",
  "quarterly",
  "q1 ",
  "q2 ",
  "q3 ",
  "q4 ",
  " results",
  "profit",
  "revenue",
  "guidance",
];
const CORP_ACTION_KEYWORDS = [
  "dividend",
  "stock split",
  " split",
  "bonus",
  "rights issue",
  "buyback",
  "record date",
  "ex-date",
  "ex date",
  "merger",
  "demerger",
  "amalgamation",
  "acquisition",
];

// ── Pure helpers ────────────────────────────────────────────────────────────

/**
 * True iff `updatedAt` is newer than `ttlMs` ago (strict `<`, so exactly-at-TTL
 * is stale). Ported from apps/web/lib/market/quote-freshness.ts.
 */
function isFresh(updatedAt: Date, ttlMs: number): boolean {
  return Date.now() - updatedAt.getTime() < ttlMs;
}

/**
 * MONEY-408: blend the enriched market-wide RSS table (`NewsArticle`) into the
 * per-symbol `StockNews` rows. De-dupes by link, sorts newest-first, caps to
 * `limit`. Ported verbatim from news.ts:28-57.
 */
function blendRssNews(
  stockNews: NewsArticle[],
  rss: Array<{
    id: string;
    title: string;
    url: string;
    summary: string | null;
    source: string;
    publishedAt: Date | null;
    symbols: string[];
    sentiment: string | null;
  }>,
  limit: number,
): NewsArticle[] {
  const mapped: NewsArticle[] = rss.map((a) => ({
    id: a.id,
    symbol: a.symbols[0] ?? "",
    title: a.title,
    link: a.url,
    pubDate: a.publishedAt,
    source: a.source,
    snippet: a.summary ?? null,
    sentiment: a.sentiment ?? null,
  }));
  const seen = new Set<string>();
  return [...stockNews, ...mapped]
    .filter((a) => (seen.has(a.link) ? false : (seen.add(a.link), true)))
    .sort((x, y) => (y.pubDate?.getTime() ?? 0) - (x.pubDate?.getTime() ?? 0))
    .slice(0, limit);
}

// ── Injectable IO seam ──────────────────────────────────────────────────────

/**
 * `@usemoney/services` runs its suite as ESM, so tests inject fakes via `deps`
 * rather than module-mocking. `fetchNews` and `generateBrief` default to lazy
 * `import()` of the heavy `@usemoney/research` / `@usemoney/core/gemini` modules
 * — mirroring the web actions' `await import(...)`.
 */
export interface NewsServiceDeps {
  prisma?: typeof prisma;
  fetchNews?: (symbol: string, limit: number) => Promise<FetchedArticle[]>;
  getCached?: <T>(
    module: "chat",
    userId: string,
    identifier: string,
    filters?: unknown,
    config?: { ttl?: number },
  ) => Promise<T | null>;
  setCached?: <T>(
    module: "chat",
    userId: string,
    identifier: string,
    data: T,
    filters?: unknown,
    config?: { ttl?: number },
  ) => Promise<void>;
  generateBrief?: (prompt: string) => Promise<string>;
}

/** Lazy default RSS fetch — mirrors news.ts `await import("@usemoney/research")`. */
async function defaultFetchNews(
  symbol: string,
  limit: number,
): Promise<FetchedArticle[]> {
  const mod = (await import("@usemoney/research")) as {
    fetchNews: (q: string, n: number) => Promise<FetchedArticle[]>;
  };
  return mod.fetchNews(symbol, limit);
}

/** Lazy default Gemini Flash generation — mirrors news.ts `import("@/lib/gemini/models")`. */
async function defaultGenerateBrief(prompt: string): Promise<string> {
  const mod = (await import("@usemoney/core/gemini")) as {
    getGeminiModel: (mode: "fast") => unknown;
    generateWithTimeout: (
      model: unknown,
      prompt: string,
      timeoutMs: number,
    ) => Promise<string>;
  };
  const model = mod.getGeminiModel("fast");
  return mod.generateWithTimeout(model, prompt, 15000);
}

// ── getStockNews (news.ts:66) ───────────────────────────────────────────────

/**
 * News for a single symbol. DB-first: returns the cached StockNews rows while
 * fresh (<30 min); otherwise fetches Google-News RSS, upserts, and re-reads.
 * Never a user-scoped read (per-symbol news is public) — matches the action.
 */
export async function getStockNews(
  symbol: string,
  limit = 8,
  deps: NewsServiceDeps = {},
): Promise<ServiceResult<{ articles: NewsArticle[] }>> {
  const db = deps.prisma ?? prisma;
  const fetchNews = deps.fetchNews ?? defaultFetchNews;
  const clean = symbol.replace(/\.(NS|BO)$/i, "").toUpperCase();

  try {
    const existing = await db.stockNews.findMany({
      where: { symbol: clean },
      orderBy: { fetchedAt: "desc" },
      take: limit,
    });

    const hasFreshCache =
      existing.length > 0 && isFresh(existing[0]!.fetchedAt, NEWS_STALE_MS);

    if (hasFreshCache) {
      return { success: true, data: { articles: existing } };
    }

    const freshArticles = await fetchNews(clean, limit);
    if (freshArticles.length > 0) {
      for (const article of freshArticles) {
        try {
          await db.stockNews.upsert({
            where: { symbol_link: { symbol: clean, link: article.link } },
            update: { fetchedAt: new Date() },
            create: {
              symbol: clean,
              title: article.title,
              link: article.link,
              pubDate: article.pubDate ? new Date(article.pubDate) : null,
              source: "GOOGLE_NEWS",
              snippet: article.snippet || null,
            },
          });
        } catch {
          // Duplicate or constraint error — skip.
        }
      }
    }

    const updated = await db.stockNews.findMany({
      where: { symbol: clean },
      orderBy: { fetchedAt: "desc" },
      take: limit,
    });

    return { success: true, data: { articles: updated } };
  } catch {
    // Fallback to whatever we had in DB.
    const fallback = await db.stockNews
      .findMany({
        where: { symbol: clean },
        orderBy: { fetchedAt: "desc" },
        take: limit,
      })
      .catch(() => [] as NewsArticle[]);

    return { success: true, data: { articles: fallback } };
  }
}

// ── getMarketPulseNews (news.ts:189) ────────────────────────────────────────

/**
 * News across a set of symbols for the dashboard Market Pulse. With no symbols
 * it uses the caller's top-5 holdings (by current value), falling back to
 * popular large-caps. Blends the market-wide RSS table in. Caps to 10.
 */
export async function getMarketPulseNews(
  userId: string,
  symbols: string[] | undefined,
  deps: NewsServiceDeps = {},
): Promise<ServiceResult<{ articles: NewsArticle[] }>> {
  const db = deps.prisma ?? prisma;
  const fetchNews = deps.fetchNews ?? defaultFetchNews;

  try {
    let targetSymbols = symbols;

    if (!targetSymbols || targetSymbols.length === 0) {
      const holdings = await db.holding.findMany({
        where: { userId },
        orderBy: { currentValue: "desc" },
        take: 5,
        select: { symbol: true },
      });
      targetSymbols = holdings.map((h) => h.symbol);
    }

    if (targetSymbols.length === 0) {
      targetSymbols = [...POPULAR_SYMBOLS];
    }

    let articles = await db.stockNews.findMany({
      where: { symbol: { in: targetSymbols } },
      orderBy: { fetchedAt: "desc" },
      take: 10,
    });

    if (articles.length === 0) {
      try {
        const fetchSymbols = targetSymbols.slice(0, 3);
        for (const sym of fetchSymbols) {
          const fresh = await fetchNews(sym, 4);
          for (const article of fresh) {
            try {
              await db.stockNews.upsert({
                where: { symbol_link: { symbol: sym, link: article.link } },
                update: { fetchedAt: new Date() },
                create: {
                  symbol: sym,
                  title: article.title,
                  link: article.link,
                  pubDate: article.pubDate ? new Date(article.pubDate) : null,
                  source: "GOOGLE_NEWS",
                  snippet: article.snippet || null,
                },
              });
            } catch {
              // Duplicate — skip.
            }
          }
        }
        articles = await db.stockNews.findMany({
          where: { symbol: { in: targetSymbols } },
          orderBy: { fetchedAt: "desc" },
          take: 10,
        });
      } catch {
        // Fetch failed — return empty gracefully.
      }
    }

    // MONEY-408: blend the enriched market-wide RSS table.
    const rss = await db.newsArticle.findMany({
      where: { symbols: { hasSome: targetSymbols } },
      orderBy: { publishedAt: "desc" },
      take: 10,
    });

    return {
      success: true,
      data: { articles: blendRssNews(articles, rss, 10) },
    };
  } catch (error) {
    logger.error({ error, userId }, "getMarketPulseNews service error");
    return { success: true, data: { articles: [] } };
  }
}

/**
 * Market-wide RSS feed filtered to a content category by keyword. Auth-
 * independent (these categories aren't holdings-scoped). news.ts:379.
 */
async function getContentFilteredFeed(
  db: typeof prisma,
  filter: "earnings" | "corp_action",
  limit: number,
): Promise<ServiceResult<{ articles: NewsArticle[] }>> {
  try {
    const kw = filter === "earnings" ? EARNINGS_KEYWORDS : CORP_ACTION_KEYWORDS;
    const rss = await db.newsArticle.findMany({
      orderBy: { publishedAt: "desc" },
      take: 200,
    });
    const matched = rss.filter((a) => {
      const hay = `${a.title} ${a.summary ?? ""}`.toLowerCase();
      return kw.some((k) => hay.includes(k));
    });
    return {
      success: true,
      data: { articles: blendRssNews([], matched, limit) },
    };
  } catch (error) {
    logger.error({ error, filter }, "getContentFilteredFeed service error");
    return { success: true, data: { articles: [] } };
  }
}

// ── getNewsFeed (news.ts:412) ───────────────────────────────────────────────

/**
 * Filter-aware feed for the News & Events page.
 *
 * - "holdings"    → news for the caller's top holdings
 * - "watchlists"  → news for any stock in any of the caller's watchlists
 * - "market"      → broad-market news (popular large-caps)
 * - "earnings"/"corp_action" → market-wide RSS filtered by keyword (auth-free)
 * - "all"         → combines holdings + watchlists, de-duplicated
 *
 * The web action's unauthenticated market-pulse fallback (news.ts:427-430) is
 * NOT ported — the API route always supplies a resolved userId.
 */
export async function getNewsFeed(
  userId: string,
  options: { filter?: NewsFeedFilter; limit?: number } = {},
  deps: NewsServiceDeps = {},
): Promise<ServiceResult<{ articles: NewsArticle[] }>> {
  const db = deps.prisma ?? prisma;
  const filter = options.filter ?? "all";
  const limit = Math.min(options.limit ?? 20, 50);

  try {
    // Content filters (earnings / corp actions) search the market-wide RSS
    // table by keyword — independent of holdings.
    if (filter === "earnings" || filter === "corp_action") {
      return getContentFilteredFeed(db, filter, limit);
    }

    let symbols: string[] = [];

    if (filter === "holdings" || filter === "all") {
      const holdings = await db.holding.findMany({
        where: { userId },
        orderBy: { currentValue: "desc" },
        take: 15,
        select: { symbol: true },
      });
      symbols.push(...holdings.map((h) => h.symbol));
    }

    if (filter === "watchlists" || filter === "all") {
      const items = await db.watchlistItem.findMany({
        where: { watchlist: { userId } },
        take: 50,
        select: { symbol: true },
      });
      symbols.push(...items.map((i) => i.symbol));
    }

    if (filter === "market") {
      symbols = [...MARKET_SYMBOLS];
    }

    symbols = Array.from(new Set(symbols));

    if (symbols.length === 0) {
      return { success: true, data: { articles: [] } };
    }

    const articles = await db.stockNews.findMany({
      where: { symbol: { in: symbols } },
      orderBy: { fetchedAt: "desc" },
      take: limit,
    });

    // MONEY-408: merge the enriched market-wide RSS table. "market" takes the
    // latest market-wide articles; holdings/watchlist match on the tags.
    const rss = await db.newsArticle.findMany({
      where: filter === "market" ? {} : { symbols: { hasSome: symbols } },
      orderBy: { publishedAt: "desc" },
      take: limit,
    });

    return {
      success: true,
      data: { articles: blendRssNews(articles, rss, limit) },
    };
  } catch (error) {
    logger.error({ error, userId }, "getNewsFeed service error");
    return { success: true, data: { articles: [] } };
  }
}

// ── getUpcomingEvents (news.ts:514) ─────────────────────────────────────────

/**
 * Upcoming events (next 7 days) scoped to the caller's universe (held +
 * watch-listed symbols) plus macro events (symbol == null) that apply to
 * everyone. Oldest-first, capped to 30.
 */
export async function getUpcomingEvents(
  userId: string,
  deps: NewsServiceDeps = {},
): Promise<ServiceResult<{ events: UpcomingEvent[] }>> {
  const db = deps.prisma ?? prisma;
  try {
    const [holdings, watch] = await Promise.all([
      db.holding.findMany({
        where: { userId },
        select: { symbol: true },
        take: 100,
      }),
      db.watchlistItem.findMany({
        where: { watchlist: { userId } },
        select: { symbol: true },
        take: 100,
      }),
    ]);
    const symbols = Array.from(
      new Set([...holdings, ...watch].map((r) => r.symbol)),
    );

    const horizon = new Date(Date.now() + 7 * 86_400_000);
    const rows = await db.upcomingEvent.findMany({
      where: {
        date: { gte: new Date(), lte: horizon },
        OR: [
          // MONEY-1236 — measured on prod 2026-08-21: UpcomingEvent total=1,766,
          // absent=0, null=0, set=1,766. The ONLY writer is the `createMany` in
          // workers/src/processors/events-sync.ts, and its `UpcomingEventRow`
          // types `symbol: string` as REQUIRED (events-sync-logic.ts:83), so a
          // symbol-less row has never been written. That REFUTES the earlier
          // reading that "macro events are invisible in the feed": this arm
          // matches nothing because nothing symbol-less EXISTS, not because the
          // filter cannot reach it. If a macro-event writer is ever added it MUST
          // write `symbol: null` EXPLICITLY — otherwise this arm needs an
          // `{ symbol: { isSet: false } }` twin and the claim becomes true.
          // prisma-null-ok: no symbol-less row exists (0 absent of 1,766)
          { symbol: null }, // macro events apply to everyone
          ...(symbols.length ? [{ symbol: { in: symbols } }] : []),
        ],
      },
      orderBy: { date: "asc" },
      take: 30,
    });

    // DB stores "earnings" | "macro" | "corp_action" | "dividend" | "splits";
    // the page collapses the non-earnings/macro kinds to one bucket.
    const toCategory = (dbCat: string): UpcomingEvent["category"] =>
      dbCat === "earnings"
        ? "earnings"
        : dbCat === "macro"
          ? "macro"
          : "corporate-action";

    const events: UpcomingEvent[] = rows.map((e) => ({
      date: e.date.toISOString().slice(0, 10),
      title: e.title,
      category: toCategory(e.category),
      symbol: e.symbol ?? undefined,
    }));
    return { success: true, data: { events } };
  } catch (error) {
    logger.error({ error, userId }, "getUpcomingEvents service error");
    return { success: true, data: { events: [] } };
  }
}

// ── getDailyBrief (news.ts:621) ─────────────────────────────────────────────

/**
 * Gemini-generated paragraph summarising overnight news impact on the caller's
 * holdings. Cached per-user 1h (module "chat"). Returns null when the caller has
 * no holdings or no recent news (we won't fabricate a brief).
 */
export async function getDailyBrief(
  userId: string,
  deps: NewsServiceDeps = {},
): Promise<ServiceResult<{ brief: DailyBrief | null }>> {
  const db = deps.prisma ?? prisma;
  const getCached = deps.getCached ?? defaultGetCached;
  const setCached = deps.setCached ?? defaultSetCached;
  const generateBrief = deps.generateBrief ?? defaultGenerateBrief;

  try {
    // Cache per-user 1h (reuse the chat cache module).
    const cached = await getCached<DailyBrief>(
      "chat",
      userId,
      "daily-brief",
      undefined,
      { ttl: 60 * 60 },
    );
    if (cached) {
      return { success: true, data: { brief: cached } };
    }

    const holdings = await db.holding.findMany({
      where: { userId },
      orderBy: { currentValue: "desc" },
      take: 10,
      select: { symbol: true, name: true },
    });

    if (holdings.length === 0) {
      return { success: true, data: { brief: null } };
    }

    const symbols = holdings.map((h) => h.symbol);
    const recentNews = await db.stockNews.findMany({
      where: {
        symbol: { in: symbols },
        fetchedAt: { gte: new Date(Date.now() - 24 * 60 * 60 * 1000) },
      },
      orderBy: { fetchedAt: "desc" },
      take: 12,
      select: { symbol: true, title: true, sentiment: true },
    });

    if (recentNews.length === 0) {
      return { success: true, data: { brief: null } };
    }

    const bullets = recentNews
      .map(
        (n) =>
          `- ${n.symbol}: ${n.title}${n.sentiment ? ` [${n.sentiment}]` : ""}`,
      )
      .join("\n");

    const prompt = [
      'You are writing a 1-paragraph "Daily Brief" for a retail Indian investor.',
      "Their top holdings: " + holdings.map((h) => h.symbol).join(", "),
      "Overnight news:",
      bullets,
      "",
      "Write ONE paragraph (40-60 words) summarizing:",
      "1. How many positive catalysts (news with POSITIVE sentiment) affect their holdings",
      "2. Key names moved (max 3)",
      "3. Brief outlook sentence",
      "No disclaimers. No headlines. Prose only.",
    ].join("\n");

    const summary = await generateBrief(prompt);

    const positiveCount = recentNews.filter(
      (n) => (n.sentiment ?? "").toUpperCase() === "POSITIVE",
    ).length;

    const brief: DailyBrief = {
      generatedAt: new Date().toISOString(),
      summary: summary.trim(),
      catalystCount: positiveCount,
      // estimating rupee impact would require price × qty × expected move; out
      // of scope for MVP.
      estImpactRupees: null,
    };

    await setCached("chat", userId, "daily-brief", brief, undefined, {
      ttl: 60 * 60,
    });

    return { success: true, data: { brief } };
  } catch (error) {
    logger.error({ error, userId }, "getDailyBrief service error");
    return { success: true, data: { brief: null } };
  }
}
