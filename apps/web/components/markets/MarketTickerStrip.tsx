"use client";

/**
 * Horizontal scrolling ticker strip for the Markets page (MONEY-242,
 * design Image #29 - the slim row at the very top of the page).
 *
 * Why this exists:
 *   The 6 index cards below are heavier (sparklines + live polling)
 *   so they sometimes render their skeleton state for several seconds.
 *   This strip uses the same `getIndicesAction` SSR snapshot - but
 *   without sparklines, so it paints immediately and gives the user
 *   something live-feeling at the very top of the viewport.
 *
 *   Behavior:
 *     - Marquee-style horizontal auto-scroll (CSS-only, pure transform).
 *     - Pauses on hover.
 *     - Shares the same `liveIndices` array the IndexCards receive, so
 *       once polling lands the values tick here too without any extra
 *       wiring.
 */

import type { IndexData } from "@/lib/actions/discover-indices";

interface MarketTickerStripProps {
  indices: IndexData[];
  /** Optional extra rows (e.g. top index movers) the parent wants to
   *  prepend after indices. Each entry is rendered identically. */
  extras?: TickerRow[];
}

export interface TickerRow {
  /** Display label, e.g. "RELIANCE", "NIFTY IT". */
  label: string;
  /** Last quoted value. */
  value: number;
  /** Day change % (signed, can be 0). */
  changePercent: number;
}

function formatVal(v: number): string {
  if (!Number.isFinite(v)) return "-";
  return v.toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

function formatPct(p: number): string {
  if (!Number.isFinite(p)) return "-";
  return `${p >= 0 ? "+" : ""}${p.toFixed(2)}%`;
}

function indexToRow(i: IndexData): TickerRow {
  return { label: i.name, value: i.price, changePercent: i.changePercent };
}

export function MarketTickerStrip({
  indices,
  extras = [],
}: MarketTickerStripProps) {
  const rows: TickerRow[] = [...indices.map(indexToRow), ...extras];

  if (rows.length === 0) {
    // Nothing to show yet - render an empty placeholder bar with the
    // same height so the page layout doesn't reflow once data lands.
    return (
      <div className="mb-3 h-9 rounded-md border border-[var(--border-default)] bg-white/[0.02]" />
    );
  }

  // Duplicate the row list so the marquee loop is seamless - the second
  // pass slides in just as the first finishes its translateX.
  const looped = [...rows, ...rows];

  return (
    <div
      className="mb-3 relative overflow-hidden rounded-md border border-[var(--border-default)] bg-white/[0.02] group"
      role="region"
      aria-label="Market ticker"
    >
      {/* Edge fades so the loop entry/exit doesn't snap visibly. */}
      <div className="pointer-events-none absolute inset-y-0 left-0 w-12 bg-gradient-to-r from-[#16140e] to-transparent z-10" />
      <div className="pointer-events-none absolute inset-y-0 right-0 w-12 bg-gradient-to-l from-[#16140e] to-transparent z-10" />

      <div
        className="flex items-center gap-6 py-2 whitespace-nowrap"
        style={{
          animation: "um-marquee 40s linear infinite",
        }}
      >
        {looped.map((r, i) => {
          const pos = r.changePercent >= 0;
          return (
            <span
              key={`${r.label}-${i}`}
              className="inline-flex items-center gap-2 px-3 font-mono text-[12px] tabular-nums shrink-0"
            >
              <span className="font-bold text-[var(--text-secondary)] tracking-[0.3px]">
                {r.label}
              </span>
              <span className="text-[var(--text-primary)]">
                {formatVal(r.value)}
              </span>
              <span
                className={`font-semibold ${pos ? "text-emerald-400" : "text-red-400"}`}
              >
                {pos ? "▲" : "▼"} {formatPct(r.changePercent)}
              </span>
            </span>
          );
        })}
      </div>

      <style jsx>{`
        @keyframes um-marquee {
          from {
            transform: translateX(0);
          }
          to {
            transform: translateX(-50%);
          }
        }
        .group:hover > div[style*="um-marquee"] {
          animation-play-state: paused;
        }
      `}</style>
    </div>
  );
}

export default MarketTickerStrip;
