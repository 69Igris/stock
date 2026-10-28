import Sidebar from "@/components/Sidebar";
import { Skeleton } from "@usemoney/ui/skeleton";

/**
 * /calculators listing page loading skeleton.
 *
 * Container width + grid breakpoints + section structure all mirror
 * `calculators/page.tsx` exactly so stages 1 → 3 render identical
 * boxes: `max-w-[1200px]` container, `grid-cols-1 sm:grid-cols-2
 * lg:grid-cols-4` card grid, two sections (Financial = 8 cards, MF = 7
 * cards), Tools breadcrumb on the title row, BETA chip on each section
 * header.
 */
export default function CalculatorsLoading() {
  return (
    <div className="pf-app min-h-screen">
      <Sidebar />
      <main className="lg:ml-[var(--sidebar-w)] min-h-screen pt-[var(--mobile-header-h)] lg:pt-[var(--topbar-h)]">
        <div className="px-4 sm:px-6 py-6 max-w-[1200px] mx-auto">
          {/* Playful page header placeholder - mirrors pf-ph in page.tsx. */}
          <div className="pf-ph">
            <div className="l">
              <Skeleton className="h-3 w-52 bg-muted mb-3" />
              <h1>
                The math, <span className="ser">we do.</span>
              </h1>
              <Skeleton className="h-4 w-full max-w-[480px] bg-muted mt-3" />
            </div>
          </div>

          {/* Section header - Financial calculators */}
          <section>
            <div className="pf-sec-h">
              <span className="n">BETA</span>
              <Skeleton className="h-5 w-44 bg-muted" />
              <span className="rule" />
            </div>
            <Skeleton className="h-3 w-52 max-w-full bg-muted mb-3.5" />
            {/* Calculator card grid - 1/2/4 responsive, matches CalcSection */}
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3.5">
              {Array.from({ length: 8 }).map((_, i) => (
                <Skeleton
                  key={i}
                  className="h-[130px] bg-muted/60 rounded-[14px]"
                />
              ))}
            </div>
          </section>

          <div className="mt-6" />

          {/* Section header - Mutual fund calculators */}
          <section>
            <div className="pf-sec-h">
              <span className="n">BETA</span>
              <Skeleton className="h-5 w-56 bg-muted" />
              <span className="rule" />
            </div>
            <Skeleton className="h-3 w-64 max-w-full bg-muted mb-3.5" />
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3.5">
              {Array.from({ length: 7 }).map((_, i) => (
                <Skeleton
                  key={i}
                  className="h-[130px] bg-muted/60 rounded-[14px]"
                />
              ))}
            </div>
          </section>
        </div>
      </main>
    </div>
  );
}
