/**
 * Screener loading skeleton (MONEY-243 / MONEY-392).
 *
 * Chrome mirrors `discover/screener/client.tsx` exactly: same Sidebar,
 * same padding, same `max-w-[1600px]` container, same inline title +
 * DISCOVER breadcrumb. No PageGuard wrapper here - PageGuard lives
 * inside the page itself and would otherwise intercept this skeleton
 * with its own default chrome.
 */

import Sidebar from "@/components/Sidebar";
import { PfPageHead } from "@/components/playful/PfPageHead";
import { ScreenerInnerSkeleton } from "@/components/screener/InnerSkeleton";

export default function ScreenerLoading() {
  return (
    <div className="pf-app min-h-screen">
      <Sidebar />
      <main className="lg:ml-[var(--sidebar-w)] min-h-screen pt-[var(--mobile-header-h)] lg:pt-[var(--topbar-h)]">
        <div className="px-4 sm:px-6 py-6 max-w-[1600px] mx-auto">
          {/* Playful header - mirrors the hydrated ScreenerClient pf-ph
              so there is no chrome flash between loading and ready. */}
          <PfPageHead
            eyebrow="DISCOVER · SCREENER"
            title={
              <>
                Find the next <span className="ser">idea,</span>{" "}
                <span className="hl-gold">fast.</span>
              </>
            }
            sub="Stack fundamentals, search, and filters. Build the screen with AI, then save or export it."
          />

          <ScreenerInnerSkeleton />
        </div>
      </main>
    </div>
  );
}
