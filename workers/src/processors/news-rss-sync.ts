/**
 * News RSS Sync Processor - MONEY-408.
 *
 * Pulls RSS feeds from major Indian financial outlets, dedups against
 * what's already in the NewsArticle table, and persists fresh rows.
 *
 * Cron: every 5 min during market hours (9:00–16:00 IST Mon-Fri),
 * every 15 min off-hours. Configured in
 * `scripts/ops/setup-scheduler.sh` as `news-rss-sync-trigger`.
 *
 * MONEY-408: each article is enriched on ingest with the symbols it mentions
 * (curated large-cap names + uppercase ticker tokens that resolve to a real
 * instrument) and a lexicon sentiment. Deterministic — no LLM in the hot path —
 * so ingest stays fast while NewsArticle becomes queryable by holding /
 * watchlist and sentiment-aware.
 */

import prisma from "@usemoney/database";
import { reportJobOutcome } from "@usemoney/datadog/job-outcome";
import { dedupNewsBatch, parseRssChannel } from "@usemoney/services";
import type { RawNewsItem } from "@usemoney/services";

export interface NewsRssSyncMessage {
  /** Optional source filter - when omitted, all configured feeds are fetched. */
  sources?: string[];
  /** Soft per-feed item cap (default 50) */
  maxPerFeed?: number;
}

interface FeedConfig {
  source: string;
  url: string;
}

const FEEDS: FeedConfig[] = [
  {
    source: "ET",
    url: "https://economictimes.indiatimes.com/markets/rssfeeds/1977021501.cms",
  },
  { source: "Mint", url: "https://www.livemint.com/rss/markets" },
  {
    source: "BS",
    url: "https://www.business-standard.com/rss/markets-106.rss",
  },
  {
    source: "MC",
    url: "https://www.moneycontrol.com/rss/marketreports.xml",
  },
];

const REQUEST_TIMEOUT_MS = 10_000;

async function fetchFeed(url: string): Promise<string | null> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), REQUEST_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      signal: ctrl.signal,
      headers: { "User-Agent": "UseMoneyAI/1.0 (news-rss-sync)" },
    });
    if (!res.ok) {
      console.warn(`[news-rss-sync] ${url} returned ${res.status}`);
      return null;
    }
    return await res.text();
  } catch (error) {
    console.warn(
      `[news-rss-sync] ${url} fetch failed:`,
      error instanceof Error ? error.message : String(error),
    );
    return null;
  } finally {
    clearTimeout(timer);
  }
}

// ── Lightweight enrichment (deterministic, no LLM) ───────────────────

const POS_RE =
  /\b(surge|jump|gain|rise|rally|soar|beat|upgrade|profit|record|high|strong|boost|outperform|bullish|growth|expand)\w*/gi;
const NEG_RE =
  /\b(fall|drop|decline|slump|plunge|loss|downgrade|weak|miss|cut|crash|warn|bearish|fraud|probe|default|lawsuit|layoff)\w*/gi;

function scoreSentiment(text: string): "positive" | "negative" | "neutral" {
  const p = (text.match(POS_RE) || []).length;
  const n = (text.match(NEG_RE) || []).length;
  if (p > n) return "positive";
  if (n > p) return "negative";
  return "neutral";
}

// Curated name → NSE symbol for the most-mentioned large caps (lowercase keys,
// distinctive enough to keep false positives low).
const NAME_TO_SYMBOL: Record<string, string> = {
  reliance: "RELIANCE",
  infosys: "INFY",
  wipro: "WIPRO",
  "hdfc bank": "HDFCBANK",
  "icici bank": "ICICIBANK",
  "axis bank": "AXISBANK",
  "state bank": "SBIN",
  "tata motors": "TATAMOTORS",
  "tata steel": "TATASTEEL",
  "bharti airtel": "BHARTIARTL",
  "sun pharma": "SUNPHARMA",
  "bajaj finance": "BAJFINANCE",
  "kotak mahindra": "KOTAKBANK",
  larsen: "LT",
  maruti: "MARUTI",
};

/** Tag the symbols an article mentions: curated large-cap names + uppercase
 *  ticker tokens that resolve to a real instrument. Capped to keep noise down. */
function tagSymbols(text: string, knownSymbols: Set<string>): string[] {
  const lower = text.toLowerCase();
  const found = new Set<string>();
  for (const [name, sym] of Object.entries(NAME_TO_SYMBOL)) {
    if (lower.includes(name)) found.add(sym);
  }
  for (const tok of text.match(/\b[A-Z]{3,12}\b/g) || []) {
    if (knownSymbols.has(tok)) found.add(tok);
  }
  return Array.from(found).slice(0, 4);
}

export async function processNewsRssSync(
  data: NewsRssSyncMessage,
): Promise<void> {
  const targetFeeds =
    data.sources && data.sources.length > 0
      ? FEEDS.filter((f) => data.sources!.includes(f.source))
      : FEEDS;

  if (targetFeeds.length === 0) {
    console.warn("[news-rss-sync] No matching feeds - exiting");
    reportJobOutcome({
      job: "news-rss-sync",
      selected: 0,
      written: 0,
      skippedReason: `no configured feed matches sources=[${data.sources?.join(",") ?? ""}]`,
    });
    return;
  }

  const maxPerFeed = data.maxPerFeed ?? 50;

  // Feeds that produced nothing usable — a non-200, a timeout, or a body the
  // parser refused. Counted rather than only warned about, because "every feed
  // returned nothing" and "no news was published in the last five minutes" are
  // indistinguishable in the article counts below and only one of them is a
  // healthy state (MONEY-1250).
  let feedFailures = 0;

  // Fetch + parse in parallel; one slow feed shouldn't block the rest.
  const parsedBatches = await Promise.all(
    targetFeeds.map(async (feed): Promise<RawNewsItem[]> => {
      const xml = await fetchFeed(feed.url);
      if (!xml) {
        feedFailures++;
        return [];
      }
      try {
        return parseRssChannel(xml, feed.source).slice(0, maxPerFeed);
      } catch (error) {
        feedFailures++;
        console.warn(
          `[news-rss-sync] parse failed for ${feed.source}:`,
          error instanceof Error ? error.message : String(error),
        );
        return [];
      }
    }),
  );
  const fresh = parsedBatches.flat();

  if (fresh.length === 0) {
    // Every feed silent at once is the egress-block shape, not a quiet market:
    // four independent outlets do not stop publishing on the same tick. It is
    // an ERROR line so it is greppable and alertable on its own, because the
    // article-level pair below cannot see it — see the note at the final
    // report.
    if (feedFailures === targetFeeds.length) {
      console.error(
        `[news-rss-sync] ALL ${targetFeeds.length} feed(s) failed to fetch or ` +
          `parse — this is not an empty window`,
      );
    } else {
      console.log("[news-rss-sync] No fresh items from any feed");
    }
    reportJobOutcome({
      job: "news-rss-sync",
      selected: 0,
      written: 0,
      // FEEDS, not rows — MONEY-1250 review. `failed` counts rows that
      // could not be persisted; a feed that would not answer is neither a
      // row nor a persistence failure.
      transportFailures: feedFailures,
      skippedReason:
        `no item parsed from any of ${targetFeeds.length} feed(s) ` +
        `(${feedFailures} failed)`,
    });
    return;
  }

  // Pull a window of recently stored URLs + titles so cross-batch dedup
  // doesn't re-save articles we already have.
  const since = new Date(Date.now() - 1000 * 60 * 60 * 24 * 7); // last 7d
  const known = await prisma.newsArticle.findMany({
    where: { publishedAt: { gte: since } },
    select: { url: true, title: true },
  });
  const dedupped = dedupNewsBatch(
    fresh,
    new Set(known.map((k) => k.url)),
    known.map((k) => k.title),
  );

  if (dedupped.length === 0) {
    console.log(
      `[news-rss-sync] All ${fresh.length} items already known - no inserts`,
    );
    reportJobOutcome({
      job: "news-rss-sync",
      selected: 0,
      written: 0,
      // FEEDS, not rows — MONEY-1250 review. `failed` counts rows that
      // could not be persisted; a feed that would not answer is neither a
      // row nor a persistence failure.
      transportFailures: feedFailures,
      skippedReason: `all ${fresh.length} item(s) already known`,
    });
    return;
  }

  // Exact URL dedup against the unique index for THIS batch. The 7d
  // window above is only a fuzzy-title net — an old-but-still-in-feed URL
  // sailed past it, and Prisma on MongoDB has NO createMany skipDuplicates
  // (despite the old comment), so one `news_articles_url_key` collision
  // threw P2002, the route 500'd, and Pub/Sub redelivered the same feed
  // forever (the retry storm of 2026-06-11).
  const candidateUrls = dedupped.map((i) => i.url);
  const existingByUrl = await prisma.newsArticle.findMany({
    where: { url: { in: candidateUrls } },
    select: { url: true },
  });
  const existingUrlSet = new Set(existingByUrl.map((e) => e.url));
  const toInsert = dedupped.filter((i) => !existingUrlSet.has(i.url));
  if (toInsert.length === 0) {
    console.log(
      `[news-rss-sync] All ${dedupped.length} candidates already stored by URL - no inserts`,
    );
    reportJobOutcome({
      job: "news-rss-sync",
      selected: 0,
      written: 0,
      // FEEDS, not rows — MONEY-1250 review. `failed` counts rows that
      // could not be persisted; a feed that would not answer is neither a
      // row nor a persistence failure.
      transportFailures: feedFailures,
      skippedReason: `all ${dedupped.length} candidate(s) already stored by URL`,
    });
    return;
  }

  // Enrichment lookup: load active equity symbols once so titles can be tagged
  // by uppercase ticker token (MONEY-408).
  const symbolRows = await prisma.instrumentMapping.findMany({
    where: { instrumentType: "EQUITY", isActive: true },
    select: { symbol: true },
  });
  const knownSymbols = new Set(symbolRows.map((r) => r.symbol.toUpperCase()));

  const rows = toInsert.map((item) => {
    const text = `${item.title} ${item.summary ?? ""}`;
    return {
      url: item.url,
      title: item.title,
      summary: item.summary,
      source: item.source,
      publishedAt: item.publishedAt,
      symbols: tagSymbols(text, knownSymbols),
      sectors: [],
      categories: [],
      language: "en",
      sentiment: scoreSentiment(text),
    };
  });

  let inserted = 0;
  try {
    const result = await prisma.newsArticle.createMany({ data: rows });
    inserted = result.count;
  } catch (err) {
    // A pod race can still land a duplicate between our check and the
    // write. Fall back to per-item inserts, swallowing ONLY the
    // unique-constraint collisions — anything else must surface so the
    // job genuinely fails.
    if ((err as { code?: string }).code !== "P2002") throw err;
    for (const row of rows) {
      try {
        await prisma.newsArticle.create({ data: row });
        inserted++;
      } catch (e) {
        if ((e as { code?: string }).code !== "P2002") throw e;
      }
    }
  }

  console.log(
    `[news-rss-sync] Inserted ${inserted} fresh articles (${fresh.length} candidates, ${fresh.length - toInsert.length} dedupped)`,
  );

  // MONEY-1250 — `selected` is `toInsert`, the articles that survived BOTH
  // dedupe gates and therefore had a write coming. NOT `fresh`.
  //
  // `fresh` is every item currently sitting in the four RSS channels, which is
  // ~200 on every tick whether or not anything is new. Pairing it with
  // `inserted` would report `selected 200, written 0` on the ordinary quiet
  // five-minute window — an alarm most of the day, muted within a week, and the
  // job's real failure then invisible behind the mute. `toInsert` is 0 on that
  // same window, so the monitor is silent, and it is non-zero exactly when the
  // job identified articles it was supposed to persist.
  //
  // KNOWN GAP, stated rather than papered over: this pair cannot see an
  // all-feeds-down run, because a feed that returns nothing produces no
  // candidates and so owes no write. That shape is carried by `failed`
  // (the `stockbook.job.failed` series) and by the ERROR line in the
  // `fresh.length === 0` branch above.
  reportJobOutcome({
    job: "news-rss-sync",
    selected: toInsert.length,
    written: inserted,
    failed: toInsert.length - inserted + feedFailures,
    ...(inserted < toInsert.length || feedFailures > 0
      ? {
          skippedReason:
            `${toInsert.length - inserted} of ${toInsert.length} new ` +
            `article(s) not stored; ${feedFailures} feed(s) failed`,
        }
      : {}),
  });
}
