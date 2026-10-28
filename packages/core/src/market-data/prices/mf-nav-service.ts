/**
 * MF NAV history — DB reads are synchronous, backfill is a JOB (MONEY-1205).
 *
 * Data source: MFAPI.in (`https://api.mfapi.in/mf/<schemeCode>`).
 *
 * ## What was wrong
 *
 * `getMfNavHistory` used to run `count === 0 → await backfillMfNav()` INSIDE the
 * caller's request, and that backfill issued **one Prisma upsert per NAV point** — 609 sequential round trips for a typical fund. Measured on prod:
 * scheme 152387's 609 rows were created 09:19:20 → 09:20:15 UTC *during a
 * founder page view*. The request was cut off, the client caught the failure and
 * set `navHistory = []`, and 52W high/low + CAGR rendered "-". With NAV history
 * present for only **16 of 14,223 schemes**, that 55-83s stall was the normal
 * first-visit experience for essentially every fund on the platform.
 *
 * ## What it does now
 *
 * 1. **Read returns immediately.** `getMfNavHistory` only ever queries the
 *    database. It never fetches, and it never awaits a backfill.
 * 2. **Cold schemes enqueue.** When the scheme has no usable history the read
 *    publishes an `mf-nav-backfill` job and returns whatever it had (usually
 *    `[]`). The caller renders "not enough history yet", which is a DISTINCT
 *    state from "failed to load" — see `computeNavDerivatives` in
 *    `@usemoney/services`.
 * 3. **The backfill is a bulk write, and it lives in the WORKER.**
 *    `workers/src/processors/mf-nav-backfill.ts` diffs against the dates already
 *    stored (via the pure `selectMissingNavPoints` below) and `createMany`s only
 *    the missing ones: **2 round trips plus one per 1,000 new points**, instead
 *    of N. It is a plain `prisma.mfNavHistory.*` call there rather than a
 *    delegation into this package so `prod-only-sync-coverage.test.ts` can see
 *    what advances the table. Same shape as the
 *    `yahoo-price-service.upsertDailyPrices` precedent, and for the same reason
 *    a published NAV for a past date never changes, so skipping stored dates is
 *    correct.
 *
 * ## The guaranteed publisher
 *
 * `mf-nav-backfill` has TWO publishers and the first needs no application code:
 *  - **Cloud Scheduler** `mf-nav-backfill-daily` (23:00 IST, after
 *    `mf-sync-daily` at 22:30) publishes `{universe:true}` straight to the
 *    topic. This is what actually seeds the 14,207 uncovered schemes, and it is
 *    why the on-demand path is an optimisation rather than the mechanism.
 *  - **This module**, on a cold read (below).
 *
 * @see workers/src/processors/mf-nav-backfill.ts (consumer)
 * @see packages/services/src/mutualfunds-logic.ts#computeNavDerivatives
 */

import { prisma } from "@usemoney/database";
import {
  PUBSUB_TOPICS,
  getTopicName,
  type MfNavBackfillMessage,
} from "@usemoney/types";

// ============== TYPES ==============

export interface NavPoint {
  date: string; // YYYY-MM-DD
  nav: number;
}

export interface BackfillResult {
  schemeCode: string;
  /** Rows newly written. */
  inserted: number;
  /** Usable points the upstream returned. */
  total: number;
  /** Points already present (skipped, not an error). */
  existing: number;
  error?: string;
}

/**
 * The narrow slice of `prisma.mfNavHistory` a read needs.
 *
 * Injectable so the cold-read behaviour — "return what we have, publish a job,
 * never fetch" — can be asserted against the REAL exported function without
 * booting a Prisma client. Mirrors the `EnqueuePrismaClient` seam in
 * `packages/research/src/data-sources/rag-enqueue.ts`.
 */
export interface MfNavReader {
  count(args: { where: { schemeCode: string } }): Promise<number>;
  findMany(args: {
    where: { schemeCode: string; date: { gte: Date; lte: Date } };
    orderBy: { date: "asc" };
    select: { date: true; nav: true };
  }): Promise<Array<{ date: Date; nav: number }>>;
}

/** What a read knows about how much history it has. */
export interface MfNavCoverage {
  schemeCode: string;
  /** Rows stored for the scheme across ALL time (not just the query window). */
  storedRows: number;
  /** True when there is too little history to derive anything from. */
  cold: boolean;
}

interface MfApiResponse {
  meta?: {
    fund_house?: string;
    scheme_type?: string;
    scheme_category?: string;
    scheme_code?: number;
    scheme_name?: string;
  };
  data?: Array<{
    date: string; // DD-MM-YYYY
    nav: string;
  }>;
  status?: string;
}

/**
 * Below this many stored rows a scheme is "cold" and a backfill is requested.
 *
 * 2 rather than 1: a single point cannot produce a return, a CAGR, or a range,
 * so a one-row scheme is indistinguishable from an empty one for every consumer.
 */
export const MF_NAV_COLD_THRESHOLD = 2;

// ============== HELPERS ==============

/** Parse MFAPI.in's "DD-MM-YYYY" into a UTC-midnight Date. */
function parseMfApiDate(dateStr: string): Date | null {
  const parts = dateStr.split("-");
  if (parts.length !== 3) return null;
  const [day, month, year] = parts;
  const date = new Date(`${year}-${month}-${day}T00:00:00.000Z`);
  if (Number.isNaN(date.getTime())) return null;
  return date;
}

/** Format a Date as YYYY-MM-DD. */
function formatDate(date: Date): string {
  return date.toISOString().split("T")[0]!;
}

// ============== BACKFILL PUBLISHER SEAM ==============

/**
 * Publishes an `mf-nav-backfill` job.
 *
 * Injectable so tests can assert the enqueue without a Pub/Sub client, and so a
 * host that wires its own transport can replace it.
 */
export type MfNavBackfillPublisher = (
  message: MfNavBackfillMessage,
) => Promise<string>;

let injectedPublisher: MfNavBackfillPublisher | null = null;
let publisherWarned = false;

/** Inject a publisher (tests, or a host with its own transport). */
export function setMfNavBackfillPublisher(
  publisher: MfNavBackfillPublisher | null,
): void {
  injectedPublisher = publisher;
}

/**
 * Default publisher: the shared Pub/Sub client, resolved lazily.
 *
 * The import is DYNAMIC on purpose. `@usemoney/pubsub` statically imports
 * `@usemoney/core/gemini/credentials`, so a static import here would make
 * core -> pubsub -> core a declared package cycle (which `turbo` rejects).
 * A lazy import resolves at call time, long after both module graphs are
 * initialised, and costs nothing on the overwhelmingly common warm-read path
 * where no job is published at all. `@usemoney/pubsub` is already in every
 * consuming app's server graph via `@usemoney/services`, so this pulls in
 * nothing new.
 */
async function defaultPublish(message: MfNavBackfillMessage): Promise<string> {
  const { getPubSubClient } = await import("@usemoney/pubsub/client");
  const topic = getPubSubClient().topic(
    getTopicName(PUBSUB_TOPICS.MF_NAV_BACKFILL),
  );
  return topic.publishMessage({ json: message });
}

// ---- request de-duplication --------------------------------------------
//
// The MF detail page can re-read the same cold scheme many times in a session
// (chart period switches, a refresh, two tabs). Publishing on each one would
// queue the same backfill dozens of times. This is a per-process guard, so
// across N Cloud Run / Vercel instances the worst case is N publishes per TTL —
// still bounded, and the job itself is idempotent (it only inserts dates it
// does not already have).

const REQUEST_TTL_MS = 30 * 60 * 1000;
/** Bounded so a scan of the whole 14k universe cannot grow this without limit. */
const REQUEST_CACHE_MAX = 2_000;
const recentRequests = new Map<string, number>();

function pruneRequestCache(now: number): void {
  for (const [key, expiry] of recentRequests) {
    if (expiry <= now) recentRequests.delete(key);
  }
  if (recentRequests.size > REQUEST_CACHE_MAX) {
    // Map preserves insertion order — drop the oldest overflow.
    const excess = recentRequests.size - REQUEST_CACHE_MAX;
    let dropped = 0;
    for (const key of recentRequests.keys()) {
      recentRequests.delete(key);
      if (++dropped >= excess) break;
    }
  }
}

/** Test seam: forget every de-dup entry. */
export function resetMfNavBackfillRequests(): void {
  recentRequests.clear();
  publisherWarned = false;
}

export type MfNavBackfillRequestStatus =
  | "published"
  | "deduped"
  | "disabled"
  | "failed";

export interface MfNavBackfillRequest {
  schemeCode: string;
  status: MfNavBackfillRequestStatus;
  messageId?: string;
  error?: string;
}

/**
 * Ask the worker to backfill one scheme's NAV history.
 *
 * Never throws. A publish failure is a LOGGED, RETURNED status — not a silent
 * no-op — because "we asked and nothing happened" and "we never asked" are
 * different bugs and the nightly universe job only covers the second.
 *
 * Set `MF_NAV_BACKFILL_ON_READ=off` to stop reads from enqueuing at all (the
 * nightly job still runs).
 */
export async function requestMfNavBackfill(
  schemeCode: string,
  options: { reason?: string; force?: boolean } = {},
): Promise<MfNavBackfillRequest> {
  if (!schemeCode) {
    return { schemeCode, status: "failed", error: "empty schemeCode" };
  }

  if ((process.env.MF_NAV_BACKFILL_ON_READ ?? "").toLowerCase() === "off") {
    return { schemeCode, status: "disabled" };
  }

  const now = Date.now();
  pruneRequestCache(now);
  if (!options.force) {
    const expiry = recentRequests.get(schemeCode);
    if (expiry !== undefined && expiry > now) {
      return { schemeCode, status: "deduped" };
    }
  }
  recentRequests.set(schemeCode, now + REQUEST_TTL_MS);

  const message: MfNavBackfillMessage = {
    schemeCodes: [schemeCode],
    reason: options.reason ?? "cold-read",
  };

  try {
    const publish = injectedPublisher ?? defaultPublish;
    const messageId = await publish(message);
    return { schemeCode, status: "published", messageId };
  } catch (error) {
    // Un-cache so the next read can retry rather than being deduped against a
    // publish that never landed.
    recentRequests.delete(schemeCode);
    const msg = error instanceof Error ? error.message : String(error);
    if (!publisherWarned) {
      publisherWarned = true;
      console.error(
        `[mf-nav] could not publish ${PUBSUB_TOPICS.MF_NAV_BACKFILL} ` +
          `(further occurrences logged at debug): ${msg}`,
      );
    }
    return { schemeCode, status: "failed", error: msg };
  }
}

// ============== MFAPI.IN FETCH ==============

/**
 * Fetch full NAV history from MFAPI.in.
 *
 * Only ever called from the BACKFILL WORKER — never from a read path.
 */
export async function fetchMfNavPoints(
  schemeCode: string,
): Promise<Array<{ date: Date; nav: number }>> {
  const response = await fetch(`https://api.mfapi.in/mf/${schemeCode}`, {
    headers: { Accept: "application/json" },
    signal: AbortSignal.timeout(30_000),
  });

  if (!response.ok) {
    throw new Error(`MFAPI.in returned ${response.status} for ${schemeCode}`);
  }

  const data = (await response.json()) as MfApiResponse;
  if (!data.data || !Array.isArray(data.data)) return [];

  // Dedupe on the date: MFAPI occasionally repeats a day, and a repeat inside
  // one `createMany` throws the WHOLE batch on the (schemeCode, date) unique.
  const byDate = new Map<number, { date: Date; nav: number }>();
  for (const d of data.data) {
    const date = parseMfApiDate(d.date);
    const nav = Number.parseFloat(d.nav);
    if (!date || !Number.isFinite(nav) || nav <= 0) continue;
    byDate.set(date.getTime(), { date, nav });
  }

  return [...byDate.values()].sort(
    (a, b) => a.date.getTime() - b.date.getTime(),
  );
}

// ============== PUBLIC READ API ==============

/**
 * NAV history for a scheme, from the DATABASE ONLY.
 *
 * Returns immediately. When the scheme has (almost) no stored history this
 * enqueues a backfill and still returns what it had — an empty array is a
 * truthful "we have no history for this fund *yet*", and the caller must render
 * it as such rather than as a load failure.
 */
export async function getMfNavHistory(
  schemeCode: string,
  startDate?: Date,
  endDate?: Date,
  db?: MfNavReader,
): Promise<NavPoint[]> {
  const { points } = await getMfNavHistoryWithCoverage(
    schemeCode,
    startDate,
    endDate,
    db,
  );
  return points;
}

/**
 * Same read as {@link getMfNavHistory}, plus the coverage verdict.
 *
 * Consumers that need to distinguish "this fund has no history" from "this
 * window has no history" (the MF detail page does) should use this.
 */
export async function getMfNavHistoryWithCoverage(
  schemeCode: string,
  startDate?: Date,
  endDate?: Date,
  db?: MfNavReader,
): Promise<{ points: NavPoint[]; coverage: MfNavCoverage }> {
  const reader: MfNavReader =
    db ?? (prisma.mfNavHistory as unknown as MfNavReader);
  const end = endDate || new Date();
  const start = startDate || new Date(0);

  const [storedRows, records] = await Promise.all([
    reader.count({ where: { schemeCode } }),
    reader.findMany({
      where: { schemeCode, date: { gte: start, lte: end } },
      orderBy: { date: "asc" },
      select: { date: true, nav: true },
    }),
  ]);

  const cold = storedRows < MF_NAV_COLD_THRESHOLD;

  if (cold) {
    // Fire the request and await the PUBLISH (tens of ms), never the fetch.
    // Awaiting matters on serverless: an un-awaited promise is routinely killed
    // when the response is sent, which would make the on-demand path a no-op
    // exactly where it is most needed.
    const request = await requestMfNavBackfill(schemeCode, {
      reason: "cold-read",
    });
    if (request.status === "published") {
      console.log(
        `[mf-nav] ${schemeCode} has ${storedRows} stored rows — queued backfill (${request.messageId})`,
      );
    }
  }

  return {
    points: records.map((r) => ({ date: formatDate(r.date), nav: r.nav })),
    coverage: { schemeCode, storedRows, cold },
  };
}

// ============== BACKFILL PIECES (the WRITE lives in the worker) ==============

/**
 * The dates already stored, as a lookup key set.
 *
 * Exported so the worker and the tests agree on the key (UTC epoch ms), which
 * is what makes "insert only what is missing" idempotent across redeliveries.
 */
export function navDateKeys(dates: readonly Date[]): Set<number> {
  return new Set(dates.map((d) => d.getTime()));
}

/**
 * The points that are NOT yet stored — pure, so it is unit-testable.
 *
 * Correctness: a published NAV for a past date never changes, so skipping a
 * date we already hold is right, not merely cheap. It is also what makes the
 * job resumable — a redelivery or an overlapping run inserts nothing.
 *
 * NOTE the DB WRITE deliberately does NOT live in this package. It sits in
 * `workers/src/processors/mf-nav-backfill.ts` as a plain
 * `prisma.mfNavHistory.createMany`, because `prod-only-sync-coverage.test.ts`
 * scans the PROCESSOR files to answer "what advances this table tomorrow?" — a
 * processor that writes only by delegating into a package is invisible to that
 * guard, which is exactly how five collections went stale on QA while every
 * comment insisted they were fed (MONEY-1196).
 */
export function selectMissingNavPoints(
  points: ReadonlyArray<{ date: Date; nav: number }>,
  storedDates: readonly Date[],
): Array<{ date: Date; nav: number }> {
  const stored = navDateKeys(storedDates);
  return points.filter((p) => !stored.has(p.date.getTime()));
}

/** How many rows go into one `createMany`. */
export const MF_NAV_INSERT_CHUNK = 1_000;
