"use client";

/**
 * Shimmer skeleton placeholder for the screener results grid/table.
 * Renders the same layout as a populated page (cards or table) so the
 * pane doesn't jump when real data arrives.
 *
 * Used by stocks-mode, mf-mode, etf-mode while a server action is in
 * flight after a filter/query/sort/page change.
 *
 * Theme-aware: shimmer blocks use the playful --rule-soft / --emerald-bg
 * tokens so the skeleton reads correctly in both light + dark themes and
 * matches the .pf-card surfaces it stands in for (MONEY-485).
 */

interface ResultsSkeletonProps {
  view: "cards" | "table";
  /** Approximate row count to show. Defaults to PAGE_SIZE (25) so the
   *  pane height matches the eventual content. */
  count?: number;
}

export function ResultsSkeleton({ view, count = 12 }: ResultsSkeletonProps) {
  if (view === "cards") {
    return (
      <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-3 gap-3">
        {Array.from({ length: count }).map((_, i) => (
          <CardSkeleton key={i} />
        ))}
      </div>
    );
  }
  return <TableSkeleton count={count} />;
}

function CardSkeleton() {
  return (
    <div
      className="pf-card flat space-y-3 animate-pulse"
      style={{ padding: 16 }}
    >
      <div className="flex items-center gap-2">
        <div
          className="h-4 w-12 rounded"
          style={{ background: "var(--emerald-bg)" }}
        />
        <div
          className="h-3 w-24 rounded"
          style={{ background: "var(--rule-soft)" }}
        />
      </div>
      <div
        className="h-4 w-3/4 rounded"
        style={{ background: "var(--rule-soft)" }}
      />
      <div className="grid grid-cols-3 gap-2">
        <div
          className="h-3 rounded"
          style={{ background: "var(--rule-softer)" }}
        />
        <div
          className="h-3 rounded"
          style={{ background: "var(--rule-softer)" }}
        />
        <div
          className="h-3 rounded"
          style={{ background: "var(--rule-softer)" }}
        />
      </div>
      <div
        className="h-1.5 w-full rounded"
        style={{ background: "var(--rule-softer)" }}
      >
        <div
          className="h-1.5 w-2/3 rounded animate-pulse"
          style={{ background: "var(--emerald)" }}
        />
      </div>
    </div>
  );
}

function TableSkeleton({ count }: { count: number }) {
  return (
    <div className="pf-card" style={{ padding: 0, overflow: "hidden" }}>
      <div
        className="px-3.5 py-2.5"
        style={{ borderBottom: "1.5px solid var(--rule-soft)" }}
      >
        <div
          className="h-3 w-24 rounded animate-pulse"
          style={{ background: "var(--rule-soft)" }}
        />
      </div>
      {Array.from({ length: count }).map((_, i) => (
        <div
          key={i}
          className="flex items-center gap-3 px-3.5 py-3 animate-pulse"
          style={{
            borderBottom: i === count - 1 ? "0" : "1px dashed var(--rule-soft)",
          }}
        >
          <div
            className="h-3 w-16 rounded"
            style={{ background: "var(--emerald-bg)" }}
          />
          <div
            className="h-3 w-10 rounded"
            style={{ background: "var(--rule-soft)" }}
          />
          <div
            className="h-3 w-20 rounded ml-auto"
            style={{ background: "var(--rule-softer)" }}
          />
          <div
            className="h-3 w-12 rounded"
            style={{ background: "var(--rule-softer)" }}
          />
          <div
            className="h-3 w-12 rounded"
            style={{ background: "var(--rule-softer)" }}
          />
          <div
            className="h-3 w-16 rounded"
            style={{ background: "var(--rule-softer)" }}
          />
        </div>
      ))}
    </div>
  );
}

export default ResultsSkeleton;
