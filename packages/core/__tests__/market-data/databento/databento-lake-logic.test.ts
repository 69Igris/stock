/**
 * MONEY-1505 (B5) — the lake bar loader's pure decisions.
 *
 * Every case here is one the loader gets wrong SILENTLY if the guard is
 * removed: a wrong table name, an unstable ledger key, a month a file never
 * belonged to, a coverage denominator counting sessions that never existed.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  EmptyPlanError,
  LAKE_LOADABLE_SCHEMAS,
  LAKE_TRADE_BAR_TABLES,
  SchemaNotLoadableError,
  TRADE_BAR_PARSER_VERSION,
  archiveFileDateRange,
  archiveFileSymbol,
  assertPlannedMonths,
  filesMayOverlap,
  lastDateOfMonth,
  monthKeyOf,
  monthsBetween,
  monthsForArchiveFile,
  monthsOfYear,
  numeric,
  parseDatabentoArchiveKey,
  planMonthPartitions,
  spreadCostPartitionKey,
  toTradeBarRow,
  tradeBarMonthWindow,
  tradeBarPartitionKey,
  tradeBarSourceHash,
  tradeBarTableFor,
  tradeBarTimeframeFor,
  volumeToInt64String,
} from "../../../src/market-data/databento/databento-lake-logic";
import { databentoArchiveKey } from "../../../src/market-data/databento/databento-logic";

/* ─────────────────────────────────────────────────────────────────────────
   The ohlcv-1s guard — the prompt asks for a test that FAILS if any loader
   targets it
   ──────────────────────────────────────────────────────────────────────── */

describe("ohlcv-1s can never reach a bar table", () => {
  it("LAKE_LOADABLE_SCHEMAS is pinned BY VALUE", () => {
    // By value, not by "does not include": a list that has drifted to []
    // satisfies every negative assertion below while loading nothing.
    assert.deepEqual([...LAKE_LOADABLE_SCHEMAS], ["ohlcv-1m", "ohlcv-1h"]);
  });

  it("the table map has no ohlcv-1s entry", () => {
    assert.equal(
      Object.prototype.hasOwnProperty.call(LAKE_TRADE_BAR_TABLES, "ohlcv-1s"),
      false,
    );
  });

  it("tradeBarTableFor THROWS on ohlcv-1s and names why", () => {
    // Not `undefined`. An undefined table renders as
    // `lake_silver_prod.undefined`, which BigQuery answers "not found" and an
    // operator reads as a missing DDL migration.
    assert.throws(
      () => tradeBarTableFor("ohlcv-1s"),
      (err: unknown) => {
        assert.ok(err instanceof SchemaNotLoadableError);
        assert.match(err.message, /ohlcv-1s/);
        assert.match(err.message, /ARCHIVE-ONLY/i);
        return true;
      },
    );
  });

  it("the quote/trade schemas are refused with their OWN reason", () => {
    for (const schema of ["bbo-1m", "tbbo"]) {
      assert.throws(
        () => tradeBarTableFor(schema),
        /quote\/trade record/,
        `${schema} must be refused as a record schema, not as a bar one`,
      );
    }
  });

  it("an unknown schema is refused rather than defaulted", () => {
    assert.throws(() => tradeBarTableFor("ohlcv-1d"), SchemaNotLoadableError);
    assert.throws(() => tradeBarTableFor(""), SchemaNotLoadableError);
  });
});

describe("schema -> table and timeframe", () => {
  it("maps the two loadable schemas", () => {
    assert.equal(tradeBarTableFor("ohlcv-1m"), "trade_bar_m1");
    assert.equal(tradeBarTableFor("ohlcv-1h"), "trade_bar_h1");
  });

  it("the timeframe literals are M1 / H1, never the vendor's 1m / 1h", () => {
    assert.equal(tradeBarTimeframeFor("ohlcv-1m"), "M1");
    assert.equal(tradeBarTimeframeFor("ohlcv-1h"), "H1");
    assert.notEqual(tradeBarTimeframeFor("ohlcv-1m"), "1m");
  });

  it("tradeBarTimeframeFor refuses ohlcv-1s too", () => {
    // The timeframe map DOES carry `ohlcv-1s: "S1"`, so without the
    // `tradeBarTableFor` call inside it this would happily answer "S1" and a
    // caller would key stage objects under a timeframe no table accepts.
    assert.throws(
      () => tradeBarTimeframeFor("ohlcv-1s"),
      SchemaNotLoadableError,
    );
  });
});

/* ─────────────────────────────────────────────────────────────────────────
   The ledger key
   ──────────────────────────────────────────────────────────────────────── */

describe("partition keys", () => {
  it("carry market and timeframe, so two loaders cannot share one claim", () => {
    assert.equal(tradeBarPartitionKey("US", "M1", "2024-03"), "US/M1/2024-03");
    assert.notEqual(
      tradeBarPartitionKey("US", "M1", "2024-03"),
      tradeBarPartitionKey("US", "H1", "2024-03"),
    );
  });

  it("spread has one grain and therefore no timeframe segment", () => {
    assert.equal(spreadCostPartitionKey("US", "2024-03"), "US/2024-03");
  });

  it("refuse a malformed month", () => {
    for (const bad of ["2024-3", "2024-13", "2024-00", "2024", "2024-03-01"]) {
      assert.throws(
        () => tradeBarPartitionKey("US", "M1", bad),
        RangeError,
        `"${bad}" must be refused`,
      );
    }
  });

  it("refuse an empty component", () => {
    assert.throws(() => tradeBarPartitionKey("", "M1", "2024-03"), RangeError);
    assert.throws(() => tradeBarPartitionKey("US", " ", "2024-03"), RangeError);
    assert.throws(() => spreadCostPartitionKey("", "2024-03"), RangeError);
  });
});

describe("tradeBarSourceHash", () => {
  it("is independent of input ORDER", () => {
    const a = tradeBarSourceHash(["sha-a", "sha-b", "sha-c"]);
    const b = tradeBarSourceHash(["sha-c", "sha-a", "sha-b"]);
    assert.equal(a, b);
  });

  it("changes when ANY contributing file changes", () => {
    const base = tradeBarSourceHash(["sha-a", "sha-b"]);
    assert.notEqual(base, tradeBarSourceHash(["sha-a", "sha-b2"]));
    assert.notEqual(base, tradeBarSourceHash(["sha-a"]));
    assert.notEqual(base, tradeBarSourceHash(["sha-a", "sha-b", "sha-c"]));
  });

  it("cannot be built from an EMPTY set", () => {
    // A hash over nothing is a well-formed identity for a partition built from
    // nothing. The ledger query matching no files is the thing to surface.
    assert.throws(() => tradeBarSourceHash([]), RangeError);
  });

  it("does not collide across a separator boundary", () => {
    // A `|`-joined hash would make ["a|b"] and ["a","b"] the same partition.
    assert.notEqual(
      tradeBarSourceHash(["a\u0000b"]),
      tradeBarSourceHash(["a", "b"]),
    );
  });
});

/* ─────────────────────────────────────────────────────────────────────────
   Archive keys
   ──────────────────────────────────────────────────────────────────────── */

describe("parseDatabentoArchiveKey", () => {
  it("round-trips against databentoArchiveKey, which is the only writer", () => {
    const cases = [
      {
        dataset: "EQUS.MINI",
        schema: "ohlcv-1m",
        year: 2024,
        jobId: "GLBX-1",
        filename: "AAPL.ohlcv-1m.csv.zst",
      },
      {
        dataset: "EQUS.MINI",
        schema: "bbo-1m",
        year: 2023,
        jobId: "job_9",
        filename: "equs-mini-20230404.bbo-1m.csv.zst",
      },
      {
        dataset: "EQUS.SUMMARY",
        schema: "tbbo",
        year: 2026,
        jobId: "x",
        filename: "a.csv.zst",
      },
    ];
    for (const c of cases) {
      const key = databentoArchiveKey(c);
      assert.deepEqual(parseDatabentoArchiveKey(key), c, key);
      // And through a gs:// uri, which is how the ledger stores it.
      assert.deepEqual(
        parseDatabentoArchiveKey(`gs://stockbook-content-prod/${key}`),
        c,
      );
    }
  });

  it("returns null for a key that is not ours", () => {
    assert.equal(
      parseDatabentoArchiveKey("feeds/TIINGO/eod/2024/01/x.json"),
      null,
    );
    assert.equal(
      parseDatabentoArchiveKey("databento/EQUS.MINI/ohlcv-1m/x.csv"),
      null,
    );
    assert.equal(
      parseDatabentoArchiveKey("databento/EQUS.MINI/ohlcv-1m/20xx/j/f.csv"),
      null,
      "a non-numeric year segment must not parse",
    );
  });
});

/* ─────────────────────────────────────────────────────────────────────────
   File -> month assignment
   ──────────────────────────────────────────────────────────────────────── */

describe("monthsForArchiveFile", () => {
  // THE MEASURED LAYOUT (gs://stockbook-content-prod, 2026-09-23): the whole
  // ohlcv-1h/ohlcv-1m harvest sits under path year 2023 — the JOB's start
  // year — and each symbol-year file names its own vendor range.
  const harvest = (filename: string) => ({
    dataset: "EQUS.MINI",
    schema: "ohlcv-1h",
    year: 2023,
    jobId: "EQUS-20260909-3NUK7D7APM",
    filename,
  });
  const THROUGH = "2026-09";

  it("a harvest year-file feeds ITS OWN range's months, not the path year's", () => {
    // MONEY-1515. This file holds 2024's bars and sits under `2023/`. It was
    // filed under 2022-12..2023-12, so every 2024 row was parsed and dropped
    // and no `--year` could reach it.
    assert.deepEqual(
      monthsForArchiveFile(
        harvest("equs-mini-20240101-20241231.ohlcv-1h.AAPL.csv.zst"),
        THROUGH,
      ),
      ["2023-12", ...monthsOfYear(2024)],
    );
    assert.deepEqual(
      monthsForArchiveFile(
        harvest("equs-mini-20260101-20260908.ohlcv-1h.AAPL.csv.zst"),
        THROUGH,
      ),
      ["2025-12", ...monthsOfYear(2026).slice(0, 9)],
      "the part-year 2026 file ends at its own last date, 2026-09",
    );
  });

  it("the history-floor file feeds all of 2023's bought months, not only March", () => {
    // It used to read its START date as a session date and feed 2023-03 alone,
    // so 2023-04..12 were hashed over the 2024 files — nine months whose
    // ledger identity described none of their rows.
    const months = monthsForArchiveFile(
      harvest("equs-mini-20230328-20231231.ohlcv-1h.MILN.csv.zst"),
      THROUGH,
    );
    assert.deepEqual(months, monthsOfYear(2023).slice(2));
  });

  it("a range feeds the month of the day BEFORE it opens — the previous December", () => {
    // The vendor's dates are UTC and our key is the ET SESSION date:
    // `2025-01-01T00:00Z` is 19:00 on 2024-12-31 under EST, so the file OPENS
    // inside the previous session's post-market hour. Those bars exist in no
    // other file — 2024's ends at 18:59 ET the same evening.
    const months = monthsForArchiveFile(
      harvest("equs-mini-20250101-20251231.ohlcv-1h.AAPL.csv.zst"),
      THROUGH,
    );
    assert.equal(months[0], "2024-12");
    assert.equal(months.length, 13);
    // …and ONLY one day back: a range opening mid-month does not reach the
    // month before it.
    assert.equal(
      monthsForArchiveFile(
        harvest("equs-mini-20230328-20231231.ohlcv-1h.MILN.csv.zst"),
        THROUGH,
      )[0],
      "2023-03",
    );
  });

  it("a DAY file feeds exactly one month — even dated the 1st", () => {
    // This is what stops a nightly append from re-loading twelve months of
    // 43M-row minute bars to store one session. The 1st is the case that
    // matters: read as a range it would reach back into the month before, and
    // every append landing on a 1st would re-load that whole finished month.
    for (const [filename, month] of [
      ["equs-mini-20240315.ohlcv-1m.csv.zst", "2024-03"],
      ["equs-mini-20240401.ohlcv-1m.csv.zst", "2024-04"],
    ] as const) {
      assert.deepEqual(
        monthsForArchiveFile({ ...harvest(filename), year: 2024 }, THROUGH),
        [month],
        filename,
      );
    }
  });

  it("a DAY file dated after its path year is its OWN month — the bbo harvest", () => {
    // The trailing-12-month bbo harvest sits under `2025/` and holds 172
    // sessions of 2026. The old rule demanded the date's year equal the path
    // year, so these fell back to 2024-12..2025-12 and 2026's spread months
    // were unreachable.
    assert.deepEqual(
      monthsForArchiveFile(
        {
          dataset: "EQUS.MINI",
          schema: "bbo-1m",
          year: 2025,
          jobId: "EQUS-20260909-9QT9SHG3DE",
          filename: "equs-mini-20260105.bbo-1m.csv.zst",
        },
        THROUGH,
      ),
      ["2026-01"],
    );
  });

  it("an unreadable name OVER-assigns through the end of the purchase", () => {
    // "Cannot tell" must never become "drop it". A harvest's files now run
    // years past their path year, so the old fallback — the path year's own
    // months — was the UNDER-assigning direction.
    const expected = monthsBetween("2022-12", THROUGH);
    for (const filename of [
      "AAPL.ohlcv-1h.csv.zst", // no date at all
      "equs-mini-20240230.ohlcv-1h.csv.zst", // V8 parses Feb 30 as Mar 1
      "equs-mini-20241231-20240101.ohlcv-1h.csv.zst", // reversed range
      "sym-19700101.csv.zst", // a digit run from before the job existed
    ]) {
      assert.deepEqual(
        monthsForArchiveFile(harvest(filename), THROUGH),
        expected,
        filename,
      );
    }
  });

  it("the fallback never shrinks below the path year, whatever the bound", () => {
    // A purchase that ended before the path year's December must not cut the
    // fallback shorter than the rule it replaced.
    assert.deepEqual(
      monthsForArchiveFile(harvest("AAPL.ohlcv-1h.csv.zst"), "2023-04"),
      ["2022-12", ...monthsOfYear(2023)],
    );
    assert.throws(
      () => monthsForArchiveFile(harvest("AAPL.ohlcv-1h.csv.zst"), "2023-4"),
      RangeError,
    );
  });

  it("monthsOfYear is ascending, zero-padded and twelve long", () => {
    const m = monthsOfYear(2023);
    assert.equal(m.length, 12);
    assert.equal(m[0], "2023-01");
    assert.equal(m[11], "2023-12");
    assert.deepEqual([...m].sort(), m, "must already be ascending");
  });

  it("monthsBetween is inclusive and crosses year ends", () => {
    assert.deepEqual(monthsBetween("2024-11", "2025-02"), [
      "2024-11",
      "2024-12",
      "2025-01",
      "2025-02",
    ]);
    assert.deepEqual(monthsBetween("2024-03", "2024-03"), ["2024-03"]);
    assert.deepEqual(monthsBetween("2024-04", "2024-03"), []);
  });
});

describe("archiveFileDateRange / archiveFileSymbol", () => {
  it("reads the vendor's range, a single date, or nothing", () => {
    assert.deepEqual(
      archiveFileDateRange("equs-mini-20240101-20241231.ohlcv-1h.AAPL.csv.zst"),
      { first: "2024-01-01", last: "2024-12-31" },
    );
    assert.deepEqual(
      archiveFileDateRange("equs-mini-20260909.ohlcv-1h.csv.zst"),
      { first: "2026-09-09", last: "2026-09-09" },
    );
    assert.equal(archiveFileDateRange("AAPL.ohlcv-1h.csv.zst"), null);
    assert.equal(
      archiveFileDateRange("equs-mini-20240230.ohlcv-1h.csv.zst"),
      null,
      "Feb 30 must not round-trip into March",
    );
  });

  it("names the symbol of a symbol split, dots included, and nothing else", () => {
    const parts = (filename: string) => ({
      dataset: "EQUS.MINI",
      schema: "ohlcv-1h",
      year: 2023,
      jobId: "j",
      filename,
    });
    assert.equal(
      archiveFileSymbol(
        parts("equs-mini-20240101-20241231.ohlcv-1h.BRK.B.csv.zst"),
      ),
      "BRK.B",
    );
    assert.equal(
      archiveFileSymbol(parts("equs-mini-20260909-20260921.ohlcv-1h.csv.zst")),
      null,
      "an unsplit append holds many symbols",
    );
  });
});

describe("filesMayOverlap", () => {
  const f = (filename: string, schema = "ohlcv-1h") => ({
    dataset: "EQUS.MINI",
    schema,
    year: 2026,
    jobId: "j",
    filename,
  });

  it("the H1 append's re-bought window IS an overlap — measured 2026-09", () => {
    // The nightly append re-buys from 2026-09-09 every night, one file per
    // symbol chunk, so 09-09 arrives in every run's file.
    assert.equal(
      filesMayOverlap([
        f("equs-mini-20260909.ohlcv-1h.csv.zst"),
        f("equs-mini-20260909-20260910.ohlcv-1h.csv.zst"),
      ]),
      true,
    );
  });

  it("per-symbol year splits of DIFFERENT symbols never overlap", () => {
    // A harvest month is ~12,000 of these with one identical range. Flagging
    // them would put a de-dup Set of every M1 bar of the year in memory.
    assert.equal(
      filesMayOverlap([
        f("equs-mini-20250101-20251231.ohlcv-1h.AAPL.csv.zst"),
        f("equs-mini-20250101-20251231.ohlcv-1h.MSFT.csv.zst"),
        f("equs-mini-20260101-20260908.ohlcv-1h.AAPL.csv.zst"),
      ]),
      false,
    );
  });

  it("the same symbol in two overlapping ranges does", () => {
    assert.equal(
      filesMayOverlap([
        f("equs-mini-20250101-20251231.ohlcv-1h.AAPL.csv.zst"),
        f("equs-mini-20251201-20260131.ohlcv-1h.AAPL.csv.zst"),
      ]),
      true,
    );
  });

  it("M1's 2026-09 — harvest to 09-05, then disjoint appends — does not", () => {
    assert.equal(
      filesMayOverlap([
        f("equs-mini-20260101-20260905.ohlcv-1m.AAPL.csv.zst", "ohlcv-1m"),
        f("equs-mini-20260908-20260909.ohlcv-1m.csv.zst", "ohlcv-1m"),
        f("equs-mini-20260910.ohlcv-1m.csv.zst", "ohlcv-1m"),
        f("equs-mini-20260911.ohlcv-1m.csv.zst", "ohlcv-1m"),
      ]),
      false,
    );
  });

  it("a name it cannot read overlaps anything beside it, and nothing alone", () => {
    assert.equal(
      filesMayOverlap([
        f("mystery.csv.zst"),
        f("equs-mini-20260910.ohlcv-1h.csv.zst"),
      ]),
      true,
    );
    assert.equal(filesMayOverlap([f("mystery.csv.zst")]), false);
  });
});

describe("monthKeyOf / lastDateOfMonth", () => {
  it("monthKeyOf takes the month of a date key", () => {
    assert.equal(monthKeyOf("2024-03-15"), "2024-03");
    assert.throws(() => monthKeyOf("2024-03"), RangeError);
  });

  it("lastDateOfMonth gets February and leap years right", () => {
    assert.equal(lastDateOfMonth("2024-02"), "2024-02-29");
    assert.equal(lastDateOfMonth("2023-02"), "2023-02-28");
    assert.equal(lastDateOfMonth("2024-01"), "2024-01-31");
    assert.equal(lastDateOfMonth("2024-04"), "2024-04-30");
    assert.equal(lastDateOfMonth("2024-12"), "2024-12-31");
  });
});

/* ─────────────────────────────────────────────────────────────────────────
   The coverage window
   ──────────────────────────────────────────────────────────────────────── */

describe("tradeBarMonthWindow", () => {
  const entry = {
    entryStartDateKey: "2023-01-01",
    entryEndDateKey: "2026-12-31",
  };

  it("clamps the first month to EQUS.MINI's own inception", () => {
    // Without this, March 2023 expects the two sessions before the dataset
    // existed and reports a permanent gap no reload can close.
    assert.deepEqual(
      tradeBarMonthWindow({
        ...entry,
        monthKey: "2023-03",
        todayDateKey: "2026-09-22",
      }),
      { from: "2023-03-28", to: "2023-03-31" },
    );
  });

  it("clamps the current month to TODAY", () => {
    // Expecting a month's remaining sessions makes every nightly run REJECT.
    assert.deepEqual(
      tradeBarMonthWindow({
        ...entry,
        monthKey: "2026-09",
        todayDateKey: "2026-09-10",
      }),
      { from: "2026-09-01", to: "2026-09-10" },
    );
  });

  it("clamps to the purchased window at both ends", () => {
    assert.deepEqual(
      tradeBarMonthWindow({
        monthKey: "2024-06",
        entryStartDateKey: "2024-06-10",
        entryEndDateKey: "2024-06-20",
        todayDateKey: "2026-09-22",
      }),
      { from: "2024-06-10", to: "2024-06-20" },
    );
  });

  it("returns NULL — not an empty range — for a month outside the purchase", () => {
    // A zero-length window makes expectedSessions 0, and `decideCoverage`
    // would then be the only thing between us and an ACCEPTED empty month.
    assert.equal(
      tradeBarMonthWindow({
        monthKey: "2023-01",
        entryStartDateKey: "2024-01-01",
        entryEndDateKey: "2024-12-31",
        todayDateKey: "2026-09-22",
      }),
      null,
    );
    assert.equal(
      tradeBarMonthWindow({
        ...entry,
        monthKey: "2026-12",
        todayDateKey: "2026-09-22",
      }),
      null,
      "a month entirely in the future must be null, not a reversed range",
    );
  });

  it("refuses a malformed month key", () => {
    assert.throws(
      () =>
        tradeBarMonthWindow({
          ...entry,
          monthKey: "2024-13",
          todayDateKey: "2026-09-22",
        }),
      RangeError,
    );
  });
});

/* ─────────────────────────────────────────────────────────────────────────
   The row
   ──────────────────────────────────────────────────────────────────────── */

const PROV = {
  sourceObjectUri:
    "gs://stockbook-content-prod/databento/EQUS.MINI/ohlcv-1m/2024/j/AAPL.csv.zst",
  pipelineRunId: "lake-load-databento-2026-09-22T00-00-00-000Z",
  observedAtMs: Date.UTC(2026, 8, 22, 5, 0, 0),
  ingestedAtMs: Date.UTC(2026, 8, 22, 6, 0, 0),
};

const BAR = {
  market: "US",
  listingId: "AAPL:NASDAQ:1980-12-12",
  symbol: "AAPL",
  exchange: "NASDAQ",
  sourceInstrumentId: 12345,
  publisherId: 95,
  tsMs: Date.UTC(2024, 2, 15, 14, 30, 0),
  sessionDate: "2024-03-15",
  open: 172.25,
  high: 172.5,
  low: 172.1,
  close: 172.4,
  volume: 48210,
  source: "DATABENTO",
};

describe("toTradeBarRow", () => {
  it("writes volume as a decimal STRING", () => {
    // BigQuery INT64 over the JSON load path is a string; a JS number loses
    // precision above 2^53 and a bigint throws inside JSON.stringify.
    const row = toTradeBarRow(BAR, PROV);
    assert.equal(row.volume, "48210");
    assert.equal(typeof row.volume, "string");
    assert.doesNotThrow(() => JSON.stringify(row));
  });

  it("carries all six mandatory silver columns", () => {
    const row = toTradeBarRow(BAR, PROV) as unknown as Record<string, unknown>;
    for (const col of [
      "source_object_uri",
      "source_record_key",
      "parser_version",
      "pipeline_run_id",
      "observed_at",
      "ingested_at",
    ]) {
      assert.ok(row[col], `${col} must be present and non-empty`);
    }
    assert.equal(row.parser_version, TRADE_BAR_PARSER_VERSION);
    assert.equal(row.observed_at, "2026-09-22T05:00:00.000Z");
    assert.equal(row.ingested_at, "2026-09-22T06:00:00.000Z");
    assert.notEqual(
      row.observed_at,
      row.ingested_at,
      "the four clocks must not collapse into one",
    );
  });

  it("the record key identifies one record within the object", () => {
    assert.equal(
      toTradeBarRow(BAR, PROV).source_record_key,
      "AAPL|2024-03-15T14:30:00.000Z",
    );
  });

  it("session_date is carried, not re-derived from the UTC ts", () => {
    // A 20:00 ET post-market bar under EST is the NEXT UTC day. The caller
    // computes the ET session with `usMarketDateKey`; taking `ts.slice(0,10)`
    // here would file it one session late.
    const row = toTradeBarRow(
      {
        ...BAR,
        tsMs: Date.UTC(2024, 0, 3, 0, 30, 0),
        sessionDate: "2024-01-02",
      },
      PROV,
    );
    assert.equal(row.session_date, "2024-01-02");
    assert.equal(row.ts.slice(0, 10), "2024-01-03");
  });

  it("a non-finite price becomes NULL, never 0", () => {
    const row = toTradeBarRow(
      { ...BAR, close: Number.NaN, low: Infinity },
      PROV,
    );
    assert.equal(row.close, null);
    assert.equal(row.low, null);
    assert.notEqual(row.close, 0);
  });

  it("a non-integer instrument or publisher id becomes NULL", () => {
    const row = toTradeBarRow(
      { ...BAR, sourceInstrumentId: Number.NaN, publisherId: 1.5 },
      PROV,
    );
    assert.equal(row.source_instrument_id, null);
    assert.equal(row.publisher_id, null);
  });
});

describe("volumeToInt64String", () => {
  it("survives a bigint, which JSON.stringify does not", () => {
    assert.equal(volumeToInt64String(9007199254740993n), "9007199254740993");
  });

  it("truncates a float and refuses a non-finite", () => {
    assert.equal(volumeToInt64String(12.9), "12");
    assert.equal(volumeToInt64String(Number.NaN), null);
    assert.equal(volumeToInt64String(null), null);
    assert.equal(volumeToInt64String(undefined), null);
  });

  it("0 round-trips as '0', not as null", () => {
    // A trade-derived feed's 0 means nothing traded. Dropping it to null would
    // erase the distinction `source` exists to carry.
    assert.equal(volumeToInt64String(0), "0");
  });
});

/* ─────────────────────────────────────────────────────────────────────────
   The planner — the rule whose failure is DESTRUCTIVE
   ──────────────────────────────────────────────────────────────────────── */

describe("planMonthPartitions", () => {
  const mk = (archiveKey: string, sha256: string) => ({
    archiveKey,
    sha256,
    size: 10,
  });
  // THE MEASURED LAYOUT: every harvest year-file sits under path year 2023 —
  // the job's start year — and names its own vendor range. `first`/`last`
  // override the calendar-year default for the floor and part-year files.
  const archived = (pathYear: number, filename: string, sha256: string) => ({
    file: mk(`databento/EQUS.MINI/ohlcv-1m/${pathYear}/j/${filename}`, sha256),
    parts: {
      dataset: "EQUS.MINI",
      schema: "ohlcv-1m",
      year: pathYear,
      jobId: "j",
      filename,
    },
  });
  const yearFile = (
    year: number,
    symbol: string,
    first = `${year}0101`,
    last = `${year}1231`,
  ) =>
    archived(
      2023,
      `equs-mini-${first}-${last}.ohlcv-1m.${symbol}.csv.zst`,
      `sha-${year}-${symbol}`,
    );
  const base = {
    partitionKeyFor: (m: string) => tradeBarPartitionKey("US", "M1", m),
    entryStartDateKey: "2023-01-01",
    entryEndDateKey: "2026-12-31",
    todayDateKey: "2026-09-22",
  };
  const plan = (over: Record<string, unknown>) =>
    planMonthPartitions({
      ...base,
      files: [yearFile(2024, "AAPL")],
      allowedMonths: monthsOfYear(2024),
      ...over,
    });

  it("claims ONLY the months of its own year, however many the files touch", () => {
    // The 2025 file touches 2024-12; the 2024 file touches 2023-12. Claiming
    // 2023-12 here would PURGE a fully loaded month and write one spill hour
    // in its place — the loader deletes a partition's range before it writes.
    const { plans, skipped } = plan({
      files: [yearFile(2024, "AAPL"), yearFile(2025, "AAPL")],
    });
    assert.deepEqual(
      plans.map((p) => p.monthKey),
      monthsOfYear(2024),
    );
    assert.ok(
      skipped.some(
        (s) => s.monthKey === "2023-12" && s.reason === "not-this-run",
      ),
      "the previous December must be skipped BY NAME, not silently absent",
    );
  });

  it("December's source hash includes the NEXT year's file, and only December's", () => {
    const withNext = plan({
      files: [yearFile(2024, "AAPL"), yearFile(2025, "AAPL")],
    }).plans;
    const alone = plan({}).plans;
    const dec = (ps: typeof withNext) =>
      ps.find((p) => p.monthKey === "2024-12")!;
    const jan = (ps: typeof withNext) =>
      ps.find((p) => p.monthKey === "2024-01")!;

    assert.equal(dec(withNext).files.length, 2);
    assert.equal(dec(alone).files.length, 1);
    assert.notEqual(dec(withNext).sourceHash, dec(alone).sourceHash);
    // Every other month is untouched, so adding the second year does not
    // re-load the whole year.
    assert.equal(jan(withNext).sourceHash, jan(alone).sourceHash);
  });

  it("counts REAL trading sessions, from the calendar and not from the data", () => {
    // January 2024 opens on a Monday: 23 weekdays, minus New Year's Day
    // (Mon 1st) and MLK Day (Mon 15th) = 21. A denominator derived from what
    // ARRIVED could only ever report 100%.
    assert.equal(
      plan({}).plans.find((p) => p.monthKey === "2024-01")!
        .expectedSessionCount,
      21,
    );
  });

  it("skips a month outside the purchase BY NAME rather than claiming it empty", () => {
    const { plans, skipped } = plan({ entryStartDateKey: "2024-07-01" });
    assert.deepEqual(
      plans.map((p) => p.monthKey),
      ["2024-07", "2024-08", "2024-09", "2024-10", "2024-11", "2024-12"],
    );
    assert.equal(
      skipped.filter((s) => s.reason === "outside-purchase").length,
      6,
      "the six months before the purchase must be named, not silently dropped",
    );
  });

  it("--month narrows to one partition and names the rest as filtered", () => {
    const { plans, skipped } = plan({ onlyMonth: "2024-06" });
    assert.deepEqual(
      plans.map((p) => p.monthKey),
      ["2024-06"],
    );
    assert.equal(skipped.filter((s) => s.reason === "filtered").length, 11);
  });

  it("two files of one month hash together, order-independently", () => {
    const a = plan({ files: [yearFile(2024, "AAPL"), yearFile(2024, "MSFT")] })
      .plans[0]!;
    const b = plan({ files: [yearFile(2024, "MSFT"), yearFile(2024, "AAPL")] })
      .plans[0]!;
    assert.equal(a.sourceHash, b.sourceHash);
    assert.equal(a.files.length, 2);
  });

  it("falls back to archiveKey:size when the manifest carried no checksum", () => {
    const noSha = {
      ...yearFile(2024, "AAPL"),
      file: mk(yearFile(2024, "AAPL").file.archiveKey, ""),
    };
    const fallback = plan({ files: [noSha] }).plans[0]!;
    assert.match(fallback.sourceHash, /^[0-9a-f]{64}$/);
    // It must DIFFER from the checksummed one, or a file that later gained a
    // checksum would never re-load.
    assert.notEqual(fallback.sourceHash, plan({}).plans[0]!.sourceHash);
  });

  /* ───────────────────────────────────────────────────────────────────────
     MONEY-1515 — every bought month is reachable through the run's selection
     ────────────────────────────────────────────────────────────────────── */

  describe("the run's selection over the measured archive", () => {
    // What the loader hands the planner: the WHOLE inventory (every path
    // year), `allowedMonths = monthsOfYear(--year)`, `onlyMonth = --month`,
    // and the purchase window EQUS.MINI actually sold.
    const LISTING = ["AAPL", "MSFT"].flatMap((sym) => [
      yearFile(2023, sym, "20230328", "20231231"),
      yearFile(2024, sym),
      yearFile(2025, sym),
      yearFile(2026, sym, "20260101", "20260908"),
    ]);
    const append = archived(
      2026,
      "equs-mini-20260909.ohlcv-1m.csv.zst",
      "sha-append-0909",
    );
    const run = (year: number, onlyMonth: string | null = null) =>
      planMonthPartitions({
        ...base,
        files: [...LISTING, append],
        allowedMonths: monthsOfYear(year),
        onlyMonth,
        entryStartDateKey: "2023-03-28",
        entryEndDateKey: "2026-09-21",
      });
    const keysOf = (files: readonly { archiveKey: string }[]) =>
      files.map((f) => f.archiveKey).sort();

    it("--year 2025 --month 2025-06 plans 2025-06 from the 2025 files", () => {
      // Unreachable before: these files sit under path year 2023 and were
      // filed under 2023's months, so no --year planned a 2025 partition.
      const { plans } = run(2025, "2025-06");
      assert.deepEqual(
        plans.map((p) => p.monthKey),
        ["2025-06"],
      );
      assert.deepEqual(
        keysOf(plans[0]!.files),
        keysOf([yearFile(2025, "AAPL").file, yearFile(2025, "MSFT").file]),
      );
      // Real sessions, not files: June 2025 is 21 weekdays minus Juneteenth.
      assert.equal(plans[0]!.expectedSessionCount, 20);
    });

    it("each year reaches all of its own bought months, and only those", () => {
      const months = (y: number) => run(y).plans.map((p) => p.monthKey);
      assert.deepEqual(months(2023), monthsOfYear(2023).slice(2));
      assert.deepEqual(months(2024), monthsOfYear(2024));
      assert.deepEqual(months(2025), monthsOfYear(2025));
      assert.deepEqual(months(2026), monthsOfYear(2026).slice(0, 9));
      // 43 in all: 2023-03 .. 2026-09 (10 + 12 + 12 + 9).
      assert.equal(
        [2023, 2024, 2025, 2026].reduce((n, y) => n + months(y).length, 0),
        43,
      );
    });

    it("a 2023 month is built from the 2023 file, not the 2024 one", () => {
      // The old rule hashed 2023-04..12 over the 2024 files and fed 2023-03
      // alone from the file that holds them — a re-delivered 2023 file then
      // reloaded nothing but March.
      const apr = run(2023).plans.find((p) => p.monthKey === "2023-04")!;
      assert.deepEqual(
        keysOf(apr.files),
        keysOf([
          yearFile(2023, "AAPL", "20230328", "20231231").file,
          yearFile(2023, "MSFT", "20230328", "20231231").file,
        ]),
      );
    });

    it("December is fed by the next year's files; 2026-09 by the harvest AND the append", () => {
      const dec = run(2024).plans.find((p) => p.monthKey === "2024-12")!;
      assert.equal(dec.files.length, 4, "2024's two files + 2025's two");
      const sep = run(2026).plans.find((p) => p.monthKey === "2026-09")!;
      assert.ok(keysOf(sep.files).includes(append.file.archiveKey));
      assert.equal(sep.files.length, 3);
    });

    it("flags a month whose files may repeat a bar, and only that month", () => {
      // The measured H1 shape: tonight's append re-buys 2026-09-09.
      const rebuy = archived(
        2026,
        "equs-mini-20260909-20260910.ohlcv-1m.csv.zst",
        "sha-rebuy",
      );
      const { plans } = planMonthPartitions({
        ...base,
        files: [...LISTING, append, rebuy],
        allowedMonths: monthsOfYear(2026),
        entryStartDateKey: "2023-03-28",
        entryEndDateKey: "2026-09-21",
      });
      const flagged = plans.filter((p) => p.filesMayOverlap);
      assert.deepEqual(
        flagged.map((p) => p.monthKey),
        ["2026-09"],
      );
    });
  });

  /* ───────────────────────────────────────────────────────────────────────
     MONEY-1515 — a plan of nothing REFUSES
     ────────────────────────────────────────────────────────────────────── */

  describe("assertPlannedMonths", () => {
    const ctx = { schema: "ohlcv-1m", year: 2025, fileCount: 507 };

    it("returns the plans unchanged when there ARE any", () => {
      const result = plan({});
      assert.equal(assertPlannedMonths(result, ctx), result.plans);
      assert.equal(result.plans.length, 12);
    });

    it("THROWS on a selection whose files feed no month of --year", () => {
      // The shape that measured this no-op under the path-year rule, and it
      // is a DAY-SPLIT append rather than a year file: the objects under
      // `.../ohlcv-1m/2026/` carry their session date in the filename, so
      // `monthsForArchiveFile` returns ONE month and there is no
      // previous-December spill to rescue the run. Offered alone to a
      // `--year 2025` run they file under `2026-09`, miss `monthsOfYear(2025)`
      // entirely — and the job used to fall through to "already ACCEPTED —
      // nothing to do" and exit 0 having loaded nothing.
      const dayFile = {
        file: mk(
          "databento/EQUS.MINI/ohlcv-1m/2026/j/equs-mini-20260905.ohlcv-1m.csv.zst",
          "sha-day",
        ),
        parts: {
          dataset: "EQUS.MINI",
          schema: "ohlcv-1m",
          year: 2026,
          jobId: "j",
          filename: "equs-mini-20260905.ohlcv-1m.csv.zst",
        },
      };
      const result = plan({
        files: [dayFile],
        allowedMonths: monthsOfYear(2025),
      });
      assert.equal(result.plans.length, 0, "the no-op must reproduce");
      assert.throws(
        () => assertPlannedMonths(result, ctx),
        (err: unknown) => {
          assert.ok(err instanceof EmptyPlanError);
          // The reason has to be NAMED — a bare throw would only move the
          // silence one layer up.
          assert.match(err.message, /--year 2025/);
          assert.match(err.message, /507 archived file\(s\) considered/);
          assert.match(err.message, /not-this-run=1/);
          assert.match(err.message, /DATA year/);
          return true;
        },
      );
    });

    it("names the empty-skip case too, instead of rendering a blank reason", () => {
      // `plans` and `skipped` both empty means no file mapped to any month at
      // all. An unguarded `join("")` would render the tally as "" and produce
      // a message with a hole in exactly the state nobody has seen before.
      assert.throws(
        () =>
          assertPlannedMonths(
            { plans: [], skipped: [] },
            { ...ctx, fileCount: 0 },
          ),
        /no file mapped to any month/,
      );
    });
  });
});

/* ─────────────────────────────────────────────────────────────────────────
   The two `numeric()` copies, pinned — MONEY-1514 review
   ──────────────────────────────────────────────────────────────────────── */

describe("numeric() agrees across the package boundary", () => {
  // `databento-lake-logic.ts` states that its copy "is pinned in agreement by
  // `databento-lake-logic.test.ts`". Until this block that claim was FALSE —
  // this file named neither `@usemoney/lake` nor `price-bar-logic`, and no
  // test anywhere compared them. A comment asserting a guard that does not
  // exist is worse than no comment: it stops the next reader looking.
  //
  // The duplication itself is deliberate — `packages/core` and `packages/lake`
  // have no dependency edge in either direction — so the rule is that they
  // must not DRIFT, not that there is one copy.
  it("produces identical output to @usemoney/lake's copy", async () => {
    const lake = (await import("../../../../lake/src/price-bar-logic")) as {
      numeric: (n: number | null | undefined, s?: number) => number | null;
    };

    const cases: ReadonlyArray<readonly [number | null | undefined, number]> = [
      [1502986459.65 / 100_000, 6], // the value that broke derivatives_eod_in
      [((100.005 - 99.995) / 100) * 10_000, 6], // a 1-cent spread in bps
      [1 / 3, 6],
      [1 / 3, 4],
      [2 / 3, 6],
      [22 / 7, 6],
      [-1.0000005, 6],
      [-0.0000001, 6],
      [1e-7, 6],
      [0.1 + 0.2, 6],
      [1_000_000_000_000.1234567, 6],
      [0, 6],
      [null, 6],
      [undefined, 6],
      [Number.NaN, 6],
      [Number.POSITIVE_INFINITY, 6],
    ];

    for (const [input, scale] of cases) {
      assert.equal(
        JSON.stringify(numeric(input, scale)),
        JSON.stringify(lake.numeric(input, scale)),
        `core and lake disagree on numeric(${String(input)}, ${scale})`,
      );
    }
  });
});
