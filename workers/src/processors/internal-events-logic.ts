/**
 * The `POST /internal/events` request contract. MONEY-1507 (C1).
 *
 * PURE — no Prisma, no Pub/Sub, no clock. The shell is
 * `workers/src/processors/internal-events.ts`.
 *
 * ## WHY THE PYTHON SIDE POSTS FILINGS AND NOT EVENTS
 *
 * `services/us-fundamentals` is a separate Cloud Run service and the seam to
 * the TypeScript side is Mongo + Pub/Sub, never an import — a test enforces
 * that. So the EDGAR detector cannot call `secFilingEvent()`, and the C1 brief
 * resolves this by having it call a small HTTP endpoint here "rather than
 * duplicating the writer in Python".
 *
 * This request carries FACTS THE DETECTOR ALREADY HAS — the `us_filings` row it
 * just claimed — and nothing derived. The listing resolution, the form->type
 * mapping, the severity ladder and the event id are all computed HERE, once, in
 * the language that owns the contract. A Python copy of any of them would be a
 * second spelling of a rule that has to agree forever, which is precisely the
 * defect class this repo keeps paying for (`mimeType` exact-vs-substring,
 * MONEY-1255; the concept vocabulary, MONEY-979).
 *
 * ## DATES ARRIVE AS ISO STRINGS
 *
 * `JSON.stringify(new Date())` on both sides produces `2026-08-29T01:53:58.000Z`
 * — `app/publish.py`'s `iso_timestamp` mirrors it exactly. Zod's `z.date()`
 * would reject the string, so each is coerced HERE, and an UNPARSEABLE one is
 * refused rather than becoming `Invalid Date`: an Invalid Date flows through
 * every comparison as `false` and lands in Mongo as a null, so the event would
 * store with no `publishedAt` and nothing anywhere saying why.
 */

import { z } from "zod";

/** ISO-8601 -> Date, refusing anything that does not parse. */
const isoDate = z
  .string()
  .min(1)
  .transform((s, ctx) => {
    const d = new Date(s);
    if (Number.isNaN(d.getTime())) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          `not an ISO-8601 timestamp: ${JSON.stringify(s)}. Refused rather ` +
          "than coerced — an Invalid Date compares false everywhere and " +
          "stores as null, so the row would look merely incomplete.",
      });
      return z.NEVER;
    }
    return d;
  });

/**
 * One claimed filing.
 *
 * `accession` and `cik10` are both REQUIRED and both shape-checked. They are
 * the two halves of every downstream identity: the accession IS the event's
 * `source_record_key` (and therefore half its id), and `cik10` is the join key
 * to a listing. A malformed one of either produces an event that looks fine and
 * can never be matched to anything.
 *
 * The cik shape is TEN DIGITS, which is how SEC spells it in every URL, bulk
 * filename and API path, and how `us_filings` / `us_filers` / `us_instruments`
 * all store it. An unpadded `320193` joins to nothing.
 */
export const secFilingRequestSchema = z.object({
  accession: z
    .string()
    .regex(
      /^\d{10}-\d{2}-\d{6}$/,
      "accession must be SEC's dashed form, 0000320193-26-000106",
    ),
  cik10: z.string().regex(/^\d{10}$/, "cik10 must be zero-padded to 10 digits"),
  form: z.string().min(1),
  items: z.array(z.string()).optional(),
  acceptedAt: isoDate.nullish(),
  filedAt: isoDate.nullish(),
  /**
   * MONEY-1532 — WHEN THE DETECTOR SAW IT: `us_filings.detectedAt`, the claim
   * instant. A bare string on purpose, NOT `isoDate`: an unusable value falls
   * back (see `payloadObservedAt`) instead of 400-ing a batch of up to 500
   * good filings into the dead-letter topic over one clock.
   */
  observedAt: z.string().nullish(),
  // NO `summary` / `enrichedAt`. The ENRICHMENT does not come through this
  // route: `us-filing-insight` runs inside the workers and calls
  // `enrichEvent` directly, which writes those two columns and nothing else.
  //
  // Declaring them here anyway would be a field the route accepts, forwards
  // and nobody ever sends — the shape `createMissing` had for two releases,
  // documented as supported and `undefined` in every production run that ever
  // executed (MONEY-1235).
});

export type SecFilingRequest = z.infer<typeof secFilingRequestSchema>;

/**
 * A batch of claimed filings.
 *
 * `.min(1)` — an empty batch is REFUSED rather than answered 200 with a zero.
 * A producer that sends nothing has a bug, and the alternative is a healthy
 * looking `{written: 0}` that is indistinguishable from a quiet minute. Same
 * rule as `encodeNdjson` refusing a zero-row stage object.
 *
 * `MAX_FILINGS_PER_REQUEST` bounds one request's work inside the 600 s a
 * Cloud Run request has. A detect run fans out at most a few dozen filings; the
 * cap exists so a future bulk caller is told to page rather than discovering
 * the limit as a timeout.
 */
export const MAX_FILINGS_PER_REQUEST = 500;

export const internalEventsRequestSchema = z.object({
  filings: z
    .array(secFilingRequestSchema)
    .min(1, "refusing an empty batch — see the schema comment")
    .max(
      MAX_FILINGS_PER_REQUEST,
      `at most ${MAX_FILINGS_PER_REQUEST} filings per request; page instead`,
    ),
});

export type InternalEventsRequest = z.infer<typeof internalEventsRequestSchema>;

/**
 * The distinct CIKs in a batch, so the shell issues ONE lookup rather than N.
 *
 * A `Set` because EDGAR routinely files several forms for one company in a
 * minute (a 10-Q plus its 8-K plus three Form 4s), and `findMany({in: [...]})`
 * with a repeated value scans the same index entries again for nothing.
 */
export function distinctCiks(filings: readonly SecFilingRequest[]): string[] {
  return [...new Set(filings.map((f) => f.cik10))];
}

/**
 * The earliest `observedAt` accepted. An observation of an EDGAR filing cannot
 * predate EDGAR (first electronic filings: 1993); anything earlier is a zeroed
 * or defaulted clock — epoch 0 is 1970, Python's `datetime.min` is year 1.
 */
export const OBSERVED_AT_FLOOR = new Date("1993-01-01T00:00:00.000Z");

/**
 * How far past the reference instant a claimed `observedAt` may sit.
 *
 * The producer stamps `detectedAt` BEFORE it publishes, so against the
 * envelope's `publishTime` the only honest excess is skew between two
 * NTP-disciplined Google clocks — milliseconds. Sixty seconds is margin on that
 * and still far under any real nonzero UTC offset (an hour at least; IST is
 * +5:30), which is the size of the one likely producer bug: local time sent as
 * UTC. It catches that bug from zones EAST of UTC, which stamp the future; a
 * zone west of UTC stamps the past, and no rule here can tell that from a
 * genuinely old claim — the zone rule below only catches a MISSING zone.
 *
 * SIXTY SECONDS, NOT FIVE MINUTES — MONEY-1532 review. The lake sink
 * (`packages/lake/src/events-logic.ts` `CLOCK_SKEW_TOLERANCE_MS`, 60 s) refuses
 * for ever any row whose `observedAt` is more than 60 s after its `ingestedAt`
 * — the MONEY-1531 "moved clock" signature. `ingestedAt` is stamped at the
 * create, a moment after `publishTime`, so a claim this route accepted at
 * +90 s would never be sunk, never be stamped, and never expire. The two bounds
 * must agree, and this one may only be the tighter.
 */
export const OBSERVED_AT_MAX_LEAD_MS = 60 * 1000;

/**
 * An ISO-8601 date-time WITH an explicit zone. Measured on this repo's Node:
 * `new Date("2026-09-22T10:00:00")` is LOCAL time, so a zone-less stamp names a
 * different instant on every host whose TZ is not UTC.
 */
const ZONED_ISO_DATETIME =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:\d{2})$/i;

/**
 * The producer's claim instant, if it is usable as the event's `observedAt` —
 * else `null`, and the caller falls back to the envelope's `publishTime` (or
 * the wall clock for a direct body). MONEY-1532.
 *
 * Decided HERE rather than in the schema, so one bad clock costs one event its
 * precision instead of 400-ing its whole batch. Usable means all of:
 *
 *   - a zoned ISO-8601 date-time (see `ZONED_ISO_DATETIME`) that parses;
 *   - not before `OBSERVED_AT_FLOOR`;
 *   - not after `reference + OBSERVED_AT_MAX_LEAD_MS`, where `reference` is the
 *     fallback itself. The producer stamps before it publishes, so an
 *     observation later than the publish is impossible — and the publish
 *     instant is then the tighter bound on when we really saw the filing.
 *
 * There is deliberately NO recency rule. A backfill re-emits claims days old ON
 * PURPOSE, and "too old, use publishTime" would stamp exactly those with TODAY
 * — a week-old filing arriving as new and firing every alert on it at once,
 * which is the defect this field exists to remove.
 */
export function payloadObservedAt(
  claimed: string | null | undefined,
  reference: Date,
): Date | null {
  if (!claimed || !ZONED_ISO_DATETIME.test(claimed)) return null;
  const at = new Date(claimed);
  const ms = at.getTime();
  if (!Number.isFinite(ms)) return null;
  if (ms < OBSERVED_AT_FLOOR.getTime()) return null;
  if (ms > reference.getTime() + OBSERVED_AT_MAX_LEAD_MS) return null;
  return at;
}

/**
 * The HTTP status for a completed batch — which is to say, ACK or NACK.
 *
 * MONEY-1520. This is a one-expression decision and it lives here, not inline
 * in the route, for the reason the header gives about every other decision in
 * this file: a source scan cannot tell `failed > 0` from `failed >= 0`, and the
 * difference between those two is whether a partially-written batch is
 * discarded or redelivered.
 *
 * ## PUB/SUB ACKS ONLY ON 2xx, SO A 2xx MUST MEAN "DONE"
 *
 * This route used to answer 200 with `success: false` when some upserts threw.
 * Under a direct POST that was a number the caller logged and moved past. Under
 * a push subscription it is an ACK: the message is gone, and with it every
 * event whose upsert failed — the same silent-loss shape, one layer down from
 * the one MONEY-1520 fixed.
 *
 * A retry is free. `publishEvents` upserts on a deterministic `eventId`
 * (`sha1(source + NUL + accession)`), so re-running the rows that already
 * landed writes the same values again. After five attempts the message parks on
 * `dead-letter-{env}` WITH its payload, which is what makes a genuinely poison
 * batch visible rather than silently dropped.
 */
export function ackStatusFor(result: { readonly failed: number }): 200 | 500 {
  return result.failed > 0 ? 500 : 200;
}
