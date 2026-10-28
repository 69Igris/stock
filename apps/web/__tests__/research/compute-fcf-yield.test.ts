/**
 * FCF Yield Tool Tests
 * (packages/research/src/tools/compute-fcf-yield.ts)
 *
 * Pure compute tool — no network/db/io. Tests exercise the public
 * `computeFcfYieldTool.execute(args)` contract:
 *   1. Happy path → success:true, data.available:true, key fields + types.
 *   2. Known-value numeric assertion (tight float tolerances).
 *   3. Graceful degradation → success:true + data.available:false + reason.
 *   4. Edge cases (zero/negative/short series/missing optionals) — no throw.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { computeFcfYieldTool } from "../../../../packages/research/src/tools/compute-fcf-yield";

// ── Shape helpers ──────────────────────────────────────────────────

interface FcfYieldData {
  available: boolean;
  reason?: string;
  symbol?: string;
  freeCashFlow?: number;
  fcfDerived?: boolean;
  marketCap?: number;
  enterpriseValue?: number;
  evFellBackToMarketCap?: boolean;
  fcfYield?: number;
  fcfYieldOnEV?: number;
  fcfMargin?: number;
  riskFreeRate?: number;
  classification?: "attractive" | "fair" | "expensive";
  avgFcfYield?: number;
  periodsCovered?: number;
  fcfTrend?: "improving" | "stable" | "declining" | "volatile" | "unknown";
  score?: number;
  flags?: string[];
}

async function run(args: Record<string, unknown>) {
  return computeFcfYieldTool.execute(args);
}

const APPROX = 1e-9;
function near(actual: number, expected: number, tol = APPROX): boolean {
  return Math.abs(actual - expected) <= tol;
}

// ── 1. Tool metadata sanity ────────────────────────────────────────

test("tool exposes expected metadata", () => {
  assert.equal(computeFcfYieldTool.name, "compute_fcf_yield");
  assert.equal(computeFcfYieldTool.category, "computation");
  assert.equal(typeof computeFcfYieldTool.execute, "function");
  // marketCap is the only hard-required parameter.
  assert.equal(computeFcfYieldTool.parameters.marketCap?.required, true);
});

// ── 2. Happy path: success + available + field presence/types ──────

test("happy path returns available result with typed key fields", async () => {
  const r = await run({
    symbol: "tcs.ns",
    freeCashFlow: 600,
    marketCap: 12000,
    revenue: 5000,
    totalDebt: 1000,
    totalCash: 400,
    riskFreeRate: 0.07,
    historicalFcf: [
      { fcf: 400, marketCap: 10000 },
      { fcf: 500, marketCap: 11000 },
    ],
  });

  assert.equal(r.success, true);
  const data = r.data as FcfYieldData;
  assert.equal(data.available, true);

  // Symbol is normalized: suffix stripped + uppercased.
  assert.equal(data.symbol, "TCS");

  // Numeric headline fields present and finite numbers.
  assert.equal(typeof data.freeCashFlow, "number");
  assert.equal(typeof data.marketCap, "number");
  assert.equal(typeof data.enterpriseValue, "number");
  assert.equal(typeof data.fcfYield, "number");
  assert.equal(typeof data.fcfYieldOnEV, "number");
  assert.equal(typeof data.fcfMargin, "number");
  assert.equal(typeof data.avgFcfYield, "number");
  assert.equal(typeof data.score, "number");
  assert.equal(typeof data.periodsCovered, "number");

  // Categorical / boolean fields.
  assert.ok(["attractive", "fair", "expensive"].includes(data.classification!));
  assert.ok(
    ["improving", "stable", "declining", "volatile", "unknown"].includes(
      data.fcfTrend!
    )
  );
  assert.equal(typeof data.fcfDerived, "boolean");
  assert.equal(typeof data.evFellBackToMarketCap, "boolean");
  assert.ok(Array.isArray(data.flags));

  // Range invariants.
  assert.ok(data.score! >= 0 && data.score! <= 100);
  assert.equal(data.periodsCovered, 3); // 2 history + current
  assert.equal(data.riskFreeRate, 0.07);

  // EV computed from debt/cash (12000 + 1000 - 400 = 12600), not a fallback.
  assert.equal(data.enterpriseValue, 12600);
  assert.equal(data.evFellBackToMarketCap, false);
});

// ── 3. KNOWN-VALUE numeric assertion ───────────────────────────────

test("known-value: fcf=500 mktcap=10000 rev=4000 no debt/cash rf=0.07", async () => {
  const r = await run({
    freeCashFlow: 500,
    marketCap: 10000,
    revenue: 4000,
    riskFreeRate: 0.07,
  });

  assert.equal(r.success, true);
  const data = r.data as FcfYieldData;
  assert.equal(data.available, true);

  assert.ok(near(data.fcfYield!, 0.05), `fcfYield=${data.fcfYield}`);
  // No debt/cash supplied → EV falls back to market cap.
  assert.equal(data.enterpriseValue, 10000);
  assert.equal(data.evFellBackToMarketCap, true);
  assert.ok(
    near(data.fcfYieldOnEV!, 0.05),
    `fcfYieldOnEV=${data.fcfYieldOnEV}`
  );
  assert.ok(near(data.fcfMargin!, 0.125), `fcfMargin=${data.fcfMargin}`);
  assert.equal(data.classification, "fair"); // 0.05 >= 0.02 and < 0.07
  assert.equal(data.score, 70); // 50 + 15 (yield>=0.05) + 5 (margin>=0.10)
  assert.equal(data.fcfDerived, false);
  assert.equal(data.freeCashFlow, 500);
  assert.equal(data.marketCap, 10000);
});

test("known-value: FCF derived from OCF - |CapEx| sets fcfDerived true", async () => {
  const r = await run({
    operatingCashFlow: 700,
    capitalExpenditure: -200, // sign-agnostic → |CapEx| = 200
    marketCap: 10000,
    revenue: 4000,
    riskFreeRate: 0.07,
  });

  assert.equal(r.success, true);
  const data = r.data as FcfYieldData;
  assert.equal(data.available, true);
  assert.equal(data.freeCashFlow, 500); // 700 - 200
  assert.equal(data.fcfDerived, true);
  assert.ok(near(data.fcfYield!, 0.05), `fcfYield=${data.fcfYield}`);
});

test("known-value: supplied enterpriseValue is used (no fallback)", async () => {
  const r = await run({
    freeCashFlow: 800,
    marketCap: 10000,
    enterpriseValue: 16000,
    riskFreeRate: 0.07,
  });

  assert.equal(r.success, true);
  const data = r.data as FcfYieldData;
  assert.equal(data.available, true);
  assert.equal(data.enterpriseValue, 16000);
  assert.equal(data.evFellBackToMarketCap, false);
  assert.ok(
    near(data.fcfYieldOnEV!, 0.05),
    `fcfYieldOnEV=${data.fcfYieldOnEV}`
  ); // 800/16000
});

test("known-value: yield >= riskFreeRate classifies attractive", async () => {
  const r = await run({
    freeCashFlow: 900,
    marketCap: 10000,
    riskFreeRate: 0.07,
  });

  assert.equal(r.success, true);
  const data = r.data as FcfYieldData;
  assert.ok(near(data.fcfYield!, 0.09), `fcfYield=${data.fcfYield}`);
  assert.equal(data.classification, "attractive"); // 0.09 >= 0.07
});

// ── 4. Graceful degradation (success:true, available:false, reason) ─

test("graceful: no FCF derivable inputs → available:false with reason", async () => {
  const r = await run({
    marketCap: 10000,
    // neither freeCashFlow nor operatingCashFlow supplied
  });

  assert.equal(r.success, true); // NOT success:false
  const data = r.data as FcfYieldData;
  assert.equal(data.available, false);
  assert.equal(typeof data.reason, "string");
  assert.ok(data.reason!.length > 0);
});

test("graceful: missing marketCap → available:false with reason", async () => {
  const r = await run({
    freeCashFlow: 500,
    // marketCap missing
  });

  assert.equal(r.success, true);
  const data = r.data as FcfYieldData;
  assert.equal(data.available, false);
  assert.equal(typeof data.reason, "string");
  assert.ok(/market cap/i.test(data.reason!));
});

test("graceful: non-positive marketCap → available:false", async () => {
  const r = await run({ freeCashFlow: 500, marketCap: 0 });
  assert.equal(r.success, true);
  const data = r.data as FcfYieldData;
  assert.equal(data.available, false);
  assert.ok(typeof data.reason === "string");

  const rNeg = await run({ freeCashFlow: 500, marketCap: -100 });
  assert.equal(rNeg.success, true);
  assert.equal((rNeg.data as FcfYieldData).available, false);
});

// ── 5. Edge cases — must not throw ─────────────────────────────────

test("edge: negative FCF classifies expensive, flags + lowered score", async () => {
  const r = await run({
    freeCashFlow: -500,
    marketCap: 10000,
    revenue: 4000,
    riskFreeRate: 0.07,
  });

  assert.equal(r.success, true);
  const data = r.data as FcfYieldData;
  assert.equal(data.available, true);
  assert.equal(data.classification, "expensive"); // fcf < 0
  assert.ok(data.fcfYield! < 0);
  // 50 - 30 (negative fcf) = 20; clamped 0..100.
  assert.ok(data.score! >= 0 && data.score! <= 100);
  assert.ok(
    data.flags!.some((f) => /negative free cash flow/i.test(f)),
    `flags=${JSON.stringify(data.flags)}`
  );
});

test("edge: empty params object does not throw and degrades", async () => {
  const r = await run({});
  assert.equal(r.success, true);
  const data = r.data as FcfYieldData;
  assert.equal(data.available, false);
  assert.equal(typeof data.reason, "string");
});

test("edge: short history series (< 3 periods) → trend unknown", async () => {
  const r = await run({
    freeCashFlow: 500,
    marketCap: 10000,
    historicalFcf: [{ fcf: 480, marketCap: 9800 }],
  });
  assert.equal(r.success, true);
  const data = r.data as FcfYieldData;
  assert.equal(data.available, true);
  // 1 history + current = 2 periods → below the 3-period trend threshold.
  assert.equal(data.periodsCovered, 2);
  assert.equal(data.fcfTrend, "unknown");
});

test("edge: malformed historicalFcf entries are skipped, not thrown", async () => {
  const r = await run({
    freeCashFlow: 500,
    marketCap: 10000,
    historicalFcf: [
      null,
      "not-an-object",
      42,
      { foo: "bar" }, // no usable fcf/ocf → skipped
      { fcf: 450, marketCap: 9000 },
    ] as unknown[],
  });
  assert.equal(r.success, true);
  const data = r.data as FcfYieldData;
  assert.equal(data.available, true);
  // Only the one valid history row counts + current period.
  assert.equal(data.periodsCovered, 2);
});

test("edge: missing optional revenue → fcfMargin undefined, no throw", async () => {
  const r = await run({ freeCashFlow: 500, marketCap: 10000 });
  assert.equal(r.success, true);
  const data = r.data as FcfYieldData;
  assert.equal(data.available, true);
  assert.equal(data.fcfMargin, undefined);
  // Margin-based score bump should not apply.
  assert.equal(typeof data.score, "number");
});

test("edge: volatile history (sign flips) classified volatile with flag", async () => {
  const r = await run({
    freeCashFlow: 300,
    marketCap: 10000,
    historicalFcf: [
      { fcf: 200, marketCap: 10000 },
      { fcf: -150, marketCap: 10000 },
      { fcf: 250, marketCap: 10000 },
      { fcf: -100, marketCap: 10000 },
    ],
  });
  assert.equal(r.success, true);
  const data = r.data as FcfYieldData;
  assert.equal(data.available, true);
  assert.equal(data.fcfTrend, "volatile");
  assert.ok(
    data.flags!.some((f) => /volatile/i.test(f)),
    `flags=${JSON.stringify(data.flags)}`
  );
});
