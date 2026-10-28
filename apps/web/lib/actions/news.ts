"use server";

import { prisma } from "@/lib/prisma";
import { getAuthenticatedUser } from "@/lib/auth";
import { isDemoSession } from "@/lib/demo/session";
import { getCached, setCached } from "@usemoney/core";
import { isFresh } from "@/lib/market/quote-freshness";
import type { ActionResponse } from "@usemoney/validation";

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

/**
 * MONEY-408: blend the enriched market-wide RSS table (`NewsArticle`) into the
 * per-symbol `StockNews` rows the pages already render. The RSS worker now tags
 * each article with the symbols it mentions + a lexicon sentiment, so the two
 * sources share the page's `NewsArticle` shape. De-dupes by link, sorts
 * newest-first, and caps to `limit`.
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
  limit: number
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

// 30 minutes staleness threshold
const NEWS_STALE_MS = 30 * 60 * 1000;

/**
 * Get news for a specific stock symbol.
 * DB-first: returns cached news if fresh (<30 min), otherwise fetches from Google News RSS.
 */
export async function getStockNewsAction(
  symbol: string,
  limit = 8
): Promise<ActionResponse<{ articles: NewsArticle[] }>> {
  const clean = symbol.replace(/\.(NS|BO)$/i, "").toUpperCase();

  // Demo mode - return sample data
  if (await isDemoSession()) {
    return {
      success: true,
      data: {
        articles: [
          {
            id: "demo-1",
            symbol: clean,
            title: `${clean} reports strong Q3 results, beats estimates`,
            link: "#",
            pubDate: new Date(),
            source: "Economic Times",
            snippet: `${clean} posted quarterly revenue growth of 12% year-over-year...`,
            sentiment: "POSITIVE",
          },
          {
            id: "demo-2",
            symbol: clean,
            title: `Analysts upgrade ${clean} target price after earnings`,
            link: "#",
            pubDate: new Date(Date.now() - 3600000),
            source: "Moneycontrol",
            snippet: `Multiple brokerages have revised their target price for ${clean}...`,
            sentiment: "POSITIVE",
          },
          {
            id: "demo-3",
            symbol: clean,
            title: `${clean} announces new expansion plans`,
            link: "#",
            pubDate: new Date(Date.now() - 7200000),
            source: "LiveMint",
            snippet: null,
            sentiment: "NEUTRAL",
          },
        ],
      },
    };
  }

  try {
    // Check DB for recent news
    const existing = await prisma.stockNews.findMany({
      where: { symbol: clean },
      orderBy: { fetchedAt: "desc" },
      take: limit,
    });

    const hasFreshCache =
      existing.length > 0 && isFresh(existing[0]!.fetchedAt, NEWS_STALE_MS);

    if (hasFreshCache) {
      return {
        success: true,
        data: { articles: existing },
      };
    }

    // Fetch fresh from Google News RSS
    const { fetchNews } = await import("@usemoney/research");
    const freshArticles = await fetchNews(clean, limit);

    if (freshArticles.length > 0) {
      // Upsert to DB (fire-and-forget for speed)
      for (const article of freshArticles) {
        try {
          await prisma.stockNews.upsert({
            where: {
              symbol_link: { symbol: clean, link: article.link },
            },
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
          // Duplicate or constraint error - skip
        }
      }
    }

    // Return from DB (includes both old and new)
    const updated = await prisma.stockNews.findMany({
      where: { symbol: clean },
      orderBy: { fetchedAt: "desc" },
      take: limit,
    });

    return {
      success: true,
      data: { articles: updated },
    };
  } catch {
    // Fallback to whatever we had in DB
    const fallback = await prisma.stockNews.findMany({
      where: { symbol: clean },
      orderBy: { fetchedAt: "desc" },
      take: limit,
    });

    return {
      success: true,
      data: { articles: fallback },
    };
  }
}

/**
 * Get news for multiple symbols (used for Market Pulse on dashboard).
 * Returns top 2 news per symbol, max 10 articles total.
 */
export async function getMarketPulseNewsAction(
  symbols?: string[]
): Promise<ActionResponse<{ articles: NewsArticle[] }>> {
  // Demo mode
  if (await isDemoSession()) {
    return {
      success: true,
      data: {
        articles: [
          {
            id: "mp-1",
            symbol: "RELIANCE",
            title: "Reliance Industries hits all-time high on Jio growth",
            link: "#",
            pubDate: new Date(),
            source: "Economic Times",
            snippet: null,
            sentiment: "POSITIVE",
          },
          {
            id: "mp-2",
            symbol: "TCS",
            title: "TCS wins $2B deal, stock surges 3%",
            link: "#",
            pubDate: new Date(Date.now() - 1800000),
            source: "Moneycontrol",
            snippet: null,
            sentiment: "POSITIVE",
          },
          {
            id: "mp-3",
            symbol: "HDFCBANK",
            title: "HDFC Bank Q3: Net profit up 18%, NII rises 10%",
            link: "#",
            pubDate: new Date(Date.now() - 3600000),
            source: "LiveMint",
            snippet: null,
            sentiment: "POSITIVE",
          },
          {
            id: "mp-4",
            symbol: "INFY",
            title: "Infosys raises revenue guidance for FY26",
            link: "#",
            pubDate: new Date(Date.now() - 5400000),
            source: "NDTV Profit",
            snippet: null,
            sentiment: "NEUTRAL",
          },
        ],
      },
    };
  }

  const authUser = await getAuthenticatedUser();
  if (!authUser) {
    return { success: false, error: "Unauthorized" };
  }

  try {
    let targetSymbols = symbols;

    // If no symbols provided, get user's top held stocks
    if (!targetSymbols || targetSymbols.length === 0) {
      const holdings = await prisma.holding.findMany({
        where: { userId: authUser.userId },
        orderBy: { currentValue: "desc" },
        take: 5,
        select: { symbol: true },
      });
      targetSymbols = holdings.map((h) => h.symbol);
    }

    if (targetSymbols.length === 0) {
      // No holdings - use popular market stocks
      targetSymbols = ["RELIANCE", "TCS", "HDFCBANK", "INFY", "ICICIBANK"];
    }

    // Query DB for recent news across these symbols
    let articles = await prisma.stockNews.findMany({
      where: {
        symbol: { in: targetSymbols },
      },
      orderBy: { fetchedAt: "desc" },
      take: 10,
    });

    // If DB is empty, fetch fresh news for top 3 symbols
    if (articles.length === 0) {
      try {
        const { fetchNews } = await import("@usemoney/research");
        const fetchSymbols = targetSymbols.slice(0, 3);
        for (const sym of fetchSymbols) {
          const fresh = await fetchNews(sym, 4);
          for (const article of fresh) {
            try {
              await prisma.stockNews.upsert({
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
              // Duplicate - skip
            }
          }
        }
        // Re-query after populating
        articles = await prisma.stockNews.findMany({
          where: { symbol: { in: targetSymbols } },
          orderBy: { fetchedAt: "desc" },
          take: 10,
        });
      } catch {
        // Fetch failed - return empty gracefully
      }
    }

    // MONEY-408: blend in the enriched market-wide RSS table so the dashboard
    // pulse isn't limited to the per-symbol Google-News rows.
    const rss = await prisma.newsArticle.findMany({
      where: { symbols: { hasSome: targetSymbols } },
      orderBy: { publishedAt: "desc" },
      take: 10,
    });

    return {
      success: true,
      data: { articles: blendRssNews(articles, rss, 10) },
    };
  } catch {
    return {
      success: true,
      data: { articles: [] },
    };
  }
}

// ============== MONEY-197/4c: News & Events Page ==============

export type NewsFeedFilter =
  | "all"
  | "holdings"
  | "watchlists"
  | "market"
  | "earnings"
  | "corp_action";

// MONEY-408: keyword heuristics for the content filters. NewsArticle.categories
// isn't populated yet, so the Earnings / Corp-actions chips filter the
// market-wide RSS feed by title/summary keyword rather than returning empty.
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

/**
 * Market-wide RSS feed filtered to a content category by keyword. Auth-
 * independent (these categories aren't holdings-scoped).
 */
async function getContentFilteredFeed(
  filter: "earnings" | "corp_action",
  limit: number
): Promise<ActionResponse<{ articles: NewsArticle[] }>> {
  try {
    const kw = filter === "earnings" ? EARNINGS_KEYWORDS : CORP_ACTION_KEYWORDS;
    const rss = await prisma.newsArticle.findMany({
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
    console.error("getContentFilteredFeed error:", error);
    return { success: true, data: { articles: [] } };
  }
}

/**
 * Filter-aware news feed for the News & Events page.
 *
 * - "holdings"    → news for user's top holdings
 * - "watchlists"  → news for any stock in any watchlist
 * - "market"      → broad-market news (popular large-caps)
 * - "earnings" / "corp_action" → market-wide RSS filtered by keyword
 * - "all"         → combines holdings + watchlists, de-duplicated
 */
export async function getNewsFeedAction(options?: {
  filter?: NewsFeedFilter;
  limit?: number;
}): Promise<ActionResponse<{ articles: NewsArticle[] }>> {
  const filter = options?.filter ?? "all";
  const limit = Math.min(options?.limit ?? 20, 50);

  try {
    // Content filters (earnings / corporate actions) search the market-wide
    // RSS table by keyword — independent of holdings/auth.
    if (filter === "earnings" || filter === "corp_action") {
      return getContentFilteredFeed(filter, limit);
    }

    const authUser = await getAuthenticatedUser();
    if (!authUser && filter !== "market") {
      // Not signed in - fall back to market-wide feed rather than erroring
      return getMarketPulseNewsAction();
    }

    let symbols: string[] = [];

    if (filter === "holdings" || filter === "all") {
      if (authUser) {
        const holdings = await prisma.holding.findMany({
          where: { userId: authUser.userId },
          orderBy: { currentValue: "desc" },
          take: 15,
          select: { symbol: true },
        });
        symbols.push(...holdings.map((h) => h.symbol));
      }
    }

    if (filter === "watchlists" || filter === "all") {
      if (authUser) {
        const items = await prisma.watchlistItem.findMany({
          where: { watchlist: { userId: authUser.userId } },
          take: 50,
          select: { symbol: true },
        });
        symbols.push(...items.map((i) => i.symbol));
      }
    }

    if (filter === "market") {
      // Popular large-caps - serves as broad-market proxy
      symbols = ["RELIANCE", "TCS", "HDFCBANK", "INFY", "ICICIBANK", "SBIN"];
    }

    // Dedupe
    symbols = Array.from(new Set(symbols));

    if (symbols.length === 0) {
      return { success: true, data: { articles: [] } };
    }

    // Query DB for recent news across these symbols. (earnings / corp_action
    // are handled up top via getContentFilteredFeed and never reach here.)
    const whereClause: Record<string, unknown> = {
      symbol: { in: symbols },
    };

    const articles = await prisma.stockNews.findMany({
      where: whereClause,
      orderBy: { fetchedAt: "desc" },
      take: limit,
    });

    // MONEY-408: merge in the enriched market-wide RSS table (NewsArticle),
    // which the RSS worker now tags with symbols + sentiment. "market" takes
    // the latest market-wide articles; holdings/watchlist match on the tags.
    const rss = await prisma.newsArticle.findMany({
      where: filter === "market" ? {} : { symbols: { hasSome: symbols } },
      orderBy: { publishedAt: "desc" },
      take: limit,
    });
    return {
      success: true,
      data: { articles: blendRssNews(articles, rss, limit) },
    };
  } catch (error) {
    console.error("getNewsFeedAction error:", error);
    return { success: true, data: { articles: [] } };
  }
}

export interface UpcomingEvent {
  date: string; // ISO date
  title: string;
  category: "earnings" | "macro" | "corporate-action";
  symbol?: string;
}

/**
 * Upcoming events feed (next 7 days).
 *
 * Currently returns empty because we don't have a source table yet -
 * NSE corporate actions + RBI monetary policy calendar will land in a
 * follow-up ticket. Empty state in the UI is intentional ("No events
 * scheduled this week"); we are NOT fabricating events.
 */
export async function getUpcomingEventsAction(): Promise<
  ActionResponse<{ events: UpcomingEvent[] }>
> {
  // Demo mode - return illustrative data so the page doesn't look broken
  // in the demo walkthrough. Real users will see the empty state.
  if (await isDemoSession()) {
    const today = new Date();
    const fmt = (offsetDays: number) => {
      const d = new Date(today);
      d.setDate(d.getDate() + offsetDays);
      return d.toISOString().split("T")[0]!;
    };
    return {
      success: true,
      data: {
        events: [
          {
            date: fmt(1),
            title: "TCS · Q4 results",
            category: "earnings",
            symbol: "TCS",
          },
          { date: fmt(2), title: "RBI policy decision", category: "macro" },
          {
            date: fmt(3),
            title: "HDFCBANK · results",
            category: "earnings",
            symbol: "HDFCBANK",
          },
        ],
      },
    };
  }
  // Real read (MONEY-408): the events-sync worker now populates UpcomingEvent
  // with earnings dates for held/watch-listed/alerted symbols. Scope the feed
  // to the user's universe plus macro events (symbol == null) that apply to
  // everyone; next 7 days, oldest-first.
  const authUser = await getAuthenticatedUser();
  try {
    let symbols: string[] = [];
    if (authUser) {
      const [holdings, watch] = await Promise.all([
        prisma.holding.findMany({
          where: { userId: authUser.userId },
          select: { symbol: true },
          take: 100,
        }),
        prisma.watchlistItem.findMany({
          where: { watchlist: { userId: authUser.userId } },
          select: { symbol: true },
          take: 100,
        }),
      ]);
      symbols = Array.from(
        new Set([...holdings, ...watch].map((r) => r.symbol))
      );
    }

    const horizon = new Date(Date.now() + 7 * 86_400_000);
    const rows = await prisma.upcomingEvent.findMany({
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
    // the page's interface collapses the non-earnings/macro kinds to one bucket.
    const toCategory = (db: string): UpcomingEvent["category"] =>
      db === "earnings"
        ? "earnings"
        : db === "macro"
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
    console.error("getUpcomingEventsAction error:", error);
    return { success: true, data: { events: [] } };
  }
}

export interface DailyBrief {
  generatedAt: string;
  summary: string;
  catalystCount: number;
  estImpactRupees: number | null;
}

/**
 * Daily Brief - Gemini-generated paragraph summarizing overnight news
 * impact on the user's holdings. Cached 1h per user.
 *
 * Uses Flash model for low latency + cost. Returns null when the user has
 * no holdings (we won't fabricate a brief about stocks they don't own).
 */
export async function getDailyBriefAction(): Promise<
  ActionResponse<{ brief: DailyBrief | null }>
> {
  if (await isDemoSession()) {
    return {
      success: true,
      data: {
        brief: {
          generatedAt: new Date().toISOString(),
          summary:
            "Your portfolio caught 3 positive catalysts overnight - RELIANCE earnings beat, HDFC bonus issue approved, INFY wins $1.5B deal. Net expected impact at open: positive across top holdings.",
          catalystCount: 3,
          estImpactRupees: 8400,
        },
      },
    };
  }

  const authUser = await getAuthenticatedUser();
  if (!authUser) {
    return { success: false, error: "Unauthorized" };
  }

  try {
    // Cache per-user 1h
    const cached = await getCached<DailyBrief>(
      "chat", // reuse chat cache module (1h TTL by default)
      authUser.userId,
      "daily-brief",
      undefined,
      { ttl: 60 * 60 }
    );
    if (cached) {
      return { success: true, data: { brief: cached } };
    }

    // Gather top holdings + recent news
    const holdings = await prisma.holding.findMany({
      where: { userId: authUser.userId },
      orderBy: { currentValue: "desc" },
      take: 10,
      select: { symbol: true, name: true },
    });

    if (holdings.length === 0) {
      return { success: true, data: { brief: null } };
    }

    const symbols = holdings.map((h) => h.symbol);
    const recentNews = await prisma.stockNews.findMany({
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

    // Generate via Gemini Flash
    const { getGeminiModel, generateWithTimeout } =
      await import("@/lib/gemini/models");
    const model = getGeminiModel("fast");

    const bullets = recentNews
      .map(
        (n) =>
          `- ${n.symbol}: ${n.title}${n.sentiment ? ` [${n.sentiment}]` : ""}`
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

    const summary = (await generateWithTimeout(model, prompt, 15000)) as string;

    const positiveCount = recentNews.filter(
      (n) => (n.sentiment ?? "").toUpperCase() === "POSITIVE"
    ).length;

    const brief: DailyBrief = {
      generatedAt: new Date().toISOString(),
      summary: summary.trim(),
      catalystCount: positiveCount,
      estImpactRupees: null, // estimating rupee impact would require price × holding qty × expected move; out of scope for MVP
    };

    await setCached("chat", authUser.userId, "daily-brief", brief, undefined, {
      ttl: 60 * 60,
    });

    return { success: true, data: { brief } };
  } catch (error) {
    console.error("getDailyBriefAction error:", error);
    return { success: true, data: { brief: null } };
  }
}
