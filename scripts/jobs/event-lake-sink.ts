/**
 * `event-lake-sink` — Mongo `instrument_events` -> `lake_silver.instrument_event`.
 * MONEY-1507 (data-platform C1).
 *
 * ## A JOB, NOT A PUB/SUB CONSUMER, AND THE BRIEF SAYS OTHERWISE
 *
 * C1 specifies "a small Cloud Run consumer `event-lake-sink`" fed by an
 * `instrument-event-{env}` topic. Two facts on disk make that arrangement
 * impossible as written:
 *
 *   1. `stockbook-workers` runs as `stockbook-api@`
 *      (`workers/cloudbuild.{prod,qa}.yaml`), and `docs/reference/lake-layout.md`
 *      §10 grants that account NOTHING on BigQuery — "everything" in the Never
 *      column. `setup-lake.sh` grants it nothing and deliberately avoids even
 *      project-level impersonation, naming `stockbook-api@` as the reason. A
 *      push subscription landing on a worker route therefore could not perform
 *      the append it exists for.
 *   2. A publish has to be FAIL-SOFT (the EDGAR detect loop must not die
 *      because an events topic is down), so a dropped message would be a silver
 *      row that never exists and nothing would ever notice.
 *
 * Draining the SERVING COPY by watermark removes both. A run that fails
 * re-reads the same window; a run that never happens is caught by the
 * watermark, not by a message that no longer exists.
 *
 * ## THE WINDOW IS ON **OUR** CLOCK, NOT THE PRODUCER'S
 *
 * Watermark = `MAX(ingested_at)` in silver; Mongo is selected on `updatedAt`.
 * Both move when WE write. `observed_at` does not: the 8-K insight sweep adds a
 * summary hours later and deliberately leaves the producer's clock alone,
 * because point-in-time correctness says we saw the filing when we saw it. A
 * window anchored on `observed_at` would therefore never re-read an enriched
 * row, and the silver copy would carry `summary: null` for ever while Mongo
 * held the sentence — with both tables looking entirely healthy.
 *
 * `SINK_OVERLAP_MS` (2 h) re-reads, because the two clocks are on two machines
 * and a row can be written between this run reading its window and the same run
 * stamping `ingested_at`. The re-read costs one query and writes nothing.
 *
 * ## APPEND-ONLY, KEYED ON (event_id, observed_at, enriched_at)
 *
 * An enrichment appends a SECOND row with the same `event_id` AND the same
 * `observed_at` — see the DDL header — so a two-part key would skip it and the
 * summary would never arrive. Readers take the latest `(observed_at,
 * ingested_at)` per `event_id`.
 *
 * ## THIS JOB IS THE ONLY WRITER OF `expiresAt` — MONEY-1521
 *
 * The serving copy is bounded by a TTL index on `expiresAt`, and Mongo's TTL
 * monitor skips a row whose field is absent. So the stamp IS the permission to
 * delete, and only the party that knows the lake has the row may give it:
 *
 *   - a row this run APPENDS is stamped after the INSERT carrying it returns,
 *     chunk by chunk (`appendThenStamp`); a failed INSERT stamps nothing;
 *   - a row whose CURRENT key silver already holds is stamped too — otherwise
 *     rows sunk before this existed would never get a TTL at all;
 *   - the stamp is compare-and-set on that key, and RAW, so it never moves the
 *     `updatedAt` clock this job selects on.
 *
 * And every UNSTAMPED row is re-read on every run, however old
 * (`sinkSelection`). Absent `expiresAt` means "not yet confirmed", which makes
 * a killed run, a failed stamp or a missed window self-healing instead of a
 * permanent, invisible gap.
 *
 * A row whose `observedAt` was moved past its own creation is REFUSED by name
 * (`observedAfterIngest`) — never written, never stamped. That is the MONEY-1531
 * signature, and a moved clock written under the current parser version is a
 * duplicate `--reload` cannot remove.
 *
 * ## `--reload` — REBUILD FROM THE SERVING COPY (MONEY-1531)
 *
 * Bumping `EVENT_SINK_PARSER_VERSION` is not self-applying: the key carries
 * `observed_at`, so a corrected clock appends BESIDE the stale row rather than
 * superseding it. `--reload` is the same lever `corp-action-lake-sink` has,
 * with two changes that this table needs and that one does not:
 *
 *   1. INSERT FIRST, DELETE LAST. The sibling deletes, then inserts. Here the
 *      watermark would turn a crash between the two into a permanent gap — the
 *      next plain run would window on the few rows that landed. So `--reload`
 *      reads the WHOLE serving copy, skips only keys the CURRENT version has
 *      already written (re-runnable after a crash), appends and stamps the rest,
 *      and only then deletes.
 *   2. THE DELETE IS SCOPED. It removes other-version rows only for events that
 *      now have a current-version row. Mongo is a 90-day window and silver is
 *      the permanent record, so an unscoped `parser_version != @current` would,
 *      once the TTL has run, delete every event the serving copy no longer
 *      holds — the lake's only copy. Scoped, a reload can only ever replace.
 *
 * A reload rebuilds each event from its CURRENT Mongo state, so an event's
 * pre-enrichment row does not survive one. Zero rows are enriched today.
 *
 * ## Usage
 *
 *     npx tsx scripts/jobs/event-lake-sink.ts --env qa            # dry run
 *     npx tsx scripts/jobs/event-lake-sink.ts --env qa --apply
 *
 *   After a parser-version bump, and only after the serving copy is clean
 *   (MONEY-1531: `scripts/data/repair-instrument-event-clocks.ts` first):
 *
 *     npx tsx scripts/jobs/event-lake-sink.ts --env prod --reload           # census + plan
 *     npx tsx scripts/jobs/event-lake-sink.ts --env prod --reload --apply
 *
 * Runs as `lake-writer-{env}@` (dataEditor on silver + project jobUser), NOT as
 * `stockbook-api@`. `--env` pins BOTH ENDS through `pinJobEnv` below — a Cloud
 * Run JOB inherits no service env block, and the Mongo READ and the BigQuery
 * WRITE must never be allowed to name different environments (MONEY-1514).
 */
import { BigQuery } from "@google-cloud/bigquery";
import { PrismaClient, type Prisma } from "@prisma/client";
import { pinJobEnv } from "@usemoney/core/ops/gcp-secrets";
import { guardCompletion } from "@usemoney/core/ops/job-completion";
import { LAKE_REGION, datasetFor } from "@usemoney/core/ops/lake-layout";
import { reportBuildProvenance } from "@usemoney/core/ops/build-provenance";
import { beginRun, endRun } from "@usemoney/lake/ledger";
import { runId } from "@usemoney/lake/ledger-logic";
import {
  EVENT_SINK_PARSER_VERSION,
  appendThenStamp,
  chunkRows,
  eventSilverKey,
  observedAfterIngest,
  planEventSink,
  sinkSelection,
  sinkWindowStart,
  stampExpiryCommand,
  toEventSilverRow,
  type EventSilverRow,
} from "@usemoney/lake/events-logic";
import { initJobTelemetry } from "../../workers/src/lib/job-telemetry";

const JOB = "event-lake-sink";
const GCP_PROJECT = "stock-book-483718";

/**
 * Built from the URI `--env` RESOLVES, never the ambient `DATABASE_URL` —
 * MONEY-1514.
 *
 * `@usemoney/database` exports a singleton constructed AT MODULE SCOPE, so
 * importing it and then calling `pinJobEnv` inside `main()` does NOT repoint
 * it: probe-verified, the import-time capture wins and the connection still
 * resolves the OLD host. That combination is strictly WORSE than the bug it
 * looks like a fix for — today an unset `DATABASE_URL` fails closed, where a
 * pin-after-import would make a QA-shell `--env prod` run silently read QA
 * Mongo into `lake_silver_prod`. An explicit datasource removes the
 * import-order trap rather than racing it. Same shape as `identity-sync`.
 */
let prisma: PrismaClient;

/** Rows per INSERT. See `recordSourceObjects`: BigQuery bills a 10 MB minimum
 *  per statement, and an UNNEST of tens of thousands of structs breaches the
 *  query size limit. 2,000 keeps both comfortable for a row this wide. */
const CHUNK = 2_000;

/** Mongo rows read per page. */
const PAGE = 5_000;

const log = {
  info: (...a: unknown[]) => console.log(`[${JOB}]`, ...a),
  warn: (...a: unknown[]) => console.warn(`[${JOB}]`, ...a),
  error: (...a: unknown[]) => console.error(`[${JOB}]`, ...a),
};

function parseArgs(): { env: "qa" | "prod"; apply: boolean; reload: boolean } {
  const argv = process.argv.slice(2);
  const i = argv.indexOf("--env");
  const env = i >= 0 ? argv[i + 1] : undefined;
  if (env !== "qa" && env !== "prod")
    throw new Error("--env must be qa or prod");
  return {
    env,
    apply: argv.includes("--apply"),
    reload: argv.includes("--reload"),
  };
}

function silver(env: "qa" | "prod", table: string): string {
  return `\`${GCP_PROJECT}.${datasetFor("lake_silver", env)}.${table}\``;
}

/**
 * The newest `ingested_at` already in silver, or null on an empty table.
 *
 * OUR write clock. See the header for why it is not `observed_at`.
 */
async function readWatermark(
  bq: BigQuery,
  env: "qa" | "prod",
): Promise<Date | null> {
  const [rows] = await bq.query({
    query: `SELECT MAX(ingested_at) AS watermark FROM ${silver(env, "instrument_event")}`,
  });
  const raw = (rows as { watermark?: { value?: string } | string | null }[])[0]
    ?.watermark;
  if (!raw) return null;
  // The BigQuery client returns a TIMESTAMP as a `BigQueryTimestamp` wrapper
  // carrying `.value`, not as a Date. Reading it as a Date yields `Invalid
  // Date`, and every comparison against one is FALSE — so the window would
  // silently become "everything", on every run, for ever.
  const value = typeof raw === "string" ? raw : raw.value;
  return value ? new Date(value) : null;
}

/**
 * The keys silver already holds, for every candidate this run built.
 *
 * Filtered on `observed_at >= @from`, where `from` is the OLDEST
 * `observed_at` among the candidates. That prunes partitions — `observed_at`
 * IS the partition key — while still covering every row the batch could
 * collide with. Filtering on the run's `ingested_at` window instead would miss
 * an enriched row whose original was appended months ago, which is exactly the
 * pair this exists to tell apart.
 *
 * `onlyVersion` narrows to one parser version, for `--reload`: rows of any
 * other version are about to be superseded, so they must not count as "silver
 * already has this" — a candidate skipped on the strength of a row the reload
 * then deletes would vanish from the lake.
 */
async function readExisting(
  bq: BigQuery,
  env: "qa" | "prod",
  from: Date | null,
  onlyVersion: string | null,
): Promise<Set<string>> {
  if (!from) return new Set();
  const [rows] = await bq.query({
    query: `SELECT event_id, observed_at, enriched_at
            FROM ${silver(env, "instrument_event")}
            WHERE observed_at >= @from
            ${onlyVersion ? "AND parser_version = @version" : ""}`,
    params: { from, ...(onlyVersion ? { version: onlyVersion } : {}) },
    types: {
      from: "TIMESTAMP",
      ...(onlyVersion ? { version: "STRING" } : {}),
    },
  });
  const out = new Set<string>();
  for (const r of rows as {
    event_id: string;
    observed_at: { value?: string } | string;
    enriched_at: { value?: string } | string | null;
  }[]) {
    out.add(
      eventSilverKey({
        event_id: r.event_id,
        observed_at: isoOf(r.observed_at) ?? "",
        enriched_at: isoOf(r.enriched_at),
      }),
    );
  }
  return out;
}

/**
 * A BigQuery TIMESTAMP -> the ISO string `toEventSilverRow` produces.
 *
 * The client returns a `BigQueryTimestamp` WRAPPER carrying `.value`, not a
 * Date and not a string. Read as either, it never equals the mapper's output,
 * so every key would miss and every row would be appended again every run.
 */
function isoOf(raw: { value?: string } | string | null): string | null {
  if (raw === null || raw === undefined) return null;
  const value = typeof raw === "string" ? raw : raw.value;
  return value ? new Date(value).toISOString() : null;
}

async function insertRows(
  bq: BigQuery,
  env: "qa" | "prod",
  rows: readonly EventSilverRow[],
  pipelineRunId: string,
): Promise<void> {
  const now = new Date();
  for (const batch of chunkRows(rows, CHUNK)) {
    await bq.query({
      query: `INSERT ${silver(env, "instrument_event")}
              (event_id, market, listing_id, entity_id, event_type, severity,
               title, summary, evidence_uri, source, published_at,
               linker_version, confidence, tags, supersedes_event_id,
               enriched_at, source_object_uri, source_record_key,
               parser_version, pipeline_run_id, observed_at, ingested_at)
              SELECT r.event_id, r.market, r.listing_id, r.entity_id,
                     r.event_type, r.severity, r.title, r.summary,
                     r.evidence_uri, r.source,
                     SAFE_CAST(r.published_at AS TIMESTAMP),
                     r.linker_version, r.confidence, r.tags,
                     r.supersedes_event_id,
                     SAFE_CAST(r.enriched_at AS TIMESTAMP),
                     r.source_object_uri, r.source_record_key,
                     @parser_version, @run_id,
                     CAST(r.observed_at AS TIMESTAMP), @ingested_at
              FROM UNNEST(@rows) r`,
      params: {
        parser_version: EVENT_SINK_PARSER_VERSION,
        run_id: pipelineRunId,
        ingested_at: now,
        rows: batch as unknown as Record<string, unknown>[],
      },
      types: {
        parser_version: "STRING",
        run_id: "STRING",
        ingested_at: "TIMESTAMP",
        rows: [
          {
            event_id: "STRING",
            market: "STRING",
            listing_id: "STRING",
            entity_id: "STRING",
            event_type: "STRING",
            severity: "INT64",
            title: "STRING",
            summary: "STRING",
            evidence_uri: "STRING",
            source: "STRING",
            published_at: "STRING",
            linker_version: "STRING",
            confidence: "FLOAT64",
            tags: ["STRING"],
            supersedes_event_id: "STRING",
            enriched_at: "STRING",
            source_object_uri: "STRING",
            source_record_key: "STRING",
            // STRING then CAST, never TIMESTAMP directly: `observed_at` is NOT
            // NULL and a struct field typed TIMESTAMP rejects the whole batch
            // on one unparseable value, where `CAST` fails by NAME. `published_at`
            // is nullable and uses SAFE_CAST for the same reason in reverse.
            observed_at: "STRING",
          },
        ],
      },
    });
  }
}

/**
 * Stamp `expiresAt` on the Mongo rows behind these silver rows. Returns the
 * number the compare-and-set matched; the rest changed after this run read
 * them and stay unstamped until a later run confirms their new key.
 *
 * `writeErrors` is checked by hand: a raw command answers `ok: 1` with the
 * failures in an array, so a stamp that failed for every row would otherwise
 * read as a quiet one.
 */
async function stampExpiry(rows: readonly EventSilverRow[]): Promise<number> {
  const res = (await prisma.$runCommandRaw(
    stampExpiryCommand(rows) as unknown as Prisma.InputJsonObject,
  )) as { n?: number; writeErrors?: unknown[] };
  if (res.writeErrors?.length) {
    throw new Error(
      `expiresAt stamp: ${res.writeErrors.length} write error(s), first ` +
        `${JSON.stringify(res.writeErrors[0])}. The silver rows are written; ` +
        "their Mongo rows stay unstamped and the next run re-reads them.",
    );
  }
  return Number(res.n ?? 0);
}

/** Rows and events per parser version — what `--reload` is about to rewrite. */
async function logVersionCensus(
  bq: BigQuery,
  env: "qa" | "prod",
): Promise<void> {
  const [rows] = await bq.query({
    query: `SELECT parser_version, COUNT(*) AS n, COUNT(DISTINCT event_id) AS events
            FROM ${silver(env, "instrument_event")}
            GROUP BY parser_version ORDER BY parser_version`,
  });
  const census = (
    rows as { parser_version: string; n: number; events: number }[]
  )
    .map((r) => `${r.parser_version}=${r.n} rows/${r.events} events`)
    .join(", ");
  log.info(
    `silver by parser_version: ${census || "EMPTY"} (current ${EVENT_SINK_PARSER_VERSION})`,
  );
}

/**
 * `--reload`'s last step: delete other-version rows for every event that now
 * has a current-version row. See the header for why it is SCOPED and why it
 * runs AFTER the append — both are the difference from `corp-action-lake-sink`.
 *
 * The scope is enforced by the table at the moment of the DELETE, not by this
 * run's bookkeeping: a row can only go if its replacement is already there.
 */
async function deleteSupersededRows(
  bq: BigQuery,
  env: "qa" | "prod",
): Promise<number> {
  const table = silver(env, "instrument_event");
  const [job] = await bq.createQueryJob({
    query: `DELETE FROM ${table}
            WHERE parser_version != @current
              AND event_id IN (SELECT event_id FROM ${table}
                               WHERE parser_version = @current)`,
    params: { current: EVENT_SINK_PARSER_VERSION },
    types: { current: "STRING" },
    location: LAKE_REGION,
  });
  await job.getQueryResults();
  const [meta] = await job.getMetadata();
  return Number(meta.statistics?.query?.numDmlAffectedRows ?? 0);
}

async function main(): Promise<void> {
  const { env, apply, reload } = parseArgs();
  // FIRST, before any client is constructed. `pinJobEnv` resolves
  // `DATABASE_URL` from Secret Manager for THIS `--env` and pins `LAKE_ENV` /
  // `LAKE_PROJECT` / `GCP_PROJECT_ID` to match, so the Mongo read, the
  // BigQuery write and the ledger run cannot disagree. It is the ONLY writer
  // of `LAKE_ENV` here — the `process.env.LAKE_ENV = env` this replaces would
  // be one fact with two spellings beside it.
  const { databaseUrl } = pinJobEnv(env);
  prisma = new PrismaClient({ datasources: { db: { url: databaseUrl } } });

  await initJobTelemetry();
  reportBuildProvenance(log, JOB);

  const startedAt = new Date();
  const id = runId(JOB, startedAt.getTime());
  const bq = new BigQuery({ projectId: GCP_PROJECT, location: LAKE_REGION });

  const watermark = await readWatermark(bq, env);
  // `--reload` is a REBUILD: a window would rebuild only what moved recently.
  const since = reload ? null : sinkWindowStart(watermark);
  log.info(
    reload
      ? `env=${env} RELOAD to ${EVENT_SINK_PARSER_VERSION} — reading the whole serving copy`
      : since
        ? `env=${env} incremental from ${since.toISOString()} (watermark ${watermark?.toISOString()}) plus every unstamped row`
        : `env=${env} FIRST RUN — silver is empty, reading the whole serving copy`,
  );
  if (reload) await logVersionCensus(bq, env);

  // CANDIDATES FIRST, then ask silver what it already has. The order matters:
  // `readExisting` prunes partitions on the candidates' oldest `observed_at`,
  // which it cannot know before they are built.
  const candidates: EventSilverRow[] = [];
  let scanned = 0;
  let refused = 0;
  let refusedSample: string | undefined;
  let cursor: string | undefined;
  for (;;) {
    const page = await prisma.instrumentEvent.findMany({
      // `updatedAt` (OUR clock — see the header) OR `expiresAt` absent. Never a
      // `{f: null}` test: on Mongo that matches an explicit null only, and this
      // field is ABSENT until stamped (MONEY-1050 / 1205 / 1234 / 1236).
      where: sinkSelection(since),
      orderBy: { id: "asc" },
      take: PAGE,
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
    });
    if (page.length === 0) break;
    scanned += page.length;
    cursor = page[page.length - 1]!.id;
    for (const row of page) {
      if (observedAfterIngest(row)) {
        refused++;
        refusedSample ??=
          `${row.eventId} observedAt=${row.observedAt.toISOString()} ` +
          `ingestedAt=${row.ingestedAt.toISOString()}`;
        continue;
      }
      candidates.push(toEventSilverRow(row));
    }
    if (page.length < PAGE) break;
  }
  if (refused > 0) {
    // NAMED, and never written: see `observedAfterIngest`. These rows stay
    // unstamped, so they cannot expire before they are repaired and sunk.
    log.warn(
      `REFUSED ${refused} row(s) whose observedAt sits after their own ` +
        `ingestedAt — a re-emission moved the first-sighting clock ` +
        `(MONEY-1531). Run scripts/data/repair-instrument-event-clocks.ts ` +
        `--env ${env}. e.g. ${refusedSample}`,
    );
  }

  // REDUCED, never `Math.min(...array)`. That spread pushes one argument per
  // element onto the call stack, and this array is the whole serving copy on a
  // first run — tens of thousands of events is a RangeError, not a slow path.
  const oldestObservedMs = candidates.reduce(
    (min, r) => Math.min(min, new Date(r.observed_at).getTime()),
    Number.POSITIVE_INFINITY,
  );
  const oldestObserved = Number.isFinite(oldestObservedMs)
    ? new Date(oldestObservedMs)
    : null;
  // Read whenever silver holds anything — which an unstamped-row sweep, or a
  // reload, can reach far behind the watermark. On a reload, ONLY the current
  // version counts as "already there": the rest is about to be superseded.
  const inSilver = await readExisting(
    bq,
    env,
    watermark ? oldestObserved : null,
    reload ? EVENT_SINK_PARSER_VERSION : null,
  );
  log.info(
    `silver already holds ${inSilver.size} key(s) at or after ` +
      `${oldestObserved?.toISOString() ?? "the beginning"}`,
  );

  const plan = planEventSink(candidates, inSilver);
  log.info(
    `scanned ${scanned} Mongo rows, refused ${refused}: ` +
      `${plan.pending.length} to append then stamp, ` +
      `${plan.confirmed.length} already in silver to stamp`,
  );

  if (!apply) {
    log.info("DRY RUN — nothing written. Re-run with --apply.");
    return;
  }

  const effects = {
    append: (rows: readonly EventSilverRow[]) => insertRows(bq, env, rows, id),
    stamp: stampExpiry,
  };

  if (plan.pending.length === 0 && !reload) {
    // Nothing for the lake, so no ledger run — but the stamps are real writes
    // and are reported. A quiet window is the COMMON case for this job, and a
    // run that logs nothing is indistinguishable from one that never ran
    // (MONEY-1278).
    const out = await appendThenStamp(plan, CHUNK, effects);
    log.info(
      `nothing to append; stamped ${out.stamped} of ${plan.confirmed.length} ` +
        `row(s) silver already holds`,
    );
    return;
  }

  await beginRun({ runId: id, job: JOB, startedAt });
  try {
    const out = await appendThenStamp(plan, CHUNK, effects);
    const superseded = reload ? await deleteSupersededRows(bq, env) : 0;
    await endRun({
      runId: id,
      status: "SUCCESS",
      finishedAt: new Date(),
      rowsIn: scanned,
      rowsOut: out.appended,
      rowsRejected: refused,
      notes:
        (reload
          ? `reload superseded_deleted=${superseded}`
          : since
            ? `since=${since.toISOString()}`
            : "full") + ` stamped=${out.stamped}`,
    });
    log.info(
      `appended ${out.appended} row(s); stamped ${out.stamped} of ` +
        `${plan.pending.length + plan.confirmed.length}` +
        (reload ? `; deleted ${superseded} superseded row(s)` : ""),
    );
  } catch (err) {
    await endRun({
      runId: id,
      status: "FAILED",
      finishedAt: new Date(),
      notes: err instanceof Error ? err.message : String(err),
    });
    throw err;
  }
}

guardCompletion(JOB, main())
  .catch((err) => {
    log.error(err instanceof Error ? err.stack : String(err));
    process.exitCode = 1;
  })
  // OPTIONAL CHAIN: `prisma` is assigned inside `main()`, after `parseArgs`.
  // A bad `--env` throws before that, and an unguarded `.$disconnect()` would
  // replace the argument error with a TypeError from the `finally`.
  .finally(() => void prisma?.$disconnect());
