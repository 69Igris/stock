/**
 * The `/quotes` request contract — MONEY-1469 (A4).
 *
 * The expensive failure in this module is not a bad 400. It is a READER and a
 * WRITER that spell one key two ways: every lookup misses, `missing` names
 * every symbol, the caller falls back to the vendor the ticket existed to stop
 * calling, and nothing anywhere reports an error. It happened twice while this
 * was being built — once on the Redis TYPE (hash vs string) and once on the
 * exchange suffix — so the agreement is asserted here from BOTH sides rather
 * than described in a comment.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  DEFAULT_IN_EXCHANGE,
  MAX_QUOTE_SYMBOLS,
  parseQuoteRequest,
  toListingId,
} from "../../../src/market-data/quotes/quote-request";
import { quoteKey } from "../../../src/market-data/quotes/quote-logic";

describe("the key the READER builds is the key the WRITER builds", () => {
  it("agrees for India, where the exchange is part of the listing", () => {
    // THE WRITER: `refreshAllQuotes` has the instrument row in hand and builds
    // its listing id as `${inst.symbol}:${inst.exchange}`. Reproduced here as
    // an expression, not as a string literal, so the two cannot drift.
    const row = { symbol: "RELIANCE", exchange: "NSE" };
    const writerKey = quoteKey("IN", `${row.symbol}:${row.exchange}`);

    // THE READER: a browser asks for `?symbols=RELIANCE&exchange=NSE`.
    const parsed = parseQuoteRequest({ symbols: "reliance", exchange: "nse" });
    assert.ok(parsed.ok);
    const readerKey = quoteKey("IN", parsed.listingIds[0]!);

    assert.equal(readerKey, writerKey);
  });

  it("keeps NSE and BSE apart — they are two listings at two prices", () => {
    // A bare-symbol key would have the two exchanges overwrite one another all
    // night and the last writer would win, silently.
    assert.notEqual(
      quoteKey("IN", toListingId("RELIANCE", "IN", "NSE")),
      quoteKey("IN", toListingId("RELIANCE", "IN", "BSE")),
    );
  });

  it("US stays keyed by BARE SYMBOL, because the socket holder owns that key", () => {
    // `quoteKey` strips anything after the colon for US, so a listingId that
    // carries a venue still resolves to the key `main.ts:256` writes.
    assert.equal(quoteKey("US", "AAPL"), "rt:us:quote:AAPL");
    assert.equal(quoteKey("US", "AAPL:NASDAQ:1980-12-12"), "rt:us:quote:AAPL");
    assert.equal(
      toListingId("AAPL", "US", "NSE"),
      "AAPL",
      "no venue is appended for US",
    );
  });
});

describe("parsing", () => {
  it("defaults the India exchange to NSE", () => {
    const p = parseQuoteRequest({ symbols: "TCS" });
    assert.ok(p.ok);
    assert.equal(p.listingIds[0], `TCS:${DEFAULT_IN_EXCHANGE}`);
    assert.equal(p.requested[0], "TCS", "the caller's own spelling is kept");
  });

  it("an explicit venue on the symbol WINS over the query parameter", () => {
    const p = parseQuoteRequest({ symbols: "RELIANCE:BSE", exchange: "NSE" });
    assert.ok(p.ok);
    assert.deepEqual(p.listingIds, ["RELIANCE:BSE"]);
  });

  it("de-duplicates on the KEY, not on the string", () => {
    // `RELIANCE` and `RELIANCE:NSE` are one listing. Counting them twice would
    // put a phantom hit into the ratio the miss monitor reads.
    const p = parseQuoteRequest({ symbols: "RELIANCE,RELIANCE:NSE,reliance" });
    assert.ok(p.ok);
    assert.equal(p.listingIds.length, 1);
  });

  it("REFUSES an oversized batch rather than truncating it", () => {
    // A silently shortened list returns a `missing` array that omits the
    // symbols nobody looked up — indistinguishable from "those have no
    // quotes", which sends the caller to a vendor for data never requested.
    const many = Array.from(
      { length: MAX_QUOTE_SYMBOLS + 1 },
      (_, i) => `S${i}`,
    ).join(",");
    const p = parseQuoteRequest({ symbols: many });
    assert.equal(p.ok, false);
    assert.match(p.ok === false ? p.reason : "", /too many/);

    const atLimit = Array.from(
      { length: MAX_QUOTE_SYMBOLS },
      (_, i) => `S${i}`,
    ).join(",");
    assert.equal(
      parseQuoteRequest({ symbols: atLimit }).ok,
      true,
      "the limit itself is allowed",
    );
  });

  it("refuses an empty or unknown request rather than answering an empty batch", () => {
    // An empty `data` for a malformed request looks exactly like "none of your
    // symbols have quotes", and a caller would retry it forever.
    assert.equal(parseQuoteRequest({ symbols: "" }).ok, false);
    assert.equal(parseQuoteRequest({ symbols: " , , " }).ok, false);
    assert.equal(parseQuoteRequest({ symbols: "TCS", market: "EU" }).ok, false);
  });

  it("an empty exchange parameter falls back to the default, not to ':'", () => {
    const p = parseQuoteRequest({ symbols: "TCS", exchange: "  " });
    assert.ok(p.ok);
    assert.equal(p.listingIds[0], `TCS:${DEFAULT_IN_EXCHANGE}`, "never TCS:");
  });
});
