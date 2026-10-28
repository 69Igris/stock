import Sidebar from "@/components/Sidebar";
import { Skeleton } from "@usemoney/ui/skeleton";

/**
 * IPOs loading skeleton — MONEY-1204 (P14).
 * Mirrors the hydrated layout (page head + filter pills + card grid) so the
 * swap to real content does not shift the page.
 */
export default function Loading() {
  return (
    <div className="pf-app min-h-screen">
      <Sidebar />
      <main className="lg:ml-[var(--sidebar-w)] min-h-screen pt-[var(--mobile-header-h)] lg:pt-[var(--topbar-h)]">
        <div className="px-4 sm:px-6 py-6 max-w-[1200px] mx-auto">
          <div className="flex items-baseline gap-3 mb-2 flex-wrap">
            <h1 className="font-display text-[28px] font-bold tracking-[-0.5px] text-[var(--text-primary)]">
              IPOs
            </h1>
            <span className="font-mono text-[11px] text-[var(--text-muted)] uppercase tracking-[1.2px]">
              Discover
            </span>
          </div>
          <Skeleton className="h-4 w-full max-w-[640px] bg-muted mb-5" />

          <div className="flex flex-wrap items-center gap-2 mb-4">
            <Skeleton className="h-7 w-24 bg-emerald-500/15 dark:bg-emerald-500/25 rounded-full" />
            <Skeleton className="h-7 w-24 bg-muted/60 rounded-full" />
            <Skeleton className="h-7 w-28 bg-muted/60 rounded-full" />
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
            {Array.from({ length: 6 }).map((_, i) => (
              <div
                key={i}
                className="rounded-xl border border-[var(--border-default)] bg-card/40 p-4"
              >
                <Skeleton className="h-3 w-20 bg-muted/70 mb-3" />
                <Skeleton className="h-5 w-32 bg-muted mb-2" />
                <Skeleton className="h-3 w-full bg-muted/50 mb-1.5" />
                <Skeleton className="h-3 w-2/3 bg-muted/40" />
              </div>
            ))}
          </div>
        </div>
      </main>
    </div>
  );
}
