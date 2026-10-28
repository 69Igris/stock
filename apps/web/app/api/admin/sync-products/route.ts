import { NextRequest, NextResponse } from "next/server";
import { auth, clerkClient } from "@clerk/nextjs/server";
import { syncDodoProducts } from "@usemoney/services/product-sync";
import { paymentsLogger as logger } from "@usemoney/logger";
import {
  checkAdminAccess,
  formatAdminSyncResponse,
  type AdminMetadata,
} from "./route-logic";

export async function POST(request: NextRequest) {
  try {
    const { userId } = await auth();

    if (!userId) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    // Verify admin role via Clerk metadata
    const client = await clerkClient();
    const clerkUser = await client.users.getUser(userId);
    const access = checkAdminAccess(
      userId,
      clerkUser.publicMetadata as AdminMetadata
    );
    if (!access.allowed) {
      return NextResponse.json(
        { error: access.error },
        { status: access.status }
      );
    }

    logger.info(`Product sync triggered by user: ${userId}`);

    const result = await syncDodoProducts();

    return NextResponse.json(
      formatAdminSyncResponse(result.synced, result.errors)
    );
  } catch (error: unknown) {
    logger.error(
      `Product sync failed: ${error instanceof Error ? error.message : "Unknown error"}`
    );
    return NextResponse.json({ error: "Product sync failed" }, { status: 500 });
  }
}
