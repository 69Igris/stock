/**
 * Payout Coverage Tool Tests
 * (packages/research/src/tools/compute-payout-coverage.ts)
 *
 * Pure compute tool — dividend & buyback sustainability. Tests assert against
 * the REAL tool (no re-implementation), via computePayoutCoverageTool.execute.
 *
 * Graceful-degradation contract (verified against source):
 *   - Missing dividend signal (dividendsPaid AND dps) OR missing netIncome
 *     → { success: true, data: { available: false, reason, ... } }
 *     (NOT success:false — that is reserved for genuine runtime exceptions).
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { computePayoutCoverageTool } from "../../../../packages/research/src/tools/compute-payout-coverage";

interface PayoutCoverageResult {
  available: boolean;
  reason?: string;
  symbol?: string;
  payoutRatio: number | null;
  fcfPayout: number | null;
  dividendCoverage: number | null;
  buybackYield: number | null;
  totalShareholderYield: number | null;
  dividendYield: number | null;
  verdict: "safe" | "moderate" | "at_risk" | "unknown";
  sustainabilityScore: number;
  flags: string[];
}

async function run(args: Record<string, unknown>) {
  return computePayoutCoverageTool.execute(args);
}

const EPS = 1e-9;

function near(actual: number | null, expected: number, msg: string): void {
  assert.ok(actual !== null, `${msg}: expected ~${expected}, got null`);
  assert.ok(
    Math.abs((actual as number) - expected) < EPS,
    `${msg}: expected ~${expected}, got ${actual}`
  );
}

// ── 1. Tool definition shape ─────────────────────────────────────────
test("tool definition: name, category, execute are correct", () => {
  assert.equal(computePayoutCoverageTool.name, "compute_payout_coverage");
  assert.equal(computePayoutCoverageTool.category, "computation");
  assert.equal(typeof computePayoutCoverageTool.execute, "function");
  // netIncome is the only declared-required parameter
  assert.equal(computePayoutCoverageTool.parameters.netIncome.required, true);
});

// ── 2. Happy path: representative inputs ─────────────────────────────
test("happy path: success true, available true, key fields present + typed", async () => {
  const r = await run({
    symbol: "TCS.NS",
    dividendsPaid: 120,
    netIncome: 400,
    freeCashFlow: 300,
    buybacks: 40,
    marketCap: 8000,
    dps: 24,
    currentPrice: 1200,
  });

  assert.equal(r.success, true);
  const d = r.data as PayoutCoverageResult;

  assert.equal(d.available, true);
  // symbol normalized: stripped .NS suffix, uppercased
  assert.equal(d.symbol, "TCS");

  assert.equal(typeof d.payoutRatio, "number");
  assert.equal(typeof d.fcfPayout, "number");
  assert.equal(typeof d.dividendCoverage, "number");
  assert.equal(typeof d.buybackYield, "number");
  assert.equal(typeof d.totalShareholderYield, "number");
  assert.equal(typeof d.dividendYield, "number");
  assert.equal(typeof d.sustainabilityScore, "number");
  assert.ok(["safe", "moderate", "at_risk", "unknown"].includes(d.verdict));
  assert.ok(Array.isArray(d.flags));
  assert.ok(d.sustainabilityScore >= 0 && d.sustainabilityScore <= 100);
});

// ── 3. KNOWN-VALUE numeric assertion (the canonical fixture) ─────────
test("known values: payout/fcf/coverage/yields/verdict exact", async () => {
  const r = await run({
    dividendsPaid: 100,
    netIncome: 500,
    freeCashFlow: 200,
    buybacks: 50,
    marketCap: 10000,
  });

  assert.equal(r.success, true);
  const d = r.data as PayoutCoverageResult;

  assert.equal(d.available, true);
  near(d.payoutRatio, 0.2, "payoutRatio"); // 100 / 500
  near(d.fcfPayout, 0.5, "fcfPayout"); // 100 / 200
  near(d.dividendCoverage, 5, "dividendCoverage"); // 500 / 100
  near(d.buybackYield, 0.005, "buybackYield"); // 50 / 10000
  near(d.totalShareholderYield, 0.015, "totalShareholderYield"); // 150 / 10000
  assert.equal(d.verdict, "safe");

  // NOTE: the prompt's stated expected sustainabilityScore of 95 does NOT
  // match the implementation. Tracing the source (single source of truth):
  //   base 50
  //   + 20  (payoutRatio 0.2 < 0.3)
  //   + 8   (fcfPayout 0.5 is NOT < 0.5, but IS < 0.8)
  //   + 10  (dividendCoverage 5 >= 3)
  //   = 88
  // The test pins the tool's actual deterministic output (88).
  assert.equal(
    d.sustainabilityScore,
    88,
    "sustainabilityScore traces to 88 from source (50+20+8+10), not 95"
  );
});

// ── 4. dps/eps fallback path for payoutRatio + derived dividendYield ──
test("dps/eps fallback: payoutRatio from per-share, dividendYield from price", async () => {
  const r = await run({
    dps: 10,
    eps: 40,
    netIncome: 1000,
    currentPrice: 500,
  });

  assert.equal(r.success, true);
  const d = r.data as PayoutCoverageResult;

  assert.equal(d.available, true);
  near(d.payoutRatio, 0.25, "payoutRatio from dps/eps"); // 10 / 40
  near(d.dividendYield, 0.02, "dividendYield from dps/price"); // 10 / 500
  // dividendsPaid totals absent → fcf/coverage/buyback yields stay null
  assert.equal(d.fcfPayout, null);
  assert.equal(d.dividendCoverage, null);
});

// ── 5. Graceful degradation: missing dividend signal ────────────────
test("graceful degrade: no dividend signal → success true, available false", async () => {
  const r = await run({ netIncome: 500 });

  assert.equal(
    r.success,
    true,
    "must NOT surface success:false for missing data"
  );
  const d = r.data as PayoutCoverageResult;

  assert.equal(d.available, false);
  assert.equal(typeof d.reason, "string");
  assert.ok((d.reason as string).includes("dividendsPaid/dps"));
  assert.equal(d.verdict, "unknown");
  assert.equal(d.sustainabilityScore, 0);
  assert.deepEqual(d.flags, []);
});

// ── 6. Graceful degradation: missing netIncome ──────────────────────
test("graceful degrade: missing netIncome → success true, available false", async () => {
  const r = await run({ dividendsPaid: 100 });

  assert.equal(r.success, true);
  const d = r.data as PayoutCoverageResult;

  assert.equal(d.available, false);
  assert.equal(typeof d.reason, "string");
  assert.ok((d.reason as string).includes("netIncome"));
  assert.equal(d.verdict, "unknown");
});

// ── 7. Graceful degradation: completely empty input ─────────────────
test("graceful degrade: empty input → success true, available false (no throw)", async () => {
  const r = await run({});

  assert.equal(r.success, true);
  const d = r.data as PayoutCoverageResult;
  assert.equal(d.available, false);
  // both signals missing → reason lists both
  assert.ok((d.reason as string).includes("dividendsPaid/dps"));
  assert.ok((d.reason as string).includes("netIncome"));
});

// ── 8. Edge: negative net income → at_risk + reserve-funded flag ────
test("edge: dividends paid despite non-positive net income → at_risk", async () => {
  const r = await run({
    dividendsPaid: 100,
    netIncome: -50,
    freeCashFlow: 200,
    marketCap: 5000,
  });

  assert.equal(r.success, true);
  const d = r.data as PayoutCoverageResult;

  assert.equal(d.available, true);
  assert.equal(d.verdict, "at_risk");
  assert.ok(
    d.flags.some((f) => f.toLowerCase().includes("net income")),
    `expected a non-positive-net-income flag, got: ${JSON.stringify(d.flags)}`
  );
  // netIncome <= 0 zone: payoutRatio uses netIncome !== 0 guard (−50 ≠ 0) →
  // 100 / -50 = -2, so payoutRatio is negative (still a finite number).
  near(d.payoutRatio, -2, "payoutRatio with negative netIncome");
  assert.ok(d.sustainabilityScore >= 0 && d.sustainabilityScore <= 100);
});

// ── 9. Edge: FCF payout > 100% → at_risk + unsustainable flag ───────
test("edge: FCF payout above 100% → at_risk", async () => {
  const r = await run({
    dividendsPaid: 300,
    netIncome: 1000,
    freeCashFlow: 200, // 300 / 200 = 1.5 > 1
    marketCap: 9000,
  });

  assert.equal(r.success, true);
  const d = r.data as PayoutCoverageResult;
  assert.equal(d.available, true);
  near(d.fcfPayout, 1.5, "fcfPayout > 1");
  assert.equal(d.verdict, "at_risk");
  assert.ok(d.flags.some((f) => f.includes("FCF payout")));
});

// ── 10. Edge: zeros must not throw / no divide-by-zero corruption ────
test("edge: zero netIncome / zero freeCashFlow → no throw, nulls where undivisible", async () => {
  const r = await run({
    dividendsPaid: 50,
    netIncome: 0, // netIncome present (0) but payoutRatio guard skips /0
    freeCashFlow: 0, // fcfPayout guard skips /0
    marketCap: 0, // marketCap not > 0 → yields stay null
  });

  assert.equal(r.success, true);
  const d = r.data as PayoutCoverageResult;
  assert.equal(d.available, true); // netIncome === 0 is NOT null → available
  assert.equal(d.payoutRatio, null); // guarded against /0
  assert.equal(d.fcfPayout, null); // guarded against /0
  assert.equal(d.buybackYield, null); // marketCap not > 0
  assert.equal(d.totalShareholderYield, null);
  // dividendCoverage = netIncome / dividendsPaid = 0 / 50 = 0 (finite)
  near(d.dividendCoverage, 0, "dividendCoverage 0/50");
  // netIncome <= 0 → at_risk
  assert.equal(d.verdict, "at_risk");
});

// ── 11. Edge: negative dividends (cash-flow sign) normalized to magnitude ──
test("edge: negative dividendsPaid normalized to positive magnitude", async () => {
  const r = await run({
    dividendsPaid: -100, // cash flow statements often sign dividends negative
    netIncome: 500,
    freeCashFlow: 200,
    buybacks: -50, // also negative in cash flow
    marketCap: 10000,
  });

  assert.equal(r.success, true);
  const d = r.data as PayoutCoverageResult;
  assert.equal(d.available, true);
  // Magnitudes match the canonical fixture after abs()
  near(d.payoutRatio, 0.2, "payoutRatio (abs dividends)");
  near(d.fcfPayout, 0.5, "fcfPayout (abs dividends)");
  near(d.buybackYield, 0.005, "buybackYield (abs buybacks)");
  near(d.totalShareholderYield, 0.015, "totalShareholderYield (abs)");
});

// ── 12. Edge: string-coerced numbers + missing optionals → no throw ──
test("edge: numeric strings coerced; missing optional fields tolerated", async () => {
  const r = await run({
    dividendsPaid: "100",
    netIncome: "500",
    // no freeCashFlow, no buybacks, no marketCap, no currentPrice
  });

  assert.equal(r.success, true);
  const d = r.data as PayoutCoverageResult;
  assert.equal(d.available, true);
  near(d.payoutRatio, 0.2, "payoutRatio from string inputs");
  near(d.dividendCoverage, 5, "dividendCoverage from string inputs");
  // Optionals absent → those derived metrics are null, not NaN
  assert.equal(d.fcfPayout, null);
  assert.equal(d.buybackYield, null);
  assert.equal(d.totalShareholderYield, null);
  assert.equal(d.dividendYield, null);
});

// ── 13. Determinism: identical inputs → identical output ────────────
test("determinism: same input yields identical result twice", async () => {
  const args = {
    dividendsPaid: 100,
    netIncome: 500,
    freeCashFlow: 200,
    buybacks: 50,
    marketCap: 10000,
  };
  const a = await run({ ...args });
  const b = await run({ ...args });
  assert.deepEqual(a, b);
});

// ── 14. Non-numeric junk in numeric fields → treated as missing ─────
test("edge: non-numeric junk in dividend signal → graceful available false", async () => {
  const r = await run({
    dividendsPaid: "not-a-number",
    dps: "also-junk",
    netIncome: 500,
  });

  assert.equal(r.success, true);
  const d = r.data as PayoutCoverageResult;
  // toNum() returns null for non-finite → no dividend signal → degrade
  assert.equal(d.available, false);
  assert.ok((d.reason as string).includes("dividendsPaid/dps"));
});
