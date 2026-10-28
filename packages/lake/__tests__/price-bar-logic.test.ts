/**
 * `price-bar-logic` — MONEY-1496 (B2) + MONEY-1497 (B2-IN).
 *
 * Every case here pins a failure that is SILENT in production: a wrong
 * partition key reloads for ever or skips a month, a wrong source hash does
 * both, and a mishandled volume either throws or quietly loses precision.
 * None of them produce an error anyone would see.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  PRICE_BAR_PARSER_VERSION,
  groupBarsByPartition,
  priceBarPartitionKey,
  priceBarSourceHash,
  planShardYears,
  toPriceBarRow,
  volumeToInt64String,
  type RawBar,
  type RowProvenance,
} from "../src/price-bar-logic";

const PROV: RowProvenance = {
  sourceObjectUri: "gs://stockbook-lake-qa/lake/stage/x.parquet",
  sourceRecordKey: "row-1",
  pipelineRunId: "run-abc",
  observedAtMs: Date.UTC(2026, 2, 3, 10, 0, 0),
  ingestedAtMs: Date.UTC(2026, 2, 3, 11, 0, 0),
};

function bar(over: Partial<RawBar> = {}): RawBar {
  return {
    market: "US",
    listingId: "AAPL:NASDAQ:1980-12-12",
    symbol: "AAPL",
    exchange: "NASDAQ",
    sessionDate: "2026-03-03",
    open: 1,
    high: 2,
    low: 0.5,
    close: 1.5,
    volume: 1000,
    source: "TIINGO",
    ...over,
  };
}

describe("priceBarPartitionKey", () => {
  it("is the MONTH, because the table is MONTH-partitioned", () => {
    // A per-day key would claim ~21 partitions for one BigQuery partition, and
    // a month 1/21 loaded would then read ACCEPTED.
    assert.equal(priceBarPartitionKey("US", "2026-03-03"), "US/2026-03");
    assert.equal(priceBarPartitionKey("US", "2026-03-31"), "US/2026-03");
  });

  it("REGRESSION: the MARKET is in the key", () => {
    // Both markets write one table. Without the market, the US loader's
    // ACCEPTED row makes the India loader skip a month it has never touched.
    assert.notEqual(
      priceBarPartitionKey("US", "2026-03-03"),
      priceBarPartitionKey("IN", "2026-03-03"),
    );
  });

  it("REFUSES a malformed date rather than producing a key", () => {
    // A key that never matches the next run's key reloads the partition for
    // ever — and reports success every time.
    for (const bad of ["2026-3-3", "03-03-2026", "2026-03", "", "not-a-date"]) {
      assert.throws(() => priceBarPartitionKey("US", bad), /YYYY-MM-DD/);
    }
  });
});

describe("priceBarSourceHash", () => {
  it("is stable under input ORDER", () => {
    // GCS listing order and Mongo cursor order are incidental. An unsorted
    // hash differs run-to-run over identical bytes, so every claim reloads.
    const a = priceBarSourceHash({
      shardGenerations: ["3", "1", "2"],
      hotMaxTsMs: 42,
    });
    const b = priceBarSourceHash({
      shardGenerations: ["1", "2", "3"],
      hotMaxTsMs: 42,
    });
    assert.equal(a, b);
  });

  it("REGRESSION: changes when a shard GENERATION changes", () => {
    // A shard rewritten in place keeps its NAME. Hashing names would make a
    // corrected shard invisible and the partition would never reload.
    const before = priceBarSourceHash({
      shardGenerations: ["100"],
      hotMaxTsMs: null,
    });
    const after = priceBarSourceHash({
      shardGenerations: ["101"],
      hotMaxTsMs: null,
    });
    assert.notEqual(before, after);
  });

  it("REGRESSION: changes when only the HOT max ts moves", () => {
    // The newest sessions are in Mongo, in no shard. Drop this term and
    // today's bar lands in a partition whose hash is yesterday's — claim says
    // skip, and the day is never written.
    const yesterday = priceBarSourceHash({
      shardGenerations: ["1"],
      hotMaxTsMs: 1_000,
    });
    const today = priceBarSourceHash({
      shardGenerations: ["1"],
      hotMaxTsMs: 2_000,
    });
    assert.notEqual(yesterday, today);
  });

  it("distinguishes 'no hot rows' from a hot ts of 0", () => {
    assert.notEqual(
      priceBarSourceHash({ shardGenerations: [], hotMaxTsMs: null }),
      priceBarSourceHash({ shardGenerations: [], hotMaxTsMs: 0 }),
    );
  });
});

describe("volumeToInt64String", () => {
  it("round-trips a bigint that JSON.stringify would THROW on", () => {
    // Cold shards decode INT64 as bigint. `JSON.stringify(1n)` throws, so a
    // loader that passed it through would fail the whole partition.
    assert.equal(
      volumeToInt64String(9_007_199_254_740_993n),
      "9007199254740993",
    );
  });

  it("keeps precision above 2^53, which a JS number cannot", () => {
    const big = 9_007_199_254_740_993n;
    assert.notEqual(volumeToInt64String(big), String(Number(big)));
  });

  it("non-finite volume is NULL, never 0", () => {
    // 0 means "nothing traded" on a trade-derived feed. Writing it for a
    // missing value makes the two indistinguishable.
    assert.equal(volumeToInt64String(Number.NaN), null);
    assert.equal(volumeToInt64String(Number.POSITIVE_INFINITY), null);
    assert.equal(volumeToInt64String(null), null);
    assert.equal(volumeToInt64String(undefined), null);
  });

  it("a real zero survives", () => {
    assert.equal(volumeToInt64String(0), "0");
  });
});

describe("toPriceBarRow", () => {
  it("non-finite prices become NULL, never 0", () => {
    // A NaN close stored as 0 charts, adjusts, and yields -100% then +inf.
    const row = toPriceBarRow(
      bar({ open: Number.NaN, high: Number.POSITIVE_INFINITY, close: 1.5 }),
      PROV,
    );
    assert.equal(row.open, null);
    assert.equal(row.high, null);
    assert.equal(row.close, 1.5);
  });

  it("carries all six mandatory silver columns", () => {
    // lake-layout.md §5: "not optional and not added later". Without
    // source_object_uri and parser_version a wrong number cannot be traced to
    // the bytes that produced it.
    const row = toPriceBarRow(bar(), PROV) as unknown as Record<
      string,
      unknown
    >;
    for (const col of [
      "source_object_uri",
      "source_record_key",
      "parser_version",
      "pipeline_run_id",
      "observed_at",
      "ingested_at",
    ]) {
      assert.ok(
        row[col] !== undefined && row[col] !== null,
        `${col} missing from the row`,
      );
    }
    assert.equal(row.parser_version, PRICE_BAR_PARSER_VERSION);
  });

  it("observed_at and ingested_at are DIFFERENT clocks", () => {
    // Collapsing them loses the only signal for "the source asserted this long
    // before we stored it", which is how a stale replay is spotted.
    const row = toPriceBarRow(bar(), PROV);
    assert.notEqual(row.observed_at, row.ingested_at);
  });
});

describe("groupBarsByPartition", () => {
  it("splits on month AND market", () => {
    const grouped = groupBarsByPartition([
      bar({ sessionDate: "2026-03-01" }),
      bar({ sessionDate: "2026-03-31" }),
      bar({ sessionDate: "2026-04-01" }),
      bar({ market: "IN", sessionDate: "2026-03-01", exchange: "NSE" }),
    ]);
    assert.deepEqual([...grouped.keys()].sort(), [
      "IN/2026-03",
      "US/2026-03",
      "US/2026-04",
    ]);
    assert.equal(grouped.get("US/2026-03")?.length, 2);
  });

  it("an empty input yields no partitions, not one empty partition", () => {
    // Claiming a partition for zero rows would write an ACCEPTED row asserting
    // a month was loaded when nothing was read.
    assert.equal(groupBarsByPartition([]).size, 0);
  });
});

describe("planShardYears — we never list, so years are computed", () => {
  it("is inclusive at BOTH ends", () => {
    // An exclusive end silently drops the listing's final year of history.
    assert.deepEqual(
      planShardYears({
        listingStartYear: 2020,
        listingEndYear: 2022,
        currentYear: 2026,
      }),
      [2020, 2021, 2022],
    );
  });

  it("a live listing runs to the CURRENT year, not its end year", () => {
    assert.deepEqual(
      planShardYears({
        listingStartYear: 2024,
        listingEndYear: null,
        currentYear: 2026,
      }),
      [2024, 2025, 2026],
    );
  });

  it("REGRESSION: clamps to the 1962 history floor", () => {
    // A bad master row claiming 1800 would otherwise cost ~160 pointless GETs
    // per listing, across ~72,000 listings.
    const years = planShardYears({
      listingStartYear: 1800,
      listingEndYear: null,
      currentYear: 1965,
    });
    assert.equal(years[0], 1962);
    assert.equal(years.length, 4);
  });

  it("REGRESSION: never plans a year beyond the current one", () => {
    // A delisted-date in the future (they occur in the master) would request
    // shards that cannot exist.
    assert.deepEqual(
      planShardYears({
        listingStartYear: 2025,
        listingEndYear: 2099,
        currentYear: 2026,
      }),
      [2025, 2026],
    );
  });

  it("returns EMPTY rather than a reversed range", () => {
    // A listing whose end precedes its start is bad data; looping anyway would
    // either spin or produce negative-length work.
    assert.deepEqual(
      planShardYears({
        listingStartYear: 2026,
        listingEndYear: 2020,
        currentYear: 2026,
      }),
      [],
    );
  });
});

/* ─────────────────────────────────────────────────────────────────────────
   NUMERIC scale — MONEY-1512
   ──────────────────────────────────────────────────────────────────────── */

describe("NUMERIC scale (MONEY-1512)", () => {
  /** What BigQuery sees: the NDJSON text, not the JS number behind it. */
  function serialisedDecimals(v: unknown): number {
    const s = JSON.stringify(v);
    const dot = s.indexOf(".");
    return dot === -1 ? 0 : s.length - dot - 1;
  }

  it("a 1-for-3 split does not blow NUMERIC(18, 6)", () => {
    // This is the US half of the defect that stopped `derivatives_eod_in`
    // loading. `price_bar_d1` only ever looked healthy because bhavcopy cash
    // prices carry two decimals; a split ratio carries sixteen.
    const splitFactor = 1 / 3;
    assert.equal(serialisedDecimals(splitFactor), 16, "premise");

    const row = toPriceBarRow(bar({ splitFactor }), PROV);
    assert.equal(JSON.stringify(row.split_factor), "0.333333");
  });

  it("every NUMERIC column of a bar rounds to EXACTLY scale 6", () => {
    // EXACT, not `<= 6`: an over-rounding mutation (scale 4) satisfies a
    // `<= 6` loop, so that shape only catches "no rounding at all" — which the
    // split_factor assertion above already catches. MONEY-1512 review.
    const row = toPriceBarRow(
      bar({
        open: 1 / 3,
        high: 2 / 3,
        low: 1 / 7,
        close: 22 / 7,
        divCash: 0.1 + 0.2,
        splitFactor: 1 / 3,
      }),
      PROV,
    );
    const expected: ReadonlyArray<readonly [keyof typeof row, string]> = [
      ["open", "0.333333"],
      ["high", "0.666667"],
      ["low", "0.142857"],
      ["close", "3.142857"],
      ["div_cash", "0.3"],
      ["split_factor", "0.333333"],
    ];
    for (const [col, want] of expected) {
      assert.equal(JSON.stringify(row[col]), want, col);
    }
  });

  it("volume stays an INT64 decimal string, never rounded", () => {
    // Rounding a count would be the mirror defect: `volumeToInt64String`
    // exists because a count above 2^53 cannot survive a JS number.
    const row = toPriceBarRow(bar({ volume: 9_007_199_254_740_993n }), PROV);
    assert.equal(row.volume, "9007199254740993");
  });
});
