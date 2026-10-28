/**
 * Angel One Publisher Login Callback Route
 *
 * After the user logs in on Angel One's publisher login page, they're
 * redirected here with `?auth_token=<JWT>`. The auth_token IS the JWT — no
 * exchange step — so it's passed straight to the action as the "code".
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
    "ANGEL_ONE",
    request.nextUrl.searchParams
  );

  if (cancelled || !code) {
    return NextResponse.redirect(
      brokerCancelRedirect("ANGEL_ONE", baseUrl, cancelReason)
    );
  }

  const result = await handleOAuthCallbackAction("ANGEL_ONE", code, state);
  return NextResponse.redirect(
    result.success
      ? brokerSuccessRedirect("ANGEL_ONE", baseUrl)
      : brokerFailureRedirect("ANGEL_ONE", baseUrl, result.error)
  );
}
