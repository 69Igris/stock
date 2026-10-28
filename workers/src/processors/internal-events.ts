/**
 * `POST /internal/events` — the SEC producer's shell. MONEY-1507 (C1).
 *
 * Resolves each filing's CIK to a listing, builds the event through the shared
 * contract, and hands the batch to `publishEvents`. Every DECISION is in
 * `internal-events-logic.ts` (the request contract) or in
 * `@usemoney/core/events/event-types` (the event contract); this file reads
 * Mongo and calls them.
 *
 * ## THE RESOLUTION IS `UsInstrument.cik`, NOT `UsFiler` OR `UsCusipMap`
 *
 * The C1 brief says "resolve cik10 -> listing_id via UsFiler/UsCusipMap
 * (exact)". Neither of those tables HAS a listing id: `UsFiler` carries SIC,
 * former names and the tickers AS THE FILER DECLARES THEM (which is explicitly
 * not our universe), and `UsCusipMap` maps a CUSIP to a ticker. The column that
 * holds the join is `UsInstrument.cik`, written by the nightly EDGAR
 * `company_tickers` pass and indexed — the same call `identity-sync` made for
 * `lake_silver.listing`, for the same reason.
 *
 * `UsFiler` IS read, for the company NAME only, because an event titled
 * "Apple Inc. — 8-K" is legible and one titled "0000320193 — 8-K" is not.
 *
 * ## A CIK WITH NO LISTING IS NOT AN ERROR
 *
 * A fund manager filing 13F, a private filer, an issuer listed this morning —
 * all real, all unmappable today, and all still events about the FILER. The
 * event is stored with `listingId: null` and `confidence: 0.5`; C3's linkers
 * fill it in later. Dropping them would shrink the corpus with nothing to
 * measure the loss against.
 *
 * ## THE ROW WE PICK WHEN A CIK HAS SEVERAL LISTINGS
 *
 * ACTIVE first, then the oldest `listingStartDate`. A CIK legitimately owns
 * several rows — share classes (`BRK-A` / `BRK-B`), a delisted predecessor
 * beside its successor — and an arbitrary pick would attach a company's filings
 * to whichever row Mongo returned first, which can change between runs. Oldest
 * ACTIVE is the primary listing in every case measured here.
 */

import { prisma } from "@usemoney/database";
import {
  secFilingEvent,
  type InstrumentEvent,
} from "@usemoney/core/events/event-types";
import {
  publishEvents,
  type PublishEventsResult,
} from "@usemoney/services/events";
import {
  distinctCiks,
  internalEventsRequestSchema,
  payloadObservedAt,
  type SecFilingRequest,
} from "./internal-events-logic";

export interface InternalEventsResult extends PublishEventsResult {
  received: number;
  /** How many of the batch resolved to a listing — the linkage coverage. */
  listingResolved: number;
  /**
   * How many events took `observedAt` from the PAYLOAD (the detector's claim
   * instant) rather than the fallback — MONEY-1532. Counted so "the producer
   * sends it and this route honours it" is a number in the log line, not an
   * assumption: a field the route accepts and silently ignores is
   * `createMissing` again (MONEY-1235).
   */
  observedAtFromPayload: number;
}

/** Injectable seams, so the whole processor runs in a test with no Mongo. */
export interface InternalEventsDeps {
  /** cik10 -> listingId, for the CIKs in this batch. */
  resolveListings?: (ciks: readonly string[]) => Promise<Map<string, string>>;
  /** cik10 -> company name. */
  resolveNames?: (ciks: readonly string[]) => Promise<Map<string, string>>;
  publish?: typeof publishEvents;
  now?: () => Date;
}

async function defaultResolveListings(
  ciks: readonly string[],
): Promise<Map<string, string>> {
  // `cik: { in: [...] }` is a POSITIVE filter on a value. Never
  // `{ cik: { not: null } }` — a Mongo `db push` creates indexes and not
  // fields, so both polarities of a null test return zero on rows that predate
  // the column (MONEY-1050 / 1205 / 1234 / 1236).
  const rows = await prisma.usInstrument.findMany({
    where: { cik: { in: [...ciks] } },
    select: { cik: true, listingId: true },
    // "ACTIVE" sorts before "DELISTED", so ascending puts a live listing first;
    // `listingStartDate` ascending then picks the OLDEST of the survivors,
    // which is the primary listing in every case measured here. Ordering
    // explicitly rather than taking whatever Mongo returned first is what makes
    // the answer the same on two consecutive runs.
    orderBy: [{ listingStatus: "asc" }, { listingStartDate: "asc" }],
  });
  const out = new Map<string, string>();
  for (const row of rows) {
    if (!row.cik || out.has(row.cik)) continue;
    out.set(row.cik, row.listingId);
  }
  return out;
}

async function defaultResolveNames(
  ciks: readonly string[],
): Promise<Map<string, string>> {
  const rows = await prisma.usFiler.findMany({
    where: { cik10: { in: [...ciks] } },
    select: { cik10: true, name: true },
  });
  return new Map(rows.map((r) => [r.cik10, r.name]));
}

/**
 * Turn a batch of claimed SEC filings into `InstrumentEvent` rows.
 *
 * THROWS on an invalid request — that is a producer bug and a 400, not a
 * transient condition. Everything after validation is counted rather than
 * thrown, because the caller is the EDGAR detect loop and it must not be taken
 * down by an events problem.
 */
export async function processInternalEvents(
  body: unknown,
  deps: InternalEventsDeps = {},
): Promise<InternalEventsResult> {
  const resolveListings = deps.resolveListings ?? defaultResolveListings;
  const resolveNames = deps.resolveNames ?? defaultResolveNames;
  const publish = deps.publish ?? publishEvents;
  const now = deps.now ?? (() => new Date());

  const request = internalEventsRequestSchema.parse(body);
  const ciks = distinctCiks(request.filings);
  const [listings, names] = await Promise.all([
    resolveListings(ciks),
    resolveNames(ciks),
  ]);

  // `observedAt` is EACH FILING'S OWN claim instant when the producer sent a
  // usable one (MONEY-1532) — `us_filings.detectedAt`, which is earlier than
  // any publish and, for a backfilled filing, days earlier than this one.
  //
  // The FALLBACK is ONE instant for the whole batch, and `now` is the
  // envelope's `publishTime` when the route has one. The detector saw these
  // filings in one pass; stamping each with its own `new Date()` would make
  // the ordering inside a batch depend on how long the Mongo lookups took.
  const fallbackObservedAt = now();
  let observedAtFromPayload = 0;

  const events: InstrumentEvent[] = request.filings.map(
    (f: SecFilingRequest) => {
      const claimed = payloadObservedAt(f.observedAt, fallbackObservedAt);
      if (claimed) observedAtFromPayload++;
      return secFilingEvent(
        {
          accession: f.accession,
          cik10: f.cik10,
          form: f.form,
          items: f.items ?? [],
          acceptedAt: f.acceptedAt ?? null,
          filedAt: f.filedAt ?? null,
          listingId: listings.get(f.cik10) ?? null,
          entityName: names.get(f.cik10) ?? null,
        },
        claimed ?? fallbackObservedAt,
      );
    },
  );

  const result = await publish(events);
  return {
    ...result,
    received: request.filings.length,
    listingResolved: events.filter((e) => e.listingId).length,
    observedAtFromPayload,
  };
}
