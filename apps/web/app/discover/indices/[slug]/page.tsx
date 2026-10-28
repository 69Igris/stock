/**
 * /discover/indices/[slug] — MONEY-1204 (P14 / 14d.6, decision D2).
 *
 * The index-detail route that did not exist: constituents, membership change
 * history, a close sparkline, and the valuation block (`pe` / `pb` /
 * `divYield`) that `ind_close_all` has been publishing into `index_closes`
 * unread.
 *
 * ## The slug is `IndexClose.indexSlug`
 *
 * "nifty-50", derived from NSE's display name. It is NOT
 * `IndexConstituent.indexId` ("nifty50", and "banknifty" where NSE's own file
 * says "niftybank") — two vocabularies that were never one, resolved once by
 * `resolveIndexRoute`. Aliases resolve rather than 404.
 *
 * ## No `notFound()`
 *
 * An index we hold no constituent list for is the NORMAL case: NSE publishes
 * closes for ~100 indices and only eight registry families fetch lists. The
 * page renders price + valuation with the constituents section in its empty
 * state. A 404 for a real index would be wrong, and the house rule is that
 * missing data is an empty section, never a 404.
 *
 * ROUTE GATING: `/discover(.*)` is already in `APP_ROUTE_PATTERNS`
 * (`apps/web/proxy-routes.ts`), so this sub-route — dynamic segment included —
 * is gated as an app route (Clerk session OR demo cookie) with no change to
 * that file. Verified by `__tests__/proxy/discover-routes.test.ts` against the
 * REAL arrays.
 */

import type { Metadata } from "next";
import Sidebar from "@/components/Sidebar";
import { PageGuard } from "@/components/PageGuard";
import { PfPageHead } from "@/components/playful/PfPageHead";
import { IndexDetailView } from "@/components/discover/IndexDetailView";

export const dynamic = "force-dynamic";

/** Title from the slug alone — no DB read on the metadata path. */
export async function generateMetadata(props: {
  params: Promise<{ slug: string }>;
}): Promise<Metadata> {
  const { slug } = await props.params;
  const pretty = decodeURIComponent(slug)
    .split("-")
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
  return {
    title: pretty || "Index",
    description: `${pretty} — constituents, weightage, membership changes and valuation from NSE's daily index file.`,
  };
}

export default async function IndexDetailPage(props: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await props.params;
  const raw = decodeURIComponent(slug);

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
              eyebrow="NSE INDEX · CONSTITUENTS + VALUATION"
              title={
                <>
                  What&apos;s <span className="ser">inside the</span>{" "}
                  <span className="hl-gold">index.</span>
                </>
              }
              sub="Constituents with free-float weight where NSE publishes one, observed membership changes, and the index's own P/E, P/B and dividend yield. Blank means the exchange reported nothing — never zero."
            />
            <IndexDetailView slug={raw} />
          </div>
        </main>
      </div>
    </PageGuard>
  );
}
