import { NextResponse } from "next/server";
import { getSubscriptionAccess } from "@/lib/subscription/access";
import { subscriptionLogger as logger } from "@usemoney/logger";

// Per-user entitlement — must never be prerendered or shared.
export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const access = await getSubscriptionAccess();
    // MONEY-1126: `getSubscriptionAccess` now caches its resolution SERVER-side,
    // scoped to the internal user id. The HTTP response deliberately stays
    // uncacheable: this body is one user's entitlement, and the route had no
    // `Cache-Control` at all, so nothing stopped a shared cache from holding it.
    // Caching belongs behind the user-id key, not in front of it.
    return NextResponse.json(access, {
      headers: { "Cache-Control": "private, no-store, max-age=0" },
    });
  } catch (error) {
    logger.error({ error }, "Error getting subscription access");
    return NextResponse.json(
      { error: "Failed to get subscription access" },
      { status: 500 }
    );
  }
}
