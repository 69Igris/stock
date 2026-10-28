/**
 * Intraday ring buffer — Redis reads and writes. MONEY-1470 (A5).
 *
 * Every decision lives in `rollup-logic.ts`; this moves bytes.
 *
 * A SORTED SET scored by each bar's own timestamp, not a list. `rollup-logic`'s
 * `BufferMember` header has the three separate defects the list version had and
 * why they share one root cause — in a list, position only APPROXIMATES time.
 */
import { getRedisClient, isRedisConfigured } from "../../cache/redis";
import {
  BUFFER_TTL_SECONDS,
  bufferCapacity,
  decodeBuffer,
  intradayKey,
  toBufferMembers,
  type BasisBar,
} from "./rollup-logic";

/**
 * Add bars and trim to capacity, atomically enough.
 *
 * Returns how many members Redis ACCEPTED — never how many it was handed.
 * `pipeline.exec()` resolves with `[err, value]` tuples and does NOT reject
 * when individual commands fail, so a WRONGTYPE, a `maxmemory` refusal or a
 * partial pipeline all return normally. Reporting the input length would make
 * every caller's counter (`rt.candles_buffered`, `rowsBuffered`, `buffered`)
 * read full and healthy against a buffer that is empty and a chart that answers
 * `no_data` for every intraday symbol. The sibling `writeQuotes` already
 * inspects its results for exactly this reason.
 */
export async function appendBars(
  market: "IN" | "US",
  listingId: string,
  bars: readonly BasisBar[],
): Promise<boolean> {
  if (bars.length === 0) return false;
  const key = intradayKey(market, listingId);
  try {
    // INSIDE the try: the callers are a realtime socket and two nightly
    // loaders, and none should die because the cache layer surprised us.
    const redis = getRedisClient();
    if (!redis) return false;

    const members = toBufferMembers(bars);
    const pipeline = redis.pipeline();
    // ZADD dedupes by member, so a re-fetched identical bar is a score update
    // rather than a second copy — which is what stops `intraday-sync`'s
    // 5-day nightly overlap from inflating every derived volume ~5x.
    pipeline.zadd(key, ...members.flatMap((m) => [m.score, m.value]));
    // Evict the OLDEST beyond capacity. Rank, not score: a cutoff score would
    // need a writer to decide what "45 sessions ago" means on a calendar with
    // holidays, and a writer that gets that wrong silently shortens every chart.
    pipeline.zremrangebyrank(key, 0, -(bufferCapacity(market) + 1));
    // TTL on EVERY write. Nothing else bounds the KEYSPACE — see
    // BUFFER_TTL_SECONDS — and this is the shared Redis that also holds the
    // realtime socket's fail-closed leader lock.
    pipeline.expire(key, BUFFER_TTL_SECONDS);
    const results = await pipeline.exec();

    // The ZADD is result 0. If IT failed, nothing was stored, whatever the
    // other two did.
    const zadd = results?.[0];
    return Boolean(zadd && !zadd[0]);
  } catch {
    return false;
  }
}

/**
 * Read the most recent `limit` bars, ascending.
 *
 * `available: false` is an OUTAGE and is NOT the same as an empty buffer: one
 * is "we cannot answer", the other is "this listing has no intraday", and the
 * reader answers them differently. `dropped` counts entries that would not
 * parse, so a corrupt buffer is visible rather than merely short.
 */
export async function readBars(
  market: "IN" | "US",
  listingId: string,
  limit: number,
): Promise<{ bars: BasisBar[]; dropped: number; available: boolean }> {
  try {
    const redis = getRedisClient();
    // See `readQuotes`: NOT CONFIGURED is "no buffer" (an empty answer the
    // caller reports as `no_data`), while CONFIGURED BUT NULL is an outage.
    if (!redis) {
      return { bars: [], dropped: 0, available: !isRedisConfigured() };
    }
    // ZREVRANGE: the newest `limit`, whoever wrote them and in whatever order.
    // That is the whole reason this is a sorted set — `databento-append` writes
    // the PRIOR session hours after the socket has written today's.
    const lines = await redis.zrevrange(
      intradayKey(market, listingId),
      0,
      Math.max(0, limit - 1),
    );
    const { bars, dropped } = decodeBuffer(lines);
    return { bars, dropped, available: true };
  } catch {
    return { bars: [], dropped: 0, available: false };
  }
}
