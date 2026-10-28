/**
 * Re-map OFF-TAXONOMY sector values onto the canonical 13  (MONEY-1302)
 * ==========================================================================
 *
 * The generalisation of `resector-real-estate.ts`. That script moved rows into
 * ONE hard-coded target using a free-text `industry` matcher; this one moves
 * rows wherever `YAHOO_TO_NSE_MAP` says they belong, and has no matcher of its
 * own at all. The taxonomy is the decision — the script only carries it out.
 *
 * ## Why any of this is needed
 *
 * Editing `YAHOO_TO_NSE_MAP` only affects FUTURE writes. Existing rows never
 * re-bucket themselves: `sector-enrichment.ts` selects only rows whose sector
 * is null/empty, so a row already stored as "Media & Entertainment" is
 * permanently excluded from re-enrichment. Measured on prod 2026-08-30, 101
 * active rows sat outside `NSE_SECTORS`.
 *
 * ## What it will NOT do, and why that is most of the value
 *
 * 1. **It never invents a mapping.** A raw value that `toWritableNseSector`
 *    does not resolve is REPORTED under UNMAPPED and left exactly as it is.
 *    The fix for an unmapped value is a reviewed alias in `sector-taxonomy.ts`,
 *    not a heuristic here. `Other` (29 prod rows) is the live example.
 *
 * 2. **It does not re-sector rows that are not equities.** This is the finding
 *    that reshaped the ticket. 57 of those 101 rows are DEBT wearing
 *    `instrumentType: "EQUITY"` — 30 NHAI tax-free bonds under `Construction`,
 *    a Gujarat SDL and 25 debentures under `Other`, a National Fertilizers bond
 *    under `Chemicals`. They are recognisable in the data rather than by
 *    eye: every one is a BSE row whose group letter is still the stamped
 *    default "EQ" and which carries no ISIN, i.e. a row the BSE scrip master
 *    has never sourced, and `classifyCashInstrument` abstains on all of them
 *    (`bse-group-unrecognised-EQ`).
 *
 *    So the write plan includes ONLY rows the classifier positively confirms as
 *    EQUITY / REIT / INVIT. Abstentions are excluded by default. That is the
 *    same fail-safe direction `sector-write-guard.ts` argues for: failing to
 *    write a sector is recoverable, writing one onto a bond is not — the
 *    nightly DEBT retype clears sectors only on rows still typed EQUITY, so
 *    anything written back afterwards is permanent.
 *
 * 3. **It does not trust itself silently.** The dry run prints every affected
 *    row — symbol, name, current sector, classifier verdict, target — grouped
 *    by raw value, because the only way to know a re-map is right is for a
 *    human to read the company names under it. That is the lesson
 *    `resector-real-estate.ts` records after a plausible bond regex hit 2,236
 *    wrong rows.
 *
 * Reversibility: a rollback snapshot of every (id, sector) it overwrites is
 * written BEFORE any write, into `scripts/data/rollbacks/`.
 *
 * Usage (dry run is the default — it writes nothing without `--apply`):
 *   yarn data:resector-noncanonical                      # ambient DATABASE_URL
 *   yarn data:resector-noncanonical --env prod           # dry run vs prod
 *   yarn data:resector-noncanonical --env prod --apply   # WRITES (always prompts)
 *
 * Direct invocation, equivalent:
 *   npx tsx scripts/data/resector-noncanonical.ts --env qa
 *
 * Flags:
 *   --apply                  actually write (default: dry run). Always prompts.
 *   --env qa|prod            read DATABASE_URL from Secret Manager
 *   --limit N                cap the rows considered (dry run only)
 *   --only VALUE             restrict to rows whose stored sector is VALUE
 *   --include-unclassified   ALSO write rows the classifier abstains on.
 *                            Dangerous — read guarantee 2 above first.
 */

import { execFileSync } from "child_process";
import dotenv from "dotenv";
import { fileURLToPath } from "url";
import { createInterface } from "readline";
import { writeFileSync, renameSync, readFileSync, mkdirSync } from "fs";
import path from "path";

// NARROW subpaths, never the `/market-data` barrel. The barrel re-exports
// `syncInstruments`, which imports `@usemoney/database`, whose PrismaClient is
// built at module scope from `process.env.DATABASE_URL` — importing it
// statically would pin the client before `--env` resolves and defeat the
// `await import()` below. Both modules here are leaves.
import {
  NSE_SECTORS,
  toWritableNseSector,
} from "@usemoney/core/sector-taxonomy";
import { classifyCashInstrument } from "@usemoney/core/market-data/instrument-classification";

// Load the repo `.env`, exactly as the sibling scripts do — otherwise the
// `yarn data:*` family resolves DATABASE_URL differently from one shell to the
// next, which the README's phrase "ambient DATABASE_URL" hides.
dotenv.config({
  path: path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    "..",
    "..",
    ".env",
  ),
});

const GCP_PROJECT = "stock-book-483718";

/**
 * Types that may carry a sector — mirrors `SECTOR_BEARING_TYPES` in
 * `packages/core/src/market-data/instruments/sector-write-guard.ts`. Copied
 * rather than imported because that module has no package export; if it gains
 * one, import it instead of maintaining a second list.
 */
const SECTOR_BEARING = ["EQUITY", "REIT", "INVIT"] as const;

interface Options {
  apply: boolean;
  env: "qa" | "prod" | null;
  limit: number | null;
  only: string | null;
  includeUnclassified: boolean;
}

/**
 * Flags this script understands. Anything else is REFUSED rather than ignored.
 * `argv.includes(...)` silently drops what it does not recognise, which in the
 * sibling scripts turned typos into destructive defaults — `--apply --dry-run`
 * WROTE, and `--env=prod` left APPLY pointed at the ambient DATABASE_URL.
 */
const KNOWN_FLAGS = new Set(
  "--apply,--env,--limit,--only,--include-unclassified".split(","),
);

function assertKnownFlags(argv: string[]): void {
  const unknown = argv.filter(
    (a) => a.startsWith("--") && !KNOWN_FLAGS.has(a.split("=")[0]!),
  );
  if (unknown.length > 0) {
    throw new Error(
      `Unknown flag(s): ${unknown.join(", ")}. Known: ` +
        `${[...KNOWN_FLAGS].join(", ")}. Refusing to run rather than ` +
        `silently ignoring an option you believed was in effect.`,
    );
  }
  const eq = argv.filter((a) => /^--[a-z-]+=/.test(a));
  if (eq.length > 0) {
    throw new Error(
      `Use "--flag value", not "${eq[0]}". The equals form is not parsed, and ` +
        `an unparsed --env would leave APPLY mode pointed at the ambient ` +
        `DATABASE_URL.`,
    );
  }
}

function parseArgs(argv: string[]): Options {
  assertKnownFlags(argv);
  const has = (f: string) => argv.includes(f);
  const val = (f: string): string | null => {
    const i = argv.indexOf(f);
    if (i < 0) return null;
    const next = argv[i + 1];
    // A flag present with NO value is an error, not "flag absent" — a trailing
    // `--limit` used to mean "no limit", i.e. every row.
    if (!next || next.startsWith("--")) {
      throw new Error(`${f} was given with no value`);
    }
    return next;
  };

  const env = val("--env");
  if (env && env !== "qa" && env !== "prod") {
    throw new Error(`--env must be "qa" or "prod", got "${env}"`);
  }

  const limitRaw = val("--limit");
  let limit: number | null = null;
  if (limitRaw !== null) {
    const n = Number(limitRaw);
    if (!Number.isFinite(n) || !Number.isInteger(n) || n <= 0) {
      throw new Error(
        `--limit must be a positive integer, got "${limitRaw}". Refusing to ` +
          `run rather than silently processing every row.`,
      );
    }
    limit = n;
  }

  const apply = has("--apply");

  // `--limit` caps an `orderBy: id asc` prefix, which is a biased slice and not
  // a sample. Applying over one would write a prefix while the report describes
  // it as the whole population.
  if (apply && limit !== null) {
    throw new Error(
      "--limit cannot be combined with --apply: the limit is applied to an " +
        "id-ordered prefix, not a sample, so the plan you reviewed would not " +
        "be the population. Use --limit for the dry run, then --apply without it.",
    );
  }

  // Fail FAST on non-interactive stdin, before touching the database. A hung
  // prompt exits 0, which a wrapper's `&&` reads as success.
  if (apply && !process.stdin.isTTY) {
    throw new Error(
      "--apply requires an interactive terminal: the confirmation prompt " +
        "cannot be answered when stdin is not a TTY (a pipe, </dev/null, or a " +
        "CI runner). Refusing rather than hanging.",
    );
  }

  return {
    apply,
    env: (env as "qa" | "prod" | null) ?? null,
    limit,
    only: val("--only"),
    includeUnclassified: has("--include-unclassified"),
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
  ).trim();
  if (!out) throw new Error(`Could not read ${secret} from Secret Manager`);
  return out;
}

/**
 * Host of a Mongo URI, for display. Never prints any credential — parsed with
 * `new URL()` rather than a regex, because the regex form leaked a password
 * tail for un-encoded `@` and showed nothing at all for credential-less URIs.
 * Returns null when the host cannot be determined; callers then REFUSE to
 * prompt rather than showing a placeholder.
 */
function maskedHost(uri: string): string | null {
  try {
    const u = new URL(uri);
    return u.host || null;
  } catch {
    // mongodb+srv with a comma-separated host list is not a legal URL.
    const withoutScheme = uri.replace(/^[a-z+]+:\/\//i, "");
    const authority = withoutScheme.split("/")[0] ?? "";
    const at = authority.lastIndexOf("@");
    const host = at >= 0 ? authority.slice(at + 1) : authority;
    return host.trim() || null;
  }
}

/**
 * Confirm before ANY write, whichever database is targeted, and echo the host.
 * Keyed on the WRITE, never on a flag: the `DATABASE_URL=... --apply` form has
 * no `--env`, so an `--env`-keyed check would wave through exactly the
 * invocation most likely to be pointed at prod by accident.
 */
async function confirmWrite(uri: string, envLabel: string): Promise<void> {
  const host = maskedHost(uri);
  if (!host) {
    console.error(
      "\n  Refusing to write: could not determine the target host from " +
        "DATABASE_URL.\n  Fix the connection string so the prompt can show " +
        "you what you are hitting.\n",
    );
    process.exit(1);
  }
  if (!process.stdin.isTTY) {
    console.error(
      "\n  Refusing to write: stdin is not a TTY, so the confirmation cannot " +
        "be answered.\n  This script is deliberately interactive — run it from " +
        "a terminal.\n",
    );
    process.exit(1);
  }
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const answer = await new Promise<string>((resolve) => {
    rl.question(
      `\n  About to WRITE to ${host} (${envLabel}).\n` +
        `  Type "yes" to continue: `,
      resolve,
    );
  });
  rl.close();
  if (answer.trim() !== "yes") {
    console.log("\n  Aborted — nothing written.\n");
    process.exit(1);
  }
}

/**
 * Rewrite the rollback artefact mid-run so it states what has ACTUALLY been
 * written. See the twin in `reclassify-instruments.ts`: chunked writes have no
 * transaction, so a throw mid-loop used to leave rows written under a file that
 * still said "staged". Failures here are swallowed deliberately — losing
 * progress metadata must never abort a run that is mid-write.
 */
function recordProgress(
  artefactPath: string,
  written: number,
  writtenIds: readonly string[],
): void {
  try {
    const snap = JSON.parse(readFileSync(artefactPath, "utf8")) as Record<
      string,
      unknown
    >;
    snap.status = "applying";
    snap.appliedRows = written;
    snap.writtenIds = [...writtenIds];
    snap.lastProgressAt = new Date().toISOString();
    writeFileSync(artefactPath, JSON.stringify(snap, null, 2), "utf8");
  } catch {
    /* best-effort; never abort a live write for metadata */
  }
}

interface Row {
  id: string;
  symbol: string;
  exchange: string;
  name: string;
  sector: string | null;
  industry: string | null;
  series: string | null;
  isin: string | null;
  /**
   * SELECTED, and it was not.
   *
   * `classifyCashInstrument` receives this row directly, and its INDEX rule is
   * deliberately not gated on the stamped default — a segment of `INDICES` is
   * the exchange naming an index outright. So leaving the column out of the
   * projection did not fall back to an abstention, it changed the verdict:
   *
   *   {symbol:"NIFTY 50", exchange:"NSE", series:"EQ", isin:null}
   *     without segmentCode -> EQUITY / nse-series-EQ
   *     with    segmentCode -> INDEX  / segment-indices
   *
   * and EQUITY is in `SECTOR_BEARING`, so this script would mark each of the
   * 213 live index rows WRITE for a sector.
   */
  segmentCode: string | null;
  instrumentType: string;
}

interface Planned extends Row {
  target: string;
  klass: string;
  reason: string;
}

async function main(): Promise<void> {
  const opts = parseArgs(process.argv.slice(2));

  if (opts.env) process.env.DATABASE_URL = databaseUrlForEnv(opts.env);
  const uri = process.env.DATABASE_URL;
  if (!uri) {
    throw new Error(
      "No DATABASE_URL. Pass --env qa|prod, or set DATABASE_URL yourself.",
    );
  }

  // Imported AFTER DATABASE_URL is resolved — PrismaClient is built at module
  // scope from the env var, so a static import would pin the wrong database.
  const { prisma } = await import("@usemoney/database");

  console.log(
    `\n  Non-canonical sector re-map — ${opts.apply ? "APPLY" : "DRY RUN"}`,
  );
  console.log(`  Target: ${maskedHost(uri) ?? "unknown"}`);
  console.log(`  Canonical sectors: ${Object.keys(NSE_SECTORS).length}\n`);

  const canonical = new Set(Object.keys(NSE_SECTORS));

  // Every ACTIVE row with a sector set. The non-canonical filter is applied in
  // JS rather than in Mongo: `notIn` over a 13-element list would also have to
  // reason about absent fields and casing, and the population here is small
  // enough (~20k rows, one indexed collection) that filtering in memory is both
  // cheaper to read and impossible to get subtly wrong.
  const all = (await prisma.instrumentMapping.findMany({
    // `isSet` as well as `not: null` — MONEY-1236. In Prisma+Mongo a bare
    // `NOT: { sector: null }` reasons only about rows where the KEY EXISTS and
    // holds null; a row whose `sector` was never written is a different state,
    // and this collection has plenty (the enricher only ever writes the field
    // it resolves). Without the `isSet` arm the population silently excludes
    // them — the same absent-vs-null trap as MONEY-1050 / 1234 / 1235.
    where: { isActive: true, sector: { not: null, isSet: true } },
    select: {
      id: true,
      symbol: true,
      exchange: true,
      name: true,
      sector: true,
      industry: true,
      series: true,
      isin: true,
      segmentCode: true,
      instrumentType: true,
    },
    orderBy: { id: "asc" },
    ...(opts.limit ? { take: opts.limit } : {}),
  })) as Row[];

  const offTaxonomy = all.filter(
    (r) =>
      r.sector !== null &&
      r.sector !== "" &&
      r.sector !== "N/A" &&
      !canonical.has(r.sector) &&
      (opts.only === null || r.sector === opts.only),
  );

  console.log(
    `  Rows scanned: ${all.length}   off-taxonomy: ${offTaxonomy.length}\n`,
  );
  if (offTaxonomy.length === 0) {
    console.log("  Nothing to do.\n");
    await prisma.$disconnect();
    return;
  }

  // Bucket by the RAW stored value — the unit a mapping decision is made in.
  const buckets = new Map<string, Row[]>();
  for (const r of offTaxonomy) {
    const list = buckets.get(r.sector!) ?? [];
    list.push(r);
    buckets.set(r.sector!, list);
  }

  const planned: Planned[] = [];
  const unmapped: Array<{ value: string; rows: Row[] }> = [];
  const abstained: Planned[] = [];

  for (const [raw, rows] of [...buckets.entries()].sort(
    (a, b) => b[1].length - a[1].length,
  )) {
    // THE decision, and the only one — the same guard the enrichment writer
    // uses, so what this script may write and what the enricher may write can
    // never diverge.
    const target = toWritableNseSector(raw);

    if (target === null) {
      unmapped.push({ value: raw, rows });
      console.log(`  ##  "${raw}"  (${rows.length})  ->  UNMAPPED — untouched`);
      for (const r of rows) {
        const c = classifyCashInstrument(r);
        console.log(
          `        ${r.symbol.padEnd(12)} ${r.exchange.padEnd(3)} ` +
            `${c.klass.padEnd(7)} isin=${(r.isin ?? "-").padEnd(13)} | ${r.name.slice(0, 44)}`,
        );
      }
      console.log("");
      continue;
    }

    console.log(`  ##  "${raw}"  (${rows.length})  ->  "${target}"`);
    for (const r of rows) {
      const c = classifyCashInstrument(r);
      const eligible =
        (SECTOR_BEARING as readonly string[]).includes(c.klass) ||
        (opts.includeUnclassified && c.klass === "UNKNOWN");
      const entry: Planned = { ...r, target, klass: c.klass, reason: c.reason };
      if (eligible) planned.push(entry);
      else abstained.push(entry);
      console.log(
        `      ${eligible ? "WRITE " : "SKIP  "} ${r.symbol.padEnd(12)} ` +
          `${r.exchange.padEnd(3)} ${c.klass.padEnd(7)} (${c.reason}) ` +
          `isin=${(r.isin ?? "-").padEnd(13)} | ${r.name.slice(0, 40)}`,
      );
    }
    console.log("");
  }

  console.log(`  ── Summary ──────────────────────────────────────────────`);
  console.log(`  Off-taxonomy rows        : ${offTaxonomy.length}`);
  console.log(`  Planned rewrites         : ${planned.length}`);
  console.log(
    `  Skipped (not confirmed equity): ${abstained.length}` +
      (abstained.length > 0 && !opts.includeUnclassified
        ? "   <- overwhelmingly bonds; see guarantee 2 in the header"
        : ""),
  );
  const unmappedRows = unmapped.reduce((n, u) => n + u.rows.length, 0);
  console.log(
    `  Unmapped values          : ${unmapped.length} (${unmappedRows} rows)` +
      (unmapped.length > 0
        ? `  [${unmapped.map((u) => `"${u.value}"`).join(", ")}]`
        : ""),
  );
  if (unmapped.length > 0) {
    console.log(
      `\n  An unmapped value is NOT a bug in this script — it is a decision\n` +
        `  nobody has made yet. Read the names above, then add a reviewed alias\n` +
        `  to YAHOO_TO_NSE_MAP in\n` +
        `  packages/core/src/market-data/instruments/sector-taxonomy.ts —\n` +
        `  or leave it unmapped on purpose, which is the right answer when the\n` +
        `  rows behind it are debt (they resolve to "Not Categorised", which is\n` +
        `  what a bond should be).`,
    );
  }

  if (!opts.apply) {
    console.log(
      `\n  DRY RUN — nothing written. Re-run with --apply to make these changes.\n`,
    );
    await prisma.$disconnect();
    return;
  }

  if (planned.length === 0) {
    console.log(`\n  Nothing to write.\n`);
    await prisma.$disconnect();
    return;
  }

  // ── Rollback snapshot, written BEFORE any write ──
  const rollbackDir = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    "rollbacks",
  );
  mkdirSync(rollbackDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const rollbackPath = path.join(
    rollbackDir,
    `resector-noncanonical-${opts.env ?? "ambient"}-${stamp}.json`,
  );
  writeFileSync(
    rollbackPath,
    JSON.stringify(
      {
        script: "resector-noncanonical",
        ticket: "MONEY-1302",
        status: "staged",
        target: maskedHost(uri),
        env: opts.env ?? "ambient",
        stagedAt: new Date().toISOString(),
        plannedRows: planned.length,
        rows: planned.map((p) => ({
          id: p.id,
          symbol: p.symbol,
          exchange: p.exchange,
          previousSector: p.sector,
          newSector: p.target,
          klass: p.klass,
        })),
      },
      null,
      2,
    ),
    "utf8",
  );
  console.log(`\n  Rollback snapshot staged: ${rollbackPath}`);

  await confirmWrite(
    uri,
    opts.env ? `--env ${opts.env} (Secret Manager)` : "ambient DATABASE_URL",
  );

  // Group by (previousSector -> target) so the write can PIN the value the plan
  // read. The prompt above can block on a human for minutes and the nightly
  // bhavcopy writer runs 21:00 IST, so a row can be retyped DEBT and have its
  // sector cleared in between. Both axes are re-checked in the `where`:
  // re-checking the type alone would let this script overwrite a sector another
  // writer legitimately set, while the snapshot recorded the stale one — a
  // replay would then DISCARD the concurrent write rather than restore it.
  const groups = new Map<string, { from: string; to: string; ids: string[] }>();
  for (const p of planned) {
    const key = `${p.sector}\u0000${p.target}`;
    const g = groups.get(key) ?? { from: p.sector!, to: p.target, ids: [] };
    g.ids.push(p.id);
    groups.set(key, g);
  }

  let written = 0;
  const writtenIds: string[] = [];
  const CHUNK = 500;
  for (const { from, to, ids } of groups.values()) {
    for (let i = 0; i < ids.length; i += CHUNK) {
      const chunk = ids.slice(i, i + CHUNK);
      const r = await prisma.instrumentMapping.updateMany({
        where: {
          id: { in: chunk },
          sector: from,
          instrumentType: { in: [...SECTOR_BEARING] },
        },
        data: { sector: to },
      });
      written += r.count;
      if (r.count === chunk.length) writtenIds.push(...chunk);
      recordProgress(rollbackPath, written, writtenIds);
    }
  }

  if (written < planned.length) {
    console.log(
      `\n  NOTE: ${planned.length - written} of ${planned.length} planned rows ` +
        `were NOT written — their instrumentType or sector changed between the ` +
        `plan and the write. That is the guard working; re-run to pick them up. ` +
        `The artefact's "writtenIds" lists ONLY the rows confirmed written, ` +
        `which is the safe set to replay — "rows" is the full PLANNED set and ` +
        `replaying that would revert a concurrent writer's legitimate work.`,
    );
  }
  console.log(`\n  Re-mapped ${written} rows.`);

  // Promote the staged snapshot — from here it describes writes that ACTUALLY
  // happened, which is the only kind safe to replay.
  const appliedPath = rollbackPath.replace(/\.json$/, ".applied.json");
  try {
    const snap = JSON.parse(readFileSync(rollbackPath, "utf8")) as Record<
      string,
      unknown
    >;
    snap.status = "applied";
    snap.appliedRows = written;
    snap.appliedAt = new Date().toISOString();
    writeFileSync(rollbackPath, JSON.stringify(snap, null, 2), "utf8");
    renameSync(rollbackPath, appliedPath);
    console.log(`  Rollback snapshot (APPLIED): ${appliedPath}\n`);
  } catch (e) {
    console.warn(
      `  Could not finalise the snapshot (${e instanceof Error ? e.message : e}). ` +
        `The writes DID happen; ${rollbackPath} is still the recovery source — ` +
        `check its "status" field, not its name.\n`,
    );
  }

  await prisma.$disconnect();
}

main().catch((err) => {
  console.error("\n  FAILED:", err instanceof Error ? err.message : err);
  process.exit(1);
});
