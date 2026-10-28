"use client";

/**
 * Notifications — playful (MONEY-485) full-feed view.
 *
 * Built entirely on the playful design system (playful-app.css): a
 * `pf-ph` page head, `pf-pill` filter chips (All / Unread / Mentions /
 * Alerts / System), and a `pf-card` list of rows. Each row renders:
 *   - a rotated, colored square icon tile per notification type
 *     (emerald / coral / gold / blue family)
 *   - an emerald unread accent (left bar + dot)
 *   - title · mono relative timestamp on the same row
 *   - message line below
 *   - an arrow-up-right deep-link affordance
 *
 * Wired 1:1 to the existing server actions: getNotificationsAction (page),
 * markAsReadAction (single, on row open), markAllAsReadAction (bulk),
 * and clearAllReadAction (bulk delete of read items).
 */

import { useMemo, useState, useTransition } from "react";
import Link from "next/link";
import {
  ArrowUpRight,
  Bell,
  BellRing,
  CheckCheck,
  Trash2,
  Loader2,
  FileText,
  Flame,
  Sparkles,
  AtSign,
  CreditCard,
  Link2,
  Calendar,
  AlertTriangle,
  BarChart3,
  Info,
  type LucideIcon,
} from "lucide-react";
import {
  markAsReadAction,
  markAllAsReadAction,
  clearAllReadAction,
  type NotificationItem,
} from "@/lib/actions/notifications";
import { toast } from "sonner";

type Filter = "all" | "unread" | "mentions" | "alerts" | "system";

const FILTERS: { id: Filter; label: string }[] = [
  { id: "all", label: "All" },
  { id: "unread", label: "Unread" },
  { id: "mentions", label: "Mentions" },
  { id: "alerts", label: "Alerts" },
  { id: "system", label: "System" },
];

// Playful tile palette — the four "pop" tiles the design uses for
// rotated icon squares. Backed by playful-app.css CSS vars so both
// themes stay in sync; foreground always reads on the filled tile.
type Tone = "emerald" | "coral" | "gold" | "blue";
const TONE_STYLE: Record<Tone, { bg: string; fg: string }> = {
  emerald: { bg: "var(--emerald)", fg: "var(--paper)" },
  coral: { bg: "var(--pop-1)", fg: "#f7f3e6" },
  gold: { bg: "var(--pop-2)", fg: "#1d1d1b" },
  blue: { bg: "var(--pop-3)", fg: "#f7f3e6" },
};

// Per-type icon + tile tone. Collapsed onto the four-color playful
// palette: alerts/imports → gold, news/sync/docs → blue, failures →
// coral, research/mentions/positive → emerald.
const TYPE_VISUAL: Record<string, { Icon: LucideIcon; tone: Tone }> = {
  PRICE_ALERT: { Icon: BellRing, tone: "gold" },
  VOLUME_ALERT: { Icon: BarChart3, tone: "gold" },
  NEWS_ALERT: { Icon: FileText, tone: "blue" },
  EARNINGS_REMINDER: { Icon: Calendar, tone: "emerald" },
  CORPORATE_ACTION: { Icon: Info, tone: "blue" },
  ROAST_COMPLETE: { Icon: Flame, tone: "coral" },
  RESEARCH_COMPLETE: { Icon: Sparkles, tone: "emerald" },
  ANALYSIS_COMPLETE: { Icon: BarChart3, tone: "emerald" },
  ANALYSIS_FAILED: { Icon: AlertTriangle, tone: "coral" },
  SCAN_COMPLETED: { Icon: Sparkles, tone: "emerald" },
  SCAN_FAILED: { Icon: AlertTriangle, tone: "coral" },
  LOGIN_BRIEFING: { Icon: Sparkles, tone: "blue" },
  SYNC_COMPLETE: { Icon: Link2, tone: "blue" },
  IMPORT_COMPLETE: { Icon: FileText, tone: "gold" },
  PAIRING_COMPLETE: { Icon: Link2, tone: "blue" },
  DOCUMENT_READY: { Icon: FileText, tone: "blue" },
  MENTION: { Icon: AtSign, tone: "emerald" },
  STRATEGY_FORK: { Icon: AtSign, tone: "emerald" },
  SUBSCRIPTION_RENEWED: { Icon: CreditCard, tone: "gold" },
  BROKER_REAUTH: { Icon: Link2, tone: "coral" },
  SYSTEM: { Icon: Bell, tone: "blue" },
};

function visualFor(
  type: string,
  alertKind?: string | null
): { Icon: LucideIcon; tone: Tone } {
  // A data-engine alert arrives typed SYSTEM; drawing it with the generic
  // system bell is the same misfiling the Alerts filter used to do.
  if (alertKind && (type === "SYSTEM" || !TYPE_VISUAL[type])) {
    return { Icon: BellRing, tone: "gold" };
  }
  return TYPE_VISUAL[type] ?? { Icon: Bell, tone: "blue" };
}

function relativeTime(d: Date | string): string {
  const t = typeof d === "string" ? new Date(d).getTime() : d.getTime();
  const m = Math.floor((Date.now() - t) / 60_000);
  if (m < 1) return "just now";
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

const MENTION_TYPES = new Set(["MENTION", "STRATEGY_FORK"]);

// ── Alert classification (MONEY-1204) ──────────────────────────────
//
// CANONICAL. `apps/web/app/discover/news/page.tsx` mirrors this block and is
// pinned to it by `__tests__/notifications/alert-classification.test.ts`. It
// cannot simply import it: that page is a SERVER component, and Next's flight
// loader rewrites every export of a `"use client"` module into a stub that
// throws `Attempted to call ALERT_NOTIFICATION_TYPES() from the server`
// (next/dist/build/webpack/loaders/next-flight-loader/index.js:119-128). The
// real home is a directive-free module both layers can import — see the note
// on the mirror.

/**
 * The notification types that are alerts by TYPE ALONE.
 *
 * Kept as a plain array (not just a Set) because the drift test compares it
 * against the mirror's source literal.
 */
export const ALERT_NOTIFICATION_TYPES = [
  "PRICE_ALERT",
  "VOLUME_ALERT",
  "NEWS_ALERT",
  "EARNINGS_REMINDER",
  "CORPORATE_ACTION",
] as const;

const ALERT_TYPES = new Set<string>(ALERT_NOTIFICATION_TYPES);

/** The only two fields either surface needs in order to classify a row. */
export interface ClassifiableNotification {
  type: string;
  metadata?: Record<string, unknown> | null;
}

/**
 * `metadata.alertKind`, or null.
 *
 * The alert evaluator files all six MONEY-1204 data-engine kinds under
 * NotificationType `SYSTEM` — correctly, since the Prisma enum has no members
 * for them — and carries the precise kind in `metadata.alertKind` (see
 * `DATA_ENGINE_NOTIFICATION_TYPE` and the createNotification call beside it in
 * workers/src/processors/alert-evaluator.ts). Until this function existed that
 * field had ZERO readers, so a fired FLAG_TRANSITION landed next to
 * broker-reauth housekeeping and never appeared under Alerts.
 */
export function alertKindOf(metadata: unknown): string | null {
  if (!metadata || typeof metadata !== "object") return null;
  const v = (metadata as Record<string, unknown>).alertKind;
  return typeof v === "string" && v.trim() ? v.trim() : null;
}

/**
 * Is this notification a fired ALERT?
 *
 * Discriminates on `metadata.alertKind` as well as `type`, so a SYSTEM row
 * written by the alert evaluator counts while a SYSTEM row written by a broker
 * reauth or a dead-letter does not. Adding `SYSTEM` to the type list would
 * have dragged every one of those into the Alerts tab.
 */
export function isAlertNotification(n: ClassifiableNotification): boolean {
  if (ALERT_TYPES.has(n.type)) return true;
  return alertKindOf(n.metadata) !== null;
}

const SYSTEM_TYPES = new Set([
  "SYNC_COMPLETE",
  "IMPORT_COMPLETE",
  "PAIRING_COMPLETE",
  "DOCUMENT_READY",
  "BROKER_REAUTH",
  "SUBSCRIPTION_RENEWED",
  "SYSTEM",
]);

/**
 * System = housekeeping. A fired alert that happens to be typed SYSTEM belongs
 * under Alerts and ONLY under Alerts — otherwise it is filed in both places and
 * the System tally double-counts it.
 */
export function isSystemNotification(n: ClassifiableNotification): boolean {
  return SYSTEM_TYPES.has(n.type) && !isAlertNotification(n);
}

interface Props {
  initial: NotificationItem[];
}

export default function NotificationsClient({ initial }: Props) {
  const [items, setItems] = useState<NotificationItem[]>(initial);
  const [filter, setFilter] = useState<Filter>("all");
  const [pending, startTransition] = useTransition();

  const unreadCount = items.filter((n) => !n.isRead).length;
  const readCount = items.filter((n) => n.isRead).length;

  const filtered = useMemo(() => {
    if (filter === "all") return items;
    if (filter === "unread") return items.filter((n) => !n.isRead);
    if (filter === "mentions")
      return items.filter((n) => MENTION_TYPES.has(n.type));
    if (filter === "alerts") return items.filter(isAlertNotification);
    if (filter === "system") return items.filter(isSystemNotification);
    return items;
  }, [items, filter]);

  const countFor = (id: Filter): number => {
    if (id === "all") return items.length;
    if (id === "unread") return unreadCount;
    if (id === "mentions")
      return items.filter((n) => MENTION_TYPES.has(n.type)).length;
    if (id === "alerts") return items.filter(isAlertNotification).length;
    return items.filter(isSystemNotification).length;
  };

  const handleMarkAllRead = () => {
    if (unreadCount === 0) return;
    setItems((prev) => prev.map((n) => ({ ...n, isRead: true })));
    startTransition(async () => {
      const result = await markAllAsReadAction();
      if (!result?.success) {
        toast.error(result?.error || "Failed to mark all as read");
      }
    });
  };

  const handleClearAll = () => {
    if (readCount === 0) return;
    setItems((prev) => prev.filter((n) => !n.isRead));
    startTransition(async () => {
      const result = await clearAllReadAction();
      if (!result?.success) {
        toast.error(result?.error || "Failed to clear notifications");
      } else {
        toast.success(`Cleared ${result.data ?? readCount} notifications`);
      }
    });
  };

  const handleOpen = (n: NotificationItem) => {
    if (n.isRead) return;
    setItems((prev) =>
      prev.map((p) => (p.id === n.id ? { ...p, isRead: true } : p))
    );
    startTransition(async () => {
      await markAsReadAction(n.id);
    });
  };

  return (
    <>
      {/* Page head — playful pf-ph idiom with bulk actions on the right */}
      <div className="pf-ph">
        <div className="l">
          <div className="eyebrow">
            <span className="d" aria-hidden />
            ACCOUNT · NOTIFICATIONS
          </div>
          <h1>
            Everything <span className="ser">worth</span>{" "}
            <span className="hl">a ping.</span>
          </h1>
          <div className="sub">
            Price alerts, broker reauth, billing reminders, and StockSage
            research updates — all in one feed.
          </div>
        </div>
        <div className="r">
          {unreadCount > 0 && (
            <span className="pf-pill emerald">{unreadCount} unread</span>
          )}
          <button
            type="button"
            onClick={handleMarkAllRead}
            disabled={pending || unreadCount === 0}
            className="pf-bf sm"
            style={{
              opacity: pending || unreadCount === 0 ? 0.5 : 1,
              cursor: pending || unreadCount === 0 ? "not-allowed" : "pointer",
            }}
          >
            {pending ? (
              <Loader2 size={14} className="animate-spin" />
            ) : (
              <CheckCheck size={14} />
            )}
            Mark all read
          </button>
          <button
            type="button"
            onClick={handleClearAll}
            disabled={pending || readCount === 0}
            className="pf-bf sm danger"
            style={{
              opacity: pending || readCount === 0 ? 0.5 : 1,
              cursor: pending || readCount === 0 ? "not-allowed" : "pointer",
            }}
          >
            <Trash2 size={14} /> Clear all
          </button>
        </div>
      </div>

      {/* Filter chips — pf-pill (active filled emerald, rest outline) */}
      <div
        style={{
          display: "flex",
          flexWrap: "wrap",
          gap: 8,
          marginBottom: 20,
        }}
      >
        {FILTERS.map((f) => {
          const isActive = filter === f.id;
          const n = countFor(f.id);
          return (
            <button
              key={f.id}
              type="button"
              onClick={() => setFilter(f.id)}
              className={`pf-pill${isActive ? " emerald" : " outline"}`}
              style={{ cursor: "pointer" }}
              aria-pressed={isActive}
            >
              {f.label}
              <span style={{ opacity: 0.7 }}>{n}</span>
            </button>
          );
        })}
      </div>

      {filtered.length === 0 ? (
        <div
          className="pf-card flat"
          style={{
            borderStyle: "dashed",
            textAlign: "center",
            padding: "40px 24px",
          }}
        >
          <div
            style={{
              fontSize: 18,
              fontWeight: 800,
              letterSpacing: "-0.4px",
              color: "var(--ink)",
              marginBottom: 6,
            }}
          >
            {filter === "all"
              ? "No notifications yet"
              : `No ${filter} notifications`}
          </div>
          <div
            style={{
              fontSize: 13.5,
              color: "var(--ink-3)",
              maxWidth: 420,
              margin: "0 auto",
              lineHeight: 1.4,
            }}
          >
            Price alerts, broker sync messages, and StockSage research updates
            land here.
          </div>
        </div>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          {filtered.map((n) => {
            const md = (n.metadata ?? {}) as Record<string, unknown>;
            const { Icon, tone } = visualFor(n.type, alertKindOf(md));
            const toneStyle = TONE_STYLE[tone];
            const deepLink =
              (md.link as string | undefined) ??
              (md.deepLink as string | undefined) ??
              (md.symbol ? `/stock/${md.symbol}` : "/dashboard");
            return (
              <Link
                key={n.id}
                href={deepLink}
                onClick={() => handleOpen(n)}
                className="pf-card"
                style={{
                  position: "relative",
                  display: "grid",
                  gridTemplateColumns: "auto 1fr auto",
                  alignItems: "center",
                  gap: 14,
                  padding: "14px 16px",
                  textDecoration: "none",
                  color: "var(--ink)",
                  overflow: "hidden",
                  background: n.isRead ? "var(--paper)" : "var(--emerald-bg)",
                }}
              >
                {!n.isRead && (
                  <span
                    aria-hidden
                    style={{
                      position: "absolute",
                      left: 0,
                      top: 0,
                      bottom: 0,
                      width: 4,
                      background: "var(--emerald)",
                    }}
                  />
                )}
                {/* Rotated colored square icon tile per type */}
                <span
                  style={{
                    width: 36,
                    height: 36,
                    borderRadius: 9,
                    display: "grid",
                    placeItems: "center",
                    background: toneStyle.bg,
                    color: toneStyle.fg,
                    border: "1.5px solid var(--ink)",
                    transform: "rotate(-3deg)",
                    flexShrink: 0,
                  }}
                >
                  <Icon size={16} />
                </span>
                <div style={{ minWidth: 0 }}>
                  <div
                    style={{
                      display: "flex",
                      alignItems: "baseline",
                      gap: 8,
                      flexWrap: "wrap",
                    }}
                  >
                    <span
                      style={{
                        fontSize: 14,
                        fontWeight: 700,
                        letterSpacing: "-0.2px",
                        color: "var(--ink)",
                        lineHeight: 1.25,
                      }}
                    >
                      {n.title}
                    </span>
                    {!n.isRead && (
                      <span
                        aria-hidden
                        style={{
                          width: 6,
                          height: 6,
                          borderRadius: "50%",
                          background: "var(--emerald)",
                          flexShrink: 0,
                        }}
                      />
                    )}
                    <span
                      className="mono"
                      style={{
                        fontSize: 11,
                        color: "var(--ink-3)",
                        whiteSpace: "nowrap",
                      }}
                    >
                      {relativeTime(n.createdAt)}
                    </span>
                  </div>
                  {n.message && (
                    <div
                      style={{
                        fontSize: 12.5,
                        color: "var(--ink-3)",
                        lineHeight: 1.35,
                        marginTop: 2,
                        overflow: "hidden",
                        textOverflow: "ellipsis",
                        whiteSpace: "nowrap",
                      }}
                    >
                      {n.message}
                    </div>
                  )}
                </div>
                <ArrowUpRight
                  size={16}
                  style={{ color: "var(--ink-3)", flexShrink: 0 }}
                />
              </Link>
            );
          })}
        </div>
      )}
    </>
  );
}
