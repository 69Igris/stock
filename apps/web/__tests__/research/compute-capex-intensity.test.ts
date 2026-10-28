/**
 * CapEx Intensity Tool Tests
 * (packages/research/src/tools/compute-capex-intensity.ts)
 *
 * PURE compute tool — no network/db/io, fully deterministic.
 *
 * Coverage:
 *   - Happy path (success:true, available:true, field presence + types)
 *   - Known-value numeric assertion (runtime-verified expected values)
 *   - Graceful degradation: available:false ONLY when BOTH capex & revenue
 *     are missing (still success:true — NOT success:false)
 *   - Edge cases: empty / zero / negative / short series / missing optional
 *     fields — must not throw and must keep success:true
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { computeCapexIntensityTool } from "../../../../packages/research/src/tools/compute-capex-intensity";

// ── Shape of result.data (mirrors CapexIntensityResult) ──────────────
interface CapexIntensityResult {
  available: boolean;
  reason?: string;
  symbol?: string;
  capexIntensity: number | null;
  avgCapexIntensity: number | null;
  trend: "rising" | "stable" | "falling" | "insufficient_data";
  capexToOCF: number | null;
  capexToDepreciation: number | null;
  classification: "asset-light" | "moderate" | "capital-intensive" | "unknown";
  historyYears: number;
  qualityScore: number;
  flags: string[];
}

async function run(args: Record<string, unknown>) {
  return computeCapexIntensityTool.execute(args);
}

function asData(r: { success: boolean; data?: unknown }): CapexIntensityResult {
  assert.ok(r.data, "expected data on tool output");
  return r.data as CapexIntensityResult;
}

// ── 1. Tool metadata sanity ──────────────────────────────────────────
test("tool is wired with name + category + execute", () => {
  assert.equal(computeCapexIntensityTool.name, "compute_capex_intensity");
  assert.equal(computeCapexIntensityTool.category, "computation");
  assert.equal(typeof computeCapexIntensityTool.execute, "function");
});

// ── 2. Happy path: success:true, available:true, field types ─────────
test("happy path returns success:true, available:true with typed fields", async () => {
  const r = await run({
    capitalExpenditure: 200,
    revenue: 1000,
    operatingCashFlow: 400,
    depreciation: 150,
    historicalCapex: [100, 120, 140, 170, 200],
    historicalRevenue: [700, 800, 850, 920, 1000],
    symbol: "RELIANCE.NS",
  });

  assert.equal(r.success, true);
  const data = asData(r);

  assert.equal(data.available, true);
  // key fields present + correct types
  assert.equal(typeof data.capexIntensity, "number");
  assert.equal(typeof data.avgCapexIntensity, "number");
  assert.equal(typeof data.capexToOCF, "number");
  assert.equal(typeof data.capexToDepreciation, "number");
  assert.equal(typeof data.qualityScore, "number");
  assert.equal(typeof data.historyYears, "number");
  assert.equal(typeof data.classification, "string");
  assert.equal(typeof data.trend, "string");
  assert.ok(Array.isArray(data.flags));
  // symbol is normalized (suffix stripped, uppercased)
  assert.equal(data.symbol, "RELIANCE");
  // quality score is bounded 0-100
  assert.ok(data.qualityScore >= 0 && data.qualityScore <= 100);
});

// ── 3. KNOWN-VALUE numeric assertion (runtime-verified) ──────────────
test("known-value assertion: exact computed metrics", async () => {
  const r = await run({
    capitalExpenditure: 150,
    revenue: 1000,
    operatingCashFlow: 300,
    depreciation: 100,
    historicalCapex: [60, 80, 100, 130, 150],
    historicalRevenue: [800, 850, 900, 950, 1000],
  });

  assert.equal(r.success, true);
  const data = asData(r);

  assert.equal(data.available, true);
  // capexIntensity = 150 / 1000 = 0.15
  assert.ok(
    Math.abs((data.capexIntensity ?? NaN) - 0.15) < 1e-9,
    `capexIntensity should be 0.15, got ${data.capexIntensity}`
  );
  // avgCapexIntensity ≈ 0.1134 (rounded to 4dp by the tool)
  assert.ok(
    Math.abs((data.avgCapexIntensity ?? NaN) - 0.1134) < 1e-9,
    `avgCapexIntensity should be 0.1134, got ${data.avgCapexIntensity}`
  );
  // trend rising (0.075 → 0.15)
  assert.equal(data.trend, "rising");
  // capexToOCF = 150 / 300 = 0.5
  assert.ok(
    Math.abs((data.capexToOCF ?? NaN) - 0.5) < 1e-9,
    `capexToOCF should be 0.5, got ${data.capexToOCF}`
  );
  // capexToDepreciation = 150 / 100 = 1.5
  assert.ok(
    Math.abs((data.capexToDepreciation ?? NaN) - 1.5) < 1e-9,
    `capexToDepreciation should be 1.5, got ${data.capexToDepreciation}`
  );
  // classification moderate (0.15 ≤ 0.15)
  assert.equal(data.classification, "moderate");
  assert.equal(data.historyYears, 5);
  assert.equal(data.qualityScore, 70);
});

// ── 4. Graceful degradation: BOTH inputs missing -> available:false ──
test("available:false (still success:true) when BOTH capex AND revenue missing", async () => {
  const r = await run({
    operatingCashFlow: 300,
    depreciation: 100,
  });

  // The tool returns success:true even when it cannot compute.
  assert.equal(r.success, true);
  const data = asData(r);

  assert.equal(data.available, false);
  assert.equal(typeof data.reason, "string");
  assert.ok(
    (data.reason ?? "").length > 0,
    "reason should be a non-empty string"
  );
  // degraded fields
  assert.equal(data.capexIntensity, null);
  assert.equal(data.avgCapexIntensity, null);
  assert.equal(data.trend, "insufficient_data");
  assert.equal(data.classification, "unknown");
  assert.equal(data.historyYears, 0);
  assert.equal(data.qualityScore, 0);
});

test("still available:true when only ONE of capex/revenue is present (revenue only)", async () => {
  const r = await run({ revenue: 1000 });
  assert.equal(r.success, true);
  const data = asData(r);
  // Only one input present -> NOT the both-missing path -> available:true
  assert.equal(data.available, true);
  // can't form a ratio without capex
  assert.equal(data.capexIntensity, null);
});

test("still available:true when only capex is present", async () => {
  const r = await run({ capitalExpenditure: 150 });
  assert.equal(r.success, true);
  const data = asData(r);
  assert.equal(data.available, true);
  assert.equal(data.capexIntensity, null);
});

// ── 5. Edge cases: must not throw, keep success:true ─────────────────
test("empty args do not throw -> available:false", async () => {
  const r = await run({});
  assert.equal(r.success, true);
  const data = asData(r);
  assert.equal(data.available, false);
});

test("zero revenue -> no division, capexIntensity null, no throw", async () => {
  const r = await run({ capitalExpenditure: 100, revenue: 0 });
  assert.equal(r.success, true);
  const data = asData(r);
  assert.equal(data.available, true);
  // revenue > 0 guard means ratio is null, not Infinity/NaN
  assert.equal(data.capexIntensity, null);
});

test("negative capex is treated sign-agnostically (abs)", async () => {
  const r = await run({
    capitalExpenditure: -150,
    revenue: 1000,
    operatingCashFlow: -300,
    depreciation: -100,
  });
  assert.equal(r.success, true);
  const data = asData(r);
  assert.equal(data.available, true);
  // |−150| / 1000 = 0.15
  assert.ok(Math.abs((data.capexIntensity ?? NaN) - 0.15) < 1e-9);
  // OCF is not abs'd and negative OCF fails the > 0 guard -> null
  assert.equal(data.capexToOCF, null);
  // depreciation IS abs'd -> 150 / 100 = 1.5
  assert.ok(Math.abs((data.capexToDepreciation ?? NaN) - 1.5) < 1e-9);
});

test("short history series (< 3) yields insufficient_data trend, no throw", async () => {
  const r = await run({
    capitalExpenditure: 150,
    revenue: 1000,
    historicalCapex: [100, 150],
    historicalRevenue: [900, 1000],
  });
  assert.equal(r.success, true);
  const data = asData(r);
  assert.equal(data.available, true);
  assert.equal(data.historyYears, 2);
  assert.equal(data.trend, "insufficient_data");
});

test("missing optional fields (no ocf / depreciation / history) -> nulls, no throw", async () => {
  const r = await run({ capitalExpenditure: 50, revenue: 2000 });
  assert.equal(r.success, true);
  const data = asData(r);
  assert.equal(data.available, true);
  // 50 / 2000 = 0.025 -> asset-light (< 0.05)
  assert.ok(Math.abs((data.capexIntensity ?? NaN) - 0.025) < 1e-9);
  assert.equal(data.classification, "asset-light");
  assert.equal(data.capexToOCF, null);
  assert.equal(data.capexToDepreciation, null);
  assert.equal(data.avgCapexIntensity, null);
  assert.equal(data.historyYears, 0);
});

test("mismatched history lengths use the overlap and skip non-positive revenue years", async () => {
  const r = await run({
    capitalExpenditure: 200,
    revenue: 1000,
    historicalCapex: [50, 60, 70, 80, 90, 100],
    historicalRevenue: [0, 500, 600, 700], // shorter + a zero-revenue year
  });
  assert.equal(r.success, true);
  const data = asData(r);
  assert.equal(data.available, true);
  // overlap length = 4; the leading 0-revenue year is skipped -> 3 usable years
  assert.equal(data.historyYears, 3);
  assert.equal(typeof data.avgCapexIntensity, "number");
});
