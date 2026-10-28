/**
 * `/udf/history` response shaping — MONEY-1467 (A2).
 *
 * Every rule here fails SILENTLY in the product. TradingView renders an empty
 * chart or an infinite spinner; it never surfaces an error. So each assertion
 * names the visible symptom rather than the internal state.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  barsToUdfOk,
  errorResponse,
  noDataResponse,
  parseHistoryRequest,
  sliceBarsForRequest,
  yearsForRequest,
} from "../../../src/market-data/udf/history-logic";
import { cdnCacheControlForHistory } from "../../../src/market-data/udf/history-cache-logic";
import type { TileBar } from "../../../src/market-data/tiles/tile-logic";

/** Ascending daily bars, one per "day" at 86400s spacing. */
const series = (n: number, startSec = 1_700_000_000): TileBar[] =>
  Array.from({ length: n }, (_, i): TileBar => {
    const t = startSec + i * 86_400;
    return [t, 10 + i, 12 + i, 9 + i, 11 + i, 1_000 + i];
  });

describe("countback wins over `from`", () => {
  it("returns exactly the tail N bars ending at `to`", () => {
    // TradingView sends countback on the initial load and expects EXACTLY N
    // bars. Returning fewer when the data exists makes the chart load short
    // and immediately re-request — a visible stutter, no error.
    const bars = series(500);
    const out = sliceBarsForRequest(bars, {
      from: bars[0]![0],
      to: bars[bars.length - 1]![0],
      countback: 300,
    });
    assert.equal(out.length, 300);
    assert.equal(
      out[out.length - 1]![0],
      bars[bars.length - 1]![0],
      "ends at `to`",
    );
  });

  it("countback IGNORES a `from` that would have returned fewer bars", () => {
    const bars = series(500);
    const out = sliceBarsForRequest(bars, {
      // A `from` that only admits 10 bars...
      from: bars[490]![0],
      to: bars[499]![0],
      countback: 300, // ...but countback asks for 300.
    });
    assert.equal(
      out.length,
      300,
      "countback must win, or the initial load is short",
    );
  });

  it("`to` still bounds the RIGHT edge, countback or not", () => {
    // Otherwise the chart draws candles into the future.
    const bars = series(500);
    const cutoff = bars[100]![0];
    const out = sliceBarsForRequest(bars, {
      from: bars[0]![0],
      to: cutoff,
      countback: 300,
    });
    assert.equal(out[out.length - 1]![0], cutoff);
    assert.ok(out.every((b) => b[0] <= cutoff));
  });

  it("without countback the window is the inclusive [from, to] range", () => {
    const bars = series(10);
    const out = sliceBarsForRequest(bars, {
      from: bars[2]![0],
      to: bars[5]![0],
    });
    assert.deepEqual(
      out.map((b) => b[0]),
      [bars[2]![0], bars[3]![0], bars[4]![0], bars[5]![0]],
      "both ends inclusive",
    );
  });
});

describe("no_data MUST carry nextTime, except when it must not", () => {
  it("a gap INSIDE our history points forward to the newest bar we hold", () => {
    // Without nextTime the widget steps back one window at a time, forever,
    // and the user watches a spinner.
    const res = noDataResponse({
      requestedFrom: 1_800_000_000,
      earliestAvailable: 1_700_000_000,
      latestAvailable: 1_750_000_000,
    });
    assert.equal(res.s, "no_data");
    assert.equal(res.nextTime, 1_750_000_000);
  });

  it("a request OLDER than all our history carries NO nextTime", () => {
    // This is the case that looks like it wants a nextTime and does not: there
    // is no older bar to point at, so sending one sends the widget further
    // back — the same infinite loop by another route.
    const res = noDataResponse({
      requestedFrom: 1_000_000_000,
      earliestAvailable: 1_700_000_000,
      latestAvailable: 1_750_000_000,
    });
    assert.equal(res.s, "no_data");
    assert.equal(res.nextTime, undefined);
  });

  it("holding nothing at all carries no nextTime", () => {
    const res = noDataResponse({
      requestedFrom: 1_700_000_000,
      earliestAvailable: null,
      latestAvailable: null,
    });
    assert.deepEqual(res, { s: "no_data" });
  });
});

describe("the ok payload is column arrays of the right length", () => {
  it("transposes tuples, in seconds", () => {
    const bars = series(3);
    const ok = barsToUdfOk(bars);
    assert.equal(ok.s, "ok");
    assert.deepEqual(
      ok.t,
      bars.map((b) => b[0]),
    );
    assert.deepEqual(
      ok.c,
      bars.map((b) => b[4]),
    );
    for (const key of ["t", "o", "h", "l", "c", "v"] as const) {
      assert.equal(ok[key].length, 3, `${key} must be parallel`);
    }
    assert.ok(
      ok.t.every((t) => t < 1e11),
      "seconds, never milliseconds",
    );
  });

  it("sources ride along ONLY when parallel", () => {
    const bars = series(3);
    assert.deepEqual(barsToUdfOk(bars, ["A", "B", "C"]).sources, [
      "A",
      "B",
      "C",
    ]);
    // A short array would mis-attribute every bar after the gap, so it is
    // dropped entirely rather than sent partially.
    assert.equal(barsToUdfOk(bars, ["A"]).sources, undefined);
  });
});

describe("request parsing refuses rather than clamps", () => {
  const base = {
    symbol: "NSE:RELIANCE",
    resolution: "1D",
    from: "1700000000",
    to: "1750000000",
  };

  it("accepts a well-formed request", () => {
    const r = parseHistoryRequest(base);
    assert.equal(r.ok, true);
    if (r.ok) {
      assert.equal(r.symbol, "NSE:RELIANCE");
      assert.equal(r.req.from, 1_700_000_000);
      assert.equal(r.req.countback, undefined);
    }
  });

  it("REFUSES millisecond timestamps", () => {
    // The whole reason this guard exists: a millisecond value is finite, passes
    // every other check, and asks for a ~55,000-year window that quietly
    // returns nothing.
    const r = parseHistoryRequest({
      ...base,
      from: "1700000000000",
      to: "1750000000000",
    });
    assert.equal(r.ok, false);
    if (!r.ok) assert.match(r.error.errmsg, /millisecond/i);
  });

  it("REFUSES an inverted range instead of swapping it", () => {
    // A silently swapped range answers a question nobody asked, and the chart
    // looks fine.
    const r = parseHistoryRequest({
      ...base,
      from: "1750000000",
      to: "1700000000",
    });
    assert.equal(r.ok, false);
  });

  it("REFUSES a missing symbol and a non-positive countback", () => {
    assert.equal(parseHistoryRequest({ ...base, symbol: "  " }).ok, false);
    assert.equal(parseHistoryRequest({ ...base, countback: "0" }).ok, false);
    assert.equal(parseHistoryRequest({ ...base, countback: "-5" }).ok, false);
  });

  it("every refusal is s:error, never s:no_data", () => {
    // `no_data` means "this symbol has no bars in this range" and draws a blank
    // chart with NO message — indistinguishable from a delisted instrument.
    for (const bad of [
      { ...base, symbol: "" },
      { ...base, from: "nonsense" },
      { ...base, to: "1690000000" },
    ]) {
      const r = parseHistoryRequest(bad);
      assert.equal(r.ok, false);
      if (!r.ok) assert.equal(r.error.s, "error");
    }
  });
});

describe("year fan-out is COMPUTED, never listed", () => {
  it("returns the inclusive span, ascending", () => {
    assert.deepEqual(yearsForRequest(2021, 2024), [2021, 2022, 2023, 2024]);
    assert.deepEqual(yearsForRequest(2024, 2024), [2024]);
  });

  it("is bounded, so one request cannot fan out across three decades", () => {
    assert.equal(yearsForRequest(1990, 2026, 5).length, 5);
    // Bounded from the NEWEST end — the recent years are the ones a chart
    // actually draws.
    assert.equal(yearsForRequest(1990, 2026, 5).at(-1), 2026);
  });
});

describe("the CDN header follows the session, and is separate from the Redis TTL", () => {
  it("market hours are short with stale-while-revalidate; off hours are long", () => {
    const live = cdnCacheControlForHistory(true);
    const off = cdnCacheControlForHistory(false);
    assert.match(live, /s-maxage=60\b/);
    assert.match(live, /stale-while-revalidate/);
    assert.match(off, /s-maxage=3600\b/);
    // `public` is required or a shared cache stores nothing at all — and the
    // whole service exists to be cached at the edge.
    assert.ok(live.startsWith("public"), live);
    assert.ok(off.startsWith("public"), off);
  });

  it("errorResponse never throws and always names something", () => {
    const e = errorResponse("tile store unavailable");
    assert.equal(e.s, "error");
    assert.ok(e.errmsg.length > 0);
  });
});
