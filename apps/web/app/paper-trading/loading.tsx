import { Skeleton } from "@usemoney/ui/skeleton";

/**
 * /paper-trading (Chat tab) loading skeleton.
 *
 * Mirrors `paper-trading/page.tsx`'s hero state - Sparkles icon +
 * "Paper Trading Assistant" h2 + subtitle + ChatPromptArea +
 * 3 quick-action chips. Renders INSIDE the paper-trading layout's
 * chrome (the layout already provides Sidebar + sub-nav + per-route
 * h1), so this file only shows the content area.
 */
export default function PaperTradingChatLoading() {
  return (
    <div className="pf-app flex flex-col flex-1 min-h-0 -mx-4 lg:-mx-6 -mb-48 sm:-mb-44">
      {/* Hero scroll area */}
      <div className="flex-1 min-h-0 overflow-hidden px-4 lg:px-6 pb-6">
        <div className="flex flex-col items-center justify-center min-h-[40vh] pt-6 sm:pt-10">
          {/* Sparkles playful icon */}
          <Skeleton className="h-12 w-12 rounded-xl mb-4 bg-emerald-500/20 dark:bg-emerald-500/25" />
          {/* h2 title */}
          <Skeleton className="h-6 sm:h-7 w-72 mx-auto mb-2 bg-muted" />
          {/* Subtitle */}
          <Skeleton className="h-4 w-full max-w-md mx-auto bg-muted/70 mb-1" />
          <Skeleton className="h-4 w-3/4 max-w-md mx-auto bg-muted/70" />
        </div>
      </div>

      {/* Prompt + quick actions pinned at bottom */}
      <div className="shrink-0 px-4 sm:px-6 pb-4 sm:pb-6 sm:flex sm:justify-center">
        <div className="w-full max-w-2xl">
          {/* Chat prompt area */}
          <div className="rounded-2xl border border-border bg-card/40 p-3 sm:p-4">
            <div className="flex items-start gap-3 mb-3">
              <Skeleton className="h-4 w-52 max-w-full bg-muted mt-1" />
              <Skeleton className="ml-auto h-6 w-12 bg-emerald-500/15 dark:bg-emerald-500/25 rounded-full shrink-0" />
            </div>
            <div className="flex items-center gap-2 flex-wrap">
              <Skeleton className="h-8 w-8 bg-muted rounded-md shrink-0" />
              <div className="ml-auto flex items-center gap-2">
                <Skeleton className="h-7 w-20 bg-muted rounded-md" />
                <Skeleton className="h-7 w-7 bg-muted rounded-md" />
              </div>
            </div>
          </div>
          {/* Desktop quick actions */}
          <div className="hidden sm:flex mt-3 flex-wrap items-center justify-center gap-2">
            <Skeleton className="h-8 w-32 bg-muted rounded-full" />
            <Skeleton className="h-8 w-32 bg-muted rounded-full" />
            <Skeleton className="h-8 w-28 bg-muted rounded-full" />
          </div>
          {/* Mobile quick actions - horizontal scroll */}
          <div className="sm:hidden mt-3 overflow-x-auto">
            <div className="flex items-center gap-2 px-2 pb-1">
              <Skeleton className="h-8 w-32 bg-muted rounded-full shrink-0" />
              <Skeleton className="h-8 w-32 bg-muted rounded-full shrink-0" />
              <Skeleton className="h-8 w-28 bg-muted rounded-full shrink-0" />
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
