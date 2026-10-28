"use client";

/**
 * SUGGESTED chips at the bottom of the Screener filter sidebar
 * (MONEY-243, design Image #42).
 *
 * Pure presentational - clicking a chip calls `onPick(metric)` so the
 * parent can scroll/expand the matching FilterCard. We don't try to
 * dispatch the filter action directly here because every metric has
 * a different default range UX; bouncing the user to the existing
 * FilterCard preserves the sidebar's shared editing model.
 */

import { remainingSuggestions } from "./suggested-filters-logic";

interface SuggestedChipsProps {
  onPick: (metric: string) => void;
  /**
   * MONEY-1247 — ids of filters the user has ALREADY set. Those chips are
   * hidden, because suggesting a filter that is already applied is not a
   * suggestion. Every one of the six used to show unconditionally while the
   * sidebar rendered a card for each of them, so the whole section only ever
   * offered what was already on screen.
   */
  activeIds?: readonly string[];
}

export function SuggestedChips({
  onPick,
  activeIds = [],
}: SuggestedChipsProps) {
  // Shared with the "+ Add filter" picker and asserted directly by the tests,
  // so the shipped list and the tested list cannot drift.
  const remaining = remainingSuggestions(activeIds);

  // Nothing left to suggest once every metric is in use. Rendering an empty
  // "SUGGESTED" heading would read as a broken section.
  if (remaining.length === 0) return null;

  return (
    <div className="pt-1">
      <div className="mono text-[9.5px] tracking-[1.4px] uppercase font-bold text-[var(--ink-3)] mb-2">
        Suggested
      </div>
      <div className="flex flex-wrap gap-1.5">
        {remaining.map((s) => (
          <button
            key={s.id}
            type="button"
            onClick={() => onPick(s.id)}
            className="pf-pill outline cursor-pointer hover:text-[var(--emerald-text)] hover:border-[var(--emerald)] transition-colors"
            style={{ fontSize: 10.5 }}
          >
            <span className="font-bold">+</span>
            {s.label}
          </button>
        ))}
      </div>
    </div>
  );
}

export default SuggestedChips;
