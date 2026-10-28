"use client";

/**
 * Feeds tab body — playful redesign (MONEY-483).
 *
 * Per chat-sidebar.jsx FeedsBody:
 *  - Dashed emerald "Build from this chat" promo card.
 *  - Each feed is a pf-card (slight tilt) with an RSS tile + live dot.
 *  - Empty: direct link to create a feed via the drawer.
 */

import { useEffect, useState } from "react";
import Link from "next/link";
import { Plus, Sparkles, Rss, ArrowRight } from "lucide-react";
import {
  loadCustomFeeds,
  saveCustomFeeds,
  makePortfolioFeed,
  isPortfolioFeed,
  type FeedDef,
} from "@/app/discover/news/feed-storage";
import NewFeedDrawer from "@/app/discover/news/NewFeedDrawer";
import { getHoldingsAction } from "@/lib/actions/holdings";

interface Props {
  detectedSymbols?: string[];
}

/** Pop colour index for non-portfolio feeds */
const FEED_POPS = [
  "var(--pop-3)",
  "var(--pop-5)",
  "var(--pop-4)",
  "var(--pop-2)",
  "var(--pop-1)",
];

export default function FeedsTabBody({ detectedSymbols = [] }: Props) {
  const [customFeeds, setCustomFeeds] = useState<FeedDef[]>([]);
  const [portfolioSymbols, setPortfolioSymbols] = useState<string[]>([]);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [drawerPrefill, setDrawerPrefill] = useState<{
    symbols: string[];
    name: string;
  } | null>(null);

  useEffect(() => {
    setCustomFeeds(loadCustomFeeds());
  }, []);

  useEffect(() => {
    let cancelled = false;
    getHoldingsAction()
      .then((r) => {
        if (cancelled || !r?.success) return;
        const syms = Array.from(
          new Set(
            (r.data?.holdings ?? [])
              .map((h) => (h.symbol ?? "").toUpperCase())
              .filter(Boolean)
          )
        );
        setPortfolioSymbols(syms);
      })
      .catch(() => {
        // Silent — keep portfolio feed hidden if fetch fails.
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const portfolioFeed =
    portfolioSymbols.length > 0 ? makePortfolioFeed(portfolioSymbols) : null;
  const feeds: FeedDef[] = portfolioFeed
    ? [portfolioFeed, ...customFeeds]
    : customFeeds;

  const openCreateDrawer = (
    prefill: { symbols: string[]; name: string } | null
  ) => {
    setDrawerPrefill(prefill);
    setDrawerOpen(true);
  };

  const handleCreate = (feed: FeedDef) => {
    const next = [feed, ...customFeeds];
    setCustomFeeds(next);
    saveCustomFeeds(next);
    setDrawerOpen(false);
    setDrawerPrefill(null);
  };

  return (
    <div
      className="pf-noscrollbar"
      style={{ flex: 1, overflowY: "auto", padding: "14px 12px 18px" }}
    >
      {/* Section header */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          marginBottom: 12,
          padding: "0 2px",
        }}
      >
        <span
          className="mono"
          style={{
            fontSize: 10.5,
            fontWeight: 700,
            letterSpacing: "1.5px",
            textTransform: "uppercase",
            color: "var(--ink-3)",
          }}
        >
          My feeds
        </span>
        <button
          type="button"
          onClick={() => openCreateDrawer(null)}
          aria-label="New feed"
          style={{
            width: 22,
            height: 22,
            borderRadius: 6,
            border: "1.25px solid var(--ink)",
            background: "var(--paper)",
            color: "var(--ink)",
            display: "grid",
            placeItems: "center",
            cursor: "pointer",
            boxShadow: "1.5px 1.5px 0 var(--ink)",
          }}
        >
          <Plus className="h-3 w-3" />
        </button>
      </div>

      {/* Build-from-chat promo — dashed emerald card */}
      <button
        type="button"
        onClick={() =>
          openCreateDrawer(
            detectedSymbols.length > 0
              ? {
                  symbols: detectedSymbols,
                  name: `Chat — ${detectedSymbols.slice(0, 3).join(", ")}${detectedSymbols.length > 3 ? "…" : ""}`,
                }
              : null
          )
        }
        className="pf-card"
        style={{
          width: "100%",
          padding: 12,
          background: "var(--emerald-bg)",
          borderColor: "var(--emerald)",
          borderStyle: "dashed",
          borderWidth: 1.5,
          boxShadow: "none",
          marginBottom: 14,
          textAlign: "left",
          cursor: "pointer",
          fontFamily: "inherit",
        }}
      >
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 7,
            marginBottom: 4,
          }}
        >
          <Sparkles
            className="h-3 w-3 shrink-0"
            style={{ color: "var(--emerald-text)" }}
          />
          <span
            style={{ fontSize: 12.5, fontWeight: 700, color: "var(--ink)" }}
          >
            Build from this chat
          </span>
        </div>
        <div
          className="ser"
          style={{ fontSize: 12.5, color: "var(--ink-3)", lineHeight: 1.35 }}
        >
          {detectedSymbols.length > 0
            ? `Detected: ${detectedSymbols.slice(0, 6).join(", ")}`
            : "Mention tickers in chat to auto-fill."}
        </div>
      </button>

      {feeds.length === 0 ? (
        <div style={{ padding: "8px 0 0", textAlign: "center" }}>
          <Rss
            className="h-8 w-8 mx-auto mb-3"
            style={{ color: "var(--ink-4)" }}
          />
          <p
            className="ser"
            style={{ fontSize: 13, color: "var(--ink-3)", marginBottom: 12 }}
          >
            No feeds yet — build one to start tracking.
          </p>
          <button
            type="button"
            onClick={() => openCreateDrawer(null)}
            className="pf-bs sm"
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: 6,
              padding: "7px 12px",
              fontSize: 12,
            }}
          >
            <Plus className="h-3 w-3" /> Build first feed
          </button>
        </div>
      ) : (
        <>
          <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
            {feeds.map((f, i) => {
              const pop = isPortfolioFeed(f)
                ? "var(--emerald)"
                : FEED_POPS[i % FEED_POPS.length];
              const isPortfolio = isPortfolioFeed(f);
              return (
                <Link
                  key={f.id}
                  href={`/discover/news?tab=my-feeds&feed=${encodeURIComponent(f.id)}`}
                  style={{ textDecoration: "none" }}
                >
                  <div
                    className="pf-card"
                    style={{
                      padding: 12,
                      boxShadow: "3px 3px 0 var(--ink)",
                      // No panel-level rotate(): the card holds the feed name —
                      // tilting it re-rasterises the text (blurry). Keep only
                      // the hover "lift" translate for the playful feel.
                      transition: "transform 0.12s",
                    }}
                    onMouseEnter={(e) => {
                      (e.currentTarget as HTMLDivElement).style.transform =
                        "translate(-1px, -1px)";
                    }}
                    onMouseLeave={(e) => {
                      (e.currentTarget as HTMLDivElement).style.transform =
                        "none";
                    }}
                  >
                    <div
                      style={{ display: "flex", alignItems: "center", gap: 8 }}
                    >
                      {/* Icon tile */}
                      <div
                        style={{
                          width: 28,
                          height: 28,
                          borderRadius: 7,
                          background: pop,
                          border: "1.5px solid var(--ink)",
                          display: "grid",
                          placeItems: "center",
                          transform: "rotate(-4deg)",
                          flexShrink: 0,
                          color: "var(--paper)",
                        }}
                      >
                        <Rss className="h-3 w-3" strokeWidth={2.25} />
                      </div>

                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div
                          style={{
                            display: "flex",
                            alignItems: "center",
                            gap: 6,
                          }}
                        >
                          <span
                            style={{
                              fontSize: 12.5,
                              fontWeight: 700,
                              color: "var(--ink)",
                              overflow: "hidden",
                              textOverflow: "ellipsis",
                              whiteSpace: "nowrap",
                            }}
                          >
                            {f.name}
                          </span>
                          {/* Live pulse dot */}
                          <span
                            style={{
                              width: 6,
                              height: 6,
                              borderRadius: 999,
                              background: "var(--emerald)",
                              animation: "ph-pulse 1.6s infinite",
                              flexShrink: 0,
                            }}
                            aria-hidden="true"
                          />
                        </div>
                        <div
                          className="mono"
                          style={{
                            fontSize: 10,
                            color: "var(--ink-3)",
                            letterSpacing: 0.3,
                            marginTop: 1,
                          }}
                        >
                          {f.symbols.length} SYMBOL
                          {f.symbols.length === 1 ? "" : "S"}
                          {isPortfolio
                            ? " · LIVE"
                            : ` · ${relCreated(f.createdAt)}`}
                        </div>
                      </div>
                    </div>
                  </div>
                </Link>
              );
            })}
          </div>

          <div style={{ padding: "10px 4px 0" }}>
            <Link
              href="/discover/news?tab=my-feeds"
              style={{
                display: "inline-flex",
                alignItems: "center",
                gap: 6,
                fontSize: 12,
                fontWeight: 600,
                color: "var(--emerald-text)",
                textDecoration: "none",
              }}
            >
              View all feeds <ArrowRight className="h-3 w-3" />
            </Link>
          </div>
        </>
      )}

      <NewFeedDrawer
        open={drawerOpen}
        onClose={() => {
          setDrawerOpen(false);
          setDrawerPrefill(null);
        }}
        onCreate={handleCreate}
        prefilledSymbols={drawerPrefill?.symbols}
        prefilledName={drawerPrefill?.name}
      />
    </div>
  );
}

function relCreated(iso: string): string {
  const t = new Date(iso).getTime();
  if (!t) return "—";
  const m = Math.floor((Date.now() - t) / 60_000);
  if (m < 1) return "just now";
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  if (d < 7) return `${d}d ago`;
  return new Date(t).toLocaleDateString("en-IN", {
    day: "numeric",
    month: "short",
  });
}
