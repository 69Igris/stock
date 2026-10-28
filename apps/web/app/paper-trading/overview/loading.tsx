import { Skeleton } from "@usemoney/ui/skeleton";

/**
 * /paper-trading/overview loading skeleton — playful pf-card chrome
 * (design: PaperOverviewScreen).
 *   stat strip → equity curve + win/loss → open positions + watchlist rail
 *
 * Renders inside the paper-trading layout's chrome (which provides the
 * sub-nav + per-route h1), so only the content area shows.
 */
export default function PaperTradingOverviewLoading() {
  return (
    <div className="pf-app">
      {/* Stat strip */}
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))",
          gap: 12,
          marginBottom: 18,
        }}
      >
        {Array.from({ length: 4 }).map((_, i) => (
          <div
            key={i}
            className="pf-card pf-stat flat"
            style={{ background: "var(--rule-softer)" }}
          >
            <Skeleton className="h-3 w-24 bg-muted/70 mb-2" />
            <Skeleton className="h-6 w-28 bg-muted mb-2" />
            <Skeleton className="h-3 w-16 bg-muted/60" />
          </div>
        ))}
      </div>

      {/* Equity curve + win/loss */}
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "1.6fr 1fr",
          gap: 18,
          marginBottom: 18,
        }}
      >
        <div className="pf-card" style={{ padding: 20 }}>
          <Skeleton className="h-3 w-40 bg-muted mb-3" />
          <Skeleton className="h-[200px] w-full bg-muted rounded" />
        </div>
        <div className="pf-card" style={{ padding: 18 }}>
          <Skeleton className="h-3 w-40 bg-muted mb-3" />
          <div className="space-y-3">
            {Array.from({ length: 3 }).map((_, i) => (
              <Skeleton
                key={i}
                className="h-3.5 w-full bg-muted rounded-full"
              />
            ))}
          </div>
        </div>
      </div>

      {/* Open positions + watchlist rail */}
      <div
        style={{ display: "grid", gridTemplateColumns: "1fr 360px", gap: 18 }}
      >
        <div className="pf-card" style={{ padding: 0, overflow: "hidden" }}>
          <div
            style={{
              padding: "14px 18px",
              borderBottom: "1.5px dashed var(--rule-soft)",
              display: "flex",
              justifyContent: "space-between",
            }}
          >
            <Skeleton className="h-5 w-32 bg-muted" />
            <Skeleton className="h-7 w-24 bg-emerald-500/15 dark:bg-emerald-500/25 rounded-md" />
          </div>
          {Array.from({ length: 5 }).map((_, i) => (
            <div
              key={i}
              style={{
                display: "flex",
                alignItems: "center",
                justifyContent: "space-between",
                padding: "12px 18px",
                borderBottom: "1px dashed var(--rule-soft)",
              }}
            >
              <Skeleton className="h-4 w-24 bg-muted" />
              <Skeleton className="h-4 w-16 bg-muted" />
              <Skeleton className="h-7 w-12 bg-muted rounded-md" />
            </div>
          ))}
        </div>
        <div className="pf-card" style={{ padding: 16 }}>
          <Skeleton className="h-4 w-24 bg-muted mb-3" />
          <div className="space-y-2">
            {Array.from({ length: 6 }).map((_, i) => (
              <div
                key={i}
                style={{
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "space-between",
                  paddingBottom: 8,
                  borderBottom: "1px dashed var(--rule-soft)",
                }}
              >
                <Skeleton className="h-4 w-16 bg-muted" />
                <Skeleton className="h-3 w-12 bg-muted/60" />
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
