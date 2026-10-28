/**
 * /discover/circulars — MONEY-1204 (P14 / 14d.5).
 *
 * NSE's circular feed, filterable by department. `?department=Surveillance`
 * deep-links a filter.
 *
 * ROUTE GATING: `/discover(.*)` is already in `APP_ROUTE_PATTERNS`
 * (`apps/web/proxy-routes.ts`), so this sub-route is gated as an app route
 * (Clerk session OR a valid demo cookie) with no change to that file. Verified
 * by `__tests__/proxy/discover-routes.test.ts` against the REAL arrays.
 *
 * force-dynamic: reads live DB data at request time.
 */

import Sidebar from "@/components/Sidebar";
import { PageGuard } from "@/components/PageGuard";
import { PfPageHead } from "@/components/playful/PfPageHead";
import { CircularsFeed } from "@/components/discover/CircularsFeed";

export const metadata = {
  title: "Exchange Circulars",
  description:
    "NSE circulars by department — surveillance actions, listing notices, margin and settlement changes.",
};

export const dynamic = "force-dynamic";

export default async function DiscoverCircularsPage(props: {
  searchParams?: Promise<{ department?: string }>;
}) {
  const searchParams = (await props.searchParams) ?? {};
  const department = searchParams.department?.trim() || null;

  return (
    <PageGuard
      route="/discover"
      containerClassName="px-6 py-6 max-w-[1100px] mx-auto"
    >
      <div className="pf-app min-h-screen">
        <Sidebar />
        <main className="lg:ml-[var(--sidebar-w)] min-h-screen pt-[var(--mobile-header-h)] lg:pt-[var(--topbar-h)]">
          <div className="pf-page">
            <PfPageHead
              eyebrow="NSE CIRCULARS · UPDATED DAILY"
              title={
                <>
                  What the <span className="ser">exchange</span>{" "}
                  <span className="hl-gold">just said.</span>
                </>
              }
              sub="Every circular NSE issues, by department. A circular filed under two departments appears twice — that is how NSE issues it, and collapsing them would hide half of each re-issue."
            />
            <CircularsFeed initialDepartment={department} />
          </div>
        </main>
      </div>
    </PageGuard>
  );
}
