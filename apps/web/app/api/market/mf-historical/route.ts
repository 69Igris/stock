/**
 * MF Historical NAV API
 *
 * GET /api/market/mf-historical?schemeCode=119551&period=1y
 *
 * Returns historical NAV data for a mutual fund scheme.
 * Data is fetched from MFAPI.in and cached in the MfNavHistory table.
 *
 * Periods: 1m, 3m, 6m, 1y, 2y, 3y, 5y, max
 */

import { NextRequest, NextResponse } from "next/server";
import { getMfNavHistory } from "@usemoney/core/market-data";
import { apiLogger as logger } from "@usemoney/logger";

export const dynamic = "force-dynamic";

const VALID_PERIODS = [
  "1m",
  "3m",
  "6m",
  "1y",
  "2y",
  "3y",
  "5y",
  "max",
] as const;
type MfPeriod = (typeof VALID_PERIODS)[number];

function getStartDateFromPeriod(period: MfPeriod): Date {
  const now = new Date();
  switch (period) {
    case "1m":
      now.setMonth(now.getMonth() - 1);
      return now;
    case "3m":
      now.setMonth(now.getMonth() - 3);
      return now;
    case "6m":
      now.setMonth(now.getMonth() - 6);
      return now;
    case "1y":
      now.setFullYear(now.getFullYear() - 1);
      return now;
    case "2y":
      now.setFullYear(now.getFullYear() - 2);
      return now;
    case "3y":
      now.setFullYear(now.getFullYear() - 3);
      return now;
    case "5y":
      now.setFullYear(now.getFullYear() - 5);
      return now;
    case "max":
      return new Date(0);
  }
}

export async function GET(request: NextRequest) {
  try {
    const searchParams = request.nextUrl.searchParams;
    const schemeCode = searchParams.get("schemeCode");
    const period = (searchParams.get("period") || "1y") as MfPeriod;

    if (!schemeCode) {
      return NextResponse.json(
        { error: "schemeCode parameter is required" },
        { status: 400 }
      );
    }

    if (!VALID_PERIODS.includes(period)) {
      return NextResponse.json(
        {
          error: `Invalid period. Valid periods: ${VALID_PERIODS.join(", ")}`,
        },
        { status: 400 }
      );
    }

    const startDate = getStartDateFromPeriod(period);
    const data = await getMfNavHistory(schemeCode, startDate);

    return NextResponse.json({
      data,
      meta: {
        schemeCode,
        period,
        count: data.length,
      },
    });
  } catch (error) {
    logger.error({ error }, "[mf-historical] API error");
    return NextResponse.json(
      { error: "Failed to fetch MF historical data" },
      { status: 500 }
    );
  }
}
