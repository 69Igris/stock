/**
 * `buildUsSymbolInfo` — the US listing's `LibrarySymbolInfo`. MONEY-1478.
 *
 * ## WHY THIS BUILDER EXISTS SEPARATELY AT ALL
 *
 * Every other builder in `symbols-logic.ts` returns `ticker: EXCHANGE:SYMBOL`.
 * For a US listing that is not merely inconsistent, it is WRONG — and wrong in
 * the one way a chart cannot reveal.
 *
 * A TICKER IS NOT A SECURITY. The Tiingo master holds two rows for `DOW` on
 * NYSE: Dow Chemical (1972-2017) and Dow Inc. (2019-), identical in exchange,
 * assetType and currency. `Candle` and the D1 tiles are keyed on `listingId`
 * (`{symbol}:{exchange}:{listingStartDate}`) precisely so a full-range read can
 * never concatenate two companies.
 *
 * TradingView CACHES the `ticker` it is handed and requests every subsequent
 * bar under it. So a 2-part ticker would have the widget ask `/udf/history` for
 * `NASDAQ:AAPL`, which `resolveListing` reads as an INDIA listing on a
 * non-existent "NASDAQ" exchange: a resolve that succeeds and then charts
 * blank — the exact resolve-then-fail defect MONEY-1476 was spent closing.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  buildUsSymbolInfo,
  DAILY_RESOLUTIONS,
} from "../../../src/market-data/udf/symbols-logic";

const AAPL = {
  listingId: "AAPL:NASDAQ:1980-12-12",
  symbol: "AAPL",
  exchange: "NASDAQ",
  description: "Apple Inc",
  type: "stock" as const,
};

describe("the ticker is the LISTING ID, never EXCHANGE:SYMBOL", () => {
  it("ticker and full_name both round-trip the listing id", () => {
    const info = buildUsSymbolInfo(AAPL);
    assert.equal(info.ticker, "AAPL:NASDAQ:1980-12-12");
    assert.equal(info.full_name, "AAPL:NASDAQ:1980-12-12");
    // The failure this prevents, stated as the thing it must NOT be.
    assert.notEqual(info.ticker, "NASDAQ:AAPL");
  });

  it("two listings of the SAME ticker get DIFFERENT tickers", () => {
    // The DOW case, which is the whole reason listingId exists. If these two
    // ever collapse to one string, a full-range read concatenates Dow Chemical
    // and Dow Inc. into one price series and nothing on the chart says so.
    const chem = buildUsSymbolInfo({
      ...AAPL,
      listingId: "DOW:NYSE:1972-01-03",
      symbol: "DOW",
      description: "Dow Chemical",
    });
    const inc = buildUsSymbolInfo({
      ...AAPL,
      listingId: "DOW:NYSE:2019-03-20",
      symbol: "DOW",
      description: "Dow Inc",
    });
    assert.notEqual(chem.ticker, inc.ticker);
    assert.equal(
      chem.name,
      inc.name,
      "the display NAME is legitimately shared",
    );
  });
});

describe("the session and clock belong to the VENUE", () => {
  it("US equities are 0930-1600 New York, not Indian hours", () => {
    const info = buildUsSymbolInfo(AAPL);
    assert.equal(info.session, "0930-1600");
    assert.equal(info.timezone, "America/New_York");
    // Handing TradingView Asia/Kolkata does not error — it draws the bars on
    // the wrong DAYS, which no number on the chart reveals.
    assert.notEqual(info.timezone, "Asia/Kolkata");
  });

  it("a US fund prices once a day, so it gets no intraday grid", () => {
    const f = buildUsSymbolInfo({ ...AAPL, type: "fund" });
    assert.equal(f.session, "0000-2359");
    assert.equal(f.has_no_volume, true, "a NAV series has no volume");
    assert.equal(
      f.visible_plots_set,
      "c",
      "one point a day is a line, not OHLC",
    );
  });
});

describe("only what the tiles can actually serve is advertised", () => {
  it("has_intraday is FALSE — tile-build-d1 is daily", () => {
    // Advertising intraday makes the widget request a resolution that can only
    // answer `no_data`, which renders as a blank chart with NO message rather
    // than as the "not available" it is.
    assert.equal(buildUsSymbolInfo(AAPL).has_intraday, false);
  });

  it("the resolution list is daily-and-above, with no Zerodha intervals", () => {
    const info = buildUsSymbolInfo(AAPL);
    assert.deepEqual(info.supported_resolutions, [...DAILY_RESOLUTIONS]);
    // `hasBrokerCreds` is an INDIA concept (Zerodha-only 3m/10m). A Zerodha
    // connection must never widen a US resolution list.
    for (const r of ["1", "3", "5", "10", "15", "30", "60"]) {
      assert.ok(
        !info.supported_resolutions.includes(r),
        `intraday resolution ${r} must not be offered for a US listing`,
      );
    }
    assert.ok(
      info.supported_resolutions.length > 0,
      "a symbol with no requestable resolution is a permanently blank chart",
    );
  });

  it("an equity reports REAL volume — the zero is structural only for RT", () => {
    // Tiingo EOD bars are trade-derived and carry real volume. The structural
    // `volume: 0` belongs to the `TIINGO_RT` quote-mid bars, and conflating the
    // two changes what the histogram MEANS.
    assert.equal(buildUsSymbolInfo(AAPL).has_no_volume, false);
    assert.equal(
      buildUsSymbolInfo({ ...AAPL, type: "etf" }).has_no_volume,
      false,
    );
  });
});

describe("the response can never look like an ERROR to the widget", () => {
  it("carries no top-level `s` key", () => {
    // TradingView's vendored datafeed: `if (void 0 !== e.s) r("unknown_symbol")`
    // — ANY top-level `s` field, whatever its value, makes a perfectly good
    // symbol render as "This symbol doesn't exist".
    for (const type of ["stock", "etf", "fund"] as const) {
      const info = buildUsSymbolInfo({ ...AAPL, type });
      assert.ok(
        !Object.prototype.hasOwnProperty.call(info, "s"),
        `a ${type} symbol-info must not carry an \`s\` key`,
      );
    }
  });
});
