/**
 * HDFC Securities OAuth Callback Route
 *
 * HDFC returns the auth code as `request_token` (or `code`) —
 * see BROKER_CALLBACK_CONFIG.HDFC.
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
    "HDFC",
    request.nextUrl.searchParams
  );

  if (cancelled || !code) {
    return NextResponse.redirect(
      brokerCancelRedirect("HDFC", baseUrl, cancelReason)
    );
  }

  const result = await handleOAuthCallbackAction("HDFC", code, state);
  return NextResponse.redirect(
    result.success
      ? brokerSuccessRedirect("HDFC", baseUrl)
      : brokerFailureRedirect("HDFC", baseUrl, result.error)
  );
}
