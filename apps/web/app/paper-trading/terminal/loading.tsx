import { Skeleton } from "@usemoney/ui/skeleton";

/**
 * Paper trading terminal loading skeleton — playful pf-card chrome
 * (design: PaperTerminalScreen). Renders inside paper-trading/layout.tsx
 * which already provides Sidebar + sub-nav + per-route h1.
 */
export default function PaperTradingTerminalLoading() {
  return (
    <div className="pf-app flex flex-col gap-4">
      {/* Stat strip */}
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fit, minmax(140px, 1fr))",
          gap: 12,
        }}
      >
        {Array.from({ length: 5 }).map((_, i) => (
          <div
            key={i}
            className="pf-card pf-stat flat"
            style={{ background: "var(--rule-softer)" }}
          >
            <Skeleton className="h-3 w-24 bg-muted/70 mb-2" />
            <Skeleton className="h-6 w-20 bg-muted" />
          </div>
        ))}
      </div>

      {/* Stock list + chart */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        <div className="lg:col-span-1 flex flex-col gap-3">
          <Skeleton className="h-10 w-full rounded-lg bg-muted" />
          <Skeleton className="h-8 w-full rounded-lg bg-muted" />
          <div className="pf-card" style={{ padding: 0 }}>
            {Array.from({ length: 6 }).map((_, i) => (
              <div
                key={i}
                style={{
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "space-between",
                  padding: 12,
                  borderBottom: "1px dashed var(--rule-soft)",
                }}
              >
                <div>
                  <Skeleton className="h-4 w-16 bg-muted mb-1" />
                  <Skeleton className="h-3 w-24 bg-muted/70" />
                </div>
                <Skeleton className="h-4 w-14 bg-muted" />
              </div>
            ))}
          </div>
        </div>
        <div className="lg:col-span-2 flex flex-col gap-3">
          <div
            className="pf-card"
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              padding: "12px 16px",
            }}
          >
            <Skeleton className="h-5 w-40 bg-muted" />
            <Skeleton className="h-7 w-24 bg-muted rounded-md" />
          </div>
          <Skeleton className="flex-1 w-full rounded-[14px] bg-muted h-64" />
        </div>
      </div>
    </div>
  );
}
