/**
 * Constituent Analysis Tool + enhanced MF-Analysis skill plan-shape tests.
 * (packages/research/src/tools/compute-constituent-analysis.ts
 *  + packages/research/src/skills/mf-analysis.ts — MONEY-446 Part C)
 *
 * The tool is a PURE compute tool — no network/db/io, fully deterministic — so
 * every value is hand-checkable.
 *
 * Coverage:
 *   Tool:
 *     - metadata wiring (name / category / execute / required holdings param)
 *     - known-value: top-N selection, weight rank, concentration tiers, sector
 *       weight + share math, sector grouping, analysedWeightPct
 *     - topN clamping (default, hard cap, floor, non-numeric)
 *     - defensive parse: {percentage} vs {weight}, {name} vs {symbol},
 *       bare array vs { holdings } wrapper, duplicate keys summed
 *     - graceful degradation: no/garbage holdings -> available:false
 *     - SEBI-safety: reads + observations carry no buy/sell/hold/winner words
 *   Skill:
 *     - comprehensive depth -> top-5 constituents task wired into synthesis
 *     - advanced depth -> top-8 constituents task
 *     - moderate depth -> NO constituents task (lighter run)
 *     - default (no depth) -> comprehensive (constituents present)
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { computeConstituentAnalysisTool } from "../../../../packages/research/src/tools/compute-constituent-analysis";
import { mfAnalysisSkill } from "../../../../packages/research/src/skills/mf-analysis";

// ── Result shape (mirrors ConstituentAnalysisResult) ─────────────────
interface AnalysedConstituent {
  key: string;
  name: string;
  sector: string | null;
  params: {
    portfolioWeight: number;
    weightRank: number;
    concentrationTier: "mega" | "large" | "mid" | "small";
    sectorWeight: number | null;
    sectorShare: number | null;
  };
  read: string;
}
interface ConstituentSectorGroup {
  sector: string;
  weight: number;
  constituents: string[];
}
interface ConstituentAnalysisResult {
  available: boolean;
  reason?: string;
  totalHoldings: number;
  analysedCount: number;
  topN: number;
  constituents: AnalysedConstituent[];
  sectorGroups: ConstituentSectorGroup[];
  analysedWeightPct: number;
  observations: string[];
}

async function run(args: Record<string, unknown>) {
  return computeConstituentAnalysisTool.execute(args);
}
function asData(r: {
  success: boolean;
  data?: unknown;
}): ConstituentAnalysisResult {
  assert.ok(r.data, "expected data on tool output");
  return r.data as ConstituentAnalysisResult;
}
const EPS = 1e-9;
const SEBI_BANNED = /\b(buy|sell|hold|winner|best|target\s*price)\b/i;

// ── 1. Metadata wiring ────────────────────────────────────────────────
test("tool is wired with name + category + execute + required holdings param", () => {
  assert.equal(
    computeConstituentAnalysisTool.name,
    "compute_constituent_analysis"
  );
  assert.equal(computeConstituentAnalysisTool.category, "computation");
  assert.equal(typeof computeConstituentAnalysisTool.execute, "function");
  assert.equal(
    computeConstituentAnalysisTool.parameters.holdings?.required,
    true
  );
});

// ── 2. Known-value math ───────────────────────────────────────────────
//
// Holdings (weights as % of fund):
//   HDFCBANK 10  (Financials)
//   ICICIBANK 6  (Financials)
//   RELIANCE 5   (Energy)
//   INFY 3       (IT)
//   TCS 1.5      (IT)
//   ITC 0.5      (FMCG)   <- outside top-5
//
// fundTotalWeight = 26
// Sector totals (whole fund): Financials 16, IT 4.5, Energy 5, FMCG 0.5
//
// topN = 5 -> analysed: HDFCBANK, ICICIBANK, RELIANCE, INFY, TCS
//   ranks 1..5; tiers: 10->mega, 6->large, 5->large, 3->mid, 1.5->small
//   analysedWeightPct = 10+6+5+3+1.5 = 25.5
//
// HDFCBANK: sectorWeight = Financials 16, sectorShare = 10/16 = 62.5
// ICICIBANK: sectorShare = 6/16 = 37.5
// INFY: sectorWeight = IT 4.5, sectorShare = 3/4.5 = 66.7
// TCS: sectorShare = 1.5/4.5 = 33.3
//
// sectorGroups (analysed only): Financials 16, Energy 5, IT 4.5
test("known-value: top-N selection, ranks, tiers, sector math, grouping", async () => {
  const r = await run({
    topN: 5,
    holdings: [
      { symbol: "HDFCBANK", weight: 10, sector: "Financials" },
      { symbol: "ICICIBANK", weight: 6, sector: "Financials" },
      { symbol: "RELIANCE", weight: 5, sector: "Energy" },
      { symbol: "INFY", weight: 3, sector: "IT" },
      { symbol: "TCS", weight: 1.5, sector: "IT" },
      { symbol: "ITC", weight: 0.5, sector: "FMCG" },
    ],
  });

  assert.equal(r.success, true);
  const data = asData(r);
  assert.equal(data.available, true);
  assert.equal(data.totalHoldings, 6);
  assert.equal(data.analysedCount, 5);
  assert.equal(data.topN, 5);

  // Ranking + tiers
  assert.deepEqual(
    data.constituents.map((c) => c.key),
    ["HDFCBANK", "ICICIBANK", "RELIANCE", "INFY", "TCS"]
  );
  assert.deepEqual(
    data.constituents.map((c) => c.params.weightRank),
    [1, 2, 3, 4, 5]
  );
  assert.deepEqual(
    data.constituents.map((c) => c.params.concentrationTier),
    ["mega", "large", "large", "mid", "small"]
  );

  // analysedWeightPct
  assert.ok(Math.abs(data.analysedWeightPct - 25.5) < EPS);

  // Sector weight + share
  const hdfc = data.constituents.find((c) => c.key === "HDFCBANK")!;
  assert.ok(Math.abs(hdfc.params.sectorWeight! - 16) < EPS);
  assert.ok(Math.abs(hdfc.params.sectorShare! - 62.5) < EPS);
  const icici = data.constituents.find((c) => c.key === "ICICIBANK")!;
  assert.ok(Math.abs(icici.params.sectorShare! - 37.5) < EPS);
  const infy = data.constituents.find((c) => c.key === "INFY")!;
  assert.ok(Math.abs(infy.params.sectorWeight! - 4.5) < EPS);
  assert.ok(Math.abs(infy.params.sectorShare! - 66.7) < EPS); // 3/4.5 round1
  const tcs = data.constituents.find((c) => c.key === "TCS")!;
  assert.ok(Math.abs(tcs.params.sectorShare! - 33.3) < EPS);

  // Sector grouping (analysed-only), weight desc
  assert.deepEqual(
    data.sectorGroups.map((g) => g.sector),
    ["Financials", "Energy", "IT"]
  );
  const fin = data.sectorGroups.find((g) => g.sector === "Financials")!;
  assert.ok(Math.abs(fin.weight - 16) < EPS);
  assert.deepEqual(fin.constituents, ["HDFCBANK", "ICICIBANK"]);

  // Each constituent has a one-line read mentioning its name + weight
  for (const c of data.constituents) {
    assert.ok(c.read.includes(c.name), `read should mention ${c.name}`);
    assert.ok(
      c.read.includes(`${c.params.portfolioWeight}%`),
      "read should mention the portfolio weight"
    );
  }

  // SEBI-safety: no banned words anywhere
  for (const c of data.constituents) {
    assert.ok(!SEBI_BANNED.test(c.read), `read must be SEBI-safe: ${c.read}`);
  }
  for (const o of data.observations) {
    assert.ok(!SEBI_BANNED.test(o), `observation must be SEBI-safe: ${o}`);
  }
});

// ── 3. Observations: concentration + sector tilt ─────────────────────
test("observations flag a notable single-name concentration and sector tilt", async () => {
  const r = await run({
    topN: 5,
    holdings: [
      { symbol: "HDFCBANK", weight: 12, sector: "Financials" },
      { symbol: "ICICIBANK", weight: 11, sector: "Financials" },
      { symbol: "SBIN", weight: 10, sector: "Financials" },
      { symbol: "RELIANCE", weight: 4, sector: "Energy" },
    ],
  });
  const data = asData(r);
  assert.equal(data.available, true);

  // Top-N concentration line is always present
  assert.ok(
    data.observations.some((o) => /Top \d+ constituents account for/.test(o))
  );
  // 12% largest single name >= 8% threshold -> concentration note
  assert.ok(
    data.observations.some((o) =>
      /HDFCBANK is the largest single-name exposure/.test(o)
    )
  );
  // Financials 33/37 ~ 89% of fund (>= 30%) -> sector tilt note
  assert.ok(data.observations.some((o) => /tilts toward Financials/.test(o)));
});

// ── 4. topN clamping ──────────────────────────────────────────────────
test("topN clamps: default 5, hard cap 12, floor 1, non-numeric -> default", async () => {
  const many = Array.from({ length: 20 }, (_, i) => ({
    symbol: `S${i}`,
    weight: 20 - i, // strictly descending so ranking is unambiguous
  }));

  // default (no topN) -> 5
  const d = asData(await run({ holdings: many }));
  assert.equal(d.topN, 5);
  assert.equal(d.analysedCount, 5);

  // hard cap: ask for 50 -> 12
  const cap = asData(await run({ holdings: many, topN: 50 }));
  assert.equal(cap.topN, 12);
  assert.equal(cap.analysedCount, 12);

  // floor: ask for 0 -> 1
  const floor = asData(await run({ holdings: many, topN: 0 }));
  assert.equal(floor.topN, 1);
  assert.equal(floor.analysedCount, 1);

  // non-numeric -> default 5
  const bad = asData(await run({ holdings: many, topN: "lots" }));
  assert.equal(bad.topN, 5);
});

// ── 5. Fewer holdings than topN ──────────────────────────────────────
test("analyses all holdings when fewer than topN, with a note", async () => {
  const r = await run({
    topN: 8,
    holdings: [
      { symbol: "A", weight: 5 },
      { symbol: "B", weight: 3 },
    ],
  });
  const data = asData(r);
  assert.equal(data.available, true);
  assert.equal(data.analysedCount, 2);
  assert.ok(
    data.observations.some((o) => /carried only 2 constituent/.test(o))
  );
});

// ── 6. Defensive parsing ──────────────────────────────────────────────
test("defensive parse: {percentage}/{name} aliases, bare array, dup keys summed", async () => {
  // bare array (Tickertape MfHolding[] shape) with {name}+{percentage}, plus a
  // duplicate key that must be summed.
  const r = await run({
    holdings: [
      { name: "HDFC Bank", percentage: 10, sector: "Financials" },
      { name: "HDFC Bank", percentage: 5, sector: "Financials" }, // dup -> summed
      { name: "Infosys", percentage: 4, sector: "IT" },
    ],
  });
  const data = asData(r);
  assert.equal(data.available, true);
  assert.equal(data.totalHoldings, 2); // HDFC BANK (summed) + INFOSYS
  const hdfc = data.constituents.find((c) => c.key === "HDFC BANK")!;
  assert.ok(Math.abs(hdfc.params.portfolioWeight - 15) < EPS);
  assert.equal(hdfc.params.weightRank, 1);
});

test("defensive parse: { holdings } wrapper is unwrapped (executor-injected shape)", async () => {
  // The executor's `whole` binding hands fetch_mf_holdings through as a bare
  // array, but a { holdings } wrapper must also be accepted.
  const r = await run({
    holdings: { holdings: [{ symbol: "TCS", weight: 7, sector: "IT" }] },
  });
  const data = asData(r);
  assert.equal(data.available, true);
  assert.equal(data.totalHoldings, 1);
  assert.equal(data.constituents[0]!.key, "TCS");
});

// ── 7. Graceful degradation ───────────────────────────────────────────
test("no holdings param -> available:false (graceful, success:true)", async () => {
  const r = await run({});
  assert.equal(r.success, true);
  const data = asData(r);
  assert.equal(data.available, false);
  assert.equal(data.reason, "no parseable holdings to analyse");
  assert.equal(data.totalHoldings, 0);
  assert.deepEqual(data.constituents, []);
});

test("garbage holdings -> available:false", async () => {
  const r = await run({
    holdings: [null, "nope", { weight: 5 } /* no key */, {}],
  });
  assert.equal(r.success, true);
  const data = asData(r);
  assert.equal(data.available, false);
  assert.equal(data.totalHoldings, 0);
});

test("empty holdings array -> available:false", async () => {
  const data = asData(await run({ holdings: [] }));
  assert.equal(data.available, false);
});

// ── 8. Holdings with no sector still analyse (sector fields null) ─────
test("sector-less holdings analyse with null sector fields and 'Unclassified' group", async () => {
  const r = await run({
    holdings: [
      { symbol: "AAA", weight: 9 },
      { symbol: "BBB", weight: 4 },
    ],
  });
  const data = asData(r);
  assert.equal(data.available, true);
  const aaa = data.constituents[0]!;
  assert.equal(aaa.sector, null);
  assert.equal(aaa.params.sectorWeight, null);
  assert.equal(aaa.params.sectorShare, null);
  assert.deepEqual(
    data.sectorGroups.map((g) => g.sector),
    ["Unclassified"]
  );
});

// ── 9. Enhanced MF-analysis skill plan-shape ─────────────────────────
test("skill: comprehensive depth wires a top-5 constituents task into synthesis", () => {
  const plan = mfAnalysisSkill.buildPlan({
    symbol: "120503",
    depth: "comprehensive",
  });

  assert.equal(plan.skill, "mf-analysis");
  assert.equal(plan.complexity, "complex");
  assert.equal(plan.estimatedSteps, plan.tasks.length);

  const constituents = plan.tasks.find((t) => t.id === "constituents");
  assert.ok(constituents, "plan should contain a 'constituents' task");
  assert.equal(constituents.tool, "compute_constituent_analysis");
  assert.equal(constituents.type, "computation");
  assert.deepEqual(
    constituents.dependsOn,
    ["mf_holdings"],
    "constituents should depend on mf_holdings"
  );
  assert.equal((constituents.params as { topN?: number }).topN, 5);

  // synthesis depends on the constituents task (so it folds into the report)
  const report = plan.tasks[plan.tasks.length - 1]!;
  assert.equal(report.tool, "synthesize_report");
  assert.ok(
    report.dependsOn.includes("constituents"),
    "synthesize_report should depend on the constituents task"
  );
  // queryType still routes to the MF synthesizer schema
  assert.equal((report.params as { queryType?: string }).queryType, "mf");
});

test("skill: advanced depth raises the constituent cap to 8", () => {
  const plan = mfAnalysisSkill.buildPlan({
    symbol: "120503",
    depth: "advanced",
  });
  const constituents = plan.tasks.find((t) => t.id === "constituents")!;
  assert.ok(constituents);
  assert.equal((constituents.params as { topN?: number }).topN, 8);
});

test("skill: default (no depth) defaults to comprehensive -> constituents present", () => {
  const plan = mfAnalysisSkill.buildPlan({ symbol: "120503" });
  const constituents = plan.tasks.find((t) => t.id === "constituents");
  assert.ok(constituents, "default depth should include constituents");
  assert.equal((constituents!.params as { topN?: number }).topN, 5);
});

test("skill: moderate depth omits the constituents task (lighter run)", () => {
  const plan = mfAnalysisSkill.buildPlan({
    symbol: "120503",
    depth: "moderate",
  });
  assert.equal(
    plan.tasks.find((t) => t.id === "constituents"),
    undefined,
    "moderate depth should NOT include a constituents task"
  );
  assert.equal(plan.complexity, "moderate");
  // synthesis should NOT depend on constituents
  const report = plan.tasks[plan.tasks.length - 1]!;
  assert.ok(!report.dependsOn.includes("constituents"));
});

test("skill: ETF symbol still detected with constituents enabled", () => {
  // ETF detection matches a standalone "BEES" / "ETF" token (word-boundaried).
  const plan = mfAnalysisSkill.buildPlan({ symbol: "NIFTY BEES" });
  const report = plan.tasks[plan.tasks.length - 1]!;
  assert.equal((report.params as { queryType?: string }).queryType, "etf");
  assert.ok(plan.tasks.find((t) => t.id === "constituents"));
});
