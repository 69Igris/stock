/**
 * Delete price rows whose `instrumentId` points at no instrument  (MONEY-1156)
 * ==========================================================================
 *
 * QA carries a large population of price rows keyed to PROD's instrument
 * ObjectIds. Measured 2026-08-08:
 *
 *     latest_quotes   18,211 total   8,820 orphan (48.4%)   6,999 with mcap
 *     daily_prices  1,450,061 total 500,386 orphan (34.5%)
 *     prod            ZERO orphans in either collection
 *
 * Every orphan is frozen — orphan `latest_quotes` max `updatedAt` is
 * 2026-06-18T17:32:57Z, orphan `daily_prices` max `date` is 2026-06-19.
 *
 * ## Where they came from
 *
 * `scripts/ops/sync-prod-to-qa.sh` was created 2026-06-19 (`adad49aa`,
 * MONEY-840) with `instrument_mappings`, `daily_prices`, `intraday_bars` and
 * `latest_quotes` all in `REFERENCE_COLLECTIONS`. `91bbda97` (MONEY-1085)
 * removed them once the FK problem was understood. The price legs evidently
 * landed in QA while the `instrument_mappings` leg did not persist (QA's
 * instrument `_id`s are still QA-native), so QA ended up holding prod-keyed
 * price rows with nothing to hang them on. The `@unique` on `instrumentId`
 * could not stop it: different keyspace, no collision.
 *
 * Sampling confirmed the provenance rather than assuming it — 60/60 sampled QA
 * orphan `instrumentId`s resolve in PROD's `instrument_mappings`, and the
 * ObjectId process signatures separate cleanly (prod's instrument bulk carries
 * `…9c01208e0a…`, QA's `…00ef8d8bf5…`; every orphan carries prod's).
 *
 * ## Why they must go rather than being left alone
 *
 * They are unreachable by every join, so no feature can read them — but they
 * ARE read by anything that queries these collections WITHOUT joining
 * `instrument_mappings`. `discover-heatmap`'s `marketCap: {gt: 0}` +
 * `orderBy marketCap desc` index scan is exactly that shape, and 6,999 of the
 * orphans carry a non-zero `marketCap`. They also corrupt every prod-vs-QA
 * coverage comparison, which is how they were found.
 *
 * No job will ever reclaim them: ingest upserts by `(instrumentId, date)` /
 * `instrumentId`, so a row whose `instrumentId` is not in this environment is
 * never revisited.
 *
 * ## The failure mode this script is built around
 *
 * The orphan test is "instrumentId is not in the set of instrument `_id`s".
 * If that set fails to load — wrong database, a dropped collection, a bad
 * projection — then EVERY row looks orphaned and a naive script cheerfully
 * deletes the entire price history. A silent empty read must never present as
 * "delete everything", which is the same fail-open rule this codebase applies
 * to caches.
 *
 * So the guards below are not decoration:
 *   - an empty instrument set ABORTS unconditionally;
 *   - an orphan share above --max-share (default 0.60) ABORTS unless --force;
 *   - a live re-count after deletion must equal the planned count.
 *
 * Usage:
 *   yarn data:purge-orphans --env qa                 # dry run (default)
 *   yarn data:purge-orphans --env qa --apply         # DELETES (always prompts)
 *   yarn data:purge-orphans --env qa --apply --collection latest_quotes
 *
 * Flags:
 *   --apply              actually delete (default: dry run). Always prompts.
 *   --env qa|prod        read DATABASE_URL from Secret Manager
 *   --collection NAME    only latest_quotes or daily_prices (default: both)
 *   --max-share F        abort above this orphan share (default 0.60)
 *   --force              proceed past the share guard (never past an empty set)
 *   --no-snapshot        skip the rollback file (NOT recommended)
 *
 * Rollback snapshots are written to `scripts/data/rollbacks/` — repo-relative,
 * NOT the cwd. See that directory's README.md; the files it holds are the only
 * surviving copy of the deleted documents.
 */

import { execFileSync } from "child_process";
import { createInterface } from "readline";
import { createWriteStream, renameSync, mkdirSync } from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { MongoClient, type Collection, type Document } from "mongodb";
import type { ObjectId } from "mongodb";

const GCP_PROJECT = "stock-book-483718";

/** Collections keyed by a foreign `instrumentId`, in delete order. */
const TARGETS = ["latest_quotes", "daily_prices"] as const;
type TargetName = (typeof TARGETS)[number];

interface Options {
  apply: boolean;
  env?: "qa" | "prod";
  collections: TargetName[];
  maxShare: number;
  force: boolean;
  snapshot: boolean;
}

function parseArgs(argv: string[]): Options {
  const has = (f: string): boolean => argv.includes(f);
  const val = (f: string): string | undefined => {
    const i = argv.indexOf(f);
    return i === -1 ? undefined : argv[i + 1];
  };

  const envRaw = val("--env");
  if (envRaw !== undefined && envRaw !== "qa" && envRaw !== "prod") {
    // Mirrors resector-real-estate.ts: an unparsed --env would silently leave
    // APPLY mode pointed at the ambient DATABASE_URL, i.e. at whatever the
    // shell happened to export. That is the one mistake this must never make.
    throw new Error(
      `--env must be "qa" or "prod" (got ${JSON.stringify(envRaw)}); ` +
        `an unparsed --env would leave APPLY mode pointed at the ambient ` +
        `DATABASE_URL.`,
    );
  }

  const collRaw = val("--collection");
  if (collRaw !== undefined && !TARGETS.includes(collRaw as TargetName)) {
    throw new Error(
      `--collection must be one of ${TARGETS.join(" | ")} (got ${JSON.stringify(collRaw)})`,
    );
  }

  const shareRaw = val("--max-share");
  const maxShare = shareRaw === undefined ? 0.6 : Number(shareRaw);
  if (!Number.isFinite(maxShare) || maxShare <= 0 || maxShare > 1) {
    throw new Error(`--max-share must be a fraction in (0, 1]; got ${shareRaw}`);
  }

  return {
    apply: has("--apply"),
    env: envRaw as Options["env"],
    collections: collRaw ? [collRaw as TargetName] : [...TARGETS],
    maxShare,
    force: has("--force"),
    snapshot: !has("--no-snapshot"),
  };
}

/** Fetch DATABASE_URL from Secret Manager, mirroring scripts/seed-env.sh. */
function databaseUrlForEnv(env: "qa" | "prod"): string {
  const secret = env === "qa" ? "DATABASE_URL_QA" : "DATABASE_URL_PROD";
  const out = execFileSync(
    "gcloud",
    [
      "secrets",
      "versions",
      "access",
      "latest",
      `--secret=${secret}`,
      `--project=${GCP_PROJECT}`,
    ],
    {
      encoding: "utf8",
      env: { ...process.env, CLOUDSDK_ACTIVE_CONFIG_NAME: "stockbook" },
    },
  );
  return out.trim();
}

/** Mask credentials before anything is printed. */
function maskUri(uri: string): string {
  return uri.replace(/\/\/([^:]+):([^@]+)@/, "//$1:****@");
}

async function confirmWrite(envLabel: string, plan: string): Promise<void> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const answer = await new Promise<string>((resolve) => {
    rl.question(
      `\n  About to DELETE from ${envLabel}:\n${plan}\n` +
        `  This cannot be undone from within the database.\n` +
        `  Type the environment name to proceed: `,
      resolve,
    );
  });
  rl.close();
  if (answer.trim() !== envLabel) {
    throw new Error(`Aborted — expected ${JSON.stringify(envLabel)}.`);
  }
}

interface Scan {
  total: number;
  orphanIds: ObjectId[];
  sample: Document[];
}

/**
 * Stream a collection, classifying each row against `liveIds`.
 *
 * Full documents are appended to `snapshotStream` as they are found, so a
 * 500k-row snapshot never has to be held in memory at once; only the `_id`s
 * are retained, because those are what the delete needs.
 */
async function scanOrphans(
  coll: Collection,
  liveIds: Set<string>,
  snapshotStream: NodeJS.WritableStream | null,
  onFirst: () => void,
): Promise<Scan> {
  const orphanIds: ObjectId[] = [];
  const sample: Document[] = [];
  let total = 0;
  let wroteAny = false;

  const cursor = coll.find({}, { projection: {} });
  for await (const doc of cursor) {
    total++;
    const fk = doc.instrumentId as ObjectId | null | undefined;
    const live = fk != null && liveIds.has(fk.toHexString());
    if (live) continue;

    orphanIds.push(doc._id as ObjectId);
    if (sample.length < 3) sample.push(doc);
    if (snapshotStream) {
      if (!wroteAny) {
        onFirst();
        wroteAny = true;
      } else {
        snapshotStream.write(",\n");
      }
      snapshotStream.write(JSON.stringify(doc));
    }
  }
  return { total, orphanIds, sample };
}

async function main(): Promise<void> {
  const opts = parseArgs(process.argv.slice(2));

  const uri = opts.env ? databaseUrlForEnv(opts.env) : process.env.DATABASE_URL;
  if (!uri) {
    throw new Error(
      "No database URL. Pass --env qa|prod or export DATABASE_URL.",
    );
  }
  const envLabel = opts.env ?? "ambient";

  console.log(
    `\n  Orphan price-row purge — ${opts.apply ? "APPLY" : "DRY RUN"}` +
      `\n  env:        ${envLabel}` +
      `\n  uri:        ${maskUri(uri)}` +
      `\n  targets:    ${opts.collections.join(", ")}` +
      `\n  max share:  ${opts.maxShare}${opts.force ? " (--force: guard bypassed)" : ""}\n`,
  );

  const client = new MongoClient(uri, { serverSelectionTimeoutMS: 30_000 });
  await client.connect();

  try {
    const db = client.db();

    // ── Load the live instrument id set ──────────────────────────────────
    const liveIds = new Set<string>();
    const instrCursor = db
      .collection("instrument_mappings")
      .find({}, { projection: { _id: 1 } });
    for await (const d of instrCursor) liveIds.add((d._id as ObjectId).toHexString());

    console.log(`  instrument_mappings: ${liveIds.size.toLocaleString()} ids`);

    // GUARD 1 — unconditional. An empty set makes every row look orphaned.
    if (liveIds.size === 0) {
      throw new Error(
        "instrument_mappings is EMPTY — every price row would look orphaned. " +
          "Refusing to continue. This is a wrong-database or dropped-collection " +
          "signal, not a cleanup opportunity. (--force does NOT bypass this.)",
      );
    }

    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const results: Array<{ name: TargetName; scan: Scan; share: number }> = [];
    const snapshotPaths: string[] = [];

    // Snapshots land in `scripts/data/rollbacks/`, anchored on THIS FILE rather
    // than on `process.cwd()`. cwd is not a stable anchor: `yarn
    // data:purge-orphans` runs from the repo root, `scripts/ops/
    // run-market-data-job.sh` invokes the sibling scripts by a RELATIVE
    // `scripts/data/...` path (assuming the root without guaranteeing it), and
    // `npx tsx scripts/data/…` runs from wherever the operator is. These files
    // are the ONLY surviving copy of the deleted documents, so scattering them
    // across whichever directory the run started in — where a routine tidy of
    // the repo root then removed them — is not a cosmetic problem.
    //
    // Created ONCE, and only when a snapshot will actually be written: a dry
    // run must not touch the filesystem at all, which is why this sits behind
    // the same `opts.apply && opts.snapshot` condition as the streams below
    // rather than at module load.
    const rollbackDir = path.resolve(
      path.dirname(fileURLToPath(import.meta.url)),
      "rollbacks",
    );
    if (opts.apply && opts.snapshot) mkdirSync(rollbackDir, { recursive: true });

    for (const name of opts.collections) {
      const coll = db.collection(name);
      let stream: NodeJS.WritableStream | null = null;
      let snapPath: string | null = null;

      if (opts.apply && opts.snapshot) {
        snapPath = path.resolve(
          rollbackDir,
          `purge-orphans-rollback-${name}-${stamp}.json`,
        );
        stream = createWriteStream(snapPath, "utf8");
        stream.write("[\n");
      }

      const scan = await scanOrphans(coll, liveIds, stream, () => {});

      if (stream) {
        stream.write("\n]\n");
        await new Promise<void>((res, rej) => {
          stream!.end((err?: Error | null) => (err ? rej(err) : res()));
        });
        snapshotPaths.push(snapPath!);
      }

      const share = scan.total === 0 ? 0 : scan.orphanIds.length / scan.total;
      results.push({ name, scan, share });

      console.log(
        `  ${name.padEnd(15)} total=${scan.total.toLocaleString().padStart(11)}` +
          `  orphan=${scan.orphanIds.length.toLocaleString().padStart(9)}` +
          `  (${(share * 100).toFixed(1)}%)`,
      );
      for (const s of scan.sample) {
        console.log(
          `      e.g. _id=${String(s._id)} instrumentId=${String(s.instrumentId)}` +
            (s.updatedAt ? ` updatedAt=${String(s.updatedAt)}` : "") +
            (s.date ? ` date=${String(s.date)}` : ""),
        );
      }
    }

    // GUARD 2 — a share above the threshold means the premise is probably wrong.
    for (const r of results) {
      if (r.share > opts.maxShare && !opts.force) {
        throw new Error(
          `${r.name}: orphan share ${(r.share * 100).toFixed(1)}% exceeds ` +
            `--max-share ${(opts.maxShare * 100).toFixed(0)}%. Refusing. ` +
            `Either the instrument set is wrong or this is not the cleanup you ` +
            `think it is. Re-check, then pass --force if it is genuinely correct.`,
        );
      }
    }

    const totalOrphans = results.reduce(
      (n, r) => n + r.scan.orphanIds.length,
      0,
    );

    if (!opts.apply) {
      console.log(
        `\n  DRY RUN — nothing deleted. ${totalOrphans.toLocaleString()} rows would go.` +
          `\n  Re-run with --apply to delete (a rollback snapshot is written first).\n`,
      );
      return;
    }

    if (totalOrphans === 0) {
      console.log("\n  Nothing to delete.\n");
      return;
    }

    for (const p of snapshotPaths) {
      console.log(`  Rollback snapshot staged: ${p}`);
    }

    await confirmWrite(
      envLabel,
      results
        .map(
          (r) =>
            `    ${r.name}: ${r.scan.orphanIds.length.toLocaleString()} of ${r.scan.total.toLocaleString()} rows`,
        )
        .join("\n"),
    );

    // ── Delete in batches ────────────────────────────────────────────────
    for (const r of results) {
      if (r.scan.orphanIds.length === 0) continue;
      const coll = db.collection(r.name);
      const BATCH = 5_000;
      let deleted = 0;
      for (let i = 0; i < r.scan.orphanIds.length; i += BATCH) {
        const chunk = r.scan.orphanIds.slice(i, i + BATCH);
        const res = await coll.deleteMany({ _id: { $in: chunk } });
        deleted += res.deletedCount ?? 0;
        process.stdout.write(
          `\r  ${r.name}: deleted ${deleted.toLocaleString()} / ${r.scan.orphanIds.length.toLocaleString()}`,
        );
      }
      process.stdout.write("\n");

      if (deleted !== r.scan.orphanIds.length) {
        console.warn(
          `  WARNING ${r.name}: deleted ${deleted} but planned ` +
            `${r.scan.orphanIds.length}. Rows may have been removed concurrently.`,
        );
      }
    }

    // ── Verify against a live re-count ───────────────────────────────────
    console.log("\n  Verifying...");
    for (const r of results) {
      const coll = db.collection(r.name);
      let remaining = 0;
      const cur = coll.find({}, { projection: { instrumentId: 1 } });
      for await (const d of cur) {
        const fk = d.instrumentId as ObjectId | null | undefined;
        if (fk == null || !liveIds.has(fk.toHexString())) remaining++;
      }
      const total = await coll.countDocuments({});
      console.log(
        `  ${r.name.padEnd(15)} total=${total.toLocaleString().padStart(11)}  orphan remaining=${remaining}`,
      );
      if (remaining !== 0) {
        console.warn(
          `  WARNING ${r.name}: ${remaining} orphans remain. Re-run to finish.`,
        );
      }
    }

    for (const p of snapshotPaths) {
      const applied = p.replace(/\.json$/, ".applied.json");
      renameSync(p, applied);
      console.log(`  Snapshot finalised: ${applied}`);
    }
    console.log("");
  } finally {
    await client.close();
  }
}

main().catch((err: unknown) => {
  console.error(`\n  ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
