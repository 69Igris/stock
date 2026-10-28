/**
 * Market Indices — REAL logic test.
 *
 * Exercises the ACTUAL exported symbols from
 * `@/app/api/market/indices/indices-logic` (the pure module the indices route
 * imports) — NOT inline copies:
 *   - TICKER_INDICES / MCX_COMMODITIES (ticker taxonomy)
 *   - getMarketPhase (IN / US / MCX session math)
 *   - getCurrentFutSymbol (current-month futures symbol)
 *   - stripYahooSuffix / buildIndexQuote / filterPositivePrice (row shaping)
 *   - getIndicesCache (the globalThis HMR-survival cache)
 *   - isCacheFresh (60s TTL boundary)
 *   - withTimeout (Promise.race timeout guard)
 *
 * (Replaces the previous shadow version, which reimplemented all of these
 * inline — including a private test-only cache key and an inline withTimeout —
 * and asserted the copies.)
 *
 * Source: apps/web/app/api/market/indices/indices-logic.ts
 *         (imported by apps/web/app/api/market/indices/route.ts)
 */

import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import {
  TICKER_INDICES,
  MCX_COMMODITIES,
  getMarketPhase,
  getCurrentFutSymbol,
  stripYahooSuffix,
  buildIndexQuote,
  filterPositivePrice,
  getIndicesCache,
  isCacheFresh,
  withTimeout,
  type MarketPhase,
  type SimpleQuote,
  type YahooBasePayload,
} from "@/app/api/market/indices/indices-logic";

describe("Market Indices Logic", () => {
  describe("Ticker indices configuration", () => {
    it("should have 10 ticker indices", () => {
      assert.strictEqual(TICKER_INDICES.length, 10);
    });

    it("should have 6 Indian market indices", () => {
      const indianIndices = TICKER_INDICES.filter((i) => i.market === "IN");
      assert.strictEqual(indianIndices.length, 6);
    });

    it("should have 4 US market indices", () => {
      const usIndices = TICKER_INDICES.filter((i) => i.market === "US");
      assert.strictEqual(usIndices.length, 4);
    });

    it("should include NIFTY 50", () => {
      const nifty = TICKER_INDICES.find((i) => i.name === "NIFTY 50");
      assert.ok(nifty);
      assert.strictEqual(nifty!.yahooSymbol, "^NSEI");
    });

    it("should include SENSEX", () => {
      const sensex = TICKER_INDICES.find((i) => i.name === "SENSEX");
      assert.ok(sensex);
      assert.strictEqual(sensex!.yahooSymbol, "^BSESN");
    });
  });

  describe("MCX commodities configuration", () => {
    it("should have 2 MCX commodities", () => {
      // Crude Oil was removed 2026-05-04 (stale upstream CL=F); GOLD + SILVER remain.
      assert.strictEqual(MCX_COMMODITIES.length, 2);
    });

    it("should include GOLD with GC=F fallback", () => {
      const gold = MCX_COMMODITIES.find((c) => c.name === "GOLD");
      assert.ok(gold);
      assert.strictEqual(gold!.yahooFallback, "GC=F");
      assert.strictEqual(gold!.zerodhaSymbol, "GOLD");
    });

    it("should include SILVER with SI=F fallback", () => {
      const silver = MCX_COMMODITIES.find((c) => c.name === "SILVER");
      assert.ok(silver);
      assert.strictEqual(silver!.yahooFallback, "SI=F");
    });
  });

  describe("Market phase calculation", () => {
    it("should return a valid phase for IN market", () => {
      const phases: MarketPhase[] = ["PRE", "OPEN", "POST", "CLOSED"];
      assert.ok(phases.includes(getMarketPhase("IN")));
    });

    it("should return a valid phase for US market", () => {
      const phases: MarketPhase[] = ["PRE", "OPEN", "POST", "CLOSED"];
      assert.ok(phases.includes(getMarketPhase("US")));
    });

    it("should return a valid phase for MCX market", () => {
      const phases: MarketPhase[] = ["PRE", "OPEN", "POST", "CLOSED"];
      assert.ok(phases.includes(getMarketPhase("MCX")));
    });

    it("should return CLOSED on weekends for every market", () => {
      const day = new Date().getUTCDay();
      if (day === 0 || day === 6) {
        assert.strictEqual(getMarketPhase("IN"), "CLOSED");
        assert.strictEqual(getMarketPhase("US"), "CLOSED");
        assert.strictEqual(getMarketPhase("MCX"), "CLOSED");
      }
    });
  });

  describe("Futures symbol generation", () => {
    it("should generate NIFTY current month futures symbol", () => {
      const symbol = getCurrentFutSymbol("NIFTY");
      assert.ok(symbol.startsWith("NIFTY"));
      assert.ok(symbol.endsWith("FUT"));
      assert.ok(symbol.length > 10);
    });

    it("should generate GOLD current month futures symbol", () => {
      const symbol = getCurrentFutSymbol("GOLD");
      assert.ok(symbol.startsWith("GOLD"));
      assert.ok(symbol.endsWith("FUT"));
    });

    it("should include 2-digit year", () => {
      const symbol = getCurrentFutSymbol("NIFTY");
      const yy = String(new Date().getFullYear()).slice(2);
      assert.ok(symbol.includes(yy));
    });

    it("should include 3-letter month abbreviation", () => {
      const months = [
        "JAN",
        "FEB",
        "MAR",
        "APR",
        "MAY",
        "JUN",
        "JUL",
        "AUG",
        "SEP",
        "OCT",
        "NOV",
        "DEC",
      ];
      const symbol = getCurrentFutSymbol("NIFTY");
      const month = months[new Date().getMonth()];
      assert.ok(symbol.includes(month));
    });
  });

  describe("Yahoo symbol stripping", () => {
    it("should strip .NS suffix", () => {
      assert.strictEqual(stripYahooSuffix("RELIANCE.NS"), "RELIANCE");
    });

    it("should strip .BO suffix", () => {
      assert.strictEqual(stripYahooSuffix("RELIANCE.BO"), "RELIANCE");
    });

    it("should strip ^ prefix", () => {
      assert.strictEqual(stripYahooSuffix("^NSEI"), "NSEI");
    });

    it("should leave plain symbol unchanged", () => {
      assert.strictEqual(stripYahooSuffix("RELIANCE"), "RELIANCE");
    });
  });

  describe("Index quote building", () => {
    it("should build quote from valid data", () => {
      const idx = TICKER_INDICES[0];
      const quote: SimpleQuote = {
        price: 22500,
        change: 150,
        changePercent: 0.67,
      };
      const result = buildIndexQuote(idx, quote);
      assert.strictEqual(result.symbol, "^NSEI");
      assert.strictEqual(result.name, "NIFTY 50");
      assert.strictEqual(result.price, 22500);
      assert.strictEqual(result.market, "IN");
    });

    it("should default to 0 when quote is null", () => {
      const idx = TICKER_INDICES[0];
      const result = buildIndexQuote(idx, null);
      assert.strictEqual(result.price, 0);
      assert.strictEqual(result.change, 0);
      assert.strictEqual(result.changePercent, 0);
    });
  });

  describe("Positive price filtering", () => {
    it("should keep entries with positive price", () => {
      const data = [{ price: 100 }, { price: 0 }, { price: 200 }];
      const result = filterPositivePrice(data);
      assert.strictEqual(result.length, 2);
    });

    it("should remove entries with zero price", () => {
      const data = [{ price: 0 }];
      const result = filterPositivePrice(data);
      assert.strictEqual(result.length, 0);
    });

    it("should handle empty array", () => {
      const result = filterPositivePrice([]);
      assert.strictEqual(result.length, 0);
    });
  });

  // ── globalThis Cache Pattern (real getIndicesCache) ─────────────

  describe("globalThis cache (getIndicesCache)", () => {
    // getIndicesCache reads/writes the production "__sb_indices_cache__" key on
    // globalThis. Reset it between tests so cases don't bleed into each other.
    afterEach(() => {
      delete (globalThis as Record<string, unknown>)["__sb_indices_cache__"];
    });

    it("should create cache on first access", () => {
      const cache = getIndicesCache();
      assert.ok(cache);
      assert.strictEqual(cache.cachedResponse, null);
      assert.strictEqual(cache.inflightPromise, null);
    });

    it("should return same cache instance on subsequent calls", () => {
      const cache1 = getIndicesCache();
      const cache2 = getIndicesCache();
      assert.strictEqual(cache1, cache2);
    });

    it("should persist data across calls (survives HMR)", () => {
      const payload: YahooBasePayload = {
        success: true,
        data: [],
        marketStatus: { IN: "CLOSED", US: "CLOSED", MCX: "CLOSED" },
      };
      const cache = getIndicesCache();
      cache.cachedResponse = { data: payload, timestamp: Date.now() };

      const cache2 = getIndicesCache();
      assert.ok(cache2.cachedResponse);
      assert.deepStrictEqual(cache2.cachedResponse.data, payload);
    });

    it("should allow resetting cache", () => {
      const cache = getIndicesCache();
      cache.cachedResponse = {
        data: {
          success: true,
          data: [],
          marketStatus: { IN: "OPEN", US: "OPEN", MCX: "OPEN" },
        },
        timestamp: Date.now(),
      };
      cache.cachedResponse = null;

      assert.strictEqual(getIndicesCache().cachedResponse, null);
    });
  });

  describe("Cache TTL logic (isCacheFresh)", () => {
    it("should treat cache as fresh within TTL", () => {
      const now = Date.now();
      assert.strictEqual(isCacheFresh(now - 30_000, now), true); // 30s ago
    });

    it("should treat cache as stale after TTL", () => {
      const now = Date.now();
      assert.strictEqual(isCacheFresh(now - 61_000, now), false); // 61s ago
    });

    it("should treat cache at exact TTL boundary as stale", () => {
      const now = Date.now();
      assert.strictEqual(isCacheFresh(now - 60_000, now), false); // exactly 60s
    });

    it("should treat a just-stamped cache as fresh", () => {
      const now = Date.now();
      assert.strictEqual(isCacheFresh(now, now), true);
    });
  });

  // ── withTimeout Utility (real export) ───────────────────────────

  describe("withTimeout", () => {
    it("should return value when promise resolves before timeout", async () => {
      const fast = new Promise<string>((r) => setTimeout(() => r("ok"), 10));
      const result = await withTimeout(fast, 200);
      assert.strictEqual(result, "ok");
    });

    it("should return null when promise exceeds timeout", async () => {
      const slow = new Promise<string>((r) => setTimeout(() => r("late"), 500));
      const result = await withTimeout(slow, 10);
      assert.strictEqual(result, null);
    });

    it("should handle immediate resolution", async () => {
      const immediate = Promise.resolve(42);
      const result = await withTimeout(immediate, 100);
      assert.strictEqual(result, 42);
    });

    it("should handle rejected promise", async () => {
      const failing = Promise.reject(new Error("network error"));
      await assert.rejects(() => withTimeout(failing, 100), {
        message: "network error",
      });
    });
  });
});
