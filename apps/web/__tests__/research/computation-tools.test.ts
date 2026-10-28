/**
 * Research Package Computation Tools — REAL tools under test (de-shadowed, MONEY-620)
 *
 * Drives the ACTUAL exported research tool objects (via their public async
 * `.execute()`), replacing the previous inline re-implementations:
 *   - computeGrowthMetricsTool  (packages/research/src/tools/compute-growth-metrics.ts)
 *   - computeHealthScoreTool    (packages/research/src/tools/compute-health-score.ts)
 *   - computeDcfTool            (packages/research/src/tools/compute-dcf.ts)
 *
 * Import style mirrors the sibling tool tests (compute-altman-z, compute-beta …):
 * a direct relative path to the tool module so we exercise the real code without
 * pulling the whole `@usemoney/research/tools` barrel (and its data-source deps).
 *
 * The tools' pure helpers (computeCAGR / assessMarginTrend / computeConsistency
 * in growth-metrics; clamp / scoreMetric in health-score) are module-PRIVATE —
 * there is no exported symbol to bind to. We therefore assert their behaviour
 * through the tool's observable public output (revenueCAGR/profitCAGR/epsCAGR,
 * marginTrend, growthConsistency, details[x].score), which is the real seam.
 *
 * IMPORTANT — health-score values here track the REAL tool, which differs from
 * the old shadow: overall weights are 0.25/0.20/0.15/0.15/0.15 (sum 0.90, not
 * 1.0), leverage = avg(debtToEquity, interestCoverage|50), and efficiency =
 * avg(roa, cfToNetIncome|50). The previous shadow's 0.30/0.25 weights and
 * leverage=de / efficiency=roa were stale; expectations below are corrected.
 *
 * Pure-arithmetic edges with NO observable tool surface (e.g. clamp() called
 * with min > max — never reachable from the tool) are intentionally dropped and
 * noted inline rather than left as an un-anchored inline copy.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { computeGrowthMetricsTool } from "../../../../packages/research/src/tools/compute-growth-metrics";
import { computeHealthScoreTool } from "../../../../packages/research/src/tools/compute-health-score";
import { computeDcfTool } from "../../../../packages/research/src/tools/compute-dcf";

// ────────────────────────────────────────────────────────────────
// Thin typed adapters over the real tools' `.execute()` (the seam)
// ────────────────────────────────────────────────────────────────

interface FinancialStatement {
  period: string;
  endDate?: string;
  revenue?: number;
  netIncome?: number;
  operatingIncome?: number;
  [key: string]: unknown;
}

interface GrowthMetricsResult {
  revenueCAGR: number;
  profitCAGR: number;
  epsCAGR: number;
  marginTrend: "improving" | "stable" | "declining";
  growthConsistency: number;
  details: Array<{
    period: string;
    revenue?: number;
    netIncome?: number;
    operatingMargin?: number;
  }>;
}

interface HealthScoreResult {
  overall: number;
  profitability: number;
  leverage: number;
  liquidity: number;
  efficiency: number;
  growth: number;
  details: Record<
    string,
    { score: number; metric: string; value: number; benchmark: number }
  >;
}

interface DcfResult {
  intrinsicValue: number;
  currentPrice: number;
  marginOfSafety: number;
  upside: number;
  assumptions: {
    fcf: number;
    growthRate: number;
    terminalGrowthRate: number;
    discountRate: number;
    projectionYears: number;
  };
  projections: Array<{ year: number; fcf: number; discountedFcf: number }>;
}

type Outcome<T> = { success: boolean; data?: T; error?: string };

async function executeGrowthMetrics(params: {
  statements?: FinancialStatement[];
  eps?: number[];
}): Promise<Outcome<GrowthMetricsResult>> {
  const out = await computeGrowthMetricsTool.execute(
    params as Record<string, unknown>
  );
  return {
    success: out.success,
    data: out.data as GrowthMetricsResult | undefined,
    error: out.error,
  };
}

async function executeHealthScore(params: {
  roe?: number;
  roa?: number;
  operatingMargin?: number;
  netMargin?: number;
  debtToEquity?: number;
  currentRatio?: number;
  revenueGrowth?: number;
  earningsGrowth?: number;
}): Promise<Outcome<HealthScoreResult>> {
  const out = await computeHealthScoreTool.execute(
    params as Record<string, unknown>
  );
  return {
    success: out.success,
    data: out.data as HealthScoreResult | undefined,
    error: out.error,
  };
}

async function executeDcf(params: {
  currentPrice?: number;
  freeCashFlow?: number;
  sharesOutstanding?: number;
  growthRate?: number;
  terminalGrowthRate?: number;
  discountRate?: number;
  projectionYears?: number;
}): Promise<Outcome<DcfResult>> {
  const out = await computeDcfTool.execute(params as Record<string, unknown>);
  return {
    success: out.success,
    data: out.data as DcfResult | undefined,
    error: out.error,
  };
}

// ── Helpers asserting the (private) growth-metrics math via the real tool ──
//
// computeCAGR / assessMarginTrend / computeConsistency are not exported, so we
// surface them through a 2-statement (or N-statement) growth-metrics call and
// read the rounded public field. CAGR is exposed rounded to 4 decimals.

/** Real revenueCAGR for start→end over `years` (years+1 statements). */
async function cagrViaTool(
  start: number,
  end: number,
  years: number
): Promise<number> {
  const statements: FinancialStatement[] = Array.from(
    { length: years + 1 },
    (_, i) => ({
      period: `FY${2000 + i}`,
      // geometric interpolation so first=start, last=end, all > 0
      revenue: start * Math.pow(end / start, i / years),
      netIncome: 100,
    })
  );
  const res = await executeGrowthMetrics({ statements });
  assert.equal(res.success, true);
  return res.data!.revenueCAGR;
}

/** Real marginTrend for a given operating-margin series. */
async function marginTrendViaTool(
  margins: number[]
): Promise<"improving" | "stable" | "declining"> {
  // operatingMargin = operatingIncome / revenue; fix revenue=1000 so margin*1000 = OI.
  const statements: FinancialStatement[] = margins.map((m, i) => ({
    period: `FY${2000 + i}`,
    revenue: 1000,
    operatingIncome: m * 1000,
    netIncome: 100,
  }));
  const res = await executeGrowthMetrics({ statements });
  assert.equal(res.success, true);
  return res.data!.marginTrend;
}

/** Real growthConsistency for a revenue series (rounded to 2 decimals). */
async function consistencyViaTool(revenues: number[]): Promise<number> {
  const statements: FinancialStatement[] = revenues.map((r, i) => ({
    period: `FY${2000 + i}`,
    revenue: r,
    netIncome: 100,
  }));
  const res = await executeGrowthMetrics({ statements });
  assert.equal(res.success, true);
  return res.data!.growthConsistency;
}

/** Real scoreMetric(value, benchmark, higherIsBetter=true) via ROE detail. */
async function roeScoreViaTool(roe: number | undefined): Promise<number> {
  const res = await executeHealthScore(roe == null ? {} : { roe });
  assert.equal(res.success, true);
  return res.data!.details.roe!.score;
}

/** Real scoreMetric(value, benchmark, higherIsBetter=false) via D/E detail. */
async function deScoreViaTool(de: number | undefined): Promise<number> {
  const res = await executeHealthScore(de == null ? {} : { debtToEquity: de });
  assert.equal(res.success, true);
  return res.data!.details.debtToEquity!.score;
}

// ════════════════════════════════════════════════════════════════
//  TESTS
// ════════════════════════════════════════════════════════════════

// ────────────────────────────────────────────────────────────────
//  1. computeCAGR — exercised through computeGrowthMetricsTool.revenueCAGR
//     (the helper is module-private; revenueCAGR is its observable output,
//      rounded to 4 decimals, with years = statements.length - 1 (integer ≥ 1)).
//
//  NOTE: raw-signature-only edges that the tool can never produce are dropped:
//    - fractional years (2.5, 0.5) and years = 1000 — the tool's `years` is
//      always an integer = statements.length - 1.
//    - negative `years` — same reason (always ≥ 1).
//  Their guard intent ("returns 0 for bad inputs") is still covered below via
//  the reachable paths: <2 valid revenues → 0, and non-positive start/end → 0.
// ────────────────────────────────────────────────────────────────

describe("computeCAGR (via compute_growth_metrics revenueCAGR)", () => {
  it("should compute normal growth (100 -> 200 in 5 years)", async () => {
    const result = await cagrViaTool(100, 200, 5);
    // (200/100)^(1/5) - 1 ~ 0.1487 (rounded to 4dp by the tool)
    assert.ok(
      Math.abs(result - 0.1487) < 0.001,
      `Expected ~0.1487, got ${result}`
    );
  });

  it("should return 0 when the start revenue is non-positive (guard)", async () => {
    // revenue[0] = -100 reaches computeCAGR(-100, …) → guard returns 0.
    const res = await executeGrowthMetrics({
      statements: [
        { period: "FY1", revenue: -100, netIncome: 1 },
        { period: "FY2", revenue: 200, netIncome: 1 },
      ],
    });
    assert.equal(res.success, true);
    assert.strictEqual(res.data!.revenueCAGR, 0);
  });

  it("should return 0 when the end revenue is non-positive (guard)", async () => {
    const res = await executeGrowthMetrics({
      statements: [
        { period: "FY1", revenue: 100, netIncome: 1 },
        { period: "FY2", revenue: -200, netIncome: 1 },
      ],
    });
    assert.equal(res.success, true);
    assert.strictEqual(res.data!.revenueCAGR, 0);
  });

  it("should return 0 when fewer than 2 revenues are present (guard)", async () => {
    // Second statement omits revenue → revenues.length < 2 → revenueCAGR 0.
    const res = await executeGrowthMetrics({
      statements: [
        { period: "FY1", revenue: 100, netIncome: 1 },
        { period: "FY2", netIncome: 1 },
      ],
    });
    assert.equal(res.success, true);
    assert.strictEqual(res.data!.revenueCAGR, 0);
  });

  it("should return 0 when start equals end (flat revenue)", async () => {
    assert.strictEqual(await cagrViaTool(100, 100, 5), 0);
  });

  it("should handle very large growth (100 -> 1000000 in 10 years)", async () => {
    const result = await cagrViaTool(100, 1000000, 10);
    // (10000)^(1/10) - 1 ~ 1.5849
    assert.ok(result > 1, `Expected > 100%, got ${result}`);
    assert.ok(Number.isFinite(result), "Should be finite");
  });

  it("should handle very small growth (100 -> 101 in 10 years)", async () => {
    const result = await cagrViaTool(100, 101, 10);
    assert.ok(
      result > 0 && result < 0.01,
      `Expected tiny positive CAGR, got ${result}`
    );
  });

  it("should compute exactly 10% for (100 -> 110 in 1 year)", async () => {
    const result = await cagrViaTool(100, 110, 1);
    assert.ok(Math.abs(result - 0.1) < 1e-4, `Expected 0.1, got ${result}`);
  });

  it("should compute 1 year period with doubling", async () => {
    const result = await cagrViaTool(100, 200, 1);
    assert.ok(
      Math.abs(result - 1.0) < 1e-4,
      `Expected 1.0 (100%), got ${result}`
    );
  });

  it("should handle very large numbers without overflow", async () => {
    const result = await cagrViaTool(1e12, 2e12, 10);
    assert.ok(Number.isFinite(result), "Should be finite");
    assert.ok(result > 0, "Should be positive growth");
  });

  it("should handle decline (200 -> 100 in 5 years) → negative CAGR", async () => {
    const result = await cagrViaTool(200, 100, 5);
    // (0.5)^(1/5) - 1 ~ -0.1294
    assert.ok(result < 0, `Expected negative CAGR for decline, got ${result}`);
  });

  it("should handle end much smaller than start (near-zero end)", async () => {
    const result = await cagrViaTool(1000, 0.01, 5);
    assert.ok(result < 0, "Severe decline should be negative");
  });

  it("should be directional: forward > 0, backward < 0", async () => {
    const forward = await cagrViaTool(100, 300, 4);
    const backward = await cagrViaTool(300, 100, 4);
    assert.ok(forward > 0, "Forward should be positive");
    assert.ok(backward < 0, "Backward should be negative");
  });

  it("should return 0 when start = end = 1", async () => {
    assert.strictEqual(await cagrViaTool(1, 1, 10), 0);
  });

  it("should compute known value: 1000 -> 1610.51 in 5 years ~ 10%", async () => {
    const result = await cagrViaTool(1000, 1610.51, 5);
    assert.ok(Math.abs(result - 0.1) < 0.001, `Expected ~0.1, got ${result}`);
  });
});

// ────────────────────────────────────────────────────────────────
//  2. assessMarginTrend — via compute_growth_metrics marginTrend
//     (operatingMargin = operatingIncome / revenue; revenue fixed at 1000).
// ────────────────────────────────────────────────────────────────

describe("assessMarginTrend (via compute_growth_metrics marginTrend)", () => {
  it("should return stable when fewer than 2 margins (single statement n/a → use empty-margins path)", async () => {
    // No operatingIncome anywhere → margins=[] → assessMarginTrend([]) = stable.
    const res = await executeGrowthMetrics({
      statements: [
        { period: "FY1", revenue: 1000, netIncome: 1 },
        { period: "FY2", revenue: 1100, netIncome: 1 },
      ],
    });
    assert.equal(res.success, true);
    assert.strictEqual(res.data!.marginTrend, "stable");
  });

  it("should return improving for consistently increasing margins", async () => {
    assert.strictEqual(
      await marginTrendViaTool([0.1, 0.12, 0.14, 0.16]),
      "improving"
    );
  });

  it("should return declining for consistently decreasing margins", async () => {
    assert.strictEqual(
      await marginTrendViaTool([0.16, 0.14, 0.12, 0.1]),
      "declining"
    );
  });

  it("should return stable when improving equals declining", async () => {
    assert.strictEqual(await marginTrendViaTool([0.1, 0.12, 0.1]), "stable");
  });

  it("should treat diff exactly 0.005 as neither improving nor declining", async () => {
    assert.strictEqual(await marginTrendViaTool([0.1, 0.105]), "stable");
  });

  it("should treat diff of 0.004 as neither", async () => {
    assert.strictEqual(await marginTrendViaTool([0.1, 0.104]), "stable");
  });

  it("should treat diff just above 0.005 as improving", async () => {
    assert.strictEqual(await marginTrendViaTool([0.1, 0.1051]), "improving");
  });

  it("should treat diff of -0.005 exactly as stable (not declining)", async () => {
    assert.strictEqual(await marginTrendViaTool([0.105, 0.1]), "stable");
  });

  it("should treat diff just below -0.005 as declining", async () => {
    assert.strictEqual(await marginTrendViaTool([0.1051, 0.1]), "declining");
  });

  it("should handle mixed with some stable periods", async () => {
    assert.strictEqual(
      await marginTrendViaTool([0.1, 0.102, 0.12, 0.118]),
      "improving"
    );
  });

  it("should handle large array of improving margins", async () => {
    const margins = Array.from({ length: 20 }, (_, i) => 0.05 + i * 0.01);
    assert.strictEqual(await marginTrendViaTool(margins), "improving");
  });

  it("should handle large array of declining margins", async () => {
    const margins = Array.from({ length: 20 }, (_, i) => 0.25 - i * 0.01);
    assert.strictEqual(await marginTrendViaTool(margins), "declining");
  });

  it("should handle two elements with large improvement", async () => {
    assert.strictEqual(await marginTrendViaTool([0.01, 0.5]), "improving");
  });

  it("should handle two elements with large decline", async () => {
    assert.strictEqual(await marginTrendViaTool([0.5, 0.01]), "declining");
  });

  it("should handle alternating up-down with more ups", async () => {
    assert.strictEqual(
      await marginTrendViaTool([0.1, 0.12, 0.11, 0.13, 0.15]),
      "improving"
    );
  });

  it("should handle alternating up-down with more downs", async () => {
    assert.strictEqual(
      await marginTrendViaTool([0.15, 0.13, 0.14, 0.12, 0.1]),
      "declining"
    );
  });
});

// ────────────────────────────────────────────────────────────────
//  3. computeConsistency — via compute_growth_metrics growthConsistency
//     (revenue series; tool rounds the ratio to 2 decimals).
// ────────────────────────────────────────────────────────────────

describe("computeConsistency (via compute_growth_metrics growthConsistency)", () => {
  it("should return 1 for all increasing values", async () => {
    assert.strictEqual(await consistencyViaTool([10, 20, 30, 40, 50]), 1);
  });

  it("should return 0 for all decreasing values", async () => {
    assert.strictEqual(await consistencyViaTool([50, 40, 30, 20, 10]), 0);
  });

  it("should return 0.5 for half increasing", async () => {
    // 10->20 (up), 20->15 (down), 15->25 (up), 25->10 (down) => 2/4 = 0.5
    assert.strictEqual(await consistencyViaTool([10, 20, 15, 25, 10]), 0.5);
  });

  it("should return 0 for all same values", async () => {
    assert.strictEqual(await consistencyViaTool([100, 100, 100, 100]), 0);
  });

  it("should handle two elements increasing", async () => {
    assert.strictEqual(await consistencyViaTool([1, 2]), 1);
  });

  it("should handle two elements decreasing", async () => {
    assert.strictEqual(await consistencyViaTool([2, 1]), 0);
  });

  it("should handle two elements equal", async () => {
    assert.strictEqual(await consistencyViaTool([5, 5]), 0);
  });

  it("should compute 0.75 for 3 out of 4 increasing", async () => {
    // 10->20 (up), 20->25 (up), 25->30 (up), 30->20 (down) => 3/4 = 0.75
    assert.strictEqual(await consistencyViaTool([10, 20, 25, 30, 20]), 0.75);
  });

  it("should compute 0.25 for 1 out of 4 increasing", async () => {
    // 40->30 (down), 30->20 (down), 20->25 (up), 25->15 (down) => 1/4 = 0.25
    assert.strictEqual(await consistencyViaTool([40, 30, 20, 25, 15]), 0.25);
  });
});

// ────────────────────────────────────────────────────────────────
//  4. scoreMetric — via compute_health_score detail scores
//     higherIsBetter=true  → ROE detail  (benchmark 0.15)
//     higherIsBetter=false → D/E detail  (benchmark 1.0)
//     The helper's `weight` is always 1 from the tool, so weight variants are
//     dropped (not reachable). NaN/undefined → score 50 is observable.
// ────────────────────────────────────────────────────────────────

describe("scoreMetric (via compute_health_score detail scores)", () => {
  it("undefined value → score 50 (ROE)", async () => {
    assert.strictEqual(await roeScoreViaTool(undefined), 50);
  });

  it("NaN value → score 50 (ROE)", async () => {
    assert.strictEqual(await roeScoreViaTool(NaN), 50);
  });

  // higherIsBetter = true (ROE, benchmark 0.15)
  it("higherIsBetter=true: value at benchmark → score 100", async () => {
    assert.strictEqual(await roeScoreViaTool(0.15), 100);
  });

  it("higherIsBetter=true: value at 2x benchmark → clamped 100", async () => {
    assert.strictEqual(await roeScoreViaTool(0.3), 100);
  });

  it("higherIsBetter=true: value at 0 → score 0", async () => {
    assert.strictEqual(await roeScoreViaTool(0), 0);
  });

  it("higherIsBetter=true: value at half benchmark → score 50", async () => {
    assert.strictEqual(await roeScoreViaTool(0.075), 50);
  });

  it("higherIsBetter=true: value at 0.75 benchmark → score 75", async () => {
    assert.strictEqual(await roeScoreViaTool(0.1125), 75);
  });

  it("higherIsBetter=true: negative value → score 0 (clamped)", async () => {
    assert.strictEqual(await roeScoreViaTool(-0.1), 0);
  });

  it("higherIsBetter=true: very large value → clamped 100", async () => {
    assert.strictEqual(await roeScoreViaTool(1000), 100);
  });

  // higherIsBetter = false (D/E, benchmark 1.0)
  it("higherIsBetter=false: value at benchmark → score 50", async () => {
    assert.strictEqual(await deScoreViaTool(1.0), 50);
  });

  it("higherIsBetter=false: value at 0 → score 100", async () => {
    assert.strictEqual(await deScoreViaTool(0), 100);
  });

  it("higherIsBetter=false: value at 2x benchmark → score 0", async () => {
    assert.strictEqual(await deScoreViaTool(2.0), 0);
  });

  it("higherIsBetter=false: value at 3x benchmark → clamped 0", async () => {
    assert.strictEqual(await deScoreViaTool(3.0), 0);
  });

  it("higherIsBetter=false: value at half benchmark → score 75", async () => {
    assert.strictEqual(await deScoreViaTool(0.5), 75);
  });

  it("higherIsBetter=false: negative value → clamped 100", async () => {
    // ratio=-0.5 → (2-(-0.5))*50 = 125 → clamp 100.
    assert.strictEqual(await deScoreViaTool(-0.5), 100);
  });

  it("preserves the original value in the detail (ROE)", async () => {
    const res = await executeHealthScore({ roe: 0.23 });
    assert.equal(res.success, true);
    assert.strictEqual(res.data!.details.roe!.value, 0.23);
  });
});

// ────────────────────────────────────────────────────────────────
//  6. Health Score (execute)
// ────────────────────────────────────────────────────────────────

describe("Health Score (execute)", () => {
  // REAL tool: overall = profitability*0.25 + leverage*0.20 + liquidity*0.15 +
  // efficiency*0.15 + growth*0.15 (weights sum to 0.90). leverage = avg(D/E,
  // interestCoverage|50); efficiency = avg(ROA, cfToNetIncome|50). Default
  // (no-sector) benchmarks: roe .15 / roa .05 / opMargin .15 / netMargin .10 /
  // D/E 1.0 / currentRatio 1.5; growth benchmarks .10.
  it("should compute score with all params provided (excellent company)", async () => {
    const result = await executeHealthScore({
      roe: 0.2,
      netMargin: 0.15,
      operatingMargin: 0.2,
      debtToEquity: 0.3,
      currentRatio: 2.5,
      roa: 0.1,
      revenueGrowth: 0.2,
      earningsGrowth: 0.25,
    });

    assert.strictEqual(result.success, true);
    const data = result.data!;
    assert.ok(
      data.overall > 70,
      `Expected high overall for excellent company, got ${data.overall}`
    );
    assert.ok(data.overall <= 100, "Overall should be <= 100");
  });

  it("all params undefined → every category 50, overall 45 (weights sum to 0.90)", async () => {
    const result = await executeHealthScore({});

    assert.strictEqual(result.success, true);
    const data = result.data!;
    // Each scoreMetric returns 50 for undefined; leverage/efficiency average
    // 50 with their default-50 second dimension → still 50.
    assert.strictEqual(data.profitability, 50);
    assert.strictEqual(data.leverage, 50);
    assert.strictEqual(data.liquidity, 50);
    assert.strictEqual(data.efficiency, 50);
    assert.strictEqual(data.growth, 50);
    // 50 * (0.25+0.20+0.15+0.15+0.15) = 50 * 0.90 = 45.
    assert.strictEqual(data.overall, 45);
  });

  it("should compute low score for distressed company", async () => {
    const result = await executeHealthScore({
      roe: -0.1,
      netMargin: -0.05,
      operatingMargin: -0.08,
      debtToEquity: 5.0,
      currentRatio: 0.3,
      roa: -0.02,
      revenueGrowth: -0.2,
      earningsGrowth: -0.3,
    });

    assert.strictEqual(result.success, true);
    const data = result.data!;
    assert.ok(
      data.overall < 25,
      `Expected low overall for distressed company, got ${data.overall}`
    );
    assert.ok(data.overall >= 0, "Overall should be >= 0");
  });

  it("should correctly weight the overall score (all metrics at benchmark)", async () => {
    const result = await executeHealthScore({
      roe: 0.15,
      netMargin: 0.1,
      operatingMargin: 0.15,
      debtToEquity: 1.0,
      currentRatio: 1.5,
      roa: 0.05,
      revenueGrowth: 0.1,
      earningsGrowth: 0.1,
    });

    assert.strictEqual(result.success, true);
    const data = result.data!;
    // roe=100, netMargin=100, opMargin=100 => profitability=100
    // D/E at benchmark => de=50; interestCoverage absent => 50 => leverage=50
    // CR at benchmark => liquidity=100
    // ROA=100; cfToNetIncome absent => 50 => efficiency=round((100+50)/2)=75
    // revGrowth=100, earnGrowth=100 => growth=100
    // overall = 100*0.25 + 50*0.20 + 100*0.15 + 75*0.15 + 100*0.15
    //         = 25 + 10 + 15 + 11.25 + 15 = 76.25 => 76
    assert.strictEqual(data.profitability, 100);
    assert.strictEqual(data.leverage, 50);
    assert.strictEqual(data.liquidity, 100);
    assert.strictEqual(data.efficiency, 75);
    assert.strictEqual(data.growth, 100);
    assert.strictEqual(data.overall, 76);
  });

  it("should clamp overall to 0-100 range", async () => {
    const result = await executeHealthScore({
      roe: 0.15,
      netMargin: 0.1,
      operatingMargin: 0.15,
      debtToEquity: 1.0,
      currentRatio: 1.5,
      roa: 0.05,
      revenueGrowth: 0.1,
      earningsGrowth: 0.1,
    });

    assert.strictEqual(result.success, true);
    const data = result.data!;
    assert.ok(data.overall >= 0, "Overall >= 0");
    assert.ok(data.overall <= 100, "Overall <= 100");
  });

  it("should populate details object correctly", async () => {
    const result = await executeHealthScore({
      roe: 0.2,
      netMargin: 0.05,
      debtToEquity: 2.0,
    });

    assert.strictEqual(result.success, true);
    const data = result.data!;
    assert.ok("roe" in data.details, "Should have roe detail");
    assert.ok("netMargin" in data.details, "Should have netMargin detail");
    assert.ok(
      "debtToEquity" in data.details,
      "Should have debtToEquity detail"
    );
    assert.ok(
      "currentRatio" in data.details,
      "Should have currentRatio detail"
    );
    assert.ok("roa" in data.details, "Should have roa detail");
    assert.ok(
      "revenueGrowth" in data.details,
      "Should have revenueGrowth detail"
    );
    assert.ok(
      "earningsGrowth" in data.details,
      "Should have earningsGrowth detail"
    );
    assert.ok(
      "operatingMargin" in data.details,
      "Should have operatingMargin detail"
    );

    // Check roe detail values
    assert.strictEqual(data.details.roe!.metric, "ROE");
    assert.strictEqual(data.details.roe!.value, 0.2);
    assert.strictEqual(data.details.roe!.benchmark, 0.15);
  });

  it("should handle only profitability params provided", async () => {
    const result = await executeHealthScore({
      roe: 0.3,
      netMargin: 0.2,
      operatingMargin: 0.25,
    });

    assert.strictEqual(result.success, true);
    const data = result.data!;
    assert.ok(data.profitability > 50, "Profitability should be high");
    // Other categories default: leverage/liquidity 50, efficiency=avg(50,50)=50, growth 50.
    assert.strictEqual(data.leverage, 50);
    assert.strictEqual(data.liquidity, 50);
    assert.strictEqual(data.efficiency, 50);
    assert.strictEqual(data.growth, 50);
  });

  it("D/E = 0 with no interest coverage → leverage = avg(100, 50) = 75", async () => {
    const result = await executeHealthScore({ debtToEquity: 0.0 });
    assert.strictEqual(result.success, true);
    const data = result.data!;
    // D/E=0: de.score = clamp((2-0)*50,0,100)=100; interestCoverage absent → 50.
    // leverage = round((100 + 50) / 2) = 75.
    assert.strictEqual(data.leverage, 75);
  });

  it("interestCoverage participates in leverage when provided", async () => {
    // D/E at benchmark (de=50) + strong interest coverage (≥ benchmark → 100)
    // → leverage = round((50 + 100)/2) = 75.
    const result = await executeHealthScore({
      debtToEquity: 1.0,
      // not in the narrow param type, but the real tool reads it; cast through.
      ...({ interestCoverage: 6 } as { interestCoverage: number }),
    });
    assert.strictEqual(result.success, true);
    assert.strictEqual(result.data!.leverage, 75);
  });

  it("cfToNetIncome participates in efficiency when provided", async () => {
    // ROA at benchmark (100) + strong CF/NI (≥1 → 100) → efficiency = 100.
    const result = await executeHealthScore({
      roa: 0.05,
      ...({ cfToNetIncome: 1.5 } as { cfToNetIncome: number }),
    });
    assert.strictEqual(result.success, true);
    assert.strictEqual(result.data!.efficiency, 100);
  });

  it("should produce correct profitability with mixed good/bad metrics", async () => {
    const result = await executeHealthScore({
      roe: 0.3, // 200% of benchmark -> score 100 (clamped)
      netMargin: 0.01, // 10% of benchmark -> score 10
      operatingMargin: 0.15, // at benchmark -> score 100
    });

    assert.strictEqual(result.success, true);
    const data = result.data!;
    // profitability = round((100 + 10 + 100) / 3) = round(70) = 70
    assert.strictEqual(data.profitability, 70);
  });

  it("should handle zero current ratio", async () => {
    const result = await executeHealthScore({ currentRatio: 0 });
    assert.strictEqual(result.success, true);
    const data = result.data!;
    assert.strictEqual(data.liquidity, 0);
  });

  it("should handle very high current ratio (capped at 100)", async () => {
    const result = await executeHealthScore({ currentRatio: 10.0 });
    assert.strictEqual(result.success, true);
    const data = result.data!;
    // ratio = 10/1.5 = 6.67, raw = clamp(667, 0, 100) = 100
    assert.strictEqual(data.liquidity, 100);
  });

  it("all zeros → overall 19 (leverage=75 from D/E=0, efficiency=25)", async () => {
    const result = await executeHealthScore({
      roe: 0,
      netMargin: 0,
      operatingMargin: 0,
      debtToEquity: 0,
      currentRatio: 0,
      roa: 0,
      revenueGrowth: 0,
      earningsGrowth: 0,
    });

    assert.strictEqual(result.success, true);
    const data = result.data!;
    // profitability=0; D/E=0 → de=100, ic absent 50 → leverage=75;
    // liquidity=0; ROA=0, cf absent 50 → efficiency=round((0+50)/2)=25; growth=0.
    // overall = 0*0.25 + 75*0.20 + 0*0.15 + 25*0.15 + 0*0.15 = 15 + 3.75 = 18.75 => 19.
    assert.strictEqual(data.leverage, 75);
    assert.strictEqual(data.efficiency, 25);
    assert.strictEqual(data.overall, 19);
  });

  it("should have growth as average of revenue and earnings growth scores", async () => {
    const result = await executeHealthScore({
      revenueGrowth: 0.2, // ratio=2, score=100 (clamped)
      earningsGrowth: 0.05, // ratio=0.5, score=50
    });

    assert.strictEqual(result.success, true);
    const data = result.data!;
    // growth = round((100 + 50) / 2) = 75
    assert.strictEqual(data.growth, 75);
  });

  it("should handle partial params with some undefined", async () => {
    const result = await executeHealthScore({
      roe: 0.15,
      debtToEquity: 1.0,
      roa: 0.05,
    });

    assert.strictEqual(result.success, true);
    const data = result.data!;
    // roe=100, netMargin=50(undef), opMargin=50(undef) => profitability=round(200/3)=67
    assert.strictEqual(data.profitability, 67);
    // D/E benchmark => de=50, ic absent 50 => leverage=50.
    assert.strictEqual(data.leverage, 50);
    // ROA=100, cf absent 50 => efficiency=round((100+50)/2)=75.
    assert.strictEqual(data.efficiency, 75);
  });
});

// ────────────────────────────────────────────────────────────────
//  7. Growth Metrics (execute)
// ────────────────────────────────────────────────────────────────

describe("Growth Metrics (execute)", () => {
  // MONEY-1274 (MONEY-1155 #30) — CHANGED from `success: false`. A thin input is
  // not a failed computation: `success: false` marks the executor task FAILED and
  // the synthesiser lists it under "FAILED / UNAVAILABLE SOURCES", so a run that
  // merely fetched too little data was reported as the analysis engine breaking.
  // Contract is now `success: true` + `available: false` + a reason.
  // See packages/research/src/tools/insufficient-input.ts.
  //
  // NOTE these live in apps/web AND packages/research — the same tools are
  // covered from two workspaces, and only the research copy was updated when the
  // guards were converted. The full gate caught it; a single-workspace run did
  // not.
  it("reports UNAVAILABLE with less than 2 statements", async () => {
    const result = await executeGrowthMetrics({
      statements: [{ period: "FY2023", revenue: 1000, netIncome: 100 }],
    });
    assert.strictEqual(result.success, true);
    const d = result.data as unknown as Record<string, unknown>;
    assert.strictEqual(d.available, false);
    assert.ok(String(d.reason).includes("At least 2"));
    assert.strictEqual(d.got, 1, "the shortfall is reported, not just the gap");
  });

  it("reports UNAVAILABLE with an empty statements array", async () => {
    const result = await executeGrowthMetrics({ statements: [] });
    assert.strictEqual(result.success, true);
    assert.strictEqual(
      (result.data as unknown as Record<string, unknown>).available,
      false
    );
  });

  it("reports UNAVAILABLE with undefined statements", async () => {
    const result = await executeGrowthMetrics({});
    assert.strictEqual(result.success, true);
    assert.strictEqual(
      (result.data as unknown as Record<string, unknown>).available,
      false
    );
  });

  it("should compute revenue CAGR for 2 statements", async () => {
    const result = await executeGrowthMetrics({
      statements: [
        { period: "FY2022", revenue: 1000, netIncome: 100 },
        { period: "FY2023", revenue: 1100, netIncome: 120 },
      ],
    });

    assert.strictEqual(result.success, true);
    const data = result.data!;
    // revenueCAGR = CAGR(1000, 1100, 1) = 0.10 => rounded to 4 dec = 0.1
    assert.strictEqual(data.revenueCAGR, 0.1);
  });

  it("should compute profit CAGR using Math.abs", async () => {
    const result = await executeGrowthMetrics({
      statements: [
        { period: "FY2022", revenue: 1000, netIncome: -50 },
        { period: "FY2023", revenue: 1100, netIncome: -30 },
      ],
    });

    assert.strictEqual(result.success, true);
    const data = result.data!;
    // profitCAGR = CAGR(abs(-50)=50, abs(-30)=30, 1) = 30/50 - 1 = -0.4
    // But CAGR(50, 30, 1) -> 30 > 0, 50 > 0 => (30/50)^1 - 1 = -0.4
    assert.ok(
      Math.abs(data.profitCAGR - -0.4) < 0.001,
      `Expected -0.4, got ${data.profitCAGR}`
    );
  });

  it("should compute EPS CAGR from eps array", async () => {
    const result = await executeGrowthMetrics({
      statements: [
        { period: "FY2022", revenue: 1000, netIncome: 100 },
        { period: "FY2023", revenue: 1100, netIncome: 120 },
      ],
      eps: [10, 12],
    });

    assert.strictEqual(result.success, true);
    const data = result.data!;
    // epsCAGR = CAGR(10, 12, 1) = 0.2
    assert.strictEqual(data.epsCAGR, 0.2);
  });

  it("should return epsCAGR=0 when no eps array provided", async () => {
    const result = await executeGrowthMetrics({
      statements: [
        { period: "FY2022", revenue: 1000, netIncome: 100 },
        { period: "FY2023", revenue: 1100, netIncome: 120 },
      ],
    });

    assert.strictEqual(result.success, true);
    assert.strictEqual(result.data!.epsCAGR, 0);
  });

  it("should return epsCAGR=0 when eps array has < 2 elements", async () => {
    const result = await executeGrowthMetrics({
      statements: [
        { period: "FY2022", revenue: 1000, netIncome: 100 },
        { period: "FY2023", revenue: 1100, netIncome: 120 },
      ],
      eps: [10],
    });

    assert.strictEqual(result.success, true);
    assert.strictEqual(result.data!.epsCAGR, 0);
  });

  it("should round CAGR values to 4 decimal places", async () => {
    const result = await executeGrowthMetrics({
      statements: [
        { period: "FY2020", revenue: 1000, netIncome: 100 },
        { period: "FY2021", revenue: 1150, netIncome: 130 },
        { period: "FY2022", revenue: 1350, netIncome: 160 },
        { period: "FY2023", revenue: 1500, netIncome: 200 },
      ],
    });

    assert.strictEqual(result.success, true);
    const data = result.data!;
    // Check rounding: should have at most 4 decimal places
    const revenueStr = data.revenueCAGR.toString();
    const decimalPart = revenueStr.split(".")[1] || "";
    assert.ok(
      decimalPart.length <= 4,
      `Revenue CAGR has more than 4 decimal places: ${data.revenueCAGR}`
    );
  });

  it("should compute growthConsistency rounded to 2 decimal places", async () => {
    const result = await executeGrowthMetrics({
      statements: [
        { period: "FY2020", revenue: 100, netIncome: 10 },
        { period: "FY2021", revenue: 120, netIncome: 12 },
        { period: "FY2022", revenue: 110, netIncome: 11 },
        { period: "FY2023", revenue: 130, netIncome: 13 },
      ],
    });

    assert.strictEqual(result.success, true);
    const data = result.data!;
    // revenues: [100, 120, 110, 130]
    // consistency: 100->120 (up), 120->110 (down), 110->130 (up) => 2/3 = 0.6667 => round to 0.67
    assert.strictEqual(data.growthConsistency, 0.67);
  });

  it("should compute marginTrend from operating margins", async () => {
    const result = await executeGrowthMetrics({
      statements: [
        {
          period: "FY2020",
          revenue: 1000,
          operatingIncome: 100,
          netIncome: 80,
        },
        {
          period: "FY2021",
          revenue: 1100,
          operatingIncome: 130,
          netIncome: 100,
        },
        {
          period: "FY2022",
          revenue: 1200,
          operatingIncome: 160,
          netIncome: 120,
        },
      ],
    });

    assert.strictEqual(result.success, true);
    const data = result.data!;
    // margins: 100/1000=0.1, 130/1100=0.1182, 160/1200=0.1333
    // diffs: 0.0182 (improving), 0.0152 (improving) => "improving"
    assert.strictEqual(data.marginTrend, "improving");
  });

  it("should return stable marginTrend when no operating income", async () => {
    const result = await executeGrowthMetrics({
      statements: [
        { period: "FY2022", revenue: 1000, netIncome: 100 },
        { period: "FY2023", revenue: 1100, netIncome: 120 },
      ],
    });

    assert.strictEqual(result.success, true);
    // No operatingIncome => margins array is empty => assessMarginTrend([]) = "stable"
    assert.strictEqual(result.data!.marginTrend, "stable");
  });

  it("should populate details array with one entry per statement", async () => {
    const stmts: FinancialStatement[] = [
      { period: "FY2020", revenue: 500, netIncome: 50, operatingIncome: 70 },
      { period: "FY2021", revenue: 600, netIncome: 60, operatingIncome: 90 },
      { period: "FY2022", revenue: 700, netIncome: 70, operatingIncome: 105 },
    ];
    const result = await executeGrowthMetrics({ statements: stmts });

    assert.strictEqual(result.success, true);
    const data = result.data!;
    assert.strictEqual(data.details.length, 3);
    assert.strictEqual(data.details[0]!.period, "FY2020");
    assert.strictEqual(data.details[0]!.revenue, 500);
    assert.strictEqual(data.details[0]!.netIncome, 50);
    // operatingMargin = 70/500 = 0.14 => round to 4 dec = 0.14
    assert.strictEqual(data.details[0]!.operatingMargin, 0.14);
  });

  it("should set operatingMargin to undefined in details when missing operatingIncome", async () => {
    const result = await executeGrowthMetrics({
      statements: [
        { period: "FY2022", revenue: 1000, netIncome: 100 },
        { period: "FY2023", revenue: 1100, netIncome: 120 },
      ],
    });

    assert.strictEqual(result.success, true);
    assert.strictEqual(result.data!.details[0]!.operatingMargin, undefined);
  });

  it("should handle statements with no revenue (filtered out of revenue array)", async () => {
    const result = await executeGrowthMetrics({
      statements: [
        { period: "FY2022", netIncome: 100 },
        { period: "FY2023", netIncome: 120 },
      ],
    });

    assert.strictEqual(result.success, true);
    // revenues empty => revenueCAGR = 0
    assert.strictEqual(result.data!.revenueCAGR, 0);
  });

  it("should use years = statements.length - 1 for CAGR denominator", async () => {
    const result = await executeGrowthMetrics({
      statements: [
        { period: "FY2019", revenue: 100, netIncome: 10 },
        { period: "FY2020", revenue: 110, netIncome: 11 },
        { period: "FY2021", revenue: 121, netIncome: 12 },
        { period: "FY2022", revenue: 133.1, netIncome: 13 },
        { period: "FY2023", revenue: 146.41, netIncome: 14 },
      ],
    });

    assert.strictEqual(result.success, true);
    const data = result.data!;
    // CAGR(100, 146.41, 4) = (1.4641)^(1/4) - 1 = 1.1 - 1 = 0.1
    assert.strictEqual(data.revenueCAGR, 0.1);
  });

  it("should handle EPS array with negative values using abs", async () => {
    const result = await executeGrowthMetrics({
      statements: [
        { period: "FY2022", revenue: 1000, netIncome: 100 },
        { period: "FY2023", revenue: 1100, netIncome: 120 },
      ],
      eps: [-5, -10],
    });

    assert.strictEqual(result.success, true);
    const data = result.data!;
    // epsCAGR = CAGR(abs(-5)=5, abs(-10)=10, 1) = (10/5)^1 - 1 = 1.0
    assert.strictEqual(data.epsCAGR, 1);
  });

  it("should handle EPS array length different from statements length", async () => {
    const result = await executeGrowthMetrics({
      statements: [
        { period: "FY2022", revenue: 1000, netIncome: 100 },
        { period: "FY2023", revenue: 1100, netIncome: 120 },
      ],
      eps: [10, 11, 12],
    });

    assert.strictEqual(result.success, true);
    const data = result.data!;
    // eps years = epsArr.length - 1 = 2
    // epsCAGR = CAGR(10, 12, 2) = (1.2)^0.5 - 1 = 0.0954
    assert.ok(
      Math.abs(data.epsCAGR - 0.0954) < 0.001,
      `Expected ~0.0954, got ${data.epsCAGR}`
    );
  });

  it("should handle many statements for large CAGR computation", async () => {
    const statements: FinancialStatement[] = Array.from(
      { length: 11 },
      (_, i) => ({
        period: `FY${2013 + i}`,
        revenue: 1000 * Math.pow(1.15, i),
        netIncome: 100 * Math.pow(1.12, i),
      })
    );

    const result = await executeGrowthMetrics({ statements });
    assert.strictEqual(result.success, true);
    const data = result.data!;
    // Revenue CAGR over 10 years with 15% annual growth should be ~0.15
    assert.ok(
      Math.abs(data.revenueCAGR - 0.15) < 0.001,
      `Expected ~0.15, got ${data.revenueCAGR}`
    );
  });

  it("should handle flat revenue (zero growth)", async () => {
    const result = await executeGrowthMetrics({
      statements: [
        { period: "FY2022", revenue: 1000, netIncome: 100 },
        { period: "FY2023", revenue: 1000, netIncome: 100 },
      ],
    });

    assert.strictEqual(result.success, true);
    assert.strictEqual(result.data!.revenueCAGR, 0);
    assert.strictEqual(result.data!.profitCAGR, 0);
    assert.strictEqual(result.data!.growthConsistency, 0);
  });

  it("should handle declining revenue", async () => {
    const result = await executeGrowthMetrics({
      statements: [
        { period: "FY2022", revenue: 1000, netIncome: 100 },
        { period: "FY2023", revenue: 800, netIncome: 60 },
      ],
    });

    assert.strictEqual(result.success, true);
    const data = result.data!;
    // revenueCAGR = CAGR(1000, 800, 1) = -0.2
    assert.strictEqual(data.revenueCAGR, -0.2);
    assert.strictEqual(data.growthConsistency, 0);
  });

  it("should handle operatingMargin rounding in details", async () => {
    const result = await executeGrowthMetrics({
      statements: [
        {
          period: "FY2022",
          revenue: 3000,
          operatingIncome: 1000,
          netIncome: 800,
        },
        {
          period: "FY2023",
          revenue: 3500,
          operatingIncome: 1200,
          netIncome: 950,
        },
      ],
    });

    assert.strictEqual(result.success, true);
    const data = result.data!;
    // FY2022: 1000/3000 = 0.33333... => round to 0.3333
    assert.strictEqual(data.details[0]!.operatingMargin, 0.3333);
    // FY2023: 1200/3500 = 0.34285... => round to 0.3429
    assert.strictEqual(data.details[1]!.operatingMargin, 0.3429);
  });
});

// ────────────────────────────────────────────────────────────────
//  8. DCF (execute)
// ────────────────────────────────────────────────────────────────

describe("DCF (execute)", () => {
  it("should fail when currentPrice is missing", async () => {
    const result = await executeDcf({
      freeCashFlow: 1000000,
      sharesOutstanding: 100000,
    });
    assert.strictEqual(result.success, false);
    assert.ok(result.error?.includes("required"));
  });

  it("should fail when freeCashFlow is missing", async () => {
    const result = await executeDcf({
      currentPrice: 100,
      sharesOutstanding: 100000,
    });
    assert.strictEqual(result.success, false);
    assert.ok(result.error?.includes("required"));
  });

  it("should fail when sharesOutstanding is missing", async () => {
    const result = await executeDcf({
      currentPrice: 100,
      freeCashFlow: 1000000,
    });
    assert.strictEqual(result.success, false);
    assert.ok(result.error?.includes("required"));
  });

  it("should fail when discountRate equals terminalGrowthRate", async () => {
    const result = await executeDcf({
      currentPrice: 100,
      freeCashFlow: 1000000,
      sharesOutstanding: 100000,
      discountRate: 0.05,
      terminalGrowthRate: 0.05,
    });
    assert.strictEqual(result.success, false);
    assert.ok(result.error?.includes("greater than"));
  });

  it("should fail when discountRate is less than terminalGrowthRate", async () => {
    const result = await executeDcf({
      currentPrice: 100,
      freeCashFlow: 1000000,
      sharesOutstanding: 100000,
      discountRate: 0.02,
      terminalGrowthRate: 0.05,
    });
    assert.strictEqual(result.success, false);
    assert.ok(result.error?.includes("greater than"));
  });

  it("should use default parameters when not provided", async () => {
    const result = await executeDcf({
      currentPrice: 100,
      freeCashFlow: 1000000,
      sharesOutstanding: 100000,
    });
    assert.strictEqual(result.success, true);
    const data = result.data!;
    assert.strictEqual(data.assumptions.growthRate, 0.12);
    assert.strictEqual(data.assumptions.terminalGrowthRate, 0.03);
    assert.strictEqual(data.assumptions.discountRate, 0.1);
    assert.strictEqual(data.assumptions.projectionYears, 10);
  });

  it("should compute intrinsicValue with known inputs", async () => {
    const result = await executeDcf({
      currentPrice: 100,
      freeCashFlow: 1000000,
      sharesOutstanding: 100000,
      growthRate: 0.1,
      terminalGrowthRate: 0.03,
      discountRate: 0.1,
      projectionYears: 1,
    });

    assert.strictEqual(result.success, true);
    const data = result.data!;

    // Year 1: projectedFcf = 1000000 * 1.10 = 1100000, discountFactor = 1.10
    // discountedFcf = 1100000 / 1.10 = 1000000
    // terminalFcf = 1000000 * 1.10 * 1.03 = 1133000
    // terminalValue = 1133000 / (0.10 - 0.03) = 16185714.29
    // discountedTerminal = 16185714.29 / 1.10 = 14714285.71
    // totalPV = 1000000 + 14714285.71 = 15714285.71
    // intrinsicValue = 15714285.71 / 100000 = 157.14
    assert.strictEqual(data.intrinsicValue, 157.14);
  });

  it("should compute positive upside for undervalued stock", async () => {
    const result = await executeDcf({
      currentPrice: 50,
      freeCashFlow: 1000000,
      sharesOutstanding: 10000,
      growthRate: 0.15,
      terminalGrowthRate: 0.03,
      discountRate: 0.1,
      projectionYears: 10,
    });

    assert.strictEqual(result.success, true);
    const data = result.data!;
    assert.ok(data.intrinsicValue > 50, "Should be undervalued");
    assert.ok(data.upside > 0, "Upside should be positive");
    assert.ok(data.marginOfSafety > 0, "MoS should be positive");
  });

  it("should compute negative upside for overvalued stock", async () => {
    const result = await executeDcf({
      currentPrice: 10000,
      freeCashFlow: 1000,
      sharesOutstanding: 100000,
      growthRate: 0.05,
      terminalGrowthRate: 0.02,
      discountRate: 0.1,
      projectionYears: 5,
    });

    assert.strictEqual(result.success, true);
    const data = result.data!;
    assert.ok(data.intrinsicValue < 10000, "Should be overvalued");
    assert.ok(data.upside < 0, "Upside should be negative");
    assert.ok(
      data.marginOfSafety < 0,
      "MoS should be negative when overvalued"
    );
  });

  it("should have projection array length equal to projectionYears", async () => {
    const years = 7;
    const result = await executeDcf({
      currentPrice: 100,
      freeCashFlow: 1000000,
      sharesOutstanding: 100000,
      projectionYears: years,
    });

    assert.strictEqual(result.success, true);
    assert.strictEqual(result.data!.projections.length, years);
  });

  it("should have projections with year field from 1 to N", async () => {
    const result = await executeDcf({
      currentPrice: 100,
      freeCashFlow: 1000000,
      sharesOutstanding: 100000,
      projectionYears: 5,
    });

    assert.strictEqual(result.success, true);
    const data = result.data!;
    for (let i = 0; i < 5; i++) {
      assert.strictEqual(data.projections[i]!.year, i + 1);
    }
  });

  it("should have increasing projected FCF values when growth > 0", async () => {
    const result = await executeDcf({
      currentPrice: 100,
      freeCashFlow: 1000000,
      sharesOutstanding: 100000,
      growthRate: 0.1,
      projectionYears: 5,
    });

    assert.strictEqual(result.success, true);
    const data = result.data!;
    for (let i = 1; i < data.projections.length; i++) {
      assert.ok(
        data.projections[i]!.fcf > data.projections[i - 1]!.fcf,
        `FCF should increase year over year: year ${i} (${data.projections[i]!.fcf}) <= year ${i - 1} (${data.projections[i - 1]!.fcf})`
      );
    }
  });

  it("should round intrinsicValue to 2 decimal places", async () => {
    const result = await executeDcf({
      currentPrice: 100,
      freeCashFlow: 777777,
      sharesOutstanding: 99999,
      growthRate: 0.11,
      projectionYears: 8,
    });

    assert.strictEqual(result.success, true);
    const data = result.data!;
    const str = data.intrinsicValue.toString();
    const decPart = str.split(".")[1] || "";
    assert.ok(
      decPart.length <= 2,
      `intrinsicValue has more than 2 decimal places: ${data.intrinsicValue}`
    );
  });

  it("should round marginOfSafety to 2 decimal places", async () => {
    const result = await executeDcf({
      currentPrice: 123,
      freeCashFlow: 500000,
      sharesOutstanding: 10000,
    });

    assert.strictEqual(result.success, true);
    const data = result.data!;
    const str = data.marginOfSafety.toString();
    const decPart = str.split(".")[1] || "";
    assert.ok(
      decPart.length <= 2,
      `marginOfSafety has more than 2 decimal places: ${data.marginOfSafety}`
    );
  });

  it("should round upside to 2 decimal places", async () => {
    const result = await executeDcf({
      currentPrice: 123,
      freeCashFlow: 500000,
      sharesOutstanding: 10000,
    });

    assert.strictEqual(result.success, true);
    const data = result.data!;
    const str = data.upside.toString();
    const decPart = str.split(".")[1] || "";
    assert.ok(
      decPart.length <= 2,
      `upside has more than 2 decimal places: ${data.upside}`
    );
  });

  it("honours an explicit 0% growthRate override (MONEY-779: no falsy-coalesce)", async () => {
    const result = await executeDcf({
      currentPrice: 100,
      freeCashFlow: 1000000,
      sharesOutstanding: 100000,
      growthRate: 0,
    });

    assert.strictEqual(result.success, true);
    // 0 is a legitimate conservative override — Number.isFinite keeps it, NOT 0.12.
    assert.strictEqual(result.data!.assumptions.growthRate, 0);
  });

  it("should handle single year projection", async () => {
    const result = await executeDcf({
      currentPrice: 100,
      freeCashFlow: 1000000,
      sharesOutstanding: 100000,
      projectionYears: 1,
    });

    assert.strictEqual(result.success, true);
    const data = result.data!;
    assert.strictEqual(data.projections.length, 1);
    assert.strictEqual(data.projections[0]!.year, 1);
  });

  it("should handle large projection years (30 years)", async () => {
    const result = await executeDcf({
      currentPrice: 100,
      freeCashFlow: 1000000,
      sharesOutstanding: 100000,
      projectionYears: 30,
    });

    assert.strictEqual(result.success, true);
    const data = result.data!;
    assert.strictEqual(data.projections.length, 30);
    assert.ok(
      Number.isFinite(data.intrinsicValue),
      "Intrinsic value should be finite"
    );
  });

  it("should preserve currentPrice in result", async () => {
    const result = await executeDcf({
      currentPrice: 456.78,
      freeCashFlow: 1000000,
      sharesOutstanding: 100000,
    });

    assert.strictEqual(result.success, true);
    assert.strictEqual(result.data!.currentPrice, 456.78);
  });

  it("should preserve FCF in assumptions", async () => {
    const result = await executeDcf({
      currentPrice: 100,
      freeCashFlow: 5000000,
      sharesOutstanding: 100000,
    });

    assert.strictEqual(result.success, true);
    assert.strictEqual(result.data!.assumptions.fcf, 5000000);
  });

  it("should handle all params explicitly set", async () => {
    const result = await executeDcf({
      currentPrice: 200,
      freeCashFlow: 2000000,
      sharesOutstanding: 50000,
      growthRate: 0.15,
      terminalGrowthRate: 0.04,
      discountRate: 0.12,
      projectionYears: 8,
    });

    assert.strictEqual(result.success, true);
    const data = result.data!;
    assert.strictEqual(data.assumptions.growthRate, 0.15);
    assert.strictEqual(data.assumptions.terminalGrowthRate, 0.04);
    assert.strictEqual(data.assumptions.discountRate, 0.12);
    assert.strictEqual(data.assumptions.projectionYears, 8);
    assert.strictEqual(data.currentPrice, 200);
    assert.strictEqual(data.assumptions.fcf, 2000000);
  });

  it("should compute terminal value dominance for long projections", async () => {
    // With low growth and long projection, terminal value makes up a large portion
    const shortResult = await executeDcf({
      currentPrice: 100,
      freeCashFlow: 1000000,
      sharesOutstanding: 100000,
      projectionYears: 3,
    });

    const longResult = await executeDcf({
      currentPrice: 100,
      freeCashFlow: 1000000,
      sharesOutstanding: 100000,
      projectionYears: 20,
    });

    assert.strictEqual(shortResult.success, true);
    assert.strictEqual(longResult.success, true);
    // Longer projections capture more PV => higher intrinsic value
    assert.ok(
      longResult.data!.intrinsicValue > shortResult.data!.intrinsicValue,
      "Longer projections should yield higher intrinsic value"
    );
  });

  it("should compute marginOfSafety as percentage of intrinsic value", async () => {
    const result = await executeDcf({
      currentPrice: 100,
      freeCashFlow: 1000000,
      sharesOutstanding: 100000,
      growthRate: 0.1,
      terminalGrowthRate: 0.03,
      discountRate: 0.1,
      projectionYears: 1,
    });

    assert.strictEqual(result.success, true);
    const data = result.data!;
    // marginOfSafety = ((intrinsic - current) / intrinsic) * 100
    const expected = ((data.intrinsicValue - 100) / data.intrinsicValue) * 100;
    assert.ok(
      Math.abs(data.marginOfSafety - Math.round(expected * 100) / 100) < 0.01,
      `MoS mismatch: expected ${expected}, got ${data.marginOfSafety}`
    );
  });

  it("should compute upside as percentage of current price", async () => {
    const result = await executeDcf({
      currentPrice: 100,
      freeCashFlow: 1000000,
      sharesOutstanding: 100000,
      growthRate: 0.1,
      terminalGrowthRate: 0.03,
      discountRate: 0.1,
      projectionYears: 1,
    });

    assert.strictEqual(result.success, true);
    const data = result.data!;
    // upside = ((intrinsic - current) / current) * 100
    const expected = ((data.intrinsicValue - 100) / 100) * 100;
    assert.ok(
      Math.abs(data.upside - Math.round(expected * 100) / 100) < 0.01,
      `Upside mismatch: expected ${expected}, got ${data.upside}`
    );
  });

  it("should handle negative FCF (still computes but returns error since !fcf with negative is truthy)", async () => {
    // In the source: const fcf = params.freeCashFlow as number; if (!currentPrice || !fcf || !shares)
    // -1000 is truthy, so it should NOT fail the check. Wait: !(-1000) = false, so it passes.
    const result = await executeDcf({
      currentPrice: 100,
      freeCashFlow: -1000000,
      sharesOutstanding: 100000,
    });

    assert.strictEqual(result.success, true);
    const data = result.data!;
    // Negative FCF means negative projections => negative intrinsic value
    assert.ok(
      data.intrinsicValue < 0,
      "Negative FCF should yield negative intrinsic value"
    );
  });

  it("should handle very small FCF", async () => {
    const result = await executeDcf({
      currentPrice: 100,
      freeCashFlow: 1,
      sharesOutstanding: 100000,
    });

    assert.strictEqual(result.success, true);
    const data = result.data!;
    // totalPV ~ 28.68 / 100000 shares ~ 0.000287 => rounds to 0.00
    assert.ok(
      data.intrinsicValue >= 0,
      "Small positive FCF should give non-negative intrinsic value"
    );
    assert.ok(data.intrinsicValue < 100, "Should be overvalued with tiny FCF");
    assert.ok(
      data.upside < 0,
      "Upside should be negative for overvalued stock"
    );
  });

  it("should handle very large FCF", async () => {
    const result = await executeDcf({
      currentPrice: 100,
      freeCashFlow: 1e12,
      sharesOutstanding: 100000,
    });

    assert.strictEqual(result.success, true);
    const data = result.data!;
    assert.ok(Number.isFinite(data.intrinsicValue), "Should be finite");
    assert.ok(data.intrinsicValue > 100, "Should be highly undervalued");
  });

  it("should fail when currentPrice is 0 (falsy)", async () => {
    const result = await executeDcf({
      currentPrice: 0,
      freeCashFlow: 1000000,
      sharesOutstanding: 100000,
    });
    assert.strictEqual(result.success, false);
    assert.ok(result.error?.includes("required"));
  });

  it("should fail when sharesOutstanding is 0 (falsy)", async () => {
    const result = await executeDcf({
      currentPrice: 100,
      freeCashFlow: 1000000,
      sharesOutstanding: 0,
    });
    assert.strictEqual(result.success, false);
    assert.ok(result.error?.includes("required"));
  });

  it("should compute FCF projection correctly: fcf * (1+g)^i", async () => {
    const fcf = 1000000;
    const g = 0.12;
    const result = await executeDcf({
      currentPrice: 100,
      freeCashFlow: fcf,
      sharesOutstanding: 100000,
      growthRate: g,
      projectionYears: 3,
    });

    assert.strictEqual(result.success, true);
    const data = result.data!;
    assert.strictEqual(
      data.projections[0]!.fcf,
      Math.round(fcf * Math.pow(1 + g, 1))
    );
    assert.strictEqual(
      data.projections[1]!.fcf,
      Math.round(fcf * Math.pow(1 + g, 2))
    );
    assert.strictEqual(
      data.projections[2]!.fcf,
      Math.round(fcf * Math.pow(1 + g, 3))
    );
  });

  it("should compute discounted FCF correctly: projectedFcf / (1+r)^i", async () => {
    const fcf = 1000000;
    const g = 0.12;
    const r = 0.1;
    const result = await executeDcf({
      currentPrice: 100,
      freeCashFlow: fcf,
      sharesOutstanding: 100000,
      growthRate: g,
      discountRate: r,
      projectionYears: 3,
    });

    assert.strictEqual(result.success, true);
    const data = result.data!;
    for (let i = 0; i < 3; i++) {
      const proj = fcf * Math.pow(1 + g, i + 1);
      const disc = proj / Math.pow(1 + r, i + 1);
      assert.strictEqual(data.projections[i]!.discountedFcf, Math.round(disc));
    }
  });

  it("should handle wide gap between discount and terminal rate", async () => {
    const result = await executeDcf({
      currentPrice: 100,
      freeCashFlow: 1000000,
      sharesOutstanding: 100000,
      discountRate: 0.2,
      terminalGrowthRate: 0.02,
    });

    assert.strictEqual(result.success, true);
    const data = result.data!;
    assert.ok(Number.isFinite(data.intrinsicValue), "Should be finite");
  });

  it("should handle narrow gap between discount and terminal rate", async () => {
    const result = await executeDcf({
      currentPrice: 100,
      freeCashFlow: 1000000,
      sharesOutstanding: 100000,
      discountRate: 0.05,
      terminalGrowthRate: 0.04,
    });

    assert.strictEqual(result.success, true);
    const data = result.data!;
    assert.ok(Number.isFinite(data.intrinsicValue), "Should be finite");
    // Narrow gap => large terminal value => high intrinsic value
    assert.ok(
      data.intrinsicValue > 100,
      "Narrow gap should inflate intrinsic value"
    );
  });

  it("falls back to the default for projectionYears = 0 (no valid 0-year DCF; MONEY-779)", async () => {
    const result = await executeDcf({
      currentPrice: 100,
      freeCashFlow: 1000000,
      sharesOutstanding: 100000,
      projectionYears: 0,
    });

    assert.strictEqual(result.success, true);
    // Unlike growthRate/WACC, 0 is NOT a valid years override (degenerate DCF) →
    // the >0 guard keeps the documented default of 10.
    assert.strictEqual(result.data!.assumptions.projectionYears, 10);
    assert.strictEqual(result.data!.projections.length, 10);
  });
});

// ────────────────────────────────────────────────────────────────
//  9. Cross-function integration / monkey tests
// ────────────────────────────────────────────────────────────────

describe("Cross-function integration and edge cases", () => {
  it("CAGR and consistency agree on direction for monotonic increase (via tool)", async () => {
    const values = [100, 110, 121, 133, 146];
    const cagr = await cagrViaTool(
      values[0]!,
      values[values.length - 1]!,
      values.length - 1
    );
    const consistency = await consistencyViaTool(values);
    assert.ok(cagr > 0, "CAGR should be positive for increasing values");
    assert.strictEqual(
      consistency,
      1,
      "Consistency should be 1 for strictly increasing"
    );
  });

  it("CAGR and consistency agree on direction for monotonic decrease (via tool)", async () => {
    const values = [146, 133, 121, 110, 100];
    const cagr = await cagrViaTool(
      values[0]!,
      values[values.length - 1]!,
      values.length - 1
    );
    const consistency = await consistencyViaTool(values);
    assert.ok(cagr < 0, "CAGR should be negative for decreasing values");
    assert.strictEqual(
      consistency,
      0,
      "Consistency should be 0 for strictly decreasing"
    );
  });

  it("marginTrend and consistency can give different signals for volatile data (via tool)", async () => {
    // Margins improving overall but revenues volatile.
    const trend = await marginTrendViaTool([0.1, 0.12, 0.11, 0.14, 0.13, 0.16]);
    const consistency = await consistencyViaTool([100, 90, 110, 95, 115, 100]);
    // Margins: +0.02(i), -0.01(d), +0.03(i), -0.01(d), +0.03(i) => 3i, 2d => improving
    assert.strictEqual(trend, "improving");
    // Revenues: down, up, down, up, down => 2/5 = 0.4
    assert.strictEqual(consistency, 0.4);
  });

  it("health score with extreme values stays in 0-100 range", async () => {
    const result = await executeHealthScore({
      roe: 10.0, // extremely high
      netMargin: 5.0,
      operatingMargin: 8.0,
      debtToEquity: 0.0,
      currentRatio: 50.0,
      roa: 2.0,
      revenueGrowth: 3.0,
      earningsGrowth: 5.0,
    });

    assert.strictEqual(result.success, true);
    const data = result.data!;
    assert.ok(data.overall >= 0, "Overall >= 0");
    assert.ok(data.overall <= 100, "Overall <= 100");
  });

  it("DCF with growth metrics: high growth company should have high intrinsic value", async () => {
    // Simulate: company growing revenue at 20% CAGR
    const statements: FinancialStatement[] = [
      {
        period: "FY2020",
        revenue: 1000000,
        netIncome: 100000,
        operatingIncome: 150000,
      },
      {
        period: "FY2021",
        revenue: 1200000,
        netIncome: 130000,
        operatingIncome: 190000,
      },
      {
        period: "FY2022",
        revenue: 1440000,
        netIncome: 165000,
        operatingIncome: 235000,
      },
      {
        period: "FY2023",
        revenue: 1728000,
        netIncome: 210000,
        operatingIncome: 290000,
      },
    ];

    const growthResult = await executeGrowthMetrics({ statements });
    assert.strictEqual(growthResult.success, true);
    assert.ok(
      growthResult.data!.revenueCAGR > 0.19,
      "Revenue CAGR should be ~20%"
    );

    // Use that growth rate for DCF
    const dcfResult = await executeDcf({
      currentPrice: 100,
      freeCashFlow: 210000,
      sharesOutstanding: 10000,
      growthRate: growthResult.data!.revenueCAGR,
      projectionYears: 10,
    });

    assert.strictEqual(dcfResult.success, true);
    assert.ok(
      dcfResult.data!.intrinsicValue > 100,
      "High growth company should be undervalued at 100"
    );
  });

  // NOTE: scoreMetric with a ZERO benchmark (→ ratio Infinity) is unreachable
  // through the public tool: every health-score benchmark is a positive constant
  // (or a positive sector value), so the x/0 path can't be triggered via the tool.
  // The reachable higherIsBetter=false scoring is covered in the scoreMetric
  // (via D/E detail) block above. Original raw-helper test dropped (no seam).

  it("growth metrics with single revenue but multiple netIncome", async () => {
    const result = await executeGrowthMetrics({
      statements: [
        { period: "FY2022", revenue: 1000, netIncome: 50 },
        { period: "FY2023", netIncome: 80 },
      ],
    });

    assert.strictEqual(result.success, true);
    // Only one revenue value (second is undefined/filtered out)
    // revenues.length < 2, so revenueCAGR = 0
    assert.strictEqual(result.data!.revenueCAGR, 0);
    // profits = [50, 80], profitCAGR = CAGR(50, 80, 1) = 0.6
    assert.strictEqual(result.data!.profitCAGR, 0.6);
  });

  // NOTE: clamp(value, min, max) with min > max is a pure-arithmetic quirk that
  // the health-score tool never invokes (it always calls clamp(overall, 0, 100)
  // with min < max). There is no observable tool surface for the min>max branch,
  // so this raw-helper test is dropped rather than kept as an un-anchored copy.

  it("DCF projections have rounded integer FCF values", async () => {
    const result = await executeDcf({
      currentPrice: 100,
      freeCashFlow: 999999,
      sharesOutstanding: 100000,
      projectionYears: 5,
    });

    assert.strictEqual(result.success, true);
    for (const proj of result.data!.projections) {
      assert.strictEqual(
        proj.fcf,
        Math.round(proj.fcf),
        `FCF year ${proj.year} not rounded`
      );
      assert.strictEqual(
        proj.discountedFcf,
        Math.round(proj.discountedFcf),
        `Discounted FCF year ${proj.year} not rounded`
      );
    }
  });

  it("growthConsistency stays within [0,1] for any revenue series (via tool)", async () => {
    const testCases = [
      [1, 2, 3, 2, 1, 5, 3, 7],
      [100, 100, 100],
      [10, 5, 1], // all-decreasing (avoid all-zero: revenue 0 is filtered out)
      [5, 3, 1, 2, 10],
      [1e10, 1e9, 1e11, 1e8],
    ];

    for (const revenues of testCases) {
      const result = await consistencyViaTool(revenues);
      assert.ok(
        Number.isFinite(result) && result >= 0 && result <= 1,
        `growthConsistency ${result} out of range for ${revenues}`
      );
    }
  });

  it("assessMarginTrend handles a long alternating sequence", async () => {
    // 0.10, 0.12, 0.10, 0.12, 0.10, 0.12, 0.10
    // diffs: +0.02(i), -0.02(d), +0.02(i), -0.02(d), +0.02(i), -0.02(d) => 3i, 3d => stable
    const trend = await marginTrendViaTool([
      0.1, 0.12, 0.1, 0.12, 0.1, 0.12, 0.1,
    ]);
    assert.strictEqual(trend, "stable");
  });
});
