import { defineConfig } from "tsup";
import type { Plugin } from "esbuild";

/**
 * Externalize every bare import EXCEPT @usemoney/* workspace packages.
 *
 * Workspace packages export raw .ts files that Node.js can't run,
 * so they must be compiled by esbuild and bundled into the output.
 * Everything else (npm packages like @prisma/client, ioredis, pino,
 * and Node.js built-ins like node:fs) stays external and is resolved
 * from node_modules at runtime.
 *
 * This plugin is needed because tsup's `noExternal` only removes packages
 * from the auto-external list (direct deps in package.json). It doesn't
 * handle TRANSITIVE deps of bundled workspace packages. For example,
 * @usemoney/database imports @prisma/client - without this plugin,
 * esbuild would try to bundle @prisma/client (which uses dynamic require
 * and native binaries, breaking in ESM).
 */
const externalizeNonWorkspace: Plugin = {
  name: "externalize-non-workspace",
  setup(build) {
    build.onResolve({ filter: /^[^./]/ }, (args) => {
      if (args.path.startsWith("@usemoney/")) {
        return undefined; // let esbuild resolve and bundle
      }
      return { path: args.path, external: true };
    });
  },
};

export default defineConfig({
  /**
   * Object form, not array — it pins the output filenames.
   *
   * `index` is the Pub/Sub push service (Cloud Run SERVICE, `node dist/index.js`).
   * The other two are Cloud Run JOBS (MONEY-941): they walk decades of exchange
   * archives and parse them, which takes hours and so cannot live behind Pub/Sub's
   * 600s ack deadline. They share this image rather than getting their own so the
   * runtime stage keeps shipping only `dist/` — no source tree, no tsx.
   *
   * Both scripts call `main()` at module top level, so running the bundle runs the
   * job. An array entry would emit them under a `../scripts/jobs/` output path;
   * the object form flattens them to `dist/feed-backfill.js` / `dist/feed-parse.js`.
   */
  entry: {
    index: "src/index.ts",
    // MONEY-1309 — the always-on Tiingo realtime socket holder. Its own Cloud
    // Run SERVICE on this SAME image, selected by a `command` override, because
    // Cloud Run throttles CPU to near-zero between requests unless
    // `cpu-throttling: "false"` is set — and `stockbook-workers` is
    // request-driven, does not set it, and runs at maxScale 20. A websocket
    // living in that service would be starved between Pub/Sub pushes: missed
    // heartbeats, a thrashing reconnect loop, and a metered REST snapshot bought
    // on every reconnect. Without this entry the service starts and dies
    // instantly with "Cannot find module /app/dist/tiingo-realtime.js".
    "tiingo-realtime": "src/realtime/main.ts",
    // MONEY-1472 (B1) — the lake ledger backfill. Without this entry the job
    // is not deployable at all: the Cloud Run task starts and dies with
    // "Cannot find module /app/dist/ledger-backfill-databento.js", which is
    // exactly what the harvest's error path promises will retry the mirror.
    // A named remedy that cannot be deployed is not a remedy.
    "ledger-backfill-databento": "../scripts/jobs/ledger-backfill-databento.ts",
    "ledger-backfill-tiingo": "../scripts/jobs/ledger-backfill-tiingo.ts",
    "feed-backfill": "../scripts/jobs/feed-backfill.ts",
    "feed-parse": "../scripts/jobs/feed-parse.ts",
    "feed-repair": "../scripts/jobs/feed-repair.ts",
    "fo-summary": "../scripts/jobs/fo-summary.ts",
    // MONEY-1114 — the XBRL history walk. Same reason as the others: it runs for
    // hours (seven years of filings at 600 ms apiece) and cannot live behind
    // Pub/Sub's 600 s ack deadline. Without this entry the Cloud Run job starts
    // and dies instantly with "Cannot find module /app/dist/xbrl-backfill.js".
    "xbrl-backfill": "../scripts/jobs/xbrl-backfill.ts",
    // MONEY-1235 — the XBRL -> stock_financials backlog drain. The nightly
    // projection is capped at 500 filings by Pub/Sub's 600 s ack deadline, so
    // 71,450 quarterly filings would take ~143 nights; a JOB has no ack
    // deadline. Without this entry the Cloud Run job starts and dies instantly
    // with "Cannot find module /app/dist/xbrl-projection-drain.js".
    "xbrl-projection-drain": "../scripts/jobs/xbrl-projection-drain.ts",
    // MONEY-1314 — the document-ingest backfill: scan-convert / batch-build /
    // batch-submit / batch-ingest / sweep over the 48,322-document eligible
    // set. A Cloud Run JOB rather than a Pub/Sub lane because `scan-convert`
    // alone pages through 309.8 GB of GCS reads, which no 600 s ack deadline
    // can hold.
    //
    // Without this entry the job starts and dies instantly with "Cannot find
    // module /app/dist/doc-ingest-backfill.js" — the same failure the four
    // comments around this one already describe, which is why
    // `setup-doc-ingest-backfill-job.sh` REFUSES to provision until this line
    // exists rather than printing a warning nobody reads.
    "doc-ingest-backfill": "../scripts/jobs/doc-ingest-backfill.ts",
    // MONEY-1499 — the document_embeddings -> _v2 int8 migration. 5.95M rows
    // and ~67 GiB read is hours; Pub/Sub's ack deadline maxes out at 600 s and
    // past it the message is REDELIVERED, so a second copy of the migration
    // would run beside the first against the same cursor. Without this entry
    // the Cloud Run job starts and dies instantly with "Cannot find module
    // /app/dist/embeddings-v2-backfill.js".
    "embeddings-v2-backfill": "../scripts/jobs/embeddings-v2-backfill.ts",
    // MONEY-1252 — re-parse the ~96,000 stored filings from the ARCHIVED XML,
    // so MONEY-1250's two new cash concepts reach rows that were parsed before
    // the concepts existed. Reads GCS only, never NSE. Without this entry the
    // Cloud Run job starts and dies instantly with "Cannot find module
    // /app/dist/xbrl-reparse.js".
    "xbrl-reparse": "../scripts/jobs/xbrl-reparse.ts",
    // MONEY-1258 — the BSE historical results walk. The only entry here that
    // lives outside scripts/jobs/, because the SAME script is also the
    // operator's interactive tool (`run-market-data-job.sh bseresults`): a
    // second copy under scripts/jobs/ would be two classifiers writing the same
    // `@@unique([symbol, exchange, docType, period])` key and disagreeing.
    //
    // It runs for ~30h across 2015-2025 (61,800 filings x 1.5s of PDF pacing
    // plus 4.8h of index pacing), so it cannot be a laptop run — this repo lost
    // two runs to machine sleep. Note that exceeds Cloud Run's 24h task cap, so
    // executions must be SPLIT by year range; see setup-bse-backfill-job.sh.
    //
    // Without this entry the job starts and dies instantly with "Cannot find
    // module /app/dist/bse-backfill.js".
    "bse-backfill": "../scripts/data/backfill-bse-results.ts",
    // MONEY-1263 — the US EOD history walk. 72,685 listings, ONE request each
    // (a single call returns a symbol's ENTIRE series: AAPL is 11,517 bars in
    // 2.4s), so ~3.7h at the Commercial plan's 20,000/hour. That is hours past
    // Pub/Sub's un-raisable 600s ack deadline, and it is the walk this repo
    // kept losing to a closed laptop lid. Checkpointed per symbol, so an
    // interrupted run costs time and never work.
    //
    // Without this entry the Cloud Run job starts and dies instantly with
    // "Cannot find module /app/dist/tiingo-us-backfill.js".
    "tiingo-us-backfill": "../scripts/jobs/tiingo-us-backfill.ts",
    // MONEY-1263 — the US corporate-actions EX-DATE walk. Tiingo's market-wide
    // route takes exactly one `exDate` and rejects a range, so the population
    // is DAYS: ~522 requests per year of history (261 weekdays x 2 routes), or
    // ~18,600 for the full 1990-2026 span. Checkpointed per (day, route).
    //
    // Deliberately a SEPARATE entry from the EOD walk rather than a mode flag
    // on it: the two hold separate throttles against ONE account-wide quota and
    // must not run concurrently, and a shared entrypoint would make "which walk
    // am I running" an argument rather than a job name.
    //
    // Without this entry the Cloud Run job starts and dies instantly with
    // "Cannot find module /app/dist/tiingo-us-corp-actions-backfill.js".
    "tiingo-us-corp-actions-backfill":
      "../scripts/jobs/tiingo-us-corp-actions-backfill.ts",
    // MONEY-1264 — the US news seed. Only ~90 requests (Tiingo serves a 3-month
    // history floor, day-walked so each day gets its own dated archive object),
    // so this one is NOT here for the 600s deadline. It is here because the
    // OTHER two are: an operator reaching for a laptop to run the short walk is
    // how the archive credentials and FEED_ARCHIVE_MODE=archive get skipped,
    // and then QA has no bytes to replay and pays the quota a second time.
    // One lane for all three Tiingo walks.
    //
    // Without this entry the Cloud Run job starts and dies instantly with
    // "Cannot find module /app/dist/tiingo-us-news-seed.js".
    "tiingo-us-news-seed": "../scripts/jobs/tiingo-us-news-seed.ts",
    // MONEY-1373 — the Databento US bar HARVEST. A Cloud Run JOB rather than a
    // Pub/Sub push route because one manifest entry is a batch job the vendor
    // has to materialise, then hundreds of gigabytes of DBN to download and
    // load: hours to days, against Pub/Sub's 600s ack deadline, which is
    // Pub/Sub's MAXIMUM and cannot be raised. Past it Pub/Sub does not merely
    // wait — it REDELIVERS, so a second walker starts on the same manifest
    // entry and re-submits a PAID batch job.
    //
    // Without this entry the Cloud Run job starts and dies instantly with
    // "Cannot find module /app/dist/databento-harvest.js".
    "databento-harvest": "../scripts/jobs/databento-harvest.ts",
    // MONEY-1467 — the D1 tile builder (data-platform A2). A JOB rather than a
    // Pub/Sub lane because a full India build is ~24,000 active listings x a
    // five-year DailyPrice range, which is hours against Pub/Sub's 600s ack
    // deadline — and past it Pub/Sub REDELIVERS, so a second builder starts on
    // the same listings and both write the same objects.
    //
    // Without this entry the Cloud Run job starts and dies instantly with
    // "Cannot find module /app/dist/tile-build-d1.js" — the same failure the
    // comments around this one already describe.
    // TWO entries from ONE source, deliberately. The two markets follow
    // DIFFERENT producers on DIFFERENT schedules (India after bhavcopy-sync,
    // US after us-eod-sync), so they must be two Cloud Run jobs — and the
    // release's re-pin loop, `SETUP_SCRIPT_BY_ENTRYPOINT` and
    // `job-build-provenance.test.ts` all key on ONE tsup entry per job base.
    // A single entry serving two jobs would leave one of them re-pinned by
    // nothing: it would keep the image it was provisioned with and run last
    // release's code, exiting 0 (MONEY-1205/1250/1314/1317, one ticket each).
    // The market itself comes from `--args` at provision time.
    "tile-build-d1-in": "../scripts/jobs/tile-build-d1-in.ts",
    "tile-build-d1-us": "../scripts/jobs/tile-build-d1-us.ts",
    // MONEY-1373 — the APPEND half: poll an already-submitted Databento batch
    // job to completion and append what it produced. Shorter than the harvest,
    // and still a JOB for the same reason — "poll until the vendor finishes" is
    // unbounded from our side, so it is minutes on a good day and far past 600s
    // on a bad one, which is exactly the shape an ack deadline cannot express.
    //
    // Without this entry the Cloud Run job starts and dies instantly with
    // "Cannot find module /app/dist/databento-append.js".
    "databento-append": "../scripts/jobs/databento-append.ts",
    // MONEY-1505 (B5) — the Databento bars already in GCS into
    // `lake_silver.trade_bar_{m1,h1}` and `spread_cost_daily`. A JOB because
    // one execution streams a YEAR of vendor files (2.0 GiB of zstd for the M1
    // baseline, 151.5M rows across the whole entry) and issues BigQuery load
    // jobs — tens of minutes against Pub/Sub's 600s ack deadline, past which
    // Pub/Sub REDELIVERS and a second loader starts on the same partitions.
    //
    // It contacts no vendor: every byte it reads was bought and verified
    // already, so there is no budget to spend and no `submitBatchJob` on any
    // path out of it.
    //
    // Without this entry the Cloud Run job starts and dies instantly with
    // "Cannot find module /app/dist/lake-load-databento.js".
    "lake-load-databento": "../scripts/jobs/lake-load-databento.ts",
    // MONEY-1518 (B7) — cut an immutable parquet release. A JOB because EXPORT
    // DATA over a whole warehouse plus a sha256 read-back of every object is
    // tens of minutes, and a cut must never be redelivered into a second id.
    // Provisioned (with the sink below) by scripts/ops/setup-lake-jobs.sh.
    //
    // Without this entry the Cloud Run job starts and dies instantly with
    // "Cannot find module /app/dist/lake-release.js".
    "lake-release": "../scripts/jobs/lake-release.ts",
    // MONEY-1507 / MONEY-1521 — Mongo instrument_events -> silver, then the
    // expiresAt stamp that is the ONLY thing letting those rows expire. Hourly.
    //
    // Without this entry the Cloud Run job starts and dies instantly with
    // "Cannot find module /app/dist/event-lake-sink.js".
    "event-lake-sink": "../scripts/jobs/event-lake-sink.ts",
    // MONEY-1609 — the long lake loads, moved off the founder's laptop: the
    // Workspace session policy (`invalid_rapt`) expired gcloud AND ADC twice on
    // 2026-09-23 and killed every local run mid-walk. Each runs as
    // `lake-writer-{env}@` with arguments passed per execution, provisioned by
    // scripts/ops/setup-lake-jobs.sh. Without an entry the job starts and dies
    // instantly with "Cannot find module /app/dist/<name>.js".
    "lake-replay-in": "../scripts/jobs/lake-replay-in.ts",
    "lake-replay-us": "../scripts/jobs/lake-replay-us.ts",
    "filing-registry-sync": "../scripts/jobs/filing-registry-sync.ts",
    "corp-action-lake-sink": "../scripts/jobs/corp-action-lake-sink.ts",
    "identity-sync": "../scripts/jobs/identity-sync.ts",
    // MONEY-1611 — gold: the Dataform CLI over the `dataform/` directory this
    // image carries (workers/Dockerfile), as `lake-dataform-{env}@`, twice a
    // day. Provisioned by scripts/ops/setup-dataform.sh. Without this entry
    // the job starts and dies instantly with "Cannot find module
    // /app/dist/lake-gold.js".
    "lake-gold": "../scripts/jobs/lake-gold.ts",
  },
  format: ["esm"],
  target: "node22",
  outDir: "dist",
  clean: true,
  splitting: false,
  sourcemap: true,
  // Override tsup's auto-externalization of @usemoney/* deps from package.json
  noExternal: [/@usemoney\/.*/],
  // Catch all transitive npm deps from workspace packages
  esbuildPlugins: [externalizeNonWorkspace],
});
