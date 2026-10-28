"use client";

/**
 * Shared Tradebook sub-navigation strip.
 *
 * Trades · Import · History · Export
 *
 * Lives in one place so /tradebook, /tradebook/import,
 * /tradebook/import/history and /tradebook/export all stay in sync. Used
 * to be inlined per-page; consolidating it here means a future tab change
 * is one edit instead of four.
 */

import { Table2, Upload, History, Download } from "lucide-react";
import type { LucideIcon } from "lucide-react";

export type TradebookTabId = "list" | "import" | "history" | "export";

interface Tab {
  id: TradebookTabId;
  icon: LucideIcon;
  label: string;
  href: string;
}

const TABS: Tab[] = [
  { id: "list", icon: Table2, label: "Trades", href: "/tradebook" },
  { id: "import", icon: Upload, label: "Import", href: "/tradebook/import" },
  {
    id: "history",
    icon: History,
    label: "History",
    href: "/tradebook/import/history",
  },
  {
    id: "export",
    icon: Download,
    label: "Export",
    href: "/tradebook/export",
  },
];

export function TradebookSubNav({
  active,
  right,
  trailingMargin = true,
}: {
  active: TradebookTabId;
  /** Optional right-side actions (e.g. "+ Add trade" on the list view). */
  right?: React.ReactNode;
  /** Set false when the page handles its own bottom margin. */
  trailingMargin?: boolean;
}) {
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: 12,
        marginBottom: trailingMargin ? 18 : 0,
        paddingBottom: trailingMargin ? 14 : 0,
        borderBottom: trailingMargin
          ? "1px solid var(--border-default)"
          : undefined,
        flexWrap: "wrap",
      }}
    >
      <div
        style={{
          display: "flex",
          gap: 4,
          padding: 4,
          background: "var(--bg-segmented)",
          border: "1px solid var(--border-default)",
          borderRadius: 10,
          overflowX: "auto",
          WebkitOverflowScrolling: "touch",
          maxWidth: "100%",
        }}
      >
        {TABS.map((t) => {
          const a = active === t.id;
          const Icon = t.icon;
          return (
            <a
              key={t.id}
              href={t.href}
              data-walkthrough={`tradebook-import-${t.id}`}
              style={{
                padding: "7px 12px",
                background: a ? "rgba(52,211,153,.14)" : "transparent",
                color: a ? "#34d399" : "var(--text-dim)",
                border: 0,
                borderRadius: 7,
                cursor: "pointer",
                fontSize: 12.5,
                fontWeight: 600,
                display: "inline-flex",
                alignItems: "center",
                gap: 7,
                whiteSpace: "nowrap",
                textDecoration: "none",
                transition: "background .15s, color .15s",
              }}
            >
              <Icon style={{ width: 14, height: 14 }} />
              <span>{t.label}</span>
            </a>
          );
        })}
      </div>
      {right && (
        <div
          style={{
            marginLeft: "auto",
            display: "flex",
            gap: 8,
            flexWrap: "wrap",
          }}
        >
          {right}
        </div>
      )}
    </div>
  );
}
