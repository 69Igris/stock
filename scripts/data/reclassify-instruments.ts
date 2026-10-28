/**
 * Reclassify mistyped cash instruments — MONEY-1093.
 *
 * ## What it fixes
 *
 * `InstrumentMapping` holds ~22,090 active rows typed EQUITY. Measured on
 * prod, 11,795 of them have no usable sector, and they are not unclassified
 * equities — they are DEBT instruments the Zerodha dump types `EQ` like
 * everything else in the cash segment:
 *
 *   885PFL31    8.85% Piramal Finance 2031
 *   689IRFC31   6.89% IRFC 2031
 *   726NHAI38   7.26% NHAI 2038
 *   EPDPGSEC28  a G-Sec
 *
 * Worse, ~2,200 of them carry a REAL sector — "0795GOI32", a GOI bond,
 * labelled "Financial Services" — because two writers wrote whatever Yahoo or
 * Gemini returned. Those rows inflate every sector aggregate they appear in.
 *
 * ## How it decides
 *
 * It does NOT pattern-match symbols. That was tried and measured: the
 * candidate regex hit 2,236 wrong rows and recalled only 2,752 of 11,795,
 * because real equities start with digits (3MINDIA, 5PAISA, 63MOONS, 1STCUS)
 * and real bonds do not always look like bonds (EPDPGSEC28, CSAI240226).
 *
 * It uses the exchange's own settlement series/group, via
 * `classifyCashInstrument`. That field is now persisted by the bhavcopy sync
 * (see `planMetadataBackfill`), so this script is only as good as that
 * backfill's coverage — which is exactly why it reports its abstentions.
 *
 * ## MONEY-1298 — three more feed-supplied signals
 *
 * `series` is the stamped default "EQ" on every row nothing has sourced, so the
 * honest abstention above covered 12,541 of the 20,850 active EQUITY rows.
 * Measured on prod 2026-08-30, the real Indian cash-equity universe is 5,610
 * distinct symbols (8,083 ISIN-bearing rows: 3,184 NSE + 4,899 BSE) — ~61% of
 * the "equity" table is not equity. `classifyCashInstrument` now reads two more
 * columns, which this script must SELECT and now does:
 *
 *   segmentCode "INDICES"     213 rows -> INDEX   (NSE 136, BSE 77)
 *   NSE `-XX` symbol suffix  7,149 rows -> DEBT 6,172 / EQUITY 876 (untouched)
 *                                          / INVIT 21 / REIT 6 / UNKNOWN 72
 *   BSE stamped default,
 *   no ISIN, name === symbol 5,392 rows -> DEBT 5,288 / ABSTAIN 104
 *
 * The 876 EQUITY verdicts matter as much as the DEBT ones: they are the
 * `SYM-SM`/`-BE`/`-ST`/`-BZ` rows that sit beside a bare ISIN-bearing `SYM`,
 * and 446 of them carry 13,917 `daily_prices` rows plus 455 `latest_quotes` on
 * the SUFFIXED id. They are duplicates with real history attached, not bonds —
 * nothing here touches them, and nothing should deactivate them either.
 *
 * ## Safety
 *
 *   - DRY-RUN BY DEFAULT. `--apply` is required to write anything.
 *   - UNKNOWN classifications are SKIPPED, never retyped. An instrument whose
 *     series has never been observed must be left exactly as it is; retyping
 *     on a guess is how 2,200 bonds got a sector in the first place.
 *   - Clearing `sector`/`industry` DESTROYS data — those values exist nowhere
 *     else, and a retyped row is excluded from re-enrichment (the enrichment
 *     pipeline queries `instrumentType: "EQUITY"` only). So `--apply` writes a
 *     `reclassify-rollback-<ts>.json` snapshot of every field it overwrites
 *     BEFORE writing, into `scripts/data/rollbacks/` (repo-relative, NOT the
 *     cwd — see that directory's README.md). That file is the recovery path;
 *     keep it.
 *   - Retypes DEBT only. REIT/INVIT are also mistyped but no consumer matches
 *     those types yet, so retyping them would drop their news/filings sync.
 *   - EVERY `--apply` requires typing "yes", whichever database is targeted,
 *     and echoes the masked target host. Keying that off `--env prod` would
 *     have missed the `DATABASE_URL=... --apply` invocation documented below.
 *
 * ## Usage
 *
 *   # Preferred — no tsx invocation to remember. Args pass straight through.
 *   yarn data:reclassify                      # dry run, ambient DATABASE_URL
 *   yarn data:reclassify --env qa             # dry run against QA
 *   yarn data:reclassify --env prod --apply   # WRITES (always prompts)
 *
 *   # dry run (default) — prints the full plan, writes nothing
 *   DATABASE_URL=... npx tsx scripts/data/reclassify-instruments.ts
 *
 *   # apply
 *   DATABASE_URL=... npx tsx scripts/data/reclassify-instruments.ts --apply
 *
 *   # env-aware (fetches DATABASE_URL from Secret Manager like seed-env.sh)
 *   npx tsx scripts/data/reclassify-instruments.ts --env qa --apply
 *
 *   Options
 *     --apply            actually write (default: dry run)
 *     --env <qa|prod>    fetch DATABASE_URL from GCP Secret Manager
 *     --limit <n>        cap rows examined (default: all)
 *     --keep-sector      retype only; do NOT clear the bogus sector
 */

import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";
import { execFileSync } from "child_process";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, "..", "..", ".env") });

/**
 * `@usemoney/database` is imported LAZILY, and that is load-bearing.
 *
 * It builds its PrismaClient at MODULE scope and bakes `process.env.DATABASE_URL`
 * into the constructor (`packages/database/client.ts:40-47`). ESM evaluates every
 * static import BEFORE any statement in this file's body — including
 * `dotenv.config()` above and the `--env` resolution in `main()`. So a STATIC
 * import here pinned the client to whatever `DATABASE_URL` the shell happened to
 * export, silently ignoring `--env` while `confirmWrite` echoed the host that
 * `--env` had resolved. The operator typed "yes" to one database and wrote to
 * another. It only appeared to work when the shell had no DATABASE_URL, which is
 * the worst kind of bug: correct on the maintainer's machine.
 *
 * Guarded by a static-scan test — see
 * `packages/core/__tests__/market-data/ops-script-db-target.test.ts`.
 */
type PrismaLike = (typeof import("@usemoney/database"))["default"];
let prisma: PrismaLike | null = null;
// Narrow subpath rather than the market-data barrel: the tightest import that
// works, per the standing subpath rule. It also makes the package.json export
// live instead of dead wiring.
import {
  classifyCashInstrument,
  type CashInstrumentClass,
} from "@usemoney/core/market-data/instrument-classification";
// MONEY-1196 — the readiness decision, pure and unit-tested. Kept out of this
// script on purpose: the bug it fixes was invisible precisely because the
// arithmetic lived inline where nothing could assert on it.
//
// The SUBPATH, not `@usemoney/core/market-data`. The barrel pulls the Prisma
// client in as a VALUE, and this script must not construct a DB client before
// `--env` has been resolved — otherwise it would connect to whatever ambient
// DATABASE_URL happens to be set, which for a script that retypes instruments
// and clears sectors is the wrong database by default. There is a test
// enforcing exactly this ("ops scripts never construct a DB client before
// resolving --env"), and it caught the barrel import here.
import { judgeSeriesReadiness } from "@usemoney/core/market-data/series-readiness";
import { writeFileSync, renameSync, readFileSync, mkdirSync } from "fs";

/**
 * Classes this script will retype. DEBT only — deliberately NOT the full
 * `isNonEquityClass` set.
 *
 * `REIT`/`INVIT` are genuinely mistyped too, and are still excluded — but the
 * reason stated here previously was WRONG and is corrected.
 *
 * The old claim was "NOTHING in the repo branches on instrumentType REIT or
 * INVIT (grepped …)". That is false: `FUND_INSTRUMENT_TYPES = ["ETF","REIT",
 * "INVIT"]` (market-data/instruments/types.ts) drives production queries in
 * discover.service, discover-market.service, screener.service, match-score and
 * discover-indices. The grep that "proved" it required `instrumentType` and
 * `"REIT"` on the same line, and the constant indirection defeated it.
 *
 * The real reason to leave them alone is narrower and still holds: the news,
 * filings, BSE-announcement and financial-data syncs all filter
 * `instrumentType: "EQUITY"`, so retyping the ~7 real trusts (EMBASSY,
 * MINDSPACE, BIRET, NXST, INDIGRID, IRBINVIT, PGINVIT) would drop their news
 * and filings coverage. Unlike bonds, those ARE securities users hold and
 * expect coverage for — so the trade is a real one, not a free win.
 *
 * NOTHING ELSE WILL DO IT EITHER — this is a real residual, not a gap something
 * else covers.
 *
 * An earlier version of this note said the exclusion was "only partial in
 * practice", because Zerodha's `mapToUpdate` kept a positively-identified type
 * and so the nightly sync would type name-matched trusts REIT/INVIT anyway.
 * That was true when written and was made false by this same branch: the
 * oscillation fix strips `instrumentType` from the update payload
 * unconditionally. Combined with `BACKFILL_TYPES = {DEBT, ETF}` and
 * `mintMissingTrustInstruments` covering only NSE series RR/IV — while Kite
 * lists the trusts on BSE — nothing can now move EMBASSY, MINDSPACE, BIRET,
 * NXST, INDIGRID, IRBINVIT or PGINVIT off EQUITY.
 *
 * That is a deliberate, documented residual: retyping them would drop the ~7
 * real trusts out of the news, filings, BSE-announcement and financial-data
 * syncs, which all gate on `instrumentType: "EQUITY"`. It needs its own ticket
 * to widen those consumers first. The reassurance is removed because an
 * operator reading it would conclude no action was needed.
 */
const RETYPE_CLASSES = new Set<CashInstrumentClass>(["DEBT", "INDEX"]);

/*
 * INDEX joined DEBT in MONEY-1298, and the REIT/INVIT reasoning above is
 * exactly why it is safe to.
 *
 * That exclusion turns on a real cost: retyping the ~7 trusts drops securities
 * users HOLD out of the news, filings, BSE-announcement and financial-data
 * syncs, which all gate on `instrumentType: "EQUITY"`. An index row has no such
 * cost — nobody holds NIFTY 50, there are no filings to lose, and its sector is
 * either absent or the literal "N/A". The trade is not a trade.
 *
 * It is also the one retype that ADDS a surface rather than removing one.
 * `getIndices` (discover.service.ts) and `getInstrumentsBySymbolsAction`
 * (discover-indices.ts) both query `instrumentType: "INDEX"`, and prod holds
 * ZERO such rows today — measured 2026-08-30: EQUITY 20,850, DEBT 2,428,
 * ETF 541, and nothing else. Both surfaces return an empty list because the
 * 213 index rows are sitting in the equity table.
 *
 * `INDEX` is a pre-existing `InstrumentMapping.instrumentType` value, not a new
 * one: it is in the schema comment, in `INSTRUMENT_TYPE_MAP` (Kite `IF` ->
 * INDEX), in `quote-service.ts`'s QUOTABLE_TYPES and in `instrument-sync.ts`.
 */

const GCP_PROJECT = "stock-book-483718";

interface Options {
  apply: boolean;
  env: "qa" | "prod" | null;
  limit: number | null;
  clearSector: boolean;
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
const KNOWN_FLAGS = new Set("--apply,--env,--limit,--keep-sector".split(","));

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
 * written.
 *
 * The artefact used to be written once, before the loop, with
 * `status: "staged"`, and promoted to "applied" only AFTER the loop inside the
 * same try as the rename. The chunked writes have no transaction, so a throw at
 * chunk 7 of 40 left ~3,000 rows retyped and their sectors destroyed, while the
 * file on disk still said "staged" and stdout printed only "Failed: <message>" —
 * the per-class log line sits after the loop and never ran, and `written` was
 * never persisted anywhere. An incident responder reading either signal would
 * conclude nothing happened and not replay.
 *
 * `status` goes to "applying" the moment the first chunk lands and carries the
 * ids confirmed written so far, so a crashed run leaves a file that is
 * immediately actionable. Failures here are swallowed deliberately: losing
 * progress metadata must never abort a run that is mid-write.
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
  // A typo'd limit must NOT silently mean "the whole catalogue". `--limit 5oo`
  // and `--limit --apply` both parse to NaN, which is falsy, which previously
  // dropped `take` and processed every row.
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
  // `--limit` and `--apply` cannot both be honoured.
  //
  // The data-readiness gate measures the share of BSE rows whose `series` is
  // still the stamped default, and it measures it over the rows the query
  // RETURNED. With `--limit N` over `orderBy: { id: "asc" }` that is a biased
  // prefix of the collection, not a sample — a small limit can contain no BSE
  // rows at all, which collapses `distinctSeries` to 0 and trips the gate, so
  // the documented `--limit N --apply` simply could not work for small N.
  //
  // Refusing is the honest resolution: the alternative is a gate measured on
  // evidence that does not represent what is about to be written. `--limit` is
  // still exactly right for sizing up a dry run.
  if (apply && limit !== null) {
    throw new Error(
      "--limit cannot be combined with --apply: the data-readiness gate is " +
        "measured over the rows the query returns, and a limited prefix is not " +
        "a representative sample. Use --limit for the dry run to see scale, " +
        "then --apply without it.",
    );
  }

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
    clearSector: !has("--keep-sector"),
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
 * Confirm before ANY write, whichever database is targeted.
 *
 * The first version only prompted when `--env prod` was passed. That keyed the
 * safety gate off a CLI FLAG rather than off the database actually being
 * written to — and this file's own usage examples show
 * `DATABASE_URL=... --apply` as a supported invocation, which leaves
 * `opts.env` null. So an operator who exported a prod connection string and
 * ran `--apply` would retype ~11.8k rows and clear their sectors with no
 * prompt at all, while the docstring promised otherwise.
 *
 * Detecting "is this prod" from a connection string is unreliable (hosts
 * change, QA and prod may share a cluster). Confirming on every write removes
 * the detection problem entirely, and it is cheap: this script is run by hand,
 * a handful of times, and the destructive path is the whole point of it.
 * The masked host is echoed so the operator can see what they are about to
 * hit rather than trusting a flag.
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
  process.stdout.write(
    `\n⚠️  This will WRITE to a database.\n` +
      `      target : ${maskedHost(uri) ?? "<unknown host>"}\n` +
      `      source : ${envLabel}\n` +
      `   It retypes instruments away from EQUITY and CLEARS their sector.\n` +
      `   Type 'yes' to continue: `,
  );
  const answer = await new Promise<string>((resolve) => {
    process.stdin.once("data", (d) => resolve(String(d).trim()));
  });
  if (answer !== "yes") {
    // Non-zero: an abort is NOT success. With exit(0) a wrapper's `&&` treats
    // "the operator said no" as "step completed" and runs the next step.
    console.log("Aborted.");
    process.exit(1);
  }
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

  // The single value that both the connection and the confirmation prompt are
  // derived from, so they can never disagree about which database this is.
  const resolvedUri = process.env.DATABASE_URL;

  // Import ONLY now — after the URL is final. See the note on the lazy import.
  const db = (await import("@usemoney/database")).default;
  prisma = db;

  console.log("=".repeat(70));
  console.log(
    `  Instrument reclassification — ${opts.apply ? "APPLY" : "DRY RUN"}`,
  );
  console.log(`  target: ${maskedHost(resolvedUri) ?? "<unknown host>"}`);
  console.log("=".repeat(70));

  // EQUITY **and** DEBT, and the DEBT half is load-bearing.
  //
  // This used to query EQUITY only, on the reasoning that only an EQUITY row can
  // be MIS-typed as equity. That was true until the bhavcopy worker began typing
  // rows DEBT automatically — after which every bond that TRADES was retyped
  // nightly and thereby dropped out of this query while KEEPING its bogus
  // sector. Nothing else clears it: sector-enrichment only touches EQUITY rows,
  // and this script is the only writer that clears `sector`/`industry`.
  //
  // NOTE this population now shrinks on its own: the nightly bhavcopy backfill
  // clears sector/industry in the SAME write that types a row DEBT, so a bond
  // first seen after that deploy never reaches this script. What is left here is
  // the backlog — rows typed before the change, and rows that have not traded
  // since — plus the rollback snapshot the worker cannot write.
  //
  // The failure was exactly inverted from what you would want. The more liquid a
  // bond, the more likely it trades; the more likely it trades, the sooner it is
  // auto-typed; and the more likely a user actually holds it — so the bonds whose
  // wrong sector is most visible on the holdings page (which joins
  // `InstrumentMapping.sector` at read time with NO instrumentType filter, and
  // feeds sector concentration and risk) were precisely the ones this script
  // could no longer reach. It was invisible in operation too: the dry run prints
  // a shrinking "Would retype N rows", which reads as progress.
  const rows = await db.instrumentMapping.findMany({
    where: { isActive: true, instrumentType: { in: ["EQUITY", "DEBT"] } },
    select: {
      id: true,
      symbol: true,
      name: true,
      exchange: true,
      series: true,
      // MONEY-1298 — decision inputs for the three rules added there. Selecting
      // them is not optional bookkeeping: `classifyCashInstrument` treats an
      // ABSENT `isin` as "no ISIN", so a caller that forgets the column hands
      // the classifier a fabricated absence and every ISIN-bearing NSE row
      // becomes eligible for the symbol-suffix recovery.
      isin: true,
      segmentCode: true,
      sector: true,
      industry: true,
      instrumentType: true,
    },
    // Deterministic, so a `--limit` dry run and the subsequent apply are the
    // SAME rows. Without it, natural order over a collection the nightly writers
    // mutate means the operator confirms one sample and writes another.
    orderBy: { id: "asc" },
    ...(opts.limit ? { take: opts.limit } : {}),
  });
  console.log(`\nExamined ${rows.length} active EQUITY + DEBT rows.\n`);

  const byClass = new Map<CashInstrumentClass, number>();
  const byReason = new Map<string, number>();
  const retype: Array<{
    id: string;
    symbol: string;
    exchange: string;
    series: string | null;
    /** MONEY-1298 — pinned at write time alongside `series`. */
    segmentCode: string | null;
    /** MONEY-1298 — true when the row already carried an ISIN at PLAN time. */
    hadIsin: boolean;
    klass: CashInstrumentClass;
    reason: string;
    hadSector: string | null;
    hadIndustry: string | null;
    /** Current stored type — "DEBT" means only the sector needs clearing. */
    from: string;
  }> = [];

  for (const r of rows) {
    const res = classifyCashInstrument({
      symbol: r.symbol,
      name: r.name,
      exchange: r.exchange,
      series: r.series,
      isin: r.isin,
      segmentCode: r.segmentCode,
    });
    byClass.set(res.klass, (byClass.get(res.klass) ?? 0) + 1);
    byReason.set(res.reason, (byReason.get(res.reason) ?? 0) + 1);

    if (RETYPE_CLASSES.has(res.klass)) {
      // Already the right type? Then there is nothing to retype, but a bogus
      // sector may still be sitting on it — which is the whole reason DEBT rows
      // are in the query. Skip only when there is genuinely nothing to do.
      const alreadyTyped = r.instrumentType === res.klass;
      if (alreadyTyped && !r.sector && !r.industry) continue;

      retype.push({
        id: r.id,
        symbol: r.symbol,
        exchange: r.exchange,
        series: r.series,
        segmentCode: r.segmentCode,
        hadIsin: String(r.isin ?? "").trim() !== "",
        klass: res.klass,
        reason: res.reason,
        hadSector: r.sector,
        hadIndustry: r.industry,
        from: r.instrumentType,
      });
    }
  }

  console.log("Classification:");
  for (const [k, n] of [...byClass].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${k.padEnd(8)} ${String(n).padStart(6)}`);
  }

  // ── Data-readiness gate ──
  //
  // The classifier is only as good as `series`, and `series` defaults to the
  // stamped string "EQ" on every row. On BSE that is detectable (BSE never
  // issues "EQ" as a group, so those rows come back UNKNOWN). On NSE it is
  // NOT: "EQ" is a real NSE series, so an un-sourced row is indistinguishable
  // from a genuine main-board equity and gets classified EQUITY on no
  // evidence at all.
  //
  // That is currently harmless — this script only retypes AWAY from EQUITY, so
  // a false EQUITY produces no write — but it would let real NSE debt hide,
  // and it would report a confidence the data does not support. So measure how
  // much of the series column is still the default and say so plainly.
  // MONEY-1196 — the decision now lives in a pure, unit-tested function, and it
  // counts over ALL ACTIVE BSE ROWS rather than only those still typed EQUITY.
  //
  // The previous comment here already diagnosed the mechanism — "the denominator
  // drains as BSE rows are typed DEBT — so the ratio only RISES" — and then
  // fixed the wrong half of it. Scoping the question to BSE was necessary ("EQ"
  // is a legitimate NSE main-board series, so counting NSE made every real
  // equity look unsourced forever) but the population stayed EQUITY-only, and
  // retyping is exactly what removes a row from it. Every successful run
  // therefore tightened the gate that authorises the run.
  //
  // Measured on QA either side of ONE apply: 5,581/11,374 = 49% PASS, then
  // 5,581/10,438 = 53% FAIL. QA passed by a single point, did the work, and
  // locked itself out; prod at 51% never passed at all. A guard that
  // anti-correlates with the thing it guards is worse than no guard, because it
  // looks like caution.
  //
  // A retype changes `instrumentType` but never `isActive`, so the new
  // population is invariant under the operation — the reading moves only when
  // the ENRICHER sources more of the column, which is what readiness means.
  const readiness = judgeSeriesReadiness(rows);
  const distinctSeries = { size: readiness.distinctSeries };
  const stampedDefault = readiness.stampedDefault;
  const undecided = { length: readiness.population };
  const defaultShare = readiness.defaultShare;

  if (!readiness.ready) {
    console.log(
      `\n${"!".repeat(70)}\n` +
        `  SERIES DATA IS NOT READY — this run is NOT actionable.\n` +
        `${"!".repeat(70)}\n` +
        `  ${stampedDefault}/${undecided.length} undecided BSE rows (${Math.round(defaultShare * 100)}%) still carry the\n` +
        `  stamped\n` +
        `  default series "EQ", and only ${distinctSeries.size} distinct series exist in the column.\n` +
        `  A real universe has ~14 BSE groups plus ~10 NSE series.\n` +
        `\n  The classifier reads \`series\`, so until the bhavcopy sync has\n` +
        `  populated it, most rows either abstain (BSE, detectably) or are\n` +
        `  classified EQUITY on no evidence (NSE, NOT detectable).\n` +
        `\n  Do this first:\n` +
        `    1. Deploy the worker so the bhavcopy sync persists series + isin\n` +
        `       (\`./scripts/ops/setup-infra.sh <env> --only deploy\`).\n` +
        `    2. Wait for BSE coverage — ONE instrument-sync run (22:00 IST)\n` +
        `       settles it, because the scrip master covers the whole active\n` +
        `       BSE universe. BSE rows still showing the default here mean that\n` +
        `       sync has not run since the enricher was deployed: read its log,\n` +
        `       do not wait.\n` +
        `\n` +
        `       NSE DEBT NO LONGER DEPENDS ON THIS COLUMN (MONEY-1298).\n` +
        `       It used to, and this message used to say so: the bhavcopy\n` +
        `       parser drops every NSE debt series (GS/TB/SG, N*/Y*/Z*) at parse\n` +
        `       time via keepSeries, no other writer supplies one, so ~4,188 NSE\n` +
        `       bonds sat at series "EQ" and were read as CONFIDENT equity.\n` +
        `       They are now decided from the NSE series carried in the TRADING\n` +
        `       SYMBOL (664UP30-SG, 667GS2050-GS, 965SCL25C-N0), which Kite\n` +
        `       reproduces verbatim — 6,172 DEBT verdicts on prod. This gate\n` +
        `       still measures BSE only, and it still gates the whole run.\n` +
        `    3. Re-run this dry run and check the distinct-series count.\n`,
    );
    if (opts.apply) {
      console.log(
        "  REFUSING to --apply against unsourced series data. Re-run once the\n" +
          "  backfill has landed. (Nothing was written.)\n",
      );
      return;
    }
  }

  const unknown = byClass.get("UNKNOWN") ?? 0;
  if (unknown > 0) {
    console.log(
      `\n  NOTE ${unknown} rows are UNKNOWN and will NOT be touched — "no` +
        `\n  series observed yet". Where the series comes from differs by` +
        `\n  exchange, so the wait differs too:` +
        `\n    BSE  — the scrip master covers the WHOLE active universe, so one` +
        `\n           instrument-sync run (22:00 IST) settles BSE. If BSE rows` +
        `\n           are still UNKNOWN here, that sync has not run since the` +
        `\n           enricher was deployed — check its log, do not just wait.` +
        `\n    NSE  — do NOT wait for the series COLUMN; it never fills.` +
        `\n           The bhavcopy parser drops every NSE debt series at parse` +
        `\n           time (keepSeries keeps only NSE_CASH_SERIES), and no other` +
        `\n           writer supplies one — so NSE bonds sit at series "EQ"` +
        `\n           forever. Since MONEY-1298 that no longer hides them: the` +
        `\n           series is recovered from the TRADING SYMBOL's -XX suffix,` +
        `\n           so they are decided now, not waited for. What is left` +
        `\n           UNKNOWN here is the 72 suffixes NSE has published no` +
        `\n           meaning for (-SF, -RL, -D1, -W1, and the A*/B* codes) —` +
        `\n           read the circular; do not guess a family for them.` +
        `\n  Re-run this script later rather than forcing a decision now.`,
    );
  }

  // Why clearing the sector matters, stated accurately. An earlier version of
  // this reasoning claimed "some surfaces group by sector without filtering
  // type" — that is FALSE, and a reviewer disproved it: every catalog-wide
  // sector aggregate (discover-heatmap, discover-sectors, discover.service,
  // discover-market.service, screener.service) filters `instrumentType:
  // "EQUITY"` explicitly, and there is no `instrumentMapping.groupBy` anywhere.
  //
  // The real, narrower leak is on the read path for what a user actually OWNS:
  // the holdings page resolves a stock's sector by a READ-TIME JOIN to
  // `InstrumentMapping.sector` (see `sector-enrichment.ts` — "stock sector is
  // shown on the holdings page via a read-time join"), and the holding-scoped
  // sector groupings (risk.service, holdings-logic, roast/portfolio-query,
  // investor-rollup-logic) do NOT filter instrumentType. So a user holding
  // 0795GOI32 sees a GOI bond presented under "Financial Services", and it
  // counts toward that user's sector concentration and risk numbers.
  //
  // That is worth fixing, but it is a per-holding display/risk issue, not the
  // catalog-wide corruption the old comment implied.
  const withBogusSector = retype.filter((r) => r.hadSector);
  const needsRetype = retype.filter((r) => r.from === "EQUITY");
  const sectorOnly = retype.filter((r) => r.from !== "EQUITY");
  console.log(`\nWould change ${retype.length} rows:`);
  console.log(`  ${needsRetype.length} retyped away from EQUITY`);
  console.log(
    `  ${sectorOnly.length} already correctly typed — sector/industry cleanup only` +
      `\n    (these were auto-typed by the nightly bhavcopy backfill and would` +
      `\n     otherwise keep a bogus sector forever)`,
  );
  console.log(
    `  ...of which ${withBogusSector.length} currently carry a sector that will be cleared` +
      `${opts.clearSector ? "" : " (SKIPPED — --keep-sector)"}.`,
  );

  // Every reason, not a curated prefix list.
  //
  // The filter used to name two prefixes explicitly, which meant MONEY-1298's
  // three new reasons — `segment-indices`, `nse-symbol-series-*` and
  // `bse-unenriched-code` — would each have been silently absent from the only
  // report an operator reads before typing "yes". A verdict that cannot appear
  // in the audit output is a verdict nobody audits, and this script's whole
  // safety story is "the human reads the plan". Excluding `name-*` is kept:
  // those are heuristics, and their counts are already in the class table.
  console.log("\nTop reasons:");
  for (const [reason, n] of [...byReason]
    .filter(([k]) => !k.startsWith("name-"))
    .sort((a, b) => b[1] - a[1])
    .slice(0, 15)) {
    console.log(`  ${reason.padEnd(34)} ${String(n).padStart(6)}`);
  }

  console.log("\nSample of rows to retype:");
  for (const r of retype.slice(0, 12)) {
    const sec = r.hadSector ? `  sector="${r.hadSector}" -> null` : "";
    console.log(
      `  ${r.exchange} ${r.symbol.padEnd(16)} series=${String(r.series).padEnd(4)} -> ${r.klass.padEnd(6)} (${r.reason})${sec}`,
    );
  }

  if (!opts.apply) {
    console.log(
      "\nDRY RUN — nothing written. Re-run with --apply to make these changes.\n",
    );
    return;
  }

  // ── Rollback snapshot ──
  //
  // The earlier version of this comment claimed the change was "reversible
  // because nothing is deleted". That was wrong, and a reviewer was right to
  // call it: clearing `sector`/`industry` DESTROYS values that exist nowhere
  // else. There is no history column on InstrumentMapping, and — worse — the
  // enrichment pipeline only ever queries `instrumentType: "EQUITY"`
  // (`sector-enrichment.ts`), so a row retyped to DEBT will never be
  // re-enriched while it stays DEBT. A false positive would lose its sector
  // permanently, and even after a manual retype back to EQUITY the next pass
  // (up to a week later) fetches a FRESH value from Yahoo, not the original.
  //
  // So: dump every field this run will overwrite, before overwriting it. That
  // turns "reversible in principle" into an actual file someone can replay.
  //
  // Anchored on THIS FILE (`scripts/data/rollbacks/`), not on `process.cwd()`.
  // cwd is not a stable anchor for this script: `yarn data:reclassify` runs it
  // from the repo root, `scripts/ops/run-market-data-job.sh` invokes it by a
  // RELATIVE `scripts/data/...` path (so it too assumes the root, without
  // guaranteeing it), and the documented `npx tsx scripts/data/…` form runs
  // from wherever the operator happens to be. Writing to cwd therefore
  // scattered the ONLY copy of the destroyed values across whatever directory
  // that was — and because the repo root was the usual one, a routine tidy of
  // the root silently undid itself on the next `--apply`. One canonical
  // directory, with a README explaining what each artefact reverses.
  const rollbackDir = path.resolve(__dirname, "rollbacks");
  mkdirSync(rollbackDir, { recursive: true });
  const rollbackPath = path.resolve(
    rollbackDir,
    `reclassify-rollback-${Date.now()}.json`,
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
        target: maskedHost(resolvedUri) ?? "<unknown host>",
        note: "Replay: set instrumentType/sector/industry back to these values.",
        rows: retype.map((r) => ({
          id: r.id,
          symbol: r.symbol,
          exchange: r.exchange,
          previousInstrumentType: r.from,
          previousSector: r.hadSector,
          previousIndustry: r.hadIndustry,
          newInstrumentType: r.klass,
          reason: r.reason,
        })),
      },
      null,
      2,
    ),
    "utf8",
  );
  console.log(`\nRollback snapshot staged: ${rollbackPath}`);
  // Staged, not applied. An abort leaves this file behind describing writes
  // that never happened, and nothing distinguished it from a real snapshot —
  // so an incident responder replaying the wrong file would REVERT a legitimate
  // state. It is renamed to `.applied.json` only after the writes succeed.

  // Confirm LAST: after the readiness gate, after the plan has been printed,
  // and after the rollback file exists — so the operator is agreeing to a
  // specific, visible change set that is already recoverable.
  await confirmWrite(
    resolvedUri,
    opts.env ? `--env ${opts.env} (Secret Manager)` : "ambient DATABASE_URL",
  );

  // Apply, grouped by (target type, PLANNED SERIES) so this is a handful of
  // updateMany calls rather than one per row — and so the write can pin the
  // field the plan actually decided from.
  //
  // The previous grouping was by class alone, and the WHERE re-checked
  // `instrumentType`. That guards the wrong axis: the classification input is
  // `series`, and nothing re-checked it. The sequence that breaks is not
  // hypothetical — it is the DESIGNED first run:
  //
  //   21:50  operator runs `--env prod --apply`; the plan reads `series`
  //   21:5x  the rollback snapshot is written, `confirmWrite` blocks on a human
  //          (the docstring explicitly expects this to take minutes)
  //   22:00  `instrument-sync-daily` fires. The NEW BSE scrip-master enricher
  //          rewrites `series` across the whole active BSE universe (~12,600
  //          rows), so a stale/wrong "F" becomes "B"
  //   22:0x  the operator types yes. The row is still EQUITY, so the old guard
  //          MATCHED, and a real equity was typed DEBT with its sector and
  //          industry destroyed — on the authority of a series value that no
  //          longer exists in the database.
  //
  // Note the timing the old comment got wrong too: it cited the 21:00 bhavcopy,
  // but the writer with by far the largest `series` blast radius runs at 22:00,
  // AFTER it. And the first prod `--apply` is by design run right after
  // deploying that enricher — the single highest-churn moment this column will
  // ever see.
  //
  // `series` is nullable, so the key uses a sentinel for null rather than
  // dropping those rows: a null-series row planned as DEBT still has to be
  // pinned to "still null" at write time.
  //
  // MONEY-1298 added two more decision inputs, so two more axes are pinned.
  // The reasoning is identical and the 22:00 race is the SAME race:
  //
  //   `isin`        — the NSE/BSE master enrichers write it, and every new rule
  //                   is gated on its ABSENCE. A row that gained an ISIN
  //                   between plan and write is one an exchange cash-equity
  //                   master has just claimed, which is precisely the evidence
  //                   that it is NOT a bond. Pinned only for rows planned
  //                   WITHOUT one: enrichers add ISINs and never remove them,
  //                   and the pre-existing BSE group-F/G rule legitimately
  //                   retypes ISIN-BEARING rows.
  //   `segmentCode` — Zerodha's `mapToUpdate` narrows away `series` and
  //                   `instrumentType` but KEEPS `segmentCode`, so the 22:00
  //                   sync can rewrite it, and it is what the INDEX rule reads.
  //
  // `name` is deliberately NOT pinned, and that is a stated residual rather
  // than an oversight. Pinning it would put ~5,288 distinct values in the group
  // key — one `updateMany` per row — and the transition that would matter is a
  // bond acquiring a company NAME in the Kite dump, which is not something that
  // happens to a bond. The `isin` pin covers the direction that does: a row
  // becoming a real listed security acquires an ISIN from its exchange master.
  const NULL_SERIES = "\u0000null";
  const NULL_SEGMENT = "\u0000nullseg";
  /**
   * "This optional string column is still EMPTY."
   *
   * A bare `{ f: null }` on Prisma-Mongo is an equality against an EXPLICIT
   * JSON null and never reaches a document where the key was never written —
   * `prisma db push` creates indexes, not fields. `isSet: false` is the only
   * spelling that does. All three arms are needed because the classifier treats
   * absent, null and `""` identically, so the write guard has to as well or it
   * would skip rows the plan legitimately decided.
   * See apps/web/__tests__/meta/prisma-null-vs-isset.test.ts.
   */
  const stillEmpty = (field: "series" | "isin" | "segmentCode") => ({
    OR: [{ [field]: { isSet: false } }, { [field]: null }, { [field]: "" }],
  });
  const byTarget = new Map<
    string,
    {
      klass: CashInstrumentClass;
      series: string | null;
      segmentCode: string | null;
      hadIsin: boolean;
      ids: string[];
    }
  >();
  for (const r of retype) {
    const key =
      `${r.klass}|${r.series ?? NULL_SERIES}` +
      `|${r.segmentCode ?? NULL_SEGMENT}|${r.hadIsin ? "isin" : "noisin"}`;
    const g = byTarget.get(key) ?? {
      klass: r.klass,
      series: r.series,
      segmentCode: r.segmentCode,
      hadIsin: r.hadIsin,
      ids: [],
    };
    g.ids.push(r.id);
    byTarget.set(key, g);
  }

  let written = 0;
  const writtenIds: string[] = [];
  const perClass = new Map<
    CashInstrumentClass,
    { planned: number; written: number }
  >();
  for (const {
    klass,
    series,
    segmentCode,
    hadIsin,
    ids,
  } of byTarget.values()) {
    // Chunked: a 9k-element `$in` is close to Mongo's practical limit and a
    // single failure would lose the whole batch.
    for (let i = 0; i < ids.length; i += 500) {
      const chunk = ids.slice(i, i + 500);
      const res = await db.instrumentMapping.updateMany({
        // EVERY axis the plan classified from is re-checked: the type we
        // planned FROM, and the `series` / `segmentCode` / ISIN-absence we
        // CLASSIFIED FROM. A row whose evidence changed since the plan no
        // longer matches, so it is skipped rather than retyped on stale
        // evidence — and the shortfall is reported below instead of hidden.
        where: {
          id: { in: chunk },
          instrumentType: { in: ["EQUITY", "DEBT"] },
          AND: [
            series === null || series === ""
              ? stillEmpty("series")
              : { series },
            segmentCode === null || segmentCode === ""
              ? stillEmpty("segmentCode")
              : { segmentCode },
            ...(hadIsin ? [] : [stillEmpty("isin")]),
          ],
        },
        data: {
          instrumentType: klass,
          // Clearing the sector is the point: a bond labelled "Financial
          // Services" corrupts every aggregate that groups by sector, and it
          // Cleared because a bogus sector on a bond is visible where it
          // matters most: the holdings page joins InstrumentMapping.sector at
          // READ time with no instrumentType filter, so a user holding the bond
          // sees it counted in their sector concentration and risk numbers.
          ...(opts.clearSector ? { sector: null, industry: null } : {}),
        },
      });
      written += res.count;
      if (res.count === chunk.length) {
        // Only a FULL match means these exact ids were written. A partial match
        // means a concurrent writer moved some of them, and we cannot tell which
        // — so none of the chunk goes into the replayable set.
        writtenIds.push(...chunk);
      }
      // Persist progress after EVERY chunk. There is no transaction here, so a
      // throw at chunk 7 of 40 leaves ~3,000 rows written; without this the
      // artefact still said "staged" and stdout said nothing, and a responder
      // reading either would conclude nothing happened and not replay.
      recordProgress(rollbackPath, written, writtenIds);
    }
    const acc = perClass.get(klass) ?? { planned: 0, written: 0 };
    acc.planned += ids.length;
    perClass.set(klass, acc);
  }

  for (const [klass, acc] of perClass) {
    // Report what was WRITTEN, not what was planned. Logging `ids.length` here
    // is the exact defect this branch fixed in bhavcopy and resector: a planned
    // count reads as a success count.
    console.log(`  ${klass}: ${acc.planned} planned`);
  }
  if (written < retype.length) {
    console.log(
      `\n  NOTE: ${retype.length - written} of ${retype.length} planned rows ` +
        `were NOT written — their instrumentType or series changed between the ` +
        `plan and the write (the nightly writers run 21:00 and 22:00 IST). ` +
        `That is the guard working. Re-run to pick them up on fresh evidence.`,
    );
  }

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
    snapshot.appliedRows = written;
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

  console.log(`\nApplied. ${written} rows updated.\n`);
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
