/**
 * atlas-heatmap.ts — the G0 gate for the data-platform migration. READ-ONLY.
 *
 * Measures what Atlas is actually holding, so that nothing is deleted from
 * Mongo on the strength of an estimate. Emits two artifacts:
 *
 *   docs/reference/atlas-heatmap-{YYYY-MM}.md      the human heat map
 *   docs/reference/atlas-indexstats-{YYYY-MM}.json the machine capture B6 diffs
 *
 * Usage:
 *   npx tsx scripts/ops/atlas-heatmap.ts                 # RO credential required
 *   npx tsx scripts/ops/atlas-heatmap.ts --allow-rw      # fall back to DATABASE_URL_PROD
 *   npx tsx scripts/ops/atlas-heatmap.ts --month=2026-10 # the B6 re-run, 30 days later
 *   npx tsx scripts/ops/atlas-heatmap.ts --skip-candles  # if the cube scan is too heavy
 *
 * ## THIS FILE CONTAINS NO WRITE CALL, AND THAT IS ENFORCED
 *
 * `atlas-heatmap.test.ts` scans this source for every Mongo mutation
 * verb and for the `$out` / `$merge` aggregation stages, and fails on any of
 * them. A source scan cannot usually assert a policy — it proves a call site
 * exists, not which of two expressions is there — but the policy here is
 * literally "this file contains no write call", which is exactly the shape a
 * scan does settle. It matters because `--allow-rw` can hand this script the
 * read-WRITE production credential.
 *
 * ## THE CREDENTIAL, and how to create the one this wants
 *
 * Resolution ladder, first hit wins:
 *
 *   1. `MONGODB_URI_RO` in the environment.
 *   2. GCP Secret Manager `MONGODB_URI_RO_PROD`  <- the intended steady state.
 *   3. `--allow-rw` only: Secret Manager `DATABASE_URL_PROD`, the read-write
 *      application credential, with a banner and a stamp in the emitted
 *      markdown naming which credential produced the numbers.
 *
 * Rung 2 did not exist when this was written. Creating it is a FOUNDER action
 * in the Atlas UI — there is no Atlas CLI on this machine and no Atlas Admin
 * API key in Secret Manager, so the script cannot do it and does not pretend
 * to. The procedure is in the emitted markdown and in
 * docs/reference/atlas-heatmap-2026-09.md § "Creating the read-only user".
 *
 * The roles needed are `clusterMonitor@admin` (dbStats, collStats, indexStats)
 * plus `readAnyDatabase@admin` (the `candles` aggregation). That pair is known
 * to be sufficient rather than guessed: the `datadog_monitor` user created for
 * MONEY-1377 carries exactly it and reaches everything DBM issues, including
 * `local.oplog.rs`.
 *
 * ## THE TWO READS WANT OPPOSITE READ PREFERENCES
 *
 * `$indexStats` is NODE-LOCAL. Its `accesses.ops` counter lives in that one
 * mongod's memory, counts only what that member served, and resets to zero when
 * the process restarts. Our workload is served by the PRIMARY, so reading index
 * usage from a secondary reports near-zero ops for every index — and B6, whose
 * whole job is "list indexes with zero ops in 30 days", would then propose
 * dropping the hottest indexes on the cluster. So `$indexStats` is pinned to
 * `primary`, and every doc's `host` and `accesses.since` are carried into the
 * JSON: a `since` that moved FORWARD between two captures means the node
 * restarted and the 30-day comparison is void, not clean.
 *
 * Everything else — dbStats, $collStats, the candles cube — reads replicated
 * data and returns the same answer from any member, so it goes to
 * `secondaryPreferred` and keeps a full-collection scan off the node serving
 * the app.
 *
 * ## ONE PASS OVER `candles`, NOT THREE
 *
 * The three breakdowns asked for (by timeframe, by source, by year of `ts`)
 * are three foldings of one cube. `$group` on a compound `_id` of all three
 * scans the collection once and returns a few hundred rows; the folding is
 * pure and tested. Three separate `$group` stages would be three scans of a
 * collection measured in the hundreds of millions of rows.
 *
 * `$year` cannot use an index, so the cube is a COLLSCAN however it is spelled.
 * It is therefore bounded by `maxTimeMS` and, on breach, reported as a named
 * failure in the markdown rather than taking the whole run down — the size
 * table is the load-bearing half and must survive a slow cube.
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { MongoClient } from "mongodb";

import { parseCliArgsOrExit } from "@usemoney/core/ops/cli-args";
import { secret } from "@usemoney/core/ops/gcp-secrets";
import {
  INDEX_STATS_COLLECTIONS,
  type ClusterReport,
  type CollectionStats,
  type CubeRow,
  type IndexStatsDoc,
  firstNonBlank,
  foldCube,
  footprint,
  redactUri,
  renderMarkdown,
  summariseCollStats,
} from "@usemoney/core/ops/atlas-heatmap";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const OUT_DIR = join(REPO_ROOT, "docs", "reference");

/** Local mirror of the pure module's `num`, for the driver's BSON numerics. */
function num(v: unknown): number {
  const n = typeof v === "bigint" ? Number(v) : Number(v);
  return Number.isFinite(n) ? n : 0;
}

// ---------------------------------------------------------------------------
// I/O
// ---------------------------------------------------------------------------


function resolveMain(allowRw: boolean): { uri: string; credential: string } {
  const fromEnv = firstNonBlank(process.env.MONGODB_URI_RO);
  if (fromEnv) {
    return { uri: fromEnv, credential: "env `MONGODB_URI_RO` (read-only)" };
  }
  const ro = secret("MONGODB_URI_RO_PROD");
  if ("value" in ro) {
    return { uri: ro.value, credential: "Secret Manager `MONGODB_URI_RO_PROD` (read-only)" };
  }
  console.warn(`[atlas-heatmap] no read-only credential: ${ro.reason}`);
  if (allowRw) {
    const rw = secret("DATABASE_URL_PROD");
    if ("value" in rw) {
      console.warn(
        "[atlas-heatmap] No read-only credential found; --allow-rw given, so connecting with " +
          "DATABASE_URL_PROD (read-WRITE). This script issues no write call and a test enforces " +
          "that, but create the RO user — the procedure is in the emitted markdown.",
      );
      return {
        uri: rw.value,
        credential:
          "Secret Manager `DATABASE_URL_PROD` — **read-write application credential**, used under `--allow-rw` because no RO user existed at capture time",
      };
    }
  }
  console.error(
    [
      "[atlas-heatmap] No credential. Tried, in order:",
      "  1. env MONGODB_URI_RO",
      "  2. Secret Manager MONGODB_URI_RO_PROD",
      allowRw ? "  3. Secret Manager DATABASE_URL_PROD (--allow-rw)" : "  3. skipped — pass --allow-rw to permit the read-write credential",
      "",
      "Create the read-only user: Atlas -> Database Access -> Add New Database User,",
      "roles clusterMonitor@admin + readAnyDatabase@admin, then store the SRV string as",
      "MONGODB_URI_RO_PROD. Full procedure in docs/reference/atlas-heatmap-*.md.",
    ].join("\n"),
  );
  process.exit(1);
}

/**
 * The claude-algo cluster, resolved the way claude-algo itself resolves it.
 *
 * That repo's rule is `MONGODB_URI_RO ?? MONGODB_URI` (`packages/db/src/prisma.ts`,
 * `apps/dashboard/lib/db.ts`), and its own `deploy/evidence_datadog.md` records
 * the state we hit here: "`ALGO_MONGODB_URI_RO_PROD` has no readable version
 * (the secret container exists) … The API therefore reads through the
 * read-write URI." So `algo-api-prod` is ALREADY running on the RW credential
 * and this measurement is not reaching for anything the owning repo does not.
 *
 * `ALGO_MONGODB_URI_DD_PROD` is deliberately not in the ladder: it does not
 * exist in Secret Manager at all (checked 2026-09-14), and claude-algo's
 * `install_datadog.sh` builds its agent credential from
 * `DD_MONGO_MONITOR_PASSWORD_PROD` plus a `datadog_monitor` USERNAME instead.
 * Assembling a URI from those parts would mean CONSTRUCTING a credential and
 * guessing the cluster host, whose failure mode is an auth error
 * indistinguishable from a user that was never provisioned on that cluster.
 * Reading a secret that exists is the lazier and more honest rung.
 *
 * OWNERSHIP: this reads the algo cluster and touches nothing inside it. Per
 * stockbook's CLAUDE.md the `algo-*` VMs and their services belong to the
 * claude-algo repo; a read-only footprint measurement is not a change to them.
 */
function resolveAlgo(allowRw: boolean): { uri: string; credential: string } | { reason: string } {
  const fromEnv = firstNonBlank(process.env.MONGODB_URI_ALGO_RO);
  if (fromEnv) {
    return { uri: fromEnv, credential: "env `MONGODB_URI_ALGO_RO` (read-only)" };
  }
  const ro = secret("ALGO_MONGODB_URI_RO_PROD");
  if ("value" in ro) {
    return { uri: ro.value, credential: "Secret Manager `ALGO_MONGODB_URI_RO_PROD` (read-only)" };
  }
  if (!allowRw) return { reason: `${ro.reason}, and --allow-rw was not given` };

  const rw = secret("ALGO_MONGODB_URI_PROD");
  if ("value" in rw) {
    console.warn(
      "[atlas-heatmap] claude-algo: no read-only credential; --allow-rw given, so connecting " +
        "with ALGO_MONGODB_URI_PROD (read-WRITE) — the same fallback algo-api-prod already runs on.",
    );
    return {
      uri: rw.value,
      credential:
        "Secret Manager `ALGO_MONGODB_URI_PROD` — **read-write credential**, used under " +
        "`--allow-rw` because `ALGO_MONGODB_URI_RO_PROD` exists with ZERO VERSIONS. This is " +
        "claude-algo's own documented fallback (`MONGODB_URI_RO ?? MONGODB_URI`), not a new rule",
    };
  }
  return { reason: `${ro.reason}; and the read-write fallback ${rw.reason}` };
}

async function gather(
  uri: string,
  label: string,
  credential: string,
  dbNameOverride: string | null,
  skipCandles: boolean,
  candlesTimeoutMs: number,
): Promise<ClusterReport> {
  const client = new MongoClient(uri, { serverSelectionTimeoutMS: 20_000 });
  await client.connect();
  try {
    const db = dbNameOverride ? client.db(dbNameOverride) : client.db();
    const build = (await db.admin().command({ buildInfo: 1 })) as { version?: string };

    // Replicated data — read off a secondary so a full scan never touches the
    // node serving the app. See the header for why $indexStats does NOT.
    const ro = { readPreference: "secondaryPreferred" as const };

    const stats = (await db.command({ dbStats: 1 }, ro)) as Record<string, unknown>;

    const listed = await db.listCollections({}, { nameOnly: false }).toArray();
    const collections: CollectionStats[] = [];
    for (const entry of listed) {
      if (entry.type === "view") continue; // $collStats errors on a view
      try {
        const docs = await db
          .collection(entry.name)
          .aggregate([{ $collStats: { storageStats: {} } }], ro)
          .toArray();
        collections.push(
          summariseCollStats(entry.name, String(entry.type ?? "collection"), docs as Record<string, unknown>[]),
        );
      } catch (err) {
        console.warn(`[atlas-heatmap] ${label}: $collStats failed for ${entry.name}: ${String(err)}`);
      }
    }
    console.log(`[atlas-heatmap] ${label}: ${collections.length} collections measured`);

    // ── the candles cube: ONE scan, three foldings ──────────────────────────
    let candles: ClusterReport["candles"] = null;
    let candlesNote: string | null = null;
    const hasCandles = collections.some((c) => c.name === "candles");
    if (!hasCandles) {
      candlesNote = "no `candles` collection in this database";
    } else if (skipCandles) {
      candlesNote = "`--skip-candles` was passed";
    } else {
      console.log(`[atlas-heatmap] ${label}: candles cube (one COLLSCAN, bounded to ${candlesTimeoutMs / 60_000} min)…`);
      try {
        const raw = await db
          .collection("candles")
          .aggregate(
            [
              {
                $group: {
                  _id: { timeframe: "$timeframe", source: "$source", year: { $year: "$ts" } },
                  docs: { $sum: 1 },
                },
              },
            ],
            { ...ro, allowDiskUse: true, maxTimeMS: candlesTimeoutMs },
          )
          .toArray();
        const cube: CubeRow[] = raw.map((d) => {
          const id = d._id as { timeframe?: string; source?: string; year?: number };
          return {
            timeframe: id?.timeframe ?? "(absent)",
            source: id?.source ?? "(absent)",
            year: id?.year ?? null,
            docs: num(d.docs),
          };
        });
        candles = { cube, breakdowns: foldCube(cube) };
      } catch (err) {
        candlesNote = `the aggregation did not complete within ${candlesTimeoutMs / 60_000} minutes (\`${String(err).slice(0, 160)}\`)`;
        console.warn(`[atlas-heatmap] ${label}: candles cube failed — ${candlesNote}`);
      }
    }

    // ── $indexStats: PRIMARY ONLY. Counters are per-node. ───────────────────
    const largest = [...collections].sort((a, b) => footprint(b) - footprint(a)).slice(0, INDEX_STATS_COLLECTIONS);
    const indexStats: IndexStatsDoc[] = [];
    for (const c of largest) {
      try {
        const docs = await db
          .collection(c.name)
          .aggregate([{ $indexStats: {} }], { readPreference: "primary" })
          .toArray();
        for (const d of docs) {
          const accesses = (d.accesses ?? {}) as { ops?: unknown; since?: unknown };
          indexStats.push({
            collection: c.name,
            index: String(d.name),
            host: String(d.host ?? "unknown"),
            ops: num(accesses.ops),
            since: accesses.since instanceof Date ? accesses.since.toISOString() : String(accesses.since ?? ""),
          });
        }
      } catch (err) {
        console.warn(`[atlas-heatmap] ${label}: $indexStats failed for ${c.name}: ${String(err)}`);
      }
    }
    console.log(`[atlas-heatmap] ${label}: ${indexStats.length} index-usage rows from ${largest.length} collections`);

    return {
      label,
      hostRedacted: redactUri(uri),
      credential,
      dbName: db.databaseName,
      serverVersion: build.version ?? "unknown",
      dbStats: {
        collections: num(stats.collections),
        objects: num(stats.objects),
        dataSize: num(stats.dataSize),
        storageSize: num(stats.storageSize),
        indexes: num(stats.indexes),
        indexSize: num(stats.indexSize),
      },
      collections,
      candles,
      candlesNote,
      indexStats,
    };
  } finally {
    await client.close();
  }
}

async function main(): Promise<void> {
  const args = parseCliArgsOrExit(
    process.argv.slice(2),
    {
      bare: ["allow-rw", "skip-candles"],
      valued: ["month", "candles-timeout-min"],
      numeric: ["candles-timeout-min"],
    },
    "atlas-heatmap",
  );

  const month = args.value("month") ?? new Date().toISOString().slice(0, 7);
  if (!/^\d{4}-\d{2}$/.test(month)) {
    console.error(`[atlas-heatmap] --month=${month} is not YYYY-MM.`);
    process.exit(1);
  }
  const candlesTimeoutMs = args.number("candles-timeout-min", 20) * 60_000;
  const skipCandles = args.has("skip-candles");

  const clusters: ClusterReport[] = [];
  const skipped: string[] = [];

  const main_ = resolveMain(args.has("allow-rw"));
  clusters.push(
    await gather(main_.uri, "stockbook — PROD", main_.credential, null, skipCandles, candlesTimeoutMs),
  );

  const algo = resolveAlgo(args.has("allow-rw"));
  if ("uri" in algo) {
    clusters.push(await gather(algo.uri, "claude-algo — PROD", algo.credential, "algo", skipCandles, candlesTimeoutMs));
  } else {
    console.warn(`[atlas-heatmap] claude-algo not measured: ${algo.reason}`);
    skipped.push(
      `**claude-algo cluster NOT MEASURED.** \`MONGODB_URI_ALGO_RO\` is unset and ${algo.reason}. ` +
        "This is a named absence, not an empty section — the algo cluster's footprint is simply " +
        "unknown here, and the Invoice total below will not account for it.",
    );
  }

  let commit = "unknown";
  try {
    commit = execFileSync("git", ["rev-parse", "--short", "HEAD"], {
      cwd: REPO_ROOT,
      encoding: "utf8",
    }).trim();
  } catch {
    /* not a git checkout — provenance degrades, the capture does not */
  }

  const generatedAt = new Date().toISOString();
  mkdirSync(OUT_DIR, { recursive: true });

  const mdPath = join(OUT_DIR, `atlas-heatmap-${month}.md`);
  writeFileSync(mdPath, renderMarkdown(month, generatedAt, commit, clusters, skipped), "utf8");

  const jsonPath = join(OUT_DIR, `atlas-indexstats-${month}.json`);
  writeFileSync(
    jsonPath,
    JSON.stringify(
      {
        generatedAt,
        commit,
        month,
        note:
          "Index-usage counters are PER NODE and reset on mongod restart. A later capture " +
          "whose `since` has moved forward for a host makes the comparison void for every " +
          "index on that host. Captured from the PRIMARY; see scripts/ops/atlas-heatmap.ts.",
        clusters: clusters.map((c) => ({
          label: c.label,
          host: c.hostRedacted,
          database: c.dbName,
          serverVersion: c.serverVersion,
          credential: c.credential,
          indexStats: c.indexStats,
          collectionFootprint: [...c.collections]
            .sort((a, b) => footprint(b) - footprint(a))
            .map((x) => ({
              name: x.name,
              count: x.count,
              storageSize: x.storageSize,
              totalIndexSize: x.totalIndexSize,
              indexSizes: x.indexSizes,
            })),
          candlesCube: c.candles?.cube ?? null,
          // WHY the cube is null, carried into the machine artifact. Without it
          // B6 cannot tell a cube that TIMED OUT from one that is legitimately
          // empty — the markdown says so and the JSON did not.
          candlesNote: c.candlesNote,
        })),
      },
      null,
      2,
    ) + "\n",
    "utf8",
  );

  console.log(`[atlas-heatmap] wrote ${mdPath}`);
  console.log(`[atlas-heatmap] wrote ${jsonPath}`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error("[atlas-heatmap]", err);
    process.exit(1);
  });
}
