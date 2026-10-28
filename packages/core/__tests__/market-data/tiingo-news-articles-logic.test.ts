/**
 * MONEY-1309 — the ARTICLE-level news store's pure logic.
 *
 * Sibling of `tiingo-news-logic.test.ts`, which covers the ENDPOINT (the 90-day
 * floor, the clamp check, the offset ceiling, `tickers[]` repeating itself).
 * Nothing here re-tests any of that: this file is about the three decisions the
 * poller adds on top — which tickers may be stored, what a headline's
 * fingerprint is, and which WINDOW each 2-minute poll asks for.
 *
 * ## The mutations these are sized for
 *
 * Each of the three has one obvious "simplification" that a reader would make
 * and that no type would stop, so each has a case whose only job is to go red
 * when it is made:
 *
 *   1. drop the `knownTickers` membership test in `normalizeArticle` and store
 *      whatever Tiingo sent
 *   2. make `planNewsCursor` a strict `> lastCrawl` boundary instead of
 *      subtracting the overlap
 *   3. hash the raw title instead of the normalised one
 *
 * All three were RUN against this file before it was committed.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import {
  CLUSTER_KEY_VERSION,
  DEFAULT_NEWS_OVERLAP_MS,
  FIRST_RUN_LOOKBACK_MS,
  clusterKeyFor,
  newestCrawlDate,
  normalizeArticle,
  oldestCrawlDate,
  planNewsCursor,
  safeCursorAdvance,
  type UsNewsArticleRow,
} from "../../src/market-data/tiingo/tiingo-news-articles-logic";
import {
  TIINGO_NEWS_HISTORY_DAYS,
  type TiingoNewsArticle,
} from "../../src/market-data/tiingo/tiingo-news-logic";

const SRC = fileURLToPath(
  new URL(
    "../../src/market-data/tiingo/tiingo-news-articles-logic.ts",
    import.meta.url,
  ),
);
const SOURCE = readFileSync(SRC, "utf8");

/**
 * One article in the shape `parseNewsResponse` produces.
 *
 * The defaults are a REAL row's shape: a numeric `id`, ISO-8601 UTC dates (the
 * crawl one carrying microseconds, as the live payload does), a publisher
 * domain in `source`, and LOWERCASE tickers — the case mismatch against
 * `UsInstrument.symbol` is the whole reason `dedupeTickers` uppercases.
 */
function article(over: Partial<TiingoNewsArticle> = {}): TiingoNewsArticle {
  return {
    id: 42_000_001,
    publishedDate: "2026-08-31T13:00:00Z",
    crawlDate: "2026-08-31T13:04:11.981203Z",
    title: "Apple to acquire Foobar Inc for $2 billion",
    description: "The deal is expected to close in Q4.",
    url: "https://www.prnewswire.com/news-releases/apple-foobar.html",
    source: "prnewswire.com",
    tags: ["Earnings", "tech", "earnings"],
    tickers: ["aapl", "aapl", "foobar", "tech"],
    ...over,
  };
}

const KNOWN = new Set(["AAPL", "MSFT", "NVDA"]);

/* -------------------------------------------------------------------------- */

describe("[premise] the fixtures can actually distinguish pass from fail", () => {
  test("the source under test was read, and it is the real module", () => {
    // A guard that silently reads nothing passes by checking nothing — the
    // shape `no-feed-fetch-bypass.test.ts` records as the worst kind of green.
    assert.ok(SOURCE.length > 5_000, `read ${SOURCE.length} chars`);
    assert.match(SOURCE, /export function normalizeArticle/);
    assert.match(SOURCE, /export function planNewsCursor/);
    assert.match(SOURCE, /export function clusterKeyFor/);
  });

  test("the fixture article names BOTH a carried and an uncarried ticker", () => {
    // Without this the drop-count cases are vacuous in either direction: an
    // article with no unknown tickers can never exercise a drop, and one with
    // no known tickers can never prove a survivor was kept.
    const distinct = new Set(article().tickers.map((t) => t.toUpperCase()));
    const carried = [...distinct].filter((t) => KNOWN.has(t));
    const uncarried = [...distinct].filter((t) => !KNOWN.has(t));
    assert.deepEqual(carried, ["AAPL"]);
    assert.deepEqual(uncarried.sort(), ["FOOBAR", "TECH"]);
    // And the raw array REPEATS, so a count taken off it rather than off the
    // deduped set would over-report — the measured 79-of-200 hazard.
    assert.equal(article().tickers.length, 4);
    assert.equal(distinct.size, 3);
  });

  test("the known set is non-empty, so `has` is a real test", () => {
    assert.ok(KNOWN.size > 0);
  });
});

describe("normalizeArticle — an unknown ticker is DROPPED and COUNTED", () => {
  test("stores only the carried tickers, and counts the rest", () => {
    const { row, droppedTickers, dropped } = normalizeArticle(article(), KNOWN);
    assert.ok(row, "the row must survive — an unknown ticker is not fatal");
    assert.deepEqual(row.tickers, ["AAPL"]);
    // COUNTED, not merely discarded. `0` here under the mutation "delete the
    // membership test" is the point of this assertion: the count is what tells
    // an operator "Tiingo named symbols we do not carry" apart from "our master
    // lookup broke", which produce the identical empty array.
    assert.equal(droppedTickers, 2);
    assert.deepEqual(dropped.sort(), ["FOOBAR", "TECH"]);
  });

  test("the dropped symbols are NOT in the stored ticker array", () => {
    // The membership test could be deleted and the COUNT kept (a plausible
    // half-fix), so the array itself is inspected rather than trusted.
    //
    // Scoped to `tickers` deliberately, and the first draft of this case was
    // not: it scanned the whole serialized row for `FOOBAR` and went red on
    // the fixture's own TITLE ("Apple to acquire Foobar Inc") and URL. Both are
    // correct to store — dropping a ticker is a claim about what we can JOIN
    // on, never about what the headline is allowed to say. A row-wide scan
    // would have to be satisfied by censoring the article text, which is the
    // opposite of the intent.
    const { row } = normalizeArticle(article(), KNOWN);
    for (const dropped of ["FOOBAR", "TECH"]) {
      assert.equal(
        row!.tickers.includes(dropped),
        false,
        `${dropped} is not a security we carry and must not be a join key`,
      );
    }
    assert.deepEqual(row!.tickers, ["AAPL"]);
    // `tech` DOES survive as a TAG, and that is not a leak: tags are an
    // uncontrolled vocabulary joined to nothing, while `tickers` is a foreign
    // key in all but name.
    assert.ok(row!.tags.includes("tech"));
  });

  test("counts DISTINCT unknowns, not repeats — tickers[] repeats itself", () => {
    const { droppedTickers, dropped } = normalizeArticle(
      article({ tickers: ["zzz", "zzz", "zzz", "aapl"] }),
      KNOWN,
    );
    assert.equal(droppedTickers, 1, "one unknown symbol, seen three times");
    assert.deepEqual(dropped, ["ZZZ"]);
  });

  test("an article carrying NO carried ticker is still a row", () => {
    // 15 of 32 articles in one measured market-wide day carried an EMPTY
    // tickers array — macro and general-business stories. Storing them is the
    // POINT of an article-level table: the symbol-keyed one could not represent
    // them at all, because a row there needs a symbol to exist.
    const { row, droppedTickers } = normalizeArticle(
      article({ tickers: [] }),
      KNOWN,
    );
    assert.ok(row);
    assert.deepEqual(row.tickers, []);
    assert.equal(droppedTickers, 0);
  });

  test("matches on the UPPERCASED symbol — the two sides disagree on case", () => {
    // News `tickers` are lowercase; `UsInstrument.symbol` carries the master's
    // spelling. A membership test against the raw string matches nothing and
    // drops every ticker in the feed, silently.
    const { row } = normalizeArticle(article({ tickers: ["aapl"] }), KNOWN);
    assert.deepEqual(row!.tickers, ["AAPL"]);
  });
});

describe("normalizeArticle — what it REFUSES rather than defaults", () => {
  test("a missing id (parsed as 0) produces no row", () => {
    // `parseNewsResponse` maps an absent/non-finite id to 0, so 0 means
    // "absent". Upserting on it would make every id-less article overwrite one
    // shared row: a table that looks healthy holding one row for hundreds.
    const { row, skipReason } = normalizeArticle(article({ id: 0 }), KNOWN);
    assert.equal(row, null);
    assert.equal(skipReason, "no-id");
  });

  test("an unparseable date produces no row, and is NOT defaulted to now", () => {
    // THE reason this is a refusal. `crawlDate` is the CURSOR column: a
    // fabricated `now` would push the watermark to the present, and every
    // genuinely older article still to arrive would then fall below it and be
    // dropped forever. One malformed row would silently truncate the feed.
    for (const [field, reason] of [
      ["publishedDate", "bad-published-date"],
      ["crawlDate", "bad-crawl-date"],
    ] as const) {
      const { row, skipReason } = normalizeArticle(
        article({ [field]: "not a date" }),
        KNOWN,
      );
      assert.equal(row, null, field);
      assert.equal(skipReason, reason);
    }
  });

  test("a refusal still reports the dropped-ticker count", () => {
    // Otherwise a run of malformed articles would look like a run that named
    // only symbols we carry.
    const { row, droppedTickers } = normalizeArticle(
      article({ id: 0, tickers: ["nope"] }),
      KNOWN,
    );
    assert.equal(row, null);
    assert.equal(droppedTickers, 1);
  });
});

describe("NO full article text is stored — title, url and snippet only", () => {
  test("the row carries no body/content/text field of any name", () => {
    const { row } = normalizeArticle(article(), KNOWN);
    const keys = Object.keys(row as UsNewsArticleRow);
    assert.deepEqual(keys.sort(), [
      "clusterKey",
      "crawlDate",
      "description",
      "publishedAt",
      "source",
      "tags",
      "tickers",
      "tiingoId",
      "title",
      "url",
    ]);
    for (const banned of [
      "body",
      "content",
      "fullText",
      "articleText",
      "html",
    ]) {
      assert.equal(
        keys.includes(banned),
        false,
        `${banned} must never be a column on this row`,
      );
    }
  });

  test("`description` is Tiingo's snippet VERBATIM, never something fetched", () => {
    // The strongest available statement: the stored value equals the input
    // exactly, so nothing expanded, followed or enriched it.
    const snippet = "The deal is expected to close in Q4.";
    const { row } = normalizeArticle(article({ description: snippet }), KNOWN);
    assert.equal(row!.description, snippet);
    assert.ok(row!.description!.length < 500, "a snippet, not an article body");
  });

  test("an empty snippet is null, not an empty string", () => {
    // "" is not a snippet, it is the absence of one rendered as a value, and
    // the column is nullable precisely so the two can be told apart.
    const { row } = normalizeArticle(article({ description: "   " }), KNOWN);
    assert.equal(row!.description, null);
  });

  test("the module fetches NOTHING — it is pure by construction", () => {
    // A source scan, because the property is an ABSENCE and no behavioural
    // test can cover a call nobody wrote. `url` is stored and never followed.
    assert.doesNotMatch(SOURCE, /\bfetch\s*\(/);
    assert.doesNotMatch(SOURCE, /getFeedAsset|axios|node:https?\b/);
  });
});

describe("clusterKeyFor — stable for one title, different for another", () => {
  test("the same title always yields the same key", () => {
    const t = "Apple to acquire Foobar Inc for $2 billion";
    assert.equal(clusterKeyFor(t), clusterKeyFor(t));
    // Stability across CALLS is weak; stability across a round trip through the
    // value that would actually be stored is the property that matters.
    const stored = clusterKeyFor(t);
    assert.equal(stored, clusterKeyFor(`${t}`));
  });

  test("a different headline yields a different key", () => {
    const a = clusterKeyFor("Apple to acquire Foobar Inc for $2 billion");
    const b = clusterKeyFor("Microsoft to acquire Foobar Inc for $2 billion");
    assert.notEqual(a, b);
  });

  test("wire copy survives case, punctuation and stopword variation", () => {
    // The population this exists for: one press release, several outlets, the
    // same words with different typography. `clusterKeyFor` hashes the
    // NORMALISED title, so these collapse — under the mutation "hash the raw
    // title" every one of them becomes its own cluster.
    const base = clusterKeyFor("Apple to acquire Foobar Inc for $2 billion");
    for (const variant of [
      "APPLE TO ACQUIRE FOOBAR INC FOR $2 BILLION",
      "Apple to acquire Foobar Inc. for $2 billion!",
      "Apple  acquire  Foobar  Inc  $2  billion",
      "Apple to acquire Foobar Inc — for $2 billion",
    ]) {
      assert.equal(clusterKeyFor(variant), base, variant);
    }
  });

  test("word ORDER is preserved — who did what to whom is not a stopword", () => {
    // Sorting the tokens would cluster harder and would make these one story.
    assert.notEqual(
      clusterKeyFor("Apple beats Google"),
      clusterKeyFor("Google beats Apple"),
    );
  });

  test("the key carries its VERSION, so a normaliser change is visible", () => {
    const key = clusterKeyFor("anything at all");
    assert.ok(key.startsWith(`${CLUSTER_KEY_VERSION}:`), key);
    // 16 hex characters — a 64-bit FNV-1a. Pinned because a Number-based hash
    // would lose the top bits above 2^53 and silently shrink the key space,
    // which no behavioural test would notice.
    assert.match(key, /^v\d+:[0-9a-f]{16}$/);
  });

  test("it is total: an empty or symbol-only title still yields a key", () => {
    // Cannot arise from a stored row (`normalizeArticle` refuses a title-less
    // article), so this only pins that the function does not throw.
    assert.match(clusterKeyFor(""), /^v\d+:[0-9a-f]{16}$/);
    assert.match(clusterKeyFor("!!! ???"), /^v\d+:[0-9a-f]{16}$/);
  });

  test("non-Latin headlines are not all hashed to the same empty key", () => {
    // `[^a-z0-9 ]` would have deleted these entirely. `\p{L}` does not.
    assert.notEqual(
      clusterKeyFor("ソニーが決算を発表"),
      clusterKeyFor("トヨタが決算を発表"),
    );
    assert.notEqual(clusterKeyFor("ソニーが決算を発表"), clusterKeyFor(""));
  });
});

describe("planNewsCursor — the window OVERLAPS, it is not a strict boundary", () => {
  const now = new Date("2026-08-31T14:00:00Z");

  test("windowStart is lastCrawl MINUS the overlap, never lastCrawl", () => {
    // THE case. Under the mutation "use `lastCrawl` as the boundary" this goes
    // red, and every other case in this describe stays green — which is why it
    // asserts the arithmetic rather than the resulting date string.
    const lastCrawl = new Date("2026-08-31T13:50:00Z");
    const plan = planNewsCursor(lastCrawl, now);
    assert.ok(
      plan.windowStart < lastCrawl,
      `windowStart ${plan.windowStart.toISOString()} must precede the ` +
        `watermark ${lastCrawl.toISOString()} — a strict boundary drops every ` +
        "article Tiingo crawls late, permanently and silently",
    );
    assert.equal(
      plan.windowStart.getTime(),
      lastCrawl.getTime() - DEFAULT_NEWS_OVERLAP_MS,
    );
    assert.equal(plan.overlapMs, DEFAULT_NEWS_OVERLAP_MS);
  });

  test("the overlap can reach back into the PREVIOUS calendar day", () => {
    // The boundary the 30 minutes actually protects. At 00:05 UTC a strict
    // cursor asks only for the new day and misses anything crawled late against
    // the old one — and the endpoint's granularity is DAYS, so this is the one
    // place the sub-day overlap changes the request that is made.
    const midnightish = new Date("2026-08-31T00:05:00Z");
    const plan = planNewsCursor(midnightish, new Date("2026-08-31T00:06:00Z"));
    assert.equal(plan.startDate, "2026-08-30", "the previous day is re-asked");
    assert.equal(plan.endDate, "2026-08-31");
  });

  test("a custom overlap is honoured", () => {
    const lastCrawl = new Date("2026-08-31T13:50:00Z");
    const plan = planNewsCursor(lastCrawl, now, 60_000);
    assert.equal(plan.overlapMs, 60_000);
    assert.equal(plan.windowStart.getTime(), lastCrawl.getTime() - 60_000);
  });

  test("a NaN, negative or ZERO overlap falls back to the default", () => {
    // Zero IS the defect. Accepting it as "the caller asked for no overlap"
    // would let a NaN reintroduce the strict-boundary bug through arithmetic.
    //
    // D2 — `0` WAS ACCEPTED for a release, and this test is why nobody saw it:
    // it was titled "...never to 0" and exercised `[NaN, -1, Infinity]`, so the
    // one value that produces a zero-width overlap was the one value untested.
    // The guard read `overlapMs >= 0` while the type module, the function's own
    // doc comment and this title all said it was refused.
    const lastCrawl = new Date("2026-08-31T13:50:00Z");
    for (const bad of [Number.NaN, -1, Number.POSITIVE_INFINITY, 0, -0]) {
      const plan = planNewsCursor(lastCrawl, now, bad);
      assert.equal(plan.overlapMs, DEFAULT_NEWS_OVERLAP_MS, String(bad));
      assert.ok(plan.windowStart < lastCrawl, String(bad));
    }
  });

  test("`overlapMs: 0` cannot collapse the window at a UTC-midnight boundary", () => {
    // The consequence, at the boundary where it bites. `windowStart ===
    // lastCrawl` means the previous calendar day is never re-asked, and the
    // endpoint has no finer parameter than a day — so every article Tiingo
    // crawled late against that day is dropped, once, permanently. The route
    // forwards a 0 happily (`Number.isFinite(0)` is true) and so does the
    // processor (`typeof 0 === "number"`), so this guard is the only one.
    const justAfterMidnight = new Date("2026-08-31T00:05:00Z");
    const plan = planNewsCursor(
      justAfterMidnight,
      new Date("2026-08-31T00:06:00Z"),
      0,
    );
    assert.equal(
      plan.startDate,
      "2026-08-30",
      "with 0 honoured this would be 2026-08-31 and the 30th would be lost",
    );
  });

  test("a first run looks back FIRST_RUN_LOOKBACK_MS, not 90 days", () => {
    const plan = planNewsCursor(null, now);
    assert.equal(plan.firstRun, true);
    assert.equal(
      plan.windowStart.getTime(),
      now.getTime() - FIRST_RUN_LOOKBACK_MS,
    );
    assert.equal(plan.startDate, "2026-08-29");
    assert.equal(plan.clampedToFloor, false);
  });

  test("a long outage is clamped to Tiingo's floor and SAYS SO", () => {
    // A pre-floor request is not an error upstream: it answers HTTP 200 with
    // rows from the floor date. Reported rather than silently raised, because
    // it means history this endpoint will no longer serve has been lost — a
    // backfill's problem, not something a 2-minute job can heal.
    const ancient = new Date("2024-01-01T00:00:00Z");
    const plan = planNewsCursor(ancient, now);
    assert.equal(plan.clampedToFloor, true);
    const floor = new Date(
      now.getTime() - TIINGO_NEWS_HISTORY_DAYS * 86_400_000,
    )
      .toISOString()
      .slice(0, 10);
    assert.equal(plan.startDate, floor);
    assert.ok(plan.startDate <= plan.endDate);
  });

  test("a FUTURE watermark cannot invert the window", () => {
    // Clock skew or a bad stored row. `buildTiingoNewsUrl` throws on
    // `endDate < startDate`, and a 2-minute poller that throws every run on a
    // stored value cannot recover without a hand edit.
    const future = new Date("2027-01-01T00:00:00Z");
    const plan = planNewsCursor(future, now);
    assert.ok(
      plan.startDate <= plan.endDate,
      `${plan.startDate}..${plan.endDate}`,
    );
    assert.equal(plan.endDate, "2026-08-31");
  });

  test("an Invalid `now` throws rather than producing a NaN window", () => {
    // An Invalid floor comparison answers `false`, which fails OPEN straight
    // into the clamped regime — the failure the whole floor guard exists for.
    assert.throws(
      () => planNewsCursor(null, new Date("nonsense")),
      /Invalid Date/,
    );
  });
});

describe("newestCrawlDate — the watermark comes from what LANDED", () => {
  function row(crawl: string): UsNewsArticleRow {
    return {
      tiingoId: 1,
      title: "t",
      url: "u",
      description: null,
      publishedAt: new Date("2026-08-31T00:00:00Z"),
      crawlDate: new Date(crawl),
      source: "s",
      tickers: [],
      tags: [],
      clusterKey: "v1:0000000000000000",
    };
  }

  test("returns the maximum, whatever order the rows arrive in", () => {
    const newest = newestCrawlDate([
      row("2026-08-31T10:00:00Z"),
      row("2026-08-31T12:00:00Z"),
      row("2026-08-31T11:00:00Z"),
    ]);
    assert.equal(newest?.toISOString(), "2026-08-31T12:00:00.000Z");
  });

  test("an EMPTY set returns null — 'do not move the watermark'", () => {
    // Not `now`, and not the window we asked for. Advancing from the REQUEST
    // sails the marker past articles no write ever stored, and the 30-minute
    // overlap is far too small to reach back for them.
    assert.equal(newestCrawlDate([]), null);
  });
});

/* -------------------------------------------------------------------------- */
/* safeCursorAdvance — THE WATERMARK INVARIANT                                 */
/*                                                                             */
/*   NO ARTICLE MAY FALL PERMANENTLY OUTSIDE EVERY FUTURE WINDOW.              */
/*                                                                             */
/* The processor drove this end to end for a release with                      */
/* `newestCrawlDate(persisted)`, unconditionally, which is safe ONLY if a      */
/* partial run's written set is not the newest slice of a multi-day window.    */
/* It is exactly that: the feed is newest-first ACROSS DAYS (measured), `rows` */
/* is never sorted, and the next window is day-granular.                       */
/* -------------------------------------------------------------------------- */

describe("safeCursorAdvance", () => {
  function row(id: number, crawl: string): UsNewsArticleRow {
    return {
      tiingoId: id,
      title: `t${id}`,
      url: `https://x/${id}`,
      description: null,
      publishedAt: new Date(crawl),
      crawlDate: new Date(crawl),
      source: "prnewswire.com",
      tickers: [],
      tags: [],
      clusterKey: "v1:0",
    };
  }

  const day3 = row(3, "2026-08-31T13:00:00Z");
  const day2 = row(2, "2026-08-30T13:00:00Z");
  const day1 = row(1, "2026-08-29T13:00:00Z");

  test("a fully-drained window advances to the newest written row", () => {
    // The falsifiable other half: without it, "never advance" passes everything
    // below and the poller silently stops making progress forever.
    const d = safeCursorAdvance({
      persisted: [day1, day3, day2],
      unpersisted: [],
      windowComplete: true,
    });
    assert.equal(d.reason, "newest-written");
    assert.equal(d.advanceTo?.toISOString(), "2026-08-31T13:00:00.000Z");
  });

  test("it never advances PAST the oldest row it failed to store", () => {
    // THE DEFECT, in one line. `newestCrawlDate(persisted)` answers day 3 here;
    // the next window would then start on day 3 and day 1 would never be asked
    // for again.
    const d = safeCursorAdvance({
      persisted: [day3, day2],
      unpersisted: [day1],
      windowComplete: true,
    });
    assert.equal(d.reason, "bounded-by-owed");
    assert.equal(
      d.advanceTo?.toISOString(),
      "2026-08-29T13:00:00.000Z",
      "the OLDEST owed row, not the newest written one",
    );
  });

  test("an owed row NEWER than everything written does not hold the cursor back", () => {
    // The bound is a MIN, not "always the owed row". A row owed from the future
    // end of the window is inside the next window anyway (which ends at today),
    // so pinning the cursor to it would stall progress for nothing.
    const d = safeCursorAdvance({
      persisted: [day1],
      unpersisted: [day3],
      windowComplete: true,
    });
    assert.equal(d.reason, "newest-written");
    assert.equal(d.advanceTo?.toISOString(), "2026-08-29T13:00:00.000Z");
  });

  test("an INCOMPLETE window does not advance at all, whatever landed", () => {
    // We do not know the crawlDates of what we never fetched. "The remainder is
    // older" follows from newest-first paging, which is inferred rather than
    // measured — and an inference is not something to spend permanent invisible
    // loss on when the alternative costs one idempotent re-fetch.
    const d = safeCursorAdvance({
      persisted: [day3, day2, day1],
      unpersisted: [],
      windowComplete: false,
    });
    assert.equal(d.reason, "window-incomplete");
    assert.equal(d.advanceTo, null);
  });

  test("nothing written means nothing to advance from", () => {
    const d = safeCursorAdvance({
      persisted: [],
      unpersisted: [day1],
      windowComplete: true,
    });
    assert.equal(d.reason, "nothing-written");
    assert.equal(d.advanceTo, null);
  });

  test("THE INVARIANT: every owed row survives into the next window", () => {
    // The property itself, checked through the real planner rather than
    // restated — a cursor VALUE assertion can pass against a fix that stamps a
    // plausible date the day-granular window still excludes.
    const owed = [day1, day2];
    const d = safeCursorAdvance({
      persisted: [day3],
      unpersisted: owed,
      windowComplete: true,
    });
    assert.ok(d.advanceTo !== null);
    const next = planNewsCursor(d.advanceTo, new Date("2026-08-31T14:02:00Z"));
    for (const r of owed) {
      const day = r.crawlDate.toISOString().slice(0, 10);
      assert.ok(
        next.startDate <= day && day <= next.endDate,
        `${day} must lie inside ${next.startDate}..${next.endDate}`,
      );
    }
  });

  test("and the UNFIXED rule breaks that invariant — the ceiling", () => {
    // Proves the assertion above is capable of failing. This is exactly what
    // the processor did before: advance to the newest row that landed.
    const naive = newestCrawlDate([day3]);
    const next = planNewsCursor(naive, new Date("2026-08-31T14:02:00Z"));
    assert.ok(
      next.startDate > "2026-08-29",
      `the naive watermark yields ${next.startDate}, which orphans 2026-08-29`,
    );
  });
});

describe("oldestCrawlDate", () => {
  function row(id: number, crawl: string): UsNewsArticleRow {
    return {
      tiingoId: id,
      title: `t${id}`,
      url: `https://x/${id}`,
      description: null,
      publishedAt: new Date(crawl),
      crawlDate: new Date(crawl),
      source: "s",
      tickers: [],
      tags: [],
      clusterKey: "v1:0",
    };
  }

  test("returns the minimum, whatever the input order", () => {
    const rows = [
      row(1, "2026-08-31T13:00:00Z"),
      row(2, "2026-08-29T13:00:00Z"),
      row(3, "2026-08-30T13:00:00Z"),
    ];
    assert.equal(
      oldestCrawlDate(rows)?.toISOString(),
      "2026-08-29T13:00:00.000Z",
    );
    // Not merely the first or the last element — both would pass a sorted list.
    assert.equal(
      oldestCrawlDate([...rows].reverse())?.toISOString(),
      "2026-08-29T13:00:00.000Z",
    );
  });

  test("null for an empty list — 'nothing owed', never a zero", () => {
    assert.equal(oldestCrawlDate([]), null);
  });

  test("it is not newestCrawlDate under another name", () => {
    const rows = [
      row(1, "2026-08-31T13:00:00Z"),
      row(2, "2026-08-29T13:00:00Z"),
    ];
    assert.notEqual(
      oldestCrawlDate(rows)?.getTime(),
      newestCrawlDate(rows)?.getTime(),
    );
  });
});

describe("[D3] the per-symbol news card has a COMPOUND index", () => {
  const SCHEMA = readFileSync(
    fileURLToPath(
      new URL("../../../database/prisma/schema.prisma", import.meta.url),
    ),
    "utf8",
  );

  function usNewsArticleBlock(): string {
    const start = SCHEMA.indexOf("model UsNewsArticle {");
    assert.ok(start > 0, "model UsNewsArticle not found in schema.prisma");
    const end = SCHEMA.indexOf('@@map("us_news_articles")', start);
    assert.ok(end > start, "the model's @@map was not found");
    return SCHEMA.slice(start, end);
  }

  test("the schema file was really read", () => {
    assert.ok(SCHEMA.length > 100_000, `read ${SCHEMA.length} chars`);
    assert.ok(usNewsArticleBlock().includes("tiingoId"));
  });

  test("`tickers` leads a compound index with `publishedAt`", () => {
    // The card is `where {tickers:{has:SYM}} orderBy {publishedAt:desc}`. Two
    // SINGLE-FIELD indexes serve the MATCH and then blocking-sort every article
    // that ever named the symbol, in memory, under a 32 MB cap with no
    // `allowDiskUse` on a find. The predecessor `UsStockNews` carries
    // `@@index([symbol, pubDate])` for exactly this; dropping to two singles on
    // the replacement was a regression nothing would surface until one symbol
    // accumulated enough history.
    assert.match(usNewsArticleBlock(), /@@index\(\[tickers,\s*publishedAt\]\)/);
  });

  test("the bare `tickers` single is gone, not sitting beside it", () => {
    // A compound whose prefix is `tickers` already serves every `has:` query
    // the single did, so keeping both is a second index to write on every
    // insert for no read it can serve.
    assert.doesNotMatch(usNewsArticleBlock(), /@@index\(\[tickers\]\)/);
  });
});
