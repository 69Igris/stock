export const dynamic = "force-dynamic";

import { getWatchlistsAction } from "@/lib/actions/watchlist";
import WatchlistClient from "./client";
import { withTimeout } from "@/lib/utils/with-timeout";

export const metadata = {
  // MONEY-394 N - bare title; root layout's template adds `| UseMoney`.
  title: "Watchlist",
  description: "Track and monitor your favorite stocks and mutual funds",
};

export default async function WatchlistPage() {
  const watchlistResult = await withTimeout(
    getWatchlistsAction().catch(() => null),
    4000
  );

  return (
    <WatchlistClient
      initialWatchlists={
        watchlistResult?.success ? (watchlistResult.data ?? null) : null
      }
    />
  );
}
