"use client";

/**
 * News & events tab for the Stock detail page (MONEY-244 v3.1).
 *
 * Renders the most recent news items from `StockNews`. Each item shows
 * source, relative timestamp, sentiment dot (when classified), title
 * + snippet, and links out to the original article.
 */

import { useEffect, useState } from "react";
import { Newspaper, ExternalLink } from "lucide-react";
import {
  getStockNewsAction,
  type StockNewsItem,
} from "@/lib/actions/stock-tabs";
import { relativeTime } from "./relative-time";
import { SectionEmpty } from "./SectionShell";

interface StockNewsTabProps {
  symbol: string;
}

function SentimentDot({
  sentiment,
}: {
  sentiment: StockNewsItem["sentiment"];
}) {
  if (!sentiment) return null;
  const color =
    sentiment === "POSITIVE"
      ? "bg-emerald-400"
      : sentiment === "NEGATIVE"
        ? "bg-red-400"
        : "bg-amber-400";
  return (
    <span
      className={`inline-block w-1.5 h-1.5 rounded-full ${color}`}
      title={sentiment}
    />
  );
}

export function StockNewsTab({ symbol }: StockNewsTabProps) {
  const [news, setNews] = useState<StockNewsItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    getStockNewsAction({ symbol, limit: 24 })
      .then((r) => {
        if (cancelled) return;
        if (r.success) setNews(r.data);
        else setError(r.error ?? "Failed to load news");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [symbol]);

  return (
    <div>
      <div className="flex items-center gap-2 mb-3">
        <Newspaper className="h-4 w-4 text-emerald-400" />
        <h3 className="font-display text-[16px] font-bold tracking-[-0.2px]">
          News &amp; events
        </h3>
        {news.length > 0 && (
          <span className="font-mono text-[10.5px] tracking-[1px] uppercase text-[var(--text-muted)] ml-2">
            {news.length} item{news.length === 1 ? "" : "s"}
          </span>
        )}
      </div>

      {loading ? (
        <NewsSkeleton />
      ) : error ? (
        <div className="rounded-xl border border-red-400/20 bg-red-400/5 p-6 text-center text-red-400/80 text-sm">
          {error}
        </div>
      ) : news.length === 0 ? (
        // MONEY-1255 — was a byte-identical copy of `SectionShell`'s dashed
        // box carrying its own sentence. Nothing provenance-bearing was lost:
        // "No news for X yet" said only what the generic body says.
        <SectionEmpty />
      ) : (
        <div className="space-y-2">
          {news.map((n, i) => (
            <a
              key={`${n.link}-${i}`}
              href={n.link}
              target="_blank"
              rel="noopener noreferrer"
              className="block rounded-lg border border-[var(--border-default)] bg-[var(--gradient-card)] p-3.5 hover:border-emerald-400/30 transition-colors group"
            >
              <div className="flex items-baseline gap-2 mb-1.5 flex-wrap">
                <SentimentDot sentiment={n.sentiment} />
                <span className="font-mono text-[10px] tracking-[1px] uppercase font-bold text-[var(--text-muted)]">
                  {n.source.replace(/_/g, " ")}
                </span>
                <span className="font-mono text-[10.5px] text-[var(--text-muted)]">
                  · {relativeTime(n.pubDate)}
                </span>
                <ExternalLink className="ml-auto h-3 w-3 text-[var(--text-muted)] group-hover:text-emerald-400 transition-colors" />
              </div>
              <h4 className="text-[13.5px] font-semibold text-[var(--text-primary)] leading-snug mb-1 group-hover:text-emerald-400 transition-colors">
                {n.title}
              </h4>
              {n.snippet && (
                <p className="text-[12.5px] text-[var(--text-dim)] leading-relaxed line-clamp-2">
                  {n.snippet}
                </p>
              )}
            </a>
          ))}
        </div>
      )}
    </div>
  );
}

/** Shimmer placeholder mirroring the populated news list - source +
 *  timestamp on top line, headline below, snippet below that. */
function NewsSkeleton() {
  return (
    <div className="space-y-3">
      {Array.from({ length: 5 }).map((_, i) => (
        <div
          key={i}
          className="rounded-xl border border-[var(--border-default)] bg-[var(--gradient-card)] p-4 animate-pulse"
        >
          <div className="flex items-center gap-2 mb-2">
            <div className="h-3 w-20 bg-emerald-400/[0.10] rounded" />
            <div className="h-3 w-16 bg-white/[0.04] rounded" />
            <div className="h-3 w-12 bg-white/[0.04] rounded ml-auto" />
          </div>
          <div className="h-4 w-3/4 bg-white/[0.06] rounded mb-2" />
          <div className="h-3 w-full bg-white/[0.04] rounded mb-1" />
          <div className="h-3 w-5/6 bg-white/[0.04] rounded" />
        </div>
      ))}
    </div>
  );
}

export default StockNewsTab;
