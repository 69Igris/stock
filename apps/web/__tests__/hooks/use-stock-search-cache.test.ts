/**
 * MONEY-1123 — useStockSearch result LRU.
 *
 * Backspacing (`RELIAN` → `RELIA` → `RELI`) walks back over queries that were
 * just fetched, and every step re-ran `/api/market/search` + `/api/market/quote`.
 * The hook now consults a module-scoped LRU (cap 50, ~60s TTL) before fetching.
 *
 * These tests drive the REAL exported cache helpers from
 * `@/hooks/useStockSearch` — the same functions `fetchSearchResults` calls — so
 * a regression in the key shape, the eviction order or the expiry fails here.
 * The clock is INJECTED (both helpers take a `now`), so nothing sleeps and no
 * timer is created.
 *
 * Source: apps/web/hooks/useStockSearch.ts
 */

import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";

import {
  buildSearchCacheKey,
  readSearchCache,
  writeSearchCache,
  clearSearchCache,
  SEARCH_CACHE_CAP,
  SEARCH_CACHE_TTL_MS,
} from "@/hooks/useStockSearch";
import type { StockWithPrice } from "@/hooks/useStockSearch";

// ── fixtures ───────────────────────────────────────────────────────────────

function row(symbol: string, price = 100): StockWithPrice {
  return {
    symbol,
    name: `${symbol} Ltd`,
    exchange: "NSE",
    type: "EQUITY",
    yahooSymbol: `${symbol}.NS`,
    price,
    change: 1,
    changePercent: 1,
    volume: 1000,
    dayHigh: price + 1,
    dayLow: price - 1,
  };
}

/** The hook's own call shape: (query, limit, includeIndices, typesKey). */
function key(query: string, limit = 20, includeIndices = false, types = "") {
  return buildSearchCacheKey(query, limit, includeIndices, types);
}

const T0 = 1_000_000;

describe("MONEY-1123 — useStockSearch result LRU", () => {
  beforeEach(() => {
    clearSearchCache();
  });

  describe("key shape", () => {
    it("normalizes case and surrounding whitespace", () => {
      assert.equal(key("  RELIANCE "), key("reliance"));
      assert.equal(key("ReLiAnCe"), key("reliance"));
    });

    it("distinguishes different queries", () => {
      assert.notEqual(key("relian"), key("relia"));
    });

    it("includes every option that changes the response", () => {
      assert.notEqual(key("rel", 20), key("rel", 10));
      assert.notEqual(key("rel", 20, false), key("rel", 20, true));
      assert.notEqual(key("rel", 20, false, ""), key("rel", 20, false, "ETF"));
    });
  });

  describe("read / write", () => {
    it("a miss returns null", () => {
      assert.equal(readSearchCache(key("reliance"), T0), null);
    });

    it("a repeat query is served from the cache", () => {
      const results = [row("RELIANCE")];
      writeSearchCache(key("reliance"), results, T0);
      assert.deepEqual(readSearchCache(key("reliance"), T0 + 1), results);
    });

    it("the backspace path hits: RELIAN → RELIA → RELIAN re-uses both entries", () => {
      writeSearchCache(key("relian"), [row("RELIANCE")], T0);
      writeSearchCache(key("relia"), [row("RELIANCE"), row("RELIABLE")], T0);

      assert.equal(readSearchCache(key("relia"), T0 + 10)?.length, 2);
      assert.equal(readSearchCache(key("relian"), T0 + 10)?.length, 1);
    });

    it("a different option set misses even for the same query text", () => {
      writeSearchCache(key("rel", 20), [row("RELIANCE")], T0);
      assert.equal(readSearchCache(key("rel", 10), T0), null);
    });

    it("re-writing a key replaces its value and refreshes its TTL", () => {
      writeSearchCache(key("rel"), [row("RELIANCE", 100)], T0);
      writeSearchCache(key("rel"), [row("RELIANCE", 250)], T0 + 30_000);

      const late = readSearchCache(key("rel"), T0 + SEARCH_CACHE_TTL_MS + 1);
      assert.equal(late?.[0]?.price, 250, "the newer write extends the entry");
    });

    it("clearSearchCache drops everything", () => {
      writeSearchCache(key("rel"), [row("RELIANCE")], T0);
      clearSearchCache();
      assert.equal(readSearchCache(key("rel"), T0), null);
    });
  });

  describe("TTL expiry (injected clock — no real waiting)", () => {
    it("serves an entry right up to the TTL boundary", () => {
      writeSearchCache(key("rel"), [row("RELIANCE")], T0);
      assert.notEqual(
        readSearchCache(key("rel"), T0 + SEARCH_CACHE_TTL_MS - 1),
        null
      );
    });

    it("expires exactly at the TTL boundary", () => {
      writeSearchCache(key("rel"), [row("RELIANCE")], T0);
      assert.equal(readSearchCache(key("rel"), T0 + SEARCH_CACHE_TTL_MS), null);
    });

    it("an expired entry is evicted, not just hidden (a later read still misses)", () => {
      writeSearchCache(key("rel"), [row("RELIANCE")], T0);
      assert.equal(readSearchCache(key("rel"), T0 + SEARCH_CACHE_TTL_MS), null);
      // Reading with an earlier clock must NOT resurrect it.
      assert.equal(readSearchCache(key("rel"), T0 + 1), null);
    });

    it("the TTL is short enough that quoted prices cannot go badly stale", () => {
      assert.ok(SEARCH_CACHE_TTL_MS <= 60_000, "entries carry live prices");
    });
  });

  describe("LRU eviction", () => {
    it("keeps the cap: the oldest entry is dropped on overflow", () => {
      // NB: do NOT probe q0 before overflowing — a read refreshes recency and
      // would make q0 the MRU (see the next test).
      for (let i = 0; i < SEARCH_CACHE_CAP; i += 1) {
        writeSearchCache(key(`q${i}`), [row(`SYM${i}`)], T0);
      }

      writeSearchCache(key("overflow"), [row("NEW")], T0);

      assert.equal(
        readSearchCache(key("q0"), T0),
        null,
        "the least-recently-used entry is evicted past the cap"
      );
      assert.notEqual(readSearchCache(key("q1"), T0), null);
      assert.notEqual(readSearchCache(key("overflow"), T0), null);
    });

    it("a READ refreshes recency, so a re-read entry survives the next overflow", () => {
      for (let i = 0; i < SEARCH_CACHE_CAP; i += 1) {
        writeSearchCache(key(`q${i}`), [row(`SYM${i}`)], T0);
      }

      // Touch the oldest entry → it becomes the most recently used.
      assert.notEqual(readSearchCache(key("q0"), T0), null);

      writeSearchCache(key("overflow"), [row("NEW")], T0);

      assert.notEqual(
        readSearchCache(key("q0"), T0),
        null,
        "a recently READ entry must not be the eviction victim"
      );
      assert.equal(readSearchCache(key("q1"), T0), null, "q1 is now the LRU");
    });

    it("never grows past the cap even under a long typing burst", () => {
      const total = SEARCH_CACHE_CAP * 3;
      for (let i = 0; i < total; i += 1) {
        writeSearchCache(key(`burst${i}`), [row(`SYM${i}`)], T0);
      }
      let alive = 0;
      for (let i = 0; i < total; i += 1) {
        if (readSearchCache(key(`burst${i}`), T0) !== null) alive += 1;
      }
      assert.equal(alive, SEARCH_CACHE_CAP);
    });
  });
});
