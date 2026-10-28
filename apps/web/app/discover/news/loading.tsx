import Sidebar from "@/components/Sidebar";
import { Skeleton } from "@usemoney/ui/skeleton";

/**
 * /discover/news loading skeleton — mirrors PageGuard's loading stage
 * (stage 2) so stages 1 → 2 stay pixel-stable:
 *   - "News & Events" 32px + "Tools" tagline + description on its own line
 *   - 4 primary tabs (Live feed / My feeds / Alerts / Notifications)
 *   - Category sub-tab strip + sources chip strip
 *   - 2-col grid: feed (left) + Alerts/Notifications sidebar (right)
 *
 * The playful (pf-*) chrome is intentionally NOT applied here: it's the
 * hydrated stage-3 reveal (NewsChrome). Stage 1 + stage 2 share the dark
 * bg-background + plain title so only one transition happens at hydration.
 */
export default function NewsLoading() {
  return (
    <div className="pf-app min-h-screen">
      <Sidebar />
      <main className="lg:ml-[var(--sidebar-w)] min-h-screen pt-[var(--mobile-header-h)] lg:pt-[var(--topbar-h)]">
        <div className="px-6 py-6 max-w-[1280px] mx-auto">
          {/* Title row — matches PageGuard stage 2 (plain title + Tools
              chip + description). The LIVE pill is intentionally NOT
              rendered here: it's a live-data signal the hydrated
              NewsChrome owns. */}
          <div className="flex items-baseline gap-3 mb-6 flex-wrap">
            <h1 className="font-display text-[32px] font-bold tracking-[-0.5px] text-[var(--text-primary)] leading-none m-0">
              News &amp; Events
            </h1>
            <span className="font-mono text-[11px] uppercase tracking-[1.2px] text-[var(--text-muted)] font-bold">
              Tools
            </span>
            <p className="basis-full text-[13px] text-[var(--text-muted)] mt-1 m-0">
              Feeds, alerts &amp; notifications — all in one place.
            </p>
          </div>

          {/* Primary tab strip */}
          <div className="flex gap-1.5 mb-4 flex-wrap">
            <Skeleton className="h-7 w-24 bg-emerald-500/15 dark:bg-emerald-500/25 rounded-md" />
            <Skeleton className="h-7 w-28 bg-[var(--bg-elevated)] rounded-md" />
            <Skeleton className="h-7 w-20 bg-[var(--bg-elevated)] rounded-md" />
            <Skeleton className="h-7 w-28 bg-[var(--bg-elevated)] rounded-md" />
          </div>

          {/* Live-feed body: left column + right aside */}
          <div className="grid grid-cols-1 lg:grid-cols-[1fr_300px] gap-5">
            <div>
              {/* Category strip */}
              <div className="flex gap-3 mb-3 border-b border-[var(--border-default)] pb-2">
                {[32, 64, 64, 56, 72, 32, 96].map((w, i) => (
                  <Skeleton
                    key={i}
                    className="h-3.5 bg-[var(--bg-card)] rounded"
                    style={{ width: `${w}px` }}
                  />
                ))}
              </div>

              {/* Sources chip strip */}
              <div className="flex items-center gap-2 mb-4 flex-wrap">
                <Skeleton className="h-3 w-16 bg-[var(--bg-card)] rounded" />
                {Array.from({ length: 6 }).map((_, i) => (
                  <Skeleton
                    key={i}
                    className="h-6 w-14 bg-[var(--bg-card)] rounded-md"
                  />
                ))}
              </div>

              {/* Article cards */}
              {Array.from({ length: 5 }).map((_, i) => (
                <div
                  key={i}
                  className="rounded-xl border border-[var(--border-default)] p-4 mb-2.5 space-y-2.5"
                >
                  <div className="flex items-center gap-2">
                    <Skeleton className="h-4 w-12 bg-[var(--bg-elevated)] rounded" />
                    <Skeleton className="h-3 w-16 bg-[var(--bg-card)] rounded" />
                    <Skeleton className="h-4 w-16 bg-emerald-500/10 rounded ml-auto" />
                  </div>
                  <Skeleton className="h-4 w-4/5 bg-[var(--bg-elevated)] rounded" />
                  <Skeleton className="h-3 w-full bg-[var(--bg-card)] rounded" />
                  <Skeleton className="h-3 w-3/4 bg-[var(--bg-card)] rounded" />
                </div>
              ))}
            </div>

            {/* Right aside */}
            <aside className="space-y-3.5">
              <div className="rounded-xl border border-[var(--border-default)] p-4">
                <div className="flex items-center gap-2 mb-3">
                  <Skeleton className="h-3.5 w-3.5 bg-amber-300/30 rounded-full" />
                  <Skeleton className="h-3 w-24 bg-[var(--bg-elevated)] rounded" />
                </div>
                {Array.from({ length: 3 }).map((_, i) => (
                  <div key={i} className="flex items-center gap-2.5 py-2">
                    <Skeleton className="h-3.5 w-3.5 bg-[var(--bg-card)] rounded-full" />
                    <div className="flex-1 space-y-1.5">
                      <Skeleton className="h-3 w-full bg-[var(--bg-elevated)] rounded" />
                      <Skeleton className="h-2.5 w-16 bg-[var(--bg-card)] rounded" />
                    </div>
                  </div>
                ))}
                <Skeleton className="h-8 w-full bg-[var(--bg-card)] rounded-md mt-3" />
              </div>
              <div className="rounded-xl border border-[var(--border-default)] p-4">
                <div className="flex items-center gap-2 mb-3">
                  <Skeleton className="h-3.5 w-3.5 bg-emerald-300/30 rounded-full" />
                  <Skeleton className="h-3 w-24 bg-[var(--bg-elevated)] rounded" />
                </div>
                {Array.from({ length: 3 }).map((_, i) => (
                  <div key={i} className="flex items-center gap-2.5 py-2">
                    <Skeleton className="h-3.5 w-3.5 bg-[var(--bg-card)] rounded-full" />
                    <div className="flex-1 space-y-1.5">
                      <Skeleton className="h-3 w-full bg-[var(--bg-elevated)] rounded" />
                      <Skeleton className="h-2.5 w-16 bg-[var(--bg-card)] rounded" />
                    </div>
                  </div>
                ))}
              </div>
            </aside>
          </div>
        </div>
      </main>
    </div>
  );
}
