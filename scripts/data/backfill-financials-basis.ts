/**
 * Stamp `stock_financials.basis = "UNKNOWN"` onto the vendor rows — MONEY-1300.
 *
 * NO NETWORK. NO GCS. NO RE-PARSE. It writes ONE column, on rows that do not
 * carry it, and reads nothing but this collection.
 *
 * ## What is wrong today
 *
 * Measured on prod 2026-08-31:
 *
 *     stock_financials            32,359 rows, source TICKERTAPE on 100% of them
 *     rows carrying `basis`             0
 *     XbrlFiling                  63,575 STANDALONE + 44,447 CONSOLIDATED
 *
 * `basis` (CONSOLIDATED | STANDALONE) exists in the Prisma schema and is
 * written by the XBRL projection on every create and update. It is ABSENT — not
 * null — on all 32,359 rows, because a Mongo `prisma db push` creates INDEXES,
 * never FIELDS. Nothing has backfilled it, so today the column says nothing
 * about any row in the table.
 *
 * That matters because a company files BOTH bases for one period and they
 * differ by a MULTIPLE for any holding company (360ONE FY2025 totalAssets:
 * 19,768 Cr consolidated against 7,332 Cr standalone). `XbrlFiling` keeps both
 * because its key carries `basis`; `StockFinancials`'s `@@unique` deliberately
 * does NOT, so one row holds one of the two and — until this runs — says
 * nothing about which.
 *
 * ## Why the value is the literal "UNKNOWN" and never null
 *
 * This is the whole point of the ticket, so it is written down rather than
 * implied.
 *
 * Prisma's MongoDB connector does not treat an ABSENT field as null. Both
 * `{ basis: null }` AND `{ basis: { not: null } }` return ZERO against a
 * population where the attribute does not exist — the filter matches only
 * documents that actually carry the key. So "vendor row, basis unknown" and
 * "XBRL row, consolidated" are indistinguishable to every reader that tries to
 * ask, and the honest-looking query returns an empty set instead of an error.
 * That class has now cost MONEY-1050, MONEY-1205, MONEY-1234, MONEY-1235 and
 * MONEY-1236.
 *
 * Writing an explicit `null` would fix NOTHING. `{ basis: null }` would then
 * match, but `{ basis: { not: null } }` would still exclude the row, and a
 * reader asking "which rows have a known basis" and a reader asking "which rows
 * are unattributed" would still get answers that do not sum to the table. A
 * NAMED value is the only shape where both questions are answerable with one
 * ordinary equality:
 *
 *     basis === "UNKNOWN"                       vendor row, basis not recorded
 *     basis === "CONSOLIDATED" | "STANDALONE"   the projection stamped it
 *     basis absent                              a row NOTHING has touched yet
 *
 * The third state stays meaningful precisely because we do not write null: an
 * absent `basis` after this script has run is a row that arrived after it, and
 * that is a fact worth being able to see.
 *
 * ## Why the SELECTION is raw Mongo and not a Prisma `where`
 *
 * Because Prisma cannot express the population. `{ basis: null }` misses every
 * one of the 32,359 rows; the only Prisma spelling that reaches an absent key
 * is `{ isSet: false }`, and this script goes one step further and uses the raw
 * `$exists: false` directly (`scripts/ops/backfill-user-isactive.ts`, the same
 * pattern for the same reason). One filter document drives the CENSUS, the
 * SAMPLES and the WRITE — `stampFilter()` — so the plan an operator judges and
 * the plan that executes cannot drift apart. That drift is what made
 * `ops/backfill-syncbucket.ts` print "Nothing to backfill" over a population it
 * could not see.
 *
 * Note the inversion, because it is easy to misread this file: in RAW Mongo
 * `{ field: null }` DOES match a missing key, and `$nin` DOES match a document
 * that lacks the field. The raw semantics are the ones we want; it is Prisma's
 * stricter layer that is the trap. `$exists: false` is used anyway because it
 * says what it means to a reader who has just come from the Prisma side.
 *
 * ## What it refuses to touch
 *
 *   - Any row that ALREADY carries `basis`, whatever the value. Not an
 *     optimisation — a CONSOLIDATED row overwritten with "UNKNOWN" would be a
 *     downgrade on a table whose unique key has no `source` and no `basis`, so
 *     there is no second copy to restore from.
 *   - Any row whose `source` is the projection's (`NSE_XBRL`). Those rows are
 *     the projection's to describe; if one is missing a basis, the projection
 *     is what should supply it, not a blanket vendor stamp. They are COUNTED
 *     and reported in their own bucket rather than folded into the total — a
 *     skip nobody can see is a skip nobody can act on.
 *   - Rows carrying an EXPLICIT null `basis`. `$exists: false` does not reach
 *     them by construction. They are counted separately and reported; prod has
 *     zero. If that number is ever non-zero, widen the filter DELIBERATELY —
 *     not by accident, and not by switching to a bare raw `{ basis: null }`
 *     that reads like the Prisma bug this file exists to avoid.
 *   - `source`, `rawData`, `fetchedAt`, `updatedAt` and every figure. The write
 *     is a raw `$set` of one key, so `@updatedAt` does NOT fire — which is
 *     correct here and deliberate: this stamps PROVENANCE, not data, and moving
 *     32,359 `updatedAt` values would tell every staleness reader the whole
 *     table just refreshed.
 *
 * ## Why it does NOT call `mayOverwriteFinancials`
 *
 * Every other writer of this model must, and
 * `packages/core/__tests__/market-data/financials-write-authority.test.ts`
 * scans for it. The authority question is "may my source replace the value
 * already in this cell?", and it does not arise here: the write is gated on the
 * cell being ABSENT, so there is nothing to displace, and it touches no owned
 * figure and never rewrites `source`. What WOULD be an authority violation —
 * a vendor stamp landing on a row the projection owns — is refused by
 * `stampFilter()`'s `$nin` against the same `FINANCIALS_AUTHORITY` vocabulary
 * that helper ranks. The guard is the filter, not a call made after the fact
 * (`reference_authority_rank_must_gate_the_write`).
 *
 * ## Idempotent, structurally
 *
 * The selection is "rows without the attribute" and the write is "give them the
 * attribute", so every row this run stamps is excluded from the next run's
 * selection BY THE SAME PREDICATE. A second pass matches zero, modifies zero
 * and says so. This is a property of the filter, not a checkpoint that can go
 * stale — there is nothing to reset if a run is interrupted half way.
 *
 * ## Verification goes through the OTHER route on purpose
 *
 * A verify that re-runs the selection's own predicate can only confirm the
 * selection's own blind spot (MONEY-1236). So the post-write check counts
 * through PRISMA — `count({ where: { basis: "UNKNOWN" } })`, an ordinary
 * equality Prisma expresses correctly — and compares it against the raw count.
 *
 * That pairing is chosen for one specific adversary. If the write were ever
 * changed to `$set: { basis: null }`, the raw "still missing" count would go to
 * ZERO and report success, because the attribute would then EXIST. Only the
 * Prisma equality notices that nothing readable was written. The two routes
 * disagree exactly where it matters.
 *
 * A whole-collection count is also compared raw-vs-Prisma, because `aggregate`
 * against a collection name that does not exist returns an EMPTY result rather
 * than an error — so a future `@@map()` rename would otherwise turn this whole
 * verification into a hard-coded pass.
 *
 * ## Usage
 *
 *   npx tsx scripts/data/backfill-financials-basis.ts --env prod
 *   npx tsx scripts/data/backfill-financials-basis.ts --env prod --apply
 *   DATABASE_URL=... npx tsx scripts/data/backfill-financials-basis.ts
 *
 *   Options
 *     --apply           actually write (default: dry run). Prompts; needs a TTY.
 *     --env <qa|prod>   fetch DATABASE_URL from GCP Secret Manager
 *     --samples <n>     example rows to print per bucket (default 8, max 50)
 *
 * Run it on **prod**. `stock_financials` is a REFERENCE collection in
 * `sync-prod-to-qa.sh`, so QA receives the stamped rows by copy and a QA run is
 * undone by the next restore. `--env qa` still works for a rehearsal.
 */

import { execFileSync } from "child_process";
import dotenv from "dotenv";
import path from "path";
import { fileURLToPath, pathToFileURL } from "url";

// The ONE declared provenance vocabulary, imported rather than restated so this
// script and the projection cannot disagree about who owns a row.
//
// A NARROW SUBPATH, never the `@usemoney/core/market-data` barrel:
// `xbrl-projection.ts`'s only static imports are two bindings from
// `xbrl-financials-logic.ts`, which imports nothing at all, so this cannot drag
// `@usemoney/database` into the static closure and construct a PrismaClient
// before `--env` resolves. The barrel reaches the DB through ten modules and is
// exactly how `resector-real-estate.ts` was broken while looking correct.
import { XBRL_SOURCE } from "@usemoney/core/market-data/xbrl-projection";

// The READER's vocabulary for this column (MONEY-1300 step 1), imported for the
// same reason and with the same subpath discipline — `financials-basis.ts` is a
// zero-import leaf. The coupling is a TYPE rather than a runtime indirection:
// `UNKNOWN_BASIS` below is annotated `StockFinancialsBasis`, so if the reader's
// three-state vocabulary ever loses or renames `"UNKNOWN"`, this writer stops
// COMPILING instead of quietly stamping a value every reader would collapse to
// "Basis not stated" while believing it had been told something.
import type { StockFinancialsBasis } from "@usemoney/core/market-data/financials-basis";

dotenv.config({
  path: path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    "..",
    "..",
    ".env",
  ),
});

const GCP_PROJECT = "stock-book-483718";

/** `StockFinancials.@@map`. Every raw command names this and nothing else. */
export const COLLECTION = "stock_financials";

/**
 * The value stamped onto a vendor row whose basis is not recorded.
 *
 * TYPED as the READER's `StockFinancialsBasis`, so the writer and
 * `normalizeStockFinancialsBasis` cannot come to mean different things by the
 * same column. Step 1 of this ticket already collapses ABSENT and "UNKNOWN" to
 * the same reader state, which is what makes this backfill safe to run at any
 * time and in any order relative to that deploy: it changes what the column
 * SAYS, never what the page RENDERS.
 *
 * A NAMED STRING, never null and never absent — see the header. It is exported
 * so a reader (and the test) binds to this constant instead of re-typing the
 * literal in a second place, which is how "one rule, stated twice" starts.
 */
export const UNKNOWN_BASIS: StockFinancialsBasis = "UNKNOWN";

/**
 * Sources whose `basis` belongs to the projection, not to this backfill.
 *
 * Derived from `XBRL_SOURCE` rather than from a local `"NSE_XBRL"` literal.
 * Everything else in `FINANCIALS_AUTHORITY` (DOC_PDF, TICKERTAPE, SCREENER,
 * YAHOO) is a reading of a filing that does not record which basis it read, and
 * an unknown source ranks LAST in that same table — so "not the projection's"
 * is precisely the right test, and a source we have never seen falls on the
 * correct side of it without anyone editing this list.
 */
export const PROJECTION_OWNED_SOURCES: readonly string[] = [XBRL_SOURCE];

/** A raw Mongo command / filter / document, as `$runCommandRaw` speaks it. */
export type RawDoc = Record<string, unknown>;

/** `prisma.$runCommandRaw`, narrowed to what this file needs and injectable. */
export type RawCommandRunner = (command: RawDoc) => Promise<RawDoc>;

/**
 * Every row where the attribute is ABSENT, whatever its source.
 *
 * `$exists: false` and nothing else. This is the count that says how big the
 * hole is; `stampFilter()` is the subset this script is allowed to fill.
 */
export function missingBasisFilter(): RawDoc {
  return { basis: { $exists: false } };
}

/**
 * THE selection. Census, samples and write all go through this one function.
 *
 * `$nin` rather than `$ne` for the source guard so the list can grow without
 * the operator changing shape, and because raw `$nin` MATCHES a document that
 * lacks `source` entirely — a row with no recorded source is not the
 * projection's, and unknown ranks last in `FINANCIALS_AUTHORITY`, so stamping
 * it is the correct call rather than an accident of operator semantics. (Prod
 * has `source` on 100% of rows; the census reports the bucket regardless, so
 * this can never become silent.)
 */
export function stampFilter(): RawDoc {
  return {
    basis: { $exists: false },
    source: { $nin: [...PROJECTION_OWNED_SOURCES] },
  };
}

/**
 * The rows deliberately LEFT ALONE: no basis, but written by the projection.
 *
 * Counted and reported in its own bucket. Together with `stampFilter()` it
 * partitions `missingBasisFilter()` exactly, which is the accounting identity
 * `censusAccountingError` asserts.
 */
export function projectionSkipFilter(): RawDoc {
  return {
    basis: { $exists: false },
    source: { $in: [...PROJECTION_OWNED_SOURCES] },
  };
}

/**
 * Rows carrying an EXPLICIT null — present key, null value.
 *
 * Out of scope by construction (`$exists: false` cannot reach them) and
 * measured at zero on prod. Reported so that "out of scope" is a number an
 * operator can see rather than an assumption this file makes about the data.
 */
export function explicitNullBasisFilter(): RawDoc {
  return { basis: { $exists: true, $eq: null } };
}

/** Rows already stamped by a previous run. The idempotency witness. */
export function alreadyStampedFilter(): RawDoc {
  return { basis: UNKNOWN_BASIS };
}

/**
 * The whole write, as one raw command document.
 *
 * `multi: true` — this is a single server-side update over the selection, not a
 * paged read-then-write, so there is no window in which a row the plan counted
 * gets stamped from a stale id list. The filter is re-evaluated by the server
 * at write time, which is also what makes a concurrent projection write safe: a
 * row that acquired a real basis between the census and this command no longer
 * matches `$exists: false` and is left exactly as the projection wrote it.
 */
export function basisStampCommand(collection: string = COLLECTION): RawDoc {
  return {
    update: collection,
    updates: [
      {
        q: stampFilter(),
        u: { $set: { basis: UNKNOWN_BASIS } },
        multi: true,
      },
    ],
  };
}

export interface StampResult {
  /** Rows the server matched. */
  matched: number;
  /** Rows the server actually changed. On a second run both are 0. */
  modified: number;
}

/**
 * Issue the write. Injectable runner so the command this function ACTUALLY
 * emits can be driven against a fake in a test — the alternative is a test that
 * asserts on a command builder nothing is proven to call.
 */
export async function applyBasisStamp(
  run: RawCommandRunner,
  collection: string = COLLECTION,
): Promise<StampResult> {
  const res = await run(basisStampCommand(collection));
  return {
    matched: Number(res.n ?? 0),
    modified: Number(res.nModified ?? 0),
  };
}

export interface BasisCensus {
  /** Every row in the collection. */
  total: number;
  /** `basis` absent, any source. */
  missingBasis: number;
  /** `basis` absent AND not projection-owned — what this run would stamp. */
  stampable: number;
  /** `basis` absent AND projection-owned — deliberately skipped. */
  projectionSkipped: number;
  /** Present key, null value. Out of `$exists: false`'s reach. */
  explicitNull: number;
  /** Already carrying `UNKNOWN` from an earlier run. */
  alreadyStamped: number;
  /** `source` -> count, over the rows missing a basis. */
  missingBySource: Array<{ source: string; n: number }>;
  /** `basis` -> count, over the rows that carry one. */
  presentByBasis: Array<{ basis: string; n: number }>;
}

interface FacetBatch {
  cursor?: {
    firstBatch?: Array<Record<string, unknown>>;
  };
}

function facetCount(facet: Record<string, unknown>, key: string): number {
  const arr = facet[key];
  if (!Array.isArray(arr) || arr.length === 0) return 0;
  const first = arr[0] as { n?: unknown };
  return Number(first?.n ?? 0);
}

function facetGroups(
  facet: Record<string, unknown>,
  key: string,
): Array<{ id: string; n: number }> {
  const arr = facet[key];
  if (!Array.isArray(arr)) return [];
  return (arr as Array<{ _id?: unknown; n?: unknown }>)
    .map((g) => ({
      id: g._id === null || g._id === undefined ? "<absent>" : String(g._id),
      n: Number(g.n ?? 0),
    }))
    .sort((a, b) => b.n - a.n);
}

/**
 * One round trip, one `$facet`, every number the report prints.
 *
 * A `$facet` returns exactly ONE document, so `cursor.firstBatch` cannot be
 * truncated the way a multi-document `find` can (MONEY-1189 — a truncated
 * firstBatch manufactures gaps and following the cursor does not fix it, since
 * `$runCommandRaw` has no `getMore`). The grouped arrays inside it are bounded
 * by the number of distinct `source` values (4) and `basis` values (3), not by
 * the row count.
 */
export async function readBasisCensus(
  run: RawCommandRunner,
  collection: string = COLLECTION,
): Promise<BasisCensus> {
  const res = (await run({
    aggregate: collection,
    pipeline: [
      {
        $facet: {
          total: [{ $count: "n" }],
          missingBasis: [{ $match: missingBasisFilter() }, { $count: "n" }],
          stampable: [{ $match: stampFilter() }, { $count: "n" }],
          projectionSkipped: [
            { $match: projectionSkipFilter() },
            { $count: "n" },
          ],
          explicitNull: [
            { $match: explicitNullBasisFilter() },
            { $count: "n" },
          ],
          alreadyStamped: [{ $match: alreadyStampedFilter() }, { $count: "n" }],
          missingBySource: [
            { $match: missingBasisFilter() },
            { $group: { _id: "$source", n: { $sum: 1 } } },
          ],
          presentByBasis: [
            { $match: { basis: { $exists: true } } },
            { $group: { _id: "$basis", n: { $sum: 1 } } },
          ],
        },
      },
    ],
    cursor: {},
  })) as FacetBatch;

  const facet = res.cursor?.firstBatch?.[0] ?? {};
  return {
    total: facetCount(facet, "total"),
    missingBasis: facetCount(facet, "missingBasis"),
    stampable: facetCount(facet, "stampable"),
    projectionSkipped: facetCount(facet, "projectionSkipped"),
    explicitNull: facetCount(facet, "explicitNull"),
    alreadyStamped: facetCount(facet, "alreadyStamped"),
    missingBySource: facetGroups(facet, "missingBySource").map((g) => ({
      source: g.id,
      n: g.n,
    })),
    presentByBasis: facetGroups(facet, "presentByBasis").map((g) => ({
      basis: g.id,
      n: g.n,
    })),
  };
}

/**
 * The buckets must PARTITION the population, or the report is describing
 * something other than what the write will do.
 *
 * Returns a message when they do not, `null` when they do. A returned message
 * is fatal at the call site: a plan whose halves do not sum to its own total is
 * a plan nobody can approve, and this repo has shipped three completeness
 * checks at the wrong granularity that each reported SUCCESS (MONEY-1189).
 */
export function censusAccountingError(c: BasisCensus): string | null {
  const parts = c.stampable + c.projectionSkipped;
  if (parts !== c.missingBasis) {
    return (
      `bucket accounting failed: stampable ${c.stampable} + projection-owned ` +
      `${c.projectionSkipped} = ${parts}, but ${c.missingBasis} rows are ` +
      `missing a basis. The two filters must PARTITION the missing-basis ` +
      `population; they no longer do.`
    );
  }
  const grouped = c.missingBySource.reduce((a, g) => a + g.n, 0);
  if (grouped !== c.missingBasis) {
    return (
      `bucket accounting failed: the per-source breakdown sums to ${grouped}, ` +
      `but ${c.missingBasis} rows are missing a basis.`
    );
  }
  if (c.missingBasis > c.total) {
    return (
      `bucket accounting failed: ${c.missingBasis} rows missing a basis in a ` +
      `collection of ${c.total}. The census is reading two different things.`
    );
  }
  return null;
}

interface Options {
  apply: boolean;
  env: "qa" | "prod" | null;
  samples: number;
}

/**
 * Flags this script understands. Anything else is REFUSED rather than ignored:
 * `argv.includes()` silently drops what it does not recognise, which is how a
 * sibling came to accept-and-ignore `--dry-run` alongside `--apply` (i.e. it
 * WROTE).
 */
const KNOWN_FLAGS = new Set(["--apply", "--env", "--samples"]);

const MAX_SAMPLES = 50;

export function parseArgs(argv: string[]): Options {
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

  const samplesRaw = val("--samples");
  let samples = 8;
  if (samplesRaw !== null) {
    const n = Number(samplesRaw);
    if (!Number.isInteger(n) || n <= 0) {
      throw new Error(
        `--samples must be a positive integer, got "${samplesRaw}".`,
      );
    }
    // A `find` through `$runCommandRaw` returns only `cursor.firstBatch` and
    // there is no `getMore` from here, so a large `--samples` would silently
    // return fewer rows than asked for. Refuse instead of under-reporting.
    if (n > MAX_SAMPLES) {
      throw new Error(
        `--samples is capped at ${MAX_SAMPLES}: a raw find returns only ` +
          `cursor.firstBatch and this script cannot issue a getMore, so a ` +
          `bigger number would silently print fewer rows than requested.`,
      );
    }
    samples = n;
  }

  const apply = has("--apply");
  // Fail FAST, before any connection. `--apply` on a closed stdin can never
  // succeed, and a hung prompt exits 0 — which a wrapper's `&&` reads as
  // success. An agent runs dry runs; a human runs writes.
  if (apply && !process.stdin.isTTY) {
    throw new Error(
      "--apply requires an interactive terminal: the confirmation prompt " +
        "cannot be answered when stdin is not a TTY (a pipe, </dev/null, or a " +
        "CI runner). Refusing rather than hanging.",
    );
  }

  return { apply, env: (env as "qa" | "prod" | null) ?? null, samples };
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
  if (!out) throw new Error(`Secret ${secret} resolved empty.`);
  return out;
}

/** Host of a Mongo URI, for display. Never prints a credential. */
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

async function confirmWrite(
  uri: string,
  envLabel: string,
  stampable: number,
): Promise<void> {
  const host = maskedHost(uri);
  if (!host) {
    // Refuse rather than prompt with a placeholder: the prompt exists so the
    // operator can SEE what they are about to hit.
    console.error(
      "\n  Refusing to write: could not determine the target host from " +
        "DATABASE_URL.\n",
    );
    process.exit(1);
  }
  if (!process.stdin.isTTY) {
    console.error(
      "\n  Refusing to write: stdin is not a TTY, so the confirmation cannot " +
        "be answered.\n",
    );
    process.exit(1);
  }
  process.stdout.write(
    `\n!!  This will WRITE to a database.\n` +
      `      target : ${host}\n` +
      `      source : ${envLabel}\n` +
      `      change : basis = "${UNKNOWN_BASIS}" on ${stampable} row(s) of ` +
      `${COLLECTION}\n` +
      `   Nothing else is touched — no figures, no source, no rawData.\n` +
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

function pad(n: number, width: number): string {
  return String(n).padStart(width, " ");
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

  // DEFERRED, and it has to be. `@usemoney/database` builds its PrismaClient at
  // MODULE scope from `process.env.DATABASE_URL`, and ESM evaluates every
  // static import before any statement here — so a static import would pin the
  // client to the shell's database while `confirmWrite` echoed the one `--env`
  // resolved. The operator types "yes" to one database and writes to another.
  const { prisma } = await import("@usemoney/database");

  const run: RawCommandRunner = (command) =>
    prisma.$runCommandRaw(
      command as Parameters<typeof prisma.$runCommandRaw>[0],
    ) as unknown as Promise<RawDoc>;

  console.log(
    `\n${COLLECTION}.basis backfill — ${opts.apply ? "APPLY" : "DRY RUN"}\n` +
      `  target : ${maskedHost(uri) ?? "<unknown host>"}\n` +
      `  source : ${envLabel}\n`,
  );

  const census = await readBasisCensus(run);

  // The `@@map` guard. `aggregate` against a collection name that does not
  // exist returns an EMPTY result rather than an error, so without this a
  // rename would turn every number below into a confident zero.
  const prismaTotal = await prisma.stockFinancials.count();
  if (census.total !== prismaTotal) {
    throw new Error(
      `Aborting: the raw aggregate over "${COLLECTION}" counted ${census.total} ` +
        `documents, Prisma counted ${prismaTotal}. Either the @@map changed or ` +
        `the aggregate hit a collection that does not exist — an empty result ` +
        `reads as a clean bill and must never be trusted as one.`,
    );
  }

  const accounting = censusAccountingError(census);
  if (accounting) throw new Error(`Aborting: ${accounting}`);

  // What the BROKEN filter sees, printed beside what is really there. This is
  // the defect the ticket is about, stated as two numbers on the same screen
  // rather than as a paragraph nobody reads (the shape
  // `migrations/stamp-welcome-email-backfill.ts` established).
  const prismaBareNull = await prisma.stockFinancials.count({
    // prisma-null-ok: measuring what the BROKEN filter sees, on purpose. This
    // is the number the header is about — it reads 0 against a population of
    // tens of thousands, because Prisma's Mongo connector matches an explicit
    // JSON null and never an absent key.
    where: { basis: null },
  });

  const w = Math.max(
    6,
    String(Math.max(census.total, census.missingBasis)).length,
  );
  // Labels padded from ONE width so the two numbers an operator is meant to
  // compare — the raw count and what a Prisma `where` can see — land in the
  // same column. A defect stated as two figures that do not line up is a defect
  // that gets skimmed.
  const rows: Array<[label: string, n: number, note: string]> = [
    [`rows in ${COLLECTION}`, census.total, ""],
    ["basis ABSENT (raw $exists:false)", census.missingBasis, ""],
    [
      "basis null per PRISMA's { basis: null }",
      prismaBareNull,
      "<- all a Prisma where can see",
    ],
    [
      "basis EXPLICIT null (present key, null value)",
      census.explicitNull,
      "<- outside $exists:false's reach, by design",
    ],
    [`already stamped "${UNKNOWN_BASIS}"`, census.alreadyStamped, ""],
  ];
  const labelWidth = Math.max(...rows.map(([l]) => l.length));
  console.log(
    rows
      .map(
        ([label, n, note]) =>
          `  ${label.padEnd(labelWidth)} : ${pad(n, w)}${note ? `   ${note}` : ""}`,
      )
      .join("\n") + "\n",
  );

  console.log(
    `  plan\n` +
      `    ${pad(census.stampable, w)}  stamp basis = "${UNKNOWN_BASIS}"  (vendor rows, no basis recorded)\n` +
      `    ${pad(census.projectionSkipped, w)}  SKIPPED — source in [${PROJECTION_OWNED_SOURCES.join(", ")}]; ` +
      `the projection owns these rows' basis\n`,
  );

  if (census.missingBySource.length > 0) {
    console.log("  rows missing a basis, by source:");
    for (const g of census.missingBySource) {
      const owned = PROJECTION_OWNED_SOURCES.includes(g.source);
      console.log(
        `    ${pad(g.n, w)}  ${g.source}${owned ? "   (skipped)" : ""}`,
      );
    }
    console.log("");
  }

  if (census.presentByBasis.length > 0) {
    console.log("  rows that already carry a basis:");
    for (const g of census.presentByBasis) {
      console.log(`    ${pad(g.n, w)}  ${g.basis}`);
    }
    console.log("");
  }

  if (census.stampable > 0 && opts.samples > 0) {
    const sampleRes = (await run({
      find: COLLECTION,
      filter: stampFilter(),
      projection: {
        _id: 0,
        symbol: 1,
        exchange: 1,
        statementType: 1,
        periodType: 1,
        period: 1,
        source: 1,
      },
      limit: opts.samples,
    })) as FacetBatch;
    const rows = sampleRes.cursor?.firstBatch ?? [];
    console.log(`  e.g. (${rows.length} of ${census.stampable}):`);
    for (const r of rows) {
      console.log(
        `    ${String(r.symbol)}/${String(r.exchange)}  ${String(r.statementType)}  ` +
          `${String(r.periodType)} ${String(r.period)}  [${String(r.source)}]`,
      );
    }
    console.log("");
  }

  console.log(
    `  IDEMPOTENT by construction: the selection is "basis absent" and the ` +
      `write gives\n` +
      `  those rows a basis, so a second run selects — and modifies — zero.\n`,
  );

  if (!opts.apply) {
    console.log(
      `  DRY RUN — nothing written. Would stamp ${census.stampable} row(s).\n` +
        `  Re-run with --apply (prompts, needs a TTY).\n`,
    );
    await prisma.$disconnect();
    return;
  }

  if (census.stampable === 0) {
    console.log("  Nothing to stamp.\n");
    await prisma.$disconnect();
    return;
  }

  await confirmWrite(uri, envLabel, census.stampable);

  const { matched, modified } = await applyBasisStamp(run);
  console.log(`\n  matched ${matched} row(s), modified ${modified}.\n`);

  // ── verify, through the OTHER route ─────────────────────────────────────
  //
  // PRISMA, not the raw predicate the write selected with. The adversary is a
  // write that sets `basis: null`: the raw "still missing" count would go to
  // ZERO and report success, because the attribute would then EXIST. Only this
  // ordinary equality notices that nothing readable landed.
  const prismaStamped = await prisma.stockFinancials.count({
    where: { basis: UNKNOWN_BASIS },
  });
  const after = await readBasisCensus(run);

  console.log(
    `  post-write\n` +
      `    basis == "${UNKNOWN_BASIS}" per PRISMA : ${prismaStamped}\n` +
      `    basis == "${UNKNOWN_BASIS}" per RAW    : ${after.alreadyStamped}\n` +
      `    basis still ABSENT (stampable)   : ${after.stampable}\n`,
  );

  if (prismaStamped !== after.alreadyStamped) {
    throw new Error(
      `Verification FAILED: Prisma counts ${prismaStamped} rows at ` +
        `basis="${UNKNOWN_BASIS}" while raw Mongo counts ${after.alreadyStamped}. ` +
        `The two routes must agree; they were chosen to disagree only when ` +
        `something unreadable was written.`,
    );
  }
  if (prismaStamped < modified) {
    throw new Error(
      `Verification FAILED: ${modified} row(s) were modified but Prisma can ` +
        `only see ${prismaStamped} at basis="${UNKNOWN_BASIS}". A write that ` +
        `lands a value no reader can match is the defect this script exists ` +
        `to remove, not a variant of fixing it.`,
    );
  }
  if (after.stampable !== 0) {
    throw new Error(
      `Verification FAILED: ${after.stampable} vendor row(s) still have no ` +
        `basis after the write. Idempotency is a property of the filter, so a ` +
        `non-zero residual means the write and the selection have drifted.`,
    );
  }

  console.log(
    `  verified: every vendor row now carries a basis, and it is readable ` +
      `through an ordinary Prisma equality.\n`,
  );

  await prisma.$disconnect();
}

/* ── entry point ────────────────────────────────────────────────────────── */

/**
 * `main()` runs ONLY when this file is what was executed.
 *
 * `packages/core/__tests__/market-data/financials-basis-backfill.test.ts`
 * imports the filters and `applyBasisStamp` from here to drive them against a
 * fake. An unguarded `main()` would reach for a DATABASE_URL and shell out to
 * gcloud the moment that test imported the file.
 *
 * The failure direction matters: `process.argv[1]` is undefined only when there
 * is no script entry at all, and any direct `npx tsx …` invocation matches — so
 * the gate cannot be silently disarmed by a missing env var. That is the
 * MF_METADATA_PROVIDER shape (MONEY-1214) this repo has paid for twice.
 */
const invokedDirectly =
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(process.argv[1]).href;

if (invokedDirectly) {
  main().catch((err: unknown) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
