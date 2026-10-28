"use client";

/**
 * Screener pagination footer (MONEY-243).
 *
 * Shared by stocks/mf/etf modes - renders the "Showing 1–25 of 4,744"
 * line plus emerald-anchored numeric chips with ellipsis collapse for
 * long ranges (designs Image #71/#72: "1, 2, …, 396"). Mirrors the
 * ergonomics of `components/PaginationControls` but uses the screener
 * monospace styling.
 */

import { useMemo } from "react";
import { ChevronLeft, ChevronRight } from "lucide-react";

interface ScreenerPaginationProps {
  /** 1-indexed start of the current page in the matched set. */
  startIdx: number;
  /** 1-indexed end of the current page in the matched set. */
  endIdx: number;
  /** Total matched-set size - drives the "of N" suffix. */
  total: number;
  /** Current page (0-indexed). Already clamped by the caller. */
  page: number;
  /** Number of pages. */
  totalPages: number;
  onPageChange: (next: number) => void;
}

export function ScreenerPagination({
  startIdx,
  endIdx,
  total,
  page,
  totalPages,
  onPageChange,
}: ScreenerPaginationProps) {
  // Build the visible chip list: first, last, and current ± 1.
  // Replace runs of skipped pages with an ellipsis marker. <= 7 pages
  // → render every chip without ellipsis (the design's threshold).
  const chips: Array<number | "ellipsis"> = useMemo(() => {
    if (totalPages <= 7) return Array.from({ length: totalPages }, (_, i) => i);
    const set = new Set<number>([0, totalPages - 1, page - 1, page, page + 1]);
    const sorted = Array.from(set)
      .filter((n) => n >= 0 && n < totalPages)
      .sort((a, b) => a - b);
    const out: Array<number | "ellipsis"> = [];
    for (let i = 0; i < sorted.length; i++) {
      if (i > 0 && sorted[i] - sorted[i - 1] > 1) out.push("ellipsis");
      out.push(sorted[i]);
    }
    return out;
  }, [totalPages, page]);

  const onPrev = () => onPageChange(Math.max(0, page - 1));
  const onNext = () => onPageChange(Math.min(totalPages - 1, page + 1));

  return (
    <div className="mt-3 flex items-center gap-3 px-1 whitespace-nowrap overflow-x-auto">
      <span className="mono text-[11px] text-[var(--ink-3)] shrink-0">
        <span className="text-[var(--ink-2)] tabular-nums">
          {startIdx}–{endIdx}
        </span>{" "}
        of{" "}
        <span className="text-[var(--ink-2)] tabular-nums">
          {total.toLocaleString("en-IN")}
        </span>
      </span>
      <div className="ml-auto flex items-center gap-1 shrink-0">
        <button
          onClick={onPrev}
          disabled={page === 0}
          aria-label="Previous page"
          className="pf-bf sm disabled:opacity-40 disabled:cursor-not-allowed"
          style={{ padding: "6px 8px" }}
        >
          <ChevronLeft className="h-3 w-3" />
        </button>
        {chips.map((chip, idx) => {
          if (chip === "ellipsis") {
            return (
              <span
                key={`ellipsis-${idx}`}
                className="mono text-[11px] text-[var(--ink-3)] px-1"
              >
                …
              </span>
            );
          }
          const active = chip === page;
          return (
            <button
              key={chip}
              onClick={() => onPageChange(chip)}
              className="min-w-[28px] px-2 py-1 rounded-[6px] mono text-[11.5px] font-bold tabular-nums cursor-pointer transition-colors"
              style={
                active
                  ? {
                      background: "var(--emerald)",
                      color: "var(--paper)",
                      border: "1.5px solid var(--emerald)",
                    }
                  : {
                      color: "var(--ink-3)",
                      border: "1.5px solid transparent",
                    }
              }
              aria-current={active ? "page" : undefined}
            >
              {chip + 1}
            </button>
          );
        })}
        <button
          onClick={onNext}
          disabled={page >= totalPages - 1}
          aria-label="Next page"
          className="pf-bf sm disabled:opacity-40 disabled:cursor-not-allowed"
          style={{ padding: "6px 8px" }}
        >
          <ChevronRight className="h-3 w-3" />
        </button>
      </div>
    </div>
  );
}

export default ScreenerPagination;
