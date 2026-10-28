/**
 * Fyers OAuth Callback Route
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
    "FYERS",
    request.nextUrl.searchParams
  );

  if (cancelled || !code) {
    return NextResponse.redirect(
      brokerCancelRedirect("FYERS", baseUrl, cancelReason)
    );
  }

  const result = await handleOAuthCallbackAction("FYERS", code, state);
  return NextResponse.redirect(
    result.success
      ? brokerSuccessRedirect("FYERS", baseUrl)
      : brokerFailureRedirect("FYERS", baseUrl, result.error)
  );
}
