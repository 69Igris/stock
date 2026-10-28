/**
 * Strip the literal double quotes off `InstrumentMapping.name` — MONEY-1205.
 *
 * ## What it fixes
 *
 * Measured on prod 2026-08-18: **13,287 of 26,669 instrument names (49.8%) are
 * wrapped in literal double quotes** — NSE 6,620/11,529, BSE 6,667/15,140,
 * including **540 of the 541 active ETFs**:
 *
 *   SBIETFQLTY   name = "\"SBI NIFTY 200 QUALITY 30 ETF\""
 *   ABB          name = "\"ABB INDIA\""
 *   ARE&M        name = "\"AMARA RAJA ENERGY & MOBILITY L\""
 *
 * The cause was `parseCSV` in
 * `packages/core/src/market-data/instruments/zerodha-instruments-logic.ts`,
 * which split Kite's `/instruments` dump on `line.split(",")`. Kite DOES quote
 * its `name` column (106,262 of 114,427 lines), so the quotes were kept as part
 * of the value and written straight through `mapToUpsert`.
 *
 * Every one of the 13,287 is FULLY wrapped (`^".*"$`) — measured, not assumed:
 * zero rows have interior-only quotes, zero have an odd number of quote
 * characters, and zero would strip to an empty string. So a symmetric strip is
 * a complete repair, and it is idempotent: a second run finds nothing.
 *
 * ## ORDERING IS LOAD-BEARING — read this before running
 *
 * `ZerodhaInstrumentProvider.mapToUpdate` destructures away only `series` and
 * `instrumentType`; **`name` stays in `rest` and is rewritten on EVERY nightly
 * UPDATE**. 12,377 of the quoted rows carried `updatedAt = 2026-08-17` — the
 * 22:00 IST instrument-sync had re-stamped them the night before.
 *
 * So a repair run against a deployment whose parser is NOT yet fixed is
 * silently reverted within 24 hours. This is the MONEY-1093 class exactly (the
 * nightly writer undoing a deliberate repair, with no error anywhere).
 *
 * This script therefore REFUSES to `--apply` when it can prove the parser fix
 * is not live — see {@link judgeParserFixLive}. The proof is real evidence, not
 * a flag: if the most recent instrument-sync wrote quoted names, the fix that
 * would have stripped them was not running when it did.
 *
 * ## Safety
 *
 *   - DRY-RUN BY DEFAULT. `--apply` is required to write anything.
 *   - `--apply` requires an interactive TTY and typing "yes", whichever
 *     database is targeted, and echoes the masked target host.
 *   - A rollback snapshot of every previous name is written to
 *     `scripts/data/rollbacks/` BEFORE any write, and is rewritten mid-run so a
 *     crashed run leaves an artefact that states what actually landed.
 *   - The write re-checks the EXACT name it planned from, so a row the nightly
 *     sync touched between the plan and the write is skipped rather than
 *     clobbered — and the shortfall is reported, not hidden.
 *   - Only `^"(.*)"$` is touched. Anything else is left exactly as it is.
 *
 * ## Usage
 *
 *   yarn data:repair-names                      # dry run, ambient DATABASE_URL
 *   yarn data:repair-names --env qa             # dry run against QA
 *   yarn data:repair-names --env prod --apply   # WRITES (always prompts)
 *
 *   DATABASE_URL=... npx tsx scripts/data/repair-instrument-names.ts
 *   DATABASE_URL=... npx tsx scripts/data/repair-instrument-names.ts --apply
 *
 *   Options
 *     --apply            actually write (default: dry run)
 *     --env <qa|prod>    fetch DATABASE_URL from GCP Secret Manager
 *     --limit <n>        cap rows examined (default: all)
 *     --force            proceed even when the parser fix looks un-deployed.
 *                        Reverted within 24h if you are wrong. Requires a TTY
 *                        and the same "yes" prompt.
 *
 * ## After a successful run
 *
 * Atlas Search re-indexes from the change stream automatically — there is no
 * manual re-sync. Two caches hold stale names briefly and expire on their own:
 * the 5-minute Redis caches behind `/api/market/search` and
 * `/api/market/autocomplete`, and the per-lambda in-process cache in
 * `apps/web/lib/market/symbol-mapper.ts:135-136`.
 */

import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";
import { execFileSync } from "child_process";
import { writeFileSync, renameSync, readFileSync, mkdirSync } from "fs";

// MONEY-1205 — the two decisions, pure and unit-tested. Kept out of this script
// on purpose, exactly like `judgeSeriesReadiness` in `reclassify-instruments.ts`
// (MONEY-1196): the defect that motivates a repair script is usually invisible
// precisely because the arithmetic lived inline where nothing could assert on it.
//
// The narrow SUBPATH, never `@usemoney/core/market-data`. The barrel pulls the
// Prisma client in as a VALUE, and this script must not construct a DB client
// before `--env` has been resolved — otherwise it connects to whatever ambient
// DATABASE_URL happens to be set while the prompt echoes the host `--env`
// resolved. `ops-script-db-target.test.ts` enforces exactly this, and it caught
// the barrel import in `resector-real-estate.ts`.
import {
  stripWrappingQuotes,
  judgeParserFixLive,
} from "@usemoney/core/market-data/instrument-name-repair";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, "..", "..", ".env") });

/**
 * `@usemoney/database` is imported LAZILY, and that is load-bearing.
 *
 * It builds its PrismaClient at MODULE scope and bakes `process.env.DATABASE_URL`
 * into the constructor. ESM evaluates every static import BEFORE any statement in
 * this file's body — including `dotenv.config()` above and the `--env` resolution
 * in `main()` — so a STATIC import would pin the client to whatever
 * `DATABASE_URL` the shell exported while `confirmWrite` echoed the host `--env`
 * resolved. The operator would type "yes" to one database and write to another.
 *
 * Guarded by a static scan — see
 * `packages/core/__tests__/market-data/ops-script-db-target.test.ts`, whose
 * OPS_SCRIPTS list includes this file.
 */
type PrismaLike = (typeof import("@usemoney/database"))["default"];

const GCP_PROJECT = "stock-book-483718";

const SAME_RUN_HOURS = 2;

interface Options {
  apply: boolean;
  env: "qa" | "prod" | null;
  limit: number | null;
  force: boolean;
}

/**
 * Flags this script understands. Anything else is REFUSED rather than ignored —
 * `argv.includes(...)` silently drops what it does not recognise, which is how a
 * typo'd `--dry-run` turned an `--apply` into a write the operator thought was a
 * rehearsal.
 */
const KNOWN_FLAGS = new Set("--apply,--env,--limit,--force".split(","));

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
    // A flag present with NO value is an error, not "flag absent". A trailing
    // `--limit` returning null would mean "no limit" — i.e. every row — which is
    // the opposite of what the operator typed.
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
        `--limit must be a positive integer, got "${limitRaw}". ` +
          `Refusing to run rather than silently processing every row.`,
      );
    }
    limit = n;
  }

  const apply = has("--apply");
  // Fail FAST on a non-interactive stdin, before touching the database.
  // `confirmWrite` guards this too, but by then the script has read the whole
  // collection. `--apply` on a closed stdin can never succeed.
  if (apply && !process.stdin.isTTY) {
    throw new Error(
      "--apply requires an interactive terminal: the confirmation prompt " +
        "cannot be answered when stdin is not a TTY (a pipe, </dev/null, or a " +
        "CI runner). Refusing rather than hanging — a hung prompt exits 0, " +
        "which a wrapper's && reads as success.",
    );
  }

  return {
    apply,
    env: (env as "qa" | "prod" | null) ?? null,
    limit,
    force: has("--force"),
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
 * Host of a Mongo URI, for display. Never prints any credential.
 *
 * Parsed with `new URL()` rather than a regex, because `uri.match(/@([^/?]+)/)`
 * matches the wrong thing for a literal `@` inside a password (leaking the
 * password tail to stdout AND into the rollback JSON) and matches nothing at all
 * for a credential-less URI (asking the operator to confirm a write with no host
 * shown). Returns null when the host cannot be determined; callers REFUSE to
 * prompt rather than showing a placeholder.
 */
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

/**
 * Rewrite the rollback artefact mid-run so it states what has ACTUALLY been
 * written. There is no transaction here: a throw partway through leaves rows
 * repaired, and an artefact still reading "staged" would tell an incident
 * responder that nothing happened. Failures are swallowed — losing progress
 * metadata must never abort a run that is mid-write.
 */
function recordProgress(
  file: string,
  written: number,
  writtenIds: readonly string[],
): void {
  try {
    const snap = JSON.parse(readFileSync(file, "utf8")) as Record<
      string,
      unknown
    >;
    snap.status = "applying";
    snap.appliedRows = written;
    snap.writtenIds = [...writtenIds];
    snap.lastProgressAt = new Date().toISOString();
    writeFileSync(file, JSON.stringify(snap, null, 2), "utf8");
  } catch {
    /* best-effort */
  }
}

/**
 * Confirm before ANY write, whichever database is targeted.
 *
 * Deliberately NOT keyed off `--env prod`: the documented
 * `DATABASE_URL=... --apply` form leaves `env` null, and keying the gate off a
 * flag rather than off the database being written is how an operator with a prod
 * connection string exported gets no prompt at all.
 */
async function confirmWrite(
  uri: string,
  envLabel: string,
  planned: number,
): Promise<void> {
  const host = maskedHost(uri);
  if (!host) {
    console.error(
      "\n  Refusing to write: could not determine the target host from " +
        "DATABASE_URL.\n  Fix the connection string so the prompt can show " +
        "you what you are hitting.\n",
    );
    process.exit(1);
  }
  // A closed / non-interactive stdin must ABORT, not hang: neither prompt
  // callback can fire at EOF, `main()` never settles, and node exits 0 having
  // written nothing — which a wrapper's `&&` reads as "step completed".
  if (!process.stdin.isTTY) {
    console.error(
      "\n  Refusing to write: stdin is not a TTY, so the confirmation cannot " +
        "be answered.\n  This script is deliberately interactive — run it from " +
        "a terminal.\n",
    );
    process.exit(1);
  }
  process.stdout.write(
    `\n⚠️  This will WRITE to a database.\n` +
      `      target : ${host}\n` +
      `      source : ${envLabel}\n` +
      `      rows   : ${planned}\n` +
      `   It rewrites InstrumentMapping.name, stripping wrapping quotes.\n` +
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

interface Planned {
  id: string;
  symbol: string;
  exchange: string;
  before: string;
  after: string;
}

async function main(): Promise<void> {
  const opts = parseArgs(process.argv.slice(2));

  if (opts.env) {
    process.env.DATABASE_URL = databaseUrlForEnv(opts.env);
    console.log(`Using ${opts.env.toUpperCase()} database (Secret Manager)`);
  }
  if (!process.env.DATABASE_URL) {
    throw new Error(
      "DATABASE_URL is not set. Pass --env qa|prod, or set it inline.",
    );
  }

  // The single value both the connection and the prompt derive from, so they can
  // never disagree about which database this is.
  const resolvedUri = process.env.DATABASE_URL;

  // Import ONLY now — after the URL is final. See the note on the lazy import.
  const db: PrismaLike = (await import("@usemoney/database")).default;

  console.log("=".repeat(72));
  console.log(
    `  Instrument name repair (MONEY-1205) — ${opts.apply ? "APPLY" : "DRY RUN"}`,
  );
  console.log(`  target: ${maskedHost(resolvedUri) ?? "<unknown host>"}`);
  console.log("=".repeat(72));

  const total = await db.instrumentMapping.count();

  const rows = await db.instrumentMapping.findMany({
    where: { name: { startsWith: '"' } },
    select: {
      id: true,
      symbol: true,
      exchange: true,
      name: true,
      updatedAt: true,
    },
    // Deterministic, so a `--limit` dry run and the subsequent apply are the
    // SAME rows. Without it, natural order over a collection the nightly writers
    // mutate means the operator confirms one sample and writes another.
    orderBy: { id: "asc" },
    ...(opts.limit ? { take: opts.limit } : {}),
  });

  const plan: Planned[] = [];
  let notWrapped = 0;
  for (const r of rows) {
    const after = stripWrappingQuotes(r.name);
    if (after === r.name) {
      // Starts with a quote but is not symmetrically wrapped (or would empty).
      // LEFT ALONE and counted — an asymmetric name is a different defect and
      // guessing at it is how you turn a display bug into data loss.
      notWrapped++;
      continue;
    }
    plan.push({
      id: r.id,
      symbol: r.symbol,
      exchange: r.exchange,
      before: r.name,
      after,
    });
  }

  // ── Completeness, stated as N/M ──
  const scope = opts.limit ? `first ${opts.limit} by id` : "whole collection";
  console.log(`\nScanned ${rows.length} quote-prefixed rows (${scope}).`);
  console.log(
    `  ${plan.length}/${total} of ALL instrument rows are fully wrapped ` +
      `^"(.*)"$ and will be repaired.`,
  );
  if (notWrapped > 0) {
    console.log(
      `  ${notWrapped} start with a quote but are NOT symmetrically wrapped — ` +
        `LEFT UNTOUCHED\n    (asymmetric quoting is a different defect; ` +
        `guessing at it would risk real data).`,
    );
  }

  const byExchange = new Map<string, number>();
  for (const p of plan) {
    byExchange.set(p.exchange, (byExchange.get(p.exchange) ?? 0) + 1);
  }
  if (byExchange.size > 0) {
    console.log("\n  By exchange:");
    for (const [ex, n] of [...byExchange].sort((a, b) => b[1] - a[1])) {
      console.log(`    ${ex.padEnd(6)} ${String(n).padStart(6)}`);
    }
  }

  console.log("\n  Sample:");
  for (const p of plan.slice(0, 10)) {
    console.log(
      `    ${p.exchange} ${p.symbol.padEnd(14)} ${JSON.stringify(p.before)} -> ${JSON.stringify(p.after)}`,
    );
  }

  // ── Caveat: names that become identical across exchanges ──
  //
  // Surfaced because it is the one visible side effect of the strip, and because
  // it is much SMALLER than it first looks — the reassuring version of this note
  // would be the dangerous one, so both numbers are printed.
  //
  // Nothing keys on name uniqueness: `InstrumentMapping` has @@unique on
  // [symbol, exchange] and [yahooSymbol] only, `@@index([name])` is NOT unique,
  // no findUnique/findFirst resolves an instrument by name equality, and there is
  // no groupBy/distinct on name. So new duplicates are cosmetic.
  {
    const all = await db.instrumentMapping.findMany({
      select: { symbol: true, exchange: true, name: true },
    });
    const bySymbol = new Map<string, string[]>();
    for (const r of all) {
      const a = bySymbol.get(r.symbol) ?? [];
      a.push(r.name);
      bySymbol.set(r.symbol, a);
    }
    let mixed = 0;
    let dupBefore = 0;
    let dupAfter = 0;
    for (const [, names] of bySymbol) {
      if (names.length < 2) continue;
      const q = names.filter(
        (n) => n.startsWith('"') && n.endsWith('"') && n.length >= 2,
      ).length;
      if (q > 0 && q < names.length) mixed++;
      if (new Set(names).size < names.length) dupBefore++;
      if (new Set(names.map(stripWrappingQuotes)).size < names.length) {
        dupAfter++;
      }
    }
    console.log(
      `\n  CAVEAT — cross-exchange name collisions:\n` +
        `    ${mixed} symbols exist quoted on one exchange and unquoted on the other.\n` +
        `    Symbols whose names are identical across exchanges: ` +
        `${dupBefore} before -> ${dupAfter} after (+${dupAfter - dupBefore}).\n` +
        `    That is CORRECT — the same company should have the same name — and\n` +
        `    nothing keys on name uniqueness (@@unique is [symbol,exchange] and\n` +
        `    [yahooSymbol]; @@index([name]) is non-unique; no lookup resolves an\n` +
        `    instrument by name equality).`,
    );
  }

  // ── Ordering gate: is the fixed parser actually live? ──
  const newest = await db.instrumentMapping.findFirst({
    orderBy: { updatedAt: "desc" },
    select: { updatedAt: true },
  });
  const lastSyncAt = newest?.updatedAt ?? null;
  const quotedInLastRun = lastSyncAt
    ? await db.instrumentMapping.count({
        where: {
          name: { startsWith: '"' },
          updatedAt: {
            gte: new Date(lastSyncAt.getTime() - SAME_RUN_HOURS * 3_600_000),
          },
        },
      })
    : 0;
  const verdict = judgeParserFixLive({
    lastSyncAt,
    quotedInLastRun,
    now: new Date(),
  });

  console.log(
    `\n  Parser-fix check: ${verdict.live ? "OK" : "NOT LIVE"} — ${verdict.reason}.`,
  );

  if (!verdict.live) {
    console.log(
      `\n${"!".repeat(72)}\n` +
        `  THE FIXED PARSER IS NOT DEPLOYED — repairing now is POINTLESS.\n` +
        `${"!".repeat(72)}\n` +
        `  ZerodhaInstrumentProvider.mapToUpdate strips only \`series\` and\n` +
        `  \`instrumentType\`. \`name\` stays in the spread and is rewritten on\n` +
        `  EVERY nightly UPDATE, so instrument-sync (22:00 IST) will restore the\n` +
        `  quotes within 24 hours and this run will have achieved nothing.\n` +
        `  That is the MONEY-1093 class: the nightly writer undoing a deliberate\n` +
        `  repair, silently.\n` +
        `\n  Do this instead:\n` +
        `    1. Ship the parser fix (packages/core .../zerodha-instruments-logic.ts).\n` +
        `    2. Let ONE instrument-sync run, or re-run this check after it.\n` +
        `    3. Re-run this script.\n` +
        `\n  --force overrides this if you know the deploy landed after that sync.\n`,
    );
    if (opts.apply && !opts.force) {
      console.log("  REFUSING to --apply. (Nothing was written.)\n");
      return;
    }
  }

  if (plan.length === 0) {
    console.log("\nNothing to repair — already clean (or already run).\n");
    return;
  }

  if (!opts.apply) {
    console.log(
      "\nDRY RUN — nothing written. Re-run with --apply to make these changes.\n",
    );
    return;
  }

  // ── Rollback snapshot ──
  //
  // Anchored on THIS FILE, not on `process.cwd()`: this script is invoked from
  // the repo root by `yarn data:repair-names` and from wherever the operator
  // happens to be by the documented `npx tsx` form, and writing the ONLY copy of
  // the previous names to a varying directory is how it gets tidied away.
  const rollbackDir = path.resolve(__dirname, "rollbacks");
  mkdirSync(rollbackDir, { recursive: true });
  const rollbackPath = path.resolve(
    rollbackDir,
    `repair-names-rollback-${Date.now()}.json`,
  );
  writeFileSync(
    rollbackPath,
    JSON.stringify(
      {
        generatedAt: new Date().toISOString(),
        // The artefact states its own truth rather than encoding it in a
        // filename a crash cannot update. The rename to `.applied.json` below is
        // a convenience; on a partial apply the NAME still says staged while
        // rows are already written.
        status: "staged",
        target: maskedHost(resolvedUri) ?? "<unknown host>",
        note: "Replay: set InstrumentMapping.name back to `previousName`.",
        rows: plan.map((p) => ({
          id: p.id,
          symbol: p.symbol,
          exchange: p.exchange,
          previousName: p.before,
          newName: p.after,
        })),
      },
      null,
      2,
    ),
    "utf8",
  );
  console.log(`\nRollback snapshot staged: ${rollbackPath}`);

  // Confirm LAST: after the plan is printed and the rollback file exists, so the
  // operator agrees to a specific, visible change set that is already
  // recoverable.
  await confirmWrite(
    resolvedUri,
    opts.env ? `--env ${opts.env} (Secret Manager)` : "ambient DATABASE_URL",
    plan.length,
  );

  // Each row has a DIFFERENT new value, so this cannot be one updateMany. It is
  // an updateMany PER ROW whose WHERE re-checks the exact name the plan was
  // built from — the nightly sync runs at 22:00 IST and `confirmWrite` blocks on
  // a human, so a row can genuinely change between plan and write. A row that
  // moved is SKIPPED, not clobbered, and the shortfall is reported below.
  let written = 0;
  const writtenIds: string[] = [];
  const CHUNK = 25;
  for (let i = 0; i < plan.length; i += CHUNK) {
    const chunk = plan.slice(i, i + CHUNK);
    const results = await Promise.all(
      chunk.map((p) =>
        db.instrumentMapping.updateMany({
          where: { id: p.id, name: p.before },
          data: { name: p.after },
        }),
      ),
    );
    results.forEach((res, j) => {
      if (res.count === 1) {
        written++;
        writtenIds.push(chunk[j]!.id);
      }
    });
    // Persist progress after EVERY chunk: there is no transaction, so a throw
    // partway leaves rows written, and without this the artefact would still say
    // "staged" and a responder would conclude nothing happened.
    recordProgress(rollbackPath, written, writtenIds);
    if ((i / CHUNK) % 40 === 0) {
      process.stdout.write(`  ...${written}/${plan.length}\r`);
    }
  }

  // Report what was WRITTEN, never what was planned — a planned count read as a
  // success count is the exact defect this repo has fixed twice before.
  console.log(`\n\n  Repaired ${written}/${plan.length} planned rows.`);
  if (written < plan.length) {
    console.log(
      `  NOTE: ${plan.length - written} rows were NOT written — their name ` +
        `changed between the plan and the write (instrument-sync runs 22:00 ` +
        `IST). That is the guard working. Re-run to pick them up.`,
    );
  }

  // Verify against the database rather than trusting the counter.
  const remaining = await db.instrumentMapping.count({
    where: { name: { startsWith: '"' } },
  });
  const expected = notWrapped + (plan.length - written);
  console.log(
    `  Verification: ${remaining} rows still start with a quote ` +
      `(expected ${expected}).`,
  );
  // COMPARE them — MONEY-1238. Both numbers were computed and printed under a
  // comment reading "Verify against the database rather than trusting the
  // counter", and then nothing verified anything: a run that repaired 12 of
  // 12,000 rows printed `Verification: 8000 ... (expected 12).` and exited 0.
  // A mismatch means the write loop's own accounting disagrees with the
  // database, which is the one thing this line exists to detect.
  if (remaining !== expected) {
    console.error(
      `  MISMATCH: the database says ${remaining} quoted row(s) remain but ` +
        `this run accounted for ${expected}. The repair did not do what its ` +
        `counters claim — do not treat the names as fixed.`,
    );
    process.exitCode = 1;
  }

  console.log(
    `\n  Caches: Atlas Search re-indexes from the change stream automatically.\n` +
      `  The 5-minute Redis caches on /api/market/search and\n` +
      `  /api/market/autocomplete, and the per-lambda cache at\n` +
      `  apps/web/lib/market/symbol-mapper.ts:135-136, will serve stale names\n` +
      `  for a few minutes. No manual re-sync is required.\n`,
  );

  // Promote the staged snapshot: from here it describes writes that ACTUALLY
  // happened, which is the only kind safe to replay.
  const appliedPath = rollbackPath.replace(/\.json$/, ".applied.json");
  try {
    const snap = JSON.parse(readFileSync(rollbackPath, "utf8")) as Record<
      string,
      unknown
    >;
    snap.status = "applied";
    snap.appliedRows = written;
    snap.writtenIds = writtenIds;
    writeFileSync(rollbackPath, JSON.stringify(snap, null, 2), "utf8");
    renameSync(rollbackPath, appliedPath);
    console.log(`  Rollback snapshot applied: ${appliedPath}`);
  } catch {
    console.log(
      `  (Could not promote the snapshot; it remains at ${rollbackPath} and is ` +
        `still valid — read its "status" field, not its filename.)`,
    );
  }
}

main()
  .catch((err) => {
    console.error(`\nFailed: ${err instanceof Error ? err.message : err}`);
    process.exitCode = 1;
  })
  .finally(() => {
    // Best-effort disconnect; the client may never have been constructed.
    void (async () => {
      try {
        const db = (await import("@usemoney/database")).default;
        await db.$disconnect();
      } catch {
        /* never constructed */
      }
    })();
  });
