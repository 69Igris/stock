import { Skeleton } from "@usemoney/ui/skeleton";

/**
 * /paper-trading/analytics loading skeleton.
 *
 * The analytics route redirects to /paper-trading, so this is rarely seen;
 * it mirrors the playful pf-card chrome for the brief redirect window.
 */
export default function PaperAnalyticsLoading() {
  return (
    <div className="pf-app">
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
            <Skeleton className="h-3 w-20 bg-muted/70 mb-2" />
            <Skeleton className="h-7 w-24 bg-muted" />
          </div>
        ))}
      </div>
      <div
        style={{ display: "grid", gridTemplateColumns: "1.6fr 1fr", gap: 18 }}
      >
        <div className="pf-card" style={{ padding: 20 }}>
          <Skeleton className="h-[200px] w-full bg-muted rounded" />
        </div>
        <div className="pf-card" style={{ padding: 18 }}>
          <div className="space-y-3">
            {Array.from({ length: 4 }).map((_, i) => (
              <Skeleton
                key={i}
                className="h-3.5 w-full bg-muted rounded-full"
              />
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
