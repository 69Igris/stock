/**
 * databento-inventory.ts — what the Databento harvest ACTUALLY holds. READ-ONLY.
 *
 * Data-platform S0b (MONEY-1463). MONEY-1373 decided what each of the seven
 * manifest entries is FOR; this establishes what EXISTS, and writes
 * `docs/reference/databento-inventory-{YYYY-MM}.md`.
 *
 * Usage:
 *   npx tsx scripts/ops/databento-inventory.ts
 *   npx tsx scripts/ops/databento-inventory.ts --month=2026-10
 *
 * `--month` names the OUTPUT FILE and nothing else. The report is always a
 * snapshot of the state at generation time — the ledger query is unfiltered —
 * so `--month=2026-08` writes an August-named file full of today's facts. The
 * artifact carries `generatedAt` in its first line for exactly that reason.
 *   npx tsx scripts/ops/databento-inventory.ts --skip-gcs   # ledger + Mongo only
 *
 * ## NO WRITES, AND A TEST ENFORCES IT
 *
 * `packages/core/__tests__/ops/databento-inventory.test.ts` scans this source
 * for every Mongo mutation verb, for `$out` / `$merge`, for the storage
 * package's writing exports (`uploadFile`, `uploadStream`, `deleteFile`), for
 * `listFiles`, and for any `db.command()` argument outside a read allowlist.
 * The script reads production and must stay incapable of changing it.
 *
 * ## NEVER `listFiles`
 *
 * `@usemoney/storage`'s `listFiles` fails open to `[]` on error, so a listing
 * can never support an "it is missing" verdict — an empty result is
 * indistinguishable from an outage. Every key checked here comes from the
 * LEDGER's own `archiveKey` and is fetched with `getFileMetadata`. The rule is
 * the data-platform plan's ("compute keys and `get`, or ask the ledger") and
 * the test asserts `listFiles` never appears.
 *
 * ## THREE presence states, because two would have lied on the first run
 *
 * `getFileMetadata` returns `null` for an absent OBJECT and THROWS for an
 * unreachable bucket or a bad credential. Measured while building this: an
 * expired ADC token threw on every key. Had throw been folded into "absent",
 * the first report would have declared all 66,046 files missing and raised a
 * re-purchase alarm over a laptop login. `UNKNOWN` still blocks the
 * "fully present" claim — you cannot bank a file you could not see — but it
 * reports as NOT VERIFIED rather than VERIFIED MISSING.
 *
 * ## The credentials, and why GCS needs the service-account key
 *
 * Mongo: `MONGODB_URI_RO_PROD` (created by `create-ro-secrets.mjs`, the
 * `datadog_monitor` user — reads everything, writes refused `Unauthorized`).
 *
 * GCS: `GCP_SERVICE_ACCOUNT_KEY_BASE64` from Secret Manager rather than
 * Application Default Credentials. ADC on a laptop expires into an
 * `invalid_rapt` reauth error that surfaces as a THROW on every object, i.e.
 * as 66,046 unverifiable files. Reading the key the deployed services use
 * removes a failure mode whose symptom is a report full of holes.
 *
 * ## Concurrency
 *
 * 66,046 HEADs serially at ~60 ms is over an hour. They run `HEAD_CONCURRENCY`
 * at a time — GCS metadata reads are Class B operations and this is a modest
 * fan-out — bringing a full pass to a few minutes. Failures are per-key and
 * become `UNKNOWN`; one bad object never aborts the sweep.
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { MongoClient } from "mongodb";

import { parseCliArgsOrExit } from "@usemoney/core/ops/cli-args";
import { GCP_PROJECT_ID, secret } from "@usemoney/core/ops/gcp-secrets";
import {
  type CandleRollup,
  type InventoryFile,
  type InventoryJob,
  type PresenceResult,
  renderInventory,
  rollupEntries,
} from "@usemoney/core/ops/databento-inventory";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const OUT_DIR = join(REPO_ROOT, "docs", "reference");
const PROD_BUCKET = "stockbook-content-prod";
/** Simultaneous GCS metadata reads. Class B ops; modest fan-out. */
const HEAD_CONCURRENCY = 32;
/** The `source` value Databento bars carry — `DATABENTO_SOURCE`. */
const DATABENTO_SOURCE = "DATABENTO";

function num(v: unknown): number {
  const n = typeof v === "bigint" ? Number(v) : Number(v);
  return Number.isFinite(n) ? n : 0;
}

function asDate(v: unknown): Date | null {
  if (v instanceof Date) return v;
  if (typeof v === "string" || typeof v === "number") {
    const d = new Date(v);
    return Number.isNaN(d.getTime()) ? null : d;
  }
  return null;
}

/**
 * The `files` column is `Json`, therefore `unknown`. Mirrors
 * `readFileRecords` in `databento-repo.ts`, which cannot be imported here
 * because it pulls in the Prisma client and this script uses the raw driver
 * against a read-only URI.
 */
let droppedRecords = 0;

function readFiles(raw: unknown): InventoryFile[] {
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((r) => {
    if (!r || typeof r !== "object") {
      droppedRecords++;
      return [];
    }
    const o = r as Record<string, unknown>;
    const archiveKey = typeof o.archiveKey === "string" ? o.archiveKey : "";
    if (!archiveKey) {
      // A record with no key cannot be checked at all — but dropping it
      // SILENTLY shrinks the denominator, so a row that lost some keys reads
      // "N/N in GCS" and fullyPresent. Only the all-dropped case is caught by
      // the empty-list guard. Counted and reported instead.
      droppedRecords++;
      return [];
    }
    return [
      {
        filename: String(o.filename ?? ""),
        archiveKey,
        size: num(o.size),
        kind: o.kind === "support" ? ("support" as const) : ("data" as const),
        verified: o.verified === true,
        loadedRows: o.loadedRows === undefined ? undefined : num(o.loadedRows),
      },
    ];
  });
}

/** Run `work` over `items` with a bounded number in flight. */
async function mapLimit<T, R>(
  items: readonly T[],
  limit: number,
  work: (item: T) => Promise<R>,
): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      out[i] = await work(items[i]!);
    }
  });
  await Promise.all(runners);
  return out;
}

async function main(): Promise<void> {
  const args = parseCliArgsOrExit(
    process.argv.slice(2),
    { bare: ["skip-gcs"], valued: ["month"], numeric: [] },
    "databento-inventory",
  );
  const month = args.value("month") ?? new Date().toISOString().slice(0, 7);
  if (!/^\d{4}-\d{2}$/.test(month)) {
    console.error(`[databento-inventory] --month=${month} is not YYYY-MM.`);
    process.exit(1);
  }

  // ── credentials ─────────────────────────────────────────────────────────
  const mongoRo = secret("MONGODB_URI_RO_PROD");
  if (!("value" in mongoRo)) {
    console.error(
      `[databento-inventory] no read-only Mongo credential: ${mongoRo.reason}\n` +
        "Create it with: node scripts/ops/create-ro-secrets.mjs",
    );
    process.exit(1);
  }

  const skipGcs = args.has("skip-gcs");
  let gcsReady = false;
  if (!skipGcs) {
    const key = secret("GCP_SERVICE_ACCOUNT_KEY_BASE64");
    if ("value" in key) {
      process.env.GCP_SERVICE_ACCOUNT_KEY_BASE64 = key.value;
      process.env.GCP_PROJECT_ID = GCP_PROJECT_ID;
      process.env.GCP_STORAGE_BUCKET = PROD_BUCKET;
      gcsReady = true;
    } else {
      console.warn(`[databento-inventory] GCS unavailable: ${key.reason}`);
    }
  }

  // ── the ledger ──────────────────────────────────────────────────────────
  const client = new MongoClient(mongoRo.value, { serverSelectionTimeoutMS: 20_000 });
  await client.connect();
  let jobs: InventoryJob[] = [];
  let candles: CandleRollup[] | null = null;
  let candlesNote: string | null = null;
  let databaseName = "";
  try {
    const db = client.db();
    databaseName = db.databaseName;
    const rows = await db
      .collection("databento_batch_jobs")
      .find({}, { readPreference: "secondaryPreferred" })
      .toArray();

    jobs = rows.map((r) => ({
      rowId: String(r._id),
      env: String(r.env ?? "unknown"),
      entryId: String(r.entryId ?? "unknown"),
      schema: String(r.schema ?? "unknown"),
      dataset: String(r.dataset ?? "unknown"),
      purpose: String(r.purpose ?? "unknown"),
      state: String(r.state ?? "unknown"),
      jobId: typeof r.jobId === "string" ? r.jobId : null,
      costUsd: r.costUsd === null || r.costUsd === undefined ? null : num(r.costUsd),
      costUsdQuoted: num(r.costUsdQuoted),
      submittedAt: asDate(r.submittedAt),
      tsExpiration: asDate(r.tsExpiration),
      symbolCount: num(r.symbolCount),
      start: asDate(r.start),
      end: asDate(r.end),
      loadedRows: num(r.loadedRows),
      files: readFiles(r.files),
    }));
    console.log(
      `[databento-inventory] ${jobs.length} ledger rows, ${jobs.reduce((n, j) => n + j.files.length, 0)} file records`,
    );

    // ── candles actually loaded ───────────────────────────────────────────
    try {
      const agg = await db
        .collection("candles")
        .aggregate(
          [
            { $match: { source: DATABENTO_SOURCE } },
            { $group: { _id: { tf: "$timeframe", sym: "$symbol", y: { $year: "$ts" } }, rows: { $sum: 1 } } },
            {
              $group: {
                _id: "$_id.tf",
                rows: { $sum: "$rows" },
                // `$addToSet`, NOT `$sum: 1`. The inner group is keyed on
                // (timeframe, symbol, YEAR), so counting its documents counts
                // symbol-years: a symbol present in four years would be four
                // "distinct symbols". The bug is invisible while the hot window
                // holds a single year — which is exactly the state prod is in
                // today — and silently quadruples the moment it does not.
                syms: { $addToSet: "$_id.sym" },
                minYear: { $min: "$_id.y" },
                maxYear: { $max: "$_id.y" },
              },
            },
            { $project: { rows: 1, minYear: 1, maxYear: 1, symbols: { $size: "$syms" } } },
          ],
          { readPreference: "secondaryPreferred", allowDiskUse: true, maxTimeMS: 20 * 60_000 },
        )
        .toArray();
      candles = agg
        .map((d) => ({
          timeframe: String(d._id),
          rows: num(d.rows),
          symbols: num(d.symbols),
          minYear: d.minYear === null || d.minYear === undefined ? null : num(d.minYear),
          maxYear: d.maxYear === null || d.maxYear === undefined ? null : num(d.maxYear),
        }))
        .sort((a, b) => b.rows - a.rows);
      console.log(
        `[databento-inventory] candles: ${candles.map((c) => `${c.timeframe}=${c.rows}`).join(" ")}`,
      );
    } catch (err) {
      candlesNote = `the aggregation did not complete (\`${String(err).slice(0, 160)}\`)`;
      console.warn(`[databento-inventory] candles count failed — ${candlesNote}`);
    }
  } finally {
    await client.close();
  }

  // ── GCS presence, from the ledger's own keys ────────────────────────────
  const presenceByRow = new Map<string, PresenceResult[]>();
  if (gcsReady) {
    const { getFileMetadata } = await import("@usemoney/storage");
    const flat = jobs.flatMap((j) => j.files.map((f) => ({ rowId: j.rowId, file: f })));
    console.log(`[databento-inventory] HEADing ${flat.length} objects in ${PROD_BUCKET}…`);
    let done = 0;
    const results = await mapLimit(flat, HEAD_CONCURRENCY, async ({ rowId, file }) => {
      let r: PresenceResult;
      try {
        const meta = await getFileMetadata(file.archiveKey);
        if (!meta) {
          r = {
            archiveKey: file.archiveKey,
            state: "ABSENT",
            ledgerSize: file.size,
            ledgerVerified: file.verified === true,
          };
        } else {
          const gcsSize = num(meta.size);
          const base = {
            archiveKey: file.archiveKey,
            gcsSize,
            ledgerSize: file.size,
            ledgerVerified: file.verified === true,
          };
          if (file.size <= 0) {
            // NOTHING TO COMPARE AGAINST is not agreement. `readFiles` maps a
            // missing or NaN `size` to 0, and the download job's failure branch
            // stamps `verified:false` WITHOUT a size — so `size > 0 && …` used
            // to certify such a record PRESENT at whatever size GCS reported.
            r = { ...base, state: "UNKNOWN", detail: "ledger records no size — nothing to compare" };
          } else if (gcsSize !== file.size) {
            r = { ...base, state: "MISMATCH", detail: `ledger ${file.size} vs gcs ${gcsSize}` };
          } else {
            r = { ...base, state: "PRESENT" };
          }
        }
      } catch (err) {
        // A THROW is an unreachable bucket or a bad credential — NOT evidence
        // that the object is gone. See the module header.
        r = {
          archiveKey: file.archiveKey,
          state: "UNKNOWN",
          ledgerSize: file.size,
          ledgerVerified: file.verified === true,
          detail: String(err).slice(0, 120),
        };
      }
      if (++done % 10_000 === 0) console.log(`[databento-inventory]   ${done}/${flat.length}`);
      return { rowId, r };
    });
    for (const { rowId, r } of results) {
      const bucket = presenceByRow.get(rowId);
      if (bucket) bucket.push(r);
      else presenceByRow.set(rowId, [r]);
    }
    const tally = results.reduce<Record<string, number>>((m, x) => {
      m[x.r.state] = (m[x.r.state] ?? 0) + 1;
      return m;
    }, {});
    console.log(`[databento-inventory] presence: ${JSON.stringify(tally)}`);
  } else {
    console.warn("[databento-inventory] GCS checks SKIPPED — every file reports UNVERIFIED");
    for (const j of jobs) {
      presenceByRow.set(
        j.rowId,
        j.files.map((f) => ({
          archiveKey: f.archiveKey,
          state: "UNKNOWN" as const,
          ledgerSize: f.size,
          ledgerVerified: f.verified === true,
          detail: skipGcs ? "--skip-gcs" : "no GCS credential",
        })),
      );
    }
  }

  // ── manifest entries the ledger has never heard of ──────────────────────
  const manifest = JSON.parse(
    readFileSync(join(REPO_ROOT, "scripts/data/databento-manifest.json"), "utf8"),
  ) as { entries: Array<{ id: string }> };
  const seen = new Set(jobs.map((j) => j.entryId));
  const manifestOnlyEntries = manifest.entries.map((e) => e.id).filter((id) => !seen.has(id));

  const now = new Date();
  let commit = "unknown";
  try {
    commit = execFileSync("git", ["rev-parse", "--short", "HEAD"], {
      cwd: REPO_ROOT,
      encoding: "utf8",
    }).trim();
  } catch {
    /* provenance degrades; the capture does not */
  }

  const rollups = rollupEntries(jobs, presenceByRow, now);
  const problems = [...presenceByRow.values()]
    .flat()
    .filter((p) => p.state !== "PRESENT")
    .sort((a, b) => a.archiveKey.localeCompare(b.archiveKey));
  mkdirSync(OUT_DIR, { recursive: true });
  const path = join(OUT_DIR, `databento-inventory-${month}.md`);
  writeFileSync(
    path,
    renderInventory({
      generatedAt: now.toISOString(),
      commit,
      month,
      bucket: gcsReady ? PROD_BUCKET : "(not checked)",
      database: databaseName,
      rollups,
      candles,
      candlesNote,
      manifestOnlyEntries,
      problems,
      droppedRecords,
      now,
    }),
    "utf8",
  );
  console.log(`[databento-inventory] wrote ${path}`);
  if (droppedRecords > 0) {
    console.warn(
      `[databento-inventory] ${droppedRecords} file record(s) had no usable archiveKey and were NOT checked`,
    );
  }

  const risky = rollups.filter((r) => r.atRisk);
  for (const r of risky) console.error(`[databento-inventory] AT RISK: ${r.entryId} — ${r.riskReason}`);
  console.log(
    risky.length === 0
      ? "[databento-inventory] no entry is at re-purchase risk"
      : `[databento-inventory] ${risky.length} entries AT RE-PURCHASE RISK`,
  );
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error("[databento-inventory]", err);
    process.exit(1);
  });
}
