/* =====================================================================
   Stale-while-error caching  (MONEY-1092)
   ---------------------------------------------------------------------
   Two failure modes killed the discover heatmap, and neither is solved
   by a plain get/compute/set:

   1. THUNDERING HERD. `getCached`/`setCached` are bare reads and writes
      with no coordination. When a short-TTL key expires, every
      concurrent request recomputes it — so an expensive query gets N
      simultaneous executions at exactly the moment the database is
      already slowest. `withCache` has a single-flight registry, but it
      derives its cache key from `args[0]` as a userId, which does not
      fit a global (user-independent) market key.

   2. ALL-OR-NOTHING FAILURE. One slow query turned into a full-page
      "Failed to load market heatmap", discarding a perfectly good copy
      that was correct sixty seconds earlier. For market aggregates a
      slightly old number beats no number — the standing rule is that a
      surface degrades, it does not dead-end.

   The fix is one primitive with two cache entries per logical key:
     - the FRESH entry, short TTL, the thing we serve normally;
     - the LAST-GOOD entry, long TTL, written on every success and read
       only when a recompute fails.

   `resolveWithStaleFallback` holds the decision logic and takes its I/O
   as ports, so the whole state machine is unit-testable with plain
   in-memory fakes and no Redis. `cachedWithStaleFallback` binds those
   ports to the real cache client.
   ===================================================================== */

import { getCached, setCached } from "./wrapper";
import type { CacheModule } from "@usemoney/cache";

/** A cached value plus when it was computed, so a stale serve can say so. */
export interface Stamped<T> {
  value: T;
  /** Epoch ms at which `value` was successfully computed. */
  computedAt: number;
}

/**
 * What a resolve produced.
 *
 * `stale` is deliberately distinct from `fresh` rather than a boolean on
 * one shape: the caller has to decide what to render, and collapsing the
 * two is how "showing yesterday's number" silently becomes "showing the
 * number".
 */
export type ResolveOutcome<T> =
  | { status: "fresh"; data: T }
  | { status: "stale"; data: T; computedAt: number; error: unknown }
  | { status: "failed"; error: unknown };

export interface StaleWhileErrorPorts<T> {
  /** Read the short-TTL entry. */
  readFresh: () => Promise<T | null>;
  /** Read the long-TTL last-known-good entry. */
  readLastGood: () => Promise<Stamped<T> | null>;
  /** Write the short-TTL entry. Must not throw. */
  writeFresh: (value: T) => Promise<void>;
  /** Write the long-TTL entry. Must not throw. */
  writeLastGood: (stamped: Stamped<T>) => Promise<void>;
  /** The expensive operation. May throw. */
  compute: () => Promise<T>;
  /** Injected for deterministic tests. */
  now: () => number;
  /**
   * Classify a thrown error as PERMANENT — an answer, not an outage.
   *
   * Stale-fallback exists for transient failures: the data was right a
   * minute ago and the database is briefly unavailable, so old numbers beat
   * no numbers. That reasoning inverts for a permanent answer. "This sector
   * has no instruments" is not a blip; serving a last-good copy would
   * resurrect a sector that no longer exists and keep resurrecting it for
   * the whole 24h fallback window.
   *
   * Returning true skips the fallback entirely and surfaces the error.
   * Defaults to treating every error as transient, which is the safe
   * default for callers that have no such distinction.
   */
  isPermanentError?: (error: unknown) => boolean;
}

/**
 * Core state machine: fresh hit → serve; miss → compute; compute failed →
 * serve last-good if we have one, else report the failure.
 *
 * Cache WRITES are never allowed to fail the request. A Redis blip while
 * persisting a value we already computed should not turn a successful
 * response into an error, so both writes are swallowed. Cache READS are
 * likewise defensive: a read that throws is treated as a miss.
 */
export async function resolveWithStaleFallback<T>(
  ports: StaleWhileErrorPorts<T>,
): Promise<ResolveOutcome<T>> {
  try {
    const fresh = await ports.readFresh();
    if (fresh !== null && fresh !== undefined) {
      return { status: "fresh", data: fresh };
    }
  } catch {
    // A failed cache read is a miss, not an error — fall through and
    // compute. Never let the cache layer be the reason a page breaks.
  }

  try {
    const value = await ports.compute();
    const stamped: Stamped<T> = { value, computedAt: ports.now() };
    // Write last-good FIRST. If the process dies between the two writes
    // we would rather have a usable fallback than a fresh entry with no
    // safety net behind it.
    await swallow(() => ports.writeLastGood(stamped));
    await swallow(() => ports.writeFresh(value));
    return { status: "fresh", data: value };
  } catch (error) {
    // A permanent answer must never be masked by a stale copy — see
    // `isPermanentError`. Report it immediately.
    if (ports.isPermanentError?.(error)) {
      return { status: "failed", error };
    }

    let lastGood: Stamped<T> | null = null;
    try {
      lastGood = await ports.readLastGood();
    } catch {
      lastGood = null;
    }
    if (lastGood) {
      return {
        status: "stale",
        data: lastGood.value,
        computedAt: lastGood.computedAt,
        error,
      };
    }
    return { status: "failed", error };
  }
}

async function swallow(fn: () => Promise<void>): Promise<void> {
  try {
    await fn();
  } catch {
    /* cache writes are best-effort by design — see above */
  }
}

/* ---------------------------------------------------------------------
   In-process single-flight
   ------------------------------------------------------------------ */

/**
 * Concurrent resolves of the SAME key within one instance share a single
 * execution. This is per-instance, not distributed — which is the right
 * scope here: it removes the N-way self-inflicted pile-up a single Vercel
 * lambda causes on a cold key, and the short TTL bounds cross-instance
 * duplication to at most one compute per instance per window.
 *
 * The entry is deleted in a `finally` so a rejected compute never
 * poisons the key for subsequent callers.
 */
const inFlight = new Map<string, Promise<unknown>>();

/**
 * How long any caller — leader or follower — will wait on a shared flight
 * before giving up (MONEY-1135).
 *
 * Single-flight is a load optimisation that quietly becomes a availability
 * risk: collapsing N callers onto one execution is exactly right until that
 * ONE execution hangs, at which point every caller for that key hangs with it,
 * and so does every caller that arrives later. Before MONEY-1126 this was a
 * narrow concern; that ticket put `singleFlight` on the dashboard, holdings and
 * screener paths, so a single stuck leader now stalls a page for everyone
 * asking the same question.
 *
 * ## Why 25s, and why it MUST exceed QUOTE_FETCH_BUDGET_MS
 *
 * This is a BACKSTOP, not the primary control. The primary controls are the
 * inner budgets — chiefly `QUOTE_FETCH_BUDGET_MS` (20s), which bounds the Yahoo
 * quote fetch and degrades to PARTIAL results (`Promise.allSettled` over chunks,
 * missing symbols instead of an empty response).
 *
 * At the original 15s that ordering was inverted, and the inner degradation was
 * dead code on the path it was written for: `screener.ts` wraps the engine in a
 * single flight, `engine.ts` calls `fetchQuotes`, so a slow Yahoo killed the
 * leader at 15s — five seconds BEFORE its own budget expired. Every waiter got
 * a `SingleFlightTimeoutError` instead of the partial screener result the budget
 * exists to deliver. A backstop that fires before the mechanism it backs up
 * doesn't protect that mechanism, it replaces it.
 *
 * So: strictly greater than the longest legitimate inner budget, plus slack for
 * the DB query, scoring and cache write that share the flight. 20s + 5s.
 * `single-flight-budget-ordering.test.ts` asserts the relation so it cannot
 * silently invert again — the constants live in different modules and neither
 * can import the other without dragging Redis into a pure logic file.
 *
 * ## Platform ceiling — UNVERIFIED, and deliberately not asserted here
 *
 * An earlier version of this comment claimed 15s was "shorter than the
 * platform's function timeout". That was never checked. What IS checked: no
 * `maxDuration` is exported anywhere in `apps/web` except
 * `/api/cron/apply-scheduled-plan-changes` (300s), so every other route runs on
 * the Vercel plan default. For this backstop to do its job that default must be
 * comfortably above 25s. Confirm it in the Vercel dashboard; if it is lower,
 * this constant and the quote budget both have to come down together, keeping
 * the ordering above.
 */
export const SINGLE_FLIGHT_TIMEOUT_MS = 25_000;

export class SingleFlightTimeoutError extends Error {
  constructor(key: string, timeoutMs: number) {
    super(`single-flight for "${key}" exceeded ${timeoutMs}ms`);
    this.name = "SingleFlightTimeoutError";
  }
}

/**
 * Bound a wait on the shared flight.
 *
 * On expiry we ALSO evict the entry, so the next caller starts a fresh compute
 * rather than joining a flight nobody is going to finish. Eviction is
 * conditional on the stored promise still being `run`: without that check, a
 * leader that times out and then completes late would delete a NEWER entry
 * created in the meantime, silently un-sharing the next round of callers.
 */
function withDeadline<T>(
  run: Promise<T>,
  key: string,
  timeoutMs: number,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      if (inFlight.get(key) === run) inFlight.delete(key);
      reject(new SingleFlightTimeoutError(key, timeoutMs));
    }, timeoutMs);
  });
  // `finally` clears the timer on BOTH paths, so a settled flight never leaves
  // a pending timer holding the event loop open (which would orphan tests and
  // keep a lambda warm for no reason).
  return Promise.race([run, deadline]).finally(() => {
    if (timer) clearTimeout(timer);
  }) as Promise<T>;
}

export function singleFlight<T>(
  key: string,
  fn: () => Promise<T>,
  timeoutMs: number = SINGLE_FLIGHT_TIMEOUT_MS,
): Promise<T> {
  const existing = inFlight.get(key);
  if (existing) return withDeadline(existing as Promise<T>, key, timeoutMs);

  // The `finally` needs to compare against ITS OWN promise, which does not
  // exist yet at the point the closure is written. A one-field holder gives the
  // closure a stable reference to read after assignment, without a
  // definite-assignment assertion that would only be hiding the ordering.
  const self: { promise?: Promise<T> } = {};
  const run = (async () => {
    try {
      return await fn();
    } finally {
      // Conditional for the same reason as in `withDeadline`: if this flight
      // was already evicted by a timeout and a new one started, deleting
      // unconditionally would drop the REPLACEMENT.
      if (inFlight.get(key) === self.promise) inFlight.delete(key);
    }
  })();
  self.promise = run;

  // Belt-and-braces, and REDUNDANT as `withDeadline` is written today — say so
  // rather than let the next reader think it is load-bearing.
  //
  // The invariant: a leader that rejects after every waiter has timed out must
  // not escape as an unhandled rejection, because that would take the process
  // down over an error already surfaced to callers as a timeout.
  //
  // `withDeadline` uses `Promise.race`, which attaches a rejection handler to
  // BOTH inputs at construction. That marks `run` handled forever, even when the
  // race settled on the deadline long before — verified with a probe, not
  // assumed from the spec. So the race already provides the invariant.
  //
  // Kept anyway: it is one line, and it is what still holds if `withDeadline`
  // ever grows a path that returns without racing (an early return for a
  // non-positive timeout, say, or an `await`-based rewrite). Deleting it would
  // make that refactor silently unsafe.
  run.catch(() => {});

  inFlight.set(key, run);
  return withDeadline(run, key, timeoutMs);
}

/** Test seam — drops any in-flight entries so cases cannot leak into each other. */
export function __resetSingleFlight(): void {
  inFlight.clear();
}

/* ---------------------------------------------------------------------
   Bound helper
   ------------------------------------------------------------------ */

export interface CachedWithStaleFallbackArgs<T> {
  module: CacheModule;
  /** Cache "userId" slot. Global market data uses a constant like "_global". */
  scope: string;
  /** Identifier within the module — the logical key. */
  identifier: string;
  /** Short TTL for the served entry, in seconds. */
  ttlSeconds: number;
  /**
   * How long the fallback copy survives, in seconds. Should comfortably
   * exceed any plausible outage — a fallback that expires during the
   * incident it exists for is not a fallback.
   */
  staleTtlSeconds: number;
  compute: () => Promise<T>;
  now?: () => number;
  /** See {@link StaleWhileErrorPorts.isPermanentError}. */
  isPermanentError?: (error: unknown) => boolean;
}

/**
 * `resolveWithStaleFallback` wired to the real cache client and wrapped in
 * single-flight. The last-good entry lives under a `:last-good` suffix in
 * the same module so existing invalidation by module still clears both.
 */
export function cachedWithStaleFallback<T>(
  args: CachedWithStaleFallbackArgs<T>,
): Promise<ResolveOutcome<T>> {
  const {
    module,
    scope,
    identifier,
    ttlSeconds,
    staleTtlSeconds,
    compute,
    now = () => Date.now(),
    isPermanentError,
  } = args;

  const lastGoodId = `${identifier}:last-good`;

  return singleFlight(`${module}:${scope}:${identifier}`, () =>
    resolveWithStaleFallback<T>({
      readFresh: () => getCached<T>(module, scope, identifier),
      readLastGood: () => getCached<Stamped<T>>(module, scope, lastGoodId),
      writeFresh: (value) =>
        setCached(module, scope, identifier, value, undefined, {
          ttl: ttlSeconds,
        }),
      writeLastGood: (stamped) =>
        setCached(module, scope, lastGoodId, stamped, undefined, {
          ttl: staleTtlSeconds,
        }),
      compute,
      now,
      // MUST be forwarded. An earlier revision destructured this from `args`
      // and then omitted it here, so every caller that passed a classifier
      // silently got the default transient behaviour — the exact protection
      // they asked for, absent. Unit tests on `resolveWithStaleFallback` did
      // not catch it because they call that function directly; the gap was
      // in this wiring, which nothing exercised.
      isPermanentError,
    }),
  );
}
