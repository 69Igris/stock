/**
 * ARTICLE-LEVEL Tiingo news, pure logic — MONEY-1309.
 *
 * Sibling of `tiingo-news-logic.ts`, and deliberately a THIN layer on top of
 * it rather than a parallel one. Everything that endpoint taught us — the
 * 90-day floor and its silent clamp, the honoured `limit` of 5,000, the
 * `offset=10000` cliff, the fact that `tickers[]` repeats itself — is measured,
 * written down and enforced over there. This module imports those guards; it
 * does not restate them and must never re-derive them.
 *
 * What is NEW here is the shape of the store, and it is a different shape for a
 * reason a count makes obvious.
 *
 * ## Why an article table, and why a poller
 *
 * `us_stock_news` is `@@unique([symbol, link])`, so one story mentioning five
 * companies is FIVE rows, each a full copy, none able to say the other four
 * exist. "This article mentions 5 companies" is unrepresentable, dedup has
 * nothing to group on, and the article is not a thing the schema believes in.
 *
 * The freshness problem is separate and worse, because it is a SCHEDULE bug
 * rather than a modelling one. The leg this poller supersedes rode
 * `us-eod-sync`, whose cron is `0 11 * * 2-6` IST — a MARKET schedule, Tue-Sat,
 * chosen correctly for prices because a US session on day D closes at 02:30 IST
 * on D+1. News is not a market. It does not stop on Saturday, and the calendar
 * it follows is nobody's trading calendar. Measured on prod 2026-08-31: the
 * newest article we held was 88 HOURS old and mean ingest lag was 29.6 hours,
 * and by construction the job could not run at all on a Sunday or a Monday IST.
 * No counter could show that: the leg fetched its day, wrote its rows and
 * reported healthy every time it ran. It was the not-running that was wrong.
 *
 * So the replacement runs every 2 minutes, 24x7, and its correctness argument
 * is about a CURSOR rather than about a session date — see
 * {@link planNewsCursor}.
 *
 * ## No I/O, no clock, no Prisma
 *
 * Every function here is pure and takes `now` as a parameter. That is not
 * ceremony: the cursor arithmetic is the whole risk surface of a 24x7 poller,
 * and a test that computes "30 minutes ago" and asserts the code computed the
 * same thing proves only that two copies of one expression agree.
 */

import {
  dedupeTickers,
  isBeforeFloor,
  newsFloorDate,
  type TiingoNewsArticle,
} from "./tiingo-news-logic";

/**
 * Bumped whenever {@link clusterKeyFor}'s normalisation changes.
 *
 * The key is STORED, not computed at read time, so the table holds a mixture of
 * whatever versions have run. Without a version in the key, changing the
 * stopword list would silently split every existing cluster in half — old rows
 * keyed the old way, new rows the new way, and the two never meeting — while
 * every row still looked perfectly well-formed. With it, the change is visible
 * as a prefix and a backfill is a query rather than an archaeology exercise.
 */
export const CLUSTER_KEY_VERSION = "v1";

/**
 * How far BACK of the stored watermark each poll re-asks. 30 minutes.
 *
 * ## The defect this exists to prevent
 *
 * `crawlDate` is TIINGO'S clock — stamped when their crawler reached the
 * article — and it is NOT monotonic with respect to our polling. Articles
 * arrive late and out of order: a story published at 14:00 can be crawled at
 * 14:03 while one published at 13:58 is crawled at 14:05.
 *
 * A strict `> lastCrawl` cursor therefore drops them. Run at 14:04 it sees the
 * 14:03 article, moves the watermark to 14:03, and the 14:05 crawl of the
 * OLDER story — whose crawlDate is above 14:03, so actually fine — is kept,
 * but any article whose crawlDate lands BELOW the mark after it moved is never
 * selected again. Not delayed. Dropped, once, permanently, with no error, no
 * exception and no gap that any row count can see. It is the same family as
 * every silent-partial-failure in this repo: the job keeps reporting the
 * articles it DID get.
 *
 * ## Why 30 minutes, and why the asymmetry decides it
 *
 * The two errors are not symmetric, so we take the survivable one — the same
 * reasoning that makes `TIINGO_NEWS_HISTORY_DAYS` 90 rather than the measured
 * 91, and `resolveTiingoPlan` default to the LOWER rate limits.
 *
 * Too SMALL an overlap loses articles permanently and invisibly. Too LARGE an
 * overlap costs re-fetched rows that the `tiingoId` upsert absorbs as no-op
 * writes — visible, bounded, and free of consequence. 30 minutes is 15 polls of
 * slack at a 2-minute cadence, which covers a crawler running half an hour
 * behind itself as well as a poller that missed a handful of runs.
 *
 * It is NOT sized to cover a long outage; that is what the day-granular window
 * below does. If the poller is down for hours, `planNewsCursor` still asks from
 * `lastCrawl - overlap`, whose CALENDAR DAY is the day the job stopped, so the
 * whole gap is re-requested. The overlap protects against out-of-order arrival;
 * the day granularity protects against downtime. Two different failures, and
 * conflating them is how one of them ends up uncovered.
 */
export const DEFAULT_NEWS_OVERLAP_MS = 30 * 60_000;

/**
 * What a FIRST run (no stored watermark) asks for: 2 days.
 *
 * Not the full 90-day history. A cold start that asked for the whole window
 * would page ~10,000 articles into a job built to move a couple of hundred, and
 * the 2-minute cadence means the second run picks up wherever the first stopped
 * anyway. Seeding history is `scripts/jobs/tiingo-us-news-seed.ts`'s job — it
 * has the day-walk and the checkpoints for exactly that.
 */
export const FIRST_RUN_LOOKBACK_MS = 2 * 86_400_000;

/** One `us_news_articles` row, ready for Prisma. */
export interface UsNewsArticleRow {
  /** Tiingo's own article id. The upsert key. */
  tiingoId: number;
  title: string;
  url: string;
  /** The publisher's SNIPPET. Never a fetched body — see the module header. */
  description: string | null;
  publishedAt: Date;
  crawlDate: Date;
  /** Publisher domain, e.g. `prnewswire.com`. */
  source: string;
  /** Tickers that resolved against our master. May legitimately be empty. */
  tickers: string[];
  tags: string[];
  clusterKey: string;
}

/** Why {@link normalizeArticle} refused to produce a row. */
export type NormalizeSkipReason =
  | "no-id"
  | "no-title"
  | "no-url"
  | "bad-published-date"
  | "bad-crawl-date";

/** Verdict for ONE article. */
export interface NormalizedArticle {
  /** The row, or `null` when the article cannot be stored at all. */
  row: UsNewsArticleRow | null;
  /**
   * Distinct tickers Tiingo named that our master does not carry.
   *
   * COUNTED, never stored, and never silently discarded. "Tiingo tagged this
   * with symbols we do not carry" and "our master lookup came back empty
   * because it broke" both produce an empty `tickers` array, and they send an
   * operator to two different systems. The count is what separates them, so it
   * is reported in the job outcome rather than logged and forgotten.
   */
  droppedTickers: number;
  /** The dropped symbols themselves, for the log line. Deduped, ordered. */
  dropped: string[];
  /** Set only when `row` is null. */
  skipReason?: NormalizeSkipReason;
}

/**
 * English stopwords stripped before hashing a title.
 *
 * Small and closed ON PURPOSE. Every word here is one that outlets vary freely
 * while republishing the same wire copy ("Apple to buy X" / "Apple buys X"), so
 * removing them makes the fingerprint survive that variation. A larger list
 * would start removing words that carry the story — a general-purpose stopword
 * list contains `up`, `down` and `new`, and dropping those makes "Oil prices up
 * 5%" and "Oil prices down 5%" the same headline.
 */
const TITLE_STOPWORDS = new Set([
  "a",
  "an",
  "and",
  "as",
  "at",
  "be",
  "by",
  "for",
  "from",
  "in",
  "is",
  "of",
  "on",
  "or",
  "the",
  "to",
  "with",
]);

/**
 * FNV-1a, 64-bit, as 16 lowercase hex characters.
 *
 * Hand-rolled rather than `node:crypto` because this module is imported from
 * `packages/core`, which is bundled into the Next.js apps as well as the
 * workers — a `createHash` import drags a Node builtin into a client bundle for
 * a fingerprint that has no security role whatsoever. The requirement is
 * STABILITY, not cryptography: the same title must produce the same key in
 * every process, on every platform, forever, because the key is written to the
 * database and compared against keys written months earlier.
 *
 * BigInt with an explicit 64-bit mask, not Number: `Number` loses precision
 * above 2^53, so the top bits of a 64-bit product would quietly stop
 * contributing and the effective key would shrink to whatever survived. That is
 * a collision rate change that no test would notice.
 */
function fnv1a64Hex(input: string): string {
  const MASK = (1n << 64n) - 1n;
  const PRIME = 1099511628211n;
  let hash = 14695981039346656037n;
  for (let i = 0; i < input.length; i++) {
    hash = (hash ^ BigInt(input.charCodeAt(i))) & MASK;
    hash = (hash * PRIME) & MASK;
  }
  return hash.toString(16).padStart(16, "0");
}

/**
 * A stable fingerprint for a headline, for FUTURE near-duplicate clustering.
 *
 * ## The problem it addresses
 *
 * Wire copy is republished VERBATIM by many outlets under many urls, and Tiingo
 * gives each republication its own `tiingoId`. That is correct — they ARE
 * distinct articles — so the primary key cannot collapse them, and any "how
 * much news did this company get today" reading counts one press release twelve
 * times.
 *
 * ## The normalisation, and what each step is for
 *
 *   1. lowercase                — outlets differ on Title Case vs sentence case
 *   2. strip everything that is not a letter, digit or space (Unicode-aware),
 *      which also folds the curly-vs-straight apostrophe and the
 *      hyphen-vs-en-dash variants that differ per CMS
 *   3. collapse whitespace
 *   4. drop {@link TITLE_STOPWORDS}
 *   5. FNV-1a 64, prefixed with {@link CLUSTER_KEY_VERSION}
 *
 * ## Token ORDER is preserved, deliberately
 *
 * Sorting the tokens would cluster harder, and it would be wrong: it makes
 * "Apple beats Google" and "Google beats Apple" one story. The population this
 * is aimed at is verbatim republication, where order is already identical, so
 * sorting buys nothing real and costs the one distinction that matters most in
 * financial headlines — who did what to whom.
 *
 * ## It is NOT unique and NOT a dedup key
 *
 * `us_news_articles.clusterKey` is a plain index. Collapsing on insert would
 * DELETE the sibling copies, and their existence — "this ran in twelve places"
 * — is precisely the signal a future ranker wants. This function writes a
 * grouping column; it does not decide what to do with the groups.
 *
 * An empty or whitespace-only title still yields a key (the hash of the empty
 * string) rather than throwing. It cannot arise from a stored row —
 * `normalizeArticle` refuses a title-less article, and `parseNewsResponse`
 * drops one before that — so this branch exists only so the function is total.
 */
export function clusterKeyFor(title: string): string {
  const normalized = title
    .toLowerCase()
    // Unicode-aware: `\p{L}` and `\p{N}` keep accented and non-Latin headlines
    // intact, where `[^a-z0-9 ]` would have deleted them entirely and hashed
    // every such title to the same empty key.
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()
    .split(/\s+/)
    .filter((w) => w !== "" && !TITLE_STOPWORDS.has(w))
    .join(" ");
  return `${CLUSTER_KEY_VERSION}:${fnv1a64Hex(normalized)}`;
}

/**
 * Turn one parsed Tiingo article into a storable row, validating its tickers.
 *
 * `knownTickers` is the set of UPPERCASE symbols our master carries. It comes
 * from `us_instruments` and it is the caller's job to have built it — this
 * function must not be handed an empty set on a lookup FAILURE, because from in
 * here "we carry none of these" and "we could not ask" are the same argument
 * and the second one must not silently blank a row's tickers. The processor
 * refuses to write at all in that case; see `runNewsPoll`.
 *
 * ## Every refusal returns null rather than a defaulted row
 *
 * `publishedAt` and `crawlDate` are NON-NULLABLE on `us_news_articles`, and the
 * tempting default — `now` — is the one value that must never be written.
 * `crawlDate` is the CURSOR column: a fabricated `now` on a malformed article
 * would push the watermark to the present, and every genuinely older article
 * still to arrive would then fall below it and be dropped forever. One bad row
 * would silently truncate the feed. The article is skipped and counted instead.
 *
 * A `tiingoId` of 0 is refused for the same class of reason: `parseNewsResponse`
 * maps a missing or non-finite id to 0, so 0 means "absent", and upserting on it
 * would make every id-less article overwrite one shared row — a table that looks
 * healthy while holding one row where it should hold hundreds.
 */
export function normalizeArticle(
  raw: TiingoNewsArticle,
  knownTickers: ReadonlySet<string>,
): NormalizedArticle {
  // Deduped FIRST, then partitioned. Tiingo repeats tickers inside one
  // article's own array — measured, 79 of 200 market-wide rows — so counting
  // drops off the raw array would report the same unknown symbol several times
  // and inflate the very number an operator uses to judge the master.
  const distinct = dedupeTickers(raw.tickers);
  const tickers: string[] = [];
  const dropped: string[] = [];
  for (const symbol of distinct) {
    if (knownTickers.has(symbol)) tickers.push(symbol);
    else dropped.push(symbol);
  }

  const skip = (skipReason: NormalizeSkipReason): NormalizedArticle => ({
    row: null,
    droppedTickers: dropped.length,
    dropped,
    skipReason,
  });

  if (!Number.isInteger(raw.id) || raw.id <= 0) return skip("no-id");

  const title = raw.title.trim();
  if (title === "") return skip("no-title");

  const url = raw.url.trim();
  if (url === "") return skip("no-url");

  const publishedAt = parseUtcInstant(raw.publishedDate);
  if (publishedAt === null) return skip("bad-published-date");

  const crawlDate = parseUtcInstant(raw.crawlDate);
  if (crawlDate === null) return skip("bad-crawl-date");

  const description = raw.description.trim();

  return {
    row: {
      tiingoId: raw.id,
      title,
      url,
      // "" is not a snippet, it is the absence of one rendered as a value —
      // and the column is nullable precisely so the two can be told apart.
      description: description === "" ? null : description,
      publishedAt,
      crawlDate,
      source: raw.source.trim(),
      tickers,
      tags: dedupeTags(raw.tags),
      clusterKey: clusterKeyFor(title),
    },
    droppedTickers: dropped.length,
    dropped,
  };
}

/**
 * An ISO instant as a Date, or null.
 *
 * Null rather than `new Date(NaN)`: an Invalid Date reaching Prisma is a write
 * error at best and a permanently unsortable row at worst. Both date columns
 * here are non-nullable, so null propagates into a SKIP rather than into a
 * defaulted row — see {@link normalizeArticle}.
 */
function parseUtcInstant(raw: string): Date | null {
  const t = Date.parse(raw);
  return Number.isFinite(t) ? new Date(t) : null;
}

/**
 * Distinct tags, lowercased, in first-seen order.
 *
 * Lowercased because the tag vocabulary is uncontrolled and the same topic
 * arrives capitalised differently between rows; deduped for the same reason
 * `tickers[]` is — nothing promises the upstream array is a set.
 */
function dedupeTags(tags: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of tags) {
    const t = raw.trim().toLowerCase();
    if (t === "" || seen.has(t)) continue;
    seen.add(t);
    out.push(t);
  }
  return out;
}

/** The window one poll should request. */
export interface NewsCursorPlan {
  /** Inclusive `YYYY-MM-DD`, safe to hand to `buildTiingoNewsUrl`. */
  startDate: string;
  /** Inclusive `YYYY-MM-DD`. */
  endDate: string;
  /**
   * The instant the window starts from, BEFORE day-truncation.
   *
   * Reported so the overlap is observable rather than inferred: this is
   * `lastCrawl - overlapMs`, and a test asserting it is strictly less than
   * `lastCrawl` is what pins the cursor as overlapping rather than
   * strict-boundary.
   */
  windowStart: Date;
  /** The overlap actually applied, after sanitisation. */
  overlapMs: number;
  /** No stored watermark — {@link FIRST_RUN_LOOKBACK_MS} was used. */
  firstRun: boolean;
  /**
   * The requested start was raised to Tiingo's 90-day floor.
   *
   * REPORTED rather than silent: it means the poller has been down long enough
   * to lose history that this endpoint will no longer serve, which is a
   * backfill's problem and not something a 2-minute job can heal.
   */
  clampedToFloor: boolean;
}

/** `YYYY-MM-DD` of an instant, in UTC. */
function toIsoDay(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/**
 * Decide the window for one poll.
 *
 * ## The overlap, restated where it is implemented
 *
 * `windowStart` is `lastCrawl - overlapMs`, NEVER `lastCrawl`. See
 * {@link DEFAULT_NEWS_OVERLAP_MS} for the measured reason; the short version is
 * that `crawlDate` is Tiingo's clock and articles arrive out of order, so a
 * strict boundary drops the late ones permanently and silently. Removing the
 * subtraction is the mutation the test suite is written to catch.
 *
 * ## Day granularity is the endpoint's, not a choice
 *
 * `/tiingo/news` takes `startDate` / `endDate` as `YYYY-MM-DD`. There is no
 * finer parameter, so the fetched window is always whole days and the effective
 * overlap is at least "since midnight UTC". That makes the 30 minutes look
 * redundant, and it is not: the boundary it protects is the one at the START of
 * a UTC day, where `lastCrawl` at 00:05 minus nothing would ask only for the
 * new day and miss anything crawled late against the old one.
 *
 * ## Every clamp raises the floor, none lowers it
 *
 *   - a `lastCrawl` in the FUTURE (clock skew, a bad row) is treated as `now`,
 *     so the window never inverts. `buildTiingoNewsUrl` throws on
 *     `endDate < startDate`, and a 2-minute poller that throws every run on a
 *     stored value is a job that cannot recover without a hand edit.
 *   - a non-finite, negative OR ZERO `overlapMs` falls back to the default
 *     rather than being clamped to 0. Zero IS the defect; silently accepting it
 *     as "the caller asked for no overlap" would let a NaN reintroduce the
 *     strict-boundary bug through arithmetic, and `0` reintroduces it
 *     directly.
 *   - a start before Tiingo's 90-day floor is raised to it and FLAGGED. A
 *     pre-floor request is not an error upstream: it answers HTTP 200 with rows
 *     from the floor date, which is why `buildTiingoNewsUrl` refuses to
 *     construct one at all.
 */
export function planNewsCursor(
  lastCrawl: Date | null,
  now: Date,
  overlapMs: number = DEFAULT_NEWS_OVERLAP_MS,
): NewsCursorPlan {
  const nowMs = now.getTime();
  if (!Number.isFinite(nowMs)) {
    throw new RangeError(
      "planNewsCursor received an Invalid Date for `now` — every window " +
        "boundary below would be NaN, and an Invalid floor comparison answers " +
        "`false`, which fails OPEN straight into Tiingo's clamped regime.",
    );
  }

  // `> 0`, NOT `>= 0`. ZERO IS THE DEFECT and it was ACCEPTED here for a
  // release while the doc comment above, `TiingoNewsPollMessage.overlapMs` in
  // `packages/types/src/pubsub.ts` and the sibling test titled "...never to 0"
  // all said it was refused — the test exercised `[NaN, -1, Infinity]` and
  // never the one value that produces a zero-width overlap. `overlapMs: 0`
  // makes `windowStart === lastCrawl`, which is the strict-boundary cursor this
  // whole module exists to prevent: at 00:05 UTC it asks only for the new day
  // and every article Tiingo crawled late against the old one is dropped, once,
  // permanently. Masked today only by the scheduler payload being `{}`, which
  // is one payload away from being untrue.
  const overlap =
    Number.isFinite(overlapMs) && overlapMs > 0
      ? overlapMs
      : DEFAULT_NEWS_OVERLAP_MS;

  const lastMs = lastCrawl === null ? null : lastCrawl.getTime();
  const usableLast =
    lastMs !== null && Number.isFinite(lastMs) ? Math.min(lastMs, nowMs) : null;
  const firstRun = usableLast === null;

  // THE OVERLAP. `- overlap`, not `usableLast`.
  const windowStartMs = firstRun
    ? nowMs - FIRST_RUN_LOOKBACK_MS
    : usableLast - overlap;
  const windowStart = new Date(windowStartMs);

  const endDate = toIsoDay(now);
  const rawStart = toIsoDay(windowStart);

  // The floor guard, reused rather than re-derived. `isBeforeFloor` FAILS SAFE
  // on anything it cannot judge, so a malformed day is raised to the floor
  // instead of being handed to the API.
  const clampedToFloor = isBeforeFloor(rawStart, now);
  const floored = clampedToFloor ? newsFloorDate(now) : rawStart;

  // A start after the end can still happen when the floor itself is later than
  // `now`'s day, which only occurs for a nonsensical clock. Collapsing to a
  // single day keeps the request constructible.
  const startDate = floored > endDate ? endDate : floored;

  return {
    startDate,
    endDate,
    windowStart,
    overlapMs: overlap,
    firstRun,
    clampedToFloor,
  };
}

/**
 * The newest `crawlDate` among rows that were actually WRITTEN.
 *
 * `null` for an empty list, which the caller must treat as "do not move the
 * watermark" rather than as a value. Advancing a cursor from the window we
 * ASKED for — instead of from what landed — is the "stamped-never-created"
 * shape MONEY-1235 spent a ticket unpicking by hand: the marker moves past
 * articles no write ever stored, and the overlap is far too small to reach back
 * for them.
 */
export function newestCrawlDate(
  rows: readonly UsNewsArticleRow[],
): Date | null {
  let newest: Date | null = null;
  for (const row of rows) {
    if (newest === null || row.crawlDate > newest) newest = row.crawlDate;
  }
  return newest;
}

/**
 * The OLDEST `crawlDate` among rows — the mirror of {@link newestCrawlDate}.
 *
 * Exists for {@link safeCursorAdvance}, whose bound is about the thing we still
 * OWE rather than the thing we managed to store. `null` for an empty list,
 * which there means "nothing is owed" and not "zero".
 */
export function oldestCrawlDate(
  rows: readonly UsNewsArticleRow[],
): Date | null {
  let oldest: Date | null = null;
  for (const row of rows) {
    if (oldest === null || row.crawlDate < oldest) oldest = row.crawlDate;
  }
  return oldest;
}

/** What one run may safely move the watermark to. */
export interface CursorAdvanceDecision {
  /** The watermark, or `null` to leave the stored cursor exactly where it is. */
  advanceTo: Date | null;
  /**
   * Why it is what it is. Reported, not merely logged: "the cursor did not
   * move" and "the cursor moved to the newest thing we wrote" are the two
   * readings an operator has to tell apart during an incident, and a bare date
   * (or a bare null) says neither.
   */
  reason:
    | "nothing-written"
    | "window-incomplete"
    | "bounded-by-owed"
    | "newest-written";
}

/**
 * THE WATERMARK INVARIANT — MONEY-1309.
 *
 * > No article may fall permanently outside every future window.
 *
 * That is the property this function exists to preserve, and it is the ONE
 * property the whole poller rests on: an article dropped here is not delayed,
 * it is gone, with no error, no exception and no gap that any row count can
 * see. Everything below is a consequence of it.
 *
 * ## What the code did before, and why it lost days
 *
 * `runNewsPoll` passed `newestCrawlDate(persisted)` unconditionally. Three
 * facts compose into permanent loss:
 *
 *   1. Tiingo's feed is NEWEST-FIRST ACROSS DAYS. Measured 2026-08-28 and
 *      written down in `detectClampedResponse`'s header: a wide window with
 *      `limit=1000` came back with 1,000 rows whose oldest was the PREVIOUS
 *      DAY. So a partial read of a multi-day window is the NEWEST slice of it.
 *   2. The rows are never sorted, and are written in fetch order, so the set
 *      that got persisted is a PREFIX — the newest days.
 *   3. The next window is DAY-GRANULAR. `/tiingo/news` takes `startDate` /
 *      `endDate` as `YYYY-MM-DD`; there is no finer parameter. So the next
 *      poll asks from `toIsoDay(cursor - overlap)`, and a 30-minute overlap
 *      reaches back at most one calendar day.
 *
 * Put together: a 3-day catch-up window that stops after the day-3 rows
 * advanced the cursor into day 3, and days 1 and 2 were never asked for again.
 * Any cold start (`FIRST_RUN_LOOKBACK_MS` is 2 days, which spans 3 calendar
 * days) or any outage of a day or more can trigger it. Simulated: the run
 * reported `ok: true`, `selected === written`, `failed: 0`.
 *
 * ## The granularity trap, measured rather than assumed
 *
 * `crawlDate` is NOT day-granular — it is an ISO instant with microseconds
 * (`2026-08-27T00:17:23.981203Z`), so the stored watermark CAN express "13:04
 * on day 3". The REQUEST cannot. That asymmetry is what makes a fractionally-
 * advanced cursor lossy rather than merely imprecise, and it is why the bound
 * below is stated against the next WINDOW rather than against the next cursor.
 *
 * Note also that `crawlDate` is not monotonic even WITHIN a page: the committed
 * market-wide fixture (32 rows, one day) is neither ascending nor descending.
 * So "the persisted prefix is the newest slice" is a DAY-level claim only,
 * which is exactly the level the window operates at.
 *
 * ## The rule
 *
 *   - `windowComplete === false` -> DO NOT ADVANCE, at all.
 *
 *     The run did not see the whole window, so it cannot know what it is
 *     leaving behind. The unfetched remainder is older by fact (1), but only at
 *     day granularity and only if offset paging preserves the sort across
 *     pages — which is inferred, not measured. Advancing on an inferred
 *     ordering risks permanent invisible loss to save a re-fetch the idempotent
 *     `tiingoId` upsert absorbs for free. When the two errors are not
 *     symmetric, take the survivable one — the same reasoning that makes
 *     `TIINGO_NEWS_HISTORY_DAYS` 90 rather than the measured 91.
 *
 *   - otherwise advance to `min(newest persisted, oldest UNpersisted)`.
 *
 *     Everything unpersisted has a `crawlDate` at or above the bound, so its
 *     calendar day is at or above `toIsoDay(bound)`; the next window runs
 *     `[toIsoDay(bound - overlap) .. today]` and `toIsoDay(bound - overlap) <=
 *     toIsoDay(bound)`, so every owed row is inside it. INCLUSIVE is safe and
 *     no epsilon is needed, precisely because the window's start day is
 *     inclusive — subtracting a millisecond would buy nothing and would look
 *     like it was doing something.
 *
 * The `min` covers the two ways a fetched row goes unpersisted, and the second
 * was silently broken too: the write loop stopping on its run budget (a tail),
 * AND an individual upsert throwing (a hole in the middle, which the old code
 * sailed straight past because a newer row wrote successfully after it).
 *
 * A non-advancing run is not a stalled feed: the newest articles are still
 * written every tick. It stalls only the WATERMARK, loudly — `truncated` /
 * `writeTruncated` are reported and `ok` is false — which is the trade this
 * function makes on purpose.
 */
export function safeCursorAdvance(args: {
  /** Rows this run actually wrote. */
  persisted: readonly UsNewsArticleRow[];
  /** Rows this run built but did NOT write — budget-skipped or write-refused. */
  unpersisted: readonly UsNewsArticleRow[];
  /**
   * Did the offset walk reach a natural end (a short page)?
   *
   * FALSE for every other way the walk stopped — the offset ceiling, the run
   * budget, a 404, a 401, a rate limit, or an ordinary page error after a full
   * page. All of them mean the same thing here: rows exist in this window that
   * this run never saw.
   */
  windowComplete: boolean;
}): CursorAdvanceDecision {
  const { persisted, unpersisted, windowComplete } = args;

  const newest = newestCrawlDate(persisted);
  if (newest === null) {
    // Nothing landed, so there is nothing to advance FROM. Checked before the
    // completeness gate only so the reason reported is the more specific one.
    return { advanceTo: null, reason: "nothing-written" };
  }

  if (!windowComplete) {
    return { advanceTo: null, reason: "window-incomplete" };
  }

  const owed = oldestCrawlDate(unpersisted);
  if (owed === null) {
    return { advanceTo: newest, reason: "newest-written" };
  }

  return owed < newest
    ? { advanceTo: owed, reason: "bounded-by-owed" }
    : { advanceTo: newest, reason: "newest-written" };
}
