import { getIndicesAction } from "@/lib/actions/discover-indices";
import { getDiscoverSummary } from "@usemoney/services";
import { getHeatmapDataAction } from "@/lib/actions/discover-heatmap";
import { getSectorHeatmapAction } from "@/lib/actions/sector-heatmap";
import MarketsClient from "./client";
import { withTimeout } from "@/lib/utils/with-timeout";

/**
 * Markets Overview (MONEY-195 + MONEY-242)
 *
 * Global data, identical for every user - all four server actions are wrapped
 * in `withTimeout` so a cold-start DB or upstream-data outage renders the page
 * with empty sections rather than blocking the whole response.
 *
 * MONEY-242 adds the squarified treemap heatmap. The SSR default scope is
 * `nifty50` (narrowed from the original `nifty500`) because "all NSE" can be
 * 2k+ rows and lengthens the SSR critical path; the user widens it from the
 * client toggle, which fetches via `useHeatmapData`. MONEY-1092 made the
 * treemap the SECOND view of a shared canvas — the sector grid is now the
 * default, and its buckets are SSR-primed alongside.
 *
 * force-dynamic: fetches live DB data (indices, sectors, heatmap) at request
 * time; avoids build-time PrismaClientInitializationError when DATABASE_URL
 * is absent in Vercel's build environment.
 */
// force-dynamic: fetches live DB data at request time; avoids build-time Prisma init without DATABASE_URL
export const dynamic = "force-dynamic";

export const metadata = {
  // MONEY-394 N - bare title; root layout's metadata.title.template
  // (`%s | UseMoney`) adds the suffix.
  title: "Markets",
  description:
    "Live Indian market overview - major indices, top gainers/losers, and sector performance.",
};

export default async function MarketsPage() {
  // The heatmap action has its own internal 10s timeout; the outer caps here
  // are a safety net so a runaway DB call can never block the SSR. If one
  // misses we pass null and the client fetches it post-mount with a skeleton
  // in the meantime.
  //
  // MONEY-1092 - `getSectorPerformanceAction` is gone from this list. It fed
  // the text-bar sector list, which the tile heatmap replaces; keeping it
  // would have meant SSR-ing a SECOND, differently-weighted set of sector
  // numbers alongside the one actually rendered. `getSectorHeatmapAction`
  // takes its slot, so the sector grid arrives primed instead of being
  // fetched client-side after mount (the old sectors page never passed
  // `initialBuckets`, which is why every visitor paid the cold query
  // interactively).
  //
  // MONEY-1131 - `getDiscoverSummary`, NOT `getDiscoverDataAction`. This page
  // reads exactly two fields off that payload (topGainers / topLosers) and
  // never renders a row from `allStocks`, so it was Redis-GET-ing and
  // JSON.parse-ing the ~7,400-row universe blob on every cold render to throw
  // it away. The summary is the same movers entry without the universe.
  const [indicesResult, discoverResult, sectorHeatmapResult, heatmapResult] =
    await Promise.all([
      withTimeout(getIndicesAction(), 6000),
      withTimeout(getDiscoverSummary(), 6000),
      withTimeout(getSectorHeatmapAction({ timeframe: "1D" }), 6000),
      // Default scope: Nifty 50 (was Nifty 500). Smaller cohort means
      // a faster cold-cache SSR fetch and a denser visually-readable
      // grid. Users can widen to Nifty 500 / All NSE from the toggle.
      withTimeout(getHeatmapDataAction({ scope: "nifty50" }), 5000),
    ]);

  return (
    <MarketsClient
      initialIndices={indicesResult?.success ? (indicesResult.data ?? []) : []}
      initialGainers={
        discoverResult?.success ? (discoverResult.data?.topGainers ?? []) : []
      }
      initialLosers={
        discoverResult?.success ? (discoverResult.data?.topLosers ?? []) : []
      }
      initialSectorBuckets={
        sectorHeatmapResult?.success
          ? (sectorHeatmapResult.data?.buckets ?? [])
          : []
      }
      // The SSR call can ITSELF be served from the stale-fallback copy.
      // Taking only `.buckets` discarded that, and because the client
      // pre-seeds 1D as already-fetched it never refetched — so an
      // hours-old server render looked live for the whole session.
      initialSectorStaleSince={
        sectorHeatmapResult?.success && sectorHeatmapResult.data?.stale
          ? (sectorHeatmapResult.data.staleSince ?? null)
          : null
      }
      initialHeatmap={
        heatmapResult?.success ? (heatmapResult.data ?? null) : null
      }
    />
  );
}
