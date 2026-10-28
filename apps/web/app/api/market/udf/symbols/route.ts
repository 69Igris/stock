/**
 * TradingView UDF - Symbol resolution endpoint
 *
 * GET /api/market/udf/symbols?symbol=NSE:TCS
 * GET /api/market/udf/symbols?symbol=MF:120503
 *
 * Resolves a symbol to a `LibrarySymbolInfo` record. The TradingView widget
 * calls this once per symbol load and caches the result.
 *
 * Critical rules:
 * - On unknown symbol return `{s:"error", errmsg:"..."}` - do NOT throw, the
 *   widget hangs forever on a thrown error.
 * - `supported_resolutions` is computed PER-SYMBOL based on broker creds, so
 *   free-tier users don't see Zerodha-only intervals (3m, 10m).
 * - For MFs and indices set `has_no_volume:true` and `visible_plots_set:"c"`
 *   so the chart hides volume and shows the close-only line view.
 *
 * Spec: https://www.tradingview.com/charting-library-docs/latest/api/interfaces/Datafeed.LibrarySymbolInfo/
 */

import { auth } from "@clerk/nextjs/server";
import { NextRequest, NextResponse } from "next/server";
import { apiLogger as logger } from "@usemoney/logger";
import { prisma } from "@usemoney/database";
import {
  findInstrument,
  INDEX_MAPPINGS,
  type Exchange,
} from "@/lib/market/symbol-mapper";
import { isDemoSession } from "@/lib/demo/session";
import { isDemoChartSymbol } from "@/lib/demo/data";
import {
  type ResolvedSymbol,
  computeSupportedResolutions,
  parseSymbolPrefix,
  isUnsupportedEquityExchange,
  buildEquitySymbolInfo,
  buildIndexSymbolInfo,
  buildFundSymbolInfo,
} from "./symbols-logic";

export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  // Auth boundary - match historical/route.ts.
  // MONEY-278: demo sessions also pass, but are restricted to DEMO_CHART_SYMBOLS
  // and never see broker-credentialed intraday resolutions.
  const { userId } = await auth();
  const demo = userId ? false : await isDemoSession();
  if (!userId && !demo) {
    return NextResponse.json(
      { error: "Authentication required" },
      { status: 401 }
    );
  }

  try {
    const symbolParam = request.nextUrl.searchParams.get("symbol");
    if (!symbolParam) {
      return NextResponse.json(
        { s: "error", errmsg: "symbol parameter is required" },
        { status: 200 } // 200 with error body so TV displays the message
      );
    }

    // Demo allow-list enforcement: parse the raw symbol and reject early if
    // it's not in the demo-chart whitelist. Avoids unauthenticated probes of
    // the full instrument table.
    if (demo) {
      const { rawSymbol } = parseSymbolPrefix(symbolParam);
      if (!isDemoChartSymbol(rawSymbol)) {
        return NextResponse.json(
          {
            s: "error",
            errmsg: `${rawSymbol} is not available in demo mode`,
          },
          { status: 200 }
        );
      }
    }

    // MONEY-837: the web app no longer serves broker-credentialed market data
    // (live quotes / intraday / streaming moved to the standalone Connect
    // service). No symbol exposes the Zerodha-only intraday resolutions
    // (3m / 10m) or a streaming data_status, so this is always false.
    const hasBrokerCreds = false;

    // ── Parse "EXCHANGE:SYMBOL" prefix ──
    const { prefix, rawSymbol } = parseSymbolPrefix(symbolParam);

    // ── MF branch ──
    if (prefix === "MF") {
      const mf = await prisma.mutualFundMaster.findUnique({
        where: { schemeCode: rawSymbol },
        select: {
          schemeCode: true,
          schemeName: true,
          amcName: true,
          category: true,
        },
      });

      if (!mf) {
        return NextResponse.json(
          { s: "error", errmsg: `unknown mutual fund: ${rawSymbol}` },
          { status: 200 }
        );
      }

      const resolved: ResolvedSymbol = buildFundSymbolInfo({
        schemeCode: mf.schemeCode,
        schemeName: mf.schemeName,
        amcName: mf.amcName,
        hasBrokerCreds,
      });
      return NextResponse.json(resolved);
    }

    // ── NSE / BSE branch ──
    if (isUnsupportedEquityExchange(prefix)) {
      return NextResponse.json(
        { s: "error", errmsg: `unsupported exchange prefix: ${prefix}` },
        { status: 200 }
      );
    }
    const exchange = prefix as Exchange;
    const upperSymbol = rawSymbol.toUpperCase();

    // First check well-known indices
    const indexYahoo = INDEX_MAPPINGS[upperSymbol];
    if (indexYahoo) {
      const resolved: ResolvedSymbol = buildIndexSymbolInfo({
        symbol: upperSymbol,
        exchange,
        description: upperSymbol,
        hasBrokerCreds,
      });
      return NextResponse.json(resolved);
    }

    // Otherwise look up via the DB-backed instrument resolver
    const instrument = await findInstrument(upperSymbol, exchange);
    if (!instrument) {
      return NextResponse.json(
        { s: "error", errmsg: `unknown symbol: ${prefix}:${upperSymbol}` },
        { status: 200 }
      );
    }

    // MONEY-1383 (L4): read the type off the row `findInstrument` ALREADY
    // fetched. This used to be a second `findUnique` against the same
    // `symbol_exchange` key for one extra column — two round trips on a route
    // measured at 0.83s warm / 2.50s cold, and every chart load pays it.
    const instrumentType = instrument.instrumentType.toUpperCase();
    const tvType: "stock" | "etf" | "index" =
      instrumentType === "ETF"
        ? "etf"
        : instrumentType === "INDEX"
          ? "index"
          : "stock";

    if (tvType === "index") {
      // DB-resolved index: unlike a well-known INDEX_MAPPINGS index, the data
      // status depends on broker creds (no guaranteed delayed feed otherwise).
      const resolved: ResolvedSymbol = {
        ticker: `${exchange}:${upperSymbol}`,
        name: upperSymbol,
        full_name: `${exchange}:${upperSymbol}`,
        description: instrument.name,
        type: "index",
        session: "0915-1530",
        timezone: "Asia/Kolkata",
        exchange,
        listed_exchange: exchange,
        format: "price",
        pricescale: 100,
        minmov: 1,
        has_intraday: true,
        has_daily: true,
        has_weekly_and_monthly: true,
        supported_resolutions: computeSupportedResolutions(
          "index",
          hasBrokerCreds
        ),
        volume_precision: 0,
        data_status: hasBrokerCreds ? "delayed_streaming" : "endofday",
        has_no_volume: true,
        visible_plots_set: "c",
      };
      return NextResponse.json(resolved);
    }

    const resolved: ResolvedSymbol = buildEquitySymbolInfo({
      symbol: upperSymbol,
      exchange,
      description: instrument.name,
      type: tvType,
      hasBrokerCreds,
    });
    return NextResponse.json(resolved);
  } catch (error) {
    logger.error({ error }, "[udf/symbols] error");
    return NextResponse.json(
      { s: "error", errmsg: "internal error resolving symbol" },
      { status: 200 }
    );
  }
}
