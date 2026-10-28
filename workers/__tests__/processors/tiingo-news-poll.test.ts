/**
 * MONEY-1309 — the 24x7 news poller, driven end to end through its own seam.
 *
 * `runNewsPoll` takes a `deps` object whose DEFAULTS are the production
 * collaborators, so what runs here is the loop the scheduler runs — not a
 * re-declared copy of it. Nothing opens a socket or a database handle and there
 * is nothing to orphan.
 *
 * ## What this file exists to catch, and what it deliberately does not
 *
 * The window arithmetic, the ticker validation rule and the cluster key are
 * PURE and are covered against their own module in
 * `packages/core/__tests__/market-data/tiingo-news-articles-logic.test.ts`.
 * Duplicating them here would be two copies of one claim.
 *
 * What only this level can see is the WIRING, and every case below is a
 * property that a plausible edit to the processor breaks while the pure tests
 * stay green:
 *
 *   - the upsert is keyed on `tiingoId`, so an overlapping poll re-delivering
 *     the same article writes ONCE
 *   - `written` is incremented AFTER the upsert resolves, so a database that
 *     refuses every row reports 0 and not a full run (MONEY-1255)
 *   - an unknown ticker never reaches the `create` payload, and IS counted
 *   - the request window is built from `lastCrawl - overlap`, so the fetch this
 *     job actually issues overlaps rather than starting at the watermark
 *   - the cursor advances from what LANDED, never from what was asked for
 *   - the stored payload has no article-body column of any name
 *
 * ## Mutations run against this file
 *
 *   1. `where: { tiingoId }` -> `where: { url }`            -> idempotence red
 *   2. `state.written++` moved ABOVE the `await upsert`     -> counter red
 *   3. `normalizeArticle(article, known)` -> `(article, new Set(mentioned))`
 *      (i.e. validate against what Tiingo said, not against our master)
 *                                                            -> drop-count red
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import {
  JOB_NAME,
  NEWS_CURSOR_KEY,
  POLL_INTERVAL_MS,
  RUN_TIME_BUDGET_MS,
  runNewsPoll,
  type NewsPollDeps,
} from "../../src/processors/tiingo-news-poll";
import { DEFAULT_NEWS_OVERLAP_MS } from "@usemoney/core/market-data/tiingo/tiingo-news-articles-logic";
import type { TiingoNewsArticle } from "@usemoney/core/market-data/tiingo/tiingo-news-logic";

const PROC = readFileSync(
  fileURLToPath(
    new URL("../../src/processors/tiingo-news-poll.ts", import.meta.url),
  ),
  "utf8",
);

/* -------------------------------------------------------------------------- */
/* Fixtures                                                                    */
/* -------------------------------------------------------------------------- */

function article(over: Partial<TiingoNewsArticle> = {}): TiingoNewsArticle {
  return {
    id: 900_001,
    publishedDate: "2026-08-31T13:00:00Z",
    crawlDate: "2026-08-31T13:04:11.981203Z",
    title: "Apple to acquire Foobar Inc for $2 billion",
    description: "The deal is expected to close in Q4.",
    url: "https://www.prnewswire.com/news-releases/apple-foobar.html",
    source: "prnewswire.com",
    tags: ["earnings"],
    tickers: ["aapl", "foobar"],
    ...over,
  };
}

interface UpsertCall {
  where: { tiingoId: number };
  create: Record<string, unknown>;
  update: Record<string, unknown>;
}

/** Seed an EXISTING row so an update can be shown not to shrink it (D4). */
function seedRow(
  db: ReturnType<typeof makeDb>,
  tiingoId: number,
  row: Record<string, unknown>,
): void {
  db.rows.set(tiingoId, { tiingoId, ...row });
}

/**
 * A Prisma stand-in holding exactly the three models the poller touches.
 *
 * `usNewsArticle.upsert` REALLY upserts into a Map keyed on `tiingoId`, rather
 * than merely recording the call. That distinction is what makes the
 * idempotence case a test of behaviour: a recorder would count two calls and
 * two rows alike, so mutation 1 (`where: { url }`) would look identical.
 */
function makeDb(
  opts: {
    symbols?: string[];
    lookupThrows?: boolean;
    upsertThrows?: boolean;
    /** Throw for SOME lookup chunks only — the partial-failure case (D4). */
    lookupThrowsForSlice?: (slice: string[]) => boolean;
    /** Refuse SOME rows only — a hole in the middle, not a total outage. */
    upsertFailsFor?: (tiingoId: number) => boolean;
    /** Called with the running upsert COUNT, so a test can move a fake clock. */
    onUpsert?: (count: number) => void;
  } = {},
) {
  const known = opts.symbols ?? ["AAPL", "MSFT"];
  const rows = new Map<number, Record<string, unknown>>();
  const upserts: UpsertCall[] = [];
  let cursorRow: {
    key: string;
    lastCrawlDate: Date | null;
    lastRunAt: Date | null;
    meta: unknown;
  } | null = null;
  const cursorWrites: Array<{
    lastCrawlDate: Date | null;
    lastRunAt: Date | null;
  }> = [];

  return {
    rows,
    upserts,
    cursorWrites,
    get cursor() {
      return cursorRow;
    },
    seedCursor(lastCrawlDate: Date | null) {
      cursorRow = {
        key: NEWS_CURSOR_KEY,
        lastCrawlDate,
        lastRunAt: null,
        meta: null,
      };
    },
    db: {
      usNewsCursor: {
        findUnique: async () => cursorRow,
        upsert: async ({
          create,
          update,
        }: {
          create: {
            key: string;
            lastCrawlDate: Date | null;
            lastRunAt: Date | null;
            meta: unknown;
          };
          update: {
            lastCrawlDate: Date | null;
            lastRunAt: Date | null;
            meta: unknown;
          };
        }) => {
          const data = cursorRow === null ? create : update;
          cursorWrites.push({
            lastCrawlDate: data.lastCrawlDate,
            lastRunAt: data.lastRunAt,
          });
          cursorRow = {
            key: NEWS_CURSOR_KEY,
            lastCrawlDate: data.lastCrawlDate,
            lastRunAt: data.lastRunAt,
            meta: data.meta,
          };
          return cursorRow;
        },
      },
      usInstrument: {
        findMany: async ({
          where,
        }: {
          where: { symbol: { in: string[] } };
        }) => {
          if (opts.lookupThrows) throw new Error("mongo is down");
          if (opts.lookupThrowsForSlice?.(where.symbol.in)) {
            throw new Error("mongo refused this chunk");
          }
          // `listingId` rides along — MONEY-1507 reads it to build a NEWS
          // event, and a fake that returned only `symbol` would leave every
          // event skipped for a falsy listing while the poller looked healthy.
          return where.symbol.in
            .filter((s) => known.includes(s))
            .map((symbol) => ({
              symbol,
              listingId: `${symbol}:NASDAQ:2000-01-01`,
            }));
        },
      },
      usNewsArticle: {
        upsert: async (call: UpsertCall) => {
          upserts.push(call);
          opts.onUpsert?.(upserts.length);
          if (opts.upsertThrows) throw new Error("write refused");
          if (opts.upsertFailsFor?.(call.where.tiingoId)) {
            throw new Error(`write refused for ${call.where.tiingoId}`);
          }
          // A REAL upsert: one key, one row, whatever the call count.
          rows.set(call.where.tiingoId, {
            ...(rows.get(call.where.tiingoId) ?? call.create),
            ...call.update,
          });
          return rows.get(call.where.tiingoId);
        },
      },
    },
  };
}

interface FetchCall {
  startDate: string;
  endDate: string;
  limit?: number;
  offset?: number;
}

function makeFetch(pages: TiingoNewsArticle[][]) {
  const calls: FetchCall[] = [];
  let i = 0;
  const fn = async (q: FetchCall) => {
    calls.push({ ...q });
    const articles = pages[i] ?? [];
    i++;
    return {
      articles,
      bytes: 1024,
      url: `https://api.tiingo.com/tiingo/news?${q.startDate}`,
    };
  };
  return { calls, fn };
}

async function run(opts: {
  articles?: TiingoNewsArticle[][];
  db?: ReturnType<typeof makeDb>;
  now?: Date;
  overlapMs?: number;
  limit?: number;
  /**
   * The RUN-BUDGET clock, in ms. Separate from `now` on purpose: `now` is
   * pinned so the requested window is deterministic, while the budget needs a
   * clock that MOVES or the two truncation branches — the ones that lost days —
   * are unreachable without patching a global.
   */
  elapsedMs?: () => number;
  /** MONEY-1507 — replaces the `InstrumentEvent` writer. */
  publishEvents?: NewsPollDeps["publishEvents"];
}) {
  const db = opts.db ?? makeDb();
  const fetch = makeFetch(opts.articles ?? [[article()]]);
  const deps: NewsPollDeps = {
    prisma: db.db as never,
    fetchNews: fetch.fn as never,
    now: () => opts.now ?? new Date("2026-08-31T14:00:00Z"),
    ...(opts.elapsedMs ? { elapsedMs: opts.elapsedMs } : {}),
    // DEFAULT IS A NO-OP, not the real writer: every existing case in this file
    // would otherwise reach Mongo through `publishEvents`. The cases that test
    // the emission pass their own.
    publishEvents:
      opts.publishEvents ?? (async () => ({ upserted: 0, failed: 0 })),
  };
  const msg: Record<string, number> = {};
  if (opts.overlapMs !== undefined) msg.overlapMs = opts.overlapMs;
  if (opts.limit !== undefined) msg.limit = opts.limit;
  const result = await runNewsPoll(msg, deps);
  return { result, db, fetchCalls: fetch.calls };
}

/* -------------------------------------------------------------------------- */

describe("[premise] the harness can tell a pass from a failure", () => {
  it("a plain run actually writes, so every 'wrote nothing' case is meaningful", async () => {
    const { result, db } = await run({});
    assert.equal(result.written, 1, "the happy path must write");
    assert.equal(db.rows.size, 1);
    assert.equal(result.articles, 1);
  });

  it("the fake upsert really persists, so a double-write would be visible", async () => {
    // Without this, the idempotence case below could pass against a stub that
    // stores nothing at all — the vacuous green this repo keeps re-learning.
    const db = makeDb();
    await db.db.usNewsArticle.upsert({
      where: { tiingoId: 7 },
      create: { tiingoId: 7, title: "a" },
      update: { title: "a" },
    });
    await db.db.usNewsArticle.upsert({
      where: { tiingoId: 8 },
      create: { tiingoId: 8, title: "b" },
      update: { title: "b" },
    });
    assert.equal(db.rows.size, 2, "two DIFFERENT keys are two rows");
  });

  it("the processor source was read", () => {
    assert.ok(PROC.length > 5_000, `read ${PROC.length} chars`);
  });
});

describe("an unknown ticker is DROPPED and COUNTED, never stored", () => {
  it("stores only the carried symbol and reports the drop", async () => {
    const { result, db } = await run({
      articles: [[article({ tickers: ["aapl", "foobar", "notaticker"] })]],
    });
    assert.equal(result.written, 1, "the article itself is not lost");
    assert.equal(result.droppedTickers, 2);
    assert.equal(result.matchedSymbols, 1, "AAPL, and only AAPL");

    const stored = db.rows.get(900_001)!;
    assert.deepEqual(stored.tickers, ["AAPL"]);
  });

  it("the create payload never carries an uncarried symbol", async () => {
    const { db } = await run({
      articles: [[article({ tickers: ["aapl", "foobar"] })]],
    });
    const call = db.upserts[0]!;
    assert.deepEqual(call.create.tickers, ["AAPL"]);
    assert.deepEqual(call.update.tickers, ["AAPL"]);
  });

  it("an article whose tickers are ALL unknown is still stored, with none", async () => {
    // The article-level table's whole reason for existing: a macro story with
    // no carried ticker is real market news, and the symbol-keyed table could
    // not hold it because a row there needs a symbol.
    const { result, db } = await run({
      articles: [[article({ tickers: ["xyzzy"] })]],
    });
    assert.equal(result.written, 1);
    assert.equal(result.droppedTickers, 1);
    assert.deepEqual(db.rows.get(900_001)!.tickers, []);
  });

  it("REFUSES to write when EVERY master lookup chunk threw", async () => {
    // `0` and `null` are different answers. Writing here would store each
    // article with an empty `tickers` array, and the `tiingoId` upsert would
    // then treat those rows as settled on the next poll — a permanent,
    // invisible loss of every join key for the window.
    const db = makeDb({ lookupThrows: true });
    const { result } = await run({ db, articles: [[article()]] });
    assert.equal(result.written, 0);
    assert.equal(result.matchedSymbols, null, "null, never a fabricated 0");
    assert.equal(result.ok, false);
    assert.match(result.reason ?? "", /UNDETERMINED/);
    assert.equal(db.rows.size, 0, "nothing may be stored on a blind lookup");
    assert.equal(
      db.cursorWrites.at(-1)?.lastCrawlDate,
      null,
      "and the cursor must NOT advance, so the next poll re-asks",
    );
  });
});

describe("idempotent on tiingoId — the overlap window re-delivers on purpose", () => {
  it("the same article twice writes ONE row", async () => {
    // The overlap means this is the ORDINARY case, not an edge: at a 2-minute
    // cadence with a 30-minute overlap, an article is re-delivered ~15 times.
    const db = makeDb();
    const a = article();
    const first = await run({ db, articles: [[a]] });
    const second = await run({ db, articles: [[a]] });

    assert.equal(first.result.written, 1);
    assert.equal(
      second.result.written,
      1,
      "the upsert runs again, and that is fine",
    );
    assert.equal(db.rows.size, 1, "ONE row for one article, across two polls");
    assert.equal(db.upserts.length, 2);
    for (const call of db.upserts) {
      assert.deepEqual(
        Object.keys(call.where),
        ["tiingoId"],
        "the key must be the article id — a url is a string we do not control " +
          "the normalisation of, and two Tiingo articles have been seen at one",
      );
      assert.equal(call.where.tiingoId, 900_001);
    }
  });

  it("one article repeated INSIDE a single run is upserted once", async () => {
    // A page boundary can repeat a row. Two upserts to one key inside one run
    // would count two writes for one row.
    const { result, db } = await run({
      articles: [[article(), article(), article()]],
    });
    assert.equal(db.upserts.length, 1, "deduped in memory before the write");
    assert.equal(result.written, 1);
    assert.equal(result.articles, 3, "but all three were RECEIVED, and say so");
  });

  it("two DIFFERENT articles are two rows", async () => {
    // The other direction. Without it, a mutation that deduped everything to a
    // single row would pass the case above.
    const { result, db } = await run({
      articles: [[article({ id: 1 }), article({ id: 2, url: "https://x/2" })]],
    });
    assert.equal(result.written, 2);
    assert.equal(db.rows.size, 2);
  });
});

describe("counters are incremented AFTER the call — MONEY-1255", () => {
  it("a database that refuses every row reports 0 written", async () => {
    // Incremented before the upsert, this reports a full run from a database
    // that stored nothing — the reading that hid Tickertape's block for five
    // months, rebuilt one layer up.
    const db = makeDb({ upsertThrows: true });
    const { result } = await run({
      db,
      articles: [[article(), article({ id: 2 })]],
    });
    assert.equal(result.written, 0);
    assert.equal(result.failed, 2);
    assert.equal(db.rows.size, 0);
  });

  it("a refused write does NOT advance the cursor", async () => {
    // The watermark comes from what LANDED. Advancing from the window we asked
    // for sails past articles no write ever stored, and the overlap is far too
    // small to reach back for them — MONEY-1235's stamped-never-created shape.
    const db = makeDb({ upsertThrows: true });
    await run({ db, articles: [[article()]] });
    assert.equal(db.cursorWrites.at(-1)?.lastCrawlDate, null);
  });

  it("the source increments `written` below the awaited upsert", () => {
    // A structural backstop for the mutation, because the behavioural case
    // above would also pass against `state.written++` placed inside the `try`
    // but before the `await` on a run where nothing throws.
    const upsertAt = PROC.indexOf("await db.usNewsArticle.upsert(");
    const writtenAt = PROC.indexOf("state.written++", upsertAt);
    assert.ok(upsertAt > 0, "the upsert was not found");
    assert.ok(
      writtenAt > upsertAt,
      "`written` must be counted after the await",
    );
  });

  it("a successful run DOES advance the cursor, to the newest crawlDate", async () => {
    // The falsifiable other half: without it, "never advances" would pass.
    const db = makeDb();
    await run({
      db,
      articles: [
        [
          article({ id: 1, crawlDate: "2026-08-31T13:00:00Z" }),
          article({
            id: 2,
            url: "https://x/2",
            crawlDate: "2026-08-31T13:30:00Z",
          }),
        ],
      ],
    });
    assert.equal(
      db.cursor?.lastCrawlDate?.toISOString(),
      "2026-08-31T13:30:00.000Z",
    );
  });

  it("`lastRunAt` is stamped even when nothing was written", async () => {
    // Liveness. A quiet market and a dead poller both leave the watermark
    // still, and only this column tells them apart.
    const db = makeDb();
    const { result } = await run({ db, articles: [[]] });
    assert.equal(result.written, 0);
    assert.ok(db.cursor?.lastRunAt instanceof Date);
    assert.equal(db.cursor?.lastCrawlDate, null);
  });
});

describe("the cursor OVERLAPS — the fetch is not a strict boundary", () => {
  it("the requested window starts BEFORE the stored watermark", async () => {
    // Driven through the processor rather than through `planNewsCursor`,
    // because what has to be pinned is the window the job ACTUALLY ASKS FOR.
    // A correct planner wired to `cursor.lastCrawlDate` with the overlap
    // dropped at the call site is exactly the half-fix a pure test misses.
    const db = makeDb();
    db.seedCursor(new Date("2026-08-31T00:10:00Z"));
    const { fetchCalls } = await run({
      db,
      now: new Date("2026-08-31T00:12:00Z"),
      articles: [[]],
    });
    assert.equal(fetchCalls.length, 1);
    assert.equal(
      fetchCalls[0]!.startDate,
      "2026-08-30",
      "a 30-minute overlap from 00:10 UTC reaches into the PREVIOUS day; a " +
        "strict `> lastCrawl` cursor would ask for 2026-08-31 only and lose " +
        "every article Tiingo crawled late against the 30th",
    );
    assert.equal(fetchCalls[0]!.endDate, "2026-08-31");
  });

  it("a zero overlap would NOT reach back — the guard is what saves it", async () => {
    // The falsifiable ceiling for the case above: prove the fixture is capable
    // of producing the strict-boundary window, so its absence means something.
    // `planNewsCursor` refuses 0 and falls back to the default, so this asks
    // for a tiny-but-legal overlap instead and shows the window collapse.
    const db = makeDb();
    db.seedCursor(new Date("2026-08-31T00:10:00Z"));
    const { fetchCalls } = await run({
      db,
      now: new Date("2026-08-31T00:12:00Z"),
      overlapMs: 1,
      articles: [[]],
    });
    assert.equal(
      fetchCalls[0]!.startDate,
      "2026-08-31",
      "with effectively no overlap the previous day is NOT re-asked",
    );
  });

  it("the default overlap is used when the message says nothing", async () => {
    const db = makeDb();
    const lastCrawl = new Date("2026-08-31T12:00:00Z");
    db.seedCursor(lastCrawl);
    const { fetchCalls } = await run({ db, articles: [[]] });
    const expected = new Date(lastCrawl.getTime() - DEFAULT_NEWS_OVERLAP_MS)
      .toISOString()
      .slice(0, 10);
    assert.equal(fetchCalls[0]!.startDate, expected);
  });

  it("a first run (no cursor) still asks for a real window", async () => {
    const { result, fetchCalls } = await run({ db: makeDb(), articles: [[]] });
    assert.equal(result.firstRun, true);
    assert.ok(fetchCalls[0]!.startDate < fetchCalls[0]!.endDate);
  });

  it("`limit` is EXPLICIT on every page — omitting it means 100 rows", async () => {
    // MONEY-1264 F1: `buildTiingoNewsUrl` only sets `limit` when it is given
    // one, so an unparameterised call silently takes Tiingo's server default of
    // 100 rows of a market-wide, NEWEST-FIRST feed.
    const { fetchCalls } = await run({ articles: [[article()]] });
    assert.equal(typeof fetchCalls[0]!.limit, "number");
    assert.ok(fetchCalls[0]!.limit! > 100);
  });
});

describe("NO full article text is stored", () => {
  it("the create payload has exactly the ten expected columns", async () => {
    const { db } = await run({});
    const create = db.upserts[0]!.create;
    assert.deepEqual(Object.keys(create).sort(), [
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
  });

  it("no column of any body-like name reaches Prisma", async () => {
    const { db } = await run({});
    for (const payload of [db.upserts[0]!.create, db.upserts[0]!.update]) {
      for (const banned of [
        "body",
        "content",
        "text",
        "fullText",
        "html",
        "articleBody",
      ]) {
        assert.equal(
          Object.prototype.hasOwnProperty.call(payload, banned),
          false,
          `${banned} must never be written`,
        );
      }
    }
  });

  it("`description` is the snippet Tiingo sent, unexpanded", async () => {
    const snippet = "The deal is expected to close in Q4.";
    const { db } = await run({
      articles: [[article({ description: snippet })]],
    });
    assert.equal(db.upserts[0]!.create.description, snippet);
  });

  it("the processor never follows the article url", () => {
    // The property is an ABSENCE, so it needs a source scan: no behavioural
    // test covers a call nobody wrote. `row.url` is stored and never fetched.
    assert.doesNotMatch(PROC, /fetch\(\s*(row|article)\.url/);
    assert.doesNotMatch(PROC, /globalThis\.fetch|new Request\(/);
  });
});

describe("the schedule this job is sized against", () => {
  it("the run budget is well under the poll interval, not the ack deadline", () => {
    // The binding constraint arrives 4.5 minutes before Pub/Sub's 600s: a run
    // still going at 120s is running CONCURRENTLY with the next scheduled one,
    // against a paid quota that reports nothing about itself.
    assert.ok(
      RUN_TIME_BUDGET_MS < POLL_INTERVAL_MS,
      `${RUN_TIME_BUDGET_MS}ms must leave room before the next ${POLL_INTERVAL_MS}ms tick`,
    );
    assert.ok(
      POLL_INTERVAL_MS - RUN_TIME_BUDGET_MS >= 15_000,
      "and real margin",
    );
    assert.ok(
      RUN_TIME_BUDGET_MS < 600_000,
      "never sized against the ack deadline",
    );
  });

  it("the job id and cursor key are stable strings", () => {
    // The outcome metric's series name and the single cursor row's key. A
    // changed job id is a monitor in NO DATA; a changed cursor key is a cold
    // start that re-polls two days of history and silently orphans a row.
    assert.equal(JOB_NAME, "tiingo-news-poll");
    assert.equal(NEWS_CURSOR_KEY, "tiingo-news");
  });

  it("it reports a job outcome on EVERY path, from one place", () => {
    // A `reportJobOutcome` that early returns can skip is a monitor that sits
    // in NO DATA on exactly the branch that fires in production.
    assert.equal(
      (PROC.match(/reportJobOutcome\(/g) ?? []).length,
      1,
      "one call site, in `finish`, which every return path goes through",
    );
    for (const marker of ["return finish(", "async function finish("]) {
      assert.ok(PROC.includes(marker), marker);
    }
  });

  it("the floor and clamp guards came across from the retired leg", () => {
    // The failure they cover is an HTTP 200 carrying rows about the WRONG DAYS,
    // which a fresh poller would file as fresh news. Catching only the
    // pre-flight error would let the response-side clamp fall through as an
    // ordinary transport flake.
    assert.match(PROC, /TiingoNewsFloorError/);
    assert.match(PROC, /TiingoNewsClampedError/);
    assert.match(PROC, /state\.floorRejected = true/);
    // And the offset ceiling is a REFUSAL, not a loop condition.
    assert.match(PROC, /TIINGO_NEWS_MAX_OFFSET/);
  });

  it("us_stock_news is NOT written by this job", () => {
    // The old table stays read-only legacy until its readers migrate. A
    // dual-write would be two sources of truth for one feed with a race
    // between them.
    assert.doesNotMatch(PROC, /usStockNews\s*\./);
  });
});

/* -------------------------------------------------------------------------- */
/* D1 — THE WATERMARK INVARIANT                                                */
/*                                                                             */
/*   NO ARTICLE MAY FALL PERMANENTLY OUTSIDE EVERY FUTURE WINDOW.              */
/*                                                                             */
/* The defect these cases pin is not "the cursor is wrong". It is that the     */
/* cursor was advanced to the NEWEST thing written, on a feed that is          */
/* newest-first ACROSS DAYS, into a request window that is DAY-granular. A     */
/* partial run therefore wrote day 3, stamped day 3, and days 1 and 2 were     */
/* never asked for again — while the run reported `ok: true`,                  */
/* `selected === written`, `failed: 0`.                                        */
/*                                                                             */
/* Each case below asserts the invariant END TO END: it runs a SECOND poll     */
/* against the same cursor row and checks that the day the first poll failed   */
/* to store is still inside the window the second poll asks for. Asserting the */
/* cursor VALUE alone would pass against a fix that stamped a plausible date   */
/* the day-granular window still excluded.                                     */
/* -------------------------------------------------------------------------- */

/** Newest-first across days, exactly as the endpoint serves a wide window. */
function multiDayFeed(perDay: number): TiingoNewsArticle[] {
  const days = ["2026-08-31", "2026-08-30", "2026-08-29"];
  const out: TiingoNewsArticle[] = [];
  let id = 1;
  for (const day of days) {
    for (let i = 0; i < perDay; i++) {
      const mm = String(i).padStart(2, "0");
      out.push(
        article({
          id: id++,
          url: `https://example.test/${day}/${i}`,
          publishedDate: `${day}T12:00:00Z`,
          crawlDate: `${day}T13:${mm}:00Z`,
        }),
      );
    }
  }
  return out;
}

describe("[D1] a truncated multi-day run must not orphan the older days", () => {
  it("SIMULATION: a write-budget truncation leaves day 1 inside the next window", async () => {
    // 45 articles, newest-first: 15 on the 31st, 15 on the 30th, 15 on the
    // 29th. The write loop checks its budget every WRITE_CHUNK_ROWS (25) rows,
    // so crossing the budget after the 25th upsert stops it with rows 25..44 —
    // the whole of the 29th and a third of the 30th — unattempted.
    let t = 0;
    const db = makeDb({
      onUpsert: (count) => {
        if (count >= 25) t = RUN_TIME_BUDGET_MS + 1;
      },
    });
    db.seedCursor(new Date("2026-08-29T12:00:00Z"));

    const { result } = await run({
      db,
      articles: [multiDayFeed(15)],
      elapsedMs: () => t,
      now: new Date("2026-08-31T14:00:00Z"),
    });

    assert.equal(result.writeTruncated, true, "the run must actually truncate");
    assert.equal(result.written, 25, "and must have written a real prefix");
    assert.equal(result.unpersisted, 20, "with the rest owed");
    assert.equal(
      result.selected,
      45,
      "`selected` is what Datadog is told, and it must count the rows the " +
        "budget SKIPPED — it reported 25 (=== written) on the very run that " +
        "lost data, which is MONEY-1255's counter defect pointing the other " +
        "way",
    );
    assert.equal(
      result.selected,
      result.written + result.unpersisted,
      "and it is exactly written + owed, by construction",
    );
    assert.equal(
      result.ok,
      false,
      "a truncated run is NOT healthy — it reported `ok: true` before, which " +
        "is why the loss was silent",
    );

    // THE INVARIANT, checked where it bites: the next poll's window.
    const second = await run({
      db,
      articles: [[]],
      now: new Date("2026-08-31T14:02:00Z"),
    });
    assert.ok(
      second.fetchCalls[0]!.startDate <= "2026-08-29",
      `the next window starts ${second.fetchCalls[0]!.startDate} — every row ` +
        "this run failed to store is crawled on 2026-08-29 or later, so a " +
        "start after that day loses them permanently",
    );
  });

  it("SIMULATION: refused writes in the middle do not let the cursor sail past", async () => {
    // The same defect from the other direction, and one no clock is needed to
    // reach: an individual upsert that throws leaves a HOLE, and a newer row
    // written after it used to carry the watermark straight over the top.
    const db = makeDb({ upsertFailsFor: (id) => id >= 2 });
    db.seedCursor(new Date("2026-08-29T12:00:00Z"));

    const { result } = await run({
      db,
      articles: [multiDayFeed(1)], // id 1 = the 31st, 2 = the 30th, 3 = the 29th
      now: new Date("2026-08-31T14:00:00Z"),
    });

    assert.equal(result.written, 1, "only the newest day landed");
    assert.equal(result.failed, 2);
    assert.equal(result.unpersisted, 2);
    assert.equal(result.cursorAdvanceReason, "bounded-by-owed");
    assert.equal(
      db.cursor?.lastCrawlDate?.toISOString(),
      "2026-08-29T13:00:00.000Z",
      "the watermark is the OLDEST owed row, not the newest written one",
    );

    const second = await run({
      db,
      articles: [[]],
      now: new Date("2026-08-31T14:02:00Z"),
    });
    assert.ok(
      second.fetchCalls[0]!.startDate <= "2026-08-29",
      `next window starts ${second.fetchCalls[0]!.startDate}`,
    );
  });

  it("a walk that STOPPED SHORT holds the cursor even though rows landed", async () => {
    // The generalisation, and a defect the brief did not name: the offset walk
    // stops for a dozen reasons and only ONE of them — a short page — means the
    // window was read to its end. Here page 1 is full and page 2 FAILS, so
    // page 1's rows are written and the rest of the window was never seen.
    // `truncated` is false (that flag is the offset ceiling / budget case), so
    // enumerating truncation flags would have missed this entirely; asking
    // whether the walk FINISHED cannot.
    const db = makeDb();
    db.seedCursor(new Date("2026-08-29T12:00:00Z"));
    const before = db.cursor!.lastCrawlDate!.toISOString();

    let page = 0;
    const fetchFn = async () => {
      page++;
      if (page === 1) {
        return {
          articles: [
            article({ id: 1 }),
            article({ id: 2, url: "https://x/2" }),
          ],
          bytes: 1,
          url: "https://api.tiingo.com/tiingo/news",
        };
      }
      throw new Error("upstream hung up on page 2");
    };

    const result = await runNewsPoll(
      { limit: 2 }, // a 2-row page IS a full page, so the walk continues
      {
        prisma: db.db as never,
        fetchNews: fetchFn as never,
        now: () => new Date("2026-08-31T14:00:00Z"),
        // MONEY-1507 — stubbed, like `run()` does. Without it this case
        // reaches REAL Prisma through `publishEvents` and prints an
        // initialisation error per stored row.
        publishEvents: async () => ({ upserted: 0, failed: 0 }),
      },
    );

    assert.equal(result.pages, 2, "it really did try a second page");
    assert.equal(result.transportFailures, 1);
    assert.equal(
      result.windowComplete,
      false,
      "the walk never reached a short page",
    );
    assert.equal(result.written, 2, "the rows it DID get are still stored");
    assert.equal(result.cursorAdvanceReason, "window-incomplete");
    assert.equal(result.cursorAdvancedTo, null);
    assert.equal(
      result.ok,
      false,
      "and it is not healthy — this used to be counted in transportFailures " +
        "and reported ok:true while the cursor moved past the unseen rows",
    );
    assert.match(result.reason ?? "", /INCOMPLETE/);
    assert.equal(
      db.cursor?.lastCrawlDate?.toISOString(),
      before,
      "the watermark is exactly where it was, so the whole window is re-asked",
    );
  });

  it("a budget-exhausted page walk also holds the cursor", async () => {
    // The run budget is ONE budget: exhausting it mid-walk means the write loop
    // cannot run either, so this is `truncated` with nothing written. Kept
    // separate from the case above precisely because the two produce different
    // `cursorAdvanceReason`s and a single test would have to accept either.
    let t = 0;
    const db = makeDb();
    db.seedCursor(new Date("2026-08-29T12:00:00Z"));
    const before = db.cursor!.lastCrawlDate!.toISOString();

    const fetchFn = async () => {
      t = RUN_TIME_BUDGET_MS + 1;
      return {
        articles: [article({ id: 1 }), article({ id: 2, url: "https://x/2" })],
        bytes: 1,
        url: "https://api.tiingo.com/tiingo/news",
      };
    };

    const result = await runNewsPoll(
      { limit: 2 },
      {
        prisma: db.db as never,
        fetchNews: fetchFn as never,
        now: () => new Date("2026-08-31T14:00:00Z"),
        elapsedMs: () => t,
        // MONEY-1507 — stubbed, like `run()` does. Without it this case
        // reaches REAL Prisma through `publishEvents` and prints an
        // initialisation error per stored row.
        publishEvents: async () => ({ upserted: 0, failed: 0 }),
      },
    );

    assert.equal(result.truncated, true);
    assert.equal(result.windowComplete, false);
    assert.equal(result.ok, false);
    assert.equal(result.cursorAdvancedTo, null);
    assert.equal(db.cursor?.lastCrawlDate?.toISOString(), before);
  });

  it("the falsifiable other half: a COMPLETE run still advances normally", async () => {
    // Without this, "never advances" would satisfy every case above.
    const db = makeDb();
    db.seedCursor(new Date("2026-08-29T12:00:00Z"));
    const { result } = await run({
      db,
      articles: [multiDayFeed(2)],
      now: new Date("2026-08-31T14:00:00Z"),
    });
    assert.equal(result.written, 6);
    assert.equal(result.unpersisted, 0);
    assert.equal(result.windowComplete, true);
    assert.equal(result.ok, true);
    assert.equal(result.cursorAdvanceReason, "newest-written");
    assert.equal(
      db.cursor?.lastCrawlDate?.toISOString(),
      "2026-08-31T13:01:00.000Z",
      "the newest crawlDate in the whole window",
    );
  });

  it("truncation is REPORTED, so a monitor can see it", async () => {
    // `ok` excluded both truncation flags, so the one run that lost data was
    // indistinguishable from a healthy one in every field an operator reads.
    let t = 0;
    const db = makeDb({
      onUpsert: (count) => {
        if (count >= 25) t = RUN_TIME_BUDGET_MS + 1;
      },
    });
    const { result } = await run({
      db,
      articles: [multiDayFeed(15)],
      elapsedMs: () => t,
    });
    assert.equal(result.ok, false);
    assert.ok((result.reason ?? "").length > 0, "and it says why");
  });
});

describe("[D4] a partial master lookup never SHRINKS a stored tickers array", () => {
  /** > LOOKUP_CHUNK_SIZE distinct symbols, so the lookup takes two chunks. */
  function manyTickers(): string[] {
    const out = ["aapl"];
    for (let i = 0; i < 600; i++) out.push(`synth${i}`);
    return out;
  }

  it("omits `tickers` from the UPDATE when a lookup chunk threw", async () => {
    const db = makeDb({
      symbols: ["AAPL", "MSFT"],
      // The SECOND chunk fails. The first still matches AAPL, so this is a
      // partial failure — the run writes, undercounted, rather than refusing.
      lookupThrowsForSlice: (slice) => slice.includes("SYNTH599"),
    });
    seedRow(db, 900_001, { tickers: ["AAPL", "MSFT"] });

    const { result } = await run({
      db,
      articles: [[article({ tickers: manyTickers() })]],
    });

    assert.equal(result.written, 1, "a partial failure still writes");
    assert.ok((result.matchedSymbols ?? 0) >= 1, "and it did match something");

    const call = db.upserts[0]!;
    assert.equal(
      Object.prototype.hasOwnProperty.call(call.update, "tickers"),
      false,
      "a run that could not ask completely must not overwrite a correct array " +
        "with its own known undercount",
    );
    assert.ok(
      Object.prototype.hasOwnProperty.call(call.create, "tickers"),
      "but a NEW row still gets the best set we have — an undercounted row " +
        "beats no row, and the overlap hands it to a healthy poll",
    );
    assert.deepEqual(
      db.rows.get(900_001)!.tickers,
      ["AAPL", "MSFT"],
      "the stored row kept MSFT, which this run could not see",
    );
  });

  it("a COMPLETE lookup DOES update `tickers` — the falsifiable other half", async () => {
    // Without this, "never write tickers on update" would pass the case above
    // and would silently freeze every row's symbols forever.
    const db = makeDb({ symbols: ["AAPL", "MSFT"] });
    seedRow(db, 900_001, { tickers: ["AAPL", "MSFT"] });
    await run({ db, articles: [[article({ tickers: ["aapl"] })]] });

    const call = db.upserts[0]!;
    assert.deepEqual(call.update.tickers, ["AAPL"]);
    assert.deepEqual(
      db.rows.get(900_001)!.tickers,
      ["AAPL"],
      "a healthy run reflects the CURRENT master, in both directions",
    );
  });
});

describe("[MONEY-1507] every STORED article becomes NEWS events", () => {
  it("emits one event per (stored article, resolved listing)", async () => {
    // THE JOIN. `tiingoNewsEvents` is unit-tested on its own, and that proves
    // nothing about whether this poller ever calls it — the defect class this
    // repo keeps paying for (MONEY-1490's envelope, MONEY-1235's `createMissing`).
    const seen: { listingId: string | null | undefined; eventType: string }[] =
      [];
    const { result } = await run({
      articles: [[article({ id: 1, tickers: ["AAPL"] })]],
      publishEvents: async (events) => {
        for (const e of events as {
          listingId?: string | null;
          eventType: string;
        }[]) {
          seen.push({ listingId: e.listingId, eventType: e.eventType });
        }
        return { upserted: events.length, failed: 0 };
      },
    });
    assert.equal(result.written, 1);
    assert.deepEqual(seen, [
      { listingId: "AAPL:NASDAQ:2000-01-01", eventType: "NEWS" },
    ]);
    assert.equal(result.eventsWritten, 1);
    assert.equal(result.eventsFailed, 0);
  });

  it("emits NOTHING for an article whose row was never written", async () => {
    // An event claiming an article `us_news_articles` does not hold would be a
    // notification pointing at a story no reader can open.
    const called: unknown[][] = [];
    const db = makeDb({ upsertThrows: true });
    const { result } = await run({
      db,
      articles: [[article({ id: 1, tickers: ["AAPL"] })]],
      publishEvents: async (events) => {
        called.push([...events]);
        return { upserted: events.length, failed: 0 };
      },
    });
    assert.equal(result.written, 0);
    assert.deepEqual(called, []);
  });

  it("a THROWING writer is counted and never loses the cursor decision", async () => {
    // The cursor is the one thing in this run that must not be lost: an
    // un-advanced watermark costs a re-poll, one advanced past an unwritten row
    // loses it permanently.
    const { result, db } = await run({
      articles: [[article({ id: 1, tickers: ["AAPL"] })]],
      publishEvents: async () => {
        throw new Error("events are down");
      },
    });
    assert.equal(result.written, 1, "the article still stored");
    assert.equal(result.eventsWritten, 0);
    assert.ok(result.eventsFailed > 0, "the failure is COUNTED, not swallowed");
    assert.ok(db.cursorWrites.length > 0, "the cursor decision still ran");
  });

  it("[control] the default deps do NOT stub the writer", () => {
    // `run()` above injects a no-op so the other 37 cases never reach Mongo.
    // That stub must not exist in the PROCESSOR: if the production default were
    // also a no-op, every assertion above would be about the test harness.
    assert.match(PROC, /deps\.publishEvents \?\? publishEvents/);
  });
});
