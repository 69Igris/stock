"use client";

/**
 * ETFs mode - InstrumentMapping ⨝ MutualFundMaster screener (MONEY-196).
 *
 * Filters: Exchange, Asset class, Theme (substring), AUM, 1Y returns, Expense ratio
 * Columns: TICKER · EXCH · NAV · Δ · 1Y · AUM · EXP · CLASS · MATCH
 * Row action: navigate to /etf/{symbol}?exchange={exchange}
 *
 * AUM / 1Y / expense ratio / asset class arrive via the MF master join in
 * `screenEtfsAction`. When MONEY-209 wires the ETF expense-ratio source,
 * the expense column populates without changes here.
 */

import { useMemo, useState } from "react";
import { instrumentDetailHref } from "@/lib/fund/instrument-href";
import { useRouter } from "next/navigation";
import { ScreenerPagination } from "@/components/screener/ScreenerPagination";
import { ResultsSkeleton } from "@/components/screener/ResultsSkeleton";
import { FilterSidebar } from "@/components/screener/FilterSidebar";
import { FilterCard } from "@/components/screener/FilterCard";
import { FundFilterSidebar } from "@/components/screener/FundFilterSidebar";
import { MatchScoreBar } from "@/components/screener/MatchScoreBar";
import { FundCardCompact } from "@/components/screener/FundCardCompact";
import { MAX_COMPARE_ITEMS } from "@/lib/compare/schema";
import React from "react";
import { Sparkles, Bookmark, SlidersHorizontal } from "lucide-react";
import ResearchModal from "@/components/analysis/ResearchModal";
import { WatchlistPopover } from "@/components/watchlist/WatchlistPopover";
import { EmptyState } from "@/components/empty/EmptyState";

/**
 * MONEY-457: labelled "+ Watch" trigger in the ETF table actions column.
 * The labelled variant (matches the card view's `WatchInlineTrigger` UX)
 * makes the action obvious and surfaces the watchlist member count when
 * set. (MONEY-558 restored the sibling Analyse button.)
 */
type WatchlistTableTriggerProps =
  React.ButtonHTMLAttributes<HTMLButtonElement> & {
    memberCount?: number;
  };
const WatchlistIconTrigger = React.forwardRef<
  HTMLButtonElement,
  WatchlistTableTriggerProps
>(function WatchlistIconTrigger({ memberCount = 0, ...rest }, ref) {
  const isWatched = memberCount > 0;
  return (
    <button
      ref={ref}
      type="button"
      aria-label={
        isWatched ? `In ${memberCount} watchlists` : "Add to watchlist"
      }
      title={isWatched ? `In ${memberCount} watchlists` : "Add to watchlist"}
      className={`inline-flex items-center gap-1 px-2 py-1 rounded-md border font-mono text-[10.5px] font-bold tracking-[0.3px] transition-colors ${
        isWatched
          ? "bg-emerald-400/[0.12] border-emerald-400/30 text-emerald-400"
          : "border-[1.5px] border-[var(--ink)] text-[var(--ink-3)] hover:text-[var(--emerald-text)] hover:border-[var(--emerald)]"
      }`}
      style={isWatched ? {} : { background: "var(--paper)" }}
      {...rest}
    >
      <Bookmark className="h-3 w-3" />
      <span className="hidden sm:inline">
        {isWatched ? `In ${memberCount}` : "Watch"}
      </span>
    </button>
  );
});
import { ViewToggle, useScreenerView } from "@/components/screener/ViewToggle";
import {
  AdvancedFiltersToggle,
  useAdvancedFilters,
} from "@/components/screener/AdvancedFiltersToggle";
import {
  FundSortDirectionButton,
  FundSortKeyDropdown,
  type FundSortKey,
} from "@/components/screener/FundSortDropdown";
import { type ResultsColumn } from "@/components/screener/ResultsTableShell";
import type { EtfScreenFilters, EtfScreenResult } from "@/lib/actions/screener";

const PAGE_SIZE = 25;

const ETF_COLUMNS: ResultsColumn[] = [
  { key: "select", label: "", align: "left" },
  { key: "ticker", label: "Ticker", align: "left" },
  { key: "exch", label: "Exch", align: "left" },
  { key: "ltp", label: "NAV", align: "right" },
  { key: "chg", label: "Δ", align: "right" },
  {
    key: "r1y",
    label: "1Y",
    align: "right",
    responsive: "hidden sm:table-cell",
  },
  { key: "aum", label: "AUM", align: "right" },
  {
    key: "exp",
    label: "Exp",
    align: "right",
    responsive: "hidden md:table-cell",
  },
  {
    key: "class",
    label: "Class",
    align: "left",
    responsive: "hidden lg:table-cell",
  },
  { key: "match", label: "Match", align: "right" },
  { key: "actions", label: "Actions", align: "right" },
];

const ASSET_CLASS_OPTIONS = [
  "equity",
  "debt",
  "hybrid",
  "solution",
  "other",
] as const;
const ASSET_CLASS_LABELS: Record<(typeof ASSET_CLASS_OPTIONS)[number], string> =
  {
    equity: "Equity",
    debt: "Debt",
    hybrid: "Hybrid",
    solution: "Solution",
    other: "Other",
  };

interface EtfModeProps {
  filters: EtfScreenFilters;
  onFiltersChange: (filters: EtfScreenFilters) => void;
  /** Rows for the current page - already sorted + sliced server-side. */
  results: EtfScreenResult[];
  total: number;
  page: number;
  onPageChange: (next: number) => void;
  sort: string;
  onSortChange: (next: string) => void;
  loading?: boolean;
  /** Switch to a different screener mode - wired to the Type segment in
   *  FundFilterSidebar so "Mutual Funds" actually flips to the MF tab. */
  onModeChange?: (next: "stocks" | "mf" | "etf") => void;
  /** Selection state lifted to the screener client. */
  selected: Set<string>;
  setSelected: (
    update: Set<string> | ((prev: Set<string>) => Set<string>)
  ) => void;
  /** How many MFs the user has currently selected (cap is global). */
  otherSelectedCount?: number;
}

// ── Formatters ────────────────────────────────────────────────────

function formatPct(v: number | null, withSign = true): string {
  if (v == null || !Number.isFinite(v)) return "-";
  const sign = withSign && v >= 0 ? "+" : "";
  return `${sign}${v.toFixed(2)}%`;
}

function formatAum(cr: number | null): string {
  if (cr == null || !Number.isFinite(cr)) return "-";
  if (cr >= 100_000) return `₹${(cr / 100_000).toFixed(1)}T`;
  if (cr >= 1_000) return `₹${(cr / 1_000).toFixed(1)}k Cr`;
  return `₹${cr.toFixed(0)} Cr`;
}

function formatInr(v: number | null): string {
  if (v == null || !Number.isFinite(v)) return "-";
  return `₹${v.toLocaleString("en-IN", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}

function formatExpense(v: number | null): string {
  if (v == null || !Number.isFinite(v)) return "-";
  return `${v.toFixed(2)}%`;
}

function rangeSummary(
  min: number | undefined,
  max: number | undefined,
  prefix = "",
  suffix = ""
): string {
  if (min != null && max != null)
    return `${prefix}${min}${suffix} – ${prefix}${max}${suffix}`;
  if (min != null) return `> ${prefix}${min}${suffix}`;
  if (max != null) return `< ${prefix}${max}${suffix}`;
  return "Any";
}

function countActive(f: EtfScreenFilters): number {
  let n = 0;
  if (f.exchange) n++;
  if (f.assetClass) n++;
  if (f.theme && f.theme.trim().length > 0) n++;
  if (f.minAum != null || f.maxAum != null) n++;
  if (f.minReturns1Y != null || f.maxReturns1Y != null) n++;
  if (f.minExpenseRatio != null || f.maxExpenseRatio != null) n++;
  return n;
}

// ── Component ─────────────────────────────────────────────────────

export function EtfMode({
  filters,
  onFiltersChange,
  results,
  total,
  page,
  onPageChange,
  sort,
  onSortChange,
  loading = false,
  onModeChange,
  selected,
  setSelected,
  otherSelectedCount = 0,
}: EtfModeProps) {
  const router = useRouter();
  // ETF mode now uses the unified `FundFilterSidebar`, so `onModeChange`
  // is wired through the Type segment to flip back to MF / stocks.
  const [view, setView] = useScreenerView("screener.view.etf", "cards");
  const [advancedOpen, setAdvancedOpen] = useAdvancedFilters(
    "screener.advanced.etf",
    false
  );
  // Session-only flag so the mobile filter MODAL never auto-opens from the
  // persisted `advancedOpen` value on navigation (#97). Desktop left column
  // keeps keying off `advancedOpen` alone.
  const [filtersInteracted, setFiltersInteracted] = useState(false);
  // `selected` + `setSelected` come from the screener client so MF +
  // ETF picks accumulate across tabs.
  function toggleSelect(id: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
      } else if (next.size + otherSelectedCount < MAX_COMPARE_ITEMS) {
        next.add(id);
      }
      return next;
    });
  }

  // Server-side sort + slice - render `results` verbatim. Pagination
  // math here is for the footer ("Showing 1–25 of N").
  const pageRows = results;
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const clampedPage = Math.min(page, totalPages - 1);
  const startIdx = total === 0 ? 0 : clampedPage * PAGE_SIZE + 1;
  const endIdx = Math.min((clampedPage + 1) * PAGE_SIZE, total);

  const update = (patch: Partial<EtfScreenFilters>) =>
    onFiltersChange({ ...filters, ...patch });

  const summaries = useMemo(
    () => ({
      exchange: filters.exchange ?? "Any",
      assetClass: filters.assetClass
        ? (ASSET_CLASS_LABELS[
            filters.assetClass as keyof typeof ASSET_CLASS_LABELS
          ] ?? filters.assetClass)
        : "Any",
      theme:
        filters.theme && filters.theme.trim().length > 0
          ? `"${filters.theme}"`
          : "Any",
      aum: rangeSummary(filters.minAum, filters.maxAum, "₹", " Cr"),
      r1y: rangeSummary(filters.minReturns1Y, filters.maxReturns1Y, "", "%"),
      exp: rangeSummary(
        filters.minExpenseRatio,
        filters.maxExpenseRatio,
        "",
        "%"
      ),
    }),
    [filters]
  );

  return (
    <div className="flex flex-col gap-3">
      {/* Sticky toolbar - pinned to the top so the count + filters
          stay visible while the user scrolls the result list. */}
      <div className="sticky top-[var(--topbar-h,0px)] z-20 -mx-6 px-6 pt-2 pb-2 bg-[var(--paper)]/95 backdrop-blur supports-[backdrop-filter]:bg-[var(--paper)]/80 border-b border-[var(--rule-soft)]">
        {/* Status row - same pattern as stocks-mode (image #29). */}
        <div className="flex items-center gap-2 mb-2 min-w-0">
          <span className="pf-pill emerald shrink-0 whitespace-nowrap">
            {total.toLocaleString("en-IN")} ETFs
          </span>
          <span className="mono text-[11px] text-[var(--ink-3)] truncate">
            {countActive(filters) === 0
              ? "Showing all — apply filters to narrow"
              : `${countActive(filters)} filter${countActive(filters) === 1 ? "" : "s"} active`}
          </span>
          {loading && (
            <span className="mono text-[10px] text-[var(--emerald-text)] animate-pulse inline-flex items-center gap-1">
              <span className="h-1.5 w-1.5 rounded-full bg-[var(--emerald)] animate-pulse" />
              fetching results…
            </span>
          )}
        </div>

        {/* Toolbar - split sort (direction + axis) at every breakpoint
            so funds match the stocks toolbar pattern (image #74). */}
        <div
          className="flex items-center gap-2 mb-2 flex-wrap"
          data-walkthrough="screener-etf-filters"
        >
          <AdvancedFiltersToggle
            open={advancedOpen}
            onChange={(next) => {
              setFiltersInteracted(true);
              setAdvancedOpen(next);
            }}
            activeCount={countActive(filters)}
          />
          <div className="ml-auto flex items-center gap-1.5">
            <FundSortDirectionButton
              value={sort as FundSortKey}
              onChange={(next) => onSortChange(next)}
            />
            <FundSortKeyDropdown
              value={sort as FundSortKey}
              onChange={(next) => onSortChange(next)}
              fields={["match", "ret1y", "nav", "aum"]}
            />
          </div>
          <div className="shrink-0">
            <ViewToggle value={view} onChange={setView} />
          </div>
        </div>
      </div>

      {/* Body: advanced filter sidebar on the LEFT, cards on the
          RIGHT. The sidebar shrinks the results column on lg+. */}
      <div className="flex flex-col lg:flex-row gap-6">
        {/* Left-column sidebar (desktop) - unified across MF + ETF tabs.
            Type segment flips screener mode; ETF-specific filters
            (Exchange / Asset class / Theme) render only on this tab. */}
        {advancedOpen && (
          <div className="hidden lg:block lg:w-[320px] shrink-0 order-1">
            <FundFilterSidebar
              variant="column"
              type="etf"
              onTypeChange={(next) => {
                if (next === "mf") onModeChange?.("mf");
                // "etf" - already on this tab, no-op
              }}
              etfFilters={filters}
              onEtfFiltersChange={onFiltersChange}
              onResetAll={
                countActive(filters) > 0
                  ? () => onFiltersChange({} as EtfScreenFilters)
                  : undefined
              }
            />
          </div>
        )}

        {/* Cards / table column - right, takes flex-1 */}
        <div className="flex-1 min-w-0 order-2">
          {/* MONEY-558: results + pagination live in ONE bordered box
              (mirrors the research-list pattern in app/analysis/client.tsx)
              so the page controls always stay WITHIN the container in both
              card and table views — no chips floating past the box edge. */}
          <div
            className="pf-card"
            style={{ padding: 0, overflow: "hidden" }}
            data-walkthrough="screener-etf-results"
          >
            {/* MONEY-392: full skeleton on every filter/sort/page change. */}
            {loading ? (
              <div style={{ padding: 16 }}>
                <ResultsSkeleton view={view} />
              </div>
            ) : view === "cards" ? (
              pageRows.length === 0 ? (
                <div style={{ padding: 16 }}>
                  <EmptyState
                    icon={SlidersHorizontal}
                    title="No ETFs match"
                    description="Try a different asset class or widen the AUM range."
                    muted
                    card={false}
                    action={
                      countActive(filters) > 0
                        ? {
                            label: "Reset filters",
                            onClick: () =>
                              onFiltersChange({} as EtfScreenFilters),
                          }
                        : undefined
                    }
                  />
                </div>
              ) : (
                <div
                  className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-3 gap-3"
                  style={{ padding: 16 }}
                >
                  {pageRows.map((r) => (
                    <FundCardCompact
                      key={`${r.symbol}|${r.exchange}`}
                      fund={{ kind: "ETF", row: r }}
                      selected={selected.has(r.symbol)}
                      onToggleSelect={toggleSelect}
                    />
                  ))}
                </div>
              )
            ) : (
              <div style={{ overflowX: "auto" }}>
                <table className="pf-tbl">
                  <thead>
                    <tr>
                      {ETF_COLUMNS.map((col, idx) => (
                        <th
                          key={col.key}
                          className={col.responsive ?? undefined}
                          style={{
                            textAlign: col.align === "right" ? "right" : "left",
                            paddingLeft: idx === 0 ? 16 : undefined,
                          }}
                        >
                          {col.label}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {pageRows.length === 0 ? (
                      <tr>
                        <td
                          colSpan={ETF_COLUMNS.length}
                          style={{ padding: "40px 16px" }}
                        >
                          <EmptyState
                            icon={SlidersHorizontal}
                            title="No ETFs match"
                            description="Loosen your filters or try a different asset class."
                            muted
                            card={false}
                            action={
                              countActive(filters) > 0
                                ? {
                                    label: "Reset filters",
                                    onClick: () =>
                                      onFiltersChange({} as EtfScreenFilters),
                                  }
                                : undefined
                            }
                          />
                        </td>
                      </tr>
                    ) : (
                      pageRows.map((r) => (
                        <EtfTableRow
                          key={`${r.symbol}|${r.exchange}`}
                          row={r}
                          selected={selected.has(r.symbol)}
                          canSelect={
                            selected.has(r.symbol) ||
                            selected.size + otherSelectedCount <
                              MAX_COMPARE_ITEMS
                          }
                          onToggleSelect={() => toggleSelect(r.symbol)}
                        />
                      ))
                    )}
                  </tbody>
                </table>
              </div>
            )}

            {/* Pagination — pinned to the bottom of the same box,
                separated by a top rule like the research-list footer. */}
            {total > PAGE_SIZE && (
              <div
                style={{
                  borderTop: "1.5px solid var(--rule-soft)",
                  padding: "4px 16px 12px",
                }}
              >
                <ScreenerPagination
                  startIdx={startIdx}
                  endIdx={endIdx}
                  total={total}
                  page={clampedPage}
                  totalPages={totalPages}
                  onPageChange={onPageChange}
                />
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Compare bar lives at the screener client level so MF + ETF
          selections share one batch - see ScreenerFundsCompareBar in
          ./client.tsx. */}

      {/* Mobile bottom sheet - flipped open by AdvancedFiltersToggle.
          Hidden on lg+, where the right column sidebar shows instead. */}
      {advancedOpen && filtersInteracted && (
        <div className="lg:hidden fixed inset-0 z-[60] flex items-end">
          <button
            type="button"
            aria-label="Close filters"
            onClick={() => setAdvancedOpen(false)}
            className="absolute inset-0 bg-black/50 cursor-pointer"
          />
          <div
            className="relative w-full bg-[var(--paper)] rounded-t-[22px] max-h-[85vh] flex flex-col animate-in slide-in-from-bottom duration-200"
            style={{ border: "2px solid var(--ink)", borderBottom: 0 }}
          >
            <div className="py-2.5 grid place-items-center">
              <div
                style={{
                  width: 50,
                  height: 4,
                  borderRadius: 999,
                  background: "var(--ink-3)",
                }}
              />
            </div>
            <div
              className="sticky top-0 z-10 flex items-center px-4 py-3 bg-[var(--paper)]"
              style={{ borderBottom: "2px solid var(--ink)" }}
            >
              <span className="mono text-[11px] tracking-[1.5px] uppercase font-bold text-[var(--ink-2)]">
                ETF filters
              </span>
              <button
                type="button"
                onClick={() => setAdvancedOpen(false)}
                className="pf-bf sm ml-auto"
              >
                Close
              </button>
            </div>
            <div className="overflow-y-auto p-4 pb-[calc(1.5rem+env(safe-area-inset-bottom,0px))]">
              <FundFilterSidebar
                variant="panel"
                type="etf"
                onTypeChange={(next) => {
                  if (next === "mf") onModeChange?.("mf");
                }}
                etfFilters={filters}
                onEtfFiltersChange={onFiltersChange}
                onResetAll={
                  countActive(filters) > 0
                    ? () => onFiltersChange({} as EtfScreenFilters)
                    : undefined
                }
              />
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ── Helpers (mirror stocks-mode.tsx + mf-mode.tsx) ────────────────

function RadioRow({
  options,
  value,
  onChange,
  labels,
  allLabel = "Any",
}: {
  options: readonly string[];
  value: string | null;
  onChange: (v: string | null) => void;
  labels?: Record<string, string>;
  allLabel?: string;
}) {
  const ButtonClass = (active: boolean) =>
    `px-2.5 py-1.5 rounded text-[11.5px] font-medium transition-colors cursor-pointer ${
      active
        ? "bg-emerald-400/10 text-emerald-400 border border-emerald-400/25"
        : "bg-transparent text-[var(--ink-3)] border border-[var(--rule-soft)] hover:text-[var(--ink)] hover:border-[var(--ink)]"
    }`;
  return (
    <div className="flex flex-wrap gap-1.5">
      <button
        onClick={() => onChange(null)}
        className={ButtonClass(value == null)}
      >
        {allLabel}
      </button>
      {options.map((o) => (
        <button
          key={o}
          onClick={() => onChange(o)}
          className={ButtonClass(value === o)}
        >
          {labels?.[o] ?? o}
        </button>
      ))}
    </div>
  );
}

function RangeInputs({
  min,
  max,
  onChange,
  suffix,
}: {
  min: number | undefined;
  max: number | undefined;
  onChange: (min: number | undefined, max: number | undefined) => void;
  suffix?: string;
}) {
  const handle =
    (which: "min" | "max") => (e: React.ChangeEvent<HTMLInputElement>) => {
      const raw = e.target.value;
      const parsed = raw === "" ? undefined : Number(raw);
      const next = Number.isFinite(parsed) ? parsed : undefined;
      if (which === "min") onChange(next, max);
      else onChange(min, next);
    };
  const InputClass =
    "w-full border-[1.5px] border-[var(--ink)] rounded-[7px] px-2 py-1.5 text-[12px] text-[var(--ink)] font-mono tabular-nums focus:outline-none focus:border-[var(--emerald)] transition-colors";
  return (
    <div className="flex items-center gap-2 text-[11px]">
      <input
        type="number"
        value={min ?? ""}
        onChange={handle("min")}
        placeholder={`Min${suffix ? ` (${suffix})` : ""}`}
        className={InputClass}
        style={{ background: "var(--paper)" }}
      />
      <span className="text-[var(--ink-3)]">–</span>
      <input
        type="number"
        value={max ?? ""}
        onChange={handle("max")}
        placeholder={`Max${suffix ? ` (${suffix})` : ""}`}
        className={InputClass}
        style={{ background: "var(--paper)" }}
      />
    </div>
  );
}

/* CSV export for the ETF bulk-action toolbar - mirrors the stocks-mode
   CSV builder layout. */
function downloadEtfCsv(
  rows: readonly EtfScreenResult[],
  selected: ReadonlySet<string>
): void {
  const picked = rows.filter((r) => selected.has(r.symbol));
  if (picked.length === 0) return;
  const header = [
    "symbol",
    "exchange",
    "name",
    "ltp",
    "changePercent",
    "aum",
    "expenseRatio",
    "returns1Y",
    "matchScore",
  ];
  const lines = [header.join(",")];
  for (const r of picked) {
    lines.push(
      [
        r.symbol,
        r.exchange,
        `"${(r.name ?? "").replace(/"/g, '""')}"`,
        r.ltp ?? "",
        r.changePercent ?? "",
        r.aum ?? "",
        r.expenseRatio ?? "",
        r.returns1Y ?? "",
        r.matchScore,
      ].join(",")
    );
  }
  const csv = lines.join("\n");
  const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  const stamp = new Date().toISOString().slice(0, 16).replace(/[:T-]/g, "");
  a.href = url;
  a.download = `screener-etf-${stamp}.csv`;
  a.click();
  URL.revokeObjectURL(url);
}

export default EtfMode;

// ──────────────────────────────────────────────────────────────────
// Table row - extracted for per-row ResearchModal state.
// ──────────────────────────────────────────────────────────────────
function EtfTableRow({
  row,
  selected,
  canSelect,
  onToggleSelect,
}: {
  row: EtfScreenResult;
  selected: boolean;
  canSelect: boolean;
  onToggleSelect: () => void;
}) {
  const router = useRouter();
  const [researchOpen, setResearchOpen] = useState(false);
  return (
    <tr
      className="cursor-pointer"
      onClick={() =>
        // MONEY-457: ETF rows route to the dedicated /etf/[symbol] detail page
        // (fund-shaped UX) instead of /stock/[symbol] (OHLC/PE-shaped, wrong
        // for funds). MONEY-1205: through the shared resolver, so this tile and
        // every other link site cannot drift apart again.
        router.push(
          instrumentDetailHref({
            symbol: row.symbol,
            exchange: row.exchange,
            instrumentType: "ETF",
          })
        )
      }
    >
      <td style={{ width: 32 }} onClick={(e) => e.stopPropagation()}>
        <input
          type="checkbox"
          aria-label={`Select ${row.symbol}`}
          checked={selected}
          disabled={!canSelect}
          onChange={onToggleSelect}
          className="h-3.5 w-3.5 accent-emerald-400 cursor-pointer disabled:opacity-30 disabled:cursor-not-allowed"
        />
      </td>
      <td style={{ paddingLeft: 16 }}>
        <span className="tk" style={{ color: "var(--emerald-text)" }}>
          {row.symbol}
        </span>
        <div
          className="nm truncate max-w-[260px]"
          style={{ fontSize: 10, marginTop: 2 }}
        >
          {row.name}
        </div>
      </td>
      <td>
        <span
          className="pf-pill outline"
          style={{
            fontSize: 9.5,
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
      </td>
      <td
        className="num"
        style={{ textAlign: "right", color: "var(--ink)", fontWeight: 700 }}
      >
        {formatInr(row.ltp)}
      </td>
      <td
        className={`num ${(row.changePercent ?? 0) >= 0 ? "pos" : "neg"}`}
        style={{ textAlign: "right" }}
      >
        {formatPct(row.changePercent)}
      </td>
      <td
        className={`num hidden sm:table-cell ${(row.returns1Y ?? 0) >= 0 ? "pos" : "neg"}`}
        style={{ textAlign: "right" }}
      >
        {formatPct(row.returns1Y, false)}
      </td>
      <td className="num" style={{ textAlign: "right", color: "var(--ink-2)" }}>
        {formatAum(row.aum)}
      </td>
      <td
        className="num hidden md:table-cell"
        style={{ textAlign: "right", color: "var(--ink-3)" }}
      >
        {formatExpense(row.expenseRatio)}
      </td>
      <td className="hidden lg:table-cell" style={{ color: "var(--ink-3)" }}>
        {row.assetClass
          ? (ASSET_CLASS_LABELS[
              row.assetClass as keyof typeof ASSET_CLASS_LABELS
            ] ?? row.assetClass)
          : "-"}
      </td>
      <td style={{ textAlign: "right" }}>
        <MatchScoreBar score={row.matchScore} />
      </td>
      <td style={{ textAlign: "right" }} onClick={(e) => e.stopPropagation()}>
        <div className="inline-flex items-center gap-1">
          {/* MONEY-558: StockSage ETF analyse — restored to match the MF
              table action (and the ETF card, which always had it). Opens
              the ResearchModal (mounted below) with type: "etf" so the
              research flow runs for this ETF and routes to
              /analysis/[sessionId]. Uses the playful `pf-bf sm` treatment
              so it matches the card's Analyse button rather than the faint
              emerald wash used before. */}
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              setResearchOpen(true);
            }}
            className="pf-bf sm"
            style={{ padding: "4px 8px", fontSize: 10.5 }}
            title={`Analyse ${row.symbol}`}
          >
            <Sparkles className="h-3 w-3" />
            <span className="hidden sm:inline">Analyse</span>
          </button>
          <WatchlistPopover
            target={{
              symbol: row.symbol,
              exchange: row.exchange,
              kind: "STOCK",
            }}
            displayKind="ETF"
            trigger={<WatchlistIconTrigger />}
          />
        </div>
        {researchOpen && (
          <ResearchModal
            open={researchOpen}
            onOpenChange={setResearchOpen}
            entity={{
              symbol: row.symbol,
              name: row.name || row.symbol,
              type: "etf",
              exchange: row.exchange,
            }}
          />
        )}
      </td>
    </tr>
  );
}
