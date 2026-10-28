/**
 * Fund Composition API
 *
 * GET /api/market/fund-composition?fundType=MF&fundId=119551
 *
 * Returns cached composition data or 404 if not yet extracted.
 */

import { NextRequest, NextResponse } from "next/server";
import { getCompositionFromDb } from "@usemoney/core/market-data";
import { apiLogger as logger } from "@usemoney/logger";

export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  try {
    const searchParams = request.nextUrl.searchParams;
    const fundType = searchParams.get("fundType") as
      | "MF"
      | "ETF"
      | "INDEX"
      | null;
    const fundId = searchParams.get("fundId");

    if (!fundType || !fundId) {
      return NextResponse.json(
        { error: "fundType and fundId parameters are required" },
        { status: 400 }
      );
    }

    if (fundType !== "MF" && fundType !== "ETF" && fundType !== "INDEX") {
      return NextResponse.json(
        { error: "fundType must be MF, ETF, or INDEX" },
        { status: 400 }
      );
    }

    const result = await getCompositionFromDb(fundType, fundId);

    if (!result) {
      return NextResponse.json(
        { error: "Composition not yet extracted for this fund" },
        { status: 404 }
      );
    }

    return NextResponse.json({ data: result });
  } catch (error) {
    logger.error({ error }, "[fund-composition] API error");
    return NextResponse.json(
      { error: "Failed to fetch fund composition" },
      { status: 500 }
    );
  }
}
