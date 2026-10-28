"use client";

/**
 * Compact fund card for the Screener Cards view (MF + ETF modes,
 * MONEY-243). Mirrors `StockCardCompact` but for `MfScreenResult` and
 * `EtfScreenResult` shapes.
 *
 * Layout:
 *   [✓] [CATEGORY pill]                [RISK pill]
 *   {Scheme name}
 *   {AMC}
 *   ₹NAV    +1Y%
 *   ─────────────────────────────────
 *   3Y CAGR · AUM · EXP    <- metric strip
 *   ─────────────────────────────────
 *   [Match score bar]
 *   [Open ›]                  [+ Watchlist / In N]
 */

import React, { useState } from "react";
import { instrumentDetailHref } from "@/lib/fund/instrument-href";
import Link from "next/link";
import { Eye, Sparkles } from "lucide-react";
import type { EtfScreenResult, MfScreenResult } from "@/lib/actions/screener";
import { MatchScoreBar } from "@/components/screener/MatchScoreBar";
import { WatchlistPopover } from "@/components/watchlist/WatchlistPopover";
import { useWatchlistMembership } from "@/hooks/useWatchlistMembership";
import ResearchModal from "@/components/analysis/ResearchModal";

/** Inline "+ Watch" / "In N" trigger - matches the StockCardCompact
 *  variant; replicated here to keep the cards self-contained. */
/**
 * forwardRef so Radix's `<PopoverTrigger asChild>` can pass down both the
 * onClick (for opening the popover) and a ref (for focus management).
 * See StockCardCompact.tsx for the full reasoning.
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

/** Discriminated union to avoid two near-identical card components. */
export type FundRow =
  | { kind: "MF"; row: MfScreenResult }
  | { kind: "ETF"; row: EtfScreenResult };

interface FundCardCompactProps {
  fund: FundRow;
  selected: boolean;
  onToggleSelect: (id: string) => void;
}

function formatPct(v: number | null | undefined, withSign = true): string {
  if (v == null || !Number.isFinite(v)) return "-";
  const sign = withSign && v >= 0 ? "+" : "";
  return `${sign}${v.toFixed(1)}%`;
}

function formatAum(cr: number | null | undefined): string {
  if (cr == null || !Number.isFinite(cr)) return "-";
  if (cr >= 100_000) return `₹${(cr / 100_000).toFixed(1)}T`;
  if (cr >= 1_000) return `₹${(cr / 1_000).toFixed(1)}k Cr`;
  return `₹${cr.toFixed(0)} Cr`;
}

function formatNav(nav: number | null | undefined): string {
  if (nav == null || !Number.isFinite(nav)) return "-";
  return `₹${nav.toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function formatExp(exp: number | null | undefined): string {
  if (exp == null || !Number.isFinite(exp)) return "-";
  return `${exp.toFixed(2)}%`;
}

function riskTone(risk: string | null | undefined): {
  label: string;
  /** Token-driven pill border color so the badge tracks light + dark themes. */
  color: string;
  /** AA-safe text sibling of `color` for the pill label (MONEY-498). */
  textColor: string;
} {
  if (!risk)
    return { label: "-", color: "var(--ink-3)", textColor: "var(--ink-3)" };
  const r = risk.toLowerCase();
  if (r.includes("very high"))
    return {
      label: "Very High",
      color: "var(--pop-1)",
      textColor: "var(--pop-1-text)",
    };
  if (r.includes("high"))
    return {
      label: "High",
      color: "var(--pop-1)",
      textColor: "var(--pop-1-text)",
    };
  if (r.includes("moderat"))
    return {
      label: "Moderate",
      color: "var(--pop-2)",
      textColor: "var(--pop-2-text)",
    };
  return {
    label: risk,
    color: "var(--emerald)",
    textColor: "var(--emerald-text)",
  };
}

export function FundCardCompact({
  fund,
  selected,
  onToggleSelect,
}: FundCardCompactProps) {
  const isMf = fund.kind === "MF";
  const [researchOpen, setResearchOpen] = useState(false);
  const id = isMf ? fund.row.schemeCode : fund.row.symbol;
  const name = isMf ? fund.row.schemeName : fund.row.name;
  // ETF symbol - surface as the prominent ticker on ETF cards (parity
  // with StockCardCompact). MFs don't have meaningful trading tickers,
  // so only set this for ETFs.
  const ticker = !isMf ? fund.row.symbol : null;
  const subtitle = isMf
    ? fund.row.amcName
    : (fund.row.assetClass ?? fund.row.exchange);
  const category = isMf ? fund.row.category : (fund.row.assetClass ?? "ETF");
  const nav = isMf ? fund.row.nav : fund.row.ltp;
  const change = isMf ? fund.row.returns1Y : fund.row.changePercent;
  const aum = isMf ? fund.row.aum : fund.row.aum;
  const cagr3 = isMf ? fund.row.returns3Y : null;
  const exp = isMf ? fund.row.expenseRatio : fund.row.expenseRatio;
  const risk = isMf ? riskTone(fund.row.riskLevel) : null;
  // MONEY-457: ETF cards route to /etf/[symbol] — a fund-shaped detail page
  // that mirrors the MF detail layout. Previously they went to /stock/[symbol],
  // which is OHLC/PE-shaped and wrong for funds. MONEY-1205: through the shared
  // resolver, so this card and the six sites that disagreed with it now agree
  // by construction.
  const href = instrumentDetailHref({
    symbol: id,
    exchange: isMf ? null : fund.row.exchange,
    instrumentType: isMf ? "MF" : "ETF",
  });
  const watchlistTarget = isMf
    ? { symbol: id, exchange: "MF", kind: "MF" as const }
    : {
        symbol: fund.row.symbol,
        exchange: fund.row.exchange,
        kind: "STOCK" as const,
      };

  const pos = (change ?? 0) >= 0;

  /* MONEY-1253 — see StockCardCompact for the full note. `useState(0)` here
     meant every fund/ETF card claimed "+ Watch" on load; membership was only
     fetched when the popover opened. Resolved from the same ONE cached
     watchlist read the stock cards use, keyed off `watchlistTarget` so ETFs
     (stored under kind "STOCK") and MFs (kind "MF") each count against the
     right lists. */
  const { countFor } = useWatchlistMembership();
  const [overrideCount, setOverrideCount] = useState<number | null>(null);
  const memberCount =
    overrideCount ??
    countFor(
      watchlistTarget.symbol,
      watchlistTarget.exchange,
      watchlistTarget.kind
    );

  return (
    <div
      className="pf-card relative transition-transform"
      style={{
        padding: 14,
        ...(selected ? { borderColor: "var(--emerald)" } : {}),
      }}
    >
      {/* Top row */}
      <div className="flex items-center gap-2 mb-2">
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            onToggleSelect(id);
          }}
          aria-label={selected ? `Deselect ${name}` : `Select ${name}`}
          className="h-[18px] w-[18px] shrink-0 rounded-[5px] flex items-center justify-center transition-colors cursor-pointer"
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
        <span
          className="pf-pill outline"
          style={{
            fontSize: 9,
            borderColor: "var(--pop-5)",
            color: "var(--pop-5-text)",
          }}
        >
          {fund.kind}
        </span>
        <span
          className="pf-pill outline truncate max-w-[140px]"
          style={{ fontSize: 9 }}
        >
          {category}
        </span>
        {risk && (
          <span
            className="pf-pill outline ml-auto"
            style={{
              fontSize: 9,
              borderColor: risk.color,
              color: risk.textColor,
            }}
          >
            {risk.label}
          </span>
        )}
      </div>

      {/* Identity - fund title bold sentence-case (legibility wins over
          uppercase for long scheme names), AMC subtitle italic uppercase
          quoted to mirror the StockCardCompact treatment. */}
      <Link href={href} className="block">
        <div className="text-[13px] text-[var(--ink)] font-bold leading-tight mb-1 line-clamp-2 min-h-[2.4em]">
          {name}
        </div>
        <div className="ser text-[12px] uppercase tracking-[0.4px] text-[var(--ink-3)] truncate mb-2.5">
          &quot;{subtitle.toUpperCase()}&quot;
        </div>
      </Link>

      {/* Price */}
      <div className="flex items-baseline gap-2 mb-3">
        <span className="mono text-[15px] font-bold tabular-nums text-[var(--ink)]">
          {formatNav(nav)}
        </span>
        <span
          className="mono text-[11px] font-bold tabular-nums"
          style={{ color: pos ? "var(--emerald-text)" : "var(--pop-1-text)" }}
        >
          {formatPct(change)}
          <span className="ml-0.5 text-[var(--ink-3)] font-normal">
            {isMf ? "1Y" : ""}
          </span>
        </span>
      </div>

      {/* Metric strip */}
      <div
        className="grid grid-cols-3 gap-x-3 gap-y-2 py-2.5 mb-2.5"
        style={{
          borderTop: "1.5px dashed var(--rule-soft)",
          borderBottom: "1.5px dashed var(--rule-soft)",
        }}
      >
        {isMf ? (
          <>
            <Metric label="3Y CAGR" value={formatPct(cagr3, false)} />
            <Metric label="AUM" value={formatAum(aum)} />
            <Metric label="Exp" value={formatExp(exp)} />
          </>
        ) : (
          <>
            <Metric label="AUM" value={formatAum(aum)} />
            <Metric label="Exp" value={formatExp(exp)} />
            <Metric label="Match" value={`${fund.row.matchScore}`} />
          </>
        )}
      </div>

      {/* Match bar */}
      <div className="mb-3">
        <MatchScoreBar score={fund.row.matchScore} width={120} />
      </div>

      {/* Action row */}
      <div className="flex items-center gap-2">
        {/* MONEY-446: Analysis button restored for MF cards (mirrors the
            stock + ETF affordance). The ResearchModal below mounts with
            type: "mf", which forces the `mf-analysis` skill + `mf_analysis`
            credit estimate and routes to /analysis/[sessionId]. */}
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
            target={watchlistTarget}
            displayKind={isMf ? "MF" : "ETF"}
            trigger={<WatchInlineTrigger memberCount={memberCount} />}
            onMembershipChange={setOverrideCount}
          />
        </div>
      </div>
      {/* Lazy-mount only when open - see StockCardCompact for why
          (the preference hooks inside fire server actions on mount). */}
      {researchOpen && (
        <ResearchModal
          open={researchOpen}
          onOpenChange={setResearchOpen}
          entity={{
            symbol: isMf ? String(id) : (ticker ?? String(id)),
            name: name || String(id),
            type: isMf ? "mf" : "etf",
            exchange: !isMf ? fund.row.exchange : undefined,
          }}
        />
      )}
    </div>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div className="mono text-[9px] tracking-[1px] uppercase font-bold text-[var(--ink-3)]">
        {label}
      </div>
      <div className="mono text-[11.5px] font-bold tabular-nums mt-0.5 text-[var(--ink-2)]">
        {value}
      </div>
    </div>
  );
}

export default FundCardCompact;
