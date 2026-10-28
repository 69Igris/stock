/**
 * `publishEvents` — the one writer for `InstrumentEvent`. MONEY-1507 (C1).
 *
 * Every producer (the SEC detector via `POST /jobs/us-filing-events`, the Tiingo
 * news poll, C3's filing and press linkers) goes through this. It does two
 * things:
 *
 *   1. VALIDATE against the zod contract. An event that fails is refused, not
 *      coerced — a producer that cannot name a listing or an entity has
 *      produced something no consumer can retrieve.
 *   2. UPSERT into Mongo on `eventId`. This is the serving copy, and it is what
 *      C4's evaluator, the events tab and `/discover/news?entity=` read.
 *
 * ## THERE IS NO PUB/SUB LEG, AND THAT IS A DELIBERATE DEPARTURE FROM THE BRIEF
 *
 * C1 specifies `publishEvent(evt)` as "Mongo upsert + Pub/Sub
 * `instrument-event-{env}` publish + async append to silver (batched by a small
 * Cloud Run consumer `event-lake-sink`)". Two measured facts on disk make that
 * arrangement impossible AS WRITTEN, and a third makes it unnecessary:
 *
 *   1. THE WORKERS SERVICE CANNOT WRITE BIGQUERY. It runs as `stockbook-api@`
 *      (`workers/cloudbuild.{prod,qa}.yaml`, `serviceAccountName:`), and
 *      `docs/reference/lake-layout.md` §10 says that account gets "nothing on
 *      BigQuery" — "everything" in the Never column. `setup-lake.sh` grants it
 *      nothing and deliberately avoids even project-level impersonation, whose
 *      comment names `stockbook-api@` as the reason. So a push subscription
 *      landing on a worker route could not perform the append it exists for.
 *   2. NOTHING ELSE IN THE PLAN CONSUMES THE TOPIC. C3's linkers consume
 *      `news-item-{env}` / `filing-item-{env}` and EMIT through this function;
 *      C4's evaluator reads Mongo (`observed_at > last run`). So with the sink
 *      moved, `instrument-event-{env}` would have a publisher and no consumer —
 *      the dead-topic shape `topic-publisher-coverage.test.ts` was written for
 *      after `fund-composition-sync` and `proactive-analysis`.
 *   3. A PUB/SUB HOP WOULD MAKE THE LAKE LOSSY. The publish has to be fail-soft
 *      (the EDGAR detect loop must not die because an events topic is down), so
 *      a dropped message is a silver row that never exists and nothing ever
 *      notices. `scripts/jobs/event-lake-sink.ts` instead drains THIS
 *      collection by watermark, from a Cloud Run job running as
 *      `lake-writer-{env}@`: a run that fails simply re-reads the same window.
 *
 * Reinstating the topic is a small change the day something needs it — one
 * `PUBSUB_TOPICS` entry, one publish call here, one consumer. It is not built
 * on spec, because a topic nobody reads is indistinguishable from one whose
 * reader was lost in a refactor.
 *
 * ## `us-filing-events` IS NOT THAT TOPIC — MONEY-1520
 *
 * A topic by that name now exists and none of the three reasons above bears on
 * it, so do not read them as forbidding it. They are about the LAKE SINK — the
 * silver append. `us-filing-events` is the SEC producer's TRANSPORT into this
 * function: `services/us-fundamentals` (Python) publishes claimed filings and
 * `/jobs/us-filing-events` consumes them.
 *
 *   (1) it ends in a Mongo upsert, not a BigQuery append, so
 *       `stockbook-api@`'s lack of BigQuery access is irrelevant;
 *   (2) it HAS a consumer — that is the entire point of it;
 *   (3) losslessness runs the OTHER way. The transport it replaced was a
 *       cross-service HTTP POST to `/internal/events`, and it lost 100% of its
 *       messages, silently, for its whole life: this service is
 *       `ingress: internal` and the producer has no VPC egress, so Cloud Run
 *       refused every call at the edge with a 404 while `[job-outcome]`
 *       reported `failed: 0`. Pub/Sub with retries and a dead-letter topic is
 *       strictly better than that.
 *
 * The silver append is UNCHANGED: `scripts/jobs/event-lake-sink.ts` still
 * drains this collection by watermark.
 *
 * ## THIS FILE NEVER WRITES `expiresAt` — MONEY-1521
 *
 * It used to stamp `observedAt + 30d` on every upsert, which put a delete timer
 * on every row with no knowledge of whether the lake ever took it: a sink that
 * was broken, unscheduled or merely behind would have lost rows silently. The
 * LAKE SINK is now its only writer, and stamps a row only after silver holds
 * it. Mongo's TTL monitor skips a document whose indexed field is absent, so a
 * row this function creates is born un-expirable and stays so until the lake
 * has it. Nothing here may write the field — not even a `null`.
 */

import { prisma, type Prisma } from "@usemoney/database";
import {
  instrumentEventSchema,
  type InstrumentEvent,
} from "@usemoney/core/events/event-types";

/** Mongo collection + index names. Shared with `ensureInstrumentEventIndexes`. */
export const EVENT_COLLECTION = "instrument_events";
export const EVENT_TTL_INDEX = "instrument_events_expires_ttl";

export interface PublishEventsResult {
  /** Rows written to Mongo (created + updated). */
  upserted: number;
  /**
   * Events whose upsert threw. NOT silently zero: a run that stored nothing and
   * reported success is the failure shape this repo keeps paying for.
   */
  failed: number;
}

/* ─────────────────────────────────────────────────────────────────────────
   The TTL index
   ──────────────────────────────────────────────────────────────────────── */

/**
 * The `createIndexes` command. Exported so the shell and the test agree.
 *
 * `expireAfterSeconds: 0` means "delete when the DATE in this field has
 * passed", which is what makes `expiresAt` the anchor — the same arrangement
 * `pubsub_message_dedupe` uses. A non-zero value here would ADD to a date that
 * is already in the future and silently double the retention.
 *
 * Deliberately NOT sparse and NOT partial: the TTL monitor already skips a
 * document whose `expiresAt` is absent or not a date, and that skip is the
 * whole MONEY-1521 interlock — the lake sink is the only writer of the field.
 */
export function instrumentEventIndexCommand(): Record<string, unknown> {
  return {
    createIndexes: EVENT_COLLECTION,
    indexes: [
      { key: { expiresAt: 1 }, name: EVENT_TTL_INDEX, expireAfterSeconds: 0 },
    ],
  };
}

let indexPromise: Promise<void> | null = null;

/**
 * Create the TTL index once per process. Best-effort, and loudly so.
 *
 * `db push` creates the two `@@index` entries in the schema and CANNOT create a
 * TTL index — Prisma has no syntax for one. Without this call the collection
 * grows forever while every query still works, which stays invisible until the
 * Atlas tier B6 is trying to downgrade runs out of room.
 *
 * And `db push` DROPS it. Measured 2026-09-23 with a read-only
 * `prisma migrate diff --from-schema-datasource` against prod: the one
 * difference between prod and schema.prisma is `[-] Index
 * instrument_events_expires_ttl`. So after any `setup-infra.sh {env} --only
 * db`, rows stop expiring until a worker process restarts and calls this. That
 * is the SAFE direction under MONEY-1521 — Mongo grows, nothing the lake lacks
 * is lost — but it is not "applied by db push".
 *
 * It does not throw: a failed `createIndexes` must not stop events being
 * written, because an unbounded collection is a slow problem and a dropped
 * event is an immediate one. `createIndexes` is idempotent.
 */
export function ensureInstrumentEventIndexes(): Promise<void> {
  if (indexPromise) return indexPromise;
  indexPromise = (async () => {
    try {
      await prisma.$runCommandRaw(
        instrumentEventIndexCommand() as Prisma.InputJsonObject,
      );
    } catch (err) {
      console.error(
        "[events] createIndexes failed — instrument_events has NO TTL index " +
          "and will grow without bound. Events are still being written.",
        err,
      );
    }
  })();
  return indexPromise;
}

/* ─────────────────────────────────────────────────────────────────────────
   The writer
   ──────────────────────────────────────────────────────────────────────── */

/** Injectable seams, so the tests drive the real function with fakes. */
export interface PublishEventsDeps {
  upsert?: (event: InstrumentEvent) => Promise<void>;
  ensureIndexes?: () => Promise<void>;
  logError?: (message: string, err?: unknown) => void;
}

/**
 * The upsert arguments for one event. Exported so the tests read the ACTUAL
 * arguments rather than a description of them.
 *
 * ## TWO WRITE SHAPES, AND WHICH ONE A FIELD JOINS IS A DECISION
 *
 * `mutable` is spelled ONCE and written on create AND update, so a new contract
 * field cannot land on inserts and be missing from updates — which would leave
 * an improved row permanently carrying the first pass's value.
 *
 * `firstSighting` is CREATE-ONLY, and it holds `observedAt`: the instant we
 * FIRST saw the thing. That is a fact about the first emission, and every later
 * emission carries its own `new Date()` — so while it sat in the shared shape,
 * each re-emission overwrote it (MONEY-1531). Measured on prod 2026-09-23:
 * 11,871 of 11,976 news events (99.1%) carried an `observedAt` moved past their
 * own creation, median 4.8 h, max 10.9 h, because the news poll re-emits every
 * article its overlap re-reads. A point-in-time read dated each headline hours
 * late, and the lake sink's `(event_id, observed_at, enriched_at)` key turned
 * every move into a second silver row. A field belongs here only if it
 * describes the FIRST emission and a re-emission cannot know better.
 *
 * `expiresAt` is in NEITHER shape and must never join one — see the header.
 */
export function instrumentEventUpsertArgs(event: InstrumentEvent) {
  const mutable = {
    market: event.market,
    listingId: event.listingId ?? null,
    entityId: event.entityId ?? null,
    eventType: event.eventType,
    severity: event.severity,
    title: event.title,
    evidenceUri: event.evidenceUri ?? null,
    source: event.source,
    sourceRecordKey: event.sourceRecordKey,
    publishedAt: event.publishedAt ?? null,
    linkerVersion: event.linkerVersion,
    confidence: event.confidence,
    tags: [...event.tags],
    supersedesEventId: event.supersedesEventId ?? null,
  };
  const firstSighting = { observedAt: event.observedAt };
  return {
    where: { eventId: event.eventId },
    create: {
      eventId: event.eventId,
      ...firstSighting,
      ...mutable,
      summary: event.summary ?? null,
      enrichedAt: event.enrichedAt ?? null,
    },
    // `summary` and `enrichedAt` are OMITTED from the UPDATE when the incoming
    // event carries none, so a re-emission cannot erase an enrichment.
    //
    // `enrichEvent` is their other writer and the two run in that order: the
    // detector emits with no summary, the insight sweep adds one minutes later.
    // A later re-emission from the same producer — a manual replay, a reparse —
    // also carries no summary, and a plain `update: row` would set it back to
    // null. Nothing would report that: the row still exists, still has its
    // title, and the events tab simply stops showing the sentence.
    //
    // Same shape as `tiingo-news-poll`'s `tickers`, for the same reason:
    // narrowing the WRITE makes "a re-read can only improve a row" true by
    // construction instead of being a hope.
    update: {
      ...mutable,
      ...(event.summary ? { summary: event.summary } : {}),
      ...(event.enrichedAt ? { enrichedAt: event.enrichedAt } : {}),
    },
  };
}

async function defaultUpsert(event: InstrumentEvent): Promise<void> {
  await prisma.instrumentEvent.upsert(instrumentEventUpsertArgs(event));
}

/* ─────────────────────────────────────────────────────────────────────────
   Enrichment
   ──────────────────────────────────────────────────────────────────────── */

export interface EnrichEventResult {
  /** True when a row was found and updated. */
  enriched: boolean;
  /** Set when it was not. The one reachable cause, NAMED rather than counted
   *  as a failure: an absent event is normal and a database error is not. */
  reason?: "not-found";
}

/** The Prisma error code for "record to update not found". */
const PRISMA_RECORD_NOT_FOUND = "P2025";

/**
 * Add a summary to an event that already exists. MONEY-1507 (C1 item 4).
 *
 * A PARTIAL update, never an upsert, and that is the whole design. The brief
 * asks the insight sweep to emit "an UPDATE event (same event_id +
 * `enriched_at`, summary from the insight)", and the only honest way to do that
 * is to write the two columns the enrichment actually KNOWS.
 *
 * The sweep reads `us_filing_documents`, which carries no `acceptedAt`. So
 * rebuilding the whole event would downgrade `publishedAt` from SEC's
 * acceptance INSTANT to the filing DATE — on a row that already held the better
 * value, with nothing on the row to say it had been made worse, and on the one
 * clock this repo has already documented as running a business day ahead.
 *
 * A MISSING row is a NAMED no-op, never a create. The event may legitimately
 * not exist: the filing predates C1, the detector's emission failed (fail-soft
 * by contract), or the TTL reaped it after the lake sink confirmed it
 * (MONEY-1521). Creating one here would invent an
 * event with no market, no listing and a `severity` defaulted to something —
 * and that default is a number C4's alert floor reads.
 */
export async function enrichEvent(
  eventId: string,
  enrichment: { summary: string; enrichedAt: Date },
  deps: {
    update?: (
      id: string,
      e: { summary: string; enrichedAt: Date },
    ) => Promise<void>;
  } = {},
): Promise<EnrichEventResult> {
  const update =
    deps.update ??
    (async (id, e) => {
      await prisma.instrumentEvent.update({
        where: { eventId: id },
        data: { summary: e.summary, enrichedAt: e.enrichedAt },
      });
    });
  try {
    await update(eventId, enrichment);
    return { enriched: true };
  } catch (err) {
    // Matched on the CODE, never on the message: the message is prose and a
    // substring test on it would start reading a real database failure as an
    // absent row the day Prisma rewords it.
    if ((err as { code?: string } | null)?.code === PRISMA_RECORD_NOT_FOUND) {
      return { enriched: false, reason: "not-found" };
    }
    throw err;
  }
}

/**
 * Validate, then upsert into Mongo.
 *
 * Returns counts rather than throwing on a per-row failure, for the reason in
 * the header: the callers are the EDGAR detect loop and the news poll, and
 * neither may be taken down by an events problem. A caller that needs to fail
 * reads `failed`.
 *
 * A zod failure DOES throw, and that is the one exception: an invalid event is
 * a bug in the producer, not a transient condition, and admitting it would put
 * a row in the serving copy that no consumer can use.
 */
export async function publishEvents(
  events: readonly unknown[],
  deps: PublishEventsDeps = {},
): Promise<PublishEventsResult> {
  const upsert = deps.upsert ?? defaultUpsert;
  const ensureIndexes = deps.ensureIndexes ?? ensureInstrumentEventIndexes;
  const logError = deps.logError ?? ((m, e) => console.error(m, e));

  // Parse EVERY event before writing ANY of them. A half-written batch whose
  // tail was invalid leaves the producer with no way to tell which rows landed.
  const parsed = events.map((e) => instrumentEventSchema.parse(e));
  if (parsed.length === 0) return { upserted: 0, failed: 0 };

  await ensureIndexes();

  let upserted = 0;
  let failed = 0;
  for (const event of parsed) {
    try {
      await upsert(event);
      upserted++;
    } catch (err) {
      failed++;
      logError(`[events] upsert failed for ${event.eventId}`, err);
    }
  }
  return { upserted, failed };
}

/** One event. The brief names this; it delegates so there is one code path. */
export async function publishEvent(
  event: unknown,
  deps: PublishEventsDeps = {},
): Promise<PublishEventsResult> {
  return publishEvents([event], deps);
}
