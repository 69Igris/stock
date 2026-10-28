/**
 * Mongo -> `lake_silver` row shapes for events and filings. MONEY-1507 (C1).
 * And the serving copy's lifecycle: who may stamp `expiresAt`, and when
 * (MONEY-1521), and the one-off clock repair (MONEY-1531).
 *
 * PURE — no BigQuery, no Prisma, no clock. `appendThenStamp` takes its two
 * effects as arguments so the ORDER it imposes is testable without either. The
 * shells are `scripts/jobs/event-lake-sink.ts`,
 * `scripts/jobs/filing-registry-sync.ts` and
 * `scripts/data/repair-instrument-event-clocks.ts`.
 *
 * ## THE KEYS ARE snake_case BECAUSE THE SQL READS THEM BY NAME
 *
 * Both jobs write with `INSERT ... SELECT FROM UNNEST(@rows)`, the shape
 * `identity-sync` uses, so each property name here IS a column name. A
 * camelCase key silently supplies NULL for its column: the statement succeeds,
 * the row lands, and the column is empty for ever.
 *
 * ## `observed_at` IS ALWAYS THE SOURCE'S CLOCK, NEVER ours
 *
 * lake-layout.md §6. For an event it is the instant the producer SAW the thing
 * (the detector's observation, already stamped on the Mongo row). For a filing
 * it is SEC's acceptance instant, falling back to the filing DATE at UTC
 * midnight — never `ingestedAt`, which would back-date every backfilled row to
 * the day the backfill ran and make a point-in-time query see data the market
 * could not have seen.
 */

/**
 * Bumped when the MEANING of a produced column changes.
 *
 * v2 — MONEY-1531: `observed_at` is the FIRST sighting. Every v1 row carries a
 * later RE-EMISSION's instant instead, because `publishEvents` rewrote
 * `observedAt` on every upsert. Measured on prod 2026-09-23: all 5,323 v1 rows
 * (one run, 16:45Z on 2026-09-22) share `observed_at` 16:43:34Z — the poll that
 * last re-emitted them — for events first ingested from 13:03Z on.
 * `event-lake-sink --reload` rewrites them from the repaired serving copy.
 */
export const EVENT_SINK_PARSER_VERSION = "event-lake-sink-v2";
export const FILING_REGISTRY_PARSER_VERSION = "filing-registry-v1";

/**
 * How far back of the watermark each sink run re-reads.
 *
 * TWO HOURS, and it is not caution. The watermark is the newest `ingested_at`
 * in silver — the sink's OWN write clock — and the Mongo side is selected on
 * `updatedAt`, which moves whenever a row is written. Two clocks on two
 * machines, and a row can be written between a run reading its window and the
 * same run stamping `ingested_at`. A strict `>` would drop it permanently and
 * leave a gap no count can see, which is the reasoning `tiingo-news-poll`'s
 * 30-minute `crawlDate` overlap is built on.
 *
 * The overlap is safe because the sink SKIPS the (event_id, observed_at,
 * enriched_at) triples silver already holds, so a re-read writes nothing.
 */
export const SINK_OVERLAP_MS = 2 * 60 * 60 * 1000;

/**
 * The window a sink run should read, given the newest `ingested_at` in silver.
 *
 * `ingested_at`, NOT `observed_at`, and the difference is the whole enrichment
 * story. `observed_at` is the PRODUCER's clock and it never moves again — the
 * 8-K insight sweep adds a summary hours later WITHOUT touching it, because
 * point-in-time correctness says we saw the filing when we saw it. (True by
 * construction only since MONEY-1531 made it create-only in `publishEvents`;
 * before that, every re-emission moved it.) A window
 * anchored on `observed_at` would therefore never re-read an enriched row, and
 * the silver copy would carry `summary: null` for ever while Mongo held the
 * sentence. Our own write clock is the one that moves when we learn something.
 *
 * `null` means the table is EMPTY and the whole history is in scope — returned
 * as `null` rather than as epoch-zero so the caller can tell a first run from
 * an incremental one and say so, instead of silently reading everything and
 * looking like a normal night.
 */
export function sinkWindowStart(
  watermark: Date | null,
  overlapMs: number = SINK_OVERLAP_MS,
): Date | null {
  if (!watermark) return null;
  if (!Number.isFinite(watermark.getTime())) {
    throw new Error(
      "sinkWindowStart: the watermark is an Invalid Date. Refused rather than " +
        "coerced — every comparison against it is false, so the run would " +
        "select nothing and report a clean, healthy, empty night.",
    );
  }
  return new Date(watermark.getTime() - overlapMs);
}

/** Split into statement-sized chunks. See `recordSourceObjects` for the why. */
export function chunkRows<T>(rows: readonly T[], size: number): T[][] {
  if (!Number.isInteger(size) || size < 1) {
    throw new Error(
      `chunkRows: size must be a positive integer, got ${String(size)} — a ` +
        "non-positive chunk size writes nothing and reports success",
    );
  }
  const out: T[][] = [];
  for (let i = 0; i < rows.length; i += size) out.push(rows.slice(i, i + size));
  return out;
}

/* ─────────────────────────────────────────────────────────────────────────
   instrument_event
   ──────────────────────────────────────────────────────────────────────── */

/** The Mongo `instrument_events` fields this mapper reads. */
export interface MongoEventRow {
  eventId: string;
  market: string;
  listingId: string | null;
  entityId: string | null;
  eventType: string;
  severity: number;
  title: string;
  summary: string | null;
  evidenceUri: string | null;
  source: string;
  sourceRecordKey: string;
  publishedAt: Date | null;
  observedAt: Date;
  linkerVersion: string;
  confidence: number;
  tags: string[];
  supersedesEventId: string | null;
  enrichedAt: Date | null;
}

/**
 * The key that decides whether silver already holds a row.
 *
 * THREE parts, and `enriched_at` is the one that earns its place: an
 * enrichment appends a SECOND row with the same `event_id` and the same
 * `observed_at` (the producer's clock does not move), so a two-part key would
 * skip it and the summary would never reach the lake.
 *
 * NUL-separated, for the reason `buildEventId` gives: an ISO timestamp carries
 * `:` and `.`, so a printable separator can be produced by the parts.
 */
export function eventSilverKey(row: {
  event_id: string;
  observed_at: string;
  enriched_at: string | null;
}): string {
  return `${row.event_id}\u0000${row.observed_at}\u0000${row.enriched_at ?? ""}`;
}

/** One row of `lake_silver.instrument_event`, keyed exactly as the DDL spells it. */
export interface EventSilverRow {
  event_id: string;
  market: string;
  listing_id: string | null;
  entity_id: string | null;
  event_type: string;
  severity: number;
  title: string;
  summary: string | null;
  evidence_uri: string | null;
  source: string;
  published_at: string | null;
  linker_version: string;
  confidence: number;
  tags: string[];
  supersedes_event_id: string | null;
  enriched_at: string | null;
  source_object_uri: string;
  source_record_key: string;
  observed_at: string;
}

/** `Date` -> the RFC-3339 spelling BigQuery's TIMESTAMP parameter accepts. */
function ts(d: Date | null | undefined): string | null {
  if (!d) return null;
  if (!Number.isFinite(d.getTime())) {
    throw new Error(
      "an Invalid Date reached the silver mapper. Refused rather than written " +
        "as NULL: a null timestamp reads as 'the source never stated one', " +
        "which is a different and perfectly ordinary fact.",
    );
  }
  return d.toISOString();
}

/**
 * `source_object_uri` for an event.
 *
 * There is no archived OBJECT behind an event — a producer asserted it — so the
 * column names the ASSERTION: `event://SEC_EDGAR/0000320193-26-000106`. That
 * keeps lake-layout.md §5's promise ("a wrong number can be traced to the bytes
 * and the code that produced it") to the extent that is true here, and the
 * bytes themselves are one hop further on, at `evidence_uri`.
 *
 * Spelled as a function rather than inline so the sink and any future reparse
 * cannot disagree about it.
 */
export function eventSourceObjectUri(
  source: string,
  sourceRecordKey: string,
): string {
  return `event://${source}/${sourceRecordKey}`;
}

export function toEventSilverRow(event: MongoEventRow): EventSilverRow {
  return {
    event_id: event.eventId,
    market: event.market,
    listing_id: event.listingId ?? null,
    entity_id: event.entityId ?? null,
    event_type: event.eventType,
    severity: event.severity,
    title: event.title,
    summary: event.summary ?? null,
    evidence_uri: event.evidenceUri ?? null,
    source: event.source,
    published_at: ts(event.publishedAt),
    linker_version: event.linkerVersion,
    confidence: event.confidence,
    tags: [...(event.tags ?? [])],
    supersedes_event_id: event.supersedesEventId ?? null,
    enriched_at: ts(event.enrichedAt),
    source_object_uri: eventSourceObjectUri(
      event.source,
      event.sourceRecordKey,
    ),
    source_record_key: event.sourceRecordKey,
    observed_at: ts(event.observedAt) as string,
  };
}

/* ─────────────────────────────────────────────────────────────────────────
   The serving copy's lifecycle — MONEY-1521
   ──────────────────────────────────────────────────────────────────────── */

/**
 * The Mongo collection behind `InstrumentEvent`. The stamp and the repair are
 * RAW commands, which name a collection rather than a model, so this must equal
 * the model's `@@map` — pinned against schema.prisma by a test, because a wrong
 * name is a command that matches nothing and reports `n: 0`.
 */
export const INSTRUMENT_EVENTS_COLLECTION = "instrument_events";

/**
 * How long a row stays in the serving copy once the lake has it — MONEY-1521.
 *
 * 90 days, from the longest-lived reader rather than a round number: C4's
 * evaluator reads `observed_at > last run` (minutes); the events tab and
 * `/discover/news?entity=` show 30–90 days of history. The lake keeps
 * everything.
 */
export const EVENT_RETENTION_DAYS = 90;

/**
 * `observed_at + 90d` — when the TTL monitor may delete a row the lake holds.
 *
 * Anchored on the EVENT's clock, never on the stamp time. The serving copy is a
 * window over `observed_at`, so a row sunk late must not buy a fresh 90 days;
 * and the sink re-confirms rows it re-reads (the overlap, every re-emission),
 * so a `now`-anchored stamp would push the expiry forward on every run and the
 * row would never expire at all. A row observed more than 90 days before it is
 * sunk is therefore stamped in the PAST and deleted within a minute — correctly,
 * because the lake has it.
 */
export function eventExpiresAt(
  observedAt: string,
  days: number = EVENT_RETENTION_DAYS,
): Date {
  const ms = Date.parse(observedAt);
  if (!Number.isFinite(ms)) {
    throw new Error(
      `eventExpiresAt: observed_at ${JSON.stringify(observedAt)} is not a ` +
        "timestamp. Refused rather than coerced — this value is a deletion date.",
    );
  }
  return new Date(ms + days * 86_400_000);
}

/** The Prisma `where` a sink run reads the serving copy with. */
export interface SinkSelection {
  OR?: [{ updatedAt: { gte: Date } }, { expiresAt: { isSet: false } }];
}

/**
 * Which serving-copy rows a sink run reads.
 *
 * `null` — an empty silver table, or `--reload` — reads everything. Otherwise
 * the rows WE wrote since the window start, PLUS every row the lake has not yet
 * confirmed: an ABSENT `expiresAt` means exactly that, so the sink re-reads
 * such a row, however old, until it has taken it. That arm turns three silent,
 * permanent gaps into self-healing ones:
 *
 *   - a run killed between two INSERT chunks: the watermark jumps to the chunks
 *     that landed, and the rest fall outside every later `updatedAt` window
 *     (the gap `corp-action-lake-sink`'s header measures);
 *   - an INSERT that landed and a stamp that then failed;
 *   - rows sunk before MONEY-1521, and rows the MONEY-1531 repair un-stamped —
 *     no later write brings either back into the window.
 *
 * `isSet: false`, never `null`: on Mongo a Prisma `{expiresAt: null}` matches
 * only an EXPLICIT null, and this field is absent until stamped (MONEY-1050 /
 * 1205 / 1234). Measured on prod 2026-09-23 against `stock_financials.basis`:
 * Prisma `isSet: false` 32,359 = raw `$exists: false` 32,359.
 */
export function sinkSelection(since: Date | null): SinkSelection {
  if (!since) return {};
  return {
    OR: [{ updatedAt: { gte: since } }, { expiresAt: { isSet: false } }],
  };
}

/**
 * How far `observedAt` may sit AFTER its row's creation before the sink
 * refuses the row — MONEY-1531.
 *
 * A first-sighting clock cannot be later than the create it describes: every
 * producer stamps `observedAt` BEFORE calling `publishEvents`, and `ingestedAt`
 * is written by that create. So `observedAt > ingestedAt` is the fingerprint of
 * a re-emission having overwritten it. 60 s absorbs producer/writer clock skew
 * and splits the two populations measured on prod 2026-09-23 cleanly: the 105
 * unmoved rows LEAD their creation by at most 72 s, the 11,871 moved ones TRAIL
 * it by at least 174 s.
 */
export const CLOCK_SKEW_TOLERANCE_MS = 60_000;

/**
 * True when a row's first-sighting clock was moved past its own creation.
 *
 * The sink REFUSES such a row rather than writing it, because a moved clock
 * written under the CURRENT parser version is out of `--reload`'s reach: its
 * superseded-row delete removes only OTHER versions, so the wrong row would sit
 * beside the repaired one for good — and readers take the LATEST `observed_at`,
 * which is the wrong one. A refused row also stays unstamped, so it cannot
 * expire before it has been repaired and sunk.
 */
export function observedAfterIngest(
  row: { observedAt: Date; ingestedAt: Date },
  toleranceMs: number = CLOCK_SKEW_TOLERANCE_MS,
): boolean {
  return row.observedAt.getTime() - row.ingestedAt.getTime() > toleranceMs;
}

/** What one sink run does with its candidates. */
export interface EventSinkPlan {
  /** Silver holds these at their CURRENT key: stamp, never append. */
  confirmed: EventSilverRow[];
  /** Silver does not: append, THEN stamp. */
  pending: EventSilverRow[];
}

/**
 * Split candidates by whether silver already holds their CURRENT key.
 *
 * `confirmed` means found in `inSilver` — BigQuery as read — and never "seen
 * earlier in this batch". That difference is the interlock: an in-batch
 * duplicate of a PENDING row is not in the lake yet, and stamping it before its
 * twin's INSERT lands would let the TTL delete a row the lake never took. A
 * duplicate is dropped instead; its twin's stamp covers it, being keyed on the
 * same (event_id, observed_at, enriched_at).
 */
export function planEventSink(
  candidates: readonly EventSilverRow[],
  inSilver: ReadonlySet<string>,
): EventSinkPlan {
  const plan: EventSinkPlan = { confirmed: [], pending: [] };
  const seen = new Set<string>();
  for (const row of candidates) {
    const key = eventSilverKey(row);
    if (seen.has(key)) continue;
    seen.add(key);
    (inSilver.has(key) ? plan.confirmed : plan.pending).push(row);
  }
  return plan;
}

/** The two writes a sink run makes — injected so their ORDER is testable. */
export interface EventSinkEffects {
  /** Append to silver. Must resolve only once BigQuery has committed the rows. */
  append(rows: readonly EventSilverRow[]): Promise<void>;
  /** Stamp `expiresAt` on the Mongo rows behind these; resolves to rows matched. */
  stamp(rows: readonly EventSilverRow[]): Promise<number>;
}

/**
 * Append, then stamp — per CHUNK, in that order. MONEY-1521.
 *
 * A stamp is a licence to delete: once `expiresAt` is on a row the TTL monitor
 * will remove it. So it is written only after the INSERT carrying that row has
 * returned, and a failed INSERT throws BEFORE its own stamp — every row it
 * carried stays unstamped, un-expirable, and in the next run's selection. Per
 * chunk rather than per run, so a failure part-way leaves exactly the chunks
 * that landed stamped.
 *
 * `confirmed` rows go last: they are in the lake already, and a Mongo problem
 * stamping them must not hold back the append.
 */
export async function appendThenStamp(
  plan: EventSinkPlan,
  chunkSize: number,
  fx: EventSinkEffects,
): Promise<{ appended: number; stamped: number }> {
  let appended = 0;
  let stamped = 0;
  for (const chunk of chunkRows(plan.pending, chunkSize)) {
    await fx.append(chunk);
    appended += chunk.length;
    stamped += await fx.stamp(chunk);
  }
  for (const chunk of chunkRows(plan.confirmed, chunkSize)) {
    stamped += await fx.stamp(chunk);
  }
  return { appended, stamped };
}

/** A Mongo `update` command, typed as far as this file builds one. */
export interface MongoUpdateCommand {
  update: string;
  ordered: false;
  updates: { q: Record<string, unknown>; u: Record<string, unknown> }[];
}

/**
 * The raw `update` that stamps `expiresAt` on the rows these silver rows
 * describe.
 *
 * RAW, never `prisma.instrumentEvent.updateMany`: Prisma writes `@updatedAt` on
 * every update, and `updatedAt` is the clock the sink SELECTS on. A stamp that
 * moved it would hand every stamped row back to the next run, which would
 * re-confirm and re-stamp it and move it again — every row re-read on every
 * run, for ever.
 *
 * COMPARE-AND-SET on the silver key: a row is stamped only while its
 * `(observedAt, enrichedAt)` still equal the key silver confirmed, so a row
 * enriched between this run's read and its stamp — holding a summary the lake
 * does not have yet — stays unstamped until a later run appends it. In raw
 * Mongo `{enrichedAt: null}` matches an explicit null AND an absent key, which
 * is the intent (and one reason this is not a Prisma `where`).
 */
export function stampExpiryCommand(
  rows: readonly Pick<
    EventSilverRow,
    "event_id" | "observed_at" | "enriched_at"
  >[],
): MongoUpdateCommand {
  return {
    update: INSTRUMENT_EVENTS_COLLECTION,
    ordered: false,
    updates: rows.map((r) => ({
      q: {
        eventId: r.event_id,
        observedAt: { $date: r.observed_at },
        enrichedAt: r.enriched_at === null ? null : { $date: r.enriched_at },
      },
      u: {
        $set: {
          expiresAt: { $date: eventExpiresAt(r.observed_at).toISOString() },
        },
      },
    })),
  };
}

/* ─────────────────────────────────────────────────────────────────────────
   The MONEY-1531 clock repair
   ──────────────────────────────────────────────────────────────────────── */

/** The serving-copy fields the repair reads. */
export interface EventClockRow {
  /** Mongo `_id` — what the backup is keyed on. */
  id: string;
  eventId: string;
  observedAt: Date;
  ingestedAt: Date;
  expiresAt: Date | null;
}

/** One row's repair, and the clock it was READ with (the compare-and-set). */
export interface EventClockRepair {
  id: string;
  eventId: string;
  observedAtWas: Date;
  /** As read, for the backup: the value `$unset` removes. */
  expiresAtWas: Date | null;
  /** The first-sighting clock to restore; null leaves `observedAt` alone. */
  observedAt: Date | null;
  unsetExpiresAt: boolean;
}

/**
 * `observedAt := min(observedAt, ingestedAt)` and `$unset expiresAt` — or
 * `null` when the row needs neither, which is what makes a second run a no-op.
 *
 * `ingestedAt` is the floor because it is `@default(now())`: written once, by
 * the create, which IS the first emission. For a news row it trails the true
 * first sighting by the poll's own write loop — at most 72 s, measured as the
 * lead of the 105 rows no re-emission moved — so a repaired clock is never
 * early, and late by no more than that. Strict `>` here, unlike
 * {@link observedAfterIngest}'s 60 s: the repair makes the clock exact, the
 * sink only refuses what is unmistakable.
 *
 * `expiresAt` is cleared on EVERY row carrying one, moved or not: each was
 * stamped `observedAt + 30d` by `publishEvents`, a writer with no knowledge of
 * whether the lake took the row — the design MONEY-1521 replaces. An unstamped
 * row never expires, and the sink re-stamps it once silver holds it at its
 * current key.
 */
export function planClockRepair(row: EventClockRow): EventClockRepair | null {
  const moved = row.observedAt.getTime() > row.ingestedAt.getTime();
  const unsetExpiresAt = row.expiresAt !== null;
  if (!moved && !unsetExpiresAt) return null;
  return {
    id: row.id,
    eventId: row.eventId,
    observedAtWas: row.observedAt,
    expiresAtWas: row.expiresAt,
    observedAt: moved ? row.ingestedAt : null,
    unsetExpiresAt,
  };
}

/**
 * The raw `update` for a batch of repairs.
 *
 * Compare-and-set on the `observedAt` READ: a row re-stamped between the read
 * and this write — the pre-fix writer still deployed — is left alone and
 * reported as unmatched, never overwritten blind. Raw, so `updatedAt` does not
 * move; the sink's `--reload` re-reads the whole collection regardless.
 *
 * REFUSES a repair that changes nothing. In Mongo an update document with no
 * operators is a REPLACEMENT, so `u: {}` would not be a no-op — it would wipe
 * the row down to its `_id`.
 */
export function clockRepairCommand(
  repairs: readonly EventClockRepair[],
): MongoUpdateCommand {
  return {
    update: INSTRUMENT_EVENTS_COLLECTION,
    ordered: false,
    updates: repairs.map((r) => {
      if (!r.observedAt && !r.unsetExpiresAt) {
        throw new Error(
          `clockRepairCommand: the repair for ${r.eventId} changes nothing. ` +
            "Refused — an operator-free update document REPLACES the row.",
        );
      }
      return {
        q: {
          eventId: r.eventId,
          observedAt: { $date: r.observedAtWas.toISOString() },
        },
        u: {
          ...(r.observedAt
            ? { $set: { observedAt: { $date: r.observedAt.toISOString() } } }
            : {}),
          ...(r.unsetExpiresAt ? { $unset: { expiresAt: "" } } : {}),
        },
      };
    }),
  };
}

/**
 * Every row the repair writes is copied here first — the convention of the
 * `corporate_actions` repairs (`corporate_actions_money1530_backup`, `…1535…`).
 */
export const CLOCK_REPAIR_BACKUP_COLLECTION =
  "instrument_events_money1531_backup";

const ejsonDate = (d: Date): { $date: string } => ({ $date: d.toISOString() });

/**
 * The backup entry for one repair, keyed on the row's `_id`: the two fields it
 * changes AS READ (`doc`), and what it writes over them (`wrote`), which is what
 * lets `--restore` recognise a field still holding the repair's value.
 *
 * `wrote.expiresAt: null` records the `$unset`. The shell stores it with
 * `$setOnInsert`, so a re-run keeps the FIRST original.
 * ponytail: a row whose first run only unset `expiresAt` and whose re-run also
 * moves `observedAt` keeps run one's `wrote`, so `--restore` leaves that clock
 * at `ingestedAt` (<= 72 s from the original, which `doc` still holds).
 */
export function clockRepairBackup(r: EventClockRepair): {
  id: string;
  role: string;
  doc: Record<string, unknown>;
  wrote: Record<string, unknown>;
} {
  return {
    id: r.id,
    role: r.observedAt ? "MOVED" : "EXPIRY_ONLY",
    doc: {
      _id: { $oid: r.id },
      eventId: r.eventId,
      observedAt: ejsonDate(r.observedAtWas),
      expiresAt: r.expiresAtWas ? ejsonDate(r.expiresAtWas) : null,
    },
    wrote: {
      ...(r.observedAt ? { observedAt: ejsonDate(r.observedAt) } : {}),
      ...(r.unsetExpiresAt ? { expiresAt: null } : {}),
    },
  };
}

/** A document in {@link CLOCK_REPAIR_BACKUP_COLLECTION}, as read back raw. */
export interface ClockBackupDoc {
  _id: { $oid: string };
  doc: { observedAt: unknown; expiresAt: unknown };
  wrote: { observedAt?: unknown; expiresAt?: null };
}

/**
 * Epoch ms of `{ $date: "…" }` — what `$runCommandRaw` returns (measured, see
 * `reanchor-corporate-action-dates-logic.ts` `readDate`). Any other shape is
 * null, which matches no clock: the row reads as changed and is left alone.
 */
function ejsonMs(v: unknown): number | null {
  const d = (v as { $date?: unknown } | null)?.$date;
  const t = typeof d === "string" ? Date.parse(d) : Number.NaN;
  return Number.isFinite(t) ? t : null;
}

/** `--restore`'s writes (compare-and-set: `expect` must still hold), and what it left. */
export interface ClockRestorePlan {
  ops: Array<{
    id: string;
    expect: Record<string, unknown>;
    set: Record<string, unknown>;
  }>;
  partial: string[];
  changedSince: string[];
  gone: string[];
}

/**
 * The reversal, FIELD-LEVEL — `planDividendRestore`'s rule: each field the
 * repair wrote goes back to what was read, only while the row STILL holds the
 * value the repair wrote. `observedAt` is guarded on the clock it set;
 * `expiresAt` on being absent — so a row `event-lake-sink` has stamped since
 * (MONEY-1521) keeps its stamp. A row holding neither is listed, not touched;
 * one holding only one gets only that one, and is listed as `partial`.
 */
export function planClockRestore(
  backup: readonly ClockBackupDoc[],
  current: ReadonlyMap<string, { observedAt: Date; expiresAt: Date | null }>,
): ClockRestorePlan {
  const out: ClockRestorePlan = {
    ops: [],
    partial: [],
    changedSince: [],
    gone: [],
  };
  for (const b of backup) {
    const id = b._id.$oid;
    const now = current.get(id);
    if (!now) {
      out.gone.push(id);
      continue;
    }
    const expect: Record<string, unknown> = {};
    const set: Record<string, unknown> = {};
    const wroteClock = "observedAt" in b.wrote;
    const wroteUnset = "expiresAt" in b.wrote;
    if (
      wroteClock &&
      ejsonMs(b.wrote.observedAt) === now.observedAt.getTime()
    ) {
      expect.observedAt = b.wrote.observedAt;
      set.observedAt = b.doc.observedAt;
    }
    if (wroteUnset && now.expiresAt === null) {
      // Raw `{expiresAt: null}` matches absent as well as null — the `$unset`.
      expect.expiresAt = null;
      set.expiresAt = b.doc.expiresAt;
    }
    const restored = Object.keys(set).length;
    if (restored === 0) {
      out.changedSince.push(id);
      continue;
    }
    if (restored < Number(wroteClock) + Number(wroteUnset))
      out.partial.push(id);
    out.ops.push({ id, expect, set });
  }
  return out;
}

/**
 * Why a finished repair must exit NON-ZERO, or null when it may exit 0.
 *
 * A compare-and-set miss (`matched < planned`) or a non-empty re-census right
 * after the write both mean something is moving clocks under the repair — and
 * the only writer that does is `publishEvents` from BEFORE MONEY-1531. Exiting
 * 0 there would hand `event-lake-sink --reload` a serving copy that is still
 * being re-dated.
 */
export function clockRepairVerdict(r: {
  planned: number;
  matched: number;
  remaining: number;
}): string | null {
  const problems: string[] = [];
  if (r.matched < r.planned) {
    problems.push(
      `${r.planned - r.matched} of ${r.planned} planned write(s) matched ` +
        "nothing — their observedAt moved after it was read",
    );
  }
  if (r.remaining > 0) {
    problems.push(`${r.remaining} row(s) still need repair after the write`);
  }
  if (problems.length === 0) return null;
  return (
    `${problems.join("; ")}. The likely cause: the pre-MONEY-1531 workers are ` +
    "still deployed and re-moving clocks. Deploy the workers carrying " +
    "MONEY-1531, then re-run — the repair is idempotent, and the backup keeps " +
    "each row's first original. Do NOT run event-lake-sink --reload yet."
  );
}

/** What `repair-instrument-event-clocks.ts` was asked to do. */
export interface ClockRepairArgs {
  env: "qa" | "prod";
  apply: boolean;
  /** `--apply --yes`: consent given on the command line, so no prompt. */
  yes: boolean;
  /** Put back what the repair wrote, from the backup. Same `--apply` arming. */
  restore: boolean;
}

const CLOCK_REPAIR_FLAGS = new Set(["--apply", "--env", "--yes", "--restore"]);

/**
 * The repair script's flag grammar — here rather than in the script so it is
 * TESTED, not read.
 *
 * Arming follows `dedupe-candles.ts` and `reanchor-corporate-action-dates.ts`:
 * `--apply` ASKS (a prompt showing the masked host), and `--apply --yes` is the
 * non-interactive consent, for an operator or agent that has read the dry run.
 * `--yes` WITHOUT `--apply` is refused rather than ignored: it is consent to a
 * write nobody asked for, and a dry run that swallowed it would teach a caller
 * that the pair is optional.
 *
 * `--env` is REQUIRED — there is no ambient-`DATABASE_URL` form, because the
 * repo's `.env` is QA. Unknown flags and the `--env=x` form are refused, never
 * ignored: `argv.includes(...)` drops what it does not know, which is how
 * `--apply --dry-run` once WROTE (reclassify-instruments.ts).
 *
 * `stdinIsTTY` is a parameter so the refusal a pipe gets is testable. It fails
 * FAST, before the collection is read: a bare `--apply` on a closed stdin can
 * never be answered, and a hung prompt exits 0 — which a wrapper's `&&` reads
 * as success.
 */
export function parseClockRepairArgs(
  argv: readonly string[],
  stdinIsTTY: boolean,
): ClockRepairArgs {
  const unknown = argv.filter(
    (a) => a.startsWith("--") && !CLOCK_REPAIR_FLAGS.has(a.split("=")[0]!),
  );
  if (unknown.length > 0) {
    throw new Error(
      `Unknown flag(s): ${unknown.join(", ")}. Known: ${[...CLOCK_REPAIR_FLAGS].join(", ")}.`,
    );
  }
  if (argv.some((a) => /^--[a-z-]+=/.test(a))) {
    throw new Error(
      'Use "--env prod", not "--env=prod": the equals form is not parsed.',
    );
  }
  const i = argv.indexOf("--env");
  const env = i >= 0 ? argv[i + 1] : undefined;
  if (env !== "qa" && env !== "prod") {
    throw new Error(
      `--env qa|prod is REQUIRED, got ${JSON.stringify(env)}. There is no ` +
        "ambient-DATABASE_URL form: the repo's .env is QA.",
    );
  }
  const apply = argv.includes("--apply");
  const yes = argv.includes("--yes");
  if (yes && !apply) {
    throw new Error(
      "--yes is consent to WRITE and means nothing without --apply. Refused " +
        "rather than ignored: run the dry run, then --apply --yes.",
    );
  }
  if (apply && !yes && !stdinIsTTY) {
    throw new Error(
      "--apply asks for confirmation and stdin is not a TTY. Read the dry " +
        "run, then pass --apply --yes.",
    );
  }
  return { env, apply, yes, restore: argv.includes("--restore") };
}

/* ─────────────────────────────────────────────────────────────────────────
   filing_registry
   ──────────────────────────────────────────────────────────────────────── */

/** The `us_filings` fields this mapper reads. */
export interface MongoFilingRow {
  accession: string;
  cik10: string;
  form: string;
  filedAt: Date;
  acceptedAt: Date | null;
  periodOfReport: Date | null;
  items: string[];
  primaryDocument: string | null;
  isXbrl: boolean;
  isInlineXbrl: boolean;
  sizeBytes: number | null;
  parseClass: string;
  status: string;
  rawPath: string | null;
}

export interface FilingRegistryRow {
  accession: string;
  market: string;
  cik10: string;
  listing_id: string | null;
  form: string;
  filed_at: string;
  accepted_at: string | null;
  period_of_report: string | null;
  items: string[];
  primary_document: string | null;
  is_xbrl: boolean;
  is_inline_xbrl: boolean;
  size_bytes: number | null;
  parse_class: string;
  status: string;
  raw_path: string | null;
  source_object_uri: string;
  source_record_key: string;
  observed_at: string;
}

/** `Date` -> `YYYY-MM-DD`, in UTC. */
function day(d: Date | null | undefined): string | null {
  const iso = ts(d);
  return iso ? iso.slice(0, 10) : null;
}

/**
 * One `us_filings` row -> one `filing_registry` row.
 *
 * `observed_at` is `acceptedAt` when SEC gave one, else `filedAt`. That order is
 * load-bearing and is the same rule `UsFiling`'s own schema comment states: a
 * filing accepted at 21:53 ET is DATED the next business day, so `filedAt` runs
 * AHEAD of the acceptance instant and `filedAt - acceptedAt` is negative most
 * evenings. Using the filing date as the observation clock would claim we knew
 * about a filing before it was accepted.
 *
 * `is_xbrl` / `is_inline_xbrl` are coerced with `=== true` rather than passed
 * through. Mongo's `to_doc()` OMITS a false default, so the attribute is ABSENT
 * on a freshly detected row — and `undefined` in an UNNEST struct lands as NULL
 * in a `BOOL NOT NULL` column, which fails the whole statement rather than one
 * row.
 */
export function toFilingRegistryRow(
  filing: MongoFilingRow,
  listingId: string | null,
): FilingRegistryRow {
  const filedAt = day(filing.filedAt);
  if (!filedAt) {
    throw new Error(
      `filing ${filing.accession} has no filedAt. It is NOT NULL in Mongo, so ` +
        "an absent one means the row was written by something that does not " +
        "use UsFilingRow — refused rather than defaulted to today, which would " +
        "file a decade-old filing in this month's data.",
    );
  }
  return {
    accession: filing.accession,
    market: "US",
    cik10: filing.cik10,
    listing_id: listingId,
    form: filing.form,
    filed_at: filedAt,
    accepted_at: ts(filing.acceptedAt),
    period_of_report: day(filing.periodOfReport),
    items: [...(filing.items ?? [])],
    primary_document: filing.primaryDocument ?? null,
    is_xbrl: filing.isXbrl === true,
    is_inline_xbrl: filing.isInlineXbrl === true,
    size_bytes: filing.sizeBytes ?? null,
    parse_class: filing.parseClass,
    status: filing.status,
    raw_path: filing.rawPath ?? null,
    source_object_uri: filing.rawPath
      ? `gs://${filing.rawPath}`
      : `sec://edgar/${filing.cik10}/${filing.accession}`,
    source_record_key: filing.accession,
    observed_at: (ts(filing.acceptedAt) ??
      `${filedAt}T00:00:00.000Z`) as string,
  };
}
