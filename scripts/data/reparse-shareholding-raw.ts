/**
 * Re-resolve every `shareholding_patterns` column from its own stored `raw`
 * (MONEY-1207)
 * ==========================================================================
 *
 * NO NETWORK. This script re-runs the CURRENT parser over the payload each row
 * already carries. Every one of the 7,953 rows on prod stores the source object
 * verbatim in `raw`, which is exactly what that column is for — an audit
 * artefact to RE-PARSE from when the key set is corrected.
 *
 * ## What was wrong
 *
 * `SHAREHOLDING_KEYS.public` listed six spellings — `public`,
 * `publicPercentage`, `publicShareholding`, `publicAndOthers`, `nonPromoter`,
 * `nonPromoterNonPublic` — and NSE uses none of them. The live payload calls the
 * public float **`public_val`**. Consequence, measured on prod 2026-08-18:
 *
 *   - `publicPct` is NULL on 7,953 of 7,953 rows (100%)
 *   - `public_val` is a non-blank string on 7,953 of 7,953 rows (100%)
 *   - `promoterPct` was the ONLY populated percentage in the whole table
 *
 * `employeeTrusts` and `underlyingDrs` were dropped the same way — no alias
 * named them, so they had nowhere to go even though they ship on every row.
 * They now have their own columns.
 *
 * The run telemetry said so all along and nobody could read it: every sync log
 * reported `keyHits: {"quarter:date", "promoter:pr_and_prgrp"}` and nothing
 * else. `keyHits` is a POSITIVE counter, so a mapping that does not exist simply
 * never appears — indistinguishable from a field the feed does not send. That is
 * why `ParseOutcome.unmapped` now exists, and why this script prints it.
 *
 * ## Why re-parse instead of re-fetch
 *
 * A re-fetch would take ~18,576 requests against nseindia.com and would only
 * return the CURRENT filing set. `raw` holds what was actually served at the
 * time, including quarters NSE has since rolled out of its window. Re-parsing is
 * both cheaper and strictly more faithful.
 *
 * ## What it refuses to do
 *
 * A row whose re-derived QUARTER differs from its stored one is REPORTED and
 * SKIPPED, never rewritten. `quarter` is one third of the
 * `(symbol, exchange, quarter)` unique, so moving it is not an update — it is a
 * delete plus an insert that could collide with a row that already exists. If
 * this counter is ever non-zero the normalisation rule has changed underneath
 * the table and that needs its own decision, not a silent merge.
 *
 * It also touches ONLY `source: "NSE_SHP"` / `exchange: "NSE"` rows. The BSE
 * provider writes the same table under its own `(symbol, "BSE", quarter)` keys
 * and its own payload shape; feeding those to the NSE parser is not this
 * script's job and could only do harm.
 *
 * Usage (dry run prints the full plan and writes nothing):
 *   npx tsx scripts/data/reparse-shareholding-raw.ts
 *   npx tsx scripts/data/reparse-shareholding-raw.ts --env qa
 *   npx tsx scripts/data/reparse-shareholding-raw.ts --env prod
 *   npx tsx scripts/data/reparse-shareholding-raw.ts --env prod --apply
 *   DATABASE_URL=... npx tsx scripts/data/reparse-shareholding-raw.ts --apply
 *
 * Flags:
 *   --apply        actually write (default: dry run). ALWAYS prompts; requires a TTY.
 *   --env qa|prod  read DATABASE_URL from GCP Secret Manager
 *   --limit N      dry-run only — sample the first N rows to size the change
 */

import { execFileSync } from "child_process";
import dotenv from "dotenv";
import { fileURLToPath } from "url";
import { writeFileSync, renameSync, readFileSync, mkdirSync } from "fs";
import path from "path";

// The NARROW subpath. Same reasoning as resector-real-estate.ts: a barrel would
// pull in `@usemoney/database`, whose PrismaClient is built at module scope from
// `process.env.DATABASE_URL`, which would pin the client before `--env` can
// resolve and silently defeat the `await import()` below. `ownership-logic` is a
// pure leaf with no imports at all.
import {
  parseShareholdingMaster,
  type ShareholdingRow,
} from "@usemoney/research/data-sources/ownership-logic";

dotenv.config({
  path: path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    "..",
    "..",
    ".env",
  ),
});

const GCP_PROJECT = "stock-book-483718";

/** The columns this script re-derives. Order is the order they are reported in. */
const COLUMNS = [
  "promoterPct",
  "pledgedPct",
  "fiiPct",
  "diiPct",
  "publicPct",
  "employeeTrustsPct",
  "underlyingDrsPct",
] as const;
type Column = (typeof COLUMNS)[number];

interface Options {
  apply: boolean;
  env: "qa" | "prod" | null;
  limit: number | null;
}

/**
 * Flags this script understands. Anything else is REFUSED rather than ignored —
 * `argv.includes()` silently drops what it does not recognise, which is how
 * `--dry-run` came to be accepted-and-ignored alongside `--apply` on a sibling
 * script (i.e. it WROTE).
 */
const KNOWN_FLAGS = new Set(["--apply", "--env", "--limit"]);

function assertKnownFlags(argv: string[]): void {
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
      `Use "--flag value", not "${eq[0]}". The equals form is not parsed, and an ` +
        `unparsed --env would leave APPLY mode pointed at the ambient DATABASE_URL.`,
    );
  }
}

function parseArgs(argv: string[]): Options {
  assertKnownFlags(argv);
  const has = (f: string): boolean => argv.includes(f);
  const val = (f: string): string | null => {
    const i = argv.indexOf(f);
    if (i < 0) return null;
    const next = argv[i + 1];
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
      throw new Error(`--limit must be a positive integer, got "${limitRaw}"`);
    }
    limit = n;
  }

  const apply = has("--apply");
  // `--limit --apply` would report an N/M completeness line measured over a
  // biased prefix and then write the whole table on that evidence. The
  // completeness line is the ONLY output an operator has to judge the change by,
  // so it must describe what is actually being written.
  if (apply && limit !== null) {
    throw new Error(
      "--limit cannot be combined with --apply: the completeness report would " +
        "describe a sample while the write covers the table. Use --limit for the " +
        "dry run, then --apply without it.",
    );
  }
  // Fail FAST, before reading ~8,000 rows: `--apply` on a closed stdin can never
  // succeed, and a hung prompt exits 0 — which a wrapper's `&&` reads as success.
  if (apply && !process.stdin.isTTY) {
    throw new Error(
      "--apply requires an interactive terminal: the confirmation prompt cannot " +
        "be answered when stdin is not a TTY (a pipe, </dev/null, or a CI runner).",
    );
  }

  return { apply, env: (env as "qa" | "prod" | null) ?? null, limit };
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

/** Host of a Mongo URI, for display. Never prints any credential. */
function maskedHost(uri: string): string | null {
  try {
    const u = new URL(uri);
    return u.host || null;
  } catch {
    const withoutScheme = uri.replace(/^[a-z+]+:\/\//i, "");
    const authority = withoutScheme.split("/")[0] ?? "";
    const at = authority.lastIndexOf("@");
    const host = at >= 0 ? authority.slice(at + 1) : authority;
    return host.trim() || null;
  }
}

/** Confirm before ANY write, whichever database is targeted. */
async function confirmWrite(uri: string, envLabel: string): Promise<void> {
  const host = maskedHost(uri);
  if (!host) {
    console.error(
      "\n  Refusing to write: could not determine the target host from " +
        "DATABASE_URL. The prompt exists so you can SEE what you are about to " +
        "hit; a placeholder gives you nothing to check.\n",
    );
    process.exit(1);
  }
  if (!process.stdin.isTTY) {
    console.error(
      "\n  Refusing to write: stdin is not a TTY, so the confirmation cannot be " +
        "answered. This script is deliberately interactive.\n",
    );
    process.exit(1);
  }
  process.stdout.write(
    `\n⚠️  This will WRITE to a database.\n` +
      `      target : ${host}\n` +
      `      source : ${envLabel}\n` +
      `   It rewrites shareholding_patterns percentage columns from each row's ` +
      `own stored raw payload.\n` +
      `   Type 'yes' to continue: `,
  );
  const answer = await new Promise<string>((resolve) => {
    process.stdin.once("data", (d) => resolve(String(d).trim()));
  });
  if (answer !== "yes") {
    // Non-zero: an abort is NOT success.
    console.log("Aborted.");
    process.exit(1);
  }
}

interface StoredRow {
  id: string;
  symbol: string;
  quarter: string;
  promoterPct: number | null;
  pledgedPct: number | null;
  fiiPct: number | null;
  diiPct: number | null;
  publicPct: number | null;
  employeeTrustsPct: number | null;
  underlyingDrsPct: number | null;
  raw: string;
}

interface Planned {
  id: string;
  symbol: string;
  quarter: string;
  before: Record<Column, number | null>;
  after: Record<Column, number | null>;
  changed: Column[];
}

function pctsOf(
  row: Pick<StoredRow, Column> | ShareholdingRow,
): Record<Column, number | null> {
  return {
    promoterPct: row.promoterPct,
    pledgedPct: row.pledgedPct,
    fiiPct: row.fiiPct,
    diiPct: row.diiPct,
    publicPct: row.publicPct,
    employeeTrustsPct: row.employeeTrustsPct,
    underlyingDrsPct: row.underlyingDrsPct,
  };
}

function bump(counter: Map<string, number>, key: string): void {
  counter.set(key, (counter.get(key) ?? 0) + 1);
}

function pad(n: number, width: number): string {
  return String(n).padStart(width, " ");
}

async function main(): Promise<void> {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.env) process.env.DATABASE_URL = databaseUrlForEnv(opts.env);
  const uri = process.env.DATABASE_URL ?? "";
  if (!uri) {
    throw new Error(
      "No DATABASE_URL. Pass --env qa|prod, or export DATABASE_URL yourself.",
    );
  }

  const { prisma } = await import("@usemoney/database");

  console.log(
    `\nRe-parsing shareholding_patterns from stored raw` +
      `${opts.env ? ` (--env ${opts.env})` : ""}` +
      `${opts.limit ? ` [SAMPLE of ${opts.limit}]` : ""}\n` +
      `target: ${maskedHost(uri) ?? "<unknown host>"}\n`,
  );

  // SOURCE-SCOPED, and this is load-bearing rather than tidy.
  //
  // `parseShareholdingMaster` is the NSE summary parser. A BSE-sourced row's
  // `raw` is a DIFFERENT payload shape, and running it through here would at
  // best refuse it (counted as a skip, harmless) and at worst resolve an alias
  // that happens to collide, writing an NSE-shaped reading into a BSE row. A
  // repair script must never widen its own blast radius past the writer whose
  // output it is repairing. The BSE provider owns its own rows.
  const rows = (await prisma.shareholdingPattern.findMany({
    where: { source: "NSE_SHP", exchange: "NSE" },
    select: {
      id: true,
      symbol: true,
      quarter: true,
      promoterPct: true,
      pledgedPct: true,
      fiiPct: true,
      diiPct: true,
      publicPct: true,
      employeeTrustsPct: true,
      underlyingDrsPct: true,
      raw: true,
    },
    orderBy: { id: "asc" },
    ...(opts.limit ? { take: opts.limit } : {}),
  })) as StoredRow[];

  const total = rows.length;
  if (total === 0) {
    console.log("No rows. Nothing to do.\n");
    await prisma.$disconnect();
    return;
  }

  const planned: Planned[] = [];
  const reasons = new Map<string, number>();
  const unmapped = new Map<string, number>();
  const keyHits = new Map<string, number>();
  // "How many rows END UP with a value in this column" — the N of the N/M line.
  const filledAfter: Record<Column, number> = {
    promoterPct: 0,
    pledgedPct: 0,
    fiiPct: 0,
    diiPct: 0,
    publicPct: 0,
    employeeTrustsPct: 0,
    underlyingDrsPct: 0,
  };
  const filledBefore: Record<Column, number> = { ...filledAfter };
  const changedByColumn: Record<Column, number> = { ...filledAfter };

  for (const row of rows) {
    for (const c of COLUMNS) if (row[c] !== null) filledBefore[c]++;

    let payload: unknown;
    try {
      payload = JSON.parse(row.raw);
    } catch {
      bump(reasons, "rawNotJson");
      continue;
    }

    // Straight through the REAL parser, wrapped in the same envelope the
    // endpoint uses. Re-implementing the column rules here would be a shadow of
    // the writer and would drift from it on the next key correction.
    const out = parseShareholdingMaster(row.symbol, { data: [payload] });
    for (const [k, v] of Object.entries(out.reasons)) {
      reasons.set(k, (reasons.get(k) ?? 0) + v);
    }
    for (const [k, v] of Object.entries(out.unmapped)) {
      unmapped.set(k, (unmapped.get(k) ?? 0) + v);
    }
    for (const [k, v] of Object.entries(out.keyHits)) {
      keyHits.set(k, (keyHits.get(k) ?? 0) + v);
    }

    const parsed = out.rows[0];
    if (!parsed) {
      // The parser refused it. Already counted in `reasons` above — no row means
      // no quarter or no core percentage, both of which are real answers.
      bump(reasons, "noRowFromRaw");
      for (const c of COLUMNS) if (row[c] !== null) filledAfter[c]++;
      continue;
    }

    if (parsed.quarter !== row.quarter) {
      // The unique key would move. Reported, never rewritten — see the header.
      bump(reasons, `quarterDrift:${row.quarter}->${parsed.quarter}`);
      for (const c of COLUMNS) if (row[c] !== null) filledAfter[c]++;
      continue;
    }

    const before = pctsOf(row);
    const after = pctsOf(parsed);
    for (const c of COLUMNS) if (after[c] !== null) filledAfter[c]++;

    const changed = COLUMNS.filter((c) => before[c] !== after[c]);
    for (const c of changed) changedByColumn[c]++;
    if (changed.length > 0) {
      planned.push({
        id: row.id,
        symbol: row.symbol,
        quarter: row.quarter,
        before,
        after,
        changed,
      });
    }
  }

  // ── Report ────────────────────────────────────────────────────────────────
  console.log(`Rows read: ${total}`);
  console.log(`Rows that would change: ${planned.length}/${total}\n`);

  console.log("Column completeness (rows with a non-null value):");
  console.log("  column               before        after");
  for (const c of COLUMNS) {
    const b = `${pad(filledBefore[c], 5)}/${total}`;
    const a = `${pad(filledAfter[c], 5)}/${total}`;
    const pctB = ((filledBefore[c] / total) * 100).toFixed(1);
    const pctA = ((filledAfter[c] / total) * 100).toFixed(1);
    const delta =
      changedByColumn[c] > 0 ? `   (+${changedByColumn[c]} changed)` : "";
    console.log(
      `  ${c.padEnd(20)} ${b} (${pad(Number(pctB), 5)}%)  ${a} (${pad(Number(pctA), 5)}%)${delta}`,
    );
  }

  console.log("\nAlias hits (which key actually resolved each field):");
  for (const [k, v] of [...keyHits].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${k.padEnd(34)} ${v}`);
  }

  console.log("\nSkip reasons:");
  if (reasons.size === 0) console.log("  (none)");
  for (const [k, v] of [...reasons].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${k.padEnd(34)} ${v}`);
  }

  // The completeness assertion. A non-empty map here means a key we have
  // VERIFIED is present in the payload still produced nothing — i.e. our alias
  // list has regressed, which is the exact failure this whole ticket is about.
  console.log("\nUNMAPPED verified keys (must be empty):");
  if (unmapped.size === 0) {
    console.log("  (none) — every verified payload key resolved");
  } else {
    for (const [k, v] of [...unmapped].sort((a, b) => b[1] - a[1])) {
      console.log(`  !! ${k.padEnd(31)} ${v}`);
    }
    console.log(
      "\n  ^ This is a BUG IN OUR KEY SET, not in the feed. Fix SHAREHOLDING_KEYS\n" +
        "    in packages/research/src/data-sources/ownership-logic.ts before applying.",
    );
  }

  const sample = planned.slice(0, 10);
  if (sample.length > 0) {
    console.log("\nSample of planned changes:");
    for (const p of sample) {
      const diffs = p.changed
        .map((c) => `${c}: ${p.before[c] ?? "null"} -> ${p.after[c] ?? "null"}`)
        .join(", ");
      console.log(`  ${p.symbol} ${p.quarter}  ${diffs}`);
    }
    if (planned.length > sample.length) {
      console.log(`  ... and ${planned.length - sample.length} more`);
    }
  }

  if (!opts.apply) {
    console.log(
      "\nDRY RUN — nothing written. Re-run with --apply to make these changes.\n",
    );
    await prisma.$disconnect();
    return;
  }

  if (planned.length === 0) {
    console.log("\nNothing to write.\n");
    await prisma.$disconnect();
    return;
  }

  // REFUSE to apply while the completeness assertion is red. Writing now would
  // bake a known-incomplete parse into the table and destroy the "before" state
  // that makes the next fix measurable.
  if (unmapped.size > 0) {
    console.error(
      "\n  REFUSING to --apply: the UNMAPPED report above is non-empty, which " +
        "means\n  a verified payload key still resolves to nothing. Correct the " +
        "alias list first.\n",
    );
    process.exit(1);
  }

  // Rollback BEFORE the write. Anchored on THIS FILE, not on `process.cwd()` —
  // see scripts/data/rollbacks/README.md for why cwd lost a whole batch once.
  const rollbackDir = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    "rollbacks",
  );
  mkdirSync(rollbackDir, { recursive: true });
  const rollbackPath = path.resolve(
    rollbackDir,
    `reparse-shareholding-rollback-${Date.now()}.json`,
  );
  writeFileSync(
    rollbackPath,
    JSON.stringify(
      {
        generatedAt: new Date().toISOString(),
        // The artefact states its own truth rather than encoding it in a
        // filename that a crash cannot update.
        status: "staged",
        target: maskedHost(uri) ?? "<unknown host>",
        note: "Replay: for each id, set the columns back to `before`.",
        rows: planned.map((p) => ({
          id: p.id,
          symbol: p.symbol,
          quarter: p.quarter,
          before: p.before,
          after: p.after,
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

  let written = 0;
  let failed = 0;
  const CHUNK = 50;
  for (let i = 0; i < planned.length; i += CHUNK) {
    const chunk = planned.slice(i, i + CHUNK);
    await Promise.all(
      chunk.map(async (p) => {
        try {
          await prisma.shareholdingPattern.update({
            where: { id: p.id },
            data: p.after,
          });
          written++;
        } catch (err) {
          failed++;
          console.warn(
            `  update failed ${p.symbol}/${p.quarter}: ${
              err instanceof Error ? err.message : err
            }`,
          );
        }
      }),
    );
    if (i % 500 === 0) {
      console.log(
        `  ... ${Math.min(i + CHUNK, planned.length)}/${planned.length}`,
      );
    }
  }

  // Promote the snapshot only once the writes have actually happened.
  const appliedPath = rollbackPath.replace(/\.json$/, ".applied.json");
  try {
    const snapshot = JSON.parse(readFileSync(rollbackPath, "utf8")) as Record<
      string,
      unknown
    >;
    snapshot.status = "applied";
    snapshot.appliedRows = written;
    snapshot.failedRows = failed;
    snapshot.appliedAt = new Date().toISOString();
    writeFileSync(rollbackPath, JSON.stringify(snapshot, null, 2), "utf8");
    renameSync(rollbackPath, appliedPath);
    console.log(`  Rollback snapshot (APPLIED): ${appliedPath}`);
  } catch (e) {
    console.warn(
      `  Could not finalise the snapshot (${e instanceof Error ? e.message : e}). ` +
        `The writes DID happen; the file at ${rollbackPath} is still the recovery ` +
        `source — check its "status" field, not its name.`,
    );
  }

  console.log(`\nApplied. ${written} rows updated, ${failed} failed.\n`);
  await prisma.$disconnect();
}

main().catch((err) => {
  console.error("\nFailed:", err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
