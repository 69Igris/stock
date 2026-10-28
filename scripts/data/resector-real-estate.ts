/**
 * Move existing real-estate rows into the Real Estate sector  (MONEY-1093)
 * ==========================================================================
 *
 * Real Estate became its own NSE sector on 2026-07-30 (founder decision). It
 * used to fold into Financial Services, which made DLF, Godrej Properties and
 * Oberoi Realty indistinguishable from HDFC Bank in every sector aggregate.
 *
 * Changing `YAHOO_TO_NSE_MAP` only affects FUTURE writes. Existing rows do NOT
 * re-bucket themselves, and they never will on their own: the enrichment
 * pipeline only fetches rows whose sector is UNSET (`sector-enrichment.ts`), so
 * a row already stored as "Financial Services" is permanently excluded from
 * re-enrichment. Hence this script.
 *
 * ## What `industry` actually contains — read this before trusting a match
 *
 * An earlier version of this comment claimed the column holds "Yahoo's RAW
 * industry string". That is only one of its provenances, and the omission
 * mattered:
 *
 *   - Yahoo taxonomy (`Real Estate - Development`, `Mortgage Finance`,
 *     `Engineering & Construction`) — a closed, predictable vocabulary;
 *   - **unvalidated Gemini free text**, written by `enrich-sectors-gemini.ts`
 *     for rows with no sector — i.e. precisely this ticket's target population;
 *   - on-demand enrichment via `stock-sector.ts`.
 *
 * The consequence is specific: `"realty"` does not exist in Yahoo's taxonomy at
 * all, so that match rule fires EXCLUSIVELY on model output. And a model asked
 * "what industry is REPCOHOME" happily returns strings like
 * `"Housing Finance / Real Estate"` — which contains a match term AND a
 * near-miss term. So this script cannot treat a single substring hit as a
 * decision; see `classifyIndustry` below.
 *
 * ## Why it does not trust its own matcher
 *
 * Matching on free text is a heuristic, and on this ticket a heuristic already
 * cost a bug: a bond-symbol regex looked sound and, measured against prod, hit
 * 2,236 wrong rows while missing 9,043. So this script does NOT quietly apply a
 * pattern. The dry run prints EVERY distinct industry value it matched, with
 * counts, plus the near-misses it rejected — because the only way to know a
 * text matcher is right is for a human to read what it caught.
 *
 * Reversibility is real here: a rollback snapshot of every (id, sector,
 * industry) it overwrites is written BEFORE any write, into
 * `scripts/data/rollbacks/` (repo-relative, NOT the cwd — see that directory's
 * README.md).
 *
 * Usage (preferred — args pass straight through):
 *   yarn data:resector                      # dry run, ambient DATABASE_URL
 *   yarn data:resector --env qa             # dry run against QA
 *   yarn data:resector --env prod --apply   # WRITES (always prompts)
 *
 * Direct invocation, equivalent:
 *   npx tsx scripts/data/resector-real-estate.ts                  # dry run
 *   npx tsx scripts/data/resector-real-estate.ts --env qa
 *   npx tsx scripts/data/resector-real-estate.ts --env prod --apply
 *   DATABASE_URL=... npx tsx scripts/data/resector-real-estate.ts --apply
 *
 * Flags:
 *   --apply        actually write (default: dry run). Always prompts.
 *   --env qa|prod  read DATABASE_URL from Secret Manager
 *   --limit N      cap the rows considered (for a smaller first pass)
 *   --from SECTOR  only consider rows currently in SECTOR
 *                  (default: any sector, plus rows with none)
 */

import { execFileSync } from "child_process";
import dotenv from "dotenv";
import { fileURLToPath } from "url";
import { createInterface } from "readline";
import { writeFileSync, renameSync, readFileSync, mkdirSync } from "fs";
import path from "path";

// The NARROW subpath, not the `/market-data` barrel — and that matters beyond
// the standing subpath rule. The barrel re-exports `syncInstruments`, which
// imports `@usemoney/database`, whose PrismaClient is built at module scope from
// `process.env.DATABASE_URL`. Importing the barrel statically therefore pinned
// the client before `--env` could resolve, defeating the `await import()` below
// entirely. `sector-taxonomy` is a leaf module with no imports at all.
import { normalizeToNseSector } from "@usemoney/core/sector-taxonomy";

// Pure matcher lives in @usemoney/core so it can be unit-tested without this
// script's module-scope `main()` running against a database — and because `tsx`
// compiles scripts/ as CJS while packages/* is ESM, so named exports do not
// cross that boundary. A LEAF module (zero imports), which keeps it clear of the
// ops-script DB-target guard.
import {
  classifyIndustry,
  isInfraTrust,
} from "@usemoney/core/real-estate-industry-match";

// Load the repo `.env`, exactly as reclassify-instruments.ts does.
//
// Without it the two scripts in the same `yarn data:*` family resolved
// DATABASE_URL DIFFERENTLY: from one shell `data:reclassify` silently targeted
// whatever `.env` pointed at while `data:resector` threw — or, worse, the two
// targeted different databases in the same session. The README calls it "ambient
// DATABASE_URL", which hid the `.env` read.
dotenv.config({
  path: path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    "..",
    "..",
    ".env",
  ),
});

const GCP_PROJECT = "stock-book-483718";

/** The canonical target. Imported indirectly via normalizeToNseSector below. */
const TARGET_SECTOR = "Real Estate";

interface Options {
  apply: boolean;
  env: "qa" | "prod" | null;
  limit: number | null;
  from: string | null;
}

/**
 * Flags this script understands. Anything else is REFUSED rather than ignored.
 *
 * `argv.includes(...)` silently drops what it does not recognise, which turned
 * two typos into destructive defaults: `--keep-sectors` (plural) left
 * `clearSector` TRUE so sectors were cleared, and `--dry-run` — the convention
 * scripts/README.md says every migration supports — was ignored, so
 * `--apply --dry-run` WROTE. `--env=prod` (equals form) was also dropped,
 * leaving APPLY mode pointed at the ambient DATABASE_URL.
 */
const KNOWN_FLAGS = new Set("--apply,--env,--limit,--from".split(","));

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

/**
 * Rewrite the rollback artefact mid-run so it states what has ACTUALLY been
 * written. See the twin in `reclassify-instruments.ts` for the full reasoning:
 * the chunked writes have no transaction, so a throw mid-loop used to leave rows
 * written under a file that still said "staged".
 */
function recordProgress(
  path: string,
  written: number,
  writtenIds: readonly string[],
): void {
  try {
    const snap = JSON.parse(readFileSync(path, "utf8")) as Record<
      string,
      unknown
    >;
    snap.status = "applying";
    snap.appliedRows = written;
    snap.writtenIds = [...writtenIds];
    snap.lastProgressAt = new Date().toISOString();
    writeFileSync(path, JSON.stringify(snap, null, 2), "utf8");
  } catch {
    /* progress metadata is best-effort; never abort a live write for it */
  }
}

function parseArgs(argv: string[]): Options {
  assertKnownFlags(argv);
  const has = (f: string) => argv.includes(f);
  const val = (f: string): string | null => {
    const i = argv.indexOf(f);
    if (i < 0) return null;
    const next = argv[i + 1];
    // A flag present with NO value is an error, not "flag absent". This used to
    // return null for a TRAILING `--limit`, which then meant "no limit" — i.e.
    // every row — directly contradicting the refusal three lines below. A value
    // that looks like another flag is the same mistake.
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
  // Same guard as reclassify-instruments.ts: `--limit 5oo` and `--limit --apply`
  // both parse to NaN, which is falsy, which drops `take` and silently
  // processes EVERY row. Refuse instead.
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
  //
  // `confirmWrite` also guards this as the last line of defence, but by then the
  // script has already read tens of thousands of rows. `--apply` on a closed
  // stdin can never succeed, so refusing here costs the operator nothing and
  // saves a pointless full-collection read.
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
    from: val("--from"),
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
 * Parsed with `new URL()` rather than a regex. The regex version was
 * `uri.match(/@([^/?]+)/)`, whose FIRST match is wrong for two real shapes:
 *   - a literal un-encoded `@` in the password (`u:pa@ss@host/db`) matched
 *     `ss@host`, printing the password tail — to stdout AND into the `target`
 *     field of the rollback JSON on disk;
 *   - no credentials at all (`mongodb://localhost:27017/db`) matched nothing,
 *     so the operator was asked to confirm a destructive write with NO host
 *     shown — indistinguishable from garbage.
 *
 * Returns null when the host cannot be determined, and callers REFUSE to prompt
 * in that case rather than showing a placeholder.
 */
function maskedHost(uri: string): string | null {
  try {
    const u = new URL(uri);
    // `URL` keeps credentials in `username`/`password`, never in `host`.
    return u.host || null;
  } catch {
    // mongodb+srv with a comma-separated host list is not a legal URL. Take the
    // authority after the LAST `@` that precedes the first `/`.
    const withoutScheme = uri.replace(/^[a-z+]+:\/\//i, "");
    const authority = withoutScheme.split("/")[0] ?? "";
    const at = authority.lastIndexOf("@");
    const host = at >= 0 ? authority.slice(at + 1) : authority;
    return host.trim() || null;
  }
}

/**
 * Confirm before ANY write, whichever database is targeted, and echo the host
 * being written to. Keyed on the WRITE, never on a flag: the documented
 * `DATABASE_URL=... --apply` form has no `--env`, so an `--env`-keyed check
 * would wave through exactly the invocation most likely to be pointed at prod
 * by accident.
 */
async function confirmWrite(uri: string, envLabel: string): Promise<void> {
  const host = maskedHost(uri);
  if (!host) {
    // Refuse rather than prompt with a placeholder. The prompt exists so the
    // operator can SEE what they are about to hit; "<unparseable host>" gave
    // them nothing to check and still accepted "yes".
    console.error(
      "\n  Refusing to write: could not determine the target host from " +
        "DATABASE_URL.\n  Fix the connection string so the prompt can show " +
        "you what you are hitting.\n",
    );
    process.exit(1);
  }
  // A closed / non-interactive stdin must ABORT, not hang.
  //
  // Neither prompt's callback can ever fire when stdin is at EOF (`< /dev/null`,
  // a pipe, a CI runner, a cron wrapper). `main()` then never settles, its
  // `.finally` never runs, and node exits **0** having written nothing — which
  // is precisely the failure the exit(1) paths here exist to prevent: a wrapper
  // using `&&` reads "the operator was never asked" as "step completed".
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
  if (answer.trim().toLowerCase() !== "yes") {
    console.log("  Aborted — nothing written.\n");
    process.exit(1);
  }
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));

  if (opts.env) process.env.DATABASE_URL = databaseUrlForEnv(opts.env);
  const uri = process.env.DATABASE_URL ?? "";
  if (!uri) {
    throw new Error("DATABASE_URL is not set (pass --env qa|prod, or set it)");
  }

  const { prisma } = await import("@usemoney/database");

  console.log(
    `\n  Real-estate re-sector — ${opts.apply ? "APPLY" : "DRY RUN"}` +
      `\n  target: ${maskedHost(uri) ?? "<unknown host>"}` +
      `\n  moving matching rows into sector "${TARGET_SECTOR}"\n`,
  );

  const rows = await prisma.instrumentMapping.findMany({
    where: {
      isActive: true,
      // EQUITY and REIT only. An InvIT owns toll roads, transmission lines or
      // gas pipelines — never property — but Yahoo's taxonomy has no InvIT
      // class, so Indian InvITs land under "REIT - Specialty"/"Diversified".
      //
      // Filtering on instrumentType alone does NOT protect them, which the
      // previous comment got wrong: it named seven trusts as excluded, and
      // four of them are not typed INVIT at all. `classifyTrustInstrument`
      // matches on the tokens "INVIT" / "INV IT" / "INFRASTRUCTURE INVESTMENT
      // TRUST", so PGINVIT and IRBINVIT match — but INDIGRID ("INDIA GRID
      // TRUST"), NHIT ("NATIONAL HIGHWAYS INFRA TRUST"), Cube Highways Trust
      // and Anzen carry none of those tokens, are typed EQUITY, and would have
      // been swept straight in. Verified by running the matcher.
      //
      // So the name is checked explicitly below as well.
      instrumentType: { in: ["EQUITY", "REIT"] },
      ...(opts.from ? { sector: opts.from } : {}),
    },
    select: {
      id: true,
      symbol: true,
      exchange: true,
      name: true,
      sector: true,
      industry: true,
    },
    // Deterministic. Without an orderBy, `--limit N` samples natural order over
    // a collection the nightly writers are mutating, so the dry run and the
    // apply would be two DIFFERENT sets — the operator confirms one and gets
    // another.
    orderBy: { id: "asc" },
    ...(opts.limit ? { take: opts.limit } : {}),
  });

  console.log(`  Considered ${rows.length} active rows.`);

  const move: Array<{
    id: string;
    symbol: string;
    exchange: string;
    sector: string | null;
    industry: string | null;
    via: string;
  }> = [];
  const byMatch = new Map<string, number>();
  const byIndustry = new Map<string, number>();
  const byFromSector = new Map<string, number>();
  const nearMiss = new Map<string, number>();
  /** Hit BOTH lists — reported and deliberately NOT moved. */
  const ambiguous: Array<{ symbol: string; industry: string }> = [];
  /** Has a sector but no industry evidence at all — invisible to this matcher
   *  AND permanently excluded from re-enrichment. The residual, sized. */
  let noEvidence = 0;
  /** Infrastructure trusts skipped by name — reported, never moved. */
  let infraTrusts = 0;
  /**
   * The subset of those already sitting in a Real-Estate bucket: symbol -> the
   * raw stored sector. This is wrong data the script deliberately does NOT
   * touch, so it has to be visible or nobody will ever know it is there. Yahoo
   * files InvITs as "Real Estate", so on a first run this is most of them.
   */
  const infraTrustsInTarget = new Map<string, string>();

  for (const r of rows) {
    const normalised = r.sector ? normalizeToNseSector(r.sector) : null;

    // The infra-trust exclusion runs FIRST, before the already-correct check.
    //
    // Yahoo files Indian InvITs under sector "Real Estate" with industry
    // "REIT - Specialty", so the common case for INDIGRID/PGINVIT is a row
    // ALREADY stored as "Real Estate" — which the already-correct branch used
    // to skip silently, before this check could see it. The exclusion that
    // exists precisely to keep infra trusts out of Real Estate was therefore
    // unreachable for exactly the rows it was written for, and those rows were
    // not even counted: they left no line in the report at all.
    //
    // These are still never MOVED — an InvIT is not real estate, but which
    // sector it does belong to (Utilities? Industrials? Financial Services?) is
    // a product decision outside this script's remit. So they are counted and
    // reported, split by whether they are already sitting in a Real-Estate
    // bucket, because that subset is wrong data a human needs to act on.
    //
    // Checked on the NAME because instrumentType does not reliably carry it
    // (see the query comment above) — and, since MONEY-1093 removed the only
    // writer that retyped an existing row to INVIT, nothing will make it
    // reliable on its own.
    if (isInfraTrust(r.symbol, r.name ?? null)) {
      infraTrusts++;
      if (normalised === TARGET_SECTOR) {
        infraTrustsInTarget.set(
          r.symbol,
          r.sector ?? "(none)",
        );
      }
      continue;
    }

    // Already correct? Covers the rows the un-normalising writers left as a
    // non-canonical "Real Estate"/"Realty" bucket — those become correct for
    // free now that the sector is canonical, so they are not "moves".
    if (normalised === TARGET_SECTOR && r.sector === TARGET_SECTOR) continue;

    const cls = classifyIndustry(r.industry);

    // Hit both lists: do NOT decide. "Housing Finance / Real Estate" is a real
    // Gemini output shape, and silently relabelling an HFC as Real Estate is
    // worse than leaving it for a human.
    // The SECTOR-ALIAS decision comes first, because it does not depend on the
    // industry text at all.
    //
    // A row stored as "Realty" needs normalising to the canonical "Real Estate"
    // whatever its industry says — but the ambiguity check used to `continue`
    // before this branch, so such a row was skipped entirely and left in a
    // non-canonical bucket that `sector: "Real Estate"` equality queries cannot
    // reach. That is the very failure the taxonomy comment documents for
    // "Realty", re-created by ordering.
    if (normalised === TARGET_SECTOR) {
      byMatch.set("sector-alias", (byMatch.get("sector-alias") ?? 0) + 1);
      byFromSector.set(
        r.sector ?? "(none)",
        (byFromSector.get(r.sector ?? "(none)") ?? 0) + 1,
      );
      move.push({ ...r, via: "sector-alias" });
      continue;
    }

    if (cls.verdict === "ambiguous") {
      ambiguous.push({ symbol: r.symbol, industry: r.industry ?? "" });
      continue;
    }

    if (cls.verdict === "match") {
      const via = cls.match!;
      byMatch.set(via, (byMatch.get(via) ?? 0) + 1);
      byIndustry.set(r.industry!, (byIndustry.get(r.industry!) ?? 0) + 1);
      byFromSector.set(
        r.sector ?? "(none)",
        (byFromSector.get(r.sector ?? "(none)") ?? 0) + 1,
      );
      move.push({ ...r, via });
      continue;
    }

    if (cls.verdict === "near-miss") {
      nearMiss.set(cls.nearMiss!, (nearMiss.get(cls.nearMiss!) ?? 0) + 1);
    } else if (r.sector && !r.industry) {
      // No industry to reason from, and a sector already set — so re-enrichment
      // will never revisit it either. Counted so the operator knows the size of
      // what this script CANNOT fix.
      noEvidence++;
    }
  }

  if (move.length === 0) {
    console.log("\n  Nothing to move. Either already done, or no matches.\n");
    await prisma.$disconnect();
    return;
  }

  console.log(`\n  Would move ${move.length} rows to "${TARGET_SECTOR}".`);

  console.log("\n  By match rule:");
  for (const [k, n] of [...byMatch].sort((a, b) => b[1] - a[1])) {
    console.log(`    ${k.padEnd(16)} ${String(n).padStart(6)}`);
  }

  console.log("\n  From sector:");
  for (const [k, n] of [...byFromSector].sort((a, b) => b[1] - a[1])) {
    console.log(`    ${k.padEnd(26)} ${String(n).padStart(6)}`);
  }

  // The important part: every distinct industry string this matched, so a
  // human validates the matcher instead of trusting it.
  console.log(
    "\n  EVERY distinct industry matched — read this before applying:",
  );
  for (const [k, n] of [...byIndustry].sort((a, b) => b[1] - a[1])) {
    console.log(`    ${String(n).padStart(5)}  ${k}`);
  }

  if (ambiguous.length > 0) {
    console.log(
      `\n  AMBIGUOUS — ${ambiguous.length} rows matched BOTH a real-estate term` +
        `\n  and a near-miss term. NOT moved. These are the ones most likely to` +
        `\n  be housing finance / construction mislabelled by the Gemini` +
        `\n  enrichment, and they are exactly what a single-substring matcher` +
        `\n  would have moved silently:`,
    );
    for (const a of ambiguous.slice(0, 20)) {
      console.log(`    ${a.symbol.padEnd(14)} "${a.industry}"`);
    }
    if (ambiguous.length > 20) {
      console.log(`    ... and ${ambiguous.length - 20} more`);
    }
  }

  if (infraTrusts > 0) {
    console.log(
      `\n  ${infraTrusts} infrastructure trusts skipped by name (toll roads,` +
        `\n  transmission, pipelines). They are not real estate, and typing` +
        `\n  alone does not exclude them — Yahoo files them under REIT.`,
    );
  }

  if (infraTrustsInTarget.size > 0) {
    // These are NOT skipped-and-fine — they are wrong data this script
    // deliberately does not touch, and they were previously invisible: the
    // already-correct branch swallowed them before the infra check ran, so they
    // produced no line at all. Yahoo files InvITs under "Real Estate", so on a
    // first run this is most of them.
    console.log(
      `\n  ACTION NEEDED — ${infraTrustsInTarget.size} infrastructure trusts are` +
        `\n  ALREADY sitting in a Real Estate bucket. This script never moves a` +
        `\n  trust, so it cannot fix these; which sector they belong in` +
        `\n  (Utilities? Industrials? Financial Services?) is a product` +
        `\n  decision. Listed so they are not invisible:`,
    );
    for (const [symbol, stored] of [...infraTrustsInTarget].sort()) {
      console.log(`    ${symbol.padEnd(14)} currently "${stored}"`);
    }
  }

  if (noEvidence > 0) {
    console.log(
      `\n  NOT FIXABLE HERE — ${noEvidence} rows have a sector but NO industry` +
        `\n  string, so there is nothing to match on. They are also excluded` +
        `\n  from re-enrichment (that pipeline only fetches rows with no` +
        `\n  sector), so a real-estate company in this set stays mis-bucketed` +
        `\n  until someone enriches it deliberately.`,
    );
  }

  if (nearMiss.size > 0) {
    console.log(
      "\n  Deliberately NOT matched (shown so the omission is visible, not silent):",
    );
    for (const [k, n] of [...nearMiss].sort((a, b) => b[1] - a[1])) {
      console.log(`    ${String(n).padStart(5)}  *${k}*`);
    }
  }

  console.log("\n  Sample of rows to move:");
  for (const r of move.slice(0, 15)) {
    console.log(
      `    ${r.exchange} ${r.symbol.padEnd(14)} ${String(r.sector ?? "(none)").padEnd(22)}` +
        ` -> ${TARGET_SECTOR}   [${r.via}] industry="${r.industry ?? ""}"`,
    );
  }

  if (!opts.apply) {
    console.log(
      "\n  DRY RUN — nothing written. Re-run with --apply to make these changes.\n",
    );
    await prisma.$disconnect();
    return;
  }

  // Rollback BEFORE the write. `sector`/`industry` exist nowhere else and a
  // re-enrichment will not restore them (the pipeline only fetches rows with
  // NO sector), so this file is the recovery path.
  //
  // Anchored on THIS FILE (`scripts/data/rollbacks/`), not on `process.cwd()`,
  // and derived from `import.meta.url` exactly like the `.env` load above. cwd
  // is not a stable anchor: `yarn data:resector` runs from the repo root,
  // `scripts/ops/run-market-data-job.sh` invokes the sibling scripts by a
  // RELATIVE `scripts/data/...` path (assuming the root without guaranteeing
  // it), and `npx tsx scripts/data/…` runs from wherever the operator is. cwd
  // therefore scattered the ONLY copy of the destroyed sectors, and — since
  // the repo root was the usual cwd — a routine tidy of the root silently
  // undid itself on the next `--apply`. One canonical directory, with a README
  // recording what each artefact reverses.
  const rollbackDir = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    "rollbacks",
  );
  mkdirSync(rollbackDir, { recursive: true });
  const rollbackPath = path.resolve(
    rollbackDir,
    `resector-rollback-${Date.now()}.json`,
  );
  writeFileSync(
    rollbackPath,
    JSON.stringify(
      {
        generatedAt: new Date().toISOString(),
        // The artefact states its own truth, rather than encoding it in a
        // filename a crash cannot update. The rename to `.applied.json` still
        // happens, but it is now a convenience: on a PARTIAL apply (a throw
        // mid-chunk) or a failed rename, the file keeps the staged NAME while
        // rows are already written — so a responder reading only the name would
        // wrongly conclude "nothing happened" and not replay.
        status: "staged",
        target: maskedHost(uri) ?? "<unknown host>",
        note: "Replay: set sector back to previousSector for each id.",
        rows: move.map((r) => ({
          id: r.id,
          symbol: r.symbol,
          exchange: r.exchange,
          previousSector: r.sector,
          industry: r.industry,
          newSector: TARGET_SECTOR,
          via: r.via,
        })),
      },
      null,
      2,
    ),
    "utf8",
  );
  console.log(`\n  Rollback snapshot staged: ${rollbackPath}`);
  // Staged, not applied. An abort leaves this file behind describing writes
  // that never happened, and nothing distinguished it from a real snapshot —
  // so an incident responder replaying the wrong file would REVERT a legitimate
  // state. It is renamed to `.applied.json` only after the writes succeed.

  await confirmWrite(
    uri,
    opts.env ? `--env ${opts.env} (Secret Manager)` : "ambient DATABASE_URL",
  );

  // One updateMany for the whole set — sector is the only field changing and
  // the value is identical for every row. `industry` is deliberately left
  // alone: it is the EVIDENCE for this decision, and keeping it means the run
  // stays auditable afterwards.
  // Re-check the type AND chunk, matching the sibling script.
  //
  // The confirmation prompt above can block on a human for minutes, and the
  // nightly bhavcopy writer runs 21:00 IST — so a row can be typed DEBT and have
  // its sector cleared between the plan and here. Writing "Real Estate" onto it
  // then re-creates the bond-with-a-sector state this whole ticket exists to
  // remove, and the rollback file would restore the STALE planned value on top.
  // reclassify-instruments.ts added exactly this guard for exactly this reason
  // and resector did not get it.
  // Grouped by the SECTOR the plan read, so the write can pin it.
  //
  // Re-checking `instrumentType` alone guards one axis and leaves the other
  // open: this script decides from `sector`/`industry`, and between the plan and
  // the write the sector-enrichment worker or `stock-sector.ts` can write a real
  // sector onto a row that had none. The write then overwrote it with
  // "Real Estate" while the rollback snapshot recorded `previousSector: null`,
  // so a replay would DISCARD the concurrently-written value rather than restore
  // it. Same shape as the `series` axis in the sibling script.
  const NULL_SECTOR = "\u0000null";
  const bySector = new Map<string, { previous: string | null; ids: string[] }>();
  for (const m of move) {
    const key = m.sector ?? NULL_SECTOR;
    const g = bySector.get(key) ?? { previous: m.sector ?? null, ids: [] };
    g.ids.push(m.id);
    bySector.set(key, g);
  }

  let written = 0;
  const writtenIds: string[] = [];
  const CHUNK = 500;
  for (const { previous, ids: groupIds } of bySector.values()) {
    for (let i = 0; i < groupIds.length; i += CHUNK) {
      const chunk = groupIds.slice(i, i + CHUNK);
      const r = await prisma.instrumentMapping.updateMany({
        where: {
          id: { in: chunk },
          // Both axes: the type must still be eligible AND the sector must still
          // be the one the plan read.
          instrumentType: { in: ["EQUITY", "REIT"] },
          sector: previous === null ? null : previous,
        },
        data: { sector: TARGET_SECTOR },
      });
      written += r.count;
      if (r.count === chunk.length) writtenIds.push(...chunk);
      recordProgress(rollbackPath, written, writtenIds);
    }
  }
  if (written < move.length) {
    console.log(
      `\n  NOTE: ${move.length - written} of ${move.length} planned rows were ` +
        `NOT written — their instrumentType or sector changed between the plan ` +
        `and the write. That is the guard working; re-run to pick them up. The ` +
        `artefact's "writtenIds" lists ONLY the rows confirmed written, which is ` +
        `the safe set to replay — its "rows" field is the full PLANNED set and ` +
        `replaying that would revert the concurrent writer's legitimate work.`,
    );
  }
  const res = { count: written };

  console.log(`\n  Moved ${res.count} rows to "${TARGET_SECTOR}".`);
  // Promote the staged snapshot: from here on it describes writes that ACTUALLY
  // happened, which is the only kind that is safe to replay.
  const appliedPath = rollbackPath.replace(/\.json$/, ".applied.json");
  try {
    // Rewrite the CONTENT first, so the artefact is correct even if the rename
    // fails or the process dies immediately after.
    const snapshot = JSON.parse(readFileSync(rollbackPath, "utf8")) as Record<
      string,
      unknown
    >;
    snapshot.status = "applied";
    snapshot.appliedRows = res.count;
    snapshot.appliedAt = new Date().toISOString();
    writeFileSync(rollbackPath, JSON.stringify(snapshot, null, 2), "utf8");
    renameSync(rollbackPath, appliedPath);
    console.log(`  Rollback snapshot (APPLIED): ${appliedPath}`);
  } catch (e) {
    console.warn(
      `  Could not finalise the snapshot (${e instanceof Error ? e.message : e}). ` +
        `The writes DID happen; the file at ${rollbackPath} is still the ` +
        `recovery source — check its "status" field, not its name.`,
    );
  }

  console.log(`  Rollback: ${rollbackPath}\n`);

  await prisma.$disconnect();
}

main().catch((err) => {
  console.error("\n  FAILED:", err instanceof Error ? err.message : err);
  process.exit(1);
});
