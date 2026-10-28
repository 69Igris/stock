/**
 * `/udf/history` — served from D1 tiles. MONEY-1467 (data-platform A2).
 *
 * The whole reason this service exists: on Vercel this endpoint measured p50
 * 0.75s / p95 3.15s doing Clerk auth + Redis + Mongo + a live Yahoo fetch per
 * request. Here it is one object read from the lake, cached at the edge.
 *
 * ## THE READ NEVER LISTS
 *
 * The year tiles a request touches are COMPUTED from its range and `get`
 * individually. `listFiles` fails open to `[]`, so a reader that asked "which
 * years exist" would serve a silently truncated price series on every
 * credentials blip — a chart missing a decade, with no error.
 *
 * ## FAILURE IS NEVER `no_data`
 *
 * `{s:"no_data"}` means "this symbol has no bars in this range", which the
 * widget draws as a blank chart with no message — indistinguishable from a
 * delisted instrument. A tile store that threw must answer `{s:"error"}`, so
 * the widget shows something and the span carries the failure.
 */
import { Hono } from "hono";
import {
  decodeTile,
  tileKey5y,
  tileKeyYear,
  venueYear,
  type TileBar,
  type TileMarket,
} from "@usemoney/core/market-data/tiles/tile-logic";
import { readTile } from "@usemoney/core/market-data/tiles/tile-store";
import {
  barsToUdfOk,
  errorResponse,
  noDataResponse,
  parseHistoryRequest,
  sliceBarsForRequest,
  yearsForRequest,
} from "@usemoney/core/market-data/udf/history-logic";
import { cdnCacheControlForHistory } from "@usemoney/core/market-data/udf/history-cache-logic";
import { prisma } from "@usemoney/database";
import { CACHE_CONTROL } from "../app-logic";
// MONEY-1470 (A5) — the intraday half.
import {
  isIntradayResolution,
  planIntradayRead,
  baseBarsNeeded,
} from "@usemoney/core/market-data/intraday/intraday-request";
import {
  BUCKET_PHASE_SECONDS,
  INTERVAL_MINUTES,
  MixedBasisError,
  bufferCapacity,
  reportedBasis,
  rollUpWithBasis,
  selectBasisPerSession,
} from "@usemoney/core/market-data/intraday/rollup-logic";
import { usMarketDateKey } from "@usemoney/core/market-data/us-market-hours";
import { getMfNavHistory } from "@usemoney/core/market-data/prices/mf-nav-service";
import { navPointsToBars } from "@usemoney/core/market-data/udf/fund-bars";
import { readBars } from "@usemoney/core/market-data/intraday/intraday-store";
import { checkMarketToken } from "../middleware/market-token";
import { tokenMayReadIntraday, tokenMayReadUs } from "../app-logic";
import type { Context } from "hono";

const history = new Hono();

/**
 * `NSE:RELIANCE` -> `{market, listingId}`.
 *
 * The UDF symbol is `{EXCHANGE}:{SYMBOL}` while a tile's listing id is
 * `{SYMBOL}:{EXCHANGE}` — they are REVERSED, and that is the kind of thing
 * that produces a 404 which reads as "no history for this symbol".
 */
export type ResolvedTarget =
  | { kind: "tile"; market: TileMarket; listingId: string }
  | { kind: "fund"; schemeCode: string };

export function resolveListing(symbol: string): ResolvedTarget | null {
  const parts = symbol.split(":");
  if (parts.length === 2) {
    const [exchange, ticker] = parts as [string, string];
    const ex = exchange.toUpperCase();
    if (ex === "NSE" || ex === "BSE") {
      return {
        kind: "tile",
        market: "IN",
        listingId: `${ticker.toUpperCase()}:${ex}`,
      };
    }
    // MONEY-1478 — a mutual fund. It is NOT a TileMarket: funds have no tiles
    // and no exchange, and their series is synthesised from AMFI NAV. Keeping
    // them in the SAME resolver is the point — `/udf/symbols` and
    // `/udf/history` disagreeing about what exists is the defect MONEY-1476
    // was spent closing.
    if (ex === "MF" && ticker !== "") {
      return { kind: "fund", schemeCode: ticker };
    }
    return null;
  }
  // US listing ids already carry their own shape: SYMBOL:EXCHANGE:LISTINGSTART.
  if (parts.length === 3)
    return { kind: "tile", market: "US", listingId: symbol.toUpperCase() };
  return null;
}

/**
 * Is the India session live right now? Only the CDN TTL depends on it.
 *
 * Deliberately coarse — 09:15–15:30 IST on a weekday. A holiday calendar would
 * make the header marginally more accurate and is not worth a database read on
 * a path whose entire purpose is to avoid one; being wrong costs a shorter
 * cache TTL on a holiday, never a wrong price.
 */
export function inIndiaSession(now: Date): boolean {
  const ist = new Date(now.getTime() + 5.5 * 3600 * 1000);
  const day = ist.getUTCDay();
  if (day === 0 || day === 6) return false;
  const minutes = ist.getUTCHours() * 60 + ist.getUTCMinutes();
  return minutes >= 9 * 60 + 15 && minutes <= 15 * 60 + 30;
}

/** The daily resolutions this origin serves. ONE spelling, two callers. */
function isDailyResolution(resolution: string): boolean {
  return resolution === "1D" || resolution === "D";
}

/**
 * Is a mutual-fund NAV about to move? MONEY-1478.
 *
 * NOT `inIndiaSession`. The equity session is 09:15-15:30 IST; the two jobs
 * that write a NAV run at 22:30 (`mf-sync-daily`) and 23:00
 * (`mf-nav-backfill-daily`), both OUTSIDE it. So the session test graded the
 * NAV write window as "closed" and handed it the LONG `s-maxage=3600`, pinning
 * a fund chart at every POP across the exact hour its new NAV lands — the same
 * clock inversion this file documents for US tiles, one asset class over.
 *
 * The window runs to 00:30 IST because the backfill job publishes at 23:00 and
 * its worker is not instantaneous; ending at midnight would reopen the hole for
 * whatever lands after it. EVERY DAY, not weekdays: AMFI publishes on non-
 * trading days too (a Friday NAV is restated on a Saturday), and a weekday test
 * here would pin the weekend to the long TTL.
 */
export function inMfNavWindow(now: Date): boolean {
  const ist = new Date(now.getTime() + 5.5 * 3600 * 1000);
  const minutes = ist.getUTCHours() * 60 + ist.getUTCMinutes();
  return minutes >= 22 * 60 || minutes <= 30;
}

history.get("/history", async (c) => {
  const parsed = parseHistoryRequest({
    symbol: c.req.query("symbol"),
    resolution: c.req.query("resolution"),
    from: c.req.query("from"),
    to: c.req.query("to"),
    countback: c.req.query("countback"),
  });
  if (!parsed.ok) {
    c.header("Cache-Control", CACHE_CONTROL.notImplemented);
    return c.json(parsed.error, 200); // UDF errors are 200 with s:"error"
  }

  const listing = resolveListing(parsed.symbol);
  if (!listing) {
    c.header("Cache-Control", CACHE_CONTROL.notImplemented);
    return c.json(errorResponse(`unrecognised symbol ${parsed.symbol}`), 200);
  }

  // ── THE US LICENCE GATE, ON EVERY RESOLUTION. MONEY-1477. ────────────────
  //
  // This used to live ONLY inside `serveIntraday`, so US DAILY was served to
  // anyone with the URL: `allUsers -> roles/run.invoker` is granted on the LB,
  // there is no Cloud Armor and no IAP, and the daily branch asked for no
  // token at all.
  //
  // Tiingo COMMERCIAL is INTERNAL USE ONLY — ingest and storage are fine,
  // SERVING a US price to a user is redistribution, and the $250/mo
  // redistribution plan (MONEY-1262) is not bought. So an open US daily lane
  // is a licence breach that answers 200.
  //
  // It sits ABOVE the intraday split deliberately: placing it per-branch is
  // exactly how one of the two lanes ended up uncovered, and a gate that has
  // to be repeated is a gate that will be forgotten. India stays PUBLIC on
  // both lanes — it is our own bhavcopy data, and the smoke asserts "daily
  // bars still need no token".
  //
  // The refusal is a 200 `s:"error"`, never a 401: the widget cannot parse a
  // non-200 and renders nothing at all, so a status code here would look like
  // a broken chart rather than a refused one.
  // ── MUTUAL FUNDS: a synthesised series, not a tile. MONEY-1478. ──────────
  //
  // Handled BEFORE the US gate and the resolution split because a fund is
  // neither: it has no exchange, no tile, and no intraday. `apps/web` has
  // served this since long before the cutover, and offering a fund in search
  // that this origin then refuses is the resolve-then-fail defect MONEY-1476
  // was spent closing.
  if (listing.kind === "fund") {
    // A FUND OBEYS THE SAME RESOLUTION RULE AS AN EQUITY. MONEY-1478 review.
    //
    // This branch sat ABOVE the daily check below, so `MF:120503&resolution=5`
    // returned the daily NAV series and the widget drew it as five-minute
    // candles — "a chart ignoring the timeframe button the user just pressed",
    // which is the thing that check exists to prevent. It also skipped
    // `serveIntraday` entirely, so the intraday TOKEN GATE never ran for a
    // fund symbol.
    //
    // A NAV is one number a day: there is no intraday series to serve, so the
    // honest answer is the same named refusal an equity gets, not bars.
    if (!isDailyResolution(parsed.resolution)) {
      c.header("Cache-Control", CACHE_CONTROL.notImplemented);
      return c.json(
        errorResponse(`resolution ${parsed.resolution} is not served`),
        200,
      );
    }
    return serveFundNav(c, parsed, listing.schemeCode);
  }

  if (listing.market === "US") {
    const auth = checkMarketToken(c.req.header("Authorization"));
    if (!auth.ok || !tokenMayReadUs(auth.claims)) {
      c.header("Cache-Control", CACHE_CONTROL.notImplemented);
      console.warn(
        `[market-data] US history refused: ${auth.ok ? "no us claim" : auth.reason}`,
      );
      return c.json(
        errorResponse("US market data is not available on this account"),
        200,
      );
    }
  }

  // MONEY-1470 (A5) — intraday is served from the Redis ring buffer, and it is
  // GATED. Daily bars stay public; intraday does not.
  if (isIntradayResolution(parsed.resolution)) {
    return serveIntraday(c, parsed, listing);
  }

  // Anything else that is not a daily resolution must SAY SO rather than
  // silently return daily bars, which renders as a chart ignoring the timeframe
  // button the user just pressed.
  if (!isDailyResolution(parsed.resolution)) {
    c.header("Cache-Control", CACHE_CONTROL.notImplemented);
    return c.json(
      errorResponse(`resolution ${parsed.resolution} is not served`),
      200,
    );
  }

  try {
    const fiveY = await readTile(tileKey5y(listing.market, listing.listingId));
    if (fiveY.status === "failed") {
      // An OUTAGE, not an absence. See the header.
      c.header("Cache-Control", CACHE_CONTROL.notImplemented);
      return c.json(errorResponse("tile store unavailable"), 200);
    }

    let bars: TileBar[] = [];
    let sources: string[] = [];
    if (fiveY.status === "present") {
      const tile = decodeTile(fiveY.body);
      bars = tile.bars;
      sources = tile.sources;
    }

    // Does the request reach back past the 5y window? Then pull the year tiles
    // it needs — COMPUTED, never listed.
    const earliestHeld = bars.length ? bars[0]![0] : null;
    if (earliestHeld === null || parsed.req.from < earliestHeld) {
      const fromYear = venueYear(parsed.req.from, listing.market);
      const toYear = venueYear(earliestHeld ?? parsed.req.to, listing.market);
      // IN PARALLEL. The keys are COMPUTED, not listed, so there is nothing to
      // discover serially — and `yearsForRequest` allows up to 30, which as a
      // sequential loop is 30 round-trips on the one route whose entire purpose
      // is replacing a p95 of 3.15s.
      const years = yearsForRequest(fromYear, toYear);
      const fetched = await Promise.all(
        years.map((year) =>
          readTile(tileKeyYear(listing.market, listing.listingId, year)),
        ),
      );
      // A failure anywhere is an OUTAGE, and it must not be quietly folded in
      // as a shorter chart.
      if (fetched.some((f) => f.status === "failed")) {
        c.header("Cache-Control", CACHE_CONTROL.notImplemented);
        return c.json(errorResponse("tile store unavailable"), 200);
      }
      for (const got of fetched) {
        if (got.status !== "present") continue;
        const tile = decodeTile(got.body);
        // Concatenated and then sorted+deduped below: the 5y window and a year
        // tile OVERLAP by construction, and a duplicated bar draws a doubled
        // candle.
        bars = [...tile.bars, ...bars];
        sources = [...tile.sources, ...sources];
      }
      // SORT THE PAIR, NOT THE HALVES. Year tiles are prepended in ascending
      // year order, so the merged array is descending BY BLOCK
      // (`[2016…, 2015…, 5y…]`). Sorting `bars` alone and leaving `sources`
      // in merge order re-attributes every bar to some other bar's source —
      // the exact defect `decodeTile`'s parallel-array length check exists to
      // prevent, rebuilt one layer up where no length check can see it,
      // because both arrays stay the right LENGTH.
      //
      // So they travel as one object until the very end.
      const paired = bars.map((b, i) => ({
        bar: b,
        source: sources[i] ?? "UNKNOWN",
      }));
      paired.sort((a, b) => a.bar[0] - b.bar[0]);
      const seen = new Set<number>();
      const keptBars: TileBar[] = [];
      const keptSources: string[] = [];
      for (const { bar, source } of paired) {
        if (seen.has(bar[0])) continue;
        seen.add(bar[0]);
        keptBars.push(bar);
        keptSources.push(source);
      }
      bars = keptBars;
      sources = keptSources;
    }

    const selected = sliceBarsForRequest(bars, parsed.req);
    if (selected.length === 0) {
      // NO CDN HEADER ON A no_data. MONEY-1475.
      //
      // This used to set the shared-cache header ABOVE this branch, so a
      // `no_data` shipped `s-maxage=3600`. Two consequences, both measured:
      //
      //   - a newly-listed symbol whose first tile lands at 21:05 IST answers
      //     blank from every POP until 22:05 + SWR — a blank chart that
      //     outlives the backfill that fixed it.
      //   - a service whose tile store is unconfigured returns `no_data` for
      //     EVERY symbol (`readTile` yields `absent`, not `failed`, so no error
      //     path runs), and that platform-wide blank chart was being pinned at
      //     the edge for an hour.
      //
      // The intraday leg carried the SAME defect and is fixed below; an earlier
      // draft of this comment claimed it "already did this correctly".
      c.header("Cache-Control", CACHE_CONTROL.noData);
      return c.json(
        noDataResponse({
          requestedFrom: parsed.req.from,
          earliestAvailable: bars.length ? bars[0]![0] : null,
          latestAvailable: bars.length ? bars[bars.length - 1]![0] : null,
        }),
        200,
      );
    }

    // CACHEABLE ONLY WHEN THERE ARE BARS.
    //
    // THE SHORT TTL TRACKS WHEN THE TILE IS WRITTEN, NOT WHEN THE MARKET IS
    // OPEN — and getting that backwards is why this is spelled out.
    //
    // An earlier cut of this commit keyed US off `isUsMarketOpen`, reasoning
    // that a "still-forming" bar needs a short TTL. That is false for a DAILY
    // tile: it does not change during the session, it changes when
    // `tile-build-d1-us-daily` writes it — 11:45 IST, after `us-eod-sync` at
    // 11:00. `isUsMarketOpen` is RTH-only, so 11:45 IST (~01:15 ET) graded
    // "closed" and took the LONG TTL: a chart loaded at 11:40 IST would have
    // been pinned at every POP until ~12:45 and never shown the session just
    // written. That is a 60x LONGER blind window than before the change, at
    // exactly the minute the data moves.
    //
    // Both builders run on IST schedules (`setup-scheduler.sh`), so the India
    // session window is the honest proxy for "a tile may land soon" for BOTH
    // markets. Narrowing this properly means keying off the tile's own
    // freshness rather than any clock — noted, not done here.
    // US IS NEVER SHARED-CACHED. MONEY-1478.
    //
    // The licence check above is UNDONE BY A HEADER if this response is
    // `public`. Cloud CDN fronts this origin with `USE_ORIGIN_HEADERS` and no
    // `--cache-key-include-http-header`, so the cache key is scheme + host +
    // path + query and carries nothing about the caller — and the URL an
    // entitled caller used is replayable verbatim by anyone. One founder chart
    // load would publish an hour of Tiingo US OHLC to whoever has the link.
    //
    // India stays on the CDN value: it is our own bhavcopy data and is
    // deliberately public on this lane, which the smoke asserts.
    c.header(
      "Cache-Control",
      listing.market === "US"
        ? CACHE_CONTROL.licensed
        : cdnCacheControlForHistory(inIndiaSession(new Date())),
    );

    const offset = bars.indexOf(selected[0]!);
    return c.json(
      barsToUdfOk(selected, sources.slice(offset, offset + selected.length)),
      200,
    );
  } catch (err) {
    // NEVER throw at the route — rule 4. A 500 here is an infinite spinner.
    c.header("Cache-Control", CACHE_CONTROL.notImplemented);
    return c.json(
      errorResponse(
        err instanceof Error ? err.message : "history is unavailable",
      ),
      200,
    );
  }
});

/**
 * Intraday bars, from the 45-session Redis ring buffer.
 *
 * ## THE BASIS TRAVELS WITH THE ANSWER
 *
 * `X-Bar-Basis` is `trade` or `quote_mid`. It is not decoration: a `quote_mid`
 * series is built from the MID of top-of-book because that feed carries no
 * trades at all, so its `volume` is a structural ZERO meaning "this feed does
 * not report volume" — not "nothing traded". A chart that renders a volume
 * histogram of zeros next to a real one, with nothing to distinguish them, is
 * wrong in a way the numbers cannot reveal. The header is what lets the widget
 * badge it (A5 item 15).
 *
 * ## A MIXED BUFFER IS SERVED, NOT REFUSED
 *
 * A buffer can legitimately hold both bases over time — Databento backfills
 * `trade` for a symbol the Tiingo socket also streams as `quote_mid`. Rolling
 * them up TOGETHER is refused (`MixedBasisError`), because the combined bar's
 * volume would be partly structural and partly real. So one basis is CHOSEN —
 * `trade`, the better measurement, same direction as the price-source authority
 * table — and the other is dropped for this response. Refusing outright would
 * blank a chart that has perfectly good bars in it.
 */
/**
 * A fund's D1 series, synthesised from AMFI NAV. MONEY-1478.
 *
 * A NAV is ONE number per day, so the bar is flat: open = high = low = close.
 * `volume: 0` means "this series HAS no volume", never "nothing traded" — the
 * same rule `TIINGO_RT` bars follow, and the reason a fund's symbol info sets
 * `has_no_volume` so the widget hides the pane rather than drawing a flat zero.
 *
 * PUBLIC, like India daily: AMFI NAV is a public disclosure carrying no vendor
 * redistribution limit, unlike Tiingo's US series.
 */
async function serveFundNav(
  c: Context,
  parsed: { req: { from: number; to: number } },
  schemeCode: string,
): Promise<Response> {
  try {
    // THE SCHEME MUST EXIST BEFORE WE READ NAVs FOR IT. MONEY-1478 review.
    //
    // `getMfNavHistory` enqueues a BACKFILL when a scheme has fewer than two
    // stored rows, and its in-process dedupe is keyed on the scheme code — so
    // `MF:1`, `MF:2`, `MF:3` … each bypass it and publish, from an ANONYMOUS
    // caller on a CDN-fronted origin, and the worker then fetches api.mfapi.in
    // per message. `no-store` on this path means the edge absorbs none of it.
    //
    // `schemeCode` is `@unique`, so this is one indexed lookup and it refuses
    // the whole made-up-code population before any of that. The second half is
    // `MF_NAV_BACKFILL_ON_READ=off` in both cloudbuild specs, which stops a
    // REAL but cold code from enqueuing here too — `apps/web` keeps the
    // on-read backfill, where the caller is Clerk-gated.
    const known = await prisma.mutualFundMaster.findUnique({
      where: { schemeCode },
      select: { schemeCode: true },
    });
    if (!known) {
      c.header("Cache-Control", CACHE_CONTROL.notImplemented);
      return c.json(errorResponse(`unknown mutual fund: ${schemeCode}`), 200);
    }

    const points = await getMfNavHistory(
      schemeCode,
      new Date(parsed.req.from * 1000),
      new Date(parsed.req.to * 1000),
    );

    // GUARD ON THE BARS, NOT THE POINTS. MONEY-1478 review.
    //
    // `navPointsToBars` DROPS a point it cannot turn into a price — AMFI
    // publishes the literal body `None`, and a 0 charted is a cliff to zero
    // that reads as a real crash. So a window can hold points and still yield
    // ZERO bars, and the old `points.length` test let that fall through to
    // `barsToUdfOk([], [])` — an `{s:"ok", t:[]}` served under `public,
    // s-maxage=3600`. An empty OK pinned at the edge for an hour is exactly the
    // MONEY-1475 defect this file spends twenty lines refusing.
    const bars = navPointsToBars(points);

    if (bars.length === 0) {
      // `nextTime` when the fund HAS history outside this window, so the widget
      // knows where to look instead of walking backwards for ever. Probing is
      // cheap and the alternative is an infinite scroll.
      const earlier = await getMfNavHistory(schemeCode);
      c.header("Cache-Control", CACHE_CONTROL.noData);
      if (earlier.length === 0) return c.json({ s: "no_data" }, 200);
      return c.json(
        {
          s: "no_data",
          nextTime: Math.floor(
            new Date(`${earlier[0]!.date}T00:00:00.000Z`).getTime() / 1000,
          ),
        },
        200,
      );
    }

    // A FUND'S FRESHNESS WINDOW IS THE NAV WRITE, NOT THE INDIA SESSION.
    //
    // `inIndiaSession` is 09:15-15:30 IST. `mf-sync-daily` runs 22:30 IST and
    // `mf-nav-backfill-daily` 23:00 IST — both OUTSIDE it — so a fund chart
    // loaded at 22:45 took the LONG `s-maxage=3600` and was pinned at every POP
    // until ~23:45 plus SWR, across the exact minute the NAV it is missing
    // lands. That is the same clock inversion this file already documents for
    // US tiles, one asset class over.
    //
    // A NAV is ONE number a day, so the short value costs almost nothing: the
    // series only changes once, and being an hour stale on the day's own point
    // is the whole complaint.
    c.header(
      "Cache-Control",
      cdnCacheControlForHistory(inMfNavWindow(new Date())),
    );
    return c.json(
      barsToUdfOk(
        bars,
        bars.map(() => "nav"),
      ),
      200,
    );
  } catch (err) {
    c.header("Cache-Control", CACHE_CONTROL.notImplemented);
    console.error(
      `[market-data] fund nav failed for ${schemeCode}: ${String(err)}`,
    );
    return c.json(errorResponse("fund history is unavailable"), 200);
  }
}

async function serveIntraday(
  c: Context,
  parsed: {
    symbol: string;
    resolution: string;
    req: { from: number; to: number; countback?: number };
  },
  listing: { market: TileMarket; listingId: string },
): Promise<Response> {
  // EVERY path below is inside this try. It used to sit OUTSIDE the route's
  // own try — this function is `return`ed before it — so its `throw err`
  // rethrow escaped to `app.onError` and became a 500 with no Cache-Control,
  // in the file whose header states "NEVER throw at the route — rule 4". A 500
  // is an infinite spinner; the widget does not parse it.
  try {
    // GATED. Daily bars are public and CDN-cached; intraday is per-user.
    const auth = checkMarketToken(c.req.header("Authorization"));
    if (!auth.ok) {
      console.warn(`[market-data] intraday refused: ${auth.reason}`);
      // 200 with s:"error", like every other UDF refusal — the widget does not
      // parse a 401 body, so the chart would spin rather than report.
      c.header("Cache-Control", CACHE_CONTROL.notImplemented);
      return c.json(
        errorResponse("intraday requires a market-data token"),
        200,
      );
    }

    const market = listing.market === "US" ? "US" : "IN";

    // THE US LICENCE, checked BEFORE and SEPARATELY from the plan tier.
    //
    // A US listing's intraday buffer holds Tiingo `quote_mid` bars — the same
    // licensed data as `rt:us:quote:*`. Gating them on the plan claim alone
    // meant that writing `{"tiers":["PRO"]}` into one PlatformConfig row,
    // intended to unlock INDIA intraday, shipped 45 sessions of US OHLC to
    // every PRO subscriber at once, with no deploy and no diff.
    // The US LICENCE is now checked ABOVE the resolution split (MONEY-1477),
    // so this is defence in depth rather than the only gate. Kept because
    // `serveIntraday` is exported and a future caller could reach it directly —
    // removing it would make that caller's US lane open, silently.
    if (market === "US" && !tokenMayReadUs(auth.claims)) {
      c.header("Cache-Control", CACHE_CONTROL.notImplemented);
      return c.json(
        errorResponse("US market data is not available on this account"),
        200,
      );
    }

    // ENTITLEMENT, a separate refusal from authentication. A valid token from a
    // plan without intraday is not an auth failure, and telling the two apart
    // is what stops a support ticket becoming a security investigation.
    // FAIL-CLOSED on an absent claim: tokens minted before A5 carry none.
    if (!tokenMayReadIntraday(auth.claims)) {
      c.header("Cache-Control", CACHE_CONTROL.notImplemented);
      return c.json(
        errorResponse("intraday bars are not included in your plan"),
        200,
      );
    }

    const plan = planIntradayRead(market, parsed.resolution);
    if (!plan.ok) {
      c.header("Cache-Control", CACHE_CONTROL.notImplemented);
      return c.json(errorResponse(plan.reason), 200);
    }

    // How many TARGET bars are wanted. `countback` WINS over `from` — the UDF
    // contract says so, and a reader that honoured `from` returns a different
    // number of bars than the widget asked for and then loops.
    //
    // The fallback divides by the TARGET INTERVAL, not by 60. Dividing by 60
    // counted MINUTES and fed them to `baseBarsNeeded` as a bar count, so
    // `need` always clamped to the whole buffer: every non-countback request
    // read ~43,200 entries and sorted them twice, on the route built to fix a
    // 4-second p95 — and, with no rate limit, a cheap way to stall the shared
    // Redis.
    const windowSeconds = Math.max(0, parsed.req.to - parsed.req.from);
    const want =
      parsed.req.countback ??
      Math.ceil(windowSeconds / (INTERVAL_MINUTES[plan.interval] * 60));
    const need = Math.min(
      baseBarsNeeded(Math.max(1, want), plan.interval, plan.base),
      bufferCapacity(market),
    );

    const read = await readBars(market, listing.listingId, need);
    if (!read.available) {
      // An OUTAGE, not an absence — the distinction this whole file is built on.
      c.header("Cache-Control", CACHE_CONTROL.notImplemented);
      return c.json(errorResponse("intraday buffer unavailable"), 200);
    }
    if (read.dropped > 0) {
      console.warn(
        `[market-data] ${read.dropped} unparseable buffer entries for ${listing.listingId}`,
      );
    }

    // ONE basis PER SESSION, never per response. See `selectBasisPerSession`:
    // choosing once for the whole window let a single Databento `trade` session
    // delete every live `quote_mid` bar from today.
    const selectedBars = selectBasisPerSession(read.bars, (ts) =>
      market === "US"
        ? usMarketDateKey(new Date(ts * 1000))
        : indiaSessionKey(ts),
    );

    const basis = reportedBasis(selectedBars.bars);
    if (selectedBars.bars.length === 0 || basis === null) {
      // `noData`, not the intraday TTL. Same rule as the daily leg: a
      // `no_data` is exactly the state the next tick changes, so caching it —
      // even for 30s in the browser — pins a blank chart past the bar that
      // would fill it.
      c.header("Cache-Control", CACHE_CONTROL.noData);
      // NO `nextTime`: the buffer is a 45-session window with a hard floor, so
      // there is no older bar to point at, and a `nextTime` naming a time with
      // no data is how the widget loops backwards for ever.
      return c.json({ s: "no_data" }, 200);
    }

    let rolled: { bars: TileBar[] };
    try {
      rolled = rollUpWithBasis(
        selectedBars.bars,
        plan.interval,
        plan.base,
        BUCKET_PHASE_SECONDS[market],
      ) as { bars: TileBar[] };
    } catch (err) {
      if (err instanceof MixedBasisError) {
        // Unreachable while `selectBasisPerSession` picks one basis per session
        // and a bucket never spans sessions — so reaching it means one of those
        // two invariants moved. Say so rather than serve a mixture.
        c.header("Cache-Control", CACHE_CONTROL.notImplemented);
        return c.json(errorResponse("intraday basis conflict"), 200);
      }
      throw err;
    }

    c.header("X-Bar-Basis", basis);
    // Whether the window spans BOTH bases — a client that renders one badge for
    // the whole chart needs to know it is only true of the newest session.
    c.header("X-Bar-Basis-Mixed", String(selectedBars.bases.length > 1));
    // The buffer's own floor, so a client can tell "we have no more" from "you
    // asked for the wrong window" without a second request.
    c.header("X-Buffer-Oldest", String(rolled.bars[0]?.[0] ?? ""));

    const selected = sliceBarsForRequest(rolled.bars, parsed.req);
    if (selected.length === 0) {
      // SET HERE, not above this branch — the identical defect the daily leg
      // carried (MONEY-1475). The header used to be set before the check, so a
      // no_data inherited the intraday TTL.
      c.header("Cache-Control", CACHE_CONTROL.noData);
      // `noDataResponse`, not a bare `{s:"no_data"}`: when bars EXIST outside
      // the requested window the widget must be told where to look next, or it
      // walks backwards for ever. The daily branch above already uses it.
      return c.json(
        noDataResponse({
          requestedFrom: parsed.req.from,
          earliestAvailable: rolled.bars[0]?.[0] ?? null,
          latestAvailable: rolled.bars[rolled.bars.length - 1]?.[0] ?? null,
        }),
        200,
      );
    }

    // PRIVATE, and only on the success path. Intraday is plan-gated, so a
    // SHARED cache holding one user's response would hand it to a caller with
    // no token at all — the gate removed by a header. Restored here after the
    // MONEY-1475 move: taking the header off the branch above briefly left this
    // return with NO Cache-Control, which is the one state that lets the CDN
    // decide for itself.
    c.header("Cache-Control", CACHE_CONTROL.intraday);
    return c.json(
      barsToUdfOk(
        selected,
        selected.map(() => basis),
      ),
      200,
    );
  } catch (err) {
    c.header("Cache-Control", CACHE_CONTROL.notImplemented);
    console.error(`[market-data] intraday failed: ${String(err)}`);
    return c.json(errorResponse("intraday is unavailable"), 200);
  }
}

/**
 * The IST calendar date a bar belongs to, as a session key.
 *
 * India's session is 09:15-15:30 IST and never crosses midnight, so the
 * calendar date IS the session — unlike the US, whose post-market runs into the
 * next UTC day and needs `usMarketDateKey`.
 */
function indiaSessionKey(tsSeconds: number): string {
  return new Date((tsSeconds + 5.5 * 3600) * 1000).toISOString().slice(0, 10);
}

export default history;
