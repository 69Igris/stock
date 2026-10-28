"use client";

import Image from "next/image";
import "./bits.css";

/**
 * PfFilterPills — a horizontal (wrapping) row of toggleable filter pills.
 *
 * Some pills can carry a real broker logo (from /public/brokers/*.png).
 * Pills WRAP — they never scroll horizontally.
 * Groups are separated by a vertical rule divider.
 *
 * Theme-aware via CSS vars.
 */

export interface FilterPillDescriptor {
  /** Unique identifier for this pill */
  id: string;
  /** Human-readable label */
  label: string;
  /** If provided, renders the matching broker PNG from /public/brokers/ */
  brokerLogo?:
    | "zerodha"
    | "upstox"
    | "angel"
    | "dhan"
    | "fyers"
    | "groww"
    | "hdfc"
    | "icici";
  /** Whether this pill is currently active */
  active: boolean;
  /** Optional count badge shown inside the pill */
  count?: number;
  /** Optional accent colour token (without --var wrapping) */
  color?: "emerald" | "pop-1" | "pop-2" | "pop-3" | "pop-4" | "pop-5";
}

export interface PillGroup {
  /** Group key used as a React key */
  key: string;
  /** Pills belonging to this group */
  items: FilterPillDescriptor[];
}

export interface PfFilterPillsProps {
  /** Pill groups — each group is separated by a visual divider */
  groups: PillGroup[];
  /** Called with the pill id whenever a pill is toggled */
  onToggle: (id: string) => void;
  /** Whether to show a "Clear all" button that fires for every active pill */
  showClearAll?: boolean;
  /** Called when "Clear all" is pressed */
  onClearAll?: () => void;
}

/** Tiny checkmark icon */
function IconCheck({ size = 10 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      style={{ display: "block", flexShrink: 0 }}
    >
      <polyline points="20 6 9 17 4 12" />
    </svg>
  );
}

/** Tiny ✕ icon */
function IconX({ size = 10 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      style={{ display: "block", flexShrink: 0 }}
    >
      <line x1="18" y1="6" x2="6" y2="18" />
      <line x1="6" y1="6" x2="18" y2="18" />
    </svg>
  );
}

function pillColors(
  active: boolean,
  color?: FilterPillDescriptor["color"]
): { background: string; color: string } {
  if (!active) return { background: "var(--paper)", color: "var(--ink-2)" };

  switch (color) {
    case "emerald":
      return { background: "var(--emerald)", color: "var(--paper)" };
    case "pop-1":
      return { background: "var(--pop-1)", color: "#fff" };
    case "pop-2":
      return { background: "var(--pop-2)", color: "#1d1d1b" };
    case "pop-3":
      return { background: "var(--pop-3)", color: "#fff" };
    case "pop-4":
      return { background: "var(--pop-4)", color: "#fff" };
    case "pop-5":
      return { background: "var(--pop-5)", color: "#fff" };
    default:
      return { background: "var(--ink)", color: "var(--paper)" };
  }
}

export function PfFilterPills({
  groups,
  onToggle,
  showClearAll = true,
  onClearAll,
}: PfFilterPillsProps) {
  const hasActive = groups.some((g) => g.items.some((it) => it.active));

  return (
    <div className="bits-filter-row" role="group" aria-label="Filter pills">
      {groups.map((group, gi) => (
        <div key={group.key} style={{ display: "contents" }}>
          {/* Group divider — shown before every group except the first */}
          {gi > 0 && <div className="bits-filter-sep" aria-hidden />}

          <div className="bits-filter-pills" role="group">
            {group.items.map((pill) => {
              const { background, color: fgColor } = pillColors(
                pill.active,
                pill.color
              );
              const countBg = pill.active
                ? "rgba(0,0,0,.16)"
                : "var(--rule-softer)";
              const countFg = pill.active ? fgColor : "var(--ink-3)";

              return (
                <button
                  key={pill.id}
                  type="button"
                  className={`bits-filter-pill${pill.active ? " is-active" : ""}`}
                  style={{ background, color: fgColor }}
                  onClick={() => onToggle(pill.id)}
                  aria-pressed={pill.active}
                >
                  {/* Checkmark when active (no broker logo) */}
                  {pill.active && !pill.brokerLogo && <IconCheck size={10} />}

                  {/* Broker logo */}
                  {pill.brokerLogo && (
                    <Image
                      src={`/brokers/${pill.brokerLogo}.png`}
                      alt={pill.brokerLogo}
                      width={14}
                      height={14}
                      className="bits-broker-logo"
                      style={{ width: 14, height: 14 }}
                    />
                  )}

                  {pill.label}

                  {/* Count badge */}
                  {pill.count != null && (
                    <span
                      className="bits-filter-pill-count"
                      style={{ background: countBg, color: countFg }}
                    >
                      {pill.count}
                    </span>
                  )}
                </button>
              );
            })}
          </div>
        </div>
      ))}

      {showClearAll && hasActive && (
        <button
          type="button"
          className="bits-filter-clear"
          onClick={onClearAll}
          aria-label="Clear all filters"
        >
          <IconX size={10} />
          Clear all
        </button>
      )}
    </div>
  );
}

export default PfFilterPills;

/* ──────────────────────────────────────────────────────────────────────
   Convenience: a pre-wired demo version matching the design reference.
   Useful for storybook / quick import on the holdings page.
   ────────────────────────────────────────────────────────────────────── */
export const DEFAULT_FILTER_GROUPS: PillGroup[] = [
  {
    key: "type",
    items: [
      {
        id: "equity",
        label: "Equity",
        count: 8,
        active: true,
        color: "emerald",
      },
      {
        id: "mf",
        label: "Mutual funds",
        count: 3,
        active: false,
        color: "pop-3",
      },
      { id: "etf", label: "ETF", count: 2, active: false, color: "pop-5" },
      { id: "fno", label: "F&O", count: 0, active: false, color: "pop-1" },
    ],
  },
  {
    key: "cap",
    items: [
      { id: "largecap", label: "Large cap", count: 5, active: true },
      { id: "midcap", label: "Mid cap", count: 4, active: false },
      { id: "smallcap", label: "Small cap", count: 2, active: false },
    ],
  },
  {
    key: "broker",
    items: [
      {
        id: "zerodha",
        label: "Zerodha",
        count: 7,
        active: false,
        brokerLogo: "zerodha",
      },
      {
        id: "groww",
        label: "Groww",
        count: 5,
        active: false,
        brokerLogo: "groww",
      },
    ],
  },
];
