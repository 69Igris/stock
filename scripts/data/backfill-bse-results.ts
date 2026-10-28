/**
 * Backfill BSE results filings for the BSE-ONLY cohort — MONEY-1255
 * ==========================================================================
 *
 * `bse-announcements-sync` runs a 2-day trailing window. It now works (the
 * `strCat=-1` defect is fixed), but a window cannot reach backwards, and the
 * table it writes into has **zero rows** — the job never wrote one. This walks
 * BSE's announcement archive PER SCRIP over a wide window and lands the
 * `Result` + `Integrated Filing` filings the daily job will never see.
 *
 * ## Why the BSE-ONLY cohort
 *
 * `workers/CLAUDE.md` records the gap in `stock-document-sync`: a BSE-only
 * symbol is selected, counted as `noNseListing`, and skipped, because **no
 * producer in this repo can give a BSE-only company an `annual_report` /
 * `quarterly_result` / `financial_statement`**. Every other document source we
 * run is NSE-keyed. So this cohort has no financial documents by construction,
 * and it is also the only cohort where a backfill cannot duplicate something a
 * different job would have produced anyway.
 *
 * ## DRY RUN BY DEFAULT. `--apply` opts in.
 *
 * The opposite contract from `xbrl-backfill.ts` (which applies by default and
 * takes `--dry-run`) and the same one as `repair-stock-document-queue.ts` /
 * `doc-financials-reconcile.ts`. If this is ever registered in
 * `scripts/ops/run-market-data-job.sh` the row **MUST** declare
 * `APPLY_FLAG="--apply"`: that wrapper CONSUMES `--apply` and re-emits only the
 * declared flag, so a missing declaration makes the flag reach the job as
 * NEITHER flag. That is not hypothetical — `xbrl-reparse` shipped without it,
 * read 41,924 rows, reported 24,165 as changed, wrote nothing, and exited 0
 * after 54 minutes.
 *
 * ## `--probe` FIRST. The archive depth is UNKNOWN.
 *
 * Nobody has measured how far back `AnnSubCategoryGetData/w` serves. Our own
 * `docs/reference/exchange-archive-ranges.md` says so in as many words — the
 * 2011 probe returned EMPTY, but so did the RECENT control, because both were
 * sent with `strCat=-1`, so neither result says anything about depth. Guessing
 * a floor and looping from it is how a run spends hours on windows that were
 * never going to return anything.
 *
 * `--probe` fetches a SMALL SAMPLE of scrips year by year and prints the row
 * count per year. It writes nothing, ever, and it is the input to choosing
 * `--from-year`. Run it before the first `--apply`.
 *
 *   npx tsx scripts/data/backfill-bse-results.ts --probe --env prod
 *   npx tsx scripts/data/backfill-bse-results.ts --env prod --from-year 2020
 *   npx tsx scripts/data/backfill-bse-results.ts --env prod --from-year 2020 --apply
 *
 * Flags:
 *   --probe             measure archive depth on a sample. No writes. No cohort walk.
 *   --env qa|prod       read DATABASE_URL from Secret Manager (mirrors seed-env.sh)
 *   --from-year YYYY    earliest calendar year to walk (default: last year)
 *   --to-year YYYY      latest calendar year to walk (default: current year)
 *   --limit N           cap the cohort at N scrips (dry run only)
 *   --sample N          --probe only: scrips to sample (default 5)
 *   --apply             WRITE. Interactive confirmation required.
 */

import { execFileSync } from "child_process";
import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";

import {
  BSE_RESULT_CATEGORIES,
  fetchBSEAnnouncementsByCategory,
  BseRateLimitError,
  type BseAnnouncement,
} from "@usemoney/research/data-sources/bse-client";
import { buildStockDocPath } from "@usemoney/research/data-sources/stock-document-paths";
// MONEY-1315 (B) — the BODY sniff. This script is the SIXTH writer of
// `stock_documents` from downloaded bytes, and its own comment below already
// names the failure ("A 404 here is 8,406 bytes of HTML, well over
// MIN_PDF_BYTES"). It is operator-run against the same table the quarantine
// migration cleans, so an unguarded historical walk re-creates exactly the
// rows that migration exists to remove.
import {
  mayStoreDocumentBody,
  ABSENT_GCS_PATH,
  HTML_QUARANTINE_STATUS,
} from "@usemoney/research/data-sources/document-body-guard";
import {
  normalizeDocMimeType,
  initialProcessingStatus,
} from "@usemoney/core/market-data/doc-mime";
// The REAL production decisions, imported rather than restated. A backfill that
// classifies differently from the nightly job produces rows the nightly job
// would then fight with on the same unique key.
import {
  BSE_DOC_TYPE_QUARTERLY_RESULT,
  bseAttachmentCandidates,
  buildBseDocumentDescription,
  classifyBseAnnouncement,
  parseBseDocumentBreadcrumb,
  buildShardArgs,
  resolveApplyConfirmation,
  shouldChainShard,
} from "../../workers/src/processors/bse-announcements-sync-logic";
import { initJobTelemetry } from "../../workers/src/lib/job-telemetry";

dotenv.config({
  path: path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    "..",
    "..",
    ".env",
  ),
});

const GCP_PROJECT = "stock-book-483718";

/** Pause between BSE API requests. `API_LIMITS.screener` was cut 2000 -> 500
 *  after MONEY-853, where a whole-market run hit a per-IP 429 wall and ZERO
 *  data landed. A backfill is the exact shape that triggers it. */
const API_PACE_MS = 700;
/** Pause between attachment downloads. Matches the nightly job. */
const PDF_PACE_MS = 1500;
/** Pages per (scrip, category, window). A single company files a handful of
 *  results a year, so this is generous. */
const MAX_PAGES = 3;
/** A real PDF is well over this; smaller responses are error pages. */
const MIN_PDF_BYTES = 1000;
/** Stop the whole run after this many consecutive scrips produced nothing AND
 *  errored — a block looks like an empty archive otherwise. */
const CONSECUTIVE_FAILURE_BREAKER = 25;

interface Options {
  apply: boolean;
  probe: boolean;
  env: "qa" | "prod" | null;
  fromYear: number;
  toYear: number;
  limit: number | null;
  sample: number;
}

const KNOWN_FLAGS = new Set([
  "--apply",
  "--probe",
  "--env",
  "--from-year",
  "--to-year",
  "--limit",
  "--sample",
]);

/**
 * Anything unrecognised is REFUSED rather than ignored. `argv.includes()`
 * silently drops what it does not know, which is how a sibling script came to
 * accept-and-ignore `--dry-run` alongside `--apply` (i.e. it WROTE).
 */
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
  const int = (f: string, fallback: number): number => {
    const raw = val(f);
    if (raw === null) return fallback;
    const n = Number(raw);
    if (!Number.isInteger(n) || n <= 0) {
      throw new Error(`${f} must be a positive integer, got "${raw}"`);
    }
    return n;
  };

  const env = val("--env");
  if (env && env !== "qa" && env !== "prod") {
    throw new Error(`--env must be "qa" or "prod", got "${env}"`);
  }

  const nowYear = new Date().getUTCFullYear();
  const toYear = int("--to-year", nowYear);
  const fromYear = int("--from-year", nowYear - 1);
  if (fromYear > toYear) {
    throw new Error(`--from-year ${fromYear} is after --to-year ${toYear}`);
  }

  const limitRaw = val("--limit");
  const limit = limitRaw === null ? null : int("--limit", 0);
  const apply = has("--apply");
  const probe = has("--probe");

  if (apply && probe) {
    throw new Error(
      "--probe never writes. Combining it with --apply asks for two different " +
        "runs; do the probe first, read the per-year counts, then apply.",
    );
  }
  if (apply && limit !== null) {
    throw new Error(
      "--limit cannot be combined with --apply: the summary would describe a " +
        "sample while the write covers the cohort.",
    );
  }
  // Fail FAST, before touching BSE. `--apply` on a closed stdin can never
  // succeed, and a hung prompt exits 0 — which a wrapper's `&&` reads as
  // success.
  if (
    apply &&
    resolveApplyConfirmation({
      isTTY: Boolean(process.stdin.isTTY),
      cloudRunJob: process.env.CLOUD_RUN_JOB,
    }) === "refuse"
  ) {
    throw new Error(
      "--apply requires an interactive terminal: the confirmation prompt cannot " +
        "be answered when stdin is not a TTY (a pipe, </dev/null, or a CI runner). " +
        "For the long historical walk use the Cloud Run job instead — " +
        "scripts/ops/setup-bse-backfill-job.sh — where the execution itself is " +
        "the confirmation.",
    );
  }

  return {
    apply,
    probe,
    env: (env as "qa" | "prod" | null) ?? null,
    fromYear,
    toYear,
    limit,
    sample: int("--sample", 5),
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

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Confirm before ANY write, whichever database is targeted.
 *
 * The prompt exists so an operator can SEE the host — a placeholder gives them
 * nothing to check, so an unresolvable host REFUSES rather than degrading to a
 * generic warning. Aborting exits NON-ZERO: an abort is not success, and a
 * wrapper's `&&` must not read it as one.
 */
async function confirmWrite(
  uri: string,
  envLabel: string,
  scrips: number,
  fromYear: number,
  toYear: number,
): Promise<void> {
  const host = maskedHost(uri);
  if (!host) {
    console.error(
      "\n  Refusing to write: could not determine the target host from " +
        "DATABASE_URL.\n",
    );
    process.exit(1);
  }
  const confirmation = resolveApplyConfirmation({
    isTTY: Boolean(process.stdin.isTTY),
    cloudRunJob: process.env.CLOUD_RUN_JOB,
  });
  if (confirmation === "refuse") {
    console.error(
      "\n  Refusing to write: stdin is not a TTY, so the confirmation cannot " +
        "be answered. This script is deliberately interactive.\n",
    );
    process.exit(1);
  }
  if (confirmation === "cloud-run-job") {
    // Announced, not silent. The one thing worse than an unattended write is an
    // unattended write nobody can see in the log.
    console.log(
      `\n  NON-INTERACTIVE APPLY — running as Cloud Run job ` +
        `"${process.env.CLOUD_RUN_JOB}" execution ` +
        `"${process.env.CLOUD_RUN_EXECUTION ?? "?"}".\n` +
        `  The job execution IS the confirmation; no prompt is possible here.\n`,
    );
    return;
  }
  process.stdout.write(
    `\n⚠️  This will WRITE to a database AND upload PDFs to GCS.\n` +
      `      target : ${host}\n` +
      `      source : ${envLabel}\n` +
      `      scope  : ${scrips} BSE-only scrip(s), ${fromYear}..${toYear}, ` +
      `${BSE_RESULT_CATEGORIES.join(" + ")}\n` +
      `      writes : stock_documents rows (docType ${BSE_DOC_TYPE_QUARTERLY_RESULT})\n` +
      `   Type 'yes' to continue: `,
  );
  const answer = await new Promise<string>((resolve) => {
    process.stdin.once("data", (d) => resolve(String(d).trim()));
  });
  if (answer !== "yes") {
    console.log("Aborted.");
    process.exit(1);
  }
}

/** One cohort member: a BSE-listed company with no NSE listing. */
interface CohortRow {
  instrumentId: string;
  symbol: string;
  isin: string | null;
  name: string;
  scripCode: string;
}

/**
 * Build the BSE-ONLY cohort and attach each member's numeric BSE scrip code.
 *
 * `InstrumentMapping` has NO scrip-code column, so the codes come from BSE's
 * own scrip master (`ListofScripData`) — the feed the nightly enricher already
 * fetches, so this adds no new upstream. Matching is ISIN first (durable
 * identity) and `scrip_id` second, because BSE's scrip_id does not always equal
 * our stored symbol.
 */
/**
 * Is this row a COMPANY, as opposed to debt typed EQUITY? — MONEY-1258.
 *
 * The test is an INE ISIN: the exchange's own answer, not our inference. An
 * `INE` prefix is a company issuer; government paper (`IN0`/`IN9`) and fund
 * units (`INF`) are not, and a row with no ISIN at all is the 5,381-row
 * placeholder population whose `name` is just the symbol echoed back.
 *
 * NOT a symbol-shape test, and that is the whole point. `1STCUS`, `3BFILMS`,
 * `7NR` and `7SEASL` are digit-led REAL companies carrying INE ISINs — every
 * one of them appears in the probe's own sample. Excluding by shape is the
 * mistake `reclassify-instruments.ts` measured: 2,236 wrong rows, and only
 * 2,752 of 11,795 recalled.
 */
/**
 * Did this filing's attachment reach GCS? — MONEY-1258.
 *
 * `stored`       bytes are in GCS and `gcsPath` is set
 * `failed`       BSE offered a PDF and the fetch/upload THREW
 * `empty`        BSE offered a PDF and it came back too small to keep
 * `none-offered` the filing carries no attachment at all
 *
 * The distinction exists because the upload sits in a best-effort `catch` that
 * used to swallow silently. A run with GCS unconfigured therefore wrote rows
 * with `gcsPath: ""` and reported a clean summary — and `gcsPath: ""` makes the
 * parse lane terminal-FAIL the row, so the failure is not merely invisible, it
 * is durable.
 */
type AttachmentOutcome =
  | "stored"
  | "failed"
  | "empty"
  /**
   * MONEY-1315 (B) — the download SUCCEEDED and the bytes were an HTML page.
   *
   * Its own outcome, not folded into `failed` or `empty`. `failed` means the
   * upload threw and is worth retrying; `empty` means BSE served nothing. This
   * one means BSE served something that is not a document, deterministically —
   * and it is the ONLY one of the three where a row was nonetheless written
   * TERMINAL. Folding it into either would make the "NO ATTACHMENT REACHED
   * GCS" alarm below fire on a run that behaved correctly.
   */
  | "refused-html"
  | "none-offered";

export function isCompanyInstrument(isin: string | null | undefined): boolean {
  return /^INE/.test(isin ?? "");
}

async function buildCohort(
  prisma: typeof import("@usemoney/database").prisma,
  limit: number | null,
): Promise<{
  cohort: CohortRow[];
  bseOnly: number;
  unmatched: number;
  nonCompany: number;
}> {
  // RELATIVE, and DYNAMIC. `bse-master-instruments` has no `exports` subpath
  // on @usemoney/core, and the only published door to it is the market-data
  // BARREL — which would drag the whole market-data surface, including modules
  // that build a PrismaClient at module scope from `process.env.DATABASE_URL`,
  // pinning the client before `--env` has resolved. Same precedent as
  // `scripts/seed/seed-stock-documents.ts`. Dynamic so it loads after the
  // env resolution in `main()` either way.
  const { fetchBseScripMaster } = await import(
    "../../packages/core/src/market-data/instruments/bse-master-instruments"
  );

  const [bse, nse] = await Promise.all([
    prisma.instrumentMapping.findMany({
      where: { exchange: "BSE", isActive: true, instrumentType: "EQUITY" },
      select: { id: true, symbol: true, isin: true, name: true },
      orderBy: { symbol: "asc" },
    }),
    prisma.instrumentMapping.findMany({
      where: { exchange: "NSE", isActive: true, instrumentType: "EQUITY" },
      select: { symbol: true, isin: true },
    }),
  ]);

  const nseSymbols = new Set(nse.map((r) => r.symbol.toUpperCase()));
  const nseIsins = new Set(
    nse.map((r) => (r.isin ?? "").toUpperCase()).filter(Boolean),
  );

  // BSE-only: neither the symbol nor the ISIN appears on an active NSE equity.
  // ISIN is checked too because a rename (MONEY-1177) leaves the two exchanges
  // carrying different tickers for one company.
  const bseOnlyRows = bse.filter(
    (r) =>
      !nseSymbols.has(r.symbol.toUpperCase()) &&
      !(r.isin && nseIsins.has(r.isin.toUpperCase())),
  );

  const master = await fetchBseScripMaster();

  // AN EMPTY MASTER IS AN OUTAGE, NOT A FINDING — MONEY-1258.
  //
  // `fetchBseScripMaster` returns [] both when BSE is unreachable and when
  // `BSE_MASTER_ENRICH=off`. Falling through with [] makes EVERY company
  // unmatched, and the run then prints "N with no scrip code in BSE's master,
  // 0 selected" — a confident claim about our data produced by a network
  // failure. Observed exactly that on 2026-08-27: "giving up after retries",
  // then 2,388 companies reported as having no scrip code.
  //
  // Same distinction `screener-resolve.ts` draws between `miss` (we looked,
  // BSE has no row) and `unavailable` (we could not look), and it must be a
  // separate outcome for the same reason: caching a failure as a fact is how a
  // transient outage becomes a permanent conclusion.
  if (master.length === 0) {
    throw new Error(
      "BSE SCRIP MASTER UNAVAILABLE — fetchBseScripMaster returned 0 rows. " +
        "This is a fetch failure or BSE_MASTER_ENRICH=off, NOT a statement " +
        "about our cohort: every company would report as 'no scrip code'. " +
        "Re-run when BSE is reachable.",
    );
  }

  const byIsin = new Map<string, string>();
  const byScripId = new Map<string, string>();
  for (const m of master) {
    if (m.isin) byIsin.set(m.isin.toUpperCase(), m.scripCode);
    if (m.scripId) byScripId.set(m.scripId.toUpperCase(), m.scripCode);
  }

  // COMPANIES ONLY — an INE ISIN, exchange-issued, is the discriminator.
  //
  // Measured on prod 2026-08-27: of 7,903 "BSE-only active equities", 5,381
  // (68.1%) have `name === symbol` — no company name at all, just the ticker
  // echoed back — and only 2,389 (30.2%) carry an INE ISIN. The rest are DEBT
  // typed EQUITY with series "EQ" (MONEY-1258): `001HCCL29` is an HCC
  // debenture, `0360OPL27` a 360 ONE one. BSE serves filings for them, so the
  // walk succeeds and writes debenture notices under a symbol no company owns.
  //
  // THE ORDERING MADE THIS INVISIBLE. `bse` is read `orderBy: { symbol: "asc" }`
  // and both `--sample` and `--limit` take the HEAD, but digits sort before
  // letters: the first REAL COMPANY sits at index 925. So `--probe --sample 5`
  // measured BSE's archive depth for BONDS and reported it as the answer for
  // companies, and any `--limit` under 925 would have applied to zero
  // companies. Same mechanism as MONEY-1257, one script over.
  //
  // Filtering here rather than in the Prisma `where` is deliberate: `isin` is
  // ABSENT (not null) on these rows, and both `{isin: null}` and
  // `{isin: {not: null}}` match ZERO on Mongo — MONEY-1050 / 1205 / 1234 /
  // 1236 / 1256. A `where` clause would look right and select nothing.
  //
  // NOT a symbol-shape test: `1STCUS`, `4THGEN` and `7TEC` are digit-led REAL
  // companies with INE ISINs, and excluding them is exactly the mistake
  // `reclassify-instruments.ts` measured (2,236 wrong rows, 2,752 of 11,795
  // recalled).
  const companyRows = bseOnlyRows.filter((r) => isCompanyInstrument(r.isin));
  const nonCompany = bseOnlyRows.length - companyRows.length;

  const cohort: CohortRow[] = [];
  let unmatched = 0;
  for (const r of companyRows) {
    const code =
      (r.isin ? byIsin.get(r.isin.toUpperCase()) : undefined) ??
      byScripId.get(r.symbol.toUpperCase());
    if (!code) {
      unmatched++;
      continue;
    }
    cohort.push({
      instrumentId: r.id,
      symbol: r.symbol,
      isin: r.isin,
      name: r.name,
      scripCode: code,
    });
  }

  return {
    cohort: limit === null ? cohort : cohort.slice(0, limit),
    bseOnly: bseOnlyRows.length,
    unmatched,
    nonCompany,
  };
}

/**
 * `--probe` — measure how far back BSE actually serves, per year.
 *
 * This is the step the ticket insists on: the depth is UNKNOWN and must be
 * MEASURED rather than estimated. It prints one row per (scrip, year) with the
 * announcement count, so the year the archive stops is visible rather than
 * inferred, and it writes nothing.
 */
async function runProbe(
  cohort: CohortRow[],
  fromYear: number,
  toYear: number,
): Promise<void> {
  console.log(
    `\nPROBE — ${cohort.length} scrip(s) x ${toYear - fromYear + 1} year(s), ` +
      `categories ${BSE_RESULT_CATEGORIES.join(" + ")}. Writes nothing.\n`,
  );
  const perYear = new Map<number, number>();
  const perYearScrips = new Map<number, number>();

  for (const c of cohort) {
    const counts: string[] = [];
    for (let year = toYear; year >= fromYear; year--) {
      await sleep(API_PACE_MS);
      let n = 0;
      let note = "";
      try {
        const res = await fetchBSEAnnouncementsByCategory({
          fromDate: `${year}-01-01`,
          toDate: `${year}-12-31`,
          maxPages: MAX_PAGES,
          categories: BSE_RESULT_CATEGORIES,
          scripCode: c.scripCode,
          paceMs: API_PACE_MS,
        });
        n = res.announcements.length;
        if (res.transportFailures > 0) note = `!${res.transportFailures}`;
      } catch (err) {
        if (err instanceof BseRateLimitError) {
          console.error(
            "\nRATE LIMITED — stopping the probe. Re-run later; a partial " +
              "probe under a 429 measures our block, not BSE's archive.\n",
          );
          return;
        }
        note = "!ERR";
      }
      counts.push(`${year}:${n}${note}`);
      perYear.set(year, (perYear.get(year) ?? 0) + n);
      if (n > 0) perYearScrips.set(year, (perYearScrips.get(year) ?? 0) + 1);
    }
    console.log(`  ${c.symbol.padEnd(14)} ${c.scripCode.padEnd(8)} ${counts.join("  ")}`);
  }

  console.log("\n  year   rows   scrips-with-rows");
  for (let year = toYear; year >= fromYear; year--) {
    console.log(
      `  ${year}  ${String(perYear.get(year) ?? 0).padStart(5)}  ` +
        `${String(perYearScrips.get(year) ?? 0).padStart(6)} / ${cohort.length}`,
    );
  }
  console.log(
    "\n  A year of 0 across EVERY sampled scrip is where the archive stops —\n" +
      "  or where our egress is blocked. Those two look identical from here, so\n" +
      "  confirm a non-zero year on the SAME run before treating a floor as real.\n" +
      "  Choose --from-year from this table; do not estimate it.\n",
  );
}

/**
 * Trigger the next shard by asking Cloud Run to run THIS job again.
 *
 * Uses the Admin API (`jobs:run` with an arg override) rather than shelling out
 * to gcloud, which is not in the runtime image. The token comes from the
 * metadata server, so it is the job's own service account — the one
 * `setup-bse-backfill-job.sh` already grants `roles/run.invoker` on this job.
 *
 * BEST EFFORT, and deliberately so. A failed chain leaves the operator with a
 * completed shard and a command to run by hand, which is the state they were in
 * before chaining existed. A THROW here would fail a shard that did all its
 * work, which is strictly worse.
 */
async function triggerNextShard(next: {
  fromYear: number;
  toYear: number;
}): Promise<void> {
  const job = process.env.CLOUD_RUN_JOB;
  const project = process.env.GCP_PROJECT_ID;
  // CLOUD_RUN_EXECUTION looks like "<job>-abcde"; the region is not in any env
  // var, so it is read from the metadata server alongside the token.
  if (!job || !project) {
    console.error("  chain: CLOUD_RUN_JOB or GCP_PROJECT_ID missing — not chaining");
    return;
  }
  const MD = "http://metadata.google.internal/computeMetadata/v1";
  const H = { "Metadata-Flavor": "Google" };
  try {
    const [tokenRes, zoneRes] = await Promise.all([
      fetch(`${MD}/instance/service-accounts/default/token`, { headers: H }),
      fetch(`${MD}/instance/region`, { headers: H }),
    ]);
    const token = (await tokenRes.json())?.access_token as string | undefined;
    // "projects/<num>/regions/asia-south1" -> "asia-south1"
    const region = (await zoneRes.text()).split("/").pop();
    if (!token || !region) {
      console.error("  chain: could not resolve token/region — not chaining");
      return;
    }
    const url =
      `https://${region}-run.googleapis.com/v2/projects/${project}` +
      `/locations/${region}/jobs/${job}:run`;
    const res = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        overrides: {
          containerOverrides: [
            {
              args: buildShardArgs(next),
            },
          ],
        },
      }),
      signal: AbortSignal.timeout(30_000),
    });
    if (!res.ok) {
      console.error(
        `  chain: jobs:run returned ${res.status} — run the next shard by hand:\n` +
          `    --args=${buildShardArgs(next).join(",")}`,
      );
      return;
    }
    console.log(
      `\n  CHAINED -> next shard ${next.fromYear}..${next.toYear} triggered on ${job}.\n`,
    );
  } catch (err) {
    console.error(
      `  chain: failed (${err instanceof Error ? err.message : String(err)}) — ` +
        `run the next shard by hand:\n` +
        `    --args=${buildShardArgs(next).join(",")}`,
    );
  }
}

interface Plan {
  cohortRow: CohortRow;
  ann: BseAnnouncement;
  docType: string;
  period: string;
  action: "create" | "supersede" | "retry-bytes" | "skip-same";
}

async function main(): Promise<void> {
  // MONEY-1375 — attach the Datadog log stream. This job lives outside
  // scripts/jobs/, which is how the first pass missed it: the test derived its
  // population from that directory rather than from the tsup entry list.
  await initJobTelemetry();
  const opts = parseArgs(process.argv.slice(2));
  if (opts.env) process.env.DATABASE_URL = databaseUrlForEnv(opts.env);
  const uri = process.env.DATABASE_URL ?? "";
  if (!uri) {
    throw new Error(
      "No DATABASE_URL. Pass --env qa|prod, or export DATABASE_URL yourself.",
    );
  }

  const { prisma } = await import("@usemoney/database");

  const mode = opts.probe ? "PROBE" : opts.apply ? "APPLY" : "DRY RUN";
  console.log(
    `\nBSE results backfill — ${mode}` +
      `${opts.env ? ` (--env ${opts.env})` : ""}\n` +
      `target : ${maskedHost(uri) ?? "<unknown host>"}\n` +
      `years  : ${opts.fromYear}..${opts.toYear}\n`,
  );

  try {
    const { cohort, bseOnly, unmatched, nonCompany } = await buildCohort(
      prisma,
      opts.probe ? opts.sample : opts.limit,
    );
    console.log(
      `cohort : ${bseOnly} BSE-only rows typed EQUITY, ${nonCompany} DROPPED ` +
        `(no INE ISIN — debt typed EQUITY, MONEY-1258), ${unmatched} with no ` +
        `scrip code in BSE's master, ${cohort.length} selected\n`,
    );
    if (cohort.length > 0) {
      // Name the head. `--sample`/`--limit` take it, and before the INE filter
      // the first 925 rows were bonds — so a probe reported BSE's depth for
      // debentures and read as the answer for companies.
      console.log(
        `  head   : ${cohort
          .slice(0, 3)
          .map((r) => `${r.symbol} (${r.name ?? "?"})`)
          .join(", ")}\n`,
      );
    }
    if (cohort.length === 0) {
      console.log("Nothing to do.\n");
      return;
    }

    if (opts.probe) {
      await runProbe(cohort, opts.fromYear, opts.toYear);
      return;
    }

    if (opts.apply) {
      await confirmWrite(
        uri,
        opts.env ?? "ambient DATABASE_URL",
        cohort.length,
        opts.fromYear,
        opts.toYear,
      );
    }

    const plans: Plan[] = [];
    let consecutiveFailures = 0;
    let scanned = 0;
    /** Did a 429 end the walk? Feeds the chain decision — MONEY-1258. */
    let rateLimited = false;
    /** Did CONSECUTIVE_FAILURE_BREAKER end the walk? Same. */
    let breakerTripped = false;
    /** Attachment outcomes — MONEY-1258. A run that stores NOTHING must say so. */
    const attach: Record<AttachmentOutcome, number> = {
      stored: 0,
      failed: 0,
      empty: 0,
      "refused-html": 0,
      "none-offered": 0,
    };

    for (const c of cohort) {
      scanned++;
      await sleep(API_PACE_MS);
      let announcements: BseAnnouncement[] = [];
      try {
        const res = await fetchBSEAnnouncementsByCategory({
          fromDate: `${opts.fromYear}-01-01`,
          toDate: `${opts.toYear}-12-31`,
          maxPages: MAX_PAGES,
          categories: BSE_RESULT_CATEGORIES,
          scripCode: c.scripCode,
          paceMs: API_PACE_MS,
        });
        announcements = res.announcements;
        consecutiveFailures =
          res.transportFailures > 0 ? consecutiveFailures + 1 : 0;
      } catch (err) {
        if (err instanceof BseRateLimitError) {
          console.error(
            `\nRATE LIMITED after ${scanned} scrip(s) — stopping. Re-run later.\n`,
          );
          rateLimited = true;
          break;
        }
        consecutiveFailures++;
      }

      // A block looks exactly like an empty archive from in here. Only a RUN of
      // failures distinguishes them, so that is what the breaker counts.
      if (consecutiveFailures >= CONSECUTIVE_FAILURE_BREAKER) {
        console.error(
          `\n${CONSECUTIVE_FAILURE_BREAKER} consecutive scrips failed — ` +
            "stopping rather than recording a block as an empty archive.\n",
        );
        breakerTripped = true;
        break;
      }

      for (const ann of announcements) {
        const cls = classifyBseAnnouncement(ann, ann.quarterId);
        // RESULTS ONLY. A `corporate_filing` from a wide historical window is
        // the daily job's business and would be written here with a period the
        // daily job then re-derives identically — duplicated effort with no
        // gain, and thousands of extra PDF downloads.
        if (cls.docType !== BSE_DOC_TYPE_QUARTERLY_RESULT) continue;

        const existing = await prisma.stockDocument.findUnique({
          where: {
            symbol_exchange_docType_period: {
              symbol: c.symbol,
              exchange: "BSE",
              docType: cls.docType,
              period: cls.period,
            },
          },
          select: {
            id: true,
            description: true,
            sourceUrl: true,
            gcsPath: true,
            fileSize: true,
          },
        });

        let action: Plan["action"] = "create";
        if (existing) {
          const prior =
            parseBseDocumentBreadcrumb(existing.description)?.attachment ??
            (existing.sourceUrl ?? "").split("/").pop() ??
            "";
          const incoming = (ann.pdfUrl ?? "").split("/").pop() ?? "";
          const hasBytes = Boolean(existing.gcsPath && existing.fileSize > 0);
          // Same attachment but NO bytes = a prior run's failed download. The
          // parse lane turns such a row TERMINAL on its first attempt
          // (`downloadFromGCS("")` throws -> parseStatus FAILED), so skipping
          // it strands that company-quarter permanently.
          action =
            prior !== incoming
              ? "supersede"
              : hasBytes
                ? "skip-same"
                : "retry-bytes";
        }

        plans.push({
          cohortRow: c,
          ann,
          docType: cls.docType,
          period: cls.period,
          action,
        });

        if (opts.apply && action !== "skip-same") {
          const outcome = await writeOne(
            prisma,
            c,
            ann,
            cls.docType,
            cls.period,
            existing,
          );
          attach[outcome]++;
          await sleep(PDF_PACE_MS);
        }
      }

      if (scanned % 25 === 0) {
        console.log(`  … ${scanned}/${cohort.length} scrips, ${plans.length} filings found`);
      }
    }

    const by = (a: Plan["action"]) => plans.filter((p) => p.action === a).length;
    console.log(
      `\n${mode} summary\n` +
        `  scrips walked      : ${scanned}\n` +
        `  results filings    : ${plans.length}\n` +
        `  would create       : ${by("create")}\n` +
        `  would supersede    : ${by("supersede")}\n` +
        `  would retry bytes  : ${by("retry-bytes")}\n` +
        `  already identical  : ${by("skip-same")}\n` +
        (opts.apply
          ? `  attachments stored : ${attach.stored}\n` +
            `    upload FAILED    : ${attach.failed}\n` +
            `    too small/empty  : ${attach.empty}\n` +
            `    refused as HTML  : ${attach["refused-html"]}\n` +
            `    none offered     : ${attach["none-offered"]}\n`
          : ""),
    );

    // A run that OFFERED attachments and stored NONE is broken, not idle.
    //
    // This is the shape that produced 59 rows with `gcsPath: ""` on
    // 2026-08-27: the wrapper declared NEEDS_GCS=0, so uploadFile had no
    // GCP_PROJECT_ID or GCP_STORAGE_BUCKET, every upload threw into a silent
    // best-effort catch, and the summary above looked entirely healthy. An
    // empty gcsPath is not a cosmetic gap — the parse lane terminal-FAILs the
    // row on the first downloadFromGCS(""), and it occupies the unique key, so
    // a later correct run has to overwrite a row already marked terminal.
    // `refused-html` counts as OFFERED — BSE handed us bytes — but it must not
    // make the alarm fire, because those rows were written deliberately and
    // terminally. A shard that refused everything and stored nothing is a
    // correct run, not a broken one, so it is excluded from the zero-store
    // trigger while staying in the denominator the message reports.
    const offered =
      attach.stored + attach.failed + attach.empty + attach["refused-html"];
    if (
      opts.apply &&
      offered > 0 &&
      attach.stored === 0 &&
      attach["refused-html"] === 0
    ) {
      console.error(
        `\n  *** NO ATTACHMENT REACHED GCS — ${offered} filing(s) offered one ` +
          `and 0 were stored.\n` +
          `      Every row written by this run has gcsPath "" and will ` +
          `terminal-FAIL in the parse lane.\n` +
          `      CHECK THE YEAR FIRST. BSE stops serving attachments for older\n` +
          `      filings, and a shard past that floor returns 0 of N with no\n` +
          `      error — the same shape as a broken run. Measured on prod\n` +
          `      2026-08-29, quarterly_result rows with bytes vs without:\n` +
          `        2019-2025   0-1% empty     attachments served\n` +
          `        2018         75% empty     partial\n` +
          `        2017        100% empty     nothing served\n` +
          `      So 0-of-N below ~2018 is EXPECTED and re-running spends\n` +
          `      thousands of requests to store nothing. The rows still carry\n` +
          `      title, description and sourceUrl, which is the useful part.\n` +
          `      If the year is 2019+, THEN suspect the run: check GCP_PROJECT_ID\n` +
          `      and GCP_STORAGE_BUCKET are set, and that the attachment host is\n` +
          `      not rate-limiting (a 429 raises rather than reaching here).\n`,
      );
      process.exitCode = 1;
    }

    // ── CHAIN TO THE NEXT SHARD ───────────────────────────────────────────
    //
    // Automatic only on the happy path. Every refusal below is a state where
    // continuing would spend another ~9-12h being refused, unattended — and
    // the walk FETCHES, one index call per company plus one download per
    // filing, against a host that has 429'd this repo before (MONEY-853).
    //
    // Termination is structural: BSE_SHARD_PLAN is a fixed array and
    // `nextShard` only walks FORWARD from a matched entry, so a chain is at
    // most plan.length - 1 links whatever the data does. An ad-hoc window that
    // is not in the plan matches nothing and never chains.
    const chain = shouldChainShard({
      current: { fromYear: opts.fromYear, toYear: opts.toYear },
      inCloudRunJob: Boolean(process.env.CLOUD_RUN_JOB),
      rateLimited,
      breakerTripped,
      attachmentsOffered:
        attach.stored + attach.failed + attach.empty + attach["refused-html"],
      attachmentsStored: attach.stored,
    });
    if (opts.apply) {
      if (chain.decision === "chain" && chain.next) {
        await triggerNextShard(chain.next);
      } else if (chain.next) {
        // NAMED, not silent. "The next shard did not start" and "there is no
        // next shard" are different facts and an operator must not have to
        // infer which one happened.
        console.log(
          `\n  NOT CHAINING (${chain.decision}). Next shard would be ` +
            `${chain.next.fromYear}..${chain.next.toYear}; start it by hand ` +
            `once the cause is understood.\n`,
        );
      } else if (chain.decision === "plan-complete") {
        console.log("\n  SHARD PLAN COMPLETE — no further shard to run.\n");
      }
    }
    if (!opts.apply) {
      console.log(
        "  DRY RUN — nothing was written. Re-run with --apply (interactive) to write.\n",
      );
      const preview = plans.filter((p) => p.action !== "skip-same").slice(0, 20);
      for (const p of preview) {
        console.log(
          `  ${p.action.padEnd(10)} ${p.cohortRow.symbol.padEnd(14)} ` +
            `${p.period.padEnd(10)} ${p.ann.title.slice(0, 70)}`,
        );
      }
      if (preview.length > 0) console.log("");
    }
  } finally {
    await prisma.$disconnect();
  }
}

/**
 * Archive the PDF and upsert one row — the SAME shape the nightly job writes,
 * built from the SAME helpers, so a backfilled row and a nightly row are
 * indistinguishable and cannot fight over the unique key.
 */
async function writeOne(
  prisma: typeof import("@usemoney/database").prisma,
  c: CohortRow,
  ann: BseAnnouncement,
  docType: string,
  period: string,
  existing: { description: string | null; sourceUrl: string | null } | null,
): Promise<AttachmentOutcome> {
  const { uploadFile } = await import("@usemoney/storage");

  let gcsPath = "";
  let fileSize = 0;
  let contentType: string | null = null;
  let uploadFailed = false;
  /** MONEY-1315 (B) — the bytes came back, and they were an HTML page. */
  let htmlRefused = false;
  let htmlRefusalReason = "";

  // AttachLive vs AttachHis — MONEY-1258. `pdfUrl` is always built against
  // AttachLive, which serves only RECENT filings; a historical walk 404s every
  // one of them. Candidates come back age-ordered so the likely directory is
  // tried first and a wrong guess costs one request, not a missed attachment.
  const candidates = bseAttachmentCandidates(ann.pdfUrl, ann.publishedAt);
  for (const url of candidates) {
    try {
      const res = await fetch(url, {
        headers: {
          "User-Agent":
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
          Referer: "https://www.bseindia.com/",
        },
        signal: AbortSignal.timeout(30_000),
      });
      if (res.status === 429) throw new BseRateLimitError(`PDF ${c.symbol}`);
      // A 404 here is 8,406 bytes of HTML, well over MIN_PDF_BYTES — so the
      // status check, not the length check, is what keeps error pages out of
      // GCS. Do not collapse the two.
      if (res.ok) {
        contentType = res.headers?.get?.("content-type") ?? "";
        const buffer = Buffer.from(await res.arrayBuffer());
        if (buffer.length >= MIN_PDF_BYTES) {
          const clean = c.symbol.toUpperCase().replace(/[^A-Z0-9&]/g, "");
          const safePeriod = period.replace(/[/\\:*?"<>|\s]/g, "-");
          const fileName = `${clean}-${docType.replace(/_/g, "-")}-${safePeriod}.pdf`;
          const full = buildStockDocPath(
            c.symbol,
            docType as Parameters<typeof buildStockDocPath>[1],
            fileName,
          );
          // The BODY, before the upload. The `res.ok` check the comment above
          // relies on cannot see the OTHER shape this walk meets: a directory
          // that answers 200 for a filing it does not hold. Refusing here is
          // also what stops a historical walk re-creating the rows
          // `quarantine-html-stock-documents.ts` was written to clear.
          const gate = mayStoreDocumentBody({ gcsPath: full, body: buffer });
          if (!gate.store) {
            // Recorded, not silently dropped, and TERMINAL rather than FAILED:
            // BSE will serve the identical page on the next walk, so a
            // retryable state means paying for it forever.
            htmlRefused = true;
            htmlRefusalReason = gate.reason;
          } else {
            await uploadFile({
              file: buffer,
              fileName,
              folder: full.slice(0, full.length - fileName.length - 1),
              contentType: contentType || "application/pdf",
              isPublic: false,
            });
            gcsPath = full;
            fileSize = buffer.length;
          }
        }
      }
    } catch (err) {
      if (err instanceof BseRateLimitError) throw err;
      // Best-effort: the row still lands with the source URL so a later pass
      // can retry the attachment. COUNTED, though — see AttachmentOutcome.
      uploadFailed = true;
    }
    if (gcsPath) break;
  }

  const priorAttachment = existing
    ? (parseBseDocumentBreadcrumb(existing.description)?.attachment ??
      (existing.sourceUrl ?? "").split("/").pop() ??
      null)
    : null;

  const common = {
    title: ann.title || `${c.symbol} BSE Filing`,
    description: buildBseDocumentDescription({
      ann,
      previousDescription: existing?.description ?? null,
      supersededAttachment: priorAttachment,
    }),
    sourceUrl: ann.pdfUrl ?? undefined,
    sourceType: "BSE",
    // MONEY-1315 (B) — a refusal lands on the SHARED terminal state, imported
    // from the module the quarantine migration writes from, so a row refused
    // here and a row cleaned up there cannot end in two different states.
    // `title`, `description` and `sourceUrl` survive either way.
    gcsPath: htmlRefused ? ABSENT_GCS_PATH : gcsPath,
    fileSize: htmlRefused ? 0 : fileSize,
    mimeType: htmlRefused ? "text/html" : normalizeDocMimeType(contentType),
    processingStatus: htmlRefused
      ? HTML_QUARANTINE_STATUS
      : gcsPath
        ? initialProcessingStatus(contentType)
        : "FAILED",
    fetchedAt: new Date(),
  };

  await prisma.stockDocument.upsert({
    where: {
      symbol_exchange_docType_period: {
        symbol: c.symbol,
        exchange: "BSE",
        docType,
        period,
      },
    },
    create: {
      instrumentId: c.instrumentId,
      symbol: c.symbol,
      exchange: "BSE",
      docType,
      period,
      ...common,
    },
    update: {
      ...common,
      isEmbedded: false,
      textContent: null,
      parseStatus: "PENDING",
      parsedAt: null,
    },
  });

  if (gcsPath) return "stored";
  if (htmlRefused) {
    console.warn(
      `  REFUSED BSE ${docType} for ${c.symbol} ${period}: ${htmlRefusalReason} ` +
        `(${ann.pdfUrl})`,
    );
    return "refused-html";
  }
  return ann.pdfUrl ? (uploadFailed ? "failed" : "empty") : "none-offered";
}

main().catch((err) => {
  console.error(`\n${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
