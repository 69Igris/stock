"use client";

/**
 * News page chrome — playful (pf-*) re-skin (MONEY-485).
 *
 * Preserves the full feature surface unchanged:
 *   - Title row "News & Events · Tools · LIVE"
 *   - Primary tabs: Live feed / My feeds (N) / Alerts (N) / Notifications (N)
 *   - Category tabs: All / Markets / Stocks / Macro / Earnings / RBI / Corp actions
 *   - Sources chip strip: ET / MINT / BS / MONEYCONTROL / NSE / BSE
 *   - "UPCOMING THIS WEEK" horizontal scroll cards
 *   - Right side panel: YOUR ALERTS + NOTIFICATIONS summary
 *
 * Filter state is local; the parent server component still owns the
 * feed fetch and re-fetches when the URL `?filter=` changes.
 */

import { useState } from "react";
import Link from "next/link";
import { useRouter, useSearchParams, usePathname } from "next/navigation";
import {
  Rss,
  Bell,
  BellRing,
  Calendar,
  TrendingDown,
  TrendingUp,
  FileText,
  AtSign,
  Flame,
  Sparkles,
  BellPlus,
  Plus,
} from "lucide-react";
import NewAlertDrawer from "./NewAlertDrawer";
import MyFeedsBody from "./MyFeedsBody";
import type { NewsArticle } from "@/lib/actions/news";
import { useOwnedRoute } from "@/lib/hooks/useOwnedRoute";

type PrimaryTab = "live" | "my-feeds" | "alerts" | "notifications";
type CategoryTab =
  | "All"
  | "Markets"
  | "Stocks"
  | "Macro"
  | "Earnings"
  | "RBI"
  | "Corp actions";
type Source = "ET" | "MINT" | "BS" | "MONEYCONTROL" | "NSE" | "BSE";

const PRIMARY: Array<{
  id: PrimaryTab;
  label: string;
  Icon: React.ComponentType<{ className?: string }>;
}> = [
  { id: "live", label: "Live feed", Icon: Rss },
  { id: "my-feeds", label: "My feeds", Icon: Bell },
  { id: "alerts", label: "Alerts", Icon: BellRing },
  { id: "notifications", label: "Notifications", Icon: Bell },
];

const CATEGORIES: CategoryTab[] = [
  "All",
  "Markets",
  "Stocks",
  "Macro",
  "Earnings",
  "RBI",
  "Corp actions",
];

const SOURCES: Source[] = ["ET", "MINT", "BS", "MONEYCONTROL", "NSE", "BSE"];

interface UpcomingCard {
  date: string;
  category: string;
  title: string;
  symbol?: string;
  note?: string;
}

/**
 * Icon keys instead of function components - Server Components can't
 * pass functions across the boundary. NewsChrome maps key → Icon
 * locally.
 */
export type AlertIconKey =
  | "bell"
  | "bell-ring"
  | "trending-down"
  | "trending-up"
  | "file-text"
  | "calendar"
  | "at-sign";

export type NotifIconKey =
  | "bell"
  | "bell-ring"
  | "file-text"
  | "flame"
  | "sparkles"
  | "at-sign"
  | "calendar";

const ALERT_ICON: Record<
  AlertIconKey,
  React.ComponentType<{ className?: string }>
> = {
  bell: Bell,
  "bell-ring": BellRing,
  "trending-down": TrendingDown,
  "trending-up": TrendingUp,
  "file-text": FileText,
  calendar: Calendar,
  "at-sign": AtSign,
};

const NOTIF_ICON: Record<
  NotifIconKey,
  React.ComponentType<{ className?: string }>
> = {
  bell: Bell,
  "bell-ring": BellRing,
  "file-text": FileText,
  flame: Flame,
  sparkles: Sparkles,
  "at-sign": AtSign,
  calendar: Calendar,
};

interface AlertSummary {
  id: string;
  symbol: string;
  text: string;
  when: string;
  iconKey: AlertIconKey;
}

interface NotificationSummary {
  id: string;
  text: string;
  when: string;
  unread: boolean;
  iconKey: NotifIconKey;
}

interface Props {
  primaryCounts?: Partial<Record<PrimaryTab, number>>;
  upcoming?: UpcomingCard[];
  alerts?: AlertSummary[];
  notifications?: NotificationSummary[];
  /** Raw articles — needed so the My feeds tab can filter client-side
   *  without a second round-trip. */
  articles?: NewsArticle[];
  /** Distinct holding symbols. Drives the default "My portfolio" feed. */
  portfolioSymbols?: string[];
  children?: React.ReactNode;
}

export default function NewsChrome({
  primaryCounts,
  upcoming = [],
  alerts = [],
  notifications = [],
  articles = [],
  portfolioSymbols = [],
  children,
}: Props) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const ownedRoute = useOwnedRoute();

  const [primary, setPrimary] = useState<PrimaryTab>("live");
  const [category, setCategory] = useState<CategoryTab>("All");
  const [activeSources, setActiveSources] = useState<Set<Source>>(
    new Set(SOURCES)
  );
  const [drawerOpen, setDrawerOpen] = useState(false);

  const toggleSource = (s: Source) => {
    setActiveSources((prev) => {
      const next = new Set(prev);
      if (next.has(s)) next.delete(s);
      else next.add(s);
      return next.size === 0 ? new Set(SOURCES) : next;
    });
  };

  const handleCategoryClick = (c: CategoryTab) => {
    setCategory(c);
    // Map category to existing server filter
    const filterMap: Record<CategoryTab, string> = {
      All: "all",
      Markets: "market",
      Stocks: "holdings",
      Macro: "market",
      Earnings: "earnings",
      RBI: "market",
      "Corp actions": "corp_action",
    };
    const params = new URLSearchParams(searchParams?.toString() ?? "");
    params.set("filter", filterMap[c]);
    // MONEY-1082: `pathname` is captured at render, so an unguarded write
    // could re-assert this route after the user navigated away. replaceRoute
    // (not syncParams) because the filter drives a server re-render.
    ownedRoute.replaceRoute(`${pathname}?${params.toString()}`);
  };

  return (
    <>
      {/* Title + Tools chip + LIVE pill */}
      <div className="pf-ph" style={{ alignItems: "flex-start" }}>
        <div className="l">
          <div className="eyebrow">
            <span className="d" aria-hidden />
            DISCOVER · NEWS · RANKED FOR YOU
          </div>
          <h1>
            What&rsquo;s <span className="ser">moving the tape.</span>
          </h1>
          <div className="sub">
            Feeds, alerts &amp; notifications — all in one place.
          </div>
        </div>
        <div className="r">
          <span className="pf-pill emerald">
            <span
              style={{
                width: 6,
                height: 6,
                borderRadius: "50%",
                background: "var(--paper)",
              }}
            />
            LIVE
          </span>
        </div>
      </div>

      {/* Primary tab strip */}
      <div
        style={{ display: "flex", gap: 6, marginBottom: 16, flexWrap: "wrap" }}
      >
        {PRIMARY.map((t) => {
          const count = primaryCounts?.[t.id];
          const active = primary === t.id;
          return (
            <button
              key={t.id}
              onClick={() => setPrimary(t.id)}
              className={`pf-pill ${active ? "" : "outline"}`}
              style={{
                cursor: "pointer",
                fontSize: 12,
                padding: "6px 12px",
                background: active ? "var(--ink)" : "transparent",
                color: active ? "var(--paper)" : "var(--ink-2)",
                borderColor: "var(--ink)",
              }}
            >
              <t.Icon className="h-3.5 w-3.5" />
              {t.label}
              {count !== undefined && count > 0 && (
                <span
                  className="mono"
                  style={{
                    fontSize: 10,
                    fontWeight: 700,
                    padding: "0 6px",
                    borderRadius: 999,
                    background: active ? "var(--paper)" : "var(--rule-softer)",
                    color: active ? "var(--ink)" : "var(--ink-3)",
                  }}
                >
                  {count}
                </span>
              )}
            </button>
          );
        })}
      </div>

      {/* "New alert" CTA - only on Alerts tab */}
      {primary === "alerts" && (
        <div
          style={{
            display: "flex",
            justifyContent: "flex-end",
            marginBottom: 16,
          }}
        >
          <button onClick={() => setDrawerOpen(true)} className="pf-bs">
            <BellPlus className="h-3 w-3" /> New alert
          </button>
        </div>
      )}

      {/* Alerts tab - full-width list */}
      {primary === "alerts" && (
        <AlertsList alerts={alerts} onNewAlert={() => setDrawerOpen(true)} />
      )}

      {/* Notifications tab - full-width list */}
      {primary === "notifications" && (
        <NotificationsList notifications={notifications} />
      )}

      {/* My feeds — custom news streams (per-symbol, per-sector, keyword) */}
      {primary === "my-feeds" && (
        <div className="grid grid-cols-1 lg:grid-cols-[minmax(0,1fr)_300px] gap-5">
          <MyFeedsBody
            articles={articles}
            portfolioSymbols={portfolioSymbols}
          />
          <FeedsSidePanel
            alerts={alerts}
            notifications={notifications}
            onNewAlert={() => setDrawerOpen(true)}
          />
        </div>
      )}

      {/* Live feed layout: feed (left) + alerts/notifications panel (right) */}
      {primary === "live" && (
        <div className="grid grid-cols-1 lg:grid-cols-[minmax(0,1fr)_300px] gap-5">
          <div>
            {/* Category tabs */}
            <div
              style={{
                display: "flex",
                gap: 14,
                marginBottom: 12,
                borderBottom: "1.5px solid var(--rule-soft)",
                flexWrap: "wrap",
              }}
            >
              {CATEGORIES.map((c) => {
                const active = c === category;
                return (
                  <button
                    key={c}
                    onClick={() => handleCategoryClick(c)}
                    style={{
                      position: "relative",
                      paddingBottom: 8,
                      fontSize: 13,
                      fontWeight: active ? 700 : 500,
                      cursor: "pointer",
                      background: "transparent",
                      border: 0,
                      color: active ? "var(--ink)" : "var(--ink-3)",
                    }}
                  >
                    {c}
                    {active && (
                      <span
                        style={{
                          position: "absolute",
                          bottom: -1,
                          left: 0,
                          right: 0,
                          height: 2,
                          background: "var(--emerald)",
                          borderRadius: "2px 2px 0 0",
                        }}
                      />
                    )}
                  </button>
                );
              })}
            </div>

            {/* Sources chip strip */}
            <div
              style={{
                display: "flex",
                alignItems: "center",
                gap: 6,
                marginBottom: 16,
                flexWrap: "wrap",
              }}
            >
              <span
                className="mono"
                style={{
                  fontSize: 10.5,
                  textTransform: "uppercase",
                  letterSpacing: 1.5,
                  color: "var(--ink-3)",
                  fontWeight: 700,
                }}
              >
                SOURCES
              </span>
              {SOURCES.map((s) => {
                const active = activeSources.has(s);
                return (
                  <button
                    key={s}
                    onClick={() => toggleSource(s)}
                    className={`pf-pill ${active ? "emerald" : "outline"}`}
                    style={{
                      cursor: "pointer",
                      fontSize: 9.5,
                      padding: "3px 9px",
                    }}
                  >
                    {s}
                  </button>
                );
              })}
            </div>

            {/* Upcoming this week */}
            {upcoming.length > 0 && (
              <>
                <div
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 8,
                    marginBottom: 10,
                  }}
                >
                  <Calendar
                    className="h-3.5 w-3.5"
                    style={{ color: "var(--pop-2-text)" }}
                  />
                  <span
                    className="mono"
                    style={{
                      fontSize: 10.5,
                      textTransform: "uppercase",
                      letterSpacing: 1.5,
                      color: "var(--pop-2-text)",
                      fontWeight: 700,
                    }}
                  >
                    UPCOMING THIS WEEK
                  </span>
                </div>
                <div
                  style={{
                    display: "flex",
                    gap: 10,
                    overflowX: "auto",
                    paddingBottom: 12,
                    marginBottom: 16,
                  }}
                >
                  {upcoming.map((u, i) => {
                    const tone =
                      u.category.toLowerCase() === "earnings"
                        ? "var(--emerald-text)"
                        : u.category.toLowerCase() === "rbi" ||
                            u.category.toLowerCase().includes("macro")
                          ? "var(--pop-5-text)"
                          : "var(--pop-2-text)";
                    return (
                      <div
                        key={`${u.date}-${i}`}
                        className="pf-card flat"
                        style={{ minWidth: 230, padding: 12 }}
                      >
                        <div
                          style={{
                            display: "flex",
                            alignItems: "center",
                            gap: 8,
                            marginBottom: 6,
                          }}
                        >
                          <span
                            className="mono"
                            style={{
                              fontSize: 10,
                              textTransform: "uppercase",
                              letterSpacing: 1,
                              fontWeight: 700,
                              color: tone,
                            }}
                          >
                            {u.category}
                          </span>
                        </div>
                        <div
                          style={{
                            fontSize: 12.5,
                            fontWeight: 700,
                            color: "var(--ink)",
                            lineHeight: 1.3,
                            marginBottom: 8,
                          }}
                        >
                          {u.title}
                        </div>
                        <div
                          className="mono"
                          style={{
                            display: "flex",
                            alignItems: "center",
                            gap: 6,
                            fontSize: 10.5,
                            color: "var(--ink-3)",
                          }}
                        >
                          <span>{u.date}</span>
                          {u.symbol && (
                            <span
                              style={{
                                padding: "0 6px",
                                borderRadius: 4,
                                color: "var(--emerald-text)",
                                background: "var(--emerald-bg)",
                              }}
                            >
                              {u.symbol}
                            </span>
                          )}
                          {u.note && <span>· {u.note}</span>}
                        </div>
                      </div>
                    );
                  })}
                </div>
              </>
            )}

            {children}
          </div>

          {/* Right panel - Alerts + Notifications */}
          <aside style={{ display: "flex", flexDirection: "column", gap: 14 }}>
            <SidePanelAlerts
              alerts={alerts}
              onNewAlert={() => setDrawerOpen(true)}
            />
            <SidePanelNotifications notifications={notifications} />
          </aside>
        </div>
      )}

      <NewAlertDrawer
        open={drawerOpen}
        onClose={() => setDrawerOpen(false)}
        onCreated={() => {
          // The page is server-rendered; soft-refresh so the new alert
          // shows up in the side panel + Alerts tab on the next paint.
          router.refresh();
        }}
      />
    </>
  );
}

// ── Side panels ───────────────────────────────────────────────────

function SidePanelAlerts({
  alerts,
  onNewAlert,
}: {
  alerts: AlertSummary[];
  onNewAlert: () => void;
}) {
  return (
    <div className="pf-card">
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 8,
          marginBottom: 12,
        }}
      >
        <BellRing
          className="h-3.5 w-3.5"
          style={{ color: "var(--pop-2-text)" }}
        />
        <span className="ttl">YOUR ALERTS</span>
        {alerts.length > 0 && (
          <span
            className="pf-pill gold"
            style={{ fontSize: 9.5, padding: "1px 7px" }}
          >
            {alerts.length}
          </span>
        )}
        <a
          href="/notifications"
          className="mono"
          style={{ marginLeft: "auto", fontSize: 10.5, color: "var(--ink-3)" }}
        >
          All ›
        </a>
      </div>
      {alerts.length === 0 ? (
        <div style={{ fontSize: 12, color: "var(--ink-3)" }}>
          No alerts firing right now.
        </div>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          {alerts.slice(0, 4).map((a) => {
            const I = ALERT_ICON[a.iconKey] ?? Bell;
            return (
              <div
                key={a.id}
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 10,
                  fontSize: 12,
                }}
              >
                <I className="h-3.5 w-3.5 flex-shrink-0" />
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div
                    style={{
                      color: "var(--ink-2)",
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                      whiteSpace: "nowrap",
                    }}
                  >
                    {a.text}
                  </div>
                  <div
                    className="mono"
                    style={{ fontSize: 10.5, color: "var(--ink-3)" }}
                  >
                    {a.when}
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}
      <button
        onClick={onNewAlert}
        className="pf-bf sm"
        style={{ marginTop: 12, width: "100%", justifyContent: "center" }}
      >
        <Bell className="h-3 w-3" /> New alert
      </button>
    </div>
  );
}

function SidePanelNotifications({
  notifications,
}: {
  notifications: NotificationSummary[];
}) {
  const unread = notifications.filter((n) => n.unread).length;
  return (
    <div className="pf-card">
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 8,
          marginBottom: 12,
        }}
      >
        <Bell
          className="h-3.5 w-3.5"
          style={{ color: "var(--emerald-text)" }}
        />
        <span className="ttl">NOTIFICATIONS</span>
        {unread > 0 && (
          <span
            className="pf-pill emerald"
            style={{ fontSize: 9.5, padding: "1px 7px" }}
          >
            {unread} unread
          </span>
        )}
        <a
          href="/notifications"
          className="mono"
          style={{ marginLeft: "auto", fontSize: 10.5, color: "var(--ink-3)" }}
        >
          All ›
        </a>
      </div>
      {notifications.length === 0 ? (
        <div style={{ fontSize: 12, color: "var(--ink-3)" }}>
          You&rsquo;re all caught up.
        </div>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          {notifications.slice(0, 4).map((n) => {
            const I = NOTIF_ICON[n.iconKey] ?? Bell;
            return (
              <div
                key={n.id}
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 10,
                  fontSize: 12,
                }}
              >
                <I className="h-3.5 w-3.5 flex-shrink-0" />
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div
                    style={{
                      color: "var(--ink-2)",
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                      whiteSpace: "nowrap",
                    }}
                  >
                    {n.text}
                  </div>
                  <div
                    className="mono"
                    style={{ fontSize: 10.5, color: "var(--ink-3)" }}
                  >
                    {n.when}
                  </div>
                </div>
                {n.unread && (
                  <span
                    style={{
                      width: 6,
                      height: 6,
                      borderRadius: "50%",
                      background: "var(--emerald)",
                      flexShrink: 0,
                    }}
                    aria-hidden
                  />
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

function AlertsList({
  alerts,
  onNewAlert,
}: {
  alerts: AlertSummary[];
  onNewAlert: () => void;
}) {
  if (alerts.length === 0) {
    return (
      <div className="pf-card" style={{ padding: 40, textAlign: "center" }}>
        <BellRing
          className="h-6 w-6 mx-auto mb-2.5"
          style={{ color: "var(--pop-2)" }}
        />
        <div
          style={{
            fontSize: 16,
            fontWeight: 800,
            color: "var(--ink)",
            marginBottom: 6,
          }}
        >
          No alerts yet
        </div>
        <div
          style={{
            fontSize: 13,
            color: "var(--ink-3)",
            maxWidth: 420,
            margin: "0 auto 16px",
          }}
        >
          Build a price, volume, news or earnings alert and we&rsquo;ll notify
          you when the condition fires.
        </div>
        <button onClick={onNewAlert} className="pf-bs">
          <Plus className="h-3 w-3" /> Create your first alert
        </button>
      </div>
    );
  }
  return (
    <div className="pf-card" style={{ padding: 0, overflow: "hidden" }}>
      <div
        style={{
          padding: "12px 16px",
          borderBottom: "1.5px dashed var(--rule-soft)",
          display: "flex",
          alignItems: "center",
          gap: 8,
        }}
      >
        <BellRing
          className="h-3.5 w-3.5"
          style={{ color: "var(--pop-2-text)" }}
        />
        <span className="ttl">ACTIVE ALERTS</span>
        <span
          className="mono"
          style={{ fontSize: 10.5, color: "var(--ink-3)" }}
        >
          · {alerts.length} live
        </span>
      </div>
      <div>
        {alerts.map((a, i) => {
          const I = ALERT_ICON[a.iconKey] ?? Bell;
          return (
            <div
              key={a.id}
              style={{
                padding: "12px 16px",
                display: "flex",
                alignItems: "center",
                gap: 12,
                borderBottom:
                  i === alerts.length - 1 ? 0 : "1px dashed var(--rule-soft)",
              }}
            >
              <I className="h-3.5 w-3.5 flex-shrink-0" />
              <div style={{ flex: 1, minWidth: 0 }}>
                <div
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 6,
                    marginBottom: 2,
                  }}
                >
                  {a.symbol && (
                    <span
                      className="mono"
                      style={{
                        fontSize: 11,
                        fontWeight: 700,
                        color: "var(--emerald-text)",
                      }}
                    >
                      {a.symbol}
                    </span>
                  )}
                  <span
                    className="mono"
                    style={{ fontSize: 10.5, color: "var(--ink-3)" }}
                  >
                    {a.when}
                  </span>
                </div>
                <div style={{ fontSize: 13, color: "var(--ink-2)" }}>
                  {a.text}
                </div>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function NotificationsList({
  notifications,
}: {
  notifications: NotificationSummary[];
}) {
  if (notifications.length === 0) {
    return (
      <div className="pf-card" style={{ padding: 40, textAlign: "center" }}>
        <Bell
          className="h-6 w-6 mx-auto mb-2.5"
          style={{ color: "var(--emerald)" }}
        />
        <div
          style={{
            fontSize: 16,
            fontWeight: 800,
            color: "var(--ink)",
            marginBottom: 6,
          }}
        >
          You&rsquo;re all caught up
        </div>
        <div
          style={{
            fontSize: 13,
            color: "var(--ink-3)",
            maxWidth: 420,
            margin: "0 auto",
          }}
        >
          Roast, research and learning completions land here. Head to
          /notifications for the full history.
        </div>
      </div>
    );
  }
  return (
    <div className="pf-card" style={{ padding: 0, overflow: "hidden" }}>
      <div
        style={{
          padding: "12px 16px",
          borderBottom: "1.5px dashed var(--rule-soft)",
          display: "flex",
          alignItems: "center",
          gap: 8,
        }}
      >
        <Bell
          className="h-3.5 w-3.5"
          style={{ color: "var(--emerald-text)" }}
        />
        <span className="ttl">RECENT NOTIFICATIONS</span>
        <div style={{ flex: 1 }} />
        <Link
          href="/notifications"
          className="mono"
          style={{ fontSize: 10.5, color: "var(--ink-3)" }}
        >
          All ›
        </Link>
      </div>
      <div>
        {notifications.map((n, i) => {
          const I = NOTIF_ICON[n.iconKey] ?? Bell;
          return (
            <div
              key={n.id}
              style={{
                padding: "12px 16px",
                display: "flex",
                alignItems: "center",
                gap: 12,
                borderBottom:
                  i === notifications.length - 1
                    ? 0
                    : "1px dashed var(--rule-soft)",
              }}
            >
              <I className="h-3.5 w-3.5 flex-shrink-0" />
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 13, color: "var(--ink-2)" }}>
                  {n.text}
                </div>
                <div
                  className="mono"
                  style={{
                    fontSize: 10.5,
                    color: "var(--ink-3)",
                    marginTop: 2,
                  }}
                >
                  {n.when}
                </div>
              </div>
              {n.unread && (
                <span
                  style={{
                    width: 6,
                    height: 6,
                    borderRadius: "50%",
                    background: "var(--emerald)",
                    flexShrink: 0,
                  }}
                  aria-hidden
                />
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

function FeedsSidePanel({
  alerts,
  notifications,
  onNewAlert,
}: {
  alerts: AlertSummary[];
  notifications: NotificationSummary[];
  onNewAlert: () => void;
}) {
  const unread = notifications.filter((n) => n.unread).length;
  return (
    <aside style={{ display: "flex", flexDirection: "column", gap: 14 }}>
      <div className="pf-card">
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 8,
            marginBottom: 12,
          }}
        >
          <BellRing
            className="h-3.5 w-3.5"
            style={{ color: "var(--pop-2-text)" }}
          />
          <span className="ttl">YOUR ALERTS</span>
          {alerts.length > 0 && (
            <span
              className="pf-pill gold"
              style={{ fontSize: 9.5, padding: "1px 7px" }}
            >
              {alerts.length}
            </span>
          )}
          <a
            href="/notifications"
            className="mono"
            style={{
              marginLeft: "auto",
              fontSize: 10.5,
              color: "var(--ink-3)",
            }}
          >
            All ›
          </a>
        </div>
        {alerts.length === 0 ? (
          <div style={{ fontSize: 12, color: "var(--ink-3)" }}>
            No alerts firing right now.
          </div>
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            {alerts.slice(0, 4).map((a) => {
              const I = ALERT_ICON[a.iconKey] ?? Bell;
              return (
                <div
                  key={a.id}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 10,
                    fontSize: 12,
                  }}
                >
                  <I className="h-3.5 w-3.5 flex-shrink-0" />
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div
                      style={{
                        color: "var(--ink-2)",
                        overflow: "hidden",
                        textOverflow: "ellipsis",
                        whiteSpace: "nowrap",
                      }}
                    >
                      {a.text}
                    </div>
                    <div
                      className="mono"
                      style={{ fontSize: 10.5, color: "var(--ink-3)" }}
                    >
                      {a.when}
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        )}
        <button
          onClick={onNewAlert}
          className="pf-bf sm"
          style={{ marginTop: 12, width: "100%", justifyContent: "center" }}
        >
          <BellPlus className="h-3 w-3" /> New alert
        </button>
      </div>

      <div className="pf-card">
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 8,
            marginBottom: 12,
          }}
        >
          <Bell
            className="h-3.5 w-3.5"
            style={{ color: "var(--emerald-text)" }}
          />
          <span className="ttl">NOTIFICATIONS</span>
          {unread > 0 && (
            <span
              className="pf-pill emerald"
              style={{ fontSize: 9.5, padding: "1px 7px" }}
            >
              {unread} unread
            </span>
          )}
          <a
            href="/notifications"
            className="mono"
            style={{
              marginLeft: "auto",
              fontSize: 10.5,
              color: "var(--ink-3)",
            }}
          >
            All ›
          </a>
        </div>
        {notifications.length === 0 ? (
          <div style={{ fontSize: 12, color: "var(--ink-3)" }}>
            You&rsquo;re all caught up.
          </div>
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            {notifications.slice(0, 4).map((n) => {
              const I = NOTIF_ICON[n.iconKey] ?? Bell;
              return (
                <div
                  key={n.id}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 10,
                    fontSize: 12,
                  }}
                >
                  <I className="h-3.5 w-3.5 flex-shrink-0" />
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div
                      style={{
                        color: "var(--ink-2)",
                        overflow: "hidden",
                        textOverflow: "ellipsis",
                        whiteSpace: "nowrap",
                      }}
                    >
                      {n.text}
                    </div>
                    <div
                      className="mono"
                      style={{ fontSize: 10.5, color: "var(--ink-3)" }}
                    >
                      {n.when}
                    </div>
                  </div>
                  {n.unread && (
                    <span
                      style={{
                        width: 6,
                        height: 6,
                        borderRadius: "50%",
                        background: "var(--emerald)",
                        flexShrink: 0,
                      }}
                      aria-hidden
                    />
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>
    </aside>
  );
}
