/**
 * Quote provider seam (MONEY-566 → MONEY-837) — REAL logic test.
 *
 * As of MONEY-837 the web app's quote seam is Yahoo-only (the Zerodha live-quote
 * provider moved to the Connect service). This exercises the ACTUAL exported
 * symbols from `@/lib/market/providers/quote-providers`:
 *   - resolveQuoteChain        (Yahoo-only chain)
 *   - resolveQuoteFromChain    (single-quote first-hit-wins core)
 *   - resolveQuotesFromChain   (multi-quote merge + `source` semantics core)
 *   - yahooQuoteProvider       (the real public provider; isPublic invariant)
 *
 * The pure resolution cores take an EXPLICIT provider chain, so mock providers
 * make the merge deterministic without any network. They keep working when a
 * future licensed feed is inserted ahead of Yahoo.
 *
 * Source: apps/web/lib/market/providers/quote-providers.ts
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { QuoteData } from "@/lib/market/yahoo-client";
import type { Exchange } from "@/lib/market/symbol-mapper";
import {
  resolveQuoteChain,
  resolveQuoteFromChain,
  resolveQuotesFromChain,
  yahooQuoteProvider,
  type QuoteProvider,
} from "@/lib/market/providers/quote-providers";

const NSE: Exchange = "NSE";

/** Minimal but complete QuoteData carrying a price (other fields are filler). */
function mkQuote(symbol: string, price: number): QuoteData {
  return {
    symbol,
    exchange: "NSE",
    name: symbol,
    price,
    change: 0,
    changePercent: 0,
    open: price,
    high: price,
    low: price,
    previousClose: price,
    volume: 0,
    timestamp: new Date(0),
  };
}

/** Mock public provider over a {symbol: price} table (real QuoteProvider shape). */
function mockProvider(data: Record<string, number>): QuoteProvider {
  return {
    name: "yahoo",
    isPublic: true,
    async fetchQuote(symbol) {
      return symbol in data ? mkQuote(symbol, data[symbol]!) : null;
    },
    async fetchQuotes(symbols) {
      const m = new Map<string, QuoteData>();
      for (const s of symbols) if (s in data) m.set(s, mkQuote(s, data[s]!));
      return m;
    },
  };
}

// ============== resolveQuoteChain (real providers) ==============

describe("resolveQuoteChain", () => {
  it("is Yahoo-only (MONEY-837 — no broker provider in web)", () => {
    const chain = resolveQuoteChain();
    assert.deepEqual(
      chain.map((p) => p.name),
      ["yahoo"]
    );
  });

  it("INVARIANT: the public provider is isPublic:true (cacheable cross-user)", () => {
    assert.equal(yahooQuoteProvider.isPublic, true);
    assert.equal(resolveQuoteChain()[0]!.isPublic, true);
  });
});

// ============== resolveQuoteFromChain (single, first-hit-wins) ==============

describe("resolveQuoteFromChain", () => {
  it("returns the first provider's quote (first-hit-wins)", async () => {
    const chain = [mockProvider({ TCS: 4000 }), mockProvider({ TCS: 3990 })];
    const { quote, source } = await resolveQuoteFromChain("TCS", NSE, chain);
    assert.equal(source, "yahoo");
    assert.equal(quote!.price, 4000); // first provider wins
  });

  it("falls through to a later provider when the first returns nothing", async () => {
    const chain = [mockProvider({}), mockProvider({ TCS: 3990 })];
    const { quote, source } = await resolveQuoteFromChain("TCS", NSE, chain);
    assert.equal(source, "yahoo");
    assert.equal(quote!.price, 3990);
  });

  it("reports the last provider as source when nothing is found", async () => {
    const chain = [mockProvider({}), mockProvider({})];
    const { quote, source } = await resolveQuoteFromChain("ZZZ", NSE, chain);
    assert.equal(quote, null);
    assert.equal(source, "yahoo");
  });
});

// ============== resolveQuotesFromChain (merge + source) ==============

describe("resolveQuotesFromChain", () => {
  it("fills missing symbols from later providers (first-hit-wins per symbol)", async () => {
    const chain = [
      mockProvider({ TCS: 4000, INFY: 1500 }),
      mockProvider({ TCS: 1, INFY: 1, RELIANCE: 2900 }),
    ];
    const { quotes, source } = await resolveQuotesFromChain(
      ["TCS", "INFY", "RELIANCE"],
      NSE,
      chain
    );
    assert.equal(source, "yahoo");
    assert.equal(quotes.TCS!.price, 4000); // first provider wins for TCS
    assert.equal(quotes.INFY!.price, 1500);
    assert.equal(quotes.RELIANCE!.price, 2900); // filled from later provider
    assert.equal(Object.keys(quotes).length, 3);
  });

  it("stops early once every symbol is resolved (no redundant later hit)", async () => {
    let laterCalls = 0;
    const counting: QuoteProvider = {
      name: "yahoo",
      isPublic: true,
      async fetchQuote() {
        return null;
      },
      async fetchQuotes(symbols) {
        laterCalls++;
        const m = new Map<string, QuoteData>();
        for (const s of symbols) m.set(s, mkQuote(s, 1));
        return m;
      },
    };
    const chain = [mockProvider({ TCS: 4000, INFY: 1500 }), counting];
    const { source } = await resolveQuotesFromChain(
      ["TCS", "INFY"],
      NSE,
      chain
    );
    assert.equal(source, "yahoo");
    assert.equal(
      laterCalls,
      0,
      "first provider covered all → later not called"
    );
  });
});
