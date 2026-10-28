/**
 * The SSE stream serves US symbols — MONEY-1309.
 *
 * `/api/market/stream` was a complete, 27-test SSE route with ZERO consumers.
 * MONEY-1309 extends it rather than adding a second one: the auth, the per-user
 * connection cap, the abort wiring and the frame grammar are four things that
 * must not be allowed to drift into two copies. So the assertions here come in
 * two halves.
 *
 *   1. The PURE half — `parseExchange` now resolves a US venue — runs against the
 *      real exported function.
 *   2. The ROUTE half is a source scan, because the handler is a `ReadableStream`
 *      over Clerk auth and a Redis singleton and this suite has no server. What
 *      it checks is not cosmetic: that the US path polls `mget` rather than
 *      opening a SUBSCRIBE (a second Redis connection per web instance against a
 *      ~50-connection ceiling — MONEY-1127), that the India path's symbol
 *      suffixing is not applied to US tickers, and that both markets emit the
 *      same frame shape.
 *
 * A source scan is a weaker instrument than a request, and it is named as such
 * rather than dressed up: it is what can actually be checked with `node:test`
 * and no DOM/server, and it is the same instrument
 * `delayed-data-note.test.ts` already uses for a claim of this shape.
 *
 * Source: apps/web/app/api/market/stream/{route,stream-logic}.ts
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
  POLL_INTERVAL,
  parseExchange,
  formatConnectMessage,
} from "@/app/api/market/stream/stream-logic";
import { resolveQuoteExchange } from "@/lib/market/quote-exchange";

const ROUTE = join("app", "api", "market", "stream", "route.ts");
const routeSrc = readFileSync(ROUTE, "utf8");

/** The handler body, with the header comment stripped — prose is not code. */
function routeBody(): string {
  const end = routeSrc.indexOf("*/");
  assert.ok(
    end > 0,
    "ceiling: the stream route has no header comment to strip"
  );
  return routeSrc.slice(end + 2);
}

describe("stream-logic accepts US venues (MONEY-1309)", () => {
  it("[meta] the module under test is the real one", () => {
    // Ceiling: `POLL_INTERVAL` is the route's own constant, so importing a
    // stub or a stale copy shows up here rather than as a silent pass.
    assert.equal(POLL_INTERVAL, 5000);
    assert.ok(routeSrc.length > 2000, `route read as ${routeSrc.length} chars`);
  });

  it("resolves a US venue to its canonical spelling", () => {
    assert.equal(parseExchange("NASDAQ"), "NASDAQ");
    assert.equal(parseExchange("nasdaq"), "NASDAQ");
    assert.equal(parseExchange("nyse arca"), "NYSE ARCA");
  });

  it("leaves India — and the historic default — exactly as they were", () => {
    assert.equal(parseExchange(null), "NSE");
    assert.equal(parseExchange(""), "NSE");
    assert.equal(parseExchange("BSE"), "BSE");
  });

  it("[regression] the stream and the quote route resolve a venue IDENTICALLY", () => {
    // They were two implementations held in agreement by a comment saying they
    // were "deliberately the same function shape … so the stream and the quote
    // route cannot disagree". The route's stopped casting an unrecognised
    // string into `Exchange`; this one would have kept doing it. `parseExchange`
    // now delegates, so the two cannot drift.
    for (const raw of [null, "", "LSE", "nonsense", "BSE", "bse", "nasdaq"]) {
      assert.equal(
        parseExchange(raw),
        resolveQuoteExchange(raw),
        `the stream and the quote route disagree about ?exchange=${raw}`
      );
    }
    assert.equal(parseExchange("LSE"), "NSE");
  });

  it("the connect frame echoes the US venue back to the client", () => {
    const frame = JSON.parse(formatConnectMessage(["AAPL"], "NASDAQ"));
    assert.equal(frame.type, "connected");
    assert.equal(frame.exchange, "NASDAQ");
    assert.deepEqual(frame.symbols, ["AAPL"]);
  });
});

describe("the stream route's US poll (MONEY-1309)", () => {
  it("reads the US quotes through the shared read path", () => {
    const body = routeBody();
    assert.match(
      body,
      /tiingo-rt-read/,
      "the US poll does not go through `resolveUsQuotes`. One implementation, " +
        "two callers (this route and /api/market/quote) is the reason it lives " +
        "in core at all."
    );
  });

  it("[regression] one poll at a time, and every poll bounded", () => {
    const body = routeBody();
    // `setInterval` fires on a clock, not on completion, so a tick that
    // overruns the 5s cadence is JOINED by the next one rather than replacing
    // it. The US body is a Redis `mget` plus up to a dozen Mongo queries and
    // neither carries a client-side deadline, so a wedged store multiplies the
    // load instead of slowing it: at the 5-connection per-user cap that is
    // ~60 Mongo queries per 5s per user, stacking indefinitely.
    assert.match(
      body,
      /inFlight/,
      "the SSE poll has no in-flight latch, so slow ticks stack"
    );
    assert.match(
      body,
      /if\s*\(!isConnected\s*\|\|\s*inFlight\)\s*return;/,
      "the latch is declared but the poll does not bail on it"
    );
    assert.match(
      body,
      /finally\s*\{\s*\n?\s*inFlight\s*=\s*false;/,
      "the latch is not released in a `finally` — one throw wedges the stream " +
        "permanently, which is worse than the stacking it was added to stop"
    );
    // The cached quote path wraps the identical call in `withBudget` and says
    // why; this one called it bare.
    assert.match(
      body,
      /withBudget\(/,
      "the SSE poll runs unbounded while the cached path bounds the same call"
    );
  });

  it("does NOT open a Redis subscriber", () => {
    const body = routeBody();
    // ioredis puts a subscribed client into a mode where it can issue nothing
    // else, so SUBSCRIBE means a SECOND connection per web instance against a
    // node whose documented ceiling is ~50 (MONEY-1127). The read path polls
    // the connection the process already holds.
    assert.doesNotMatch(
      body,
      /\.(p?subscribe)\s*\(/,
      "the stream route opened a Redis subscriber. That is a second connection " +
        "per web instance; poll the shared client with mget instead."
    );
    assert.doesNotMatch(
      body,
      /new\s+Redis\s*\(/,
      "the stream route constructed its own Redis client — `getRedisClient()` " +
        "is the one sanctioned singleton (MONEY-1127)."
    );
  });

  it("never suffixes a US ticker through toYahooSymbol", () => {
    const body = routeBody();
    // `toYahooSymbol("DOW", <anything but BSE>)` is `DOW.NS`, a real NSE symbol
    // for a different company. The mapping must be guarded by the venue check.
    assert.match(
      body,
      /isUsExchange\(exchange\)\s*\n?\s*\?\s*\[\]/,
      "the Yahoo symbol mapping is no longer gated on the venue — a US ticker " +
        "would be suffixed `.NS` and answered by a different company."
    );
  });

  it("keeps ONE frame grammar for both markets", () => {
    const body = routeBody();
    // Both branches feed the same `type: "quotes"` envelope, so a consumer
    // needs no per-market branch. Two enqueue sites with two shapes is how the
    // formats drift.
    const quoteFrames = body.match(/type:\s*"quotes"/g) ?? [];
    assert.equal(
      quoteFrames.length,
      1,
      `found ${quoteFrames.length} "quotes" frame builders; there must be exactly one`
    );
  });

  it("keeps the per-user connection cap and the abort teardown", () => {
    const body = routeBody();
    // The reason for extending this route instead of writing a second one. If
    // these went missing, a US stream would leak connections and ignore the cap.
    assert.match(body, /checkConnectionLimit\(/);
    assert.match(body, /incrementConnection\(/);
    assert.match(body, /decrementConnection\(/);
    assert.match(body, /clearInterval\(intervalId\)/);
  });
});
