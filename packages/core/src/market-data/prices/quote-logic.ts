/**
 * Quote Service — Pure Logic
 *
 * Pure, side-effect-free helpers used by `quote-service.ts` for cache freshness
 * and the MongoDB write-conflict retry control-flow. Extracted so the exact
 * retry/backoff and freshness logic that production runs can be unit-tested
 * without a database.
 *
 * `quote-service.ts` imports and calls these — no parallel copies.
 */

// ─── Constants ───────────────────────────────────────────────────────

export const DEFAULT_QUOTE_TTL_MS = 60 * 1000; // 60 seconds
export const UPSERT_MAX_RETRIES = 3;
export const REFRESH_MAX_RETRIES = 5;
export const UPSERT_BACKOFF_BASE_MS = 150;
export const REFRESH_BACKOFF_BASE_MS = 200;

/**
 * Max ids per `{ in: [...] }` predicate (MONEY-704).
 *
 * MongoDB's practical `$in` ceiling is far higher (the 16MB BSON document
 * limit), but a 500-id cap keeps the query document small, keeps the planner
 * on an index scan, and bounds the memory a single call can pin. Call sites
 * whose id list can exceed this chunk with {@link chunkIds} and merge — they
 * must NOT fall back to reading the whole collection.
 */
export const ID_QUERY_CHUNK_SIZE = 500;

/**
 * Concurrency for the per-symbol `latestQuote.upsert` fan-out (MONEY-1124).
 *
 * Enough parallelism to stop a 50-symbol refresh serialising 50 round trips,
 * while leaving the connection pool room to serve the rest of the request.
 *
 * 5, not 25: `packages/database/client.ts` pins `maxPoolSize=10` for serverless,
 * so a batch of 25 would ask for 2.5x the whole instance's pool — saturating it
 * and queueing every other query on that lambda, including the broker-status
 * read running in the SAME `Promise.all` as this refresh. The original comment
 * here claimed 25 was "small enough that one request cannot exhaust the Prisma
 * connection pool"; it was inverted. Half the pool is the most one background
 * fan-out should ever claim.
 */
export const UPSERT_BATCH_SIZE = 5;

// ─── Bounded id queries ──────────────────────────────────────────────

/**
 * Split an id list into `size`-length chunks. Returns `[]` for an empty input
 * so callers can `if (!chunks.length) return` without issuing a query.
 */
export function chunkIds<T>(
  ids: readonly T[],
  size: number = ID_QUERY_CHUNK_SIZE,
): T[][] {
  if (size <= 0) throw new RangeError("chunkIds: size must be > 0");
  const chunks: T[][] = [];
  for (let i = 0; i < ids.length; i += size) {
    chunks.push(ids.slice(i, i + size));
  }
  return chunks;
}

/**
 * Run a bounded `{ in: ids }` query over an arbitrarily long id list by
 * chunking it and concatenating the results.
 *
 * This exists so "the list might be huge" is never an excuse to read a whole
 * collection into Node and `.filter()` it down — the failure mode MONEY-704
 * was opened for. Chunks run sequentially so a 10k-id list cannot open 20
 * simultaneous cursors.
 */
export async function queryByIdChunks<TId, TRow>(
  ids: readonly TId[],
  run: (chunk: TId[]) => Promise<TRow[]>,
  size: number = ID_QUERY_CHUNK_SIZE,
): Promise<TRow[]> {
  const chunks = chunkIds(ids, size);
  if (chunks.length === 0) return [];
  if (chunks.length === 1) return run(chunks[0]!);

  const rows: TRow[] = [];
  for (const chunk of chunks) {
    rows.push(...(await run(chunk)));
  }
  return rows;
}

// ─── Freshness ───────────────────────────────────────────────────────

/**
 * A cached entry is fresh while STRICTLY less than `ttlMs` has elapsed since
 * `updatedAt`. At exactly `ttlMs` the entry is considered stale.
 *
 * Accepts an injectable `now` (defaults to Date.now()) so the boundary can be
 * tested deterministically; production callers omit it.
 */
export function isFresh(
  updatedAt: Date,
  ttlMs: number,
  now: number = Date.now(),
): boolean {
  return now - updatedAt.getTime() < ttlMs;
}

/**
 * Decide whether a cached quote must be (re)fetched from the upstream API.
 * A null cache always fetches; otherwise fetch exactly when it is no longer
 * fresh. Mirrors the `cached && isFresh(...)` guard in `getLatestQuote`.
 */
export function shouldFetchFromApi(
  cachedQuote: { updatedAt: Date } | null,
  ttlMs: number,
  now: number | Date = Date.now(),
): boolean {
  if (!cachedQuote) return true;
  const nowMs = typeof now === "number" ? now : now.getTime();
  return !isFresh(cachedQuote.updatedAt, ttlMs, nowMs);
}

// ─── Write-conflict retry ────────────────────────────────────────────

/** True for MongoDB transient write-conflict / deadlock errors (case-sensitive). */
export function isWriteConflictError(error: unknown): boolean {
  const msg = error instanceof Error ? error.message : "";
  return msg.includes("write conflict") || msg.includes("deadlock");
}

/** Base backoff (ms, pre-jitter) for a given 1-based attempt. */
export function calcBackoff(baseMs: number, attempt: number): number {
  return baseMs * Math.pow(2, attempt - 1);
}

export interface WriteConflictRetryOptions {
  maxRetries: number;
  backoffBaseMs: number;
  /** Injected sleeper (defaults to setTimeout); override in tests to avoid waits. */
  sleep?: (ms: number) => Promise<void>;
  /** Injected jitter source in [0,1) (defaults to Math.random). */
  random?: () => number;
}

export interface WriteConflictRetryResult {
  success: boolean;
  attempts: number;
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Run `fn` with up to `maxRetries` attempts, retrying ONLY on transient
 * write-conflict/deadlock errors with exponential backoff + jitter. Any other
 * error is rethrown immediately. Returns `{ success, attempts }`; on exhausted
 * write-conflicts it resolves with `success: false` (does NOT throw) — this
 * mirrors the single-quote upsert loop in `getLatestQuotes`.
 */
export async function runWithWriteConflictRetry(
  fn: () => Promise<unknown>,
  options: WriteConflictRetryOptions,
): Promise<WriteConflictRetryResult> {
  const {
    maxRetries,
    backoffBaseMs,
    sleep = defaultSleep,
    random = Math.random,
  } = options;

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      await fn();
      return { success: true, attempts: attempt };
    } catch (error) {
      const conflict = isWriteConflictError(error);
      if (conflict && attempt < maxRetries) {
        const delay = calcBackoff(backoffBaseMs, attempt) + random() * 100;
        await sleep(delay);
        continue;
      }
      if (!conflict) throw error;
      // Exhausted write-conflict retries — fall through to the failure result.
    }
  }
  return { success: false, attempts: maxRetries };
}
