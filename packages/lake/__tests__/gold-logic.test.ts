/**
 * MONEY-1506 (B4) — the BigQuery row shapes the tile builder depends on.
 *
 * Every case here is a value that would produce a COMPLETE, PLAUSIBLE, WRONG
 * result rather than an error: a blank chart, a bar filed under no year, or a
 * closed-year tile that survives a split for ever. None of them throws in
 * production.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { bqDay, bqNum, toAdjustedBar, toTileListing } from "../src/gold-logic";

describe("a BigQuery DATE is an object, not a string", () => {
  it("unwraps `{ value }`", () => {
    assert.equal(bqDay({ value: "2026-09-11" }), "2026-09-11");
  });

  it("passes a plain string through", () => {
    assert.equal(bqDay("2026-09-11"), "2026-09-11");
  });

  it("refuses to stringify an object it does not understand", () => {
    // `String({})` is "[object Object]". `new Date` of that is `Invalid Date`
    // either way, but the log line reads as though a date had been supplied —
    // which is the difference between a five-minute diagnosis and an hour.
    assert.equal(bqDay({}), "");
    assert.equal(bqDay(null), "");
    assert.equal(bqDay(undefined), "");
    assert.equal(bqDay({ value: 20260911 }), "");
  });
});

describe("a BigQuery NUMERIC is a string, because it does not fit a double", () => {
  it("parses the string form", () => {
    assert.equal(bqNum("1234.550000"), 1234.55);
  });

  it("passes a number through", () => {
    assert.equal(bqNum(0), 0);
  });

  it("a MISSING column is NaN, never 0", () => {
    // 0 is a real price for nothing and a real volume for "nothing traded".
    // Handing back 0 for an absent column would put a valid-looking bar on a
    // chart; NaN is rejected by every `finite()` guard downstream.
    assert.ok(Number.isNaN(bqNum(undefined)));
    assert.ok(Number.isNaN(bqNum(null)));
  });
});

describe("chart_tile_manifest -> the builder's listing", () => {
  it("carries the fingerprint through", () => {
    const got = toTileListing({
      listing_id: "AAPL:NASDAQ:1980-12-12",
      symbol: "AAPL",
      exchange: "NASDAQ",
      last_session: { value: "2026-09-11" },
      actions_fingerprint: "deadbeef",
    });
    assert.deepEqual(got, {
      listingId: "AAPL:NASDAQ:1980-12-12",
      symbol: "AAPL",
      exchange: "NASDAQ",
      lastSession: "2026-09-11",
      actionsFingerprint: "deadbeef",
    });
  });

  it('a NULL fingerprint becomes "none", never undefined', () => {
    // THE ONE THAT MATTERS. `rebuildReason` compares the fingerprint only when
    // BOTH sides have one — deliberately, so a tile written before fingerprints
    // existed is not rebuilt nightly for ever. `undefined` here therefore
    // SKIPS the comparison: a US listing's closed-year tiles would survive a
    // split permanently, and the chart would step at the five-year boundary
    // with every counter reporting success.
    //
    // `"none"` is also the exact literal `fingerprintActions([])` returns, so
    // the two halves compare without a translation step.
    for (const fp of [null, undefined, ""]) {
      const got = toTileListing({
        listing_id: "X:NYSE:2020-01-01",
        actions_fingerprint: fp,
      });
      assert.equal(got.actionsFingerprint, "none", `for ${String(fp)}`);
      assert.notEqual(got.actionsFingerprint, undefined);
    }
  });
});

describe("adjusted_bar_d1 -> the builder's bar", () => {
  const row = {
    listing_id: "AAPL:NASDAQ:1980-12-12",
    session_date: { value: "2026-09-11" },
    adj_open: "226.500000",
    adj_high: "228.100000",
    adj_low: "225.900000",
    adj_close: "227.750000",
    adj_volume: 51234567,
    source: "TIINGO",
  };

  it("maps the ADJUSTED columns, under adj* names", () => {
    // The raw OHLC rides in the same row. Handing `adj_close` back as `close`
    // is how a caller re-adjusts an already-adjusted series and halves a
    // decade of prices while still drawing a chart.
    assert.deepEqual(toAdjustedBar(row), {
      listingId: "AAPL:NASDAQ:1980-12-12",
      sessionDate: "2026-09-11",
      adjOpen: 226.5,
      adjHigh: 228.1,
      adjLow: 225.9,
      adjClose: 227.75,
      adjVolume: 51234567,
      source: "TIINGO",
    });
  });

  it('a missing source is "UNKNOWN", never absent', () => {
    // The tile carries `sources` as a PARALLEL ARRAY. An `undefined` that got
    // dropped would shift every later index and mis-attribute every bar after
    // the gap — and "we do not know" is a different statement from any
    // vendor's name.
    assert.equal(toAdjustedBar({ ...row, source: null }).source, "UNKNOWN");
    assert.equal(toAdjustedBar({ ...row, source: "" }).source, "UNKNOWN");
  });

  it("a zero adjusted volume survives — it is a real value", () => {
    // `TIINGO_RT` writes a STRUCTURAL zero meaning "this feed does not report
    // volume". Coercing it to anything else would erase the distinction the
    // silver DDL keeps `source` around to make.
    assert.equal(toAdjustedBar({ ...row, adj_volume: 0 }).adjVolume, 0);
  });
});
