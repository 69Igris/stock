/**
 * Backfill `lake_bronze.source_object` from what already exists. MONEY-1472 (B1).
 *
 * The ledger is new; the inventory is not. Every Databento file we hold is
 * recorded in `DatabentoBatchJob.files`, a Mongo `Json` array, and the whole
 * point of B1 is that the array is not queryable. This walks those rows once
 * and writes the ledger rows they imply.
 *
 * ## IT SELECTS WITH A RAW MONGO FILTER, BECAUSE NO PRISMA PREDICATE WORKS
 *
 * A Mongo `db push` creates indexes and not fields, so every row that predates
 * this ticket has `ledgerBacked` ABSENT — a different value from `false`. This
 * header used to say `{ not: true }` matches both. **It matches NEITHER.**
 *
 * MEASURED against PROD 2026-09-17, 69 rows, `ledgerBacked` absent on all 69:
 *
 *     raw   { ledgerBacked: { $ne: true } }      69
 *     raw   { ledgerBacked: { $exists: false } } 69
 *     prisma{ ledgerBacked: { not: true } }       0   <- what this job shipped
 *     prisma{ ledgerBacked: false }               0
 *
 * Prisma compiles `not` into `$and: [{$ne: [f, true]}, {$ne: [f, "$$REMOVE"]}]`
 * — the second clause EXCLUDES every document where the field is absent. So the
 * job printed "0 job row(s) not yet ledger-backed / Nothing to do." and exited
 * 0 with an empty ledger, which is the exact MONEY-1050/1234/1235 failure this
 * header was written to prevent, one layer deeper than the note that warned
 * about it. Naming a bug is not protection from it.
 *
 * The filter therefore goes to Mongo verbatim through `$runCommandRaw`, which
 * handles absent, false and any future row without a migration — and a
 * `@default(false)` would not help, since Prisma applies it at CREATE and the
 * 69 existing rows stay absent for ever.
 *
 * A SOURCE SCAN COULD NOT SEE THIS. `databento-ledger-mapping.test.ts` greps
 * for the literal `/ledgerBacked:\s*\{\s*not:\s*true\s*\}/` and stayed
 * green over a dead query for the whole life of the defect.
 *
 * ## PROD IS THE ONLY WRITER
 *
 * Databento is a paid metered vendor. Its schedulers are prod-only, and
 * `databento_batch_jobs` is a REFERENCE_COLLECTION — QA receives prod's rows by
 * copy, `ledgerBacked` included. A QA row reading `ledgerBacked: true` beside
 * an empty `lake_bronze_qa` is CORRECT: the inventory it refers to is prod's.
 *
 * ## IT DOES HEAD, BUT IT DOES NOT HASH
 *
 * A HEAD per object gives `generation`, the real `bytes` and `contentType` —
 * and `generation` is half the MERGE key, so without it "pins WHICH version of
 * the object was read" pins nothing. A HEAD that 404s writes `MISSING`, which
 * is otherwise a state with no writer at all.
 *
 * A HEAD that FAILS is not an absent object: the row keeps what the manifest
 * said, because recording MISSING on a credentials blip would say we lost a
 * file we still have.
 *
 *
 * `sha256` is written only when the vendor's manifest already carried it.
 * Computing one ourselves means downloading terabytes to learn something the
 * manifest states, against a vendor whose files expire 30 days after
 * submission.
 *
 * ## IT DOES NOT LIST
 *
 * Keys come from the records, which came from the vendor's manifest.
 * `listFiles` fails open to `[]`, so a reader that asked GCS "what is there?"
 * would silently record an empty inventory on any credentials blip — which in
 * a LEDGER is worse than no row at all, because a later coverage query would
 * read it as an answer.
 *
 * ## Usage
 *
 *     npx tsx scripts/jobs/ledger-backfill-databento.ts --env prod           # dry run
 *     npx tsx scripts/jobs/ledger-backfill-databento.ts --env prod --apply
 */
import { prisma } from "@usemoney/database";
import { getFileMetadata } from "@usemoney/storage";
import { reportBuildProvenance } from "@usemoney/core/ops/build-provenance";
import { initJobTelemetry } from "../../workers/src/lib/job-telemetry";
import { recordSourceObjects, beginRun, endRun } from "@usemoney/lake/ledger";
import { runId } from "@usemoney/lake/ledger-logic";
import {
  markLedgerBacked,
  readFileRecords,
  toLedgerSourceObjects,
} from "@usemoney/core/market-data/databento/databento-repo";
import { mapWithConcurrency } from "@usemoney/core/market-data/databento/databento-harvest-logic";

const JOB = "ledger-backfill-databento";

/**
 * Job states after which the file list will not grow.
 *
 * A row in any other state may still receive files, so it must stay selectable.
 */
const TERMINAL_STATES = ["DONE", "DOWNLOADED", "LOADED", "EXPIRED", "FAILED"];

/** Bounded GCS metadata reads. See the call site for what unbounded cost. */
const HEAD_CONCURRENCY = 16;

interface Args {
  env: "qa" | "prod";
  apply: boolean;
  limit: number;
  head: boolean;
}

function parseArgs(): Args {
  const argv = process.argv.slice(2);
  const take = (n: string): string | undefined => {
    const i = argv.indexOf(n);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const env = take("--env");
  if (env !== "qa" && env !== "prod") throw new Error("--env must be qa or prod");
  // PROD IS THE ONLY WRITER. Databento's schedulers are prod-only because a QA
  // trigger spends real money for rows the next restore deletes, and
  // `databento_batch_jobs` is a REFERENCE_COLLECTION — QA receives prod's rows
  // by copy, `ledgerBacked` included. Backfilling QA would write a ledger for
  // objects QA never acquired, against a bucket QA's jobs never wrote.
  //
  // `--allow-qa` exists for exercising the code path against a throwaway
  // dataset, and says what it is doing.
  if (env === "qa" && !argv.includes("--allow-qa")) {
    throw new Error(
      "this job is PROD-ONLY: QA receives databento_batch_jobs by copy, so a QA " +
        "ledger would describe objects QA never acquired. Pass --allow-qa to " +
        "exercise the path deliberately.",
    );
  }
  const limitRaw = take("--limit");
  return {
    env,
    apply: argv.includes("--apply"),
    // HEAD is a GCS request per object — ~56,220 of them for the full
    // inventory. On by default because a ledger without `generation` cannot
    // pin a version, and off-switchable for a fast re-run over rows whose
    // metadata has not changed.
    head: !argv.includes("--no-head"),
    // Bounded by default. A Cloud Run JOB has no ack deadline, but an unbounded
    // first run against prod is also the worst time to discover a mapping bug.
    limit: limitRaw ? Number(limitRaw) : 500,
  };
}

const log = {
  info: (...a: unknown[]) => console.log(`[${JOB}]`, ...a),
  warn: (...a: unknown[]) => console.warn(`[${JOB}]`, ...a),
  error: (...a: unknown[]) => console.error(`[${JOB}]`, ...a),
};

/**
 * The ids of jobs not yet mirrored to the ledger.
 *
 * Mongo, not Prisma: `$ne: true` matches an ABSENT field and every Prisma
 * predicate excludes it. Ordered by `_id` so `--limit` walks the inventory
 * deterministically instead of re-reading one arbitrary page.
 */
async function selectUnbackedIds(limit: number): Promise<string[]> {
  const res = (await prisma.$runCommandRaw({
    find: "databento_batch_jobs",
    filter: { ledgerBacked: { $ne: true } },
    projection: { _id: 1 },
    sort: { _id: 1 },
    limit,
  } as never)) as unknown as {
    cursor?: { firstBatch?: { _id?: { $oid?: string } | string }[] };
  };
  return (res.cursor?.firstBatch ?? [])
    .map((d) => (typeof d._id === "string" ? d._id : d._id?.$oid))
    .filter((id): id is string => typeof id === "string");
}

async function main(): Promise<void> {
  const args = parseArgs();

  // WHICH IMAGE IS THIS. A Cloud Run JOB pins its image at PROVISION time, so
  // a job never re-pinned after a workers deploy runs last release's code
  // indefinitely and exits 0 — this repo has paid for that four times, one
  // ticket each (MONEY-1205, 1250, 1314, 1317). The provenance line is what
  // makes it visible in the log rather than discovered months later.
  // FIRST: attach the Datadog log stream. Without it a Cloud Run JOB logs to
  // stdout only, so every line below reaches Cloud Logging and NOTHING reaches
  // the place anyone actually watches.
  await initJobTelemetry();

  // The LITERAL entry-point name, not `JOB`. `job-build-provenance.test.ts`
  // scans for `reportBuildProvenance(log, "<entrypoint>")` and a source scan
  // cannot resolve a constant — so passing `JOB` reads as "silent" to the very
  // guard that exists to catch a job running last release's code.
  reportBuildProvenance(log, "ledger-backfill-databento");
  process.env.LAKE_ENV = args.env;
  
  const startedAt = new Date();
  const id = runId(JOB, startedAt.getTime());

  // RAW, never a Prisma predicate — see the header. `$ne: true` is the only
  // expression that matches an ABSENT field, and absent is what all 69 prod
  // rows are.
  const candidateIds = await selectUnbackedIds(args.limit);

  // NOT-MEASURED IS NOT DONE. A zero here has two causes that print the same
  // line: every row is backed (healthy), or the selector matched nothing while
  // rows exist (the defect above). They are separated rather than collapsed,
  // because "Nothing to do." is exactly what the broken query said.
  const totalRows = await prisma.databentoBatchJob.count();
  if (candidateIds.length === 0 && totalRows > 0) {
    const backed = Number(
      (
        (await prisma.$runCommandRaw({
          count: "databento_batch_jobs",
          query: { ledgerBacked: true },
        } as never)) as unknown as { n?: number }
      ).n ?? 0,
    );
    if (backed < totalRows) {
      throw new Error(
        `selector matched 0 of ${totalRows} rows but only ${backed} are ` +
          `ledgerBacked — the selection is broken, not the work. Refusing to ` +
          `report a clean zero.`,
      );
    }
  }

  const rows = await prisma.databentoBatchJob.findMany({
    where: { id: { in: candidateIds } },
    select: {
      id: true,
      jobId: true,
      dataset: true,
      files: true,
      state: true,
      // MONEY-1472 review — the mapper needs the real acquisition instant and
      // the cost. `acquired_at` is the PARTITION column, so stamping `now()`
      // for a two-year backfill puts every row in one date partition.
      costUsd: true,
      // The quote is the only cost figure that exists before the vendor has
      // processed the job; without it every in-flight purchase writes NULL.
      costUsdQuoted: true,
      downloadedAt: true,
      submittedAt: true,
    },
    orderBy: { id: "asc" },
  });

  console.log(`\n${JOB} — ${args.env}`);
  console.log(`${rows.length} job row(s) not yet ledger-backed (limit ${args.limit})\n`);

  if (rows.length === 0) {
    console.log("Nothing to do.");
    return;
  }

  if (args.apply) await beginRun({ runId: id, job: JOB, startedAt });

  let objects = 0;
  let headed = 0;
  let missing = 0;
  let jobsDone = 0;
  let jobsEmpty = 0;
  let failed = 0;
  // COUNTED, not just warned. A silent HEAD failure leaves `generation` NULL,
  // which is exactly the state the HEAD exists to prevent.
  let headFailures = 0;

  for (const row of rows) {
    const records = readFileRecords(row.files);
    if (records.length === 0) {
      // A job with no files is NOT an error — a PROBE or a quoted-but-never-
      // submitted row legitimately has none. Counted separately so "nothing to
      // mirror" cannot hide inside "mirrored successfully".
      jobsEmpty++;
      // STAMPED ONLY IF THE ROW IS TERMINAL.
      //
      // A QUOTED / SUBMITTED / PROCESSING row legitimately has no files YET.
      // Stamping it `ledgerBacked: true` would exclude it from
      // `{ not: true }` FOR EVER — so when the vendor finishes and the harvest
      // mirrors it, any failure there leaves that purchase's entire inventory
      // permanently absent from the ledger, with the run that caused it
      // reporting `empty=1` as a healthy outcome.
      if (args.apply && TERMINAL_STATES.includes(row.state)) {
        await markLedgerBacked(row.id);
      }
      continue;
    }

    const ledgerRows = toLedgerSourceObjects(row, records, {
      env: args.env,
      now: new Date(),
    });

    // HEAD each object for its GENERATION — B1 asks for this, and without it
    // the MERGE key degenerates.
    //
    // `recordSourceObject` matches on (object_uri, generation). With generation
    // always NULL that is `object_uri` alone, so the DDL's "pins WHICH version
    // of the object was read" pins nothing, and the first row that ever DOES
    // carry a generation becomes a SECOND ledger row for the same object whose
    // `state` can disagree with the first.
    //
    // It also turns `PRESENT` from an assertion into an observation: a HEAD
    // that 404s means the object is gone, which is `MISSING` — a state that
    // otherwise has no writer at all in a table clustered on `state`.
    if (args.head) {
      // BOUNDED. This was `Promise.all` over the whole row — up to 42,084
      // simultaneous GCS getMetadata calls from a 1Gi / 1 CPU task, with
      // `https.globalAgent.maxSockets` defaulting to Infinity so nothing
      // throttled them. ~21k in-flight TLS requests is ~1 GB of sockets: an OOM
      // before the first MERGE, or a 429 storm if it survived. The degraded
      // path was silent — the catch only warns, and neither counter moves — so
      // a rate-limited run left `generation` NULL on every row, which is the
      // degenerate MERGE key this HEAD exists to prevent, and reported SUCCESS.
      await mapWithConcurrency(
        ledgerRows,
        HEAD_CONCURRENCY,
        async (r) => {
          const key = r.objectUri.replace(/^gs:\/\/[^/]+\//, "");
          try {
            const meta = await getFileMetadata(key);
            if (!meta) {
              // Absent, not unreadable. `getFileMetadata` returns null for a
              // missing OBJECT and throws for a missing BUCKET, so this branch
              // is genuinely "we no longer have it".
              r.state = "MISSING";
              r.verifiedAt = null;
              missing++;
              return;
            }
            const gen = Number(meta.generation);
            if (Number.isFinite(gen)) r.generation = gen;
            const size = Number(meta.size);
            if (Number.isFinite(size)) r.bytes = size;
            if (typeof meta.contentType === "string") r.contentType = meta.contentType;
            headed++;
          } catch (err) {
            // A HEAD that FAILED is not an absent object. Leaving the row as the
            // manifest described it is the honest outcome; recording MISSING
            // here would turn a credentials blip into "we lost the file".
            headFailures++;
            console.warn(`   head failed for ${key}: ${String(err)}`);
          }
        },
      );
    }

    if (!args.apply) {
      objects += ledgerRows.length;
      jobsDone++;
      console.log(
        `   DRY-RUN  ${row.jobId ?? row.id}  ${ledgerRows.length} object(s)  ` +
          `${ledgerRows.filter((r) => r.state === "VERIFIED").length} verified`,
      );
      continue;
    }

    try {
      // ONE statement per ~5,000 files, not one per file. See
      // `recordSourceObjects` — the per-file shape could not finish a 42,084
      // file row inside the 2 h task timeout, so that row was never marked and
      // every run redid its first few thousand files.
      await recordSourceObjects(ledgerRows);
      objects += ledgerRows.length;
      await markLedgerBacked(row.id);
      jobsDone++;
    } catch (err) {
      // Per ROW, so one bad job does not abandon the rest. `ledgerBacked` stays
      // unset for it, so the next run retries exactly that one.
      failed++;
      console.error(`   FAILED   ${row.jobId ?? row.id}: ${String(err)}`);
    }
  }

  const summary =
    `jobs=${jobsDone} empty=${jobsEmpty} failed=${failed} objects=${objects} ` +
    `headed=${headed} missing=${missing} headFailures=${headFailures}`;
  console.log(`\n${args.apply ? "Applied" : "DRY RUN"} — ${summary}`);

  if (args.apply) {
    await endRun({
      runId: id,
      status: failed === 0 ? "SUCCESS" : "FAILED",
      finishedAt: new Date(),
      rowsOut: objects,
      rowsRejected: failed,
      notes: summary,
    });
  }
  if (!args.apply) {
    console.log("Re-run with --apply to write.");
  }
  // A non-zero exit on partial failure: the row-level catch above keeps the run
  // going, and a run that ends 0 with failures would report healthy.
  // A HEAD that could not run leaves `generation` NULL on a row that claims a
  // pinned version, so a run with head failures is incomplete even though every
  // row it wrote parses.
  if (failed > 0 || headFailures > 0) process.exitCode = 1;
}

main()
  .catch((err) => {
    console.error(`\n${err instanceof Error ? err.message : String(err)}`);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
