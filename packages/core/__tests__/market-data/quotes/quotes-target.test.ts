/**
 * Which origin the quote poller talks to — MONEY-1469 (A4).
 *
 * One direction is cheap and one is not:
 *
 *   fail to the OLD route   a slower poll, correct prices, nobody notices
 *   fail to the NEW one     before India's keys are populated, every symbol is
 *                           a MISS and a watchlist renders blank rows
 *
 * So every ambiguous input must resolve to the legacy route.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  BROKER_STATUS_URL,
  LEGACY_QUOTE_URL,
  isQuotesFlagEnabled,
  isServiceQuotesUrl,
  resolveQuotesBaseUrl,
} from "../../../src/market-data/quotes/quotes-target";

const URL_OK = "https://market-data.usemoney.ai";

describe("the flag is compared LITERALLY", () => {
  it('"false" is false — Boolean("false") is true, which is the trap', () => {
    assert.equal(isQuotesFlagEnabled("false"), false);
    assert.equal(isQuotesFlagEnabled({ enabled: "false" }), false);
    assert.equal(isQuotesFlagEnabled(0), false);
    assert.equal(isQuotesFlagEnabled("no"), false);
    assert.equal(isQuotesFlagEnabled([]), false);
  });

  it("only an explicit true is true", () => {
    assert.equal(isQuotesFlagEnabled(true), true);
    assert.equal(isQuotesFlagEnabled("true"), true);
    assert.equal(isQuotesFlagEnabled("TRUE"), true);
    assert.equal(isQuotesFlagEnabled({ enabled: true }), true);
  });
});

describe("it fails safe to the route that already works", () => {
  it("flag on + a usable https origin is the ONLY path to the service", () => {
    assert.equal(
      resolveQuotesBaseUrl({ flagValue: true, marketDataUrl: URL_OK }),
      `${URL_OK}/quotes`,
    );
  });

  it("every ambiguous input lands on the legacy route", () => {
    for (const input of [
      { flagValue: undefined, marketDataUrl: URL_OK },
      { flagValue: false, marketDataUrl: URL_OK },
      { flagValue: true, marketDataUrl: undefined },
      { flagValue: true, marketDataUrl: "" },
      { flagValue: true, marketDataUrl: "   " },
      { flagValue: true, marketDataUrl: "/quotes" },
      { flagValue: true, marketDataUrl: "not a url" },
      // http is refused: a CDN-fronted origin has no reason to be plaintext.
      { flagValue: true, marketDataUrl: "http://market-data.usemoney.ai" },
    ]) {
      assert.equal(
        resolveQuotesBaseUrl(input),
        LEGACY_QUOTE_URL,
        JSON.stringify(input),
      );
    }
  });

  it("a path on the configured URL is DISCARDED, not appended to", () => {
    // `new URL("https://x/foo").origin` drops the path — otherwise a
    // misconfigured `.../api` would produce `/api/quotes` and 404 silently.
    assert.equal(
      resolveQuotesBaseUrl({
        flagValue: true,
        marketDataUrl: `${URL_OK}/api/v2`,
      }),
      `${URL_OK}/quotes`,
    );
  });

  it("isServiceQuotesUrl is what the hook branches on", () => {
    assert.equal(isServiceQuotesUrl(LEGACY_QUOTE_URL), false);
    assert.equal(isServiceQuotesUrl(`${URL_OK}/quotes`), true);
  });
});

describe("brokerStatus does not move to the service", () => {
  it("it has its own web route", () => {
    // It is an ENTITLEMENT gate read from a broker-connection row and has
    // nothing to do with market data. The service has no database and must
    // never learn about brokers.
    assert.equal(BROKER_STATUS_URL, "/api/market/broker-status");
    assert.notEqual(BROKER_STATUS_URL, LEGACY_QUOTE_URL);
  });
});
