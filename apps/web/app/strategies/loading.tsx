import Sidebar from "@/components/Sidebar";
import { Skeleton } from "@usemoney/ui/skeleton";

/**
 * /strategies loading skeleton — mirrors the playful (MONEY-485)
 * StrategiesClient:
 *   - pf-ph hero ("Strategies that earn their keep") + (Build custom /
 *     Create with AI) action buttons on the right
 *   - 6-tab primary row (Catalog / Detail / Backtest / Forward /
 *     Build custom / Create AI)
 *   - Category pill row + search + universe chips + sort
 *   - pf-card catalog grid (6 stats + sparkline footer)
 *
 * Container width matches the live page (max-w-[1600px]).
 */
export default function StrategiesLoading() {
  return (
    <div className="pf-app min-h-screen">
      <Sidebar />
      <main className="lg:ml-[var(--sidebar-w)] min-h-screen pt-[var(--mobile-header-h)] lg:pt-[var(--topbar-h)]">
        <div className="pf-page" style={{ paddingTop: 16 }}>
          {/* pf-ph hero */}
          <div className="pf-ph">
            <div className="l">
              <div className="eyebrow">
                <span className="d" aria-hidden />
                RESEARCH · STRATEGIES
              </div>
              <h1>
                Strategies that <span className="ser">earn</span>{" "}
                <span className="hl">their keep.</span>
              </h1>
              <div className="sub">
                Backtested on 8 years of NSE data — fork, run, or paper-trade
                any of them.
              </div>
            </div>
            <div className="r">
              <Skeleton className="h-9 w-32 rounded-lg" />
              <Skeleton className="h-9 w-36 rounded-lg" />
            </div>
          </div>

          {/* 6-tab primary row */}
          <div
            style={{
              display: "flex",
              gap: 10,
              flexWrap: "wrap",
              borderBottom: "2px solid var(--ink)",
              paddingBottom: 10,
              marginBottom: 20,
            }}
          >
            {[80, 70, 80, 80, 110, 90].map((w, i) => (
              <Skeleton
                key={i}
                className="h-6 rounded-md"
                style={{ width: w }}
              />
            ))}
          </div>

          {/* Category pill row */}
          <div className="flex gap-2 flex-wrap mb-3">
            {[44, 60, 84, 60, 64, 112, 64, 60].map((w, i) => (
              <Skeleton
                key={i}
                className="h-6 rounded-full"
                style={{ width: w }}
              />
            ))}
          </div>

          {/* Search + chips + sort */}
          <div className="flex items-center gap-2 flex-wrap mb-5">
            <Skeleton className="h-10 flex-1 min-w-[220px] rounded-lg" />
            <Skeleton className="h-6 w-20 rounded-full" />
            <Skeleton className="h-6 w-24 rounded-full" />
            <Skeleton className="h-6 w-16 rounded-full" />
            <Skeleton className="h-8 w-24 rounded-lg ml-auto" />
          </div>

          {/* Catalog cards */}
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "repeat(auto-fill, minmax(300px, 1fr))",
              gap: 14,
            }}
          >
            {Array.from({ length: 9 }).map((_, i) => (
              <div key={i} className="pf-card" style={{ padding: 18 }}>
                <div className="flex items-start justify-between gap-3 mb-2">
                  <Skeleton className="h-4 w-3/5 rounded" />
                  <Skeleton className="h-5 w-16 rounded-full" />
                </div>
                <Skeleton className="h-3 w-full rounded mb-1.5" />
                <Skeleton className="h-3 w-4/5 rounded mb-4" />
                <div className="grid grid-cols-3 gap-x-3 gap-y-2.5 mb-4">
                  {Array.from({ length: 6 }).map((_, j) => (
                    <div key={j} className="space-y-1">
                      <Skeleton className="h-2 w-10 rounded" />
                      <Skeleton className="h-3 w-12 rounded" />
                    </div>
                  ))}
                </div>
                <div className="pt-3 border-t border-dashed border-[var(--rule-soft)]">
                  <Skeleton className="h-8 w-full rounded" />
                </div>
              </div>
            ))}
          </div>
        </div>
      </main>
    </div>
  );
}
