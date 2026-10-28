/**
 * Broker Market Data Status API
 *
 * GET /api/market/broker-status
 *
 * Returns the user's broker connection status for market data.
 * Used by the useBrokerStatus hook to show/hide the reauth banner.
 * Cached for 60s via Cache-Control to avoid DB spam.
 */

import { NextResponse } from "next/server";
import { auth } from "@clerk/nextjs/server";
import { getBrokerMarketDataStatus } from "@/lib/actions/broker-status";
import { apiLogger as logger } from "@usemoney/logger";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const { userId } = await auth();
    if (!userId) {
      return NextResponse.json(
        { error: "Authentication required" },
        { status: 401 }
      );
    }

    const status = await getBrokerMarketDataStatus();

    return NextResponse.json(
      { success: true, ...status },
      {
        headers: {
          "Cache-Control": "private, max-age=60",
        },
      }
    );
  } catch (error) {
    logger.error({ error }, "Broker status API error");
    return NextResponse.json(
      { error: "Failed to fetch broker status" },
      { status: 500 }
    );
  }
}
