/**
 * TradingView UDF - Live Bar Stream (DECOMMISSIONED — MONEY-566)
 *
 * GET /api/market/udf/stream?symbol=NSE:TCS&resolution=5
 *
 * This endpoint USED to fan a SHARED Zerodha WebSocket — opened under the FIRST
 * subscriber's access_token via `intraday-hub` — out to every SSE subscriber on
 * the Node instance. That meant one user's broker ticks were delivered into
 * other users' chart sessions, violating the Zerodha market-data commitment
 * (data fetched only under each user's OWN token, rendered only in their own
 * session, never aggregated or redistributed cross-user).
 *
 * Why we don't just scope one WebSocket per user: Kite Connect caps WebSocket
 * connections at **3 per API key** (not per user / per access_token). A
 * per-user socket design therefore cannot scale past 3 concurrent broker users,
 * so it is not a viable replacement.
 *
 * Resolution: the live WS push stream is decommissioned. This route returns
 * 409 so the client datafeed (installUdfStreaming() in
 * components/charts/TradingViewAdvancedChart.tsx) closes its EventSource on
 * `onerror` and falls back to TradingView's built-in /history polling. After
 * MONEY-566 P0a, /api/market/udf/history fetches per-user under the caller's
 * OWN token and never caches Zerodha bars cross-user — so the fallback is
 * compliant. Net effect: broker users get fresh ~10s polled bars instead of
 * tick-by-tick; no-broker users are unchanged (they already used the polling
 * fallback). The shared `intraday-hub` is now unreferenced (kept for a future
 * per-user streaming service: dedicated WS workers behind Redis pub/sub, scoped
 * strictly per access_token).
 */

import { NextRequest } from "next/server";
import { auth } from "@clerk/nextjs/server";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(_request: NextRequest) {
  const { userId } = await auth();
  if (!userId) {
    return new Response(JSON.stringify({ error: "authentication required" }), {
      status: 401,
      headers: { "Content-Type": "application/json" },
    });
  }

  // MONEY-566: live Zerodha WS streaming is decommissioned. Return 409 → the
  // client EventSource fires `onerror`, closes, and TradingView continues to
  // poll /history (per-user, compliant). 409 (not a 200 SSE) is deliberate:
  // it reuses the client's existing, already-tested 4xx → poll fallback.
  return new Response(
    JSON.stringify({
      error:
        "live bar streaming is disabled; client falls back to history polling",
      reason: "compliance:zerodha-per-user",
    }),
    { status: 409, headers: { "Content-Type": "application/json" } }
  );
}
