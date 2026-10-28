import { test } from "node:test";
import assert from "node:assert/strict";

import { detectBreakoutSetupsTool } from "../../../../packages/research/src/tools/detect-breakout-setups";

// MONEY-543 - detect-breakout-setups pure-function tests.
//
// The tool is a PURE compute tool (no network / db / io). It reads closes /
// highs / lows / volumes from params and emits rolling resistance/support
// (Donchian + 52w extremes), range/consolidation tightness (ATR%), volume
// confirmation, 52w-high proximity, and NR7 / inside-bar contraction — as
// observations + confidence SCORES only (no buy/sell advice).
//
// Contract under test:
//  - genuine exceptions      → { success: false, error }
//  - too little data (<30)   → { success: true, data: { available: false, reason } }
//  - happy path              → { success: true, data: { available: true, ... } }

interface BreakoutSetup {
  type: string;
  observation: string;
  level: number;
  distancePct: number;
  volumeConfirmed: boolean;
  confidence: number;
}

interface BreakoutData {
  available: boolean;
  reason?: string;
  symbol?: string;
  lastClose?: number;
  nearestResistance?: number;
  nearestSupport?: number;
  rangeBoundPct?: number;
  atrPercent?: number;
  fiftyTwoWeekHigh?: number;
  fiftyTwoWeekLow?: number;
  setups?: BreakoutSetup[];
  lookback?: number;
  textSummary?: string;
}

async function run(args: Record<string, unknown>) {
  return detectBreakoutSetupsTool.execute(args);
}

// A clean, deterministic uptrend with matching highs/lows + volume. 60 bars so
// every guard path (channel, ATR window, NR7, inside bar, 52w) has data.
function uptrendBars(length = 60) {
  const closes: number[] = [];
  const highs: number[] = [];
  const lows: number[] = [];
  const volumes: number[] = [];
  for (let i = 0; i < length; i++) {
    const c = 100 + i * 0.5;
    closes.push(c);
    highs.push(c + 1);
    lows.push(c - 1);
    volumes.push(1000);
  }
  return { closes, highs, lows, volumes };
}

// ─────────────────────────────────────────────────────────────────────────────
// 1. Happy path — success + available, key fields present with correct types.
// ─────────────────────────────────────────────────────────────────────────────

test("happy path: success + available, key fields present with correct types", async () => {
  const { closes, highs, lows, volumes } = uptrendBars(60);

  const r = await run({ closes, highs, lows, volumes, symbol: "TEST" });
  assert.equal(r.success, true);
  const d = r.data as BreakoutData;

  assert.equal(d.available, true);
  assert.equal(d.symbol, "TEST");

  // numeric fields present + typed
  assert.equal(typeof d.lastClose, "number");
  assert.equal(typeof d.nearestResistance, "number");
  assert.equal(typeof d.nearestSupport, "number");
  assert.equal(typeof d.rangeBoundPct, "number");
  assert.equal(typeof d.atrPercent, "number");
  assert.equal(typeof d.fiftyTwoWeekHigh, "number");
  assert.equal(typeof d.fiftyTwoWeekLow, "number");
  assert.equal(typeof d.lookback, "number");
  assert.equal(typeof d.textSummary, "string");

  // setups is an array of well-formed objects, sorted highest-confidence first
  assert.ok(Array.isArray(d.setups));
  for (const s of d.setups!) {
    assert.equal(typeof s.type, "string");
    assert.equal(typeof s.observation, "string");
    assert.equal(typeof s.level, "number");
    assert.equal(typeof s.distancePct, "number");
    assert.equal(typeof s.volumeConfirmed, "boolean");
    assert.equal(typeof s.confidence, "number");
    assert.ok(
      s.confidence >= 0 && s.confidence <= 1,
      `confidence in [0,1], got ${s.confidence}`
    );
  }
  for (let i = 1; i < d.setups!.length; i++) {
    assert.ok(
      d.setups![i - 1]!.confidence >= d.setups![i]!.confidence,
      "setups sorted by descending confidence"
    );
  }

  // default lookback is 20
  assert.equal(d.lookback, 20);
  // last close = 100 + 59*0.5 = 129.5
  assert.equal(d.lastClose, 129.5);

  // metadata sanity
  const meta = r.metadata as Record<string, unknown>;
  assert.equal(meta.barsAnalyzed, 60);
  assert.equal(meta.volumeDataProvided, true);
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. KNOWN-VALUE numeric assertion (runtime-verified).
//    30 bars. Bars 1-29 (idx 0..28): close oscillates 97/99, high=100, low=95,
//    volume=1000. Bar 30 (idx 29): close=110, high=112, low=101, volume=3000.
//    lookback=20.
//
//    Verified output:
//      available = true
//      lastClose = 110
//      nearestResistance = 112  (close 110 > 20-bar channel resistance 100 →
//                                falls back to 52w high = max(highs) = 112)
//      nearestSupport = 95      (close 110 >= support 95 → channel support)
//      setups[0] = {
//        type: "breakout_above_resistance",
//        level: 100,
//        distancePct: 10,             // (110-100)/100*100
//        volumeConfirmed: true,       // 3000/1000 = 3x > 1.5
//        confidence: 0.95,            // 0.5 + min(0.25, 10/20=0.5)=0.25 + 0.2 vol
//      }
// ─────────────────────────────────────────────────────────────────────────────

test("known values: decisive resistance breakout with volume confirmation", async () => {
  const closes: number[] = [];
  const highs: number[] = [];
  const lows: number[] = [];
  const volumes: number[] = [];
  for (let i = 0; i < 29; i++) {
    closes.push(i % 2 === 0 ? 97 : 99);
    highs.push(100);
    lows.push(95);
    volumes.push(1000);
  }
  // The breakout bar.
  closes.push(110);
  highs.push(112);
  lows.push(101);
  volumes.push(3000);

  const r = await run({ closes, highs, lows, volumes, lookback: 20 });
  assert.equal(r.success, true);
  const d = r.data as BreakoutData;

  assert.equal(d.available, true);
  assert.equal(d.lastClose, 110);

  // nearestResistance falls back to the 52w high (112) because the last close
  // already cleared the 20-bar channel resistance (100).
  assert.equal(d.nearestResistance, 112);
  assert.equal(d.nearestSupport, 95);
  assert.equal(d.fiftyTwoWeekHigh, 112);
  assert.equal(d.fiftyTwoWeekLow, 95);

  // The strongest setup is the resistance breakout.
  const top = d.setups![0]!;
  assert.equal(top.type, "breakout_above_resistance");
  assert.equal(top.level, 100);
  assert.ok(
    Math.abs(top.distancePct - 10) < 1e-9,
    `distancePct=10, got ${top.distancePct}`
  );
  assert.equal(top.volumeConfirmed, true);
  assert.ok(
    Math.abs(top.confidence - 0.95) < 1e-9,
    `confidence=0.95 (0.5 + 0.25 + 0.2), got ${top.confidence}`
  );
});

test("known values: SAME setup without volume drops confidence to 0.75", async () => {
  // Identical price geometry, but no volumes supplied → volumeConfirmed false,
  // confidence = 0.5 + 0.25 = 0.75 (the +0.2 volume bonus is withheld).
  const closes: number[] = [];
  const highs: number[] = [];
  const lows: number[] = [];
  for (let i = 0; i < 29; i++) {
    closes.push(i % 2 === 0 ? 97 : 99);
    highs.push(100);
    lows.push(95);
  }
  closes.push(110);
  highs.push(112);
  lows.push(101);

  const r = await run({ closes, highs, lows, lookback: 20 });
  assert.equal(r.success, true);
  const d = r.data as BreakoutData;

  const top = d.setups!.find((s) => s.type === "breakout_above_resistance")!;
  assert.equal(top.volumeConfirmed, false);
  assert.ok(
    Math.abs(top.confidence - 0.75) < 1e-9,
    `confidence=0.75 without volume, got ${top.confidence}`
  );
});

// ─────────────────────────────────────────────────────────────────────────────
// 3. Graceful degradation — available:false (NOT success:false) on thin data.
//    The synthesizer renders an honest "—" instead of fabricating levels.
// ─────────────────────────────────────────────────────────────────────────────

test("graceful degrade: < 30 bars → success:true, available:false, reason names count", async () => {
  const closes = Array.from({ length: 10 }, (_, i) => 100 + i);
  const highs = closes.map((c) => c + 1);
  const lows = closes.map((c) => c - 1);

  const r = await run({ closes, highs, lows, symbol: "THIN" });
  // NOT a thrown exception — success stays true, the result self-reports.
  assert.equal(r.success, true);
  const d = r.data as BreakoutData;

  assert.equal(d.available, false);
  assert.equal(typeof d.reason, "string");
  assert.ok(
    (d.reason as string).includes("10"),
    `reason should name the count 10, got "${d.reason}"`
  );
  assert.ok(
    (d.reason as string).toLowerCase().includes("insufficient"),
    `reason should explain insufficiency, got "${d.reason}"`
  );
  // symbol is echoed even on the degraded path (for rendering context).
  assert.equal(d.symbol, "THIN");
  // No fabricated levels.
  assert.equal(d.setups, undefined);
  assert.equal(d.nearestResistance, undefined);
});

test("graceful degrade: exactly 29 valid bars is still below the 30 gate", async () => {
  const closes = Array.from({ length: 29 }, (_, i) => 100 + i);
  const r = await run({ closes });
  assert.equal(r.success, true);
  const d = r.data as BreakoutData;
  assert.equal(d.available, false);
  assert.ok((d.reason as string).includes("29"));
});

test("graceful degrade: non-finite closes are dropped before the 30 gate", async () => {
  // 29 valid + junk that must be filtered out → still < 30 valid bars.
  // NOTE: toNumberArray keeps anything Number()-coercible to a finite value
  // (so `null`→0 and `""`→0 would survive). We use only genuinely non-finite
  // entries here so the surviving count stays at 29.
  const valid = Array.from({ length: 29 }, (_, i) => 100 + i);
  const closes = [
    ...valid,
    Number.NaN,
    Number.POSITIVE_INFINITY,
    Number.NEGATIVE_INFINITY,
    "oops",
    undefined,
  ];

  const r = await run({ closes });
  assert.equal(r.success, true);
  const d = r.data as BreakoutData;
  assert.equal(d.available, false);
  assert.ok(
    (d.reason as string).includes("29"),
    `reason should report 29 surviving closes, got "${d.reason}"`
  );
});

// ─────────────────────────────────────────────────────────────────────────────
// 4. Edge cases — must not throw / must remain well-formed.
// ─────────────────────────────────────────────────────────────────────────────

test("edge: missing closes param → available:false (count 0), no throw", async () => {
  const r = await run({});
  assert.equal(r.success, true);
  const d = r.data as BreakoutData;
  assert.equal(d.available, false);
  assert.ok((d.reason as string).includes("0"));
});

test("edge: empty arrays → available:false (count 0), no throw", async () => {
  const r = await run({ closes: [], highs: [], lows: [], volumes: [] });
  assert.equal(r.success, true);
  const d = r.data as BreakoutData;
  assert.equal(d.available, false);
  assert.ok((d.reason as string).includes("0"));
});

test("edge: closes not an array (object) → treated as empty, available:false", async () => {
  const r = await run({ closes: { not: "an array" } });
  assert.equal(r.success, true);
  const d = r.data as BreakoutData;
  assert.equal(d.available, false);
});

test("edge: highs/lows misaligned with closes → falls back to close, still available", async () => {
  // 40 closes but shorter highs/lows → tool falls back to using closes as
  // highs/lows (no throw), result still available.
  const closes = Array.from({ length: 40 }, (_, i) => 100 + i * 0.5);
  const highs = closes.slice(0, 20).map((c) => c + 1);
  const lows = closes.slice(0, 20).map((c) => c - 1);

  const r = await run({ closes, highs, lows });
  assert.equal(r.success, true);
  const d = r.data as BreakoutData;
  assert.equal(d.available, true);
  assert.equal(typeof d.lastClose, "number");
  assert.ok(Array.isArray(d.setups));
});

test("edge: zero / negative prices do not throw and stay well-formed", async () => {
  // toNumberArray keeps 0 and negatives (only non-finite dropped). The guards
  // (resistance > 0, support > 0, lastClose > 0) simply skip; no crash.
  const closes = Array.from({ length: 35 }, (_, i) => (i < 17 ? 0 : -5));
  const highs = closes.map((c) => c + 1);
  const lows = closes.map((c) => c - 1);

  const r = await run({ closes, highs, lows });
  assert.equal(r.success, true);
  const d = r.data as BreakoutData;
  assert.equal(d.available, true);
  // lastClose <= 0 → atrPercent guarded to 0, no division-by-zero blow-up.
  assert.equal(typeof d.atrPercent, "number");
  assert.ok(Array.isArray(d.setups));
});

test("edge: oversized lookback is clamped to (bars - 1)", async () => {
  const { closes, highs, lows } = uptrendBars(35);
  const r = await run({ closes, highs, lows, lookback: 9999 });
  assert.equal(r.success, true);
  const d = r.data as BreakoutData;
  assert.equal(d.available, true);
  assert.equal(d.lookback, 34); // min(9999, 35 - 1)
});

test("edge: invalid / non-numeric lookback falls back to default 20", async () => {
  const { closes, highs, lows } = uptrendBars(60);

  const bad = await run({ closes, highs, lows, lookback: "not-a-number" });
  assert.equal(bad.success, true);
  assert.equal((bad.data as BreakoutData).lookback, 20);

  // Tiny lookback is floored to a minimum of 2.
  const tiny = await run({ closes, highs, lows, lookback: 1 });
  assert.equal(tiny.success, true);
  assert.equal((tiny.data as BreakoutData).lookback, 2);
});

test("edge: missing optional symbol + missing volumes → no throw, no volume confirm", async () => {
  const { closes, highs, lows } = uptrendBars(40);
  const r = await run({ closes, highs, lows });
  assert.equal(r.success, true);
  const d = r.data as BreakoutData;
  assert.equal(d.symbol, undefined);
  assert.equal(d.available, true);
  // Without volumes, no setup may be volume-confirmed.
  for (const s of d.setups!) {
    assert.equal(s.volumeConfirmed, false);
  }
  assert.equal(
    (r.metadata as Record<string, unknown>).volumeDataProvided,
    false
  );
});

test("edge: flat constant series (>=30 bars) → consolidation setup, no throw", async () => {
  // Constant prices → zero ATR / zero channel width → range-bound behaviour.
  const closes = Array.from({ length: 40 }, () => 100);
  const highs = closes.map((c) => c);
  const lows = closes.map((c) => c);

  const r = await run({ closes, highs, lows });
  assert.equal(r.success, true);
  const d = r.data as BreakoutData;
  assert.equal(d.available, true);
  // channelWidth = 0 → rangeBoundPct defaults to 50.
  assert.equal(d.rangeBoundPct, 50);
  assert.equal(d.atrPercent, 0);
  assert.ok(Array.isArray(d.setups));
});
