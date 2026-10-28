import { getDiscoverDataAction } from "@/lib/actions/discover";
import { getMfDiscoverDataAction } from "@/lib/actions/discover-mf";
import {
  getIndicesAction,
  getETFsAction,
} from "@/lib/actions/discover-indices";
import DiscoverPageClient from "./client";
import { withTimeout } from "@/lib/utils/with-timeout";

/**
 * Discover data (stocks, MF, indices, ETFs) is global and refreshed daily
 * by price-sync workers. Watchlists are user-specific and loaded client-side
 * via useEffect.
 *
 * force-dynamic: fetches live DB data (instruments, MFs, indices, ETFs) at
 * request time; avoids build-time PrismaClientInitializationError when
 * DATABASE_URL is absent in Vercel's build environment.
 */
// force-dynamic: fetches live DB data at request time; avoids build-time Prisma init without DATABASE_URL
export const dynamic = "force-dynamic";

export default async function DiscoverPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;

  // MONEY-1131 - this page KEEPS `getDiscoverDataAction()` (the full
  // `allStocks` universe) on purpose. Unlike /discover/markets and
  // /discover/screener - which read only `topGainers` / `sectors` and now take
  // the row-free `getDiscoverSummary()` instead - this page RENDERS that
  // universe: the "All Stocks" grid filters it client-side, so shipping only a
  // summary would trade a payload for a first-paint skeleton on the one screen
  // that actually needs the rows.
  //
  // Fetch global data in parallel with a 6s timeout.
  // All stocks + MF funds are pre-loaded so the client can filter instantly.
  // If server-side fetch is slow (cold start, DB), the page still renders
  // and the client component falls back to its own fetching via IDB cache.
  // NOTE: Watchlists are user-specific - fetched client-side only to keep
  // this page ISR-cacheable across users.
  const [discoverResult, mfResult, indicesResult, etfsResult] =
    await Promise.all([
      withTimeout(getDiscoverDataAction(), 6000),
      withTimeout(getMfDiscoverDataAction(), 6000),
      withTimeout(getIndicesAction(), 6000),
      withTimeout(getETFsAction({ limit: 20 }), 6000),
    ]);

  return (
    <DiscoverPageClient
      initialDiscoverData={
        discoverResult?.success ? (discoverResult.data ?? null) : null
      }
      initialMfData={mfResult?.success ? (mfResult.data ?? null) : null}
      initialIndices={indicesResult?.success ? (indicesResult.data ?? []) : []}
      initialEtfs={etfsResult?.success ? (etfsResult.data ?? []) : []}
      initialWatchlists={[]}
      sectorParam={(params?.sector as string) ?? null}
      tabParam={(params?.tab as string) ?? null}
    />
  );
}
