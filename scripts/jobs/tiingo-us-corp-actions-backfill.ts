/**
 * US corporate-actions backfill from Tiingo — dividends and splits —
 * MONEY-1263.
 *
 * Walks a range of EX-DATES, fetching both market-wide routes for each trading
 * day, archiving the raw CSV and writing `UsCorporateAction`, checkpointing
 * every (day, route) so the run is resumable.
 *
 * ## Why a DAY walk and not a symbol walk
 *
 * Measured 2026-08-28: the market-wide form takes exactly one `exDate` and
 * REJECTS `startExDate` / `endExDate` (those work only on the per-ticker form),
 * and omitting `exDate` is a 400 `{"detail":"Error: Must provide an exDate."}`.
 * So there is no market-wide range query and the population is DAYS.
 *
 * That is the better axis anyway, for two reasons that are not about the API:
 *
 *   - **Cost is independent of the universe.** ~522 requests per YEAR of
 *     history (261 weekdays x 2 routes), against ~145,000 for a symbol walk
 *     over 72,685 listings x 2 routes. At the Commercial plan's 20,000/hour
 *     that is ~94 seconds a year versus ~7.3 hours.
 *   - **It reaches securities no master still lists.** A symbol walk can only
 *     ask about tickers it already knows, so every delisted name that fell out
 *     of `supported_tickers.csv` is invisible to it. The market-wide day form
 *     returns whatever filed that day, whether or not we carry it — which is
 *     exactly why `UsCorporateAction.listingId` is nullable.
 *
 * ## Why a script and not a Pub/Sub worker
 *
 * Same reason as `tiingo-us-backfill.ts` and `feed-backfill.ts`: a push
 * subscription has a 600s ack deadline and a multi-year walk runs far past it,
 * so Pub/Sub would redeliver mid-run and put two walkers on the same days. A
 * script (or Cloud Run Job) has no deadline and is restartable. The NIGHTLY
 * freshness leg is a worker and is a different piece of work.
 *
 * ## Usage
 *
 * ### Cloud Run Job (MONEY-1263) — the primary form
 *
 * This lives in `scripts/jobs/` and is a tsup ENTRY
 * (`dist/tiingo-us-corp-actions-backfill.js`), provisioned by
 * `scripts/ops/setup-tiingo-backfill-job.sh`:
 *
 *   gcloud run jobs execute tiingo-us-corp-actions-backfill-prod \
 *     --region=asia-south1 --args=--apply,--from=1990-01-01,--to=1999-12-31
 *
 * The EQUALS form is required and it SURVIVES gcloud's `--args` comma split
 * (verified against googlecloudsdk.calliope.arg_parsers.ArgList: that string
 * arrives as `["--apply","--from=1990-01-01","--to=1999-12-31"]`).
 *
 * >>> DO NOT copy `setup-bse-backfill-job.sh`'s dialect. That script's parser
 * >>> demands the SPACE form (`--from-year 2024`) and REJECTS equals; this one
 * >>> is the exact inverse. Two backfill scripts in one repo with opposite argv
 * >>> contracts — MONEY-1261 lost a chain to this, in the other direction.
 *
 * ### Local (dry runs only)
 *
 *   node --import tsx scripts/jobs/tiingo-us-corp-actions-backfill.ts --from=2020-01-01
 *   node --import tsx scripts/jobs/tiingo-us-corp-actions-backfill.ts --from=2020-01-01 --apply
 *   node --import tsx scripts/jobs/tiingo-us-corp-actions-backfill.ts --from=1990-01-01 --to=1999-12-31 --apply
 *   node --import tsx scripts/jobs/tiingo-us-corp-actions-backfill.ts --from=2020-01-01 --apply --limit=20
 *   node --import tsx scripts/jobs/tiingo-us-corp-actions-backfill.ts --from=2026-08-01 --apply --retry-terminal
 *
 * DRY RUN IS THE DEFAULT and `--apply` is a BARE FLAG, never `--apply=true`.
 * MONEY-1252: a wrapper that forwarded `--flag=value` had its `--apply`
 * swallowed, and a 54-minute "apply" run wrote nothing while exiting 0.
 *
 * That is now ENFORCED rather than merely documented — every option is
 * `--flag` or `--flag=value`, the SPACE form is refused, and an unknown or
 * unparseable token exits 1 before the first request. `--to 1999-12-31` used
 * to fall back to yesterday and turn a 2,600-request walk into an 18,600-request
 * one. See the `tiingo-cli-args` region below.
 *
 * ## Three ways the run STOPS
 *
 * A rate limit (which includes the daily cap), an auth/entitlement refusal, and
 * — added by the MONEY-1263 review — a moved route or a changed feed shape.
 * All four are GLOBAL conditions: true for one ex-date means true for all of
 * them, so collecting the same verdict once per day is pure waste. Each exits
 * NON-ZERO. See {@link judgeNotFoundStreak} and the `SHAPE` arm in `main`.
 *
 * Run it on PROD, where `FEED_ARCHIVE_MODE=archive`; QA receives the same bytes
 * through the nightly feeds mirror instead of spending the quota twice.
 *
 * **Do not run this at the same time as `tiingo-us-backfill.ts`.** The two
 * clients hold SEPARATE throttles against ONE account-wide quota — see the
 * module header of `tiingo-corp-actions.ts` for the arithmetic and the durable
 * fix.
 */

import "dotenv/config";
import { judgeBackfillOutcome } from "@usemoney/core/ops/backfill-outcome";

import prisma from "@usemoney/database";
import { reportBuildProvenance } from "@usemoney/core/ops/build-provenance";
import {
  fetchDistributionsByExDate,
  fetchSplitsByExDate,
} from "@usemoney/core/market-data/tiingo/tiingo-corp-actions";
import {
  dedupeCorpActions,
  enumerateExDates,
  TiingoCorpActionsShapeError,
  toUsCorporateActionRows,
  type CorpActionListingWindow,
  type UsCorporateActionRow,
} from "@usemoney/core/market-data/tiingo/tiingo-corp-actions-logic";
import {
  fetchSupportedTickers,
  TiingoAuthError,
  TiingoRateLimitError,
} from "@usemoney/core/market-data/tiingo/tiingo-client";
import {
  resolveTiingoPlan,
  tiingoLimits,
} from "@usemoney/core/market-data/tiingo/tiingo-logic";
import { selectPrimaryListings } from "@usemoney/core/market-data/instruments/tiingo-instruments-logic";
import { initJobTelemetry } from "../../workers/src/lib/job-telemetry";

/**
 * ## The checkpoint: `BackfillCheckpoint`, shared with a distinct jobKey
 *
 * Shared rather than given its own model, and the fit is now exact rather than
 * merely workable:
 *
 *   `jobKey`  namespaces this walk from `tiingo-us-eod`, which is what the
 *             column exists for ("e.g. `tiingo-us-eod`", per the schema).
 *   `itemKey` holds the EX-DATE. The population of this walk is DAYS, so the
 *             day IS the unit a checkpoint has to identify.
 *   `scope`   holds the ROUTE (`DISTRIBUTIONS` / `SPLITS`). One day is TWO
 *             independent fetches, and a run killed between them must not redo
 *             the one that finished. Putting the route here is what makes
 *             `@@unique([jobKey, itemKey, scope])` collision-free for this
 *             walk — the same trick, in reverse, that MONEY-980 needed when
 *             two `DOW` listings collapsed onto one key and one verdict
 *             silently overwrote the other.
 *
 * Everything else lines up without stretching: `rows` = actions parsed,
 * `bytes` = raw response size (this feed is metered on bandwidth),
 * `firstTs`/`lastTs` = the ex-date itself, `detail` = the error text.
 *
 * ## The columns used to be called `symbol` and `exchange`
 *
 * This block used to be an apology. The model was `CandleBackfillCheckpoint`
 * and this walk stored a DATE in a column named `symbol` and a ROUTE in one
 * named `exchange`, with a paragraph here explaining that the columns are
 * free-text and that a dedicated model was not worth a migration. Both jobs
 * worked; the schema said something false about both, and every query an
 * operator ran returned ex-dates under a `symbol` heading.
 *
 * The rename to `itemKey` / `scope` cost nothing to migrate — measured
 * 2026-08-28, `candle_backfill_checkpoints` held ZERO rows in QA and did not
 * exist at all in prod — so the generic name is now simply true. A name that
 * has to be read as a lie at every call site is a name that will eventually be
 * believed.
 */
const JOB_KEY = "tiingo-us-corp-actions";

/** The `scope` column's two values for this walk. See {@link JOB_KEY}. */
const ROUTES = ["DISTRIBUTIONS", "SPLITS"] as const;
type Route = (typeof ROUTES)[number];

/**
 * Verdicts that mean "asked and answered — do not ask again".
 *
 * `EMPTY` is terminal and that is deliberate: a market holiday genuinely has no
 * corporate actions, answers 200 `None`, and re-fetching it every run forever
 * is pure waste. `--retry-terminal` re-opens them for the one case where it is
 * wrong — see {@link DEFAULT_TO_OFFSET_DAYS}.
 *
 * ## `NOT_FOUND` was here and has been REMOVED — MONEY-1263 review, F3
 *
 * It never described a DAY. The client is explicit that `null` means the ROUTE
 * 404'd (an empty day is a 200 `None`, and a bad path answers 404 with HTML),
 * which is a GLOBAL condition: if it is true for one ex-date it is true for
 * every ex-date in the run. Recording it per-day AND treating it as terminal
 * meant that a renamed endpoint on a `--from=1990-01-01` walk burned ~18,000
 * requests writing ~18,000 permanent "there was nothing there" verdicts,
 * printed `DONE ... notFound=9000`, exited 0, and made every later run skip the
 * entire window.
 *
 * The status STRING is kept — it is the honest label for what happened and the
 * schema already lists it — but it is no longer terminal, so a re-run after the
 * path is fixed repairs the window without `--retry-terminal`. `SHAPE` (a
 * parser that refused the response's header) is excluded for the same reason,
 * and so is `ERROR`. All three are global-ish conditions the operator fixes
 * once; none of them is a fact about the day.
 */
const TERMINAL_STATUSES = ["DONE", "EMPTY"];

/**
 * How far back from today `--to` defaults, in days.
 *
 * ONE, not zero. Today's ex-dates are still landing: a day fetched at 10:00
 * and checkpointed DONE would never be re-walked, so any action filed later
 * that day is lost until someone notices a hole. Yesterday is settled.
 *
 * This is the same class of defect as a `desc` rotation over a growing
 * population (MONEY-1255) — a walk that records "done" for a unit that is not
 * finished — and it costs one day of latency to avoid entirely. The nightly
 * worker leg, not this script, is what keeps the recent window fresh.
 */
const DEFAULT_TO_OFFSET_DAYS = 1;

/** Concurrent upserts per chunk. Bounded so one day cannot swamp the pool. */
const WRITE_CHUNK = 25;

/* tiingo-cli-args:begin
 *
 * The argv parser, and why it REFUSES instead of defaulting — MONEY-1263
 * review, F4.
 *
 * ## The old parser failed in the direction of "do far more work than asked"
 *
 * It was two lines, identical in all three Tiingo scripts, and it accepted
 * exactly one spelling:
 *
 *     const arg = (name) => argv.find((a) => a.startsWith(`--${name}=`))?...
 *
 * Every other spelling returned `undefined`, silently, and NOTHING rejected an
 * unrecognised token. Four measured consequences, and every one of them WIDENS
 * the run:
 *
 *   `--to 1999-12-31`  the space form. `TO` fell back to its default, so a
 *                      1990-1999 walk became 1990-today: ~18,600 requests
 *                      instead of ~2,600.
 *   `--limit 500`      `Number(undefined) || 0` = 0, and 0 is these scripts'
 *                      sentinel for NO LIMIT — the entire population, from an
 *                      operator who asked for 500.
 *   `--limit=abc`      `Number("abc")` is NaN and `NaN || 0` is 0. Unlimited
 *                      again, this time from a typo.
 *   `--apply=true`     neither detected by `argv.includes("--apply")` NOR
 *                      rejected, so a multi-hour walk ran as a DRY RUN and
 *                      exited 0 having written nothing. That is exactly the
 *                      MONEY-1252 / MONEY-1261 wrapper shape these files' own
 *                      headers warn about, rebuilt in the parser underneath the
 *                      warning.
 *
 * A parser whose failure mode is "bigger job" is worse than no parser at all:
 * the operator's model and the machine's behaviour diverge silently, and only
 * the machine is right. An unparseable argument must never resolve to more
 * work — it must stop the run before the first request is issued.
 *
 * ## The rules
 *
 * Every token is `--flag` or `--flag=value`; every flag must be known; a BARE
 * flag must never carry `=`; a VALUED flag must always carry a non-empty `=`
 * value; a NUMERIC value must be a positive integer; no flag may repeat.
 * Anything else throws.
 *
 * The SPACE form is rejected rather than supported. Supporting it makes
 * `--symbols AAPL --apply` ambiguous, and the sibling that does support it
 * (`backfill-financials-from-rawdata.ts`) needed a `next.startsWith("--")`
 * special case to stay safe. One spelling, enforced, is smaller than two
 * spellings plus a disambiguation rule — and the error message names the `=`
 * form, so the space form costs one re-run rather than a wrong one.
 *
 * ## Why this region is marked
 *
 * It is byte-identical in all three scripts and pinned that way by
 * `tiingo-script-decisions.test.ts`, which lifts it out of each real file into
 * a temp ESM module and EXECUTES it. Three copies of a rule drift; three copies
 * a test compares cannot. Everything below is pure and import-free so the lift
 * needs nothing but the region itself.
 */
export interface TiingoCliSpec {
  /** Flags that are present or absent. `--apply`, never `--apply=true`. */
  readonly bare: readonly string[];
  /** Flags that REQUIRE a value: `--from=2020-01-01`. */
  readonly valued: readonly string[];
  /** Of {@link TiingoCliSpec.valued}, those whose value must be a positive integer. */
  readonly numeric: readonly string[];
}

/** Thrown for any argv this parser does not fully understand. */
export class TiingoCliError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TiingoCliError";
  }
}

export interface TiingoCliArgs {
  /** Was this BARE flag passed? */
  has(flag: string): boolean;
  /** A VALUED flag's value, or undefined when it was not passed. */
  value(flag: string): string | undefined;
  /** A NUMERIC flag's value, or `fallback` when it was not passed. */
  number(flag: string, fallback: number): number;
}

export function parseTiingoCliArgs(
  argv: readonly string[],
  spec: TiingoCliSpec,
): TiingoCliArgs {
  const known = new Set([...spec.bare, ...spec.valued]);
  const usage =
    "Known flags: " +
    [
      ...spec.bare.map((f) => `--${f}`),
      ...spec.valued.map((f) => `--${f}=<value>`),
    ].join(" ") +
    ".";

  const flags = new Set<string>();
  const values = new Map<string, string>();

  for (const token of argv) {
    if (!token.startsWith("--")) {
      throw new TiingoCliError(
        `Unexpected argument "${token}". Every option is --flag or ` +
          "--flag=value; there are no positional arguments and the SPACE form " +
          'is not accepted, because "--limit 500" used to parse as no limit at ' +
          `all — i.e. every row. ${usage}`,
      );
    }

    const eq = token.indexOf("=");
    const name = (eq < 0 ? token : token.slice(0, eq)).slice(2);

    if (!known.has(name)) {
      throw new TiingoCliError(
        `Unknown flag "--${name}". Refusing to run rather than ignoring an ` +
          `option you believed was in effect. ${usage}`,
      );
    }
    if (flags.has(name) || values.has(name)) {
      throw new TiingoCliError(
        `--${name} was given more than once. Refusing to guess which ` +
          "occurrence wins.",
      );
    }

    if (eq < 0) {
      if (!spec.bare.includes(name)) {
        throw new TiingoCliError(
          `--${name} requires a value and the SPACE form is not accepted. ` +
            `Use --${name}=<value>. A flag whose value was swallowed used to ` +
            `read as "not passed", which for --limit and --to means the WHOLE ` +
            `population. ${usage}`,
        );
      }
      flags.add(name);
      continue;
    }

    if (spec.bare.includes(name)) {
      throw new TiingoCliError(
        `--${name} is a BARE flag: spell it exactly "--${name}". "${token}" ` +
          "is not accepted. MONEY-1252 — a wrapper that rewrote --apply as " +
          '--apply=true had it silently ignored, and a 54-minute "apply" run ' +
          "wrote nothing and exited 0.",
      );
    }

    const raw = token.slice(eq + 1);
    if (raw.trim() === "") {
      throw new TiingoCliError(
        `--${name}= was given with an EMPTY value. Refusing rather than ` +
          "treating it as absent — an absent --symbols or --limit is the " +
          "whole population.",
      );
    }
    values.set(name, raw);
  }

  for (const name of spec.numeric) {
    const raw = values.get(name);
    if (raw === undefined) continue;
    // A POSITIVE integer, matched on the STRING. `Number()` accepts "1e3",
    // " 12 ", "0x10" and "Infinity", and the old parser's `Number(x) || 0`
    // turned every rejection into 0 — the sentinel for NO LIMIT. A regex is
    // the only form in which "not a number" cannot become "everything".
    if (!/^[1-9]\d*$/.test(raw.trim())) {
      throw new TiingoCliError(
        `--${name}=${raw} is not a positive integer. Refusing to run: the old ` +
          "parser turned an unparseable value into 0, and 0 is the sentinel " +
          "for NO LIMIT — so a typo silently widened the run to the entire " +
          "population.",
      );
    }
  }

  return {
    has: (flag) => flags.has(flag),
    value: (flag) => values.get(flag),
    number: (flag, fallback) => {
      const raw = values.get(flag);
      return raw === undefined ? fallback : Number(raw.trim());
    },
  };
}
/* tiingo-cli-args:end */

/* corp-actions-notfound-breaker:begin
 *
 * A moved ROUTE must stop the run, not accumulate per-day verdicts —
 * MONEY-1263 review, F3.
 *
 * `fetchDistributionsByExDate` / `fetchSplitsByExDate` return `null` for a 404,
 * and a 404 on these routes means the PATH is wrong: an empty day is a 200 with
 * the four-byte body `None`, and a bad path answers 404 with plain HTML. So a
 * null is never a statement about the ex-date — it is a statement about the
 * endpoint, and it is equally true of every other day in the range.
 *
 * Without a breaker, a rename upstream turns a `--from=1990-01-01` run into
 * ~18,000 paced requests that all 404, each one recorded and (until this fix)
 * TERMINAL. Two things are needed and neither substitutes for the other:
 * de-terminalising the verdict (see {@link TERMINAL_STATUSES}) makes the damage
 * repairable, and this breaker keeps the run from spending hours of quota
 * proving the same fact ~18,000 times.
 *
 * ## Why a STREAK and not the first one
 *
 * The threshold is small but it is not one. A single 404 from a CDN edge or a
 * momentary deploy is possible and costs one day; stopping the whole walk on it
 * would make the backfill fragile in the opposite direction. Consecutive is the
 * discriminator: a genuinely moved route cannot answer 200 in between, so any
 * successful fetch resets the count to zero. Five legs is at most two and a half
 * calendar days of the walk.
 *
 * This is the same shape as the rate-limit and auth breakers beside it — a
 * global, non-self-healing condition ends the RUN rather than being re-collected
 * once per unit — with the one difference that those arrive as a typed throw and
 * this one arrives as a perfectly ordinary return value.
 */
export const MAX_CONSECUTIVE_NOT_FOUND = 5;

/**
 * What one (day, route) leg actually got back.
 *
 *   `answered`   a 200 — rows or the four-byte `None`. PROVES the path is live.
 *   `not-found`  a 404 — the client's `null`. Evidence the path is wrong.
 *   `failed`     a throw the leg swallowed (transport, a 5xx past the ladder).
 *                Proves NOTHING either way, which is why it is its own case.
 */
export type CorpActionLegOutcome = "answered" | "not-found" | "failed";

export interface NotFoundStreakVerdict {
  /** The streak AFTER this leg. */
  streak: number;
  /** Non-null once the breaker trips: the run must stop with this reason. */
  stop: string | null;
}

export function judgeNotFoundStreak(
  previousStreak: number,
  outcome: CorpActionLegOutcome,
  context: string,
): NotFoundStreakVerdict {
  // A 200 is the ONLY thing that clears the suspicion, because it is the only
  // outcome that proves the path still resolves.
  if (outcome === "answered") return { streak: 0, stop: null };
  // A transport failure leaves the streak exactly where it was. Resetting on it
  // would let a route that 404s while the network flaps run forever: one
  // `failed` between every two 404s and the breaker never reaches its
  // threshold, which is how a "consecutive" counter quietly becomes a counter
  // of nothing.
  if (outcome === "failed") return { streak: previousStreak, stop: null };

  const streak = previousStreak + 1;
  if (streak < MAX_CONSECUTIVE_NOT_FOUND) return { streak, stop: null };

  return {
    streak,
    stop:
      `ROUTE MOVED — ${streak} consecutive 404s, most recently at ${context}. ` +
      "A 404 on these routes is the PATH, not the day (an empty day is a 200 " +
      "`None`), so every remaining request would 404 too. Stopping instead of " +
      "walking the rest of the range. None of these legs is terminal, so a " +
      "re-run after the path is fixed repairs the window without " +
      "--retry-terminal.",
  };
}
/* corp-actions-notfound-breaker:end */

/** Every flag this script accepts, and how each one must be spelled. */
const CLI_SPEC: TiingoCliSpec = {
  bare: ["apply", "retry-terminal"],
  valued: ["from", "to", "limit"],
  numeric: ["limit"],
};

/**
 * Parse argv, or DIE with the reason on stderr and a NON-ZERO exit.
 *
 * At MODULE scope, so it runs before the security master is fetched, before
 * Prisma is touched, and before a single unit of quota is spent. A `--to`
 * swallowed by the space form used to turn a 1990-1999 walk into 1990-today —
 * ~18,600 requests instead of ~2,600 — which is precisely the kind of mistake
 * that must cost one line of stderr rather than an afternoon.
 */
function parseArgsOrExit(): TiingoCliArgs {
  try {
    return parseTiingoCliArgs(process.argv.slice(2), CLI_SPEC);
  } catch (err) {
    if (err instanceof TiingoCliError) {
      console.error(`[tiingo-corp-actions] ${err.message}`);
      process.exit(1);
    }
    throw err;
  }
}

const ARGS = parseArgsOrExit();

const APPLY = ARGS.has("apply");
const RETRY_TERMINAL = ARGS.has("retry-terminal");
const FROM = ARGS.value("from") ?? "";
/** Max DAYS this run. 0 = the whole range; `--limit=0` is REFUSED. */
const LIMIT = ARGS.number("limit", 0);

function isoDaysAgo(days: number): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - days);
  return d.toISOString().slice(0, 10);
}

const TO = ARGS.value("to") ?? isoDaysAgo(DEFAULT_TO_OFFSET_DAYS);

interface Tally {
  daysConsidered: number;
  fetches: number;
  skippedCheckpoint: number;
  dividends: number;
  splits: number;
  written: number;
  duplicatesDropped: number;
  listingIdResolved: number;
  emptyDays: number;
  notFound: number;
  errors: number;
  bytes: number;
}

// The shape every other Cloud Run job entry point uses (feed-backfill,
// feed-parse, xbrl-backfill): one object with info/warn. It is what
// `reportBuildProvenance` takes, and `@usemoney/logger`'s getLogger() is
// keyed to a fixed LoggerModule union with no entry for a script.
const log = {
  info: (...a: unknown[]) => console.log("[tiingo-corp-actions]", ...a),
  warn: (...a: unknown[]) => console.warn("[tiingo-corp-actions]", ...a),
};

function chunk<T>(rows: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < rows.length; i += size) out.push(rows.slice(i, i + size));
  return out;
}

/**
 * Occupancy windows keyed by UPPERCASE ticker, for `listingId` resolution.
 *
 * One extra request per RUN (the master is a single 800 KB zip), which buys a
 * provable `listingId` on every action whose ex-date falls inside a listing we
 * carry. `resolveListingId` refuses anything outside the window rather than
 * guessing, so a recycled ticker's historical dividends stay null instead of
 * being filed under the successor company.
 *
 * An empty master is a HARD failure, not a degraded run: proceeding would write
 * the whole backfill with `listingId: null` and look entirely successful, and
 * the column can only be repaired afterwards by re-walking every day.
 */
async function loadListingWindows(): Promise<
  Map<string, CorpActionListingWindow>
> {
  const master = await fetchSupportedTickers();
  if (master.length === 0) {
    throw new Error("supported_tickers returned 0 rows — refusing to proceed");
  }
  const { listings, stats } = selectPrimaryListings(master);
  if (listings.length === 0) {
    throw new Error("master yielded 0 US listings — refusing to proceed");
  }
  log.info(
    `master rows=${stats.fetched} inScope=${stats.inScope} ` +
      `listings=${listings.length} recycledDropped=${stats.recycledDropped} ` +
      `newestEndDate=${stats.fileMaxEndDate}`,
  );

  const map = new Map<string, CorpActionListingWindow>();
  for (const l of listings) {
    // Uppercased on the way IN as well as on the way out of the mapper: the
    // master is uppercase today, and a map whose keys silently changed case
    // would miss every lookup while looking perfectly healthy.
    map.set(l.symbol.toUpperCase(), {
      listingId: l.listingId,
      listingStartDate: l.listingStartDate,
      listingEndDate: l.listingEndDate,
    });
  }
  return map;
}

/** Persist one day's rows, returning how many landed. */
async function writeRows(
  rows: readonly UsCorporateActionRow[],
): Promise<number> {
  let written = 0;
  for (const group of chunk(rows, WRITE_CHUNK)) {
    await Promise.all(
      group.map(async (row) => {
        // UPSERT, not createMany+skipDuplicates. Tiingo BACKFILLS the
        // announcement dates (paymentDate / recordDate / declarationDate were
        // added upstream in 2024 and populated back to 2020), so a row we
        // already hold can legitimately gain three columns later. `skipDuplicates`
        // would freeze whatever we saw first and the columns would read as a
        // permanent coverage gap.
        await prisma.usCorporateAction.upsert({
          where: {
            permaTicker_type_exDate: {
              permaTicker: row.permaTicker,
              type: row.type,
              exDate: row.exDate,
            },
          },
          create: row,
          update: {
            symbol: row.symbol,
            listingId: row.listingId,
            distribution: row.distribution,
            distributionFrequency: row.distributionFrequency,
            splitFactor: row.splitFactor,
            splitFrom: row.splitFrom,
            splitTo: row.splitTo,
            paymentDate: row.paymentDate,
            recordDate: row.recordDate,
            declarationDate: row.declarationDate,
            currency: row.currency,
            source: row.source,
          },
        });
        written++;
      }),
    );
  }
  return written;
}

async function checkpoint(args: {
  exDate: string;
  route: Route;
  status: string;
  rows: number;
  bytes: number;
  detail?: string;
}): Promise<void> {
  const { exDate, route, status, rows, bytes, detail } = args;
  const ts = new Date(`${exDate}T00:00:00.000Z`);
  await prisma.backfillCheckpoint.upsert({
    where: {
      jobKey_itemKey_scope: {
        jobKey: JOB_KEY,
        itemKey: exDate,
        scope: route,
      },
    },
    create: {
      jobKey: JOB_KEY,
      itemKey: exDate,
      scope: route,
      status,
      rows,
      bytes,
      firstTs: ts,
      lastTs: ts,
      detail: detail ?? null,
    },
    update: {
      status,
      rows,
      bytes,
      detail: detail ?? null,
      at: new Date(),
    },
  });
}

async function main(): Promise<void> {
  // MONEY-1375 — attach the Datadog log stream. Without this the job logs to
  // stdout only: `initLogger()` had exactly one caller in the whole repo.
  await initJobTelemetry();
  // FIRST. These three run as Cloud Run JOBS, and a job PINS ITS IMAGE AT
  // SETUP TIME — deploying the workers SERVICE does not move it. So this
  // line is the only runtime answer to "is the running job the code I
  // pushed?", and on this repo that has already gone wrong: a MONEY-1189
  // fix sat un-executed on the nightly jobs after release because the job
  // was still on its old pin. `scripts/ops/setup-tiingo-backfill-job.sh`
  // is the ONLY thing that re-pins them.
  reportBuildProvenance(log, "tiingo-us-corp-actions-backfill");

  if (FROM === "") {
    throw new Error(
      "--from=YYYY-MM-DD is REQUIRED. There is deliberately no default: " +
        "Tiingo's history reaches 1962, so an implicit floor would launch a " +
        "~33,000-request walk that nobody asked for.",
    );
  }

  const plan = resolveTiingoPlan();
  const limits = tiingoLimits(plan);
  const allDays = enumerateExDates(FROM, TO);
  if (allDays.length === 0) {
    throw new Error(
      `--from=${FROM} --to=${TO} enumerates 0 trading days — check the range ` +
        "(both bounds must be YYYY-MM-DD and from <= to)",
    );
  }
  const days = LIMIT > 0 ? allDays.slice(0, LIMIT) : allDays;

  log.info(
    `plan=${plan} perHour=${limits.perHour} perDay=${limits.perDay} ` +
      `from=${FROM} to=${TO} weekdays=${allDays.length} selected=${days.length} ` +
      `maxRequests=${days.length * ROUTES.length} ` +
      `apply=${APPLY}${APPLY ? "" : " (DRY RUN — nothing will be written)"}`,
  );

  const listings = await loadListingWindows();

  // Resume set, keyed exactly as the checkpoint is. Terminal verdicts are
  // skipped unless explicitly retried: DONE, EMPTY and NOT_FOUND are all
  // "asked and answered", and EMPTY in particular produces zero rows — without
  // the checkpoint it is indistinguishable from never-attempted and would be
  // re-fetched forever.
  const done = new Set<string>();
  if (!RETRY_TERMINAL) {
    const rows = await prisma.backfillCheckpoint.findMany({
      where: { jobKey: JOB_KEY, status: { in: TERMINAL_STATUSES } },
      select: { itemKey: true, scope: true },
    });
    // `itemKey` is the ex-date and `scope` is the route — the same two values
    // the loop below builds its key from, in the same order.
    for (const r of rows) done.add(`${r.itemKey}::${r.scope}`);
  }
  log.info(`checkpointed already: ${done.size} (day, route) pairs`);

  const t: Tally = {
    daysConsidered: 0,
    fetches: 0,
    skippedCheckpoint: 0,
    dividends: 0,
    splits: 0,
    written: 0,
    duplicatesDropped: 0,
    listingIdResolved: 0,
    emptyDays: 0,
    notFound: 0,
    errors: 0,
    bytes: 0,
  };

  // Set by the circuit-breakers below. Checked at BOTH loop levels: a `break`
  // out of the inner route loop would otherwise hand the next day back to the
  // same wall and spend the remaining budget collecting the same error.
  let stop: string | null = null;
  /** Consecutive 404 legs. See {@link judgeNotFoundStreak}. */
  let notFoundStreak = 0;

  for (const exDate of days) {
    if (stop) break;
    t.daysConsidered++;

    for (const route of ROUTES) {
      if (stop) break;

      const key = `${exDate}::${route}`;
      if (done.has(key)) {
        t.skippedCheckpoint++;
        continue;
      }

      let status = "DONE";
      let detail: string | undefined;
      let bytes = 0;
      let rows: UsCorporateActionRow[] = [];
      let outcome: CorpActionLegOutcome = "failed";
      /**
       * A stop that must be raised only AFTER this leg's checkpoint lands.
       *
       * The rate-limit and auth breakers `break` immediately and write no
       * checkpoint, which is right: they happened before any verdict existed.
       * The 404-streak and shape breakers are different — each has a verdict
       * worth recording on the row an operator will look at first — so they
       * park the reason here and the leg finishes normally.
       */
      let pendingStop: string | null = null;

      try {
        if (route === "DISTRIBUTIONS") {
          const res = await fetchDistributionsByExDate(exDate);
          t.fetches++;
          if (res === null) {
            status = "NOT_FOUND";
            outcome = "not-found";
            detail =
              "route 404'd — a MOVED ENDPOINT, not an empty day (an empty " +
              "day is a 200 with the body `None`). Not terminal: a re-run " +
              "after the path is fixed picks this leg up again.";
            t.notFound++;
          } else {
            outcome = "answered";
            bytes = res.bytes;
            rows = toUsCorporateActionRows({
              distributions: res.rows,
              listings,
            });
            t.dividends += rows.length;
          }
        } else {
          const res = await fetchSplitsByExDate(exDate);
          t.fetches++;
          if (res === null) {
            status = "NOT_FOUND";
            outcome = "not-found";
            detail =
              "route 404'd — a MOVED ENDPOINT, not an empty day (an empty " +
              "day is a 200 with the body `None`). Not terminal: a re-run " +
              "after the path is fixed picks this leg up again.";
            t.notFound++;
          } else {
            outcome = "answered";
            bytes = res.bytes;
            rows = toUsCorporateActionRows({ splits: res.rows, listings });
            t.splits += rows.length;
          }
        }
      } catch (err) {
        if (err instanceof TiingoRateLimitError) {
          // Circuit-break the RUN. Continuing spends the remaining budget
          // collecting the same error; the checkpoint means a later run
          // resumes exactly here.
          //
          // The DAILY CAP arrives as this class too (`TiingoDailyCapError`
          // extends it), so there is deliberately no second arm.
          stop = `RATE LIMITED at ${exDate} ${route} — ${err.message}`;
          break;
        }
        if (err instanceof TiingoAuthError) {
          // Neither a rejected token nor a missing entitlement heals on retry.
          stop = `AUTH/ENTITLEMENT failure at ${exDate} ${route} — ${err.message}`;
          break;
        }
        if (err instanceof TiingoCorpActionsShapeError) {
          // MONEY-1263 review, F5. The response's HEADER is not this feed's
          // header — a renamed or dropped column. GLOBAL by nature: it is the
          // same for every ex-date, so continuing would walk the range writing
          // `SHAPE` (or, before the parser learned to refuse, terminal `EMPTY`)
          // for thousands of days.
          //
          // `SHAPE` is its own status precisely so it is DISTINGUISHABLE from
          // `EMPTY` on the checkpoint row itself, which is where the previous
          // behaviour was indistinguishable from "nothing happened that year".
          // It is not in TERMINAL_STATUSES, so fixing the parser and re-running
          // repairs the window.
          status = "SHAPE";
          detail = err.message;
          t.errors++;
          pendingStop = `FEED SHAPE CHANGED at ${exDate} ${route} — ${err.message}`;
        } else {
          status = "ERROR";
          detail = err instanceof Error ? err.message : String(err);
          t.errors++;
        }
      }

      // Only ever fired for a leg that got an ANSWER (200 or 404); a swallowed
      // transport failure leaves the streak untouched rather than clearing it.
      const nf = judgeNotFoundStreak(
        notFoundStreak,
        outcome,
        `${exDate} ${route}`,
      );
      notFoundStreak = nf.streak;
      if (nf.stop !== null) pendingStop = nf.stop;

      t.bytes += bytes;

      if (status === "DONE") {
        // Dedupe on the FULL (permaTicker, type, exDate) key BEFORE writing.
        // Two rows colliding on the unique key inside one Promise.all is a
        // write conflict rather than an upsert; deduping is also what proves
        // the two-`reax` case is NOT a duplicate (same ticker, two companies,
        // two permaTickers — both must survive).
        const deduped = dedupeCorpActions(rows);
        rows = deduped.rows;
        t.duplicatesDropped += deduped.dropped;
        if (deduped.dropped > 0) {
          log.info(
            `WARN ${exDate} ${route}: ${deduped.dropped} row(s) collided on ` +
              `(permaTicker, type, exDate) — expected 0, worth investigating`,
          );
        }
        t.listingIdResolved += rows.filter((r) => r.listingId !== null).length;
        if (rows.length === 0) {
          // A market holiday, or a weekday nobody filed on. Terminal.
          status = "EMPTY";
          t.emptyDays++;
        }
      }

      if (!APPLY) {
        log.info(
          `DRY ${exDate} ${route} ${status} rows=${rows.length} ` +
            `bytes=${bytes} withListingId=${rows.filter((r) => r.listingId !== null).length}`,
        );
        // A dry run has no checkpoint to wait for, so a parked stop fires here.
        // Without this the breakers would be APPLY-only and the rehearsal would
        // walk the whole range 404ing — the one run where an operator is
        // specifically looking for surprises.
        if (pendingStop !== null) {
          stop = pendingStop;
          break;
        }
        continue;
      }

      if (status === "DONE") {
        try {
          t.written += await writeRows(rows);
        } catch (err) {
          status = "ERROR";
          detail = err instanceof Error ? err.message : String(err);
          t.errors++;
        }
      }

      await checkpoint({
        exDate,
        route,
        status,
        rows: rows.length,
        bytes,
        detail,
      });

      // AFTER the checkpoint, so the leg that tripped the breaker is on the row
      // an operator reads first.
      if (pendingStop !== null) {
        stop = pendingStop;
        break;
      }
    }

    if (t.daysConsidered % 25 === 0) {
      log.info(
        `… ${t.daysConsidered}/${days.length} days fetched=${t.fetches} ` +
          `div=${t.dividends} split=${t.splits} written=${t.written} ` +
          `empty=${t.emptyDays} errors=${t.errors} ` +
          `MB=${(t.bytes / 1024 ** 2).toFixed(1)}`,
      );
    }
  }

  if (stop) log.info(`STOPPED — ${stop}`);

  log.info(
    `DONE days=${t.daysConsidered}/${days.length} fetches=${t.fetches} ` +
      `skipped=${t.skippedCheckpoint} dividends=${t.dividends} ` +
      `splits=${t.splits} rowsWritten=${t.written} ` +
      `duplicatesDropped=${t.duplicatesDropped} ` +
      `withListingId=${t.listingIdResolved} emptyLegs=${t.emptyDays} ` +
      `notFound=${t.notFound} errors=${t.errors} ` +
      `MB=${(t.bytes / 1024 ** 2).toFixed(1)}`,
  );
  if (!APPLY) log.info("DRY RUN — pass --apply (bare flag) to write.");

  // A run that stopped on a circuit-breaker exits NON-ZERO. It processed some
  // days and checkpointed them, so it is not a failure in the "nothing
  // happened" sense — but a wrapper or a Cloud Run Job that reads only the exit
  // code must not read "rate-limited after 3 of 250 days" as success.
  // See `judgeBackfillOutcome` — one rule for all three walks. `emptyDays` and
  // `notFound` are successful answers, not failures.
  const verdict = judgeBackfillOutcome({
    stopped: stop,
    attempted: t.fetches,
    succeeded: t.fetches - t.errors,
    failed: t.errors,
  });
  if (verdict.exitCode !== 0) {
    log.warn(`FAILED RUN — ${verdict.reason}`);
    process.exitCode = verdict.exitCode;
  }
}

main()
  .catch((err) => {
    console.error("[tiingo-corp-actions] FAILED", err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
