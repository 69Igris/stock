"use client";

import { useState, useEffect } from "react";
import { useChatContext } from "@/lib/chat/ChatContext";
import { Badge } from "@usemoney/ui/badge";
import {
  Newspaper,
  ExternalLink,
  TrendingUp,
  TrendingDown,
  Minus,
  RefreshCw,
  Loader2,
} from "lucide-react";
import { Button } from "@usemoney/ui/button";
import { getMarketPulseNewsAction, type NewsArticle } from "@/lib/actions/news";

function timeAgo(date: Date | null): string {
  if (!date) return "";
  const now = Date.now();
  const diff = now - new Date(date).getTime();
  const minutes = Math.floor(diff / 60000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

function SentimentIcon({ sentiment }: { sentiment: string | null }) {
  if (sentiment === "POSITIVE")
    return <TrendingUp className="h-3 w-3 text-emerald-500" />;
  if (sentiment === "NEGATIVE")
    return <TrendingDown className="h-3 w-3 text-red-500" />;
  return <Minus className="h-3 w-3 text-[var(--text-muted)]" />;
}

export default function MarketPulse() {
  const { executeQuickAction } = useChatContext();
  const [articles, setArticles] = useState<NewsArticle[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);

  const fetchNews = async () => {
    setLoading(true);
    setError(false);
    try {
      const result = await getMarketPulseNewsAction();
      if (result?.success && result?.data) {
        setArticles(result?.data.articles);
      } else {
        setError(true);
      }
    } catch {
      setError(true);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchNews();
  }, []);

  if (loading) {
    return (
      <div className="w-full max-w-2xl">
        <div className="flex items-center gap-2 mb-3">
          <Newspaper className="h-4 w-4 text-[var(--text-muted)]" />
          <span className="text-xs font-medium text-[var(--text-muted)] uppercase tracking-wider">
            Market Pulse
          </span>
        </div>
        <div className="flex items-center justify-center py-6">
          <Loader2 className="h-4 w-4 animate-spin text-[var(--text-muted)]/50" />
        </div>
      </div>
    );
  }

  if (error || articles.length === 0) {
    return null; // Silently hide if no news
  }

  return (
    <div className="w-full max-w-2xl">
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-2">
          <Newspaper className="h-4 w-4 text-[var(--accent-primary)]" />
          <span className="text-xs font-medium text-[var(--text-muted)] uppercase tracking-wider">
            Market Pulse
          </span>
        </div>
        <Button
          variant="ghost"
          size="icon"
          onClick={fetchNews}
          className="h-6 w-6 text-[var(--text-muted)]/50 hover:text-[var(--text-primary)]"
        >
          <RefreshCw className="h-3 w-3" />
        </Button>
      </div>

      <div className="space-y-1.5">
        {articles.slice(0, 6).map((article) => (
          <div
            key={article.id}
            className="group flex items-start gap-3 px-3 py-2.5 rounded-lg bg-[var(--bg-card)] border border-[var(--border-default)] hover:border-[var(--border-default)] transition-colors cursor-pointer"
            onClick={() => {
              if (article.link && article.link !== "#") {
                window.open(article.link, "_blank", "noopener,noreferrer");
              } else {
                executeQuickAction(
                  `What's the latest news about ${article.symbol}?`
                );
              }
            }}
          >
            <SentimentIcon sentiment={article.sentiment} />

            <div className="flex-1 min-w-0">
              <p className="text-xs text-[var(--text-primary)] leading-snug line-clamp-2 group-hover:text-[var(--accent-primary)] transition-colors">
                {article.title}
              </p>
              <div className="flex items-center gap-2 mt-1">
                <Badge
                  variant="outline"
                  className="text-[9px] px-1.5 py-0 h-3.5 border-[var(--border-default)] text-[var(--text-muted)]"
                >
                  {article.symbol}
                </Badge>
                {article.source && article.source !== "GOOGLE_NEWS" && (
                  <span className="text-[10px] text-[var(--text-muted)]/50">
                    {article.source}
                  </span>
                )}
                <span className="text-[10px] text-[var(--text-muted)]/50">
                  {timeAgo(article.pubDate)}
                </span>
              </div>
            </div>

            {article.link && article.link !== "#" && (
              <ExternalLink className="h-3 w-3 text-[var(--text-muted)]/50 group-hover:text-[var(--text-muted)] shrink-0 mt-0.5 transition-colors" />
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
