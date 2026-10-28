/**
 * One-time US news seed from Tiingo — MONEY-1264.
 *
 * Day-walks the entire window Tiingo will serve, one request per calendar day,
 * archiving each day's raw JSON and writing `UsStockNews` rows for the symbols we
 * actually carry. Checkpointed per DATE, so a run killed halfway resumes exactly
 * where it stopped.
 *
 * ## Why a DAY-WALK and not one big range request
 *
 * Three measured facts make the day-walk the only honest shape:
 *
 *   1. HISTORY IS 3 MONTHS, AND ASKING FOR MORE DOES NOT FAIL. A pre-floor
 *      `startDate` returns HTTP 200 with rows from the floor date. One
 *      `startDate=2024-08-28` request would look like a successful two-year
 *      backfill and deliver three months. The client refuses to build such a
 *      URL at all (`buildTiingoNewsUrl`) and this script never asks for one: its
 *      default window STARTS at the floor, computed from the same constant.
 *   2. THE OFFSET CEILING IS 10,000, and past it every page returns ZERO rows —
 *      indistinguishable from "no more news". A single wide-range query for a
 *      3-month firehose (>20,000 articles) would hit that wall and stop early
 *      while looking complete. A day is ~30-400 articles, nowhere near it.
 *   3. A DATED ARCHIVE KEY needs a date. One request per day means one archive
 *      object per day under `feeds/TIINGO/news/{YYYY}/{MM}/`, which is what lets
 *      QA replay the seed instead of spending the quota again.
 *
 * ~90 requests for the whole window, so the plan's rate limits are not a factor
 * (~16s of pacing at COMMERCIAL's 20,000/hr).
 *
 * ## Usage
 *
 * ### Cloud Run Job (MONEY-1264) — the primary form
 *
 * This lives in `scripts/jobs/` and is a tsup ENTRY
 * (`dist/tiingo-us-news-seed.js`), provisioned by
 * `scripts/ops/setup-tiingo-backfill-job.sh`:
 *
 *   gcloud run jobs execute tiingo-us-news-seed-prod --region=asia-south1 \
 *     --args=--apply
 *   gcloud run jobs execute tiingo-us-news-seed-prod --region=asia-south1 \
 *     --args=--apply,--from=2026-08-01,--to=2026-08-07
 *
 * The EQUALS form survives gcloud's `--args` comma split (verified against
 * googlecloudsdk.calliope.arg_parsers.ArgList). No value this script takes
 * contains a comma, so it never needs the `^:^` delimiter escape that
 * `tiingo-us-backfill.ts`'s `--symbols` does.
 *
 * At ~90 requests this is the one Tiingo walk a laptop CAN finish — but the job
 * is where the archive credentials and `FEED_ARCHIVE_MODE=archive` live, so a
 * laptop run seeds rows without archiving the bytes QA replays.
 *
 * ### Local (dry runs only)
 *
 *   node --import tsx scripts/jobs/tiingo-us-news-seed.ts                    # dry run
 *   node --import tsx scripts/jobs/tiingo-us-news-seed.ts --apply
 *   node --import tsx scripts/jobs/tiingo-us-news-seed.ts --apply --limit=5
 *   node --import tsx scripts/jobs/tiingo-us-news-seed.ts --apply --from=2026-08-01 --to=2026-08-07
 *
 * DRY RUN IS THE DEFAULT and `--apply` is a BARE flag, never `--apply=true`.
 * MONEY-1252: a wrapper that forwarded `--flag=value` had its `--apply`
 * swallowed, and a 54-minute "apply" run wrote nothing while exiting 0.
 *
 * That is now ENFORCED rather than merely documented — every option is
 * `--flag` or `--flag=value`, the SPACE form is refused, and an unknown or
 * unparseable token exits 1 before the first request. See the
 * `tiingo-cli-args` region below.
 *
 * `--to` DEFAULTS TO YESTERDAY, not today: a day walked before it is over gets
 * a TERMINAL checkpoint, and on a feed whose history floor moves forward daily
 * that turns "stale" into "unfillable". See {@link resolveNewsWindowEnd}.
 *
 * Run it on PROD, where `FEED_ARCHIVE_MODE=archive`; QA receives the same bytes
 * through the nightly feeds mirror rather than fetching them again.
 */

// Explicit, and first: every credential this script needs (TIINGO_API_KEY,
// DATABASE_URL, the GCS archive vars) comes from the environment, and
// `feed-parse.ts` shipped without this line and silently ran unauthenticated.
import "dotenv/config";
import { judgeBackfillOutcome } from "@usemoney/core/ops/backfill-outcome";

import prisma from "@usemoney/database";
import { reportBuildProvenance } from "@usemoney/core/ops/build-provenance";
import {
  fetchNews,
  type TiingoNewsResult,
} from "@usemoney/core/market-data/tiingo/tiingo-news";
import {
  TIINGO_NEWS_MAX_LIMIT,
  TIINGO_NEWS_MAX_OFFSET,
  TiingoNewsClampedError,
  TiingoNewsFloorError,
  newsFloorDate,
  toStockNewsRows,
  type StockNewsRow,
  type TiingoNewsArticle,
} from "@usemoney/core/market-data/tiingo/tiingo-news-logic";
import {
  TiingoAuthError,
  TiingoRateLimitError,
} from "@usemoney/core/market-data/tiingo/tiingo-client";
import { TIINGO_SYNC_EXCHANGES } from "@usemoney/core/market-data/instruments/tiingo-instruments-logic";
import { initJobTelemetry } from "../../workers/src/lib/job-telemetry";

/**
 * Checkpoint namespace. `FeedBackfillProgress` is keyed `(family, date)`, which
 * is exactly the shape of a day-walk: the unit is a DATE and the column is a
 * `DateTime`, so nothing has to be aliased.
 *
 * The sibling corporate-actions walk uses `BackfillCheckpoint` instead, and the
 * split is deliberate rather than historical. That walk's unit is a
 * (day, ROUTE) PAIR — two independent fetches per day, and a run killed between
 * them must not redo the one that finished — which needs a second key column
 * `FeedBackfillProgress` does not have. This walk is one fetch per day.
 *
 * (Both models used to look worse than they do. `BackfillCheckpoint` was
 * `CandleBackfillCheckpoint` with columns `symbol`/`exchange`, and the
 * corp-actions walk stored an ex-date in `symbol` and a route in `exchange`.
 * That is fixed at the schema — the columns are `itemKey`/`scope` now — so the
 * reason to prefer `FeedBackfillProgress` here is the shape of the key, not the
 * honesty of the column names.)
 */
const FAMILY = "tiingo-us-news";

/** Terminal on resume: a day with one of these verdicts is not re-fetched. */
const TERMINAL = ["DONE", "EMPTY"] as const;

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

/* news-window-end:begin
 *
 * Where the default walk STOPS, and why it is not today — MONEY-1263 review, F2.
 *
 * ## The defect: the current day was permanently lost
 *
 * `const to = TO ?? today` walked the CURRENT UTC day and checkpointed it
 * `DONE` or `EMPTY`, both of which are TERMINAL (see {@link TERMINAL}). Tiingo's
 * window is `[startDate, endDate]` on the publication date, so a run at 02:00
 * UTC — 22:00 ET the PREVIOUS day, the middle of a normal US news evening —
 * asks for a day that is two hours old, gets near-zero articles, and writes
 * `EMPTY`. Every later run then SKIPS it. That calendar day's news is gone, and
 * the only recovery is `--redo` by an operator who first has to notice a hole
 * in a 3-month rolling window that itself expires.
 *
 * It is worth being precise about why this is not merely "one stale day": the
 * feed's history floor is ~90 days and moves forward daily, so an unnoticed
 * hole becomes UNFILLABLE rather than stale. There is no going back for it.
 *
 * ## The fix, and why it is the sibling's fix
 *
 * `tiingo-us-corp-actions-backfill.ts` documents and avoids exactly this with
 * its own `DEFAULT_TO_OFFSET_DAYS = 1` ("Today's ex-dates are still landing …
 * Yesterday is settled"). One day of latency, zero lost days, and the same
 * constant name so the two read as one rule rather than two coincidences.
 *
 * An EXPLICIT `--to` is honoured rather than clamped — an operator asking for
 * today, with `--redo`, is making a choice — but it WARNS, because the
 * consequence (a terminal checkpoint on an unfinished day) is invisible at the
 * moment it is incurred and expensive later.
 *
 * Pure and total: it takes `today` as an argument rather than reading the clock,
 * so the test can walk it across month and year boundaries.
 */
export const DEFAULT_TO_OFFSET_DAYS = 1;

export interface NewsWindowEnd {
  /** The last day the walk will request, inclusive. */
  to: string;
  /** Non-null when the caller asked for a day that is not settled yet. */
  warning: string | null;
}

export function resolveNewsWindowEnd(
  explicitTo: string | undefined,
  today: string,
): NewsWindowEnd {
  const d = new Date(`${today}T00:00:00.000Z`);
  d.setUTCDate(d.getUTCDate() - DEFAULT_TO_OFFSET_DAYS);
  const settled = d.toISOString().slice(0, 10);

  if (explicitTo === undefined) return { to: settled, warning: null };
  if (explicitTo <= settled) return { to: explicitTo, warning: null };

  return {
    to: explicitTo,
    warning:
      `--to=${explicitTo} is not a SETTLED day — the newest settled day is ` +
      `${settled}. A day walked before it is over is checkpointed DONE or ` +
      "EMPTY, both TERMINAL, so anything published after this run is lost and " +
      "recoverable only with --redo. Run at 02:00 UTC (22:00 ET the previous " +
      "day) that day looks almost empty and would be recorded as such.",
  };
}
/* news-window-end:end */

/** Every flag this script accepts, and how each one must be spelled. */
const CLI_SPEC: TiingoCliSpec = {
  bare: ["apply", "redo"],
  valued: ["from", "to", "limit"],
  numeric: ["limit"],
};

/**
 * Parse argv, or DIE with the reason on stderr and a NON-ZERO exit.
 *
 * At MODULE scope, so it runs before Prisma is touched and before a single unit
 * of quota is spent. `--limit 5` used to parse as `LIMIT = 0`, which is this
 * file's sentinel for the WHOLE window — an operator's five-day smoke test
 * silently became the full ~90-day seed.
 */
function parseArgsOrExit(): TiingoCliArgs {
  try {
    return parseTiingoCliArgs(process.argv.slice(2), CLI_SPEC);
  } catch (err) {
    if (err instanceof TiingoCliError) {
      console.error(`[tiingo-news-seed] ${err.message}`);
      process.exit(1);
    }
    throw err;
  }
}

const ARGS = parseArgsOrExit();

const APPLY = ARGS.has("apply");
/** Re-attempt days previously checkpointed DONE / EMPTY. */
const REDO = ARGS.has("redo");
const FROM = ARGS.value("from");
const TO = ARGS.value("to");
/** Max DAYS this run. 0 = the whole window; `--limit=0` is REFUSED. */
const LIMIT = ARGS.number("limit", 0);

const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;

// The shape every other Cloud Run job entry point uses (feed-backfill,
// feed-parse, xbrl-backfill): one object with info/warn. It is what
// `reportBuildProvenance` takes, and `@usemoney/logger`'s getLogger() is
// keyed to a fixed LoggerModule union with no entry for a script.
const log = {
  info: (...a: unknown[]) => console.log("[tiingo-news-seed]", ...a),
  warn: (...a: unknown[]) => console.warn("[tiingo-news-seed]", ...a),
};

/** `YYYY-MM-DD` of a Date in UTC — the same calendar the client's floor uses. */
function isoDay(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/** UTC midnight of a `YYYY-MM-DD`, for the checkpoint's `date` column. */
function dayToDate(day: string): Date {
  return new Date(`${day}T00:00:00Z`);
}

/**
 * Every calendar day in `[from, to]`, inclusive and ascending.
 *
 * ASCENDING, deliberately. A day-walk ordered `desc` over a window whose recent
 * end keeps growing never reaches the oldest days — that is MONEY-1255's
 * `stock-document-extract` defect, where newest-first against a growing queue
 * pushed the backlog further down every cycle. Here the population is fixed and
 * the checkpoint decides what remains, but the ordering is stated rather than
 * incidental so it cannot be "optimised" into the failing shape.
 *
 * NO trading-calendar filter: news publishes on weekends and US holidays (the
 * measured firehose carries wire stories every day), so skipping non-trading
 * days would silently drop ~2/7 of the corpus.
 */
function dayRange(from: string, to: string): string[] {
  const out: string[] = [];
  for (
    let t = Date.parse(`${from}T00:00:00Z`);
    t <= Date.parse(`${to}T00:00:00Z`);
    t += 86_400_000
  ) {
    out.push(isoDay(new Date(t)));
  }
  return out;
}

/**
 * The US symbols we actually carry, UPPERCASED.
 *
 * ## This used to need a venue filter and no longer does
 *
 * It read `instrument_mappings` scoped to `TIINGO_SYNC_EXCHANGES`, because that
 * table held BOTH markets and 214 symbols collide across them (ACC, BABA, AUTO,
 * BBOX) — an unscoped read would have attached Atlas Air's headlines to ACC
 * Cement's news card. `us_instruments` is US-only by construction, so the
 * filter is not merely unnecessary, it is unwriteable: there is no Indian row
 * to exclude. That is the whole argument for the table split, cashed in.
 *
 * ## No `isActive` / `listingStatus` filter either, and that is deliberate
 *
 * A company that delisted last month still had news last month, and this feed's
 * history floor is ~90 days. Filtering to ACTIVE would drop exactly the
 * recently-delisted names whose final weeks are the most newsworthy, to save
 * nothing — the fan-out is a set membership test, not a query.
 */
async function loadKnownSymbols(): Promise<Set<string>> {
  const rows = await prisma.usInstrument.findMany({ select: { symbol: true } });
  const known = new Set<string>();
  for (const r of rows) {
    const key = r.symbol.trim().toUpperCase();
    // A ticker can occupy two listings (`DOW`) and list on two venues, so the
    // Set collapses duplicates by construction — which is all this needs, since
    // `us_stock_news` keys on `(symbol, link)` and carries no instrument id.
    if (key !== "") known.add(key);
  }
  return known;
}

interface Tally {
  daysConsidered: number;
  daysSkipped: number;
  daysFetched: number;
  articles: number;
  rowsCreated: number;
  rowsUpdated: number;
  rowsFailed: number;
  emptyDays: number;
  truncatedDays: number;
  errors: number;
  bytes: number;
  requests: number;
}

/**
 * Every article for ONE day, paging on `offset` only if a page comes back FULL.
 *
 * ## Why the page-full check is not optional
 *
 * A day is ~30-400 articles against a `limit` of 5,000, so in practice this
 * makes exactly ONE request per day. But "in practice" is how silent truncation
 * gets shipped: if a day ever exceeds the limit, a single-request implementation
 * returns a full page, counts it, and reports the day DONE — the same
 * shape as the clamped-history defect this whole ticket is about, one layer
 * down. So a full page is treated as "there may be more" and paged, and running
 * out of offset is reported as TRUNCATED rather than silently accepted.
 */
async function fetchDay(
  day: string,
  now: Date,
  t: Tally,
): Promise<{
  articles: TiingoNewsArticle[];
  bytes: number;
  truncated: boolean;
}> {
  const articles: TiingoNewsArticle[] = [];
  let bytes = 0;
  let offset = 0;

  for (;;) {
    const page: TiingoNewsResult | null = await fetchNews(
      {
        startDate: day,
        endDate: day,
        limit: TIINGO_NEWS_MAX_LIMIT,
        ...(offset > 0 ? { offset } : {}),
      },
      { now },
    );
    t.requests++;

    if (page === null) {
      // A 404 from this endpoint is not "no articles" — an unknown ticker
      // answers 200 with `[]`. A null here means the endpoint moved.
      throw new Error(
        `Tiingo answered 404 for ${day} — /tiingo/news does not 404 for an ` +
          `absent result, so this is a moved or withdrawn endpoint, not an ` +
          `empty day`,
      );
    }

    bytes += page.bytes;
    articles.push(...page.articles);

    if (page.articles.length < TIINGO_NEWS_MAX_LIMIT) break;

    offset += TIINGO_NEWS_MAX_LIMIT;
    if (offset >= TIINGO_NEWS_MAX_OFFSET) {
      return { articles, bytes, truncated: true };
    }
  }

  return { articles, bytes, truncated: false };
}

/**
 * Collapse a day's articles to unique `(symbol, link)` rows.
 *
 * Two independent sources of duplication, and both are real:
 *   - `tickers[]` repeats itself WITHIN one article (79 of 200 measured rows) —
 *     handled by `dedupeTickers` inside `toStockNewsRows`;
 *   - the same story is syndicated ACROSS articles with the same `url`, which
 *     would produce two rows for one `@@unique([symbol, link])` key in the same
 *     batch.
 * The upsert below would survive either, but a batch that contains the same key
 * twice does twice the work and reports twice the rows.
 */
function collapseRows(
  articles: readonly TiingoNewsArticle[],
  known: ReadonlySet<string>,
): StockNewsRow[] {
  const byKey = new Map<string, StockNewsRow>();
  for (const a of articles) {
    for (const row of toStockNewsRows(a, known)) {
      const key = `${row.symbol}|${row.link}`;
      if (!byKey.has(key)) byKey.set(key, row);
    }
  }
  return [...byKey.values()];
}

/**
 * Persist one day's rows into `us_stock_news`.
 *
 * ## `UsStockNews`, not `StockNews` + a `market` column — MONEY-1264
 *
 * The column version is what this wrote first, defended on the grounds that a
 * wrong news row is "informational — a wrong paragraph" where a wrong corporate
 * action is a wrong tax number. That severity argument is TRUE and it is not a
 * schema rule: it decides how badly a shared table fails, never whether it
 * does. `stock_news` is unique on `(symbol, link)` — the discriminator was NOT
 * in the key — and its four India readers filter on `symbol` alone, so a
 * `market` column could not have prevented anything. It would have to be read
 * by readers written before it existed.
 *
 * With the tables split there is no discriminator to forget: an India reader
 * querying `stock_news` cannot see a US row, and this writer cannot reach one.
 *
 * The `instrument` relation is gone with it. `UsStockNews` carries no
 * ObjectId — `instrument_mappings` holds no US rows any more, and a relation to
 * `us_instruments` would have to choose ONE of a recycled ticker's two
 * listings from an article that names neither.
 */
async function writeRows(
  rows: readonly StockNewsRow[],
  t: Tally,
): Promise<number> {
  let failedHere = 0;
  for (const row of rows) {
    try {
      const before = await prisma.usStockNews.findUnique({
        where: { symbol_link: { symbol: row.symbol, link: row.link } },
        select: { id: true },
      });
      await prisma.usStockNews.upsert({
        where: { symbol_link: { symbol: row.symbol, link: row.link } },
        update: {
          snippet: row.snippet,
          pubDate: row.pubDate,
          fetchedAt: new Date(),
        },
        create: {
          symbol: row.symbol,
          title: row.title,
          link: row.link,
          pubDate: row.pubDate,
          source: row.source,
          snippet: row.snippet,
        },
      });
      if (before) t.rowsUpdated++;
      else t.rowsCreated++;
    } catch (err) {
      t.rowsFailed++;
      failedHere++;
      log.info(
        `row FAILED ${row.symbol} ${row.link}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
  return failedHere;
}

async function checkpoint(
  day: string,
  status: string,
  bytes: number,
  detail: string | null,
): Promise<void> {
  const date = dayToDate(day);
  await prisma.feedBackfillProgress.upsert({
    where: { family_date: { family: FAMILY, date } },
    create: { family: FAMILY, date, status, bytes, detail },
    update: { status, bytes, detail, at: new Date() },
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
  reportBuildProvenance(log, "tiingo-us-news-seed");

  const now = new Date();
  const floor = newsFloorDate(now);
  const today = isoDay(now);

  for (const [label, value] of [
    ["from", FROM],
    ["to", TO],
  ] as const) {
    if (value !== undefined && !ISO_DAY.test(value)) {
      throw new Error(`--${label}=${value} must be YYYY-MM-DD`);
    }
  }

  // BOUNDED BY THE FLOOR BY CONSTRUCTION. The default `from` IS the floor, from
  // the same constant the client enforces — there is no second copy of the
  // window arithmetic here.
  const from = FROM ?? floor;
  // The default `to` is YESTERDAY, never today — see {@link resolveNewsWindowEnd}
  // for the day this used to lose permanently, every single run.
  const end = resolveNewsWindowEnd(TO, today);
  const to = end.to;
  if (end.warning !== null) log.info(`WARN ${end.warning}`);

  // An EXPLICIT pre-floor `--from` is REFUSED, never clamped. Clamping is
  // precisely the upstream behaviour this ticket exists to defend against, and
  // reproducing it here — quietly starting at the floor while the operator
  // believes they asked for a year — would be the same defect wearing our own
  // logo.
  if (from < floor) {
    throw new Error(
      `--from=${from} predates Tiingo's news floor of ${floor}. Tiingo does ` +
        `NOT error on a pre-floor request: it answers 200 with rows from the ` +
        `floor date, so a run started there would write 3 months and report ` +
        `success for the range you asked for. Re-run with --from=${floor} or ` +
        `later if that is what you want.`,
    );
  }
  if (to < from) {
    throw new Error(
      `--to=${to} precedes --from=${from}.` +
        (TO === undefined
          ? ` --to was not given, so it defaulted to the newest SETTLED day ` +
            `(${to}) rather than to today (${today}) — see ` +
            `resolveNewsWindowEnd. Pass --to=${today} explicitly if you ` +
            `really mean the current, unfinished day.`
          : ""),
    );
  }

  log.info(
    `floor=${floor} window=${from}..${to} apply=${APPLY}` +
      `${APPLY ? "" : " (DRY RUN — nothing will be written)"}`,
  );

  const known = await loadKnownSymbols();
  if (known.size === 0) {
    // Zero known symbols is never a real answer — it means the US instrument
    // sync has not run. Proceeding would fetch every day, fan every article to
    // ZERO rows, checkpoint each day DONE and exit 0: a completed backfill that
    // wrote nothing and can never be resumed without --redo.
    throw new Error(
      "us_instruments is EMPTY — refusing to proceed. Run the Tiingo " +
        "instrument sync first (it populates the table from " +
        `supported_tickers.zip across ${TIINGO_SYNC_EXCHANGES.join("/")}); ` +
        "every article would otherwise fan out to zero rows and every day " +
        "would be checkpointed DONE.",
    );
  }
  log.info(`known US symbols: ${known.size}`);

  const done = new Set<string>();
  if (!REDO) {
    const rows = await prisma.feedBackfillProgress.findMany({
      where: { family: FAMILY, status: { in: [...TERMINAL] } },
      select: { date: true },
    });
    for (const r of rows) done.add(isoDay(r.date));
  }
  log.info(`checkpointed already: ${done.size}`);

  const allDays = dayRange(from, to).filter((d) => !done.has(d));
  const days = LIMIT > 0 ? allDays.slice(0, LIMIT) : allDays;
  log.info(
    `days to walk: ${days.length} (of ${dayRange(from, to).length} in window)`,
  );

  const t: Tally = {
    daysConsidered: 0,
    daysSkipped: done.size,
    daysFetched: 0,
    articles: 0,
    rowsCreated: 0,
    rowsUpdated: 0,
    rowsFailed: 0,
    emptyDays: 0,
    truncatedDays: 0,
    errors: 0,
    bytes: 0,
    requests: 0,
  };

  // Set by the circuit-breakers below and read at the end for the EXIT CODE.
  // Both sibling walks already do this and say why: a run stopped after 3 of 90
  // days has checkpointed real work, so it is not a failure in the "nothing
  // happened" sense — but a wrapper, or a Cloud Run Job that reads only the
  // exit code, must not read "rate-limited early" as a completed seed.
  //
  // This script USED TO log the stop and `break` with no exit code at all, so a
  // daily-cap stop three days into a ninety-day window exited 0. That is the
  // same defect class as a swallowed `TiingoDailyCapError` — the cap becomes
  // invisible one layer up instead of at the catch.
  let stopped: string | null = null;

  for (const day of days) {
    t.daysConsidered++;

    let status = "DONE";
    let detail: string | null = null;
    let bytes = 0;
    let rows: StockNewsRow[] = [];
    let articleCount = 0;

    try {
      const fetched = await fetchDay(day, now, t);
      t.daysFetched++;
      bytes = fetched.bytes;
      t.bytes += bytes;
      articleCount = fetched.articles.length;
      t.articles += articleCount;

      if (fetched.truncated) {
        status = "TRUNCATED";
        detail =
          `hit the ${TIINGO_NEWS_MAX_OFFSET} offset ceiling — this day has ` +
          `more articles than deep pagination can reach; re-run it scoped by ` +
          `ticker`;
        t.truncatedDays++;
      } else if (articleCount === 0) {
        // Distinct from DONE. Zero articles for a day is possible but unusual
        // (the measured firehose runs every calendar day), so it is recorded
        // rather than folded into success — a run of EMPTY days is the signal
        // that something upstream changed.
        status = "EMPTY";
        t.emptyDays++;
      }

      rows = collapseRows(fetched.articles, known);
    } catch (err) {
      if (err instanceof TiingoRateLimitError) {
        // Circuit-break the RUN. Continuing spends the remaining budget
        // collecting the same error; the checkpoint resumes exactly here.
        //
        // The DAILY CAP arrives as this class too — `TiingoDailyCapError
        // extends TiingoRateLimitError` in `tiingo-pacer.ts`, deliberately, so
        // a breaker written against the parent inherits the behaviour — which
        // is why there is no second arm for it.
        stopped = `RATE LIMITED at ${day} — ${err.message}`;
        break;
      }
      if (err instanceof TiingoAuthError) {
        stopped = `AUTH/ENTITLEMENT failure at ${day} — ${err.message}`;
        break;
      }
      if (
        err instanceof TiingoNewsFloorError ||
        err instanceof TiingoNewsClampedError
      ) {
        // Either the window arithmetic or the response disagreed with what we
        // asked for. Both mean the data on the wire is not the data we
        // requested, and neither is retryable — stop rather than walk 90 days
        // writing articles from the wrong dates.
        stopped = `WINDOW failure at ${day} — ${err.message}`;
        break;
      }
      status = "ERROR";
      detail = err instanceof Error ? err.message : String(err);
      t.errors++;
    }

    if (!APPLY) {
      log.info(
        `DRY ${day} ${status} articles=${articleCount} rows=${rows.length} ` +
          `bytes=${bytes}` +
          (rows.length > 0
            ? ` sample=${rows
                .slice(0, 3)
                .map((r) => r.symbol)
                .join(",")}`
            : ""),
      );
      continue;
    }

    // THE WRITE DECIDES THE STATUS, not the fetch alone.
    //
    // `writeRows` swallows per-row failures into a counter, and this used to
    // checkpoint the fetch-derived status regardless — so a Mongo blip during
    // one day's writes left that day marked terminally DONE with its rows
    // missing. `TERMINAL` is the resume filter, so the day is never re-walked
    // without `--redo`, and Tiingo's news history floors at 90 days: after
    // three months that session is unrecoverable.
    //
    // Both sibling walks already do this — corp-actions flips to ERROR when
    // `writeRows` throws, and the EOD walk routes the write outcome through
    // `judgeEodWrite`.
    let finalStatus = status;
    let finalDetail = detail;
    if (status === "DONE" || status === "TRUNCATED") {
      const failedHere = await writeRows(rows, t);
      if (failedHere > 0) {
        // ERROR is deliberately NOT terminal, so the next run retries the day.
        finalStatus = "ERROR";
        finalDetail = `${failedHere} of ${rows.length} row write(s) failed`;
        log.info(`day ${day} -> ERROR (${finalDetail})`);
      }
    }
    await checkpoint(day, finalStatus, bytes, finalDetail);

    if (t.daysConsidered % 10 === 0) {
      log.info(
        `… ${t.daysConsidered}/${days.length} articles=${t.articles} ` +
          `created=${t.rowsCreated} updated=${t.rowsUpdated} ` +
          `errors=${t.errors} KB=${(t.bytes / 1024).toFixed(0)}`,
      );
    }
  }

  if (stopped) log.info(`STOPPED — ${stopped}`);

  log.info(
    `DONE days=${t.daysConsidered} skipped=${t.daysSkipped} ` +
      `fetched=${t.daysFetched} requests=${t.requests} ` +
      `articles=${t.articles} created=${t.rowsCreated} ` +
      `updated=${t.rowsUpdated} rowsFailed=${t.rowsFailed} ` +
      `empty=${t.emptyDays} truncated=${t.truncatedDays} errors=${t.errors} ` +
      `KB=${(t.bytes / 1024).toFixed(0)}`,
  );
  if (!APPLY) log.info("DRY RUN — pass --apply (bare flag) to write.");

  // `rowsFailed` counts INTO the failure side here, unlike the sibling walks,
  // because this script's per-row write errors are swallowed into a counter
  // that previously reached neither the checkpoint status nor the exit code.
  const verdict = judgeBackfillOutcome({
    stopped,
    attempted: t.daysFetched,
    succeeded: t.daysFetched - t.errors,
    failed: t.errors,
  });
  if (verdict.exitCode !== 0) {
    log.warn(`FAILED RUN — ${verdict.reason}`);
    process.exitCode = verdict.exitCode;
  } else if (t.rowsFailed > 0) {
    // A day whose FETCH worked but whose WRITES did not is not a healthy run,
    // and it is invisible in the day-level tally above.
    log.warn(`FAILED RUN — ${t.rowsFailed} row write(s) failed`);
    process.exitCode = 1;
  }
}

main()
  .catch((err) => {
    console.error("[tiingo-news-seed] FAILED", err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
