/**
 * Pure, side-effect-free helpers for Tiingo US NEWS — MONEY-1264.
 *
 * Sibling of `tiingo-logic.ts` and written to the same rule: everything here
 * comes from RESPONSES MEASURED AGAINST THE LIVE API on 2026-08-28, never from
 * the documentation, and the places where the two disagree are called out where
 * they apply.
 *
 * `tiingo-news.ts` imports and calls these — there are no parallel copies.
 *
 * ## The one fact that shapes this whole module
 *
 * `GET https://api.tiingo.com/tiingo/news` serves THREE MONTHS of history, and
 * asking for more DOES NOT FAIL. It answers HTTP 200 with rows starting at the
 * floor:
 *
 *     asked 2026-05-30  ->  got 2026-05-30   OK
 *     asked 2026-05-29  ->  got 2026-05-29   OK  <- the floor
 *     asked 2026-05-27  ->  got 2026-05-29   CLAMPED
 *     asked 2024-08-28  ->  got 2026-05-29   CLAMPED  (2 years)
 *     asked 2021-01-01  ->  got 2026-05-29   CLAMPED  (5 years)
 *
 * A two-year backfill would therefore not error. It would write three months of
 * articles, count them, report success, and leave behind a job that appears to
 * work and then never moves. That is the Tickertape-403 shape this repo keeps
 * re-learning: a silent partial failure that reads as health, and which is only
 * discovered months later by someone counting rows.
 *
 * So the floor is enforced in TWO independent places, because one of them is a
 * claim about arithmetic and the other is a claim about the bytes that came
 * back:
 *
 *   1. {@link buildTiingoNewsUrl} REFUSES to construct a pre-floor URL. There is
 *      no other way to spell a news request — the client has no second URL
 *      builder — so a caller cannot reach the clamped regime at all.
 *   2. {@link detectClampedResponse} checks the articles AGAINST THE WINDOW THAT
 *      WAS ASKED FOR. If the floor arithmetic below ever drifts (Tiingo moves
 *      the window, a caller passes a hand-built date, our clock is wrong), the
 *      response guard still fires, because clamped data is off by MONTHS and
 *      lands nowhere near the requested day.
 *
 * Guard 1 alone would be a single point of failure for the exact defect class it
 * exists to prevent. Guard 2 alone would let us spend quota to discover it.
 */

/**
 * Days of news history the plan actually serves.
 *
 * Measured floor on 2026-08-28 was 2026-05-29, i.e. `today - 91d`. This is
 * deliberately 90 and NOT 91, so the computed floor sits ONE DAY LATER than the
 * real cliff.
 *
 * That direction is the whole point, and it is the same reasoning as
 * `resolveTiingoPlan` defaulting to the LOWER rate limits. Guessing the window
 * too NARROW costs one day of the oldest articles — recoverable, visible, and
 * nobody is misled. Guessing it too WIDE means a request lands in the clamped
 * regime and comes back 200 with the wrong data, which is the failure this
 * module exists to make impossible. When the two errors are not symmetric, take
 * the survivable one.
 *
 * Widening this to 91 would remove the margin entirely and put us exactly on a
 * cliff edge whose position we inferred from five probes. `newsFloorDate` has a
 * test pinning the refusal of 2026-05-29 — a date Tiingo WOULD have served — so
 * that the margin is a decision on the record rather than an off-by-one waiting
 * to be "fixed".
 */
export const TIINGO_NEWS_HISTORY_DAYS = 90;

/**
 * Deep pagination stops here. Measured: `offset=10000` returns ZERO rows, on a
 * ticker (AAPL) that has 8,062 articles in the window and on market-wide
 * queries with far more.
 *
 * It matters because zero rows is ALSO how "no more news" looks. A pager that
 * loops until it sees an empty page therefore terminates correctly at the
 * ceiling by accident — and a pager that loops until it sees a SHORT page never
 * terminates at all, because page 10,000 is not short, it is empty, and the next
 * one is too. Both readings are wrong about what happened: the data did not run
 * out, the endpoint stopped serving it.
 *
 * So the ceiling is a REFUSAL, not a loop condition — see
 * {@link buildTiingoNewsUrl}. A caller that needs more than 10,000 articles for
 * one query has to narrow the query (by day, by ticker), which is precisely what
 * the seed's day-walk does.
 */
export const TIINGO_NEWS_MAX_OFFSET = 10_000;

/**
 * The largest `limit` we will ask for. Measured: 5,000 is honoured. Larger
 * values are UNTESTED, so this is the ceiling we are willing to claim rather
 * than the ceiling the API has.
 */
export const TIINGO_NEWS_MAX_LIMIT = 5_000;

/** The endpoint. JSON only — see {@link buildTiingoNewsUrl}. */
export const TIINGO_NEWS_URL = "https://api.tiingo.com/tiingo/news";

/**
 * One article exactly as Tiingo prints it.
 *
 * NINE fields, measured — there is no tenth, and none of these are optional in
 * a well-formed row:
 *   id, publishedDate, crawlDate, title, description, url, source, tags[],
 *   tickers[]
 */
export interface TiingoNewsArticle {
  /** Tiingo's own article id. A NUMBER in the live payload, not a string. */
  id: number;
  /** ISO-8601 UTC, e.g. `2026-08-27T00:00:00Z`. */
  publishedDate: string;
  /** ISO-8601 UTC with microseconds, e.g. `2026-08-27T00:17:23.981203Z`. */
  crawlDate: string;
  title: string;
  description: string;
  url: string;
  /** The PUBLISHER's domain, e.g. `prnewswire.com` — not a Tiingo feed name. */
  source: string;
  tags: string[];
  /**
   * LOWERCASE tickers, and it CONTAINS DUPLICATES — measured, 79 of 200 rows in
   * one market-wide sample, e.g. `["aaic","ai","ai","tech"]`. Never iterate this
   * directly to build rows or counts; go through {@link dedupeTickers}.
   */
  tickers: string[];
}

/** Raised when a caller asks for news older than Tiingo will serve. */
export class TiingoNewsFloorError extends Error {
  constructor(
    readonly requestedStartDate: string,
    readonly floorDate: string,
  ) {
    super(
      `Tiingo news history starts at ${floorDate} (today - ${TIINGO_NEWS_HISTORY_DAYS}d); ` +
        `refusing to request startDate=${requestedStartDate}. Tiingo does NOT ` +
        `error on a pre-floor request — it answers HTTP 200 with rows from the ` +
        `floor date, so a caller that got past this guard would receive three ` +
        `months of articles while believing it had received the range it asked ` +
        `for. Narrow the request to ${floorDate} or later.`,
    );
    this.name = "TiingoNewsFloorError";
  }
}

/** Raised when a response does not describe the window that was requested. */
export class TiingoNewsClampedError extends Error {
  constructor(reason: string) {
    super(
      `Tiingo news response does not match the requested window — ${reason}. ` +
        `This is what a CLAMPED request looks like: HTTP 200, well-formed ` +
        `articles, wrong dates. Nothing is written from it.`,
    );
    this.name = "TiingoNewsClampedError";
  }
}

/** Raised when the payload is not the JSON array the endpoint documents. */
export class TiingoNewsParseError extends Error {
  constructor(reason: string) {
    super(`Tiingo news payload is not a JSON array of articles — ${reason}`);
    this.name = "TiingoNewsParseError";
  }
}

/** `YYYY-MM-DD` of a Date, in UTC. */
function toIsoDay(d: Date): string {
  return d.toISOString().slice(0, 10);
}

const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;

/**
 * The oldest date this endpoint will serve, as `YYYY-MM-DD`.
 *
 * Computed in UTC rather than IST. The window slides on Tiingo's clock, not
 * ours, and UTC is never AHEAD of US Eastern — so a UTC-derived "today" can only
 * make the floor equal or LATER than one derived from an earlier zone, which is
 * the conservative direction (see {@link TIINGO_NEWS_HISTORY_DAYS}). Deriving it
 * from IST would put "today" up to a day ahead of Tiingo's, moving the floor
 * later still, which is also safe but throws away another day for no reason.
 *
 * `now` is a parameter and not `new Date()` so the arithmetic is testable
 * against the five MEASURED probes rather than against whatever day the suite
 * happens to run on. A test that asserts "the floor is 90 days ago" by computing
 * 90 days ago is a tautology; a test that asserts `2026-08-28 -> 2026-05-30`
 * against a recorded measurement is not.
 */
export function newsFloorDate(now: Date): string {
  const t = now.getTime();
  if (!Number.isFinite(t)) {
    // An Invalid Date must not silently produce an Invalid floor that every
    // comparison then answers `false` for — that fails OPEN, straight into the
    // clamped regime. Callers get a loud error instead.
    throw new TiingoNewsParseError(
      "cannot compute the news floor from an Invalid Date",
    );
  }
  return toIsoDay(new Date(t - TIINGO_NEWS_HISTORY_DAYS * 86_400_000));
}

/**
 * Would this `startDate` land in the clamped regime?
 *
 * FAILS SAFE on anything it cannot judge: a malformed date returns `true`
 * (refuse). The alternative — returning `false` for garbage because "it is not
 * provably before the floor" — is the fail-open default this repo has a standing
 * rule against, and here it would hand the unparseable string straight to the
 * API, whose own tolerance for it is unknown and untested.
 *
 * That does mean this predicate conflates "too old" with "not a date". The
 * builder therefore checks the FORMAT separately and reports it separately, so
 * the operator-facing message names the real cause; this function is the
 * backstop for any caller that uses it alone.
 */
export function isBeforeFloor(startDate: string, now: Date): boolean {
  if (!ISO_DAY.test(startDate)) return true;
  const t = Date.parse(`${startDate}T00:00:00Z`);
  if (!Number.isFinite(t)) return true;
  return startDate < newsFloorDate(now);
}

/** Parameters for one news request. */
export interface TiingoNewsQuery {
  /** Tickers to filter on. Omit for the market-wide firehose. */
  tickers?: readonly string[];
  /** Inclusive `YYYY-MM-DD`. Must be on or after the floor. */
  startDate: string;
  /** Inclusive `YYYY-MM-DD`. */
  endDate: string;
  limit?: number;
  offset?: number;
}

/**
 * Build the news URL, or THROW.
 *
 * This is the only place in the repo that spells a `/tiingo/news` URL, which is
 * what makes the floor guard structural rather than advisory: there is no second
 * path a caller could take to construct a pre-floor request, and no flag that
 * disables the check. Deleting the `isBeforeFloor` branch below is the mutation
 * the test suite is written to catch.
 *
 * ## `format=csv` is NOT available here
 *
 * Measured: `format=csv` on this endpoint returns 404, unlike `/tiingo/daily`
 * and the corporate-actions endpoints where CSV works and is the cheaper wire
 * format. So this feed is JSON, and the bandwidth argument that drove
 * `EOD_COLUMNS` in `tiingo-client.ts` has no lever to pull here. Worth stating
 * rather than leaving as an apparent oversight: someone WILL notice the sibling
 * client asks for CSV and try to make this one match.
 */
export function buildTiingoNewsUrl(query: TiingoNewsQuery, now: Date): string {
  const { tickers, startDate, endDate, limit, offset } = query;

  for (const [label, value] of [
    ["startDate", startDate],
    ["endDate", endDate],
  ] as const) {
    if (!ISO_DAY.test(value)) {
      throw new TiingoNewsParseError(
        `${label} must be YYYY-MM-DD, got ${JSON.stringify(value)}`,
      );
    }
  }

  if (endDate < startDate) {
    throw new TiingoNewsParseError(
      `endDate ${endDate} precedes startDate ${startDate}`,
    );
  }

  // THE guard. See the module header.
  if (isBeforeFloor(startDate, now)) {
    throw new TiingoNewsFloorError(startDate, newsFloorDate(now));
  }

  if (offset !== undefined) {
    if (!Number.isInteger(offset) || offset < 0) {
      throw new TiingoNewsParseError(
        `offset must be a non-negative integer, got ${String(offset)}`,
      );
    }
    // REFUSED, not clamped and not looped. At or past the ceiling every page is
    // empty, and an empty page is indistinguishable from "no more news" — so a
    // pager that treats it as data-exhaustion silently under-collects, and one
    // that treats it as a short page loops forever. Neither is recoverable from
    // inside the loop, so the loop is never entered.
    if (offset >= TIINGO_NEWS_MAX_OFFSET) {
      throw new TiingoNewsParseError(
        `offset ${offset} is at or past Tiingo's measured ceiling of ` +
          `${TIINGO_NEWS_MAX_OFFSET}, where every page returns ZERO rows — ` +
          `which is indistinguishable from "no more articles". Narrow the ` +
          `query (a single day, or a single ticker) instead of paging deeper.`,
      );
    }
  }

  if (limit !== undefined) {
    if (
      !Number.isInteger(limit) ||
      limit < 1 ||
      limit > TIINGO_NEWS_MAX_LIMIT
    ) {
      throw new TiingoNewsParseError(
        `limit must be an integer in 1..${TIINGO_NEWS_MAX_LIMIT}, got ${String(limit)}`,
      );
    }
  }

  const params = new URLSearchParams({ startDate, endDate });
  if (tickers && tickers.length > 0) {
    // Tiingo's own spelling: comma-separated, and it is STRICT — measured,
    // `BRK-A` matches 50/50 articles, `BRKA` matches 50/50, `BRK.A` matches
    // ZERO, and a garbage symbol matches ZERO. It filters; it does not fall
    // through to the unfiltered firehose on a symbol it does not know. That
    // distinction is why an empty result here is trustworthy as "no news for
    // this ticker" rather than "the filter was ignored".
    params.set("tickers", tickers.join(","));
  }
  if (limit !== undefined) params.set("limit", String(limit));
  if (offset !== undefined) params.set("offset", String(offset));

  return `${TIINGO_NEWS_URL}?${params.toString()}`;
}

function asString(v: unknown): string {
  return typeof v === "string" ? v : "";
}

function asStringArray(v: unknown): string[] {
  return Array.isArray(v)
    ? v.filter((x): x is string => typeof x === "string")
    : [];
}

/**
 * Parse a `/tiingo/news` response body.
 *
 * TOLERANT PER ROW, STRICT ABOUT THE CONTAINER — the same split as
 * `parseTiingoMasterCsv`, for the same reason and with one addition that matters
 * here.
 *
 * Per row: a malformed article is dropped rather than thrown, so one bad row in
 * a day's firehose does not cost the day. A row is malformed when it has no
 * `url` or no `title`: `url` is half of `UsStockNews`'s `@@unique([symbol, link])`
 * and `title` is the only non-nullable text on the row, so neither can be
 * defaulted into something meaningful.
 *
 * The container: a non-array payload THROWS instead of returning `[]`. `[]` is a
 * legitimate answer from this endpoint — it is what a quiet day, or a ticker
 * Tiingo does not know, actually returns — so a parser that also returns `[]`
 * for an error envelope makes a real failure indistinguishable from a real
 * absence. That collapse is how a job comes to report success while writing
 * nothing, which is the same defect the floor guard above exists to prevent,
 * arriving through the parser instead of the URL.
 */
export function parseNewsResponse(text: string): TiingoNewsArticle[] {
  let payload: unknown;
  try {
    payload = JSON.parse(text) as unknown;
  } catch (err) {
    throw new TiingoNewsParseError(
      `body is not valid JSON (${err instanceof Error ? err.message : String(err)})`,
    );
  }

  if (!Array.isArray(payload)) {
    throw new TiingoNewsParseError(
      `top level is ${payload === null ? "null" : typeof payload}, not an array. ` +
        `An empty day is \`[]\`; an object here is an error envelope, and ` +
        `returning zero rows for it would make a failure look like a quiet day`,
    );
  }

  const out: TiingoNewsArticle[] = [];
  for (const raw of payload) {
    if (typeof raw !== "object" || raw === null) continue;
    const r = raw as Record<string, unknown>;

    const url = asString(r.url).trim();
    const title = asString(r.title).trim();
    if (url === "" || title === "") continue;

    out.push({
      id: typeof r.id === "number" && Number.isFinite(r.id) ? r.id : 0,
      publishedDate: asString(r.publishedDate),
      crawlDate: asString(r.crawlDate),
      title,
      description: asString(r.description),
      url,
      source: asString(r.source),
      tags: asStringArray(r.tags),
      tickers: asStringArray(r.tickers),
    });
  }
  return out;
}

/**
 * Distinct tickers from one article, UPPERCASED, in first-seen order.
 *
 * Tiingo repeats them: measured, 79 of 200 market-wide rows carry a duplicate,
 * e.g. `["aaic","ai","ai","tech"]`. Every one of those is a row that
 * `@@unique([symbol, link])` would reject on insert and that any per-symbol
 * count would double. Neither failure announces itself as "the upstream repeats
 * itself" — one looks like a write bug, the other like a busier ticker.
 *
 * Uppercased here rather than at the call site because the two sides of the join
 * DISAGREE about case and always will: news `tickers` are lowercase (`aapl`)
 * while `UsInstrument.symbol` carries the master's spelling (`AAPL`, via
 * `toRawUsInstrument`). Normalising in one place is what makes the membership
 * test in {@link toStockNewsRows} mean what it reads as. Order is preserved so
 * the output is deterministic for tests and logs.
 */
export function dedupeTickers(tickers: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of tickers) {
    const t = raw.trim().toUpperCase();
    if (t === "" || seen.has(t)) continue;
    seen.add(t);
    out.push(t);
  }
  return out;
}

/** One `us_stock_news` row, ready for Prisma. */
export interface StockNewsRow {
  symbol: string;
  title: string;
  link: string;
  pubDate: Date | null;
  source: string;
  snippet: string | null;
  /**
   * Tiingo's durable security id, where the ticker resolved to exactly one.
   *
   * `null` is a perfectly good row and the common case: `permaTicker` is filled
   * by a separate paced enrichment leg, so a security it has not reached yet
   * has none to join. Null rather than the symbol — an identifier that is
   * secretly a ticker is worse than an absent one, because a reader cannot tell
   * which it got.
   */
  permaTicker: string | null;
}

/**
 * Fan ONE article out to one row per DISTINCT ticker we actually carry.
 *
 * ## The field mapping, and the one thing it loses
 *
 *   Tiingo `url`           -> `link`     (half of `@@unique([symbol, link])`)
 *   Tiingo `description`   -> `snippet`
 *   Tiingo `publishedDate` -> `pubDate`
 *   Tiingo `source`        -> `source`
 *   our master (optional)  -> `permaTicker`
 *
 * `source` therefore holds the PUBLISHER's domain (`prnewswire.com`), while the
 * India rows in `stock_news` hold a FEED name (`GOOGLE_NEWS`). The column is
 * doing two jobs and neither table has a separate provider field to fix that
 * in. Kept as specified rather than smuggling in a `TIINGO:` prefix, because
 * the publisher is the more useful of the two facts and the provenance question
 * is now answered by the TABLE: these rows go to `us_stock_news`, India's go to
 * `stock_news`, and nothing writes both.
 *
 * ## `market: "US"` is GONE, and the column going with it is the point
 *
 * This used to emit `market: "US"` into the shared `stock_news`, defended on
 * the grounds that US readers would select on it. They would; India's four
 * existing readers filter on `symbol` ALONE and predate the column entirely,
 * so with 214 measured India/US ticker collisions ACC Cement's news card would
 * have carried Atlas Air's headlines and `market` could not have stopped it.
 * `@@unique([symbol, link])` does not carry the discriminator either, so the
 * two feeds could collide on one key. The tables separated; the column had
 * nothing left to do.
 *
 * ## Why unknown tickers are DROPPED
 *
 * Tiingo tags articles with tickers well outside the universe we sync (`tech`,
 * `ai`, OTC symbols, crypto). A row whose `symbol` matches no `UsInstrument`
 * joins to nothing and is only ever visible as an inflated row count.
 *
 * Note that ZERO rows is a completely normal outcome — measured, 15 of 32
 * articles in one market-wide day carried an EMPTY `tickers` array (macro and
 * general-business stories). A caller must not read "0 rows" as a failure.
 */
export function toStockNewsRows(
  article: TiingoNewsArticle,
  knownSymbols: ReadonlySet<string>,
  permaTickers?: ReadonlyMap<string, string | null>,
): StockNewsRow[] {
  const pubDate = parseArticleDate(article.publishedDate);
  const snippet = article.description.trim();

  return dedupeTickers(article.tickers)
    .filter((symbol) => knownSymbols.has(symbol))
    .map((symbol) => ({
      symbol,
      title: article.title,
      link: article.url,
      pubDate,
      source: article.source,
      // Empty string -> null: the column is nullable and "" is not a snippet,
      // it is the absence of one rendered as a value.
      snippet: snippet === "" ? null : snippet,
      // OPTIONAL third argument, so the two existing call sites keep their
      // shape and simply get null. `?? null` and not `?? undefined`: an absent
      // key and a key mapped to null are the same answer here — "we could not
      // resolve one" — and collapsing them at the boundary means no consumer
      // has to know which of the two it got.
      permaTicker: permaTickers?.get(symbol) ?? null,
    }));
}

/**
 * `publishedDate` as a Date, or null when it cannot be one.
 *
 * Null rather than `new Date(NaN)`: an Invalid Date reaching Prisma is a write
 * error at best and a permanently unsortable row at worst, and the column is
 * nullable precisely so an undated article can still be stored.
 */
export function parseArticleDate(raw: string): Date | null {
  const t = Date.parse(raw);
  return Number.isFinite(t) ? new Date(t) : null;
}

/** Verdict from {@link detectClampedResponse}. */
export interface ClampCheck {
  clamped: boolean;
  reason?: string;
}

/**
 * Did this response describe the window we ASKED for?
 *
 * The second, independent half of the floor guard — and the only one that can
 * still fire if the arithmetic in {@link newsFloorDate} is wrong, if Tiingo
 * moves its window, or if a caller reaches the API with a hand-built URL. It is
 * the same shape as `isRecycledResponse` in `tiingo-logic.ts`: compare a fact
 * already in hand (the window we requested) against a fact in the response (the
 * dates that came back), and refuse the write when they cannot both be true.
 *
 * Clamping is not subtle — the measured cases are off by MONTHS to YEARS — so a
 * ±1 day tolerance separates it from the two benign reasons a date can sit
 * outside the window:
 *   - `publishedDate` is UTC while a "day" is a human calendar notion, so an
 *     article stamped 23:xx can land in either day depending on the zone;
 *   - Tiingo's own range filter is inclusive at both ends and its boundary
 *     handling is not documented.
 *
 * An article with an unparseable `publishedDate` cannot be judged and is skipped.
 * But a response where NOTHING is judgeable is itself reported as clamped: a
 * guard that quietly abstains is a guard that reads as green, which is the exact
 * property that makes this whole failure class survive so long.
 *
 * ## What this guard CANNOT see, stated so nobody leans on it further
 *
 * It is decisive only for a NARROW window — which is the shape the seed uses,
 * one calendar day at a time, and the shape it is calibrated for. Clamped data
 * lands at the floor, months away from a single requested day, so it is always
 * outside and always caught.
 *
 * It is BLIND to clamping when the requested window already SPANS the floor
 * (`startDate=2021-01-01&endDate=today`): the returned floor-date rows sit
 * legitimately inside that window, so there is nothing to disagree with. That
 * case is covered instead — and completely — by {@link buildTiingoNewsUrl},
 * which refuses to construct such a request at all. The two guards are not
 * redundant copies of one check; they cover different halves, and neither is
 * sufficient alone.
 *
 * A related measured trap in the same family, recorded here because it is the
 * next thing a wide-window caller would hit: the endpoint returns articles
 * NEWEST-FIRST, so `limit` truncates the OLDEST rows. Measured 2026-08-28,
 * `startDate=2021-01-01&limit=1000` came back with 1,000 rows whose oldest was
 * from the PREVIOUS DAY — the requested history was not merely clamped, it was
 * then truncated from the far end, and both losses were invisible. A day-walk is
 * immune (one day, well under the limit); anything wider is not.
 */
export function detectClampedResponse(args: {
  startDate: string;
  endDate: string;
  articles: readonly TiingoNewsArticle[];
  toleranceDays?: number;
}): ClampCheck {
  const { startDate, endDate, articles, toleranceDays = 1 } = args;
  if (articles.length === 0) return { clamped: false };

  const tolMs = toleranceDays * 86_400_000;
  const lo = Date.parse(`${startDate}T00:00:00Z`) - tolMs;
  const hi = Date.parse(`${endDate}T23:59:59Z`) + tolMs;
  if (!Number.isFinite(lo) || !Number.isFinite(hi)) {
    return {
      clamped: true,
      reason: `requested window ${startDate}..${endDate} is not parseable`,
    };
  }

  let judged = 0;
  let outside = 0;
  let earliest: string | null = null;

  for (const a of articles) {
    const t = Date.parse(a.publishedDate);
    if (!Number.isFinite(t)) continue;
    judged++;
    if (t < lo || t > hi) {
      outside++;
      if (earliest === null || a.publishedDate < earliest) {
        earliest = a.publishedDate;
      }
    }
  }

  if (judged === 0) {
    return {
      clamped: true,
      reason:
        `none of the ${articles.length} article(s) carry a parseable ` +
        `publishedDate, so the requested window ${startDate}..${endDate} ` +
        `cannot be verified at all`,
    };
  }

  if (outside > 0) {
    return {
      clamped: true,
      reason:
        `${outside} of ${judged} dated article(s) fall outside ` +
        `${startDate}..${endDate} (±${toleranceDays}d); earliest offender ` +
        `${earliest}`,
    };
  }

  return { clamped: false };
}
