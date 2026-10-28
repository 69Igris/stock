/**
 * `filing-registry-sync` — Mongo `us_filings` -> `lake_silver.filing_registry`.
 * MONEY-1507 (data-platform C1), and the table **B6 lever 3 is gated on**
 * (MONEY-1517). Cost shape rebuilt by MONEY-1533.
 *
 * B6 step 3 keeps `filedAt >= today - 2y` in Mongo and deletes the rest, and
 * its stated precondition is "registry row count == Mongo count". So this has
 * to hold EVERY filing — including the ones about to be deleted — BEFORE
 * anything is deleted. Run it, compare the two counts, then delete.
 *
 * ## MERGE ON `accession`, NOT INSERT
 *
 * `us_filings.accession` is unique in Mongo and is SEC's own primary key for a
 * filing, so one row here means one filing. A MERGE makes the whole job
 * idempotent, and idempotence is what lets it have no checkpoint at all: a
 * task killed halfway is resumed by RE-RUNNING, not by remembering where it
 * stopped. `status` is a SNAPSHOT — a re-run refreshes it, which is the right
 * behaviour for a column whose live value lives in Mongo.
 *
 * Since MONEY-1533 the run is also ATOMIC: its rows reach the target in ONE
 * statement, so a killed run has changed nothing in `filing_registry`.
 *
 * That is deliberately unlike `instrument_event`, which is append-only because
 * a correction there is a new FACT with its own `observed_at`. A filing's
 * accession names one immutable document.
 *
 * ## ONE MERGE PER RUN, NOT ONE PER 2,000 ROWS — MONEY-1533
 *
 * A MERGE with an UPDATE clause bills `q + t`: the columns it reads PLUS the
 * whole target table as it stood when the statement started, however few rows
 * it touches. This job used to MERGE every 2,000-row chunk of every 5,000-row
 * page (three statements a page), so each statement re-billed every row the
 * ones before it had written. Measured on prod 2026-09-23: `us_filings`
 * 18,765,482 rows, `filing_registry` 0, and a 50,000-row `$sample` averaging
 * 274.1 logical bytes per target row (249.5 staged, 543.7 as NDJSON).
 *
 *   BEFORE  11,260 MERGEs. Σt = 1.0565e11 row-scans x 274.1 B = 26.3 TiB,
 *           + the `accession` column each ON reads (~2.1 TiB) = ~28.5 TiB:
 *           ~$178 at the $6.25/TiB on-demand list price, against the lake's
 *           $50/month budget (lake-layout.md §11). The project's queries ARE
 *           on-demand — no query job in the 72 h to 2026-09-23 ran on a
 *           reservation. Plus 11,260 serialized DML statements.
 *   AFTER   188 stage objects, ONE load job (free), ONE MERGE. The first fill
 *           (t = 0) bills the staging table once: 18.77M x 249.5 B = ~4.7 GB,
 *           ~$0.03. A full re-run over a full target adds t (~5.1 GB) and the
 *           ON column (~0.4 GB): ~10 GB, ~$0.06. A `--since` top-up is
 *           dominated by t: ~5.6 GB, ~$0.03.
 *
 * `--since` slices never fixed it: they bound one run's DURATION, and the sum
 * over the slices is the same quadratic. The MERGE is dry-run and its estimate
 * printed before it runs; what it billed goes to `pipeline_run.bytes_scanned`.
 * How the rows get there — stage objects, the run-scoped staging table, the
 * cross-object dedupe — is `filing-registry-sync-logic.mts`.
 *
 * ## A JOB WITH NO SCHEDULER TRIGGER
 *
 * Same posture as `databento-harvest`: a full walk of `us_filings` is millions
 * of rows, which is hours, and a cron would run it nightly for no reason. It is
 * run by hand — before B6 lever 3, and with `--since` to top it up. Under
 * MONEY-1609 it becomes a Cloud Run JOB (provisioned by
 * `scripts/ops/setup-lake-jobs.sh`), still with no scheduler trigger. Run from a
 * laptop, its `[build-provenance]` line reports ERROR: nothing stamps
 * `DD_VERSION` there. That is the report working, not this job failing.
 *
 * `--since` narrows on `ingestedAt`, OUR clock, not on `filedAt`: the nightly
 * detectors and the `submissions.zip` ledger both store filings whose FILING
 * date is old, so a `filedAt` window would silently miss every backfilled row.
 *
 * ## Usage
 *
 *     npx tsx scripts/jobs/filing-registry-sync.ts --env qa                     # dry run
 *     npx tsx scripts/jobs/filing-registry-sync.ts --env prod --apply           # full
 *     npx tsx scripts/jobs/filing-registry-sync.ts --env prod --apply --since 2026-09-01
 *     npx tsx scripts/jobs/filing-registry-sync.ts --env prod --count           # the B6 gate
 *
 * A full prod walk measured ~1.15 s per 5,000-row page from a laptop, so ~75
 * min of Mongo reads, plus ~10 GB of stage objects to upload; the load and the
 * MERGE are minutes.
 *
 * Runs as `lake-writer-{env}@`, NOT as `stockbook-api@` — lake-layout.md §10
 * grants that account nothing on BigQuery.
 */
import { BigQuery } from "@google-cloud/bigquery";
import { PrismaClient } from "@prisma/client";
import { pinJobEnv } from "@usemoney/core/ops/gcp-secrets";
import { guardCompletion } from "@usemoney/core/ops/job-completion";
import {
  LAKE_REGION,
  bucketForPrefix,
  datasetFor,
} from "@usemoney/core/ops/lake-layout";
import { reportBuildProvenance } from "@usemoney/core/ops/build-provenance";
import { beginRun, endRun } from "@usemoney/lake/ledger";
import { runId } from "@usemoney/lake/ledger-logic";
import { loadNdjson } from "@usemoney/lake/load";
import {
  toFilingRegistryRow,
  type FilingRegistryRow,
} from "@usemoney/lake/events-logic";
import { STAGE_UPLOAD_POLICY } from "@usemoney/lake/stage-logic";
import { uploadFile } from "@usemoney/storage";
import { initJobTelemetry } from "../../workers/src/lib/job-telemetry";
import {
  gb,
  syncFilingRegistry,
  type RegistryIO,
  type SyncResult,
} from "./filing-registry-sync-logic.mjs";

const JOB = "filing-registry-sync";
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

const PAGE = 5_000;
/** Rows read from Mongo so far — the ledger's `rows_in` if the run fails. */
let scanned = 0;

const log = {
  info: (...a: unknown[]) => console.log(`[${JOB}]`, ...a),
  warn: (...a: unknown[]) => console.warn(`[${JOB}]`, ...a),
  error: (...a: unknown[]) => console.error(`[${JOB}]`, ...a),
};

interface Args {
  env: "qa" | "prod";
  apply: boolean;
  since: Date | null;
  countOnly: boolean;
}

function parseArgs(): Args {
  const argv = process.argv.slice(2);
  const envAt = argv.indexOf("--env");
  const env = envAt >= 0 ? argv[envAt + 1] : undefined;
  if (env !== "qa" && env !== "prod")
    throw new Error("--env must be qa or prod");

  const sinceAt = argv.indexOf("--since");
  let since: Date | null = null;
  if (sinceAt >= 0) {
    const raw = argv[sinceAt + 1] ?? "";
    const d = new Date(raw);
    // REFUSED, never coerced. An Invalid Date compares false in every
    // direction, so `{ gte: invalid }` selects NOTHING and the run would report
    // a clean, healthy, empty pass — which reads exactly like "already up to
    // date" and is the reason B6's count gate would then disagree with nothing
    // to explain it.
    if (!Number.isFinite(d.getTime())) {
      throw new Error(`--since ${JSON.stringify(raw)} is not a date`);
    }
    since = d;
  }
  return {
    env,
    apply: argv.includes("--apply"),
    since,
    countOnly: argv.includes("--count"),
  };
}

function silver(env: "qa" | "prod", table: string): string {
  return `\`${GCP_PROJECT}.${datasetFor("lake_silver", env)}.${table}\``;
}

/**
 * THE B6 GATE. Both counts, side by side.
 *
 * `COUNT(*)` with no predicate is served from BigQuery metadata at zero bytes
 * scanned, which is why `filing_registry` does not need to be partitioned for
 * this to be cheap.
 */
async function reportCounts(bq: BigQuery, env: "qa" | "prod"): Promise<void> {
  const [rows] = await bq.query({
    query: `SELECT COUNT(*) AS n FROM ${silver(env, "filing_registry")}`,
  });
  const registry = Number((rows as { n?: unknown }[])[0]?.n ?? 0);
  const mongo = await prisma.usFiling.count();
  log.info(`mongo us_filings=${mongo}  lake filing_registry=${registry}`);
  log.info(
    registry === mongo
      ? "MATCH — B6 lever 3's precondition holds."
      : `MISMATCH of ${mongo - registry} — do NOT delete from us_filings yet.`,
  );
}

/**
 * cik10 -> listingId, for the CIKs in one page.
 *
 * The SAME resolution the events producer makes (`UsInstrument.cik`, written by
 * the nightly EDGAR `company_tickers` join). Resolved per page rather than
 * once: the whole `us_instruments` table is ~74k rows and holding it in memory
 * beside a 5,000-row page is fine either way, but a per-page lookup keeps the
 * peak flat whatever the filing table grows to.
 */
async function resolveListings(
  ciks: readonly string[],
): Promise<Map<string, string>> {
  if (ciks.length === 0) return new Map();
  const rows = await prisma.usInstrument.findMany({
    where: { cik: { in: [...ciks] } },
    select: { cik: true, listingId: true },
    orderBy: [{ listingStatus: "asc" }, { listingStartDate: "asc" }],
  });
  const out = new Map<string, string>();
  for (const row of rows) {
    if (!row.cik || out.has(row.cik)) continue;
    out.set(row.cik, row.listingId);
  }
  return out;
}

/** `us_filings` in `_id` order, one mapped 5,000-row page at a time. */
async function* filingPages(
  since: Date | null,
): AsyncGenerator<FilingRegistryRow[]> {
  let cursor: string | undefined;
  for (;;) {
    const page = await prisma.usFiling.findMany({
      // `ingestedAt` has a `@default(now())` so it is present on every row
      // written by Prisma OR by the Python writer's `UsFilingRow.to_doc()`.
      // A POSITIVE comparison, never `{ingestedAt: null}` — that matches ZERO
      // in Mongo in both polarities on a column a `db push` never created.
      where: since ? { ingestedAt: { gte: since } } : {},
      orderBy: { id: "asc" },
      take: PAGE,
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
    });
    if (page.length === 0) return;
    scanned += page.length;
    cursor = page[page.length - 1]!.id;

    const listings = await resolveListings([
      ...new Set(page.map((f) => f.cik10)),
    ]);
    yield page.map((f) =>
      toFilingRegistryRow(f, listings.get(f.cik10) ?? null),
    );
    log.info(`  scanned ${scanned}`);
    if (page.length < PAGE) return;
  }
}

/** BigQuery for statements, GCS for stage objects, `loadNdjson` for the load. */
function bigQueryIO(bq: BigQuery, dataset: string, bucket: string): RegistryIO {
  return {
    async query({ sql, params, types, dryRun }) {
      const [job] = await bq.createQueryJob({
        query: sql,
        params,
        types,
        dryRun,
      });
      // A dry run creates no job; its estimate IS the create response.
      if (!dryRun) await job.promise();
      const md = dryRun ? job.metadata : (await job.getMetadata())[0];
      return {
        bytesProcessed: Number(md?.statistics?.totalBytesProcessed ?? 0),
        bytesBilled: Number(md?.statistics?.query?.totalBytesBilled ?? 0),
        affectedRows: Number(md?.statistics?.query?.numDmlAffectedRows ?? 0),
      };
    },
    async upload(key, ndjson) {
      await uploadFile({
        file: Buffer.from(ndjson, "utf8"),
        fileName: key,
        contentType: "application/x-ndjson",
        // NEVER public: `uploadFile` routes a public upload to a DIFFERENT bucket.
        isPublic: false,
        bucketName: bucket,
        // Deadline + transient retries + create-only (MONEY-1608). These are
        // the LARGEST stage parts in the lake (52.6 MiB measured), and a run
        // died 132 of 188 parts in without them.
        ...STAGE_UPLOAD_POLICY,
      });
    },
    async load(table, sourceUri) {
      const r = await loadNdjson({
        projectId: GCP_PROJECT,
        dataset,
        table,
        sourceUris: [sourceUri],
        jobPrefix: "filing_registry_stage_",
      });
      return r.outputRows;
    },
  };
}

async function main(): Promise<void> {
  const args = parseArgs();
  // FIRST, before any client is constructed — and before the `--count` branch
  // below, which reads Mongo too. `pinJobEnv` resolves `DATABASE_URL` from
  // Secret Manager for THIS `--env` and pins `LAKE_ENV` / `LAKE_PROJECT` /
  // `GCP_PROJECT_ID` to match, so the Mongo read, the BigQuery write and the
  // ledger run cannot disagree. It is the ONLY writer of `LAKE_ENV` here — the
  // `process.env.LAKE_ENV = args.env` this replaces would be one fact with two
  // spellings beside it.
  const { databaseUrl } = pinJobEnv(args.env);
  prisma = new PrismaClient({ datasources: { db: { url: databaseUrl } } });

  await initJobTelemetry();
  reportBuildProvenance(log, JOB);

  const bq = new BigQuery({ projectId: GCP_PROJECT, location: LAKE_REGION });

  if (args.countOnly) {
    await reportCounts(bq, args.env);
    return;
  }

  const startedAt = new Date();
  const id = runId(JOB, startedAt.getTime());
  const dataset = datasetFor("lake_silver", args.env);
  const bucket = bucketForPrefix("lake/stage/", args.env);
  log.info(
    `env=${args.env} apply=${args.apply} ` +
      (args.since ? `since=${args.since.toISOString()}` : "FULL walk"),
  );

  if (args.apply) await beginRun({ runId: id, job: JOB, startedAt });
  let result: SyncResult;
  try {
    result = await syncFilingRegistry({
      pages: filingPages(args.since),
      io: args.apply ? bigQueryIO(bq, dataset, bucket) : null,
      projectId: GCP_PROJECT,
      dataset,
      bucket,
      runId: id,
      log: log.info,
    });
  } catch (err) {
    if (args.apply) {
      await endRun({
        runId: id,
        status: "FAILED",
        finishedAt: new Date(),
        rowsIn: scanned,
        // Nothing: the MERGE is one statement, so a failed run wrote no row.
        rowsOut: 0,
        notes: err instanceof Error ? err.message : String(err),
      });
    }
    throw err;
  }

  if (!args.apply) {
    const [md] = await bq
      .dataset(dataset)
      .table("filing_registry")
      .getMetadata();
    const target = Number(md?.numBytes ?? 0);
    log.info(
      `DRY RUN — ${result.rows} rows. An --apply stages them as ` +
        `${result.objects} object(s), loads them with ONE load job (free) and ` +
        `runs ONE MERGE billing ~${gb(result.stagedBytes + target)} ` +
        `(staged ${gb(result.stagedBytes)} + target ${gb(target)}). ` +
        `Re-run with --apply.`,
    );
    return;
  }
  await endRun({
    runId: id,
    status: "SUCCESS",
    finishedAt: new Date(),
    rowsIn: result.rows,
    rowsOut: result.merge?.affectedRows ?? 0,
    rowsRejected: 0,
    bytesScanned: result.merge?.bytesBilled ?? 0,
    notes: args.since ? `since=${args.since.toISOString()}` : "full",
  });

  await reportCounts(bq, args.env);
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
