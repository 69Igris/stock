/**
 * Paired Trades API
 *
 * GET: Fetch paired trade views for tradebook display
 * POST: Trigger trade pairing for a user
 */

import { NextRequest, NextResponse } from "next/server";
import { auth } from "@clerk/nextjs/server";
import { apiLogger as logger } from "@usemoney/logger";
import { getOrCreateDbUser } from "@/lib/db/user";
import {
  getPairedTrades,
  type PairedTradeFilters,
} from "@/lib/pairing/service";

export async function GET(request: NextRequest) {
  try {
    const { userId: clerkUserId } = await auth();
    if (!clerkUserId) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    // Get internal user ID
    const dbUser = await getOrCreateDbUser(clerkUserId);
    if (!dbUser) {
      return NextResponse.json({ error: "User not found" }, { status: 404 });
    }
    const userId = dbUser.id;

    // Parse query parameters
    const searchParams = request.nextUrl.searchParams;
    const filters: PairedTradeFilters = {
      symbol: searchParams.get("symbol") || undefined,
      broker: searchParams.get("broker") || undefined,
      segment: searchParams.get("segment") || undefined,
      status: (searchParams.get("status") as any) || undefined,
      fromDate: searchParams.get("fromDate") || undefined,
      toDate: searchParams.get("toDate") || undefined,
      limit: searchParams.get("limit")
        ? parseInt(searchParams.get("limit")!, 10)
        : 50,
      skip: searchParams.get("skip")
        ? parseInt(searchParams.get("skip")!, 10)
        : 0,
      sortBy: (searchParams.get("sortBy") as "date" | "pnl") || "date",
      sortOrder: (searchParams.get("sortOrder") as "asc" | "desc") || "desc",
    };

    // Pairing runs on mutations (trade create, import, sync), not on read path.
    // Fetch paired trades
    const result = await getPairedTrades(userId, filters);

    return NextResponse.json({
      success: true,
      trades: result.trades,
      total: result.total,
      stats: result.stats,
    });
  } catch (error: unknown) {
    logger.error({ error, method: "GET" }, "Error fetching paired trades");
    return NextResponse.json(
      {
        success: false,
        error: "Failed to fetch paired trades",
      },
      { status: 500 }
    );
  }
}

export async function POST(request: NextRequest) {
  try {
    const { userId: clerkUserId } = await auth();
    if (!clerkUserId) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    // Auth check retained; the trigger body is a no-op now.
    const dbUser = await getOrCreateDbUser(clerkUserId);
    if (!dbUser) {
      return NextResponse.json({ error: "User not found" }, { status: 404 });
    }

    // MONEY-839: pairing is OFF in this ticket — moved to the MONEY-840 redesign
    // (rebuilt as an incremental engine). This endpoint is a no-op for now so
    // existing callers don't break.
    return NextResponse.json({ success: true, queued: false });
  } catch (error: unknown) {
    logger.error({ error, method: "POST" }, "Error triggering trade pairing");
    return NextResponse.json(
      {
        success: false,
        error: "Failed to trigger trade pairing",
      },
      { status: 500 }
    );
  }
}
