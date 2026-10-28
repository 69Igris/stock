/**
 * Holdings Overlap Tool Tests
 * (packages/research/src/tools/compute-holdings-overlap.ts)
 *
 * PURE compute tool — no network/db/io, fully deterministic.
 *
 * Coverage:
 *   - Tool metadata wiring (name / category / execute)
 *   - 2 funds with a KNOWN overlap: hand-computed common set, Jaccard, and
 *     weight-overlap (sum of min(weightA, weightB) over shared keys)
 *   - 3 funds: common across >=2, per-fund counts, pairwise pair count
 *   - distinct-only (0 common): every key unique → empty common set
 *   - single fund → available:false ("need >=2 funds with holdings")
 *   - empty funds → available:false
 *   - defensive parse of {percentage} vs {weight} and {name} vs {symbol}
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { computeHoldingsOverlapTool } from "../../../../packages/research/src/tools/compute-holdings-overlap";

// ── Shape of result.data (mirrors HoldingsOverlapResult) ─────────────
interface CommonStock {
  key: string;
  name: string;
  sector: string | null;
  fundCount: number;
  perFund: Array<{ fundId: string; weight: number }>;
  aggregateWeight: number;
  avgWeight: number;
  minWeight: number;
  maxWeight: number;
  weightDispersion: number;
}
interface DistinctFundStocks {
  fundId: string;
  holdings: Array<{
    key: string;
    name: string;
    weight: number;
    sector: string | null;
  }>;
}
interface PairwiseOverlap {
  fundA: string;
  fundB: string;
  sharedCount: number;
  jaccard: number;
  weightOverlapPct: number;
}
interface HoldingsOverlapResult {
  available: boolean;
  reason?: string;
  fundCount: number;
  fundIds: string[];
  common: CommonStock[];
  commonStockCount: number;
  distinct: DistinctFundStocks[];
  pairwise: PairwiseOverlap[];
  overallOverlapPct: number;
  commonWeightShareByFund: Array<{ fundId: string; sharePct: number }>;
  flags: string[];
}

async function run(args: Record<string, unknown>) {
  return computeHoldingsOverlapTool.execute(args);
}

function asData(r: {
  success: boolean;
  data?: unknown;
}): HoldingsOverlapResult {
  assert.ok(r.data, "expected data on tool output");
  return r.data as HoldingsOverlapResult;
}

const EPS = 1e-9;

// ── 1. Tool metadata sanity ──────────────────────────────────────────
test("tool is wired with name + category + execute", () => {
  assert.equal(computeHoldingsOverlapTool.name, "compute_holdings_overlap");
  assert.equal(computeHoldingsOverlapTool.category, "computation");
  assert.equal(typeof computeHoldingsOverlapTool.execute, "function");
  assert.equal(computeHoldingsOverlapTool.parameters.funds?.required, true);
});

// ── 2. KNOWN-VALUE: 2 funds with a known overlap ─────────────────────
//
// Fund A: HDFCBANK 30, RELIANCE 25, INFY 15      (keys: HDFCBANK,RELIANCE,INFY)
// Fund B: HDFCBANK 20, RELIANCE 10, TCS 12       (keys: HDFCBANK,RELIANCE,TCS)
//
// Shared keys = {HDFCBANK, RELIANCE}  -> sharedCount = 2
// Union keys  = {HDFCBANK,RELIANCE,INFY,TCS} = 4
// Jaccard     = 2/4 = 50%
// weightOverlap = min(30,20) + min(25,10) = 20 + 10 = 30
//
// COMMON set:
//   HDFCBANK: agg 30+20=50, avg 25, min 20, max 30, dispersion 10, fundCount 2
//   RELIANCE: agg 25+10=35, avg 17.5, min 10, max 25, dispersion 15, fundCount 2
//   -> sorted by aggregateWeight desc: HDFCBANK (50) then RELIANCE (35)
//
// DISTINCT:
//   A -> INFY (15);  B -> TCS (12)
//
// commonWeightShareByFund:
//   A total = 70, common = 30+25 = 55 -> 78.6%
//   B total = 42, common = 20+10 = 30 -> 71.4%
test("known-value: 2 funds, common set + jaccard + weight-overlap math", async () => {
  const r = await run({
    funds: [
      {
        id: "FUND_A",
        name: "Alpha Bluechip",
        holdings: [
          { symbol: "HDFCBANK", weight: 30, sector: "Financials" },
          { symbol: "RELIANCE", weight: 25, sector: "Energy" },
          { symbol: "INFY", weight: 15, sector: "IT" },
        ],
      },
      {
        id: "FUND_B",
        name: "Beta Largecap",
        holdings: [
          { symbol: "HDFCBANK", weight: 20, sector: "Financials" },
          { symbol: "RELIANCE", weight: 10, sector: "Energy" },
          { symbol: "TCS", weight: 12, sector: "IT" },
        ],
      },
    ],
  });

  assert.equal(r.success, true);
  const data = asData(r);

  assert.equal(data.available, true);
  assert.equal(data.fundCount, 2);
  assert.deepEqual(data.fundIds, ["FUND_A", "FUND_B"]);

  // COMMON set: 2 names, sorted by aggregateWeight desc
  assert.equal(data.commonStockCount, 2);
  assert.equal(data.common.length, 2);

  const hdfc = data.common[0]!; // largest aggregate
  assert.equal(hdfc.key, "HDFCBANK");
  assert.equal(hdfc.fundCount, 2);
  assert.ok(Math.abs(hdfc.aggregateWeight - 50) < EPS);
  assert.ok(Math.abs(hdfc.avgWeight - 25) < EPS);
  assert.ok(Math.abs(hdfc.minWeight - 20) < EPS);
  assert.ok(Math.abs(hdfc.maxWeight - 30) < EPS);
  assert.ok(Math.abs(hdfc.weightDispersion - 10) < EPS);
  assert.equal(hdfc.sector, "Financials");
  assert.deepEqual(hdfc.perFund, [
    { fundId: "FUND_A", weight: 30 },
    { fundId: "FUND_B", weight: 20 },
  ]);

  const rel = data.common[1]!;
  assert.equal(rel.key, "RELIANCE");
  assert.ok(Math.abs(rel.aggregateWeight - 35) < EPS);
  assert.ok(Math.abs(rel.avgWeight - 17.5) < EPS);
  assert.ok(Math.abs(rel.minWeight - 10) < EPS);
  assert.ok(Math.abs(rel.maxWeight - 25) < EPS);
  assert.ok(Math.abs(rel.weightDispersion - 15) < EPS);

  // DISTINCT: INFY only in A, TCS only in B
  const distA = data.distinct.find((d) => d.fundId === "FUND_A")!;
  const distB = data.distinct.find((d) => d.fundId === "FUND_B")!;
  assert.deepEqual(
    distA.holdings.map((h) => h.key),
    ["INFY"]
  );
  assert.deepEqual(
    distB.holdings.map((h) => h.key),
    ["TCS"]
  );

  // PAIRWISE: exactly one pair
  assert.equal(data.pairwise.length, 1);
  const pair = data.pairwise[0]!;
  assert.equal(pair.fundA, "FUND_A");
  assert.equal(pair.fundB, "FUND_B");
  assert.equal(pair.sharedCount, 2);
  // Jaccard = 2/4 = 50%
  assert.ok(Math.abs(pair.jaccard - 50) < EPS);
  // weightOverlap = min(30,20)+min(25,10) = 20+10 = 30
  assert.ok(Math.abs(pair.weightOverlapPct - 30) < EPS);

  // overall = avg of single pair = 30
  assert.ok(Math.abs(data.overallOverlapPct - 30) < EPS);

  // per-fund common-weight share
  const shareA = data.commonWeightShareByFund.find(
    (s) => s.fundId === "FUND_A"
  )!;
  const shareB = data.commonWeightShareByFund.find(
    (s) => s.fundId === "FUND_B"
  )!;
  // A: 55/70 = 78.57 -> round1 78.6
  assert.ok(Math.abs(shareA.sharePct - 78.6) < EPS);
  // B: 30/42 = 71.43 -> round1 71.4
  assert.ok(Math.abs(shareB.sharePct - 71.4) < EPS);

  // FLAGS (SEBI-safe): 50% jaccard hits the diversification flag; no winner
  assert.ok(
    data.flags.some((f) => /50% identical/.test(f)),
    "expected a high-overlap diversification flag"
  );
  for (const f of data.flags) {
    assert.ok(
      !/\b(buy|sell|hold|winner|best)\b/i.test(f),
      `flag must be SEBI-safe, got: ${f}`
    );
  }
});

// ── 3. 3 funds ───────────────────────────────────────────────────────
//
// A: X 40, Y 30          B: X 35, Z 25          C: X 20, Y 10, W 5
// key fund-counts: X=3, Y=2, W=1, Z=1
// COMMON (>=2): X (agg 40+35+20=95, fundCount 3), Y (agg 30+10=40, fundCount 2)
// DISTINCT: A none, B -> Z, C -> W
// PAIRWISE pairs = C(3,2) = 3
test("3 funds: common across >=2, distinct sleeves, 3 pairs", async () => {
  const r = await run({
    funds: [
      {
        id: "A",
        holdings: [
          { symbol: "X", weight: 40 },
          { symbol: "Y", weight: 30 },
        ],
      },
      {
        id: "B",
        holdings: [
          { symbol: "X", weight: 35 },
          { symbol: "Z", weight: 25 },
        ],
      },
      {
        id: "C",
        holdings: [
          { symbol: "X", weight: 20 },
          { symbol: "Y", weight: 10 },
          { symbol: "W", weight: 5 },
        ],
      },
    ],
  });

  assert.equal(r.success, true);
  const data = asData(r);
  assert.equal(data.available, true);
  assert.equal(data.fundCount, 3);

  // COMMON: X (held by 3) then Y (held by 2), sorted by aggregate desc
  assert.equal(data.commonStockCount, 2);
  const x = data.common[0]!;
  assert.equal(x.key, "X");
  assert.equal(x.fundCount, 3);
  assert.ok(Math.abs(x.aggregateWeight - 95) < EPS);
  assert.equal(x.perFund.length, 3);
  const y = data.common[1]!;
  assert.equal(y.key, "Y");
  assert.equal(y.fundCount, 2);
  assert.ok(Math.abs(y.aggregateWeight - 40) < EPS);

  // DISTINCT
  assert.deepEqual(
    data.distinct.find((d) => d.fundId === "A")!.holdings.map((h) => h.key),
    []
  );
  assert.deepEqual(
    data.distinct.find((d) => d.fundId === "B")!.holdings.map((h) => h.key),
    ["Z"]
  );
  assert.deepEqual(
    data.distinct.find((d) => d.fundId === "C")!.holdings.map((h) => h.key),
    ["W"]
  );

  // PAIRWISE: 3 pairs (A-B, A-C, B-C)
  assert.equal(data.pairwise.length, 3);
  const ab = data.pairwise.find((p) => p.fundA === "A" && p.fundB === "B")!;
  // A∩B = {X}, A∪B = {X,Y,Z} -> jaccard 1/3 = 33.3; overlap min(40,35)=35
  assert.equal(ab.sharedCount, 1);
  assert.ok(Math.abs(ab.jaccard - 33.3) < EPS);
  assert.ok(Math.abs(ab.weightOverlapPct - 35) < EPS);

  const ac = data.pairwise.find((p) => p.fundA === "A" && p.fundB === "C")!;
  // A∩C = {X,Y}, A∪C = {X,Y,W} -> jaccard 2/3 = 66.7; overlap min(40,20)+min(30,10)=20+10=30
  assert.equal(ac.sharedCount, 2);
  assert.ok(Math.abs(ac.jaccard - 66.7) < EPS);
  assert.ok(Math.abs(ac.weightOverlapPct - 30) < EPS);
});

// ── 4. distinct-only: 0 common ───────────────────────────────────────
test("distinct-only funds produce an empty common set", async () => {
  const r = await run({
    funds: [
      { id: "A", holdings: [{ symbol: "AAA", weight: 50 }] },
      { id: "B", holdings: [{ symbol: "BBB", weight: 50 }] },
    ],
  });
  assert.equal(r.success, true);
  const data = asData(r);
  assert.equal(data.available, true);
  assert.equal(data.commonStockCount, 0);
  assert.deepEqual(data.common, []);

  // every key is unique to its fund
  assert.deepEqual(
    data.distinct.find((d) => d.fundId === "A")!.holdings.map((h) => h.key),
    ["AAA"]
  );
  assert.deepEqual(
    data.distinct.find((d) => d.fundId === "B")!.holdings.map((h) => h.key),
    ["BBB"]
  );

  // pairwise: 0 shared, jaccard 0, weight overlap 0
  const pair = data.pairwise[0]!;
  assert.equal(pair.sharedCount, 0);
  assert.equal(pair.jaccard, 0);
  assert.equal(pair.weightOverlapPct, 0);
  assert.equal(data.overallOverlapPct, 0);

  // common-weight share is 0 for both
  for (const s of data.commonWeightShareByFund) {
    assert.equal(s.sharePct, 0);
  }
});

// ── 5. Graceful degradation ──────────────────────────────────────────
test("single fund -> available:false (need >=2 funds)", async () => {
  const r = await run({
    funds: [
      {
        id: "ONLY",
        holdings: [
          { symbol: "TCS", weight: 30 },
          { symbol: "INFY", weight: 20 },
        ],
      },
    ],
  });
  // Degradation is success:true with available:false (NOT success:false)
  assert.equal(r.success, true);
  const data = asData(r);
  assert.equal(data.available, false);
  assert.equal(data.reason, "need >=2 funds with holdings");
  assert.equal(data.fundCount, 1);
  assert.deepEqual(data.common, []);
  assert.deepEqual(data.pairwise, []);
  // distinct still surfaces the lone fund's holdings (sorted desc)
  const only = data.distinct.find((d) => d.fundId === "ONLY")!;
  assert.deepEqual(
    only.holdings.map((h) => h.key),
    ["TCS", "INFY"]
  );
});

test("empty funds -> available:false", async () => {
  const r = await run({ funds: [] });
  assert.equal(r.success, true);
  const data = asData(r);
  assert.equal(data.available, false);
  assert.equal(data.reason, "need >=2 funds with holdings");
  assert.equal(data.fundCount, 0);
});

test("no funds param at all -> available:false", async () => {
  const r = await run({});
  assert.equal(r.success, true);
  const data = asData(r);
  assert.equal(data.available, false);
  assert.equal(data.fundCount, 0);
});

test("funds with empty/garbage holdings are dropped -> available:false", async () => {
  const r = await run({
    funds: [
      { id: "A", holdings: [] },
      { id: "B", holdings: [null, "garbage", { weight: 10 }] }, // no key
      "not-an-object",
    ],
  });
  assert.equal(r.success, true);
  const data = asData(r);
  assert.equal(data.available, false);
  assert.equal(data.fundCount, 0);
});

// ── 6. Defensive parsing: {percentage} vs {weight}, {name} vs {symbol} ─
test("defensive parse: {percentage} and {name} are accepted as aliases", async () => {
  // Fund A keys via `name`, weights via `percentage`
  // Fund B keys via `symbol`, weights via `weight`
  // Shared key must match by uppercased name/symbol: "HDFC Bank" vs name "HDFC BANK"
  const r = await run({
    funds: [
      {
        id: "A",
        holdings: [
          { name: "HDFC Bank", percentage: 18, sector: "Financials" },
          { name: "Infosys", percentage: 12 },
        ],
      },
      {
        id: "B",
        holdings: [
          { name: "HDFC BANK", weight: 22, sector: "Financials" },
          { symbol: "TCS", weight: 9 },
        ],
      },
    ],
  });

  assert.equal(r.success, true);
  const data = asData(r);
  assert.equal(data.available, true);

  // "HDFC Bank" and "HDFC BANK" normalize to the same key -> common
  assert.equal(data.commonStockCount, 1);
  const c = data.common[0]!;
  assert.equal(c.key, "HDFC BANK");
  assert.equal(c.fundCount, 2);
  // percentage(18) + weight(22) = 40 aggregate
  assert.ok(Math.abs(c.aggregateWeight - 40) < EPS);
  // readable name preserved from a holding's `name`
  assert.ok(/hdfc/i.test(c.name));
  // sector carried through
  assert.equal(c.sector, "Financials");

  // weight overlap = min(18,22) = 18
  assert.ok(Math.abs(data.pairwise[0]!.weightOverlapPct - 18) < EPS);
});

test("defensive parse: bare {holdings} single payload -> available:false (only one fund)", async () => {
  // A single fetch_mf_holdings result passed bare must be accepted (not throw)
  // but resolves to a single fund -> graceful degradation.
  const r = await run({
    holdings: [
      { name: "Reliance", percentage: 25 },
      { name: "TCS", percentage: 15 },
    ],
  });
  assert.equal(r.success, true);
  const data = asData(r);
  assert.equal(data.available, false);
  assert.equal(data.fundCount, 1);
  // its holdings are still surfaced in distinct
  assert.equal(data.distinct[0]!.holdings.length, 2);
});

test("duplicate keys within one fund are summed, not double-listed", async () => {
  const r = await run({
    funds: [
      {
        id: "A",
        holdings: [
          { symbol: "TCS", weight: 10 },
          { symbol: "TCS", weight: 5 }, // same key again
          { symbol: "INFY", weight: 8 },
        ],
      },
      {
        id: "B",
        holdings: [{ symbol: "TCS", weight: 20 }],
      },
    ],
  });
  assert.equal(r.success, true);
  const data = asData(r);
  assert.equal(data.available, true);
  // TCS in fund A summed to 15 -> common aggregate 15 + 20 = 35
  const tcs = data.common.find((c) => c.key === "TCS")!;
  assert.equal(tcs.fundCount, 2);
  assert.ok(Math.abs(tcs.aggregateWeight - 35) < EPS);
  const perA = tcs.perFund.find((p) => p.fundId === "A")!;
  assert.ok(Math.abs(perA.weight - 15) < EPS);
});
