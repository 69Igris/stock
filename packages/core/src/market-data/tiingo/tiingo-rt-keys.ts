/**
 * The Redis key vocabulary for the realtime layer — ONE module, no literals
 * anywhere else.
 *
 * Three processes touch these keys and none of them can see the others' source:
 * the always-on socket holder WRITES them, the web quote path READS them, and
 * a scheduled worker maintains the subscription set. A key spelled slightly
 * differently in two of those three is not a crash — it is a permanently empty
 * read that looks exactly like "the market is quiet". This repo has paid for
 * that shape more than once (a rotation cursor read by `instrumentId` while
 * written by `symbol_exchange`), so the spelling lives in one place and every
 * caller derives it.
 *
 * ## Why the quote is a STRING and not a hash
 *
 * `packages/core/src/cache/client.ts` exposes `get`/`mget`/`setex` and no hash
 * operations, and `redis.ts` documents exactly one connection per process
 * against a ~50-connection ceiling. Serving N symbols from a hash would mean
 * either N round trips or adding `hgetall` to the sanctioned surface; a JSON
 * string read through the EXISTING `mget` serves a whole watchlist in one call
 * on the connection that is already open. The quote is small and always written
 * whole, so there is nothing a hash would buy.
 */

/** Every realtime key starts here, so a `SCAN` can find the whole namespace. */
const NS = "rt:us";

/**
 * Last known quote for one symbol, as JSON.
 *
 * Symbols are UPPER-CASED here even though the feed emits lower case, because
 * every other US surface in this repo (`UsInstrument.symbol`, `Candle.symbol`,
 * the search index) is upper. Normalising at the key boundary means a reader
 * never has to know which convention the writer happened to use.
 */
export function rtQuoteKey(symbol: string): string {
  return `${NS}:quote:${symbol.trim().toUpperCase()}`;
}

/** The durable subscription set: watchlists, holdings, the S&P baseline, ETFs. */
export const RT_BASE_SET_KEY = `${NS}:base`;

/**
 * Ephemeral page interest, a sorted set scored by EXPIRY (epoch ms).
 *
 * A zset rather than N keys with their own TTLs, for two reasons that both
 * matter: the eviction policy needs to drop the SOONEST-EXPIRING first when the
 * cap is hit, which is a range query on the score; and the socket holder needs
 * to diff the whole effective set on every pass, which would otherwise be a
 * `SCAN` per tick loop.
 */
export const RT_EPHEMERAL_SET_KEY = `${NS}:eph`;

/** Resolved `symbol -> listingId`, so the tick path never queries Mongo. */
export function rtListingKey(symbol: string): string {
  return `${NS}:listing:${symbol.trim().toUpperCase()}`;
}

/** Pub/sub channel carrying quote updates for any future dedicated consumer. */
export const RT_QUOTE_CHANNEL = `${NS}:stream`;

// NO DEGRADE-STAGE KEY HERE, deliberately.
//
// There was one — `rt:us:degrade` — whose comment said it was "written by the
// budget guard and read by the subscription manager". Nothing ever wrote it.
// The budget guard publishes its rung to its OWN key
// (`tiingo:budget:stage:m:<YYYYMM>`), so the realtime reader returned "none" on
// every pass and the whole bandwidth ladder never reached the socket. It failed
// exactly the way this file's header warns about: not a crash, a permanently
// empty read that looks like "no pressure".
//
// The subscription refresh now calls `readTiingoBytesStage()` directly. One
// key, one writer, one reader, and no third place for the spelling to diverge.

/** Leader election. One holder, one socket. */
export const RT_LEADER_KEY = `${NS}:leader`;

/**
 * What the socket holder writes and the web path reads.
 *
 * `session` rides along because the consolidated feed's day is 04:00-20:00 ET:
 * a quote can be a genuine pre- or post-market quote, and a surface that shows
 * it as a regular-hours price is wrong in a way the number itself cannot
 * reveal.
 */
export interface RtQuotePayload {
  symbol: string;
  bid: number | null;
  ask: number | null;
  /** The mid — the feed publishes no trade price. See `tiingo-minute-bars.ts`. */
  last: number | null;
  bidSize: number | null;
  askSize: number | null;
  /** Venue timestamp, epoch ms. */
  ts: number;
  /** Always `TIINGO_RT`; explicit so a reader never infers provenance. */
  src: string;
  session: "pre" | "rth" | "post" | "closed";
}

/** Parse a stored quote, or `null`. Never throws — a bad value is not a crash. */
export function parseRtQuote(raw: string | null): RtQuotePayload | null {
  if (!raw) return null;
  try {
    const v = JSON.parse(raw) as Partial<RtQuotePayload>;
    if (typeof v.symbol !== "string" || typeof v.ts !== "number") return null;
    return v as RtQuotePayload;
  } catch {
    return null;
  }
}
