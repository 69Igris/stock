/**
 * ICICI Direct (Breeze API) OAuth Callback Route
 *
 * Breeze returns the session token as `apiSession` (or `session_token` / `code`)
 * rather than a standard OAuth `code` — see BROKER_CALLBACK_CONFIG.ICICI.
 */

import { NextRequest, NextResponse } from "next/server";
import { handleOAuthCallbackAction } from "@/lib/actions/broker-connection";
import {
  parseBrokerCallback,
  resolveCallbackBaseUrl,
  brokerCancelRedirect,
  brokerSuccessRedirect,
  brokerFailureRedirect,
} from "@/lib/brokers/oauth-callback";

export async function GET(request: NextRequest) {
  const baseUrl = resolveCallbackBaseUrl(request.nextUrl.origin);
  const { code, state, cancelled, cancelReason } = parseBrokerCallback(
    "ICICI",
    request.nextUrl.searchParams
  );

  if (cancelled || !code) {
    return NextResponse.redirect(
      brokerCancelRedirect("ICICI", baseUrl, cancelReason)
    );
  }

  const result = await handleOAuthCallbackAction("ICICI", code, state);
  return NextResponse.redirect(
    result.success
      ? brokerSuccessRedirect("ICICI", baseUrl)
      : brokerFailureRedirect("ICICI", baseUrl, result.error)
  );
}
