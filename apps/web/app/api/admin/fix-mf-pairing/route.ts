/**
 * API endpoint to fix MF trade pairing issues
 *
 * Usage:
 * - GET /api/admin/fix-mf-pairing - Diagnose MF pairing issues
 * - POST /api/admin/fix-mf-pairing - Fix ISIN and trigger re-pairing
 */

import { auth, clerkClient } from "@clerk/nextjs/server";
import {
  diagnoseMFPairingAction,
  populateMFISINAction,
  triggerRepairingAction,
} from "@/lib/actions/broker-connection";
import { NextResponse } from "next/server";

// GET - Diagnose MF pairing issues
export async function GET() {
  const { userId } = await auth();
  if (!userId) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const client = await clerkClient();
  const clerkUser = await client.users.getUser(userId);
  if ((clerkUser.publicMetadata as Record<string, unknown>)?.role !== "admin") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const result = await diagnoseMFPairingAction();
  return NextResponse.json(result);
}

// POST - Fix ISIN and trigger re-pairing
export async function POST(request: Request) {
  const { userId } = await auth();
  if (!userId) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const client = await clerkClient();
  const clerkUser = await client.users.getUser(userId);
  if ((clerkUser.publicMetadata as Record<string, unknown>)?.role !== "admin") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  // Check for action parameter
  const url = new URL(request.url);
  const action = url.searchParams.get("action");

  if (action === "diagnose") {
    const result = await diagnoseMFPairingAction();
    return NextResponse.json(result);
  }

  if (action === "repair-only") {
    // Just trigger re-pairing without updating ISIN
    const result = await triggerRepairingAction();
    return NextResponse.json(result);
  }

  // Default: Fix ISIN and trigger re-pairing
  const isinResult = await populateMFISINAction();

  if (!isinResult.success) {
    return NextResponse.json(isinResult);
  }

  // If no trades were updated with ISIN, still try re-pairing
  // (in case ISIN was already populated but pairing didn't run)
  if (isinResult.updated === 0) {
    const repairResult = await triggerRepairingAction();
    return NextResponse.json({
      success: true,
      message: "No ISIN updates needed, triggered re-pairing",
      isinUpdated: 0,
      paired: repairResult.paired,
    });
  }

  return NextResponse.json({
    success: true,
    message: `Updated ${isinResult.updated} trades with ISIN, re-paired ${isinResult.paired} trades`,
    isinUpdated: isinResult.updated,
    paired: isinResult.paired,
  });
}
