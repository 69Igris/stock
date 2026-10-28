export const dynamic = "force-dynamic";

import { getTradesAction } from "@/lib/actions/trades";
import { isDemoSession } from "@/lib/demo/session";
import TradebookPageClient from "./client";
import { withTimeout } from "@/lib/utils/with-timeout";

export default async function TradebookPage() {
  const isDemo = await isDemoSession();
  const tradesResult = await withTimeout(
    getTradesAction({ limit: 20, skip: 0 }),
    4000
  );

  // Normalize server stats to include client-expected fields (openCount, etc.)
  // that the DB query doesn't compute - they come from the paired trades API.
  const initialData =
    tradesResult?.success && tradesResult.data
      ? {
          trades: tradesResult.data.trades,
          total: tradesResult.data.total,
          stats: {
            totalPnL: tradesResult.data.stats.totalPnL,
            totalUnrealizedPnL: 0,
            winRate: tradesResult.data.stats.winRate,
            winners: tradesResult.data.stats.winners,
            losers: tradesResult.data.stats.losers,
            openCount: 0,
            closedCount:
              tradesResult.data.stats.winners + tradesResult.data.stats.losers,
            // MONEY-1257: this object is rebuilt FIELD BY FIELD, so anything
            // added to the service's stats is silently dropped here unless it
            // is copied across. That is what made the fix invisible: the SSR
            // payload arrived without buyCount/sellCount, the client fell back
            // to its page-derived split, and the tile rendered the exact wrong
            // numbers on first paint.
            buyCount: tradesResult.data.stats.buyCount,
            sellCount: tradesResult.data.stats.sellCount,
            segmentBreakdown: [] as {
              segment: string;
              realizedPnL: number;
              unrealizedPnL: number;
              closedCount: number;
              openCount: number;
              winners: number;
              losers: number;
            }[],
          },
        }
      : null;

  return <TradebookPageClient initialTrades={initialData} isDemo={isDemo} />;
}
