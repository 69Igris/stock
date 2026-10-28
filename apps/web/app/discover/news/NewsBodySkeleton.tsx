import { Skeleton } from "@usemoney/ui/skeleton";

/**
 * News page body skeleton (no Sidebar / title chrome — those are owned
 * by PageGuard stage 2 / loading.tsx stage 1). Matches the hydrated
 * NewsChrome shape:
 *   - 4 primary tabs
 *   - 2-col grid: category strip + sources + article cards | aside
 */
export default function NewsBodySkeleton() {
  return (
    <>
      {/* Primary tab strip */}
      <div className="flex gap-1.5 mb-4 flex-wrap">
        <Skeleton className="h-7 w-24 bg-emerald-500/15 dark:bg-emerald-500/25 rounded-md" />
        <Skeleton className="h-7 w-28 bg-[var(--bg-elevated)] rounded-md" />
        <Skeleton className="h-7 w-20 bg-[var(--bg-elevated)] rounded-md" />
        <Skeleton className="h-7 w-28 bg-[var(--bg-elevated)] rounded-md" />
      </div>

      {/* Body grid */}
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
          {Array.from({ length: 2 }).map((_, i) => (
            <div
              key={i}
              className="rounded-xl border border-[var(--border-default)] p-4"
            >
              <div className="flex items-center gap-2 mb-3">
                <Skeleton className="h-3.5 w-3.5 bg-[var(--bg-elevated)] rounded-full" />
                <Skeleton className="h-3 w-24 bg-[var(--bg-elevated)] rounded" />
              </div>
              {Array.from({ length: 3 }).map((_, j) => (
                <div key={j} className="flex items-center gap-2.5 py-2">
                  <Skeleton className="h-3.5 w-3.5 bg-[var(--bg-card)] rounded-full" />
                  <div className="flex-1 space-y-1.5">
                    <Skeleton className="h-3 w-full bg-[var(--bg-elevated)] rounded" />
                    <Skeleton className="h-2.5 w-16 bg-[var(--bg-card)] rounded" />
                  </div>
                </div>
              ))}
            </div>
          ))}
        </aside>
      </div>
    </>
  );
}
