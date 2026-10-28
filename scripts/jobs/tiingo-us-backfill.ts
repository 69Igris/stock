/**
 * One-time US EOD backfill from Tiingo — MONEY-980.
 *
 * Walks the US security master and pulls each symbol's ENTIRE price history in
 * a single request, archiving the raw CSV, routing every bar to the tier it
 * belongs in, and checkpointing every symbol so the run is resumable.
 *
 * ## Where the bars go — three destinations, decided per bar
 *
 *   `candles` (Mongo)        an ACTIVE listing's last HOT_WINDOW_YEARS. ~33.8M
 *                            rows / ~4.8GB for equities + ETFs.
 *   GCS cold shard           everything else — every year of a DELISTED
 *                            listing, every pre-window year of a live one. One
 *                            whole-year object per symbol-year, then
 *                            `UsInstrument.coldYearsFrom/To` is stamped so a
 *                            reader never needs a GCS LIST (which fails OPEN
 *                            to `[]` — MONEY-941).
 *   `us_fund_nav`            `assetType: "Mutual Fund"`. A NAV is one daily
 *                            point, not OHLCV, and funds are 72% of all bars.
 *
 * The full 1962-onward universe is 206M bars. Prod Atlas is 37.9GB today with
 * `daily_prices` — 10.66M rows, 32 years of India — at 1.51GB, so the window
 * fits beside it and the universe does not. See the `hot-window-routing`
 * region and the FUND NAV ROUTING banner for the rules and the numbers.
 *
 * ## Why one request per SYMBOL and not per symbol-year
 *
 * Measured 2026-08-28: `/tiingo/daily/AAPL/prices?startDate=1962-01-01` returns
 * all 11,517 bars back to 1980 in one 2.4s call. There is no documented or
 * observed range cap. That turns hundreds of thousands of symbol-years into
 * 72,685 requests — ~3.7 hours at the Commercial plan's 20,000/hour rather
 * than several days. Funds are the bulk of the count (49,414) and the smallest
 * share of the bytes; their series are short.
 *
 * ## Why a script and not a Pub/Sub worker
 *
 * Same reason as `feed-backfill.ts`: a push subscription has a 600s ack
 * deadline and this runs for hours, so Pub/Sub would redeliver mid-run and put
 * two walkers on the same symbols. A script (or Cloud Run Job) has no deadline
 * and is restartable.
 *
 * ## Usage — Cloud Run Job (MONEY-1263)
 *
 * This lives in `scripts/jobs/` and is a tsup ENTRY (`dist/tiingo-us-backfill.js`),
 * so the primary way to run it is the job provisioned by
 * `scripts/ops/setup-tiingo-backfill-job.sh`:
 *
 *   gcloud run jobs execute tiingo-us-eod-backfill-prod --region=asia-south1 \
 *     --args=--apply
 *   gcloud run jobs execute tiingo-us-eod-backfill-prod --region=asia-south1 \
 *     --args=--apply,--only-delisted,--limit=500
 *
 * >>> `--symbols` NEEDS A NON-COMMA DELIMITER. gcloud's `--args` is itself a
 * >>> COMMA-separated list, so `--args=--apply,--symbols=AAPL,MSFT` arrives as
 * >>> `["--apply", "--symbols=AAPL", "MSFT"]` and the parser below REJECTS
 * >>> "MSFT" as a positional. Use gcloud's `^delim^` escape:
 * >>>
 * >>>   --args=^:^--apply:--symbols=AAPL,MSFT
 * >>>
 * >>> Verified against googlecloudsdk.calliope.arg_parsers.ArgList and against
 * >>> this file's own parser. Note the failure is LOUD (exit 1 before the first
 * >>> request), never a silently narrowed symbol set — which is the parser's
 * >>> strictness doing exactly its job.
 *
 * Locally, still useful for a dry run against a scratch DATABASE_URL:
 *
 *   node --import tsx scripts/jobs/tiingo-us-backfill.ts                 # dry run
 *   node --import tsx scripts/jobs/tiingo-us-backfill.ts --apply
 *   node --import tsx scripts/jobs/tiingo-us-backfill.ts --apply --symbols=AAPL,MSFT
 *   node --import tsx scripts/jobs/tiingo-us-backfill.ts --apply --only-delisted --limit=500
 *
 * A laptop is NOT a place to run the real walk: ~3.7h at the Commercial plan's
 * 20,000/hour, and a closed lid kills it mid-walk. It is checkpointed and
 * resumable, so that costs time rather than work — but the job costs neither.
 *
 * DRY RUN IS THE DEFAULT and `--apply` is a bare flag, never `--apply=true`.
 * MONEY-1252: a wrapper that forwarded `--flag=value` had its `--apply`
 * swallowed, and a 54-minute "apply" run wrote nothing while exiting 0.
 *
 * That is now ENFORCED rather than merely documented — every option is
 * `--flag` or `--flag=value`, the SPACE form is refused, and an unknown or
 * unparseable token exits 1 before the first request. See the
 * `tiingo-cli-args` region below for the four measured ways the old parser
 * silently widened a run.
 *
 * Run it on PROD, where `FEED_ARCHIVE_MODE=archive`; QA receives the same bytes
 * through the nightly feeds mirror instead of spending the quota twice.
 */

import "dotenv/config";
import { judgeBackfillOutcome } from "@usemoney/core/ops/backfill-outcome";

import prisma from "@usemoney/database";
import { reportBuildProvenance } from "@usemoney/core/ops/build-provenance";
import { candleRepository } from "@usemoney/core/market-data/candles";
// The hot/cold boundary, imported and never restated — see the `cold-span`
// region for the two failure modes a second copy produces.
import {
  hotWindowFloorYear,
  isRealSplit,
  resolveCandleDestination,
} from "@usemoney/core/market-data/candles/candle-logic";
import {
  fetchSupportedTickers,
  fetchTiingoEod,
  TiingoAuthError,
  TiingoRateLimitError,
} from "@usemoney/core/market-data/tiingo/tiingo-client";
import {
  isRecycledResponse,
  resolveTiingoPlan,
  tiingoLimits,
} from "@usemoney/core/market-data/tiingo/tiingo-logic";
import {
  selectPrimaryListings,
  type TiingoListing,
} from "@usemoney/core/market-data/instruments/tiingo-instruments-logic";
// MONEY-1617 — the writer clip, shared with the nightly.
import {
  clipBarsToListingWindows,
  type ListingRow,
} from "@usemoney/core/market-data/databento/databento-symbology";
// The GCS adapter for the cold shard store, and the same import path the
// sibling jobs use for `initFeedArchive` (`feed-backfill`, `xbrl-backfill`,
// `xbrl-reparse` all reach into `workers/src/lib/` this way). `packages/storage`
// depends on `@usemoney/core`, so core cannot register its own backend.
import { initCandleColdStore } from "../../workers/src/lib/candle-cold-store-gcs";
import { initJobTelemetry } from "../../workers/src/lib/job-telemetry";

const JOB_KEY = "tiingo-us-eod";

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

/* cold-span:begin
 *
 * WHERE EACH BAR LANDS, and why NONE of that rule is stated here.
 *
 * ## The number the split exists to keep down
 *
 * Measured 2026-08-28 against Tiingo's master: the full 1962-onward universe is
 * 206M bars. Prod Atlas is 37.9GB on disk today with `daily_prices` — 10.66M
 * rows, THIRTY-TWO YEARS of India — at just 1.51GB. A 10-year window over
 * equities and ETFs alone is 33.8M rows / ~4.8GB, which fits beside that; the
 * full universe does not, by an order of magnitude. So Mongo holds a ROLLING
 * WINDOW and GCS holds everything.
 *
 * ## The rule lives in ONE place, and it is not this file
 *
 * `resolveCandleDestination` in `@usemoney/core/market-data/candles/candle-logic`
 * owns it, and `putCandles` applies it to every row it is handed — archiving
 * the cold ones itself and reporting `archivedCold` / `coldShards`. So this
 * script hands over the WHOLE response and pre-splits NOTHING.
 *
 * It did, briefly, and the reason that was wrong is worth keeping. A local
 * `HOT_WINDOW_YEARS = 10` plus a local `tierForBar` compiled fine, agreed with
 * core's copy on every input, and was tested — which is exactly what makes the
 * drift invisible. Two live failure modes, and the second is the one this repo
 * keeps paying for:
 *
 *   - a bar the script calls COLD and archives, while ALSO handing it to
 *     `putCandles`, lands in BOTH stores;
 *   - a bar the two copies DISAGREE about lands in NEITHER, while one of them
 *     counts it written. A count that says the work happened and a store that
 *     does not have it.
 *
 * ## What is left here, and why it is not a second copy
 *
 * Two things the repository cannot decide, both of which DELEGATE the boundary
 * rather than restate it — `destinationOf` is injected and the caller passes
 * core's real `resolveCandleDestination`:
 *
 *   1. the COLD YEAR SPAN, for `UsInstrument.coldYearsFrom/To`. `putCandles`
 *      reports how many bars and how many shards, not which years; and the
 *      alternative to storing the span is a GCS LIST, which FAILS OPEN to `[]`
 *      (MONEY-941) and would report "this security has no history" for a
 *      credentials problem.
 *   2. the FUND gate. Funds never reach `putCandles` at all (a NAV is not
 *      OHLCV), so nothing else applies a window to them.
 */

/** A response split by destination, using the rule the CALLER injects. */
export interface HotColdSplit<B> {
  /** Bars the repository will keep in Mongo — or, for a fund, write as NAVs. */
  hot: B[];
  /** How many bars are cold. The YEARS are the span below. */
  coldCount: number;
  /** Oldest COLD year, or null when the listing has none. */
  coldYearsFrom: number | null;
  /** Newest COLD year, or null when the listing has none. */
  coldYearsTo: number | null;
}

/**
 * Split one symbol's whole history by destination.
 *
 * `destinationOf` is a PARAMETER, not an import, and that is the whole point:
 * this function contributes no boundary arithmetic of its own, so it cannot
 * drift from the repository's. The caller passes `resolveCandleDestination`;
 * the test passes the same function, imported from core, so a change to the
 * window in core moves this too and the test proves it.
 *
 * `yearOf` is injected for a smaller reason: the two callers spell a date
 * differently (`"1980-12-12"` from the CSV, a `Date` from a re-read) and a
 * parser buried in a split function is a second place for a timezone to go
 * wrong.
 */
export function splitByDestination<B>(args: {
  bars: readonly B[];
  yearOf: (bar: B) => number;
  listingStatus: string;
  now: Date;
  destinationOf: (a: {
    barYear: number;
    listingStatus: string;
    now: Date;
  }) => string;
}): HotColdSplit<B> {
  const { bars, yearOf, listingStatus, now, destinationOf } = args;

  const hot: B[] = [];
  const coldYears = new Set<number>();
  let coldCount = 0;

  for (const bar of bars) {
    const year = yearOf(bar);
    // A year that did not parse must never silently pick a side. Core routes a
    // non-finite year COLD (the conservative direction), but a cold bar with no
    // integer year cannot be filed under a shard key at all, so it would be
    // archived nowhere while counting as archived. Refusing names the bar.
    if (!Number.isInteger(year)) {
      throw new Error(
        `splitByDestination: bar has a non-integer year (${String(year)}) — ` +
          "refusing to guess a destination for it",
      );
    }
    if (destinationOf({ barYear: year, listingStatus, now }) === "COLD") {
      coldCount++;
      coldYears.add(year);
    } else {
      hot.push(bar);
    }
  }

  const sorted = [...coldYears].sort((x, y) => x - y);
  return {
    hot,
    coldCount,
    coldYearsFrom: sorted.length > 0 ? sorted[0]! : null,
    coldYearsTo: sorted.length > 0 ? sorted.at(-1)! : null,
  };
}

/** Whether the cold-year span may be written, and what to write. */
export interface ColdStampPlan {
  /** Write the stamp at all? */
  stamp: boolean;
  from: number | null;
  to: number | null;
  /** Why not, when `stamp` is false. Goes in the checkpoint `detail`. */
  reason: string | null;
}

/**
 * Decide whether the span this run computed may be recorded.
 *
 * A stamp is a PROMISE that those shard years exist, and a reader trusts it
 * INSTEAD of listing GCS. So a run in which any shard write threw
 * (`coldFailed > 0`) must not stamp: the span would name years whose objects
 * are missing, and the reader has no way to find that out. Leaving the previous
 * value — or nothing — is the recoverable state; a confident wrong span is not.
 */
export function planColdStamp(args: {
  coldYearsFrom: number | null;
  coldYearsTo: number | null;
  coldFailed: number;
}): ColdStampPlan {
  const { coldYearsFrom, coldYearsTo, coldFailed } = args;
  if (coldFailed > 0) {
    return {
      stamp: false,
      from: null,
      to: null,
      reason:
        `${coldFailed} cold bar(s) failed to reach a shard, so the year span ` +
        "was NOT stamped — a stamp is a promise those objects exist and a " +
        "reader trusts it instead of listing GCS.",
    };
  }
  return { stamp: true, from: coldYearsFrom, to: coldYearsTo, reason: null };
}
/* cold-span:end */

/** Every flag this script accepts, and how each one must be spelled. */
const CLI_SPEC: TiingoCliSpec = {
  bare: ["apply", "only-delisted", "only-active", "retry-terminal"],
  valued: ["symbols", "limit"],
  numeric: ["limit"],
};

/**
 * Parse argv, or DIE with the reason on stderr and a NON-ZERO exit.
 *
 * At MODULE scope, so it runs before the security master is fetched, before
 * Prisma is touched, and before a single unit of quota is spent. That ordering
 * is the whole value of the guard: a bad flag must cost one line of stderr, not
 * a 3.7-hour walk that turns out to have been pointed at the wrong population.
 *
 * `process.exit(1)` rather than a rethrow: a throw at module scope prints a
 * stack trace over the message an operator needs, and `main().catch(...)` below
 * never runs because the module never finished evaluating.
 */
function parseArgsOrExit(): TiingoCliArgs {
  try {
    return parseTiingoCliArgs(process.argv.slice(2), CLI_SPEC);
  } catch (err) {
    if (err instanceof TiingoCliError) {
      console.error(`[tiingo-backfill] ${err.message}`);
      process.exit(1);
    }
    throw err;
  }
}

const ARGS = parseArgsOrExit();

const APPLY = ARGS.has("apply");
const ONLY_DELISTED = ARGS.has("only-delisted");
const ONLY_ACTIVE = ARGS.has("only-active");
const SYMBOLS = (ARGS.value("symbols") ?? "")
  .split(",")
  .map((s) => s.trim().toUpperCase())
  .filter(Boolean);
/** Max SYMBOLS this run. 0 = the whole population; `--limit=0` is REFUSED. */
const LIMIT = ARGS.number("limit", 0);
/** Re-attempt symbols previously checkpointed EMPTY / NOT_FOUND / RECYCLED. */
const RETRY_TERMINAL = ARGS.has("retry-terminal");

interface Tally {
  considered: number;
  skippedCheckpoint: number;
  fetched: number;
  written: number;
  empty: number;
  notFound: number;
  recycled: number;
  errors: number;
  bytes: number;
  /** Bars sent to Mongo (`tier: "WINDOW"`). */
  hotBars: number;
  /** Bars written to GCS cold shards. */
  coldBars: number;
  /** Cold shard OBJECTS written — one per symbol-year. */
  coldShards: number;
  /** Fund NAV rows written to `us_fund_nav`. */
  navRows: number;
  /** Funds skipped because no `permaTicker` is known. See `NO_PERMATICKER`. */
  navNoPermaTicker: number;
  /**
   * Fund bars OLDER than the hot window, which have nowhere to go today.
   * Counted rather than silently dropped — see {@link writeFundNavs}.
   */
  navColdDropped: number;
  /**
   * Symbols whose cold-year stamp found NO `us_instruments` row. Every one is
   * a shard on GCS that no reader can discover without a LIST.
   */
  coldStampMissed: number;
  /**
   * MONEY-1617 — bars DROPPED by the writer clip: no master window of the
   * symbol on this venue covers the session (OUTSIDE), or several real ones do
   * and the fetched listing is not among them (AMBIGUOUS). This walk writes ONE
   * listing per ticker, so before the clip a ticker's whole series went under
   * that one id — 46,670 bars under windows that do not cover them.
   */
  clipOutside: number;
  clipAmbiguous: number;
  /**
   * Cold-destined bars the repository wrote to MONGO because no cold store was
   * registered. MUST be 0 — the startup preflight refuses to run without one —
   * so any non-zero here means the store was lost mid-run.
   */
  coldFellBackToHot: number;
}

// The shape every other Cloud Run job entry point uses (feed-backfill,
// feed-parse, xbrl-backfill): one object with info/warn. It is what
// `reportBuildProvenance` takes, and `@usemoney/logger`'s getLogger() is
// keyed to a fixed LoggerModule union with no entry for a script.
const log = {
  info: (...a: unknown[]) => console.log("[tiingo-backfill]", ...a),
  warn: (...a: unknown[]) => console.warn("[tiingo-backfill]", ...a),
};

/* eod-write-verdict:begin
 *
 * What ONE symbol's `putCandles` result means for its checkpoint —
 * MONEY-1263 review, F1.
 *
 * ## The defect: a partial write recorded as a TERMINAL success
 *
 * `putCandles` returns `failed` — "rows that could not be written even by the
 * per-row fallback", i.e. bars that landed NOWHERE. The script used to note
 * that in `detail` and bump its error tally while leaving `status = "DONE"`,
 * and `DONE` is in the resume skip-set. So the symbol was never re-fetched: its
 * missing bars became a PERMANENT price hole that no re-run repairs, on a run
 * that exits 0 with the words "N row(s) failed to write" sitting in a column
 * nobody queries. `ERROR` is the only verdict that is both truthful and
 * self-repairing — the next run picks the symbol up again.
 *
 * A duplicate-key race is deliberately NOT this shape: `putCandles` classifies
 * it as `preserved`, never `failed` (see `classifyCandleRowWriteError`), so a
 * benign concurrent write cannot manufacture an ERROR here.
 *
 * ## `rows` means BARS DURABLY STORED, not bars fetched
 *
 * The column is `BackfillCheckpoint.rows`, whose stated purpose is
 * "for reconciling against the archive". It used to be given
 * `bars.bars.length` — the FETCHED count, parsed from the very archive object
 * it would be reconciled against. That comparison could not fail: both sides
 * came from one parse, so the check was vacuous by construction and would have
 * read healthy across a symbol whose every bar failed to write.
 *
 * So `rows` is `created + upgraded + preserved` — the bars from this response
 * that ARE in the table when the write returns — PLUS `archived`, the bars
 * this response put in a GCS cold shard instead. `preserved` is included on
 * purpose and it is the interesting half: on the re-run this fix makes
 * possible, the 11,417 bars that already landed come back as `preserved` and
 * only the repaired ones as `created`. Counting strictly-written would then
 * checkpoint `rows: 100` for a symbol holding 11,517 bars, and the archive
 * reconcile would report a hole that does not exist — the same lie in the
 * other direction.
 *
 * `archivedCold` is included for the same reason and it became mandatory with
 * the hot/cold split: for a DELISTED listing EVERY bar goes to GCS and none
 * to Mongo, so a `rows` counting only the table would checkpoint 0 for all
 * 10,287 delisted issues — indistinguishable from a symbol whose write failed
 * entirely, which is the exact signal this column exists to carry.
 *
 * `dupInBatch` and `droppedNonFinite` are EXCLUDED because neither is stored
 * anywhere, so `rows < fetched` stays a real signal rather than a rounding
 * artefact.
 *
 * ## The identity is the REPOSITORY's, restated here rather than invented
 *
 * `CandleWriteResult` documents it exactly:
 *
 *   created + upgraded + preserved + dupInBatch + droppedNonFinite
 *           + failed + archivedCold  ===  bars handed in
 *
 * `fetched` is therefore the WHOLE response — the script hands `putCandles`
 * every bar and the repository routes them. `clampedVolume` is not a term (a
 * clamped bar is still written, so it is already inside one of the others) and
 * neither is `coldFellBackToHot`, which is a SUBSET of the Mongo buckets.
 * Adding either would make the identity fail on perfectly healthy runs, which
 * is the same damage as it never failing.
 */
export interface EodWriteTally {
  created: number;
  upgraded: number;
  preserved: number;
  dupInBatch: number;
  droppedNonFinite: number;
  failed: number;
  /** Bars the repository sent to a GCS shard instead of Mongo. */
  archivedCold: number;
}

export interface EodWriteVerdict {
  /** TERMINAL when DONE — so it is only DONE when nothing was lost. */
  status: "DONE" | "ERROR";
  /** Bars from this response that are durably stored. See the header. */
  rows: number;
  /** Triage text, or undefined when the write was fully accounted for. */
  detail: string | undefined;
}

export function judgeEodWrite(
  /** Bars handed to `putCandles` — the WHOLE response, hot and cold alike. */
  fetched: number,
  res: EodWriteTally,
): EodWriteVerdict {
  const landed = res.created + res.upgraded + res.preserved;
  const stored = landed + res.archivedCold;
  const accounted =
    landed +
    res.dupInBatch +
    res.droppedNonFinite +
    res.failed +
    res.archivedCold;
  const parts =
    `fetched=${fetched} created=${res.created} upgraded=${res.upgraded} ` +
    `preserved=${res.preserved} dupInBatch=${res.dupInBatch} ` +
    `dropped=${res.droppedNonFinite} failed=${res.failed} ` +
    `archivedCold=${res.archivedCold}`;

  if (res.failed > 0) {
    return {
      status: "ERROR",
      rows: stored,
      detail:
        `${res.failed} bar(s) landed NOWHERE — ${parts}. Checkpointed ERROR ` +
        "so the symbol is re-fetched; a DONE here is a permanent price hole.",
    };
  }

  // Every bar must end up in exactly one bucket. If the arithmetic does not
  // close, bars went missing somewhere this function cannot see, and that is
  // worth a permanent note even though it is not (yet) a reason to re-fetch.
  // `droppedNonFinite` is recorded for the same reason: the bars are gone, but
  // re-fetching cannot fix a non-finite price, so the verdict stays DONE.
  if (res.droppedNonFinite > 0 || accounted !== fetched) {
    return { status: "DONE", rows: stored, detail: parts };
  }

  return { status: "DONE", rows: stored, detail: undefined };
}

/** The `BackfillCheckpoint` columns one symbol's verdict determines. */
export interface EodCheckpointFields {
  status: string;
  rows: number;
  bytes: number;
  firstTs: Date | null;
  lastTs: Date | null;
  detail: string | null;
}

/**
 * Build the checkpoint columns, so the `rows` decision is EXECUTABLE.
 *
 * This function exists because of a surviving mutation, not because the upsert
 * needed a helper. `judgeEodWrite` above was fully covered and still the
 * checkpoint could be handed `bars.bars.length` again — the call site sits
 * inside `main()`, which cannot be imported, so the only guard available was a
 * source-text assertion, and a source-text assertion cannot promise that the
 * value reaching Prisma is the value the verdict computed. That is the
 * merged-but-not-wired shape this repo keeps paying for.
 *
 * With the mapping here, "checkpoint the FETCHED count" is a mutation a test
 * kills by running it. What is left un-executed at the call site is a spread of
 * this result and three constant key columns.
 *
 * `firstTs`/`lastTs` deliberately describe the FETCHED response, not the write:
 * they are what `isRecycledResponse` reasoning is checked against, so they must
 * report what the archive object contains even when nothing was stored.
 */
export function eodCheckpointFields(args: {
  status: string;
  landedRows: number;
  detail: string | undefined;
  bars: { bytes: number; bars: readonly { date: string }[] } | null;
}): EodCheckpointFields {
  const { status, landedRows, detail, bars } = args;
  const first = bars?.bars[0];
  const last = bars?.bars.at(-1);
  return {
    status,
    // BARS LANDED. Never `bars.bars.length` — see {@link judgeEodWrite}.
    rows: landedRows,
    bytes: bars?.bytes ?? 0,
    firstTs: first ? new Date(`${first.date}T00:00:00Z`) : null,
    lastTs: last ? new Date(`${last.date}T00:00:00Z`) : null,
    detail: detail ?? null,
  };
}
/* eod-write-verdict:end */

/** One bar as the Tiingo CSV parser produces it. */
interface EodBar {
  /** `YYYY-MM-DD`. */
  date: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  divCash: number;
  splitFactor: number;
}

/** UTC midnight of the session a `YYYY-MM-DD` names. */
function barTs(date: string): Date {
  return new Date(`${date}T00:00:00Z`);
}

/** The UTC year of a `YYYY-MM-DD`, or NaN when it did not parse. */
function barYear(date: string): number {
  return barTs(date).getUTCFullYear();
}

/* ── COLD REFERENCE STAMP ─────────────────────────────────────────────
 *
 * WHY THE SHARD YEARS ARE STORED AND NOT DERIVED — MONEY-941.
 *
 * The obvious way for a reader to answer "which years do we hold for LEH?" is
 * to LIST `candles/US/D1/LEH/`. It must not, and the reason is written into the
 * cold store's own port ("There is deliberately NO `list`"): `listFiles` in
 * `@usemoney/storage` FAILS OPEN to `[]` on an auth or network error. It logs
 * and returns an empty array. So a derived answer reports "this security has no
 * price history" for a credentials problem, indistinguishably from the truth,
 * and MONEY-941 is the record of exactly that — an archive parse job read an
 * empty listing as "0 files archived, parse complete" and exited 0.
 *
 * Two integers on the instrument row cannot do that. They are absent or they
 * are wrong, and "absent" is a state a reader can see.
 *
 * ## Why an overwrite is safe here, and would not be from any other writer
 *
 * The span only ever WIDENS. `coldYearsFrom` is the year of the listing's
 * first bar and never moves; `coldYearsTo` is the newest out-of-window year,
 * which advances by one each 1 January as the window floor rises. So a later
 * run can only extend the range — provided the run holds the WHOLE history,
 * which this one does (a single request returns the entire series). A writer
 * holding a partial range would narrow the stamp and orphan the shards outside
 * it, which is why this stamp belongs to the backfill and not to the nightly.
 */

/* cold-stamp-verdict:begin
 *
 * What a MISSED stamp means, as a value rather than a branch.
 *
 * `stampColdYears` uses `updateMany`, which returns `{count: 0}` for a listing
 * with no `us_instruments` row instead of throwing P2025 and aborting the walk.
 * That is the right call — one missing instrument row must not end a 3.7-hour
 * run — but it makes the miss a SILENT ZERO, which is this repo's most
 * expensive recurring shape.
 *
 * So the verdict is computed here and the call site has NO `if`. It reads
 *
 *     const verdict = judgeColdStamp({ …, stamped });
 *     t.coldStampMissed += verdict.missed;
 *
 * — an unconditional add of a number this function decided. A branch at the
 * call site can be neutered (`if (false && !stamped)`) and every unit test
 * still passes, because the call site lives inside an un-importable `main()`;
 * an unconditional add of a tested value cannot be, because there is no
 * predicate left to falsify. That is the same move `judgeEodWrite` and
 * `eodCheckpointFields` make, and it is here because the first version of this
 * counter SURVIVED exactly that mutation.
 */
export interface ColdStampVerdict {
  /** Add to the run's `coldStampMissed` tally. 0 or 1. */
  missed: number;
  /** The line to log, or null when the stamp landed. */
  warning: string | null;
}

export function judgeColdStamp(args: {
  symbol: string;
  exchange: string;
  listingId: string;
  shards: number;
  stamped: boolean;
}): ColdStampVerdict {
  const { symbol, exchange, listingId, shards, stamped } = args;
  if (stamped) return { missed: 0, warning: null };
  return {
    missed: 1,
    warning:
      `WARN ${symbol} ${exchange}: ${shards} cold shard(s) written but NO ` +
      `us_instruments row for listingId=${listingId} — nothing can discover ` +
      "them without a GCS LIST, which fails OPEN to []. Run the US instrument " +
      "sync, then re-run with --retry-terminal.",
  };
}
/* cold-stamp-verdict:end */

/**
 * Record which shard years exist, on the listing's `us_instruments` row.
 *
 * Returns false when NO row matched — see {@link judgeColdStamp} for what the
 * caller does with that and why it is not a branch.
 */
async function stampColdYears(args: {
  listingId: string;
  coldYearsFrom: number | null;
  coldYearsTo: number | null;
}): Promise<boolean> {
  const res = await prisma.usInstrument.updateMany({
    where: { listingId: args.listingId },
    data: {
      coldYearsFrom: args.coldYearsFrom,
      coldYearsTo: args.coldYearsTo,
    },
  });
  return res.count > 0;
}

/* ── FUND NAV ROUTING ─────────────────────────────────────────────────
 *
 * FUNDS DO NOT GET CANDLES — MONEY-980.
 *
 * A NAV is one daily point, not OHLCV. Writing it as a bar would leave four of
 * `Candle`'s columns null and make two of them lies (a fund has no high and no
 * low, and its "volume" is not a traded quantity). It is also the whole size
 * problem: measured 2026-08-28, funds are 49,414 of the 72,685 US listings and
 * 72% of the bars at EVERY hot-window depth — 105.9M rows for a 10-year window
 * with them against 33.8M without.
 *
 * So `assetType: "Mutual Fund"` (`TiingoListing.instrumentType === "MF"`)
 * routes to `us_fund_nav` and never reaches `putCandles`.
 *
 * ## The key is permaTicker, and it can be MISSING
 *
 * `UsFundNav` is unique on `(permaTicker, date)` for the reason
 * `UsCorporateAction` is: fund tickers recycle like every other ticker, and
 * permaTicker's failure mode is ZERO ROWS rather than a wrong join. But
 * permaTicker is NOT in `supported_tickers.zip` — it comes from
 * `/tiingo/utilities/search` via a separate enrichment leg — so a fund this
 * walk reaches before that leg does has no key to write under.
 *
 * It is checkpointed `NO_PERMATICKER`, which is deliberately NOT terminal: run
 * the search enrichment, re-run this walk, and the fund is picked up with no
 * `--retry-terminal`. Substituting the SYMBOL as the key was considered and
 * rejected — it is precisely the wrong join the permaTicker key exists to
 * prevent, and it would look entirely normal.
 *
 * ## Pre-window fund history is DROPPED, and that is an open decision
 *
 * The hot/cold split has no cold half for NAVs: there is no NAV shard format
 * and no reader for one, and inventing both here would be a schema decision
 * taken inside a backfill. So a fund's out-of-window years are counted in
 * `navColdDropped` and reported in the run summary rather than written. It is
 * visible, it is re-fetchable (nothing about the ticker is checkpointed as
 * complete-and-empty), and it is named here so the next person does not have
 * to rediscover it. See the report for MONEY-980.
 */
async function writeFundNavs(args: {
  listing: TiingoListing;
  permaTicker: string;
  hot: readonly EodBar[];
}): Promise<number> {
  const { listing, permaTicker, hot } = args;
  let written = 0;
  for (const group of chunk(hot, NAV_WRITE_CHUNK)) {
    await Promise.all(
      group.map(async (b) => {
        // UPSERT and not createMany: `skipDuplicates` is a SQL-only Prisma
        // feature (the Mongo connector types it `never`) and a bare createMany
        // loses the WHOLE batch to one duplicate key, which on a re-run is
        // every row.
        await prisma.usFundNav.upsert({
          where: { permaTicker_date: { permaTicker, date: barTs(b.date) } },
          create: {
            permaTicker,
            symbol: listing.symbol,
            date: barTs(b.date),
            nav: b.close,
            // `divCash` and `splitFactor` ride along on the SAME bar the NAV
            // comes from, and this writer used to drop both. It is the only
            // writer of HISTORICAL fund NAVs — the nightly leg runs a trailing
            // window of at most MAX_LOOKBACK_DAYS (30) and can never revisit
            // 2018 — so anything lost here is lost permanently.
            //
            // For `splitFactor` that is not a gap, it is a WRONG ANSWER:
            // `UsFundNav.splitFactor` is SPARSE and absent means exactly "no
            // split", so a dropped factor turns FCNTX 2018-08-10 (10-for-1, NAV
            // 138.17 -> 13.73) into a 90% one-day collapse that reads as real.
            divCash: b.divCash,
            // SPARSE: present only for a real split, so "no split" is an ABSENT
            // field rather than a stored 1.0. `isRealSplit` is imported from
            // core rather than open-coded — upstream stores AAPL's 2014
            // seven-for-one as 7.000007000007001, so `!== 1` is wrong here.
            ...(isRealSplit(b.splitFactor)
              ? { splitFactor: b.splitFactor }
              : {}),
            source: "TIINGO",
          },
          // The NAV for a settled session does not change, so this is a no-op
          // in the normal case — but a restated NAV is a real thing and
          // silently keeping the first value we saw would freeze the error in.
          // The same argument applies to both columns below, and `splitFactor`
          // must UNSET rather than omit: omitting leaves whatever is stored, so
          // a factor the vendor later corrects to 1 would keep a phantom split
          // for ever.
          update: {
            nav: b.close,
            symbol: listing.symbol,
            divCash: b.divCash,
            splitFactor: isRealSplit(b.splitFactor)
              ? { set: b.splitFactor }
              : { unset: true },
          },
        });
        written++;
      }),
    );
  }
  return written;
}

/** Concurrent NAV upserts per chunk. Bounded so one fund cannot swamp the pool. */
const NAV_WRITE_CHUNK = 25;

function chunk<T>(rows: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < rows.length; i += size) out.push(rows.slice(i, i + size));
  return out;
}

/**
 * The listings this run will attempt.
 *
 * Delegates the whole scoping decision to `selectPrimaryListings` — the SAME
 * function the instrument provider uses — rather than re-filtering the master
 * here. That is the point: two places deciding "which US securities exist"
 * would be one rule stated twice, and the copies drift (MONEY-1255).
 *
 * It also fixes a defect this script had while it filtered independently.
 * `BackfillCheckpoint` is unique on `(jobKey, itemKey, scope)` — here the
 * symbol and its exchange — and the master holds TWO rows for `DOW` on NYSE.
 * Walking both wrote two checkpoints to ONE key, so the surviving verdict was
 * whichever came last — the DONE for
 * Dow Inc. silently overwrote the RECYCLED for Dow Chemical. Collapsing to one
 * primary listing per ticker removes the collision at its source instead of
 * widening the key, and saves the wasted second fetch: both rows resolve to the
 * identical response anyway, because `/tiingo/daily/<ticker>/prices` takes no
 * exchange qualifier.
 *
 * Ordered by ticker ASC, not by a recency marker: this walks a FIXED population
 * once and the checkpoint alone decides what remains.
 */
function selectTargets(listings: readonly TiingoListing[]): TiingoListing[] {
  const rows = listings
    .filter((r) => {
      if (SYMBOLS.length > 0) return SYMBOLS.includes(r.symbol.toUpperCase());
      if (ONLY_DELISTED) return r.listingStatus === "DELISTED";
      if (ONLY_ACTIVE) return r.listingStatus === "ACTIVE";
      return true;
    })
    .sort((a, b) => a.symbol.localeCompare(b.symbol));
  return LIMIT > 0 ? rows.slice(0, LIMIT) : rows;
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
  reportBuildProvenance(log, "tiingo-us-backfill");

  const plan = resolveTiingoPlan();
  const limits = tiingoLimits(plan);
  // ONE clock for the WHOLE walk, not one per symbol. This runs for ~3.7 hours,
  // so a run started on 31 December would otherwise cross into a new window
  // mid-walk and route two symbols of the same vintage to different stores.
  // `putCandles` reads its own clock per batch for the same reason at a smaller
  // scale; here the span stamp has to agree with what it did.
  const now = new Date();
  const currentYear = now.getUTCFullYear();
  log.info(
    `plan=${plan} perHour=${limits.perHour} perDay=${limits.perDay} ` +
      `hotWindow=${hotWindowFloorYear(now)}..${currentYear} ` +
      `apply=${APPLY}${APPLY ? "" : " (DRY RUN — nothing will be written)"}`,
  );

  // FAIL CLOSED, before the first request. `writeColdShard` throws without a
  // registered store, so an unregistered one on an --apply run means every
  // symbol with pre-window history — i.e. almost all of them, and ALL 10,287
  // delisted issues — checkpoints ERROR after paying for the fetch. Discovering
  // that at symbol 1 of 72,685 costs one line; discovering it at symbol 72,685
  // costs the walk.
  const coldReady = initCandleColdStore();
  if (APPLY && !coldReady) {
    throw new Error(
      "GCP_STORAGE_BUCKET is unset, so no cold shard store could be " +
        "registered — refusing to --apply. Every bar outside the hot window " +
        "(every year of every DELISTED listing, and all pre-" +
        `${hotWindowFloorYear(now)} history of the live ones) has ` +
        "nowhere to go, and a run that discovered this per-symbol would " +
        "checkpoint tens of thousands of ERRORs having already spent the " +
        "metered quota to fetch them.",
    );
  }
  log.info(
    `coldStore=${coldReady ? "registered" : "ABSENT"} ` +
      `bucket=${process.env.GCP_STORAGE_BUCKET ?? "(unset)"}`,
  );

  const master = await fetchSupportedTickers();
  if (master.length === 0) {
    // An empty master is never a real answer — it means the fetch or the unzip
    // failed. Proceeding would checkpoint nothing and exit 0, which is the
    // "success that wrote nothing" shape this repo keeps re-learning.
    throw new Error("supported_tickers returned 0 rows — refusing to proceed");
  }
  const { listings, stats } = selectPrimaryListings(master);
  if (listings.length === 0) {
    throw new Error("master yielded 0 US listings — refusing to proceed");
  }
  log.info(
    `master rows=${stats.fetched} inScope=${stats.inScope} ` +
      `listings=${listings.length} active=${stats.active} ` +
      `delisted=${stats.delisted} recycledDropped=${stats.recycledDropped} ` +
      `crossVenueDropped=${stats.crossVenueDropped} ` +
      `newestEndDate=${stats.fileMaxEndDate}`,
  );

  const targets = selectTargets(listings);
  log.info(`selected=${targets.length}`);

  // Resume set. Terminal verdicts are skipped unless explicitly retried —
  // EMPTY / NOT_FOUND / RECYCLED all produce ZERO rows, so without the
  // checkpoint they are indistinguishable from never-attempted and would be
  // re-fetched on every run forever.
  const done = new Set<string>();
  if (!RETRY_TERMINAL) {
    const rows = await prisma.backfillCheckpoint.findMany({
      where: {
        jobKey: JOB_KEY,
        // NO_PERMATICKER is deliberately absent: a fund whose permaTicker the
        // search enrichment had not yet resolved must be picked up by the next
        // run without --retry-terminal. See FUND NAV ROUTING below.
        status: { in: ["DONE", "EMPTY", "NOT_FOUND", "RECYCLED"] },
      },
      // `itemKey` is the symbol and `scope` its exchange — the two halves of
      // the key the loop below rebuilds, in the same order.
      select: { itemKey: true, scope: true },
    });
    for (const r of rows) done.add(`${r.itemKey}::${r.scope}`);
  }
  log.info(`checkpointed already: ${done.size}`);

  // permaTicker per listing, for the fund leg, plus the row's existence for the
  // cold-year stamp. ONE query rather than 49,414 — the master is already in
  // memory, so a second Map of the same order of magnitude costs nothing next
  // to a round trip per fund.
  const permaTickers = new Map<string, string | null>();
  /** MONEY-1617 — every window per symbol+venue, for the writer clip. */
  const venueWindows = new Map<string, ListingRow[]>();
  /** Every window per SYMBOL, all venues — who the current occupant is. */
  const symbolWindows = new Map<string, ListingRow[]>();
  {
    const rows = await prisma.usInstrument.findMany({
      select: {
        listingId: true,
        permaTicker: true,
        symbol: true,
        exchange: true,
        listingStartDate: true,
        listingEndDate: true,
        listingStatus: true,
      },
    });
    for (const r of rows) {
      permaTickers.set(r.listingId, r.permaTicker);
      const k = `${r.symbol}\u0000${r.exchange}`;
      const bucket = venueWindows.get(k);
      if (bucket) bucket.push(r);
      else venueWindows.set(k, [r]);
      const all = symbolWindows.get(r.symbol);
      if (all) all.push(r);
      else symbolWindows.set(r.symbol, [r]);
    }
  }
  log.info(`us_instruments rows: ${permaTickers.size}`);

  const t: Tally = {
    considered: 0,
    skippedCheckpoint: 0,
    fetched: 0,
    written: 0,
    empty: 0,
    notFound: 0,
    recycled: 0,
    errors: 0,
    bytes: 0,
    hotBars: 0,
    coldBars: 0,
    coldShards: 0,
    navRows: 0,
    navNoPermaTicker: 0,
    navColdDropped: 0,
    coldStampMissed: 0,
    coldFellBackToHot: 0,
    clipOutside: 0,
    clipAmbiguous: 0,
  };

  // Set by the circuit-breakers below, and read at the end for the EXIT CODE.
  // The sibling `tiingo-us-corp-actions-backfill.ts` already does this and says
  // why: a run stopped after 3 of 72,685 symbols has checkpointed real work, so
  // it is not a failure in the "nothing happened" sense — but a wrapper or a
  // Cloud Run Job that reads only the exit code must not read "rate-limited
  // early" as a completed backfill.
  let stopped: string | null = null;

  for (const row of targets) {
    t.considered++;
    const key = `${row.symbol}::${row.exchange}`;
    if (done.has(key)) {
      t.skippedCheckpoint++;
      continue;
    }

    const listingId = row.listingId;

    let status = "DONE";
    let detail: string | undefined;
    /** Bars from this response that are in the table. See {@link judgeEodWrite}. */
    let landedRows = 0;
    let bars: Awaited<ReturnType<typeof fetchTiingoEod>> = null;

    try {
      bars = await fetchTiingoEod({ symbol: row.symbol });
      t.fetched++;
    } catch (err) {
      if (err instanceof TiingoRateLimitError) {
        // Circuit-break the RUN. Continuing spends the remaining budget
        // collecting the same error, and the checkpoint means a later run
        // resumes exactly here.
        //
        // The DAILY CAP arrives as this class too (`TiingoDailyCapError`
        // extends it), so there is deliberately no second arm — one stop, one
        // check.
        stopped = `RATE LIMITED at ${row.symbol} — ${String(err.message)}`;
        log.info(`${stopped} — stopping.`);
        break;
      }
      if (err instanceof TiingoAuthError) {
        stopped = `AUTH/ENTITLEMENT failure at ${row.symbol} — ${err.message}`;
        log.info(`${stopped} — stopping.`);
        break;
      }
      status = "ERROR";
      detail = err instanceof Error ? err.message : String(err);
      t.errors++;
    }

    if (status === "DONE") {
      if (bars === null) {
        status = "NOT_FOUND";
        t.notFound++;
      } else {
        t.bytes += bars.bytes;
        if (bars.bars.length === 0) {
          status = "EMPTY";
          t.empty++;
        } else if (
          isRecycledResponse({
            listingEndDate: row.listingEndDate,
            firstBarDate: bars.bars[0]!.date,
          })
        ) {
          // The response describes the ticker's CURRENT occupant, not the
          // listing we asked about. Writing it would file one company's prices
          // under another's identity.
          status = "RECYCLED";
          detail = `first bar ${bars.bars[0]!.date} postdates listing end ${row.listingEndDate}`;
          t.recycled++;
        }
      }
    }

    // WHAT THIS RESPONSE CONTAINS, decided once, before either branch below.
    // A dry run must print what an --apply run would act on — a rehearsal that
    // does not exercise the routing is a rehearsal of something else.
    //
    // The boundary itself is core's `resolveCandleDestination`, injected rather
    // than restated. For an equity/ETF the repository applies the same function
    // again to the same rows and does the actual routing; this split exists
    // only for the two things the repository cannot report — the cold YEAR
    // SPAN, and the fund gate.
    const isFund = row.instrumentType === "MF";
    const split =
      status === "DONE" && bars
        ? splitByDestination<EodBar>({
            bars: bars.bars,
            yearOf: (b) => barYear(b.date),
            listingStatus: row.listingStatus,
            now,
            destinationOf: resolveCandleDestination,
          })
        : null;

    if (!APPLY) {
      log.info(
        `DRY ${row.symbol} ${row.exchange} ${status} ` +
          `bars=${bars?.bars.length ?? 0} ` +
          `${isFund ? "nav" : "hot"}=${split?.hot.length ?? 0} ` +
          `cold=${split?.coldCount ?? 0} ` +
          `coldYears=${split?.coldYearsFrom ?? "-"}..${split?.coldYearsTo ?? "-"} ` +
          `listingId=${listingId}`,
      );
      continue;
    }

    if (status === "DONE" && bars && split) {
      try {
        if (isFund) {
          // ── FUNDS: NAVs, never candles. See FUND NAV ROUTING below.
          const permaTicker = permaTickers.get(listingId) ?? null;
          if (permaTicker === null || permaTicker.trim() === "") {
            // NOT terminal: run the search enrichment, re-run this walk.
            status = "NO_PERMATICKER";
            detail =
              "us_fund_nav is keyed on permaTicker and this listing has none " +
              "yet (it is not in supported_tickers.zip — the search " +
              "enrichment leg supplies it). Not terminal: re-run after that " +
              "leg reaches this row. Using the SYMBOL as the key instead is " +
              "exactly the wrong join the permaTicker key exists to prevent.";
            t.navNoPermaTicker++;
          } else {
            const navs = await writeFundNavs({
              listing: row,
              permaTicker,
              hot: split.hot,
            });
            t.navRows += navs;
            t.navColdDropped += split.coldCount;
            landedRows = navs;
            if (split.coldCount > 0) {
              detail =
                `${split.coldCount} pre-window NAV(s) not stored — there is ` +
                "no cold shard format for NAVs. See FUND NAV ROUTING in the " +
                "source.";
            }
          }
        } else {
          // ── EQUITIES + ETFs: the WHOLE response, unsplit ──
          //
          // `putCandles` routes every row itself — in-window rows to Mongo,
          // the rest to a GCS shard — and reports `archivedCold` /
          // `coldShards` / `coldFailed`. Handing it a pre-split batch, and
          // archiving the other half here, is what this script used to do and
          // is the defect the `cold-span` region documents: two copies of one
          // boundary, either double-writing a bar or losing it while counting
          // it written.
          //
          // `listingStatus` is set on EVERY row and is the half the repository
          // cannot infer. This is the one writer whose batch contains
          // recent-year bars for securities that are no longer trading, and
          // omitting it would put all ~10,287 delisted issues in Mongo.
          //
          // `tier` is deliberately NOT passed: `WINDOW` is what the routing
          // already computes for exactly the rows it belongs to.
          // MONEY-1617 — each bar under the window covering its session.
          const clip = clipBarsToListingWindows({
            bars: bars.bars,
            windows:
              venueWindows.get(`${row.symbol}\u0000${row.exchange}`) ?? [],
            symbolWindows: symbolWindows.get(row.symbol),
            fetched: {
              symbol: row.symbol,
              exchange: row.exchange,
              listingId,
              listingStartDate: row.listingStartDate
                ? barTs(row.listingStartDate)
                : null,
              listingEndDate: row.listingEndDate
                ? barTs(row.listingEndDate)
                : null,
              listingStatus: row.listingStatus,
            },
          });
          t.clipOutside += clip.dropped.OUTSIDE_EVERY_WINDOW;
          t.clipAmbiguous += clip.dropped.AMBIGUOUS_WINDOW;
          const res = await candleRepository.putCandles(
            clip.kept.map(({ bar: b, listingId: assigned, listingStatus }) => ({
              symbol: row.symbol,
              exchange: row.exchange,
              timeframe: "D1",
              ts: barTs(b.date),
              listingId: assigned,
              open: b.open,
              high: b.high,
              low: b.low,
              close: b.close,
              volume: b.volume,
              divCash: b.divCash,
              splitFactor: b.splitFactor,
              source: "TIINGO",
              // The ASSIGNED window's status: a predecessor's bars route to
              // its own (delisted) cold tier.
              listingStatus,
            })),
          );
          t.written += res.created + res.upgraded;
          t.hotBars += res.created + res.upgraded + res.preserved;
          t.coldBars += res.archivedCold;
          t.coldShards += res.coldShards;
          t.coldFellBackToHot += res.coldFellBackToHot;

          // The reference a reader consults INSTEAD of a GCS LIST — but only
          // when every shard actually landed. See {@link planColdStamp}.
          const plan = planColdStamp({
            coldYearsFrom: split.coldYearsFrom,
            coldYearsTo: split.coldYearsTo,
            coldFailed: res.coldFailed,
          });
          const stamped = plan.stamp
            ? await stampColdYears({
                listingId,
                coldYearsFrom: plan.from,
                coldYearsTo: plan.to,
              })
            : // Not attempted, so it is not a MISS. `judgeColdStamp` is told
              // the truth and the reason rides on the checkpoint below.
              true;
          // NO `if` around the count: it is an unconditional add of a value a
          // pure, tested function decided — see {@link judgeColdStamp}.
          const stamp = judgeColdStamp({
            symbol: row.symbol,
            exchange: row.exchange,
            listingId,
            shards: res.coldShards,
            stamped,
          });
          t.coldStampMissed += stamp.missed;
          if (stamp.warning !== null) log.info(stamp.warning);
          if (plan.reason !== null) log.warn(`${row.symbol} ${plan.reason}`);

          // The whole verdict — status, checkpoint `rows` and `detail` — comes
          // from one pure function so it is reachable by a test. The old inline
          // version left `status` on "DONE" for a partial write, which is a
          // terminal verdict and therefore a permanent hole (F1).
          // Judged against what the clip HANDED to putCandles; a clipped bar
          // is not a lost write, and says so in the checkpoint detail.
          const verdict = judgeEodWrite(clip.kept.length, res);
          status = verdict.status;
          const clipped =
            clip.dropped.OUTSIDE_EVERY_WINDOW + clip.dropped.AMBIGUOUS_WINDOW;
          detail =
            clipped > 0
              ? [
                  verdict.detail,
                  `clip dropped OUTSIDE_EVERY_WINDOW=${clip.dropped.OUTSIDE_EVERY_WINDOW} ` +
                    `AMBIGUOUS_WINDOW=${clip.dropped.AMBIGUOUS_WINDOW} (MONEY-1617)`,
                ]
                  .filter(Boolean)
                  .join("; ")
              : verdict.detail;
          landedRows = verdict.rows;
          if (verdict.status === "ERROR") t.errors++;
        }
      } catch (err) {
        status = "ERROR";
        detail = err instanceof Error ? err.message : String(err);
        t.errors++;
      }
    }

    // Every value-bearing column comes from one pure, TESTED function; this
    // site only supplies the three key columns and spreads the rest.
    const fields = eodCheckpointFields({ status, landedRows, detail, bars });

    // `itemKey` is the symbol and `scope` its exchange. The columns were
    // `symbol` / `exchange` until MONEY-980's audit generalised them — the
    // sibling corp-actions walk was storing an ex-date in `symbol` — and for
    // THIS walk the values are unchanged; only the column names moved.
    await prisma.backfillCheckpoint.upsert({
      where: {
        jobKey_itemKey_scope: {
          jobKey: JOB_KEY,
          itemKey: row.symbol,
          scope: row.exchange,
        },
      },
      create: {
        jobKey: JOB_KEY,
        itemKey: row.symbol,
        scope: row.exchange,
        ...fields,
      },
      update: {
        status: fields.status,
        rows: fields.rows,
        bytes: fields.bytes,
        detail: fields.detail,
        at: new Date(),
      },
    });

    if (t.considered % 250 === 0) {
      log.info(
        `… ${t.considered}/${targets.length} fetched=${t.fetched} ` +
          `written=${t.written} hot=${t.hotBars} cold=${t.coldBars} ` +
          `shards=${t.coldShards} nav=${t.navRows} empty=${t.empty} ` +
          `notFound=${t.notFound} recycled=${t.recycled} errors=${t.errors} ` +
          `clipOutside=${t.clipOutside} clipAmbiguous=${t.clipAmbiguous} ` +
          `MB=${(t.bytes / 1024 ** 2).toFixed(1)}`,
      );
    }
  }

  if (stopped) log.info(`STOPPED — ${stopped}`);

  // A run that attempted work and produced nothing, or failed most of what it
  // attempted, is a FAILED run — the exit code is what `gcloud run jobs
  // execute --wait` and the execution list read. `empty`, `notFound` and
  // `recycled` are SUCCESSFUL outcomes: the upstream answered and the answer
  // was "nothing here", which is a fact this walk exists to record.
  const verdict = judgeBackfillOutcome({
    stopped,
    attempted: t.fetched,
    succeeded: t.fetched - t.errors,
    failed: t.errors,
  });
  if (verdict.exitCode !== 0) {
    log.warn(`FAILED RUN — ${verdict.reason}`);
    process.exitCode = verdict.exitCode;
  }

  log.info(
    `DONE considered=${t.considered} skipped=${t.skippedCheckpoint} ` +
      `fetched=${t.fetched} barsWritten=${t.written} empty=${t.empty} ` +
      `notFound=${t.notFound} recycled=${t.recycled} errors=${t.errors} ` +
      `clipOutside=${t.clipOutside} clipAmbiguous=${t.clipAmbiguous} ` +
      `MB=${(t.bytes / 1024 ** 2).toFixed(1)}`,
  );
  log.info(
    `TIERS hotBars=${t.hotBars} coldBars=${t.coldBars} ` +
      `coldShards=${t.coldShards} coldStampMissed=${t.coldStampMissed} ` +
      `navRows=${t.navRows} navNoPermaTicker=${t.navNoPermaTicker} ` +
      `navColdDropped=${t.navColdDropped}`,
  );
  // Both of these are SILENT data problems, so they get their own line rather
  // than a position in a counter string nobody reads to the end of.
  if (t.coldStampMissed > 0) {
    log.info(
      `WARN ${t.coldStampMissed} symbol(s) archived cold shards with no ` +
        "us_instruments row to record the years on. Those shards are " +
        "undiscoverable without a GCS LIST, which fails OPEN to []. Run the " +
        "US instrument sync, then re-run with --retry-terminal.",
    );
  }
  if (t.navNoPermaTicker > 0) {
    log.info(
      `WARN ${t.navNoPermaTicker} fund(s) had no permaTicker and wrote no ` +
        "NAVs. Checkpointed NO_PERMATICKER, which is NOT terminal — run the " +
        "Tiingo search enrichment, then re-run this walk normally.",
    );
  }
  if (!APPLY) log.info("DRY RUN — pass --apply (bare flag) to write.");

  if (stopped) process.exitCode = 1;
}

main()
  .catch((err) => {
    console.error("[tiingo-backfill] FAILED", err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
