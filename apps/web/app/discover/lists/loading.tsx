import Sidebar from "@/components/Sidebar";
import { Skeleton } from "@usemoney/ui/skeleton";

/**
 * /discover/lists loading skeleton - matches the Research Lists hydrated
 * layout (title + DISCOVER chip + description + table of saved lists).
 * Container `max-w-[1200px]` mirrors the hydrated page.
 */
export default function ResearchListsLoading() {
  return (
    <div className="pf-app min-h-screen">
      <Sidebar />
      <main className="lg:ml-[var(--sidebar-w)] min-h-screen pt-[var(--mobile-header-h)] lg:pt-[var(--topbar-h)]">
        <div className="px-4 sm:px-6 py-6 max-w-[1200px] mx-auto">
          {/* Header */}
          <div className="flex items-baseline gap-3 mb-2 flex-wrap">
            <h1 className="font-display text-[28px] font-bold tracking-[-0.5px] text-[var(--text-primary)]">
              Research Lists
            </h1>
            <span className="font-mono text-[11px] text-[var(--text-muted)] uppercase tracking-[1.2px]">
              Discover
            </span>
          </div>
          <Skeleton className="h-4 w-full max-w-[640px] bg-muted mb-5" />

          {/* Filter / toolbar row */}
          <div className="flex flex-wrap items-center gap-2 mb-4">
            <Skeleton className="h-8 w-20 bg-emerald-500/15 dark:bg-emerald-500/25 rounded-md" />
            <Skeleton className="h-8 w-24 bg-muted/60 rounded-md" />
            <div className="ml-auto">
              <Skeleton className="h-8 w-32 bg-muted/60 rounded-md" />
            </div>
          </div>

          {/* Lists table */}
          <div className="rounded-xl border border-border bg-card/40 overflow-hidden">
            <div className="grid grid-cols-[2fr_1fr_1fr_80px] gap-3 px-4 py-3 border-b border-border">
              {Array.from({ length: 4 }).map((_, i) => (
                <Skeleton key={i} className="h-3 w-16 bg-muted/60" />
              ))}
            </div>
            {Array.from({ length: 6 }).map((_, i) => (
              <div
                key={i}
                className="grid grid-cols-[2fr_1fr_1fr_80px] gap-3 px-4 py-3 border-b border-border/40 items-center"
              >
                <Skeleton className="h-4 w-40 bg-muted" />
                <Skeleton className="h-4 w-20 bg-muted/60" />
                <Skeleton className="h-4 w-24 bg-muted/60" />
                <Skeleton className="h-7 w-7 bg-muted/60 rounded-md ml-auto" />
              </div>
            ))}
          </div>
        </div>
      </main>
    </div>
  );
}
