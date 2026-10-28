/**
 * Beneish M-Score Tool Tests
 * (packages/research/src/tools/compute-beneish-m.ts)
 *
 * Pure compute tool — no network/db/io. Exercises the public
 * `computeBeneishMTool.execute(args)` contract:
 *   1. Tool metadata sanity.
 *   2. Known-value numeric assertion: identical year-over-year inputs make all
 *      8 indices = 1 and TATA = 0, giving a hand-computable M = -2.48.
 *   3. Graceful degradation → success:true + data.available:false + reason.
 *   4. Edge cases (single year, missing variable, empty params) — no throw.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { computeBeneishMTool } from "../../../../packages/research/src/tools/compute-beneish-m";

interface BeneishData {
  available: boolean;
  reason?: string;
  symbol?: string;
  score?: number;
  likelihood?: "elevated" | "grey" | "low";
  model?: string;
  variables?: Array<{
    key: string;
    label: string;
    value: number;
    weight: number;
  }>;
  flags?: string[];
}

async function run(args: Record<string, unknown>) {
  return computeBeneishMTool.execute(args);
}

const APPROX = 1e-9;
function near(a: number, b: number, tol = APPROX): boolean {
  return Math.abs(a - b) <= tol;
}

// Identical two-year statements: every index = 1, TATA = 0 (netIncome = CFO).
// M = -4.84 + 0.92 + 0.528 + 0.404 + 0.892 + 0.115 - 0.172 + 0 - 0.327 = -2.48
const FLAT = {
  symbol: "infy.ns",
  historicalReceivables: [100, 100],
  historicalRevenue: [1000, 1000],
  historicalGrossProfit: [400, 400],
  historicalCurrentAssets: [300, 300],
  historicalPPE: [500, 500],
  historicalTotalAssets: [2000, 2000],
  historicalDepreciation: [50, 50],
  historicalSGA: [150, 150],
  historicalTotalLiabilities: [800, 800],
  historicalNetIncome: [200, 200],
  historicalOperatingCashFlow: [200, 200],
};

// ── 1. Metadata ────────────────────────────────────────────────────

test("tool exposes expected metadata", () => {
  assert.equal(computeBeneishMTool.name, "compute_beneish_m");
  assert.equal(computeBeneishMTool.category, "computation");
  assert.equal(typeof computeBeneishMTool.execute, "function");
});

// ── 2. Known-value: M = -2.48 (low likelihood) ─────────────────────

test("known-value: identical YoY inputs → M -2.48, low likelihood", async () => {
  const r = await run({ ...FLAT });

  assert.equal(r.success, true);
  const data = r.data as BeneishData;
  assert.equal(data.available, true);
  assert.equal(data.symbol, "INFY"); // normalized
  assert.ok(near(data.score!, -2.48, 1e-9), `score=${data.score}`);
  assert.equal(data.likelihood, "low"); // -2.48 < -2.22
  assert.equal(data.variables?.length, 8);
  // Every index is exactly 1 under flat inputs (except TATA = 0).
  const dsri = data.variables!.find((v) => v.key === "dsri");
  assert.ok(near(dsri!.value, 1, 1e-9), `dsri=${dsri!.value}`);
  const tata = data.variables!.find((v) => v.key === "tata");
  assert.ok(near(tata!.value, 0, 1e-9), `tata=${tata!.value}`);
  assert.ok(data.flags!.some((f) => /low/i.test(f)));
});

// ── 3. Elevated case — inflate accruals (TATA) hard ────────────────
// Big positive accrual (netIncome >> CFO) pushes M up via the 4.679 weight.

test("elevated: large positive accruals push M above -1.78", async () => {
  const r = await run({
    ...FLAT,
    historicalNetIncome: [200, 900], // current NI ≫ CFO
    historicalOperatingCashFlow: [200, 100],
  });

  assert.equal(r.success, true);
  const data = r.data as BeneishData;
  assert.equal(data.available, true);
  // TATA = (900 - 100)/2000 = 0.4 → adds 4.679*0.4 ≈ 1.87 to the flat -2.48.
  assert.ok(data.score! > -1.78, `score=${data.score}`);
  assert.equal(data.likelihood, "elevated");
  assert.ok(data.flags!.some((f) => /elevated/i.test(f)));
});

// ── 4. Graceful degradation ────────────────────────────────────────

test("graceful: missing depreciation series → available:false with reason", async () => {
  const args = { ...FLAT } as Record<string, unknown>;
  delete args.historicalDepreciation;
  const r = await run(args);

  assert.equal(r.success, true); // NOT success:false
  const data = r.data as BeneishData;
  assert.equal(data.available, false);
  assert.equal(typeof data.reason, "string");
  assert.ok(/depreciation/i.test(data.reason!));
});

// ── 5. Edge cases — must not throw ─────────────────────────────────

test("edge: single year of data → can't compute prior → available:false", async () => {
  const single: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(FLAT)) {
    single[k] = Array.isArray(v) ? [v[1]] : v; // one period only
  }
  const r = await run(single);
  assert.equal(r.success, true);
  assert.equal((r.data as BeneishData).available, false);
});

test("edge: empty params object does not throw and degrades", async () => {
  const r = await run({});
  assert.equal(r.success, true);
  const data = r.data as BeneishData;
  assert.equal(data.available, false);
  assert.equal(typeof data.reason, "string");
});
