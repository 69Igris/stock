"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import { useRouter } from "next/navigation";
import {
  Search,
  RefreshCw,
  FileSpreadsheet,
  Link2,
  FileText,
  CheckCheck,
  Loader2,
  Flame,
  BarChart3,
  AlertTriangle,
  Sparkles,
  Trash2,
  Bell,
  ArrowRight,
  Info,
  TrendingUp,
  Newspaper,
  Calendar,
  Scissors,
  type LucideIcon,
} from "lucide-react";
import {
  getNotificationsAction,
  markAsReadAction,
  markAllAsReadAction,
  clearAllReadAction,
} from "@/lib/actions/notifications";
import type { NotificationItem } from "@/lib/actions/notifications";
import type { NotificationType } from "@prisma/client";
import { EmptyState } from "@/components/empty/EmptyState";

const PAGE_SIZE = 8;

// ── Pop-colour + icon mapping per notification type ───────────────────────────
//
// Mapping philosophy:
//   Research / AI tasks   → emerald  (productive, positive completion)
//   Trade / market events → coral    (pop-1, action-oriented)
//   Import / pairing data → gold     (pop-2, informational data ops)
//   Document / file ready → blue     (pop-3, reference material)
//   Roast / analysis      → pink     (pop-4, analytical fun)
//   System / generic      → violet   (pop-5, neutral admin)
//   Price/volume alerts   → coral    (pop-1, urgent market signal)
//   News / earnings       → blue     (pop-3, informational)
//   Corporate actions     → gold     (pop-2, structured event)
//   Scan events           → emerald  (pop-0, screener success) / coral (failure)
//   Login briefing        → gold     (pop-2, daily greeting)
//
const typeConfig: Record<
  NotificationType,
  {
    icon: LucideIcon;
    pop: string; // background CSS var for the tile
    iconStroke: string; // icon colour (always #f7f3e6 for coloured tiles)
  }
> = {
  RESEARCH_COMPLETE: {
    icon: Sparkles,
    pop: "var(--emerald)",
    iconStroke: "#f7f3e6",
  },
  SYNC_COMPLETE: {
    icon: RefreshCw,
    pop: "var(--emerald)",
    iconStroke: "#f7f3e6",
  },
  IMPORT_COMPLETE: {
    icon: FileSpreadsheet,
    pop: "var(--pop-2)",
    iconStroke: "#1d1d1b",
  },
  PAIRING_COMPLETE: { icon: Link2, pop: "var(--pop-2)", iconStroke: "#1d1d1b" },
  DOCUMENT_READY: {
    icon: FileText,
    pop: "var(--pop-3)",
    iconStroke: "#f7f3e6",
  },
  ROAST_COMPLETE: { icon: Flame, pop: "var(--pop-4)", iconStroke: "#f7f3e6" },
  ANALYSIS_COMPLETE: {
    icon: BarChart3,
    pop: "var(--pop-4)",
    iconStroke: "#f7f3e6",
  },
  ANALYSIS_FAILED: {
    icon: AlertTriangle,
    pop: "var(--pop-1)",
    iconStroke: "#f7f3e6",
  },
  SCAN_COMPLETED: {
    icon: Search,
    pop: "var(--emerald)",
    iconStroke: "#f7f3e6",
  },
  SCAN_FAILED: {
    icon: AlertTriangle,
    pop: "var(--pop-1)",
    iconStroke: "#f7f3e6",
  },
  LOGIN_BRIEFING: {
    icon: Sparkles,
    pop: "var(--pop-2)",
    iconStroke: "#1d1d1b",
  },
  SYSTEM: { icon: Info, pop: "var(--pop-5)", iconStroke: "#f7f3e6" },
  // MONEY-408 alert-driven types
  PRICE_ALERT: { icon: TrendingUp, pop: "var(--pop-1)", iconStroke: "#f7f3e6" },
  VOLUME_ALERT: { icon: BarChart3, pop: "var(--pop-1)", iconStroke: "#f7f3e6" },
  NEWS_ALERT: { icon: Newspaper, pop: "var(--pop-3)", iconStroke: "#f7f3e6" },
  EARNINGS_REMINDER: {
    icon: Calendar,
    pop: "var(--pop-3)",
    iconStroke: "#f7f3e6",
  },
  CORPORATE_ACTION: {
    icon: Scissors,
    pop: "var(--pop-2)",
    iconStroke: "#1d1d1b",
  },
};

// ── Relative timestamp ────────────────────────────────────────────────────────
function formatRelativeTime(date: Date): string {
  const now = new Date();
  const diff = now.getTime() - new Date(date).getTime();
  const minutes = Math.floor(diff / 60_000);
  if (minutes < 1) return "NOW";
  if (minutes < 60) return `${minutes}M AGO`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}H AGO`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}D AGO`;
  return new Date(date)
    .toLocaleDateString("en-IN", { day: "2-digit", month: "short" })
    .toUpperCase();
}

// ── Single notification row ───────────────────────────────────────────────────
function NotifRow({
  notification,
  onMarkRead,
  onClick,
}: {
  notification: NotificationItem;
  onMarkRead: (id: string) => void;
  onClick: (n: NotificationItem) => void;
}) {
  const cfg =
    typeConfig[notification.type as NotificationType] ?? typeConfig.SYSTEM;
  const Icon = cfg.icon;
  const fresh = !notification.isRead;

  return (
    <div
      role="button"
      tabIndex={0}
      onClick={() => onClick(notification)}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onClick(notification);
        }
      }}
      style={{
        display: "flex",
        alignItems: "flex-start",
        gap: 10,
        width: "100%",
        textAlign: "left",
        padding: "9px 8px",
        borderRadius: 8,
        background: fresh ? "var(--emerald-bg)" : "transparent",
        border: fresh
          ? "1.25px dashed var(--emerald)"
          : "1.25px solid transparent",
        cursor: "pointer",
        transition: "background 0.12s",
        fontFamily: "inherit",
      }}
      onMouseEnter={(e) => {
        if (!fresh)
          (e.currentTarget as HTMLDivElement).style.background =
            "var(--rule-softer)";
      }}
      onMouseLeave={(e) => {
        if (!fresh)
          (e.currentTarget as HTMLDivElement).style.background = "transparent";
      }}
    >
      {/* Pop-coloured icon tile — rotated sticker feel from the design */}
      <div
        style={{
          width: 28,
          height: 28,
          borderRadius: 7,
          background: cfg.pop,
          border: "1.25px solid var(--ink)",
          display: "grid",
          placeItems: "center",
          transform: "rotate(-3deg)",
          flexShrink: 0,
          color: cfg.iconStroke,
        }}
      >
        <Icon size={13} strokeWidth={2.25} />
      </div>

      {/* Text body */}
      <div style={{ flex: 1, minWidth: 0 }}>
        <div
          style={{
            fontSize: 12.5,
            fontWeight: fresh ? 700 : 500,
            color: "var(--ink)",
            lineHeight: 1.2,
            whiteSpace: "nowrap",
            overflow: "hidden",
            textOverflow: "ellipsis",
          }}
        >
          {notification.title}
        </div>
        <div
          style={{
            fontSize: 11.5,
            color: "var(--ink-3)",
            marginTop: 2,
            lineHeight: 1.3,
            display: "-webkit-box",
            WebkitLineClamp: 2,
            WebkitBoxOrient: "vertical",
            overflow: "hidden",
          }}
        >
          {notification.message}
        </div>
        <div
          className="mono"
          style={{
            fontSize: 9.5,
            color: "var(--ink-4)",
            marginTop: 4,
            letterSpacing: 0.5,
          }}
        >
          {formatRelativeTime(notification.createdAt)}
        </div>
      </div>

      {/* Mark-as-read button (only shown when fresh) */}
      {fresh && (
        <button
          type="button"
          aria-label="Mark as read"
          onClick={(e) => {
            e.stopPropagation();
            onMarkRead(notification.id);
          }}
          style={{
            flexShrink: 0,
            width: 22,
            height: 22,
            borderRadius: 5,
            border: "1.25px solid var(--rule-soft)",
            background: "transparent",
            color: "var(--ink-3)",
            display: "grid",
            placeItems: "center",
            cursor: "pointer",
            marginTop: 1,
          }}
        >
          <CheckCheck size={11} strokeWidth={2.25} />
        </button>
      )}
    </div>
  );
}

// ── Main dropdown ─────────────────────────────────────────────────────────────
export function NotificationDropdown({
  onClose,
  onCountChange,
}: {
  onClose: () => void;
  onCountChange: (count: number) => void;
}) {
  const router = useRouter();
  const [notifications, setNotifications] = useState<NotificationItem[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [isLoadingMore, setIsLoadingMore] = useState(false);
  const [hasMore, setHasMore] = useState(true);
  const scrollRef = useRef<HTMLDivElement>(null);

  const fetchNotifications = useCallback(async () => {
    setIsLoading(true);
    const result = await getNotificationsAction(PAGE_SIZE, 0);
    if (result?.success && result?.data) {
      setNotifications(result.data);
      setHasMore(result.data.length >= PAGE_SIZE);
      onCountChange(result.data.filter((n) => !n.isRead).length);
    }
    setIsLoading(false);
  }, [onCountChange]);

  const loadMore = useCallback(async () => {
    if (isLoadingMore || !hasMore) return;
    setIsLoadingMore(true);
    const result = await getNotificationsAction(
      PAGE_SIZE,
      notifications.length
    );
    if (result?.success && result?.data) {
      if (result.data.length === 0) {
        setHasMore(false);
      } else {
        setNotifications((prev) => [...prev, ...result.data!]);
        setHasMore(result.data.length >= PAGE_SIZE);
      }
    }
    setIsLoadingMore(false);
  }, [isLoadingMore, hasMore, notifications.length]);

  useEffect(() => {
    fetchNotifications();
  }, [fetchNotifications]);

  // Infinite scroll
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const handleScroll = () => {
      const { scrollTop, scrollHeight, clientHeight } = el;
      if (scrollHeight - scrollTop - clientHeight < 80) loadMore();
    };
    el.addEventListener("scroll", handleScroll);
    return () => el.removeEventListener("scroll", handleScroll);
  }, [loadMore]);

  const handleMarkAsRead = async (id: string) => {
    await markAsReadAction(id);
    setNotifications((prev) =>
      prev.map((n) => (n.id === id ? { ...n, isRead: true } : n))
    );
    onCountChange(notifications.filter((n) => !n.isRead && n.id !== id).length);
  };

  const handleMarkAllAsRead = async () => {
    await markAllAsReadAction();
    setNotifications((prev) => prev.map((n) => ({ ...n, isRead: true })));
    onCountChange(0);
  };

  const handleClearAll = async () => {
    await clearAllReadAction();
    setNotifications((prev) => prev.filter((n) => !n.isRead));
    onCountChange(notifications.filter((n) => !n.isRead).length);
  };

  const handleClick = (notification: NotificationItem) => {
    if (!notification.isRead) handleMarkAsRead(notification.id);
    const metadata = notification.metadata;
    if (metadata?.link && typeof metadata.link === "string") {
      onClose();
      router.push(metadata.link);
    }
  };

  const unreadCount = notifications.filter((n) => !n.isRead).length;

  return (
    // pf-card gives the ink border + border-radius.
    // The tilt + hard ink shadow mirror the design bundle's NotifDropdown.
    <div
      className="pf-card"
      style={{
        padding: 0,
        overflow: "hidden",
        boxShadow: "5px 5px 0 var(--ink)",
        // Make sure the card itself has a solid background so it occludes
        // the page content behind it on both light and dark themes.
        background: "var(--paper)",
      }}
    >
      {/* ── Header ── dashed bottom border, paper-2 tint */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          padding: "12px 16px",
          borderBottom: "1.5px dashed var(--rule-soft)",
          background: "var(--paper-2)",
          gap: 10,
        }}
      >
        {/* Title + unread pill */}
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <Bell
            size={14}
            strokeWidth={2.25}
            style={{ color: "var(--ink)", flexShrink: 0 }}
          />
          <span
            style={{
              fontSize: 14,
              fontWeight: 800,
              color: "var(--ink)",
              letterSpacing: -0.3,
            }}
          >
            Notifications
          </span>
          {unreadCount > 0 && (
            <span
              className="pf-pill emerald"
              style={{ fontSize: 9.5, padding: "2px 7px" }}
            >
              {unreadCount} new
            </span>
          )}
        </div>

        {/* Action buttons — Mark all read / Clear all */}
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          {unreadCount > 0 && (
            <button
              type="button"
              onClick={handleMarkAllAsRead}
              style={{
                background: "transparent",
                border: 0,
                color: "var(--ink-3)",
                fontSize: 11.5,
                fontWeight: 600,
                fontFamily: "inherit",
                cursor: "pointer",
                textDecoration: "underline",
                textUnderlineOffset: 2,
                padding: 0,
                display: "flex",
                alignItems: "center",
                gap: 4,
              }}
            >
              <CheckCheck size={11} strokeWidth={2.25} />
              All read
            </button>
          )}
          {notifications.length > 0 && unreadCount === 0 && (
            <button
              type="button"
              onClick={handleClearAll}
              style={{
                background: "transparent",
                border: 0,
                color: "var(--ink-3)",
                fontSize: 11.5,
                fontWeight: 600,
                fontFamily: "inherit",
                cursor: "pointer",
                textDecoration: "underline",
                textUnderlineOffset: 2,
                padding: 0,
                display: "flex",
                alignItems: "center",
                gap: 4,
              }}
            >
              <Trash2 size={11} strokeWidth={2.25} />
              Clear all
            </button>
          )}
        </div>
      </div>

      {/* ── Body — scrollable list ── */}
      <div
        ref={scrollRef}
        className="pf-noscrollbar"
        style={{
          maxHeight: 340,
          overflowY: "auto",
          padding: isLoading || notifications.length === 0 ? 0 : 8,
        }}
      >
        {isLoading ? (
          <div
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              padding: "32px 0",
            }}
          >
            <Loader2
              size={20}
              strokeWidth={2}
              className="animate-spin"
              style={{ color: "var(--ink-3)" }}
            />
          </div>
        ) : notifications.length === 0 ? (
          <div style={{ padding: "24px 16px" }}>
            <EmptyState
              icon={Bell}
              title="All quiet here"
              description="You'll see research completions, price alerts, and import updates as they arrive."
              color="var(--pop-5)"
              card={false}
            />
          </div>
        ) : (
          <>
            {/* Notification rows separated by dashed dividers */}
            {notifications.map((notification, i) => (
              <div key={notification.id}>
                {i > 0 && (
                  <div
                    style={{
                      height: 0,
                      borderTop: "1px dashed var(--rule-soft)",
                      margin: "2px 4px",
                    }}
                  />
                )}
                <NotifRow
                  notification={notification}
                  onMarkRead={handleMarkAsRead}
                  onClick={handleClick}
                />
              </div>
            ))}

            {/* Load-more spinner */}
            {isLoadingMore && (
              <div
                style={{
                  display: "flex",
                  justifyContent: "center",
                  padding: "8px 0",
                }}
              >
                <Loader2
                  size={14}
                  strokeWidth={2}
                  className="animate-spin"
                  style={{ color: "var(--ink-4)" }}
                />
              </div>
            )}

            {/* End-of-list caption */}
            {!hasMore && notifications.length > PAGE_SIZE && (
              <div
                className="mono"
                style={{
                  textAlign: "center",
                  padding: "8px 0",
                  fontSize: 9.5,
                  color: "var(--ink-4)",
                  letterSpacing: 1,
                }}
              >
                ALL CAUGHT UP
              </div>
            )}
          </>
        )}
      </div>

      {/* ── Footer — "View all notifications" link ── */}
      {!isLoading && notifications.length > 0 && (
        <div
          style={{
            padding: "10px 16px",
            borderTop: "1.5px dashed var(--rule-soft)",
            background: "var(--paper-2)",
            textAlign: "center",
          }}
        >
          <button
            type="button"
            onClick={() => {
              onClose();
              router.push("/notifications");
            }}
            style={{
              background: "transparent",
              border: 0,
              fontFamily: "inherit",
              fontSize: 12,
              fontWeight: 700,
              color: "var(--ink)",
              cursor: "pointer",
              display: "inline-flex",
              alignItems: "center",
              gap: 6,
            }}
          >
            View all notifications
            <ArrowRight size={11} strokeWidth={2.25} />
          </button>
        </div>
      )}
    </div>
  );
}
