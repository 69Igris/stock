/**
 * Symbol Mapper Cache — pure-function tests (MONEY-620).
 *
 * De-shadowed: these assert the REAL exported helpers from
 * `apps/web/lib/market/symbol-mapper-logic.ts` — the same bytes the production
 * resolution path runs (`symbol-mapper.ts` CALLS them, binding its module-level
 * `instrumentCache`). No inline reimplementation.
 *
 * The logic module is dependency-free, so importing it never instantiates the
 * `PrismaClient` that importing `symbol-mapper.ts` would — the test stays pure
 * and exits clean (no orphan).
 *
 * Source: apps/web/lib/market/symbol-mapper-logic.ts
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  type CachedInstrument,
  getCacheKey,
  getCachedInstrument,
  setCachedInstrument,
  YAHOO_TO_DISPLAY,
  normalizeSymbol,
  isValidSymbol,
} from "../../lib/market/symbol-mapper-logic";

// ── Tests ────────────────────────────────────────────────────────

describe("Symbol Mapper Cache", () => {
  describe("getCacheKey", () => {
    it("should uppercase both symbol and exchange", () => {
      assert.strictEqual(getCacheKey("reliance", "nse"), "RELIANCE::NSE");
    });

    it("should join with :: separator", () => {
      assert.strictEqual(getCacheKey("TCS", "NSE"), "TCS::NSE");
    });

    it("should handle BSE exchange", () => {
      assert.strictEqual(getCacheKey("RELIANCE", "BSE"), "RELIANCE::BSE");
    });

    it("should handle mixed case", () => {
      assert.strictEqual(getCacheKey("Infy", "Nse"), "INFY::NSE");
    });

    it("should handle symbols with hyphens", () => {
      assert.strictEqual(
        getCacheKey("KESORAMIND-BE", "NSE"),
        "KESORAMIND-BE::NSE"
      );
    });

    it("should handle symbols with ampersands", () => {
      assert.strictEqual(getCacheKey("M&M", "NSE"), "M&M::NSE");
    });
  });

  describe("getCachedInstrument", () => {
    it("should return cached entry within TTL", () => {
      const cache = new Map<string, CachedInstrument>();
      cache.set("RELIANCE::NSE", {
        yahooSymbol: "RELIANCE.NS",
        name: "Reliance Industries",
        timestamp: Date.now(),
      });

      const result = getCachedInstrument(cache, "RELIANCE", "NSE");
      assert.ok(result !== null);
      assert.strictEqual(result!.yahooSymbol, "RELIANCE.NS");
      assert.strictEqual(result!.name, "Reliance Industries");
    });

    it("should return null for expired entry", () => {
      const cache = new Map<string, CachedInstrument>();
      cache.set("TCS::NSE", {
        yahooSymbol: "TCS.NS",
        name: "TCS",
        timestamp: Date.now() - 120_000, // 2 minutes ago
      });

      const result = getCachedInstrument(cache, "TCS", "NSE");
      assert.strictEqual(result, null);
    });

    it("should delete expired entry from cache", () => {
      const cache = new Map<string, CachedInstrument>();
      cache.set("INFY::NSE", {
        yahooSymbol: "INFY.NS",
        name: "Infosys",
        timestamp: Date.now() - 120_000,
      });

      getCachedInstrument(cache, "INFY", "NSE");
      assert.strictEqual(cache.has("INFY::NSE"), false);
    });

    it("should return null for non-existent entry", () => {
      const cache = new Map<string, CachedInstrument>();
      const result = getCachedInstrument(cache, "UNKNOWN", "NSE");
      assert.strictEqual(result, null);
    });

    it("should be case-insensitive via getCacheKey", () => {
      const cache = new Map<string, CachedInstrument>();
      cache.set("HDFCBANK::NSE", {
        yahooSymbol: "HDFCBANK.NS",
        name: "HDFC Bank",
        timestamp: Date.now(),
      });

      const result = getCachedInstrument(cache, "hdfcbank", "nse");
      assert.ok(result !== null);
      assert.strictEqual(result!.yahooSymbol, "HDFCBANK.NS");
    });

    it("should work with custom TTL", () => {
      const cache = new Map<string, CachedInstrument>();
      cache.set("SBIN::NSE", {
        yahooSymbol: "SBIN.NS",
        name: "SBI",
        timestamp: Date.now() - 3_000, // 3 seconds ago
      });

      // Fresh with 5s TTL
      const fresh = getCachedInstrument(cache, "SBIN", "NSE", 5_000);
      assert.ok(fresh !== null);

      // Re-add since the fresh check above does not consume the entry
      cache.set("SBIN::NSE", {
        yahooSymbol: "SBIN.NS",
        name: "SBI",
        timestamp: Date.now() - 3_000,
      });

      // Stale with 2s TTL
      const stale = getCachedInstrument(cache, "SBIN", "NSE", 2_000);
      assert.strictEqual(stale, null);
    });

    it("treats a future-timestamp entry as fresh (negative age < ttl)", () => {
      // A clock skew that stamps `timestamp` in the future yields a negative
      // age, which is < ttl → the entry is returned, not silently dropped.
      const cache = new Map<string, CachedInstrument>();
      cache.set("CLOCKSKEW::NSE", {
        yahooSymbol: "CLOCKSKEW.NS",
        name: "Skew",
        timestamp: Date.now() + 10_000,
      });
      const result = getCachedInstrument(cache, "CLOCKSKEW", "NSE");
      assert.ok(result !== null);
    });
  });

  describe("setCachedInstrument", () => {
    it("should add entry to cache", () => {
      const cache = new Map<string, CachedInstrument>();
      setCachedInstrument(
        cache,
        "RELIANCE",
        "NSE",
        "RELIANCE.NS",
        "Reliance Industries"
      );

      assert.strictEqual(cache.size, 1);
      assert.ok(cache.has("RELIANCE::NSE"));
    });

    it("should set timestamp to current time", () => {
      const cache = new Map<string, CachedInstrument>();
      const before = Date.now();
      setCachedInstrument(cache, "TCS", "NSE", "TCS.NS", "TCS");
      const after = Date.now();

      const entry = cache.get("TCS::NSE")!;
      assert.ok(entry.timestamp >= before);
      assert.ok(entry.timestamp <= after);
    });

    it("should overwrite existing entry", () => {
      const cache = new Map<string, CachedInstrument>();
      setCachedInstrument(cache, "INFY", "NSE", "INFY.NS", "Infosys Limited");
      setCachedInstrument(cache, "INFY", "NSE", "INFY.NS", "Infosys Ltd");

      assert.strictEqual(cache.size, 1);
      assert.strictEqual(cache.get("INFY::NSE")!.name, "Infosys Ltd");
    });

    it("should store correct yahooSymbol and name", () => {
      const cache = new Map<string, CachedInstrument>();
      setCachedInstrument(cache, "WIPRO", "BSE", "WIPRO.BO", "Wipro Limited");

      const entry = cache.get("WIPRO::BSE")!;
      assert.strictEqual(entry.yahooSymbol, "WIPRO.BO");
      assert.strictEqual(entry.name, "Wipro Limited");
    });

    it("should not trigger eviction under 10K entries", () => {
      const cache = new Map<string, CachedInstrument>();
      for (let i = 0; i < 100; i++) {
        setCachedInstrument(
          cache,
          `SYM${i}`,
          "NSE",
          `SYM${i}.NS`,
          `Stock ${i}`
        );
      }
      assert.strictEqual(cache.size, 100);
    });
  });

  describe("YAHOO_TO_DISPLAY reverse mapping", () => {
    it("should map ^NSEI to NIFTY 50", () => {
      assert.strictEqual(YAHOO_TO_DISPLAY["^NSEI"], "NIFTY 50");
    });

    it("should map ^NSEBANK to NIFTY BANK", () => {
      assert.strictEqual(YAHOO_TO_DISPLAY["^NSEBANK"], "NIFTY BANK");
    });

    it("should map ^BSESN to SENSEX", () => {
      assert.strictEqual(YAHOO_TO_DISPLAY["^BSESN"], "SENSEX");
    });

    it("should map ^CNXIT to NIFTY IT", () => {
      assert.strictEqual(YAHOO_TO_DISPLAY["^CNXIT"], "NIFTY IT");
    });

    it("should map ^INDIAVIX to INDIA VIX", () => {
      assert.strictEqual(YAHOO_TO_DISPLAY["^INDIAVIX"], "INDIA VIX");
    });

    it("should have 11 entries", () => {
      assert.strictEqual(Object.keys(YAHOO_TO_DISPLAY).length, 11);
    });

    it("should return undefined for unknown Yahoo symbol", () => {
      assert.strictEqual(YAHOO_TO_DISPLAY["^UNKNOWN"], undefined);
    });

    it("should have all values be non-empty strings", () => {
      for (const [key, value] of Object.entries(YAHOO_TO_DISPLAY)) {
        assert.ok(
          typeof value === "string" && value.length > 0,
          `${key} has invalid display name`
        );
      }
    });
  });

  describe("normalizeSymbol", () => {
    it("should uppercase the symbol", () => {
      assert.strictEqual(normalizeSymbol("reliance"), "RELIANCE");
    });

    it("should trim whitespace", () => {
      assert.strictEqual(normalizeSymbol("  TCS  "), "TCS");
    });

    it("should collapse multiple spaces", () => {
      assert.strictEqual(normalizeSymbol("NIFTY  50"), "NIFTY 50");
    });

    it("should handle index symbols with spaces", () => {
      assert.strictEqual(normalizeSymbol("nifty  bank"), "NIFTY BANK");
    });

    it("should handle already normalized symbols", () => {
      assert.strictEqual(normalizeSymbol("RELIANCE"), "RELIANCE");
    });

    it("collapses tabs/newlines too (any whitespace run → single space)", () => {
      assert.strictEqual(
        normalizeSymbol("nifty\t\tbank\nidx"),
        "NIFTY BANK IDX"
      );
    });
  });

  describe("isValidSymbol", () => {
    it("should accept uppercase letters", () => {
      assert.strictEqual(isValidSymbol("RELIANCE"), true);
    });

    it("should accept digits", () => {
      assert.strictEqual(isValidSymbol("3MINDIA"), true);
    });

    it("should accept hyphens", () => {
      assert.strictEqual(isValidSymbol("KESORAMIND-BE"), true);
    });

    it("should accept ampersands", () => {
      assert.strictEqual(isValidSymbol("M&M"), true);
    });

    it("should accept underscores", () => {
      assert.strictEqual(isValidSymbol("SOME_STOCK"), true);
    });

    it("should accept spaces (for indices)", () => {
      assert.strictEqual(isValidSymbol("NIFTY 50"), true);
    });

    it("should reject empty string", () => {
      assert.strictEqual(isValidSymbol(""), false);
    });

    it("should reject special characters", () => {
      assert.strictEqual(isValidSymbol("STOCK@123"), false);
    });

    it("should reject symbols with dots", () => {
      assert.strictEqual(isValidSymbol("RELIANCE.NS"), false);
    });

    it("should reject symbols with caret (those are Yahoo format)", () => {
      assert.strictEqual(isValidSymbol("^NSEI"), false);
    });
  });
});
