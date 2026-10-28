/**
 * The quote store's decisions. MONEY-1469 (data-platform A4).
 *
 * `/api/market/quote` measures p50 1.28 s / p95 4.0 s. The ladder is
 *
 *     shared cache (15 s)  ->  LatestQuote (60 s)  ->  YAHOO
 *
 * and the last rung is the whole number: the Yahoo client retries 3 x 15 s with
 * 1/2/4 s backoff. The fix is that writers PUT the quote so no reader ever waits
 * on a vendor.
 *
 * ## THE US HALF ALREADY EXISTS — THIS EXTENDS IT, IT DOES NOT REPLACE IT
 *
 * `rt:us:quote:<SYMBOL>` is written today by the Tiingo socket holder and read
 * by `app/api/market/quote/quote-logic.ts` and `app/api/market/stream`. That
 * path already makes ZERO vendor requests and a test enforces it.
 *
 * So the A4 brief's `q:{market}:{listing_id}` would be a SECOND Redis quote
 * store beside a working one — one fact with two spellings, which this repo has
 * paid for repeatedly. `quoteKey` below produces the EXISTING key for US and
 * extends the same scheme to India, which has no realtime quote key at all.
 * That gap is the real subject of A4: US is done, India goes to Yahoo.
 *
 * ## STALENESS IS PER SOURCE, BECAUSE THE CADENCES DIFFER BY FOUR ORDERS
 *
 * The brief says "older than 2x the source cadence". That cannot be one number.
 * Measured from `setup-scheduler.sh`:
 *
 *     TIINGO_RT        seconds       (a live socket)
 *     intraday-sync    16:05 IST     once a day
 *     price-sync       23:00 IST     once a day
 *     bhavcopy-sync    21:00 IST     once a day
 *
 * A single threshold either calls a daily close stale ten seconds after it is
 * written, or lets a dead socket serve a two-day-old price as fresh. So the
 * cadence is a property of the SOURCE and the rule reads it from there.
 *
 * ## STALE IS SERVED, NEVER DROPPED
 *
 * A stale quote is the last known price and is what every finance UI shows out
 * of hours. Dropping it makes the symbol vanish from a watchlist, which reads
 * as "this instrument does not exist" rather than "the market is closed".
 */

export type QuoteMarket = "IN" | "US";

/**
 * Where a quote came from. The same vocabulary `mayWritePriceSource` uses, so a
 * reader can rank two quotes the way the price tables already do (MONEY-1175).
 */
export type QuoteSource =
  | "TIINGO_RT"
  | "TIINGO"
  | "DATABENTO"
  | "BHAVCOPY"
  | "ZERODHA"
  | "YAHOO"
  | "UNKNOWN";

/**
 * How often each source is expected to produce a quote, in ms.
 *
 * NOT a guess: the daily ones are the live cron schedules, and `TIINGO_RT` is a
 * socket delivering top-of-book continuously. A source missing from this table
 * gets `UNKNOWN`'s cadence, which is deliberately the most generous — an
 * unrecognised source must not be declared stale merely for being unrecognised.
 */
export const SOURCE_CADENCE_MS: Readonly<Record<QuoteSource, number>> = {
  // The socket publishes on QUOTE CHANGE, so a thin name legitimately goes
  // minutes without one. 5s x 2 invented a 10-SECOND staleness threshold over
  // the SAME key whose reader already documents 15 minutes
  // (`RT_QUOTE_MAX_AGE_MS`) and explains at length why a tight window makes
  // thin names flap between LIVE and FALLBACK on consecutive polls. Two
  // thresholds on one key, and this was the tighter one; 7.5 min x 2 reproduces
  // the documented 15.
  TIINGO_RT: 7.5 * 60_000,
  // Intraday/EOD jobs, all once per trading day.
  TIINGO: 24 * 3600_000,
  DATABENTO: 24 * 3600_000,
  BHAVCOPY: 24 * 3600_000,
  ZERODHA: 24 * 3600_000,
  // 24h, not 15 minutes. The 15-minute figure is Yahoo's exchange DELAY, a
  // property of the PRICE; the cadence is how often a quote is WRITTEN, and the
  // writer is `price-sync-daily` at 23:00 IST on weekdays. At 15 minutes every
  // India quote read `stale: true` for ~23.5 hours a day and all weekend, so
  // `stockbook.quote.stale` equalled `hit` on a perfectly healthy store and
  // could never be alerted on — the MONEY-1238 shape, in the metric this ticket
  // added to watch for it.
  YAHOO: 24 * 3600_000,
  UNKNOWN: 7 * 24 * 3600_000,
};

/** A quote older than this multiple of its source's cadence is `stale`. */
export const STALE_CADENCE_MULTIPLE = 2;

/** 24 h, per the brief. Long enough that a weekend never empties the store. */
export const QUOTE_TTL_SECONDS = 24 * 3600;

export interface StoredQuote {
  price: number;
  /**
   * ABSENT, not zero, when the source cannot supply it.
   *
   * The US socket publishes TOP OF BOOK and carries no previous close, so
   * `rt:us:quote:*` has no change to report — measured, not assumed:
   * `RtQuotePayload` is `{symbol,bid,ask,last,bidSize,askSize,ts,src,session}`.
   * A zero here would render as "unchanged" in green-or-red type, which is a
   * claim about the market rather than an admission that we do not know.
   */
  change?: number;
  changePct?: number;
  open?: number;
  high?: number;
  low?: number;
  prevClose?: number;
  volume?: number;
  /** Unix MILLISECONDS of the quote itself, not of the write. */
  ts: number;
  source: QuoteSource;
}

export interface ServedQuote extends StoredQuote {
  /** True when older than 2x its source's cadence. Served anyway. */
  stale: boolean;
  /** How old, in ms, at the moment it was read. */
  ageMs: number;
}

/**
 * The Redis key for one listing's quote.
 *
 * US returns the EXISTING `rt:us:quote:<SYMBOL>` — the key the socket holder
 * already writes and two web routes already read. Changing it would strand
 * every live quote on the platform behind a rename.
 *
 * India gets the same scheme in its own namespace. It has no realtime key
 * today, which is why its reads fall through to Yahoo.
 */
export function quoteKey(market: QuoteMarket, listingId: string): string {
  if (market === "US") {
    // The US store is keyed by SYMBOL, not by listingId — that is what the
    // socket holder writes, and a reader that invented a different shape would
    // simply miss every key while looking correct.
    const symbol = listingId.split(":")[0] ?? listingId;
    return `rt:us:quote:${symbol.toUpperCase()}`;
  }
  return `rt:in:quote:${listingId.toUpperCase()}`;
}

/** Is this quote stale, given its own source's cadence? */
export function isStale(quote: StoredQuote, nowMs: number): boolean {
  const cadence = SOURCE_CADENCE_MS[quote.source] ?? SOURCE_CADENCE_MS.UNKNOWN;
  return nowMs - quote.ts > cadence * STALE_CADENCE_MULTIPLE;
}

/**
 * Decorate a stored quote for serving. NEVER returns null for staleness.
 *
 * A future timestamp is treated as age zero rather than negative: a clock skew
 * between the writer and the reader must not make a quote look infinitely
 * fresh, nor produce a negative age that a downstream `Math.max` hides.
 */
export function serveQuote(quote: StoredQuote, nowMs: number): ServedQuote {
  return {
    ...quote,
    ageMs: Math.max(0, nowMs - quote.ts),
    stale: isStale(quote, nowMs),
  };
}

/* ──────────────────────────────────────────────────────────────────────────
   Encoding — A JSON STRING, because that is what is already at the US key
   ──────────────────────────────────────────────────────────────────────── */

/**
 * THE STORE IS A STRING, AND THAT IS NOT A STYLE CHOICE.
 *
 * `workers/src/realtime/main.ts:256` writes `rt:us:quote:<SYMBOL>` with
 * `SET key <json> EX 960`. A HASH codec at the same key would be
 * `WRONGTYPE` on every US symbol — on the WRITE and on the READ — and a store
 * that catches its own errors would report that as "no quote yet", which is
 * indistinguishable from a symbol the feed has never quoted. 100% miss,
 * rendered as health.
 *
 * A string also makes the brief's batch `MGET` literally true: one round trip,
 * N keys, no pipeline of per-key reads.
 */

/**
 * The payload the US socket holder already writes — `RtQuotePayload`, restated
 * here as the shape this decoder must accept.
 *
 * NOT imported from `tiingo-rt-keys`: this module is the QUOTE contract and
 * that one is the SOCKET's. An import would make a change to the socket's
 * payload silently change what this decoder promises, when what is wanted is
 * the opposite — a change there should fail the test below.
 */
interface RtQuoteWireShape {
  symbol?: unknown;
  last?: unknown;
  bid?: unknown;
  ask?: unknown;
  ts?: unknown;
  src?: unknown;
}

/** Serialise for `SET`. Absent optionals are OMITTED, never `null`. */
export class QuoteEncodeError extends Error {
  constructor(field: string, value: unknown) {
    super(
      `refusing to store a quote whose ${field} is ${String(value)} — ` +
        "JSON.stringify writes NaN and Infinity as null, the SET succeeds, the " +
        "writer counts it, and every read of that key is a permanent miss",
    );
    this.name = "QuoteEncodeError";
  }
}

export function encodeQuote(q: StoredQuote): string {
  // THE REQUIRED FIELDS ARE GUARDED, and they were not. The seven optionals
  // each ran through a `Number.isFinite` check while `price` and `ts` went
  // straight in — so a NaN `ts` serialised as `"ts":null`, the write succeeded,
  // `cached` counted it, and `decodeQuote` refused that key for the rest of its
  // 24-hour life. A THROW, not a silent skip: a writer producing NaN prices has
  // a defect upstream and must not quietly write fewer rows than it reports.
  if (!Number.isFinite(q.price)) throw new QuoteEncodeError("price", q.price);
  if (!Number.isFinite(q.ts)) throw new QuoteEncodeError("ts", q.ts);
  const out: Record<string, number | string> = {
    price: q.price,
    ts: q.ts,
    source: q.source,
  };
  for (const [k, v] of [
    ["change", q.change],
    ["changePct", q.changePct],
    ["open", q.open],
    ["high", q.high],
    ["low", q.low],
    ["prevClose", q.prevClose],
    ["volume", q.volume],
  ] as const) {
    if (typeof v === "number" && Number.isFinite(v)) out[k] = v;
  }
  return JSON.stringify(out);
}

/** A finite number or undefined — never a coerced zero. */
function finite(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}

/**
 * Parse one stored quote, accepting EITHER shape and refusing anything else.
 *
 * TWO WRITERS, ONE KEYSPACE. India is written by this module's own writers;
 * `rt:us:quote:*` is written by the Tiingo socket holder and has been for
 * months. Migrating that writer would mean a deploy window in which the live
 * `/api/market/quote` and `/api/market/stream` readers see a shape they do not
 * know — so the decoder reads what is there instead.
 *
 * Returns null rather than throwing: one corrupt or one-sided key must not
 * fail a batch of fifty, and the caller counts it as a miss, which is the
 * honest outcome — a quote we cannot read is a quote we do not have.
 */
export function decodeQuote(
  raw: string | null | undefined,
): StoredQuote | null {
  if (typeof raw !== "string" || raw === "") return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
    return null;
  const o = parsed as Record<string, unknown> & RtQuoteWireShape;

  const ts = finite(o.ts);
  if (ts === undefined) return null;

  // DISPATCH ON `price`, which only this module's encoder writes. The socket's
  // payload names the same number `last` and documents it as the MID, because
  // that feed carries no trades at all (MONEY-1309, 236 captured frames).
  const price = finite(o.price) ?? finite(o.last);
  // A one-sided book gives `last: null`, and that is a real state, not a
  // corruption — there is genuinely no mid. It is a MISS, never a price of 0.
  if (price === undefined) return null;

  const rawSource =
    typeof o.source === "string"
      ? o.source
      : typeof o.src === "string"
        ? o.src
        : "UNKNOWN";
  // `Object.hasOwn`, NOT `in`: `in` walks the prototype chain, so a stored
  // source of `"toString"` or `"constructor"` passed, `SOURCE_CADENCE_MS[src]`
  // returned a FUNCTION, `isStale`'s `??` does not catch one, `cadence * 2` is
  // NaN, and `now - ts > NaN` is false — that quote reads FRESH for ever.
  const source: QuoteSource = Object.hasOwn(SOURCE_CADENCE_MS, rawSource)
    ? (rawSource as QuoteSource)
    : "UNKNOWN";

  const quote: StoredQuote = { price, ts, source };
  // `change` is OMITTED when the writer had none. The US socket never has one,
  // and a fabricated 0 would render as "flat" rather than as "unknown".
  for (const k of [
    "change",
    "changePct",
    "open",
    "high",
    "low",
    "prevClose",
    "volume",
  ] as const) {
    const v = finite(o[k]);
    if (v !== undefined) quote[k] = v;
  }
  return quote;
}

/* ─────────────────────────────────────────────────────────────────────────
   Batch outcome
   ──────────────────────────────────────────────────────────────────────── */

export interface BatchQuoteResult {
  quotes: Record<string, ServedQuote>;
  /** Symbols with no usable quote. NAMED, so a caller can fall back per symbol. */
  missing: string[];
  hits: number;
  misses: number;
  stale: number;
}

/**
 * Assemble a batch read.
 *
 * A PARTIAL miss is the normal case and must stay per-symbol: one unknown
 * ticker in a twenty-symbol watchlist must not cost the other nineteen their
 * quotes, and it must not be silently dropped either — `missing` names it so
 * the caller can decide.
 */
export function assembleBatch(
  requested: readonly string[],
  found: ReadonlyMap<string, StoredQuote | null>,
  nowMs: number,
): BatchQuoteResult {
  const quotes: Record<string, ServedQuote> = {};
  const missing: string[] = [];
  let stale = 0;
  for (const symbol of requested) {
    const q = found.get(symbol) ?? null;
    if (!q) {
      missing.push(symbol);
      continue;
    }
    const served = serveQuote(q, nowMs);
    if (served.stale) stale++;
    quotes[symbol] = served;
  }
  return {
    quotes,
    missing,
    hits: requested.length - missing.length,
    misses: missing.length,
    stale,
  };
}
