/**
 * Upstox OAuth Callback Route
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
    "UPSTOX",
    request.nextUrl.searchParams
  );

  if (cancelled || !code) {
    return NextResponse.redirect(
      brokerCancelRedirect("UPSTOX", baseUrl, cancelReason)
    );
  }

  const result = await handleOAuthCallbackAction("UPSTOX", code, state);
  return NextResponse.redirect(
    result.success
      ? brokerSuccessRedirect("UPSTOX", baseUrl)
      : brokerFailureRedirect("UPSTOX", baseUrl, result.error)
  );
}
