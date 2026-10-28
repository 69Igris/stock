import { NextRequest, NextResponse } from "next/server";
import { clearFeatureFlagsCache } from "@/lib/actions/feature-flags";
import { checkAdminAuth, isDebugEnabled } from "@usemoney/auth";

// Force dynamic rendering for this route
export const dynamic = "force-dynamic";

/**
 * Debug endpoint to clear feature flags cache
 * GET /api/debug/clear-ff-cache - Clear cache for admin user only
 * GET /api/debug/clear-ff-cache?all=true - Clear all caches (admin only)
 *
 * RESTRICTED: Only accessible by admin users (Clerk role metadata or ADMIN_EMAILS env var)
 */
export async function GET(request: NextRequest) {
  try {
    // Check if debug features are enabled
    if (!isDebugEnabled()) {
      return NextResponse.json(
        { error: "Debug features are disabled in production" },
        { status: 403 }
      );
    }

    // Check admin authentication
    const { isAdmin, userId, userEmail } = await checkAdminAuth();

    if (!isAdmin) {
      return NextResponse.json(
        {
          error: "Unauthorized: Admin access required",
          message: "This endpoint is restricted to admin users only",
        },
        { status: 403 }
      );
    }

    const searchParams = request.nextUrl.searchParams;
    const clearAll = searchParams.get("all") === "true";

    if (clearAll) {
      // Clear all caches
      await clearFeatureFlagsCache();
      return NextResponse.json({
        success: true,
        message: "All feature flag caches cleared",
        clearedBy: userEmail,
      });
    } else {
      // Clear cache for admin user
      await clearFeatureFlagsCache(userId!, userEmail!);
      return NextResponse.json({
        success: true,
        message: `Feature flag cache cleared for user ${userId}`,
        userId,
        email: userEmail,
      });
    }
  } catch (error) {
    console.error("Error clearing feature flags cache:", error);
    return NextResponse.json(
      { error: "Failed to clear cache" },
      { status: 500 }
    );
  }
}
