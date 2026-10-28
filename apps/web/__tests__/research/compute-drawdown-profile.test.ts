import { test } from "node:test";
import assert from "node:assert/strict";

import { computeDrawdownProfileTool } from "../../../../packages/research/src/tools/compute-drawdown-profile";

// MONEY-543 - compute-drawdown-profile pure-function tests.
//
// The tool is a PURE compute tool (no network / db / io). It reads a price
// close series (and optional dates) from params and emits the running peak,
// max drawdown (with peak/trough indices + dates), recovery bars, current
// drawdown, underwater periods, the Ulcer Index, the pain index, and
// observation flags.
//
// Contract under test:
//  - genuine exceptions  → { success: false }
//  - < 30 valid closes   → { success: true, data: { available: false, reason } }
//  - happy path          → { success: true, data: { available: true, ... } }
//
// The ToolOutput envelope stays success:true for every well-formed (and
// malformed-but-recoverable) input; the result self-reports availability.

async function run(args: Record<string, unknown>) {
  return computeDrawdownProfileTool.execute(args);
}

interface DrawdownData {
  available: boolean;
  reason?: string;
  symbol?: string;
  observations: number;
  maxDrawdown: number;
  maxDrawdownPeakIndex: number;
  maxDrawdownTroughIndex: number;
  maxDrawdownPeakDate: string | null;
  maxDrawdownTroughDate: string | null;
  recoveryBars: number | null;
  currentDrawdown: number;
  underwaterPeriods: Array<{
    startIndex: number;
    endIndex: number;
    depth: number;
    durationBars: number;
  }>;
  ulcerIndex: number;
  painIndex: number;
  flags: string[];
}

// A clean >=30-bar series with a single deep dip then a full recovery so most
// derived fields fire. 50 bars: rise to 130, crash to ~80, recover above 130.
function dipAndRecover(): number[] {
  const out: number[] = [];
  // 0..14 rising 100 → 130
  for (let i = 0; i < 15; i++) out.push(100 + i * 2);
  // 15..24 falling 130 → 80 (the big drawdown)
  for (let i = 0; i < 10; i++) out.push(130 - (i + 1) * 5);
  // 25..49 climbing back from 80 to well above the prior 130 peak
  for (let i = 0; i < 25; i++) out.push(80 + (i + 1) * 3);
  return out;
}

// ─────────────────────────────────────────────────────────────────────────────
// 1. Happy path — envelope success + available, key fields present + typed.
// ─────────────────────────────────────────────────────────────────────────────

test("happy path: success + available, key fields present with correct types", async () => {
  const closes = dipAndRecover();
  const dates = closes.map((_, i) => {
    const day = String((i % 28) + 1).padStart(2, "0");
    return `2024-01-${day}`;
  });

  const r = await run({ closes, dates, symbol: "test" });
  assert.equal(r.success, true);
  const d = r.data as DrawdownData;

  assert.equal(d.available, true);
  // symbol echoed and upper-cased.
  assert.equal(d.symbol, "TEST");

  // observation count == valid closes supplied.
  assert.equal(d.observations, closes.length);

  // numeric fields with the right types.
  assert.equal(typeof d.maxDrawdown, "number");
  assert.equal(typeof d.maxDrawdownPeakIndex, "number");
  assert.equal(typeof d.maxDrawdownTroughIndex, "number");
  assert.equal(typeof d.currentDrawdown, "number");
  assert.equal(typeof d.ulcerIndex, "number");
  assert.equal(typeof d.painIndex, "number");

  // recoveryBars is number | null.
  assert.ok(d.recoveryBars === null || typeof d.recoveryBars === "number");

  // dates supplied → peak/trough dates are strings.
  assert.equal(typeof d.maxDrawdownPeakDate, "string");
  assert.equal(typeof d.maxDrawdownTroughDate, "string");

  // arrays + flags.
  assert.ok(Array.isArray(d.underwaterPeriods));
  assert.ok(Array.isArray(d.flags));

  // sign / range invariants.
  assert.ok(d.maxDrawdown <= 0, `maxDrawdown <= 0, got ${d.maxDrawdown}`);
  assert.ok(d.currentDrawdown <= 0, `currentDrawdown <= 0`);
  assert.ok(d.ulcerIndex >= 0, `ulcerIndex >= 0`);
  assert.ok(d.painIndex >= 0, `painIndex >= 0`);
  assert.ok(d.maxDrawdownTroughIndex >= d.maxDrawdownPeakIndex);

  // The trough is the bottom of the crash (index 24, close 80) anchored to the
  // prior peak (index 14, close 128 = 100 + 14*2). Recovery happens once close
  // reclaims 128.
  assert.equal(d.maxDrawdownPeakIndex, 14);
  assert.equal(d.maxDrawdownTroughIndex, 24);
  // depth = (80-128)/128 = -0.375.
  assert.ok(
    Math.abs(d.maxDrawdown - -0.375) < 1e-3,
    `maxDrawdown ≈ -0.375, got ${d.maxDrawdown}`
  );
  // close climbs to 80 + n*3; reclaims 128 at +48 → n=16 → index 24+16 = 40.
  assert.equal(d.recoveryBars, 16);
  // ended above the prior peak → no current drawdown.
  assert.equal(d.currentDrawdown, 0);
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. KNOWN-VALUE numeric assertion.
//
// Algorithm-level (ignoring the 30-obs production floor):
//   closes = [100, 110, 80, 90, 121]
//   peaks  = [100, 110, 110, 110, 121]
//   dd     = [0, 0, -0.2727, -0.1818, 0]
//   maxDrawdown = -0.2727, peakIndex = 1, troughIndex = 2
//   recoveryBars = 2 (close 121 at index 4 reclaims prior peak 110)
//   currentDrawdown = 0
//   ulcerIndex = sqrt((0.2727^2 + 0.1818^2) / 5) = 0.1466
//   painIndex  = (0.2727 + 0.1818) / 5 = 0.0909
//
// With the 30-obs floor enforced, this 5-element input degrades:
//   available:false, reason names "got 5".
//
// We assert BOTH: the degrade for the real 5-element call, and the
// hand-computed math by replicating the algorithm with tight tolerances on a
// padded series whose first 5 distinct bars match (then a flat run keeps the
// peak fixed so the named drawdown survives the floor).
// ─────────────────────────────────────────────────────────────────────────────

test("known values: 5-element series degrades under the 30-obs floor (got 5)", async () => {
  const r = await run({ closes: [100, 110, 80, 90, 121] });
  assert.equal(r.success, true);
  const d = r.data as DrawdownData;
  assert.equal(d.available, false);
  assert.equal(d.observations, 5);
  assert.ok(
    (d.reason as string).includes("5"),
    `reason should name the count 5, got "${d.reason}"`
  );
});

test("known values: hand-computed drawdown math on a >=30-bar series", async () => {
  // Reproduce the [100,110,80,90,121] profile, then pad with 121 (the running
  // peak) so the extra bars are all at-peak (dd = 0). Those zeros do NOT change
  // maxDrawdown / indices / recovery, but they DO grow the denominator of the
  // Ulcer & pain indices. So we assert the index/recovery/maxDD facts exactly,
  // and the Ulcer/pain numerators against the now-larger N.
  const head = [100, 110, 80, 90, 121];
  const padCount = 30; // total 35 bars, comfortably over the floor
  const closes = [...head, ...Array.from({ length: padCount }, () => 121)];
  const n = closes.length; // 35

  const r = await run({ closes });
  assert.equal(r.success, true);
  const d = r.data as DrawdownData;
  assert.equal(d.available, true);
  assert.equal(d.observations, n);

  // Max drawdown facts are anchored to the head and unaffected by at-peak pads.
  // -10/110 ≈ -0.090909..., -20/110 ≈ -0.181818... ; the deepest is index 2.
  assert.ok(
    Math.abs(d.maxDrawdown - -0.2727) < 5e-4,
    `maxDrawdown ≈ -0.2727, got ${d.maxDrawdown}`
  );
  assert.equal(d.maxDrawdownPeakIndex, 1);
  assert.equal(d.maxDrawdownTroughIndex, 2);
  // close 121 at index 4 reclaims the prior peak (110): 4 - 2 = 2 bars.
  assert.equal(d.recoveryBars, 2);
  // ends at the peak → flat → no current drawdown.
  assert.equal(d.currentDrawdown, 0);

  // Ulcer / pain: only indices 2 & 3 contribute non-zero dd; the rest are 0.
  //   index 2: (80 - 110)/110 = -0.27272727
  //   index 3: (90 - 110)/110 = -0.18181818
  const dd2 = 30 / 110; // 0.27272727
  const dd3 = 20 / 110; // 0.18181818
  const expectedUlcer = Math.sqrt((dd2 * dd2 + dd3 * dd3) / n);
  const expectedPain = (dd2 + dd3) / n;
  // Tool rounds these to 4dp; compare against rounded expectations.
  const round4 = (x: number) => Math.round(x * 1e4) / 1e4;
  assert.ok(
    Math.abs(d.ulcerIndex - round4(expectedUlcer)) < 5e-5,
    `ulcerIndex ≈ ${round4(expectedUlcer)}, got ${d.ulcerIndex}`
  );
  assert.ok(
    Math.abs(d.painIndex - round4(expectedPain)) < 5e-5,
    `painIndex ≈ ${round4(expectedPain)}, got ${d.painIndex}`
  );

  // Sanity-check the exact algorithm-level numbers the spec calls out, over the
  // ORIGINAL 5-bar series, by replaying the math the tool runs (drawdown series
  // = [0,0,-0.2727,-0.1818,0]).
  const headDD = [0, 0, -(30 / 110), -(20 / 110), 0];
  const headUlcer = Math.sqrt(
    headDD.reduce((s, x) => s + x * x, 0) / headDD.length
  );
  const headPain = headDD.reduce((s, x) => s + Math.abs(x), 0) / headDD.length;
  assert.ok(
    Math.abs(headUlcer - 0.1466) < 5e-4,
    `spec headUlcer ≈ 0.1466, got ${headUlcer}`
  );
  assert.ok(
    Math.abs(headPain - 0.0909) < 5e-4,
    `spec headPain ≈ 0.0909, got ${headPain}`
  );
});

// ─────────────────────────────────────────────────────────────────────────────
// 3. Graceful degradation — available:false (NOT success:false) on thin data.
// ─────────────────────────────────────────────────────────────────────────────

test("graceful degrade: < 30 valid closes → success:true, available:false, reason names count", async () => {
  const closes = Array.from({ length: 10 }, (_, i) => 100 + i);

  const r = await run({ closes });
  // NOT a thrown exception — the envelope stays success:true.
  assert.equal(r.success, true);
  const d = r.data as DrawdownData;

  assert.equal(d.available, false);
  assert.equal(typeof d.reason, "string");
  assert.equal(d.observations, 10);
  assert.ok(
    (d.reason as string).includes("10"),
    `reason should name the count 10, got "${d.reason}"`
  );
  assert.ok(
    (d.reason as string).includes("30"),
    `reason should name the 30-obs floor, got "${d.reason}"`
  );
  // Degraded payload is fully formed (no undefined fields blow up consumers).
  assert.equal(d.maxDrawdown, 0);
  assert.equal(d.maxDrawdownPeakIndex, -1);
  assert.equal(d.maxDrawdownTroughIndex, -1);
  assert.equal(d.recoveryBars, null);
  assert.equal(d.currentDrawdown, 0);
  assert.deepEqual(d.underwaterPeriods, []);
  assert.equal(d.ulcerIndex, 0);
  assert.equal(d.painIndex, 0);
  assert.deepEqual(d.flags, []);
});

test("graceful degrade: non-finite / non-positive closes are dropped before the 30 gate", async () => {
  // 29 valid positives + junk that must be filtered → still < 30.
  const valid = Array.from({ length: 29 }, (_, i) => 100 + i);
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
  const d = r.data as DrawdownData;
  assert.equal(d.available, false);
  // Only 29 survived the finite-&-positive filter.
  assert.equal(d.observations, 29);
  assert.ok(
    (d.reason as string).includes("29"),
    `reason should report 29 valid closes, got "${d.reason}"`
  );
});

// ─────────────────────────────────────────────────────────────────────────────
// 4. Edge cases — must not throw / must remain well-formed.
// ─────────────────────────────────────────────────────────────────────────────

test("edge: empty closes → available:false (count 0), no throw", async () => {
  const r = await run({ closes: [] });
  assert.equal(r.success, true);
  const d = r.data as DrawdownData;
  assert.equal(d.available, false);
  assert.equal(d.observations, 0);
  assert.ok((d.reason as string).includes("0"));
});

test("edge: missing closes param → treated as empty, available:false, no throw", async () => {
  const r = await run({});
  assert.equal(r.success, true);
  const d = r.data as DrawdownData;
  assert.equal(d.available, false);
  assert.equal(d.observations, 0);
});

test("edge: closes not an array (object) → treated as empty, available:false", async () => {
  const r = await run({ closes: { not: "an array" } });
  assert.equal(r.success, true);
  const d = r.data as DrawdownData;
  assert.equal(d.available, false);
  assert.equal(d.observations, 0);
});

test("edge: all-zero / all-negative closes are filtered → available:false", async () => {
  const r = await run({
    closes: [0, 0, 0, -1, -2, -3, 0, 0, 0, 0],
  });
  assert.equal(r.success, true);
  const d = r.data as DrawdownData;
  assert.equal(d.available, false);
  // Every value non-positive → 0 valid observations.
  assert.equal(d.observations, 0);
});

test("edge: flat constant series (>=30 bars) → zero drawdown everywhere, no throw", async () => {
  const closes = Array.from({ length: 40 }, () => 100);

  const r = await run({ closes });
  assert.equal(r.success, true);
  const d = r.data as DrawdownData;
  assert.equal(d.available, true);
  // Never falls below the running peak → all drawdown metrics zero.
  assert.equal(d.maxDrawdown, 0);
  assert.equal(d.currentDrawdown, 0);
  assert.equal(d.ulcerIndex, 0);
  assert.equal(d.painIndex, 0);
  // maxDrawdown never updated → peak/trough both stay at index 0. The recovery
  // loop starts at index 1, where the flat close already "reclaims" the peak,
  // so recoveryBars resolves to 1 (a degenerate but well-formed result).
  assert.equal(d.recoveryBars, 1);
  // No underwater stretch ever opened.
  assert.deepEqual(d.underwaterPeriods, []);
  // "at or above prior peak" observation flag should fire.
  assert.ok(
    d.flags.some((f) => f.toLowerCase().includes("at or above")),
    `expected an at-or-above-peak flag, got ${JSON.stringify(d.flags)}`
  );
});

test("edge: dates omitted → peak/trough dates null but result still available", async () => {
  const closes = dipAndRecover();
  const r = await run({ closes }); // no dates supplied
  assert.equal(r.success, true);
  const d = r.data as DrawdownData;
  assert.equal(d.available, true);
  assert.equal(d.maxDrawdownPeakDate, null);
  assert.equal(d.maxDrawdownTroughDate, null);
});

test("edge: never recovers (monotone decline) → recoveryBars null + still-underwater flag", async () => {
  // 35 strictly falling bars: peak is bar 0, the trough is the last bar, never
  // reclaims the prior peak inside the window.
  const closes = Array.from({ length: 35 }, (_, i) => 200 - i * 2);

  const r = await run({ closes });
  assert.equal(r.success, true);
  const d = r.data as DrawdownData;
  assert.equal(d.available, true);
  assert.equal(d.maxDrawdownPeakIndex, 0);
  assert.equal(d.maxDrawdownTroughIndex, closes.length - 1);
  assert.equal(d.recoveryBars, null);
  // Current drawdown is the deepest point at the end of a one-way slide.
  assert.ok(d.currentDrawdown < 0);
  assert.ok(
    Math.abs(d.currentDrawdown - d.maxDrawdown) < 1e-9,
    "for a monotone decline, current == max drawdown"
  );
  assert.ok(
    d.flags.some((f) => f.toLowerCase().includes("not yet recovered")),
    `expected a not-yet-recovered flag, got ${JSON.stringify(d.flags)}`
  );
});

test("edge: missing optional symbol → symbol undefined, no throw", async () => {
  const closes = dipAndRecover();
  const r = await run({ closes });
  assert.equal(r.success, true);
  const d = r.data as DrawdownData;
  assert.equal(d.symbol, undefined);
  assert.equal(d.available, true);
});

test("edge: empty-string symbol → coalesced to undefined", async () => {
  const closes = dipAndRecover();
  const r = await run({ closes, symbol: "" });
  assert.equal(r.success, true);
  const d = r.data as DrawdownData;
  assert.equal(d.symbol, undefined);
  assert.equal(d.available, true);
});
