/**
 * Serving an intraday `/udf/history` — MONEY-1470 (A5).
 *
 * The failure that matters here is not a 400. It is answering a request for one
 * interval with bars of ANOTHER: every candle plots at a plausible time with a
 * plausible OHLC, and nothing downstream can tell.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  baseBarsNeeded,
  isIntradayResolution,
  planIntradayRead,
  resolutionToInterval,
} from "../../../src/market-data/intraday/intraday-request";

describe("the UDF resolution vocabulary", () => {
  it("minutes are BARE NUMBERS, days are D/1D", () => {
    assert.equal(resolutionToInterval("5"), "5m");
    assert.equal(resolutionToInterval("60"), "60m");
    assert.equal(resolutionToInterval("1"), "1m");
    assert.equal(resolutionToInterval("1D"), null);
    assert.equal(resolutionToInterval("D"), null);
    assert.equal(resolutionToInterval("W"), null);
  });

  it("an advertised-but-unserved resolution is REFUSED, never rounded", () => {
    // The config advertises 3/10/30 and we store none of them. Rounding "3" to
    // the nearest interval we DO have answers a 3-minute request with 5-minute
    // bars — which draws perfectly and is wrong.
    assert.equal(resolutionToInterval("3"), null);
    assert.equal(resolutionToInterval("10"), null);
    assert.equal(resolutionToInterval("30"), null);
  });

  it("garbage is not an interval", () => {
    for (const r of ["", " ", "abc", "-5", "0", "5.5", "1e3"]) {
      assert.equal(resolutionToInterval(r), null, `"${r}" must not resolve`);
    }
  });

  it("isIntradayResolution splits the two families the route branches on", () => {
    assert.equal(isIntradayResolution("5"), true);
    assert.equal(isIntradayResolution("3"), true, "unserved is still INTRADAY");
    assert.equal(isIntradayResolution("1D"), false);
    assert.equal(isIntradayResolution("D"), false);
    // The distinction is load-bearing: "3" must reach the intraday branch and
    // be refused BY NAME there, not fall through to the daily tile reader and
    // return daily bars for a 3-minute request.
  });
});

describe("what each market can honestly serve", () => {
  it("US serves everything from its 1m base", () => {
    for (const r of ["1", "5", "15", "60"]) {
      const p = planIntradayRead("US", r);
      assert.equal(p.ok, true, `US should serve ${r}`);
    }
  });

  it("India REFUSES 1m, because its base is 5m", () => {
    // A SOURCE fact: Yahoo retains 1m for seven days against 60 for 5m, so a
    // 45-session 1m India buffer cannot be filled. Kite Connect would supply
    // real 1m and is deliberately not activated.
    const p = planIntradayRead("IN", "1");
    assert.equal(p.ok, false);
    assert.match(
      p.ok === false ? p.reason : "",
      /narrowest stored interval is 5m/,
    );
    // The refusal NAMES the alternatives — "not supported" with no alternative
    // sends a caller looking for a bug rather than a different button.
    assert.match(p.ok === false ? p.reason : "", /5m, 15m, 60m/);
  });

  it("India serves 5/15/60", () => {
    for (const r of ["5", "15", "60"]) {
      assert.equal(planIntradayRead("IN", r).ok, true, `IN should serve ${r}`);
    }
  });
});

describe("how many base bars to read", () => {
  it("over-reads by ONE target bucket, deliberately", () => {
    // The window rarely aligns to a bucket boundary, so the oldest bucket is
    // usually PARTIAL. Serving a partial first candle makes the chart's
    // leftmost bar wrong every time the user pans.
    assert.equal(baseBarsNeeded(100, "5m", "1m"), (100 + 1) * 5);
    assert.equal(baseBarsNeeded(10, "60m", "5m"), (10 + 1) * 12);
  });

  it("the base interval itself needs one base bar per target bar", () => {
    assert.equal(baseBarsNeeded(50, "1m", "1m"), 51);
    assert.equal(baseBarsNeeded(50, "5m", "5m"), 51);
  });
});
