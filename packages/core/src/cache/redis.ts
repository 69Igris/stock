/**
 * Redis Client Setup — the CANONICAL ioredis singleton for the whole process.
 *
 * Lazy initialisation, graceful fallback when Redis is unavailable, and exactly
 * ONE TCP connection per Node process (per lambda instance on Vercel).
 *
 * MONEY-1127 — this file used to leak sockets on every cold start and then
 * permanently disable L2 for the rest of the lambda's life. Both defects and
 * their fixes are documented at {@link openConnection}.
 *
 * MONEY-1127 (FIX 2) — this is now the ONLY `new Redis(...)` reachable from the
 * apps/web serverless runtime. `apps/web/lib/redis/client.ts` and
 * `packages/core/src/screener/index-constituents.ts` each used to own an
 * independent singleton, so ONE warm lambda held 2-3 connections against a
 * managed node whose documented ceiling is ~50 (`docs/reference/scaling-roadmap.md`).
 * Both now delegate here. Anything in this runtime that needs a raw client must
 * call {@link getRedisClient} — never construct its own.
 *
 * Still holding their own clients, in SEPARATE processes and therefore out of
 * scope here (they add to the same node's connection count and are worth a
 * follow-up): `workers/src/processors/{preview-plan,studio-render}.ts`,
 * `packages/research/src/data-sources/cache.ts`, `apps/content/**` (3 sites),
 * and the standalone `apps/web/scripts/clear-cache.ts` ops script.
 */

import Redis, { type RedisOptions } from "ioredis";
import { cacheLogger as logger } from "@usemoney/logger";

/** Client factory — overridable in tests so no test ever opens a real socket. */
export type RedisClientFactory = (url: string, options: RedisOptions) => Redis;

// ---------------------------------------------------------------------------
// Module state
// ---------------------------------------------------------------------------

/** The one client. Non-null once construction has been attempted. */
let redisClient: Redis | null = null;

/**
 * Single-flight guard for connection ESTABLISHMENT.
 *
 * Deliberately a promise, not a boolean: the pre-fix code set and cleared an
 * `isConnecting` boolean inside the SAME synchronous try/finally, so the flag
 * was already false by the time the TCP+TLS handshake even started (see
 * {@link openConnection}).
 */
let connectionPromise: Promise<Redis | null> | null = null;

/** Consecutive construction attempts in the current round. Reset on connect. */
let connectionAttempts = 0;
/** Wall-clock instant before which no new attempt is made (backoff). */
let cooldownUntil = 0;
/** How many cooldowns we've served in a row — drives exponential backoff. */
let cooldownRounds = 0;

const MAX_CONNECTION_ATTEMPTS = 3;
/** First cooldown after a burst of failures. Doubles per round. */
const RETRY_COOLDOWN_BASE_MS = 5_000;
/** Cap on the backoff so a long outage still self-heals within a minute. */
const RETRY_COOLDOWN_MAX_MS = 60_000;

/** Injectable clock — tests drive the cooldown without real waits. */
let nowFn: () => number = Date.now;

/** Injectable client factory — tests inject a fake so no socket is opened. */
let clientFactory: RedisClientFactory = (url, options) =>
  new Redis(url, options);

/**
 * Test seam: override the clock used for retry backoff.
 * Pass `null` to restore `Date.now`. Production never calls this.
 */
export function __setRedisClockForTests(fn: (() => number) | null): void {
  nowFn = fn ?? Date.now;
}

/**
 * Test seam: override how the ioredis client is constructed, so the connection
 * lifecycle can be exercised with a fake and zero open handles.
 * Pass `null` to restore the real `new Redis(...)`. Production never calls this.
 */
export function __setRedisFactoryForTests(fn: RedisClientFactory | null): void {
  clientFactory = fn ?? ((url, options) => new Redis(url, options));
}

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

/**
 * Get the Redis connection URL from environment.
 *
 * MONEY-1127: `REDIS_HOST` / `REDIS_PORT` / `REDIS_AUTH_STRING` (Google Cloud
 * Memorystore, documented in apps/web/docs/setup/MEMORYSTORE_REDIS_SETUP.md)
 * used to be understood ONLY by the web-local client that this file replaced.
 * They are synthesised into a URL here so folding that client in loses nothing.
 */
function getRedisUrl(): string | undefined {
  const explicit =
    process.env.REDIS_URL ||
    process.env.UPSTASH_REDIS_REST_URL ||
    process.env.KV_URL;
  if (explicit) return explicit;

  const host = process.env.REDIS_HOST;
  const port = process.env.REDIS_PORT;
  if (!host || !port) return undefined;

  const auth = process.env.REDIS_AUTH_STRING;
  return auth
    ? `redis://:${encodeURIComponent(auth)}@${host}:${port}`
    : `redis://${host}:${port}`;
}

/**
 * Check if Redis is configured via environment variables
 */
export function isRedisConfigured(): boolean {
  return !!getRedisUrl();
}

/**
 * ioredis is terminal in exactly one state: `end`. `connecting` /
 * `reconnecting` / `close` are all transient and the client's offline queue
 * still accepts commands, so a client in those states is USABLE and must not be
 * replaced — replacing it is precisely what leaked sockets before MONEY-1127.
 */
function isUsable(client: Redis): boolean {
  return client.status !== "end";
}

/**
 * Tear down a client we are about to drop. Never throws, never orphans a
 * socket: `quit()` first (graceful), `disconnect()` as the fallback.
 *
 * The "error" listener is deliberately left attached — an ioredis client that
 * emits "error" with no listener raises an unhandled 'error' event, which would
 * take the process down.
 */
function disposeClient(client: Redis, reason: string): void {
  logger.warn({ reason, status: client.status }, "Disposing Redis client");
  try {
    void Promise.resolve(client.quit()).catch(() => {
      try {
        client.disconnect();
      } catch {
        /* already gone */
      }
    });
  } catch {
    try {
      client.disconnect();
    } catch {
      /* already gone */
    }
  }
}

/**
 * Initialize Redis client with connection handling
 */
function initRedisClient(redisUrl: string): Redis | null {
  try {
    // DigitalOcean managed Redis uses rediss:// (TLS)
    const useTls = redisUrl.startsWith("rediss://");

    const client = clientFactory(redisUrl, {
      maxRetriesPerRequest: 3,
      ...(useTls && { tls: { rejectUnauthorized: true } }),
      enableReadyCheck: true,
      // Explicit rather than implicit: these are ioredis' own defaults, spelled
      // out because the whole point of this file is that ONE connection has to
      // survive and stay usable while it is still handshaking.
      connectTimeout: 10_000,
      enableOfflineQueue: true,
      // Without this, a command handed to a still-connecting client sits in
      // ioredis' offline queue with NO client-side deadline. Against a
      // black-holed peer (dropped SYN, or TLS that stalls after connect — a
      // firewall or trusted-sources misconfiguration) the queue only flushes
      // after connectTimeout x the retry ladder, ~40s, and every concurrent
      // request piles into the same queue. On Vercel that is a function timeout
      // where the old code merely degraded to DB-only. The cache is fail-open,
      // so a timeout here costs a recompute, never a wrong answer.
      //
      // 8s, not 1-2s: the `discover` universe entries are multi-MB, and a
      // spurious timeout on a healthy-but-large GET would force an expensive
      // recompute. This is a ceiling on pathology, not a latency target.
      commandTimeout: 8_000,
      // Carried over from the web client this replaced — keeps the single
      // long-lived connection from being reaped by an idle middlebox.
      keepAlive: 30_000,
      retryStrategy: (times: number) => {
        if (times > 3) {
          logger.warn({ times }, "Redis retry limit reached");
          return null; // Stop retrying → status becomes "end"
        }
        return Math.min(times * 100, 3000); // Exponential backoff
      },
      reconnectOnError: (err) => {
        const targetErrors = ["READONLY", "ECONNRESET", "ETIMEDOUT"];
        return targetErrors.some((e) => err.message.includes(e));
      },
    });

    client.on("connect", () => {
      logger.debug("Redis socket connected (handshake pending)");
    });

    // "ready", NOT "connect". ioredis emits "connect" the moment the SOCKET is
    // established — before AUTH, SELECT and the ready check. Every failure mode
    // where TCP succeeds and the server then rejects (`max number of clients
    // reached`, WRONGPASS, LOADING, a TLS session that establishes then resets)
    // therefore fires "connect" on EVERY attempt. Resetting the ladder there
    // meant `connectionAttempts` could never reach MAX_CONNECTION_ATTEMPTS, so
    // the cooldown was unreachable and each request built a fresh client — one
    // new TCP connection per request against a node whose ~50-connection
    // ceiling is the entire reason this file exists. "ready" only fires once
    // the server has actually accepted us, which is what "success" has to mean
    // for a backoff ladder guarding connection count.
    client.on("ready", () => {
      logger.info("Redis ready");
      connectionAttempts = 0;
      cooldownUntil = 0;
      cooldownRounds = 0;
    });

    client.on("error", (err) => {
      logger.error({ error: err.message }, "Redis error");
    });

    client.on("close", () => {
      logger.debug("Redis connection closed");
    });

    return client;
  } catch (error) {
    logger.error({ error }, "Failed to initialize Redis client");
    return null;
  }
}

// ---------------------------------------------------------------------------
// Connection establishment (single-flight + bounded retry)
// ---------------------------------------------------------------------------

/**
 * The attempt budget for this round is spent. Arm an exponential cooldown and
 * report that L2 is off until it elapses.
 *
 * Called lazily, at the moment a caller would otherwise exceed the budget, so
 * it covers BOTH failure shapes: construction threw, and construction
 * succeeded but the client later reached the terminal `end` state.
 */
function armCooldown(): void {
  const backoff = Math.min(
    RETRY_COOLDOWN_BASE_MS * 2 ** cooldownRounds,
    RETRY_COOLDOWN_MAX_MS,
  );
  cooldownUntil = nowFn() + backoff;
  cooldownRounds++;
  logger.warn(
    { attempts: connectionAttempts, backoffMs: backoff },
    "Redis connection attempts exhausted - backing off (L2 disabled until cooldown elapses)",
  );
}

/**
 * Establish (or reuse) the process-wide connection.
 *
 * ## The bug this replaces (MONEY-1127)
 *
 * The old getter was:
 *
 * ```
 * if (redisClient?.status === "ready") return redisClient;   // only when READY
 * if (isConnecting) return null;
 * if (connectionAttempts >= MAX) return null;                // forever
 * isConnecting = true;
 * try { redisClient = initRedisClient(); return redisClient; }
 * finally { isConnecting = false; }                          // same tick!
 * ```
 *
 * 1. **Connection storm.** `isConnecting` was set and cleared inside the same
 *    synchronous try/finally, so it never spanned the ~50-300ms TCP+TLS
 *    handshake. Every concurrent caller during that window saw
 *    `status !== "ready"` and `isConnecting === false`, built a BRAND-NEW
 *    ioredis client, overwrote the module variable, and orphaned the previous
 *    one — which was never `quit()`ed. Up to MAX_CONNECTION_ATTEMPTS leaked
 *    sockets per cold start, against a node whose ceiling is ~50 connections.
 *
 * 2. **Permanent dead end.** Once `connectionAttempts` hit MAX the getter
 *    returned `null` for the rest of the lambda's life — L2 silently off, with
 *    only the `connect` event (which can no longer fire) able to reset it. That
 *    dead end was load-bearing enough that `brokers/oauth-state.ts` had to be
 *    rewritten to fail CLOSED because of it.
 *
 * ## The fix
 *
 * Two guards, in order:
 *
 * 1. `redisClient` is handed back as soon as it EXISTS and is not terminal —
 *    not once it is `"ready"`. ioredis offline-queues commands issued while
 *    connecting, so a connecting client is already usable; demanding `"ready"`
 *    was the entire reason a second client got built. This is what
 *    `apps/web/lib/redis/client.ts` already did correctly (`if (redisClient)
 *    return redisClient`) before the two copies diverged.
 * 2. `connectionPromise` — anything arriving while establishment is in flight
 *    awaits THIS promise rather than starting its own. A promise (unlike the
 *    old boolean) survives across await points, so the guard still holds if
 *    establishment ever becomes genuinely async.
 *
 * The permanent dead end becomes a bounded, self-healing ladder: MAX attempts,
 * then an exponential cooldown (5s → 10s → … → 60s cap) after which a fresh
 * attempt is allowed. A transient startup failure no longer disables L2 for the
 * lambda's life.
 *
 * NEVER throws and NEVER rejects — a cache miss must fail open (return null so
 * the caller computes), never surface into a request path.
 */
function openConnection(): Promise<Redis | null> {
  // --- Guard 1: reuse the live client, connecting or not. ------------------
  const current = redisClient;
  if (current) {
    if (isUsable(current)) return Promise.resolve(current);
    // Terminal client. Drop it (and any stale in-flight promise) and rebuild.
    disposeClient(current, "client reached terminal 'end' state");
    redisClient = null;
    connectionPromise = null;
  }

  // --- Guard 2: single-flight. --------------------------------------------
  if (connectionPromise) return connectionPromise;

  const redisUrl = getRedisUrl();
  if (!redisUrl) {
    // Not configured is NOT a failure — it must not consume the retry budget.
    logger.debug("Redis URL not configured - using memory cache only");
    return Promise.resolve(null);
  }

  // --- Bounded retry with backoff (replaces the permanent null). -----------
  if (connectionAttempts >= MAX_CONNECTION_ATTEMPTS) {
    if (cooldownUntil === 0) {
      // First caller to exceed the budget arms the backoff.
      armCooldown();
      return Promise.resolve(null);
    }
    if (nowFn() < cooldownUntil) {
      logger.debug("Redis connection cooling down - skipping attempt");
      return Promise.resolve(null);
    }
    // Cooldown elapsed → start a fresh round.
    connectionAttempts = 0;
    cooldownUntil = 0;
  }
  connectionAttempts++;

  const promise = Promise.resolve<Redis | null>(
    (() => {
      const client = initRedisClient(redisUrl);
      if (client) redisClient = client;
      return client;
    })(),
  );

  connectionPromise = promise;
  // Release the single-flight slot once establishment settles. `.catch` keeps
  // a sync-only caller from ever producing an unhandled rejection.
  void promise
    .catch(() => null)
    .then(() => {
      if (connectionPromise === promise) connectionPromise = null;
    });

  return promise;
}

/**
 * Get or create the Redis client instance (synchronous).
 *
 * Returns null when:
 * - Redis is not configured (no URL / host+port env)
 * - Construction failed
 * - We are inside a retry cooldown after a burst of failures
 *
 * A client that is still connecting IS returned — ioredis queues commands
 * until the handshake completes. Callers must keep wrapping commands in
 * try/catch and treating a failure as a cache miss (fail-open).
 */
export function getRedisClient(): Redis | null {
  const current = redisClient;
  if (current && isUsable(current)) return current;

  // Establishment is synchronous today, so `redisClient` is already assigned
  // when this returns; the promise is the guard for concurrent callers.
  void openConnection();

  return redisClient && isUsable(redisClient) ? redisClient : null;
}

/**
 * Async counterpart of {@link getRedisClient}: concurrent callers await the
 * SAME establishment promise, so exactly one client is ever constructed.
 * Resolves to null (never rejects) when Redis is unavailable.
 */
export function getRedisClientAsync(): Promise<Redis | null> {
  return openConnection();
}

/**
 * Close the Redis connection (for cleanup)
 */
export async function closeRedisConnection(): Promise<void> {
  const client = redisClient;
  // Clear state FIRST so a concurrent getRedisClient() never hands out a
  // client we are in the middle of quitting.
  redisClient = null;
  connectionPromise = null;
  connectionAttempts = 0;
  cooldownUntil = 0;
  cooldownRounds = 0;

  if (!client) return;

  try {
    await client.quit();
    logger.info("Redis connection closed");
  } catch (error) {
    logger.error({ error }, "Error closing Redis connection");
    try {
      client.disconnect();
    } catch {
      /* already gone */
    }
  }
}

/**
 * Reset connection state (for testing).
 *
 * Synchronous, and disposes any live client rather than orphaning its socket.
 */
export function resetRedisClient(): void {
  const client = redisClient;
  redisClient = null;
  connectionPromise = null;
  connectionAttempts = 0;
  cooldownUntil = 0;
  cooldownRounds = 0;
  if (client) {
    try {
      client.disconnect();
    } catch {
      /* already gone */
    }
  }
}

/**
 * Check if Redis is currently connected (handshake complete).
 */
export function isRedisConnected(): boolean {
  return redisClient?.status === "ready";
}
