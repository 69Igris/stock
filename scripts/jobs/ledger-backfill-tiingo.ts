/**
 * Backfill `lake_bronze.source_object` for the Tiingo corp-action archives.
 * MONEY-1474 (was MONEY-1472, data-platform B1).
 *
 * ## IT LISTS THE ARCHIVE NOW, AND THAT IS THE FIX
 *
 * The first cut computed keys from `BackfillCheckpoint` because B1 said "never
 * by listing". Its first prod dry run (2026-09-17) proved the checkpoint table
 * is not an index of the archive:
 *
 *     19,308 checkpoints -> 93 candidates -> 22 PRESENT, 71 MISSING
 *         28 objects actually in the bucket
 *
 * 63 of those MISSING were ex-dates in the FUTURE, and 6 REAL objects were
 * never candidates at all. Every checkpoint was written on 2026-08-29 by one
 * historical walk over ex-dates 1990-2026; every object was written 2026-08-31
 * onward by the NIGHTLY leg, which writes no checkpoints. Two unrelated
 * producers, so no bound derived from one can describe the other.
 *
 * "Never list" was a rule about `listFiles` FAILING OPEN to `[]` — a ledger
 * that records an empty inventory on a credentials blip is worse than one with
 * no row, because a coverage query reads it as an answer. That is a property of
 * that function, not of listing. `streamObjectSummaries` THROWS instead — it
 * already existed for exactly this reason and already PAGES rather than
 * buffering a whole prefix into memory — so the objection is removed rather
 * than worked around, and the listing carries the generation, size,
 * contentType and creation time that previously cost one HEAD per object.
 *
 * ## `MISSING` IS NOT REACHABLE HERE, DELIBERATELY
 *
 * An absent object is either "no corporate actions that ex-date, so the shape
 * guard correctly stored nothing" or "the PUT failed", and nothing
 * distinguishes them. The Databento leg writes MISSING because a vendor
 * MANIFEST proves delivery; this one has no manifest, so the strongest honest
 * statement about every row it writes is PRESENT.
 *
 * ## PROD IS THE ONLY WRITER
 *
 * `FEED_ARCHIVE_MODE` is off outside prod, so prod is the only environment that
 * ARCHIVES these. QA is not empty, though — `setup-sync-job.sh` rsyncs all of
 * `feeds/` prod->QA excluding only `TIINGO/ws/` — so a QA run would ledger
 * prod's objects under a QA bucket name. That is why `--allow-qa` exists and
 * why it is not the default; the earlier claim that "a QA listing is
 * legitimately empty" was simply wrong.
 *
 * ## Usage
 *
 *     npx tsx scripts/jobs/ledger-backfill-tiingo.ts --env prod           # dry run
 *     npx tsx scripts/jobs/ledger-backfill-tiingo.ts --env prod --apply
 */
import { streamObjectSummaries } from "@usemoney/storage";
import { recordSourceObjects, beginRun, endRun } from "@usemoney/lake/ledger";
import { runId } from "@usemoney/lake/ledger-logic";
import { reportBuildProvenance } from "@usemoney/core/ops/build-provenance";
import { bucketForPrefix } from "@usemoney/core/ops/lake-layout";
import {
  CORP_ACTION_FEEDS,
  prefixFor,
  scanArchiveKeys,
  vendorFileNameFor,
  type ListedObject,
} from "@usemoney/core/market-data/tiingo/tiingo-corp-actions-ledger";
import { initJobTelemetry } from "../../workers/src/lib/job-telemetry";

const JOB = "ledger-backfill-tiingo";

const log = {
  info: (...a: unknown[]) => console.log(`[${JOB}]`, ...a),
  warn: (...a: unknown[]) => console.warn(`[${JOB}]`, ...a),
  error: (...a: unknown[]) => console.error(`[${JOB}]`, ...a),
};

interface Args {
  env: "qa" | "prod";
  apply: boolean;
}

function parseArgs(): Args {
  const argv = process.argv.slice(2);
  const i = argv.indexOf("--env");
  const env = i >= 0 ? argv[i + 1] : undefined;
  if (env !== "qa" && env !== "prod") {
    throw new Error("--env must be qa or prod");
  }
  if (env === "qa" && !argv.includes("--allow-qa")) {
    throw new Error(
      "this job is PROD-ONLY: FEED_ARCHIVE_MODE is off outside prod, so no " +
        "other environment holds these objects. Pass --allow-qa to exercise " +
        "the path deliberately.",
    );
  }
  return { env, apply: argv.includes("--apply") };
}

async function main(): Promise<void> {
  const args = parseArgs();
  process.env.LAKE_ENV = args.env;

  await initJobTelemetry();
  reportBuildProvenance(log, "ledger-backfill-tiingo");

  const startedAt = new Date();
  const id = runId(JOB, startedAt.getTime());

  // THE THING LISTED MUST BE THE THING RECORDED.
  //
  // `listObjects` takes no bucket — it resolves `GCP_STORAGE_BUCKET` from the
  // environment — while `objectUri` below is built from
  // `bucketForPrefix(..., args.env)`. Nothing makes those agree on their own,
  // and `--env qa --allow-qa` on a prod container would list prod while
  // recording `gs://stockbook-content-qa/…`. Checked ONCE, before any read.
  const expectedBucket = bucketForPrefix(prefixFor("splits"), args.env);
  const envBucket = process.env.GCP_STORAGE_BUCKET;
  if (envBucket !== expectedBucket) {
    throw new Error(
      `GCP_STORAGE_BUCKET is ${envBucket ?? "(unset)"} but --env ${args.env} ` +
        `records gs://${expectedBucket}/. The listing would read one bucket ` +
        `while the ledger names another.`,
    );
  }

  const listed: ListedObject[] = [];
  const emptyFeeds: string[] = [];
  for (const feed of CORP_ACTION_FEEDS) {
    const prefix = prefixFor(feed);
    // FAIL-CLOSED by construction: `streamObjectSummaries` THROWS on a paging
    // or auth error, so a credentials blip aborts the run instead of recording
    // an empty archive. It also PAGES rather than buffering the whole prefix.
    const objects: ListedObject[] = [];
    for await (const o of streamObjectSummaries(prefix)) {
      objects.push({
        name: o.name,
        generation: o.generation,
        size: o.size,
        contentType: o.contentType,
        timeCreated: o.timeCreated,
      });
    }
    log.info(`${prefix} -> ${objects.length} object(s)`);
    if (objects.length === 0) emptyFeeds.push(feed);
    listed.push(...objects);
  }

  if (emptyFeeds.length > 0) {
    // PER FEED, NOT THE UNION. Testing `listed.length === 0` would let one dark
    // feed hide behind the other: distributions 404ing while splits returns 14
    // gives a non-empty union, a SUCCESS run, and a ledger silently covering
    // half the source — which a coverage query then reads as the answer. That
    // is MONEY-1255's per-source zero hidden inside an aggregate, rebuilt one
    // level up.
    throw new Error(
      `no objects under feeds/TIINGO/{${emptyFeeds.join(",")}}/ in ` +
        `gs://${expectedBucket}. Prod archives BOTH feeds nightly, so an empty ` +
        `one is a fault — the prefix moved, the credentials are wrong, or that ` +
        `leg has stopped. Refusing to report a clean run.`,
    );
  }

  const { rows, rejected } = scanArchiveKeys(listed);
  const rejectedTotal = Object.values(rejected).reduce((a, b) => a + b, 0);
  log.info(
    `${listed.length} listed · ${rows.length} recordable` +
      (rejectedTotal === 0
        ? ""
        : ` · rejected ${Object.entries(rejected)
            .filter(([, n]) => n > 0)
            .map(([k, n]) => `${k}=${n}`)
            .join(" ")}`),
  );

  if (rows.length === 0) {
    throw new Error(
      `${listed.length} object(s) listed and NONE parsed as a corp-action ` +
        `key. The archive key grammar has changed — refusing to write.`,
    );
  }

  const ledgerRows = rows.map((r) => ({
    dataset: r.feed,
    source: "TIINGO",
    objectUri: `gs://${expectedBucket}/${r.object.name}`,
    generation: r.object.generation,
    bytes: r.object.size,
    // NEVER hashed. The vendor supplies no checksum for these feeds, and
    // computing one means downloading the object to learn something no query
    // needs.
    sha256: null,
    contentType: r.object.contentType,
    // ARRIVAL, not the ex-date. `acquired_at` means "when the file arrived"
    // everywhere else in this table — `toLedgerSourceObjects` computes
    // `downloadedAt ?? submittedAt ?? now` under a header saying exactly that —
    // and one column in one `PARTITION BY DATE(acquired_at)` table must not
    // carry two different facts keyed by `source`, with nothing on the row
    // saying which.
    //
    // The ex-date is the wrong clock twice over: the nightly leg fetches the
    // NEXT trading day, so a Friday session archives a Monday ex-date and the
    // stamp would sit in the FUTURE of the PUT on every row; and spread over
    // 1990-2026 it would occupy ~9,600 daily partitions of BigQuery's
    // 10,000-per-table ceiling for this leg alone.
    //
    // `timeCreated` comes from the same listing response, so this costs nothing
    // — the earlier cut simply discarded it. `?? startedAt` only when GCS did
    // not say.
    acquiredAt: r.object.timeCreated ?? startedAt,
    vendorJobId: null,
    vendorFileName: vendorFileNameFor(r.feed, r.exDate),
    // PRESENT is the strongest honest statement — see the header. VERIFIED
    // would claim a checksum matched, and there is none to match.
    // `as const` so this stays the LITERAL union member rather than widening to
    // `string` — `SourceObjectRow.state` is a closed set, and without it the
    // one state this leg may write does not type-check against it.
    state: "PRESENT" as const,
    verifiedAt: null,
  }));

  if (!args.apply) {
    for (const r of ledgerRows) log.info(`   DRY-RUN  PRESENT ${r.objectUri}`);
    log.info(`DRY RUN — ${ledgerRows.length} row(s). Re-run with --apply.`);
    return;
  }

  await beginRun({ runId: id, job: JOB, startedAt });

  // TRY/CATCH SO `endRun` ALWAYS FIRES. Without it a BigQuery failure throws
  // past the terminal write and leaves `finished_at` NULL for ever — which the
  // DDL defines as "STILL RUNNING or killed" — and `runId` mints a new id per
  // attempt, so nothing ever reconciles the orphan. The first provisioning of
  // this job found its principal had NO BigQuery role at all, so this is a
  // live failure mode rather than a hypothetical one.
  let failure: unknown = null;
  try {
    // ONE statement per chunk, not one per object. 28 objects today; the
    // nightly leg adds two a day for ever.
    await recordSourceObjects(ledgerRows);
  } catch (err) {
    failure = err;
  }

  // A RUN THAT REJECTED SOMETHING DID NOT SUCCEED. Every surviving reject
  // reason except `below-min-bytes` is a key this reader could not parse inside
  // a prefix we pinned — a grammar surprise that silently drops objects while
  // `rows.length > 0` keeps the all-or-nothing refusal quiet. The DDL says it
  // outright for this column: "a load that wrote some rows is not a load that
  // succeeded". The sibling leg already exits non-zero on its own rejects.
  const defects = rejectedTotal - rejected["below-min-bytes"];
  const ok = failure === null && defects === 0;
  const summary =
    `present=${failure === null ? ledgerRows.length : 0} ` +
    `rejected=${rejectedTotal} defects=${defects}` +
    (failure === null ? "" : ` write=FAILED`);

  await endRun({
    runId: id,
    status: ok ? "SUCCESS" : "FAILED",
    finishedAt: new Date(),
    rowsOut: failure === null ? ledgerRows.length : 0,
    rowsRejected: rejectedTotal,
    notes: summary,
  });

  if (failure !== null) throw failure;
  log.info(`Applied — ${summary}`);
  if (!ok) {
    log.error(
      `${defects} object(s) inside a pinned prefix could not be parsed — the ` +
        `archive key grammar has drifted. Exiting non-zero.`,
    );
    process.exitCode = 1;
  }
}

main().catch((err) => {
  log.error(err instanceof Error ? err.message : String(err));
  process.exitCode = 1;
});
