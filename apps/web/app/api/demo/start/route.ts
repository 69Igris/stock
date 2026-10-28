import { NextRequest, NextResponse } from "next/server";
import { createDemoToken, COOKIE_NAME } from "@/lib/demo/session";
import { createRateLimiter } from "@usemoney/security/rate-limit";
import PostHogClient from "@/lib/posthog";
import { randomUUID } from "node:crypto";
import {
  extractDemoIp,
  demoSessionCookieAttributes,
  DEMO_COOKIE_MAX_AGE,
} from "../route-logic";

const demoRateLimiter = createRateLimiter({
  interval: 60 * 60 * 1000, // 1 hour
  uniqueTokenPerInterval: 500,
});

/**
 * MONEY-383: When a demo cookie is minted we also fire a `demo_started` event
 * to PostHog with a fresh anonymous `distinctId`. The distinctId is returned
 * to the client so it can be used to stitch subsequent demo events into the
 * same person record.
 *
 * The funnel dashboard + per-source breakdown still need to be built in
 * PostHog UI - code-side instrumentation is the prerequisite that this
 * change unblocks.
 */
export async function POST(req: NextRequest) {
  try {
    // Rate limit: 10 sessions/IP/hour
    const ip = extractDemoIp((name) => req.headers.get(name));

    const rl = await demoRateLimiter.check(10, `demo:${ip}`);
    if (!rl.success) {
      return NextResponse.json(
        { success: false, error: "Too many demo sessions. Try again later." },
        { status: 429 }
      );
    }

    const token = await createDemoToken(ip);
    const distinctId = `demo_${randomUUID()}`;

    // Fire `demo_started` (best-effort - never block the response on an
    // analytics failure).
    if (process.env.NEXT_PUBLIC_POSTHOG_KEY) {
      try {
        const posthog = PostHogClient();
        posthog.capture({
          distinctId,
          event: "demo_started",
          properties: {
            source: req.headers.get("referer") || null,
            ua: req.headers.get("user-agent") || null,
            ip_hash:
              ip === "unknown" ? null : ip.split(".").slice(0, 2).join("."),
          },
        });
        await posthog.shutdown();
      } catch (analyticsErr) {
        console.warn("[demo/start] PostHog event failed:", analyticsErr);
      }
    }

    const isProduction = process.env.NODE_ENV === "production";
    const response = NextResponse.json({ success: true, distinctId });
    response.cookies.set(
      COOKIE_NAME,
      token,
      demoSessionCookieAttributes(isProduction)
    );
    // Non-HttpOnly companion cookie so the client can read the distinctId and
    // call posthog.identify() to stitch the session. The HMAC `sb_demo` cookie
    // remains the security boundary; this cookie is informational only.
    response.cookies.set("sb_demo_did", distinctId, {
      httpOnly: false,
      secure: isProduction,
      sameSite: "lax",
      maxAge: DEMO_COOKIE_MAX_AGE,
      path: "/",
    });

    return response;
  } catch (error) {
    console.error("Demo start error:", error);
    return NextResponse.json(
      { success: false, error: "Failed to start demo session." },
      { status: 500 }
    );
  }
}
