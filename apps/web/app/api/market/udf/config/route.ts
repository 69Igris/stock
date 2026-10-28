/**
 * TradingView UDF - Config endpoint
 *
 * GET /api/market/udf/config
 *
 * Returns the static datafeed configuration. The TradingView Advanced Charts
 * widget calls this once on init to discover supported features, exchanges,
 * resolutions, and symbol types.
 *
 * Spec: https://www.tradingview.com/charting-library-docs/latest/connecting_data/UDF/
 */

import { auth } from "@clerk/nextjs/server";
import { NextResponse } from "next/server";
import { isDemoSession } from "@/lib/demo/session";
import { UDF_CONFIG, CONFIG_CACHE_CONTROL } from "./config-logic";

export const dynamic = "force-dynamic";

export async function GET() {
  // MONEY-278: demo sessions can fetch config so the chart bootstraps. Only
  // the symbols/history/search routes enforce the demo allow-list.
  const { userId } = await auth();
  if (!userId && !(await isDemoSession())) {
    return NextResponse.json(
      { error: "Authentication required" },
      { status: 401 }
    );
  }

  // MONEY-1383 (L3): UDF_CONFIG is a module constant — no user data, no
  // request input, identical for every caller. It cost 0.42s (measured, prod)
  // on EVERY chart load because the response carried no caching directive at
  // all. `private` because the route stays behind auth: a shared CDN must not
  // hold a body served from an authenticated origin, even a constant one.
  // `force-dynamic` above still applies — it governs whether Next may
  // prerender the route, not what the browser may reuse.
  return NextResponse.json(UDF_CONFIG, {
    headers: { "Cache-Control": CONFIG_CACHE_CONTROL },
  });
}
