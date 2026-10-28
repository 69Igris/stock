/**
 * MONEY-1198 — an UNBUDGETED Yahoo call gave its auth handshake a 1 ms deadline.
 *
 * ## The defect
 *
 * `withDeadline(promise, ms, label)` guarded only `ms <= 0`. `Infinity <= 0` is
 * false, so an unbudgeted call fell through to `setTimeout(..., Infinity)`,
 * which Node cannot fit in a 32-bit signed int and therefore CLAMPS TO 1 ms:
 *
 *   TimeoutOverflowWarning: Infinity does not fit into a 32-bit signed integer.
 *   Timeout duration was set to 1.
 *
 * Every caller that passes no `deadline` — `fetchChart`, `fetchQuoteSummary`,
 * `fetchSearch` — reaches it with `remaining()` = Infinity, so auth refresh was
 * racing a 1 ms timer on every one of them.
 *
 * ## Why no existing test caught it
 *
 * The auth cache is process-global and normally warm, and the mocked handshake
 * answered in well under a millisecond — so the timer never won and the bug was
 * unobservable. It only bites on a COLD or 401-invalidated cache, where
 * `getAuth()` makes two real network round trips.
 *
 * That is what this file reproduces: a cold cache plus a handshake that is
 * merely SLOW, not failing. The failure is silent — the rejection escapes from
 * an `await` sitting OUTSIDE the retry `try`, so `fetchChart` returns `[]`
 * rather than throwing, and an empty array reads as "no data for this symbol"
 * instead of "the request failed". Same silent-empty class as a feed-archive
 * replay miss.
 *
 * The file is deliberately SEPARATE from yahoo-api-contract.test.ts because the
 * auth cache is module-global: a sibling test that warmed it first would make
 * the handshake here a no-op, and this suite would pass by exercising nothing.
 *
 * Source: packages/core/src/market-data/yahoo-api.ts (withDeadline)
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { fetchChart } from "../../src/market-data/yahoo-api";
import { installMockAgent } from "../_contracts/mock-agent";

const YAHOO_ORIGIN = "https://query2.finance.yahoo.com";

const FIXTURE_DIR = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "_contracts",
  "__fixtures__",
);

function loadFixture(name: string): unknown {
  return JSON.parse(readFileSync(join(FIXTURE_DIR, name), "utf8"));
}

/**
 * Comfortably longer than the 1 ms Node clamps Infinity to, and short enough to
 * stay far from the 30 s wall-clock test timeout even under the CI contention
 * that has produced 12m55s test steps.
 */
const SLOW_AUTH_MS = 60;

/** The cold-cache case: an auth handshake that is SLOW, not failing. */
function stubSlowAuth(mock: ReturnType<typeof installMockAgent>): void {
  mock.interceptText({
    origin: "https://fc.yahoo.com",
    path: "/",
    method: "GET",
    statusCode: 200,
    body: "",
    responseHeaders: { "set-cookie": "A3=mock-cookie-value; Path=/; Secure" },
    delayMs: SLOW_AUTH_MS,
    persist: true,
  });
  mock.interceptText({
    origin: YAHOO_ORIGIN,
    path: "/v1/test/getcrumb",
    method: "GET",
    statusCode: 200,
    body: "mockCrumb123",
    delayMs: SLOW_AUTH_MS,
    persist: true,
  });
}

describe("unbudgeted Yahoo calls must not deadline their auth handshake", () => {
  it("REGRESSION: fetchChart still returns bars when a COLD auth handshake is slow", async () => {
    const mock = installMockAgent();
    try {
      stubSlowAuth(mock);
      const chart = mock.interceptJson({
        origin: YAHOO_ORIGIN,
        path: /^\/v8\/finance\/chart\/RELIANCE\.NS/,
        method: "GET",
        body: loadFixture("yahoo-chart-reliance.json"),
        persist: true,
      });

      // `fetchChart` passes no `deadline`, so `remaining()` is Infinity — the
      // exact path that used to clamp to a 1 ms auth deadline.
      const bars = await fetchChart("RELIANCE.NS", {
        period1: new Date("2024-06-13T00:00:00Z"),
        period2: new Date("2024-06-16T00:00:00Z"),
        interval: "1d",
      });

      // BEFORE THE FIX this was `[]`: the 1 ms timer beat the 60 ms handshake,
      // withDeadline rejected with "exceeded Infinityms", and that rejection
      // escaped past the retry block. An empty array, never an error — which is
      // why it would have been read as "this symbol has no data".
      assert.ok(
        bars.length > 0,
        "a cold + slow auth handshake must not empty the result: a 1ms " +
          "deadline on an UNBOUNDED budget is the MONEY-1198 defect",
      );
      // Same fixture as the contract suite: 4 timestamps, 2 fully-priced bars.
      assert.equal(bars.length, 2);
      assert.equal(bars[0]!.close, 1402.5);

      // Proves the assertion above is not passing on a cached or
      // short-circuited path — the data call really was made, exactly once.
      assert.equal(chart.calls.length, 1);
    } finally {
      await mock.close();
    }
  });
});
