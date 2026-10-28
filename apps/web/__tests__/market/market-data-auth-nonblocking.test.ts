/**
 * The chart's fetch wrapper must NEVER block on the token mint. MONEY-1480.
 *
 * ## WHY THE CHART WORKED LOCALLY AND NOT ON QA OR PROD
 *
 * `NEXT_PUBLIC_MARKET_DATA_URL` is unset in every local env file, so
 * `resolveUdfBaseUrl` returns the LEGACY route, `serviceOrigin` computes to ""
 * (the base does not start with "http"), and `installMarketDataFetch("")` is
 * INERT — `isService` is false for every URL. Locally the wrapper has never run.
 *
 * On QA and prod the variable IS set, so the wrapper is live, and it used to
 * `await getMarketDataToken()` before EVERY request to the service origin. That
 * mint is a Next.js server action doing Clerk auth, a subscription lookup, a US
 * entitlement check and a Mongo `getConfig` — four round trips in front of
 * `/udf/symbols`, which needs no token at all. The service's own smoke asserts
 * "daily bars still need no token" on every run.
 *
 * TradingView's vendored datafeed turns ANY rejected or slow-to-settle fetch
 * into `onError("unknown_symbol")`, which renders as "This symbol doesn't
 * exist" — an auth failure wearing a symbol-resolution message.
 *
 * So: one variable decided BOTH which origin serves the chart AND whether this
 * transport runs. These cases pin the property the fix restores — a request
 * goes out with whatever token is already cached, and never waits for one.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { mayCarryToken } from "@/lib/market/market-data-auth";

function src(): string {
  return readFileSync(
    join(
      dirname(new URL(import.meta.url).pathname),
      "..",
      "..",
      "lib",
      "market",
      "market-data-auth.ts"
    ),
    "utf8"
  );
}

function wrapperBody(s: string): string {
  const i = s.indexOf("export function installMarketDataFetch");
  assert.notEqual(i, -1, "installMarketDataFetch was not found — did it move?");
  return s.slice(i);
}

describe("the service-origin request path never awaits a mint", () => {
  it("the wrapper uses the CACHED token, not the awaited one", () => {
    const body = wrapperBody(src());
    assert.match(
      body,
      /const token = cachedMarketDataToken\(\)/,
      "the wrapper must read the already-held token synchronously"
    );
    assert.doesNotMatch(
      body,
      /await\s+getMarketDataToken\(/,
      "awaiting the mint here puts a four-round-trip server action in front of " +
        "/udf/symbols, which needs no token — and any hiccup renders as " +
        '"This symbol doesn\'t exist"'
    );
  });

  it("the cached accessor still WARMS the token for the next request", () => {
    // Anti-vacuity. Deleting the background mint would satisfy the case above
    // and quietly break intraday for ever: the token would never be minted at
    // all, so the one lane that genuinely needs it could never get one.
    const s = src();
    const i = s.indexOf("export function cachedMarketDataToken");
    assert.notEqual(i, -1, "cachedMarketDataToken must exist");
    const fn = s.slice(i, s.indexOf("\n}", i));
    assert.match(fn, /getMarketDataToken\(\)/, "it must kick off a mint");
    assert.match(
      fn,
      /void |\.catch\(/,
      "a background mint must not reject unhandled"
    );
    assert.match(
      fn,
      /return null/,
      "and it must return immediately, not await"
    );
  });

  it("an inert wrapper is still the LOCAL behaviour — serviceOrigin gates it", () => {
    // The other half of the RCA, pinned so it cannot silently change: when the
    // base URL is relative (no NEXT_PUBLIC_MARKET_DATA_URL), serviceOrigin is ""
    // and every request passes through untouched. That is why local never
    // exercised any of this.
    const body = wrapperBody(src());
    assert.match(
      body,
      /serviceOrigin !== ""/,
      "an empty origin must make the wrapper a pass-through"
    );
  });
});

describe("the token is still attached when we DO hold one", () => {
  it("Authorization is set from the cached token", () => {
    const body = wrapperBody(src());
    assert.match(body, /headers\.set\("Authorization", `Bearer \$\{token\}`\)/);
  });

  it("a 401 still drops the token so the next request re-mints", () => {
    const body = wrapperBody(src());
    assert.match(body, /response\.status === 401/);
    assert.match(body, /clearMarketDataToken\(\)/);
  });
});

describe("the wrapper touches ONLY routes a token can matter for", () => {
  // THE CHART BUG, pinned. Measured in the browser on a broken page:
  //
  //     /udf/config                   (failed)
  //     /udf/symbol_info?group=NYSE
  //     /udf/symbol_info?group=FOREX
  //     /udf/symbol_info?group=AMEX
  //     Series symbol resolve error: invalid symbol
  //
  // NYSE/FOREX/AMEX is the vendored datafeed's HARDCODED default exchange
  // list. It only requests `symbol_info?group=` when `supports_group_request`
  // is true, and ours is false — so the bundle never received our config.
  // `_requestConfiguration()` maps ANY failure to null and silently adopts a
  // built-in default demanding an endpoint this origin does not serve, and one
  // failed `/udf/config` poisons the chart for the whole page load.
  //
  // `/udf/config` is a CDN-cached constant. It had been made to depend on a
  // Next.js server action — Clerk, a subscription read, a Mongo getConfig —
  // whose own stack trace showed up as `w.fetch -> fetchServerAction ->
  // Failed to fetch`.
  it("config, time and search are NEVER intercepted", () => {
    const s = src();
    const i = s.indexOf("function mayCarryToken");
    assert.notEqual(i, -1, "mayCarryToken must exist");
    const fn = s.slice(i, s.indexOf("\n}", i));
    for (const pub of ["/udf/config", "/udf/time", "/udf/search"]) {
      assert.ok(
        !fn.includes(pub),
        `${pub} is public — the wrapper must not gate it on a token`
      );
    }
  });

  it("EXECUTED, not scanned: the predicate admits exactly the gated routes", () => {
    // The scans above cannot see WHICH policy is implemented, only that some
    // strings are present — and a review proved exactly that. An earlier cut
    // excluded `/udf/symbols` and every source scan here passed, while the US
    // lane could never resolve for anyone: `symbols.ts` calls
    // `checkMarketToken` on its US branch, and the client had guaranteed the
    // header was absent. The test even ASSERTED the wrong policy, so the
    // correct fix failed it.
    //
    // So the predicate is RUN, over both sides of the boundary.
    const O = "https://market-data-qa.usemoney.ai";
    for (const p of [
      "/quotes?symbols=RELIANCE&market=IN",
      "/udf/history?symbol=NSE%3ARELIANCE&resolution=5",
      "/udf/symbols?symbol=AAPL%3ANASDAQ%3A1980-12-12",
    ]) {
      assert.equal(mayCarryToken(O + p, O), true, `${p} must carry the token`);
    }
    for (const p of ["/udf/config", "/udf/time", "/udf/search?query=REL"]) {
      assert.equal(
        mayCarryToken(O + p, O),
        false,
        `${p} is public — coupling it to the mint is what broke the chart`
      );
    }
  });

  it("and the predicate actually gates the interception", () => {
    // Anti-vacuity: a `mayCarryToken` nothing calls would pass the case above
    // while every public route still went through the mint.
    assert.match(wrapperBody(src()), /mayCarryToken\(url, serviceOrigin\)/);
  });
});

describe("a refusing mint cannot storm", () => {
  it("a failure is recorded and backed off", () => {
    // Measured in local dev with MARKET_DATA_TOKEN_SECRET unset: ~15
    // server-action POSTs to /stock/RELIANCE in ONE page load, each refusing in
    // 3 ms. Nothing is cached on failure, so without a backoff every service
    // request re-fires the mint — competing with the requests the chart waits
    // on. A signed-out visitor is the NORMAL case for this, not an edge one.
    const s = src();
    assert.match(s, /failedAtMs = Date\.now\(\)/, "a failure must be recorded");
    assert.match(s, /FAILURE_BACKOFF_MS/, "and honoured before re-minting");
    const i = s.indexOf("export function cachedMarketDataToken");
    const fn = s.slice(i, s.indexOf("\n}", i));
    assert.match(
      fn,
      /now - failedAtMs >= FAILURE_BACKOFF_MS/,
      "the warm path must check the backoff, not just set it"
    );
  });
});
