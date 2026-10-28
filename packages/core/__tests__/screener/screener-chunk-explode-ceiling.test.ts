/**
 * MONEY-1144 — the screener's price chunk must stay inside Mongo's
 * `explodeForSort` ceiling.
 *
 * ## What breaks past 200
 *
 * `fetchCandleChunk` runs:
 *
 *     where:   { instrumentId: { in: ids } }
 *     orderBy: [{ instrumentId: "asc" }, { date: "desc" }]
 *
 * Mongo serves that from `@@unique([instrumentId, date])` by EXPLODING the `$in`
 * into one point-interval scan per value and merge-sorting the streams — which
 * is precisely why the sort costs nothing. The explosion is capped by the
 * `internalQueryMaxScansToExplode` server parameter, default 200. Past that the
 * planner gives up on exploding, the index no longer satisfies the sort, and it
 * falls back to a BLOCKING in-memory sort bounded at 32MB (100MB with
 * allowDiskUse) — over the largest result set this function ever materialises,
 * since there is no per-group LIMIT and `daily_prices` has no retention job.
 *
 * ## Why this is a test and not a comment
 *
 * `SCREENER_PRICE_CHUNK_SIZE`'s own docblock is a careful MEMORY argument, and
 * it ends by inviting exactly the change that breaks this: "raise these together
 * only with a memory measurement against real history depth." A memory
 * measurement at 250 would look fine and cross the ceiling anyway.
 *
 * The failure is also a cliff rather than a slope, and it lands hardest on the
 * widest screens — so it would surface as "the screener is slow for some
 * people", disconnected in time from the constant that caused it. That is the
 * kind of thing worth pinning to a number rather than to a reader's attention.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  SCREENER_PRICE_CHUNK_SIZE,
  SCREENER_PRICE_CHUNK_CONCURRENCY,
  SCREENER_CANDLE_LIMIT,
} from "../../src/screener/engine";

/** Mongo's `internalQueryMaxScansToExplode` default. Tunable server-side, but
 *  we do not tune it, so the default is the number that binds us. */
const EXPLODE_FOR_SORT_LIMIT = 200;

/** Headroom, so a later bump has to be deliberate rather than incidental. */
const SAFE_CEILING = Math.floor(EXPLODE_FOR_SORT_LIMIT * 0.75); // 150

describe("MONEY-1144 — screener chunk vs explodeForSort", () => {
  it("[regression] the chunk size stays inside the explode ceiling", () => {
    assert.ok(
      SCREENER_PRICE_CHUNK_SIZE <= SAFE_CEILING,
      `SCREENER_PRICE_CHUNK_SIZE is ${SCREENER_PRICE_CHUNK_SIZE}; it must stay ` +
        `<= ${SAFE_CEILING} (75% of internalQueryMaxScansToExplode = ` +
        `${EXPLODE_FOR_SORT_LIMIT}). Past the ceiling the $in stops exploding, ` +
        `the [{instrumentId},{date}] sort is no longer index-satisfied, and ` +
        `fetchCandleChunk degrades to a blocking 32MB in-memory sort over its ` +
        `largest result set. A memory measurement will NOT catch this`,
    );
  });

  it("the constants are sane values, not accidentally zero or NaN", () => {
    // A 0 or NaN chunk size passes the "<= 150" check while breaking the query
    // entirely, so the ceiling assertion alone is not enough.
    for (const [name, v] of [
      ["SCREENER_PRICE_CHUNK_SIZE", SCREENER_PRICE_CHUNK_SIZE],
      ["SCREENER_PRICE_CHUNK_CONCURRENCY", SCREENER_PRICE_CHUNK_CONCURRENCY],
      ["SCREENER_CANDLE_LIMIT", SCREENER_CANDLE_LIMIT],
    ] as const) {
      assert.ok(
        Number.isInteger(v) && v > 0,
        `${name} must be a positive integer, got ${v}`,
      );
    }
  });

  it("size x concurrency stays bounded — that product is the peak residency", () => {
    // Every chunk in a wave is resident at once, so this product (not the chunk
    // size alone) is what sets peak memory against the 1GiB container. Recorded
    // here so raising ONE of the two still trips a check.
    const peakInstruments =
      SCREENER_PRICE_CHUNK_SIZE * SCREENER_PRICE_CHUNK_CONCURRENCY;
    assert.ok(
      peakInstruments <= 200,
      `peak resident instruments is ${peakInstruments} ` +
        `(${SCREENER_PRICE_CHUNK_SIZE} x ${SCREENER_PRICE_CHUNK_CONCURRENCY}). ` +
        `Each carries its FULL candle history — there is no server-side row cap ` +
        `and no retention job on daily_prices — so this is the number that ` +
        `decides whether the function OOMs at five years of history`,
    );
  });
});
