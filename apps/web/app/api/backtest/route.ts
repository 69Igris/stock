import { NextRequest, NextResponse } from "next/server";
import { currentUser } from "@clerk/nextjs/server";
import { getHistorical } from "@/lib/market/yahoo-client";
import { apiRateLimiter } from "@usemoney/security/rate-limit";
import {
  validateBacktestInput,
  validateHistoricalData,
  normalizeSymbol,
  isKnownStrategy,
  runMACrossover,
  runRSIStrategy,
  buildResponse,
} from "./route-logic";

export async function POST(req: NextRequest) {
  try {
    const user = await currentUser();
    if (!user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    // Per-user rate limit (MONEY-595 hardening): each backtest does a 1-year
    // Yahoo historical fetch + full indicator pass, so it is expensive enough
    // to abuse. 20 runs/min/user is generous for the UI yet caps a hot loop.
    const rateLimitResult = await apiRateLimiter.check(20, user.id);
    if (!rateLimitResult.success) {
      return NextResponse.json(
        { error: "Rate limit exceeded. Please try again later." },
        {
          status: 429,
          headers: {
            "Retry-After": String(Math.ceil(rateLimitResult.reset / 1000)),
          },
        }
      );
    }

    const body = await req.json();
    const { symbol, strategy, params } = body;

    const inputCheck = validateBacktestInput({ symbol, strategy });
    if (!inputCheck.valid) {
      return NextResponse.json(
        { error: inputCheck.error },
        { status: inputCheck.status }
      );
    }

    // Fetch 1 year of historical data
    const yahooSymbol = normalizeSymbol(symbol);
    const historical = await getHistorical(yahooSymbol, {
      period: "1y",
      interval: "1d",
    });

    const dataCheck = validateHistoricalData(historical);
    if (!dataCheck.valid) {
      return NextResponse.json(
        { error: dataCheck.error },
        { status: dataCheck.status }
      );
    }

    const closes = historical.map((bar) => bar.close);
    const dates = historical.map((bar) => bar.date.toISOString());

    let run;
    if (strategy === "MA_CROSSOVER") {
      run = runMACrossover(closes, dates, params);
    } else if (strategy === "RSI") {
      run = runRSIStrategy(closes, dates, params);
    } else {
      // Defense in depth: validateBacktestInput already required a strategy,
      // but only a KNOWN strategy can run a backtest.
      if (!isKnownStrategy(strategy)) {
        return NextResponse.json(
          { error: `Unknown strategy: ${strategy}` },
          { status: 400 }
        );
      }
      // Unreachable (the two known strategies are handled above), but keeps the
      // type checker happy.
      return NextResponse.json(
        { error: `Unknown strategy: ${strategy}` },
        { status: 400 }
      );
    }

    return NextResponse.json(buildResponse(symbol, strategy, run));
  } catch (error) {
    console.error("Backtest error:", error);
    return NextResponse.json(
      { error: "Backtest failed. Please try again." },
      { status: 500 }
    );
  }
}
