/**
 * `GET /quotes` through the real Hono app. MONEY-1469 (A4).
 *
 * Redis is not reachable here, so what executes is the route, the parse, the
 * response mapping and the headers — and the store's own "no client" path,
 * which is the honest local-dev state and must answer a clean, named MISS
 * rather than an error.
 *
 * The expensive failure this covers: a batch that answers 200 with an empty
 * body for a MALFORMED request looks exactly like "none of your symbols have
 * quotes", and a caller retries it forever.
 */
import test from "node:test";
import assert from "node:assert/strict";

import { createApp } from "../src/app";
import { CACHE_CONTROL } from "../src/app-logic";
import { MAX_QUOTE_SYMBOLS } from "@usemoney/core/market-data/quotes/quote-request";
import { bearer, TEST_SECRET } from "./helpers/mint";

const app = createApp();
process.env.MARKET_DATA_TOKEN_SECRET = TEST_SECRET;

/** A request from a signed-in caller with NO US licence — the common case. */
const IN = { headers: bearer() };

test("an ANONYMOUS request is refused — this route shipped with no auth at all", async () => {
  // It was mounted under only requestId/secureHeaders/cors, and CORS is a
  // browser policy, not access control. The route it replaces
  // (`apps/web/app/api/market/quote`) calls `auth()`; serving the same data
  // from a public origin removed that.
  const res = await app.request("http://local/quotes?symbols=TCS");
  assert.equal(res.status, 401);
  assert.equal(((await res.json()) as { s: string }).s, "error");
});

test("a token WITHOUT the us claim cannot read market=US — the LICENCE gate", async () => {
  // `market=US` resolves to `rt:us:quote:<SYMBOL>`, the live Tiingo socket
  // keyspace. Tiingo Commercial is INTERNAL USE ONLY: serving a US price to a
  // user is redistribution and needs MONEY-1262. Fail-closed on an absent
  // claim — tokens minted before this existed carry none.
  const res = await app.request(
    "http://local/quotes?symbols=AAPL&market=US",
    IN,
  );
  assert.equal(res.status, 403);
  assert.match(
    ((await res.json()) as { errmsg: string }).errmsg,
    /not available on this account/,
  );
});

test("`us: true` opens market=US, and nothing else does", async () => {
  const res = await app.request("http://local/quotes?symbols=AAPL&market=US", {
    headers: bearer({ us: true }),
  });
  assert.equal(res.status, 200, "the licence claim is what opens it");
  // A PLAN claim must not: one PlatformConfig write meant for India intraday
  // would otherwise ship US data to every subscriber on that tier.
  const viaPlan = await app.request(
    "http://local/quotes?symbols=AAPL&market=US",
    {
      headers: bearer({ intraday: true }),
    },
  );
  assert.equal(viaPlan.status, 403, "a plan tier is not a licence");
});

test("a malformed request is a 400, not an empty 200", async () => {
  for (const qs of [
    "",
    "?symbols=",
    "?symbols=%20,%20",
    "?symbols=TCS&market=EU",
  ]) {
    const res = await app.request(`http://local/quotes${qs}`, IN);
    assert.equal(res.status, 400, qs);
    assert.equal(((await res.json()) as { s: string }).s, "error");
  }
});

test("an oversized batch is REFUSED, not truncated", async () => {
  const many = Array.from(
    { length: MAX_QUOTE_SYMBOLS + 1 },
    (_, i) => `S${i}`,
  ).join(",");
  const res = await app.request(`http://local/quotes?symbols=${many}`, IN);
  assert.equal(res.status, 400);
  // Truncating would return a `missing` array that omits the symbols nobody
  // looked up — indistinguishable from "those have no quotes", which sends the
  // caller to a vendor for data it never requested.
  assert.match(
    ((await res.json()) as { errmsg: string }).errmsg,
    /too many symbols/,
  );
});

test("no Redis is a clean, NAMED miss — never an error", async () => {
  const res = await app.request("http://local/quotes?symbols=RELIANCE,TCS", IN);
  assert.equal(res.status, 200);
  const body = (await res.json()) as {
    s: string;
    data: Record<string, unknown>;
    missing: string[];
    hits: number;
    misses: number;
  };
  assert.equal(body.s, "ok");
  assert.deepEqual(body.data, {});
  // NAMED per symbol, so a caller can fall back for exactly those and nothing
  // else — a partial miss is the normal case, not a failure.
  assert.deepEqual(body.missing.sort(), ["RELIANCE", "TCS"]);
  assert.equal(body.hits, 0);
  assert.equal(body.misses, 2);
});

test("`missing` names what the CALLER asked for, not the storage key", async () => {
  // The store keys India as `SYMBOL:EXCHANGE`. Handing that back would make
  // every lookup on the client miss while the payload looked full.
  const res = await app.request(
    "http://local/quotes?symbols=RELIANCE&exchange=NSE",
    IN,
  );
  const body = (await res.json()) as { missing: string[] };
  assert.deepEqual(body.missing, ["RELIANCE"]);
  assert.ok(
    !body.missing[0]!.includes(":"),
    "no venue suffix leaks to the caller",
  );
});

test("the response is PRIVATE — the CDN must not share one user's batch", async () => {
  const res = await app.request("http://local/quotes?symbols=TCS", IN);
  const cc = res.headers.get("Cache-Control") ?? "";
  assert.equal(cc, CACHE_CONTROL.quotes);
  assert.match(cc, /private/);
  assert.doesNotMatch(cc, /public|s-maxage/);
});

test("the service advertises the route", async () => {
  // A1's root listing is how an operator discovers what is live; a route that
  // exists and is not listed is a route nobody finds.
  const res = await app.request("http://local/");
  const body = (await res.json()) as { endpoints: string[] };
  assert.ok(body.endpoints.includes("/quotes"));
});
