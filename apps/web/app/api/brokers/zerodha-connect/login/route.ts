import { NextRequest, NextResponse } from "next/server";
import { getOAuthUrlAction } from "@/lib/actions/broker-connection";
import { resolveCallbackBaseUrl } from "@/lib/brokers/oauth-callback";

/**
 * Founder-only initiate for the paid Kite "Connect" app (MONEY-837).
 *
 * ZERODHA_CONNECT is hidden from the public broker picker, so the founder starts
 * the OAuth by visiting this URL directly. getOAuthUrlAction("ZERODHA_CONNECT")
 * enforces the founder gate + mints the CSRF state; we 302 to the Kite login URL
 * it returns (or back to /brokers with an error).
 */
export async function GET(request: NextRequest) {
  const baseUrl = resolveCallbackBaseUrl(request.nextUrl.origin);
  const result = await getOAuthUrlAction("ZERODHA_CONNECT");
  if (!result.success || !result.url) {
    return NextResponse.redirect(
      `${baseUrl}/brokers?error=${encodeURIComponent(
        result.error || "not_available"
      )}`
    );
  }
  return NextResponse.redirect(result.url);
}
