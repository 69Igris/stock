export const dynamic = "force-dynamic";

import { getHoldingsAction } from "@/lib/actions/holdings";
import { getMutualFundsAction } from "@/lib/actions/mutualfunds";
import { getPositionsAction } from "@/lib/actions/positions";
import { isDemoSession } from "@/lib/demo/session";
// MONEY-1126: was a local copy whose setTimeout was never cleared, so every
// render of this page left three pending timers armed for the full 4s. The
// shared helper clears in a `finally`.
import { withTimeout } from "@/lib/utils/with-timeout";
import HoldingsPageClient from "./client";

export default async function HoldingsPage() {
  const isDemo = await isDemoSession();

  // Fetch all three in parallel - Positions tab is folded into Holdings,
  // so the server warm-loads them together to avoid sequential client waterfalls.
  const [holdingsResult, fundsResult, positionsResult] = await Promise.all([
    withTimeout(getHoldingsAction({}), 4000),
    withTimeout(getMutualFundsAction({}), 4000),
    withTimeout(getPositionsAction({}), 4000),
  ]);

  const initialHoldings =
    holdingsResult?.success && holdingsResult.data ? holdingsResult.data : null;
  const initialFunds =
    fundsResult?.success && fundsResult.data ? fundsResult.data : null;
  const initialPositions =
    positionsResult?.success && positionsResult.data
      ? positionsResult.data
      : null;

  return (
    <HoldingsPageClient
      initialHoldings={initialHoldings}
      initialFunds={initialFunds}
      initialPositions={initialPositions}
      isDemo={isDemo}
    />
  );
}
