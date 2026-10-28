"use client";

/**
 * Horizontal sector chip strip for the Screener stocks tab.
 *
 * Reads the same `sector` filter that the FilterCard sidebar reads - the
 * strip is just a faster surface for the most common sectors. Click a chip
 * to set the filter; click the active chip again to clear.
 *
 * Responsive: on `< md` viewports the strip collapses to a single
 * "Sector ▼" button that opens a sheet with the same chips (design
 * Image #68). The chips reflow into a wrap so users can tap whichever
 * one they want without horizontal scrolling.
 */

import { useState } from "react";
import { ChevronDown, X } from "lucide-react";
import type { SectorOption } from "@/app/discover/screener/stocks-mode";

interface SectorChipsProps {
  options: readonly SectorOption[];
  active: string | null;
  onChange: (next: string | null) => void;
  /** Cap how many sectors show as chips before scrolling. Default 12. */
  maxChips?: number;
}

/**
 * Which chips to render, and in what order (MONEY-1157).
 *
 * Normally: only sectors that actually contain stocks, biggest first, capped.
 *
 * The exception is what this helper exists for. `count > 0` treats "0" as
 * "empty sector", but an all-zero option list means the counts are
 * UNAVAILABLE, not that every sector is empty — the screener page falls back to
 * the canonical taxonomy with `count: 0` whenever the Discover summary is
 * degraded or cold. Filtering on `count > 0` then removed EVERY chip, so the
 * sector strip silently vanished on exactly the loads where a user most needs
 * a way to narrow the list, and an outage looked identical to an empty market.
 * With no counts to rank by we keep the taxonomy's own order and render the
 * labels alone (`Chip` already hides a zero count), so the filter stays usable.
 *
 * Exported for test — the component calls THIS, so the assertion and production
 * run the same code.
 */
export function visibleSectorChips(
  options: readonly SectorOption[],
  maxChips: number
): readonly SectorOption[] {
  const populated = options.filter((s) => s.count > 0);
  if (populated.length === 0) return options.slice(0, maxChips);
  return populated.sort((a, b) => b.count - a.count).slice(0, maxChips);
}

export function SectorChips({
  options,
  active,
  onChange,
  maxChips = 12,
}: SectorChipsProps) {
  const sorted = visibleSectorChips(options, maxChips);

  const [mobileOpen, setMobileOpen] = useState(false);

  return (
    <>
      {/* Desktop: wrapping chip strip. `flex-wrap` lets the sector chips
          reflow onto additional rows instead of overflowing/overlapping
          when the row runs out of horizontal space.

          #225: dropped the old `-mx-1 ... px-1 pb-1 mb-1` hack — the negative
          margin plus bottom-only padding clipped the first chip row at the
          top and crowded the strip. Symmetric `gap-2` (incl. row-gap for
          wrapped lines) and `py-0.5` keep the chips clear of the wrapper
          edges; the parent's `gap-2.5` owns the spacing to the row above. */}
      <div className="hidden md:flex gap-2 flex-wrap py-0.5">
        <Chip
          label="All sectors"
          active={!active}
          count={null}
          onClick={() => onChange(null)}
        />
        {sorted.map((s) => (
          <Chip
            key={s.name}
            label={s.name}
            count={s.count}
            active={active === s.name}
            onClick={() => onChange(active === s.name ? null : s.name)}
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
            active
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
          <span>Sector{active ? `: ${active}` : ""}</span>
          <ChevronDown className="h-3 w-3" />
        </button>
      </div>

      {mobileOpen && (
        <MobileSectorSheet
          options={sorted}
          active={active}
          onChange={(next) => {
            onChange(next);
            setMobileOpen(false);
          }}
          onClose={() => setMobileOpen(false)}
        />
      )}
    </>
  );
}

function MobileSectorSheet({
  options,
  active,
  onChange,
  onClose,
}: {
  options: readonly SectorOption[];
  active: string | null;
  onChange: (next: string | null) => void;
  onClose: () => void;
}) {
  return (
    <div className="md:hidden fixed inset-0 z-50 flex items-end">
      {/* Backdrop */}
      <button
        type="button"
        aria-label="Close sectors"
        onClick={onClose}
        className="absolute inset-0 bg-black/50 cursor-pointer"
      />
      {/* Bottom sheet */}
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
            Sectors
          </span>
          <button
            type="button"
            onClick={onClose}
            className="ml-auto text-[var(--ink-3)] hover:text-[var(--emerald-text)] cursor-pointer"
            aria-label="Close"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
        <div className="flex flex-wrap gap-2">
          <Chip
            label="All sectors"
            active={!active}
            count={null}
            onClick={() => onChange(null)}
          />
          {options.map((s) => (
            <Chip
              key={s.name}
              label={s.name}
              count={s.count}
              active={active === s.name}
              onClick={() => onChange(active === s.name ? null : s.name)}
            />
          ))}
        </div>
      </div>
    </div>
  );
}

function Chip({
  label,
  count,
  active,
  onClick,
}: {
  label: string;
  count: number | null;
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
      <span>{label}</span>
      {count !== null && count > 0 && (
        <span
          className="tabular-nums text-[10px] font-bold"
          style={{ opacity: active ? 0.85 : 0.6 }}
        >
          {count}
        </span>
      )}
    </button>
  );
}

export default SectorChips;
