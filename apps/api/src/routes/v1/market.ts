/**
 * Market Data Routes (Phase C P3 — MONEY-730)
 *
 * Thin Hono handlers over the @usemoney/core market-data layer (Yahoo-delayed
 * quotes/candles + MFAPI NAV history) and the discover.service indices reader.
 *
 * COMPLIANCE: every INDIA price payload here is Yahoo/MFAPI **delayed** data —
 * NOT a live broker feed (live quotes are the founder-only Zerodha Connect app).
 * Those responses carry an explicit `{ source, delayed: true }` indicator (and
 * each quote object echoes `delayed: true`) so a mobile client can never render
 * one as a real-time tick.
 *
 * `GET /v1/market/us/quotes` IS THE EXCEPTION, and the blanket wording above
 * used to be flatly contradicted 480 lines below by the endpoint's own doc
 * comment. A US quote is served out of OUR OWN realtime Redis keys or the
 * `candles` EOD close standing in for one, so `delayed` is DERIVED — per quote,
 * and pessimistically for the envelope — through `isLiveQuoteProvenance`, the
 * one predicate apps/web's disclaimer and response envelope also read. It is
 * still never a live BROKER feed, and it is still explicit in the payload; it is
 * simply not always `true`. Read that handler, not this paragraph, for the US
 * rules.
 *
 * SCOPING: market data is user-agnostic — these endpoints require a Bearer token
 * (the /v1 auth middleware) but pass NO userId to the underlying services/core;
 * the data is global, not per-user.
 *
 * All heavy lifting (batching, retry/backoff, DB caching, NaN-guarding) lives in
 * @usemoney/core + @usemoney/services; the handlers only zod-validate the query,
 * call the fn, and shape the envelope.
 */

import { Hono } from "hono";
import { z } from "zod";
import type { AppContext } from "../../app";
import { success, error, ErrorCodes, zodParse } from "../../lib/response";
import {
  yahooFetchQuotes,
  yahooFetchChart,
  getMfNavHistory,
} from "@usemoney/core/market-data";
// Pure (no-I/O) market-phase detector — imported from its own subpath so it is
// never part of the network fetch surface (and needs no stub in contract tests).
import { getNseMarketStatus } from "@usemoney/core/market-data/market-hours";
// US quote read path — Redis realtime keys + the `candles` EOD close. NOT a
// Tiingo client; see the /us/quotes handler.
import { resolveUsQuotes } from "@usemoney/core/market-data/tiingo/tiingo-rt-read";
import { mayServeUsMarket } from "../../lib/us-access";
import {
  batchQuoteSource,
  isLiveQuoteProvenance,
  normalizeUsExchange,
} from "@usemoney/core/market-data/tiingo/tiingo-rt-read-logic";
import { usMarketSession } from "@usemoney/core/market-data/us-market-hours";
import {
  getIndices,
  getFundComposition,
  getSparklines,
} from "@usemoney/services";

const marketRoutes = new Hono<AppContext>();

// ── Input bounds (a mobile client must not trigger an unbounded upstream fan-out)
const MAX_SYMBOLS = 50;
const MAX_SYMBOL_LEN = 24;
const MAX_SCHEME_LEN = 12;

/** Neutralise a stored/upstream NaN/±Infinity to `null` (never leak "₹NaN"). */
function num(value: number | null | undefined): number | null {
  return value != null && Number.isFinite(value) ? value : null;
}

// A bounded list of Yahoo symbols (e.g. `RELIANCE.NS`, `^NSEI`), split from the
// `?symbols=A,B,C` query. Empty or >MAX_SYMBOLS → validation failure → 400.
const SymbolsSchema = z
  .array(z.string().min(1).max(MAX_SYMBOL_LEN))
  .min(1)
  .max(MAX_SYMBOLS);

const HistoricalQuerySchema = z.object({
  symbol: z.string().min(1).max(MAX_SYMBOL_LEN),
  range: z.enum(["1d", "5d", "1mo", "3mo", "6mo", "1y", "2y", "5y", "max"]),
});

// Sparkline lookback window (P4d) — the service's SparklineWindow union.
const SparklineWindowSchema = z.enum(["1D", "1W", "1M"]);
// Sparkline `?exchange=` is a STRICT enum (unlike /quotes' lenient
// resolveExchange): the service caches per `${symbol}|${exchange}` key, so a
// free-form exchange would mint unbounded cache-key cardinality. Unknown → 400.
const SparklineExchangeSchema = z.enum(["NSE", "BSE"]);

const MfNavQuerySchema = z.object({
  schemeCode: z
    .string()
    .min(1)
    .max(MAX_SCHEME_LEN)
    .regex(/^\d+$/, "schemeCode must be numeric"),
});

// fundId is a schemeCode for MF and a symbol for ETF/INDEX — bounded either way.
const MAX_FUND_ID_LEN = 64;

const FundCompositionQuerySchema = z.object({
  fundType: z.enum(["MF", "ETF", "INDEX"]),
  fundId: z.string().min(1).max(MAX_FUND_ID_LEN),
});

/** Range → lookback window + Yahoo candle interval (request-layer mapping). */
const RANGE_WINDOWS: Record<string, { days: number; interval: string }> = {
  "1d": { days: 1, interval: "5m" },
  "5d": { days: 5, interval: "15m" },
  "1mo": { days: 31, interval: "1d" },
  "3mo": { days: 93, interval: "1d" },
  "6mo": { days: 186, interval: "1d" },
  "1y": { days: 366, interval: "1d" },
  "2y": { days: 731, interval: "1wk" },
  "5y": { days: 1827, interval: "1wk" },
  max: { days: 7305, interval: "1mo" },
};

const DAY_MS = 24 * 60 * 60 * 1000;

// ═══════════════════════════════════════════════════════════════════════════
// Additive parity helpers (MONEY-1062 P3b — D3 / D5 / D6)
//
// These mirror the web market routes so a mobile client gets the SAME optional
// query surface. The web helpers they port are either web-local AND Prisma-
// importing (`toYahooSymbol` in apps/web/lib/market/symbol-mapper.ts) or a
// route-inline private fn — neither is importable from apps/api — so the MINIMAL
// PURE mapping is ported here VERBATIM with a source citation. Behaviour is
// purely additive: every pre-existing request shape is preserved byte-for-byte.
// ═══════════════════════════════════════════════════════════════════════════

// ── D3: symbol → Yahoo mapping (port of apps/web/lib/market/symbol-mapper.ts) ─
// The web quote route accepts an unsuffixed symbol + `?exchange=` and maps it
// server-side via `toYahooSymbol` (apps/web/lib/market/symbol-mapper.ts:174).
// That helper is web-local and DB-backed (imports Prisma), so the synchronous
// pure fallback (index table + suffix/^ pass-through + NSE/BSE suffix) is ported
// below. PRECEDENCE: a symbol already carrying a `.NS`/`.BO` suffix or a leading
// `^` (index) passes through UNTOUCHED, so `?symbols=RELIANCE.NS` is unchanged.
type Exchange = "NSE" | "BSE";

// Verbatim from apps/web/lib/market/symbol-mapper.ts (INDEX_MAPPINGS).
const INDEX_MAPPINGS: Record<string, string> = {
  // NSE Indices
  "NIFTY 50": "^NSEI",
  NIFTY50: "^NSEI",
  NIFTY: "^NSEI",
  "NIFTY BANK": "^NSEBANK",
  BANKNIFTY: "^NSEBANK",
  "NIFTY IT": "^CNXIT",
  NIFTYIT: "^CNXIT",
  "NIFTY MIDCAP 100": "^CNXMDCP",
  "NIFTY NEXT 50": "^NSMIDCP",
  "NIFTY PHARMA": "^CNXPHARMA",
  "NIFTY AUTO": "^CNXAUTO",
  "NIFTY FMCG": "^CNXFMCG",
  "NIFTY METAL": "^CNXMETAL",
  "NIFTY REALTY": "^CNXREALTY",
  "NIFTY ENERGY": "^CNXENERGY",
  "NIFTY INFRA": "^CNXINFRA",
  "NIFTY PRIVATE BANK": "^CNXPSUBANK",
  "NIFTY PSU BANK": "^NIFTYPSUBNK",
  "NIFTY FIN SERVICE": "^CNXFIN",
  "NIFTY MEDIA": "^CNXMEDIA",
  "INDIA VIX": "^INDIAVIX",
  // BSE Indices
  SENSEX: "^BSESN",
  "BSE SENSEX": "^BSESN",
  "BSE 100": "^BSE100",
  "BSE 200": "^BSE200",
  "BSE 500": "^BSE500",
  "BSE MIDCAP": "^BSEMCAP",
  "BSE SMALLCAP": "^BSESMLCAP",
  "BSE BANKEX": "^BSEBANKEX",
};

/**
 * Port of apps/web/lib/market/symbol-mapper.ts#toYahooSymbol (the synchronous
 * pure fallback; the DB-backed async variant is deliberately NOT ported). An
 * index name → `^SYMBOL`; an already-suffixed / `^`-prefixed symbol is returned
 * UNTOUCHED; otherwise UPPERCASE + `.NS` (NSE) / `.BO` (BSE).
 */
function toYahooSymbol(symbol: string, exchange: Exchange = "NSE"): string {
  const upperSymbol = symbol.toUpperCase().trim();
  const indexMatch = INDEX_MAPPINGS[upperSymbol];
  if (indexMatch) return indexMatch;
  if (
    symbol.endsWith(".NS") ||
    symbol.endsWith(".BO") ||
    symbol.startsWith("^")
  ) {
    return symbol;
  }
  const suffix = exchange === "BSE" ? ".BO" : ".NS";
  return `${upperSymbol}${suffix}`;
}

/**
 * Resolve the optional `?exchange=` param → NSE default. Mirrors the web quote
 * route's `resolveExchange` (apps/web/app/api/market/quote/quote-logic.ts:67):
 * a lenient cast — only `BSE` selects `.BO`; anything else maps to `.NS`.
 */
function resolveExchange(exchange: string | undefined): Exchange {
  return (exchange || "NSE") as Exchange;
}

// ── D5: MF-NAV period windows (port of apps/web app/api/market/mf-historical) ─
// The web MF-historical route (apps/web/app/api/market/mf-historical/route.ts)
// windows the NAV history via `?period=` (VALID_PERIODS + getStartDateFromPeriod).
// Ported so `/v1/market/mf-nav` gains the SAME optional window. ABSENT `?period=`
// keeps the current full-history behaviour (getMfNavHistory with no startDate).
const MF_NAV_PERIODS = [
  "1m",
  "3m",
  "6m",
  "1y",
  "2y",
  "3y",
  "5y",
  "max",
] as const;
const MfNavPeriodSchema = z.enum(MF_NAV_PERIODS);
type MfNavPeriod = (typeof MF_NAV_PERIODS)[number];

/** Verbatim window math from mf-historical/route.ts#getStartDateFromPeriod. */
function mfNavStartDate(period: MfNavPeriod): Date {
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
  // Unreachable for a schema-validated period; full history on any fall-through.
  return new Date(0);
}

// ── D6: historical period/interval (port of apps/web/lib/market/historical-fetcher) ─
// The web historical route supports independent period + interval + custom
// startDate/endDate (apps/web/app/api/market/historical/route.ts +
// lib/market/historical-fetcher.ts). Ported so `/v1/market/historical` gains the
// SAME optional params ADDITIVELY — the pre-existing `?range=` path is untouched.
const HIST_PERIODS = [
  "1d",
  "5d",
  "1mo",
  "3mo",
  "6mo",
  "1y",
  "2y",
  "5y",
  "10y",
  "ytd",
  "max",
] as const;
const HIST_INTERVALS = [
  "1m",
  "5m",
  "15m",
  "30m",
  "60m",
  "1h",
  "1d",
  "5d",
  "1wk",
  "1mo",
  "3mo",
] as const;
// Intraday intervals (excludes 1h) and the periods Yahoo can serve them with —
// the "bad combo → 400" guard mirrors fetchHistoricalBars' intraday gate.
const HIST_INTRADAY_INTERVALS = ["1m", "5m", "15m", "30m", "60m"];
const HIST_INTRADAY_PERIODS = ["1d", "5d", "1mo"];
const HistPeriodSchema = z.enum(HIST_PERIODS);
const HistIntervalSchema = z.enum(HIST_INTERVALS);
const HistSymbolSchema = z.object({
  symbol: z.string().min(1).max(MAX_SYMBOL_LEN),
});

/**
 * Verbatim port of historical-fetcher.ts#startOfLocalDay: a new Date at
 * 00:00:00 local-time of the same calendar day. Used to snap a custom
 * intraday `startDate` DOWN to a whole-day lower bound (see the
 * forward-anchor note on /historical).
 */
function startOfLocalDay(date: Date): Date {
  const d = new Date(date);
  d.setHours(0, 0, 0, 0);
  return d;
}

/** Verbatim window math from historical-fetcher.ts#getPeriodStartDate. */
function periodStartDate(period: string): Date {
  const now = new Date();
  const start = new Date(now);
  switch (period) {
    case "1d":
      start.setDate(now.getDate() - 1);
      break;
    case "5d":
      start.setDate(now.getDate() - 5);
      break;
    case "1mo":
      start.setMonth(now.getMonth() - 1);
      break;
    case "3mo":
      start.setMonth(now.getMonth() - 3);
      break;
    case "6mo":
      start.setMonth(now.getMonth() - 6);
      break;
    case "1y":
      start.setFullYear(now.getFullYear() - 1);
      break;
    case "2y":
      start.setFullYear(now.getFullYear() - 2);
      break;
    case "5y":
      start.setFullYear(now.getFullYear() - 5);
      break;
    case "10y":
      start.setFullYear(now.getFullYear() - 10);
      break;
    case "ytd":
      start.setMonth(0, 1);
      break;
    case "max":
      start.setFullYear(1970);
      break;
    default:
      start.setMonth(now.getMonth() - 1);
  }
  return start;
}

/** Serialize core `ChartBar`s to the finite-guarded wire shape (both paths). */
function serializeBars(
  bars: Array<{
    date: Date;
    open: number;
    high: number;
    low: number;
    close: number;
    volume: number;
  }>,
): Array<{
  date: string;
  open: number | null;
  high: number | null;
  low: number | null;
  close: number | null;
  volume: number | null;
}> {
  return bars.map((b) => ({
    date: b.date.toISOString(),
    open: num(b.open),
    high: num(b.high),
    low: num(b.low),
    close: num(b.close),
    volume: num(b.volume),
  }));
}

/**
 * GET /v1/market/quotes?symbols=A,B,C&exchange=NSE|BSE
 * Batch DELAYED quotes (Yahoo). Symbols are capped at MAX_SYMBOLS to bound the
 * upstream fan-out. Global (no userId).
 *
 * D3 SYMBOL CONTRACT (deliberate, matches the web quote route):
 *   - An UNSUFFIXED symbol resolves via `?exchange=` — default NSE → `.NS`,
 *     `?exchange=BSE` → `.BO`. The resolve is lenient like the web's
 *     (`resolveExchange`): any value other than `BSE` means NSE.
 *   - A symbol already carrying a `.NS`/`.BO` suffix, or a `^`-prefixed index,
 *     passes through UNTOUCHED (byte-identical to the pre-D3 behaviour).
 *   - FOREIGN tickers (e.g. `AAPL`, `MSFT`) MUST arrive already carrying their
 *     native Yahoo symbol — an unsuffixed foreign ticker is treated as Indian
 *     and suffixed `.NS`/`.BO`, so it will simply land in `missing`. This
 *     endpoint is INDIA-ONLY and stays that way: US quotes have their own
 *     route, `/v1/market/us/quotes` (MONEY-1309), because they come from a
 *     different store, carry per-quote provenance, and are NOT unconditionally
 *     delayed. Widening this one would have meant one handler with two
 *     incompatible `delayed` contracts.
 *   - `quotes[].symbol` echoes the MAPPED Yahoo symbol (it comes from the
 *     quote object); `missing[]` echoes the client's ORIGINAL symbols.
 */
marketRoutes.get("/quotes", async (c) => {
  try {
    const symbols = (c.req.query("symbols") ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    const parsed = zodParse(SymbolsSchema, symbols);
    if (!parsed.ok) {
      return c.json(
        error(ErrorCodes.VALIDATION_ERROR, "Invalid symbols", parsed.issues),
        400,
      );
    }

    // D3: map each unsuffixed symbol to the Yahoo convention via `?exchange=`
    // (default NSE), mirroring the web quote route. A symbol already carrying a
    // `.NS`/`.BO` suffix or a `^` index prefix passes through UNTOUCHED — so a
    // pre-existing `?symbols=RELIANCE.NS` request is byte-identical (identity
    // map). The LOOKUP runs against the mapped (Yahoo) symbols so the fetched
    // map keys line up; `missing` echoes the ORIGINALS (below).
    const exchange = resolveExchange(c.req.query("exchange"));
    const yahooSymbols = parsed.data.map((s) => toYahooSymbol(s, exchange));

    const quoteMap = await yahooFetchQuotes(yahooSymbols);
    const quotes = yahooSymbols
      .map((symbol) => quoteMap.get(symbol))
      .filter((q): q is NonNullable<typeof q> => q != null)
      .map((q) => ({
        symbol: q.symbol,
        name: q.shortName ?? q.longName ?? q.symbol,
        price: num(q.regularMarketPrice),
        change: num(q.regularMarketChange),
        changePercent: num(q.regularMarketChangePercent),
        previousClose: num(q.regularMarketPreviousClose),
        open: num(q.regularMarketOpen),
        dayHigh: num(q.regularMarketDayHigh),
        dayLow: num(q.regularMarketDayLow),
        volume: num(q.regularMarketVolume),
        marketCap: num(q.marketCap),
        exchange: q.exchange ?? null,
        asOf: q.regularMarketTime
          ? new Date(q.regularMarketTime * 1000).toISOString()
          : null,
        delayed: true as const,
      }));

    // `missing` echoes the client's ORIGINAL symbols, not the mapped Yahoo
    // keys — the caller sent `RELIANCE`, so a miss must say `RELIANCE`, not
    // `RELIANCE.NS` (which it never sent and can't correlate). The
    // mapped→original correspondence is positional: yahooSymbols[i] is the
    // mapping of parsed.data[i], so an index filter IS the reverse map (and,
    // unlike a Map keyed by the mapped symbol, survives two originals mapping
    // to the same Yahoo key).
    const missing = parsed.data.filter(
      (_, i) => !quoteMap.has(yahooSymbols[i]!),
    );
    const market = getNseMarketStatus();
    return c.json(
      success({
        quotes,
        missing,
        source: "yahoo",
        delayed: true,
        market: { phase: market.phase, isLive: market.isLive },
      }),
    );
  } catch (err) {
    console.error("Market quotes error:", err);
    return c.json(
      error(ErrorCodes.INTERNAL_ERROR, "Failed to fetch quotes"),
      500,
    );
  }
});

/**
 * GET /v1/market/us/quotes?symbols=AAPL,MSFT&exchange=NASDAQ
 *
 * US quotes — parity with the web app's `/api/market/quote?exchange=NASDAQ`
 * (MONEY-1309). Global (no userId), same Bearer-token middleware as the rest of
 * this file.
 *
 * ## It reads OUR OWN stores and never the vendor
 *
 * `resolveUsQuotes` serves from the realtime Redis keys the socket holder writes
 * with the `candles` EOD close behind them. Nothing here can reach
 * `api.tiingo.com`: Tiingo is a paid, metered, internal-use-only feed whose
 * client paces at 180 ms/request, and a mobile client polling a quote endpoint
 * must not be able to spend that quota. Same guarantee, same module, as the web
 * route — one implementation, two callers, which is the point of putting it in
 * core.
 *
 * ## `delayed` is per-quote here, unlike /quotes
 *
 * Every other price payload in this file is unconditionally `delayed: true`
 * because every one of them is Yahoo. A US quote is one of two things — a
 * streaming quote, or the previous close standing in for one — so each quote
 * carries its own `provenance { source, asOf, fallback }` and the envelope's
 * `delayed` is the PESSIMISTIC batch answer: live only when every quote is.
 * A mobile client that renders `delayed:false` as a live tick is then correct
 * for the whole payload rather than for its freshest member.
 */
marketRoutes.get("/us/quotes", async (c) => {
  try {
    const symbols = (c.req.query("symbols") ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    const parsed = zodParse(SymbolsSchema, symbols);
    if (!parsed.ok) {
      return c.json(
        error(ErrorCodes.VALIDATION_ERROR, "Invalid symbols", parsed.issues),
        400,
      );
    }

    // STRICT, unlike `/quotes`' lenient any-value-means-NSE resolve. A venue is
    // the thing that decides which market answers, so an unrecognised one must
    // be a 400 rather than a silent default that returns the wrong market's
    // prices (or, worse, an empty list that reads as "no data").
    //
    // `?exchange=` with an EMPTY value is ABSENT, not unrecognised. `??` is
    // nullish, so `""` slipped past the default into `normalizeUsExchange` and
    // 400'd — while the web route's `resolveQuoteExchange("")` treats the same
    // request as "no venue named" and answers 200. Two clients, one query
    // string, opposite outcomes. Strictness is about an UNKNOWN venue; an
    // omitted one is the documented NASDAQ default in both spellings.
    const rawVenue = (c.req.query("exchange") ?? "").trim();
    const venue = normalizeUsExchange(rawVenue === "" ? "NASDAQ" : rawVenue);
    if (venue === null) {
      return c.json(
        error(
          ErrorCodes.VALIDATION_ERROR,
          "exchange must be a US venue (NASDAQ, NYSE, AMEX, NYSE ARCA, NYSE MKT, NYSE NAT, BATS, NMFQS)",
        ),
        400,
      );
    }

    // LICENCE GATE. Tiingo COMMERCIAL is internal-use-only: ingest is
    // permitted, serving US prices to a client is redistribution and needs
    // MONEY-1262. This is the MOBILE endpoint and was behind nothing — the
    // widest of the three US surfaces, reachable by any client holding a valid
    // Bearer token with no page in the way.
    //
    // Refusal yields an EMPTY resolved set rather than an early return with a
    // hand-built envelope. Everything below is then unchanged: `missing` fills
    // with every requested symbol on its own, and there is no second response
    // shape to keep in step with this one. It is also the shape this handler
    // already produces for a symbol the feed has no data for — so an
    // unauthorised caller learns nothing, where a 403 would confirm the data
    // exists and would need its own client branch.
    const mayServe = await mayServeUsMarket(c.get("userId"));
    const { quotes: resolved } = mayServe
      ? await resolveUsQuotes(parsed.data, venue)
      : { quotes: new Map<string, never>() };

    const quotes = parsed.data
      .map((s) => resolved.get(s.trim().toUpperCase()))
      .filter((q): q is NonNullable<typeof q> => q != null)
      .map((q) => ({
        symbol: q.symbol,
        name: q.name,
        price: num(q.price),
        change: num(q.change),
        changePercent: num(q.changePercent),
        previousClose: num(q.previousClose),
        open: num(q.open),
        dayHigh: num(q.high),
        dayLow: num(q.low),
        volume: num(q.volume),
        exchange: q.exchange,
        currency: "USD" as const,
        asOf: q.provenance.asOf,
        provenance: q.provenance,
        // ONE predicate, not a hand-written condition. This read
        // `q.provenance.fallback || q.provenance.source !== "TIINGO_RT"` — the
        // correct rule, spelled out a third time. The apps/web disclaimer wrote
        // it a fourth time and DROPPED the `fallback` operand, which put a green
        // "Live quote" badge over a fallback price. Deleting an operand from a
        // function call is not possible; deleting one from a `||` is one
        // keystroke and, in this file's fixtures, invisible.
        delayed: !isLiveQuoteProvenance(q.provenance),
      }));

    const missing = parsed.data.filter(
      (s) => !resolved.has(s.trim().toUpperCase()),
    );
    const source = batchQuoteSource(quotes);
    const session = usMarketSession(new Date());

    return c.json(
      success({
        quotes,
        missing,
        source,
        delayed: !isLiveQuoteProvenance({ source }),
        market: { session, isLive: session === "rth" },
      }),
    );
  } catch (err) {
    console.error("US market quotes error:", err);
    return c.json(
      error(ErrorCodes.INTERNAL_ERROR, "Failed to fetch US quotes"),
      500,
    );
  }
});

/**
 * GET /v1/market/historical?symbol=&range=
 * GET /v1/market/historical?symbol=&period=&interval=&startDate=&endDate=
 * DELAYED OHLC candles (Yahoo `fetchChart`). Global (no userId).
 *
 * TWO request modes (D6 — additive):
 *   1. `?range=` (pre-existing, UNCHANGED): a bounded lookback window + a fixed
 *      candle interval (RANGE_WINDOWS). When `range` is present it wins and the
 *      new params are ignored — byte-identical to the original behaviour.
 *   2. `?period=&interval=&startDate=&endDate=` (web parity): independent period
 *      (default `1mo`) + interval (default `1d`), or a custom [startDate,endDate]
 *      that takes precedence over `period`. Bad params/combos → 400 mirroring the
 *      web guards (invalid period/interval, un-parseable dates, start>end, and an
 *      intraday interval paired with a too-long period).
 *
 *      SYMBOL MAPPING (C3#2): mode 2 applies the SAME D3 mapping as /quotes —
 *      an unsuffixed symbol resolves via `?exchange=` (default NSE → `.NS`,
 *      BSE → `.BO`; suffixed/`^` symbols pass through untouched), so
 *      `?symbol=RELIANCE&period=1y` returns bars instead of a silent Yahoo
 *      miss. The response `symbol` echoes the client's ORIGINAL value. Mode 1
 *      (`?range=`) deliberately stays raw-symbol — its pre-D6 byte-identical
 *      contract requires an already-Yahoo symbol.
 *
 *      INTRADAY + CUSTOM DATES (C3#7): Yahoo's chart endpoint returns EMPTY
 *      for intraday intervals when `period2` is significantly in the past
 *      (the forward-anchor quirk — apps/web/lib/market/
 *      historical-fetcher.ts:286-341). Mirroring the web fetcher, a custom
 *      [startDate,endDate] with an intraday interval is normalised to
 *      period1 = start-of-local-day(startDate), period2 = NOW — over-fetching
 *      forward so historical intraday windows actually return bars (the
 *      client clips to its own window; Yahoo intraday retention still
 *      bounds how far back data exists). Non-intraday custom dates are
 *      passed through unchanged.
 */
marketRoutes.get("/historical", async (c) => {
  try {
    const rangeRaw = c.req.query("range");

    // ── Mode 1: pre-existing `?range=` path — BYTE-IDENTICAL. Present `range`
    // wins; the new period/interval/date params are ignored so any existing
    // caller (range was previously REQUIRED) is completely unchanged.
    if (rangeRaw !== undefined) {
      const parsed = zodParse(HistoricalQuerySchema, {
        symbol: c.req.query("symbol"),
        range: rangeRaw,
      });
      if (!parsed.ok) {
        return c.json(
          error(
            ErrorCodes.VALIDATION_ERROR,
            "Invalid historical query",
            parsed.issues,
          ),
          400,
        );
      }

      const { symbol, range } = parsed.data;
      const window = RANGE_WINDOWS[range]!;
      const period2 = new Date();
      const period1 = new Date(period2.getTime() - window.days * DAY_MS);
      const bars = await yahooFetchChart(symbol, {
        period1,
        period2,
        interval: window.interval,
      });

      return c.json(
        success({
          symbol,
          range,
          interval: window.interval,
          bars: serializeBars(bars),
          source: "yahoo",
          delayed: true,
        }),
      );
    }

    // ── Mode 2: D6 additive path — independent period + interval + custom dates.
    // Symbol is required (400 else); period defaults `1mo`, interval `1d` (web
    // defaults). A custom [startDate,endDate] takes precedence over `period`.
    const symbolParsed = zodParse(HistSymbolSchema, {
      symbol: c.req.query("symbol"),
    });
    if (!symbolParsed.ok) {
      return c.json(
        error(
          ErrorCodes.VALIDATION_ERROR,
          "Invalid historical query",
          symbolParsed.issues,
        ),
        400,
      );
    }
    const { symbol } = symbolParsed.data;

    const intervalParsed = zodParse(
      HistIntervalSchema,
      c.req.query("interval") ?? "1d",
    );
    if (!intervalParsed.ok) {
      return c.json(
        error(
          ErrorCodes.VALIDATION_ERROR,
          `Invalid interval. Valid intervals: ${HIST_INTERVALS.join(", ")}`,
        ),
        400,
      );
    }
    const interval = intervalParsed.data;

    const periodParsed = zodParse(
      HistPeriodSchema,
      c.req.query("period") ?? "1mo",
    );
    if (!periodParsed.ok) {
      return c.json(
        error(
          ErrorCodes.VALIDATION_ERROR,
          `Invalid period. Valid periods: ${HIST_PERIODS.join(", ")}`,
        ),
        400,
      );
    }
    const period = periodParsed.data;

    const startStr = c.req.query("startDate");
    const endStr = c.req.query("endDate");

    let period1: Date;
    let period2: Date;
    let periodEcho: string;

    if (startStr && endStr) {
      // Custom range wins over `period` (mirrors the web route/fetcher).
      const start = new Date(startStr);
      const end = new Date(endStr);
      if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) {
        return c.json(
          error(
            ErrorCodes.VALIDATION_ERROR,
            "Invalid date format. Use YYYY-MM-DD",
          ),
          400,
        );
      }
      if (start > end) {
        return c.json(
          error(
            ErrorCodes.VALIDATION_ERROR,
            "startDate must be before endDate",
          ),
          400,
        );
      }
      if (HIST_INTRADAY_INTERVALS.includes(interval)) {
        // Forward-anchor normalisation (web parity — historical-fetcher.ts
        // :322-327): whole-day lower bound + period2 = NOW, else Yahoo
        // returns empty for a fully-past intraday window.
        period1 = startOfLocalDay(start);
        period2 = new Date();
      } else {
        period1 = start;
        period2 = end;
      }
      periodEcho = "custom";
    } else {
      // Intraday gate: an intraday interval can only be requested with a short
      // period (fetchHistoricalBars' intraday-period check).
      if (
        HIST_INTRADAY_INTERVALS.includes(interval) &&
        !HIST_INTRADAY_PERIODS.includes(period)
      ) {
        return c.json(
          error(
            ErrorCodes.VALIDATION_ERROR,
            `Intraday intervals (${interval}) only support periods: ${HIST_INTRADAY_PERIODS.join(", ")}`,
          ),
          400,
        );
      }
      period1 = periodStartDate(period);
      period2 = new Date();
      periodEcho = period;
    }

    // C3#2: same unsuffixed-symbol → Yahoo mapping as /quotes (?exchange=,
    // default NSE; suffixed/^ pass-through). The envelope echoes the
    // client's ORIGINAL `symbol`; only the upstream call uses the mapped one.
    const yahooSymbol = toYahooSymbol(
      symbol,
      resolveExchange(c.req.query("exchange")),
    );
    const bars = await yahooFetchChart(yahooSymbol, {
      period1,
      period2,
      interval,
    });

    return c.json(
      success({
        symbol,
        period: periodEcho,
        interval,
        bars: serializeBars(bars),
        source: "yahoo",
        delayed: true,
      }),
    );
  } catch (err) {
    console.error("Market historical error:", err);
    return c.json(
      error(ErrorCodes.INTERNAL_ERROR, "Failed to fetch historical data"),
      500,
    );
  }
});

/**
 * GET /v1/market/indices
 * Market indices (NIFTY/SENSEX/…) from the DB-cached LatestQuote via
 * discover.service. Delayed. Global (no userId).
 */
marketRoutes.get("/indices", async (c) => {
  try {
    const result = await getIndices();
    if (!result.success) {
      return c.json(error(ErrorCodes.INTERNAL_ERROR, result.error), 500);
    }
    return c.json(
      success({ indices: result.data, source: "yahoo", delayed: true }),
    );
  } catch (err) {
    console.error("Market indices error:", err);
    return c.json(
      error(ErrorCodes.INTERNAL_ERROR, "Failed to fetch indices"),
      500,
    );
  }
});

/**
 * GET /v1/market/mf-nav?schemeCode=&period=
 * Mutual-fund NAV history (MFAPI.in, DB-cached). EOD data. Global (no userId).
 *
 * `?period=` (D6 — additive, optional) windows the history to the last
 * 1m|3m|6m|1y|2y|3y|5y|max (web MF-historical semantics). ABSENT → the full
 * history (current behaviour, preserved); `max` is likewise the full history.
 */
marketRoutes.get("/mf-nav", async (c) => {
  try {
    const parsed = zodParse(MfNavQuerySchema, {
      schemeCode: c.req.query("schemeCode"),
    });
    if (!parsed.ok) {
      return c.json(
        error(ErrorCodes.VALIDATION_ERROR, "Invalid schemeCode", parsed.issues),
        400,
      );
    }

    // D5: optional period window. Absent → undefined startDate → getMfNavHistory
    // returns the full history (identical to the previous single-arg call).
    const rawPeriod = c.req.query("period");
    let startDate: Date | undefined;
    if (rawPeriod !== undefined && rawPeriod !== "") {
      const periodParsed = zodParse(MfNavPeriodSchema, rawPeriod);
      if (!periodParsed.ok) {
        return c.json(
          error(
            ErrorCodes.VALIDATION_ERROR,
            `Invalid period. Valid periods: ${MF_NAV_PERIODS.join(", ")}`,
          ),
          400,
        );
      }
      startDate = mfNavStartDate(periodParsed.data);
    }

    const history = await getMfNavHistory(parsed.data.schemeCode, startDate);
    return c.json(
      success({
        schemeCode: parsed.data.schemeCode,
        history,
        source: "mfapi.in",
        delayed: true,
      }),
    );
  } catch (err) {
    console.error("Market MF NAV error:", err);
    return c.json(
      error(ErrorCodes.INTERNAL_ERROR, "Failed to fetch NAV history"),
      500,
    );
  }
});

/**
 * GET /v1/market/sparklines?symbols=A,B,C&window=1D&exchange=NSE
 * Batch close-price sparklines (Yahoo, service-cached). Mirrors
 * getSparklinesAction (apps/web/lib/actions/sparklines.ts:25) → the EXISTING
 * packages/services/src/sparkline.service.ts#getSparklines — symbols become
 * `{ symbol, exchange }` pairs (one `?exchange=` for the batch, default NSE,
 * STRICT NSE|BSE enum → 400 on anything else — the exchange feeds the
 * service's cache key, so it must not be free-form), `?window=` ∈ 1D|1W|1M
 * (web default 1D).
 * Symbols capped at MAX_SYMBOLS (50, tighter than the service's own 100 bound).
 * Missing symbols map to empty `closes` (service contract). Delayed. Global.
 */
marketRoutes.get("/sparklines", async (c) => {
  try {
    const symbols = (c.req.query("symbols") ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    const parsed = zodParse(SymbolsSchema, symbols);
    if (!parsed.ok) {
      return c.json(
        error(ErrorCodes.VALIDATION_ERROR, "Invalid symbols", parsed.issues),
        400,
      );
    }

    const windowParsed = zodParse(
      SparklineWindowSchema,
      c.req.query("window") ?? "1D",
    );
    if (!windowParsed.ok) {
      return c.json(
        error(
          ErrorCodes.VALIDATION_ERROR,
          "Invalid window. Valid windows: 1D, 1W, 1M",
        ),
        400,
      );
    }
    const window = windowParsed.data;

    // Strict enum (400) — see SparklineExchangeSchema (cache-key cardinality).
    const exchangeParsed = zodParse(
      SparklineExchangeSchema,
      c.req.query("exchange") ?? "NSE",
    );
    if (!exchangeParsed.ok) {
      return c.json(
        error(
          ErrorCodes.VALIDATION_ERROR,
          "Invalid exchange. Valid exchanges: NSE, BSE",
        ),
        400,
      );
    }
    const exchange = exchangeParsed.data;
    const pairs = parsed.data.map((symbol) => ({ symbol, exchange }));

    const result = await getSparklines(pairs, window);
    if (!result.success) {
      return c.json(error(ErrorCodes.INTERNAL_ERROR, result.error), 500);
    }

    return c.json(
      success({
        sparklines: result.data,
        window,
        source: "yahoo",
        delayed: true,
      }),
    );
  } catch (err) {
    console.error("Market sparklines error:", err);
    return c.json(
      error(ErrorCodes.INTERNAL_ERROR, "Failed to fetch sparklines"),
      500,
    );
  }
});

/**
 * GET /v1/market/fund-composition?fundType=MF&fundId=119551
 * AI-extracted fund portfolio composition — READ path only (DB/cache via
 * getFundComposition; the Gemini extraction TRIGGER is deliberately not
 * surfaced here — a later wave). Mirrors the web
 * GET /api/market/fund-composition (apps/web app/api/market/fund-composition/
 * route.ts): missing/invalid params → 400, not-yet-extracted → 404, else the
 * finite-guarded composition. Global (no userId).
 */
marketRoutes.get("/fund-composition", async (c) => {
  try {
    const parsed = zodParse(FundCompositionQuerySchema, {
      fundType: c.req.query("fundType"),
      fundId: c.req.query("fundId"),
    });
    if (!parsed.ok) {
      return c.json(
        error(
          ErrorCodes.VALIDATION_ERROR,
          "Invalid fund-composition query",
          parsed.issues,
        ),
        400,
      );
    }

    const { fundType, fundId } = parsed.data;
    const result = await getFundComposition(fundType, fundId);
    if (!result.success) {
      return c.json(error(ErrorCodes.INTERNAL_ERROR, result.error), 500);
    }
    if (!result.data) {
      return c.json(
        error(
          ErrorCodes.NOT_FOUND,
          "Composition not yet extracted for this fund",
        ),
        404,
      );
    }

    return c.json(success(result.data));
  } catch (err) {
    console.error("Market fund-composition error:", err);
    return c.json(
      error(ErrorCodes.INTERNAL_ERROR, "Failed to fetch fund composition"),
      500,
    );
  }
});

export default marketRoutes;
