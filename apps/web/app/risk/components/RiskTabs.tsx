"use client";

/**
 * Risk v2 (MONEY-485) — section tab bar.
 *
 * Pill-style segmented tabs matching the design's section nav. Active
 * tab is theme-aware (filled ink chip). Counts shown as a small badge.
 */

import type { LucideIcon } from "lucide-react";

export interface RiskTabItem {
  id: string;
  label: string;
  icon: LucideIcon;
  count?: number;
}

export default function RiskTabs({
  items,
  active,
  onChange,
}: {
  items: RiskTabItem[];
  active: string;
  onChange: (id: string) => void;
}) {
  return (
    <div
      className="flex items-center gap-1.5 overflow-x-auto pb-1"
      role="tablist"
      aria-label="Risk sections"
    >
      {items.map((item) => {
        const Icon = item.icon;
        const isActive = item.id === active;
        return (
          <button
            key={item.id}
            role="tab"
            aria-selected={isActive}
            onClick={() => onChange(item.id)}
            className="inline-flex items-center gap-2 rounded-lg whitespace-nowrap transition-transform"
            style={{
              padding: "8px 14px",
              fontSize: 13,
              fontWeight: 700,
              border: "1.5px solid var(--ink)",
              background: isActive ? "var(--ink)" : "var(--paper)",
              color: isActive ? "var(--paper)" : "var(--ink)",
              flexShrink: 0,
            }}
          >
            <Icon className="h-[14px] w-[14px]" />
            {item.label}
            {item.count !== undefined && (
              <span
                className="mono"
                style={{
                  fontSize: 9.5,
                  fontWeight: 700,
                  padding: "1px 6px",
                  borderRadius: 999,
                  background: isActive ? "var(--pop-2)" : "var(--emerald)",
                  color: isActive ? "#1d1d1b" : "var(--paper)",
                  letterSpacing: 0.5,
                }}
              >
                {item.count}
              </span>
            )}
          </button>
        );
      })}
    </div>
  );
}
