"use client";

/**
 * Mutual Funds mode - fundamental screener over MutualFundMaster (MONEY-196).
 *
 * Filters: Category, AMC, Plan (Direct/Regular), Risk, Fund type, AUM,
 *          1Y / 3Y / 5Y returns, Expense ratio
 * Columns: SCHEME / AMC / NAV / 1Y Δ / 3Y Δ / 5Y Δ / AUM / EXP / MATCH
 * Row action: navigate to `/mf/{schemeCode}`
 * Bulk action (top toolbar): "→ Compare"
 *
 * Mirrors the layout + density of `stocks-mode.tsx`, but with MF-specific
 * filter cards and table columns. Reuses the shared FilterSidebar /
 * FilterCard / ResultsTableShell / MatchScoreBar widgets - those are mode-
 * agnostic.
 */

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { ScreenerPagination } from "@/components/screener/ScreenerPagination";
import { ResultsSkeleton } from "@/components/screener/ResultsSkeleton";
import { MatchScoreBar } from "@/components/screener/MatchScoreBar";
import { type ResultsColumn } from "@/components/screener/ResultsTableShell";
import { FundCardCompact } from "@/components/screener/FundCardCompact";
import { MAX_COMPARE_ITEMS } from "@/lib/compare/schema";
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
import { FundFilterSidebar } from "@/components/screener/FundFilterSidebar";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@usemoney/ui/select";
import type { MfScreenFilters, MfScreenResult } from "@/lib/actions/screener";
import React from "react";
import { Sparkles, Bookmark, SlidersHorizontal } from "lucide-react";
import ResearchModal from "@/components/analysis/ResearchModal";
import { WatchlistPopover } from "@/components/watchlist/WatchlistPopover";
import { EmptyState } from "@/components/empty/EmptyState";

/**
 * MONEY-457: labelled "+ Watch" trigger in the MF table actions column.
 * Now that the Analyse button is hidden, the watchlist icon was the
 * lone action in the cell and read as decorative. The labelled variant
 * (matches the card view's `WatchInlineTrigger` UX) makes the action
 * obvious and surfaces the watchlist member count when set.
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

const PAGE_SIZE = 25;

const MF_COLUMNS: ResultsColumn[] = [
  { key: "select", label: "", align: "left" },
  { key: "scheme", label: "Scheme", align: "left" },
  {
    key: "amc",
    label: "AMC",
    align: "left",
    responsive: "hidden md:table-cell",
  },
  { key: "nav", label: "NAV", align: "right" },
  { key: "r1y", label: "1Y Δ", align: "right" },
  {
    key: "r3y",
    label: "3Y Δ",
    align: "right",
    responsive: "hidden sm:table-cell",
  },
  {
    key: "r5y",
    label: "5Y Δ",
    align: "right",
    responsive: "hidden lg:table-cell",
  },
  { key: "aum", label: "AUM", align: "right" },
  {
    key: "exp",
    label: "Exp",
    align: "right",
    responsive: "hidden sm:table-cell",
  },
  { key: "match", label: "Match", align: "right" },
  { key: "actions", label: "Actions", align: "right" },
];

export interface MfFilterOptions {
  /** Categories with counts - sourced from getMfDiscoverDataAction. */
  categories: ReadonlyArray<{ name: string; count: number }>;
  /** AMC names ordered by frequency desc. */
  amcList: readonly string[];
}

interface MfModeProps {
  filters: MfScreenFilters;
  onFiltersChange: (filters: MfScreenFilters) => void;
  /** Rows for the current page - already sorted + sliced by the server. */
  results: MfScreenResult[];
  total: number;
  page: number;
  onPageChange: (next: number) => void;
  sort: string;
  onSortChange: (next: string) => void;
  loading?: boolean;
  options: MfFilterOptions;
  /** Switch to a different screener mode - wired to the Type segment in
   *  FundFilterSidebar so "ETFs" actually flips to the ETF tab. */
  onModeChange?: (next: "stocks" | "mf" | "etf") => void;
  /** Selection state lifted to the screener client so MF + ETF picks
   *  share one Compare batch. */
  selected: Set<string>;
  setSelected: (
    update: Set<string> | ((prev: Set<string>) => Set<string>)
  ) => void;
  /** How many ETFs the user has currently selected (cap is global). */
  otherSelectedCount?: number;
}

const PLAN_OPTIONS = ["DIRECT", "REGULAR"] as const;
const RISK_OPTIONS = ["Low", "Moderate", "High", "Very High"] as const;
const FUND_TYPE_OPTIONS = [
  "equity",
  "debt",
  "hybrid",
  "solution",
  "other",
] as const;
const FUND_TYPE_LABELS: Record<(typeof FUND_TYPE_OPTIONS)[number], string> = {
  equity: "Equity",
  debt: "Debt",
  hybrid: "Hybrid",
  solution: "Solution",
  other: "Other",
};

// ── Formatters ────────────────────────────────────────────────────

function formatPct(v: number | null, withSign = true): string {
  if (v == null || !Number.isFinite(v)) return "-";
  const sign = withSign && v >= 0 ? "+" : "";
  return `${sign}${v.toFixed(1)}%`;
}

function formatAum(cr: number | null): string {
  if (cr == null || !Number.isFinite(cr)) return "-";
  if (cr >= 100_000) return `₹${(cr / 100_000).toFixed(1)}T`;
  if (cr >= 1_000) return `₹${(cr / 1_000).toFixed(1)}k Cr`;
  return `₹${cr.toFixed(0)} Cr`;
}

function formatNav(nav: number): string {
  return `₹${nav.toLocaleString("en-IN", {
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

function countActive(f: MfScreenFilters): number {
  let n = 0;
  if (f.category) n++;
  if (f.amcName || (f.amcAny && f.amcAny.length > 0)) n++;
  if (f.plan) n++;
  if (f.riskLevel) n++;
  if (f.fundType) n++;
  if (f.minAum != null || f.maxAum != null) n++;
  if (f.minReturns1Y != null || f.maxReturns1Y != null) n++;
  if (f.minReturns3Y != null || f.maxReturns3Y != null) n++;
  if (f.minReturns5Y != null || f.maxReturns5Y != null) n++;
  if (f.minExpenseRatio != null || f.maxExpenseRatio != null) n++;
  return n;
}

// ── Component ─────────────────────────────────────────────────────

export function MfMode({
  filters,
  onFiltersChange,
  results,
  total,
  page,
  onPageChange,
  sort,
  onSortChange,
  loading = false,
  options,
  onModeChange,
  selected,
  setSelected,
  otherSelectedCount = 0,
}: MfModeProps) {
  const router = useRouter();
  const handleTypeChange = (next: "mf" | "etf") => {
    if (!onModeChange) return;
    if (next === "etf") onModeChange("etf");
    // "mf" - already on this tab, no-op
  };
  const [view, setView] = useScreenerView("screener.view.mf", "cards");
  const [advancedOpen, setAdvancedOpen] = useAdvancedFilters(
    "screener.advanced.mf",
    false
  );
  // The mobile filter MODAL must never auto-open from the persisted
  // `advancedOpen` localStorage value (that persistence is for the desktop
  // left column). This session-only flag stays false until the user taps the
  // toggle, so navigating to the screener never pops the sheet open (#97).
  const [filtersInteracted, setFiltersInteracted] = useState(false);
  // `selected` + `setSelected` are now passed in from the screener
  // client so MF + ETF picks accumulate across tabs.
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

  const update = (patch: Partial<MfScreenFilters>) =>
    onFiltersChange({ ...filters, ...patch });

  const summaries = useMemo(
    () => ({
      category: filters.category ?? "Any",
      amc:
        filters.amcAny && filters.amcAny.length > 0
          ? filters.amcAny.length === 1
            ? filters.amcAny[0]!
            : `${filters.amcAny.length} AMCs`
          : (filters.amcName ?? "Any"),
      plan: filters.plan ?? "Any",
      risk: filters.riskLevel ?? "Any",
      fundType: filters.fundType
        ? (FUND_TYPE_LABELS[
            filters.fundType as keyof typeof FUND_TYPE_LABELS
          ] ?? filters.fundType)
        : "Any",
      aum: rangeSummary(filters.minAum, filters.maxAum, "₹", " Cr"),
      r1y: rangeSummary(filters.minReturns1Y, filters.maxReturns1Y, "", "%"),
      r3y: rangeSummary(filters.minReturns3Y, filters.maxReturns3Y, "", "%"),
      r5y: rangeSummary(filters.minReturns5Y, filters.maxReturns5Y, "", "%"),
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
      {/* Sticky toolbar - pinned to the top so the count, view toggle,
          and sort stay visible while the user scrolls the result list. */}
      <div className="sticky top-[var(--topbar-h,0px)] z-20 -mx-6 px-6 pt-2 pb-2 bg-[var(--paper)]/95 backdrop-blur supports-[backdrop-filter]:bg-[var(--paper)]/80 border-b border-[var(--rule-soft)]">
        {/* Status row - match count + filter copy. */}
        <div className="flex items-center gap-2 mb-2 min-w-0">
          <span className="pf-pill emerald shrink-0 whitespace-nowrap">
            {total.toLocaleString("en-IN")} matches
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

        {/* Toolbar - split sort (Most/Least direction + axis dropdown)
            mirrors stocks-mode at every breakpoint per user direction
            (image #74). Wraps on small screens so labels don't crash. */}
        <div
          className="flex items-center gap-2 mb-2 flex-wrap"
          data-walkthrough="screener-mf-filters"
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
            />
          </div>
          <div className="shrink-0">
            <ViewToggle value={view} onChange={setView} />
          </div>
        </div>
      </div>

      {/* Body: advanced filter sidebar on the LEFT, cards on the
          RIGHT. The sidebar shrinks the results column on lg+;
          on mobile the sidebar opens as a bottom sheet (rendered
          outside the side-by-side layout). */}
      <div className="flex flex-col lg:flex-row gap-6">
        <div className="flex-1 min-w-0 order-2">
          {/* MONEY-558: results + pagination live in ONE bordered box
              (mirrors the research-list pattern in app/analysis/client.tsx)
              so the page controls always stay WITHIN the container in both
              card and table views — no chips floating past the box edge. */}
          <div
            className="pf-card"
            style={{ padding: 0, overflow: "hidden" }}
            data-walkthrough="screener-mf-results"
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
                    title="No funds match"
                    description="Try a different category, wider AUM range, or remove the returns filter."
                    muted
                    card={false}
                    action={
                      countActive(filters) > 0
                        ? {
                            label: "Reset filters",
                            onClick: () =>
                              onFiltersChange({} as MfScreenFilters),
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
                      key={r.schemeCode}
                      fund={{ kind: "MF", row: r }}
                      selected={selected.has(r.schemeCode)}
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
                      {MF_COLUMNS.map((col, idx) => (
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
                          colSpan={MF_COLUMNS.length}
                          style={{ padding: "40px 16px" }}
                        >
                          <EmptyState
                            icon={SlidersHorizontal}
                            title="No funds match"
                            description="Loosen your filters or try a different category."
                            muted
                            card={false}
                            action={
                              countActive(filters) > 0
                                ? {
                                    label: "Reset filters",
                                    onClick: () =>
                                      onFiltersChange({} as MfScreenFilters),
                                  }
                                : undefined
                            }
                          />
                        </td>
                      </tr>
                    ) : (
                      pageRows.map((r) => (
                        <MfTableRow
                          key={r.schemeCode}
                          row={r}
                          selected={selected.has(r.schemeCode)}
                          canSelect={
                            selected.has(r.schemeCode) ||
                            selected.size + otherSelectedCount <
                              MAX_COMPARE_ITEMS
                          }
                          onToggleSelect={() => toggleSelect(r.schemeCode)}
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

        {/* Advanced filter sidebar (left column, desktop only). On
            mobile the bottom sheet below renders instead. */}
        {advancedOpen && (
          <div className="hidden lg:block lg:w-[320px] shrink-0 order-1">
            <FundFilterSidebar
              variant="column"
              type="mf"
              onTypeChange={handleTypeChange}
              mfFilters={filters}
              onMfFiltersChange={onFiltersChange}
              categories={options.categories}
              amcList={options.amcList}
              onResetAll={
                countActive(filters) > 0
                  ? () => onFiltersChange({} as MfScreenFilters)
                  : undefined
              }
            />
          </div>
        )}
      </div>

      {/* Compare bar lives at the screener client level so MF + ETF
          selections share one batch - see ScreenerFundsCompareBar in
          ./client.tsx. */}

      {/* Mobile bottom sheet - the AdvancedFiltersToggle on the toolbar
          flips it open. Hidden on lg+, where the right column sidebar
          shows instead. */}
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
                Fund filters
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
                type="mf"
                onTypeChange={handleTypeChange}
                mfFilters={filters}
                onMfFiltersChange={onFiltersChange}
                categories={options.categories}
                amcList={options.amcList}
                onResetAll={
                  countActive(filters) > 0
                    ? () => onFiltersChange({} as MfScreenFilters)
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

// ── Helpers (mirror stocks-mode.tsx) ──────────────────────────────

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

/* CSV export for the MF bulk-action toolbar - mirrors the stocks-mode
   CSV builder layout (see BulkActionToolbar.tsx). */
function downloadMfCsv(
  rows: readonly MfScreenResult[],
  selected: ReadonlySet<string>
): void {
  const picked = rows.filter((r) => selected.has(r.schemeCode));
  if (picked.length === 0) return;
  const header = [
    "schemeCode",
    "schemeName",
    "amcName",
    "category",
    "plan",
    "nav",
    "returns1Y",
    "returns3Y",
    "returns5Y",
    "aum",
    "expenseRatio",
    "matchScore",
  ];
  const lines = [header.join(",")];
  for (const r of picked) {
    lines.push(
      [
        r.schemeCode,
        `"${(r.schemeName ?? "").replace(/"/g, '""')}"`,
        `"${(r.amcName ?? "").replace(/"/g, '""')}"`,
        `"${(r.category ?? "").replace(/"/g, '""')}"`,
        r.plan ?? "",
        r.nav ?? "",
        r.returns1Y ?? "",
        r.returns3Y ?? "",
        r.returns5Y ?? "",
        r.aum ?? "",
        r.expenseRatio ?? "",
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
  a.download = `screener-mf-${stamp}.csv`;
  a.click();
  URL.revokeObjectURL(url);
}

export default MfMode;

// ──────────────────────────────────────────────────────────────────
// Table row - extracted for per-row ResearchModal state (mirrors
// StocksTableRow). Each row lazy-mounts its own modal so 100s of
// rows don't fire the preference hooks on mount.
// ──────────────────────────────────────────────────────────────────
function MfTableRow({
  row,
  selected,
  canSelect,
  onToggleSelect,
}: {
  row: MfScreenResult;
  selected: boolean;
  canSelect: boolean;
  onToggleSelect: () => void;
}) {
  const router = useRouter();
  const [researchOpen, setResearchOpen] = useState(false);
  return (
    <tr
      className="cursor-pointer"
      onClick={() => router.push(`/mf/${row.schemeCode}`)}
    >
      <td style={{ width: 32 }} onClick={(e) => e.stopPropagation()}>
        <input
          type="checkbox"
          aria-label={`Select ${row.schemeName}`}
          checked={selected}
          disabled={!canSelect}
          onChange={onToggleSelect}
          className="h-3.5 w-3.5 accent-emerald-400 cursor-pointer disabled:opacity-30 disabled:cursor-not-allowed"
        />
      </td>
      <td style={{ paddingLeft: 16 }}>
        <div
          className="tk truncate max-w-[280px]"
          style={{ color: "var(--emerald-text)" }}
        >
          {row.schemeName}
        </div>
        <div className="nm mono" style={{ fontSize: 10, marginTop: 2 }}>
          {row.category}
          {row.plan ? ` · ${row.plan === "DIRECT" ? "Direct" : "Regular"}` : ""}
        </div>
      </td>
      <td
        className="hidden md:table-cell truncate max-w-[140px]"
        style={{ color: "var(--ink-3)" }}
      >
        {row.amcName}
      </td>
      <td
        className="num"
        style={{ textAlign: "right", color: "var(--ink)", fontWeight: 700 }}
      >
        {formatNav(row.nav)}
      </td>
      <td
        className={`num ${(row.returns1Y ?? 0) >= 0 ? "pos" : "neg"}`}
        style={{ textAlign: "right" }}
      >
        {formatPct(row.returns1Y)}
      </td>
      <td
        className={`num hidden sm:table-cell ${(row.returns3Y ?? 0) >= 0 ? "pos" : "neg"}`}
        style={{ textAlign: "right" }}
      >
        {formatPct(row.returns3Y)}
      </td>
      <td
        className={`num hidden lg:table-cell ${(row.returns5Y ?? 0) >= 0 ? "pos" : "neg"}`}
        style={{ textAlign: "right" }}
      >
        {formatPct(row.returns5Y)}
      </td>
      <td className="num" style={{ textAlign: "right", color: "var(--ink-2)" }}>
        {formatAum(row.aum)}
      </td>
      <td
        className="num hidden sm:table-cell"
        style={{ textAlign: "right", color: "var(--ink-3)" }}
      >
        {formatExpense(row.expenseRatio)}
      </td>
      <td style={{ textAlign: "right" }}>
        <MatchScoreBar score={row.matchScore} />
      </td>
      <td style={{ textAlign: "right" }} onClick={(e) => e.stopPropagation()}>
        <div className="inline-flex items-center gap-1">
          {/* MONEY-446: StockSage MF analyse — mirrors the stock screener
              table action. Opens the ResearchModal (mounted below) in MF
              mode, which forces the `mf-analysis` skill + `mf_analysis`
              credit estimate and routes to /analysis/[sessionId].
              MONEY-558: use the playful `pf-bf sm` treatment so the button
              matches the card's Analyse affordance (theme-aware ink/paper
              outline) instead of the faint emerald wash that didn't track
              the card. */}
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              setResearchOpen(true);
            }}
            className="pf-bf sm"
            style={{ padding: "4px 8px", fontSize: 10.5 }}
            title={`Analyse ${row.schemeName}`}
          >
            <Sparkles className="h-3 w-3" />
            <span className="hidden sm:inline">Analyse</span>
          </button>
          <WatchlistPopover
            target={{
              symbol: row.schemeCode,
              exchange: "MF",
              kind: "MF",
            }}
            displayKind="MF"
            trigger={<WatchlistIconTrigger />}
          />
        </div>
        {researchOpen && (
          <ResearchModal
            open={researchOpen}
            onOpenChange={setResearchOpen}
            entity={{
              symbol: row.schemeCode,
              name: row.schemeName,
              type: "mf",
            }}
          />
        )}
      </td>
    </tr>
  );
}
