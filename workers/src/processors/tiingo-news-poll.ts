/**
 * US news poller — MONEY-1309.
 *
 * SUPERSEDES leg (f) of `us-eod-sync`, which is retired. Read that sentence as
 * a statement about a SCHEDULE, because the leg it replaces was not broken in
 * any way a counter could show.
 *
 * ## What was wrong, measured
 *
 * Leg (f) rode `us-eod-sync`, whose cron is `0 11 * * 2-6` IST. That is the
 * right schedule for PRICES and it was derived carefully: a US session on day D
 * closes 16:00 ET = 02:30 IST on D+1, and fund NAVs publish after 00:00 ET, so
 * Tue-Sat at 11:00 IST is the first moment both upstream boundaries have
 * passed. Every word of that reasoning is about a MARKET.
 *
 * News is not a market. It does not close at 16:00, it does not stop on
 * Saturday, and the calendar it follows is nobody's trading calendar. Measured
 * on prod 2026-08-31:
 *
 *     newest article held      88 hours old
 *     mean ingest lag          29.6 hours
 *     runs on Sunday IST       structurally impossible (cron is 2-6)
 *     runs on Monday IST       structurally impossible
 *
 * Nothing reported a fault, and nothing could have. Each run fetched its
 * session's day, wrote its rows and landed `healthy`. The defect was in the
 * gaps BETWEEN runs, and a job cannot count the times it did not execute.
 *
 * This poller runs every 2 minutes, 24x7, and its correctness argument rests on
 * a CURSOR rather than on a session date.
 *
 * ## What is REUSED and what is new
 *
 * Everything about the endpoint is reused, unchanged, from MONEY-1264:
 * `fetchNews` for the archived, paced, retried call; `buildTiingoNewsUrl`'s
 * 90-day floor refusal; `detectClampedResponse`'s independent response-side
 * check; the measured `limit` of 5,000 and the `offset=10000` cliff. The floor
 * and clamp guards are the ones that matter most and they survive here in full
 * — see {@link runNewsPoll}'s catch — because the failure they cover is an HTTP
 * 200 carrying rows about the WRONG DAYS, which is exactly what a fresh poller
 * would file as fresh news.
 *
 * What is new is the STORE. `us_news_articles` is article-level and keyed on
 * `tiingoId`, so one story mentioning five companies is one row that says so,
 * and the same article arriving on the fifth overlapping poll writes once.
 *
 * ## `us_stock_news` IS NOT TOUCHED
 *
 * Not written, not migrated, not deleted. Its rows stay exactly where they are
 * and its readers keep working unchanged until they are moved, one at a time,
 * in their own tickets. There is deliberately NO dual-write: two writers on two
 * tables for one feed is two sources of truth with a race between them, and the
 * whole reason `us_news_articles` exists is that the old key cannot represent
 * what the new one does. A dual-write would have to pick a loser per row.
 *
 * ## Wiring
 *
 * `PUBSUB_TOPICS.TIINGO_NEWS_POLL`, the `SCHEDULER_DEFS` row
 * (`*\/2 * * * *`, PROD_ONLY) and the push subscription all landed with T7;
 * this file's route is mounted in `workers/src/index.ts` and mapped in
 * `lib/pull-subscriber.ts`.
 *
 * The pairing was ENFORCED rather than remembered, which is worth recording
 * because it is the guard doing its job in both directions:
 * `topic-publisher-coverage` fails a DECLARED topic no scheduler publishes to
 * (the MONEY-1205 dead-topic shape — created by the infra scripts, consumed by
 * a route, never fired), AND it fails a SCHEDULER entry whose `TOPIC_BASE` is
 * not in `PUBSUB_TOPICS`. So the constant and the cron could not be half-landed
 * in either order.
 *
 * The route path after `/jobs/` MUST equal the topic base name, or the push
 * subscription points at nothing: Cloud Run answers 404, the subscription
 * dead-letters after five attempts, and every provisioning check still passes
 * because each one is for a different artefact (MONEY-1257).
 */

import { reportJobOutcome } from "@usemoney/datadog/job-outcome";
import { prisma } from "@usemoney/database";
import type { Prisma } from "@usemoney/database";
import type { TiingoNewsPollMessage } from "@usemoney/types/pubsub";
import { fetchNews } from "@usemoney/core/market-data/tiingo/tiingo-news";
// The MONEY-1264 guards, imported rather than restated. `TiingoNewsFloorError`
// fires before the request; `TiingoNewsClampedError` fires on the response, so
// it still catches a clamp when the floor arithmetic is wrong or Tiingo moves
// its window. Catching only the first leaves the second falling through as an
// ordinary transport failure — which is how rows about the wrong days get
// stored as this minute's news.
import {
  TIINGO_NEWS_MAX_LIMIT,
  TIINGO_NEWS_MAX_OFFSET,
  TiingoNewsClampedError,
  TiingoNewsFloorError,
  dedupeTickers,
  type TiingoNewsArticle,
} from "@usemoney/core/market-data/tiingo/tiingo-news-logic";
import {
  TiingoAuthError,
  TiingoRateLimitError,
} from "@usemoney/core/market-data/tiingo/tiingo-client";
// MONEY-1507 (C1) — the NEWS half of the unified event stream. Imported, never
// restated: `event-types.ts` is the ONE place an event id, a severity and the
// alert floor are decided.
import { tiingoNewsEvents } from "@usemoney/core/events/event-types";
import { publishEvents } from "@usemoney/services/events";
import {
  DEFAULT_NEWS_OVERLAP_MS,
  normalizeArticle,
  planNewsCursor,
  safeCursorAdvance,
  type CursorAdvanceDecision,
  type NewsCursorPlan,
  type UsNewsArticleRow,
} from "@usemoney/core/market-data/tiingo/tiingo-news-articles-logic";

const logger = {
  info: (...args: unknown[]) => console.log("[tiingo-news-poll]", ...args),
  warn: (...args: unknown[]) => console.warn("[tiingo-news-poll]", ...args),
  error: (...args: unknown[]) => console.error("[tiingo-news-poll]", ...args),
};

/** Stable job id for the outcome metric. Matches the scheduler name. */
export const JOB_NAME = "tiingo-news-poll";

/** The `UsNewsCursor.key` this job owns. One row, one stream. */
export const NEWS_CURSOR_KEY = "tiingo-news";

/**
 * The scheduler cadence this job is sized against: 2 minutes.
 *
 * Restated here rather than read from anywhere, because there is nowhere to
 * read it from — the cron lives in `setup-scheduler.sh`, which cannot fail when
 * the two drift. It appears in exactly one arithmetic expression
 * ({@link RUN_TIME_BUDGET_MS}) so that the drift, if it happens, changes one
 * number with a stated derivation instead of an unexplained constant.
 */
export const POLL_INTERVAL_MS = 120_000;

/**
 * Wall-clock budget for one run: 90s, checked BETWEEN pages and BETWEEN write
 * chunks.
 *
 * NOT the 600s Pub/Sub ack deadline, and that is the whole point. At a
 * 2-minute cadence the binding constraint arrives four and a half minutes
 * earlier than the ack deadline does: a run still going at 120s is running
 * CONCURRENTLY with the next scheduled run, against a paid metered quota that
 * reports nothing about itself. Two pollers walking the same overlap window
 * spend double for the same rows.
 *
 * 90s leaves 30s of margin for the final write chunk, the cursor advance and
 * the outcome report — the tail that runs AFTER the last budget check. Sized
 * against the interval rather than the deadline because overrunning the
 * interval is the failure that actually happens 720 times a day.
 *
 * Overlapping runs are not corrupting — the `tiingoId` upsert is idempotent —
 * so this is a cost and pacing guard, not a correctness one. Correctness comes
 * from the cursor.
 */
export const RUN_TIME_BUDGET_MS = 90_000;

/**
 * Rows per clock check in the write loop.
 *
 * Same shape as `us-eod-sync`'s news write loop, and for the same reason: the
 * loop is the last unbounded thing in the run, so it needs a gate that is
 * checked often enough to bound the overshoot and rarely enough that
 * `Date.now()` is not the dominant cost. At a measured ~10ms per upsert, 25
 * rows is a ~250ms granularity.
 */
export const WRITE_CHUNK_ROWS = 25;

/** Symbols per `us_instruments` lookup. Mirrors `CA_LOOKUP_CHUNK_SIZE`. */
export const LOOKUP_CHUNK_SIZE = 500;

/**
 * Named so the operator-facing string is one fact in one place, and so a test
 * can assert the run SAID this rather than merely returning a zero.
 */
export const NEWS_FLOOR_REJECTED_REASON =
  "NEWS POLL REJECTED BY THE 90-DAY FLOOR (or by the clamp check behind it). " +
  "Tiingo does NOT error on a pre-floor window — it answers HTTP 200 with " +
  "rows from the floor date, so the articles would have been filed as this " +
  "minute's news. NOTHING was written and the cursor did NOT advance, so the " +
  "next poll re-asks for the same window.";

/**
 * Named for the same reason the two above are: so the operator-facing string is
 * one fact in one place, and so a test can assert the run SAID it.
 *
 * A truncated run used to report `ok: true` — neither truncation flag was in
 * the `ok` expression — while ALSO advancing the cursor past the days it never
 * wrote. The two defects hid each other: the loss was silent because the run
 * was healthy, and the run looked healthy because nothing counted the loss.
 */
export const NEWS_WINDOW_INCOMPLETE_REASON =
  "NEWS POLL INCOMPLETE: the offset walk did not reach a short page, so rows " +
  "exist in this window that this run never saw. The cursor was NOT advanced " +
  "(see safeCursorAdvance) — the feed is newest-first ACROSS DAYS and the " +
  "next window is day-granular, so advancing from a partial read would put " +
  "the older days permanently outside every future window.";

export const NEWS_LOOKUP_UNAVAILABLE_REASON =
  "NEWS POLL UNDETERMINED: articles arrived carrying tickers and EVERY " +
  "us_instruments lookup chunk failed, so 'we carry none of these' cannot be " +
  "told apart from 'we could not ask'. Writing now would store every article " +
  "with an EMPTY tickers array and the upsert would then treat those rows as " +
  "settled. Nothing was written and the cursor did NOT advance.";

/** What the route logs. Flat, so a log line is greppable. */
export interface TiingoNewsPollResult {
  ok: boolean;
  reason?: string;
  /** `YYYY-MM-DD` window actually requested. */
  startDate: string;
  endDate: string;
  /** No stored watermark — a cold start. */
  firstRun: boolean;
  /** The window start was raised to Tiingo's 90-day floor. */
  clampedToFloor: boolean;
  /** `/tiingo/news` calls issued, across every page. */
  pages: number;
  /** Articles RECEIVED. */
  articles: number;
  /** Articles that could not be stored at all (no id / no date / no title). */
  skipped: number;
  /** `us_news_articles` rows persisted. Counted AFTER the upsert returns. */
  written: number;
  /** Rows attempted and refused by the database. */
  failed: number;
  /**
   * Rows OWED a write this run — the number reported to Datadog as
   * `job.selected`.
   *
   * On the result because it was NOT before, so no log line and no test could
   * see what the metric was told. It is `written + unpersisted` by
   * construction; a run where they disagree and this equals `written` is a run
   * that under-claimed its own work.
   */
  selected: number;
  /**
   * (article, ticker) pairs naming a security our master does not carry.
   *
   * Dropped from the row and COUNTED. Never stored: an unvalidated symbol joins
   * to nothing and is visible only as an inflated array.
   */
  droppedTickers: number;
  /**
   * Distinct `us_instruments` symbols matched, or `null` when EVERY lookup
   * chunk threw.
   *
   * `0` and `null` are different answers and they send an operator to
   * different systems — `0` is "tonight's articles name nothing we carry",
   * `null` is "we could not ask". Fabricating a `0` there is the MONEY-1264 F4
   * defect, which reported a database outage as an empty master.
   */
  matchedSymbols: number | null;
  /** The offset walk hit Tiingo's measured ceiling with a still-full page. */
  truncated: boolean;
  /** The write loop stopped on {@link RUN_TIME_BUDGET_MS}. */
  writeTruncated: boolean;
  /**
   * The offset walk reached a SHORT PAGE, i.e. the window was read to its end.
   *
   * The single fact the cursor decision turns on, and deliberately a POSITIVE
   * property rather than a family of failure flags: the walk stops for a dozen
   * reasons (the offset ceiling, the run budget, a 404, a 401, a rate limit, an
   * ordinary page error after a full page) and every one of them means the same
   * thing here — rows in this window went unseen. Enumerating them is how one
   * gets missed; asking whether the walk FINISHED cannot.
   */
  windowComplete: boolean;
  /** Rows built but not written: budget-skipped or write-refused. */
  unpersisted: number;
  /** MONEY-1507 — `InstrumentEvent` rows upserted for this window's articles. */
  eventsWritten: number;
  /**
   * Events the writer refused, or the count it could not attempt at all.
   *
   * Reported because `eventsWritten: 0` has THREE causes — no stored article
   * resolved to a listing, the upsert refused, the whole call threw — and a
   * bare zero makes all three read as a quiet two minutes (MONEY-1278).
   */
  eventsFailed: number;
  /** Why the watermark did or did not move. See `safeCursorAdvance`. */
  cursorAdvanceReason: CursorAdvanceDecision["reason"];
  /** The 90-day floor / clamp guard fired. A real failure, never swallowed. */
  floorRejected: boolean;
  /** Tiingo answered 401/403. */
  refused: boolean;
  /** Upstream calls that failed. Not measured in rows — see `JobOutcome`. */
  transportFailures: number;
  /** The watermark this run advanced the cursor TO, if it moved. */
  cursorAdvancedTo: string | null;
}

interface RunState {
  pages: number;
  articles: number;
  skipped: number;
  owed: number;
  written: number;
  failed: number;
  droppedTickers: number;
  matchedSymbols: number | null;
  truncated: boolean;
  writeTruncated: boolean;
  windowComplete: boolean;
  floorRejected: boolean;
  refused: boolean;
  rateLimited: boolean;
  transportFailures: number;
  eventsWritten: number;
  eventsFailed: number;
}

function newState(): RunState {
  return {
    pages: 0,
    articles: 0,
    skipped: 0,
    owed: 0,
    written: 0,
    failed: 0,
    droppedTickers: 0,
    // NULL, not 0. See `matchedSymbols` on the result.
    matchedSymbols: null,
    truncated: false,
    writeTruncated: false,
    // FALSE until the offset walk proves otherwise by reaching a short page.
    // Fail-closed: a new stop condition added to `fetchWindow` that forgets to
    // set this leaves the cursor UNMOVED, which is the survivable direction.
    windowComplete: false,
    floorRejected: false,
    refused: false,
    rateLimited: false,
    transportFailures: 0,
    eventsWritten: 0,
    eventsFailed: 0,
  };
}

/** Deps the tests replace. Production passes NONE, so the defaults ARE the path. */
export interface NewsPollDeps {
  fetchNews?: typeof fetchNews;
  prisma?: typeof prisma;
  /** Wall-clock instant, for the WINDOW arithmetic. */
  now?: () => Date;
  /**
   * Elapsed-time source for {@link RUN_TIME_BUDGET_MS}, in ms.
   *
   * SEPARATE from `now`, because they answer different questions and a test
   * needs them to disagree: `now` is pinned to a fixed instant so the requested
   * window is deterministic, while the budget needs a clock that MOVES so the
   * truncation branches are reachable at all. Sharing one would make the
   * elapsed time permanently 0 and leave both truncation paths — the two that
   * lost days — untestable except by patching a global.
   */
  elapsedMs?: () => number;
  /**
   * The `InstrumentEvent` writer (MONEY-1507). Injected for the same reason the
   * others are: the default IS production, and a test that cannot replace it
   * would have to reach real Mongo to prove the poller emits at all.
   */
  publishEvents?: typeof publishEvents;
}

/** `true` while there is still room for another bounded unit of work. */
function withinBudget(startedAt: number, nowMs: number): boolean {
  return nowMs - startedAt < RUN_TIME_BUDGET_MS;
}

function chunk<T>(items: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size)
    out.push(items.slice(i, i + size));
  return out;
}

/**
 * One poll: read the cursor, fetch the overlap window, validate, upsert,
 * advance.
 *
 * ## The order is load-bearing
 *
 * The cursor is advanced LAST, and never past the OLDEST thing this run failed
 * to store. `safeCursorAdvance` owns that decision and its header carries the
 * measurement; the invariant it preserves is:
 *
 *     NO ARTICLE MAY FALL PERMANENTLY OUTSIDE EVERY FUTURE WINDOW.
 *
 * This used to be `newestCrawlDate(persisted)`, unconditionally, and the
 * comment here defended it as safe because it moved only to rows that were
 * actually WRITTEN. That is true and it is not sufficient. Three facts compose:
 * Tiingo's feed is newest-first ACROSS DAYS (measured — see
 * `detectClampedResponse`), `rows` is never sorted so the written set is the
 * NEWEST slice, and the next window is DAY-granular with a 30-minute overlap
 * that reaches back at most one calendar day. A 3-day catch-up window that
 * truncated therefore advanced the cursor into day 3 and days 1 and 2 were
 * never asked for again. Simulated: `ok: true`, `selected === written`,
 * `failed: 0`. Any cold start spans three calendar days
 * (`FIRST_RUN_LOOKBACK_MS` is 2 days), so this was one outage away.
 *
 * Every early return below leaves the cursor UNMOVED, which makes the next poll
 * re-ask for the same window. That is the correct direction for all of them: a
 * refused, clamped, rate-limited or lookup-blind run has learned nothing, and
 * repeating a 2-minute request is free where losing a window is permanent.
 */
export async function runNewsPoll(
  msg: TiingoNewsPollMessage = {},
  deps: NewsPollDeps = {},
): Promise<TiingoNewsPollResult> {
  const db = deps.prisma ?? prisma;
  const fetch = deps.fetchNews ?? fetchNews;
  const clock = deps.now ?? (() => new Date());
  const elapsed = deps.elapsedMs ?? (() => Date.now());

  const startedAt = elapsed();
  const state = newState();

  const cursor = await db.usNewsCursor.findUnique({
    where: { key: NEWS_CURSOR_KEY },
  });

  const plan: NewsCursorPlan = planNewsCursor(
    cursor?.lastCrawlDate ?? null,
    clock(),
    typeof msg.overlapMs === "number" ? msg.overlapMs : DEFAULT_NEWS_OVERLAP_MS,
  );

  logger.info(
    `Polling ${plan.startDate}..${plan.endDate} ` +
      `(windowStart ${plan.windowStart.toISOString()}, ` +
      `overlap ${plan.overlapMs}ms, firstRun=${plan.firstRun}` +
      (plan.clampedToFloor ? ", CLAMPED-TO-FLOOR" : "") +
      `). Cursor: ${cursor?.lastCrawlDate?.toISOString() ?? "none"}.`,
  );

  const articles = await fetchWindow({
    plan,
    state,
    startedAt,
    elapsed,
    fetch,
    msg,
  });

  // A quiet two minutes is the COMMON case and it is not a failure. The cursor
  // stays put — there is no newer crawlDate to move it to — which is exactly
  // what the overlap window needs on the next tick.
  if (articles.length === 0) {
    return finish(
      db,
      state,
      plan,
      { advanceTo: null, reason: "nothing-written" },
      startedAt,
      elapsed,
      0,
    );
  }

  // ── Validate the tickers against our own master ──────────────────────────
  //
  // Every distinct symbol the window's articles mention. Deduped per article
  // first (`dedupeTickers`, the client's own rule) because Tiingo repeats
  // tickers inside one article's array — measured, 79 of 200 market-wide rows.
  const mentioned = new Set<string>();
  for (const a of articles)
    for (const t of dedupeTickers(a.tickers)) mentioned.add(t);

  const known = new Set<string>();
  /** symbol -> listingId, for the MONEY-1507 NEWS events. */
  const symbolToListing = new Map<string, string>();
  let lookupChunks = 0;
  let lookupFailures = 0;
  for (const slice of chunk([...mentioned], LOOKUP_CHUNK_SIZE)) {
    lookupChunks++;
    try {
      const found = await db.usInstrument.findMany({
        // ACTIVE only, and matched POSITIVELY. On Mongo an attribute absent
        // from a pre-existing row makes a negative test match ZERO rows
        // (MONEY-1050 / 1205 / 1234 / 1236), so `listingStatus: {not:
        // "DELISTED"}` would silently select nothing.
        where: { listingStatus: "ACTIVE", symbol: { in: slice } },
        // `listingId` rides along for MONEY-1507's NEWS events. It costs
        // nothing — the rows are already being read — and it is the ONLY way
        // the event can name a security: `symbol` is not an identity here
        // (`DOW` is two companies), which is the whole reason `Candle` and
        // `lake_silver.listing` key on `listingId` instead.
        select: { symbol: true, listingId: true },
      });
      for (const row of found) {
        const symbol = row.symbol.toUpperCase();
        known.add(symbol);
        // FIRST WINS, matching `known`: the master can legitimately hold two
        // ACTIVE rows for one symbol across venues, and an arbitrary last-wins
        // would move an article between listings run to run.
        if (!symbolToListing.has(symbol))
          symbolToListing.set(symbol, row.listingId);
      }
    } catch (err) {
      // A failed lookup is NOT "we carry none of these". The slice stays out of
      // the known set, so its symbols are dropped rather than stored
      // unverified — the conservative direction — and the failure is counted
      // so a total outage cannot pass as an empty master.
      lookupFailures++;
      logger.warn(
        `Master lookup failed for ${slice.length} symbol(s): ` +
          `${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  // EVERY chunk failed AND nothing matched. `null`, not `0` — and we REFUSE to
  // write, because writing now would store each article with an empty
  // `tickers` array and the `tiingoId` upsert would then treat those rows as
  // settled on the next poll. A partial failure that still matched something
  // HAS proved we carry those, so it writes (undercounting, and saying so).
  if (lookupFailures > 0 && known.size === 0 && mentioned.size > 0) {
    state.matchedSymbols = null;
    logger.error(
      `${NEWS_LOOKUP_UNAVAILABLE_REASON} ` +
        `(${lookupChunks} chunk(s), ${mentioned.size} mentioned ticker(s))`,
    );
    return finish(
      db,
      state,
      plan,
      { advanceTo: null, reason: "nothing-written" },
      startedAt,
      elapsed,
      0,
      NEWS_LOOKUP_UNAVAILABLE_REASON,
    );
  }
  state.matchedSymbols = known.size;
  // D4. A PARTIAL lookup failure means `known` is a known undercount, so the
  // `tickers` array this run computes is SHORTER than the truth — and the
  // update below would overwrite a correct, longer array with it.
  const lookupComplete = lookupFailures === 0;
  if (!lookupComplete) {
    logger.warn(
      `${lookupFailures} of ${lookupChunks} lookup chunk(s) failed; ` +
        `${known.size} matched symbol(s) is an UNDERCOUNT and the symbols ` +
        "behind the failed chunks are dropped from this run's rows. " +
        "`tickers` is therefore OMITTED from the update payload — a CREATE " +
        "still carries the best set we have (an undercounted row beats no " +
        "row, and the 30-minute overlap re-delivers it to a healthy poll " +
        "within ~15 ticks), but an EXISTING row is never shrunk by a run that " +
        "could not ask.",
    );
  }

  // ── Normalize ────────────────────────────────────────────────────────────
  const rows: UsNewsArticleRow[] = [];
  const seenIds = new Set<number>();
  for (const article of articles) {
    const { row, droppedTickers, skipReason } = normalizeArticle(
      article,
      known,
    );
    state.droppedTickers += droppedTickers;
    if (row === null) {
      state.skipped++;
      logger.warn(
        `Article skipped (${skipReason}): id=${String(article.id)} ` +
          `title=${JSON.stringify(article.title.slice(0, 80))}`,
      );
      continue;
    }
    // The table's unique, applied in memory. The overlap window can return one
    // article twice inside a single run when a page boundary repeats it, and
    // two upserts to one key in one run would count two writes for one row.
    if (seenIds.has(row.tiingoId)) continue;
    seenIds.add(row.tiingoId);
    rows.push(row);
  }

  // ── Write ────────────────────────────────────────────────────────────────
  const persisted: UsNewsArticleRow[] = [];
  // EVERY row this run built and did not store. Both ways of getting here are
  // data the cursor still owes: the budget-skipped TAIL, and the individual
  // upsert that threw — a HOLE IN THE MIDDLE, which the old watermark sailed
  // straight past whenever a newer row wrote successfully after it.
  //
  // SKIPPED articles are deliberately NOT in here. An article `normalizeArticle`
  // refused has no id or no parseable date, so it can never be stored however
  // many times it is re-asked for, and it has no usable `crawlDate` to bound a
  // watermark WITH. Holding the cursor for one would stall the feed forever on
  // a row that will never become storable. It is counted in `skipped` and
  // logged instead — a different failure, reported as one.
  const unpersisted: UsNewsArticleRow[] = [];
  for (const [index, row] of rows.entries()) {
    if (index % WRITE_CHUNK_ROWS === 0 && !withinBudget(startedAt, elapsed())) {
      state.writeTruncated = true;
      const tail = rows.slice(index);
      unpersisted.push(...tail);
      // OWED, not attempted. `selected` is documented as "rows owed a write",
      // and a row the budget skipped is owed one — leaving it out reported
      // `selected === written` on the exact run that lost data, which is the
      // MONEY-1255 counter defect pointing the other way. The Datadog alarm is
      // `selected > 0 && written === 0` so this does not by itself page
      // anyone; it makes the emitted series honest, and `ok: false` plus
      // `skippedReason` are what carry the incident.
      state.owed += tail.length;
      logger.error(
        `Write loop stopped on the ${RUN_TIME_BUDGET_MS}ms run budget after ` +
          `${elapsed() - startedAt}ms with ${rows.length - index} of ` +
          `${rows.length} row(s) not attempted. The cursor is bounded by the ` +
          "OLDEST of them, so every one is inside the next poll's window. " +
          "This comment used to read 'the cursor advances only to what was " +
          "written, so the next poll re-asks for the rest' — which was FALSE " +
          "whenever the remainder fell on an earlier UTC day, because the " +
          "feed is newest-first across days and the window is day-granular.",
      );
      break;
    }
    state.owed++;
    try {
      await db.usNewsArticle.upsert({
        where: { tiingoId: row.tiingoId },
        create: {
          tiingoId: row.tiingoId,
          title: row.title,
          url: row.url,
          description: row.description,
          publishedAt: row.publishedAt,
          crawlDate: row.crawlDate,
          source: row.source,
          tickers: row.tickers,
          tags: row.tags,
          clusterKey: row.clusterKey,
        },
        // A re-read reflects the CURRENT upstream article and the CURRENT
        // master: a corrected title, a ticker the master has since learned, a
        // description that was empty. `fetchedAt` and `createdAt` are left
        // alone — they mean "when we FIRST saw this", and refreshing them on
        // every overlapping poll would make a week-old article look like it
        // arrived seconds ago, which is the one reading a freshness monitor
        // depends on.
        //
        // D4 — THIS USED TO CLAIM "a re-read can only IMPROVE a row", and the
        // claim was false in exactly one reachable case. A PARTIAL master
        // lookup (some chunks threw, some matched) still writes, and it writes
        // a SHORTER `tickers` array, overwriting a correct longer one. It
        // self-heals only inside the day-granular window, so a row whose
        // symbols were blanked at 23:58 UTC could keep them blanked. Rather
        // than narrow the comment, the write is narrowed: `tickers` is omitted
        // from the update whenever this run could not ask completely, so the
        // claim above is TRUE by construction instead of being a hope. Costs
        // nothing — no extra query, no read-modify-write race — and the
        // overlap hands the row to a healthy poll within ~15 ticks.
        update: {
          title: row.title,
          url: row.url,
          description: row.description,
          publishedAt: row.publishedAt,
          crawlDate: row.crawlDate,
          source: row.source,
          ...(lookupComplete ? { tickers: row.tickers } : {}),
          tags: row.tags,
          clusterKey: row.clusterKey,
        },
      });
      // AFTER the upsert RESOLVES — MONEY-1255. Incremented before the call,
      // this counter reports a full night's work from a database that refused
      // every write, which is precisely the reading that hid Tickertape's
      // block for five months.
      state.written++;
      persisted.push(row);
    } catch (err) {
      state.failed++;
      unpersisted.push(row);
      logger.warn(
        `Upsert failed for tiingoId=${row.tiingoId}: ` +
          `${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  // MONEY-1507 (C1) — one NEWS event per (stored article, resolved listing).
  //
  // AFTER the write loop and only over `persisted`, so an event can never claim
  // an article `us_news_articles` does not hold. FAIL-SOFT: a throw here would
  // lose the CURSOR decision below, which is the one thing in this run that
  // must not be lost — an un-advanced watermark costs a re-poll, a watermark
  // advanced past an unwritten row loses it permanently.
  //
  // `state.eventsFailed` is reported, because `eventsWritten: 0` has three
  // causes — no articles resolved to a listing, the write refused, the whole
  // call threw — and a bare zero makes all three read as a quiet two minutes.
  await emitNewsEvents(
    persisted,
    symbolToListing,
    state,
    deps.publishEvents ?? publishEvents,
  );

  // THE WATERMARK INVARIANT — no article may fall permanently outside every
  // future window. The decision is pure and lives in
  // `safeCursorAdvance`, whose header carries the measurement it rests on;
  // what this line must not do is what it did before, which was to hand
  // `newestCrawlDate(persisted)` over unconditionally.
  return finish(
    db,
    state,
    plan,
    safeCursorAdvance({
      persisted,
      unpersisted,
      windowComplete: state.windowComplete,
    }),
    startedAt,
    elapsed,
    unpersisted.length,
  );
}

/**
 * Emit one NEWS event per (stored article, resolved listing). NEVER throws.
 *
 * Bounded by construction rather than by a clock: it runs over `persisted`,
 * which the write loop has already capped on {@link RUN_TIME_BUDGET_MS}, and it
 * fans each row out to the listings THAT ROW already names. A poll writing tens
 * of articles produces tens to low hundreds of upserts at ~10 ms apiece — the
 * same order as the write loop it follows, inside a 120 s cadence.
 *
 * `publishEvents` counts a per-row failure rather than throwing, so the only
 * throw reachable here is a CONTRACT violation (a zod refusal), which is a bug
 * in this mapping and not a transient. It is caught for the reason the call
 * site gives: losing the cursor decision below is worse than losing an event.
 */
async function emitNewsEvents(
  persisted: readonly UsNewsArticleRow[],
  symbolToListing: ReadonlyMap<string, string>,
  state: RunState,
  publish: typeof publishEvents,
): Promise<void> {
  if (persisted.length === 0 || symbolToListing.size === 0) return;
  const observedAt = new Date();
  const events = persisted.flatMap((row) =>
    tiingoNewsEvents(row, symbolToListing, observedAt),
  );
  if (events.length === 0) return;
  try {
    const result = await publish(events);
    state.eventsWritten += result.upserted;
    state.eventsFailed += result.failed;
  } catch (err) {
    state.eventsFailed += events.length;
    logger.error(
      `NEWS event emission failed for ${events.length} event(s): ` +
        `${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

/**
 * The offset walk.
 *
 * Inherited wholesale from the retired leg, because every one of its stop
 * conditions is about the ENDPOINT rather than about the schedule:
 *
 *   - `limit` is EXPLICIT and always sent. Omitting it is not "the default page
 *     size", it is Tiingo's server default of 100 rows of a market-wide feed,
 *     silently, newest-first (MONEY-1264 review F1).
 *   - a SHORT page ends the walk; a FULL page means "there may be more". A
 *     single-request version returns a full page, counts it, and reports the
 *     window complete.
 *   - the offset ceiling is a REFUSAL, not a loop condition. Measured,
 *     `offset=10000` returns ZERO rows — indistinguishable from "no more news"
 *     — so a pager that reads it as exhaustion under-collects silently and one
 *     that reads it as a short page never terminates.
 *
 * The floor/clamp catch is the reason this function exists at all rather than
 * being inlined: it is the one failure whose upstream shape is a well-formed
 * HTTP 200 about the wrong days.
 */
async function fetchWindow(args: {
  plan: NewsCursorPlan;
  state: RunState;
  startedAt: number;
  elapsed: () => number;
  fetch: typeof fetchNews;
  msg: TiingoNewsPollMessage;
}): Promise<TiingoNewsArticle[]> {
  const { plan, state, startedAt, elapsed, fetch, msg } = args;
  const limit =
    typeof msg.limit === "number" &&
    Number.isInteger(msg.limit) &&
    msg.limit >= 1 &&
    msg.limit <= TIINGO_NEWS_MAX_LIMIT
      ? msg.limit
      : TIINGO_NEWS_MAX_LIMIT;

  const out: TiingoNewsArticle[] = [];
  let offset = 0;

  for (;;) {
    if (!withinBudget(startedAt, elapsed())) {
      // A FULL page was pending, so the window is incomplete. `windowComplete`
      // is already false and STAYS false, which is the fact that stops the
      // cursor. `truncated` is the narrower REPORTED flag and keeps its old
      // meaning (a page walk cut short), which is why it is still gated on
      // `offset > 0`: at offset 0 nothing was fetched at all.
      if (offset > 0) state.truncated = true;
      logger.warn(
        `Run budget reached after ${elapsed() - startedAt}ms at offset ` +
          `${offset} — window ${plan.startDate}..${plan.endDate} is INCOMPLETE.`,
      );
      break;
    }

    let pageCount = 0;
    let stop = false;
    try {
      const res = await fetch({
        startDate: plan.startDate,
        endDate: plan.endDate,
        limit,
        // Sent only when non-zero: `buildTiingoNewsUrl` validates the parameter
        // it is given, and an absent offset is the request the first page has
        // always made.
        ...(offset > 0 ? { offset } : {}),
      });
      if (res === null) {
        // 404 — a MOVED endpoint, not a quiet window. An unknown ticker answers
        // 200 with `[]`; this cannot pass as "no articles".
        state.transportFailures++;
        stop = true;
        logger.error(
          `/tiingo/news returned 404 for ${plan.startDate}..${plan.endDate} ` +
            `at offset ${offset} — the route has MOVED. Not an empty window.`,
        );
      } else {
        // AFTER the call returned.
        pageCount = res.articles.length;
        out.push(...res.articles);
        state.articles += pageCount;
      }
    } catch (err) {
      stop = true;
      state.transportFailures++;
      if (
        err instanceof TiingoNewsFloorError ||
        err instanceof TiingoNewsClampedError
      ) {
        // FIRST, and its own flag. The underlying upstream behaviour is a 200
        // about the wrong days, so it must never fall through to the generic
        // transport branch where it would read as a flake and be retried into.
        state.floorRejected = true;
        logger.error(
          `${NEWS_FLOOR_REJECTED_REASON} Window asked for: ` +
            `${plan.startDate}..${plan.endDate}. ${err.message}`,
        );
      } else if (err instanceof TiingoRateLimitError) {
        // Catches `TiingoDailyCapError` too — it is a SUBCLASS (MONEY-1263), so
        // every breaker written against the parent stops on the daily cap
        // without being edited.
        state.rateLimited = true;
        logger.error(`Tiingo rate limit — stopping this run. ${err.message}`);
      } else if (err instanceof TiingoAuthError) {
        state.refused = true;
        logger.error(`Refused by Tiingo — ${err.message}`);
      } else {
        logger.warn(
          `Page failed at offset ${offset}: ` +
            `${err instanceof Error ? err.message : String(err)}`,
        );
      }
    } finally {
      state.pages++;
    }

    if (stop) break;
    if (pageCount < limit) {
      // THE ONLY PLACE THIS IS SET. A short page is the endpoint saying "that
      // is all of it" — the one stop condition that proves the window was read
      // to its end. Every other `break` below and above leaves it false, so a
      // stop condition added later cannot silently teach the cursor to advance
      // past rows nobody saw.
      state.windowComplete = true;
      break;
    }

    offset += limit;
    if (offset >= TIINGO_NEWS_MAX_OFFSET) {
      state.truncated = true;
      logger.error(
        `Offset ceiling (${TIINGO_NEWS_MAX_OFFSET}) reached with a FULL page ` +
          `— window ${plan.startDate}..${plan.endDate} carried more articles ` +
          "than deep pagination can serve. Narrow the window or seed by day.",
      );
      break;
    }
  }

  return out;
}

/**
 * Write the cursor decision, report, return.
 *
 * The DECISION is made by `safeCursorAdvance` and arrives here already made —
 * this function only refuses to move it BACKWARDS, which is a different
 * guarantee and covers a different case (the overlap re-delivering only late,
 * older arrivals). Both are needed; neither implies the other.
 *
 * ONE exit point, so the outcome metric cannot be skipped by an early return —
 * the class of defect where a job's monitor sits in NO DATA because the branch
 * that fires in production is the branch with no `reportJobOutcome` on it.
 */
async function finish(
  db: typeof prisma,
  state: RunState,
  plan: NewsCursorPlan,
  decision: CursorAdvanceDecision,
  startedAt: number,
  elapsed: () => number,
  unpersisted: number,
  blockedReason?: string,
): Promise<TiingoNewsPollResult> {
  const advanceTo = decision.advanceTo;
  let cursorAdvancedTo: string | null = null;

  // NEVER move the watermark backwards. `newestCrawlDate` is taken over the
  // rows written THIS run, and a run that wrote only older articles (the
  // overlap re-delivering late arrivals) legitimately produces a value below
  // the stored mark. Writing it would re-widen the window every time, and on a
  // busy feed that walks backwards forever.
  const meta: Prisma.InputJsonValue = {
    articles: state.articles,
    written: state.written,
    droppedTickers: state.droppedTickers,
    windowStart: plan.windowStart.toISOString(),
    windowEnd: plan.endDate,
  };
  try {
    const existing = await db.usNewsCursor.findUnique({
      where: { key: NEWS_CURSOR_KEY },
    });
    const current = existing?.lastCrawlDate ?? null;
    const next =
      advanceTo !== null && (current === null || advanceTo > current)
        ? advanceTo
        : current;
    if (next !== null && next !== current)
      cursorAdvancedTo = next.toISOString();

    await db.usNewsCursor.upsert({
      where: { key: NEWS_CURSOR_KEY },
      create: {
        key: NEWS_CURSOR_KEY,
        lastCrawlDate: next,
        lastRunAt: new Date(),
        meta,
      },
      // `lastRunAt` is stamped on EVERY run, including one that wrote nothing.
      // It is the liveness signal, and it has to be separable from
      // `lastCrawlDate`: a quiet market and a dead poller both leave the
      // watermark still, and only this column tells them apart.
      update: { lastCrawlDate: next, lastRunAt: new Date(), meta },
    });
  } catch (err) {
    logger.error(
      "Cursor write FAILED — the next poll re-asks for the same window, " +
        "which is the safe direction: " +
        `${err instanceof Error ? err.message : String(err)}`,
    );
  }

  const reason =
    blockedReason ??
    (state.floorRejected
      ? NEWS_FLOOR_REJECTED_REASON
      : state.refused
        ? "Tiingo refused /tiingo/news with a 401/403."
        : state.rateLimited
          ? "Tiingo rate limit / daily cap — this run stopped early."
          : state.writeTruncated
            ? `Write loop stopped on the ${RUN_TIME_BUDGET_MS}ms run budget ` +
              `with ${unpersisted} row(s) unwritten; the cursor is bounded by ` +
              "the OLDEST of them so none falls outside the next window."
            : !state.windowComplete
              ? NEWS_WINDOW_INCOMPLETE_REASON
              : undefined);

  // TRUNCATION IS VISIBLE. `truncated` and `writeTruncated` were BOTH absent
  // from this expression, so a run that fetched half a window, wrote half of
  // that, and advanced its cursor past the rest reported `ok: true` with
  // `selected === written` and `failed: 0`. The `windowComplete` term is the
  // general one — it covers every way the offset walk can stop short, including
  // a 404 on page two, which used to be counted in `transportFailures` and
  // reported healthy.
  const ok =
    !state.floorRejected &&
    !state.refused &&
    !state.rateLimited &&
    !state.truncated &&
    !state.writeTruncated &&
    state.windowComplete &&
    blockedReason === undefined;

  reportJobOutcome({
    job: JOB_NAME,
    // Rows OWED a write, which is 0 for a genuinely quiet two minutes — so a
    // healthy idle poll reports `selected 0, written 0` and cannot page. A
    // DARK run (a 403, a clamp) contributes nothing here either, which is why
    // `transportFailures` exists as its own counter: a block is not a row that
    // failed to persist, it is a reason no rows were considered.
    selected: state.owed,
    written: state.written,
    failed: state.failed,
    transportFailures: state.transportFailures,
    skippedReason:
      reason ??
      (state.skipped > 0
        ? `${state.skipped} unstorable article(s)`
        : undefined),
  });

  const result: TiingoNewsPollResult = {
    ok,
    reason,
    startDate: plan.startDate,
    endDate: plan.endDate,
    firstRun: plan.firstRun,
    clampedToFloor: plan.clampedToFloor,
    pages: state.pages,
    articles: state.articles,
    skipped: state.skipped,
    written: state.written,
    failed: state.failed,
    selected: state.owed,
    droppedTickers: state.droppedTickers,
    matchedSymbols: state.matchedSymbols,
    truncated: state.truncated,
    writeTruncated: state.writeTruncated,
    windowComplete: state.windowComplete,
    unpersisted,
    eventsWritten: state.eventsWritten,
    eventsFailed: state.eventsFailed,
    cursorAdvanceReason: decision.reason,
    floorRejected: state.floorRejected,
    refused: state.refused,
    transportFailures: state.transportFailures,
    cursorAdvancedTo,
  };

  logger.info(
    `${plan.startDate}..${plan.endDate}: ${state.written}/${state.owed} row(s) ` +
      `from ${state.articles} article(s) across ${state.pages} page(s); ` +
      `${state.droppedTickers} unknown ticker(s) dropped, ` +
      `${state.matchedSymbols ?? "unanswered"} matched symbol(s), ` +
      `${state.skipped} unstorable, ${unpersisted} unpersisted, ` +
      `${state.eventsWritten} event(s) written / ${state.eventsFailed} failed; cursor -> ` +
      `${cursorAdvancedTo ?? "unmoved"} (${decision.reason})` +
      (state.floorRejected ? " FLOOR-REJECTED" : "") +
      (state.truncated ? " TRUNCATED" : "") +
      (state.writeTruncated ? " WRITE-TRUNCATED" : "") +
      (state.windowComplete ? "" : " WINDOW-INCOMPLETE") +
      ` in ${elapsed() - startedAt}ms.`,
  );

  return result;
}

/** Pub/Sub entry point. */
export async function processTiingoNewsPoll(
  msg: TiingoNewsPollMessage = {},
): Promise<TiingoNewsPollResult> {
  return runNewsPoll(msg);
}
