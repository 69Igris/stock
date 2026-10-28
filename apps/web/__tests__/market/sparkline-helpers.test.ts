/**
 * Sparkline Helper Tests
 *
 * Pure-function tests for the sparkline helpers in
 * packages/core/src/market-data/sparkline.ts:
 * - toYahooSparklineSymbol: NSE/BSE → Yahoo suffix mapping
 * - sparklineCacheKey: deterministic cache key generation
 *
 * Network-dependent helpers (fetchSparkline, fetchSparklines) are exercised
 * via integration tests in the services layer.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { toYahooSparklineSymbol, sparklineCacheKey } from "@usemoney/core";

describe("toYahooSparklineSymbol", () => {
  it("appends .NS for NSE symbols without a suffix", () => {
    assert.equal(toYahooSparklineSymbol("RELIANCE", "NSE"), "RELIANCE.NS");
  });

  it("appends .BO for BSE symbols without a suffix", () => {
    assert.equal(toYahooSparklineSymbol("RELIANCE", "BSE"), "RELIANCE.BO");
  });

  it("preserves pre-suffixed symbols (no double-suffix)", () => {
    assert.equal(toYahooSparklineSymbol("RELIANCE.NS", "NSE"), "RELIANCE.NS");
    assert.equal(toYahooSparklineSymbol("RELIANCE.BO", "NSE"), "RELIANCE.BO");
  });

  it("preserves index symbols with ^ prefix", () => {
    // Indices like ^NSEI should not get .NS appended - they have their own Yahoo convention
    assert.equal(toYahooSparklineSymbol("^NSEI", "NSE"), "^NSEI");
  });
});

describe("sparklineCacheKey", () => {
  it("builds a unique key per (exchange, symbol, window)", () => {
    assert.equal(
      sparklineCacheKey("RELIANCE", "NSE", "1D"),
      "sparkline:NSE:RELIANCE:1D"
    );
    assert.equal(
      sparklineCacheKey("RELIANCE", "BSE", "1W"),
      "sparkline:BSE:RELIANCE:1W"
    );
  });

  it("produces different keys for the same symbol across windows", () => {
    const k1d = sparklineCacheKey("HDFCBANK", "NSE", "1D");
    const k1w = sparklineCacheKey("HDFCBANK", "NSE", "1W");
    const k1m = sparklineCacheKey("HDFCBANK", "NSE", "1M");
    assert.notEqual(k1d, k1w);
    assert.notEqual(k1w, k1m);
    assert.notEqual(k1d, k1m);
  });

  it("produces different keys for the same symbol across exchanges", () => {
    const kNse = sparklineCacheKey("TCS", "NSE", "1D");
    const kBse = sparklineCacheKey("TCS", "BSE", "1D");
    assert.notEqual(kNse, kBse);
  });
});
