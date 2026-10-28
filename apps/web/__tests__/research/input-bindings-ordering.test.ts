/**
 * Annual-array binding ORDER regression (MONEY-613).
 *
 * Sources like Yahoo return financial statements NEWEST-FIRST, but the
 * annualArray/annualLast binding contract is OLDEST→NEWEST — so `annualLast`
 * (rows[last]) and `lastTwo()` must read the LATEST year. A live validation
 * caught every annual forensic/fundamental tool (Piotroski / Altman / Beneish /
 * working-capital / capex) silently computing on the OLDEST year. `annualRows`
 * now sorts ascending by date; these tests lock that through the public
 * `applyDeclarativeBindings` path.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { applyDeclarativeBindings } from "../../../../packages/research/src/tools/input-bindings";

type Task = Parameters<typeof applyDeclarativeBindings>[0];

// Newest-first balance sheet, the shape Yahoo returns.
const newestFirstBalanceDep = {
  id: "balance",
  tool: "fetch_balance_sheet",
  status: "completed",
  params: { symbol: "TCS.NS" },
  result: {
    annual: [
      {
        period: "2025-03-31",
        endDate: "1743379200",
        totalAssets: 5000,
        currentAssets: 999,
        currentLiabilities: 100,
        retainedEarnings: 400,
        totalEquity: 600,
        totalLiabilities: 400,
      },
      {
        period: "2024-03-31",
        endDate: "1711843200",
        totalAssets: 4000,
        currentAssets: 500,
        currentLiabilities: 90,
        retainedEarnings: 300,
        totalEquity: 500,
        totalLiabilities: 350,
      },
      {
        period: "2023-03-31",
        endDate: "1680220800",
        totalAssets: 3000,
        currentAssets: 50,
        currentLiabilities: 80,
        retainedEarnings: 200,
        totalEquity: 400,
        totalLiabilities: 300,
      },
    ],
  },
} as unknown as Task;

test("annualLast reads the LATEST year from a newest-first series", () => {
  const task = { id: "altman", tool: "compute_altman_z" } as unknown as Task;
  const params: Record<string, unknown> = {};
  applyDeclarativeBindings(task, newestFirstBalanceDep, params);

  // Must pick the 2025 (latest) row, NOT the 2023 (oldest, last in the array).
  assert.equal(params.currentAssets, 999);
  assert.equal(params.totalAssets, 5000);
  assert.equal(params.retainedEarnings, 400);
});

test("annualArray yields oldest→newest so lastTwo()'s 'current' is latest", () => {
  const task = {
    id: "piotroski",
    tool: "compute_piotroski",
  } as unknown as Task;
  const params: Record<string, unknown> = {};
  applyDeclarativeBindings(task, newestFirstBalanceDep, params);

  // historicalTotalAssets binds annualArray field totalAssets → oldest→newest.
  assert.deepEqual(params.historicalTotalAssets, [3000, 4000, 5000]);
});
