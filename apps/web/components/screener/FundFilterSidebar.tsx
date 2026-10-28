"use client";

/**
 * Unified filter sidebar for the Funds & ETFs screener tabs (MONEY-301).
 *
 * Behaviour by Type segment:
 *   - MF    → MF-specific (Category, AMC, Risk) + common sliders.
 *   - ETFs  → ETF-specific (Exchange, Asset class, Theme) + common sliders.
 *
 * Common-slider edits are mirrored into both `mfFilters` and `etfFilters`
 * (when each is provided) so the user doesn't lose values when flipping
 * Type tabs.
 */

import { useCallback, useMemo, useState } from "react";
import type { MfScreenFilters, EtfScreenFilters } from "@/lib/actions/screener";
import { SearchableSelect } from "@/components/screener/SearchableSelect";
import {
  ETF_FUND_HOUSE_OPTIONS,
  ETF_CATEGORY_OPTIONS,
} from "@/lib/screener/etf-derive";

export type FundType = "mf" | "etf";

const ETF_ASSET_CLASS_OPTIONS = [
  { value: "equity", label: "Equity" },
  { value: "debt", label: "Debt" },
  { value: "hybrid", label: "Hybrid" },
  { value: "solution", label: "Solution" },
  { value: "other", label: "Other" },
] as const;

import {
  SUGGESTED_ETF_FILTERS,
  remainingEtfSuggestions,
  deriveActiveMfChips,
  deriveActiveEtfChips,
  deriveActiveEtfFilterIds,
} from "./suggested-filters-logic";
import { ActiveFilterChips } from "./ActiveFilterChips";

interface FundFilterSidebarProps {
  /** Active type tab - drives which underlying mode the parent renders. */
  type: FundType;
  onTypeChange: (next: FundType) => void;
  /** MF filters - required when `type === "mf"`, optional otherwise. The
   *  common sliders still write to it when present so cross-tab edits
   *  persist. */
  mfFilters?: MfScreenFilters;
  onMfFiltersChange?: (next: MfScreenFilters) => void;
  /** ETF filters - required when `type === "etf"`, optional otherwise.
   *  Same cross-tab persistence as `mfFilters`. */
  etfFilters?: EtfScreenFilters;
  onEtfFiltersChange?: (next: EtfScreenFilters) => void;
  /** Categories with counts - sourced from `getMfDiscoverDataAction`. */
  categories?: ReadonlyArray<{ name: string; count: number }>;
  /** AMC names - sourced from `getMfDiscoverDataAction`. */
  amcList?: readonly string[];
  /** Optional reset-all callback. When set, renders the "Reset all" link. */
  onResetAll?: () => void;
  /** Layout variant. `column` = legacy 320px sidebar. `panel` (default
   *  for v3.3) = full-width panel placed below the toolbar. */
  variant?: "column" | "panel";
}

export function FundFilterSidebar({
  type,
  onTypeChange,
  mfFilters,
  onMfFiltersChange,
  etfFilters,
  onEtfFiltersChange,
  categories = [],
  amcList = [],
  onResetAll,
  variant = "panel",
}: FundFilterSidebarProps) {
  // ── Helpers ────────────────────────────────────────────────────
  const updateMf = (patch: Partial<MfScreenFilters>) => {
    if (mfFilters && onMfFiltersChange) {
      onMfFiltersChange({ ...mfFilters, ...patch });
    }
  };
  const updateEtf = (patch: Partial<EtfScreenFilters>) => {
    if (etfFilters && onEtfFiltersChange) {
      onEtfFiltersChange({ ...etfFilters, ...patch });
    }
  };

  /* MONEY-1248 — "+ Add filter" picker + SUGGESTED chips, matching stocks
     mode. ETF ONLY: this sidebar is shared with MF, so anything rendered
     unconditionally would appear there too. */
  const [pickerOpen, setPickerOpen] = useState(false);
  const activeEtfIds = useMemo(
    () => deriveActiveEtfFilterIds(etfFilters ?? {}),
    [etfFilters]
  );
  /* MONEY-1251 — the filters actually narrowing the screen, derived from
     STATE rather than from which controls exist. Ask Screener can set 17 MF
     fields against 3 rendered controls, so without this a chat-applied
     `minReturns5Y` or `plan` filtered the results while appearing nowhere and
     could only be undone with "Reset all". */
  const activeChips = useMemo(
    () =>
      type === "mf"
        ? deriveActiveMfChips((mfFilters ?? {}) as Record<string, unknown>)
        : deriveActiveEtfChips((etfFilters ?? {}) as Record<string, unknown>),
    [type, mfFilters, etfFilters]
  );

  /** Clear the given filter keys. A range chip passes BOTH bounds, so
      removing it cannot leave half a range still filtering. */
  const removeFilterKeys = useCallback(
    (keys: string[]) => {
      const patch: Record<string, undefined> = {};
      for (const k of keys) patch[k] = undefined;
      if (type === "mf") updateMf(patch as never);
      else updateEtf(patch as never);
    },
    // updateMf/updateEtf close over the current filters, so they must be deps
    // or a removal would write against a stale snapshot and resurrect a chip.
    [type, mfFilters, etfFilters, onMfFiltersChange, onEtfFiltersChange] // eslint-disable-line react-hooks/exhaustive-deps
  );

  const focusEtfFilter = useCallback((id: string) => {
    setPickerOpen(false);
    // Defer so the picker has collapsed before we scroll.
    requestAnimationFrame(() => {
      document
        .getElementById(`etf-filter-${id}`)
        ?.scrollIntoView({ behavior: "smooth", block: "center" });
    });
  }, []);

  // TODO(MONEY-367): re-enable Risk + slider state once the data
  // sources (AMFI riskLevel, MF returns/expense/AUM, ETF MF-master
  // join) are populated densely enough to make these filters useful.
  // The where-builder + post-fetch logic is still wired and exercised
  // by tests; only the UI and its derived state are commented out.
  //
  // const currentRisk: "low" | "med" | "high" | null = (() => {
  //   const r = mfFilters?.riskLevel?.toLowerCase() ?? "";
  //   if (!r) return null;
  //   if (r === "low") return "low";
  //   if (r.includes("very high")) return "high";
  //   if (r.includes("high")) return "high";
  //   if (r.includes("moderat")) return "med";
  //   return null;
  // })();
  // const setRisk = (next: "low" | "med" | "high" | null) => {
  //   const value =
  //     next === "low"
  //       ? "Low"
  //       : next === "med"
  //         ? "Moderate"
  //         : next === "high"
  //           ? "High"
  //           : undefined;
  //   updateMf({ riskLevel: value });
  // };
  //
  // const min1Y =
  //   (type === "etf" ? etfFilters?.minReturns1Y : mfFilters?.minReturns1Y) ??
  //   mfFilters?.minReturns1Y ??
  //   etfFilters?.minReturns1Y ??
  //   0;
  // const maxExp =
  //   (type === "etf"
  //     ? etfFilters?.maxExpenseRatio
  //     : mfFilters?.maxExpenseRatio) ??
  //   mfFilters?.maxExpenseRatio ??
  //   etfFilters?.maxExpenseRatio ??
  //   3;
  // const minAum =
  //   (type === "etf" ? etfFilters?.minAum : mfFilters?.minAum) ??
  //   mfFilters?.minAum ??
  //   etfFilters?.minAum ??
  //   0;

  const showMf = type === "mf";
  const showEtf = type === "etf";

  const isColumn = variant === "column";
  return (
    <div
      className={
        isColumn
          ? "pf-card w-full lg:w-[320px] shrink-0 space-y-3"
          : "pf-card w-full mb-4 space-y-3"
      }
      style={{ padding: 16 }}
    >
      <div
        className="flex items-center pb-2.5"
        style={{ borderBottom: "1.5px solid var(--ink)" }}
      >
        <span className="mono text-[10.5px] tracking-[1.5px] uppercase font-bold text-[var(--ink-2)]">
          Fund filters
        </span>
        {onResetAll && (
          <button
            type="button"
            onClick={onResetAll}
            className="ml-auto mono text-[11px] text-[var(--ink-3)] underline hover:text-[var(--emerald-text)] transition-colors cursor-pointer"
          >
            Reset all
          </button>
        )}
      </div>

      {/* TYPE segment - flips between MF and ETF tabs. */}
      <Block label="Type">
        <div
          className="inline-flex w-full items-center gap-[2px] rounded-[7px] p-[2px]"
          style={{
            border: "1.5px solid var(--ink)",
            background: "var(--paper-2)",
          }}
        >
          {(
            [
              { id: "mf" as const, label: "Mutual Funds" },
              { id: "etf" as const, label: "ETFs" },
            ] as const
          ).map((opt) => {
            const active = type === opt.id;
            return (
              <button
                key={opt.id}
                type="button"
                onClick={() => onTypeChange(opt.id)}
                className="flex-1 px-2 py-1 rounded-[5px] text-[11px] mono font-bold cursor-pointer transition-colors"
                style={
                  active
                    ? { background: "var(--ink)", color: "var(--paper)" }
                    : { background: "transparent", color: "var(--ink-3)" }
                }
              >
                {opt.label}
              </button>
            );
          })}
        </div>
      </Block>

      {/* MONEY-1251 — what is actually filtering, for BOTH modes. Rendered
          above the controls so a filter the chat set (and which may have no
          control at all) is the first thing seen, and individually removable
          rather than only clearable via "Reset all". */}
      <ActiveFilterChips chips={activeChips} onRemove={removeFilterKeys} />

      {/* MF-only sections - Category, AMC, Risk. Hidden when the user
          flips Type to All or ETFs. */}
      {showMf && (
        <>
          <Block label="Category">
            <SearchableSelect
              value={mfFilters?.category ?? null}
              onChange={(next) => updateMf({ category: next ?? undefined })}
              options={categories.map((c) => ({
                value: c.name,
                label: c.name,
                count: c.count,
              }))}
              placeholder="All categories"
              ariaLabel="Filter by category"
            />
          </Block>
          <Block label="AMC">
            <SearchableSelect
              value={mfFilters?.amcName ?? null}
              onChange={(next) =>
                updateMf({ amcName: next ?? undefined, amcAny: undefined })
              }
              options={amcList.map((a) => ({ value: a, label: a }))}
              placeholder="All AMCs"
              ariaLabel="Filter by AMC"
            />
          </Block>
          {/* TODO(MONEY-367): re-enable Risk segment once
              MutualFundMaster.riskLevel is densely populated. Wiring
              + bucket-expansion in buildMfScreenWhere stays in place
              so this is a UI-only revival.
          <Block label="Risk">
            <div className="inline-flex w-full items-center gap-0 rounded-[6px] border border-[var(--border-default)] bg-white/[0.02] p-[2px]">
              {(["low", "med", "high"] as const).map((r) => {
                const active = currentRisk === r;
                return (
                  <button
                    key={r}
                    type="button"
                    onClick={() => setRisk(active ? null : r)}
                    className={`flex-1 px-2 py-1 rounded-[5px] text-[11px] font-mono font-semibold cursor-pointer transition-colors ${
                      active
                        ? "bg-emerald-400/[0.14] text-emerald-400"
                        : "text-[var(--text-dim)] hover:text-[var(--text-secondary)]"
                    }`}
                  >
                    {r === "low" ? "Low" : r === "med" ? "Med" : "High"}
                  </button>
                );
              })}
            </div>
          </Block>
          */}

          {/* MONEY-1248 — "+ Add filter" picker + SUGGESTED chips, matching
              stocks mode. Inside `showEtf` so MF mode is untouched. Only the
              filters whose UI is actually rendered are offered; the three
              commented-out sliders (MONEY-367) are excluded in
              suggested-filters-logic, since jumping to a control that does
              not exist is the dead-end MONEY-1246 fixed. */}
          <button
            type="button"
            onClick={() => setPickerOpen((v) => !v)}
            aria-expanded={pickerOpen}
            className="w-full flex items-center justify-center gap-1.5 mt-1 px-3 py-2.5 rounded-[10px] text-[12.5px] mono font-semibold transition-colors cursor-pointer text-[var(--ink-3)] hover:text-[var(--emerald-text)]"
            style={{ border: "1.5px dashed var(--rule-soft)" }}
          >
            <span className="font-bold">+</span>
            Add filter
          </button>

          {pickerOpen && (
            <div
              className="rounded-[10px] p-2"
              style={{ border: "1.5px solid var(--ink)" }}
            >
              <div className="mono text-[9.5px] tracking-[1.4px] uppercase font-bold text-[var(--ink-3)] mb-1.5 px-1">
                Add a filter
              </div>
              <div className="flex flex-col">
                {SUGGESTED_ETF_FILTERS.map((m) => {
                  const inUse = activeEtfIds.includes(m.id);
                  return (
                    <button
                      key={m.id}
                      type="button"
                      onClick={() => focusEtfFilter(m.id)}
                      className="flex items-center justify-between text-left px-2 py-1.5 rounded-md text-[12.5px] hover:bg-[var(--paper-2)] transition-colors"
                    >
                      <span style={{ color: "var(--ink)" }}>{m.label}</span>
                      {inUse && (
                        <span
                          className="mono"
                          style={{ fontSize: 9, color: "var(--emerald-text)" }}
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

          {remainingEtfSuggestions(activeEtfIds).length > 0 && (
            <div className="pt-1">
              <div className="mono text-[9.5px] tracking-[1.4px] uppercase font-bold text-[var(--ink-3)] mb-2">
                Suggested
              </div>
              <div className="flex flex-wrap gap-1.5">
                {remainingEtfSuggestions(activeEtfIds).map((s) => (
                  <button
                    key={s.id}
                    type="button"
                    onClick={() => focusEtfFilter(s.id)}
                    className="pf-pill outline cursor-pointer hover:text-[var(--emerald-text)] hover:border-[var(--emerald)] transition-colors"
                    style={{ fontSize: 10.5 }}
                  >
                    <span className="font-bold">+</span>
                    {s.label}
                  </button>
                ))}
              </div>
            </div>
          )}
        </>
      )}

      {/* ETF-only sections - Exchange, Fund house (AMC), Category,
          Asset class, Theme. AMC + Category are derived from the
          instrument name (no DB column today) so the option lists
          come from etf-derive.ts. */}
      {showEtf && (
        <>
          <Block label="Exchange" id="etf-filter-exchange">
            <div
              className="inline-flex w-full items-center gap-[2px] rounded-[7px] p-[2px]"
              style={{
                border: "1.5px solid var(--ink)",
                background: "var(--paper-2)",
              }}
            >
              {(["NSE", "BSE"] as const).map((ex) => {
                const active = etfFilters?.exchange === ex;
                return (
                  <button
                    key={ex}
                    type="button"
                    onClick={() =>
                      updateEtf({ exchange: active ? undefined : ex })
                    }
                    className="flex-1 px-2 py-1 rounded-[5px] text-[11px] mono font-bold cursor-pointer transition-colors"
                    style={
                      active
                        ? { background: "var(--ink)", color: "var(--paper)" }
                        : { background: "transparent", color: "var(--ink-3)" }
                    }
                  >
                    {ex}
                  </button>
                );
              })}
            </div>
          </Block>
          <Block label="Fund house" id="etf-filter-amc">
            <SearchableSelect
              value={etfFilters?.amcName ?? null}
              onChange={(next) => updateEtf({ amcName: next ?? undefined })}
              options={ETF_FUND_HOUSE_OPTIONS.map((o) => ({
                value: o,
                label: o,
              }))}
              placeholder="All fund houses"
              ariaLabel="Filter by fund house"
            />
          </Block>
          <Block label="Category" id="etf-filter-category">
            <SearchableSelect
              value={etfFilters?.category ?? null}
              onChange={(next) => updateEtf({ category: next ?? undefined })}
              options={ETF_CATEGORY_OPTIONS.map((o) => ({
                value: o,
                label: o,
              }))}
              placeholder="All categories"
              ariaLabel="Filter by category"
            />
          </Block>
          <Block label="Asset class" id="etf-filter-assetClass">
            <SearchableSelect
              value={etfFilters?.assetClass ?? null}
              onChange={(next) => updateEtf({ assetClass: next ?? undefined })}
              options={ETF_ASSET_CLASS_OPTIONS.map((o) => ({
                value: o.value,
                label: o.label,
              }))}
              placeholder="Any class"
              ariaLabel="Filter by asset class"
            />
          </Block>
          {/* TODO(MONEY-367): re-enable Theme input once the post-fetch
              theme matcher has reliable data to match against (most
              ETFs lack the MutualFundMaster join the theme keyword
              search depends on for context).
          <Block label="Theme" id="etf-filter-theme">
            <input
              type="text"
              value={etfFilters?.theme ?? ""}
              onChange={(e) =>
                updateEtf({ theme: e.target.value || undefined })
              }
              placeholder="e.g. Nifty 50, Gold"
              className="w-full px-2.5 py-1.5 rounded-[6px] border border-[var(--border-default)] bg-white/[0.02] text-[12px] font-mono text-[var(--text-primary)] placeholder:text-[var(--text-dim)] focus:border-emerald-400/40 focus:outline-none transition-colors"
              aria-label="Filter by theme"
            />
          </Block>
          */}
        </>
      )}

      {/* TODO(MONEY-367): re-enable Min 1Y return / Max expense /
          Min AUM sliders once MutualFundMaster.{returns1Y, expenseRatio,
          aum} are densely populated for both MFs and the major ETFs.
          Today most rows have null for these fields - Prisma's lte/gte
          excludes nulls, the post-fetch lenient check passes them,
          either way the slider feels broken to users. The where-clause
          + post-fetch logic stays wired so this is a UI-only revival.
      <Slider
        label="Min 1Y return"
        value={min1Y}
        min={-20}
        max={60}
        step={1}
        format={(v) => `${v.toFixed(0)}%`}
        onChange={(v) => {
          const patch = v === 0 ? undefined : v;
          updateMf({ minReturns1Y: patch });
          updateEtf({ minReturns1Y: patch });
        }}
      />
      <Slider
        label="Max expense"
        value={maxExp}
        min={0}
        max={3}
        step={0.05}
        format={(v) => `${v.toFixed(2)}%`}
        onChange={(v) => {
          const patch = v >= 3 ? undefined : v;
          updateMf({ maxExpenseRatio: patch });
          updateEtf({ maxExpenseRatio: patch });
        }}
      />
      <Slider
        label="Min AUM"
        value={minAum}
        min={0}
        max={50_000}
        step={500}
        format={(v) => `₹${(v / 1000).toFixed(0)}KCr`}
        onChange={(v) => {
          const patch = v === 0 ? undefined : v;
          updateMf({ minAum: patch });
          updateEtf({ minAum: patch });
        }}
      />
      */}
    </div>
  );
}

function Block({
  label,
  children,
  id,
}: {
  label: string;
  children: React.ReactNode;
  /** MONEY-1248: scroll target so the picker/chips can focus this filter. */
  id?: string;
}) {
  return (
    <div id={id} className="scroll-mt-4">
      <div className="mono text-[9.5px] tracking-[1.4px] uppercase font-bold text-[var(--ink-3)] mb-1.5">
        {label}
      </div>
      {children}
    </div>
  );
}

function Slider({
  label,
  value,
  min,
  max,
  step,
  format,
  onChange,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  format: (v: number) => string;
  onChange: (v: number) => void;
}) {
  return (
    <div>
      <div className="flex items-baseline justify-between mb-1">
        <span className="mono text-[9.5px] tracking-[1.4px] uppercase font-bold text-[var(--ink-3)]">
          {label}
        </span>
        <span
          className="mono text-[12px] font-bold tabular-nums"
          style={{ color: "var(--emerald-text)" }}
        >
          {format(value)}
        </span>
      </div>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        className="w-full"
        style={{ accentColor: "var(--emerald)" }}
        aria-label={label}
      />
    </div>
  );
}

export default FundFilterSidebar;
