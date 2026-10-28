/**
 * Zerodha OAuth Callback Route
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
    "ZERODHA",
    request.nextUrl.searchParams
  );

  if (cancelled || !code) {
    return NextResponse.redirect(
      brokerCancelRedirect("ZERODHA", baseUrl, cancelReason)
    );
  }

  const result = await handleOAuthCallbackAction("ZERODHA", code, state);
  return NextResponse.redirect(
    result.success
      ? brokerSuccessRedirect("ZERODHA", baseUrl)
      : brokerFailureRedirect("ZERODHA", baseUrl, result.error)
  );
}
