"use client";

/**
 * Compact stock card for the Screener Cards view (MONEY-243).
 *
 * Design reference: `discover-page-redesign/project/src/PageScreener.jsx`
 * (StockCardCompact ~line 80–125 of the original prototype, adapted to the
 * real ScreenResult shape coming back from `screenStocksAction`).
 *
 * Layout:
 *   [✓] [SECTOR pill]              [≡ menu]
 *   SYMBOL · NSE
 *   Company name
 *   ₹LTP    +0.42%
 *   ─────────────────────────────────
 *   MCAP · P/E · ROE · Rev Δ · D/E   <- two-line metric strip
 *   ─────────────────────────────────
 *   [Match score bar]
 *   [Analysis ›]                  [+ Watchlist / In N]
 */

import React, { useState } from "react";
import Link from "next/link";
import { Eye, Sparkles } from "lucide-react";
import type { ScreenResult } from "@/lib/actions/screener";
import { MatchScoreBar } from "@/components/screener/MatchScoreBar";
import { WatchlistPopover } from "@/components/watchlist/WatchlistPopover";
import { useWatchlistMembership } from "@/hooks/useWatchlistMembership";
import ResearchModal from "@/components/analysis/ResearchModal";

/**
 * Inline "+ Watch" / "In N" trigger matching design Image #42 - plain
 * text + plus icon when not in any list, eye + count when in N. Used
 * inside cards instead of the heavier bookmark pill so the action
 * row reads cleanly.
 */
/**
 * forwardRef so Radix's `<PopoverTrigger asChild>` can pass down both the
 * onClick (for opening the popover) and a ref (for focus management).
 * Without this, Slot tries to clone a plain function-component result and
 * the click handler never lands on the underlying button - the popover
 * appears dead even though the visual is fine.
 */
type WatchInlineTriggerProps = React.ButtonHTMLAttributes<HTMLButtonElement> & {
  memberCount?: number;
};

const WatchInlineTrigger = React.forwardRef<
  HTMLButtonElement,
  WatchInlineTriggerProps
>(function WatchInlineTrigger({ memberCount = 0, className, ...rest }, ref) {
  const baseClass = `pf-pill cursor-pointer ${memberCount > 0 ? "emerald" : "outline"}`;
  return (
    <button
      ref={ref}
      type="button"
      className={className ? `${baseClass} ${className}` : baseClass}
      style={{ fontSize: 11 }}
      {...rest}
    >
      {memberCount > 0 ? (
        <>
          <Eye className="h-3 w-3" />
          In {memberCount}
        </>
      ) : (
        <>
          <span className="font-bold">+</span>
          Watch
        </>
      )}
    </button>
  );
});

interface StockCardCompactProps {
  row: ScreenResult;
  selected: boolean;
  onToggleSelect: (symbol: string) => void;
}

/** Compact ₹ market cap formatter. */
function formatMcap(cr: number | null): string {
  if (cr == null || !Number.isFinite(cr)) return "-";
  if (cr >= 100_000) return `₹${(cr / 100_000).toFixed(1)}T`;
  if (cr >= 1_000) return `₹${(cr / 1_000).toFixed(1)}k Cr`;
  return `₹${cr.toFixed(0)} Cr`;
}

function formatPct(v: number | null, withSign = true): string {
  if (v == null || !Number.isFinite(v)) return "-";
  const sign = withSign && v >= 0 ? "+" : "";
  return `${sign}${v.toFixed(2)}%`;
}

function formatNum(v: number | null, digits = 2): string {
  if (v == null || !Number.isFinite(v)) return "-";
  return v.toFixed(digits);
}

function formatInr(v: number | null): string {
  if (v == null || !Number.isFinite(v)) return "-";
  return `₹${v.toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

export function StockCardCompact({
  row,
  selected,
  onToggleSelect,
}: StockCardCompactProps) {
  const pos = (row.changePercent ?? 0) >= 0;
  /* MONEY-1253 — the inline trigger's member count.
     This used to be `useState(0)` populated ONLY by
     WatchlistPopover.onMembershipChange, which fires when the popover OPENS —
     so every card claimed "+ Watch" on load, including stocks sitting in three
     lists. Nothing was stale; membership was never fetched.

     The hook resolves it from ONE shared, cached `getWatchlistsAction` call
     for the whole page. Deliberately not a per-card fetch: this screener has
     already been burned by fanning out a server action per card (see the
     ResearchModal note below), and it refetches on every filter change.

     `overrideCount` keeps the popover's own callback authoritative once the
     user toggles, so the trigger still updates instantly without waiting for
     a refetch.

     That override is applied with `??`, which falls through on null/undefined
     but NOT on 0 — so a 0 from the popover wins permanently. That is correct
     only because the popover now publishes solely after it has fetched
     (WatchlistPopover gates on `cachedFor`). It previously published its
     uninitialised `memberCount` of 0 on MOUNT, which pinned every card to
     "+ Watch" and made this hook's result invisible. */
  const { countFor } = useWatchlistMembership();
  const [overrideCount, setOverrideCount] = useState<number | null>(null);
  const memberCount =
    overrideCount ?? countFor(row.symbol, row.exchange, "STOCK");
  const [researchOpen, setResearchOpen] = useState(false);

  return (
    <div
      className="pf-card relative transition-transform"
      style={{
        padding: 16,
        ...(selected ? { borderColor: "var(--emerald)" } : {}),
      }}
    >
      {/* Top row: checkbox on left, sector + exchange tags on right.
          Splitting the row gives the sector pill room to breathe instead
          of competing with the checkbox for the same horizontal slot. */}
      <div className="flex items-start justify-between gap-2 mb-2.5">
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            onToggleSelect(row.symbol);
          }}
          aria-label={
            selected ? `Deselect ${row.symbol}` : `Select ${row.symbol}`
          }
          className="h-[18px] w-[18px] mt-0.5 shrink-0 rounded-[5px] flex items-center justify-center transition-colors cursor-pointer"
          style={{
            border: "1.5px solid var(--ink)",
            background: selected ? "var(--emerald)" : "var(--paper)",
          }}
        >
          {selected && (
            <svg width="10" height="10" viewBox="0 0 9 9" fill="none">
              <path
                d="M1 4.5L3.5 7L8 1.5"
                stroke="var(--paper)"
                strokeWidth="1.6"
                strokeLinecap="round"
              />
            </svg>
          )}
        </button>
        <div className="flex items-center gap-1.5 ml-auto min-w-0 flex-wrap justify-end">
          {row.sector && (
            <span
              className="pf-pill outline truncate max-w-[180px]"
              style={{ fontSize: 9 }}
              title={row.sector}
            >
              {row.sector}
            </span>
          )}
          <span
            className="pf-pill outline"
            style={{
              fontSize: 9,
              ...(row.exchange === "BSE"
                ? { borderColor: "var(--pop-5)", color: "var(--pop-5-text)" }
                : {
                    borderColor: "var(--emerald)",
                    color: "var(--emerald-text)",
                  }),
            }}
          >
            {row.exchange}
          </span>
        </div>
      </div>

      {/* Identity + price + metrics + match - clickable navigation
          surface. Wrapping all of this in a single Link makes clicking
          anywhere in the card body (except action buttons) open the
          stock detail page. Action buttons below have their own click
          handlers + stopPropagation so they keep working. */}
      <Link
        href={`/stock/${row.symbol}?exchange=${row.exchange}`}
        className="block group cursor-pointer"
      >
        <div
          className="mono text-[15px] font-bold leading-none mb-1.5 transition-colors"
          style={{ color: "var(--emerald-text)" }}
        >
          {row.symbol}
        </div>
        <div className="text-[12px] text-[var(--ink-3)] truncate mb-3 group-hover:text-[var(--ink-2)] transition-colors">
          {row.name || row.symbol}
        </div>

        {/* Price + change - single baseline-aligned line. */}
        <div className="flex items-baseline gap-2.5 mb-3">
          <span className="mono text-[18px] font-bold tabular-nums text-[var(--ink)] leading-none">
            {formatInr(row.ltp)}
          </span>
          <span
            className="mono text-[12px] font-bold tabular-nums"
            style={{ color: pos ? "var(--emerald-text)" : "var(--pop-1-text)" }}
          >
            {formatPct(row.changePercent)}
          </span>
        </div>

        {/* Metric strip */}
        <div
          className="grid grid-cols-3 gap-x-4 gap-y-2.5 py-3 mb-3"
          style={{
            borderTop: "1.5px dashed var(--rule-soft)",
            borderBottom: "1.5px dashed var(--rule-soft)",
          }}
        >
          <Metric label="MCap" value={formatMcap(row.marketCap)} />
          <Metric label="P/E" value={formatNum(row.pe, 1)} />
          <Metric
            label="ROE"
            value={formatPct(row.roe, false)}
            tone={(row.roe ?? 0) >= 0 ? "pos" : "neg"}
          />
          <Metric
            label="Rev Δ"
            value={formatPct(row.revenueGrowth)}
            tone={(row.revenueGrowth ?? 0) >= 0 ? "pos" : "neg"}
          />
          <Metric label="D/E" value={formatNum(row.debtToEquity, 2)} />
        </div>

        {/* Match score */}
        <div className="mb-3.5">
          <div className="flex items-baseline justify-between mb-1.5">
            <span className="mono text-[9px] tracking-[1px] uppercase font-bold text-[var(--ink-3)]">
              Match
            </span>
            <span
              className="mono text-[11.5px] font-bold tabular-nums"
              style={{ color: "var(--emerald-text)" }}
            >
              {row.matchScore}
            </span>
          </div>
          <MatchScoreBar score={row.matchScore} width={120} />
        </div>
      </Link>

      {/* Action row */}
      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={() => setResearchOpen(true)}
          className="pf-bf sm"
          style={{ fontSize: 11.5 }}
        >
          <Sparkles className="h-3 w-3" />
          Analysis
        </button>
        <div className="ml-auto">
          <WatchlistPopover
            target={{
              symbol: row.symbol,
              exchange: row.exchange,
              kind: "STOCK",
            }}
            trigger={<WatchInlineTrigger memberCount={memberCount} />}
            onMembershipChange={setOverrideCount}
          />
        </div>
      </div>
      {/* Research picker - opens in-place; routes to /analysis/[id]
          after submit so the user lands on the running session, not on
          the stock detail page. Lazy-mount only when open: the modal
          internally calls useResearchPreferences/useComposerPreferences
          on mount, which fires server actions - mounting 20-25 modals
          unconditionally per page made the screener fan out a server
          action per card on every refetch. */}
      {researchOpen && (
        <ResearchModal
          open={researchOpen}
          onOpenChange={setResearchOpen}
          entity={{
            symbol: row.symbol,
            name: row.name || row.symbol,
            type: "stock",
            exchange: row.exchange,
          }}
        />
      )}
    </div>
  );
}

function Metric({
  label,
  value,
  tone,
}: {
  label: string;
  value: string;
  tone?: "pos" | "neg";
}) {
  const valueColor =
    tone === "pos"
      ? "var(--emerald-text)"
      : tone === "neg"
        ? "var(--pop-1-text)"
        : "var(--ink-2)";
  return (
    <div>
      <div className="mono text-[9px] tracking-[1px] uppercase font-bold text-[var(--ink-3)]">
        {label}
      </div>
      <div
        className="mono text-[11.5px] font-bold tabular-nums mt-0.5"
        style={{ color: valueColor }}
      >
        {value}
      </div>
    </div>
  );
}

export default StockCardCompact;
