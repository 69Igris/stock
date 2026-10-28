/**
 * Quote store — Redis reads and writes. MONEY-1469 (A4).
 *
 * Thin on purpose: every DECISION lives in `quote-logic.ts`, which imports
 * nothing and is fully tested. This file only moves bytes.
 *
 * It uses the shared client from `@usemoney/core/cache` rather than taking a
 * port, because unlike the tile store there is exactly one Redis in play and
 * every caller already has it. An unconfigured client is NOT an error — it
 * means "no store", and the reader falls back the way it always did.
 */
import { getRedisClient, isRedisConfigured } from "../../cache/redis";
import {
  QUOTE_TTL_SECONDS,
  assembleBatch,
  decodeQuote,
  encodeQuote,
  quoteKey,
  type BatchQuoteResult,
  type QuoteMarket,
  type StoredQuote,
} from "./quote-logic";

/**
 * THE US KEYSPACE IS READ-ONLY FROM HERE, and the refusal is deliberate.
 *
 * `rt:us:quote:*` has ONE writer — the Tiingo socket holder — which sets it
 * with a 960-second TTL derived from `RT_QUOTE_MAX_AGE_MS` (MONEY-1309 spells
 * out why those two numbers are one number). A second writer here would do two
 * things, both silent: overwrite a live top-of-book quote with a daily close,
 * and re-stamp the TTL to 24 HOURS — turning "the socket died an hour ago, so
 * the key is gone" into "here is yesterday's price, still present".
 *
 * India has no realtime writer at all, which is the actual subject of A4.
 */
export class UsQuotesAreReadOnlyError extends Error {
  constructor() {
    super(
      "refusing to write rt:us:quote:* — the Tiingo socket holder owns that key " +
        "and its 960s freshness TTL; writing here would extend a dead socket's " +
        "last quote to 24 hours and hide the outage",
    );
    this.name = "UsQuotesAreReadOnlyError";
  }
}

/**
 * Write one quote. Returns whether it was stored.
 *
 * `false` is ordinary — local dev has no Redis — so callers treat it as "the
 * next reader will do what it did before", never as a failure to report. A US
 * market, by contrast, THROWS: that is a programming error, not an outage.
 */
export async function writeQuote(
  market: QuoteMarket,
  listingId: string,
  quote: StoredQuote,
): Promise<boolean> {
  if (market === "US") throw new UsQuotesAreReadOnlyError();
  try {
    // INSIDE the try. `getRedisClient` is documented to return null rather than
    // throw, but that is not this module's guarantee to make — and the caller
    // is `refreshAllQuotes`, whose own catch counts a throw as
    // `failed += batch.length`. A cache-layer surprise would then be reported
    // as fifty QUOTE failures for quotes that landed in Mongo perfectly.
    const redis = getRedisClient();
    if (!redis) return false;
    // SET with EX in ONE command: a separate `expire` leaves a window in which
    // a crash between the two writes a quote that never expires.
    await redis.set(
      quoteKey(market, listingId),
      encodeQuote(quote),
      "EX",
      QUOTE_TTL_SECONDS,
    );
    return true;
  } catch {
    // A cache write that fails must never fail the caller — the writers here
    // are nightly price jobs, and none should die because Redis blinked.
    return false;
  }
}

/**
 * Read a batch in ONE round trip.
 *
 * `MGET` works because the value is a JSON STRING — which it is because that is
 * what the US socket holder already writes. See the codec's header.
 */
export async function readQuotes(
  market: QuoteMarket,
  listingIds: readonly string[],
  nowMs: number = Date.now(),
): Promise<BatchQuoteResult & { available: boolean }> {
  const found = new Map<string, StoredQuote | null>();
  // An OUTAGE is not a MISS, and the caller answers them differently: a miss
  // means "fall back for these symbols", an outage means "we could not ask".
  // Folding them together makes a dead Redis look like a universe of unknown
  // tickers. `readBars`, written in the same ticket, already carries this flag.
  let available = true;

  try {
    // INSIDE the try, so an unreachable cache is a MISS rather than a 500 on a
    // route whose whole contract is "a miss is the normal answer".
    const redis = getRedisClient();
    // A null client means TWO different things and they demand opposite
    // answers. NOT CONFIGURED — local dev, a test, a new environment — is "no
    // store", and the honest reply is an empty result the caller falls back
    // from. CONFIGURED BUT NULL is a real outage: the client failed to
    // construct, or is inside its retry cooldown after a burst of failures.
    // Reporting both as an outage makes `yarn dev` answer 503; reporting both
    // as empty makes a dead Redis look like a universe of unknown tickers.
    if (!redis && isRedisConfigured()) available = false;
    if (redis && listingIds.length > 0) {
      const values = await redis.mget(
        ...listingIds.map((id) => quoteKey(market, id)),
      );
      listingIds.forEach((id, i) => found.set(id, decodeQuote(values[i])));
    }
  } catch {
    available = false;
    for (const id of listingIds) if (!found.has(id)) found.set(id, null);
  }

  return { ...assembleBatch(listingIds, found, nowMs), available };
}

/**
 * Write a batch in ONE round trip.
 *
 * `refreshAllQuotes` sweeps ~20,700 active India instruments a night. At one
 * `SET` each that is ~20,700 round trips added to a job that already runs
 * against a 600 s Pub/Sub ack deadline — and a handler that overruns it is not
 * merely slow, it is REDELIVERED, so a second copy starts concurrently. One
 * pipeline per 50-instrument batch costs one extra round trip per batch.
 *
 * Returns how many were stored, so a caller can report the write rather than
 * assume it: a Redis that silently accepted nothing must not read as a
 * successful sync.
 */
export async function writeQuotes(
  market: QuoteMarket,
  entries: ReadonlyArray<{ listingId: string; quote: StoredQuote }>,
): Promise<number> {
  if (market === "US") throw new UsQuotesAreReadOnlyError();
  if (entries.length === 0) return 0;
  try {
    // INSIDE the try — see `writeQuote`.
    const redis = getRedisClient();
    if (!redis) return 0;
    const pipeline = redis.pipeline();
    for (const e of entries) {
      pipeline.set(
        quoteKey(market, e.listingId),
        encodeQuote(e.quote),
        "EX",
        QUOTE_TTL_SECONDS,
      );
    }
    const results = await pipeline.exec();
    // Count what ACTUALLY landed. ioredis returns [err, value] per command, and
    // one failed key in a pipeline does not fail the others — reporting
    // `entries.length` here would turn a half-written batch into a clean number.
    return (results ?? []).filter((r) => r && !r[0]).length;
  } catch {
    return 0;
  }
}
