"use client";

/**
 * Chat sidebar tab strip — playful redesign (MONEY-483).
 *
 * 4 tabs swap the sidebar body (no routing):
 *   Chats / Feeds / Alerts / Notifs
 *
 * Visual per chat-sidebar.jsx:
 *  - Tab strip on paper-2 background with 2px ink bottom border.
 *  - Active tab: paper fill, 1.5px ink border (no bottom = merges into
 *    body), slight negative margin-bottom to cover the strip border.
 *  - Active tab has an emerald dot badge at top-right corner.
 *  - Count badges sit above icon (absolute -top/-right).
 *  - Collapse button is a small 24×22 ink-bordered square.
 */

import { useEffect, useState } from "react";
import {
  MessageSquare,
  Rss,
  BellRing,
  Bell,
  PanelLeftClose,
  type LucideIcon,
} from "lucide-react";
import { getUnreadCountAction } from "@/lib/actions/notifications";

export type ChatSidebarTab = "chats" | "feeds" | "alerts" | "notifs";

interface Props {
  activeTab: ChatSidebarTab;
  onTabChange: (tab: ChatSidebarTab) => void;
  chatsCount: number;
  feedsCount?: number;
  alertsCount?: number;
  onToggle?: () => void;
}

export default function ChatSidebarTabs({
  activeTab,
  onTabChange,
  chatsCount,
  feedsCount = 0,
  alertsCount = 0,
  onToggle,
}: Props) {
  const [unread, setUnread] = useState(0);
  useEffect(() => {
    let cancelled = false;
    const fetchUnread = async () => {
      try {
        const r = await getUnreadCountAction();
        if (!cancelled && r?.success && typeof r.data === "number") {
          setUnread(r.data);
        }
      } catch {
        // keep zero
      }
    };
    fetchUnread();
    const interval = setInterval(fetchUnread, 60_000);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, []);

  const tabs: Array<{
    id: ChatSidebarTab;
    Icon: LucideIcon;
    label: string;
    count: number;
  }> = [
    { id: "chats", Icon: MessageSquare, label: "Chats", count: chatsCount },
    { id: "feeds", Icon: Rss, label: "Feeds", count: feedsCount },
    { id: "alerts", Icon: BellRing, label: "Alerts", count: alertsCount },
    { id: "notifs", Icon: Bell, label: "Notifs", count: unread },
  ];

  return (
    <div
      style={{
        background: "var(--paper-2)",
        borderBottom: "2px solid var(--ink)",
        flexShrink: 0,
      }}
    >
      {/* Tab buttons row */}
      <div
        style={{
          display: "flex",
          padding: "10px 10px 0",
          gap: 4,
        }}
      >
        {tabs.map((t) => {
          const active = activeTab === t.id;
          return (
            <button
              key={t.id}
              type="button"
              onClick={() => onTabChange(t.id)}
              style={{
                flex: 1,
                position: "relative",
                background: active ? "var(--paper)" : "transparent",
                border: active
                  ? "1.5px solid var(--ink)"
                  : "1.5px solid transparent",
                borderBottom: active ? "1.5px solid var(--paper)" : "none",
                borderRadius: "8px 8px 0 0",
                padding: "8px 4px 9px",
                marginBottom: active ? -2 : 0,
                cursor: "pointer",
                color: active ? "var(--ink)" : "var(--ink-3)",
                display: "flex",
                flexDirection: "column",
                alignItems: "center",
                gap: 3,
                fontFamily: "inherit",
                fontWeight: active ? 700 : 500,
                transition: "color 0.12s",
              }}
              aria-selected={active}
              role="tab"
            >
              {/* Icon + count badge wrapper */}
              <span style={{ position: "relative", display: "block" }}>
                <t.Icon size={14} strokeWidth={2} />
                {t.count > 0 && (
                  <span
                    style={{
                      position: "absolute",
                      top: -5,
                      right: -7,
                      minWidth: 14,
                      height: 14,
                      borderRadius: 999,
                      background: "var(--emerald)",
                      border: "1px solid var(--paper)",
                      color: "var(--paper)",
                      fontSize: 8,
                      fontWeight: 800,
                      display: "grid",
                      placeItems: "center",
                      fontFamily: "JetBrains Mono, monospace",
                      padding: "0 3px",
                      lineHeight: 1,
                    }}
                  >
                    {t.count > 99 ? "99+" : t.count}
                  </span>
                )}
              </span>
              <span
                style={{
                  fontSize: 10.5,
                  letterSpacing: 0.3,
                  fontFamily: "JetBrains Mono, monospace",
                }}
              >
                {t.label}
              </span>
              {/* Active emerald dot indicator at top-right of tab */}
              {active && (
                <span
                  style={{
                    position: "absolute",
                    top: -3,
                    right: 6,
                    width: 6,
                    height: 6,
                    borderRadius: 999,
                    background: "var(--emerald)",
                    border: "1px solid var(--ink)",
                  }}
                  aria-hidden="true"
                />
              )}
            </button>
          );
        })}
      </div>

      {/* Collapse button row */}
      {onToggle && (
        <div
          style={{
            display: "flex",
            justifyContent: "flex-end",
            padding: "6px 10px",
            borderTop: "1.5px dashed var(--rule-soft)",
          }}
        >
          <button
            type="button"
            onClick={onToggle}
            aria-label="Collapse sidebar"
            style={{
              width: 24,
              height: 22,
              border: "1.25px solid var(--ink)",
              background: "var(--paper)",
              borderRadius: 5,
              color: "var(--ink-3)",
              display: "grid",
              placeItems: "center",
              cursor: "pointer",
            }}
          >
            <PanelLeftClose size={12} strokeWidth={2} />
          </button>
        </div>
      )}
    </div>
  );
}
