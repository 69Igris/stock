import { test } from "node:test";
import assert from "node:assert/strict";

import { computeVolatilityRegimeTool } from "../../../../packages/research/src/tools/compute-volatility-regime";

// MONEY-543 - compute-volatility-regime pure-function tests.
//
// The tool is a PURE compute tool (no network / db / io). It reads daily close
// prices (oldest→newest) and emits realized (short/medium/long) + EWMA
// annualized vol, vol-of-vol, a trailing-year percentile, a regime bucket
// (low/normal/elevated/crisis), a directional vol trend, and observation flags.
//
// Contract under test:
//  - genuine exceptions        → { success: false, error }
//  - too little / bad data     → { success: true, data: { available: false, reason } }
//  - happy path                → { success: true, data: { available: true, ... } }
//
// All inputs are deterministic (closed-form arithmetic or a fixed-seed LCG), so
// every assertion is reproducible without relying on Math.random().

interface VolData {
  available: boolean;
  reason?: string;
  symbol?: string;
  sampleSize?: number;
  shortVol?: number;
  mediumVol?: number;
  longVol?: number;
  ewmaVol?: number;
  volOfVol?: number;
  volPercentile?: number;
  regime?: string;
  volTrend?: string;
  flags?: string[];
}

async function run(args: Record<string, unknown>) {
  return computeVolatilityRegimeTool.execute(args);
}

// Deterministic pseudo-random walk (fixed-seed LCG → reproducible bit-for-bit).
function seededWalk(length: number, seed = 12345, amplitude = 0.04): number[] {
  let s = seed;
  const rnd = () => {
    s = (s * 1103515245 + 12345) & 0x7fffffff;
    return s / 0x7fffffff;
  };
  const closes: number[] = [100];
  for (let i = 1; i < length; i++) {
    closes.push(closes[i - 1]! * (1 + (rnd() - 0.5) * amplitude));
  }
  return closes;
}

// closes[i] = 100 * 2^i  →  every daily log return == ln2 (a constant series).
function doublingSeries(length: number): number[] {
  return Array.from({ length }, (_, i) => 100 * Math.pow(2, i));
}

// ─────────────────────────────────────────────────────────────────────────────
// 1. Happy path — success + available, key fields present with correct types.
// ─────────────────────────────────────────────────────────────────────────────

test("happy path: success + available, key fields present with correct types", async () => {
  const closes = seededWalk(300);

  const r = await run({ closes, symbol: "test" });
  assert.equal(r.success, true);
  const d = r.data as VolData;

  assert.equal(d.available, true);
  // symbol is upper-cased by the tool.
  assert.equal(d.symbol, "TEST");

  // sampleSize reflects the count of valid closes consumed.
  assert.equal(d.sampleSize, 300);

  // numeric vol fields present and finite.
  for (const key of [
    "shortVol",
    "mediumVol",
    "longVol",
    "ewmaVol",
    "volOfVol",
  ] as const) {
    assert.equal(typeof d[key], "number", `${key} should be a number`);
    assert.ok(Number.isFinite(d[key] as number), `${key} should be finite`);
    assert.ok((d[key] as number) >= 0, `${key} should be non-negative`);
  }

  // percentile in [0,100], integer.
  assert.equal(typeof d.volPercentile, "number");
  assert.ok(
    (d.volPercentile as number) >= 0 && (d.volPercentile as number) <= 100
  );
  assert.equal(d.volPercentile, Math.round(d.volPercentile as number));

  // regime ∈ known buckets.
  assert.ok(
    ["low", "normal", "elevated", "crisis"].includes(d.regime as string),
    `regime should be a known bucket, got ${d.regime}`
  );

  // volTrend ∈ known directions.
  assert.ok(
    ["rising", "falling", "stable"].includes(d.volTrend as string),
    `volTrend should be a known direction, got ${d.volTrend}`
  );

  // flags always an array.
  assert.ok(Array.isArray(d.flags));

  // This particular fixed-seed walk lands in a calm-ish "normal" regime.
  assert.equal(d.regime, "normal");
  assert.equal(d.volTrend, "stable");
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. KNOWN-VALUE numeric assertion.
//    closes[i] = 100 * 2^i for i=0..49 (50 closes → 49 daily log returns, each
//    == ln2). Verified against the live tool:
//      available=true, sampleSize=50
//      shortVol=0, mediumVol=0, longVol=0, volOfVol=0   (reported, round4)
//      volPercentile=100  (every rolling 20d vol == current → all <= current)
//      regime="crisis"    (percentile >= 90)
//
//    Two deliberate deviations from a naive expectation, both confirmed against
//    the tool's actual arithmetic:
//      ewmaVol ≈ 10.7348  — the RiskMetrics recursion uses raw r*r (NOT
//        deviations from a mean), so a constant non-zero return ln2 drives
//        ewmaVar → r*r and ewmaVol stays large even when realized vol is 0.
//      volTrend="falling" — float rounding makes the full-window mediumVol a
//        tiny positive (~1.25e-14, rounds to 0 in the report) while the last-20
//        window's shortVol is exactly 0; the `mediumVol > 0` guard therefore
//        fires and shortVol/mediumVol = 0 < 0.9 → "falling".
// ─────────────────────────────────────────────────────────────────────────────

test("known values: 100*2^i constant-return series → crisis regime, zero realized vol", async () => {
  const closes = doublingSeries(50);

  const r = await run({ closes, symbol: "test" });
  assert.equal(r.success, true);
  const d = r.data as VolData;

  assert.equal(d.available, true);
  assert.equal(d.symbol, "TEST");
  assert.equal(d.sampleSize, 50);

  // Constant return ⇒ zero realized vol on every window (tight float tolerance).
  assert.ok(
    Math.abs((d.shortVol as number) - 0) < 1e-12,
    `shortVol≈0, got ${d.shortVol}`
  );
  assert.ok(
    Math.abs((d.mediumVol as number) - 0) < 1e-12,
    `mediumVol≈0, got ${d.mediumVol}`
  );
  assert.ok(
    Math.abs((d.longVol as number) - 0) < 1e-12,
    `longVol≈0, got ${d.longVol}`
  );
  assert.ok(
    Math.abs((d.volOfVol as number) - 0) < 1e-12,
    `volOfVol≈0, got ${d.volOfVol}`
  );

  // EWMA tracks raw r*r, so it stays large (≈10.7348) despite zero realized vol.
  assert.ok(
    Math.abs((d.ewmaVol as number) - 10.7348) < 1e-9,
    `ewmaVol should be 10.7348, got ${d.ewmaVol}`
  );

  // Every rolling vol equals the current (all 0) → 100th percentile → crisis.
  assert.equal(d.volPercentile, 100);
  assert.equal(d.regime, "crisis");

  // Float-residual mediumVol > 0 trips the trend guard; shortVol(0) < medium → falling.
  assert.equal(d.volTrend, "falling");

  // Crisis flag fires and names the 100th percentile.
  assert.ok(Array.isArray(d.flags));
  assert.ok(
    (d.flags as string[]).some(
      (f) =>
        f.includes("Crisis-level volatility") && f.includes("100th percentile")
    ),
    `flags should include the crisis observation, got ${JSON.stringify(d.flags)}`
  );
});

test("known values: object-form closes ({ close }) parse identically to raw numbers", async () => {
  const numeric = doublingSeries(50);
  const objects = numeric.map((c) => ({ close: c }));

  const rNum = await run({ closes: numeric });
  const rObj = await run({ closes: objects });

  assert.equal(rNum.success, true);
  assert.equal(rObj.success, true);
  const dNum = rNum.data as VolData;
  const dObj = rObj.data as VolData;

  // Both paths must agree on the headline outputs.
  assert.equal(dObj.available, true);
  assert.equal(dObj.sampleSize, dNum.sampleSize);
  assert.equal(dObj.regime, dNum.regime);
  assert.equal(dObj.volPercentile, dNum.volPercentile);
  assert.equal(dObj.ewmaVol, dNum.ewmaVol);
});

// A constructed volatile-burst-then-calm series that deterministically trips the
// "High volatility-of-volatility" flag (volOfVol / longVol > 0.5).
test("flag path: volatile burst then long calm tail → high vol-of-vol flag fires", async () => {
  const burst = [1.05, 0.95, 1.06, 0.94, 1.07, 0.93];
  const closes: number[] = [100];
  let v = 100;
  for (let i = 0; i < 50; i++) {
    v *= burst[i % burst.length]!;
    closes.push(v);
  }
  for (let i = 0; i < 250; i++) {
    v *= 1.0001;
    closes.push(v);
  }

  const r = await run({ closes });
  assert.equal(r.success, true);
  const d = r.data as VolData;

  assert.equal(d.available, true);
  assert.ok((d.volOfVol as number) >= 0);
  assert.ok(
    (d.flags as string[]).some((f) =>
      f.includes("High volatility-of-volatility")
    ),
    `expected high vol-of-vol flag, got ${JSON.stringify(d.flags)}`
  );
});

// ─────────────────────────────────────────────────────────────────────────────
// 3. Graceful degradation — available:false (NOT success:false) on thin data.
// ─────────────────────────────────────────────────────────────────────────────

test("graceful degrade: < 40 valid closes → success:true, available:false, reason names count", async () => {
  const closes = Array.from({ length: 30 }, (_, i) => 100 + i);

  const r = await run({ closes });
  // NOT a thrown exception — success stays true, the result self-reports.
  assert.equal(r.success, true);
  const d = r.data as VolData;

  assert.equal(d.available, false);
  assert.equal(typeof d.reason, "string");
  assert.ok(
    (d.reason as string).includes("30"),
    `reason should name the count 30, got "${d.reason}"`
  );
  assert.ok(
    (d.reason as string).includes("40"),
    `reason should name the MIN_CLOSES threshold 40, got "${d.reason}"`
  );
  // No analytics emitted when unavailable.
  assert.equal(d.shortVol, undefined);
  assert.equal(d.regime, undefined);
});

test("graceful degrade: non-finite / non-positive closes dropped before the 40 gate", async () => {
  // 39 valid positives + a pile of junk that must be filtered out → still < 40.
  const valid = Array.from({ length: 39 }, (_, i) => 100 + i);
  const closes = [
    ...valid,
    0,
    -5,
    Number.NaN,
    Number.POSITIVE_INFINITY,
    "oops",
    null,
    undefined,
  ];

  const r = await run({ closes });
  assert.equal(r.success, true);
  const d = r.data as VolData;
  assert.equal(d.available, false);
  // Only 39 survived the finite-&-positive filter.
  assert.ok(
    (d.reason as string).includes("39"),
    `reason should report 39 valid closes, got "${d.reason}"`
  );
});

test("graceful degrade: object-form closes with bad inner values filtered, then under-gate", async () => {
  const closes = [
    { close: 100 },
    { close: -1 },
    { close: "x" },
    { close: null },
  ];

  const r = await run({ closes });
  assert.equal(r.success, true);
  const d = r.data as VolData;
  assert.equal(d.available, false);
  // Only the single positive {close:100} survives.
  assert.ok((d.reason as string).includes("1 valid closes"));
});

test("graceful degrade: symbol still carried onto the degraded result", async () => {
  const closes = Array.from({ length: 10 }, (_, i) => 100 + i);
  const r = await run({ closes, symbol: "infy" });
  assert.equal(r.success, true);
  const d = r.data as VolData;
  assert.equal(d.available, false);
  assert.equal(d.symbol, "INFY");
});

// ─────────────────────────────────────────────────────────────────────────────
// 4. Edge cases — must not throw / must remain well-formed.
// ─────────────────────────────────────────────────────────────────────────────

test("edge: empty closes → available:false (count 0), no throw", async () => {
  const r = await run({ closes: [] });
  assert.equal(r.success, true);
  const d = r.data as VolData;
  assert.equal(d.available, false);
  assert.ok((d.reason as string).includes("0 valid closes"));
});

test("edge: missing closes param → treated as empty, available:false, no throw", async () => {
  const r = await run({});
  assert.equal(r.success, true);
  const d = r.data as VolData;
  assert.equal(d.available, false);
  assert.ok((d.reason as string).includes("0 valid closes"));
});

test("edge: closes not an array (object) → treated as empty, available:false", async () => {
  const r = await run({ closes: { not: "an array" } });
  assert.equal(r.success, true);
  const d = r.data as VolData;
  assert.equal(d.available, false);
});

test("edge: all-zero / all-negative closes filtered out → available:false, no throw", async () => {
  const zeros = await run({ closes: Array.from({ length: 50 }, () => 0) });
  assert.equal(zeros.success, true);
  assert.equal((zeros.data as VolData).available, false);

  const negatives = await run({
    closes: Array.from({ length: 50 }, () => -10),
  });
  assert.equal(negatives.success, true);
  assert.equal((negatives.data as VolData).available, false);
});

test("edge: single-element series → available:false, no throw", async () => {
  const r = await run({ closes: [100] });
  assert.equal(r.success, true);
  assert.equal((r.data as VolData).available, false);
});

test("edge: missing optional symbol → symbol undefined on a healthy result, no throw", async () => {
  const closes = seededWalk(300);
  const r = await run({ closes });
  assert.equal(r.success, true);
  const d = r.data as VolData;
  assert.equal(d.available, true);
  assert.equal(d.symbol, undefined);
});
