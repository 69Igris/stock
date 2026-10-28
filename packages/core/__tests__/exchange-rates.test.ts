/**
 * Currency exchange-rate service — REAL source edge coverage (MONEY-620).
 *
 * Source: packages/core/src/currency/exchange-rates.ts
 *
 * `getExchangeRate` now takes an OPTIONAL injectable fetcher (the
 * `ExchangeRateFetcher` DI seam, mirroring `YahooBatchQuoteFetcher` in
 * `../market-data/prices/quote-service.ts`). The default closes over the real
 * Yahoo `fetchQuotes`, so production callers are unchanged; tests drive the
 * provider-failure / stale-FX / unknown-pair / zero-or-negative-rate / cache-TTL
 * branches through a fake fetcher with NO network. Every cross-currency test
 * below uses a UNIQUE currency pair so the module-level 1-hour `rateCache`
 * cannot leak state between tests (only the explicit TTL test reuses a pair on
 * purpose).
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  getExchangeRate,
  convertCurrency,
  getUsdToInr,
  MARKET_CURRENCIES,
  type ExchangeRateFetcher,
  type ExchangeRateQuote,
} from "../src/currency/exchange-rates";

/**
 * Build a fake fetcher from a fixed symbol→quote map, counting invocations so
 * cache-skip behaviour is observable. Unknown symbols resolve to an absent map
 * entry (exactly what the real `fetchQuotes` does for an unresolved pair).
 */
function makeFetcher(quotes: Record<string, ExchangeRateQuote>): {
  fetch: ExchangeRateFetcher;
  calls: () => number;
} {
  let calls = 0;
  const fetch: ExchangeRateFetcher = async (symbols) => {
    calls++;
    const out = new Map<string, ExchangeRateQuote>();
    for (const s of symbols) {
      if (s in quotes) out.set(s, quotes[s]!);
    }
    return out;
  };
  return { fetch, calls: () => calls };
}

describe("getExchangeRate — same-currency short-circuit (network-free)", () => {
  it("identical codes → exactly 1 (no fetch)", async () => {
    assert.equal(await getExchangeRate("USD", "USD"), 1);
    assert.equal(await getExchangeRate("INR", "INR"), 1);
  });

  it("is case-insensitive on the same-currency check", async () => {
    assert.equal(await getExchangeRate("usd", "USD"), 1);
    assert.equal(await getExchangeRate("Inr", "inr"), 1);
  });
});

describe("convertCurrency — same-currency (network-free)", () => {
  it("converting within the same currency returns the amount unchanged", async () => {
    assert.equal(await convertCurrency(100, "INR", "INR"), 100);
    assert.equal(await convertCurrency(0, "USD", "USD"), 0);
  });

  it("EDGE: negative and zero amounts pass through the rate-of-1 multiply", async () => {
    assert.equal(await convertCurrency(-250.5, "EUR", "EUR"), -250.5);
    assert.equal(await convertCurrency(0, "GBP", "GBP"), 0);
  });
});

describe("MARKET_CURRENCIES — static map", () => {
  it("maps the supported markets to ISO currency codes", () => {
    assert.equal(MARKET_CURRENCIES.IN, "INR");
    assert.equal(MARKET_CURRENCIES.US, "USD");
    assert.equal(MARKET_CURRENCIES.GB, "GBP");
    assert.equal(MARKET_CURRENCIES.JP, "JPY");
  });

  it("EDGE: an unknown market key resolves to undefined (no throw)", () => {
    assert.equal(MARKET_CURRENCIES["ZZ"], undefined);
    assert.equal(MARKET_CURRENCIES[""], undefined);
  });
});

// ── Provider / cache branches — driven through the injected fetcher ───
//
// These exercise the previously-uncoverable network paths via the DI seam:
// happy direct pair, reverse-pair inversion, unknown pair → null, provider
// throw → null fallback, the zero/negative positivity guard, and the 1-hour
// cache TTL. No real network is touched.

describe("getExchangeRate — direct + reverse pair (injected fetcher)", () => {
  it("returns the direct pair's regularMarketPrice", async () => {
    // Unique pair (Aruba florin → Bhutan ngultrum) to avoid cache collisions.
    const { fetch } = makeFetcher({ "AWGBTN=X": { regularMarketPrice: 46.5 } });
    assert.equal(await getExchangeRate("AWG", "BTN", fetch), 46.5);
  });

  it("falls back to the reverse pair and inverts it (1 / rate)", async () => {
    // Only the reverse symbol resolves → source must invert it.
    const { fetch, calls } = makeFetcher({
      "FJDWST=X": { regularMarketPrice: 4 }, // reverse of WSTFJD
    });
    const rate = await getExchangeRate("WST", "FJD", fetch);
    assert.equal(rate, 0.25); // 1 / 4
    assert.equal(calls(), 2); // direct miss, then reverse hit
  });

  it("is case-insensitive when building the pair symbol", async () => {
    const { fetch } = makeFetcher({ "NPRPGK=X": { regularMarketPrice: 12 } });
    assert.equal(await getExchangeRate("npr", "Pgk", fetch), 12);
  });
});

describe("getExchangeRate — unknown pair / stale-or-empty quote → null", () => {
  it("unknown pair (neither direct nor reverse resolves) → null", async () => {
    const { fetch, calls } = makeFetcher({}); // every symbol absent
    assert.equal(await getExchangeRate("XAA", "XBB", fetch), null);
    assert.equal(calls(), 2); // tried direct AND reverse before giving up
  });

  it("stale/empty quote: symbol present but no regularMarketPrice → null", async () => {
    // Present-but-priceless on BOTH direct and reverse → null fallback.
    const { fetch } = makeFetcher({
      "XCCXDD=X": {}, // direct: no price field
      "XDDXCC=X": { regularMarketPrice: null }, // reverse: explicit null
    });
    assert.equal(await getExchangeRate("XCC", "XDD", fetch), null);
  });
});

describe("getExchangeRate — provider throws → catch returns null", () => {
  it("fetcher rejection is swallowed, yields null (no leak)", async () => {
    const boom: ExchangeRateFetcher = async () => {
      throw new Error("Yahoo Finance API error: 503 Service Unavailable");
    };
    assert.equal(await getExchangeRate("XEE", "XFF", boom), null);
  });

  it("convertCurrency surfaces null (not NaN) when the provider throws", async () => {
    const boom: ExchangeRateFetcher = async () => {
      throw new Error("network down");
    };
    assert.equal(await convertCurrency(1000, "XGG", "XHH", boom), null);
  });
});

describe("getExchangeRate — positivity guard (zero / negative / NaN rejected)", () => {
  it("a ZERO upstream rate is rejected (treated as provider failure)", async () => {
    // BUGFIX (MONEY-620): the source previously cached ANY regularMarketPrice,
    // so a 0 would corrupt every downstream conversion. Now rejected → null.
    const { fetch } = makeFetcher({ "XIIXJJ=X": { regularMarketPrice: 0 } });
    assert.equal(await getExchangeRate("XII", "XJJ", fetch), null);
  });

  it("a NEGATIVE upstream rate is rejected → falls through to null", async () => {
    const { fetch } = makeFetcher({ "XKKXLL=X": { regularMarketPrice: -5.2 } });
    assert.equal(await getExchangeRate("XKK", "XLL", fetch), null);
  });

  it("a NaN upstream rate is rejected → null", async () => {
    const { fetch } = makeFetcher({ "XMMXNN=X": { regularMarketPrice: NaN } });
    assert.equal(await getExchangeRate("XMM", "XNN", fetch), null);
  });

  it("a zero DIRECT rate still lets a valid REVERSE rate win (not cached as 0)", async () => {
    // Direct is 0 (invalid) but reverse is good → must invert the reverse,
    // proving the guard rejects-then-continues rather than caching the 0.
    const { fetch } = makeFetcher({
      "XOOXPP=X": { regularMarketPrice: 0 }, // invalid direct
      "XPPXOO=X": { regularMarketPrice: 8 }, // valid reverse
    });
    assert.equal(await getExchangeRate("XOO", "XPP", fetch), 0.125); // 1/8
  });
});

describe("getExchangeRate — 1-hour in-memory cache TTL", () => {
  it("a second call within TTL is served from cache (fetcher NOT re-invoked)", async () => {
    // Dedicated pair so no other test seeds/evicts this cache key.
    const { fetch, calls } = makeFetcher({
      "CACHRAT=X": { regularMarketPrice: 83.21 },
    });

    const first = await getExchangeRate("CAC", "HRAT", fetch);
    assert.equal(first, 83.21);
    assert.equal(calls(), 1);

    // Second call within the 1h TTL: a DIFFERENT fetcher that would throw if
    // ever called — proves the value came from cache, not a re-fetch.
    const exploding: ExchangeRateFetcher = async () => {
      throw new Error("cache miss: fetcher should not have been called");
    };
    const second = await getExchangeRate("CAC", "HRAT", exploding);
    assert.equal(second, 83.21);
    assert.equal(calls(), 1); // original fetcher still only called once
  });

  it("an invalid (zero) rate is NOT cached: a later valid fetch is honoured", async () => {
    // First fetch returns 0 (rejected, uncached) → null. A later fetch for the
    // SAME pair returns a good rate, which must be used (proving 0 wasn't cached).
    const bad = makeFetcher({ "RECOVR=X": { regularMarketPrice: 0 } });
    assert.equal(await getExchangeRate("REC", "OVR", bad.fetch), null);

    const good = makeFetcher({ "RECOVR=X": { regularMarketPrice: 7.5 } });
    assert.equal(await getExchangeRate("REC", "OVR", good.fetch), 7.5);
  });
});

describe("convertCurrency — through the injected fetcher", () => {
  it("multiplies the amount by the fetched rate", async () => {
    const { fetch } = makeFetcher({ "XQQXRR=X": { regularMarketPrice: 2.5 } });
    assert.equal(await convertCurrency(40, "XQQ", "XRR", fetch), 100);
  });

  it("returns null (not NaN) when no rate is available", async () => {
    const { fetch } = makeFetcher({}); // unknown pair
    assert.equal(await convertCurrency(40, "XSS", "XTT", fetch), null);
  });
});

describe("getUsdToInr — convenience wrapper (injected fetcher)", () => {
  it("delegates to getExchangeRate('USD','INR') and returns the USDINR rate", async () => {
    const { fetch, calls } = makeFetcher({
      "USDINR=X": { regularMarketPrice: 84.12 },
    });
    assert.equal(await getUsdToInr(fetch), 84.12);
    assert.equal(calls(), 1);
  });
});
