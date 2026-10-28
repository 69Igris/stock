/**
 * Exchange Fallback Tests
 *
 * Exercises the REAL `withExchangeFallback` exported from
 * packages/core/src/market-data/yahoo-api.ts (via `@usemoney/core/market-data`)
 * — the safety net that retries Yahoo calls with the alternate exchange suffix
 * (.NS ↔ .BO) when the primary fails. No inline reimplementation; the supplied
 * `fetchFn` is a pure in-test stub so no real Yahoo/network call happens.
 *
 * Source: packages/core/src/market-data/yahoo-api.ts
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  withExchangeFallback,
  normalizeTickerInput,
} from "@usemoney/core/market-data";

// ═══════════════════════════════════════════════════════════════════
// MONEY-1121 — the "@" that broke /quote
// ═══════════════════════════════════════════════════════════════════

describe("normalizeTickerInput (MONEY-1121)", () => {
  it("strips the chat @-mention token", () => {
    // The reported bug: `/quote @HDFCBANK` reached Yahoo verbatim and the
    // error echoed the character that broke it — "No data found for
    // @HDFCBANK".
    assert.equal(normalizeTickerInput("@HDFCBANK"), "HDFCBANK");
  });

  it("uppercases and trims", () => {
    assert.equal(normalizeTickerInput("  hdfcbank  "), "HDFCBANK");
    assert.equal(normalizeTickerInput(" @reliance "), "RELIANCE");
  });

  it("leaves an already-clean symbol untouched", () => {
    assert.equal(normalizeTickerInput("RELIANCE.NS"), "RELIANCE.NS");
    assert.equal(normalizeTickerInput("^NSEI"), "^NSEI");
  });

  it("handles repeated @ and an empty string", () => {
    assert.equal(normalizeTickerInput("@@TCS"), "TCS");
    assert.equal(normalizeTickerInput(""), "");
    assert.equal(normalizeTickerInput("   "), "");
  });

  it("does not strip an @ that is not leading", () => {
    // Defensive: only the mention prefix is noise.
    assert.equal(normalizeTickerInput("BRK@A"), "BRK@A");
  });
});

// ═══════════════════════════════════════════════════════════════════
// TESTS
// ═══════════════════════════════════════════════════════════════════

describe("withExchangeFallback (real @usemoney/core export)", () => {
  describe("primary symbol succeeds", () => {
    it("should return result from primary .NS symbol without fallback", async () => {
      const calls: string[] = [];
      const result = await withExchangeFallback("RELIANCE.NS", async (sym) => {
        calls.push(sym);
        return { price: 2500 };
      });
      assert.deepEqual(result, { price: 2500 });
      assert.deepEqual(calls, ["RELIANCE.NS"]);
    });

    it("should return result from primary .BO symbol without fallback", async () => {
      const calls: string[] = [];
      const result = await withExchangeFallback("BIHSPONG.BO", async (sym) => {
        calls.push(sym);
        return { price: 100 };
      });
      assert.deepEqual(result, { price: 100 });
      assert.deepEqual(calls, ["BIHSPONG.BO"]);
    });

    it("should not try alternate exchange when primary returns data", async () => {
      let callCount = 0;
      await withExchangeFallback("TCS.NS", async () => {
        callCount++;
        return "data";
      });
      assert.equal(callCount, 1);
    });
  });

  describe("primary fails, fallback succeeds", () => {
    it("should fall back from .NS to .BO when primary returns null", async () => {
      const calls: string[] = [];
      const result = await withExchangeFallback("BIHSPONG.NS", async (sym) => {
        calls.push(sym);
        if (sym === "BIHSPONG.NS") return null;
        return { price: 100 };
      });
      assert.deepEqual(result, { price: 100 });
      assert.deepEqual(calls, ["BIHSPONG.NS", "BIHSPONG.BO"]);
    });

    it("should fall back from .BO to .NS when primary returns null", async () => {
      const calls: string[] = [];
      const result = await withExchangeFallback("RELIANCE.BO", async (sym) => {
        calls.push(sym);
        if (sym === "RELIANCE.BO") return null;
        return { price: 2500 };
      });
      assert.deepEqual(result, { price: 2500 });
      assert.deepEqual(calls, ["RELIANCE.BO", "RELIANCE.NS"]);
    });

    it("should fall back from .NS to .BO when primary throws", async () => {
      const calls: string[] = [];
      const result = await withExchangeFallback("BIHSPONG.NS", async (sym) => {
        calls.push(sym);
        if (sym === "BIHSPONG.NS") throw new Error("Yahoo 404");
        return { price: 100 };
      });
      assert.deepEqual(result, { price: 100 });
      assert.deepEqual(calls, ["BIHSPONG.NS", "BIHSPONG.BO"]);
    });
  });

  describe("both primary and fallback fail", () => {
    it("should return null when both .NS and .BO return null", async () => {
      const calls: string[] = [];
      const result = await withExchangeFallback("UNKNOWN.NS", async (sym) => {
        calls.push(sym);
        return null;
      });
      assert.equal(result, null);
      assert.deepEqual(calls, ["UNKNOWN.NS", "UNKNOWN.BO"]);
    });

    it("should return null when primary returns null and fallback throws", async () => {
      const result = await withExchangeFallback("UNKNOWN.NS", async (sym) => {
        if (sym === "UNKNOWN.NS") return null;
        throw new Error("Network error");
      });
      assert.equal(result, null);
    });

    it("should return null when both throw errors", async () => {
      const result = await withExchangeFallback("UNKNOWN.NS", async () => {
        throw new Error("Yahoo error");
      });
      assert.equal(result, null);
    });
  });

  describe("no exchange suffix", () => {
    it("tries .NS then .BO for a bare equity ticker (MONEY-1121)", async () => {
      // CONTRACT CHANGE. This asserted `["AAPL"]` — no retry when the symbol
      // carries no suffix. That is precisely why `/quote HDFCBANK` could never
      // resolve: once the chat's "@" was stripped, the bare ticker was tried
      // once against Yahoo and given up on, even though HDFCBANK.NS exists.
      // A bare US ticker and a bare Indian one are indistinguishable by shape,
      // so the bare form is still tried FIRST (AAPL keeps resolving on the
      // first call) and the suffixes are only attempted after it misses.
      const calls: string[] = [];
      const result = await withExchangeFallback("AAPL", async (sym) => {
        calls.push(sym);
        return null;
      });
      assert.equal(result, null);
      assert.deepEqual(calls, ["AAPL", "AAPL.NS", "AAPL.BO"]);
    });

    it("resolves a bare Indian ticker via the .NS retry (MONEY-1121)", async () => {
      // The reported bug, end to end: `/quote @HDFCBANK` → "@" stripped →
      // "HDFCBANK" → previously null, now resolves.
      const calls: string[] = [];
      const result = await withExchangeFallback("HDFCBANK", async (sym) => {
        calls.push(sym);
        return sym === "HDFCBANK.NS" ? { price: 1650 } : null;
      });
      assert.deepEqual(result, { price: 1650 });
      assert.deepEqual(calls, ["HDFCBANK", "HDFCBANK.NS"]);
    });

    it("stops at .NS and never calls .BO once .NS answers", async () => {
      const calls: string[] = [];
      await withExchangeFallback("SBIN", async (sym) => {
        calls.push(sym);
        return sym.endsWith(".NS") ? { price: 800 } : null;
      });
      assert.ok(!calls.includes("SBIN.BO"), "must not keep trying after a hit");
    });

    it("should return data for symbols without suffix if primary succeeds", async () => {
      const result = await withExchangeFallback("AAPL", async () => {
        return { price: 150 };
      });
      assert.deepEqual(result, { price: 150 });
    });

    it("should not retry for index symbols", async () => {
      // Still true, and now load-bearing: MONEY-1121 made bare tickers retry
      // with .NS/.BO, and "^NSEI.NS" is not a symbol. Indices, currency pairs
      // and anything already dotted are excluded from suffixing.
      const calls: string[] = [];
      const result = await withExchangeFallback("^NSEI", async (sym) => {
        calls.push(sym);
        return null;
      });
      assert.equal(result, null);
      assert.deepEqual(calls, ["^NSEI"]);
    });

    it("does not suffix a currency pair either (MONEY-1121)", async () => {
      const calls: string[] = [];
      await withExchangeFallback("USDINR=X", async (sym) => {
        calls.push(sym);
        return null;
      });
      assert.deepEqual(calls, ["USDINR=X"]);
    });
  });

  describe("edge cases", () => {
    it("should handle undefined return as failure and try fallback", async () => {
      const calls: string[] = [];
      const result = await withExchangeFallback("TEST.NS", async (sym) => {
        calls.push(sym);
        if (sym === "TEST.NS") return undefined as unknown as null;
        return "found";
      });
      assert.equal(result, "found");
      assert.deepEqual(calls, ["TEST.NS", "TEST.BO"]);
    });

    it("should preserve the exact return type", async () => {
      const result = await withExchangeFallback("SYM.NS", async () => {
        return [1, 2, 3];
      });
      assert.deepEqual(result, [1, 2, 3]);
    });

    it("should handle empty string symbol", async () => {
      const result = await withExchangeFallback("", async () => null);
      assert.equal(result, null);
    });

    it("should handle symbol ending in .NS but also containing .NS in name", async () => {
      // e.g., "ANS.NS" should try "ANS.BO"
      const calls: string[] = [];
      await withExchangeFallback("ANS.NS", async (sym) => {
        calls.push(sym);
        return null;
      });
      assert.deepEqual(calls, ["ANS.NS", "ANS.BO"]);
    });
  });
});
