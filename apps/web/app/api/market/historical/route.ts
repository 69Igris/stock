/**
 * Market Historical Data API
 *
 * GET /api/market/historical?symbol=RELIANCE&period=1mo&interval=1d
 * GET /api/market/historical?symbol=RELIANCE&startDate=2024-01-01&endDate=2024-12-31&interval=1d
 *
 * Returns historical OHLCV data from Yahoo Finance (MONEY-837: the Zerodha
 * candle path moved to the standalone Connect service; Yahoo is the only
 * runtime source here).
 *
 * Response includes `source` ("yahoo") and `brokerStatus`.
 *
 * The actual fetch lives in `lib/market/historical-fetcher.ts` so the
 * TradingView UDF history endpoint can reuse the same logic.
 */

import { NextRequest, NextResponse } from "next/server";
import { auth } from "@clerk/nextjs/server";
import { apiLogger as logger } from "@usemoney/logger";
import {
  fetchHistoricalBars,
  HistoricalFetchError,
} from "@/lib/market/historical-fetcher";
import { type Exchange } from "@/lib/market/symbol-mapper";
import type { Period } from "@/lib/market/yahoo-client";
import { sanitizeErrorMessage } from "@usemoney/utils/error-sanitization";

export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  try {
    // Authenticate user
    const { userId } = await auth();
    if (!userId) {
      return NextResponse.json(
        { error: "Authentication required" },
        { status: 401 }
      );
    }

    const searchParams = request.nextUrl.searchParams;
    const symbol = searchParams.get("symbol");
    const exchange = (searchParams.get("exchange") || "NSE") as Exchange;
    const period = (searchParams.get("period") || "1mo") as Period;
    const interval = searchParams.get("interval") || "1d";
    const startDateStr = searchParams.get("startDate");
    const endDateStr = searchParams.get("endDate");

    if (!symbol) {
      return NextResponse.json(
        { error: "Symbol parameter is required" },
        { status: 400 }
      );
    }

    // Parse custom date range
    let startDate: Date | undefined;
    let endDate: Date | undefined;

    if (startDateStr && endDateStr) {
      startDate = new Date(startDateStr);
      endDate = new Date(endDateStr);

      if (isNaN(startDate.getTime()) || isNaN(endDate.getTime())) {
        return NextResponse.json(
          { error: "Invalid date format. Use YYYY-MM-DD" },
          { status: 400 }
        );
      }
    }

    // Delegate to shared fetcher
    const { data, source, brokerStatus } = await fetchHistoricalBars({
      symbol,
      exchange,
      interval,
      period,
      startDate,
      endDate,
    });

    if (data.length === 0) {
      return NextResponse.json(
        { error: `No historical data found for ${symbol}` },
        { status: 404 }
      );
    }

    return NextResponse.json({
      success: true,
      symbol,
      exchange,
      period: startDate ? "custom" : period,
      interval,
      data,
      count: data.length,
      source,
      brokerStatus,
      dateRange: {
        start: data[0]?.date,
        end: data[data.length - 1]?.date,
      },
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    if (error instanceof HistoricalFetchError) {
      // Route the app-controlled message through the shared sanitizer
      // (MONEY-595 hardening) so it can never echo raw upstream/internal
      // text to the client. Today's throw sites are safe validation strings
      // (passed through unchanged); the sanitizer guards future ones.
      return NextResponse.json(
        { error: sanitizeErrorMessage(error.message) },
        { status: error.statusCode }
      );
    }
    logger.error({ error }, "Historical API error");
    return NextResponse.json(
      { error: "Failed to fetch historical data" },
      { status: 500 }
    );
  }
}
