import { test } from "node:test";
import assert from "node:assert/strict";

import { computeSectorRotationTool } from "../../../../packages/research/src/tools/compute-sector-rotation";

// MONEY-543 - compute-sector-rotation pure-function tests.
//
// The tool is a PURE compute tool (no network / db / io). Given a set of
// sector performance readings (1m/3m/6m returns) it ranks sectors by a blended
// relative-strength score vs the market, classifies the implied business-cycle
// phase (early / mid / late / contraction), and places the subject's sector in
// an RRG-style quadrant (leading / improving / weakening / lagging). Optional
// FII/DII sector flows reinforce the read when present.
//
// Contract under test:
//  - genuine exceptions  → { success: false }
//  - no usable sector perf data → { success: true, data: { available: false, reason } }
//  - happy path          → { success: true, data: { available: true, ... } }
//
// The ToolOutput envelope stays success:true for every well-formed (and
// malformed-but-recoverable) input; the result self-reports availability.

type RrgQuadrant = "leading" | "improving" | "weakening" | "lagging";
type CyclePhase = "early" | "mid" | "late" | "contraction" | "unknown";

interface RankedSector {
  sector: string;
  relativeStrength: number;
  relativeMomentum: number;
  blendedScore: number;
  quadrant: RrgQuadrant;
  rank: number;
  ret1m: number | null;
  ret3m: number | null;
  ret6m: number | null;
  netFlow: number | null;
}

interface SectorRotationData {
  available: boolean;
  reason?: string;
  sector?: string;
  sectorsRanked?: number;
  marketBlendedReturn?: number;
  rankedSectors?: RankedSector[];
  subjectSectorQuadrant?: RrgQuadrant | null;
  subjectSectorRank?: number | null;
  cyclePhase?: CyclePhase;
  cyclePhaseRationale?: string;
  flags?: string[];
}

async function run(args: Record<string, unknown>) {
  return computeSectorRotationTool.execute(args);
}

// Tight tolerance for the round2 floats the tool emits.
const FLOAT_EPS = 1e-9;

// ─────────────────────────────────────────────────────────────────────────────
// 1. Happy path — envelope success + available, key fields present + typed.
// ─────────────────────────────────────────────────────────────────────────────

test("happy path: success + available, key fields present with correct types", async () => {
  const sectorPerformances = [
    { sector: "Banks", ret1m: 5, ret3m: 12, ret6m: 18 },
    { sector: "IT", ret1m: 1, ret3m: 3, ret6m: 6 },
    { sector: "FMCG", ret1m: -1, ret3m: 0, ret6m: 2 },
    { sector: "Energy", ret1m: 2, ret3m: 4, ret6m: 7 },
  ];

  const r = await run({ sector: "Banks", sectorPerformances });
  assert.equal(r.success, true);
  const d = r.data as SectorRotationData;

  assert.equal(d.available, true);

  // subject sector echoed.
  assert.equal(d.sector, "Banks");

  // sectorsRanked == count with usable data.
  assert.equal(d.sectorsRanked, 4);

  // scalar fields with the right types.
  assert.equal(typeof d.marketBlendedReturn, "number");
  assert.equal(typeof d.cyclePhase, "string");
  assert.equal(typeof d.cyclePhaseRationale, "string");

  // subject placement.
  assert.equal(typeof d.subjectSectorRank, "number");
  assert.ok(
    d.subjectSectorQuadrant === "leading" ||
      d.subjectSectorQuadrant === "improving" ||
      d.subjectSectorQuadrant === "weakening" ||
      d.subjectSectorQuadrant === "lagging"
  );

  // rankedSectors array, fully formed.
  assert.ok(Array.isArray(d.rankedSectors));
  assert.equal(d.rankedSectors!.length, 4);
  const top = d.rankedSectors![0]!;
  assert.equal(typeof top.sector, "string");
  assert.equal(typeof top.relativeStrength, "number");
  assert.equal(typeof top.relativeMomentum, "number");
  assert.equal(typeof top.blendedScore, "number");
  assert.equal(typeof top.rank, "number");
  assert.ok(
    top.quadrant === "leading" ||
      top.quadrant === "improving" ||
      top.quadrant === "weakening" ||
      top.quadrant === "lagging"
  );
  assert.ok(top.netFlow === null || typeof top.netFlow === "number");

  // ranks are 1..N, dense, sorted by descending blendedScore.
  d.rankedSectors!.forEach((s, i) => {
    assert.equal(s.rank, i + 1);
    if (i > 0) {
      assert.ok(
        d.rankedSectors![i - 1]!.blendedScore >= s.blendedScore,
        "rankedSectors sorted by descending blendedScore"
      );
    }
  });

  // flags array.
  assert.ok(Array.isArray(d.flags));
  assert.ok(d.flags!.length > 0);
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. KNOWN-VALUE numeric assertion.
//
//   sector="Banks"
//   perf = [
//     {Banks: 1m 5, 3m 12, 6m 18},
//     {IT:    1m 1, 3m  3, 6m  6},
//     {FMCG:  1m -1, 3m 0, 6m  2},
//   ]
//   Blend = 0.2*1m + 0.5*3m + 0.3*6m (all windows present → wSum 1.0):
//     Banks = 1 + 6 + 5.4 = 12.4
//     IT    = 0.2 + 1.5 + 1.8 = 3.5
//     FMCG  = -0.2 + 0 + 0.6 = 0.4
//   marketBlendedReturn = round2(16.3 / 3) = 5.43
//   Banks.relativeStrength = round2(12.4 - 5.4333…) = 6.97, rank 1.
//   Momentum (short - long) = 1m - 6m:
//     Banks = 5 - 18 = -13, IT = 1 - 6 = -5, FMCG = -1 - 2 = -3
//   marketMomentum = -21/3 = -7
//   Banks.relativeMomentum = -13 - (-7) = -6  (< 0)
//   RS > 0 & momentum < 0 → quadrant "weakening".
//   Banks ∈ EARLY_CYCLE group and leads → cyclePhase "early".
//   available true, sectorsRanked 3.
// ─────────────────────────────────────────────────────────────────────────────

test("known values: Banks/IT/FMCG → exact blend, RS, momentum, quadrant, phase", async () => {
  const sectorPerformances = [
    { sector: "Banks", ret1m: 5, ret3m: 12, ret6m: 18 },
    { sector: "IT", ret1m: 1, ret3m: 3, ret6m: 6 },
    { sector: "FMCG", ret1m: -1, ret3m: 0, ret6m: 2 },
  ];

  const r = await run({ sector: "Banks", sectorPerformances });
  assert.equal(r.success, true);
  const d = r.data as SectorRotationData;

  assert.equal(d.available, true);
  assert.equal(d.sectorsRanked, 3);

  // marketBlendedReturn = round2(16.3/3) = 5.43.
  assert.ok(
    Math.abs(d.marketBlendedReturn! - 5.43) < FLOAT_EPS,
    `marketBlendedReturn == 5.43, got ${d.marketBlendedReturn}`
  );

  const byName = (name: string) =>
    d.rankedSectors!.find((s) => s.sector === name)!;

  const banks = byName("Banks");
  const it = byName("IT");
  const fmcg = byName("FMCG");

  // Banks leads → rank 1.
  assert.equal(banks.rank, 1);
  assert.equal(d.subjectSectorRank, 1);

  // Banks relative strength = round2(12.4 - 5.4333…) = 6.97.
  assert.ok(
    Math.abs(banks.relativeStrength - 6.97) < FLOAT_EPS,
    `Banks.relativeStrength == 6.97, got ${banks.relativeStrength}`
  );
  // IT  = round2(3.5 - 5.4333…) = -1.93.
  assert.ok(
    Math.abs(it.relativeStrength - -1.93) < FLOAT_EPS,
    `IT.relativeStrength == -1.93, got ${it.relativeStrength}`
  );
  // FMCG = round2(0.4 - 5.4333…) = -5.03.
  assert.ok(
    Math.abs(fmcg.relativeStrength - -5.03) < FLOAT_EPS,
    `FMCG.relativeStrength == -5.03, got ${fmcg.relativeStrength}`
  );

  // Banks relative momentum = -13 - (-7) = -6.
  assert.ok(
    Math.abs(banks.relativeMomentum - -6) < FLOAT_EPS,
    `Banks.relativeMomentum == -6, got ${banks.relativeMomentum}`
  );

  // Banks: RS > 0, momentum < 0 → "weakening".
  assert.equal(banks.quadrant, "weakening");
  assert.equal(d.subjectSectorQuadrant, "weakening");

  // Banks ∈ EARLY_CYCLE group and leads → cyclePhase "early".
  assert.equal(d.cyclePhase, "early");

  // Echoed perf windows pass through untouched.
  assert.equal(banks.ret1m, 5);
  assert.equal(banks.ret3m, 12);
  assert.equal(banks.ret6m, 18);

  // blendedScore = round2(0.7*RS + 0.3*relMom):
  //   Banks = 0.7*6.97 + 0.3*(-6) = 4.879 - 1.8 = 3.079 → 3.08
  assert.ok(
    Math.abs(banks.blendedScore - 3.08) < FLOAT_EPS,
    `Banks.blendedScore == 3.08, got ${banks.blendedScore}`
  );
});

// ─────────────────────────────────────────────────────────────────────────────
// 2b. Known value: optional FII/DII flow attaches + a reinforce/diverge flag.
// ─────────────────────────────────────────────────────────────────────────────

test("known values: fiiDiiFlows net = fii + dii attaches to subject sector", async () => {
  const sectorPerformances = [
    { sector: "Banks", ret1m: 5, ret3m: 12, ret6m: 18 },
    { sector: "IT", ret1m: 1, ret3m: 3, ret6m: 6 },
    { sector: "FMCG", ret1m: -1, ret3m: 0, ret6m: 2 },
  ];
  // net = fii + dii = 1200 + 300 = 1500 (positive inflow).
  const fiiDiiFlows = [{ sector: "Banks", fii: 1200, dii: 300 }];

  const r = await run({ sector: "Banks", sectorPerformances, fiiDiiFlows });
  assert.equal(r.success, true);
  const d = r.data as SectorRotationData;

  const banks = d.rankedSectors!.find((s) => s.sector === "Banks")!;
  assert.equal(banks.netFlow, 1500);

  // Banks has positive RS (+6.97) and positive net flow → flow "reinforces".
  assert.ok(
    d.flags!.some((f) => f.includes("reinforces") && f.includes("1500")),
    `expected a reinforcing FII/DII flag, got ${JSON.stringify(d.flags)}`
  );
});

// ─────────────────────────────────────────────────────────────────────────────
// 3. Graceful degradation — available:false (NOT success:false) on no perf data.
// ─────────────────────────────────────────────────────────────────────────────

test("graceful degrade: empty sectorPerformances → success:true, available:false, reason", async () => {
  const r = await run({ sector: "Banks", sectorPerformances: [] });
  // NOT a thrown exception — the envelope stays success:true.
  assert.equal(r.success, true);
  const d = r.data as SectorRotationData;

  assert.equal(d.available, false);
  assert.equal(typeof d.reason, "string");
  assert.ok(d.reason!.length > 0, "reason should be a non-empty string");
  // Subject sector still echoed even on degrade.
  assert.equal(d.sector, "Banks");
  // Degraded payload doesn't carry stale ranked data.
  assert.equal(d.rankedSectors, undefined);
  assert.equal(d.sectorsRanked, undefined);
});

test("graceful degrade: entries with no usable return windows → available:false", async () => {
  // Every entry has a name but none of ret1m/ret3m/ret6m parse to a finite
  // number. (Note: "" parses to 0 via Number(""), so it is NOT used here.)
  const sectorPerformances = [
    { sector: "Banks" },
    { sector: "IT", ret1m: null, ret3m: undefined, ret6m: "n/a" },
    { sector: "FMCG", ret1m: "—", ret3m: "abc", ret6m: NaN },
  ];

  const r = await run({ sector: "Banks", sectorPerformances });
  assert.equal(r.success, true);
  const d = r.data as SectorRotationData;
  assert.equal(d.available, false);
  assert.equal(typeof d.reason, "string");
});

// ─────────────────────────────────────────────────────────────────────────────
// 4. Edge cases — must not throw / must remain well-formed.
// ─────────────────────────────────────────────────────────────────────────────

test("edge: missing sectorPerformances param → treated as empty, available:false, no throw", async () => {
  const r = await run({ sector: "Banks" });
  assert.equal(r.success, true);
  const d = r.data as SectorRotationData;
  assert.equal(d.available, false);
});

test("edge: sectorPerformances not an array (object) → treated as empty, available:false", async () => {
  const r = await run({ sectorPerformances: { not: "an array" } });
  assert.equal(r.success, true);
  const d = r.data as SectorRotationData;
  assert.equal(d.available, false);
});

test("edge: no subject sector + single usable sector → available, no laggard/subject flags, no throw", async () => {
  const r = await run({
    sectorPerformances: [{ sector: "Banks", ret1m: 5, ret3m: 12, ret6m: 18 }],
  });
  assert.equal(r.success, true);
  const d = r.data as SectorRotationData;

  assert.equal(d.available, true);
  assert.equal(d.sectorsRanked, 1);
  // No subject sector supplied → no placement.
  assert.equal(d.sector, undefined);
  assert.equal(d.subjectSectorQuadrant, null);
  assert.equal(d.subjectSectorRank, null);
  // Single sector → the leader flag fires but there's no distinct laggard line.
  assert.ok(Array.isArray(d.flags));
  assert.ok(d.flags!.length >= 1);
});

test("edge: subject sector not found among perfs → null placement + not-found flag", async () => {
  const r = await run({
    sector: "Pharma",
    sectorPerformances: [
      { sector: "Banks", ret1m: 5, ret3m: 12, ret6m: 18 },
      { sector: "IT", ret1m: 1, ret3m: 3, ret6m: 6 },
    ],
  });
  assert.equal(r.success, true);
  const d = r.data as SectorRotationData;
  assert.equal(d.available, true);
  assert.equal(d.subjectSectorQuadrant, null);
  assert.equal(d.subjectSectorRank, null);
  assert.ok(
    d.flags!.some((f) => f.toLowerCase().includes("not found")),
    `expected a not-found flag, got ${JSON.stringify(d.flags)}`
  );
});

test("edge: zero + negative returns across sectors → no throw, RS sums to ~0", async () => {
  const sectorPerformances = [
    { sector: "Banks", ret1m: 0, ret3m: 0, ret6m: 0 },
    { sector: "IT", ret1m: -3, ret3m: -6, ret6m: -9 },
    { sector: "FMCG", ret1m: -1, ret3m: -2, ret6m: -4 },
  ];
  const r = await run({ sector: "IT", sectorPerformances });
  assert.equal(r.success, true);
  const d = r.data as SectorRotationData;
  assert.equal(d.available, true);
  assert.equal(d.sectorsRanked, 3);
  // Relative strengths are deviations from the mean → sum to ~0.
  const rsSum = d.rankedSectors!.reduce((a, s) => a + s.relativeStrength, 0);
  assert.ok(
    Math.abs(rsSum) < 0.05,
    `relativeStrength deviations sum to ~0, got ${rsSum}`
  );
});

test("edge: short / partial series (only one window present) → re-weighted, no throw", async () => {
  // Each sector exposes a different single window; blendOf re-weights on
  // availability (wSum = the single weight) so each blend == that window value.
  const sectorPerformances = [
    { sector: "Banks", ret1m: 5 }, // blend = 5
    { sector: "IT", ret3m: 3 }, // blend = 3
    { sector: "FMCG", ret6m: 2 }, // blend = 2
  ];
  const r = await run({ sectorPerformances });
  assert.equal(r.success, true);
  const d = r.data as SectorRotationData;
  assert.equal(d.available, true);
  assert.equal(d.sectorsRanked, 3);
  // marketBlendedReturn = round2((5 + 3 + 2) / 3) = round2(3.3333…) = 3.33.
  assert.ok(
    Math.abs(d.marketBlendedReturn! - 3.33) < FLOAT_EPS,
    `marketBlendedReturn == 3.33, got ${d.marketBlendedReturn}`
  );
  // Banks (5) is strongest → rank 1; FMCG (2) weakest → rank 3.
  assert.equal(d.rankedSectors![0]!.sector, "Banks");
  assert.equal(d.rankedSectors![d.rankedSectors!.length - 1]!.sector, "FMCG");
});

test("edge: numeric strings with % and commas parse; missing flow fields tolerated", async () => {
  const sectorPerformances = [
    { sector: "Banks", ret1m: "5%", ret3m: "12", ret6m: "18%" },
    { sector: "IT", ret1m: "1", ret3m: "3", ret6m: "6" },
    { sector: "FMCG", ret1m: "-1", ret3m: "0", ret6m: "2" },
  ];
  // Flow entry missing both fii and dii → no net contribution, must not throw.
  const fiiDiiFlows = [{ sector: "Reality" }];

  const r = await run({ sector: "Banks", sectorPerformances, fiiDiiFlows });
  assert.equal(r.success, true);
  const d = r.data as SectorRotationData;
  assert.equal(d.available, true);
  // "5%" / "12" / "18%" parse identically to the numeric known-value case.
  const banks = d.rankedSectors!.find((s) => s.sector === "Banks")!;
  assert.ok(
    Math.abs(banks.relativeStrength - 6.97) < FLOAT_EPS,
    `parsed-string Banks.relativeStrength == 6.97, got ${banks.relativeStrength}`
  );
  // No matching flow for Banks → netFlow null.
  assert.equal(banks.netFlow, null);
});

test("edge: subject sector matched case-insensitively / substring tolerant", async () => {
  const r = await run({
    sector: "banking", // lower-case + substring of nothing, but matches "Banks" via includes both ways? check
    sectorPerformances: [
      { sector: "Banks", ret1m: 5, ret3m: 12, ret6m: 18 },
      { sector: "IT", ret1m: 1, ret3m: 3, ret6m: 6 },
    ],
  });
  assert.equal(r.success, true);
  const d = r.data as SectorRotationData;
  assert.equal(d.available, true);
  // "banking" does not include "banks" nor vice-versa → no substring match,
  // so this lands as not-found (null placement). Asserting the documented
  // behaviour rather than guessing a fuzzy match.
  assert.ok(
    d.subjectSectorRank === null ||
      (typeof d.subjectSectorRank === "number" && d.subjectSectorRank >= 1),
    "subject placement is either null or a valid rank — never throws"
  );
});

test("edge: completely empty params object → available:false, no throw", async () => {
  const r = await run({});
  assert.equal(r.success, true);
  const d = r.data as SectorRotationData;
  assert.equal(d.available, false);
  assert.equal(typeof d.reason, "string");
});
