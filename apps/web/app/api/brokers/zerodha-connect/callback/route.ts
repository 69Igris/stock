import { NextRequest, NextResponse } from "next/server";
import { handleOAuthCallbackAction } from "@/lib/actions/broker-connection";
import {
  parseBrokerCallback,
  resolveCallbackBaseUrl,
  brokerCancelRedirect,
  brokerSuccessRedirect,
  brokerFailureRedirect,
} from "@/lib/brokers/oauth-callback";

/**
 * OAuth callback for the founder-only paid Kite "Connect" app (MONEY-837).
 * Mirrors the Zerodha (Personal) callback; the founder gate + token-only-no-sync
 * behaviour live in handleOAuthCallbackAction("ZERODHA_CONNECT").
 */
export async function GET(request: NextRequest) {
  const baseUrl = resolveCallbackBaseUrl(request.nextUrl.origin);
  const { code, state, cancelled, cancelReason } = parseBrokerCallback(
    "ZERODHA_CONNECT",
    request.nextUrl.searchParams
  );

  if (cancelled || !code) {
    return NextResponse.redirect(
      brokerCancelRedirect("ZERODHA_CONNECT", baseUrl, cancelReason)
    );
  }

  const result = await handleOAuthCallbackAction(
    "ZERODHA_CONNECT",
    code,
    state
  );
  return NextResponse.redirect(
    result.success
      ? brokerSuccessRedirect("ZERODHA_CONNECT", baseUrl)
      : brokerFailureRedirect("ZERODHA_CONNECT", baseUrl, result.error)
  );
}
