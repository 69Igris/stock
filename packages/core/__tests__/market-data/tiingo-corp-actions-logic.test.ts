/**
 * MONEY-1263 — US corporate actions from Tiingo, pure logic.
 *
 * Every fixture here is REAL API OUTPUT captured on 2026-08-28, not a
 * hand-written approximation:
 *
 *   tiingo-splits-2026-08-25.csv        market-wide splits, the two-`reax` day
 *   tiingo-splits-aapl.csv              AAPL's 5 splits incl. 7.000007000007001
 *   tiingo-splits-ge.csv                GE incl. the 0.125 REVERSE split
 *   tiingo-distributions-aapl.csv       AAPL 2021- incl. the genuine 0.0 row
 *   tiingo-distributions-2026-08-25.csv market-wide, 189 rows, 106 partial
 *   tiingo-distributions-2026-08-25.json the SAME day in the other date format
 *   tiingo-corp-actions-empty-day.csv   the four-byte `None`
 *
 * The last one matters most and is the least obvious: a day with no corporate
 * actions answers 200 with the literal body `None`, so the fixture is a real
 * measured response even though it is four bytes long.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
  corpActionKey,
  dedupeCorpActions,
  enumerateExDates,
  isEmptyCorpActionsBody,
  isoDayToUtcDate,
  parseDistributionsCsv,
  parseSplitsCsv,
  parseTiingoDate,
  resolveListingId,
  TiingoCorpActionsShapeError,
  toUsCorporateActionRows,
  TIINGO_CORP_ACTION_CURRENCY,
  TIINGO_CORP_ACTION_SOURCE,
  type UsCorporateActionRow,
} from "../../src/market-data/tiingo/tiingo-corp-actions-logic";
import {
  buildCorpActionsUrl,
  corpActionsDescriptor,
  fetchDistributionsByExDate,
  fetchSplitsByExDate,
} from "../../src/market-data/tiingo/tiingo-corp-actions";
import { buildFeedArchiveKey } from "../../src/market-data/feed-archive";

const fixture = (name: string): string =>
  readFileSync(join(import.meta.dirname, "fixtures", name), "utf8");

const SPLITS_MARKET = fixture("tiingo-splits-2026-08-25.csv");
const SPLITS_AAPL = fixture("tiingo-splits-aapl.csv");
const SPLITS_GE = fixture("tiingo-splits-ge.csv");
const DISTS_AAPL = fixture("tiingo-distributions-aapl.csv");
const DISTS_MARKET = fixture("tiingo-distributions-2026-08-25.csv");
const DISTS_MARKET_JSON = fixture("tiingo-distributions-2026-08-25.json");
const EMPTY_DAY = fixture("tiingo-corp-actions-empty-day.csv");

// ───────────────────────────────────────────────────────────────────────────
// The empty day
// ───────────────────────────────────────────────────────────────────────────

describe("isEmptyCorpActionsBody — the four-byte `None`", () => {
  test("the captured empty-day response really is the literal `None`", () => {
    // Guards the FIXTURE, not the function. If someone regenerates this file
    // and Tiingo has since fixed the serializer, every assertion below would
    // still pass while testing a body production never sees.
    assert.equal(EMPTY_DAY, "None");
    assert.equal(Buffer.byteLength(EMPTY_DAY, "utf8"), 4);
  });

  test("`None` is recognised as empty", () => {
    assert.equal(isEmptyCorpActionsBody(EMPTY_DAY), true);
  });

  test("the JSON form and a blank body are empty too", () => {
    // The JSON serializer is correct (`[]`), so a `format=` change must not
    // turn an empty day into a parse failure.
    for (const body of ["[]", "{}", "", "   \n ", "\r\n"]) {
      assert.equal(
        isEmptyCorpActionsBody(body),
        true,
        `body ${JSON.stringify(body)}`,
      );
    }
  });

  test("a real response is NOT empty", () => {
    assert.equal(isEmptyCorpActionsBody(SPLITS_MARKET), false);
    assert.equal(isEmptyCorpActionsBody(DISTS_MARKET), false);
  });

  test("both parsers return [] for `None` rather than one junk row", () => {
    // The whole point of the explicit guard: without it, a future CSV splitter
    // change turns `None` into a row with permaTicker "None" that would be
    // written, indexed and never questioned.
    assert.deepEqual(parseSplitsCsv(EMPTY_DAY), []);
    assert.deepEqual(parseDistributionsCsv(EMPTY_DAY), []);
  });
});

// ───────────────────────────────────────────────────────────────────────────
// parseTiingoDate — both wire formats
// ───────────────────────────────────────────────────────────────────────────

describe("parseTiingoDate — bare and ISO forms", () => {
  test("the bare CSV form passes through", () => {
    assert.equal(parseTiingoDate("2026-08-25"), "2026-08-25");
  });

  test("the ISO instant form is truncated to its calendar day", () => {
    // Both real offsets: EST (05:00Z) in winter, EDT (04:00Z) in summer. Tiingo
    // is encoding an Eastern calendar day, not a moment.
    assert.equal(parseTiingoDate("1987-11-17T05:00:00.000Z"), "1987-11-17");
    assert.equal(parseTiingoDate("2026-08-25T04:00:00.000Z"), "2026-08-25");
    // declarationDate arrives at 08:00Z — the hour is NOT always midnight-local.
    assert.equal(parseTiingoDate("2026-08-11T08:00:00.000Z"), "2026-08-11");
  });

  test("null, undefined and blank all yield null", () => {
    assert.equal(parseTiingoDate(null), null);
    assert.equal(parseTiingoDate(undefined), null);
    assert.equal(parseTiingoDate(""), null);
    assert.equal(parseTiingoDate("   "), null);
  });

  test("an unrecognised shape yields null rather than an Invalid Date", () => {
    // A reformat upstream must surface as an empty column, never as a
    // `new Date(NaN)` reaching Prisma.
    for (const bad of [
      "25/08/2026",
      "2026-8-5",
      "None",
      "20260825",
      "not-a-date",
    ]) {
      assert.equal(parseTiingoDate(bad), null, `input ${bad}`);
    }
  });

  test("the SAME record in CSV and JSON yields identical days", () => {
    // The strongest available check on the truncation rule: two serializations
    // of one record, captured in the same minute from the same endpoint.
    const csvRow = parseDistributionsCsv(DISTS_MARKET).find(
      (r) => r.permaTicker === "US000000000306",
    );
    assert.ok(csvRow, "pru present in the CSV fixture");

    const jsonRows = JSON.parse(DISTS_MARKET_JSON) as {
      permaTicker: string;
      exDate: string;
      paymentDate: string;
      recordDate: string;
      declarationDate: string;
    }[];
    const jsonRow = jsonRows.find((r) => r.permaTicker === "US000000000306");
    assert.ok(jsonRow, "pru present in the JSON fixture");

    assert.equal(csvRow.exDate, parseTiingoDate(jsonRow.exDate));
    assert.equal(csvRow.paymentDate, parseTiingoDate(jsonRow.paymentDate));
    assert.equal(csvRow.recordDate, parseTiingoDate(jsonRow.recordDate));
    assert.equal(
      csvRow.declarationDate,
      parseTiingoDate(jsonRow.declarationDate),
    );
    // Not vacuously equal-because-both-null.
    assert.equal(csvRow.declarationDate, "2026-08-11");
  });
});

describe("isoDayToUtcDate", () => {
  test("anchors at UTC midnight regardless of the host timezone", () => {
    const d = isoDayToUtcDate("2026-08-25");
    assert.ok(d);
    assert.equal(d.toISOString(), "2026-08-25T00:00:00.000Z");
  });

  test("null in, null out", () => {
    assert.equal(isoDayToUtcDate(null), null);
  });
});

// ───────────────────────────────────────────────────────────────────────────
// parseSplitsCsv
// ───────────────────────────────────────────────────────────────────────────

describe("parseSplitsCsv — real responses", () => {
  test("reads AAPL's five splits with the exact upstream factors", () => {
    const rows = parseSplitsCsv(SPLITS_AAPL);
    assert.equal(rows.length, 5);

    const y2014 = rows.find((r) => r.exDate === "2014-06-09");
    assert.ok(y2014);
    // NEVER equality-test a split factor in production code. Asserting the
    // exact float HERE is the point: it pins that we store what Tiingo sent
    // rather than a rounded 7.
    assert.equal(y2014.splitFactor, 7.000007000007001);
    assert.notEqual(y2014.splitFactor, 7);

    const y2020 = rows.find((r) => r.exDate === "2020-08-31");
    assert.ok(y2020);
    assert.equal(y2020.splitFactor, 4);
  });

  test("a REVERSE split survives as a factor below 1", () => {
    const rows = parseSplitsCsv(SPLITS_GE);
    const reverse = rows.find((r) => r.exDate === "2021-08-02");
    assert.ok(reverse, "GE 2021-08-02 present");
    assert.equal(reverse.splitFactor, 0.125); // a 1-for-8
    assert.ok(reverse.splitFactor < 1);
  });

  test("splitFrom/splitTo are null on historical rows and populated on recent ones", () => {
    // The time cliff, measured: 65 of 67 live split rows carry no ratio. A
    // parser that required it would drop the entire historical majority.
    const ge = parseSplitsCsv(SPLITS_GE);
    const old = ge.find((r) => r.exDate === "2000-05-08");
    assert.ok(old);
    assert.equal(old.splitFrom, null);
    assert.equal(old.splitTo, null);
    assert.equal(old.splitFactor, 3);

    const recent = ge.find((r) => r.exDate === "2024-04-02");
    assert.ok(recent);
    assert.equal(recent.splitFrom, 1000);
    assert.equal(recent.splitTo, 1253);
    assert.equal(recent.splitFactor, 1.253);
  });

  test("the ticker is preserved in the wire (lowercase) casing at parse time", () => {
    // The parse layer is a faithful transcription; the UPPERCASE decision
    // belongs to the mapping layer and is asserted there.
    for (const r of parseSplitsCsv(SPLITS_AAPL)) {
      assert.equal(r.ticker, "aapl");
    }
  });

  test("drops a row whose splitFactor is absent, zero or negative", () => {
    const header = "permaTicker,ticker,exDate,splitFrom,splitTo,splitFactor";
    const body = [
      header,
      "US1,a,2026-01-05,,,2.0", // keep
      "US2,b,2026-01-05,,,", // no factor
      "US3,c,2026-01-05,,,0", // divides by zero downstream
      "US4,d,2026-01-05,,,-2", // flips every historical price
      "US5,e,2026-01-05,,,notanumber",
    ].join("\n");
    const rows = parseSplitsCsv(body);
    assert.deepEqual(
      rows.map((r) => r.permaTicker),
      ["US1"],
    );
  });

  test("THROWS when a required column is missing rather than mis-indexing", () => {
    // It used to return `[]`, which the backfill maps to the TERMINAL status
    // EMPTY — see the F5 suite at the bottom of this file.
    assert.throws(
      () => parseSplitsCsv("permaTicker,ticker,exDate\nUS1,a,2026-01-05"),
      TiingoCorpActionsShapeError,
    );
  });

  test("column order is irrelevant — indexed by header NAME", () => {
    // Reordering the header must not move a single value. This is the property
    // that made the EOD parser survive `close` arriving second.
    const shuffled = [
      "splitFactor,exDate,ticker,splitTo,permaTicker,splitFrom",
      "0.125,2021-08-02,ge,1.0,US000000000045,8.0",
    ].join("\n");
    const rows = parseSplitsCsv(shuffled);
    assert.equal(rows.length, 1);
    assert.deepEqual(rows[0], {
      permaTicker: "US000000000045",
      ticker: "ge",
      exDate: "2021-08-02",
      splitFrom: 8,
      splitTo: 1,
      splitFactor: 0.125,
    });
  });
});

// ───────────────────────────────────────────────────────────────────────────
// parseDistributionsCsv
// ───────────────────────────────────────────────────────────────────────────

describe("parseDistributionsCsv — real responses", () => {
  test("parses every data row of the market-wide day", () => {
    const rows = parseDistributionsCsv(DISTS_MARKET);
    // 190 lines = 1 header + 189 records; the count is asserted so a silent
    // per-row drop cannot hide behind "it parsed".
    assert.equal(DISTS_MARKET.trim().split(/\r?\n/).length, 190);
    assert.equal(rows.length, 189);
    for (const r of rows) {
      assert.equal(r.exDate, "2026-08-25");
      assert.notEqual(r.permaTicker, "");
    }
  });

  test("a genuine 0.0 distribution is preserved as zero, not nulled", () => {
    // AAPL 2022-12-23 is fully date-populated and carries 0.0. Readers filter
    // `> 0`, never `!= null`, and this is the row that makes the difference.
    const rows = parseDistributionsCsv(DISTS_AAPL);
    const zero = rows.find((r) => r.exDate === "2022-12-23");
    assert.ok(zero, "AAPL 2022-12-23 present");
    assert.equal(zero.distribution, 0);
    assert.notEqual(zero.distribution, null);
    // ...and it is a real announced event, not a placeholder.
    assert.equal(zero.paymentDate, "2023-01-09");
    assert.equal(zero.recordDate, "2022-12-28");
    assert.equal(zero.declarationDate, "2022-12-19");
  });

  test("a BLANK distribution cell is null — the other side of the same rule", () => {
    const body = [
      "permaTicker,ticker,exDate,paymentDate,recordDate,declarationDate,distribution,distributionFrequency",
      "US1,a,2026-01-05,,,,,q",
    ].join("\n");
    const rows = parseDistributionsCsv(body);
    assert.equal(rows.length, 1);
    assert.equal(rows[0]!.distribution, null);
  });

  test("the announcement-date nulls are a time cliff, and survive as nulls", () => {
    const rows = parseDistributionsCsv(DISTS_AAPL);
    const partial = rows.find((r) => r.exDate === "2021-08-06");
    assert.ok(partial, "AAPL 2021-08-06 present");
    assert.equal(partial.paymentDate, null);
    assert.equal(partial.recordDate, null);
    assert.equal(partial.declarationDate, null);
    // The row itself is real — only the announcement dates are missing.
    assert.equal(partial.distribution, 0.22);
  });

  test("distributionFrequency is null when blank and preserved when present", () => {
    const aapl = parseDistributionsCsv(DISTS_AAPL);
    assert.equal(aapl[0]!.distributionFrequency, null);

    const market = parseDistributionsCsv(DISTS_MARKET);
    const pru = market.find((r) => r.permaTicker === "US000000000306");
    assert.ok(pru);
    assert.equal(pru.distributionFrequency, "q");
  });

  test("THROWS when a required column is missing", () => {
    assert.throws(
      () => parseDistributionsCsv("permaTicker,exDate\nUS1,2026-01-05"),
      TiingoCorpActionsShapeError,
    );
  });

  test("REFUSES the splits CSV rather than emitting phantom dividends", () => {
    // Found by mutation testing (MONEY-1263), and it was a real hole rather
    // than a test gap. DISTRIBUTION_REQUIRED used to be
    // [permaTicker, ticker, exDate] — every one of which the SPLITS response
    // also carries — so this call returned FIVE rows with real permaTickers,
    // real ex-dates, type DIVIDEND and a null amount: five dividends that never
    // happened, indistinguishable from data. `distribution` is now required
    // BECAUSE it is the column the other feed does not have.
    //
    // The refusal is a THROW as of the F5 fix: returning `[]` made "this is the
    // wrong feed entirely" and "this day was quiet" the same value.
    assert.throws(
      () => parseDistributionsCsv(SPLITS_AAPL),
      TiingoCorpActionsShapeError,
    );
    assert.throws(
      () => parseDistributionsCsv(SPLITS_MARKET),
      TiingoCorpActionsShapeError,
    );
  });

  test("the splits parser refuses the distributions CSV — the mirror case", () => {
    // `splitFactor` is the column distributions lacks, so this direction was
    // already safe THROUGH THE ROW GUARD, which is why removing it from
    // SPLIT_REQUIRED used to be an equivalent mutation. It no longer is: the
    // row guard produces `[]` and the file guard produces a throw, and these
    // assertions can tell them apart.
    assert.throws(
      () => parseSplitsCsv(DISTS_AAPL),
      TiingoCorpActionsShapeError,
    );
    assert.throws(
      () => parseSplitsCsv(DISTS_MARKET),
      TiingoCorpActionsShapeError,
    );
  });

  test("a blank `distribution` CELL is fine — only the COLUMN is required", () => {
    // The required-column rule must not become "required value": 106 of the
    // 189 rows in the market-wide fixture carry blanks somewhere.
    const rows = parseDistributionsCsv(
      [
        "permaTicker,ticker,exDate,paymentDate,recordDate,declarationDate,distribution,distributionFrequency",
        "US1,a,2026-01-05,,,,,",
      ].join("\n"),
    );
    assert.equal(rows.length, 1);
    assert.equal(rows[0]!.distribution, null);
  });

  test("drops a row with an unparseable exDate but keeps its neighbours", () => {
    const body = [
      "permaTicker,ticker,exDate,paymentDate,recordDate,declarationDate,distribution,distributionFrequency",
      "US1,a,2026-01-05,,,,1.0,q",
      "US2,b,notadate,,,,1.0,q",
      "US3,c,2026-01-06,,,,1.0,q",
    ].join("\n");
    assert.deepEqual(
      parseDistributionsCsv(body).map((r) => r.permaTicker),
      ["US1", "US3"],
    );
  });
});

// ───────────────────────────────────────────────────────────────────────────
// toUsCorporateActionRows
// ───────────────────────────────────────────────────────────────────────────

describe("toUsCorporateActionRows — the mapping to Prisma rows", () => {
  test("UPPERCASES the symbol on the SPLIT path", () => {
    // The single most consequential line in the module. The API returns `aapl`;
    // the security master, InstrumentMapping, Candle and every other US table
    // hold `AAPL`. Storing the wire casing makes @@index([symbol, exDate])
    // return zero rows for every consumer — silently.
    const splits = parseSplitsCsv(SPLITS_AAPL);
    assert.equal(splits[0]!.ticker, "aapl", "the wire really is lowercase");

    const rows = toUsCorporateActionRows({ splits });
    assert.equal(rows.length, 5);
    for (const r of rows) {
      assert.equal(r.symbol, "AAPL");
      // The opaque durable id is NOT normalised — it is the unique key, and
      // re-casing a key is how you fail to match the row you already wrote.
      assert.equal(r.permaTicker, "US000000000038");
    }
  });

  test("UPPERCASES the symbol on the DIVIDEND path too", () => {
    // A SEPARATE test because the two branches carry SEPARATE `.toUpperCase()`
    // calls. Mutation testing (MONEY-1263) removed the dividend one and the
    // suite stayed green — the split-only assertion above could not see it,
    // and dividends are the higher-volume half of this table.
    const distributions = parseDistributionsCsv(DISTS_AAPL);
    assert.equal(
      distributions[0]!.ticker,
      "aapl",
      "the wire really is lowercase",
    );

    const rows = toUsCorporateActionRows({ distributions });
    assert.ok(rows.length > 0);
    for (const r of rows) {
      assert.equal(r.symbol, "AAPL");
      assert.equal(r.permaTicker, "US000000000038");
    }
  });

  test("the market-wide day uppercases every distinct ticker it carries", () => {
    // 189 rows across 189 different securities — a per-row transform rather
    // than a constant that happens to be right for one fixture.
    const rows = toUsCorporateActionRows({
      distributions: parseDistributionsCsv(DISTS_MARKET),
    });
    assert.equal(rows.length, 189);
    for (const r of rows) {
      assert.equal(r.symbol, r.symbol.toUpperCase());
      assert.notEqual(r.symbol, "");
    }
    assert.ok(
      rows.some((r) => r.symbol === "JNJ"),
      "jnj -> JNJ",
    );
  });

  test("distributions map to DIVIDEND with no split fields", () => {
    const rows = toUsCorporateActionRows({
      distributions: parseDistributionsCsv(DISTS_AAPL),
    });
    assert.ok(rows.length > 0);
    for (const r of rows) {
      assert.equal(r.type, "DIVIDEND");
      assert.equal(r.splitFactor, null);
      assert.equal(r.splitFrom, null);
      assert.equal(r.splitTo, null);
      assert.equal(r.currency, TIINGO_CORP_ACTION_CURRENCY);
      assert.equal(r.source, TIINGO_CORP_ACTION_SOURCE);
    }
  });

  test("splits map to SPLIT with no dividend or announcement fields", () => {
    const rows = toUsCorporateActionRows({ splits: parseSplitsCsv(SPLITS_GE) });
    assert.ok(rows.length > 0);
    for (const r of rows) {
      assert.equal(r.type, "SPLIT");
      assert.equal(r.distribution, null);
      assert.equal(r.distributionFrequency, null);
      // The splits route has six columns and none of them is an announcement
      // date, so these are structurally null rather than merely unpopulated.
      assert.equal(r.paymentDate, null);
      assert.equal(r.recordDate, null);
      assert.equal(r.declarationDate, null);
    }
  });

  test("dates become UTC-midnight Dates", () => {
    const rows = toUsCorporateActionRows({
      distributions: parseDistributionsCsv(DISTS_AAPL),
    });
    const zero = rows.find(
      (r) => r.exDate.toISOString() === "2022-12-23T00:00:00.000Z",
    );
    assert.ok(zero, "AAPL 2022-12-23 mapped");
    assert.equal(zero.distribution, 0);
    assert.equal(zero.paymentDate?.toISOString(), "2023-01-09T00:00:00.000Z");
  });

  test("both types can be mapped in one call and stay distinguishable", () => {
    const rows = toUsCorporateActionRows({
      distributions: parseDistributionsCsv(DISTS_AAPL),
      splits: parseSplitsCsv(SPLITS_AAPL),
    });
    assert.equal(rows.filter((r) => r.type === "DIVIDEND").length > 0, true);
    assert.equal(rows.filter((r) => r.type === "SPLIT").length, 5);
  });

  test("listingId is null when no listing map is supplied", () => {
    const rows = toUsCorporateActionRows({
      splits: parseSplitsCsv(SPLITS_AAPL),
    });
    for (const r of rows) assert.equal(r.listingId, null);
  });
});

// ───────────────────────────────────────────────────────────────────────────
// resolveListingId
// ───────────────────────────────────────────────────────────────────────────

describe("resolveListingId — window-bounded, refuses rather than guesses", () => {
  const dowInc = {
    listingId: "DOW:NYSE:2019-03-20",
    listingStartDate: "2019-03-20",
    listingEndDate: "2026-08-27",
  };

  test("claims an action inside the window", () => {
    assert.equal(resolveListingId("2021-06-30", dowInc), "DOW:NYSE:2019-03-20");
  });

  test("refuses an action BEFORE the window — the recycled-ticker trap", () => {
    // Dow Chemical's 1990s dividends must not be filed under Dow Inc.'s
    // listing. selectPrimaryListings keeps only the survivor, so a naive
    // Map<ticker, listingId> lookup would do exactly that, silently.
    assert.equal(resolveListingId("1995-04-10", dowInc), null);
  });

  test("refuses an action AFTER the window", () => {
    assert.equal(resolveListingId("2027-01-04", dowInc), null);
  });

  test("the boundaries are INCLUSIVE on both ends", () => {
    assert.equal(resolveListingId("2019-03-20", dowInc), "DOW:NYSE:2019-03-20");
    assert.equal(resolveListingId("2026-08-27", dowInc), "DOW:NYSE:2019-03-20");
  });

  test("a null bound is OPEN, and the bound that IS present still applies", () => {
    const openStart = {
      listingId: "X:NYSE:unknown",
      listingStartDate: null,
      listingEndDate: "2010-01-01",
    };
    assert.equal(resolveListingId("1900-01-01", openStart), "X:NYSE:unknown");
    assert.equal(resolveListingId("2011-01-01", openStart), null);

    const openEnd = {
      listingId: "Y:NYSE:2000-01-01",
      listingStartDate: "2000-01-01",
      listingEndDate: null,
    };
    assert.equal(resolveListingId("2099-01-01", openEnd), "Y:NYSE:2000-01-01");
    assert.equal(resolveListingId("1999-12-31", openEnd), null);
  });

  test("an unknown ticker resolves to null, never to a neighbour", () => {
    assert.equal(resolveListingId("2021-06-30", undefined), null);
  });

  test("the map drives the mapping end-to-end, keyed on the UPPERCASE symbol", () => {
    const listings = new Map([
      [
        "AAPL",
        {
          listingId: "AAPL:NASDAQ:1980-12-12",
          listingStartDate: "1980-12-12",
          listingEndDate: "2026-08-27",
        },
      ],
    ]);
    const rows = toUsCorporateActionRows({
      splits: parseSplitsCsv(SPLITS_AAPL),
      listings,
    });
    // The wire ticker is `aapl`; a map keyed on the master's `AAPL` must still
    // hit, which it only does because the mapping uppercases first.
    for (const r of rows) {
      assert.equal(r.listingId, "AAPL:NASDAQ:1980-12-12");
    }

    // A ticker absent from the map gets null rather than a wrong id.
    const geRows = toUsCorporateActionRows({
      splits: parseSplitsCsv(SPLITS_GE),
      listings,
    });
    for (const r of geRows) assert.equal(r.listingId, null);
  });

  test("an out-of-window action still maps, with a null listingId", () => {
    // The action is REAL and must be stored; only the join is refused. The
    // schema made the column nullable for exactly this.
    const listings = new Map([
      [
        "AAPL",
        {
          listingId: "AAPL:NASDAQ:2020-01-01",
          listingStartDate: "2020-01-01",
          listingEndDate: null,
        },
      ],
    ]);
    const rows = toUsCorporateActionRows({
      splits: parseSplitsCsv(SPLITS_AAPL),
      listings,
    });
    assert.equal(rows.length, 5);
    const old = rows.find(
      (r) => r.exDate.toISOString() === "1987-06-16T00:00:00.000Z",
    );
    assert.ok(old, "the 1987 split is still a row");
    assert.equal(old.listingId, null);

    const recent = rows.find(
      (r) => r.exDate.toISOString() === "2020-08-31T00:00:00.000Z",
    );
    assert.ok(recent);
    assert.equal(recent.listingId, "AAPL:NASDAQ:2020-01-01");
  });
});

// ───────────────────────────────────────────────────────────────────────────
// dedupeCorpActions
// ───────────────────────────────────────────────────────────────────────────

describe("dedupeCorpActions — on the FULL key, never on the ticker", () => {
  test("the two-`reax` day keeps BOTH rows", () => {
    // Measured: splits?exDate=2026-08-25 returns two rows, both ticker "reax",
    // both a 10-to-1 reverse split, with DIFFERENT permaTickers. They are two
    // real companies. A dedupe keyed on ticker deletes one, with no error.
    const parsed = parseSplitsCsv(SPLITS_MARKET);
    assert.equal(parsed.length, 2);
    assert.deepEqual(
      parsed.map((r) => r.ticker),
      ["reax", "reax"],
    );
    assert.notEqual(parsed[0]!.permaTicker, parsed[1]!.permaTicker);

    const { rows, dropped } = dedupeCorpActions(
      toUsCorporateActionRows({ splits: parsed }),
    );
    assert.equal(rows.length, 2, "both companies survive");
    assert.equal(dropped, 0);
    assert.deepEqual(rows.map((r) => r.permaTicker).sort(), [
      "US000000086004",
      "US000000143755",
    ]);
  });

  test("a DIVIDEND and a SPLIT on the same permaTicker and exDate both survive", () => {
    // `type` is in the unique key. A dedupe on (permaTicker, exDate) alone
    // would destroy one of the two.
    const rows = toUsCorporateActionRows({
      distributions: [
        {
          permaTicker: "US1",
          ticker: "abc",
          exDate: "2026-01-05",
          paymentDate: null,
          recordDate: null,
          declarationDate: null,
          distribution: 1.5,
          distributionFrequency: "q",
        },
      ],
      splits: [
        {
          permaTicker: "US1",
          ticker: "abc",
          exDate: "2026-01-05",
          splitFrom: null,
          splitTo: null,
          splitFactor: 2,
        },
      ],
    });
    const { rows: deduped, dropped } = dedupeCorpActions(rows);
    assert.equal(deduped.length, 2);
    assert.equal(dropped, 0);
    assert.deepEqual(deduped.map((r) => r.type).sort(), ["DIVIDEND", "SPLIT"]);
  });

  test("a true full-key collision is collapsed and COUNTED", () => {
    const one = toUsCorporateActionRows({
      splits: parseSplitsCsv(SPLITS_AAPL),
    });
    const { rows, dropped } = dedupeCorpActions([...one, ...one]);
    assert.equal(rows.length, 5);
    assert.equal(dropped, 5, "the collapse is reported, not swallowed");
  });

  test("the FIRST occurrence wins", () => {
    const base = toUsCorporateActionRows({
      splits: [
        {
          permaTicker: "US1",
          ticker: "abc",
          exDate: "2026-01-05",
          splitFrom: null,
          splitTo: null,
          splitFactor: 2,
        },
      ],
    });
    const second: UsCorporateActionRow = { ...base[0]!, splitFactor: 99 };
    const { rows } = dedupeCorpActions([...base, second]);
    assert.equal(rows.length, 1);
    assert.equal(rows[0]!.splitFactor, 2);
  });

  test("an empty input is an empty result, not a crash", () => {
    assert.deepEqual(dedupeCorpActions([]), { rows: [], dropped: 0 });
  });

  test("corpActionKey separates the three key components", () => {
    const [row] = toUsCorporateActionRows({
      splits: parseSplitsCsv(SPLITS_AAPL),
    });
    assert.ok(row);
    assert.equal(
      corpActionKey(row),
      "US000000000038::SPLIT::1987-06-16T00:00:00.000Z",
    );
  });
});

// ───────────────────────────────────────────────────────────────────────────
// enumerateExDates
// ───────────────────────────────────────────────────────────────────────────

describe("enumerateExDates — the day walk", () => {
  test("skips Saturdays and Sundays", () => {
    // 2026-08-21 is a Friday; 22nd Sat, 23rd Sun, 24th Mon.
    const days = enumerateExDates("2026-08-21", "2026-08-25");
    assert.deepEqual(days, ["2026-08-21", "2026-08-24", "2026-08-25"]);
  });

  test("a weekend-only range yields nothing rather than two wasted requests", () => {
    assert.deepEqual(enumerateExDates("2026-08-22", "2026-08-23"), []);
  });

  test("is ASCENDING and inclusive of both bounds", () => {
    const days = enumerateExDates("2026-01-01", "2026-12-31");
    assert.equal(days[0], "2026-01-01");
    assert.equal(days.at(-1), "2026-12-31");
    for (let i = 1; i < days.length; i++) {
      assert.ok(days[i - 1]! < days[i]!, "must ascend");
    }
  });

  test("a full year is ~261 weekdays — the request budget this job is sized on", () => {
    // 2 routes per day, so ~522 requests for a year of history. If this number
    // ever doubles, the weekend skip has stopped working.
    const days = enumerateExDates("2026-01-01", "2026-12-31");
    assert.equal(days.length, 261);
    assert.ok(days.length < 270, "weekends are still being skipped");
  });

  test("crosses a month and a year boundary without dropping a day", () => {
    const days = enumerateExDates("2025-12-30", "2026-01-02");
    // 30th Tue, 31st Wed, 1st Thu, 2nd Fri — all weekdays.
    assert.deepEqual(days, [
      "2025-12-30",
      "2025-12-31",
      "2026-01-01",
      "2026-01-02",
    ]);
  });

  test("handles a leap day", () => {
    const days = enumerateExDates("2028-02-28", "2028-03-01");
    // 2028-02-29 is a Tuesday.
    assert.ok(days.includes("2028-02-29"));
  });

  test("an inverted or unparseable range yields nothing rather than looping", () => {
    assert.deepEqual(enumerateExDates("2026-08-25", "2026-08-21"), []);
    assert.deepEqual(enumerateExDates("nonsense", "2026-08-25"), []);
    assert.deepEqual(enumerateExDates("2026-08-25", ""), []);
  });

  test("a single-weekday range yields exactly that day", () => {
    assert.deepEqual(enumerateExDates("2026-08-25", "2026-08-25"), [
      "2026-08-25",
    ]);
  });
});

// ───────────────────────────────────────────────────────────────────────────
// The client's URL + archive key — pure halves, no network
// ───────────────────────────────────────────────────────────────────────────

describe("buildCorpActionsUrl", () => {
  test("sends exDate and format=csv, and nothing else", () => {
    const url = buildCorpActionsUrl("splits", "2026-08-25");
    assert.equal(
      url,
      "https://api.tiingo.com/tiingo/corporate-actions/splits?exDate=2026-08-25&format=csv",
    );
    // `columns=` is documented but SILENTLY IGNORED on these routes. Sending it
    // would look like a bandwidth optimisation that never happened.
    assert.ok(!url.includes("columns"));
    // There is no market-wide range query — those params are rejected here.
    assert.ok(!url.includes("startExDate"));
    assert.ok(!url.includes("endExDate"));
  });

  test("format=csv is present on both routes", () => {
    for (const feed of ["splits", "distributions"]) {
      assert.ok(buildCorpActionsUrl(feed, "2026-08-25").includes("format=csv"));
    }
  });
});

describe("corpActionsDescriptor — one archive object per route per day", () => {
  test("each ex-date gets its OWN key", () => {
    // The URL path ends in `splits` for every day alike, so without a basename
    // buildFeedArchiveKey derives one name for the whole feed and all 261 days
    // a year overwrite one another.
    const a = buildFeedArchiveKey(
      corpActionsDescriptor("splits", "2026-08-25"),
      buildCorpActionsUrl("splits", "2026-08-25"),
    );
    const b = buildFeedArchiveKey(
      corpActionsDescriptor("splits", "2026-08-26"),
      buildCorpActionsUrl("splits", "2026-08-26"),
    );
    assert.notEqual(a, b);
    assert.ok(a.includes("splits-2026-08-25"));
    assert.ok(b.includes("splits-2026-08-26"));
  });

  test("the two routes never collide on one day", () => {
    const day = "2026-08-25";
    const s = buildFeedArchiveKey(
      corpActionsDescriptor("splits", day),
      buildCorpActionsUrl("splits", day),
    );
    const d = buildFeedArchiveKey(
      corpActionsDescriptor("distributions", day),
      buildCorpActionsUrl("distributions", day),
    );
    assert.notEqual(s, d);
    assert.ok(s.startsWith("feeds/TIINGO/splits/"));
    assert.ok(d.startsWith("feeds/TIINGO/distributions/"));
  });

  test("is DATED, not `current/`, and keeps the .csv extension", () => {
    const key = buildFeedArchiveKey(
      corpActionsDescriptor("distributions", "2026-08-25"),
      buildCorpActionsUrl("distributions", "2026-08-25"),
    );
    assert.ok(key.includes("/2026/08/"), `dated prefix missing in ${key}`);
    assert.ok(!key.includes("/current/"));
    // Without the extension the object archives as application/octet-stream.
    assert.ok(key.endsWith(".csv"));
  });

  test("the UTC-noon anchor keeps a month-end day in its own month", () => {
    // buildFeedArchiveKey runs the date through toIstDateKey (+5:30). A
    // UTC-23:00 anchor would push 2026-08-31 into September's prefix; noon
    // cannot straddle in either direction.
    const key = buildFeedArchiveKey(
      corpActionsDescriptor("splits", "2026-08-31"),
      buildCorpActionsUrl("splits", "2026-08-31"),
    );
    assert.ok(key.includes("/2026/08/"), `wrong month prefix: ${key}`);

    const jan = buildFeedArchiveKey(
      corpActionsDescriptor("splits", "2026-01-01"),
      buildCorpActionsUrl("splits", "2026-01-01"),
    );
    assert.ok(jan.includes("/2026/01/"), `wrong month prefix: ${jan}`);
  });

  test("the key is STABLE across calls for the same route and day", () => {
    // Replay depends on it: an unstable key misses forever and falls back to
    // the exchange, silently, while the logs claim the archive is live.
    const args = ["splits", "2026-08-25"] as const;
    assert.equal(
      buildFeedArchiveKey(
        corpActionsDescriptor(...args),
        buildCorpActionsUrl(...args),
      ),
      buildFeedArchiveKey(
        corpActionsDescriptor(...args),
        buildCorpActionsUrl(...args),
      ),
    );
  });
});

// ───────────────────────────────────────────────────────────────────────────
// F5 — a renamed column must NOT read as "nothing happened"
// ───────────────────────────────────────────────────────────────────────────

describe("TiingoCorpActionsShapeError — a shape failure is not an empty day", () => {
  /** The live distributions header, with one column renamed. */
  const distsHeaderMinus = (drop: string): string =>
    [
      "permaTicker,ticker,exDate,paymentDate,recordDate,declarationDate,distribution,distributionFrequency"
        .split(",")
        .map((c) => (c === drop ? `${c}Renamed` : c))
        .join(","),
      "US000000000038,aapl,2026-08-11,2026-08-14,2026-08-11,2026-07-31,0.26,q",
    ].join("\n");

  test("a RENAMED `distribution` column throws instead of returning zero rows", () => {
    // THE defect. `distribution` is required by the parser and is NOT in
    // `FEED_SHAPES["TIINGO/distributions"].requiredTokens` (permaTicker,
    // exDate), so a rename passes archive validation, archives a healthy
    // object, and used to parse to []. The backfill maps [] to the TERMINAL
    // status EMPTY, so the whole requested range became "nothing happened".
    const body = distsHeaderMinus("distribution");
    // The archive's own gate really does let this through — asserted rather
    // than asserted-about, so the two rules cannot silently converge.
    assert.ok(body.includes("permaTicker"));
    assert.ok(body.includes("exDate"));

    assert.throws(
      () => parseDistributionsCsv(body),
      (err: unknown) => {
        assert.ok(err instanceof TiingoCorpActionsShapeError);
        assert.equal(err.feed, "distributions");
        assert.deepEqual([...err.missing], ["distribution"]);
        assert.ok(err.header.includes("distributionRenamed"));
        return true;
      },
    );
  });

  test("every required column is individually load-bearing on BOTH routes", () => {
    // Not one representative case: each name is dropped in turn, so a list that
    // quietly loses an entry fails here rather than in production.
    for (const col of ["permaTicker", "ticker", "exDate", "distribution"]) {
      assert.throws(
        () => parseDistributionsCsv(distsHeaderMinus(col)),
        TiingoCorpActionsShapeError,
        `distributions must refuse a renamed ${col}`,
      );
    }

    const splitsHeaderMinus = (drop: string): string =>
      [
        "permaTicker,ticker,exDate,splitFrom,splitTo,splitFactor"
          .split(",")
          .map((c) => (c === drop ? `${c}Renamed` : c))
          .join(","),
        "US000000000038,aapl,2020-08-31,1.0,4.0,4.0",
      ].join("\n");
    for (const col of ["permaTicker", "ticker", "exDate", "splitFactor"]) {
      assert.throws(
        () => parseSplitsCsv(splitsHeaderMinus(col)),
        TiingoCorpActionsShapeError,
        `splits must refuse a renamed ${col}`,
      );
    }
  });

  test("the error names the missing column AND the header it did get", () => {
    // An operator has to be able to act on this without diffing two CSVs by
    // hand — "a required column is missing" is not a diagnosis.
    try {
      parseSplitsCsv("permaTicker,ticker,exDate\nUS1,a,2026-01-05");
      assert.fail("expected a shape error");
    } catch (err) {
      assert.ok(err instanceof TiingoCorpActionsShapeError);
      assert.equal(err.feed, "splits");
      assert.match(err.message, /splitFactor/);
      assert.match(err.message, /permaTicker, ticker, exDate/);
      assert.match(err.message, /SHAPE failure, not an\s+empty day/);
    }
  });

  test("an EMPTY day is still empty — the guard must not fire on `None`", () => {
    // The direction that would be far worse: `None` has no comma, so without
    // the explicit empty-body check the shape guard would refuse the single
    // COMMONEST response in the walk and circuit-break every market holiday.
    assert.deepEqual(parseDistributionsCsv(EMPTY_DAY), []);
    assert.deepEqual(parseSplitsCsv(EMPTY_DAY), []);
    for (const body of ["[]", "{}", "", "   \n ", "\r\n"]) {
      assert.deepEqual(
        parseDistributionsCsv(body),
        [],
        `body ${JSON.stringify(body)}`,
      );
      assert.deepEqual(
        parseSplitsCsv(body),
        [],
        `body ${JSON.stringify(body)}`,
      );
    }
  });

  test("a VALID header with no data rows is an empty day, not a shape failure", () => {
    // A corrected upstream serializer would emit exactly this for a quiet day.
    assert.deepEqual(
      parseDistributionsCsv(
        "permaTicker,ticker,exDate,paymentDate,recordDate,declarationDate,distribution,distributionFrequency",
      ),
      [],
    );
    assert.deepEqual(
      parseSplitsCsv("permaTicker,ticker,exDate,splitFrom,splitTo,splitFactor"),
      [],
    );
  });

  test("a ONE-LINE body with a WRONG header still throws", () => {
    // The header is checked BEFORE the "any data rows?" test. Reversed, an
    // error page or a swapped feed that happened to be a single line would fall
    // out as a benign zero-row day — the exact reading this fix removes.
    assert.throws(
      () => parseDistributionsCsv("<h1>Not Found</h1>"),
      TiingoCorpActionsShapeError,
    );
    assert.throws(
      () => parseSplitsCsv("permaTicker,ticker,exDate"),
      TiingoCorpActionsShapeError,
    );
  });

  test("real responses still parse — the guard costs nothing on the happy path", () => {
    assert.equal(parseDistributionsCsv(DISTS_MARKET).length, 189);
    assert.equal(parseSplitsCsv(SPLITS_MARKET).length, 2);
    assert.equal(parseSplitsCsv(SPLITS_AAPL).length, 5);
    assert.equal(parseDistributionsCsv(DISTS_AAPL).length > 0, true);
  });

  test("a column ORDER change is not a shape failure", () => {
    // Indexed by NAME. Reordering must stay free, or the guard becomes a reason
    // to fear an upstream that reorders columns for its own reasons.
    assert.equal(
      parseSplitsCsv(
        [
          "splitFactor,exDate,ticker,splitTo,permaTicker,splitFrom",
          "0.125,2021-08-02,ge,1.0,US000000000045,8.0",
        ].join("\n"),
      ).length,
      1,
    );
  });
});

// ───────────────────────────────────────────────────────────────────────────
// F6 — a missing API key is an immediate stop, not four quota charges
// ───────────────────────────────────────────────────────────────────────────

describe("getArchived — the auth header is built OUTSIDE the retry ladder", () => {
  /**
   * Runs `fn` with `TIINGO_API_KEY` removed, restoring it afterwards.
   *
   * `delete`, not `= ""`: `apiKey()` tests `?.trim()` falsiness, so both work,
   * but an empty string is a state the process can be left in and an absent var
   * is not.
   */
  async function withoutApiKey<T>(fn: () => Promise<T>): Promise<T> {
    const saved = process.env.TIINGO_API_KEY;
    delete process.env.TIINGO_API_KEY;
    try {
      return await fn();
    } finally {
      if (saved === undefined) delete process.env.TIINGO_API_KEY;
      else process.env.TIINGO_API_KEY = saved;
    }
  }

  for (const [name, call] of [
    ["distributions", () => fetchDistributionsByExDate("2026-08-25")],
    ["splits", () => fetchSplitsByExDate("2026-08-25")],
  ] as const) {
    test(`${name}: an unset TIINGO_API_KEY fails IMMEDIATELY, with no retries`, async () => {
      const started = Date.now();
      await withoutApiKey(async () => {
        await assert.rejects(call, /TIINGO_API_KEY is not set/);
      });
      const elapsed = Date.now() - started;

      // THE assertion, and the only one that can see the defect. Built inside
      // the `try`, the throw carried no HTTP status, so `decideTiingoFailure`
      // classified it "other" and the ladder retried it: 4 attempts, 4
      // `paceTiingoRequest()` calls charged against the account-wide quota, and
      // 5s + 10s + 20s = ~35s of backoff PER SYMBOL — surfacing as a generic
      // failure rather than as the auth stop callers circuit-break on.
      //
      // 2s is far below the first rung (5s) and far above anything a hoisted
      // throw can cost, so this cannot pass by accident in either direction.
      assert.ok(
        elapsed < 2_000,
        `took ${elapsed}ms — the header build is back inside the retry ladder`,
      );
    });
  }

  test("the failure is the KEY's, not the network's — no request is issued", async () => {
    // Proven by the message rather than by a spy: `apiKey()` is the only thing
    // in this path that says "TIINGO_API_KEY is not set", and it runs before
    // `paceTiingoRequest()` and before `getFeedAsset`. A request that had been
    // issued would surface a fetch/DNS/HTTP message instead.
    await withoutApiKey(async () => {
      await assert.rejects(
        () => fetchSplitsByExDate("2026-08-25"),
        (err: unknown) => {
          assert.ok(err instanceof Error);
          assert.match(err.message, /required for every api\.tiingo\.com call/);
          return true;
        },
      );
    });
  });
});
