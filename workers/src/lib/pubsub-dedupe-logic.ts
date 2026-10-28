/**
 * Pub/Sub `messageId` idempotency — PURE decision logic (MONEY-1204, 14a.5b).
 *
 * Pub/Sub is at-least-once. Every `/jobs/*` processor can therefore be handed
 * the SAME message twice: on an ack-deadline overrun (600s here — a long
 * research/roast/backfill run exceeds it), on a Cloud Run instance restart
 * mid-request, or on any 5xx from the worker. Until now every one of those
 * re-ran the whole job. For an idempotent upsert-only sync that is merely
 * wasteful; for the ones that append (`import`, `pairing`, notification writes)
 * it duplicates work the user can see.
 *
 * This module holds the branchy part with NO database and NO Hono, so it can be
 * tested exhaustively. The I/O shell that actually talks to Mongo lives in
 * `pubsub-dedupe.ts`.
 *
 * ## Why a unique-index INSERT and not a read-then-write
 *
 * `findFirst(messageId) → if absent create()` is not atomic. Two concurrent
 * deliveries both read "absent" and both run — which is exactly the failure the
 * dedupe exists to prevent, and it would show up only under the load that makes
 * it hardest to debug. MongoDB's UNIQUE INDEX is the atomic arbiter instead:
 * both deliveries attempt the same insert, the storage engine serialises them
 * on the index, exactly one wins and the other gets E11000. There is no window.
 *
 * The loser then READS the marker to decide what to do, and every branch of
 * that decision is conservative — see `decideOnExistingMarker`.
 *
 * ## Why the marker is leased rather than a plain "seen" flag
 *
 * A bare "I have seen this messageId" marker makes a CRASHED job permanently
 * un-retryable: the marker says seen, the work never finished, and every
 * redelivery is skipped. So an IN_FLIGHT marker carries a LEASE. While the
 * lease holds, a second delivery is told to come back later (nack) — never
 * "skip". Once it expires, the marker is stealable, so a crash costs one lease
 * period, not the job.
 *
 * @see workers/src/lib/pubsub-dedupe.ts (I/O shell + Hono middleware)
 * @see workers/__tests__/lib/pubsub-dedupe-logic.test.ts
 */

/** Mongo collection holding the dedupe markers. */
export const DEDUPE_COLLECTION = "pubsub_message_dedupe";

/** Unique index that makes the claim atomic. Name is load-bearing: the shell
 *  creates it by this name and treats "already exists" as success. */
export const DEDUPE_UNIQUE_INDEX = "pubsubMessageId_unique";

/** TTL index name — markers are garbage, not history. */
export const DEDUPE_TTL_INDEX = "pubsubMessageId_ttl";

/**
 * How long a marker survives before Mongo's TTL monitor reaps it.
 *
 * Must comfortably exceed Pub/Sub's `--message-retention-duration=7d` (set in
 * `workers/scripts/setup-pubsub.sh`): a marker reaped while the message can
 * still be redelivered would let that redelivery re-run the job. 14d is 2x.
 */
export const DEDUPE_RETENTION_MS = 14 * 24 * 60 * 60 * 1000;

/**
 * Default lease on an IN_FLIGHT marker.
 *
 * Lower bound: must exceed the subscription ack deadline (600s), or a
 * legitimate redelivery of a still-running job would find an expired lease and
 * steal it — double-running the very case this protects. 1h is 6x that and
 * still above Cloud Run's 60-minute request ceiling, so in practice a lease
 * only expires when the instance actually died.
 *
 * Upper bound: a crashed job is un-retryable for this long, so do not raise it
 * casually. Override per-deployment with `PUBSUB_DEDUPE_LEASE_MS`.
 */
export const DEFAULT_LEASE_MS = 60 * 60 * 1000;

/** Marker lifecycle. */
export type MarkerStatus = "IN_FLIGHT" | "COMPLETED" | "FAILED";

/** The subset of a marker document the decision actually reads. */
export interface DedupeMarker {
  messageId: string;
  route: string;
  status: MarkerStatus;
  attempts: number;
  /** Epoch ms; `null` when the marker is terminal (COMPLETED / FAILED). */
  leaseExpiresAt: number | null;
}

/**
 * What the caller should do with this delivery.
 *
 * - `RUN`             — we hold the claim; execute the job.
 * - `SKIP_COMPLETED`  — already done; ACK (200) without re-running.
 * - `RETRY_LATER`     — someone else holds a live claim; NACK (409) so Pub/Sub
 *                       redelivers after the backoff instead of racing.
 * - `RUN_UNTRACKED`   — dedupe unavailable or not applicable; run WITHOUT a
 *                       claim. Deliberately fail-OPEN, see `decideOnStoreError`.
 */
export type ClaimAction =
  | "RUN"
  | "SKIP_COMPLETED"
  | "RETRY_LATER"
  | "RUN_UNTRACKED";

export interface ClaimDecision {
  action: ClaimAction;
  /** Machine-readable reason, safe to log. */
  reason: string;
  /** Prior attempt count when known — surfaces "this is the 3rd try" in logs. */
  attempts?: number;
}

/**
 * Decide what a delivery that LOST the insert race should do.
 *
 * `marker` is what the loser read back after E11000. `null` means the row
 * vanished between the failed insert and the read — a TTL reap or a concurrent
 * cleanup. That is not evidence the job ran, so we run it (at-least-once is the
 * contract we are refining, not replacing).
 *
 * Every branch here is chosen so that being WRONG costs a duplicate run rather
 * than a dropped job. A dropped job is invisible; a duplicate run is loud.
 */
export function decideOnExistingMarker(
  marker: DedupeMarker | null,
  nowMs: number,
): ClaimDecision {
  if (!marker) {
    return {
      action: "RUN_UNTRACKED",
      reason: "marker_vanished_after_conflict",
    };
  }

  if (marker.status === "COMPLETED") {
    return {
      action: "SKIP_COMPLETED",
      reason: "already_completed",
      attempts: marker.attempts,
    };
  }

  // FAILED: the previous attempt ran to a conclusion and lost. Pub/Sub is
  // entitled to retry it (that is what max-delivery-attempts=5 is for), so this
  // must NOT be a skip. The shell re-claims via a compare-and-swap on
  // status:FAILED so only one of N concurrent retries proceeds.
  if (marker.status === "FAILED") {
    return {
      action: "RUN",
      reason: "reclaim_after_failure",
      attempts: marker.attempts,
    };
  }

  // IN_FLIGHT from here.
  //
  // A null lease on an IN_FLIGHT marker is a corrupt/legacy row. Treat it as
  // expired rather than as an eternal lock — an eternal lock is the one state
  // from which nothing recovers without manual DB surgery.
  const lease = marker.leaseExpiresAt;
  if (lease === null || lease <= nowMs) {
    return {
      action: "RUN",
      reason: lease === null ? "lease_missing" : "lease_expired",
      attempts: marker.attempts,
    };
  }

  return {
    action: "RETRY_LATER",
    reason: "in_flight_elsewhere",
    attempts: marker.attempts,
  };
}

/**
 * What to do when the dedupe STORE itself is unreachable (Mongo down, index
 * missing, raw command rejected).
 *
 * Fail OPEN, always. Dedupe is an optimisation layered on a system that is
 * already correct-but-wasteful under at-least-once delivery. Failing closed
 * would convert a dedupe-store outage into a total job outage — every nightly
 * sync silently 409ing while the market data goes stale. The blast radius of
 * the wrong choice is wildly asymmetric, so it is not a judgement call.
 */
export function decideOnStoreError(): ClaimDecision {
  return { action: "RUN_UNTRACKED", reason: "dedupe_store_unavailable" };
}

/**
 * Identify a MongoDB duplicate-key failure.
 *
 * It reaches us two ways and both must be handled:
 *  - as a THROWN error (Prisma wraps the driver error), and
 *  - as a `writeErrors[]` entry inside an `ok: 1` response — Mongo's `insert`
 *    command does NOT fail the command on a duplicate key, it reports it
 *    per-document. Checking only the throw path would silently classify every
 *    duplicate as a successful claim, i.e. dedupe that never dedupes.
 */
export function isDuplicateKeyError(value: unknown): boolean {
  if (value === null || value === undefined) return false;
  if (typeof value === "string") return value.includes("E11000");

  if (typeof value === "object") {
    const rec = value as Record<string, unknown>;
    if (rec.code === 11000 || rec.code === "11000") return true;
    if (typeof rec.message === "string" && rec.message.includes("E11000")) {
      return true;
    }
    // The `ok: 1` response shape: `{ n: 0, writeErrors: [{ code: 11000 }] }`.
    // This is the one the store actually passes in on the common path, so
    // missing it would classify every conflict as an unmodelled response and
    // fail open — a dedupe that never dedupes.
    const writeErrors = rec.writeErrors;
    if (Array.isArray(writeErrors)) {
      if (writeErrors.some((e) => isDuplicateKeyError(e))) return true;
    }

    // Nested shapes: Prisma's P2010 wraps the driver error under `meta`.
    for (const key of ["meta", "cause", "error"]) {
      const nested = rec[key];
      if (nested && typeof nested === "object" && isDuplicateKeyError(nested)) {
        return true;
      }
    }
  }
  return false;
}

/**
 * True when a raw `insert` response reports the document as written.
 *
 * `{ n: 1, ok: 1 }` is a claim. `{ n: 0, writeErrors: [{ code: 11000 }] }` is a
 * conflict. Anything else (n absent, ok: 0) is treated as NOT written, which
 * routes to the fail-open path rather than to a false claim.
 */
export function insertSucceeded(response: unknown): boolean {
  if (!response || typeof response !== "object") return false;
  const rec = response as Record<string, unknown>;
  const writeErrors = rec.writeErrors;
  if (Array.isArray(writeErrors) && writeErrors.length > 0) return false;
  return rec.n === 1 || rec.n === 1.0;
}

/**
 * Extract the Pub/Sub delivery identity from a push body.
 *
 * Returns `null` for anything that is not a real Pub/Sub push envelope with a
 * non-empty `messageId`. That is deliberate and it is NOT the same as
 * `lib/message.ts::getMessageId`, which synthesises `local-${Date.now()}` for
 * direct JSON bodies so a log line always has something to print. Deduping on a
 * synthetic clock-derived id would be actively harmful: two manual triggers or
 * two local pull deliveries inside the same millisecond would collide and the
 * second would be silently skipped as a "duplicate" of an unrelated job.
 *
 * No id → no claim → the job runs exactly as it does today.
 */
export function extractDeliveryId(body: unknown): string | null {
  if (!body || typeof body !== "object") return null;
  const message = (body as { message?: unknown }).message;
  if (!message || typeof message !== "object") return null;
  const id = (message as { messageId?: unknown }).messageId;
  if (typeof id !== "string") return null;
  const trimmed = id.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/**
 * Read a date out of a raw Mongo document.
 *
 * `$runCommandRaw` returns MongoDB Extended JSON, so a BSON Date comes back as
 * `{ $date: "2026-08-16T..." }` or `{ $date: { $numberLong: "1755..." } }`
 * depending on driver/mode — never as a JS `Date`. A naive `new Date(value)` on
 * those objects yields `Invalid Date`, whose `getTime()` is NaN, and every
 * `NaN <= now` comparison is FALSE — so a lease would read as permanently live
 * and every redelivery would nack forever. Hence an explicit tolerant reader.
 *
 * Returns epoch ms, or `null` when the value is absent/unparseable.
 */
export function parseMarkerDate(value: unknown): number | null {
  if (value === null || value === undefined) return null;

  if (typeof value === "number") {
    return Number.isFinite(value) ? value : null;
  }

  if (typeof value === "string") {
    const ms = Date.parse(value);
    return Number.isFinite(ms) ? ms : null;
  }

  if (value instanceof Date) {
    const ms = value.getTime();
    return Number.isFinite(ms) ? ms : null;
  }

  if (typeof value === "object") {
    const inner = (value as { $date?: unknown }).$date;
    if (inner === undefined) return null;
    if (typeof inner === "object" && inner !== null) {
      const long = (inner as { $numberLong?: unknown }).$numberLong;
      if (typeof long === "string") {
        const ms = Number(long);
        return Number.isFinite(ms) ? ms : null;
      }
      return null;
    }
    return parseMarkerDate(inner);
  }

  return null;
}

/** Coerce a raw Mongo status field to a known `MarkerStatus`. */
export function parseMarkerStatus(value: unknown): MarkerStatus {
  if (value === "COMPLETED" || value === "FAILED" || value === "IN_FLIGHT") {
    return value;
  }
  // Unknown/absent status is treated as IN_FLIGHT so the LEASE decides, rather
  // than defaulting to COMPLETED (which would skip work that never ran).
  return "IN_FLIGHT";
}

/** Build a typed marker from a raw Extended-JSON document. */
export function toMarker(doc: unknown): DedupeMarker | null {
  if (!doc || typeof doc !== "object") return null;
  const rec = doc as Record<string, unknown>;
  const messageId = rec.messageId;
  if (typeof messageId !== "string") return null;

  const attempts = typeof rec.attempts === "number" ? rec.attempts : 0;

  return {
    messageId,
    route: typeof rec.route === "string" ? rec.route : "unknown",
    status: parseMarkerStatus(rec.status),
    attempts: Number.isFinite(attempts) ? attempts : 0,
    leaseExpiresAt: parseMarkerDate(rec.leaseExpiresAt),
  };
}

/**
 * The route key stored on the marker.
 *
 * Purely descriptive — the UNIQUE key is `messageId` alone, never
 * `(messageId, route)`. A Pub/Sub messageId is unique per topic and each topic
 * has exactly one push endpoint here, so route adds nothing to identity; making
 * it part of the key would only create a way for the same message to be claimed
 * twice if a path ever changed.
 */
export function routeKey(path: string): string {
  const trimmed = path.split("?")[0] ?? path;
  return trimmed.length > 120 ? trimmed.slice(0, 120) : trimmed;
}

// ── The store ────────────────────────────────────────────────────────────

/**
 * Runs one MongoDB command and resolves its raw (Extended-JSON) response.
 *
 * Injected so the store below can be exercised against a fake Mongo that
 * implements a real unique index — which is the only way to test the claim
 * protocol's CONCURRENCY behaviour without a live cluster. `pubsub-dedupe.ts`
 * supplies the Prisma-backed implementation.
 */
export type RawCommandRunner = (
  command: Record<string, unknown>,
) => Promise<unknown>;

/** The `createIndexes` command. Exported so the shell and the test agree. */
export function dedupeIndexCommand(): Record<string, unknown> {
  return {
    createIndexes: DEDUPE_COLLECTION,
    indexes: [
      { key: { messageId: 1 }, name: DEDUPE_UNIQUE_INDEX, unique: true },
      { key: { expiresAt: 1 }, name: DEDUPE_TTL_INDEX, expireAfterSeconds: 0 },
    ],
  };
}

export interface DedupeStoreDeps {
  runCommand: RawCommandRunner;
  /** Injectable clock (epoch ms). */
  now?: () => number;
  /** Lease length in ms. */
  leaseMs?: () => number;
  logError?: (message: string, err?: unknown) => void;
}

/**
 * Build the dedupe store over a raw command runner.
 *
 * ## Behaviour under SIMULTANEOUS redelivery — the whole point of this code
 *
 * Two deliveries of the same messageId land on two Cloud Run instances at the
 * same instant. Both call `claim`. Both issue the SAME `insert` against a
 * collection with `unique: true` on `messageId`. MongoDB serialises them on the
 * index: exactly one document is written. The winner sees `{ n: 1 }` → `RUN`.
 * The loser sees `writeErrors: [{ code: 11000 }]`, reads the marker, and
 * `decideOnExistingMarker` returns `RETRY_LATER` because the lease is live — so
 * it nacks and Pub/Sub redelivers after the backoff. Nothing double-runs,
 * nothing is dropped, and there is no read-then-write window anywhere.
 *
 * The three other reachable states are each resolved by a compare-and-swap that
 * is itself atomic (`findAndModify` touches ONE document):
 *   - COMPLETED    → `SKIP_COMPLETED`; ack, do not re-run.
 *   - FAILED       → CAS `status:FAILED → IN_FLIGHT`. Only one of N concurrent
 *                    retries matches; the rest get `RETRY_LATER`.
 *   - lease EXPIRED→ CAS filtered on the OLD `leaseExpiresAt`, so only one
 *                    stealer matches. A crashed job is retryable and still
 *                    cannot be claimed twice.
 */
export function createDedupeStore(deps: DedupeStoreDeps): DedupeStore {
  const now = deps.now ?? (() => Date.now());
  const lease = deps.leaseMs ?? (() => DEFAULT_LEASE_MS);
  const logError = deps.logError ?? (() => {});

  async function readMarker(messageId: string): Promise<DedupeMarker | null> {
    // `aggregate` + `cursor` is the shape this repo already uses with
    // `$runCommandRaw` (scripts/migrations/*.ts). `$limit: 1` keeps
    // `firstBatch` complete, so the MONEY-1189 trap — a `firstBatch` shorter
    // than the result set reading as missing data — cannot apply here.
    const res = (await deps.runCommand({
      aggregate: DEDUPE_COLLECTION,
      pipeline: [{ $match: { messageId } }, { $limit: 1 }],
      cursor: {},
    })) as { cursor?: { firstBatch?: unknown[] } } | null;
    return toMarker(res?.cursor?.firstBatch?.[0] ?? null);
  }

  /**
   * Compare-and-swap an expired / failed marker into a fresh claim.
   *
   * The filter carries the observed `status` AND `leaseExpiresAt`, so this is a
   * genuine CAS rather than a blind overwrite: two instances racing to steal
   * the same abandoned marker both submit it, MongoDB applies them one at a
   * time to a single document, and the second matches nothing.
   */
  async function steal(
    messageId: string,
    route: string,
    marker: DedupeMarker,
  ): Promise<boolean> {
    const t = now();
    const res = (await deps.runCommand({
      findAndModify: DEDUPE_COLLECTION,
      query: {
        messageId,
        status: marker.status,
        // `null` matches both an absent and a literally-null field — the
        // corrupt-marker case `decideOnExistingMarker` treats as expired.
        leaseExpiresAt: marker.leaseExpiresAt,
      },
      update: {
        $set: {
          status: "IN_FLIGHT",
          route,
          attempts: marker.attempts + 1,
          leaseExpiresAt: t + lease(),
          claimedAt: { $date: new Date(t).toISOString() },
          expiresAt: {
            $date: new Date(t + DEDUPE_RETENTION_MS).toISOString(),
          },
        },
      },
      new: true,
    })) as { value?: unknown } | null;

    return res?.value !== null && res?.value !== undefined;
  }

  return {
    async claim(messageId: string, route: string): Promise<ClaimDecision> {
      try {
        const t = now();
        const doc = {
          messageId,
          route,
          status: "IN_FLIGHT",
          attempts: 1,
          // Epoch ms, NOT an Extended-JSON date. The lease is compared
          // numerically on every delivery and must not depend on how the driver
          // round-trips a BSON date. `expiresAt` below stays a real date
          // because Mongo's TTL monitor requires one.
          leaseExpiresAt: t + lease(),
          claimedAt: { $date: new Date(t).toISOString() },
          expiresAt: {
            $date: new Date(t + DEDUPE_RETENTION_MS).toISOString(),
          },
        };

        let response: unknown;
        try {
          response = await deps.runCommand({
            insert: DEDUPE_COLLECTION,
            documents: [doc],
            ordered: false,
          });
        } catch (err) {
          // A duplicate key reaches us as a THROW as well as in `writeErrors`.
          if (!isDuplicateKeyError(err)) throw err;
          response = { n: 0, writeErrors: [{ code: 11000 }] };
        }

        if (insertSucceeded(response)) {
          return { action: "RUN", reason: "claimed", attempts: 1 };
        }

        if (!isDuplicateKeyError(response)) {
          // Neither written nor conflicted — an unmodelled response. Fail open
          // rather than guess which it was.
          logError("[pubsub-dedupe] unexpected insert response", response);
          return decideOnStoreError();
        }

        const marker = await readMarker(messageId);
        const decision = decideOnExistingMarker(marker, now());
        if (decision.action !== "RUN" || marker === null) return decision;

        // We believe the marker is stealable. Prove it atomically.
        if (await steal(messageId, route, marker)) return decision;

        return {
          action: "RETRY_LATER",
          reason: "steal_lost_race",
          attempts: decision.attempts,
        };
      } catch (err) {
        logError("[pubsub-dedupe] claim failed; running untracked", err);
        return decideOnStoreError();
      }
    },

    /**
     * Mark a claim terminal.
     *
     * Both outcomes clear the lease. `COMPLETED` so nothing can steal a
     * finished marker; `FAILED` so the next delivery is immediately retryable
     * rather than blocked for the remainder of a lease it no longer holds.
     *
     * Never throws: a release failure must not turn a SUCCESSFUL job into a
     * 500. The cost of a lost release is one lease period of 409s on that one
     * messageId — exactly the state the lease exists to bound.
     */
    async release(
      messageId: string,
      outcome: "COMPLETED" | "FAILED",
    ): Promise<void> {
      try {
        await deps.runCommand({
          update: DEDUPE_COLLECTION,
          updates: [
            {
              q: { messageId },
              u: {
                $set: {
                  status: outcome,
                  leaseExpiresAt: null,
                  completedAt: { $date: new Date(now()).toISOString() },
                },
              },
              multi: false,
              upsert: false,
            },
          ],
        });
      } catch (err) {
        logError(`[pubsub-dedupe] release(${outcome}) failed`, err);
      }
    },
  };
}

// ── The middleware itself ────────────────────────────────────────────────

/**
 * Minimal shape of the pieces of a Hono context this middleware touches.
 *
 * Declared structurally rather than importing Hono's types — same reasoning as
 * `JobsAuthContext` in `index-auth-logic.ts`: the middleware can then be driven
 * by a plain object in a test, with no server, no sockets and no route table.
 */
export interface DedupeContext {
  req: {
    path: string;
    json(): Promise<unknown>;
  };
  res: { status: number };
  json(body: unknown, status: number): unknown;
}

export interface DedupeStore {
  /** Atomically claim `messageId`. Must never throw — errors become
   *  `RUN_UNTRACKED` inside the store. */
  claim(messageId: string, route: string): Promise<ClaimDecision>;
  /** Mark the claim terminal. Must never throw. */
  release(messageId: string, outcome: "COMPLETED" | "FAILED"): Promise<void>;
}

export interface DedupeMiddlewareDeps {
  store: DedupeStore;
  /** Route paths that opt OUT (see `SELF_DEDUPING_ROUTES`). */
  skipPaths?: readonly string[];
  log?: (message: string) => void;
  logError?: (message: string, err?: unknown) => void;
}

/**
 * Routes that must NOT go through the generic middleware.
 *
 * `/jobs/dead-letter` is the one exception and the reason is specific: the
 * generic path answers a live competing claim with 409, which NACKS. Nacking a
 * dead letter puts it back on the dead-letter queue — the single queue in the
 * system that has no further backstop and must never grow. The DLQ consumer
 * therefore calls the SAME store directly and converts every outcome to an ACK.
 */
export const SELF_DEDUPING_ROUTES = ["/jobs/dead-letter"] as const;

/**
 * Build the `/jobs/*` idempotency middleware.
 *
 * A FACTORY for the same reason `createJobsAuthMiddleware` is one: extracting
 * the decision function alone leaves the CALL SITE untested, and the call site
 * is where a dedupe silently degrades. `if (decision.action === "RUN")` flipped
 * to an unconditional run keeps every `decideOnExistingMarker` unit test green
 * while the dedupe does nothing. Composing it here means a mutation has to be
 * made where the behavioural tests execute it.
 *
 * Ordering note: this must be registered AFTER the OIDC gate. Claiming a
 * messageId for an unauthenticated request would let an attacker burn the
 * dedupe key for a legitimate message — a denial-of-job with no auth required.
 */
export function createDedupeMiddleware(deps: DedupeMiddlewareDeps) {
  const skip = new Set<string>(deps.skipPaths ?? SELF_DEDUPING_ROUTES);
  const log = deps.log ?? (() => {});
  const logError = deps.logError ?? (() => {});

  return async function pubsubDedupe(
    c: DedupeContext,
    next: () => Promise<void>,
  ): Promise<unknown> {
    const route = routeKey(c.req.path);
    if (skip.has(route)) {
      await next();
      return undefined;
    }

    // Reading the body here is safe: Hono caches the raw body TEXT
    // (`HonoRequest#cachedBody`), so the route handler's own `c.req.json()`
    // re-parses that cached text into a FRESH object. The stream is consumed
    // once and the handler cannot observe our read — verified against
    // hono@4.12 before this was written.
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      // Unparseable body — every route already handles this itself
      // (`try { body = await c.req.json() } catch { body = {} }`). Not our
      // problem to diagnose, and definitely not our problem to block on.
      await next();
      return undefined;
    }

    const messageId = extractDeliveryId(body);
    if (!messageId) {
      // Direct JSON body: local dev, a manual curl, or the pull subscriber.
      // No real messageId, so no claim — see `extractDeliveryId`.
      await next();
      return undefined;
    }

    const decision = await deps.store.claim(messageId, route);

    if (decision.action === "SKIP_COMPLETED") {
      log(
        `[pubsub-dedupe] duplicate:true route=${route} messageId=${messageId} ` +
          `reason=${decision.reason} attempts=${decision.attempts ?? 0} — acked without re-running`,
      );
      return c.json({ success: true, duplicate: true }, 200);
    }

    if (decision.action === "RETRY_LATER") {
      log(
        `[pubsub-dedupe] duplicate:true route=${route} messageId=${messageId} ` +
          `reason=${decision.reason} — a live claim exists, nacking for redelivery`,
      );
      // 409, NOT 200: the first delivery is still running and may yet fail. If
      // we acked here, a first attempt that then crashed would leave the job
      // silently undone with Pub/Sub believing it was handled.
      return c.json(
        { error: "Duplicate delivery in flight", duplicate: true },
        409,
      );
    }

    const tracked = decision.action === "RUN";
    if (!tracked) {
      log(
        `[pubsub-dedupe] untracked route=${route} messageId=${messageId} ` +
          `reason=${decision.reason} — running WITHOUT a claim (fail-open)`,
      );
    }

    let threw = false;
    try {
      await next();
    } catch (err) {
      threw = true;
      // Release BEFORE rethrowing, or a throwing handler leaves an IN_FLIGHT
      // marker that blocks every redelivery until the lease expires — turning
      // one transient error into an hour of 409s.
      if (tracked) {
        await deps.store
          .release(messageId, "FAILED")
          .catch((e: unknown) => logError("[pubsub-dedupe] release failed", e));
      }
      throw err;
    } finally {
      if (tracked && !threw) {
        // Only a 2xx counts as done. A route that returns 500 (every processor
        // route catches its own errors and returns 500 rather than throwing)
        // must stay retryable.
        const ok = c.res.status >= 200 && c.res.status < 300;
        await deps.store
          .release(messageId, ok ? "COMPLETED" : "FAILED")
          .catch((e: unknown) => logError("[pubsub-dedupe] release failed", e));
      }
    }

    return undefined;
  };
}
