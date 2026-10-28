/**
 * MONEY-1135 — the single-flight backstop must outlast every budget it backs up.
 *
 * ## The bug this pins
 *
 * `SINGLE_FLIGHT_TIMEOUT_MS` (15s) was SHORTER than `QUOTE_FETCH_BUDGET_MS`
 * (20s), and the two nest on a real path:
 *
 *     apps/web/lib/actions/screener.ts:380   singleFlight(...)      15s
 *       └─ packages/core/src/screener/engine.ts:398  fetchQuotes()  20s budget
 *
 * The quote budget is not a failure mode — it is a DEGRADATION: chunks race one
 * shared deadline under `Promise.allSettled`, so an exhausted chunk drops its
 * symbols and the rest of the result still returns. That is the good outcome.
 *
 * Inverted, it never happened. A slow Yahoo killed the flight leader at 15s,
 * five seconds before the budget it was supposedly backing up could expire, and
 * every waiter got `SingleFlightTimeoutError` instead of a partial screener
 * page. The backstop wasn't protecting the mechanism, it was pre-empting it.
 *
 * ## Why a test and not a derived constant
 *
 * The obvious fix is `SINGLE_FLIGHT_TIMEOUT_MS = QUOTE_FETCH_BUDGET_MS + slack`.
 * It is the wrong one: `yahoo-api-logic.ts` is a dependency-free logic module,
 * and `stale-while-error.ts` pulls in the cache client (Redis). Importing either
 * direction to save one number would put Redis behind a pure import, or the
 * cache behind the market-data logic. The relation is cross-module by nature, so
 * it gets asserted rather than derived.
 *
 * Adding a THIRD budget that can run inside a flight? Add it to `INNER_BUDGETS`.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { SINGLE_FLIGHT_TIMEOUT_MS } from "../../src/cache/stale-while-error";
import { QUOTE_FETCH_BUDGET_MS } from "../../src/market-data/yahoo-api-logic";

/**
 * Budgets that can run INSIDE a `singleFlight` body. Each must expire, and be
 * allowed to degrade, before the flight's backstop fires.
 */
const INNER_BUDGETS: ReadonlyArray<{ name: string; ms: number; via: string }> =
  [
    {
      name: "QUOTE_FETCH_BUDGET_MS",
      ms: QUOTE_FETCH_BUDGET_MS,
      via: "screener.ts singleFlight → engine.ts:398 fetchQuotes",
    },
  ];

/**
 * Room for the rest of the flight body — the Mongo query, scoring and the cache
 * write all share the same clock as the budget above.
 */
const MIN_SLACK_MS = 3_000;

describe("MONEY-1135 — single-flight backstop vs inner budgets", () => {
  for (const budget of INNER_BUDGETS) {
    it(`[regression] outlasts ${budget.name} with slack`, () => {
      assert.ok(
        SINGLE_FLIGHT_TIMEOUT_MS > budget.ms,
        `SINGLE_FLIGHT_TIMEOUT_MS (${SINGLE_FLIGHT_TIMEOUT_MS}ms) must exceed ` +
          `${budget.name} (${budget.ms}ms). They nest: ${budget.via}. Inverted, ` +
          `the leader is killed before the inner budget can degrade, so callers ` +
          `get SingleFlightTimeoutError instead of the partial result`,
      );
      assert.ok(
        SINGLE_FLIGHT_TIMEOUT_MS - budget.ms >= MIN_SLACK_MS,
        `only ${SINGLE_FLIGHT_TIMEOUT_MS - budget.ms}ms between the backstop ` +
          `and ${budget.name}; the flight body still has to run its DB query, ` +
          `scoring and cache write inside that margin (need >= ${MIN_SLACK_MS}ms)`,
      );
    });
  }

  it("both budgets are finite and positive", () => {
    // A NaN or 0 here disables the bound rather than tightening it, and the
    // comparison above would pass or fail for the wrong reason.
    for (const ms of [
      SINGLE_FLIGHT_TIMEOUT_MS,
      ...INNER_BUDGETS.map((b) => b.ms),
    ]) {
      assert.ok(Number.isFinite(ms) && ms > 0, `bad budget: ${ms}`);
    }
  });
});
