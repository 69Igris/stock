"use client";

/**
 * Quick-preset filter chips for the Screener stocks tab.
 *
 * Each chip applies a curated combination of filters on top of the user's
 * existing filter state. Toggling the chip off restores the prior state
 * for that field set. The chips operate ON the same `ScreenFilters`
 * object the FilterCard sidebar edits - this is a faster surface for
 * the most common workflows ("show me undervalued large caps").
 *
 * Responsive: on `< md` viewports the strip collapses to a "Quick
 * filters ▼" button that opens a sheet with the same chips reflowed
 * into a wrap, so users can tap them without horizontal scroll.
 */

import { useState } from "react";
import { ChevronDown, X } from "lucide-react";
import type { MarketCapBucket, ScreenFilters } from "@/lib/actions/screener";

interface QuickFilterChipsProps {
  filters: ScreenFilters;
  onChange: (next: ScreenFilters) => void;
}

interface QuickPreset {
  id: string;
  label: string;
  /** Diff to merge into filters when activating. Returning a partial means
   *  "set these fields to these values; clear if undefined". */
  apply: (current: ScreenFilters) => Partial<ScreenFilters>;
  /** Same shape - returns the cleanup needed to deactivate the preset.
   *  Default reverses everything `apply` set. */
  isActive: (current: ScreenFilters) => boolean;
}

const PRESETS: QuickPreset[] = [
  {
    id: "lc",
    label: "Large cap",
    apply: () => ({
      marketCapBucket: "LARGE" as MarketCapBucket,
    }),
    isActive: (f) => f.marketCapBucket === "LARGE",
  },
  {
    id: "mc",
    label: "Mid cap",
    apply: () => ({
      marketCapBucket: "MID" as MarketCapBucket,
    }),
    isActive: (f) => f.marketCapBucket === "MID",
  },
  {
    id: "sc",
    label: "Small cap",
    apply: () => ({
      marketCapBucket: "SMALL" as MarketCapBucket,
    }),
    isActive: (f) => f.marketCapBucket === "SMALL",
  },
  {
    id: "qroe",
    label: "Quality (ROE>20)",
    apply: () => ({ minRoe: 20 }),
    isActive: (f) => (f.minRoe ?? -1) >= 20,
  },
  {
    id: "lev",
    label: "Low debt",
    apply: () => ({ maxDebtToEquity: 0.5 }),
    isActive: (f) => (f.maxDebtToEquity ?? Infinity) <= 0.5,
  },
  {
    id: "val",
    label: "Undervalued (P/E<20)",
    apply: () => ({ maxPe: 20 }),
    isActive: (f) => (f.maxPe ?? Infinity) <= 20,
  },
  {
    id: "growth",
    label: "Revenue growth >25%",
    apply: () => ({ minRevenueGrowth: 25 }),
    isActive: (f) => (f.minRevenueGrowth ?? -1) >= 25,
  },
  // MONEY-779: the previous two chips ("Near 52W high/low") were FAKE — they
  // applied unrelated proxy filters (minRevenueGrowth / maxPe) and hardcoded
  // `isActive: () => false`, so they never reflected selected state and never
  // did what the label claimed. There is no 52-week high/low field anywhere in
  // the data model (neither StockRatios nor LatestQuote carry a 52w range, only
  // intraday high/low), so a genuine "distance from 52W" filter is impossible
  // today. Replaced with a real, genuinely-supported dividend-yield preset that
  // toggles correctly. (If a 52w-range field is ever synced, add it back as a
  // real chip then.)
  {
    id: "div",
    label: "Dividend payers (>2%)",
    apply: () => ({ minDividendYield: 2 }),
    isActive: (f) => (f.minDividendYield ?? -1) >= 2,
  },
];

export function QuickFilterChips({ filters, onChange }: QuickFilterChipsProps) {
  const [mobileOpen, setMobileOpen] = useState(false);

  function toggle(preset: QuickPreset) {
    if (preset.isActive(filters)) {
      // Reverse - strip whatever fields the preset set.
      const patch: Partial<ScreenFilters> = {};
      const applied = preset.apply(filters);
      for (const k of Object.keys(applied) as Array<keyof ScreenFilters>) {
        patch[k] = undefined;
      }
      onChange({ ...filters, ...patch });
    } else {
      onChange({ ...filters, ...preset.apply(filters) });
    }
  }

  const activeCount = PRESETS.filter((p) => p.isActive(filters)).length;

  return (
    <>
      {/* Desktop: wrapping chip strip. `flex-wrap` lets the chips reflow
          onto additional rows instead of overflowing/overlapping when the
          row runs out of horizontal space.

          #225: dropped the old `-mx-1 ... px-1 pb-1 mb-1` hack so this row
          stays visually aligned with the sector strip below and isn't
          clipped at the top; the parent stack's `gap-2.5` owns the spacing
          between the two chip rows. */}
      <div className="hidden md:flex gap-2 flex-wrap py-0.5">
        {PRESETS.map((p) => (
          <ChipButton
            key={p.id}
            label={p.label}
            active={p.isActive(filters)}
            onClick={() => toggle(p)}
          />
        ))}
      </div>

      {/* Mobile: single dropdown button */}
      <div className="md:hidden mb-3">
        <button
          type="button"
          onClick={() => setMobileOpen(true)}
          className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-[8px] text-[12px] mono font-bold transition-colors cursor-pointer"
          style={
            activeCount > 0
              ? {
                  background: "var(--emerald)",
                  color: "var(--paper)",
                  border: "1.5px solid var(--emerald)",
                }
              : {
                  background: "var(--paper)",
                  color: "var(--ink)",
                  border: "1.5px solid var(--ink)",
                }
          }
        >
          <span>Quick filters{activeCount > 0 ? ` · ${activeCount}` : ""}</span>
          <ChevronDown className="h-3 w-3" />
        </button>
      </div>

      {mobileOpen && (
        <div className="md:hidden fixed inset-0 z-50 flex items-end">
          <button
            type="button"
            aria-label="Close quick filters"
            onClick={() => setMobileOpen(false)}
            className="absolute inset-0 bg-black/50 cursor-pointer"
          />
          <div
            className="relative w-full rounded-t-[22px] p-4 max-h-[70vh] overflow-y-auto animate-in slide-in-from-bottom duration-200"
            style={{
              background: "var(--paper)",
              border: "2px solid var(--ink)",
              borderBottom: 0,
            }}
          >
            <div className="flex items-center mb-3">
              <span className="mono text-[10.5px] tracking-[1.5px] uppercase font-bold text-[var(--ink-2)]">
                Quick filters
              </span>
              <button
                type="button"
                onClick={() => setMobileOpen(false)}
                className="ml-auto text-[var(--ink-3)] hover:text-[var(--emerald-text)] cursor-pointer"
                aria-label="Close"
              >
                <X className="h-4 w-4" />
              </button>
            </div>
            <div className="flex flex-wrap gap-2">
              {PRESETS.map((p) => (
                <ChipButton
                  key={p.id}
                  label={p.label}
                  active={p.isActive(filters)}
                  onClick={() => toggle(p)}
                />
              ))}
            </div>
          </div>
        </div>
      )}
    </>
  );
}

function ChipButton({
  label,
  active,
  onClick,
}: {
  label: string;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`pf-pill shrink-0 cursor-pointer transition-colors ${active ? "emerald" : "outline"}`}
      style={{ fontSize: 11 }}
    >
      {active && <span>✓</span>}
      <span>{label}</span>
    </button>
  );
}

export default QuickFilterChips;
