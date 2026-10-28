/**
 * Screener inner skeleton (everything below the page header).
 *
 * Shared between two stages of the loading chain so they look identical:
 *   - Stage 1: rendered by `apps/web/app/discover/screener/loading.tsx`
 *     while the route segment is still streaming in.
 *   - Stage 2: rendered as the PageGuard `fallback` while feature flags
 *     + subscription resolve. Without a custom fallback, PageGuard
 *     falls back to a generic 3-card grid that does not match the
 *     screener layout at all (mode tabs + search + toolbar + chips +
 *     results), producing a visible jump between stages.
 *
 * The header (h1 "Screener" + DISCOVER chip + Take-the-tour) lives
 * OUTSIDE the PageGuard in the screener client so the title stays
 * visible across all stages — that's why this skeleton does NOT
 * include it.
 */

import { ResultsSkeleton } from "./ResultsSkeleton";

export function ScreenerInnerSkeleton() {
  return (
    <>
      {/* Mode tabs (Stocks / MF / ETF) */}
      <div
        className="inline-flex gap-1.5 mb-5 rounded-[10px] p-[3px] animate-pulse"
        style={{
          border: "2px solid var(--rule-soft)",
          background: "var(--paper-2)",
        }}
      >
        <div
          className="h-7 w-24 rounded-[7px]"
          style={{ background: "var(--rule-soft)" }}
        />
        <div
          className="h-7 w-32 rounded-[7px]"
          style={{ background: "var(--rule-softer)" }}
        />
      </div>

      {/* Search bar */}
      <div
        className="mt-4 mb-5 h-11 w-full rounded-[8px] animate-pulse"
        style={{
          background: "var(--rule-softer)",
          border: "1.5px solid var(--rule-soft)",
        }}
      />

      {/* Toolbar (status + view + filters + sort) */}
      <div className="flex items-center gap-3 mb-3 flex-wrap">
        <div
          className="h-5 w-24 rounded-full animate-pulse"
          style={{ background: "var(--rule-softer)" }}
        />
        <div className="ml-auto flex items-center gap-1.5">
          <div
            className="h-7 w-24 rounded-[8px] animate-pulse"
            style={{ background: "var(--rule-softer)" }}
          />
          <div
            className="h-7 w-28 rounded-[8px] animate-pulse"
            style={{ background: "var(--rule-softer)" }}
          />
          <div
            className="h-7 w-32 rounded-[8px] animate-pulse"
            style={{ background: "var(--rule-softer)" }}
          />
        </div>
      </div>

      {/* Quick filter chips */}
      <div className="flex gap-2 mb-3 overflow-hidden">
        {Array.from({ length: 7 }).map((_, i) => (
          <div
            key={i}
            className="shrink-0 h-7 w-24 rounded-full animate-pulse"
            style={{ background: "var(--rule-softer)" }}
          />
        ))}
      </div>

      {/* Sector chips */}
      <div className="flex gap-2 mb-4 overflow-hidden">
        {Array.from({ length: 6 }).map((_, i) => (
          <div
            key={i}
            className="shrink-0 h-7 w-28 rounded-full animate-pulse"
            style={{ background: "var(--rule-softer)" }}
          />
        ))}
      </div>

      {/* Cards grid */}
      <ResultsSkeleton view="cards" count={12} />
    </>
  );
}
