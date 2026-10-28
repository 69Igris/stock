/**
 * /discover/ipo — MONEY-1204 (P14 / 14d.3).
 *
 * NSE's public-issue calendar: forthcoming, currently bidding, recently listed.
 * Server shell only; `IpoBoard` fetches through the server action so the IST
 * "today" is resolved once, server-side, per request.
 *
 * ROUTE GATING: `/discover(.*)` is already in `APP_ROUTE_PATTERNS`
 * (`apps/web/proxy-routes.ts`), so this sub-route is gated as an app route
 * (Clerk session OR a valid demo cookie) with no change to that file. Verified
 * by `__tests__/proxy/discover-routes.test.ts`, which asserts it against the
 * REAL arrays rather than a copy. The three outages recorded in
 * `proxy-routes.ts` (`/etf`, `/calculators`, `/notifications`) were all
 * TOP-LEVEL routes with no covering pattern — a different case from this one.
 *
 * force-dynamic: the board reads live DB data and the IST-day bucketing must
 * not be baked into a build artefact.
 */

import Sidebar from "@/components/Sidebar";
import { PageGuard } from "@/components/PageGuard";
import { PfPageHead } from "@/components/playful/PfPageHead";
import { IpoBoard } from "@/components/discover/IpoBoard";

export const metadata = {
  // Bare title; the root layout's metadata.title.template adds `| UseMoney`.
  title: "IPOs",
  description:
    "Indian IPO calendar — issues open for bidding, upcoming public issues, and recent listings from NSE.",
};

export const dynamic = "force-dynamic";

export default function DiscoverIpoPage() {
  return (
    <PageGuard
      route="/discover"
      containerClassName="px-6 py-6 max-w-[1200px] mx-auto"
    >
      <div className="pf-app min-h-screen">
        <Sidebar />
        <main className="lg:ml-[var(--sidebar-w)] min-h-screen pt-[var(--mobile-header-h)] lg:pt-[var(--topbar-h)]">
          <div className="pf-page">
            <PfPageHead
              eyebrow="NSE PUBLIC ISSUES · MAINBOARD + SME"
              title={
                <>
                  Who&apos;s <span className="ser">coming to</span>{" "}
                  <span className="hl-gold">market.</span>
                </>
              }
              sub="Issues open for bidding right now, what's scheduled next, and what listed recently — straight from NSE's public-issue feed. Bands and dates are shown exactly as published; blanks mean NSE has not announced them."
            />
            <IpoBoard />
          </div>
        </main>
      </div>
    </PageGuard>
  );
}
