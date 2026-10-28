/**
 * Concentration Delta Tool Tests
 * (packages/research/src/tools/compute-concentration-delta.ts)
 *
 * PURE compute tool — no network/db/io, fully deterministic.
 *
 * Coverage:
 *   - Tool metadata wiring (name / category / execute)
 *   - Happy path (success:true, available:true, field presence + types)
 *   - Known-value numeric assertion (runtime-verified HHI / weights / breaches)
 *   - Graceful degradation: holdings empty/absent -> available:false with a
 *     reason string, STILL success:true (NOT success:false) — expected in
 *     single-stock research where no portfolio context exists
 *   - Edge cases: empty/zero/negative inputs, missing optional fields, symbol
 *     normalization, candidate merges into an existing holding — must not throw
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { computeConcentrationDeltaTool } from "../../../../packages/research/src/tools/compute-concentration-delta";

// ── Shape of result.data (mirrors ConcentrationDeltaResult) ──────────
interface ConcentrationDeltaResult {
  available: boolean;
  reason?: string;
  symbol: string;
  currentTotalValue: number;
  postTotalValue: number;
  currentHHI: number;
  postHHI: number;
  hhiDelta: number;
  concentrationDirection:
    | "more_concentrated"
    | "less_concentrated"
    | "unchanged";
  currentTopWeight: number;
  postTopWeight: number;
  currentTopSymbol: string;
  postTopSymbol: string;
  candidateSector: string | null;
  currentSectorWeight: number;
  postSectorWeight: number;
  candidateWeight: number;
  breaches: Array<{
    type: "single_name" | "sector";
    label: string;
    weight: number;
    threshold: number;
  }>;
  flags: string[];
}

async function run(args: Record<string, unknown>) {
  return computeConcentrationDeltaTool.execute(args);
}

function asData(r: {
  success: boolean;
  data?: unknown;
}): ConcentrationDeltaResult {
  assert.ok(r.data, "expected data on tool output");
  return r.data as ConcentrationDeltaResult;
}

const EPS = 1e-9;

// ── 1. Tool metadata sanity ──────────────────────────────────────────
test("tool is wired with name + category + execute", () => {
  assert.equal(
    computeConcentrationDeltaTool.name,
    "compute_concentration_delta"
  );
  assert.equal(computeConcentrationDeltaTool.category, "computation");
  assert.equal(typeof computeConcentrationDeltaTool.execute, "function");
});

// ── 2. Happy path: success:true, available:true, field types ─────────
test("happy path returns success:true, available:true with typed fields", async () => {
  const r = await run({
    holdings: [
      { symbol: "HDFCBANK", value: 300, sector: "Financials" },
      { symbol: "RELIANCE", value: 250, sector: "Energy" },
      { symbol: "INFY", value: 150, sector: "IT" },
    ],
    candidateSymbol: "TCS.NS",
    candidateValue: 200,
    candidateSector: "IT",
  });

  assert.equal(r.success, true);
  const data = asData(r);

  assert.equal(data.available, true);
  // key fields present + correct types
  assert.equal(typeof data.symbol, "string");
  assert.equal(typeof data.currentTotalValue, "number");
  assert.equal(typeof data.postTotalValue, "number");
  assert.equal(typeof data.currentHHI, "number");
  assert.equal(typeof data.postHHI, "number");
  assert.equal(typeof data.hhiDelta, "number");
  assert.equal(typeof data.concentrationDirection, "string");
  assert.equal(typeof data.currentTopWeight, "number");
  assert.equal(typeof data.postTopWeight, "number");
  assert.equal(typeof data.currentTopSymbol, "string");
  assert.equal(typeof data.postTopSymbol, "string");
  assert.equal(typeof data.currentSectorWeight, "number");
  assert.equal(typeof data.postSectorWeight, "number");
  assert.equal(typeof data.candidateWeight, "number");
  assert.ok(Array.isArray(data.breaches));
  assert.ok(Array.isArray(data.flags));

  // symbol is normalized (suffix stripped, uppercased)
  assert.equal(data.symbol, "TCS");
  // candidateSector echoed back
  assert.equal(data.candidateSector, "IT");
  // total value math: 700 current + 200 add = 900
  assert.ok(Math.abs(data.currentTotalValue - 700) < EPS);
  assert.ok(Math.abs(data.postTotalValue - 900) < EPS);
  // hhiDelta = postHHI - currentHHI is internally consistent
  assert.equal(data.hhiDelta, data.postHHI - data.currentHHI);
  // weights are fractions in [0,1]
  for (const w of [
    data.currentTopWeight,
    data.postTopWeight,
    data.currentSectorWeight,
    data.postSectorWeight,
    data.candidateWeight,
  ]) {
    assert.ok(w >= 0 && w <= 1, `weight should be in [0,1], got ${w}`);
  }
});

// ── 3. KNOWN-VALUE numeric assertion (runtime-verified) ──────────────
test("known-value assertion: exact HHI / weights / breaches", async () => {
  const r = await run({
    holdings: [
      { symbol: "TCS", value: 60, sector: "IT" },
      { symbol: "INFY", value: 40, sector: "IT" },
    ],
    candidateSymbol: "WIPRO",
    candidateValue: 100,
    candidateSector: "IT",
  });

  assert.equal(r.success, true);
  const data = asData(r);

  assert.equal(data.available, true);
  assert.equal(data.symbol, "WIPRO");

  // Totals: current 100, post 200
  assert.ok(Math.abs(data.currentTotalValue - 100) < EPS);
  assert.ok(Math.abs(data.postTotalValue - 200) < EPS);

  // currentHHI = (0.6^2 + 0.4^2) * 1e4 = (0.36 + 0.16) * 1e4 = 5200
  assert.equal(data.currentHHI, 5200);
  // postHHI = (0.3^2 + 0.2^2 + 0.5^2) * 1e4 = (0.09 + 0.04 + 0.25) * 1e4 = 3800
  assert.equal(data.postHHI, 3800);
  // hhiDelta = 3800 - 5200 = -1400 -> less_concentrated
  assert.equal(data.hhiDelta, -1400);
  assert.equal(data.concentrationDirection, "less_concentrated");

  // Top holding: current TCS @ 0.6, post WIPRO @ 0.5
  assert.equal(data.currentTopSymbol, "TCS");
  assert.ok(Math.abs(data.currentTopWeight - 0.6) < EPS);
  assert.equal(data.postTopSymbol, "WIPRO");
  assert.ok(Math.abs(data.postTopWeight - 0.5) < EPS);

  // Candidate own weight = 100 / 200 = 0.5
  assert.ok(Math.abs(data.candidateWeight - 0.5) < EPS);

  // Sector IT: current 100/100 = 1.0, post 200/200 = 1.0
  assert.equal(data.candidateSector, "IT");
  assert.ok(Math.abs(data.currentSectorWeight - 1.0) < EPS);
  assert.ok(Math.abs(data.postSectorWeight - 1.0) < EPS);

  // Breaches: WIPRO single_name @ 0.5 (>0.2) + IT sector @ 1.0 (>0.4)
  // (postTopSymbol === candidateSymbol, so the "other top holding" branch
  //  does NOT add a duplicate single_name breach)
  assert.equal(data.breaches.length, 2);

  const single = data.breaches.find((b) => b.type === "single_name");
  assert.ok(single, "expected a single_name breach");
  assert.equal(single.label, "WIPRO");
  assert.ok(Math.abs(single.weight - 0.5) < EPS);
  assert.ok(Math.abs(single.threshold - 0.2) < EPS);

  const sector = data.breaches.find((b) => b.type === "sector");
  assert.ok(sector, "expected a sector breach");
  assert.equal(sector.label, "IT");
  assert.ok(Math.abs(sector.weight - 1.0) < EPS);
  assert.ok(Math.abs(sector.threshold - 0.4) < EPS);

  // No double-counted single_name breach for the (identical) top holding
  assert.equal(data.breaches.filter((b) => b.type === "single_name").length, 1);
});

test("known-value: candidate merges into an existing holding (same symbol)", async () => {
  const r = await run({
    holdings: [
      { symbol: "TCS", value: 100, sector: "IT" },
      { symbol: "HDFCBANK", value: 100, sector: "Financials" },
    ],
    candidateSymbol: "TCS",
    candidateValue: 100,
    candidateSector: "IT",
  });

  assert.equal(r.success, true);
  const data = asData(r);
  assert.equal(data.available, true);

  // TCS merges -> 200; total post = 300
  assert.ok(Math.abs(data.postTotalValue - 300) < EPS);
  assert.equal(data.postTopSymbol, "TCS");
  // post TCS weight = 200 / 300 = 0.6667 (round4)
  assert.ok(Math.abs(data.postTopWeight - 0.6667) < EPS);
  assert.ok(Math.abs(data.candidateWeight - 0.6667) < EPS);
  // candidateWeight 0.6667 > 0.2 -> single_name breach for TCS
  const single = data.breaches.find((b) => b.type === "single_name");
  assert.ok(single, "expected single_name breach");
  assert.equal(single.label, "TCS");
});

// ── 4. Graceful degradation: no portfolio context ────────────────────
test("holdings absent -> available:false with reason, STILL success:true", async () => {
  const r = await run({
    candidateSymbol: "TCS",
    candidateValue: 100,
    candidateSector: "IT",
  });

  // Degradation is success:true with available:false (NOT success:false)
  assert.equal(r.success, true);
  const data = asData(r);

  assert.equal(data.available, false);
  assert.equal(typeof data.reason, "string");
  assert.equal(data.reason, "no portfolio context");
  // candidate symbol still normalized/echoed
  assert.equal(data.symbol, "TCS");
  assert.equal(data.candidateSector, "IT");
  // degraded numerics are zeroed and direction unchanged
  assert.equal(data.currentTotalValue, 0);
  assert.equal(data.postTotalValue, 0);
  assert.equal(data.currentHHI, 0);
  assert.equal(data.postHHI, 0);
  assert.equal(data.hhiDelta, 0);
  assert.equal(data.concentrationDirection, "unchanged");
  assert.deepEqual(data.breaches, []);
  assert.deepEqual(data.flags, []);
});

test("holdings empty array -> available:false (no portfolio context)", async () => {
  const r = await run({
    holdings: [],
    candidateSymbol: "TCS",
    candidateValue: 100,
  });
  assert.equal(r.success, true);
  const data = asData(r);
  assert.equal(data.available, false);
  assert.equal(data.reason, "no portfolio context");
});

test("holdings present but all entries invalid -> available:false", async () => {
  // Non-positive / zero / non-object entries are all dropped by normalize,
  // leaving an empty holdings list -> graceful degradation.
  const r = await run({
    holdings: [
      { symbol: "TCS", value: 0 },
      { symbol: "", value: 100 },
      { symbol: "INFY", value: -50 },
      null,
      "garbage",
      { value: 100 },
    ],
    candidateSymbol: "WIPRO",
    candidateValue: 100,
  });
  assert.equal(r.success, true);
  const data = asData(r);
  assert.equal(data.available, false);
  assert.equal(data.reason, "no portfolio context");
});

// ── 5. Edge cases: must not throw, keep success:true ─────────────────
test("empty args do not throw -> available:false", async () => {
  const r = await run({});
  assert.equal(r.success, true);
  const data = asData(r);
  assert.equal(data.available, false);
  assert.equal(data.reason, "no portfolio context");
  assert.equal(data.symbol, "");
});

test("zero candidateValue -> post == current, no division blowup", async () => {
  const r = await run({
    holdings: [
      { symbol: "TCS", value: 60, sector: "IT" },
      { symbol: "INFY", value: 40, sector: "IT" },
    ],
    candidateSymbol: "WIPRO",
    candidateValue: 0,
    candidateSector: "IT",
  });
  assert.equal(r.success, true);
  const data = asData(r);
  assert.equal(data.available, true);
  // addValue clamped to 0 -> post total unchanged
  assert.ok(Math.abs(data.postTotalValue - 100) < EPS);
  // WIPRO contributes 0 -> HHI unchanged, direction unchanged
  assert.equal(data.postHHI, data.currentHHI);
  assert.equal(data.hhiDelta, 0);
  assert.equal(data.concentrationDirection, "unchanged");
  // candidate weight 0 -> no single_name breach for WIPRO; sector IT still 1.0
  assert.ok(Math.abs(data.candidateWeight - 0) < EPS);
});

test("negative candidateValue is clamped to 0 (treated like no add)", async () => {
  const r = await run({
    holdings: [{ symbol: "TCS", value: 100, sector: "IT" }],
    candidateSymbol: "WIPRO",
    candidateValue: -500,
    candidateSector: "Energy",
  });
  assert.equal(r.success, true);
  const data = asData(r);
  assert.equal(data.available, true);
  // negative clamped to 0 -> post total unchanged
  assert.ok(Math.abs(data.postTotalValue - 100) < EPS);
  assert.ok(Math.abs(data.candidateWeight - 0) < EPS);
});

test("missing candidateSector -> candidateSector:null + unknown-sector flag, no throw", async () => {
  const r = await run({
    holdings: [
      { symbol: "TCS", value: 60, sector: "IT" },
      { symbol: "INFY", value: 40, sector: "IT" },
    ],
    candidateSymbol: "WIPRO",
    candidateValue: 100,
  });
  assert.equal(r.success, true);
  const data = asData(r);
  assert.equal(data.available, true);
  assert.equal(data.candidateSector, null);
  // sector weights default to 0 when sector unknown
  assert.equal(data.currentSectorWeight, 0);
  assert.equal(data.postSectorWeight, 0);
  // no sector breach when sector unknown
  assert.equal(data.breaches.filter((b) => b.type === "sector").length, 0);
  // an explanatory flag is surfaced
  assert.ok(
    data.flags.some((f) => /sector unknown/i.test(f)),
    "expected an unknown-sector flag"
  );
});

test("holdings with missing/blank sector fields do not throw and are tolerated", async () => {
  const r = await run({
    holdings: [
      { symbol: "TCS", value: 60 }, // no sector
      { symbol: "INFY", value: 40, sector: "   " }, // blank -> dropped sector
    ],
    candidateSymbol: "WIPRO",
    candidateValue: 100,
    candidateSector: "IT",
  });
  assert.equal(r.success, true);
  const data = asData(r);
  assert.equal(data.available, true);
  // candidate sector IT exists in candidate only; holdings have no IT sector
  // so currentSectorWeight = 0 but post includes the candidate add: 100/200=0.5
  assert.ok(Math.abs(data.currentSectorWeight - 0) < EPS);
  assert.ok(Math.abs(data.postSectorWeight - 0.5) < EPS);
});

test("alternate holding field names (tradingsymbol / currentValue) are normalized", async () => {
  const r = await run({
    holdings: [
      { tradingsymbol: "TCS.NS", currentValue: 60, sector: "IT" },
      { name: "INFY", marketValue: 40, sector: "IT" },
    ],
    candidateSymbol: "WIPRO",
    candidateValue: 100,
    candidateSector: "IT",
  });
  assert.equal(r.success, true);
  const data = asData(r);
  assert.equal(data.available, true);
  // same numbers as the known-value case (just different field aliases)
  assert.equal(data.currentHHI, 5200);
  assert.equal(data.postHHI, 3800);
  assert.equal(data.currentTopSymbol, "TCS");
});

test("more_concentrated direction: small base + large concentrated add", async () => {
  const r = await run({
    holdings: [
      { symbol: "TCS", value: 100, sector: "IT" },
      { symbol: "HDFCBANK", value: 100, sector: "Financials" },
    ],
    candidateSymbol: "TCS", // merge into the larger post position
    candidateValue: 800,
    candidateSector: "IT",
  });
  assert.equal(r.success, true);
  const data = asData(r);
  assert.equal(data.available, true);
  // TCS becomes 900/1000 = 0.9 of the book -> HHI rises sharply
  assert.ok(data.hhiDelta > 0, "HHI should rise");
  assert.equal(data.concentrationDirection, "more_concentrated");
  assert.equal(data.postTopSymbol, "TCS");
  assert.ok(Math.abs(data.postTopWeight - 0.9) < EPS);
});
