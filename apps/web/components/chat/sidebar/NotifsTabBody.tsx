"use client";

/**
 * Notifications tab body — playful redesign (MONEY-483).
 *
 * Fresh/unread row: emerald-bg fill + dashed emerald border + tilted
 * pop-colour icon tile — matching chat-sidebar.jsx NotifRow(fresh).
 * Read rows: minimal transparent treatment.
 * Empty state: coin-slot EmptyState with "You're all caught up" copy.
 */

import { useEffect, useState } from "react";
import Link from "next/link";
import {
  BellRing,
  FileText,
  Flame,
  Sparkles,
  Bell,
  Loader2,
  ArrowRight,
} from "lucide-react";
import { getNotificationsAction } from "@/lib/actions/notifications";

interface NotificationItem {
  id: string;
  type: string;
  title: string;
  message?: string | null;
  isRead: boolean;
  metadata?: Record<string, unknown> | null;
  createdAt: Date;
}

const TYPE_ICON: Record<string, React.ComponentType<{ className?: string }>> = {
  PRICE_ALERT: BellRing,
  VOLUME_ALERT: BellRing,
  NEWS_ALERT: FileText,
  EARNINGS_REMINDER: FileText,
  ROAST_COMPLETE: Flame,
  RESEARCH_COMPLETE: Sparkles,
};

/** Pop colour per notification type for the icon tile background */
const TYPE_POP: Record<string, string> = {
  RESEARCH_COMPLETE: "var(--emerald)",
  ROAST_COMPLETE: "var(--pop-1)",
  PRICE_ALERT: "var(--pop-1)",
  VOLUME_ALERT: "var(--pop-3)",
  NEWS_ALERT: "var(--pop-3)",
  EARNINGS_REMINDER: "var(--pop-2)",
};

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

export default function NotifsTabBody() {
  const [items, setItems] = useState<NotificationItem[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    getNotificationsAction(8, 0).then((r) => {
      if (cancelled) return;
      if (r?.success && r.data) setItems(r.data as NotificationItem[]);
      setLoading(false);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  const unread = items.filter((i) => !i.isRead).length;

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
          Notifications
        </span>
        {unread > 0 && (
          <span
            className="pf-pill emerald"
            style={{ fontSize: 9.5, padding: "2px 7px" }}
          >
            {unread} new
          </span>
        )}
      </div>

      {loading ? (
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 8,
            padding: "24px 0",
            color: "var(--ink-3)",
            fontSize: 12,
          }}
        >
          <Loader2 className="h-3 w-3 animate-spin" /> Loading…
        </div>
      ) : items.length === 0 ? (
        <div
          style={{
            padding: "24px 8px",
            textAlign: "center",
            color: "var(--ink-3)",
          }}
        >
          <Bell
            className="h-8 w-8 mx-auto mb-3"
            style={{ color: "var(--ink-4)" }}
          />
          <p className="ser" style={{ fontSize: 13, color: "var(--ink-3)" }}>
            You&rsquo;re all caught up.
          </p>
        </div>
      ) : (
        <>
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            {items.slice(0, 6).map((n) => {
              const Icon = TYPE_ICON[n.type] ?? Bell;
              const pop = TYPE_POP[n.type] ?? "var(--ink-3)";
              const md = (n.metadata ?? {}) as Record<string, unknown>;
              const href =
                (md.deepLink as string | undefined) ??
                (md.symbol ? `/stock/${md.symbol}` : "/notifications");
              const fresh = !n.isRead;

              return (
                <Link
                  key={n.id}
                  href={href}
                  style={{
                    display: "flex",
                    alignItems: "flex-start",
                    gap: 9,
                    padding: "9px 8px",
                    borderRadius: 8,
                    background: fresh ? "var(--emerald-bg)" : "transparent",
                    border: fresh
                      ? "1.25px dashed var(--emerald)"
                      : "1.25px solid transparent",
                    textDecoration: "none",
                    transition: "background 0.12s",
                  }}
                  onMouseEnter={(e) => {
                    if (!fresh)
                      e.currentTarget.style.background = "var(--rule-softer)";
                  }}
                  onMouseLeave={(e) => {
                    if (!fresh)
                      e.currentTarget.style.background = "transparent";
                  }}
                >
                  {/* Icon tile — tilted, pop-coloured for fresh; muted for read */}
                  <div
                    style={{
                      width: 26,
                      height: 26,
                      borderRadius: 7,
                      background: fresh ? pop : "var(--paper-2)",
                      border: "1.25px solid var(--ink)",
                      display: "grid",
                      placeItems: "center",
                      transform: "rotate(-3deg)",
                      flexShrink: 0,
                      color: fresh ? "var(--paper)" : "var(--ink-3)",
                    }}
                  >
                    <Icon className="h-3 w-3" />
                  </div>

                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div
                      style={{
                        fontSize: 12.5,
                        fontWeight: fresh ? 700 : 500,
                        color: fresh ? "var(--ink)" : "var(--ink-2)",
                        lineHeight: 1.2,
                        overflow: "hidden",
                        textOverflow: "ellipsis",
                        whiteSpace: "nowrap",
                      }}
                    >
                      {n.title}
                    </div>
                    {n.message && (
                      <div
                        style={{
                          fontSize: 11.5,
                          color: "var(--ink-3)",
                          marginTop: 2,
                          lineHeight: 1.3,
                          overflow: "hidden",
                          textOverflow: "ellipsis",
                          whiteSpace: "nowrap",
                        }}
                      >
                        {n.message}
                      </div>
                    )}
                    <div
                      className="mono"
                      style={{
                        fontSize: 9.5,
                        color: "var(--ink-4)",
                        marginTop: 4,
                        letterSpacing: 0.5,
                        textTransform: "uppercase",
                      }}
                    >
                      {relTime(n.createdAt)}
                    </div>
                  </div>
                </Link>
              );
            })}
          </div>

          <div style={{ padding: "10px 4px 0" }}>
            <Link
              href="/notifications"
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
              View all <ArrowRight className="h-3 w-3" />
            </Link>
          </div>
        </>
      )}
    </div>
  );
}
