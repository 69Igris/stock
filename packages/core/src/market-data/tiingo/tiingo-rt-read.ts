/**
 * US quote READ path — the ports for `tiingo-rt-read-logic.ts`.
 *
 * Two stores, both ours:
 *
 *   Redis   `rt:us:quote:<SYMBOL>`, written by the socket holder
 *   Mongo   `candles`, via `CandleRepository`, written by `us-eod-sync`
 *
 * ## There is NO Tiingo HTTP client in this file, and that is the contract
 *
 * A request for a US quote must never become a request to `api.tiingo.com`.
 * Tiingo is a PAID METERED api on a Commercial plan whose licence is internal-
 * use-only, its own rate limiter paces PROACTIVELY at 180 ms per request, and a
 * quote route is polled every 5-10 seconds per open tab — three separate reasons
 * why one user's page view must not reach the vendor. The vendor is reached by
 * exactly two things: the nightly `us-eod-sync` job and the always-on socket
 * holder. Everything a request path serves comes out of what those two wrote.
 *
 * `us-quote-read-no-vendor.test.ts` reads this file and its logic sibling and
 * fails if either grows an import of the Tiingo client or names a Tiingo host.
 * A comment asking people to remember is not a guard.
 *
 * ## ONE Redis connection, and never a subscriber
 *
 * `cache/redis.ts` documents exactly one client per process against a managed
 * node whose ceiling is ~50 connections, and MONEY-1127 is the record of what
 * three independent singletons cost. A pub/sub SUBSCRIBE would need a second
 * connection per web instance — ioredis puts a subscribed client into a mode
 * where it can issue nothing else — so the read path POLLS the same keys on the
 * shared client instead. `RT_QUOTE_CHANNEL` exists for a future dedicated
 * consumer in its own process; it is not for this one.
 *
 * A whole watchlist is ONE `mget`, which is why the socket holder stores the
 * quote as a JSON string rather than a hash (see `tiingo-rt-keys.ts`).
 */

import { getRedisClient } from "../../cache/redis";
import { apiLogger as logger } from "@usemoney/logger";

import {
  RT_EPHEMERAL_SET_KEY,
  parseRtQuote,
  rtQuoteKey,
  type RtQuotePayload,
} from "./tiingo-rt-keys";
import {
  RT_EPHEMERAL_TTL_MS,
  decideUsQuote,
  ephemeralExpiryScore,
  normalizeUsExchange,
  type UsQuote,
} from "./tiingo-rt-read-logic";
import { candleRepository } from "../candles/candle-repository";
import type { CandleBar } from "../candles/candle-logic";

/** The timeframe the US backbone stores daily bars under. */
const US_EOD_TIMEFRAME = "D1";

/**
 * How far back the EOD fallback looks for a session bar.
 *
 * It needs TWO bars — the latest close and its predecessor, which is what
 * `change` is measured against. Thirty days covers a long US holiday weekend
 * plus a thin name that did not print, without widening into a range where a
 * "previous close" would be weeks old and the delta meaningless.
 */
const US_EOD_LOOKBACK_DAYS = 30;

/**
 * How many symbols the EOD fallback will fan out to in one request.
 *
 * `CandleRepository` exposes no batch latest-bar read: `latestTs` returns a
 * TIMESTAMP (not a bar) and `getCandles` is per-security by construction,
 * because listing resolution and adjustment are both per-security. So an N-symbol
 * fallback is N bounded Mongo queries, and this cap is what stops a 50-symbol
 * watchlist that missed Redis entirely from turning one request into fifty.
 * Symbols past the cap are simply absent from the payload — the same fail-open
 * contract `/api/market/quote` has always had for a symbol nothing could
 * resolve.
 *
 * ## That last sentence was FALSE for eight months of every 20-symbol watchlist
 *
 * It described the case where Redis answered NOTHING. When Redis DID answer, the
 * loop below still asked `decideUsQuote` for every symbol — the cap truncated
 * only the BAR read — so a symbol past it arrived with a fresh realtime quote
 * and an empty bar list, took the live branch, and was served with a real price,
 * `change: 0`, `changePercent: 0`, `volume: 0` and `fallback: false`. Badged
 * live, showing a flat 0.00% the market never printed. Both routes admit 50
 * symbols, so a 20-symbol US watchlist hit it on eight of them.
 *
 * The comment is true again because `decideUsQuote` now REFUSES to emit a quote
 * with no session bar (see its module note), so the truncation surfaces where a
 * missing symbol already surfaces: in `unresolved`, which is what apps/web's
 * `fetchUsQuotesUncached` and apps/api's `missing` both already report. There is
 * no separate `skippedEod` field for a caller to destructure away — every one of
 * them did.
 *
 * Raising it is not the way to serve a bigger watchlist. The realtime layer is:
 * a symbol in the subscription set is answered from ONE `mget` and never reaches
 * this path at all.
 */
export const US_EOD_FALLBACK_MAX_SYMBOLS = 12;

/** Concurrent `getCandles` calls. Small — these are hot-store reads, not I/O waits. */
const US_EOD_CONCURRENCY = 4;

/**
 * Read the stored realtime quotes for `symbols`.
 *
 * ONE `mget` on the shared connection. Never throws: Redis unavailable, a
 * wedged node, or a value the socket holder wrote in a shape we no longer
 * understand all degrade to "no live quote", which the caller answers from the
 * EOD store.
 */
export async function readRtQuotes(
  symbols: readonly string[],
): Promise<Map<string, RtQuotePayload>> {
  const found = new Map<string, RtQuotePayload>();
  if (symbols.length === 0) return found;

  const client = getRedisClient();
  if (!client) return found;

  try {
    const keys = symbols.map((s) => rtQuoteKey(s));
    const raw = await client.mget(...keys);
    for (let i = 0; i < symbols.length; i++) {
      const parsed = parseRtQuote(raw[i] ?? null);
      if (parsed) found.set(symbols[i]!.trim().toUpperCase(), parsed);
    }
  } catch (error) {
    logger.warn({ error }, "[us-quote] realtime quote read failed");
    return new Map();
  }

  return found;
}

/** The port `resolveUsQuotes` reads session bars through. */
export type UsEodBarsReader = (
  symbol: string,
  exchange: string,
  now: Date,
) => Promise<CandleBar[]>;

let barsReaderOverride: UsEodBarsReader | null = null;

/**
 * Inject the EOD bar read. Pass null to restore `candleRepository`.
 *
 * `resolveUsQuotes` had NO seam and consequently no test: `getRedisClient` has
 * one (`__setRedisFactoryForTests`, which `us-quote-interest.test.ts` already
 * drives) but `candleRepository` is imported as a module singleton, so the only
 * way to exercise the fan-out cap was a live Mongo. That is how
 * `US_EOD_FALLBACK_MAX_SYMBOLS` shipped with a truncation defect that no test
 * could see — the cap appears in no test file at all.
 *
 * Same shape as `__setTiingoBudgetRedisForTests` / `__setRedisFactoryForTests`:
 * a module-scope override, null to restore, so the production path is the one
 * that runs when nothing is injected.
 */
export function __setUsEodBarsReaderForTests(fn: UsEodBarsReader | null): void {
  barsReaderOverride = fn;
}

/**
 * Latest daily bars for one symbol, ascending, hot store only.
 *
 * `cold: false` is load-bearing rather than an optimisation: the cold tier is
 * GCS, and a request path must not take a network hop to object storage to draw
 * a price. The hot window is ten years deep, so every bar this lookback can
 * reach is in Mongo by construction. `writeBack: false` for the same reason —
 * a read on the request path must not queue writes.
 */
async function readEodBarsForSymbol(
  symbol: string,
  exchange: string,
  now: Date,
): Promise<CandleBar[]> {
  if (barsReaderOverride) return barsReaderOverride(symbol, exchange, now);
  const from = new Date(now.getTime() - US_EOD_LOOKBACK_DAYS * 86_400_000);
  try {
    const series = await candleRepository.getCandles({
      symbol,
      exchange,
      timeframe: US_EOD_TIMEFRAME,
      from,
      to: now,
      adjusted: false,
      cold: false,
      writeBack: false,
      onColdFailure: "degrade",
    });
    return series.bars;
  } catch (error) {
    logger.warn({ error, symbol, exchange }, "[us-quote] EOD bar read failed");
    return [];
  }
}

/** Run `task` over `items` with a fixed ceiling on concurrent calls. */
async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  task: (item: T) => Promise<R>,
): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let cursor = 0;
  const workers = Array.from(
    { length: Math.min(limit, items.length) },
    async () => {
      for (;;) {
        const index = cursor++;
        if (index >= items.length) return;
        out[index] = await task(items[index]!);
      }
    },
  );
  await Promise.all(workers);
  return out;
}

export interface ResolveUsQuotesResult {
  /** Resolved quotes, keyed by UPPER-CASE symbol. */
  quotes: Map<string, UsQuote>;
  /**
   * Symbols no quote could be built for — absent from `quotes` (fail-open).
   *
   * INCLUDES the symbols past {@link US_EOD_FALLBACK_MAX_SYMBOLS}. There used
   * to be a separate `skippedEod: string[]` for those, and every caller
   * destructured it away, so a truncated batch was indistinguishable from a
   * complete one at every call site in the repo. Truncation now lands in the
   * field callers already read and already surface — apps/api's `missing`,
   * apps/web's `unresolved` — and is logged once per request besides.
   */
  unresolved: string[];
}

/**
 * Resolve US quotes for a batch: Redis first, the EOD close behind it.
 *
 * The EOD leg runs for the symbols Redis could not answer AND for those it
 * could, because a realtime quote carries no previous close — the feed publishes
 * a bid/ask, not a session. `change` has to be measured against something, and
 * inventing a zero delta would read as "unchanged" rather than as "unknown".
 * That is one bounded Mongo query per symbol, capped — and the cap is the
 * reason a symbol can come back unresolved while Redis was answering perfectly
 * well. `decideUsQuote` refuses to build a quote with no session bar, so the
 * surplus symbols land in `unresolved` rather than being served with the zero
 * delta this paragraph exists to refuse. See {@link US_EOD_FALLBACK_MAX_SYMBOLS}.
 *
 * Never throws. An unresolvable symbol is absent from the map.
 */
export async function resolveUsQuotes(
  symbols: readonly string[],
  exchange: string,
  options: { now?: Date; names?: ReadonlyMap<string, string> } = {},
): Promise<ResolveUsQuotesResult> {
  const now = options.now ?? new Date();
  const venue = normalizeUsExchange(exchange);
  const wanted = Array.from(
    new Set(
      symbols.map((s) => s.trim().toUpperCase()).filter((s) => s.length > 0),
    ),
  );

  const quotes = new Map<string, UsQuote>();
  if (venue === null || wanted.length === 0) {
    return { quotes, unresolved: [...wanted] };
  }

  const rt = await readRtQuotes(wanted);

  const eodTargets = wanted.slice(0, US_EOD_FALLBACK_MAX_SYMBOLS);
  const skippedEod = wanted.slice(US_EOD_FALLBACK_MAX_SYMBOLS);
  if (skippedEod.length > 0) {
    // Not decoration. The truncation used to be reported ONLY in a returned
    // field that all three callers destructured away, so a request serving 12
    // of 20 symbols looked, everywhere, exactly like a request for 12. It is
    // now visible twice: here, and by the skipped symbols landing in
    // `unresolved` (they get no bars, and `decideUsQuote` will not build a
    // quote without one).
    logger.warn(
      {
        venue,
        requested: wanted.length,
        cap: US_EOD_FALLBACK_MAX_SYMBOLS,
        skipped: skippedEod.length,
      },
      "[us-quote] EOD fan-out cap reached — the surplus symbols are unresolved",
    );
  }
  const barLists = await mapWithConcurrency(
    eodTargets,
    US_EOD_CONCURRENCY,
    (symbol) => readEodBarsForSymbol(symbol, venue, now),
  );
  const bars = new Map<string, CandleBar[]>();
  eodTargets.forEach((symbol, i) => bars.set(symbol, barLists[i] ?? []));

  const unresolved: string[] = [];
  const nowMs = now.getTime();
  for (const symbol of wanted) {
    const quote = decideUsQuote({
      symbol,
      exchange: venue,
      name: options.names?.get(symbol),
      rt: rt.get(symbol) ?? null,
      bars: bars.get(symbol) ?? [],
      nowMs,
    });
    if (quote) quotes.set(symbol, quote);
    else unresolved.push(symbol);
  }

  return { quotes, unresolved };
}

/**
 * Register page interest in `symbols` so the socket holder subscribes to them.
 *
 * FIRE-AND-FORGET, and that word is doing real work here: this is called from a
 * page render, and a render that throws because Redis blinked would trade a
 * missing live quote for a blank page. Every failure mode — no Redis, a wedged
 * node, a rejected pipeline — resolves to `false`. It NEVER rejects, and
 * `us-quote-interest.test.ts` mutation-checks that by injecting a client whose
 * every method throws.
 *
 * Two commands, in this order:
 *
 *   ZREMRANGEBYSCORE  drop members whose expiry has passed
 *   ZADD              re-score these members to `now + TTL` (a SLIDING window)
 *
 * The prune goes first so a set that has been idle does not carry dead members
 * into the eviction arithmetic the subscription manager runs on the same key.
 * Both ride the ONE shared connection — see the module note.
 */
export async function pingUsSymbolInterest(
  symbols: readonly string[],
  options: { now?: number; ttlMs?: number } = {},
): Promise<boolean> {
  try {
    const members = Array.from(
      new Set(
        symbols
          .map((s) => (typeof s === "string" ? s.trim().toUpperCase() : ""))
          .filter((s) => s.length > 0),
      ),
    );
    if (members.length === 0) return false;

    const client = getRedisClient();
    if (!client) return false;

    const nowMs = options.now ?? Date.now();
    const score = ephemeralExpiryScore(
      nowMs,
      options.ttlMs ?? RT_EPHEMERAL_TTL_MS,
    );

    await client.zremrangebyscore(RT_EPHEMERAL_SET_KEY, "-inf", nowMs);
    const args: (string | number)[] = [];
    for (const member of members) args.push(score, member);
    await client.zadd(RT_EPHEMERAL_SET_KEY, ...args);
    return true;
  } catch (error) {
    // Deliberately swallowed. A subscription hint is not worth a 500.
    logger.warn({ error }, "[us-quote] ephemeral interest ping failed");
    return false;
  }
}
