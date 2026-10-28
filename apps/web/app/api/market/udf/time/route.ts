/**
 * TradingView UDF - Server time endpoint
 *
 * GET /api/market/udf/time
 *
 * Returns the current server time as a unix timestamp in **seconds** as
 * **plain text** (NOT JSON). The TradingView library uses this to align its
 * own clock with the server when streaming bars.
 *
 * Spec: https://www.tradingview.com/charting-library-docs/latest/connecting_data/UDF/#time
 */

import { auth } from "@clerk/nextjs/server";
import { NextResponse } from "next/server";
import { isDemoSession } from "@/lib/demo/session";
import { getServerTimeSeconds, UDF_TIME_CONTENT_TYPE } from "./time-logic";

export const dynamic = "force-dynamic";

export async function GET() {
  // MONEY-278: demo sessions can read server time so the chart's clock can
  // align without auth.
  const { userId } = await auth();
  if (!userId && !(await isDemoSession())) {
    return NextResponse.json(
      { error: "Authentication required" },
      { status: 401 }
    );
  }

  // Plain integer string, NOT JSON. Easy to get wrong because Next.js Route
  // Handlers default to JSON via NextResponse.json().
  return new Response(getServerTimeSeconds(), {
    status: 200,
    headers: { "Content-Type": UDF_TIME_CONTENT_TYPE },
  });
}
