"use client";

import { Plus } from "lucide-react";
import type { ReactNode } from "react";

interface FilterSidebarProps {
  /** "FILTERS · {activeCount} active" header counter. Used when no
   *  `onResetAll` is supplied; ignored otherwise. */
  activeCount: number;
  children: ReactNode;
  /** Called when the user clicks "+ Add filter". Optional. */
  onAddFilter?: () => void;
  /** When set, renders a "Reset all" link in the header that calls this. */
  onResetAll?: () => void;
  /** Optional pre-children block - e.g. UniverseSection. Sits above the
   *  filter cards. */
  pre?: ReactNode;
  /** Optional post-children block - e.g. SuggestedChips. */
  post?: ReactNode;
  /** Header label override - defaults to "Filters". */
  title?: string;
  /** Layout variant. `column` (default) = legacy 320px sidebar that
   *  sits beside the results. `panel` = full-width panel placed below
   *  the toolbar (no width clamp, no right border). The internal stack
   *  of filter cards is identical in both. */
  variant?: "column" | "panel";
  /** Suppress the in-component header entirely. Used when the parent
   *  (e.g. the mobile bottom sheet) already renders its own "Filters"
   *  + Reset/Close affordances and the inner one would duplicate. */
  hideHeader?: boolean;
}

/**
 * Compact 320px filter panel. Header reads "Filters" with optional
 * "Reset all" link on the right (matches design Image #42); body slots
 * an optional `pre` block (UNIVERSE), the filter cards, the
 * "+ Add filter" CTA, and an optional `post` block (SUGGESTED chips).
 */
export function FilterSidebar({
  activeCount,
  children,
  onAddFilter,
  onResetAll,
  pre,
  post,
  title = "Filters",
  variant = "panel",
  hideHeader = false,
}: FilterSidebarProps) {
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
      {!hideHeader && (
        <div
          className="flex items-center pb-2.5"
          style={{ borderBottom: "1.5px solid var(--ink)" }}
        >
          <span className="mono text-[10.5px] tracking-[1.5px] font-bold uppercase text-[var(--ink-2)]">
            {title}
            {!onResetAll && activeCount > 0 ? (
              <span className="ml-1 text-[var(--emerald-text)]">
                · {activeCount} active
              </span>
            ) : (
              ""
            )}
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
      )}

      {pre}

      <div className="space-y-2">{children}</div>

      <button
        type="button"
        onClick={onAddFilter}
        disabled={!onAddFilter}
        className="w-full flex items-center justify-center gap-1.5 mt-2 px-3 py-2.5 rounded-[10px] text-[12.5px] mono font-semibold transition-colors disabled:opacity-50 disabled:cursor-not-allowed cursor-pointer text-[var(--ink-3)] hover:text-[var(--emerald-text)]"
        style={{ border: "1.5px dashed var(--rule-soft)" }}
      >
        <Plus className="h-3.5 w-3.5" />
        Add filter
      </button>

      {post}
    </div>
  );
}

export default FilterSidebar;
