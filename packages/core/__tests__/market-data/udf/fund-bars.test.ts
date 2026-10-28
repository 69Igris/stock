/**
 * A fund's NAV series as UDF bars — MONEY-1478.
 *
 * Funds were the one asset class `apps/market-data` had NO path for: `apps/web`
 * synthesised OHLC from AMFI NAV and the service had zero mentions of NAV or
 * scheme codes. Shared so both origins synthesise identically — a chart that
 * differs by which origin served it is what the A3 parity harness exists to
 * prevent.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { navPointsToBars } from "../../../src/market-data/udf/fund-bars";

describe("a NAV is one number a day, so the bar is FLAT", () => {
  it("open = high = low = close, and volume is 0", () => {
    const [bar] = navPointsToBars([{ date: "2026-09-11", nav: 110.261 }]);
    assert.ok(bar);
    const [t, o, h, l, c, v] = bar;
    assert.equal(o, 110.261);
    assert.equal(h, 110.261);
    assert.equal(l, 110.261);
    assert.equal(c, 110.261);
    // `0` means "this series HAS no volume", never "nothing traded" — the same
    // rule TIINGO_RT bars follow. The symbol info sets `has_no_volume` so the
    // widget hides the pane rather than drawing a flat zero line.
    assert.equal(v, 0);
    assert.equal(t, Date.UTC(2026, 8, 11) / 1000, "unix SECONDS, UTC midnight");
  });
});

describe("ordering and refusals", () => {
  it("sorts ASCENDING — the reader may return newest-first", () => {
    // TradingView requires ascending time. An out-of-order series renders as a
    // chart folding back on itself, with no error.
    const bars = navPointsToBars([
      { date: "2026-09-11", nav: 3 },
      { date: "2026-09-09", nav: 1 },
      { date: "2026-09-10", nav: 2 },
    ]);
    assert.deepEqual(
      bars.map((b) => b[4]),
      [1, 2, 3],
    );
    assert.ok(bars.every((b, i) => i === 0 || b[0] >= bars[i - 1]![0]));
  });

  it("drops a NAV that cannot be a price", () => {
    // AMFI publishes the literal body `None` for a day with no NAV. A 0 or NaN
    // plotted as a price is a cliff to zero that looks like a real crash.
    const bars = navPointsToBars([
      { date: "2026-09-09", nav: 0 },
      { date: "2026-09-10", nav: Number.NaN },
      { date: "2026-09-11", nav: -5 },
      { date: "2026-09-12", nav: 10 },
    ]);
    assert.equal(bars.length, 1);
    assert.equal(bars[0]![4], 10);
  });

  it("drops an unparseable date rather than emitting NaN time", () => {
    // A NaN timestamp puts the bar at the epoch or nowhere; the widget shows a
    // chart starting in 1970 with no error.
    assert.deepEqual(navPointsToBars([{ date: "not-a-date", nav: 10 }]), []);
  });

  it("an empty input is an empty series, not one empty bar", () => {
    assert.deepEqual(navPointsToBars([]), []);
  });
});
