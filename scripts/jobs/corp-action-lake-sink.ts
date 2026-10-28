/**
 * `corp-action-lake-sink` — Mongo `corporate_actions` ->
 * `lake_silver.corporate_action`. MONEY-1516 (a).
 *
 * ## WHY IT EXISTS
 *
 * B4's `adjusted_bar_d1` computes its split and dividend factors from the BAR's
 * own `div_cash` / `split_factor` columns. Measured on prod 2026-09-22 all
 * 13,185,397 India bars carry NULL in both — bhavcopy publishes no
 * corporate-action data — so every `CASE` takes its `ELSE`, `adj_close = close`
 * for all of them, and `assert_latest_bar_is_unadjusted` passes because the
 * latest bar is unadjusted by construction under CRSP back-adjustment. Founder
 * decision, same day: load this table and JOIN it in the adjustment. This is the
 * loader; the Dataform change is MONEY-1516 (b).
 *
 * ## A JOB, NOT A PUB/SUB CONSUMER
 *
 * Same reasoning as `event-lake-sink`, which this follows: `stockbook-workers`
 * runs as `stockbook-api@` and `lake-layout.md` §10 grants that account nothing
 * on BigQuery, so a push subscription landing on a worker route could not
 * perform the append. Draining the SERVING COPY also means a run that fails
 * re-reads the same work, and a run that never happens is caught by the data
 * rather than by a message that no longer exists.
 *
 * ## ONE FULL PASS, AND DELIBERATELY **NO** MONGO-SIDE WATERMARK
 *
 * `event-lake-sink` narrows Mongo on `updatedAt >= MAX(ingested_at) - 2h`.
 * That is right for it and WRONG HERE, and the difference is the first run.
 *
 * The write is ~30 sequential INSERTs (59,087 rows at 2,000 a statement) and
 * BigQuery gives no transaction across them. A crash after statement 15 leaves
 * silver holding half the corpus and a watermark stamped at the crash instant —
 * so the NEXT run selects only Mongo rows touched in the last two hours, the
 * other ~29,000 are outside every future window, and the gap is PERMANENT and
 * invisible: both tables look healthy and every counter is green. These rows
 * span `createdAt` 2026-06-19 → 2026-09-21, so a two-hour window cannot reach
 * them. For `instrument_event`'s steadily-arriving rows the same crash loses
 * only what was just updated, which the overlap does recover.
 *
 * So the Mongo side is read WHOLE every run and the BigQuery-side value key is
 * the only thing that decides what to append — which makes "a run that fails
 * re-reads the same work" literally true rather than nearly true. Measured on
 * prod 2026-09-22: the full scan is 59,087 rows in ~8 s.
 *
 * ADD A WATERMARK WHEN THAT STOPS BEING AFFORDABLE, and it will need a
 * completeness signal the ledger does not expose today — "did the previous run
 * of this job finish?" — because a KILLED task never reaches `endRun` at all.
 * A watermark without one re-creates exactly the gap above.
 *
 * ## APPEND-ONLY
 *
 * The DDL says a correction is a NEW ROW with a later `observed_at`, never an
 * UPDATE, because the adjustment is computed at read time from the full set.
 * `corpActionSilverKey` therefore carries the VALUES, so a revised ratio
 * appends and an unchanged re-assert does not.
 *
 * ## Usage
 *
 *     npx tsx scripts/jobs/corp-action-lake-sink.ts --env qa            # dry run
 *     npx tsx scripts/jobs/corp-action-lake-sink.ts --env prod --apply
 *
 *   After a mapping change that MOVES a date or a number, add --reload. The
 *   table is INSERT-ONLY and its natural key carries ex_date, so corrected
 *   rows land BESIDE the stale ones rather than superseding them:
 *
 *     npx tsx scripts/jobs/corp-action-lake-sink.ts --env prod --apply --reload
 *
 *   A reload prunes older-version rows in two arms, counted apart in the log:
 *   those a current row has REPLACED, and those whose Mongo row is GONE (the
 *   1,772 losers MONEY-1530's re-anchor deletes). The second arm is refused —
 *   by name, pruning nothing — unless the read proves it saw the whole table.
 *   The dry run prints the second arm's plan.
 *
 *   A THIRD arm runs on EVERY `--apply`, reload or not — MONEY-1607: it deletes
 *   CURRENT-version rows whose Mongo row is gone, under the same whole-read
 *   proof. Neither reload arm can reach them, so a retired or hand-deleted
 *   action kept adjusting gold until the next version bump. Not a flag,
 *   because a flag is that defect again: the delete waits on someone
 *   remembering it. Measured 2026-09-23 it has nothing to do — silver holds
 *   57,316 rows, all v2, and no v3 row exists to be orphaned. For scale, the
 *   v2 keys whose Mongo row has gone are 762 of 57,316 (1.3%, mostly
 *   MONEY-1530's twin deletes) — what a mirror of deliberate Mongo deletions
 *   looks like, far inside the 0.9 read floor that refuses a short read.
 *
 *   A FOURTH arm, same runs, same proof: current-version rows whose Mongo row
 *   still EXISTS but now maps to another (listing, type, ex_date) — gold's
 *   partition — are deleted by explicit `restatedKey`, never by `_id` (the
 *   moved row shares it). A retype like the subjects repair's BONUS -> OTHER
 *   would otherwise leave both rows adjusting gold. A same-partition
 *   correction (a revised ratio) is left: gold takes the later `observed_at`.
 *
 * ## ORDER, FOR THE v3 RELOAD (MONEY-1522 + MONEY-1528 B)
 *
 *   1. `lake-apply-ddl.ts --apply` — `observed_ratio` must exist before this
 *      job reads or writes it; both statements NAME it, so running first fails
 *      loud ("Unrecognized name") rather than dropping the column.
 *   2. The India bar replay under `in-bhavcopy-v2`. Until it has run,
 *      `price_bar_d1` holds two-part ids and this job's three-part rows overlap
 *      nothing, so the coverage guard REFUSES — correctly.
 *   3. This job, `--apply --reload`.
 *
 * Runs as `lake-writer-{env}@` (dataEditor on silver + project jobUser), NOT as
 * `stockbook-api@`.
 */
import { pinJobEnv } from "@usemoney/core/ops/gcp-secrets";
import { guardCompletion } from "@usemoney/core/ops/job-completion";
import { BigQuery } from "@google-cloud/bigquery";
import { PrismaClient } from "@prisma/client";
import { LAKE_REGION, datasetFor } from "@usemoney/core/ops/lake-layout";
import { reportBuildProvenance } from "@usemoney/core/ops/build-provenance";
import { buildListingId } from "@usemoney/core/market-data/tiingo/tiingo-logic";
import { beginRun, endRun } from "@usemoney/lake/ledger";
import { runId } from "@usemoney/lake/ledger-logic";
import { chunkRows } from "@usemoney/lake/events-logic";
import {
  CORP_ACTION_PARSER_VERSION,
  appendThenPrune,
  corpActionSilverKey,
  joinCoverage,
  planCorpActionAppend,
  planOrphanPrune,
  planRestatedPrune,
  RESTATED_KEY_SQL,
  restatedKey,
  toCorpActionSilverRow,
  toCorpActionWireRow,
  type CorpActionRefusal,
  type CorpActionSilverRow,
  type ExistingCorpActionKey,
} from "@usemoney/lake/corp-action-logic";
import { initJobTelemetry } from "../../workers/src/lib/job-telemetry";

/**
 * Built from the URI `--env` resolves, NOT the ambient `DATABASE_URL` —
 * MONEY-1514. `@usemoney/database`'s singleton is constructed AT IMPORT, so a
 * `--env prod` run from a shell carrying the repo's QA `.env` would read QA
 * Mongo into `lake_silver_prod` with every log line saying `env=prod`. An
 * explicit datasource removes the import-order trap entirely.
 */
let prisma: PrismaClient;

const JOB = "corp-action-lake-sink";
const GCP_PROJECT = "stock-book-483718";

/** Rows per INSERT. A large `@rows` array returns 413 as an HTML PAGE, not as a
 *  JSON API error, so the failure does not even look like BigQuery. Same 2,000
 *  as `identity-sync` and `event-lake-sink`. */
const CHUNK = 2_000;

/** Mongo rows read per page. */
const PAGE = 5_000;

const log = {
  info: (...a: unknown[]) => console.log(`[${JOB}]`, ...a),
  warn: (...a: unknown[]) => console.warn(`[${JOB}]`, ...a),
  error: (...a: unknown[]) => console.error(`[${JOB}]`, ...a),
};

function parseArgs(): {
  env: "qa" | "prod";
  apply: boolean;
  reload: boolean;
} {
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

/**
 * Delete the rows this parser version has REPLACED — MONEY-1516 review (#4),
 * rescoped by the MONEY-1522 review.
 *
 * WHY A BUMP IS NOT SELF-APPLYING. This sink is INSERT-ONLY and
 * `corpActionSilverKey` carries `ex_date` AS A VALUE, so a mapping fix that
 * MOVES a date does not supersede the old row, it creates a second one beside
 * it. `action_latest` then partitions on `(market, listing_id, action_type,
 * ex_date)` — two different ex_dates are two different partitions, so both
 * survive `obs_rank = 1`, and the adjustment applies a stale factor on a date
 * the corrected data says nothing happened. Measured against the real
 * TATASTEEL bars: a stale v1 row left beside the v2 rows puts a 10x cliff on
 * 2022-07-27, one session early, mid-series, with no error anywhere.
 *
 * RUNS LAST, after the append (`appendThenPrune`), and removes an older row
 * only when its Mongo row (`source_record_key`) already HAS a current-version
 * row. It was `WHERE parser_version != @current`, run FIRST, and that deleted
 * by negation: a reload whose Mongo read came back empty or truncated would
 * have emptied the table and written back only what it read. Scoped, a reload
 * can only ever replace — the check is made by the table at the moment of the
 * DELETE, not by this run's bookkeeping. An older row whose Mongo source has
 * since been DELETED never gets a current row, so this arm cannot reach it —
 * MONEY-1530's re-anchor makes 1,772 of those. `deleteOrphanedOlderVersions`
 * is the second arm, for exactly them.
 *
 * DELIBERATELY OPT-IN, and only inside the `--apply` branch: a re-run that
 * merely appends new actions must not delete anything, and a dry run never
 * deletes.
 */
async function deleteSupersededParserVersions(
  bq: BigQuery,
  env: "qa" | "prod",
): Promise<number> {
  const table = silver(env, "corporate_action");
  const [job] = await bq.createQueryJob({
    query: `DELETE FROM ${table}
            WHERE parser_version != @current
              AND source_record_key IN (SELECT source_record_key FROM ${table}
                                        WHERE parser_version = @current)`,
    params: { current: CORP_ACTION_PARSER_VERSION },
    types: { current: "STRING" },
    location: LAKE_REGION,
  });
  await job.getQueryResults();
  const [meta] = await job.getMetadata();
  const removed = Number(meta.statistics?.query?.numDmlAffectedRows ?? 0);
  log.warn(
    `--reload: removed ${removed} row(s) that ${CORP_ACTION_PARSER_VERSION} ` +
      `has replaced. This table is INSERT-ONLY and its key carries ex_date, so ` +
      `a moved date would otherwise leave BOTH rows live.`,
  );
  return removed;
}

/** Every `source_record_key` an OLDER parser version wrote — the orphan arm's input. */
async function readOlderVersionKeys(
  bq: BigQuery,
  env: "qa" | "prod",
): Promise<string[]> {
  const [rows] = await bq.query({
    query: `SELECT DISTINCT source_record_key
            FROM ${silver(env, "corporate_action")}
            WHERE parser_version != @current`,
    params: { current: CORP_ACTION_PARSER_VERSION },
    types: { current: "STRING" },
  });
  return (rows as { source_record_key: string }[]).map(
    (r) => r.source_record_key,
  );
}

/**
 * The orphan arm: delete older-version rows whose Mongo row no longer exists.
 *
 * By EXPLICIT key, never `NOT IN (the ids we read)`: the keys come from
 * `planOrphanPrune`, which refuses — and hands back none — unless this run read
 * the whole table. `parser_version != @current` is repeated so a current row
 * can never be named, whatever the list holds.
 */
async function deleteOrphanedOlderVersions(
  bq: BigQuery,
  env: "qa" | "prod",
  keys: readonly string[],
): Promise<number> {
  let removed = 0;
  for (const batch of chunkRows(keys, CHUNK)) {
    const [job] = await bq.createQueryJob({
      query: `DELETE FROM ${silver(env, "corporate_action")}
              WHERE parser_version != @current
                AND source_record_key IN UNNEST(@keys)`,
      params: { current: CORP_ACTION_PARSER_VERSION, keys: batch },
      types: { current: "STRING", keys: ["STRING"] },
      location: LAKE_REGION,
    });
    await job.getQueryResults();
    const [meta] = await job.getMetadata();
    removed += Number(meta.statistics?.query?.numDmlAffectedRows ?? 0);
  }
  log.warn(
    `--reload: removed ${removed} older-version row(s) whose Mongo row is ` +
      `gone (${keys.length} key(s) named). No current version can ever replace them.`,
  );
  return removed;
}

/**
 * Every row the CURRENT version wrote, as the third and fourth arms judge it:
 * its Mongo `_id` and its gold partition. `ex_date` is CAST in SQL — a DATE
 * comes back as a wrapper and would never equal the mapper's string.
 */
async function readCurrentVersionRows(
  bq: BigQuery,
  env: "qa" | "prod",
): Promise<Parameters<typeof restatedKey>[0][]> {
  const [rows] = await bq.query({
    query: `SELECT DISTINCT source_record_key, market, listing_id, action_type,
                   CAST(ex_date AS STRING) AS ex_date
            FROM ${silver(env, "corporate_action")}
            WHERE parser_version = @current`,
    params: { current: CORP_ACTION_PARSER_VERSION },
    types: { current: "STRING" },
  });
  return rows as Parameters<typeof restatedKey>[0][];
}

/**
 * The third arm: delete CURRENT-version rows whose Mongo row no longer exists
 * — MONEY-1607. By EXPLICIT key, like the second arm, and only ever a
 * current-version row: the older ones are the reload arms' business.
 */
async function deleteOrphanedCurrentVersion(
  bq: BigQuery,
  env: "qa" | "prod",
  keys: readonly string[],
): Promise<number> {
  let removed = 0;
  for (const batch of chunkRows(keys, CHUNK)) {
    const [job] = await bq.createQueryJob({
      query: `DELETE FROM ${silver(env, "corporate_action")}
              WHERE parser_version = @current
                AND source_record_key IN UNNEST(@keys)`,
      params: { current: CORP_ACTION_PARSER_VERSION, keys: batch },
      types: { current: "STRING", keys: ["STRING"] },
      location: LAKE_REGION,
    });
    await job.getQueryResults();
    const [meta] = await job.getMetadata();
    removed += Number(meta.statistics?.query?.numDmlAffectedRows ?? 0);
  }
  log.warn(
    `removed ${removed} ${CORP_ACTION_PARSER_VERSION} row(s) whose Mongo row ` +
      `is gone (${keys.length} key(s) named) — a retired or deleted action no ` +
      `longer adjusts gold.`,
  );
  return removed;
}

/**
 * The fourth arm: delete CURRENT-version rows a Mongo correction has moved to
 * another gold partition — MONEY-1607 review. By EXPLICIT `restatedKey`, which
 * names the stale row and never the moved one beside it: both share a
 * `source_record_key`, so deleting by `_id` would take the correction too.
 */
async function deleteRestatedCurrentVersion(
  bq: BigQuery,
  env: "qa" | "prod",
  keys: readonly string[],
): Promise<number> {
  let removed = 0;
  for (const batch of chunkRows(keys, CHUNK)) {
    const [job] = await bq.createQueryJob({
      query: `DELETE FROM ${silver(env, "corporate_action")}
              WHERE parser_version = @current
                AND ${RESTATED_KEY_SQL} IN UNNEST(@keys)`,
      params: { current: CORP_ACTION_PARSER_VERSION, keys: batch },
      types: { current: "STRING", keys: ["STRING"] },
      location: LAKE_REGION,
    });
    await job.getQueryResults();
    const [meta] = await job.getMetadata();
    removed += Number(meta.statistics?.query?.numDmlAffectedRows ?? 0);
  }
  log.warn(
    `removed ${removed} ${CORP_ACTION_PARSER_VERSION} row(s) a Mongo correction ` +
      `moved to another (listing, type, ex_date) (${keys.length} key(s) named) — ` +
      `gold no longer applies the old partition beside the new one.`,
  );
  return removed;
}

function silver(env: "qa" | "prod", table: string): string {
  return `\`${GCP_PROJECT}.${datasetFor("lake_silver", env)}.${table}\``;
}

/**
 * The keys silver already holds, for every candidate this run built.
 *
 * Pruned on `published_at >= @from`, where `from` is the OLDEST `published_at`
 * among the candidates — `DATE(published_at)` IS the partition key. On a full
 * pass that is the whole table, which is the point: this set is the ONLY thing
 * deciding what gets appended, so it must cover every row a candidate could
 * collide with. It stays a bound rather than a bare `SELECT *` so the query
 * prunes the moment the corpus starts earlier than this job's candidates.
 *
 * EVERY COLUMN IS CAST TO STRING IN SQL. A BigQuery DATE comes back as a
 * `BigQueryDate` wrapper and a NUMERIC as its own wrapper; read as JS values
 * they never equal the mapper's output, so every key would miss and every row
 * would be appended again, every run.
 *
 * Each key carries the VERSION that wrote it, because on a `--reload` only the
 * current version's rows count as present (`planCorpActionAppend`) — the rest
 * are about to be pruned, and a candidate skipped on their strength would go
 * with them. And the Mongo `_id` that wrote it (MONEY-1607 review): a twin's
 * identical values must not count as this row's presence.
 */
async function readExisting(
  bq: BigQuery,
  env: "qa" | "prod",
  from: Date | null,
): Promise<ExistingCorpActionKey[]> {
  if (!from) return [];
  const [rows] = await bq.query({
    query: `SELECT parser_version,
                   source_record_key,
                   listing_id,
                   action_type,
                   CAST(ex_date        AS STRING) AS ex_date,
                   CAST(record_date    AS STRING) AS record_date,
                   CAST(ratio          AS STRING) AS ratio,
                   CAST(observed_ratio AS STRING) AS observed_ratio,
                   CAST(cash           AS STRING) AS cash,
                   source
            FROM ${silver(env, "corporate_action")}
            WHERE published_at >= @from`,
    params: { from },
    types: { from: "TIMESTAMP" },
  });
  const num = (v: string | null): number | null =>
    v === null ? null : Number(v);
  return (
    rows as {
      parser_version: string;
      source_record_key: string;
      listing_id: string;
      action_type: string;
      ex_date: string | null;
      record_date: string | null;
      ratio: string | null;
      observed_ratio: string | null;
      cash: string | null;
      source: string;
    }[]
  ).map((r) => ({
    parserVersion: r.parser_version,
    sourceRecordKey: r.source_record_key,
    key: corpActionSilverKey({
      listing_id: r.listing_id,
      action_type: r.action_type,
      ex_date: r.ex_date,
      record_date: r.record_date,
      // Re-normalised through the SAME function the mapper's side uses, so
      // "5" and "5.000000" are one key rather than two.
      ratio: num(r.ratio),
      observed_ratio: num(r.observed_ratio),
      cash: num(r.cash),
      source: r.source,
    }),
  }));
}

/**
 * The `listing_id`s `price_bar_d1` actually holds, for the markets in play.
 *
 * The join target, and the ONLY thing that can catch a wrong spelling. Until
 * MONEY-1522 India had two — `{symbol}:{exchange}` on the bars and
 * `{symbol}:{exchange}:unknown` in `listing`, intersecting in nothing — and a
 * loader emitting the wrong one writes every row, reports success and joins
 * nothing. There is one spelling now, `buildListingId`'s, and this is what
 * proves the bars carry it too.
 */
async function readBarListingIds(
  bq: BigQuery,
  env: "qa" | "prod",
  markets: readonly string[],
): Promise<Set<string>> {
  if (markets.length === 0) return new Set();
  const [rows] = await bq.query({
    query: `SELECT DISTINCT listing_id
            FROM ${silver(env, "price_bar_d1")}
            WHERE market IN UNNEST(@markets)`,
    params: { markets },
    types: { markets: ["STRING"] },
  });
  return new Set((rows as { listing_id: string }[]).map((r) => r.listing_id));
}

async function insertRows(
  bq: BigQuery,
  env: "qa" | "prod",
  rows: readonly CorpActionSilverRow[],
  pipelineRunId: string,
): Promise<void> {
  const now = new Date();
  for (const batch of chunkRows(rows.map(toCorpActionWireRow), CHUNK)) {
    await bq.query({
      query: `INSERT ${silver(env, "corporate_action")}
              (market, listing_id, action_type, ex_date, record_date, ratio,
               observed_ratio, cash, source, published_at, source_object_uri,
               source_record_key, parser_version, pipeline_run_id, observed_at,
               ingested_at)
              SELECT r.market, r.listing_id, r.action_type,
                     CAST(r.ex_date        AS DATE),
                     CAST(r.record_date    AS DATE),
                     CAST(r.ratio          AS NUMERIC),
                     CAST(r.observed_ratio AS NUMERIC),
                     CAST(r.cash           AS NUMERIC),
                     r.source,
                     CAST(r.published_at AS TIMESTAMP),
                     r.source_object_uri, r.source_record_key,
                     @parser_version, @run_id,
                     CAST(r.observed_at AS TIMESTAMP), @ingested_at
              FROM UNNEST(@rows) r`,
      params: {
        parser_version: CORP_ACTION_PARSER_VERSION,
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
            market: "STRING",
            listing_id: "STRING",
            action_type: "STRING",
            // STRING then CAST for every typed column, never the type directly:
            // a struct field typed DATE / NUMERIC / TIMESTAMP rejects the whole
            // 2,000-row batch on one bad value, where a CAST fails by NAME. And
            // `CAST`, never `SAFE_CAST` — these values came from
            // `toCorpActionWireRow`, so a failure is a defect in this repo and
            // must not become a silent NULL.
            ex_date: "STRING",
            record_date: "STRING",
            ratio: "STRING",
            observed_ratio: "STRING",
            cash: "STRING",
            source: "STRING",
            published_at: "STRING",
            source_object_uri: "STRING",
            source_record_key: "STRING",
            observed_at: "STRING",
          },
        ],
      },
    });
  }
}

async function main(): Promise<void> {
  const { env, apply, reload } = parseArgs();
  // FIRST — before any client. Resolves DATABASE_URL from Secret Manager for
  // THIS --env and pins LAKE_ENV / LAKE_PROJECT to match, so the Mongo read,
  // the BigQuery write and the ledger run cannot disagree.
  const { databaseUrl } = pinJobEnv(env);
  prisma = new PrismaClient({ datasources: { db: { url: databaseUrl } } });

  await initJobTelemetry();
  reportBuildProvenance(log, JOB);

  const startedAt = new Date();
  const id = runId(JOB, startedAt.getTime());
  const bq = new BigQuery({ projectId: GCP_PROJECT, location: LAKE_REGION });

  log.info(`env=${env} apply=${apply} — reading the whole serving copy`);

  const candidates: CorpActionSilverRow[] = [];
  const refused: Record<CorpActionRefusal, number> = {
    UNRESOLVABLE_LISTING: 0,
    UNKNOWN_VENUE: 0,
    BAD_DATE: 0,
  };
  const refusedSample: Partial<Record<CorpActionRefusal, string>> = {};
  // The current version's rows, read BEFORE Mongo is counted (MONEY-1607): a
  // row appended from a Mongo row newer than the read is then never judged.
  const currentRows = await readCurrentVersionRows(bq, env);
  const currentKeys = [...new Set(currentRows.map((r) => r.source_record_key))];
  // What each Mongo row maps to NOW, for the restated arm.
  const mappedNow = new Map<string, string>();
  // Counted BEFORE the read, and every `_id` read kept: together they are what
  // lets the orphan prune prove it saw the whole table (`planOrphanPrune`).
  const counted = await prisma.corporateAction.count();
  const mongoIds = new Set<string>();
  let scanned = 0;
  let cursor: string | undefined;
  for (;;) {
    const page = await prisma.corporateAction.findMany({
      // No `where` — see the header. The whole table, every run.
      // CURSOR-PAGED on `id` ASC rather than `skip`/`take`: a `skip` re-walks
      // the collection for every page and, worse, SHIFTS under a concurrent
      // insert, so a row can be handed out twice or never.
      orderBy: { id: "asc" },
      take: PAGE,
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
    });
    if (page.length === 0) break;
    scanned += page.length;
    cursor = page[page.length - 1]!.id;
    for (const row of page) {
      mongoIds.add(row.id);
      const mapped = toCorpActionSilverRow(row, buildListingId);
      if (mapped.ok) {
        candidates.push(mapped.row);
        mappedNow.set(row.id, restatedKey(mapped.row));
        continue;
      }
      refused[mapped.reason] = (refused[mapped.reason] ?? 0) + 1;
      refusedSample[mapped.reason] ??=
        `${row.symbol}/${row.exchange}/${row.type}`;
    }
    if (page.length < PAGE) break;
  }

  const refusedTotal = Object.values(refused).reduce((a, b) => a + b, 0);
  // NAMED and always printed, never a silent drop: a refused row is a corporate
  // action that will never adjust a price, and a zero is as worth logging as a
  // thousand — a run that logs nothing is indistinguishable from one that never
  // ran (MONEY-1278).
  log.info(
    `scanned ${scanned} Mongo rows, mapped ${candidates.length}, refused ${refusedTotal}` +
      ` — ${Object.entries(refused)
        .map(
          ([r, n]) =>
            `${r}=${n}${n > 0 ? ` (e.g. ${refusedSample[r as CorpActionRefusal]})` : ""}`,
        )
        .join(" ")}`,
  );

  // REDUCED, never `Math.min(...array)`: that spread pushes one argument per
  // element onto the call stack, and on a first run this array is the whole
  // 59,087-row serving copy — a RangeError, not a slow path.
  const oldestPublishedMs = candidates.reduce(
    (min, r) => Math.min(min, new Date(r.published_at).getTime()),
    Number.POSITIVE_INFINITY,
  );
  const oldestPublished = Number.isFinite(oldestPublishedMs)
    ? new Date(oldestPublishedMs)
    : null;
  const existing = await readExisting(bq, env, oldestPublished);
  const current = existing.filter(
    (e) => e.parserVersion === CORP_ACTION_PARSER_VERSION,
  ).length;
  log.info(
    `silver already holds ${existing.length} key(s) at or after ` +
      `${oldestPublished?.toISOString() ?? "the beginning"}, ${current} of ` +
      `them written by ${CORP_ACTION_PARSER_VERSION}` +
      (reload ? " — on a --reload only those count as present" : ""),
  );

  // De-duped against the batch as well as against silver, so a double INSERT
  // is impossible rather than unlikely — this table cannot be corrected by an
  // UPDATE. On a --reload, only the CURRENT version's rows count as silver's.
  const pending = planCorpActionAppend(candidates, existing, reload);

  // MEASURED OVER `candidates`, NEVER `pending` — MONEY-1514 review.
  //
  // This job does a full Mongo pass with no watermark, so from the second run
  // on `pending` holds only what is NEW. The spelling question is about the
  // MAPPER and does not depend on what silver already has, but measured over
  // `pending` the verdict does: a night whose only new actions are G-Secs or
  // BSE `#`-suffixed rows — which arrive periodically in batches, and are
  // 6,658 of 59,087 (11.3%) of the corpus by this file's own count — yields
  // `{state: "NONE", matched: 0}` and throws "listing_id SPELLING mismatch"
  // on a perfectly healthy night. It then throws identically on every run
  // after it.
  //
  // Probed: the same 3 unmatched rows give NONE over `pending` and
  // MEASURED 3/6 over `candidates`. `readBarListingIds` is one DISTINCT query
  // either way, so asking the right population costs nothing.
  const markets = [...new Set(candidates.map((r) => r.market))];
  const coverage = joinCoverage(
    candidates,
    await readBarListingIds(bq, env, markets),
  );
  if (coverage.state === "NONE") {
    // FATAL, and it is the only guard that can see this class. Every other
    // counter is green when the spelling is wrong: the rows map, the load
    // succeeds, and the adjustment joins nothing for ever.
    throw new Error(
      `${candidates.length} mapped row(s) and NOT ONE names a listing_id that ` +
        `price_bar_d1 holds for market(s) ${markets.join(",")}. That is a ` +
        `listing_id SPELLING mismatch, not a coverage figure. These rows are ` +
        `buildListingId's {symbol}:{exchange}:unknown; if price_bar_d1 still ` +
        `holds two-part {symbol}:{exchange} ids, the India bar replay under ` +
        `in-bhavcopy-v2 has not run yet — run it first (MONEY-1522). ` +
        `Unmatched sample: ${coverage.sample.join(", ")}`,
    );
  }
  log.info(
    coverage.state === "NOT_MEASURED"
      ? `join coverage NOT MEASURED — price_bar_d1 holds no ${markets.join(",") || "-"} bars, or there is nothing to write`
      : `join coverage ${coverage.matched}/${coverage.total} ` +
          `(${(coverage.rate * 100).toFixed(2)}%) name a listing_id price_bar_d1 holds. ` +
          `Unmatched sample: ${coverage.sample.join(", ")}`,
  );

  log.info(`${pending.length} new row(s) for silver`);

  // The orphan arm's plan, printed on the DRY RUN too: this is the number an
  // operator should read before a --reload --apply.
  const orphanPlan = reload
    ? planOrphanPrune(
        { ids: mongoIds, counted },
        await readOlderVersionKeys(bq, env),
      )
    : { orphans: [], refused: null };
  if (reload) {
    log.info(
      orphanPlan.refused
        ? `--reload orphan arm REFUSED, prunes nothing: ${orphanPlan.refused}`
        : `--reload orphan arm: ${orphanPlan.orphans.length} older-version ` +
            `key(s) whose Mongo row is gone (read ${mongoIds.size} of ${counted} counted)`,
    );
  }

  // The THIRD arm — current-version rows whose Mongo row is gone. On every run,
  // reload or not; printed on the dry run too. See the header (MONEY-1607).
  const currentOrphanPlan = planOrphanPrune(
    { ids: mongoIds, counted },
    currentKeys,
    "current-version",
  );
  log.info(
    currentOrphanPlan.refused
      ? `current-version orphan arm REFUSED, prunes nothing: ${currentOrphanPlan.refused}`
      : `current-version orphan arm: ${currentOrphanPlan.orphans.length} of ` +
          `${currentKeys.length} ${CORP_ACTION_PARSER_VERSION} key(s) whose Mongo row is gone`,
  );

  // The FOURTH arm — current-version rows whose Mongo row still exists but now
  // maps to another gold partition (MONEY-1607 review). Every run, like the third.
  const restatedPlan = planRestatedPrune(
    { ids: mongoIds, counted },
    currentRows,
    mappedNow,
  );
  log.info(
    restatedPlan.refused
      ? `current-version restated arm REFUSED, prunes nothing: ${restatedPlan.refused}`
      : `current-version restated arm: ${restatedPlan.stale.length} row(s) whose ` +
          `Mongo row now maps to another (listing, type, ex_date); ` +
          `${restatedPlan.unmapped} no longer map and are kept`,
  );

  if (!apply) {
    log.info("DRY RUN — nothing written. Re-run with --apply.");
    return;
  }
  // A --reload goes on with nothing to append: it may be the re-run after a
  // crash between the append and the prune, and the prune still owes its DELETE.
  // So does a plain run whose only work is the current-version orphan arm.
  if (
    pending.length === 0 &&
    !reload &&
    currentOrphanPlan.orphans.length === 0 &&
    restatedPlan.stale.length === 0
  ) {
    log.info("nothing to append");
    return;
  }

  await beginRun({ runId: id, job: JOB, startedAt });
  let out: { appended: number; superseded: number; orphaned: number };
  let currentOrphaned = 0;
  let currentRestated = 0;
  try {
    out = await appendThenPrune(pending, reload, orphanPlan.orphans, {
      append: (rows) => insertRows(bq, env, rows, id),
      pruneSuperseded: () => deleteSupersededParserVersions(bq, env),
      pruneOrphans: (keys) => deleteOrphanedOlderVersions(bq, env, keys),
    });
    // LAST: after the append, and after both reload arms.
    if (currentOrphanPlan.orphans.length > 0) {
      currentOrphaned = await deleteOrphanedCurrentVersion(
        bq,
        env,
        currentOrphanPlan.orphans,
      );
    }
    if (restatedPlan.stale.length > 0) {
      currentRestated = await deleteRestatedCurrentVersion(
        bq,
        env,
        restatedPlan.stale,
      );
    }
    await endRun({
      runId: id,
      status: "SUCCESS",
      finishedAt: new Date(),
      rowsIn: scanned,
      rowsOut: out.appended,
      rowsRejected: refusedTotal,
      notes:
        `full ` +
        Object.entries(refused)
          .map(([r, n]) => `${r}=${n}`)
          .join(" ") +
        ` joinable=${coverage.state === "MEASURED" ? coverage.matched : "not-measured"}` +
        (reload
          ? ` reload superseded=${out.superseded} orphaned=${out.orphaned}` +
            (orphanPlan.refused ? " orphan-arm=refused" : "")
          : "") +
        ` current-orphaned=${currentOrphaned}` +
        (currentOrphanPlan.refused ? " current-orphan-arm=refused" : "") +
        ` current-restated=${currentRestated}` +
        (restatedPlan.refused ? " current-restated-arm=refused" : ""),
    });
  } catch (err) {
    await endRun({
      runId: id,
      status: "FAILED",
      finishedAt: new Date(),
      notes: err instanceof Error ? err.message : String(err),
    });
    throw err;
  }
  log.info(
    `appended ${out.appended} rows` +
      (reload
        ? `; pruned ${out.superseded} superseded + ${out.orphaned} orphaned row(s)` +
          (orphanPlan.refused
            ? ` (orphan arm refused: ${orphanPlan.refused})`
            : "")
        : "") +
      `; pruned ${currentOrphaned} current-version orphan(s)` +
      (currentOrphanPlan.refused
        ? ` (current-version arm refused: ${currentOrphanPlan.refused})`
        : "") +
      `; pruned ${currentRestated} restated current-version row(s)` +
      (restatedPlan.refused
        ? ` (restated arm refused: ${restatedPlan.refused})`
        : ""),
  );
}

guardCompletion(JOB, main())
  .catch((err) => {
    log.error(err instanceof Error ? err.stack : String(err));
    process.exitCode = 1;
  })
  .finally(() => void prisma?.$disconnect());
