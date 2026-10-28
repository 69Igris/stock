import { NextRequest, NextResponse } from "next/server";
import { COOKIE_NAME } from "@/lib/demo/session";
import PostHogClient from "@/lib/posthog";
import { demoClearCookieAttributes } from "../route-logic";

/**
 * MONEY-383: ending a demo session fires `demo_ended_signup_started` if the
 * caller indicates they're routing to sign-up. The funnel uses this to mark
 * the "demo → signup" transition.
 */
export async function POST(req: NextRequest) {
  const distinctId = req.cookies.get("sb_demo_did")?.value;
  const reason = req.nextUrl.searchParams.get("reason") || "ended";

  if (distinctId && process.env.NEXT_PUBLIC_POSTHOG_KEY) {
    try {
      const posthog = PostHogClient();
      const event =
        reason === "signup" ? "demo_ended_signup_started" : "demo_ended";
      posthog.capture({
        distinctId,
        event,
        properties: { reason },
      });
      await posthog.shutdown();
    } catch (analyticsErr) {
      console.warn("[demo/end] PostHog event failed:", analyticsErr);
    }
  }

  const isProduction = process.env.NODE_ENV === "production";
  const response = NextResponse.json({ success: true });
  response.cookies.set(
    COOKIE_NAME,
    "",
    demoClearCookieAttributes(isProduction)
  );
  response.cookies.set("sb_demo_did", "", {
    httpOnly: false,
    secure: isProduction,
    sameSite: "lax",
    maxAge: 0,
    path: "/",
  });
  return response;
}
