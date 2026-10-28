/**
 * Cold store for candles — the GCS half of the hot/cold split (MONEY-980, TASK 4).
 *
 * ## Why a port and not a direct GCS call
 *
 * `@usemoney/storage` depends on `@usemoney/core`, so core CANNOT import it —
 * that is a cycle. Core therefore owns the PORT and every decision made around
 * it; the worker registers a GCS-backed adapter at startup. This is the exact
 * arrangement `feed-archive.ts` + `workers/src/lib/feed-archive-store.ts` use,
 * and it is reused rather than reinvented so unit tests can inject a fake and
 * nothing here needs GCP to be covered.
 *
 * The worker-side adapter is ~20 lines and MUST get three things right, each of
 * which is a trap that has already cost this repo a bug:
 *
 *   1. `uploadFile` defaults `isPublic: true`, and a public upload resolves
 *      `GCP_PUBLIC_STORAGE_BUCKET`, NOT `GCP_STORAGE_BUCKET`. Passing
 *      `isPublic: false` is mandatory — MONEY-865 is the record of what happens
 *      when the wrong bucket answers.
 *   2. `uploadFile` takes `(folder, fileName)` and concatenates them, so the
 *      key must be split on its LAST `/`.
 *   3. `downloadFile` maps a 404 to `null` and rethrows everything else. That
 *      distinction is load-bearing here — see {@link ColdShardOutcome}.
 *
 * ## Scale
 *
 * 24,328 US securities × ~9.5 years of retained history ≈ 231,825 symbol-years,
 * against 200M+ daily rows in total. Mongo keeps a hot window (active symbols,
 * recent ~2y); everything older lives here as one object per symbol-year.
 */

import {
  buildCandleColdKey,
  coldShardContentType,
  decodeColdShard,
  encodeColdShard,
  mergeColdBars,
  resolveColdShardFormat,
  type CandleBar,
} from "./candle-logic";
import {
  cachedWithStaleFallback,
  SINGLE_FLIGHT_TIMEOUT_MS,
} from "../../cache/stale-while-error";
import { deleteCached } from "../../cache/wrapper";

/* ─────────────────────────────────────────────────────────────────────────
   The port
   ──────────────────────────────────────────────────────────────────────── */

/**
 * Storage port. Implemented by the worker over GCS; faked in tests.
 *
 * ## There is deliberately NO `list`
 *
 * The obvious way to answer "which years do we hold?" is to list the prefix.
 * `listFiles` in `@usemoney/storage` FAILS OPEN to `[]` on an auth or network
 * failure (it logs, but it still returns `[]`) — MONEY-941, where an archive
 * parse job read that as "0 files archived, parse complete" and exited 0. An
 * empty listing is therefore never proof of absence, and a read path that made
 * a decision on one would silently return a truncated price series on every
 * credentials blip.
 *
 * So the read never lists. It computes the candidate year keys from the
 * requested range and `get`s each one, because `get` gives an answer that CAN
 * be trusted in both directions: `null` is a 404 and means genuinely absent,
 * and anything else throws.
 */
export interface CandleColdStore {
  /** Bytes at `key`, or `null` when the object genuinely does not exist. */
  get(key: string): Promise<Buffer | null>;
  /** Persist bytes at `key`. May throw. */
  put(key: string, body: Buffer, contentType: string): Promise<void>;
}

/**
 * How long a cold read or write may take before we stop waiting.
 *
 * A bound is mandatory for the `FEED_ARCHIVE_{READ,WRITE}_TIMEOUT_MS` reason:
 * any of this can run inside a Pub/Sub push handler whose ack deadline is 600s,
 * while `@google-cloud/storage` 7.x defaults to `totalTimeout = 600s` with
 * `maxRetries = 3`. One wedged object could otherwise consume the ENTIRE ack
 * budget, at which point Pub/Sub redelivers while run #1 is still live and two
 * copies of the job race the same unique key.
 *
 * ## Why it is DERIVED from `SINGLE_FLIGHT_TIMEOUT_MS` and not the archive's 30s
 *
 * This read runs INSIDE `cachedWithStaleFallback`, which wraps its compute in
 * `singleFlight` with a 25s backstop. At the feed archive's 30s the two would be
 * inverted, and MONEY-1135 is the written record of exactly that failure: the
 * backstop fires FIRST, so every caller gets a `SingleFlightTimeoutError`
 * instead of the graceful outcome the inner budget exists to produce, and "a
 * backstop that fires before the mechanism it backs up doesn't protect that
 * mechanism, it replaces it".
 *
 * Subtracting rather than hardcoding 20s makes the ordering STRUCTURAL. A
 * comment asserting the relation is a comment; a subtraction cannot silently
 * invert when someone retunes the backstop, which is precisely how the original
 * inversion happened.
 */
export const CANDLE_COLD_TIMEOUT_MS = Math.max(
  5_000,
  SINGLE_FLIGHT_TIMEOUT_MS - 5_000,
);

let store: CandleColdStore | null = null;
let timeoutMs = CANDLE_COLD_TIMEOUT_MS;

export interface CandleColdStoreOptions {
  timeoutMs?: number;
}

/**
 * Register (or clear, with `null`) the cold backend.
 *
 * Without a registration the repository simply does not consult cold storage —
 * it does NOT error and it does NOT report a gap. That is the correct default
 * for local dev, for QA before the mirror exists, and for today, where nothing
 * has written a shard yet: an unregistered store means "everything we hold is
 * hot", which is true.
 *
 * `options` re-resolves on EVERY call so registration is idempotent and a test
 * that tightened the deadline cannot leak it into the next one — the same
 * discipline as `setFeedArchiveStore`.
 */
export function setCandleColdStore(
  next: CandleColdStore | null,
  options?: CandleColdStoreOptions,
): void {
  store = next;
  const ms = options?.timeoutMs;
  timeoutMs =
    typeof ms === "number" && Number.isFinite(ms) && ms > 0
      ? ms
      : CANDLE_COLD_TIMEOUT_MS;
}

/** The registered store, or null. Exported for assertions in tests. */
export function getCandleColdStore(): CandleColdStore | null {
  return store;
}

/* ─────────────────────────────────────────────────────────────────────────
   Outcomes — absence and failure are NOT the same thing
   ──────────────────────────────────────────────────────────────────────── */

/**
 * The three states a cold-shard read can end in.
 *
 * They are three and not two on purpose. `present` and `absent` are both
 * ANSWERS; `failed` is the absence of an answer, and the whole point of this
 * type is that the last one can never be mistaken for an empty year.
 *
 * That mistake is this repo's most expensive recurring bug. `listFiles` returning
 * `[]` on an auth failure read as "nothing archived" (MONEY-941). A checkpoint
 * recorded DONE for work that never happened (MONEY-1189). A subscription cache
 * wrote a fail-open FREE into Redis and pinned paying users to it for the whole
 * TTL (MONEY-1126). Here the same shape would be worse than any of them: a
 * silently truncated price series is not visibly wrong, it just draws a shorter
 * chart and computes a smaller CAGR.
 */
export type ColdShardOutcome =
  | { status: "present"; bars: CandleBar[] }
  | { status: "absent" }
  | { status: "failed"; error: unknown };

/** Raised when a cold read could not be completed. Never cached. */
export class ColdStoreUnavailableError extends Error {
  readonly keys: string[];
  constructor(keys: string[], cause?: unknown) {
    super(
      `candle cold store unavailable for ${keys.length} shard(s): ${keys
        .slice(0, 5)
        .join(", ")}${keys.length > 5 ? ", …" : ""}`,
    );
    this.name = "ColdStoreUnavailableError";
    this.keys = keys;
    if (cause !== undefined) this.cause = cause;
  }
}

/* ─────────────────────────────────────────────────────────────────────────
   Cached reads
   ──────────────────────────────────────────────────────────────────────── */

/**
 * Cache module + TTLs for a cold shard.
 *
 * A shard is a CLOSED year of prices for one symbol. It changes only when a
 * corporate action is restated, which is rare and lands in Mongo first (hot wins
 * the merge), so a long TTL is safe and the value of caching is high: an
 * adjusted read that has to anchor on the latest bar can touch a decade of
 * shards, and every one of those is a GCS round trip on a cold cache.
 */
export const CANDLE_COLD_CACHE_MODULE = "candles-cold";
export const CANDLE_COLD_CACHE_TTL_SECONDS = 6 * 60 * 60; // 6h
export const CANDLE_COLD_CACHE_STALE_TTL_SECONDS = 7 * 24 * 60 * 60; // 7d

/**
 * The cache client's "userId" slot. Global market data has no user.
 *
 * A NAMED CONSTANT rather than the literal it used to be, because the read and
 * the eviction have to agree on it and a literal spelled in two places is
 * exactly the drift `CA_EVICTION_UNAVAILABLE` refused to build on ("two of the
 * four key segments are private to modules this job must not restate"). One
 * declaration removes the objection instead of arguing with it.
 */
export const COLD_CACHE_SCOPE = "_global";

/**
 * The suffix `cachedWithStaleFallback` appends for its last-known-good entry.
 *
 * RESTATED, because `stale-while-error.ts` builds it as a local
 * (`const lastGoodId = \`${identifier}:last-good\``) and does not export it —
 * and an eviction that clears only the fresh copy leaves a failed recompute
 * serving the pre-write shard out of the stale entry for up to seven days,
 * which looks exactly like an eviction that worked.
 *
 * A copied constant is only safe when something fails on the day it stops being
 * a copy, so this one is pinned by a SOURCE SCAN in
 * `packages/core/__tests__/market-data/candle-cold-store.test.ts` — the same
 * guard `TIINGO_BACKOFF_BASE_MS` carries in `us-eod-sync.ts`.
 */
export const COLD_CACHE_LAST_GOOD_SUFFIX = ":last-good";

/**
 * What actually gets stored in Redis.
 *
 * The `present` discriminant is NOT decoration and it is NOT redundant with
 * `bars: []`. `resolveWithStaleFallback` treats a cached `null`/`undefined` as a
 * MISS (`if (fresh !== null && fresh !== undefined)`), so encoding "this year has
 * no shard" as `null` would defeat the cache entirely — every read of every
 * absent year would go back to GCS forever, which for a symbol listed in 2019
 * means a GCS round trip per pre-2019 year on every single request. A truthy
 * envelope makes absence a cacheable answer.
 *
 * `ts` is serialised as epoch ms because the cache round-trips through JSON and
 * a `Date` comes back as a string; reviving it at the boundary keeps every
 * consumer's `bar.ts` a real `Date`.
 */
interface CachedShard {
  present: boolean;
  bars: Array<Omit<CandleBar, "ts"> & { ts: number }>;
}

/**
 * Read ONE symbol-year, through the cache, single-flighted.
 *
 * `cachedWithStaleFallback` is used rather than `withCache` because `withCache`
 * derives its cache key from `args[0]` as a userId, which does not fit a global
 * market key — stated at `stale-while-error.ts:11-13`. It also brings the two
 * properties this path needs: an in-process single flight (so N concurrent
 * charts on the same symbol make ONE GCS call), and a last-known-good copy that
 * is served if a later read fails.
 *
 * Failure handling is the important half. Only SUCCESSES are ever written to the
 * cache, so a GCS outage can never be persisted as an empty year. A `failed`
 * outcome from the primitive is surfaced as {@link ColdShardOutcome} `failed`,
 * and the caller decides — it never silently becomes `absent`.
 */
export async function readColdShard(args: {
  market: string;
  timeframe: string;
  symbol: string;
  year: number;
}): Promise<ColdShardOutcome> {
  const active = store;
  if (!active) return { status: "absent" };

  const key = buildCandleColdKey(args);

  const outcome = await cachedWithStaleFallback<CachedShard>({
    module: CANDLE_COLD_CACHE_MODULE,
    // The cache client's "userId" slot — see COLD_CACHE_SCOPE, which the
    // eviction path reads from the same declaration.
    scope: COLD_CACHE_SCOPE,
    identifier: key,
    ttlSeconds: CANDLE_COLD_CACHE_TTL_SECONDS,
    staleTtlSeconds: CANDLE_COLD_CACHE_STALE_TTL_SECONDS,
    compute: async () => {
      const body = await withDeadline(active.get(key), key);
      if (body === null) return { present: false, bars: [] };
      const bars = await decodeColdShard(body);
      return {
        present: true,
        bars: bars.map((b) => ({ ...b, ts: b.ts.getTime() })),
      };
    },
  });

  if (outcome.status === "failed") {
    return { status: "failed", error: outcome.error };
  }
  // `fresh` and `stale` are both real answers. A stale shard is a closed year of
  // prices served from a copy that was correct hours ago — for immutable history
  // that is not a degradation worth reporting, which is exactly the case
  // stale-while-error exists for.
  const shard = outcome.data;
  if (!shard.present) return { status: "absent" };
  return {
    status: "present",
    bars: shard.bars.map((b) => ({ ...b, ts: new Date(b.ts) })),
  };
}

/**
 * Read ONE symbol-year, BYPASSING the cache entirely — MONEY-1373.
 *
 * The `compute` body of {@link readColdShard} with `cachedWithStaleFallback`
 * peeled off, and a thrown read reported as `failed` rather than propagating.
 *
 * ## Why the eviction job may not use the cached read
 *
 * Every verifying read in `candle-evict.ts` now comes through here, the D1 path
 * included. `cachedWithStaleFallback` writes TWO Redis entries per key — the
 * fresh one and its `:last-good` twin — holding the DECODED shard as JSON. A
 * 242,000-bar M1 year-shard is 7.95 MB gzipped on GCS and roughly 36 MB as
 * JSON, and the first intraday eviction night walks ~14,570 units. That is tens
 * of gigabytes pushed into Redis to answer a question asked exactly once, by a
 * job whose whole purpose is to read a shard, prove it holds a row, and never
 * look at it again. There is no size guard on the way in.
 *
 * The cached read stays the right primitive for the READ path, where a decade
 * of shards is re-read per chart and a stale closed year is a perfectly good
 * answer. It is the wrong one for a single-shot verification.
 *
 * ## `failed` is still not `absent`
 *
 * A store that throws — a timeout from {@link withDeadline}, a 500 from GCS —
 * returns `{status:"failed"}`, distinct from the `{status:"absent"}` a genuine
 * 404 produces. On the DELETE side that distinction decides whether an outage
 * reads as "there is no shard, so this row is unarchived" or as "we do not
 * know". Both resolve to KEEP, but only one of them is worth waking somebody.
 */
export async function readColdShardUncached(args: {
  market: string;
  timeframe: string;
  symbol: string;
  year: number;
}): Promise<ColdShardOutcome> {
  const active = store;
  if (!active) return { status: "absent" };

  const key = buildCandleColdKey(args);
  try {
    const body = await withDeadline(active.get(key), key);
    if (body === null) return { status: "absent" };
    // No `ts` revive here, unlike the cached path: `decodeColdShard` already
    // hands back real Dates. The revive in `readColdShard` exists only because
    // its value round-trips through JSON on the way out of Redis.
    return { status: "present", bars: await decodeColdShard(body) };
  } catch (error) {
    return { status: "failed", error };
  }
}

/**
 * Write one symbol-year, MERGING with whatever is already there.
 *
 * It lives here so the encode/key/content-type triple has exactly one
 * definition and no other writer can invent a second one.
 *
 * ## A GCS write is a REPLACE, so the default has to merge
 *
 * Handed one month of 2014, a naive write leaves the object holding one month
 * of 2014 and nothing else: eleven months deleted, no error raised, and a chart
 * that simply draws a shorter line and computes a smaller CAGR. That is the
 * same silent truncation {@link ColdShardOutcome} splits `failed` from `absent`
 * to prevent, arriving from the write side. `mergeColdBars` owns the union rule
 * (incoming wins on the natural key).
 *
 * `merge: false` skips the read for a caller that is writing a symbol-year IN
 * FULL — the backfill, which fetches a security's entire history in one request
 * — and saves one GET per shard across ~231,825 of them.
 *
 * ## The read is UNCACHED, and that is not an optimisation
 *
 * {@link readColdShard} serves from a 6h cache with a 7d stale copy. Merging
 * onto a cached read would union today's bars with a shard as it stood hours
 * ago and then WRITE that back — turning a stale read into a permanent one. The
 * merge reads through the store directly, and the cache for the key it just
 * moved is dropped afterwards by {@link evictColdShard}.
 *
 * A cache delete that fails is logged and swallowed: the object on GCS is
 * already correct, and throwing here would report a completed write as a
 * failure. The cost of a missed eviction is bounded by the 6h TTL.
 */
export async function writeColdShard(args: {
  market: string;
  timeframe: string;
  symbol: string;
  year: number;
  bars: readonly CandleBar[];
  /** Read-modify-write. Default true; false only when writing a full year. */
  merge?: boolean;
}): Promise<{ key: string; bytes: number; bars: number; merged: boolean }> {
  const active = store;
  if (!active) {
    throw new Error(
      "writeColdShard: no cold store registered — call setCandleColdStore() first",
    );
  }
  const key = buildCandleColdKey(args);

  let bars: readonly CandleBar[] = args.bars;
  let merged = false;
  if (args.merge !== false) {
    const existing = await withDeadline(active.get(key), key);
    if (existing !== null) {
      // Whatever format the existing object is in — this is the ONE place a
      // half-converted bucket is survivable or not. `decodeColdShard` sniffs
      // magic bytes, so a parquet shard merges and is re-written in the
      // CONFIGURED format, and a bucket may stay mixed indefinitely.
      bars = mergeColdBars(await decodeColdShard(existing), args.bars);
      merged = true;
    }
  }

  // Resolved HERE, per write, so flipping CANDLE_COLD_FORMAT takes effect on a
  // warm container instead of at the import that happened hours ago.
  const format = resolveColdShardFormat();
  const body = await encodeColdShard(bars, format);
  await withDeadline(active.put(key, body, coldShardContentType(format)), key);
  await evictColdShard(args);
  return { key, bytes: body.length, bars: bars.length, merged };
}

/**
 * Drop the cached copies of one symbol-year. THE eviction entry point.
 *
 * ## This is the method `CA_EVICTION_UNAVAILABLE` said did not exist
 *
 * That constant is right that a corporate action does not stale a closed year's
 * RAW prices — the adjusted series is recomputed on every read and cached
 * nowhere — and leg (c) still must not call this. What it also said, and what
 * has stopped being true, is that no entry point exists at all: once
 * `putCandles` writes shards it has to be able to invalidate the ones it moved,
 * so the entry point is a requirement of the WRITE path rather than a
 * concession to the corporate-actions one. See `CandleRepository.evictColdShards`.
 *
 * BOTH entries go: the fresh one and the `:last-good` twin
 * `cachedWithStaleFallback` writes on every success. Dropping only the fresh
 * copy would leave a recompute failure serving the pre-write shard out of the
 * stale entry for up to seven days — an eviction that looks complete and is
 * not.
 *
 * Never throws. A cache that cannot be reached is a slow read, not a wrong one.
 */
export async function evictColdShard(args: {
  market: string;
  timeframe: string;
  symbol: string;
  year: number;
}): Promise<boolean> {
  const key = buildCandleColdKey(args);
  try {
    await deleteCached(CANDLE_COLD_CACHE_MODULE, COLD_CACHE_SCOPE, key);
    await deleteCached(
      CANDLE_COLD_CACHE_MODULE,
      COLD_CACHE_SCOPE,
      `${key}${COLD_CACHE_LAST_GOOD_SUFFIX}`,
    );
    return true;
  } catch (error) {
    console.warn(
      `[candles-cold] eviction failed for ${key} (the object is written; the ` +
        `cache clears itself in ${CANDLE_COLD_CACHE_TTL_SECONDS}s): ` +
        `${error instanceof Error ? error.message : String(error)}`,
    );
    return false;
  }
}

/* ─────────────────────────────────────────────────────────────────────────
   Bounded wait
   ──────────────────────────────────────────────────────────────────────── */

/**
 * Await `work`, giving up after the configured deadline.
 *
 * Written here rather than shared with `feed-archive.ts` because that module's
 * equivalent is private to it, and lifting it out would mean editing a file this
 * change has no other business in. The three properties it must have are copied
 * exactly, and each one is a bug that has actually happened:
 *
 *   - the timer is cleared on EVERY exit, or a settled race leaves a live
 *     `setTimeout` holding the event loop open for the full deadline — a delayed
 *     shutdown in a worker and an orphaned handle in a test;
 *   - the abandoned promise gets its own no-op rejection handler, or a `work`
 *     that rejects AFTER the deadline surfaces as an unhandled rejection and
 *     takes the process down over an error already reported;
 *   - attaching that handler does not consume the rejection for the `await`
 *     below, so a `work` that rejects BEFORE the deadline still propagates.
 */
function withDeadline<T>(work: Promise<T>, key: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  work.catch(() => {});
  const deadline = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(
      () =>
        reject(
          new ColdStoreUnavailableError(
            [key],
            new Error(`timed out after ${timeoutMs}ms`),
          ),
        ),
      timeoutMs,
    );
  });
  return Promise.race([work, deadline]).finally(() => {
    if (timer) clearTimeout(timer);
  }) as Promise<T>;
}
