/**
 * MONEY-1613 — the weekend special-session calendar, the date-column check
 * that decides whether a fetched file IS that session, the walk plan, and the
 * archive seam refusing to store a file that is not.
 */
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { deflateRawSync } from "node:zlib";

import {
  FAMILIES_WITHOUT_DATE_COLUMN,
  INDIA_SPECIAL_SESSION_WEEKENDS,
  checkSessionDate,
  readFileSessionDates,
  specialSessionCandidateDates,
} from "../../src/market-data/india-special-sessions";
import {
  isoDay,
  planSpecialSessions,
} from "../../src/market-data/feed-backfill-logic";
import {
  emptyFeedAssetOutcome,
  getFeedAsset,
  setFeedArchiveStore,
  type FeedArchiveStore,
} from "../../src/market-data/feed-archive";
import { familyById } from "../../src/market-data/report-registry";

const dow = (iso: string) => new Date(`${iso}T00:00:00Z`).getUTCDay();
const byEvidence = (e: string) =>
  INDIA_SPECIAL_SESSION_WEEKENDS.filter((w) => w.evidence === e).map(
    (w) => w.anchor,
  );

describe("the special-session calendar", () => {
  it("holds the 45 measured weekends: 4 exact, 34 sat-or-sun, 7 sat-to-mon", () => {
    assert.equal(INDIA_SPECIAL_SESSION_WEEKENDS.length, 45);
    assert.deepEqual(byEvidence("exact"), [
      "2019-10-27",
      "2020-11-14",
      "2024-01-20",
      "2024-05-18",
    ]);
    assert.equal(byEvidence("sat-or-sun").length, 34);
    assert.deepEqual(byEvidence("sat-to-mon"), [
      "1995-09-02",
      "1997-04-12",
      "1999-11-06",
      "2006-04-29",
      "2009-10-17",
      "2013-11-02",
      "2016-10-29",
    ]);
    const anchors = INDIA_SPECIAL_SESSION_WEEKENDS.map((w) => w.anchor);
    assert.equal(new Set(anchors).size, anchors.length);
  });

  it("every exact date is a weekend; every other anchor is a Saturday", () => {
    for (const d of byEvidence("exact")) assert.ok([0, 6].includes(dow(d)), d);
    for (const d of [...byEvidence("sat-or-sun"), ...byEvidence("sat-to-mon")])
      assert.equal(dow(d), 6, d);
  });

  it("expands to 93 dates to try — 4 + 34x2 + 7x3 — ascending, each once", () => {
    const dates = specialSessionCandidateDates();
    assert.equal(dates.length, 93);
    assert.deepEqual(dates, [...new Set(dates)].sort());
    assert.ok(dates.includes("2020-02-01") && dates.includes("2020-02-02"));
    assert.ok(dates.includes("2016-10-31"), "sat-to-mon tries the Monday");
    assert.ok(!dates.includes("2019-10-26"), "an exact date tries only itself");
  });

  it("only the seven sat-to-mon Mondays are weekdays", () => {
    const weekdays = specialSessionCandidateDates().filter(
      (d) => ![0, 6].includes(dow(d)),
    );
    assert.equal(weekdays.length, 7);
    for (const d of weekdays) assert.equal(dow(d), 1, d);
  });

  it("the weekday 2021-11-04 Muhurat is not in it", () => {
    assert.ok(!specialSessionCandidateDates().includes("2021-11-04"));
  });
});

/** A one-entry zip, as NSE serves its bhavcopies. */
function zipOf(content: string): Buffer {
  const name = Buffer.from("bhav.csv", "ascii");
  const raw = Buffer.from(content, "utf-8");
  const body = deflateRawSync(raw);
  const header = Buffer.alloc(30);
  header.writeUInt32LE(0x04034b50, 0);
  header.writeUInt16LE(20, 4);
  header.writeUInt16LE(8, 8);
  header.writeUInt32LE(body.length, 18);
  header.writeUInt32LE(raw.length, 22);
  header.writeUInt16LE(name.length, 26);
  return Buffer.concat([header, name, body]);
}

const UDIFF = (d: string) =>
  "TradDt,BizDt,Sgmt,Src,FinInstrmTp,TckrSymb,ClsPric\n" +
  `${d},${d},CM,NSE,STK,RELIANCE,2900\n${d},${d},CM,NSE,STK,TCS,4000\n`;
const CM_LEGACY = (d: string) =>
  "SYMBOL,SERIES,OPEN,HIGH,LOW,CLOSE,LAST,PREVCLOSE,TOTTRDQTY,TOTTRDVAL,TIMESTAMP,TOTALTRADES,ISIN,\n" +
  `RELIANCE,EQ,1,2,1,2,2,1,10,20,${d},5,INE002A01018,\n`;
const SEC_FULL = (d: string) =>
  "SYMBOL, SERIES, DATE1, PREV_CLOSE, CLOSE_PRICE, DELIV_QTY\n" +
  `RELIANCE, EQ, ${d}, 1, 2, 3\n`;
const INDICES = (d: string) =>
  '"Index Name","Index Date","Open Index Value","Closing Index Value"\n' +
  `"Nifty 50, TRI","${d}","1","2"\n"Nifty Bank","${d}","1","2"\n`;
const BSE_ISIN = (d: string) =>
  "SC_CODE,SC_NAME,CLOSE,ISIN_CODE,TRADING_DATE,FILLER2\n" +
  `500325,RELIANCE,2900,INE002A01018,${d},\n`;
const BSE_EQ_NO_DATE =
  "SC_CODE,SC_NAME,SC_GROUP,SC_TYPE,OPEN,HIGH,LOW,CLOSE,LAST,PREVCLOSE\n" +
  "500325,RELIANCE,A,Q,1,2,1,2,2,1\n";

describe("readFileSessionDates — the file's own date column", () => {
  it("reads each family's column and format", () => {
    const cases: [string, string, string][] = [
      [UDIFF("2024-01-20"), "TRADDT", "2024-01-20"],
      [CM_LEGACY("27-OCT-2019"), "TIMESTAMP", "2019-10-27"],
      [SEC_FULL("27-Oct-2019"), "DATE1", "2019-10-27"],
      [INDICES("27-10-2019"), "INDEX DATE", "2019-10-27"],
      [BSE_ISIN("20-Jan-24"), "TRADING_DATE", "2024-01-20"],
    ];
    for (const [csv, column, date] of cases) {
      assert.deepEqual(readFileSessionDates(csv), {
        column,
        dates: [date],
        unparsed: 0,
        trailers: 0,
        numericDayMonth: column === "INDEX DATE",
      });
    }
  });
  it("a file with no date column -> null (BSE eq csv, an HTML page)", () => {
    assert.equal(readFileSessionDates(BSE_EQ_NO_DATE), null);
    assert.equal(readFileSessionDates("<!DOCTYPE html><html></html>"), null);
  });
  it("a rolled-over day does not parse", () => {
    assert.equal(readFileSessionDates(INDICES("31-02-2020"))?.unparsed, 2);
  });
});

/** NSE's regenerated fo14MAY2012bhav — the MONEY-1618 shape, `*Updated` trailer. */
const FO_CSV_REGENERATED = [
  "INSTRUMENT,SYMBOL,EXPIRY_DT,STRIKE_PR,OPTION_TYP,OPEN,HIGH,LOW,CLOSE,SETTLE_PR,CONTRACTS,VAL_INLAKH,OPEN_INT,CHG_IN_OI,TIMESTAMP",
  "FUTIDX,BANKNIFTY,31-May-12,0,XX,9424,9450,9132,9179.7,9179.7,73169,169860.22,2263125,157850,14-May-12",
  "OPTSTK,ZEEL,26-Jul-12,200,PE,0,0,0,71.25,73.75,0,0,0,0,14-May-12",
  "",
  "*Updated",
  "",
].join("\r\n");

describe("checkSessionDate — is this file that session?", () => {
  it("a regenerated file's `*Updated` trailer is skipped, not unreadable -> ok", () => {
    assert.deepEqual(readFileSessionDates(FO_CSV_REGENERATED), {
      column: "TIMESTAMP",
      dates: ["2012-05-14"],
      unparsed: 0,
      trailers: 1,
      numericDayMonth: false,
    });
    assert.deepEqual(
      checkSessionDate(zipOf(FO_CSV_REGENERATED), "2012-05-14"),
      { ok: true },
    );
  });
  it("a DD-MM date that is the requested day with day and month swapped -> retried, not terminal", () => {
    // ind_close_all_06042023 wrote MM-DD: "04-06-2023" reads as 4 June.
    const r = checkSessionDate(
      Buffer.from(INDICES("04-06-2023")),
      "2023-04-06",
    );
    assert.equal(r.ok, false);
    assert.equal(!r.ok && r.terminal, false);
    // The same shape holding a day that is NOT a swap stays terminal.
    const s = checkSessionDate(
      Buffer.from(INDICES("05-06-2023")),
      "2023-04-06",
    );
    assert.equal(!s.ok && s.terminal, true);
    // A swap only counts for the numeric DD-MM shape.
    const t = checkSessionDate(Buffer.from(UDIFF("2023-06-04")), "2023-04-06");
    assert.equal(!t.ok && t.terminal, true);
  });
  it("every row on the requested day -> ok, zipped or not", () => {
    assert.deepEqual(
      checkSessionDate(zipOf(CM_LEGACY("27-OCT-2019")), "2019-10-27"),
      { ok: true },
    );
    assert.deepEqual(
      checkSessionDate(Buffer.from(SEC_FULL("27-Oct-2019")), "2019-10-27"),
      { ok: true },
    );
  });
  it("a stale copy of another day -> refused, TERMINAL, naming the day it holds", () => {
    const r = checkSessionDate(
      Buffer.from(SEC_FULL("25-Oct-2019")),
      "2019-10-26",
    );
    assert.deepEqual(r, {
      ok: false,
      terminal: true,
      reason: "DATE1 holds 2019-10-25, not 2019-10-26",
    });
  });
  it("a file mixing the day with another -> refused, retried", () => {
    const mixed =
      UDIFF("2024-01-20") + "2024-01-19,2024-01-19,CM,NSE,STK,X,1\n";
    const r = checkSessionDate(Buffer.from(mixed), "2024-01-20");
    assert.equal(r.ok, false);
    assert.equal(!r.ok && r.terminal, false);
  });
  it("no date column, an unreadable cell, no rows, a broken zip -> refused, retried", () => {
    for (const body of [
      Buffer.from(BSE_EQ_NO_DATE),
      Buffer.from(INDICES("31-02-2020")),
      // one unreadable date beside good ones still cannot prove the session
      Buffer.from(INDICES("01-02-2020") + '"Nifty IT","01/02/2020","1","2"\n'),
      Buffer.from("TradDt,TckrSymb\n"),
      Buffer.from("PK\x03\x04 not really a zip at all, just the magic"),
    ]) {
      const r = checkSessionDate(body, "2020-02-01");
      assert.equal(r.ok, false);
      assert.equal(!r.ok && r.terminal, false, String(!r.ok && r.reason));
    }
  });
});

describe("planSpecialSessions — only the calendar, only in the family's era", () => {
  const family = familyById("nse-sec-bhavdata-full")!;
  const cal = specialSessionCandidateDates();

  it("walks exactly the calendar dates in the window, newest first", () => {
    const plan = planSpecialSessions(
      family,
      "2019-10-01",
      "2020-12-31",
      new Set(),
      cal,
    );
    assert.deepEqual(plan.days.map(isoDay), [
      "2020-11-14",
      "2020-02-02",
      "2020-02-01",
      "2019-10-27",
    ]);
    assert.equal(plan.floorIso, "2019-10-01");
  });
  it("skips what is already terminal", () => {
    const plan = planSpecialSessions(
      family,
      "2019-10-01",
      "2020-12-31",
      new Set(["2020-02-01", "2019-10-27"]),
      cal,
    );
    assert.deepEqual(plan.days.map(isoDay), ["2020-11-14", "2020-02-02"]);
  });
  it("refuses a range-addressed family", () => {
    assert.throws(
      () =>
        planSpecialSessions(
          familyById("bse-index-history")!,
          "2019-01-01",
          "2020-01-01",
          new Set(),
          cal,
        ),
      /chunkDays/,
    );
  });
});

describe("getFeedAsset's accept: a stale copy never reaches the archive", () => {
  const URL_27 =
    "https://nsearchives.nseindia.com/products/content/sec_bhavdata_full_27102019.csv";
  const DESC = {
    exchange: "NSE" as const,
    feed: "sec-bhavdata-full",
    date: new Date("2019-10-27T12:00:00Z"),
  };
  const KEY =
    "feeds/NSE/sec-bhavdata-full/2019/10/sec_bhavdata_full_27102019.csv";
  const accept = (b: Buffer) => checkSessionDate(b, "2019-10-27");
  const realFetch = globalThis.fetch;
  let puts: string[] = [];
  let fetches = 0;
  let seeded: Buffer | null = null;
  const store: FeedArchiveStore = {
    async get() {
      return seeded;
    },
    async put(key) {
      puts.push(key);
    },
  };
  const serve = (body: string) => {
    globalThis.fetch = (async () => {
      fetches++;
      return new Response(body, { status: 200 });
    }) as unknown as typeof fetch;
  };

  beforeEach(() => {
    puts = [];
    fetches = 0;
    seeded = null;
    setFeedArchiveStore(store);
  });
  afterEach(() => {
    globalThis.fetch = realFetch;
    setFeedArchiveStore(null);
    delete process.env.FEED_ARCHIVE_MODE;
  });

  it("archive mode: another day's file is NOT stored, and is reported rejected", async () => {
    process.env.FEED_ARCHIVE_MODE = "archive";
    serve(SEC_FULL("25-Oct-2019"));
    const outcome = emptyFeedAssetOutcome();
    const res = await getFeedAsset(
      URL_27,
      "r",
      DESC,
      outcome,
      undefined,
      accept,
    );
    assert.deepEqual(puts, []);
    assert.equal(outcome.rejected, true);
    assert.ok(res, "the bytes still reach the caller, which names the refusal");
  });
  it("archive mode: the session's own file IS stored under its key", async () => {
    process.env.FEED_ARCHIVE_MODE = "archive";
    serve(SEC_FULL("27-Oct-2019"));
    const outcome = emptyFeedAssetOutcome();
    await getFeedAsset(URL_27, "r", DESC, outcome, undefined, accept);
    assert.deepEqual(puts, [KEY]);
    assert.equal(outcome.stored, true);
  });
  it("replay mode: an archived object accept refuses is a MISS", async () => {
    process.env.FEED_ARCHIVE_MODE = "replay";
    seeded = Buffer.from(SEC_FULL("25-Oct-2019"));
    serve(SEC_FULL("27-Oct-2019"));
    await getFeedAsset(URL_27, "r", DESC, undefined, undefined, accept);
    assert.equal(fetches, 1);
  });
});

describe("feed-backfill wires the special-session walk", () => {
  // Wiring only — the script calls main() at import. Resolved from THIS file.
  const src = readFileSync(
    join(
      import.meta.dirname,
      "..",
      "..",
      "..",
      "..",
      "scripts",
      "jobs",
      "feed-backfill.ts",
    ),
    "utf8",
  );
  it("the date check reaches the archive seam as its accept", () => {
    assert.match(
      src,
      /\? \(b: Buffer\) => checkSessionDate\(b, isoDay\(day\)\)/,
    );
    assert.match(
      src,
      /getFeedAsset\(\s*url,\s*referer,\s*descriptor,\s*outcome,\s*undefined,\s*sessionCheck,\s*\)/,
    );
  });
  it("another day's file is MISSING; anything unproven is a retried ERROR", () => {
    assert.match(
      src,
      /return session\.terminal\s*\?\s*\{\s*status: "MISSING"[\s\S]{0,200}: \{\s*status: "ERROR",\s*kind: "payload"/,
    );
  });
  it("DONE requires the object to have been STORED in archive mode", () => {
    assert.match(
      src,
      /const outcome = emptyFeedAssetOutcome\(\);\s*const res = await getFeedAsset\(\s*url,\s*referer,\s*descriptor,\s*outcome,/,
    );
    assert.match(
      src,
      /if \(resolveFeedArchiveMode\(\) === "archive" && !outcome\.stored\) \{\s*[\s\S]{0,400}status: "ERROR",[\s\S]{0,200}\}\s*return \{ status: "DONE", bytes: buf\.length \};/,
    );
  });
  it("bse-cm-legacy (no date column) is not in the default special-session families", () => {
    assert.deepEqual([...FAMILIES_WITHOUT_DATE_COLUMN], ["bse-cm-legacy"]);
    assert.match(
      src,
      /allIndiaFamilies\(\)\.filter\(\s*\(f\) => !FAMILIES_WITHOUT_DATE_COLUMN\.includes\(f\),?\s*\)/,
    );
    // It genuinely cannot pass the check.
    assert.equal(readFileSessionDates(BSE_EQ_NO_DATE), null);
  });
  it("the plan is the calendar's, and the walk refuses outside archive mode", () => {
    assert.match(
      src,
      /planSpecialSessions\(family, from, to, done, candidates\)/,
    );
    assert.match(
      src,
      /SPECIAL_SESSIONS && !DRY_RUN && resolveFeedArchiveMode\(\) !== "archive"/,
    );
  });
});
