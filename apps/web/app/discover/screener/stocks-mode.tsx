"use client";

/**
 * Stocks mode - fundamental screener (MONEY-196, primary mode).
 *
 * Filters: Exchange, Sector, Market cap bucket, P/E, ROE, Revenue growth YoY, Debt/Equity
 * Columns: TICKER / MCAP / P/E / ROE / REV Δ / D/E / LTP / MATCH
 * Row action: `/stock/{symbol}?exchange={exchange}`
 * Bulk action: "→ Watchlist"
 */

import React, { useCallback, useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { ScreenerPagination } from "@/components/screener/ScreenerPagination";
import { ResultsSkeleton } from "@/components/screener/ResultsSkeleton";
import { FilterSidebar } from "@/components/screener/FilterSidebar";
import { FilterCard } from "@/components/screener/FilterCard";
import { EmptyState } from "@/components/empty/EmptyState";
import { MatchScoreBar } from "@/components/screener/MatchScoreBar";
import { type ResultsColumn } from "@/components/screener/ResultsTableShell";
import { StockCardCompact } from "@/components/screener/StockCardCompact";
import { MAX_COMPARE_ITEMS } from "@/lib/compare/schema";
import { Sparkles, Bookmark, SlidersHorizontal } from "lucide-react";
import ResearchModal from "@/components/analysis/ResearchModal";
import { WatchlistPopover } from "@/components/watchlist/WatchlistPopover";

// Icon-only trigger used in dense table rows where the default
// "+ Watchlist" pill is too wide. Bookmark icon toggles to filled
// emerald when the row is already in at least one watchlist.
const WatchlistIconTrigger = React.forwardRef<
  HTMLButtonElement,
  React.ButtonHTMLAttributes<HTMLButtonElement>
>(function WatchlistIconTrigger(props, ref) {
  return (
    <button
      ref={ref}
      type="button"
      aria-label="Add to watchlist"
      title="Add to watchlist"
      className="inline-flex items-center justify-center w-7 h-7 rounded-[7px] border-[1.5px] border-[var(--ink)] text-[var(--ink-3)] hover:text-[var(--emerald-text)] hover:border-[var(--emerald)] transition-colors"
      style={{ background: "var(--paper)" }}
      {...props}
    >
      <Bookmark className="h-3.5 w-3.5" />
    </button>
  );
});
import { SectorChips } from "@/components/screener/SectorChips";
import { QuickFilterChips } from "@/components/screener/QuickFilterChips";
import { ViewToggle, useScreenerView } from "@/components/screener/ViewToggle";
import {
  AdvancedFiltersToggle,
  useAdvancedFilters,
} from "@/components/screener/AdvancedFiltersToggle";
import {
  SortDirectionButton,
  SortKeyDropdown,
  type SortKey,
} from "@/components/screener/SortDropdown";
import {
  UniverseSection,
  type ExchangeChoice,
} from "@/components/screener/UniverseSection";
import { SuggestedChips } from "@/components/screener/SuggestedChips";
import {
  SUGGESTED_FILTERS,
  deriveActiveFilterIds,
} from "@/components/screener/suggested-filters-logic";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@usemoney/ui/select";
import type {
  ScreenFilters,
  ScreenResult,
  MarketCapBucket,
} from "@/lib/actions/screener";

/** Rows per page in the results table. 25 gives a readable density at most
 *  viewport heights without making users scroll far before paginating.
 *  Mirrors the server-side default in `screener.ts`. */
export const PAGE_SIZE = 25;

const STOCKS_COLUMNS: ResultsColumn[] = [
  { key: "select", label: "", align: "left" },
  { key: "ticker", label: "Ticker", align: "left" },
  { key: "exch", label: "Exch", align: "left" },
  { key: "mcap", label: "MCap", align: "right" },
  { key: "pe", label: "P/E", align: "right" },
  { key: "roe", label: "ROE", align: "right" },
  {
    key: "rev",
    label: "Rev Δ",
    align: "right",
    responsive: "hidden md:table-cell",
  },
  {
    key: "de",
    label: "D/E",
    align: "right",
    responsive: "hidden sm:table-cell",
  },
  { key: "ltp", label: "LTP", align: "right" },
  { key: "match", label: "Match", align: "right" },
  { key: "actions", label: "Actions", align: "right" },
];

const MCAP_BUCKET_LABELS: Record<MarketCapBucket, string> = {
  LARGE: "Large cap · ₹20,000 Cr+",
  MID: "Mid cap · ₹5k–20k Cr",
  SMALL: "Small cap · < ₹5,000 Cr",
};

export interface SectorOption {
  name: string;
  count: number;
}

interface StocksModeProps {
  filters: ScreenFilters;
  onFiltersChange: (filters: ScreenFilters) => void;
  /** Rows for the current page (already sliced + sorted server-side). */
  results: ScreenResult[];
  /** Total matched-set size - drives the count badge and pagination range. */
  total: number;
  /** 0-indexed current page - owned by parent so refetch can target it. */
  page: number;
  onPageChange: (next: number) => void;
  /** Server-side sort key. Toggling re-runs the action. */
  sort: string;
  onSortChange: (next: string) => void;
  /** Whether a fetch is in flight - used to dim the results pane. */
  loading?: boolean;
  sectorOptions: readonly SectorOption[];
  /** Selection state lifted to the screener client (MONEY-553) so stocks join
   *  the SAME Compare batch as MFs + ETFs — enabling cross-asset compare. */
  selected: Set<string>;
  setSelected: (
    update: Set<string> | ((prev: Set<string>) => Set<string>)
  ) => void;
  /** How many non-stock items (MF + ETF) are selected — the 5-item cap is
   *  global across all asset types. */
  otherSelectedCount?: number;
}

/** Compact ₹ market cap formatter: "₹6.2T" / "₹14.8T" / "₹4.5T" / "₹67Cr". */
function formatMcap(cr: number | null): string {
  if (cr == null || !Number.isFinite(cr)) return "-";
  if (cr >= 100_000) return `₹${(cr / 100_000).toFixed(1)}T`; // lakh crore = trillion
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

export function StocksMode({
  filters,
  onFiltersChange,
  results,
  total,
  page,
  onPageChange,
  sort,
  onSortChange,
  loading = false,
  sectorOptions,
  selected,
  setSelected,
  otherSelectedCount = 0,
}: StocksModeProps) {
  const router = useRouter();
  // Controlled view state - owned here so toggling Cards/Table
  // re-renders the results pane immediately. The hook still persists
  // the choice to localStorage for next visit.
  const [view, setView] = useScreenerView("screener.view.stocks", "cards");
  // v3.2 default - Advanced filters are OFF on first load so the
  // cards reclaim the full row (matches design Image #50/#42 layout).
  // The user can flip the toggle to bring the FILTERS panel back; the
  // choice persists per-tab in localStorage so power users keep their
  // preference across visits.
  const [advancedOpen, setAdvancedOpen] = useAdvancedFilters(
    "screener.advanced.stocks",
    false
  );
  // Session-only flag so the mobile filter MODAL never auto-opens from the
  // persisted `advancedOpen` value on navigation (#97). The desktop left
  // column still keys off `advancedOpen` alone, preserving its persistence.
  const [filtersInteracted, setFiltersInteracted] = useState(false);

  /* MONEY-1246 / MONEY-1247 — "+ Add filter" and the SUGGESTED chips were
     both wired to empty callbacks, and every chip named a filter the sidebar
     was already showing. `openFilterId` drives the matching FilterCard open
     (the card is controlled only while it is the picked one), and
     `activeFilterIds` hides a chip once its filter actually has a value. */
  const [openFilterId, setOpenFilterId] = useState<string | null>(null);
  const [pickerOpen, setPickerOpen] = useState(false);

  /** Ids whose filter is set. The rule lives in one shared, tested place —
      duplicating it per card is how the chips drifted out of step in the
      first place. */
  const activeFilterIds = useMemo(
    () => deriveActiveFilterIds(filters),
    [filters]
  );

  /** Open a filter card and bring it into view. Shared by the picker and the
      suggested chips so both land in the same place. */
  const focusFilter = useCallback((id: string) => {
    setOpenFilterId(id);
    setPickerOpen(false);
    // Defer so the card has rendered open before we scroll to it.
    requestAnimationFrame(() => {
      document
        .getElementById(`filter-card-${id}`)
        ?.scrollIntoView({ behavior: "smooth", block: "center" });
    });
  }, []);

  // Drop selections that no longer appear on the current page - keeps
  // the bulk toolbar accurate when the user paginates or changes filters.
  useEffect(() => {
    if (selected.size === 0) return;
    const visible = new Set(results.map((r) => r.symbol));
    const stillSelected = new Set<string>();
    let changed = false;
    selected.forEach((s) => {
      if (visible.has(s)) stillSelected.add(s);
      else changed = true;
    });
    if (changed) setSelected(stillSelected);
  }, [results, selected]);

  function toggleSelect(symbol: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(symbol)) {
        next.delete(symbol);
      } else if (next.size + otherSelectedCount < MAX_COMPARE_ITEMS) {
        next.add(symbol);
      }
      return next;
    });
  }

  // Server has already sorted + sliced the page. We only render `results`
  // verbatim - pagination math here is for the footer ("Showing 1–25 of N").
  const pageRows = results;
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const clampedPage = Math.min(page, totalPages - 1);
  const startIdx = total === 0 ? 0 : clampedPage * PAGE_SIZE + 1;
  const endIdx = Math.min((clampedPage + 1) * PAGE_SIZE, total);

  const update = (patch: Partial<ScreenFilters>) =>
    onFiltersChange({ ...filters, ...patch });

  // Summary strings for each filter card
  const summaries = useMemo(
    () => ({
      exchange: filters.exchange ?? "Any",
      sector: filters.sector ?? "Any",
      mcap: filters.marketCapBucket
        ? MCAP_BUCKET_LABELS[filters.marketCapBucket]
        : rangeSummary(filters.minMarketCap, filters.maxMarketCap, "₹", " Cr"),
      pe: rangeSummary(filters.minPe, filters.maxPe),
      roe: rangeSummary(filters.minRoe, filters.maxRoe, "", "%"),
      rev: rangeSummary(
        filters.minRevenueGrowth,
        filters.maxRevenueGrowth,
        "",
        "%"
      ),
      de: rangeSummary(filters.minDebtToEquity, filters.maxDebtToEquity),
      div: rangeSummary(
        filters.minDividendYield,
        filters.maxDividendYield,
        "",
        "%"
      ),
    }),
    [filters]
  );

  return (
    <div className="flex flex-col gap-3">
      {/* Sticky top region - toolbar + quick filter chips + sector chips.
          Stays pinned to the top of the scroll viewport so users always
          see the filter affordances when reading deep into the result
          set. The advanced filter panel and results sit below this. */}
      <div className="sticky top-[var(--topbar-h,0px)] z-20 -mx-6 px-6 pt-2 pb-2 bg-[var(--paper)]/95 backdrop-blur supports-[backdrop-filter]:bg-[var(--paper)]/80 border-b border-[var(--rule-soft)]">
        {/* Status row - match count + active filter copy. View toggle
            moved into the toolbar below per the redesigned layout
            (image #29/#31). */}
        <div className="flex items-center gap-2 mb-2 min-w-0">
          <span className="pf-pill emerald shrink-0 whitespace-nowrap">
            {total.toLocaleString("en-IN")} stocks
          </span>
          <span className="mono text-[11px] text-[var(--ink-3)] truncate">
            {countActive(filters) === 0
              ? "Showing all — apply filters to narrow"
              : `${countActive(filters)} filter${countActive(filters) === 1 ? "" : "s"} active · sorted by ${sortLabel(sort)}`}
          </span>
          {loading && (
            <span className="mono text-[10px] text-[var(--emerald-text)] animate-pulse inline-flex items-center gap-1">
              <span className="h-1.5 w-1.5 rounded-full bg-[var(--emerald)] animate-pulse" />
              fetching results…
            </span>
          )}
        </div>

        {/* Toolbar row 1 - Filters left, view toggle right (image #32).
            On lg+ the toolbar stays single-line: filters + sort + view all
            fit. Below lg the sort moves to its own row (toolbar row 2).
            `relative z-10` makes the sort dropdown's `absolute z-40` menu
            sit above the chip rows that follow in document order - without
            it, the chips's `overflow-x-auto` creates its own stacking
            context that wins later-in-document tiebreaks. */}
        <div
          className="relative z-10 flex items-center gap-2 mb-2 flex-wrap"
          data-walkthrough="screener-panel"
        >
          <AdvancedFiltersToggle
            open={advancedOpen}
            onChange={(next) => {
              setFiltersInteracted(true);
              setAdvancedOpen(next);
            }}
            activeCount={countActive(filters)}
          />
          {/* Split sort - direction toggle + axis dropdown - used at every
              breakpoint for parity with mobile (the user wants the same
              two-component concept everywhere, not a unified menu). */}
          <div className="ml-auto flex items-center gap-1.5">
            <SortDirectionButton
              value={sort as SortKey}
              onChange={(next) => onSortChange(next)}
            />
            <SortKeyDropdown
              value={sort as SortKey}
              onChange={(next) => onSortChange(next)}
            />
          </div>
          <div className="shrink-0">
            <ViewToggle value={view} onChange={setView} />
          </div>
        </div>

        {/* Quick filters on the first line, sectors on a second line
            (image #29). A vertical stack guarantees each chip group owns
            its own row — the previous single `flex justify-between` row
            squeezed both `overflow-x-auto` strips onto one baseline, which
            made the chips overlap and hid the sector row entirely.

            #225: the chip group now sits below a thin `border-t` rule with
            `pt-3` so it reads as its own calm section instead of being
            jammed against (and "cut from the top" by) the toolbar above.
            `gap-2.5` gives the two chip rows clear vertical breathing room
            between each other; `mb-4` keeps the gap to the results grid
            below — applied on the chip-row BOTTOM (not the cards-grid top)
            so the sticky toolbar owns its own internal spacing and the body
            section's `gap-6` flex stays untouched. */}
        <div className="flex flex-col gap-2.5 mt-1 pt-3 mb-4 min-w-0 border-t border-[var(--rule-softer)]">
          <QuickFilterChips filters={filters} onChange={onFiltersChange} />
          <SectorChips
            options={sectorOptions}
            active={filters.sector ?? null}
            onChange={(next) =>
              onFiltersChange({ ...filters, sector: next ?? undefined })
            }
          />
        </div>
      </div>

      {/* Body: advanced filter sidebar on the LEFT, results on the
          RIGHT. Both sit below the sticky chips area; on desktop the
          sidebar takes 320px and results take the remaining flex-1.
          On mobile the sidebar opens as a bottom sheet. */}
      <div className="flex flex-col lg:flex-row gap-6">
        {/* RESULTS COLUMN (right) */}
        <div className="flex-1 min-w-0 order-2">
          {/* MONEY-558: results + pagination live in ONE bordered box
              (mirrors the research-list pattern in app/analysis/client.tsx)
              so the page controls always stay WITHIN the container in both
              card and table views — no chips floating past the box edge.
              MONEY-392: any filter/sort/page change shows the full skeleton
              instead of stale rows + a tiny pulse. */}
          <div className="pf-card" style={{ padding: 0, overflow: "hidden" }}>
            {loading ? (
              <div style={{ padding: 16 }}>
                <ResultsSkeleton view={view} />
              </div>
            ) : view === "cards" ? (
              pageRows.length === 0 ? (
                <div style={{ padding: 16 }}>
                  <EmptyState
                    icon={SlidersHorizontal}
                    title="No stocks match"
                    description="Try loosening your filters — widen the market cap range or remove a sector constraint."
                    muted
                    card={false}
                    action={
                      countActive(filters) > 0
                        ? {
                            label: "Reset filters",
                            onClick: () => onFiltersChange({} as ScreenFilters),
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
                    <StockCardCompact
                      key={`${r.symbol}|${r.exchange}`}
                      row={r}
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
                      {STOCKS_COLUMNS.map((col, idx) => (
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
                          colSpan={STOCKS_COLUMNS.length}
                          style={{ padding: "40px 16px" }}
                        >
                          <EmptyState
                            icon={SlidersHorizontal}
                            title="No stocks match"
                            description="Loosen your filters or try a different sector."
                            muted
                            card={false}
                            action={
                              countActive(filters) > 0
                                ? {
                                    label: "Reset filters",
                                    onClick: () =>
                                      onFiltersChange({} as ScreenFilters),
                                  }
                                : undefined
                            }
                          />
                        </td>
                      </tr>
                    ) : (
                      pageRows.map((r) => (
                        <StocksTableRow
                          key={`${r.symbol}|${r.exchange}`}
                          row={r}
                          selected={selected.has(r.symbol)}
                          canSelect={
                            selected.has(r.symbol) ||
                            selected.size < MAX_COMPARE_ITEMS
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

          {/* MONEY-553 — the bulk Compare/Watchlist/CSV bar is now the unified
              cross-asset `ScreenerCompareBar` rendered once at the screener-
              client level (so a stock + fund selection accumulates across tabs
              and Compares together on /compare). No per-mode toolbar here. */}
        </div>

        {/* ADVANCED FILTER SIDEBAR (left, desktop only) */}
        {advancedOpen && (
          <>
            <div
              className="hidden lg:block lg:w-[320px] shrink-0 order-1"
              data-walkthrough="screener-panel"
            >
              <FilterSidebar
                variant="column"
                activeCount={countActive(filters)}
                onAddFilter={() => setPickerOpen((v) => !v)}
                onResetAll={
                  countActive(filters) > 0
                    ? () => onFiltersChange({} as ScreenFilters)
                    : undefined
                }
                pre={
                  <UniverseSection
                    exchange={(filters.exchange as ExchangeChoice) ?? "BOTH"}
                    onExchangeChange={(next) =>
                      update({
                        exchange:
                          next === "BOTH" ? undefined : (next as "NSE" | "BSE"),
                      })
                    }
                    index={filters.index ?? "all"}
                    onIndexChange={(next) =>
                      update({ index: next === "all" ? undefined : next })
                    }
                  />
                }
                post={
                  <>
                    {/* MONEY-1246 — the metric picker "+ Add filter" opens.
                        Every filter card is always rendered, so "adding" a
                        filter means jumping to and expanding the right card
                        rather than creating one. Already-set metrics are
                        marked so the list says what is in use rather than
                        silently doing nothing when picked. */}
                    {pickerOpen && (
                      <div
                        className="rounded-[10px] p-2 mb-2"
                        style={{ border: "1.5px solid var(--ink)" }}
                      >
                        <div className="mono text-[9.5px] tracking-[1.4px] uppercase font-bold text-[var(--ink-3)] mb-1.5 px-1">
                          Add a filter
                        </div>
                        <div className="flex flex-col">
                          {SUGGESTED_FILTERS.map((m) => {
                            const inUse = activeFilterIds.includes(m.id);
                            return (
                              <button
                                key={m.id}
                                type="button"
                                onClick={() => focusFilter(m.id)}
                                className="flex items-center justify-between text-left px-2 py-1.5 rounded-md text-[12.5px] hover:bg-[var(--paper-2)] transition-colors"
                              >
                                <span style={{ color: "var(--ink)" }}>
                                  {m.label}
                                </span>
                                {inUse && (
                                  <span
                                    className="mono"
                                    style={{
                                      fontSize: 9,
                                      color: "var(--emerald-text)",
                                    }}
                                  >
                                    IN USE
                                  </span>
                                )}
                              </button>
                            );
                          })}
                        </div>
                      </div>
                    )}
                    <SuggestedChips
                      onPick={focusFilter}
                      activeIds={activeFilterIds}
                    />
                  </>
                }
              >
                {/* Exchange now lives in the UNIVERSE block at the top
                    of the sidebar (UniverseSection) alongside Index.
                    The legacy FilterCard duplicate was removed
                    (image #87). */}

                {/* Sector */}
                <FilterCard
                  label="Sector"
                  summary={summaries.sector}
                  active={filters.sector != null}
                  onClear={() => update({ sector: undefined })}
                >
                  <Select
                    value={filters.sector ?? "__any__"}
                    onValueChange={(v) =>
                      update({ sector: v === "__any__" ? undefined : v })
                    }
                  >
                    <SelectTrigger
                      className="w-full h-8 text-[12.5px] border-[1.5px] border-[var(--ink)]"
                      style={{ background: "var(--paper)" }}
                    >
                      <SelectValue placeholder="Any sector" />
                    </SelectTrigger>
                    <SelectContent className="max-h-[360px]">
                      <SelectItem value="__any__">
                        <span className="inline-flex w-full justify-between items-baseline gap-6">
                          <span>Any sector</span>
                        </span>
                      </SelectItem>
                      {orderedSectorOptions(sectorOptions).map((s) => (
                        <SelectItem key={s.name} value={s.name}>
                          <span className="inline-flex w-full justify-between items-baseline gap-6">
                            <span>{s.name}</span>
                            {s.count > 0 && (
                              <span className="font-mono text-[11px] text-[var(--ink-3)] tabular-nums">
                                {s.count.toLocaleString("en-IN")}
                              </span>
                            )}
                          </span>
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </FilterCard>

                {/* Market cap bucket */}
                <FilterCard
                  id="filter-card-mcap"
                  open={openFilterId === "mcap" ? true : undefined}
                  onOpenChange={(next) => setOpenFilterId(next ? "mcap" : null)}
                  label="Market cap"
                  summary={summaries.mcap}
                  active={
                    filters.marketCapBucket != null ||
                    filters.minMarketCap != null ||
                    filters.maxMarketCap != null
                  }
                  onClear={() =>
                    update({
                      marketCapBucket: undefined,
                      minMarketCap: undefined,
                      maxMarketCap: undefined,
                    })
                  }
                >
                  <RadioRow
                    options={["LARGE", "MID", "SMALL"]}
                    value={filters.marketCapBucket ?? null}
                    onChange={(v) =>
                      update({
                        marketCapBucket:
                          (v as MarketCapBucket | null) ?? undefined,
                        minMarketCap: undefined,
                        maxMarketCap: undefined,
                      })
                    }
                    labels={{ LARGE: "Large", MID: "Mid", SMALL: "Small" }}
                    allLabel="Any"
                  />
                </FilterCard>

                {/* P/E */}
                <FilterCard
                  id="filter-card-pe"
                  open={openFilterId === "pe" ? true : undefined}
                  onOpenChange={(next) => setOpenFilterId(next ? "pe" : null)}
                  label="P/E ratio"
                  summary={summaries.pe}
                  active={filters.minPe != null || filters.maxPe != null}
                  onClear={() => update({ minPe: undefined, maxPe: undefined })}
                >
                  <RangeInputs
                    min={filters.minPe}
                    max={filters.maxPe}
                    onChange={(min, max) => update({ minPe: min, maxPe: max })}
                  />
                </FilterCard>

                {/* ROE */}
                <FilterCard
                  id="filter-card-roe"
                  open={openFilterId === "roe" ? true : undefined}
                  onOpenChange={(next) => setOpenFilterId(next ? "roe" : null)}
                  label="ROE"
                  summary={summaries.roe}
                  active={filters.minRoe != null || filters.maxRoe != null}
                  onClear={() =>
                    update({ minRoe: undefined, maxRoe: undefined })
                  }
                >
                  <RangeInputs
                    min={filters.minRoe}
                    max={filters.maxRoe}
                    suffix="%"
                    onChange={(min, max) =>
                      update({ minRoe: min, maxRoe: max })
                    }
                  />
                </FilterCard>

                {/* Revenue growth */}
                <FilterCard
                  id="filter-card-rev"
                  open={openFilterId === "rev" ? true : undefined}
                  onOpenChange={(next) => setOpenFilterId(next ? "rev" : null)}
                  label="Revenue growth YoY"
                  summary={summaries.rev}
                  active={
                    filters.minRevenueGrowth != null ||
                    filters.maxRevenueGrowth != null
                  }
                  onClear={() =>
                    update({
                      minRevenueGrowth: undefined,
                      maxRevenueGrowth: undefined,
                    })
                  }
                >
                  <RangeInputs
                    min={filters.minRevenueGrowth}
                    max={filters.maxRevenueGrowth}
                    suffix="%"
                    onChange={(min, max) =>
                      update({ minRevenueGrowth: min, maxRevenueGrowth: max })
                    }
                  />
                </FilterCard>

                {/* Debt/Equity */}
                <FilterCard
                  id="filter-card-de"
                  open={openFilterId === "de" ? true : undefined}
                  onOpenChange={(next) => setOpenFilterId(next ? "de" : null)}
                  label="Debt/Equity"
                  summary={summaries.de}
                  active={
                    filters.minDebtToEquity != null ||
                    filters.maxDebtToEquity != null
                  }
                  onClear={() =>
                    update({
                      minDebtToEquity: undefined,
                      maxDebtToEquity: undefined,
                    })
                  }
                >
                  <RangeInputs
                    min={filters.minDebtToEquity}
                    max={filters.maxDebtToEquity}
                    onChange={(min, max) =>
                      update({ minDebtToEquity: min, maxDebtToEquity: max })
                    }
                  />
                </FilterCard>

                {/* Dividend yield (MONEY-779) */}
                <FilterCard
                  id="filter-card-div"
                  open={openFilterId === "div" ? true : undefined}
                  onOpenChange={(next) => setOpenFilterId(next ? "div" : null)}
                  label="Dividend yield"
                  summary={summaries.div}
                  active={
                    filters.minDividendYield != null ||
                    filters.maxDividendYield != null
                  }
                  onClear={() =>
                    update({
                      minDividendYield: undefined,
                      maxDividendYield: undefined,
                    })
                  }
                >
                  <RangeInputs
                    min={filters.minDividendYield}
                    max={filters.maxDividendYield}
                    suffix="%"
                    onChange={(min, max) =>
                      update({ minDividendYield: min, maxDividendYield: max })
                    }
                  />
                </FilterCard>
              </FilterSidebar>
            </div>
            {/* Mobile: same FilterSidebar inside a bottom sheet. `hidden`
                until the user taps the toggle so a persisted-open state can't
                pop the modal on navigation; z-[60] sits above the bottom nav
                (z-50) so the sheet bottom isn't clipped by it (#97). */}
            <div
              className={`lg:hidden fixed inset-0 z-[60] flex items-end ${
                filtersInteracted ? "" : "hidden"
              }`}
            >
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
                {/* Drag handle (design: MobileScreenerSheet). */}
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
                {/* Sticky header with explicit close - keeps the close
                  affordance visible even when the user scrolls deep into
                  the filter list. */}
                <div
                  className="sticky top-0 z-10 flex items-center gap-3 px-4 py-3 bg-[var(--paper)]"
                  style={{ borderBottom: "2px solid var(--ink)" }}
                >
                  <span className="mono text-[11px] tracking-[1.5px] uppercase font-bold text-[var(--ink-2)]">
                    Filters
                    {countActive(filters) > 0 && (
                      <span className="ml-1.5 text-[var(--emerald-text)]">
                        · {countActive(filters)} active
                      </span>
                    )}
                  </span>
                  <div className="ml-auto flex items-center gap-2">
                    {countActive(filters) > 0 && (
                      <button
                        type="button"
                        onClick={() => onFiltersChange({} as ScreenFilters)}
                        className="mono text-[11.5px] text-[var(--ink-3)] underline hover:text-[var(--emerald-text)] transition-colors cursor-pointer"
                      >
                        Reset all
                      </button>
                    )}
                    <button
                      type="button"
                      onClick={() => setAdvancedOpen(false)}
                      className="pf-bf sm"
                    >
                      Close
                    </button>
                  </div>
                </div>
                <div className="overflow-y-auto p-4 pb-[calc(1.5rem+env(safe-area-inset-bottom,0px))]">
                  <FilterSidebar
                    variant="column"
                    hideHeader
                    activeCount={countActive(filters)}
                    onAddFilter={() => setPickerOpen((v) => !v)}
                    onResetAll={
                      countActive(filters) > 0
                        ? () => onFiltersChange({} as ScreenFilters)
                        : undefined
                    }
                    pre={
                      <UniverseSection
                        exchange={
                          (filters.exchange as ExchangeChoice) ?? "BOTH"
                        }
                        onExchangeChange={(next) =>
                          update({
                            exchange:
                              next === "BOTH"
                                ? undefined
                                : (next as "NSE" | "BSE"),
                          })
                        }
                        index={filters.index ?? "all"}
                        onIndexChange={(next) =>
                          update({
                            index: next === "all" ? undefined : next,
                          })
                        }
                      />
                    }
                  >
                    {/* Compact subset of cards for mobile sheet - just the
                    most-used filters. Users can still set the rest via
                    the desktop view. */}
                    <FilterCard
                      label="Sector"
                      summary={summaries.sector}
                      active={filters.sector != null}
                      onClear={() => update({ sector: undefined })}
                    >
                      <Select
                        value={filters.sector ?? "__any__"}
                        onValueChange={(v) =>
                          update({ sector: v === "__any__" ? undefined : v })
                        }
                      >
                        <SelectTrigger
                          className="w-full h-8 text-[12.5px] border-[1.5px] border-[var(--ink)]"
                          style={{ background: "var(--paper)" }}
                        >
                          <SelectValue placeholder="Any sector" />
                        </SelectTrigger>
                        <SelectContent className="max-h-[360px]">
                          <SelectItem value="__any__">Any sector</SelectItem>
                          {orderedSectorOptions(sectorOptions).map((s) => (
                            <SelectItem key={s.name} value={s.name}>
                              {s.name}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </FilterCard>
                    <FilterCard
                      label="Market cap"
                      summary={summaries.mcap}
                      active={
                        filters.marketCapBucket != null ||
                        filters.minMarketCap != null ||
                        filters.maxMarketCap != null
                      }
                      onClear={() =>
                        update({
                          marketCapBucket: undefined,
                          minMarketCap: undefined,
                          maxMarketCap: undefined,
                        })
                      }
                    >
                      <RadioRow
                        options={["LARGE", "MID", "SMALL"]}
                        value={filters.marketCapBucket ?? null}
                        onChange={(v) =>
                          update({
                            marketCapBucket:
                              (v as MarketCapBucket | null) ?? undefined,
                            minMarketCap: undefined,
                            maxMarketCap: undefined,
                          })
                        }
                        labels={{ LARGE: "Large", MID: "Mid", SMALL: "Small" }}
                        allLabel="Any"
                      />
                    </FilterCard>
                    <FilterCard
                      label="P/E ratio"
                      summary={summaries.pe}
                      active={filters.minPe != null || filters.maxPe != null}
                      onClear={() =>
                        update({ minPe: undefined, maxPe: undefined })
                      }
                    >
                      <RangeInputs
                        min={filters.minPe}
                        max={filters.maxPe}
                        onChange={(min, max) =>
                          update({ minPe: min, maxPe: max })
                        }
                      />
                    </FilterCard>
                    <FilterCard
                      label="ROE"
                      summary={summaries.roe}
                      active={filters.minRoe != null || filters.maxRoe != null}
                      onClear={() =>
                        update({ minRoe: undefined, maxRoe: undefined })
                      }
                    >
                      <RangeInputs
                        min={filters.minRoe}
                        max={filters.maxRoe}
                        suffix="%"
                        onChange={(min, max) =>
                          update({ minRoe: min, maxRoe: max })
                        }
                      />
                    </FilterCard>
                    {/* Dividend yield (MONEY-779) */}
                    <FilterCard
                      label="Dividend yield"
                      summary={summaries.div}
                      active={
                        filters.minDividendYield != null ||
                        filters.maxDividendYield != null
                      }
                      onClear={() =>
                        update({
                          minDividendYield: undefined,
                          maxDividendYield: undefined,
                        })
                      }
                    >
                      <RangeInputs
                        min={filters.minDividendYield}
                        max={filters.maxDividendYield}
                        suffix="%"
                        onChange={(min, max) =>
                          update({
                            minDividendYield: min,
                            maxDividendYield: max,
                          })
                        }
                      />
                    </FilterCard>
                  </FilterSidebar>
                </div>
              </div>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

// ============== HELPERS ==============

/** Sector order for the dropdown:
 *   1. Canonical NSE sectors sorted by count desc (most populated first)
 *   2. "Not Categorised" / empty sector always at the bottom - it's a
 *      fallback bucket for un-enriched instruments, not a selectable theme.
 */
function orderedSectorOptions(
  options: readonly SectorOption[]
): readonly SectorOption[] {
  const primary: SectorOption[] = [];
  const fallback: SectorOption[] = [];
  for (const s of options) {
    const name = s.name.toLowerCase();
    if (
      name === "not categorised" ||
      name === "uncategorised" ||
      name === "other" ||
      name === "others"
    ) {
      fallback.push(s);
    } else {
      primary.push(s);
    }
  }
  primary.sort((a, b) => b.count - a.count);
  return [...primary, ...fallback];
}

/** Friendly label for the active sort key (shown in the status line).
 *  Falls back to the raw key so a future sort axis still renders. */
function sortLabel(sort: string): string {
  const map: Record<string, string> = {
    match: "match",
    mcap: "market cap",
    pe: "P/E",
    roe: "ROE",
    rev: "revenue growth",
    de: "debt/equity",
    ltp: "price",
  };
  return map[sort] ?? sort;
}

function countActive(f: ScreenFilters): number {
  let n = 0;
  if (f.exchange) n++;
  if (f.sector) n++;
  // Index membership counts as a filter - picking "Nifty 50" narrows
  // the universe to ~50 symbols, which is exactly a filter. Was missed
  // earlier and made the badge undercount (image #85).
  if (f.index && f.index !== "all") n++;
  if (f.marketCapBucket || f.minMarketCap != null || f.maxMarketCap != null)
    n++;
  if (f.minPe != null || f.maxPe != null) n++;
  if (f.minRoe != null || f.maxRoe != null) n++;
  if (f.minRevenueGrowth != null || f.maxRevenueGrowth != null) n++;
  if (f.minDebtToEquity != null || f.maxDebtToEquity != null) n++;
  if (f.minDividendYield != null || f.maxDividendYield != null) n++;
  return n;
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
  return (
    <div className="flex flex-wrap gap-1.5">
      <button
        type="button"
        onClick={() => onChange(null)}
        className={`pf-pill ${value == null ? "emerald" : "outline"}`}
        style={{ cursor: "pointer" }}
      >
        {allLabel}
      </button>
      {options.map((o) => (
        <button
          type="button"
          key={o}
          onClick={() => onChange(o)}
          className={`pf-pill ${value === o ? "emerald" : "outline"}`}
          style={{ cursor: "pointer" }}
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
  return (
    <div className="flex items-center gap-2 text-[11px]">
      <input
        type="number"
        value={min ?? ""}
        onChange={handle("min")}
        placeholder={`Min${suffix ? ` (${suffix})` : ""}`}
        className="pf-input mono"
        style={{ padding: "6px 10px", fontSize: 12 }}
      />
      <span className="text-[var(--ink-3)]">–</span>
      <input
        type="number"
        value={max ?? ""}
        onChange={handle("max")}
        placeholder={`Max${suffix ? ` (${suffix})` : ""}`}
        className="pf-input mono"
        style={{ padding: "6px 10px", fontSize: 12 }}
      />
    </div>
  );
}

export default StocksMode;

// ──────────────────────────────────────────────────────────────────
// Table row - extracted so each row can own its own ResearchModal
// open-state without firing every row's preference hooks on mount.
// ──────────────────────────────────────────────────────────────────
function StocksTableRow({
  row,
  selected,
  canSelect,
  onToggleSelect,
}: {
  row: ScreenResult;
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
        router.push(`/stock/${row.symbol}?exchange=${row.exchange}`)
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
        {row.name ? <div className="nm">{row.name}</div> : null}
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
      <td className="num" style={{ textAlign: "right", color: "var(--ink-2)" }}>
        {formatMcap(row.marketCap)}
      </td>
      <td className="num" style={{ textAlign: "right", color: "var(--ink-3)" }}>
        {formatNum(row.pe, 1)}
      </td>
      <td
        className={`num ${(row.roe ?? 0) >= 0 ? "pos" : "neg"}`}
        style={{ textAlign: "right" }}
      >
        {formatPct(row.roe, false)}
      </td>
      <td
        className={`num ${(row.revenueGrowth ?? 0) >= 0 ? "pos" : "neg"} hidden md:table-cell`}
        style={{ textAlign: "right" }}
      >
        {formatPct(row.revenueGrowth)}
      </td>
      <td
        className="num hidden sm:table-cell"
        style={{ textAlign: "right", color: "var(--ink-3)" }}
      >
        {formatNum(row.debtToEquity, 2)}
      </td>
      <td
        className="num"
        style={{ textAlign: "right", color: "var(--ink)", fontWeight: 700 }}
      >
        {formatInr(row.ltp)}
      </td>
      <td style={{ textAlign: "right" }}>
        <MatchScoreBar score={row.matchScore} />
      </td>
      <td style={{ textAlign: "right" }} onClick={(e) => e.stopPropagation()}>
        <div className="inline-flex items-center gap-1">
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              setResearchOpen(true);
            }}
            className="pf-bf sm"
            style={{ padding: "5px 8px" }}
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
              type: "stock",
              exchange: row.exchange,
            }}
          />
        )}
      </td>
    </tr>
  );
}
