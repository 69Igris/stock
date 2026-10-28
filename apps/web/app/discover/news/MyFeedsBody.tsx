"use client";

/**
 * My Feeds — virtual "My portfolio" feed (derived from user holdings)
 * + any user-created custom feeds (persisted to localStorage).
 *
 * No dummy / seed feeds. If the user has no holdings AND no custom
 * feeds, an empty state nudges them to create one.
 */

import { useEffect, useMemo, useState } from "react";
import { Plus, Rss, Briefcase } from "lucide-react";
import type { NewsArticle } from "@/lib/actions/news";
import {
  loadCustomFeeds,
  saveCustomFeeds,
  makePortfolioFeed,
  isPortfolioFeed,
  type FeedDef,
} from "./feed-storage";
import NewFeedDrawer from "./NewFeedDrawer";
import { EmptyState } from "@/components/empty/EmptyState";

interface Props {
  articles: NewsArticle[];
  /** Symbols from the user's actual holdings. Empty array = no holdings. */
  portfolioSymbols: string[];
}

export default function MyFeedsBody({ articles, portfolioSymbols }: Props) {
  const [customFeeds, setCustomFeeds] = useState<FeedDef[]>([]);
  const [activeId, setActiveId] = useState<string>("");
  const [drawerOpen, setDrawerOpen] = useState(false);

  const portfolioFeed: FeedDef | null = useMemo(
    () =>
      portfolioSymbols.length > 0 ? makePortfolioFeed(portfolioSymbols) : null,
    [portfolioSymbols]
  );

  const feeds: FeedDef[] = useMemo(
    () => (portfolioFeed ? [portfolioFeed, ...customFeeds] : customFeeds),
    [portfolioFeed, customFeeds]
  );

  // Initial load — pull custom feeds from localStorage, select first feed
  useEffect(() => {
    const stored = loadCustomFeeds();
    setCustomFeeds(stored);
  }, []);

  // Keep activeId pointing at a live feed
  useEffect(() => {
    if (feeds.length === 0) {
      setActiveId("");
      return;
    }
    if (!feeds.find((f) => f.id === activeId)) {
      setActiveId(feeds[0].id);
    }
  }, [feeds, activeId]);

  const handleCreate = (feed: FeedDef) => {
    const next = [feed, ...customFeeds];
    setCustomFeeds(next);
    saveCustomFeeds(next);
    setActiveId(feed.id);
  };

  const activeFeed = feeds.find((f) => f.id === activeId);
  const matched = filterArticles(articles, activeFeed);
  const todayCount = matched.filter((a) => isToday(a.pubDate)).length;

  const feedStats = (feed: FeedDef) => {
    const list = filterArticles(articles, feed);
    const newest = list[0]?.pubDate
      ? formatRelative(list[0].pubDate as Date | string)
      : "—";
    const newCount = list.filter((a) =>
      isWithin(a.pubDate, 6 * 60 * 60 * 1000)
    ).length;
    return { count: list.length, newCount, newest };
  };

  // No feeds at all — empty state
  if (feeds.length === 0) {
    return (
      <div>
        <EmptyState
          icon={Rss}
          title="No feeds yet"
          description="Connect a broker so we can surface news on your holdings — or build a custom feed by sector, symbols, or keywords."
          color="var(--emerald)"
          action={{
            label: "Create your first feed",
            onClick: () => setDrawerOpen(true),
          }}
        />
        <NewFeedDrawer
          open={drawerOpen}
          onClose={() => setDrawerOpen(false)}
          onCreate={handleCreate}
        />
      </div>
    );
  }

  return (
    <div>
      {/* Horizontal feed strip */}
      <div
        style={{ display: "flex", gap: 10, flexWrap: "wrap", marginBottom: 20 }}
      >
        {feeds.map((f) => {
          const on = f.id === activeId;
          const stats = feedStats(f);
          const portfolio = isPortfolioFeed(f);
          return (
            <button
              key={f.id}
              onClick={() => setActiveId(f.id)}
              className="pf-card flat"
              style={{
                minWidth: 210,
                flexShrink: 0,
                padding: 14,
                textAlign: "left",
                cursor: "pointer",
                borderColor: on ? "var(--emerald)" : "var(--ink)",
                background: on ? "var(--emerald-bg)" : "var(--paper)",
              }}
            >
              <div
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 6,
                  marginBottom: 6,
                }}
              >
                <div
                  style={{
                    fontSize: 14,
                    fontWeight: 800,
                    color: on ? "var(--emerald-text)" : "var(--ink)",
                  }}
                >
                  {f.name}
                </div>
                {portfolio && (
                  <Briefcase
                    className="h-3 w-3"
                    style={{
                      color: on ? "var(--emerald-text)" : "var(--ink-3)",
                    }}
                  />
                )}
              </div>
              <div
                className="mono"
                style={{ fontSize: 10.5, color: "var(--ink-3)" }}
              >
                {stats.newCount} new · {stats.newest}
              </div>
            </button>
          );
        })}
        <button
          onClick={() => setDrawerOpen(true)}
          className="pf-card flat"
          style={{
            minWidth: 160,
            flexShrink: 0,
            padding: 14,
            textAlign: "left",
            cursor: "pointer",
            borderStyle: "dashed",
            display: "inline-flex",
            alignItems: "center",
            gap: 8,
          }}
        >
          <Plus
            className="h-3.5 w-3.5"
            style={{ color: "var(--emerald-text)" }}
          />
          <span
            style={{ fontSize: 13, fontWeight: 700, color: "var(--ink-2)" }}
          >
            New feed
          </span>
        </button>
      </div>

      {/* Active feed header */}
      {activeFeed && (
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 12,
            marginBottom: 12,
            flexWrap: "wrap",
            position: "relative",
            paddingLeft: 12,
          }}
        >
          <span
            style={{
              position: "absolute",
              left: 0,
              top: 6,
              bottom: 6,
              width: 3,
              borderRadius: 999,
              background: "var(--emerald)",
            }}
          />
          <div
            style={{
              fontSize: 18,
              fontWeight: 800,
              color: "var(--ink)",
              letterSpacing: -0.3,
            }}
          >
            {activeFeed.name}
          </div>
          <span
            className="pf-pill emerald"
            style={{ fontSize: 9.5, padding: "1px 7px" }}
          >
            {todayCount} today
          </span>
          <div style={{ flex: 1 }} />
          {activeFeed.symbols.length > 0 && (
            <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
              {activeFeed.symbols.slice(0, 5).map((sym) => (
                <span
                  key={sym}
                  className="pf-pill outline"
                  style={{ fontSize: 9.5, padding: "2px 8px" }}
                >
                  {sym}
                </span>
              ))}
              {activeFeed.symbols.length > 5 && (
                <span
                  className="mono"
                  style={{
                    fontSize: 10.5,
                    color: "var(--ink-3)",
                    alignSelf: "center",
                  }}
                >
                  +{activeFeed.symbols.length - 5}
                </span>
              )}
            </div>
          )}
        </div>
      )}

      {matched.length === 0 ? (
        <EmptyFeed feedName={activeFeed?.name ?? "this feed"} />
      ) : (
        <div>
          {matched.map((a) => (
            <FeedArticleRow key={a.id} article={a} />
          ))}
        </div>
      )}

      <NewFeedDrawer
        open={drawerOpen}
        onClose={() => setDrawerOpen(false)}
        onCreate={handleCreate}
      />
    </div>
  );
}

// ── Filtering ────────────────────────────────────────────────────

function filterArticles(
  articles: NewsArticle[],
  feed: FeedDef | undefined
): NewsArticle[] {
  if (!feed) return articles;
  const symbolSet = new Set(feed.symbols.map((s) => s.toUpperCase()));
  const keywords = (feed.keywords ?? [])
    .map((k) => k.toLowerCase())
    .filter(Boolean);
  return articles.filter((a) => {
    if (a.symbol && symbolSet.has(a.symbol.toUpperCase())) return true;
    if (keywords.length > 0) {
      const blob = `${a.title} ${a.snippet ?? ""}`.toLowerCase();
      if (keywords.some((k) => blob.includes(k))) return true;
    }
    if (
      feed.sentiment &&
      feed.sentiment !== "any" &&
      a.sentiment &&
      a.sentiment.toLowerCase().includes(feed.sentiment)
    ) {
      return true;
    }
    return false;
  });
}

function isToday(d: Date | string | null): boolean {
  if (!d) return false;
  const dt = typeof d === "string" ? new Date(d) : d;
  const now = new Date();
  return (
    dt.getDate() === now.getDate() &&
    dt.getMonth() === now.getMonth() &&
    dt.getFullYear() === now.getFullYear()
  );
}

function isWithin(d: Date | string | null, ms: number): boolean {
  if (!d) return false;
  const t = typeof d === "string" ? new Date(d).getTime() : d.getTime();
  return Date.now() - t < ms;
}

function formatRelative(d: Date | string): string {
  const t = typeof d === "string" ? new Date(d).getTime() : d.getTime();
  const m = Math.floor((Date.now() - t) / 60_000);
  if (m < 1) return "now";
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const days = Math.floor(h / 24);
  if (days < 7) return `${days}d ago`;
  return new Date(t).toLocaleDateString("en-IN", {
    day: "numeric",
    month: "short",
  });
}

function sentimentTone(sentiment: string | null): {
  label: string;
  variant: "emerald" | "coral" | "outline";
} | null {
  if (!sentiment) return null;
  const s = sentiment.toLowerCase();
  if (s.includes("pos")) {
    return { label: "Positive", variant: "emerald" };
  }
  if (s.includes("neg")) {
    return { label: "Negative", variant: "coral" };
  }
  return { label: "Neutral", variant: "outline" };
}

function tagsForArticle(article: NewsArticle): string[] {
  const tags = new Set<string>();
  if (article.symbol && article.symbol !== "MARKET") tags.add(article.symbol);
  const titleLower = article.title.toLowerCase();
  const KEYWORDS = [
    "Banking",
    "NIFTY",
    "BANKNIFTY",
    "RBI",
    "Telecom",
    "Auto",
    "Fintech",
    "Conglomerate",
    "IT services",
  ];
  for (const k of KEYWORDS) {
    if (titleLower.includes(k.toLowerCase())) tags.add(k);
  }
  return Array.from(tags).slice(0, 3);
}

function FeedArticleRow({ article }: { article: NewsArticle }) {
  const sentiment = sentimentTone(article.sentiment);
  const recent =
    !!article.pubDate &&
    Date.now() - new Date(article.pubDate).getTime() < 30 * 60 * 1000;
  const tags = tagsForArticle(article);

  return (
    <a
      href={article.link}
      target="_blank"
      rel="noopener noreferrer"
      className="pf-card"
      style={{
        display: "block",
        padding: 16,
        marginBottom: 10,
        textDecoration: "none",
        color: "var(--ink)",
      }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 8,
          marginBottom: 8,
          flexWrap: "wrap",
        }}
      >
        <span
          className="pf-pill outline"
          style={{ fontSize: 9.5, padding: "1px 7px" }}
        >
          {article.source}
        </span>
        {article.pubDate && (
          <span
            className="mono"
            style={{ fontSize: 10.5, color: "var(--ink-3)" }}
          >
            {formatRelative(article.pubDate)}
          </span>
        )}
        {recent && (
          <span
            className="pf-pill emerald"
            style={{ fontSize: 9, padding: "1px 7px" }}
          >
            <span
              style={{
                width: 4,
                height: 4,
                borderRadius: "50%",
                background: "var(--paper)",
              }}
            />
            NEW
          </span>
        )}
        {sentiment && (
          <span
            className={`pf-pill ${sentiment.variant}`}
            style={{ fontSize: 9.5, padding: "1px 7px" }}
          >
            {sentiment.label}
          </span>
        )}
      </div>

      <div
        style={{
          fontSize: 16,
          fontWeight: 800,
          letterSpacing: -0.4,
          color: "var(--ink)",
          lineHeight: 1.25,
        }}
      >
        {article.title}
      </div>

      {article.snippet && (
        <div
          style={{
            marginTop: 8,
            fontSize: 12.5,
            color: "var(--ink-3)",
            lineHeight: 1.5,
            display: "-webkit-box",
            WebkitLineClamp: 2,
            WebkitBoxOrient: "vertical",
            overflow: "hidden",
          }}
        >
          {article.snippet}
        </div>
      )}

      {tags.length > 0 && (
        <div
          style={{ display: "flex", flexWrap: "wrap", gap: 6, marginTop: 10 }}
        >
          {tags.map((t) => (
            <span
              key={t}
              className="pf-pill outline"
              style={{ fontSize: 9.5, padding: "1px 7px" }}
            >
              {t}
            </span>
          ))}
        </div>
      )}
    </a>
  );
}

function EmptyFeed({ feedName }: { feedName: string }) {
  return (
    <EmptyState
      icon={Rss}
      title={`No matches yet for ${feedName}`}
      description="We'll start filling this feed as articles matching its symbols and keywords come in."
      color="var(--emerald)"
      muted
    />
  );
}
