import Sidebar from "@/components/Sidebar";
import Link from "next/link";
import { ChevronLeft } from "lucide-react";
import { Skeleton } from "@usemoney/ui/skeleton";

/**
 * /calculators/[slug] detail page loading skeleton.
 *
 * The hydrated page renders a per-slug title (SIP / Lumpsum / Step-up SIP
 * / EMI / FD / NPS / etc.) which loading.tsx can't know - so we render a
 * generic "Calculator" title alongside the BETA + Tools chips and the
 * "← All calculators" back link that the hydrated page always shows.
 * Chrome (container width, padding, header arrangement) matches the
 * hydrated page exactly so stages 1 ↔ 3 don't jump.
 */
export default function CalculatorSlugLoading() {
  return (
    <div className="pf-app min-h-screen">
      <Sidebar />
      <main className="lg:ml-[var(--sidebar-w)] min-h-screen pt-[var(--mobile-header-h)] lg:pt-[var(--topbar-h)]">
        <div className="px-4 sm:px-6 py-6 max-w-[920px] mx-auto">
          {/* Back link - same shape + text as the hydrated page. */}
          <Link
            href="/calculators"
            className="inline-flex items-center gap-1 text-[12px] text-[var(--ink-3)] hover:text-[var(--emerald-text)] mb-3 transition-colors"
          >
            <ChevronLeft className="h-3.5 w-3.5" />
            All calculators
          </Link>

          {/* Playful page header placeholder - mirrors pf-ph in page.tsx. */}
          <div className="pf-ph">
            <div className="l">
              <div className="eyebrow">
                <span className="d" aria-hidden />
                TOOLS · CALCULATORS
              </div>
              <h1>Calculator</h1>
              <Skeleton className="h-4 w-full max-w-[520px] bg-muted mt-3" />
            </div>
            <div className="r">
              <span className="pf-pill outline">BETA</span>
            </div>
          </div>

          {/* Two-column form + result layout - matches CalculatorClient.tsx's
              `grid-cols-1 md:grid-cols-[1.1fr_1fr]` so stages 1 → 3 don't
              reflow. */}
          <div className="grid grid-cols-1 md:grid-cols-[1.1fr_1fr] gap-5 items-start">
            {/* Inputs section */}
            <section className="pf-card" style={{ padding: 0 }}>
              <div
                style={{
                  padding: "14px 20px",
                  borderBottom: "2px solid var(--ink)",
                }}
              >
                <Skeleton className="h-4 w-24 bg-muted" />
              </div>
              <div className="space-y-[18px] p-5">
                {Array.from({ length: 4 }).map((_, i) => (
                  <div key={i} className="space-y-1.5">
                    <Skeleton className="h-3 w-24 bg-muted" />
                    <Skeleton className="h-9 w-full bg-muted/70 rounded-lg" />
                  </div>
                ))}
              </div>
            </section>

            {/* Result section - dark hero + breakdown card */}
            <section className="flex flex-col gap-[18px]">
              <div
                className="pf-card tilt-r"
                style={{ background: "var(--ink)" }}
              >
                <Skeleton className="h-3 w-24 bg-white/10 mb-3" />
                <Skeleton className="h-10 w-40 bg-white/10" />
              </div>
              <div className="pf-card" style={{ padding: 0 }}>
                <div
                  style={{
                    padding: "12px 18px",
                    borderBottom: "1.5px dashed var(--rule-soft)",
                  }}
                >
                  <Skeleton className="h-4 w-24 bg-muted" />
                </div>
                <div className="space-y-2 px-[18px] py-3">
                  {Array.from({ length: 3 }).map((_, i) => (
                    <div
                      key={i}
                      className="flex items-baseline justify-between py-2.5"
                      style={{ borderBottom: "1px dashed var(--rule-soft)" }}
                    >
                      <Skeleton className="h-3 w-28 bg-muted" />
                      <Skeleton className="h-4 w-20 bg-muted" />
                    </div>
                  ))}
                </div>
              </div>
            </section>
          </div>
        </div>
      </main>
    </div>
  );
}
