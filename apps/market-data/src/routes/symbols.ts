/**
 * `/udf/symbols` and `/udf/search` — symbol resolution. MONEY-1476.
 *
 * ## WHY THIS EXISTS, AND WHAT IT COST TO LEARN
 *
 * These two shipped as 501 stubs ("not implemented (A2)") and stayed that way
 * while `/udf/history` was completed. On 2026-09-18 `MARKET_DATA_TILES` was set
 * true on prod, which points every chart at this service — and every chart went
 * blank with **"Symbol Error · invalid symbol"**.
 *
 * TradingView's UDF flow calls `resolveSymbol` FIRST and will not request a
 * single bar until it succeeds. So the endpoint that worked was the only one
 * anybody exercised, and the endpoint that was unimplemented was the one the
 * widget hits first. `market-data-smoke.sh` passed 21/21 through the whole
 * outage because it probed `/udf/config`, `/udf/time` and `/udf/history` and
 * never these. It probes them now.
 *
 * ## IT SHARES THE WEB APP'S LOGIC, NOT A SECOND COPY
 *
 * Every shape decision — supported resolutions, pricescale, session, the
 * volume/close-only handling for funds and indices — comes from
 * `@usemoney/core/market-data/udf/symbols-logic`, which `apps/web` also uses.
 * A chart that resolves differently depending on which origin served it is the
 * defect the A3 parity harness exists to prevent.
 *
 * ## `hasBrokerCreds` IS ALWAYS FALSE HERE, DELIBERATELY
 *
 * MONEY-837 moved broker-credentialed market data out of the product entirely;
 * no symbol exposes the Zerodha-only 3m/10m resolutions. `apps/web` hardcodes
 * the same false. Reading it from a token claim would be a new entitlement
 * surface invented in a bug fix.
 *
 * ## ERRORS ARE 200, NEVER A STATUS
 *
 * The widget displays `{s:"error", errmsg}` and HANGS on a thrown error. A 501
 * is what produced "invalid symbol" with no explanation.
 */
import { Hono } from "hono";
import { prisma } from "@usemoney/database";
import {
  buildEquitySymbolInfo,
  buildFundSymbolInfo,
  type ResolvedSymbol,
  buildUsSymbolInfo,
} from "@usemoney/core/market-data/udf/symbols-logic";
import { canBuildTileKey } from "@usemoney/core/market-data/tiles/tile-logic";
import { resolveListing } from "./history";
import {
  buildMfResultItem,
  computeExchangeFilters,
  computeSearchLimit,
  computeTypeFilters,
  instrumentTypeToTvType,
  isNumericCode,
  shouldIncludeEquity,
  type SearchSymbolResultItem,
} from "@usemoney/core/market-data/udf/search-logic";
import { CACHE_CONTROL, tokenMayReadUs } from "../app-logic";
import { checkMarketToken } from "../middleware/market-token";

const symbols = new Hono();

/** See the header: MONEY-837 removed the broker-credentialed surface. */
const HAS_BROKER_CREDS = false;

/** A UDF error. 200, because the widget hangs on anything else. */
const udfError = (msg: string) => ({ s: "error" as const, errmsg: msg });

/**
 * The instrument types `tile-build-d1` actually writes tiles for.
 *
 * `scripts/jobs/tile-build-d1.ts:220` selects
 * `instrumentType: "EQUITY"` — nothing else has a tile, so nothing else has
 * bars here. Resolving an ETF or a bond would hand the widget a symbol it can
 * draw no data for: `{s:"no_data"}` renders as a BLANK CHART WITH NO MESSAGE,
 * which is worse than a named refusal because it is indistinguishable from a
 * delisted instrument.
 */
export const TILED_TYPES = new Set(["EQUITY"]);

/** Is this instrument type one the tile builder writes bars for? */
/**
 * Tiingo's `assetType` → TradingView's symbol type.
 *
 * The master's vocabulary is exactly "Stock" | "ETF" | "Mutual Fund" (measured:
 * 8,307 / 5,756 / 27,289 active rows). Anything else falls back to "stock"
 * rather than throwing — an unrecognised asset type is a chart that renders as
 * an equity, which is wrong in the legend and right everywhere else; throwing
 * would be a blank chart.
 */
export function usTvType(assetType: string): "stock" | "etf" | "fund" {
  const t = assetType.trim().toLowerCase();
  if (t === "etf") return "etf";
  if (t === "mutual fund") return "fund";
  return "stock";
}

export function isChartable(instrumentType: string): boolean {
  return TILED_TYPES.has(instrumentType.toUpperCase());
}

symbols.get("/symbols", async (c) => {
  c.header("Cache-Control", CACHE_CONTROL.symbols);

  const symbolParam = c.req.query("symbol");
  if (!symbolParam) {
    c.header("Cache-Control", CACHE_CONTROL.notImplemented);
    return c.json(udfError("symbol parameter is required"), 200);
  }

  try {
    // ONE NOTION OF "A VALID SYMBOL", SHARED WITH `/udf/history`.
    //
    // The first cut parsed the symbol itself, and the two endpoints disagreed
    // in BOTH directions — measured:
    //
    //   resolved here, REFUSED by history:
    //     NSE:NIFTY 50   -> history leaked the tile store's internal message
    //                       ("refusing to build a tile key ... must match
    //                       [A-Za-z0-9._:+-]") straight into the user's chart.
    //                       The 501 stub had made that unreachable.
    //     MF:120503      -> "unrecognised symbol"
    //     NSE:NIFTYBEES  -> resolves, then blanks forever (not tiled)
    //
    //   REFUSED here, served by history:
    //     nse:reliance            -> prefix never uppercased
    //     AAPL:NASDAQ:1980-12-12  -> split on the FIRST colon gave prefix
    //                                "AAPL", so the whole US lane was
    //                                unreachable by the widget, which requests
    //                                no bar until resolveSymbol succeeds.
    //
    // `resolveListing` is history's own function, exported. Asking it is the
    // only way the two can agree by construction rather than by review.
    // A BARE SYMBOL MEANS NSE, matching `apps/web`.
    //
    // `parseSymbolPrefix` defaults a missing prefix to NSE, so
    // `/udf/symbols?symbol=RELIANCE` resolves there. `resolveListing` requires
    // 2 or 3 parts, so without this the two origins disagree about a symbol
    // form — latent today, because `combineSymbol` in
    // TradingViewAdvancedChart.tsx always emits `EXCHANGE:SYMBOL`, but a
    // divergence nothing sends is still a divergence waiting for the first
    // caller that does.
    //
    // Applied to the SYMBOL, not inside `resolveListing`: history's contract is
    // shared with the tile key and must keep requiring an explicit exchange.
    const qualified = symbolParam.includes(":")
      ? symbolParam
      : `NSE:${symbolParam}`;
    const listing = resolveListing(qualified);
    if (!listing) {
      c.header("Cache-Control", CACHE_CONTROL.notImplemented);
      return c.json(udfError(`unsupported symbol: ${symbolParam}`), 200);
    }

    // REFUSE WHAT THE KEY BUILDER REFUSES. MONEY-1476.
    //
    // `resolveListing` accepts any 2-part symbol, so `NSE:NIFTY 50` yields the
    // listing id "NIFTY 50:NSE" — which `tileKey5y` rejects for containing a
    // space, by THROWING. `/udf/history` returns `err.message`, so the tile
    // store's internal explanation about GCS prefixes was rendered inside the
    // user's chart. Every index whose name carries a space is in that
    // population, and the DB row for one looks perfectly chartable, so neither
    // the type guard nor `resolveListing` catches it.
    //
    // Asking the key builder's own predicate is the only way the two agree.
    //
    // IT RUNS BEFORE THE FUND AND US BRANCHES. MONEY-1478 review.
    //
    // It used to sit below them, so the one check that keeps `/udf/symbols` and
    // `/udf/history` agreeing BY CONSTRUCTION was skipped on both newly-opened
    // lanes. A `us_instruments.listingId` carrying any character outside the
    // safe charset would resolve here and then make `/udf/history` render
    // `UnsafeListingIdError.message` — the tile store's internal note about GCS
    // prefixes — inside the user's chart. That is MONEY-1476's original leak,
    // rebuilt on the new lane. A fund has no listing id and is unaffected
    // either way, which is exactly why the guard is cheap to run first.
    // Scoped to `kind === "tile"` by the UNION, not by an order of statements:
    // a fund has no listing id at all, and the compiler says so. That is the
    // discriminated union earning its keep — the guard now covers BOTH tile
    // markets and cannot be skipped by a branch added above it.
    if (listing.kind === "tile" && !canBuildTileKey(listing.listingId)) {
      c.header("Cache-Control", CACHE_CONTROL.notImplemented);
      return c.json(
        udfError(`${symbolParam} cannot be charted by this datafeed`),
        200,
      );
    }

    // ── MUTUAL FUNDS resolve here now. MONEY-1478. ─────────────────────
    if (listing.kind === "fund") {
      const mf = await prisma.mutualFundMaster.findUnique({
        where: { schemeCode: listing.schemeCode },
        select: { schemeCode: true, schemeName: true, amcName: true },
      });
      if (!mf) {
        c.header("Cache-Control", CACHE_CONTROL.notImplemented);
        return c.json(
          udfError(`unknown mutual fund: ${listing.schemeCode}`),
          200,
        );
      }
      return c.json(
        buildFundSymbolInfo({
          schemeCode: mf.schemeCode,
          schemeName: mf.schemeName,
          amcName: mf.amcName,
          hasBrokerCreds: HAS_BROKER_CREDS,
        }) satisfies ResolvedSymbol,
      );
    }

    // US LISTINGS RESOLVE NOW, BEHIND THE LICENCE CLAIM. MONEY-1478.
    //
    // MONEY-1476 refused them BY NAME and named its own two preconditions:
    // "Re-enable in the change that builds US tiles AND gates the licence, not
    // before". Both are now met, and both were MEASURED rather than assumed:
    //
    //   tiles    gs://stockbook-lake-prod/tiles/US/d1/ holds 13,978 listing
    //            prefixes, `AAPL:NASDAQ:1980-12-12/2016..2025.json` among them.
    //            The premise the old comment rested on — "prod holds no D1 tile
    //            for a US listing" — had gone stale under it.
    //   licence  `/udf/history` gates US on `tokenMayReadUs` as of d7c73700,
    //            ON THIS BRANCH. So the gate and this lift deploy together,
    //            which is what "two halves of one decision" demanded.
    //
    // THE CLAIM IS CHECKED HERE TOO, not inherited. `/udf/symbols` is a
    // separate request on a separate origin-cached route: resolving a symbol
    // this caller may not read bars for is the resolve-then-fail defect
    // MONEY-1476 was spent closing, pointed the other way — the chart would
    // open, ask for bars, and be refused with an empty frame.
    //
    // `US_MARKET_ALLOWED_EMAILS` still defaults to the founder alone, so this
    // widens NOTHING by itself: it makes the licensed lane reachable and
    // leaves who is licensed exactly where it was.
    if (listing.market === "US") {
      const auth = checkMarketToken(c.req.header("Authorization"));
      if (!auth.ok || !tokenMayReadUs(auth.claims)) {
        c.header("Cache-Control", CACHE_CONTROL.notImplemented);
        console.warn(
          `[market-data] US symbol refused: ${auth.ok ? "no us claim" : auth.reason}`,
        );
        // The SAME sentence `/udf/history` refuses with. Two spellings of one
        // refusal read as two different faults to whoever is debugging it.
        return c.json(
          udfError("US market data is not available on this account"),
          200,
        );
      }

      // `us_instruments`, NOT `instrument_mappings` — that table is India-only,
      // so the equity path below would look up symbol "AAPL" on exchange
      // "NASDAQ", miss, and answer "unknown symbol" for a listing whose tiles
      // are sitting in the lake. The lookup is on `listingId`, the model's only
      // unique, which is also the tile key.
      const us = await prisma.usInstrument.findFirst({
        where: { listingId: listing.listingId },
        select: { symbol: true, exchange: true, name: true, assetType: true },
      });
      if (!us) {
        c.header("Cache-Control", CACHE_CONTROL.notImplemented);
        return c.json(udfError(`unknown symbol: ${symbolParam}`), 200);
      }
      // NOT SHARED-CACHED. The handler sets `public, s-maxage=300` at the top
      // and that header would UNDO the check three lines above it: the CDN key
      // is scheme + host + path + query with nothing about the caller, and
      // `?symbol=AAPL:NASDAQ:1980-12-12` is a URL any anonymous client can
      // replay. A licensed user's resolve would publish the resolution — and
      // with it the fact that this listing is chartable — for five minutes.
      c.header("Cache-Control", CACHE_CONTROL.licensed);
      return c.json(
        buildUsSymbolInfo({
          listingId: listing.listingId,
          symbol: us.symbol,
          exchange: us.exchange,
          // `name` is NULLABLE and is filled by a separate paced leg, so a row
          // it has not reached yet has none. Fall back to the SYMBOL rather
          // than sending an empty description: the widget renders it in the
          // legend, and an empty one reads as a broken symbol.
          description: us.name ?? us.symbol,
          type: usTvType(us.assetType),
        }) satisfies ResolvedSymbol,
      );
    }

    const [upper, ex] = listing.listingId.split(":") as [string, string];
    // A RENAMED TICKER STILL RESOLVES. MONEY-1478 / MONEY-1177.
    //
    // `findUnique` on `symbol_exchange` alone means ZOMATO (now ETERNAL) and
    // TATAMOTORS (now TMCV/TMPV) resolve NOWHERE — a user with an old chart
    // saved, or an old link, gets "unknown symbol" for a company that exists.
    // `previousSymbols` carries a dedicated `@@index`, so the fallback costs a
    // second indexed lookup and only when the first misses.
    const instrument =
      (await prisma.instrumentMapping.findUnique({
        where: { symbol_exchange: { symbol: upper, exchange: ex } },
        select: { symbol: true, name: true, instrumentType: true },
      })) ??
      (await prisma.instrumentMapping.findFirst({
        where: {
          exchange: ex,
          previousSymbols: { has: upper },
          isActive: true,
        },
        select: { symbol: true, name: true, instrumentType: true },
      }));
    if (!instrument) {
      c.header("Cache-Control", CACHE_CONTROL.notImplemented);
      return c.json(udfError(`unknown symbol: ${ex}:${upper}`), 200);
    }

    const type = instrument.instrumentType.toUpperCase();
    if (!isChartable(type)) {
      // NAMED, not silent. See `TILED_TYPES`: the alternative is a blank chart
      // the user cannot distinguish from a delisted stock.
      c.header("Cache-Control", CACHE_CONTROL.notImplemented);
      return c.json(
        udfError(
          `${ex}:${upper} is ${type} — this datafeed serves equities only`,
        ),
        200,
      );
    }

    return c.json(
      buildEquitySymbolInfo({
        // The ROW's symbol, not the query's: a rename resolves to the CURRENT
        // ticker, so the widget caches and requests bars under the name that
        // actually has tiles.
        symbol: instrument.symbol,
        exchange: ex,
        description: instrument.name,
        type: "stock",
        hasBrokerCreds: HAS_BROKER_CREDS,
      }) satisfies ResolvedSymbol,
    );
  } catch (error) {
    // LOGGED. A bare catch here made a Mongo credential rotation or an Atlas
    // failover indistinguishable from "unknown symbol": every chart says
    // invalid, every search says no results, and the service emits no error
    // and no non-2xx, so the dashboards read healthy.
    console.error(
      `[market-data] /udf/symbols failed for ${symbolParam}: ${String(error)}`,
    );
    c.header("Cache-Control", CACHE_CONTROL.notImplemented);
    return c.json(udfError("internal error resolving symbol"), 200);
  }
});

/**
 * Mongo's `contains`/`startsWith` compile to `$regex`, so a user string reaches
 * the engine as a PATTERN. Measured: `?query=(` throws MongoDB error 51111
 * ("missing closing parenthesis") on the FIRST query, and the catch below turns
 * it into `200 []` — a user typing an open bracket silently gets "no results".
 * `[` and a trailing backslash do the same.
 */
export function escapeRegex(v: string): string {
  return v.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

symbols.get("/search", async (c) => {
  c.header("Cache-Control", CACHE_CONTROL.search);

  const raw = (c.req.query("query") ?? "").trim();
  const limit = computeSearchLimit(c.req.query("limit") ?? null);
  // An EMPTY ARRAY, never an error: the widget renders "no results" for `[]`
  // and shows nothing at all for an error shape here.
  if (raw === "") return c.json([] satisfies SearchSymbolResultItem[]);

  // THE FILTER TABS ARE REAL PARAMS. The bundled datafeed always sends them
  // from the search dialog, and ignoring them meant picking "NSE" or "Stock"
  // changed nothing — `config.ts` states the Bond type exists precisely so the
  // filter "stops a G-Sec being presented as a share".
  const typeFilter = (c.req.query("type") ?? "").trim();
  const exchangeFilter = (c.req.query("exchange") ?? "").trim();
  const { wantsEquities, wantsFunds } = computeTypeFilters(typeFilter);
  const { wantsExchangeNseBse, wantsExchangeMf } =
    computeExchangeFilters(exchangeFilter);

  // TWO VALUES, because there are two KINDS of match and they need opposite
  // treatment. MONEY-1478 review.
  //
  //   `startsWith` -> Prisma compiles it to a Mongo `$regex`, so the needle
  //                   MUST be escaped or `?query=(` is a 51111 server error.
  //   `has`        -> array-element EQUALITY. An escaped needle can never
  //                   match: searching `BRK.B` looked for the literal `BRK\.B`.
  //
  // One `upper` served both, so whichever kind it was wrong for failed
  // silently — the equality one, which is why a renamed ticker carrying a dot
  // resolved nowhere while the regex one looked fine.
  const query = escapeRegex(raw);
  const upperRe = query.toUpperCase();
  const upperLiteral = raw.toUpperCase();

  try {
    const out: SearchSymbolResultItem[] = [];

    if (wantsEquities && wantsExchangeNseBse) {
      const select = {
        symbol: true,
        exchange: true,
        name: true,
        instrumentType: true,
      } as const;

      // PREFIX ONLY, AND THAT IS A DELIBERATE NARROWING. MONEY-1478.
      //
      // `apps/web` also matches `name: { contains, mode: "insensitive" }`. That
      // is UNINDEXABLE — schema.prisma records that insensitive mode "cannot
      // take tight prefix bounds" — so every miss scanned ~24k active rows,
      // PER KEYSTROKE, ANONYMOUSLY, against the shared prod Atlas, on a service
      // built to take a Mongo read OFF the chart path. `apps/web`'s equivalent
      // is Clerk-gated; this one is public.
      //
      // The cost is real and worth stating: typing a company NAME no longer
      // finds it unless the TICKER matches. The widget's box is a ticker
      // picker, and `apps/web`'s richer search stays available behind Clerk.
      //
      // `previousSymbols` restores MONEY-1177 — it is INDEXED
      // (`@@index([previousSymbols])`), so a renamed ticker (ZOMATO -> ETERNAL,
      // TATAMOTORS -> TMCV/TMPV) is findable again without a scan.
      // NARROWED TO THE CHOSEN EXCHANGE, which `computeExchangeFilters` does
      // NOT do: it returns `wantsExchangeNseBse` for BOTH "NSE" and "BSE", so
      // it only separates equities from funds. Measured — asking for
      // `exchange=NSE` returned BSE:RELIANCE first. `apps/web` has the same
      // behaviour, so this narrows HERE rather than changing the shared helper
      // and silently altering that surface too.
      const wantedExchange =
        exchangeFilter.toUpperCase() === "NSE" ||
        exchangeFilter.toUpperCase() === "BSE"
          ? exchangeFilter.toUpperCase()
          : null;

      const rows = await prisma.instrumentMapping.findMany({
        where: {
          isActive: true,
          instrumentType: "EQUITY",
          ...(wantedExchange ? { exchange: wantedExchange } : {}),
          OR: [
            { symbol: { startsWith: upperRe } },
            { previousSymbols: { has: upperLiteral } },
          ],
        },
        select,
        orderBy: [{ symbol: "asc" }],
        take: limit,
      });

      for (const r of rows) {
        if (!shouldIncludeEquity(typeFilter, r.instrumentType)) continue;
        out.push({
          symbol: r.symbol,
          full_name: `${r.exchange}:${r.symbol}`,
          description: r.name,
          exchange: r.exchange,
          ticker: `${r.exchange}:${r.symbol}`,
          type: instrumentTypeToTvType(r.instrumentType),
        });
      }
    }

    // FUNDS ARE FOUND BY SCHEME CODE, NOT BY NAME. MONEY-1478 review.
    //
    // The first cut of this leg matched `schemeName: { startsWith, mode:
    // "insensitive" }`, and that was the SAME defect this ticket exists to
    // remove, rebuilt one collection over:
    //
    //   - `MutualFundMaster` has NO index on `schemeName` (measured:
    //     `schemeCode @unique`, then `amcName`, `category`, `isActive`,
    //     `isinGrowth`, `isinDividend` — schema.prisma). So every non-numeric
    //     query was a 14,225-document collection scan plus a blocking
    //     in-memory sort, ANONYMOUSLY, on a service built to take a Mongo read
    //     OFF the chart path. Trading a 24k-row scan for a 14k-row one is not
    //     a fix, and it would have made this commit's own headline false.
    //   - `mode: "insensitive"` cannot take tight prefix bounds anyway —
    //     schema.prisma:1844 records exactly that — so an index would not have
    //     rescued it without a normalised column and a backfill.
    //   - It passed `raw`, UNESCAPED, where the equity leg passes the escaped
    //     needle. `?query=(` sent `$regex: "^("` and Mongo answered error
    //     51111, which the catch below turned into `200 []` — the measured
    //     defect `escapeRegex`'s own docblock exists to prevent, and invisible
    //     to a test asserting only "the body is an array".
    //
    // `schemeCode` IS unique-indexed, so the exact lookup stands. This is the
    // same narrowing the equity side already documents and pays for — the
    // ticker, not the name — applied consistently rather than excepted for
    // funds. Restoring name search needs a normalised, indexed column; it is a
    // schema change, not a query tweak, and it is not smuggled in here.
    if (
      wantsFunds &&
      wantsExchangeMf &&
      out.length < limit &&
      isNumericCode(raw)
    ) {
      const mf = await prisma.mutualFundMaster.findUnique({
        where: { schemeCode: raw },
        select: { schemeCode: true, schemeName: true, amcName: true },
      });
      if (mf) out.push(buildMfResultItem(mf));
    }

    return c.json(out satisfies SearchSymbolResultItem[]);
  } catch (error) {
    // LOGGED, then `[]`. Silent `[]` made an Atlas failover look like "no
    // results" with no error and no non-2xx anywhere.
    console.error(
      `[market-data] /udf/search failed for ${raw}: ${String(error)}`,
    );
    c.header("Cache-Control", CACHE_CONTROL.notImplemented);
    return c.json([] satisfies SearchSymbolResultItem[]);
  }
});

export default symbols;
