/**
 * Interactive Brokers OAuth Callback Route
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
    "INTERACTIVE_BROKERS",
    request.nextUrl.searchParams
  );

  if (cancelled || !code) {
    return NextResponse.redirect(
      brokerCancelRedirect("INTERACTIVE_BROKERS", baseUrl, cancelReason)
    );
  }

  const result = await handleOAuthCallbackAction(
    "INTERACTIVE_BROKERS",
    code,
    state
  );
  return NextResponse.redirect(
    result.success
      ? brokerSuccessRedirect("INTERACTIVE_BROKERS", baseUrl)
      : brokerFailureRedirect("INTERACTIVE_BROKERS", baseUrl, result.error)
  );
}
