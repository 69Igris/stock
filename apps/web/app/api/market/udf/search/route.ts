/**
 * TradingView UDF - Symbol search endpoint
 *
 * GET /api/market/udf/search?query=&type=&exchange=&limit=
 *
 * Powers the symbol search box in the TradingView toolbar. Returns a **flat
 * array** (NOT wrapped in `{results: ...}`) of `SearchSymbolResultItem` shapes.
 *
 * Adapter that wraps `searchInstruments()` directly + queries `MutualFundMaster`
 * for MF results. Does NOT call `/api/market/search` - that route has many
 * existing callers and a different response shape.
 *
 * Spec: https://www.tradingview.com/charting-library-docs/latest/api/interfaces/Datafeed.SearchSymbolResultItem/
 */

import { auth } from "@clerk/nextjs/server";
import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@usemoney/database";
import { apiLogger as logger } from "@usemoney/logger";
import { searchInstruments, type Exchange } from "@/lib/market/symbol-mapper";
import { isDemoSession } from "@/lib/demo/session";
import { isDemoChartSymbol } from "@/lib/demo/data";
import {
  type SearchSymbolResultItem,
  computeTypeFilters,
  computeExchangeFilters,
  computeSearchLimit,
  isNumericCode,
  shouldIncludeEquity,
  buildEquityResultItem,
  buildMfResultItem,
} from "./search-logic";

export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  // MONEY-278: demo sessions can search, but the result set is filtered to
  // the DEMO_CHART_SYMBOLS allow-list before returning.
  const { userId } = await auth();
  const demo = userId ? false : await isDemoSession();
  if (!userId && !demo) {
    return NextResponse.json(
      { error: "Authentication required" },
      { status: 401 }
    );
  }

  try {
    const params = request.nextUrl.searchParams;
    const query = (params.get("query") || "").trim();
    const typeFilter = (params.get("type") || "").toLowerCase(); // stock, etf, fund, index, ""
    const exchangeFilter = (params.get("exchange") || "").toUpperCase(); // NSE, BSE, MF, ""
    const limit = computeSearchLimit(params.get("limit"));

    if (!query) {
      return NextResponse.json([]);
    }

    const results: SearchSymbolResultItem[] = [];

    // ── Equities / ETFs / Indices via instrument mapping ──
    const { wantsEquities, wantsFunds } = computeTypeFilters(typeFilter);
    const { wantsExchangeNseBse, wantsExchangeMf } =
      computeExchangeFilters(exchangeFilter);

    if (wantsEquities && wantsExchangeNseBse) {
      const exchangeArg: Exchange | undefined =
        exchangeFilter === "NSE" || exchangeFilter === "BSE"
          ? exchangeFilter
          : undefined;
      const equities = await searchInstruments(query, {
        limit,
        exchange: exchangeArg,
      });

      for (const inst of equities) {
        // Skip if a more specific type filter is set and doesn't match.
        if (!shouldIncludeEquity(typeFilter, inst.instrumentType)) {
          continue;
        }

        results.push(
          buildEquityResultItem(
            {
              symbol: inst.symbol,
              exchange: inst.exchange,
              name: inst.name,
              instrumentType: inst.instrumentType,
              previousSymbols: inst.previousSymbols,
            },
            query
          )
        );
        if (results.length >= limit) break;
      }
    }

    // ── Mutual funds ──
    if (wantsFunds && wantsExchangeMf && results.length < limit) {
      const remaining = limit - results.length;
      const upperQuery = query.toUpperCase();

      const mfs = await prisma.mutualFundMaster.findMany({
        where: {
          isActive: true,
          OR: isNumericCode(query)
            ? [{ schemeCode: { startsWith: query } }]
            : [
                { schemeName: { contains: query, mode: "insensitive" } },
                { amcName: { contains: upperQuery, mode: "insensitive" } },
              ],
        },
        select: {
          schemeCode: true,
          schemeName: true,
          amcName: true,
        },
        take: remaining,
        orderBy: { schemeName: "asc" },
      });

      for (const mf of mfs) {
        results.push(buildMfResultItem(mf));
      }
    }

    // MONEY-278: demo users see only allow-listed equity symbols. MFs are not
    // in the chart allow-list yet, so they're dropped from demo search.
    const filtered = demo
      ? results.filter((r) => r.type !== "fund" && isDemoChartSymbol(r.symbol))
      : results;
    return NextResponse.json(filtered);
  } catch (error) {
    logger.error({ error }, "[udf/search] error");
    // TV expects an array; return empty on error rather than 500.
    return NextResponse.json([]);
  }
}
