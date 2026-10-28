/**
 * The quote chain routes by MARKET — REAL logic test (MONEY-1309).
 *
 * Exercises the ACTUAL exports of `@/lib/market/providers/quote-providers` and
 * `@/lib/market/quote-exchange`. No network: the chain-resolution cores take an
 * EXPLICIT provider array, and the venue guard is pure.
 *
 * ## The defect this is written against
 *
 * `toYahooSymbol` appends `.NS` to anything that is not BSE. Hand it `DOW` with
 * `exchange: "NASDAQ"` and it returns `DOW.NS` — a REAL NSE symbol belonging to
 * a different company — and Yahoo answers it. The failure is not an error, it is
 * a confident wrong price, which is strictly worse than no price. Two things
 * have to hold for that to be impossible, and both are asserted:
 *
 *   1. `resolveQuoteChain("NASDAQ")` must not contain the Yahoo provider, and
 *   2. `yahooQuoteProvider` must REFUSE a US venue even if handed one directly,
 *      because a chain is data and data can be assembled wrongly.
 *
 * (1) alone would be a single point of failure — exactly the shape
 * `no-feed-fetch-bypass.test.ts` records being bypassed by moving a call one hop
 * away.
 *
 * Source: apps/web/lib/market/providers/quote-providers.ts
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import type { QuoteData } from "@/lib/market/yahoo-client-logic";
import {
  resolveQuoteChain,
  resolveQuoteFromChain,
  resolveQuotesFromChain,
  tiingoUsQuoteProvider,
  yahooQuoteProvider,
  type QuoteProvider,
} from "@/lib/market/providers/quote-providers";
import {
  isUsExchange,
  normalizeUsExchange,
  resolveQuoteExchange,
  type QuoteExchange,
} from "@/lib/market/quote-exchange";

function mkQuote(
  symbol: string,
  price: number,
  provenance?: QuoteData["provenance"]
): QuoteData {
  return {
    symbol,
    exchange: "NASDAQ",
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
    ...(provenance ? { provenance } : {}),
  };
}

/** A stand-in for the US provider that records what venue it was handed. */
function recordingProvider(
  name: QuoteProvider["name"],
  data: Record<string, number>
): QuoteProvider & { seen: QuoteExchange[] } {
  const seen: QuoteExchange[] = [];
  return {
    name,
    isPublic: false,
    seen,
    async fetchQuote(symbol, exchange) {
      seen.push(exchange);
      return symbol in data ? mkQuote(symbol, data[symbol]!) : null;
    },
    async fetchQuotes(symbols, exchange) {
      seen.push(exchange);
      const m = new Map<string, QuoteData>();
      for (const s of symbols) {
        if (s in data) m.set(s, mkQuote(s, data[s]!));
      }
      return m;
    },
  };
}

describe("venue routing (MONEY-1309)", () => {
  it("[meta] the guard actually distinguishes the two markets", () => {
    // Ceiling. Every claim below is "the chain differs by venue", which a guard
    // stuck on one answer would satisfy in one direction and silently break in
    // the other.
    assert.equal(isUsExchange("NASDAQ"), true);
    assert.equal(isUsExchange("NSE"), false);
    assert.equal(normalizeUsExchange("nasdaq"), "NASDAQ");
  });

  it("India venues get the Yahoo chain, unchanged", () => {
    for (const venue of ["NSE", "BSE"] as const) {
      const chain = resolveQuoteChain(venue);
      assert.equal(chain.length, 1);
      assert.equal(chain[0], yahooQuoteProvider);
    }
    // The default argument keeps every pre-MONEY-1309 caller on Yahoo.
    assert.equal(resolveQuoteChain()[0], yahooQuoteProvider);
  });

  it("US venues get the Tiingo chain and NO Yahoo behind it", () => {
    for (const venue of ["NASDAQ", "NYSE", "AMEX", "NMFQS"] as const) {
      const chain = resolveQuoteChain(venue);
      assert.equal(chain[0], tiingoUsQuoteProvider, `chain head for ${venue}`);
      assert.ok(
        !chain.includes(yahooQuoteProvider),
        `Yahoo is in the ${venue} chain. \`resolveQuotesFromChain\` would merge ` +
          `its answer in under the same response key, which is how DOW.NS ` +
          `(a different company) becomes DOW's price.`
      );
    }
  });

  it("the US provider is NOT public — Commercial plan is internal-use-only", () => {
    // `isPublic` gates the cross-user `_global` shared cache. Tiingo's
    // Commercial licence forbids redistribution (MONEY-1262), so these quotes
    // must never land in a store other users read from.
    assert.equal(tiingoUsQuoteProvider.isPublic, false);
    assert.equal(yahooQuoteProvider.isPublic, true);
  });

  it("yahooQuoteProvider REFUSES a US venue even when handed one directly", async () => {
    // The second line of defence. A chain is data; this is the provider
    // refusing to suffix `DOW` into `DOW.NS` no matter who assembled it.
    assert.equal(await yahooQuoteProvider.fetchQuote("DOW", "NASDAQ"), null);
    const many = await yahooQuoteProvider.fetchQuotes(["DOW", "AAPL"], "NYSE");
    assert.equal(many.size, 0);
  });

  it("resolveQuoteExchange canonicalises US and defaults everything else to NSE", () => {
    assert.equal(resolveQuoteExchange("nasdaq"), "NASDAQ");
    assert.equal(resolveQuoteExchange("NYSE ARCA"), "NYSE ARCA");
    assert.equal(resolveQuoteExchange("BSE"), "BSE");
    assert.equal(resolveQuoteExchange(null), "NSE");
    assert.equal(resolveQuoteExchange(""), "NSE");
  });

  it("[regression] an unrecognised venue is NSE, not itself cast into Exchange", () => {
    // It used to be `(value || "NSE") as Exchange`, so `?exchange=LSE` came back
    // as the literal "LSE" typed as `"NSE" | "BSE"` — a lie to the compiler that
    // the doc comment above the function already denied ("anything else … falls
    // back to NSE"). Downstream, `toYahooSymbol` suffixes anything non-BSE with
    // `.NS`, so the request became an NSE one anyway; the value that reached
    // every `exchange === "BSE" ? … : …` branch and the echoed response was
    // simply wrong.
    assert.equal(resolveQuoteExchange("LSE"), "NSE");
    assert.equal(resolveQuoteExchange("nonsense"), "NSE");
    assert.equal(resolveQuoteExchange("bse"), "BSE", "case is not a guess");
  });
});

describe("provenance survives the chain (MONEY-1309)", () => {
  it("a per-quote provenance reaches the caller intact", async () => {
    const live = mkQuote("AAPL", 200, {
      source: "TIINGO_RT",
      asOf: "2026-08-31T18:00:00.000Z",
      fallback: false,
      session: "rth",
    });
    const provider: QuoteProvider = {
      name: "TIINGO",
      isPublic: false,
      async fetchQuote() {
        return live;
      },
      async fetchQuotes() {
        return new Map([["AAPL", live]]);
      },
    };

    const single = await resolveQuoteFromChain("AAPL", "NASDAQ", [provider]);
    assert.equal(single.quote?.provenance?.source, "TIINGO_RT");
    assert.equal(single.quote?.provenance?.fallback, false);

    const many = await resolveQuotesFromChain(["AAPL"], "NASDAQ", [provider]);
    assert.equal(
      many.quotes.AAPL?.provenance?.asOf,
      "2026-08-31T18:00:00.000Z"
    );
  });

  it("the venue is handed through to the provider unchanged", async () => {
    // A provider that received "NSE" for a NASDAQ request would query the wrong
    // collection and return an empty map — which reads as "no data", not as a
    // routing bug.
    const provider = recordingProvider("TIINGO", { AAPL: 200 });
    await resolveQuotesFromChain(["AAPL"], "NYSE ARCA", [provider]);
    assert.deepEqual(provider.seen, ["NYSE ARCA"]);
  });
});
