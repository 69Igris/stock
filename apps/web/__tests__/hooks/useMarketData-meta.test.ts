/**
 * `useMarketData` surfaces the freshness meta it used to drop — MONEY-1309.
 *
 * `/api/market/quote` has returned `cached` / `asOf` / `delayed` / `partial`
 * since MONEY-1124 and the hook threw all four away, so no surface in the app
 * could tell a 75-second-old cached price from a live one. `lastUpdate` answers
 * "when did we FETCH"; it says nothing about how old the number is.
 *
 * The parse lives in `useMarketData-logic.ts` (pure) and the hook CALLS it, so
 * these assertions run against the same code production does — no shadow. The
 * hook's own wiring is checked by a source scan, because `node:test` has no DOM
 * and cannot render a React hook; the scan is named as the weaker instrument it
 * is, and it checks the two things a wrong wiring would break.
 *
 * ## The load-bearing default
 *
 * Every meta field is OPTIONAL on the wire — the route's `withMeta` drops
 * undefined keys — so each one needs a default, and `delayed` is the one that
 * matters. It defaults to TRUE. An older deploy of the route, a shape we failed
 * to parse, or a field that simply was not sent must never read as "this price
 * is live", because that is a compliance claim.
 *
 * Source: apps/web/hooks/useMarketData-logic.ts, apps/web/hooks/useMarketData.ts
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
  EMPTY_MARKET_DATA_META,
  extractMarketDataMeta,
  buildQuoteParams,
  resolveMarketDataOptions,
} from "@/hooks/useMarketData-logic";

const HOOK = join("hooks", "useMarketData.ts");
const hookSrc = readFileSync(HOOK, "utf8");

describe("extractMarketDataMeta (MONEY-1309)", () => {
  it("[meta] the helper is the real export and returns all four fields", () => {
    // Ceiling: several cases below assert a DEFAULT, which an object missing
    // the key would satisfy as `undefined === undefined` under a loose compare.
    const keys = Object.keys(extractMarketDataMeta({})).sort();
    assert.deepEqual(keys, ["asOf", "cached", "delayed", "partial"]);
  });

  it("reads a full envelope verbatim", () => {
    assert.deepEqual(
      extractMarketDataMeta({
        cached: true,
        asOf: "2026-08-31T18:00:00.000Z",
        delayed: false,
        partial: true,
      }),
      {
        cached: true,
        asOf: "2026-08-31T18:00:00.000Z",
        delayed: false,
        partial: true,
      }
    );
  });

  it("DEFAULTS delayed to true when the field is absent", () => {
    // The compliance-relevant direction. `delayed` is dropped from the payload
    // when undefined, so absence must mean "assume delayed", never "assume
    // live" — MONEY-1259 is the record of what hiding that disclosure costs.
    assert.equal(extractMarketDataMeta({}).delayed, true);
    assert.equal(extractMarketDataMeta({ cached: true }).delayed, true);
    assert.equal(extractMarketDataMeta(null).delayed, true);
    assert.equal(extractMarketDataMeta(undefined).delayed, true);
  });

  it("only an explicit `false` makes a payload non-delayed", () => {
    assert.equal(extractMarketDataMeta({ delayed: false }).delayed, false);
    // A truthy-but-not-true value is still delayed — no coercion games.
    assert.equal(
      extractMarketDataMeta({ delayed: 0 as unknown as boolean }).delayed,
      true
    );
  });

  it("defaults the rest conservatively", () => {
    const meta = extractMarketDataMeta({});
    assert.equal(meta.cached, false);
    assert.equal(meta.asOf, null);
    assert.equal(meta.partial, false);
    assert.deepEqual(meta, EMPTY_MARKET_DATA_META);
  });

  it("ignores a non-string asOf rather than passing junk to `new Date`", () => {
    assert.equal(
      extractMarketDataMeta({ asOf: 1_756_600_000_000 as unknown as string })
        .asOf,
      null
    );
  });
});

describe("the exchange option reaches the request (MONEY-1309)", () => {
  it("a US venue survives the option defaults and the query string", () => {
    // Before this ticket both of these were typed `"NSE" | "BSE"`, so a US
    // venue could not be expressed at all — the hook would have sent NSE and
    // the route would have answered with an India quote for a US ticker.
    assert.equal(
      resolveMarketDataOptions({ exchange: "NASDAQ" }).exchange,
      "NASDAQ"
    );
    assert.equal(resolveMarketDataOptions({}).exchange, "NSE");
    assert.equal(
      buildQuoteParams(["AAPL", "MSFT"], "NASDAQ").toString(),
      "symbols=AAPL%2CMSFT&exchange=NASDAQ"
    );
  });
});

describe("the hook wires meta through (MONEY-1309)", () => {
  it("[meta] the hook source is readable and is the one we think", () => {
    assert.ok(hookSrc.length > 3000, `hook read as ${hookSrc.length} chars`);
    assert.match(hookSrc, /export function useMarketData/);
  });

  it("declares `meta` on BOTH result types and returns it", () => {
    // `useQuote` delegates to `useMarketData`; dropping meta from either return
    // would leave one of the two consumers blind with no type error, since the
    // interfaces are separate.
    assert.match(hookSrc, /meta: MarketDataMeta;[\s\S]*meta: MarketDataMeta;/);
    const returns = hookSrc.match(/^\s{4}meta,$/gm) ?? [];
    assert.equal(
      returns.length,
      3,
      `expected meta in the hook return, the useQuote destructure and the ` +
        `useQuote return; found ${returns.length}`
    );
  });

  it("sets meta UNCONDITIONALLY on every successful response", () => {
    // A `if (data.asOf)` guard would leave the PREVIOUS response's freshness on
    // screen beside the new prices — stale provenance over fresh numbers, which
    // is worse than no provenance at all.
    assert.match(
      hookSrc,
      /\n\s*setMeta\(extractMarketDataMeta\(/,
      "meta is no longer set from the response"
    );
    assert.doesNotMatch(
      hookSrc,
      /if\s*\([^)]*\)\s*setMeta\(/,
      "meta is set behind a condition; it must be set on every response"
    );
  });
});
