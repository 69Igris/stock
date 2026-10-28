/**
 * TradingView UDF - Marks endpoint (MONEY-1176)
 *
 * GET /api/market/udf/marks?symbol=NSE:INFY&from=1700000000&to=1730000000&resolution=1D
 *
 * Puts a labelled glyph on the chart at every corporate-action ex-date, so the
 * cliff a raw price series shows at a split reads as an EVENT rather than a
 * crash. `DailyPrice` stores what the exchange printed (MONEY-1175), so those
 * cliffs are correct — they were just unexplained.
 *
 * Two things are easy to get wrong here and both fail silently:
 *   - the response is COLUMN-oriented (parallel arrays), not an array of
 *     objects. An array of objects renders nothing at all.
 *   - `time` is unix SECONDS, like /history.
 *
 * Actions are looked up by the current symbol, every FORMER symbol, and the
 * instrument's ISIN — so a renamed stock still shows the events it lived
 * through under its old ticker (ETERNAL's chart carries Zomato-era actions,
 * MONEY-1177) — and NOT scoped to one exchange, because a corporate action
 * belongs to the company rather than a listing.
 *
 * Spec: https://www.tradingview.com/charting-library-docs/latest/connecting_data/UDF/#marks
 */

import { auth } from "@clerk/nextjs/server";
import { NextRequest, NextResponse } from "next/server";
import { apiLogger as logger } from "@usemoney/logger";
import { isDemoSession } from "@/lib/demo/session";
import { isDemoChartSymbol } from "@/lib/demo/data";
import { prisma } from "@usemoney/database";
import {
  ISSUER_CANDIDATE_SELECT,
  issuerCandidatesWhere,
  refuseForeignIssuers,
} from "@usemoney/core/market-data";
import { parseSymbolPrefix } from "../history/route-logic";
import { buildMarks, emptyMarks } from "./route-logic";

export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  // Same gate as /history: signed-in users, or a demo session restricted to
  // the allow-listed chart symbols.
  const { userId } = await auth();
  const demo = userId ? false : await isDemoSession();
  if (!userId && !demo) {
    // Marks are cosmetic — a 401 body would make the widget log an error on
    // every chart load. Return the empty payload instead.
    return NextResponse.json(emptyMarks(), { status: 200 });
  }

  try {
    const params = request.nextUrl.searchParams;
    const symbolParam = params.get("symbol");
    const fromStr = params.get("from");
    const toStr = params.get("to");
    if (!symbolParam || !fromStr || !toStr) {
      return NextResponse.json(emptyMarks(), { status: 200 });
    }

    const { prefix, rawSymbol } = parseSymbolPrefix(symbolParam);
    if (demo && !isDemoChartSymbol(rawSymbol)) {
      return NextResponse.json(emptyMarks(), { status: 200 });
    }
    // Mutual funds have no corporate actions in this table.
    if (prefix !== "NSE" && prefix !== "BSE") {
      return NextResponse.json(emptyMarks(), { status: 200 });
    }

    const fromSec = parseInt(fromStr, 10);
    const toSec = parseInt(toStr, 10);
    if (!Number.isFinite(fromSec) || !Number.isFinite(toSec)) {
      return NextResponse.json(emptyMarks(), { status: 200 });
    }

    const symbol = rawSymbol.toUpperCase();
    const exchange = prefix.toUpperCase();

    const instrument = await prisma.instrumentMapping.findUnique({
      where: { symbol_exchange: { symbol, exchange } },
      select: { isin: true, previousSymbols: true },
    });

    // MONEY-1177: match on the CURRENT symbol, every FORMER symbol, and the
    // ISIN. A rename must not erase the events the company lived through.
    const symbols = [symbol, ...(instrument?.previousSymbols ?? [])];
    const actions = await prisma.corporateAction.findMany({
      where: {
        // Not scoped to `exchange`: a corporate action belongs to the
        // COMPANY, and the feeds report it per exchange unevenly (RELIANCE's
        // Oct-2024 bonus came from BSE only). buildMarks collapses rows
        // that describe the same event with the same FACTOR, so a cross-listed
        // event renders once — while a genuine ratio DISAGREEMENT between the
        // two exchanges still renders twice, because that is information.
        OR: [
          { symbol: { in: symbols } },
          ...(instrument?.isin ? [{ isin: instrument.isin }] : []),
        ],
        // WIDENED BY A DAY EACH SIDE, and `buildMarks` does the exact clip.
        //
        // This bound is on the RAW INSTANT while the mark's position is the
        // IST calendar day (`barSecForExDate`). Prod stores `exDate` in two
        // conventions — 18:30Z for 48,224 rows, 00:00Z for 10,863 — so the two
        // disagree by 5h30m and the edges broke in BOTH directions:
        //
        //   LEADING   from = the first bar, UTC midnight. An 18:30Z row for
        //             that very session is stored 19,800s EARLIER, fails
        //             `gte`, and is never fetched — so the whole IST fix was
        //             unreachable in production, however correct buildMarks is.
        //   TRAILING  a row inside `lte` on its raw stamp can normalise
        //             FORWARD past `toSec` and drop out.
        //
        // One day of slack covers a 5h30m skew in either direction. Over-
        // fetching is free: `buildMarks` clips on the normalised bar second,
        // which is the only place that can compare like with like.
        exDate: {
          gte: new Date((fromSec - 86_400) * 1000),
          lte: new Date((toSec + 86_400) * 1000),
        },
      },
      select: {
        id: true,
        type: true,
        exDate: true,
        ratio: true,
        dividendPerShare: true,
        oldFaceValue: true,
        newFaceValue: true,
        symbol: true,
        exchange: true,
        isin: true,
      },
      // Bounded: buildMarks caps at 200, and this stops a pathological symbol
      // pulling thousands of rows to throw most away.
      take: 500,
      orderBy: { exDate: "asc" },
    });

    // Another company's filings under the same ticker are refused, as on the
    // adjusted chart (MONEY-1543): FOCUS:NSE drew BSE Focus Business
    // Solution's bonuses — and CNL:NSE nine dividends — on days its own print
    // is flat. An issuer nobody can name stays.
    const lookup = instrument?.isin ? issuerCandidatesWhere(actions) : null;
    const candidates = lookup
      ? await prisma.instrumentMapping.findMany({
          where: lookup,
          select: ISSUER_CANDIDATE_SELECT,
        })
      : [];
    const own = refuseForeignIssuers(instrument?.isin, actions, candidates);

    return NextResponse.json(buildMarks(own.actions, fromSec, toSec), {
      status: 200,
    });
  } catch (error) {
    // Never break a chart over decoration.
    logger.error({ error }, "[udf/marks] error");
    return NextResponse.json(emptyMarks(), { status: 200 });
  }
}
