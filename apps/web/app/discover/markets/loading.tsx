/**
 * Markets loading skeleton (MONEY-242 / MONEY-392).
 *
 * Mirrors `/discover/markets/client.tsx` exactly:
 *   chrome (Sidebar + max-w-[1480px] container)
 *   → Markets · DISCOVER header + "Loading…" status chip
 *   → 6 index cards (grid-cols-2 md:3 xl:6, matches hydrated)
 *   → Heatmap section header (h2 "Heatmap" + meta + scope/timeframe
 *     toggles on the right)
 *   → Heatmap canvas (h-[480px])
 *   → 3-column movers (Gainers / Losers / Most Active)
 *
 * No PageGuard wrapper here - PageGuard lives inside the client page
 * with a matching fallback so stage 2 doesn't blank out.
 */

import Sidebar from "@/components/Sidebar";

export default function MarketsLoading() {
  return (
    <div className="pf-app min-h-screen">
      <Sidebar />
      <main className="lg:ml-[var(--sidebar-w)] min-h-screen pt-[var(--mobile-header-h)] lg:pt-[var(--topbar-h)]">
        <div className="px-4 sm:px-6 py-6 max-w-[1480px] mx-auto">
          {/* Header - matches the hydrated playful pf-ph header. */}
          <div className="pf-ph">
            <div className="l">
              <div className="eyebrow">
                <span className="d" aria-hidden />
                NSE · BSE · LIVE
              </div>
              <h1>
                The market, <span className="ser">in one</span>{" "}
                <span className="hl">breath.</span>
              </h1>
              <div className="sub">
                Indices, sectors, gainers and losers — all NSE/BSE, ranked by
                relevance.
              </div>
            </div>
            <div className="r">
              <span
                className="pf-pill outline"
                style={{ color: "var(--ink-3)" }}
              >
                <span
                  aria-hidden
                  style={{
                    width: 6,
                    height: 6,
                    borderRadius: "50%",
                    background: "var(--ink-3)",
                  }}
                />
                LOADING…
              </span>
            </div>
          </div>

          {/* 6 index cards - matches hydrated `grid-cols-2 md:3 xl:6` */}
          <div className="mb-5 grid grid-cols-2 md:grid-cols-3 xl:grid-cols-6 gap-2.5">
            {Array.from({ length: 6 }).map((_, i) => (
              <div
                key={i}
                className="rounded-xl border border-[var(--border-default)] bg-muted/30 p-3 space-y-1.5 animate-pulse"
              >
                <div className="h-3 w-20 bg-muted/70 rounded" />
                <div className="h-6 w-24 bg-muted/70 rounded" />
                <div className="h-3 w-16 bg-emerald-500/10 dark:bg-emerald-500/15 rounded" />
              </div>
            ))}
          </div>

          {/* Heatmap section */}
          <section className="mb-6">
            <div className="mb-3 flex items-baseline gap-3 flex-wrap">
              <div className="h-5 w-24 bg-muted/70 rounded animate-pulse" />
              <div className="h-3 w-44 bg-muted/50 rounded animate-pulse" />
              <div className="h-3 w-20 bg-muted/40 rounded animate-pulse" />
              <div className="ml-auto flex items-center gap-2 flex-wrap">
                {/* Scope toggle group (3 segments) */}
                <div className="inline-flex items-center gap-0 rounded-lg border border-[var(--border-default)] bg-muted/30 p-[3px]">
                  <div className="h-7 w-16 bg-muted/50 rounded-md animate-pulse" />
                  <div className="h-7 w-16 bg-muted/40 rounded-md animate-pulse" />
                  <div className="h-7 w-16 bg-muted/40 rounded-md animate-pulse" />
                </div>
                {/* Timeframe toggle group (2 segments) */}
                <div className="inline-flex items-center gap-0 rounded-lg border border-[var(--border-default)] bg-muted/30 p-[3px]">
                  <div className="h-7 w-12 bg-muted/50 rounded-md animate-pulse" />
                  <div className="h-7 w-12 bg-muted/40 rounded-md animate-pulse" />
                </div>
              </div>
            </div>

            {/* Heatmap canvas */}
            <div className="rounded-xl border border-[var(--border-default)] bg-muted/30 h-[480px] animate-pulse" />
            {/* Heatmap legend */}
            <div className="h-4 w-full max-w-md bg-muted/40 rounded animate-pulse mt-2" />
          </section>

          {/* 3-column movers - Gainers / Losers / Most Active */}
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3.5">
            {Array.from({ length: 3 }).map((_, i) => (
              <div
                key={i}
                className="rounded-xl border border-[var(--border-default)] bg-muted/30 p-4"
              >
                <div className="h-3 w-24 bg-muted/70 rounded animate-pulse mb-3" />
                {Array.from({ length: 5 }).map((__, j) => (
                  <div
                    key={j}
                    className="flex items-center gap-2 py-2 border-b last:border-b-0 border-[var(--border-default)] animate-pulse"
                  >
                    <div className="h-4 w-16 bg-emerald-500/10 dark:bg-emerald-500/15 rounded" />
                    <div className="h-4 w-24 bg-muted/50 rounded" />
                    <div className="h-4 w-12 bg-muted/50 rounded ml-auto" />
                  </div>
                ))}
              </div>
            ))}
          </div>
        </div>
      </main>
    </div>
  );
}
