/**
 * News & Events - feed + Upcoming sidebar + Daily brief AI card
 * (MONEY-197).
 *
 * Server component fetches three things in parallel:
 *   - News feed (defaults to "all" filter - holdings + watchlists)
 *   - Upcoming events (next 7 days, demo gets sample data)
 *   - Daily brief (Gemini Flash summary; null when user has no holdings)
 *
 * The page degrades gracefully:
 *   - No holdings → news shows market pulse, brief panel hides
 *   - No events → "Nothing scheduled this week"
 *   - No news → empty state with CTA to add holdings/watchlist
 */

import Sidebar from "@/components/Sidebar";
import { PageGuard } from "@/components/PageGuard";
import {
  getNewsFeedAction,
  getUpcomingEventsAction,
  getDailyBriefAction,
  type NewsFeedFilter,
} from "@/lib/actions/news";
import type { NewsArticle, UpcomingEvent } from "@/lib/actions/news";
import { Sparkles, ArrowRight } from "lucide-react";
import NewsChrome from "./NewsChrome";
import NewsBodySkeleton from "./NewsBodySkeleton";
import { getNotificationsAction } from "@/lib/actions/notifications";
import { getHoldingsAction } from "@/lib/actions/holdings";
import { ComingSoon } from "@/components/ComingSoon";
import { isNewsAndEventsVisible } from "@/lib/config/coming-soon-flags";
import { currentUser } from "@clerk/nextjs/server";
import { isDemoSession } from "@/lib/demo/session";
import { withTimeout } from "@/lib/utils/with-timeout";

export const metadata = {
  // MONEY-394 N - bare title; root layout's template adds `| UseMoney`.
  title: "News & Events",
  description:
    "Stock-specific news + upcoming earnings, macro events, and corporate actions calendar.",
};

export const dynamic = "force-dynamic";

const VALID_FILTERS = new Set<NewsFeedFilter>([
  "all",
  "holdings",
  "watchlists",
  "market",
  "earnings",
  "corp_action",
]);

function parseFilter(raw: string | undefined): NewsFeedFilter {
  const v = (raw ?? "all").toLowerCase();
  return VALID_FILTERS.has(v as NewsFeedFilter) ? (v as NewsFeedFilter) : "all";
}

// ── Alert classification (MONEY-1204) — MIRROR ─────────────────────────────
//
// The CANONICAL copy lives in `apps/web/app/notifications/client.tsx`; this one
// is pinned to it by `__tests__/notifications/alert-classification.test.ts`,
// which compares this literal against that module's exported value and fails on
// any divergence.
//
// It is a mirror rather than an import because this file is a SERVER component.
// Next's flight loader rewrites every export of a `"use client"` module, when
// imported from the server layer, into a stub that throws `Attempted to call
// ALERT_NOTIFICATION_TYPES() from the server`
// (next/dist/build/webpack/loaders/next-flight-loader/index.js:119-128), so the
// import would type-check, build, and then blow up on the first request.
//
// The real fix is a directive-free module both layers import — e.g.
// `apps/web/lib/notifications/alert-classification.ts`. That file was out of
// scope for this change; until it exists, the drift test is the guard.
const ALERT_NOTIFICATION_TYPES = [
  "PRICE_ALERT",
  "VOLUME_ALERT",
  "NEWS_ALERT",
  "EARNINGS_REMINDER",
  "CORPORATE_ACTION",
] as const;

const ALERT_TYPES = new Set<string>(ALERT_NOTIFICATION_TYPES);

/** `metadata.alertKind`, or null. See the canonical copy for the why. */
function alertKindOf(metadata: unknown): string | null {
  if (!metadata || typeof metadata !== "object") return null;
  const v = (metadata as Record<string, unknown>).alertKind;
  return typeof v === "string" && v.trim() ? v.trim() : null;
}

/**
 * Is this notification a fired ALERT?
 *
 * The six data-engine kinds are written as NotificationType `SYSTEM` with the
 * precise kind in `metadata.alertKind`, so discriminating on `type` alone sent
 * every one of them to the generic notifications list instead of the alert
 * cards. Promoting `SYSTEM` wholesale would have done the opposite damage.
 */
function isAlertNotification(n: {
  type: string;
  metadata?: Record<string, unknown> | null;
}): boolean {
  if (ALERT_TYPES.has(n.type)) return true;
  return alertKindOf(n.metadata) !== null;
}

export default async function NewsAndEventsPage(props: {
  searchParams?: Promise<{ filter?: string }>;
}) {
  const searchParams = await props.searchParams;
  // News & Events is FF-gated to coming-soon until we ship the full
  // feed pipeline. Per-user allowlist (coming-soon-flags.ts) lets
  // internal accounts preview the live UI before the constant flips.
  // PageGuard's children render after access checks but do not provide
  // their own chrome, so we render Sidebar + main here to match every
  // other gated surface.
  const clerkUser = await currentUser();
  const email = clerkUser?.primaryEmailAddress?.emailAddress ?? null;
  // Demo visitors (no Clerk session, valid sb_demo cookie) bypass the
  // allowlist gate — they get the live News & Events UI with demo
  // sample data, same as every other Discover surface in demo mode.
  const isDemo = !clerkUser && (await isDemoSession());
  if (!isNewsAndEventsVisible(email, isDemo)) {
    return (
      <PageGuard
        route="/discover"
        title="News & Events"
        breadcrumb="Tools"
        containerClassName="px-6 py-6 max-w-[1280px] mx-auto"
      >
        <div className="pf-app min-h-screen">
          <Sidebar />
          <main className="lg:ml-[var(--sidebar-w)] min-h-screen pt-[var(--mobile-header-h)] lg:pt-[var(--topbar-h)]">
            <div className="pf-page">
              <div
                className="mb-5 flex items-baseline gap-3 flex-wrap"
                style={{ color: "var(--ink)" }}
              >
                <h1
                  style={{
                    fontSize: 32,
                    fontWeight: 800,
                    letterSpacing: -0.5,
                    lineHeight: 1,
                    margin: 0,
                    color: "var(--ink)",
                  }}
                >
                  News &amp; Events
                </h1>
                <span
                  className="mono"
                  style={{
                    fontSize: 11,
                    textTransform: "uppercase",
                    letterSpacing: 1.2,
                    color: "var(--ink-3)",
                    fontWeight: 700,
                  }}
                >
                  Tools
                </span>
              </div>
              <ComingSoon pageName="News & Events" />
            </div>
          </main>
        </div>
      </PageGuard>
    );
  }

  const filter = parseFilter(searchParams?.filter);

  const [newsResult, eventsResult, briefResult, notifResult, holdingsResult] =
    await Promise.all([
      withTimeout(getNewsFeedAction({ filter, limit: 30 }), 5000),
      withTimeout(getUpcomingEventsAction(), 4000),
      withTimeout(getDailyBriefAction(), 5000),
      withTimeout(getNotificationsAction(8, 0), 3000),
      withTimeout(getHoldingsAction(), 4000),
    ]);

  const articles = newsResult?.success ? (newsResult.data?.articles ?? []) : [];
  const events = eventsResult?.success ? (eventsResult.data?.events ?? []) : [];
  const brief = briefResult?.success ? briefResult.data?.brief : null;
  const notifs = notifResult?.success ? (notifResult.data ?? []) : [];

  // Distinct symbols from the user's actual holdings — drives the
  // virtual "My portfolio" feed on the My feeds tab.
  const portfolioSymbols: string[] = holdingsResult?.success
    ? Array.from(
        new Set(
          (holdingsResult.data?.holdings ?? [])
            .map((h) => (h.symbol ?? "").toUpperCase())
            .filter(Boolean)
        )
      )
    : [];

  // Reshape events → upcoming cards
  const upcomingCards = events.slice(0, 6).map((ev) => ({
    date: new Date(ev.date).toLocaleDateString("en-IN", {
      weekday: "short",
      month: "numeric",
      day: "numeric",
    }),
    category:
      ev.category === "earnings"
        ? "EARNINGS"
        : ev.category === "macro"
          ? "MACRO"
          : "CORP",
    title: ev.title,
  }));

  // Reshape notifications into the alerts + notifications side panels.
  // `isAlertNotification` (module scope) is the single rule both panels split
  // on, so a row can never land in neither or in both.

  function relTime(d: Date | string): string {
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

  const alertCards = notifs
    .filter((n) => isAlertNotification(n))
    .map((n) => ({
      id: n.id,
      symbol:
        (((n.metadata ?? {}) as Record<string, unknown>).symbol as
          | string
          | undefined) ?? "",
      text: n.title,
      when: relTime(n.createdAt),
      iconKey:
        n.type === "PRICE_ALERT"
          ? ("bell-ring" as const)
          : n.type === "VOLUME_ALERT"
            ? ("trending-up" as const)
            : n.type === "NEWS_ALERT"
              ? ("file-text" as const)
              : n.type === "EARNINGS_REMINDER"
                ? ("calendar" as const)
                : ("bell" as const),
    }));

  const notifCards = notifs
    .filter((n) => !isAlertNotification(n))
    .slice(0, 4)
    .map((n) => ({
      id: n.id,
      text: n.title,
      when: relTime(n.createdAt),
      unread: !n.isRead,
      iconKey:
        n.type === "ROAST_COMPLETE"
          ? ("flame" as const)
          : n.type === "RESEARCH_COMPLETE"
            ? ("sparkles" as const)
            : ("file-text" as const),
    }));

  const primaryCounts = {
    "my-feeds": 0,
    alerts: alertCards.length,
    notifications: notifs.filter((n) => !n.isRead).length,
  };

  return (
    <PageGuard
      route="/discover"
      title="News & Events"
      breadcrumb="Tools"
      description="Feeds, alerts & notifications — all in one place."
      fallback={<NewsBodySkeleton />}
      containerClassName="px-6 py-6 max-w-[1280px] mx-auto"
    >
      <div className="pf-app min-h-screen">
        <Sidebar />
        <main className="lg:ml-[var(--sidebar-w)] min-h-screen pt-[var(--mobile-header-h)] lg:pt-[var(--topbar-h)]">
          <div className="pf-page">
            <NewsChrome
              primaryCounts={primaryCounts}
              upcoming={upcomingCards}
              alerts={alertCards}
              notifications={notifCards}
              articles={articles}
              portfolioSymbols={portfolioSymbols}
            >
              {articles.length === 0 ? (
                <EmptyNews />
              ) : (
                <div>
                  {articles.map((a) => (
                    <NewsRow key={a.id} article={a} />
                  ))}
                </div>
              )}
              {brief && (
                <div className="mt-5">
                  <DailyBriefPanel
                    summary={brief.summary}
                    catalystCount={brief.catalystCount}
                  />
                </div>
              )}
            </NewsChrome>
          </div>
        </main>
      </div>
    </PageGuard>
  );
}

// ── News row ──────────────────────────────────────────────────────
//
// Card-style layout per design Image #41: source pill + timestamp +
// ●NEW pill + sentiment pill at the top; bold title; muted snippet;
// tag pills at the bottom.

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

function isRecent(d: Date | null): boolean {
  if (!d) return false;
  return Date.now() - new Date(d).getTime() < 30 * 60 * 1000;
}

function tagsForArticle(article: NewsArticle): string[] {
  // Stub heuristic until backend wires real tags. Use symbol + a few
  // simple keyword extracts from the title.
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

function NewsRow({ article }: { article: NewsArticle }) {
  const sentiment = sentimentTone(article.sentiment);
  const recent = isRecent(article.pubDate);
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
      {/* Header row: source pill + timestamp + NEW + sentiment */}
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

      {/* Title */}
      <div
        style={{
          fontSize: 17,
          fontWeight: 800,
          letterSpacing: -0.4,
          color: "var(--ink)",
          lineHeight: 1.25,
        }}
      >
        {article.title}
      </div>

      {/* Snippet */}
      {article.snippet && (
        <div
          style={{
            marginTop: 8,
            fontSize: 13,
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

      {/* Tag pills */}
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

function formatRelative(d: Date): string {
  const now = Date.now();
  const diff = now - new Date(d).getTime();
  const m = Math.floor(diff / 60_000);
  if (m < 1) return "just now";
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const days = Math.floor(h / 24);
  if (days < 7) return `${days}d ago`;
  return new Date(d).toLocaleDateString("en-IN", {
    day: "numeric",
    month: "short",
  });
}

function EmptyNews() {
  return (
    <div className="pf-card" style={{ padding: 40, textAlign: "center" }}>
      <div
        style={{
          fontSize: 16,
          fontWeight: 800,
          color: "var(--ink)",
          marginBottom: 8,
        }}
      >
        No news yet
      </div>
      <div
        style={{
          fontSize: 13,
          color: "var(--ink-3)",
          maxWidth: 420,
          margin: "0 auto",
        }}
      >
        Add holdings or watchlists to see news that matters to your positions.
      </div>
    </div>
  );
}

// ── Upcoming panel ────────────────────────────────────────────────

function UpcomingPanel({ events }: { events: UpcomingEvent[] }) {
  return (
    <div className="bg-[var(--gradient-card)] border border-[var(--border-default)] rounded-xl p-4">
      <div className="font-mono text-[11px] tracking-[1.2px] uppercase text-[var(--text-primary)] font-bold mb-3">
        Upcoming · this week
      </div>
      {events.length === 0 ? (
        <div className="text-[12px] text-[var(--text-muted)] py-2">
          Nothing scheduled this week
        </div>
      ) : (
        events.map((ev, i) => (
          <div
            key={`${ev.date}-${ev.title}-${i}`}
            className="flex items-center gap-2.5 py-2 border-b border-[var(--border-default)] last:border-0"
          >
            <div className="font-mono text-[10.5px] tracking-[0.5px] text-[var(--text-muted)] font-bold w-[60px] uppercase">
              {formatEventDate(ev.date)}
            </div>
            <div className="flex-1 text-[12.5px] text-[var(--text-secondary)]">
              {ev.title}
            </div>
            <span
              className={`font-mono text-[9px] tracking-[1px] uppercase px-1.5 py-0.5 rounded border ${
                ev.category === "earnings"
                  ? "bg-emerald-400/10 border-emerald-400/25 text-emerald-400"
                  : ev.category === "macro"
                    ? "bg-violet-400/10 border-violet-400/25 text-violet-300"
                    : "bg-amber-400/10 border-amber-400/25 text-amber-300"
              }`}
            >
              {ev.category}
            </span>
          </div>
        ))
      )}
    </div>
  );
}

function formatEventDate(iso: string): string {
  const d = new Date(iso);
  if (isNaN(d.getTime())) return iso;
  return d.toLocaleDateString("en-IN", { day: "2-digit", month: "short" });
}

// ── Daily brief panel ─────────────────────────────────────────────

function DailyBriefPanel({
  summary,
  catalystCount,
}: {
  summary: string;
  catalystCount: number;
}) {
  return (
    <div className="pf-card tilt-l" style={{ background: "var(--emerald-bg)" }}>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 8,
          marginBottom: 8,
        }}
      >
        <Sparkles
          className="h-3 w-3"
          style={{ color: "var(--emerald-text)" }}
        />
        <div
          className="mono"
          style={{
            fontSize: 10,
            letterSpacing: 1.5,
            textTransform: "uppercase",
            color: "var(--emerald-text)",
            fontWeight: 700,
          }}
        >
          Daily brief
        </div>
        {catalystCount > 0 && (
          <span
            className="mono"
            style={{ fontSize: 10, color: "var(--ink-3)" }}
          >
            · {catalystCount} catalyst{catalystCount === 1 ? "" : "s"}
          </span>
        )}
      </div>
      <div
        style={{
          fontSize: 13,
          lineHeight: 1.55,
          color: "var(--ink-2)",
          marginBottom: 12,
        }}
      >
        {summary}
      </div>
      <a
        href="/stocksage?prompt=Give%20me%20today%27s%20portfolio%20brief"
        className="pf-bs sm"
        style={{ width: "100%", justifyContent: "center" }}
      >
        Open in StockSage
        <ArrowRight className="h-3 w-3" />
      </a>
    </div>
  );
}
