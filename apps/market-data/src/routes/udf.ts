/**
 * The TradingView UDF endpoints.
 *
 * `/udf/marks` is 501 here; C4 fills it. `/udf/history` is served from D1
 * tiles as of MONEY-1467 (A2) — see `./history.ts`. The route
 * files and their response-shape tests exist now so the contract is fixed
 * before the data arrives — a shape agreed after the fact is a shape the
 * widget has already been coded against.
 */
import { Hono } from "hono";
import { UDF_CONFIG } from "@usemoney/core/market-data/udf/config";
import { CACHE_CONTROL } from "../app-logic";
// MONEY-1467 (A2) — `/udf/history` is served from D1 tiles now. It lives in
// its own file because it is the only route here with real I/O, and mounting
// it on this router keeps the public path `/udf/history` unchanged.
import historyRoutes from "./history";
import symbolRoutes from "./symbols";

const udf = new Hono();

/** The datafeed config — a constant, and the clearest CDN win in the service. */
udf.get("/config", (c) => {
  c.header("Cache-Control", CACHE_CONTROL.config);
  // `supports_marks: false` ON THIS ORIGIN ONLY. MONEY-1476.
  //
  // The shared `UDF_CONFIG` says true because `apps/web` serves `/udf/marks`;
  // here it is still a 501 stub until C4. Advertising a capability the origin
  // does not have means the widget calls `/udf/marks`, gets a 501, and draws
  // NOTHING — so every split and bonus becomes an unexplained gap, which is
  // the exact reading MONEY-1176 added marks to prevent ("a raw split gap
  // reads as a crash").
  //
  // Declaring it false is the honest state: the widget stops asking, and the
  // chart is merely without glyphs rather than silently wrong. Delete this
  // override in the same change that implements the route.
  return c.json({ ...UDF_CONFIG, supports_marks: false });
});

/**
 * Server time, in SECONDS.
 *
 * TradingView's UDF spec wants a unix timestamp in seconds and reads the body
 * as plain text, not JSON. Returning milliseconds puts the chart ~55,000 years
 * in the future, and returning JSON makes it parse `NaN` — both render as an
 * empty chart rather than an error.
 */
udf.get("/time", (c) => {
  c.header("Cache-Control", CACHE_CONTROL.time);
  return c.text(String(Math.floor(Date.now() / 1000)));
});

// MONEY-1476 — `/udf/symbols` and `/udf/search` are IMPLEMENTED now, in
// `./symbols.ts`. They were 501 stubs, and flipping `MARKET_DATA_TILES` true on
// prod pointed every chart at a service that could not resolve a symbol:
// TradingView calls `resolveSymbol` FIRST and requests no bars until it
// succeeds, so every chart read "Symbol Error · invalid symbol" while
// `/udf/history` was serving correctly.
udf.route("/", symbolRoutes);

/**
 * Bars. 501 until A2/A3.
 *
 * The UDF error shape is `{ s: "error", errmsg }` — NOT an empty bar array.
 * `{ s: "no_data" }` means "this symbol has no bars in this range", which the
 * widget renders as a blank chart with no message; an unimplemented endpoint
 * returning that would look exactly like a delisted instrument.
 */
/** Corporate-action marks. 501 until C4. */
udf.get("/marks", (c) => {
  c.header("Cache-Control", CACHE_CONTROL.notImplemented);
  return c.json({ s: "error", errmsg: "not implemented (C4)" }, 501);
});

udf.route("/", historyRoutes);

export default udf;
