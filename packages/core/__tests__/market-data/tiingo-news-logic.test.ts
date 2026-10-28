/**
 * MONEY-1264 — Tiingo US news, pure logic.
 *
 * Every fixture here is REAL API OUTPUT captured on 2026-08-28:
 *
 *   tiingo-news-market-2026-08-27.json  the market-wide firehose for one day
 *                                       (32 articles, 15 of them with an EMPTY
 *                                       tickers array, 3 with duplicates)
 *   tiingo-news-brk-a.json              `tickers=BRK-A&limit=50` (50 articles)
 *
 * The floor probes the suite asserts against were measured against the live
 * endpoint on the same day and are recorded in `tiingo-news-logic.ts`'s header.
 * They are hard-coded here rather than recomputed, because a test that derives
 * "90 days ago" from the clock and then asserts the code derived the same thing
 * proves only that two copies of one expression agree.
 */

import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
  TIINGO_NEWS_HISTORY_DAYS,
  TIINGO_NEWS_MAX_LIMIT,
  TIINGO_NEWS_MAX_OFFSET,
  TiingoNewsClampedError,
  TiingoNewsFloorError,
  TiingoNewsParseError,
  buildTiingoNewsUrl,
  dedupeTickers,
  detectClampedResponse,
  isBeforeFloor,
  newsFloorDate,
  parseArticleDate,
  parseNewsResponse,
  toStockNewsRows,
  type TiingoNewsArticle,
} from "../../src/market-data/tiingo/tiingo-news-logic";
import { fetchNews } from "../../src/market-data/tiingo/tiingo-news";
import {
  TiingoAuthError,
  TiingoRateLimitError,
  decideTiingoFailure,
} from "../../src/market-data/tiingo/tiingo-client";
import {
  TiingoDailyCapError,
  __resetTiingoPacer,
  tiingoRequestsToday,
} from "../../src/market-data/tiingo/tiingo-pacer";

const FIXTURES = join(import.meta.dirname, "fixtures");
const MARKET_JSON = readFileSync(
  join(FIXTURES, "tiingo-news-market-2026-08-27.json"),
  "utf8",
);
const BRK_JSON = readFileSync(join(FIXTURES, "tiingo-news-brk-a.json"), "utf8");

/** The day the probes below were measured. */
const MEASURED_NOW = new Date("2026-08-28T12:00:00Z");

function article(over: Partial<TiingoNewsArticle> = {}): TiingoNewsArticle {
  return {
    id: 1,
    publishedDate: "2026-08-27T10:00:00Z",
    crawlDate: "2026-08-27T10:05:00Z",
    title: "A title",
    description: "A description",
    url: "https://example.com/a",
    source: "example.com",
    tags: [],
    tickers: [],
    ...over,
  };
}

// ───────────────────────────────────────────────────────────────────────────
// THE FLOOR. This is the defect the whole ticket is written against: Tiingo
// answers a pre-floor request with HTTP 200 and rows from the floor date, so a
// two-year backfill silently writes three months and reports success.
// ───────────────────────────────────────────────────────────────────────────

describe("newsFloorDate — the 3-month window, measured", () => {
  test("2026-08-28 yields 2026-05-30, ONE DAY LATER than the measured cliff", () => {
    // Measured: 2026-05-29 was served, 2026-05-27 was clamped. Our floor is
    // deliberately 90 days (2026-05-30), not 91, so we sit one day INSIDE the
    // window. Refusing a day Tiingo would have served costs the oldest
    // articles; accepting a day it would not costs three months of silent
    // wrong data.
    assert.equal(newsFloorDate(MEASURED_NOW), "2026-05-30");
  });

  test("the margin is deliberate: 2026-05-29 was SERVED and we still refuse it", () => {
    assert.equal(isBeforeFloor("2026-05-29", MEASURED_NOW), true);
  });

  test("the exact floor date is accepted", () => {
    assert.equal(isBeforeFloor("2026-05-30", MEASURED_NOW), false);
  });

  test("every measured CLAMPED probe is refused", () => {
    for (const probe of ["2026-05-27", "2024-08-28", "2021-01-01"]) {
      assert.equal(
        isBeforeFloor(probe, MEASURED_NOW),
        true,
        `${probe} was measured CLAMPED and must be refused`,
      );
    }
  });

  test("the measured OK probe is accepted", () => {
    assert.equal(isBeforeFloor("2026-05-30", MEASURED_NOW), false);
  });

  test("the window is 90 days, and the arithmetic follows the constant", () => {
    assert.equal(TIINGO_NEWS_HISTORY_DAYS, 90);
    const floor = Date.parse(`${newsFloorDate(MEASURED_NOW)}T00:00:00Z`);
    assert.equal(
      Math.round((MEASURED_NOW.getTime() - floor) / 86_400_000),
      // 12:00Z now, midnight floor -> 90 days and a half, rounding to 91.
      91,
    );
  });

  test("an Invalid Date throws rather than producing an Invalid floor", () => {
    // Fail-open here would be catastrophic: an Invalid floor makes every string
    // comparison false, so isBeforeFloor would wave everything through.
    assert.throws(
      () => newsFloorDate(new Date("not-a-date")),
      TiingoNewsParseError,
    );
  });

  test("isBeforeFloor FAILS SAFE on garbage — refuses rather than passes through", () => {
    for (const bad of [
      "",
      "yesterday",
      "2026-5-30",
      "26-05-30",
      "2026-05-30T00:00:00Z",
    ]) {
      assert.equal(
        isBeforeFloor(bad, MEASURED_NOW),
        true,
        `${JSON.stringify(bad)} is unjudgeable and must be refused, not passed`,
      );
    }
  });
});

describe("buildTiingoNewsUrl — a pre-floor request cannot be constructed", () => {
  test("REFUSES a 2-year window with a typed error naming the floor", () => {
    // The measured shape: this request returns HTTP 200 with 3 months of rows.
    // No exception from Tiingo, no warning, no short page — the caller simply
    // believes it received two years.
    assert.throws(
      () =>
        buildTiingoNewsUrl(
          { startDate: "2024-08-28", endDate: "2026-08-28" },
          MEASURED_NOW,
        ),
      (err: unknown) => {
        assert.ok(err instanceof TiingoNewsFloorError);
        assert.equal(err.requestedStartDate, "2024-08-28");
        assert.equal(err.floorDate, "2026-05-30");
        // The message must say WHY a 200 is not proof, or the operator reads
        // the refusal as our bug rather than the endpoint's behaviour.
        assert.match(err.message, /does NOT error/);
        return true;
      },
    );
  });

  test("REFUSES each measured clamped probe", () => {
    for (const probe of ["2026-05-27", "2024-08-28", "2021-01-01"]) {
      assert.throws(
        () =>
          buildTiingoNewsUrl(
            { startDate: probe, endDate: "2026-08-28" },
            MEASURED_NOW,
          ),
        TiingoNewsFloorError,
        `${probe} must be refused`,
      );
    }
  });

  test("builds a URL for an in-window request", () => {
    const url = buildTiingoNewsUrl(
      { startDate: "2026-08-27", endDate: "2026-08-27" },
      MEASURED_NOW,
    );
    assert.match(url, /^https:\/\/api\.tiingo\.com\/tiingo\/news\?/);
    const q = new URL(url).searchParams;
    assert.equal(q.get("startDate"), "2026-08-27");
    assert.equal(q.get("endDate"), "2026-08-27");
  });

  test("never asks for format=csv — that 404s on this endpoint", () => {
    const url = buildTiingoNewsUrl(
      { startDate: "2026-08-27", endDate: "2026-08-27" },
      MEASURED_NOW,
    );
    assert.equal(new URL(url).searchParams.get("format"), null);
  });

  test("tickers are comma-joined; omitted entirely when empty", () => {
    const withTickers = buildTiingoNewsUrl(
      {
        tickers: ["AAPL", "MSFT"],
        startDate: "2026-08-27",
        endDate: "2026-08-27",
      },
      MEASURED_NOW,
    );
    assert.equal(new URL(withTickers).searchParams.get("tickers"), "AAPL,MSFT");

    const firehose = buildTiingoNewsUrl(
      { tickers: [], startDate: "2026-08-27", endDate: "2026-08-27" },
      MEASURED_NOW,
    );
    // An EMPTY `tickers=` param is not the same request as no param at all, and
    // the difference is a filter that may or may not apply.
    assert.equal(new URL(firehose).searchParams.has("tickers"), false);
  });

  test("REFUSES an offset at or past the measured 10,000 ceiling", () => {
    assert.equal(TIINGO_NEWS_MAX_OFFSET, 10_000);
    for (const offset of [10_000, 10_001, 50_000]) {
      assert.throws(
        () =>
          buildTiingoNewsUrl(
            { startDate: "2026-08-27", endDate: "2026-08-27", offset },
            MEASURED_NOW,
          ),
        (err: unknown) => {
          assert.ok(err instanceof TiingoNewsParseError);
          // Zero rows at the ceiling is indistinguishable from "no more news";
          // the message has to say so or the next reader adds a while-loop.
          assert.match(err.message, /ZERO rows/);
          return true;
        },
      );
    }
  });

  test("accepts the last usable offset", () => {
    assert.doesNotThrow(() =>
      buildTiingoNewsUrl(
        { startDate: "2026-08-27", endDate: "2026-08-27", offset: 9_999 },
        MEASURED_NOW,
      ),
    );
  });

  test("rejects a negative or non-integer offset", () => {
    for (const offset of [-1, 1.5, Number.NaN]) {
      assert.throws(
        () =>
          buildTiingoNewsUrl(
            { startDate: "2026-08-27", endDate: "2026-08-27", offset },
            MEASURED_NOW,
          ),
        TiingoNewsParseError,
      );
    }
  });

  test("limit is bounded by what was measured as honoured", () => {
    assert.equal(TIINGO_NEWS_MAX_LIMIT, 5_000);
    assert.doesNotThrow(() =>
      buildTiingoNewsUrl(
        { startDate: "2026-08-27", endDate: "2026-08-27", limit: 5_000 },
        MEASURED_NOW,
      ),
    );
    for (const limit of [0, -5, 5_001, 2.5]) {
      assert.throws(
        () =>
          buildTiingoNewsUrl(
            { startDate: "2026-08-27", endDate: "2026-08-27", limit },
            MEASURED_NOW,
          ),
        TiingoNewsParseError,
      );
    }
  });

  test("rejects malformed dates with a FORMAT error, not a floor error", () => {
    // The two causes lead to different operator actions, so they must not be
    // reported as one — isBeforeFloor alone would call both "too old".
    assert.throws(
      () =>
        buildTiingoNewsUrl(
          { startDate: "27-08-2026", endDate: "2026-08-27" },
          MEASURED_NOW,
        ),
      (err: unknown) => {
        assert.ok(err instanceof TiingoNewsParseError);
        assert.ok(!(err instanceof TiingoNewsFloorError));
        assert.match(err.message, /YYYY-MM-DD/);
        return true;
      },
    );
  });

  test("rejects an inverted window", () => {
    assert.throws(
      () =>
        buildTiingoNewsUrl(
          { startDate: "2026-08-27", endDate: "2026-08-01" },
          MEASURED_NOW,
        ),
      TiingoNewsParseError,
    );
  });
});

// ───────────────────────────────────────────────────────────────────────────
// The SECOND floor guard: the response has to describe the window we asked for.
// ───────────────────────────────────────────────────────────────────────────

describe("detectClampedResponse — catches clamping the arithmetic missed", () => {
  test("flags the measured clamp shape: asked 2021, got floor-date rows", () => {
    const clamped = detectClampedResponse({
      startDate: "2021-01-01",
      endDate: "2021-01-31",
      articles: [
        article({ publishedDate: "2026-05-29T09:00:00Z" }),
        article({ publishedDate: "2026-05-30T09:00:00Z" }),
      ],
    });
    assert.equal(clamped.clamped, true);
    assert.match(String(clamped.reason), /2 of 2/);
    assert.match(String(clamped.reason), /2026-05-29/);
  });

  test("passes a response that really is inside the window", () => {
    const check = detectClampedResponse({
      startDate: "2026-08-27",
      endDate: "2026-08-27",
      articles: parseNewsResponse(MARKET_JSON),
    });
    assert.equal(check.clamped, false, check.reason);
  });

  test("the real one-day fixture survives its own window with no tolerance abuse", () => {
    // Zero tolerance still passes: the fixture genuinely is that day. This is
    // what stops the ±1d tolerance from being the reason the guard is green.
    const check = detectClampedResponse({
      startDate: "2026-08-27",
      endDate: "2026-08-27",
      articles: parseNewsResponse(MARKET_JSON),
      toleranceDays: 0,
    });
    assert.equal(check.clamped, false, check.reason);
  });

  test("an empty response is NOT clamped — a quiet day is a real answer", () => {
    assert.equal(
      detectClampedResponse({
        startDate: "2026-08-27",
        endDate: "2026-08-27",
        articles: [],
      }).clamped,
      false,
    );
  });

  test("a UTC boundary article is tolerated, not flagged", () => {
    assert.equal(
      detectClampedResponse({
        startDate: "2026-08-27",
        endDate: "2026-08-27",
        articles: [article({ publishedDate: "2026-08-26T23:40:00Z" })],
      }).clamped,
      false,
    );
  });

  test("a response with NO judgeable dates is reported clamped, never green", () => {
    // A guard that abstains reads exactly like a guard that passed.
    const check = detectClampedResponse({
      startDate: "2026-08-27",
      endDate: "2026-08-27",
      articles: [
        article({ publishedDate: "" }),
        article({ publishedDate: "x" }),
      ],
    });
    assert.equal(check.clamped, true);
    assert.match(String(check.reason), /parseable publishedDate/);
  });

  test("TiingoNewsClampedError explains that a 200 is not proof", () => {
    const err = new TiingoNewsClampedError("2 of 2 outside");
    assert.match(err.message, /HTTP 200/);
    assert.match(err.message, /Nothing is written/);
    assert.equal(err.name, "TiingoNewsClampedError");
  });
});

// ───────────────────────────────────────────────────────────────────────────
// Parsing — real payloads.
// ───────────────────────────────────────────────────────────────────────────

describe("parseNewsResponse — real payloads", () => {
  test("parses the market-wide day and preserves all nine fields", () => {
    const rows = parseNewsResponse(MARKET_JSON);
    assert.equal(rows.length, 32);
    const first = rows[0]!;
    assert.equal(typeof first.id, "number");
    assert.ok(first.publishedDate.startsWith("2026-08-27"));
    assert.ok(first.crawlDate.startsWith("2026-08-27"));
    assert.ok(first.title.length > 0);
    assert.ok(first.url.startsWith("https://"));
    assert.ok(first.source.length > 0);
    assert.ok(Array.isArray(first.tags));
    assert.ok(Array.isArray(first.tickers));
  });

  test("id stays a NUMBER — the live payload does not quote it", () => {
    for (const a of parseNewsResponse(MARKET_JSON)) {
      assert.equal(typeof a.id, "number");
    }
  });

  test("an EMPTY array is a legitimate quiet day, not an error", () => {
    assert.deepEqual(parseNewsResponse("[]"), []);
  });

  test("a non-array container THROWS rather than reading as a quiet day", () => {
    // `[]` already means "no news". A parser that also returns `[]` for an
    // error envelope makes a failure indistinguishable from an absence — the
    // exact collapse that lets a job report success while writing nothing.
    for (const payload of [
      '{"detail":"Invalid token."}',
      "null",
      '"a string"',
      "42",
    ]) {
      assert.throws(
        () => parseNewsResponse(payload),
        TiingoNewsParseError,
        payload,
      );
    }
  });

  test("invalid JSON throws", () => {
    assert.throws(
      () => parseNewsResponse("<html>nope</html>"),
      TiingoNewsParseError,
    );
  });

  test("drops a row with no url or no title, keeps the rest", () => {
    // `url` is half of @@unique([symbol, link]) and `title` is non-nullable —
    // neither can be defaulted into anything meaningful.
    const rows = parseNewsResponse(
      JSON.stringify([
        { ...article(), url: "" },
        { ...article(), title: "   " },
        null,
        "not an object",
        article({ url: "https://example.com/keep", title: "Keep" }),
      ]),
    );
    assert.equal(rows.length, 1);
    assert.equal(rows[0]!.url, "https://example.com/keep");
  });

  test("coerces missing/mistyped optional fields instead of throwing", () => {
    const rows = parseNewsResponse(
      JSON.stringify([
        {
          title: "T",
          url: "https://example.com/x",
          tickers: "aapl", // a string, not an array
          tags: null,
          id: "not-a-number",
        },
      ]),
    );
    assert.equal(rows.length, 1);
    assert.deepEqual(rows[0]!.tickers, []);
    assert.deepEqual(rows[0]!.tags, []);
    assert.equal(rows[0]!.id, 0);
    assert.equal(rows[0]!.source, "");
  });
});

// ───────────────────────────────────────────────────────────────────────────
// The ticker filter, and the duplicates inside `tickers[]`.
// ───────────────────────────────────────────────────────────────────────────

describe("the ticker filter is STRICT — it does not fall through", () => {
  test("every BRK-A article really carries brk-a", () => {
    // Measured: `BRK-A` -> 50/50, `BRKA` -> 50/50, `BRK.A` -> 0, garbage -> 0.
    // If Tiingo fell through to the unfiltered firehose on a symbol it did not
    // recognise, this fixture would be full of unrelated articles — and an
    // unfiltered response looks like ABUNDANT data, which is the reading that
    // gets shipped.
    const rows = parseNewsResponse(BRK_JSON);
    assert.equal(rows.length, 50);
    for (const a of rows) {
      assert.ok(
        dedupeTickers(a.tickers).includes("BRK-A"),
        `article ${a.id} lacks BRK-A: ${JSON.stringify(a.tickers)}`,
      );
    }
  });

  test("the market-wide firehose is NOT the same thing — most rows lack any one ticker", () => {
    // The contrast is the point: the same parser over an unfiltered response
    // yields articles with no tickers at all, so the assertion above is
    // measuring the filter and not a property of every Tiingo response.
    const market = parseNewsResponse(MARKET_JSON);
    const withBrk = market.filter((a) =>
      dedupeTickers(a.tickers).includes("BRK-A"),
    );
    assert.equal(withBrk.length, 0);
  });
});

describe("dedupeTickers — tickers[] repeats itself", () => {
  test("collapses the measured duplicate shape", () => {
    // Real: ["aaic","ai","ai","tech"] — 79 of 200 market-wide rows carry one.
    assert.deepEqual(dedupeTickers(["aaic", "ai", "ai", "tech"]), [
      "AAIC",
      "AI",
      "TECH",
    ]);
  });

  test("the real fixture contains duplicates, so this is not a hypothetical", () => {
    const dupRows = parseNewsResponse(MARKET_JSON).filter(
      (a) => new Set(a.tickers).size !== a.tickers.length,
    );
    assert.ok(
      dupRows.length > 0,
      "fixture must still exercise the duplicate case",
    );
    for (const a of dupRows) {
      const deduped = dedupeTickers(a.tickers);
      assert.equal(new Set(deduped).size, deduped.length);
      assert.ok(deduped.length < a.tickers.length);
    }
  });

  test("uppercases — news is lowercase, InstrumentMapping.symbol is not", () => {
    assert.deepEqual(dedupeTickers(["aapl", "AAPL", " aapl "]), ["AAPL"]);
  });

  test("preserves first-seen order and drops blanks", () => {
    assert.deepEqual(dedupeTickers(["msft", "", "  ", "aapl", "msft"]), [
      "MSFT",
      "AAPL",
    ]);
  });
});

// ───────────────────────────────────────────────────────────────────────────
// Fan-out to StockNews rows.
// ───────────────────────────────────────────────────────────────────────────

describe("toStockNewsRows — one row per DISTINCT carried ticker", () => {
  const known = new Set(["AAPL", "MSFT", "GOOGL"]);

  test("fans to one row per distinct known ticker", () => {
    const rows = toStockNewsRows(
      article({ tickers: ["aapl", "aapl", "googl", "msft", "msft"] }),
      known,
    );
    assert.deepEqual(
      rows.map((r) => r.symbol),
      ["AAPL", "GOOGL", "MSFT"],
    );
  });

  test("the duplicate would otherwise violate @@unique([symbol, link])", () => {
    const rows = toStockNewsRows(article({ tickers: ["aapl", "aapl"] }), known);
    const keys = rows.map((r) => `${r.symbol}|${r.link}`);
    assert.equal(new Set(keys).size, keys.length);
    assert.equal(rows.length, 1);
  });

  test("drops tickers we do not carry", () => {
    const rows = toStockNewsRows(
      article({ tickers: ["aapl", "tech", "ai", "sometotallyunknownticker"] }),
      known,
    );
    assert.deepEqual(
      rows.map((r) => r.symbol),
      ["AAPL"],
    );
  });

  test("an article with NO tickers fans to zero rows — 15 of 32 in the real day", () => {
    const market = parseNewsResponse(MARKET_JSON);
    const untagged = market.filter((a) => a.tickers.length === 0);
    assert.ok(
      untagged.length > 0,
      "fixture must still exercise the empty case",
    );
    for (const a of untagged) {
      assert.equal(toStockNewsRows(a, known).length, 0);
    }
  });

  test("maps the fields Tiingo actually names differently", () => {
    const [row] = toStockNewsRows(
      article({
        tickers: ["aapl"],
        url: "https://example.com/story",
        description: "the snippet",
        publishedDate: "2026-08-27T10:00:00Z",
        source: "prnewswire.com",
        title: "the title",
      }),
      known,
    );
    assert.ok(row);
    assert.equal(row.link, "https://example.com/story");
    assert.equal(row.snippet, "the snippet");
    assert.equal(row.source, "prnewswire.com");
    assert.equal(row.title, "the title");
    assert.equal(row.pubDate?.toISOString(), "2026-08-27T10:00:00.000Z");
    // `market` is GONE. It used to be asserted here as `"US"` and the row is
    // now written to `us_stock_news`, where the discriminator is the TABLE. A
    // stray `market` reaching the Prisma payload would be an unknown-field
    // write error, so this asserts its ABSENCE rather than leaving the removal
    // to the type checker alone — a `Record<string, unknown>` cast at any call
    // site would put it back invisibly.
    assert.equal("market" in row, false, "market must not survive the split");
  });

  test("permaTicker is null when no map is supplied — the two-arg call still works", () => {
    // The third argument is OPTIONAL precisely so `scripts/jobs/tiingo-us-news-seed.ts`
    // compiles unchanged. A null permaTicker is a valid row: the enrichment
    // rotation fills the column separately and has not reached most listings.
    const [row] = toStockNewsRows(article({ tickers: ["aapl"] }), known);
    assert.equal(row?.permaTicker, null);
  });

  test("permaTicker comes from the map, per symbol", () => {
    const rows = toStockNewsRows(
      article({ tickers: ["aapl", "msft"] }),
      new Set(["AAPL", "MSFT"]),
      new Map([
        ["AAPL", "US000000000038"],
        // Present-but-null is how an AMBIGUOUS resolution is spelled: a ticker
        // live on two venues has two permaTickers and the processor refuses to
        // pick. It must come through as null, not as the other symbol's id.
        ["MSFT", null],
      ]),
    );
    assert.equal(
      rows.find((r) => r.symbol === "AAPL")?.permaTicker,
      "US000000000038",
    );
    assert.equal(rows.find((r) => r.symbol === "MSFT")?.permaTicker, null);
  });

  test("a symbol MISSING from the map is null, not undefined", () => {
    // `undefined` reaching Prisma on a create means "omit the field", which is
    // the same outcome here — but the two are different values in every
    // assertion, every log line and every JSON round trip downstream, and a
    // column that is sometimes null and sometimes absent is the MONEY-1050
    // shape from the writing side.
    const [row] = toStockNewsRows(
      article({ tickers: ["aapl"] }),
      known,
      new Map([["NVDA", "US000000000999"]]),
    );
    assert.equal(row?.permaTicker, null);
    assert.equal(row?.permaTicker === undefined, false);
  });

  test("an empty description becomes null, not an empty string", () => {
    const [row] = toStockNewsRows(
      article({ tickers: ["aapl"], description: "   " }),
      known,
    );
    assert.equal(row?.snippet, null);
  });

  test("an unparseable publishedDate becomes null, never an Invalid Date", () => {
    // An Invalid Date reaching Prisma is a write error at best and a
    // permanently unsortable row at worst.
    //
    // Asserted as a BOOLEAN rather than `assert.equal(pubDate, null)`. With the
    // guard mutated away this value is `new Date(NaN)`, and node's TAP reporter
    // calls `toISOString()` on it while rendering the diff — which THROWS and
    // crashes the harness. The suite is red either way, but a crash is not a
    // test result: it hides which assertion failed and it would mask any other
    // failure in the same run. Comparing a boolean keeps the mutant's report a
    // clean `false !== true`.
    const [row] = toStockNewsRows(
      article({ tickers: ["aapl"], publishedDate: "not a date" }),
      known,
    );
    assert.equal(row?.pubDate === null, true, "pubDate must be null");
    assert.equal(parseArticleDate("not a date") === null, true);
    assert.equal(parseArticleDate("") === null, true);
    assert.equal(
      parseArticleDate("2026-08-27T00:00:00Z")?.toISOString(),
      "2026-08-27T00:00:00.000Z",
    );
  });

  test("over the whole real day, no two rows share (symbol, link)", () => {
    // The end-to-end version of the dedupe claim: the unique key holds across
    // the entire fixture, not just the crafted duplicate above.
    const seen = new Set<string>();
    const universe = new Set(
      parseNewsResponse(MARKET_JSON).flatMap((a) => dedupeTickers(a.tickers)),
    );
    for (const a of parseNewsResponse(MARKET_JSON)) {
      for (const row of toStockNewsRows(a, universe)) {
        const key = `${row.symbol}|${row.link}`;
        assert.equal(seen.has(key), false, `duplicate unique key ${key}`);
        seen.add(key);
      }
    }
    assert.ok(seen.size > 0);
  });
});

// ───────────────────────────────────────────────────────────────────────────
// CLIENT WIRING.
//
// The pure guards above are worthless if `fetchNews` does not actually call
// them, and "the module imports it" is not evidence — MONEY-1220 lost a release
// to merged-but-not-wired. These stub `globalThis.fetch` (the same technique as
// `feed-archive.test.ts`) so the whole path runs with no network: the URL
// builder, the archive seam, the parser and BOTH floor guards.
// ───────────────────────────────────────────────────────────────────────────

describe("fetchNews — the guards are reached, not merely imported", () => {
  const realFetch = globalThis.fetch;
  let fetchCalls: Array<{ url: string; headers: Record<string, string> }> = [];
  let savedKey: string | undefined;

  function stubFetch(body: string, status = 200): void {
    globalThis.fetch = (async (url: unknown, init?: RequestInit) => {
      const headers: Record<string, string> = {};
      for (const [k, v] of Object.entries(
        (init?.headers ?? {}) as Record<string, string>,
      )) {
        headers[k.toLowerCase()] = v;
      }
      fetchCalls.push({ url: String(url), headers });
      if (status === 404) return new Response(null, { status });
      return new Response(body, { status });
    }) as unknown as typeof fetch;
  }

  beforeEach(() => {
    fetchCalls = [];
    savedKey = process.env.TIINGO_API_KEY;
    process.env.TIINGO_API_KEY = "test-token-not-a-real-key";
    delete process.env.FEED_ARCHIVE_MODE;
    __resetTiingoPacer();
  });

  afterEach(() => {
    globalThis.fetch = realFetch;
    if (savedKey === undefined) delete process.env.TIINGO_API_KEY;
    else process.env.TIINGO_API_KEY = savedKey;
    __resetTiingoPacer();
  });

  test("GUARD 1 — a pre-floor request never reaches the network", async () => {
    // The whole point. If this ever makes a request, we have spent quota to
    // receive three months of articles labelled as two years.
    stubFetch(MARKET_JSON);
    await assert.rejects(
      () =>
        fetchNews(
          { startDate: "2024-08-28", endDate: "2026-08-28" },
          { now: MEASURED_NOW },
        ),
      TiingoNewsFloorError,
    );
    assert.equal(fetchCalls.length, 0, "no HTTP call may be made");
  });

  test("GUARD 2 — an in-window request whose RESPONSE is clamped throws", async () => {
    // Here the arithmetic said yes: we asked for a day well inside the window.
    // Tiingo answered 200 with floor-date rows anyway. That is the failure the
    // URL guard cannot see, and it must not become data.
    stubFetch(
      JSON.stringify([
        {
          id: 1,
          publishedDate: "2026-05-29T10:00:00Z",
          crawlDate: "2026-05-29T10:00:00Z",
          title: "T",
          description: "D",
          url: "https://example.com/x",
          source: "example.com",
          tags: [],
          tickers: ["aapl"],
        },
      ]),
    );
    await assert.rejects(
      () =>
        fetchNews(
          { startDate: "2026-08-27", endDate: "2026-08-27" },
          { now: MEASURED_NOW },
        ),
      TiingoNewsClampedError,
    );
    assert.equal(fetchCalls.length, 1);
  });

  test("a good in-window day parses end to end", async () => {
    stubFetch(MARKET_JSON);
    const res = await fetchNews(
      { startDate: "2026-08-27", endDate: "2026-08-27" },
      { now: MEASURED_NOW },
    );
    assert.ok(res);
    assert.equal(res.articles.length, 32);
    assert.equal(res.bytes, Buffer.byteLength(MARKET_JSON, "utf8"));
    assert.equal(fetchCalls.length, 1);
  });

  test("sends Authorization and DELETES the browser Origin/Referer defaults", async () => {
    // The archive seam impersonates a browser because NSE/BSE demand it. Tiingo
    // wants a token and nothing else, and `null` in the override map has to
    // DELETE rather than blank — a lowercase key here would JOIN with the
    // default instead of replacing it.
    stubFetch(MARKET_JSON);
    await fetchNews(
      { startDate: "2026-08-27", endDate: "2026-08-27" },
      { now: MEASURED_NOW },
    );
    const sent = fetchCalls[0]!.headers;
    assert.equal(sent.authorization, "Token test-token-not-a-real-key");
    assert.equal(sent.accept, "application/json");
    assert.equal("origin" in sent, false, "Origin must be deleted");
    assert.equal("referer" in sent, false, "Referer must be deleted");
  });

  test("the fetched URL carries the window and never format=csv", async () => {
    stubFetch(MARKET_JSON);
    await fetchNews(
      { startDate: "2026-08-27", endDate: "2026-08-27", tickers: ["AAPL"] },
      { now: MEASURED_NOW },
    );
    const q = new URL(fetchCalls[0]!.url).searchParams;
    assert.equal(q.get("startDate"), "2026-08-27");
    assert.equal(q.get("endDate"), "2026-08-27");
    assert.equal(q.get("tickers"), "AAPL");
    assert.equal(q.get("format"), null);
  });

  test("an error envelope throws rather than reading as a quiet day", async () => {
    stubFetch('{"detail":"Invalid token."}');
    await assert.rejects(
      () =>
        fetchNews(
          { startDate: "2026-08-27", endDate: "2026-08-27" },
          { now: MEASURED_NOW },
        ),
      TiingoNewsParseError,
    );
  });

  test("an empty day is a successful result, not an error", async () => {
    stubFetch("[]");
    const res = await fetchNews(
      { startDate: "2026-08-27", endDate: "2026-08-27" },
      { now: MEASURED_NOW },
    );
    assert.ok(res);
    assert.deepEqual(res.articles, []);
  });

  test("a 403 becomes TiingoAuthError without burning the retry ladder", async () => {
    // Neither a bad token nor a missing entitlement heals on retry, so the
    // ladder must not be spent on one — a single call, then the typed error the
    // seed circuit-breaks on.
    stubFetch("", 403);
    await assert.rejects(
      () =>
        fetchNews(
          { startDate: "2026-08-27", endDate: "2026-08-27" },
          { now: MEASURED_NOW },
        ),
      TiingoAuthError,
    );
    assert.equal(fetchCalls.length, 1);
  });

  test("every request is charged to the SHARED pacer, not a local one", async () => {
    // Wiring proof, and the reason it is here: a local pacer in this file would
    // behave identically in every observable way EXCEPT that its state would be
    // private — and four private throttles against one account-wide quota is a
    // combined rate of 4x the cap, with no error to announce it (MONEY-1263).
    // `tiingoRequestsToday()` is the only externally visible evidence that this
    // client charges the shared ledger, so it is asserted rather than assumed.
    stubFetch(MARKET_JSON);
    __resetTiingoPacer();
    assert.equal(tiingoRequestsToday(), 0);
    await fetchNews(
      { startDate: "2026-08-27", endDate: "2026-08-27" },
      { now: MEASURED_NOW },
    );
    assert.equal(tiingoRequestsToday(), 1, "one request charged");
    await fetchNews(
      { startDate: "2026-08-26", endDate: "2026-08-26" },
      { now: MEASURED_NOW },
    );
    assert.equal(tiingoRequestsToday(), 2, "the ledger accumulates");
  });

  test("the shared pacer's DAILY CAP propagates untouched, never retried", async () => {
    // The shared pacer throws `TiingoDailyCapError`, which is NOT the class
    // `decideTiingoFailure` re-throws (`TiingoRateLimitError`). Without an
    // explicit arm in this client it is classified "other" and spends the whole
    // ~35s ladder — four attempts, each re-entering the pacer and throwing the
    // identical cap error — before surfacing as a generic failure that no
    // caller circuit-breaks on. That is the MONEY-980 defect, reintroduced by a
    // rename.
    //
    // Driven by throwing the class from the transport rather than by charging
    // 150,000 requests at the real daily cap: the arm keys on the ERROR CLASS,
    // so where it was raised is irrelevant to what is being asserted.
    let attempts = 0;
    globalThis.fetch = (async () => {
      attempts++;
      throw new TiingoDailyCapError("Tiingo daily cap 150000 reached");
    }) as unknown as typeof fetch;

    await assert.rejects(
      () =>
        fetchNews(
          { startDate: "2026-08-27", endDate: "2026-08-27" },
          { now: MEASURED_NOW },
        ),
      TiingoDailyCapError,
    );
    assert.equal(
      attempts,
      1,
      "a permanent cap must not be retried — one attempt, then stop",
    );
  });

  test("the SHARED decision function re-throws BOTH typed errors", () => {
    // This assertion previously read `"retry"` for the cap, documenting a real
    // hole rather than a design: `decideTiingoFailure` re-threw only
    // `TiingoRateLimitError`, so a daily cap fell through to status 0 ->
    // "other" -> the full ~35s ladder, re-entering the pacer and raising the
    // identical cap error four times.
    //
    // It flipped exactly as its own note predicted it would, which is the point
    // of pinning a reason as an assertion instead of a comment. The arm in this
    // client is now redundant defence rather than a necessity — kept because it
    // is one line and costs nothing, but no longer load-bearing.
    assert.equal(
      decideTiingoFailure(new TiingoDailyCapError("cap"), 1).action,
      "rethrow",
    );
    assert.equal(
      decideTiingoFailure(new TiingoRateLimitError("ctx"), 1).action,
      "rethrow",
    );
  });

  test("a 404 returns null — the caller decides what that means", async () => {
    stubFetch("", 404);
    const res = await fetchNews(
      { startDate: "2026-08-27", endDate: "2026-08-27" },
      { now: MEASURED_NOW },
    );
    assert.equal(res, null);
  });

  test("a missing TIINGO_API_KEY fails IMMEDIATELY, not through the ladder", async () => {
    // Built inside the try/catch, this throw carries no HTTP status,
    // `decideTiingoFailure` calls it "other", and the ladder retries it — 5s +
    // 10s + 20s of sleeping for an env var that will never appear. The elapsed
    // bound is what makes that a clean assertion rather than a 30s timeout; the
    // margin is 35x, so it is a statement about the ladder and not about
    // machine speed.
    delete process.env.TIINGO_API_KEY;
    stubFetch(MARKET_JSON);
    const startedAt = Date.now();
    await assert.rejects(
      () =>
        fetchNews(
          { startDate: "2026-08-27", endDate: "2026-08-27" },
          { now: MEASURED_NOW },
        ),
      /TIINGO_API_KEY is not set/,
    );
    const elapsedMs = Date.now() - startedAt;
    assert.equal(fetchCalls.length, 0);
    assert.ok(
      elapsedMs < 1_000,
      `a permanent misconfiguration must not enter the retry ladder (took ${elapsedMs}ms)`,
    );
  });
});
