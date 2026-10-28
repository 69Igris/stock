/**
 * Snapshot + restore the VENDOR rows of `stock_ratios` and `stock_financials` —
 * MONEY-1401 B3.
 *
 * ## What it is for
 *
 * `stock_ratios` is `@@unique([symbol, exchange])` and `stock_financials` is
 * `@@unique([symbol, exchange, statementType, periodType, period])`. NEITHER
 * carries `source` (both deliberate, and both documented on the models). So two
 * sources describing one period are ONE row: the first XBRL write does not sit
 * beside the incumbent Tickertape value, it REPLACES it, and the gate that was
 * supposed to compare them has nothing left to compare against.
 *
 * That is the one-way door that has blocked `XBRL_PROJECTION_APPLY` since
 * 2026-08-30. This script is the reversibility: take the vendor rows out to a
 * side collection first, and arming the projection becomes an experiment that
 * can be undone in one command instead of a decision that has to be provably
 * right in advance.
 *
 * Measured on prod 2026-09-13: `stock_ratios` 2,135 rows (100%
 * `source: "TICKERTAPE"`), `stock_financials` 32,359 rows.
 *
 * ## Safety
 *
 *   - DRY-RUN BY DEFAULT, both directions. `--apply` is required to write.
 *   - EVERY `--apply` requires a TTY and typing "yes", and echoes the masked
 *     target host first — not just `--env prod`, because the documented
 *     `DATABASE_URL=... --apply` form leaves `--env` null and would bypass an
 *     `--env`-keyed check entirely (the MONEY-1093 finding on
 *     `reclassify-instruments.ts`).
 *   - SNAPSHOT IS OF THE VENDOR'S ROWS. A row already stamped with a source we
 *     write ourselves (`NSE_XBRL`, `DOC_PDF`) is EXCLUDED and counted. Storing
 *     it would put our own values in a collection whose name promises the
 *     vendor's, and a later restore would put them back reporting success.
 *   - SNAPSHOT IS IDEMPOTENT, AND ONLY IDEMPOTENT. Each document's `_id` is
 *     `<snapshotDay>|<naturalKey>`, and a re-run DELETES that day's documents
 *     before inserting — so a crashed run is re-runnable and can never append a
 *     second copy. But it REFUSES to replace a stored day whose rows have since
 *     been overwritten by a different `source` (MONEY-1401 F7). `snapshotDay`
 *     is a UTC day and IST 05:30-00:00 is ONE UTC day, so "snapshot at 11:00,
 *     arm, run the job at 15:00, re-snapshot at 16:00 to check" is the NORMAL
 *     shape of an Indian working session — and it used to delete the only copy
 *     of the vendor values and store the XBRL rows over them, after which
 *     `runRestore` would restore XBRL over XBRL and refuse nothing (its only
 *     guard is `days.size > 1`, and there is still exactly one day).
 *     The refusal fires in DRY RUN too: a rehearsal that hides it is not one.
 *   - RESTORE NEVER DELETES. A row that appeared after the snapshot is left
 *     alone. Restore puts back what was taken; discarding everything written
 *     since is a different and much larger promise.
 *   - RESTORE CHECKS WHAT IT IS RESTORING. The vendor-row exclusion above is on
 *     the WRITER, and the snapshot collections outlive it — a day stored by an
 *     earlier run, or taken deliberately after arming, can hold `NSE_XBRL` rows.
 *     Restoring one puts OUR OWN values back under a command that says vendor,
 *     and reports success. It refuses instead, in DRY RUN too (MONEY-1401 F7).
 *   - RESTORE REFUSES TO GUESS WHICH SNAPSHOT. With more than one snapshot day
 *     stored it names them all and exits rather than defaulting to the latest —
 *     a second snapshot taken after the projection ran holds XBRL rows, and
 *     "restore the newest" would then restore exactly what you wanted to undo.
 *
 * ## Usage
 *
 *   # dry runs — read only, write nothing
 *   npx tsx scripts/data/snapshot-vendor-fundamentals.ts --env prod
 *   npx tsx scripts/data/snapshot-vendor-fundamentals.ts --env prod --restore
 *
 *   # writes (interactive; prompts and echoes the masked host)
 *   npx tsx scripts/data/snapshot-vendor-fundamentals.ts --env prod --apply
 *   npx tsx scripts/data/snapshot-vendor-fundamentals.ts --env prod --restore --apply
 *
 *   Options
 *     --apply            actually write (default: dry run)
 *     --restore          plan/apply the RESTORE instead of the snapshot
 *     --env <qa|prod>    fetch DATABASE_URL from GCP Secret Manager
 *     --day <YYYY-MM-DD> which snapshot day to restore (required when >1 exists)
 *
 * Run it against PROD. Both tables are REFERENCE collections in
 * `sync-prod-to-qa.sh`, so a QA snapshot is undone by the next restore down.
 */

import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";
import { execFileSync } from "child_process";

import {
  NATURAL_KEY_FIELDS,
  OUR_SOURCES,
  SNAPSHOT_COLLECTION,
  partitionVendorRows,
  planResnapshotGuard,
  planRestore,
  planSnapshot,
  reviveSnapshotRow,
  snapshotDayOf,
  type RestorePlan,
  type Row,
  type SnapshotDoc,
  type VendorCollection,
} from "./snapshot-vendor-fundamentals-logic";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, "..", "..", ".env") });

/**
 * `@usemoney/database` is imported LAZILY inside `main()`, and that is
 * load-bearing. It builds its PrismaClient at MODULE scope from
 * `process.env.DATABASE_URL`, and ESM evaluates every static import BEFORE any
 * statement in this file — including the `--env` resolution. A static import
 * would pin the client to whatever the shell exported while the confirmation
 * prompt echoed the host `--env` resolved: the operator types "yes" to one
 * database and writes to another.
 *
 * The same rule bans the `@usemoney/core/market-data` barrel, which reaches the
 * client as a VALUE through ten modules. This file imports nothing from it —
 * the only non-stdlib import above is the sibling logic module, which imports
 * nothing at all.
 *
 * Enforced by `packages/core/__tests__/market-data/ops-script-db-target.test.ts`.
 */
type PrismaLike = (typeof import("@usemoney/database"))["prisma"];
let prisma: PrismaLike | null = null;

const GCP_PROJECT = "stock-book-483718";

/** Chunk for the raw `insert` command. Well inside Mongo's 16 MB per command. */
const INSERT_CHUNK = 500;

/** Keyset page for reading a snapshot back. `$runCommandRaw` has no `getMore`. */
const READ_PAGE = 1000;

const COLLECTIONS: readonly VendorCollection[] = [
  "stock_ratios",
  "stock_financials",
];

/** Prisma model accessor per collection, so the `@@map` is never retyped here. */
const PRISMA_MODEL: Readonly<
  Record<VendorCollection, "stockRatios" | "stockFinancials">
> = {
  stock_ratios: "stockRatios",
  stock_financials: "stockFinancials",
};

/**
 * The compound-unique argument name Prisma generates from each `@@unique`.
 *
 * Derived from `NATURAL_KEY_FIELDS` rather than typed out, so the two can never
 * disagree about what the key is — which is the entire failure mode this script
 * exists to make recoverable.
 */
function whereUniqueName(collection: VendorCollection): string {
  return NATURAL_KEY_FIELDS[collection].join("_");
}

/**
 * The two model methods this script uses, and nothing else.
 *
 * `prisma.stockRatios` and `prisma.stockFinancials` have different generated
 * types, so one loop over both needs a common shape. This narrow interface is
 * that shape — reached through `as unknown as`, never `any`, so a typo in a
 * method name is still a compile error.
 */
interface VendorModel {
  findMany(args: {
    orderBy: { id: "asc" };
  }): Promise<Record<string, unknown>[]>;
  upsert(args: {
    where: Record<string, unknown>;
    create: Record<string, unknown>;
    update: Record<string, unknown>;
  }): Promise<unknown>;
}

interface Options {
  apply: boolean;
  restore: boolean;
  env: "qa" | "prod" | null;
  day: string | null;
}

/**
 * Flags this script understands. Anything else is REFUSED rather than ignored:
 * `argv.includes()` silently drops what it does not recognise, which is how a
 * sibling came to accept-and-ignore `--dry-run` alongside `--apply` (i.e. it
 * WROTE).
 */
const KNOWN_FLAGS = new Set(["--apply", "--restore", "--env", "--day"]);

function parseArgs(argv: string[]): Options {
  const unknown = argv.filter(
    (a) => a.startsWith("--") && !KNOWN_FLAGS.has(a.split("=")[0]!),
  );
  if (unknown.length > 0) {
    throw new Error(
      `Unknown flag(s): ${unknown.join(", ")}. Known: ${[...KNOWN_FLAGS].join(", ")}.`,
    );
  }
  const eq = argv.filter((a) => /^--[a-z-]+=/.test(a));
  if (eq.length > 0) {
    throw new Error(
      `Use "--flag value", not "${eq[0]}". The equals form is not parsed, and ` +
        `an unparsed --env leaves APPLY mode pointed at the ambient DATABASE_URL.`,
    );
  }

  const has = (f: string): boolean => argv.includes(f);
  const val = (f: string): string | null => {
    const i = argv.indexOf(f);
    if (i < 0) return null;
    const next = argv[i + 1];
    // A flag present with NO value is an error, not "flag absent". A trailing
    // `--env` returning null would leave APPLY mode pointed at the ambient
    // DATABASE_URL while the operator believes they named an environment.
    if (!next || next.startsWith("--")) {
      throw new Error(`${f} was given with no value`);
    }
    return next;
  };

  const env = val("--env");
  if (env !== null && env !== "qa" && env !== "prod") {
    throw new Error(`--env must be "qa" or "prod", got "${env}".`);
  }

  const day = val("--day");
  if (day !== null && !/^\d{4}-\d{2}-\d{2}$/.test(day)) {
    throw new Error(`--day must be YYYY-MM-DD, got "${day}".`);
  }

  const apply = has("--apply");
  const restore = has("--restore");

  if (day !== null && !restore) {
    throw new Error(
      "--day only means something with --restore. The snapshot always writes " +
        "today's day; refusing rather than accepting a flag that does nothing.",
    );
  }

  // Fail FAST, before reading tens of thousands of rows. `--apply` on a closed
  // stdin can never succeed, so refusing here costs nothing — and a prompt that
  // hangs at EOF exits 0, which a wrapper's `&&` reads as success.
  if (apply && !process.stdin.isTTY) {
    throw new Error(
      "--apply requires an interactive terminal: the confirmation prompt " +
        "cannot be answered when stdin is not a TTY (a pipe, </dev/null, or a " +
        "CI runner). Refusing rather than hanging.",
    );
  }

  return { apply, restore, env, day };
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
  ).trim();
  if (!out) throw new Error(`Could not read ${secret} from Secret Manager`);
  return out;
}

/**
 * Host of a Mongo URI, for display. NEVER prints any credential — `URL` keeps
 * those in `username`/`password`, never in `host`. Returns null when the host
 * cannot be determined, and callers REFUSE to prompt rather than showing a
 * placeholder the operator cannot check.
 */
function maskedHost(uri: string): string | null {
  try {
    return new URL(uri).host || null;
  } catch {
    // mongodb+srv with a comma-separated host list is not a legal URL. Take the
    // authority after the LAST `@` that precedes the first `/`, so an
    // un-encoded `@` in a password cannot leak the password tail.
    const authority = uri.replace(/^[a-z+]+:\/\//i, "").split("/")[0] ?? "";
    const at = authority.lastIndexOf("@");
    return (at >= 0 ? authority.slice(at + 1) : authority).trim() || null;
  }
}

async function confirmWrite(
  uri: string,
  envLabel: string,
  change: string,
): Promise<void> {
  const host = maskedHost(uri);
  if (!host) {
    console.error(
      "\n  Refusing to write: could not determine the target host from " +
        "DATABASE_URL.\n  The prompt exists so you can SEE what you are about " +
        "to hit.\n",
    );
    process.exit(1);
  }
  // A closed / non-interactive stdin must ABORT, not hang: the callback can
  // never fire at EOF, `main()` never settles, and node exits 0 having written
  // nothing — which a wrapper's `&&` reads as "step completed".
  if (!process.stdin.isTTY) {
    console.error(
      "\n  Refusing to write: stdin is not a TTY, so the confirmation cannot " +
        "be answered. This script is deliberately interactive.\n",
    );
    process.exit(1);
  }
  process.stdout.write(
    `\n!!  This will WRITE to a database.\n` +
      `      target : ${host}\n` +
      `      source : ${envLabel}\n` +
      `      change : ${change}\n` +
      `   Type 'yes' to continue: `,
  );
  const answer = await new Promise<string>((resolve) => {
    process.stdin.once("data", (d) => resolve(String(d).trim()));
  });
  if (answer !== "yes") {
    // Non-zero: an abort is NOT success. With exit(0) a wrapper's `&&` reads
    // "the operator said no" as "step completed".
    console.log("Aborted.");
    process.exit(1);
  }
}

/** A raw Mongo command / filter / document, as `$runCommandRaw` speaks it. */
type RawDoc = Record<string, unknown>;
type RawCommandRunner = (command: RawDoc) => Promise<RawDoc>;

/** Read one collection's whole snapshot for a day, keyset-paged on `_id`. */
async function readSnapshot(
  run: RawCommandRunner,
  collection: VendorCollection,
  day: string,
): Promise<SnapshotDoc[]> {
  const out: SnapshotDoc[] = [];
  let lastId: string | null = null;
  for (;;) {
    // A raw `find` returns only `cursor.firstBatch` and this script issues no
    // `getMore`, so the page cursor is the mechanism rather than an
    // optimisation: without it a 32,359-row snapshot comes back truncated and
    // reads as a SMALLER restore plan, not as an error (MONEY-1189). The `_id`
    // is a deterministic STRING, which is what makes `$gt` paging safe here
    // without an extended-JSON `{$oid}` round trip.
    //
    // ── TWO THINGS CAP `firstBatch`, AND `limit` IS NEITHER OF THEM ────────
    //
    // Measured against a local mongo:7, 2,500 docs, this exact command shape:
    //
    //   find + sort + limit: 1000, no batchSize   ->  firstBatch  101
    //   the same + batchSize: 1000                ->  firstBatch 1000
    //
    // `batchSize` DEFAULTS TO 101 and `limit` does not raise it, so the shipped
    // command returned 101 rows and then stopped, because 101 < READ_PAGE read
    // as "exhausted". `readSnapshot` returned 101 of 2,500 in that measurement
    // — one round trip, for every caller, always.
    //
    // AND `batchSize` ALONE IS NOT THE FIX. The second cap is the 16 MB wire
    // limit, which truncates a page regardless: measured on 300 docs of ~200 KB,
    // `batchSize: 1000` still returned 83. So a SHORT page never means
    // "exhausted"; only an EMPTY one does. Same conclusion, same class, same
    // ticket as `quarantine-html-stock-documents.ts:1004` and
    // `recover-html-stock-documents.ts:533`, whose loops break on `=== 0` for
    // exactly this reason. Cost of the extra round trip: one empty page per
    // collection per run.
    //
    // `limit` STAYS, beside `batchSize`. With the two equal the server knows the
    // cursor is done and returns `cursor.id: 0` (measured), so nothing is left
    // open server-side — this script never issues `killCursors`.
    const res = (await run({
      find: SNAPSHOT_COLLECTION[collection],
      filter: {
        snapshotDay: day,
        ...(lastId !== null ? { _id: { $gt: lastId } } : {}),
      },
      sort: { _id: 1 },
      limit: READ_PAGE,
      batchSize: READ_PAGE,
    })) as { cursor?: { firstBatch?: SnapshotDoc[] } };
    const batch = res.cursor?.firstBatch ?? [];
    out.push(...batch);
    if (batch.length === 0) return out;
    lastId = batch[batch.length - 1]!._id;
  }
}

type DayCounts = Record<VendorCollection, number>;

/** Which snapshot days exist, with per-collection counts. */
async function snapshotDays(
  run: RawCommandRunner,
): Promise<Map<string, DayCounts>> {
  const days = new Map<string, DayCounts>();
  for (const collection of COLLECTIONS) {
    // `cursor: {}` is the 101-document default, same cap as the `find` above —
    // one row per distinct day here, so it fails SAFE today (a truncated day is
    // reported "no snapshot stored", never restored from). Raised anyway rather
    // than left as the one un-fixed instance of the class in this file.
    const res = (await run({
      aggregate: SNAPSHOT_COLLECTION[collection],
      pipeline: [{ $group: { _id: "$snapshotDay", n: { $sum: 1 } } }],
      cursor: { batchSize: READ_PAGE },
    })) as { cursor?: { firstBatch?: Array<{ _id: string; n: number }> } };
    for (const g of res.cursor?.firstBatch ?? []) {
      const entry = days.get(g._id) ?? { stock_ratios: 0, stock_financials: 0 };
      entry[collection] = g.n;
      days.set(g._id, entry);
    }
  }
  return days;
}

/**
 * `readSnapshot` returned EVERYTHING that is stored — MONEY-1401 F7 review.
 *
 * ## The oracle was already two lines away and nothing used it
 *
 * {@link snapshotDays} returns per-day, per-collection counts from a `$group`,
 * and `runRestore` reads them purely to pick a day. Nothing compared
 * `docs.length` to the count, so a truncated read — the exact failure the
 * keyset paging in {@link readSnapshot} was written for, and the failure its
 * own comment measures at 101 of 2,500 — still produced a SMALLER restore plan
 * that applied cleanly and printed `N row(s) restored`. Success over a subset.
 *
 * The same gap on the write side: `planResnapshotGuard` compares what
 * `readSnapshot` returned, while the `delete` that follows is scoped to the
 * WHOLE day. A short read there means the guard inspects a prefix and the
 * delete removes the rest.
 *
 * A RUNTIME assertion, not a source scan, and that is the point: it fails
 * whatever shape the paging loop is written in — including the two rewrites
 * that leave the existing scan green (`out.length >= 101` as an exhaustion
 * test, or the `_id` sort flipped). The loop is the mechanism; this is the
 * check on the mechanism.
 */
function assertReadComplete(
  what: string,
  collection: VendorCollection,
  day: string,
  got: number,
  expected: number,
): void {
  if (got === expected) return;
  throw new Error(
    `${what}: read ${got} ${collection} row(s) for snapshot day ${day} but ` +
      `${expected} are stored. A SHORT READ is not a smaller plan — it is a ` +
      `truncated one, and acting on it would ${
        what === "restore"
          ? `restore a SUBSET and report success`
          : `compare a PREFIX against a delete scoped to the whole day`
      }. See readSnapshot's paging notes: a raw \`find\` caps \`firstBatch\` at ` +
      `\`batchSize\` AND at the 16 MB wire limit, so a short page never means ` +
      `exhausted.`,
  );
}

function sample(docs: readonly SnapshotDoc[], n: number): string {
  return docs
    .slice(0, n)
    .map((d) => `      ${Object.values(d.key).join(" / ")}`)
    .join("\n");
}

async function runSnapshot(
  db: PrismaLike,
  run: RawCommandRunner,
  opts: Options,
  uri: string,
  envLabel: string,
): Promise<void> {
  const snapshotAt = new Date();
  const day = snapshotDayOf(snapshotAt);
  const plans = new Map<VendorCollection, SnapshotDoc[]>();
  // Read ONCE, before the loop and before any write — the oracle for
  // `assertReadComplete` below, and nothing in this function changes it.
  const storedCounts = (await snapshotDays(run)).get(day);

  for (const collection of COLLECTIONS) {
    const rows = (await (
      db[PRISMA_MODEL[collection]] as unknown as VendorModel
    ).findMany({ orderBy: { id: "asc" } })) as Row[];
    // ── A VENDOR SNAPSHOT IS OF THE VENDOR'S ROWS — MONEY-1401 F7 ──────────
    //
    // The read had no `source` filter at all, so in an environment where the
    // projection has already been armed this stored OUR OWN rows under a name
    // that says vendor — and a later restore would put them back, refusing
    // nothing and reporting success. Filtered in JS rather than in the query;
    // see `partitionVendorRows` for why a Prisma `not` is the wrong tool here.
    const { vendor, ours } = partitionVendorRows(rows);
    const docs = planSnapshot(vendor, { collection, snapshotAt });
    plans.set(collection, docs);
    console.log(
      `  ${collection.padEnd(17)} ${String(vendor.length).padStart(6)} vendor ` +
        `row(s) of ${rows.length} -> ${SNAPSHOT_COLLECTION[collection]}   ` +
        `key: ${NATURAL_KEY_FIELDS[collection].join("+")}`,
    );
    if (ours.length > 0) {
      console.log(
        `    ${ours.length} row(s) EXCLUDED — already stamped by us ` +
          `(${[...OUR_SOURCES].join(" / ")}). This environment has been ARMED; ` +
          `the vendor values those rows replaced are already gone.`,
      );
    }
    if (docs.length > 0) console.log(sample(docs, 3));

    // ── AND A SAME-DAY RE-RUN MAY NOT REPLACE A DIFFERENT SNAPSHOT — F7 ────
    //
    // `snapshotDay` is a UTC day and IST 05:30-00:00 is one UTC day, so
    // "snapshot, arm, run the job, re-snapshot to check" is ONE day and used to
    // delete the vendor documents and store the XBRL rows over them. Checked in
    // DRY RUN too: a rehearsal that hides the refusal is not a rehearsal.
    const stored = await readSnapshot(run, collection, day);
    // The guard below compares `stored` against the new plan, and the `delete`
    // further down is scoped to the WHOLE day — so a short read here inspects a
    // prefix and then removes the rest. See `assertReadComplete`.
    assertReadComplete(
      "re-snapshot guard",
      collection,
      day,
      stored.length,
      storedCounts?.[collection] ?? 0,
    );
    const guard = planResnapshotGuard(stored, docs);
    if (guard.refuse) {
      const shown = guard.conflicts
        .slice(0, 5)
        .map(
          (c) =>
            `      ${c.key}\n        stored ${c.stored} -> now ${c.current}`,
        )
        .join("\n");
      throw new Error(
        `REFUSING to replace the snapshot already stored for day ${day}: ` +
          `${guard.conflicts.length} of ${stored.length} stored ` +
          `${collection} row(s) have since been overwritten by a different ` +
          `source.\n${shown}\n` +
          (guard.conflicts.length > 5
            ? `      … ${guard.conflicts.length - 5} more\n`
            : "") +
          `  That snapshot is the ONLY copy of those vendor values — neither ` +
          `table carries \`source\` in its unique key, so the rows it holds no ` +
          `longer exist anywhere else. Replacing it would store what you are ` +
          `trying to be able to undo.\n` +
          `  If you meant to snapshot the CURRENT state, do it under a ` +
          `different day, or restore first (--restore --day ${day}).`,
      );
    }
  }

  const total = [...plans.values()].reduce((a, d) => a + d.length, 0);
  if (!opts.apply) {
    console.log(
      `\n  DRY RUN — nothing written. --apply would store ${total} row(s) ` +
        `under day ${day}, replacing that day if it is already there.\n`,
    );
    return;
  }

  await confirmWrite(
    uri,
    envLabel,
    `snapshot ${total} vendor row(s) into the two *_vendor_snapshot ` +
      `collections under day ${day} (replacing that day if present)`,
  );

  for (const collection of COLLECTIONS) {
    const docs = plans.get(collection) ?? [];
    const target = SNAPSHOT_COLLECTION[collection];
    // Replace the day, never append to it. `limit: 0` means "all matching".
    const del = (await run({
      delete: target,
      deletes: [{ q: { snapshotDay: day }, limit: 0 }],
    })) as { n?: number };
    let written = 0;
    for (let i = 0; i < docs.length; i += INSERT_CHUNK) {
      const chunk = docs.slice(i, i + INSERT_CHUNK);
      await run({ insert: target, documents: chunk as unknown as RawDoc[] });
      written += chunk.length;
      process.stdout.write(`\r  ${target}: ${written}/${docs.length}   `);
    }
    console.log(
      `\r  ${target}: ${written} written (${del.n ?? 0} stale row(s) for day ` +
        `${day} removed first)   `,
    );
  }
}

async function runRestore(
  db: PrismaLike,
  run: RawCommandRunner,
  opts: Options,
  uri: string,
  envLabel: string,
): Promise<void> {
  const days = await snapshotDays(run);
  if (days.size === 0) {
    throw new Error(
      "No snapshot to restore from — the *_vendor_snapshot collections are " +
        "empty. Run without --restore first.",
    );
  }

  let day: string;
  if (opts.day !== null) {
    if (!days.has(opts.day)) {
      throw new Error(
        `No snapshot stored for day ${opts.day}. Stored: ` +
          `${[...days.keys()].sort().join(", ")}`,
      );
    }
    day = opts.day;
  } else if (days.size > 1) {
    const listed = [...days.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(
        ([d, c]) =>
          `      ${d}  ratios ${c.stock_ratios}, financials ${c.stock_financials}`,
      )
      .join("\n");
    throw new Error(
      `More than one snapshot day is stored. Name one with --day:\n${listed}\n` +
        `  Refusing to default to the newest: a snapshot taken AFTER the ` +
        `projection ran holds XBRL rows, so "newest" would restore exactly ` +
        `what you are trying to undo.`,
    );
  } else {
    day = [...days.keys()][0]!;
  }
  console.log(`  restoring from snapshot day ${day}\n`);

  const plans = new Map<VendorCollection, RestorePlan>();
  for (const collection of COLLECTIONS) {
    const docs = await readSnapshot(run, collection, day);
    // `days` is the `$group` count for this very day and collection — the
    // oracle, already in hand and previously used only to pick the day. See
    // `assertReadComplete`: a truncated read restores a SUBSET and prints
    // "N row(s) restored".
    assertReadComplete(
      "restore",
      collection,
      day,
      docs.length,
      days.get(day)?.[collection] ?? 0,
    );

    // ── A RESTORE MUST CHECK WHAT IT IS RESTORING — MONEY-1401 F7, read side ──
    //
    // `partitionVendorRows` was added to the WRITER in this ticket. The snapshot
    // collections are durable data that outlives it: a day stored by any earlier
    // run — including one taken deliberately after arming, which the writer's
    // own same-day guard now names as a legitimate thing to do under a DIFFERENT
    // day — can hold `NSE_XBRL` rows. Restoring those puts OUR OWN values back
    // into `stock_ratios` / `stock_financials` and prints "restored", which is
    // the exact failure the vendor-side exclusion exists to prevent, reached
    // from the other end. `runRestore`'s only guard was `days.size > 1`, and one
    // tainted day is still one day.
    //
    // REFUSE, rather than restore the vendor part and skip the rest. A half-
    // applied restore leaves the tables in a state that is neither the snapshot
    // nor the present, with nothing on the rows to say which columns came from
    // where — and this script's whole promise is that the switchover is
    // undoable in one command.
    //
    // Reuses `partitionVendorRows` rather than re-testing `OUR_SOURCES` here:
    // the polarity ("ours" is the closed list, an unknown source is a vendor) is
    // one decision and must have one implementation. It returns the same object
    // references it was given, which is what the identity Set below relies on.
    const { ours } = partitionVendorRows(docs.map((d) => d.row));
    if (ours.length > 0) {
      const ourRows = new Set<unknown>(ours);
      const tainted = docs.filter((d) => ourRows.has(d.row));
      const shown = tainted
        .slice(0, 5)
        .map(
          (d) =>
            `      ${Object.values(d.key).join(" / ")}  ${String(d.row["source"])}`,
        )
        .join("\n");
      throw new Error(
        `REFUSING to restore snapshot day ${day}: ${tainted.length} of ` +
          `${docs.length} stored ${collection} row(s) are OURS ` +
          `(${[...OUR_SOURCES].join(" / ")}), not the vendor's.\n${shown}\n` +
          (tainted.length > 5 ? `      … ${tainted.length - 5} more\n` : "") +
          `  This day was stored by a run that predates the vendor-row ` +
          `exclusion, or was taken after the projection had already been armed. ` +
          `Restoring it would write our own values back under a command that ` +
          `says it restores the vendor's, and report success.\n` +
          `  Name a day whose rows are the vendor's with --day <YYYY-MM-DD>. ` +
          `If there is no such day, there is nothing to restore: neither table ` +
          `carries \`source\` in its unique key, so the vendor values these ` +
          `rows replaced no longer exist anywhere.`,
      );
    }

    const current = (await (
      db[PRISMA_MODEL[collection]] as unknown as VendorModel
    ).findMany({ orderBy: { id: "asc" } })) as Row[];
    const plan = planRestore(docs, current);
    plans.set(collection, plan);
    console.log(
      `  ${collection.padEnd(17)} snapshot ${String(docs.length).padStart(6)} ` +
        `-> replace ${plan.replace.length}, insert ${plan.insert.length}, ` +
        `unchanged ${plan.unchanged}`,
    );
    if (plan.replace.length > 0) {
      console.log("    would REPLACE:");
      console.log(sample(plan.replace, 3));
    }
    if (plan.insert.length > 0) {
      console.log("    would INSERT (row deleted since the snapshot):");
      console.log(sample(plan.insert, 3));
    }
  }

  const touched = [...plans.values()].reduce(
    (a, p) => a + p.replace.length + p.insert.length,
    0,
  );
  if (!opts.apply) {
    console.log(
      `\n  DRY RUN — nothing written. --apply would write ${touched} row(s).\n`,
    );
    return;
  }

  await confirmWrite(
    uri,
    envLabel,
    `restore ${touched} row(s) from snapshot day ${day}, overwriting whatever ` +
      `stock_ratios / stock_financials hold now`,
  );

  for (const collection of COLLECTIONS) {
    const plan = plans.get(collection)!;
    const model = db[PRISMA_MODEL[collection]] as unknown as VendorModel;
    const argName = whereUniqueName(collection);
    const work = [...plan.replace, ...plan.insert];
    let done = 0;
    for (const doc of work) {
      const row = reviveSnapshotRow(doc);
      // `id` is the Mongo `_id` and is immutable, so an UPDATE must not carry
      // it — the natural key is what addresses the row. The CREATE branch keeps
      // it, which puts a deleted row back at its original `_id` and therefore
      // keeps every reference to it intact.
      const { id: _id, ...updatable } = row;
      await model.upsert({
        where: { [argName]: doc.key },
        create: row,
        update: updatable,
      });
      done += 1;
      process.stdout.write(`\r  ${collection}: ${done}/${work.length}   `);
    }
    console.log(`\r  ${collection}: ${done} row(s) restored   `);
  }
}

async function main(): Promise<void> {
  const opts = parseArgs(process.argv.slice(2));

  const envLabel = opts.env ? `--env ${opts.env}` : "ambient DATABASE_URL";
  if (opts.env) process.env.DATABASE_URL = databaseUrlForEnv(opts.env);
  const uri = process.env.DATABASE_URL;
  if (!uri) {
    throw new Error(
      "No DATABASE_URL. Pass --env qa|prod, or export DATABASE_URL yourself.",
    );
  }

  // DEFERRED — see the note at the top of the file.
  const db = (await import("@usemoney/database")).prisma;
  prisma = db;

  const run: RawCommandRunner = (command) =>
    db.$runCommandRaw(
      command as Parameters<typeof db.$runCommandRaw>[0],
    ) as unknown as Promise<RawDoc>;

  console.log(
    `\nvendor fundamentals ${opts.restore ? "RESTORE" : "SNAPSHOT"} — ` +
      `${opts.apply ? "APPLY" : "DRY RUN"}\n` +
      `  target : ${maskedHost(uri) ?? "<unknown host>"}\n` +
      `  source : ${envLabel}\n`,
  );

  if (opts.restore) await runRestore(db, run, opts, uri, envLabel);
  else await runSnapshot(db, run, opts, uri, envLabel);
}

main()
  .catch((err) => {
    console.error("\nFailed:", err instanceof Error ? err.message : err);
    process.exitCode = 1;
  })
  .finally(async () => {
    // May be null if we failed before the lazy import (e.g. a bad --env).
    await prisma?.$disconnect();
    process.exit(process.exitCode ?? 0);
  });
