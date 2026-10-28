/**
 * Symbol-keyed quote cache — pure logic (MONEY-1124).
 *
 * `/api/market/quote` used to go live to Yahoo on EVERY request while the UI
 * polled it every 5 seconds (`useLivePositions`), uncached, with
 * `dynamic = "force-dynamic"` + `revalidate = 0`. This module holds the
 * resolution order that replaces that:
 *
 *   shared cache (per symbol, ~15s)  →  LatestQuote DB rows (~60s)  →  Yahoo
 *
 * Everything here is side-effect free: all I/O arrives through the
 * {@link QuoteCachePorts} seam, so the partitioning, the budget arithmetic and
 * the freshness accounting are unit-testable with no Redis, no Prisma and no
 * network. `./quote-cache.ts` supplies the production ports.
 *
 * ── Why per SYMBOL and not per symbol-set ────────────────────────────────
 * A cache keyed on the requested set would never hit: every user holds a
 * different basket, and adding one holding invalidates the whole entry. Keyed
 * per symbol, the 40 users holding RELIANCE share one entry, and a partially
 * warm basket only refetches the symbols that actually went stale.
 *
 * ── Why cross-user caching is licence-safe ───────────────────────────────
 * The only provider in the chain is Yahoo, whose `isPublic` flag is `true`
 * (exchange-delayed, not user-specific) — see
 * `lib/market/providers/quote-providers.ts`. A per-user/broker provider added
 * later must be `isPublic:false` and must NOT flow through this module.
 *
 * @see apps/web/__tests__/market/quote-cache-logic.test.ts
 */

// ─── Constants ───────────────────────────────────────────────────────

/**
 * Shared-cache lifetime for one symbol's quote, in milliseconds.
 *
 * 15s is chosen against the two consumers that poll this data:
 *   - `hooks/useLivePositions.ts` polls `/api/market/quote` every 5s;
 *   - `hooks/useMarketData.ts` polls it every 10s by default.
 * So one upstream resolution serves 3 (resp. 1–2) polls. Dropping to 5s would
 * make the cache almost a no-op for the fastest poller; raising it to 60s would
 * make a "live" tile visibly freeze — three consecutive ticks showing the exact
 * same paise is a product bug, not a perf win.
 *
 * The honesty argument for 15s: Yahoo's NSE/BSE feed is itself exchange-delayed
 * by ~15 minutes, and every surface that renders it carries the
 * `DelayedDataNote` disclaimer. A 15s cache adds ~1.7% to an already ~900s
 * delay — it cannot turn a number a user could act on into a stale one. A
 * 60s+ cache would start to be a meaningful fraction of the tick cadence users
 * actually watch, which is why it is deliberately NOT set there.
 */
export const QUOTE_CACHE_TTL_MS = 15_000;

/** Same TTL in seconds — the unit `CacheConfig.ttl` uses. */
export const QUOTE_CACHE_TTL_SECONDS = QUOTE_CACHE_TTL_MS / 1000;

/**
 * Whole-request time budget for the quote route, in milliseconds.
 *
 * Before this, one request could stack `MAX_RETRIES=3` attempts of a
 * `FETCH_TIMEOUT_MS=15_000` fetch with 1s/2s/4s backoff — ~67s of wall clock
 * per chunk, all of it while the user's tab sat on a spinner. The budget makes
 * that unreachable: whatever has resolved by the deadline is returned, and the
 * route keeps its existing fail-open contract (missing symbols are simply
 * absent from `data`, exactly as they are today when Yahoo errors).
 */
export const QUOTE_REQUEST_BUDGET_MS = 8_000;

/** Slice of the budget the LatestQuote DB read-through may consume. */
export const QUOTE_DB_BUDGET_MS = 4_000;

/** Slice of the budget reserved for writing resolved quotes back to the cache. */
export const QUOTE_CACHE_WRITE_BUDGET_MS = 1_000;

// ─── Types ───────────────────────────────────────────────────────────

/**
 * What one symbol's cache entry stores.
 *
 * `key` is carried explicitly rather than recomputed on read: the response key
 * for a request symbol is NOT always its uppercase form (index aliases resolve
 * through `toYahooSymbol`, so a request for `NIFTY` is emitted under `^NSEI`).
 * Storing it keeps a cache hit byte-identical to a live fetch.
 */
export interface CachedQuoteEnvelope<TQuote> {
  quote: TQuote;
  /** Response key this quote is emitted under. */
  key: string;
  /** Epoch ms at which this envelope was written to the shared cache. */
  cachedAt: number;
  /** Provider that produced the quote (always "yahoo" today). */
  source: string;
}

/** All I/O the resolver performs, injected so the logic stays pure. */
export interface QuoteCachePorts<TQuote> {
  /** Shared-cache read, keyed by REQUEST symbol. Must never throw. */
  readCache(
    symbols: string[]
  ): Promise<Map<string, CachedQuoteEnvelope<TQuote>>>;
  /** Shared-cache write. Must never throw. */
  writeCache(
    entries: Array<{ symbol: string; envelope: CachedQuoteEnvelope<TQuote> }>
  ): Promise<void>;
  /** LatestQuote DB read-through, keyed by REQUEST symbol. Must never throw. */
  readDb(symbols: string[]): Promise<Map<string, TQuote>>;
  /** Upstream provider chain, keyed by RESPONSE key. Must never throw. */
  readUpstream(
    symbols: string[]
  ): Promise<{ quotes: Map<string, TQuote>; source: string }>;
  /** Response key a request symbol is emitted under. Pure. */
  responseKey(symbol: string): string;
  /** Market timestamp carried by a quote, epoch ms (null when unusable). */
  quotedAtMs(quote: TQuote): number | null;
  /** Injected clock. */
  now(): number;
}

export interface QuoteCacheResult<TQuote> {
  /** Response payload, keyed exactly as a live fetch would key it. */
  quotes: Record<string, TQuote>;
  source: string;
  /** Request symbols served from the shared cache (no DB, no network). */
  cacheHits: string[];
  /** Request symbols served from the LatestQuote DB rows. */
  dbHits: string[];
  /** Request symbols that required an upstream (Yahoo) call. */
  upstreamHits: string[];
  /** Request symbols nothing could resolve — absent from `quotes` (fail-open). */
  unresolved: string[];
  /**
   * Oldest MARKET timestamp across the returned quotes, epoch ms.
   *
   * This is the honest "as of" for the payload: it is the exchange time the
   * most-stale price in the response was quoted at, NOT the time the response
   * was assembled. Never derive freshness from the envelope's `timestamp`.
   */
  asOfMs: number | null;
  /** True when at least one quote came from the shared cache. */
  fromCache: boolean;
  /** True when the time budget cut a step short and results may be partial. */
  partial: boolean;
}

// ─── Helpers ─────────────────────────────────────────────────────────

/**
 * De-duplicate request symbols preserving first-seen order.
 *
 * Deliberately EXACT-string (not case-folded): `toYahooSymbol` passes an
 * already-suffixed symbol through verbatim, so `reliance.NS` and `RELIANCE.NS`
 * are emitted under different response keys today. Folding them here would
 * silently change the payload shape for those callers.
 */
export function dedupeSymbols(symbols: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const s of symbols) {
    if (!s || seen.has(s)) continue;
    seen.add(s);
    out.push(s);
  }
  return out;
}

/** Cache identifier for one symbol on one exchange. */
export function quoteCacheIdentifier(exchange: string, symbol: string): string {
  return `q:${exchange}:${symbol}`;
}

/**
 * A cache envelope is fresh while STRICTLY less than `ttlMs` has elapsed.
 * Matches `quote-logic.ts#isFresh` so the two cache layers agree on the
 * boundary. A future `cachedAt` (clock skew between instances) counts as
 * fresh — the same convention the DB layer uses.
 */
export function isEnvelopeFresh(
  envelope: { cachedAt: number },
  nowMs: number,
  ttlMs: number
): boolean {
  if (!Number.isFinite(envelope.cachedAt)) return false;
  return nowMs - envelope.cachedAt < ttlMs;
}

/**
 * Split the requested symbols into shared-cache hits and the subset that still
 * needs resolving. Only FRESH envelopes count as hits — a stale entry is
 * treated exactly like a miss (it is never served, and never merged in as a
 * fallback, because a stale price rendered as live is the failure mode that
 * matters on this surface).
 */
export function partitionBySymbolCache<TQuote>(
  symbols: readonly string[],
  cached: ReadonlyMap<string, CachedQuoteEnvelope<TQuote>>,
  nowMs: number,
  ttlMs: number
): { hits: Map<string, CachedQuoteEnvelope<TQuote>>; missing: string[] } {
  const hits = new Map<string, CachedQuoteEnvelope<TQuote>>();
  const missing: string[] = [];

  for (const symbol of symbols) {
    const envelope = cached.get(symbol);
    if (envelope && isEnvelopeFresh(envelope, nowMs, ttlMs)) {
      hits.set(symbol, envelope);
    } else {
      missing.push(symbol);
    }
  }

  return { hits, missing };
}

/** Normalise a Date / ISO string / epoch number into epoch ms (null if unusable). */
export function toEpochMs(value: unknown): number | null {
  if (value instanceof Date) {
    const ms = value.getTime();
    return Number.isFinite(ms) ? ms : null;
  }
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : null;
  }
  if (typeof value === "string") {
    const ms = Date.parse(value);
    return Number.isFinite(ms) ? ms : null;
  }
  return null;
}

/**
 * Race `promise` against `budgetMs`, resolving to `fallback` if the budget
 * elapses first.
 *
 * Two hygiene details this exists for:
 *   1. the timer is ALWAYS cleared, so a fast path never leaves a pending
 *      handle behind (leaked timers are how this suite orphans);
 *   2. the raced promise is pre-caught, so a late rejection after the budget
 *      fired can't surface as an unhandled rejection.
 */
export function withBudget<T>(
  promise: Promise<T>,
  budgetMs: number,
  fallback: T
): Promise<{ value: T; timedOut: boolean }> {
  const guarded = promise.then(
    (value) => ({ value, timedOut: false }),
    () => ({ value: fallback, timedOut: false })
  );

  if (!Number.isFinite(budgetMs) || budgetMs <= 0) {
    return Promise.resolve({ value: fallback, timedOut: true });
  }

  // NB: deliberately NOT unref'd. This timer is the only thing that can settle
  // the race when the wrapped promise hangs, so unref'ing it would let the
  // process (or a test's event loop) drain out from under a pending budget.
  // It is always cleared in the `finally` below, so it can never outlive the
  // race either way.
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expiry = new Promise<{ value: T; timedOut: boolean }>((resolve) => {
    timer = setTimeout(
      () => resolve({ value: fallback, timedOut: true }),
      budgetMs
    );
  });

  return Promise.race([guarded, expiry]).finally(() => {
    if (timer !== undefined) clearTimeout(timer);
  });
}

// ─── Resolver ────────────────────────────────────────────────────────

/**
 * Resolve quotes for `symbols` through cache → DB → upstream, inside a total
 * wall-clock budget.
 *
 * Contract notes for reviewers:
 *   - FAIL-OPEN is preserved. A symbol nothing could resolve is simply absent
 *     from `quotes` (it lands in `unresolved`); no step throws.
 *   - Nothing STALE is ever served. Only fresh cache envelopes are hits; the
 *     DB layer applies its own TTL internally. `asOfMs` reports the oldest
 *     market timestamp actually returned so callers can be honest about it.
 *   - Cache writes are best-effort and budgeted; failing to write only costs a
 *     later miss.
 */
export async function resolveQuotesCached<TQuote>(
  symbols: readonly string[],
  ports: QuoteCachePorts<TQuote>,
  options: {
    ttlMs?: number;
    budgetMs?: number;
    dbBudgetMs?: number;
    writeBudgetMs?: number;
    /** Source reported when nothing resolved (matches the provider chain tail). */
    fallbackSource?: string;
    /**
     * Serve from `LatestQuote` before going upstream. OFF by default: those rows
     * carry no pe/eps/week52High/week52Low, so the result is a strictly smaller
     * quote than the upstream one. See step 2.
     */
    enableDbLeg?: boolean;
  } = {}
): Promise<QuoteCacheResult<TQuote>> {
  const {
    ttlMs = QUOTE_CACHE_TTL_MS,
    budgetMs = QUOTE_REQUEST_BUDGET_MS,
    dbBudgetMs = QUOTE_DB_BUDGET_MS,
    writeBudgetMs = QUOTE_CACHE_WRITE_BUDGET_MS,
    fallbackSource = "yahoo",
    // Defaults OFF — a DB-served quote is a smaller shape than a Yahoo one.
    // See the long note on step 2 before turning this on for any caller.
    enableDbLeg = false,
  } = options;

  const requested = dedupeSymbols(symbols);
  const startedAt = ports.now();
  const deadline = startedAt + budgetMs;
  const remaining = () => deadline - ports.now();

  const quotes: Record<string, TQuote> = {};
  const cacheHits: string[] = [];
  const dbHits: string[] = [];
  const upstreamHits: string[] = [];
  const fresh: Array<{
    symbol: string;
    envelope: CachedQuoteEnvelope<TQuote>;
  }> = [];
  let source = fallbackSource;
  let partial = false;

  if (requested.length === 0) {
    return {
      quotes,
      source,
      cacheHits,
      dbHits,
      upstreamHits,
      unresolved: [],
      asOfMs: null,
      fromCache: false,
      partial: false,
    };
  }

  // 1. Shared cache. Budgeted like everything else — a wedged Redis must not be
  //    slower than the network call it was added to avoid.
  const cacheRead = await withBudget(
    ports.readCache(requested),
    Math.min(remaining(), budgetMs),
    new Map<string, CachedQuoteEnvelope<TQuote>>()
  );
  partial = partial || cacheRead.timedOut;

  const { hits, missing } = partitionBySymbolCache(
    requested,
    cacheRead.value,
    ports.now(),
    ttlMs
  );

  for (const [symbol, envelope] of hits) {
    quotes[envelope.key] = envelope.quote;
    cacheHits.push(symbol);
    source = envelope.source || source;
  }

  let outstanding = missing;

  // 2. LatestQuote DB rows. A warm DB serves the request with no external call
  //    at all — and one user's refresh warms it for everybody.
  //
  //    OPT-IN ONLY (`enableDbLeg`), and off for /api/market/quote. The
  //    `latest_quotes` collection has no `pe`, `eps`, `week52High` or
  //    `week52Low` column, so a DB-served quote is a strictly SMALLER shape
  //    than a Yahoo one. Serving it from the general quote route blanked four
  //    of the eight tiles on every stock page — and worse, they would flicker
  //    back whenever the upstream leg happened to answer, which reads as a
  //    glitch rather than missing data. `name` also degrades from Yahoo's
  //    `shortName` to `InstrumentMapping.name`, which the paper-trading and
  //    watchlist views render.
  //
  //    The 15s symbol cache above already carries the FULL Yahoo shape, so the
  //    polling win (a 5s poller costs one upstream fetch per 15s) survives
  //    without this leg. Re-enable it only for a caller that provably needs
  //    just the price fields — or after `LatestQuote` grows the missing
  //    columns, at which point this comment should be deleted, not amended.
  if (enableDbLeg && outstanding.length > 0 && remaining() > 0) {
    const dbRead = await withBudget(
      ports.readDb(outstanding),
      Math.min(remaining(), dbBudgetMs),
      new Map<string, TQuote>()
    );
    partial = partial || dbRead.timedOut;

    const stillMissing: string[] = [];
    for (const symbol of outstanding) {
      const quote = dbRead.value.get(symbol);
      if (quote === undefined) {
        stillMissing.push(symbol);
        continue;
      }
      const key = ports.responseKey(symbol);
      quotes[key] = quote;
      dbHits.push(symbol);
      fresh.push({
        symbol,
        envelope: { quote, key, cachedAt: ports.now(), source: fallbackSource },
      });
    }
    outstanding = stillMissing;
  }

  // 3. Upstream (Yahoo) for whatever the DB could not answer.
  if (outstanding.length > 0 && remaining() > 0) {
    const upstream = await withBudget(
      ports.readUpstream(outstanding),
      remaining(),
      { quotes: new Map<string, TQuote>(), source: fallbackSource }
    );
    partial = partial || upstream.timedOut;

    const stillMissing: string[] = [];
    for (const symbol of outstanding) {
      const key = ports.responseKey(symbol);
      const quote = upstream.value.quotes.get(key);
      if (quote === undefined) {
        stillMissing.push(symbol);
        continue;
      }
      quotes[key] = quote;
      upstreamHits.push(symbol);
      fresh.push({
        symbol,
        envelope: {
          quote,
          key,
          cachedAt: ports.now(),
          source: upstream.value.source,
        },
      });
    }
    if (upstreamHits.length > 0) source = upstream.value.source;
    outstanding = stillMissing;
  } else if (outstanding.length > 0) {
    partial = true;
  }

  // 4. Write back everything newly resolved. Best-effort: a failed write only
  //    costs the next request a miss.
  if (fresh.length > 0) {
    await withBudget(
      ports.writeCache(fresh),
      Math.max(remaining(), writeBudgetMs),
      undefined
    );
  }

  // 5. Honest freshness: the OLDEST market timestamp in the payload.
  let asOfMs: number | null = null;
  for (const quote of Object.values(quotes)) {
    const ms = ports.quotedAtMs(quote);
    if (ms === null) continue;
    if (asOfMs === null || ms < asOfMs) asOfMs = ms;
  }

  return {
    quotes,
    source,
    cacheHits,
    dbHits,
    upstreamHits,
    unresolved: outstanding,
    asOfMs,
    fromCache: cacheHits.length > 0,
    partial,
  };
}
