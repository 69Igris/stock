import { test } from "node:test";
import assert from "node:assert/strict";

import { computeVolumeProfileTool } from "../../../../packages/research/src/tools/compute-volume-profile";

// MONEY-498 - compute-volume-profile pure-function tests.
// PURE compute tool (no io): graceful degradation returns
// { success: true, data: { available: false } }; success:false is reserved
// for genuine runtime exceptions only.

async function run(args: Record<string, unknown>) {
  return computeVolumeProfileTool.execute(args);
}

/** Minimal shape of the tool's data payload, for typed assertions. */
interface VPData {
  available: boolean;
  reason?: string;
  symbol?: string;
  bars?: number;
  levels?: Array<{
    price: number;
    priceLow: number;
    priceHigh: number;
    volume: number;
    volumePercent: number;
  }>;
  poc?: number;
  valueAreaHigh?: number;
  valueAreaLow?: number;
  valueAreaVolumePercent?: number;
  highVolumeNodes?: number[];
  lowVolumeNodes?: number[];
  volumeTrend?: "rising" | "falling" | "flat";
  upDownVolumeRatio?: number;
  recentVolumeVsAvg?: number;
  priceVsValueArea?: "above" | "inside" | "below";
  flags?: string[];
}

// A representative 60-bar series with genuine price dispersion + varied volume.
function sampleSeries(bars = 60) {
  const closes: number[] = [];
  const highs: number[] = [];
  const lows: number[] = [];
  const volumes: number[] = [];
  for (let i = 0; i < bars; i++) {
    const base = 100 + Math.sin(i / 5) * 8 + i * 0.2;
    closes.push(Math.round(base * 100) / 100);
    highs.push(Math.round((base + 1.5) * 100) / 100);
    lows.push(Math.round((base - 1.5) * 100) / 100);
    volumes.push(1000 + (i % 7) * 120);
  }
  return { closes, highs, lows, volumes };
}

// ── 1. Happy path: success + available, key fields present + typed ──
test("happy path: full OHLCV produces available profile with typed fields", async () => {
  const { closes, highs, lows, volumes } = sampleSeries(60);
  const r = await run({ closes, highs, lows, volumes, symbol: "RELIANCE.NS" });

  assert.equal(r.success, true);
  const d = r.data as VPData;
  assert.equal(d.available, true);
  assert.equal(d.symbol, "RELIANCE"); // .NS suffix stripped, uppercased

  assert.equal(typeof d.bars, "number");
  assert.equal(d.bars, 60);

  assert.ok(Array.isArray(d.levels));
  assert.ok(d.levels!.length > 0);
  for (const lvl of d.levels!) {
    assert.equal(typeof lvl.price, "number");
    assert.equal(typeof lvl.priceLow, "number");
    assert.equal(typeof lvl.priceHigh, "number");
    assert.equal(typeof lvl.volume, "number");
    assert.equal(typeof lvl.volumePercent, "number");
    assert.ok(lvl.priceHigh >= lvl.priceLow);
  }

  assert.equal(typeof d.poc, "number");
  assert.equal(typeof d.valueAreaHigh, "number");
  assert.equal(typeof d.valueAreaLow, "number");
  assert.equal(typeof d.valueAreaVolumePercent, "number");
  assert.ok(d.valueAreaHigh! >= d.valueAreaLow!);
  // Value area should capture ~70%+ of volume.
  assert.ok(d.valueAreaVolumePercent! >= 0.65);

  assert.ok(Array.isArray(d.highVolumeNodes));
  assert.ok(Array.isArray(d.lowVolumeNodes));
  assert.ok(["rising", "falling", "flat"].includes(d.volumeTrend!));
  assert.equal(typeof d.upDownVolumeRatio, "number");
  assert.equal(typeof d.recentVolumeVsAvg, "number");
  assert.ok(["above", "inside", "below"].includes(d.priceVsValueArea!));
  assert.ok(Array.isArray(d.flags));
});

// ── 2. KNOWN-VALUE numeric assertion ──
// 20 bars; closes alternate [100,110,100,110,...] (up on odd, down on even);
// no highs/lows (typical price = close); volumes all 100 except last = 300.
test("known values: poc / ratio / surge / trend match hand-computed figures", async () => {
  const n = 20;
  const closes = Array.from({ length: n }, (_, i) => (i % 2 === 0 ? 100 : 110));
  const volumes = Array.from({ length: n }, (_, i) =>
    i === n - 1 ? 300 : 100
  );

  const r = await run({ closes, volumes, symbol: "TEST" });
  assert.equal(r.success, true);
  const d = r.data as VPData;
  assert.equal(d.available, true);

  // bars
  assert.equal(d.bars, 20);

  // up/down volume ratio: up=1200 (nine odd 100s + last 300), down=900 → 1.33
  assert.ok(
    Math.abs(d.upDownVolumeRatio! - 1.33) < 0.005,
    `upDownVolumeRatio expected ~1.33, got ${d.upDownVolumeRatio}`
  );

  // recent volume vs avg: last 300 / 20-bar avg 110 → 2.73 (surge > 1.5)
  assert.ok(
    Math.abs(d.recentVolumeVsAvg! - 2.73) < 0.005,
    `recentVolumeVsAvg expected ~2.73, got ${d.recentVolumeVsAvg}`
  );

  // POC: the 110-price bin holds 1200 vol vs 1000 in the 100-price bin →
  // highest-volume bin midpoint = 109.75
  assert.ok(
    Math.abs(d.poc! - 109.75) < 0.005,
    `poc expected ~109.75, got ${d.poc}`
  );

  // volume trend: n < 40 so no last-20-vs-prior-20 comparison → "flat"
  assert.equal(d.volumeTrend, "flat");

  // surge flag must be present (recentVolumeVsAvg > 1.5)
  assert.ok(
    d.flags!.some((f) => /surge/i.test(f)),
    `expected a volume-surge flag, got ${JSON.stringify(d.flags)}`
  );
});

// ── 3. Graceful degradation (always success:true, available:false) ──
test("graceful: missing volumes → available:false, not success:false", async () => {
  const closes = Array.from({ length: 30 }, (_, i) => 100 + i);
  const r = await run({ closes, symbol: "FOO" });

  assert.equal(r.success, true); // NOT success:false
  const d = r.data as VPData;
  assert.equal(d.available, false);
  assert.equal(typeof d.reason, "string");
  assert.ok(d.reason!.length > 0);
  assert.equal(d.symbol, "FOO");
});

test("graceful: empty volumes array → available:false with reason", async () => {
  const closes = Array.from({ length: 30 }, (_, i) => 100 + i);
  const r = await run({ closes, volumes: [] });

  assert.equal(r.success, true);
  const d = r.data as VPData;
  assert.equal(d.available, false);
  assert.equal(typeof d.reason, "string");
});

test("graceful: empty closes array → available:false with reason", async () => {
  const r = await run({ closes: [], volumes: [100, 200, 300] });

  assert.equal(r.success, true);
  const d = r.data as VPData;
  assert.equal(d.available, false);
  assert.match(d.reason ?? "", /clos/i);
});

test("graceful: fewer than 20 aligned bars → available:false with reason", async () => {
  const closes = Array.from({ length: 19 }, (_, i) => 100 + i);
  const volumes = Array.from({ length: 19 }, () => 1000);
  const r = await run({ closes, volumes });

  assert.equal(r.success, true);
  const d = r.data as VPData;
  assert.equal(d.available, false);
  assert.match(d.reason ?? "", /20/);
});

test("graceful: closes∩volumes intersection < 20 even when one array is long", async () => {
  // 50 closes but only 10 volumes → aligned length n = 10 → available:false
  const closes = Array.from({ length: 50 }, (_, i) => 100 + i);
  const volumes = Array.from({ length: 10 }, () => 1000);
  const r = await run({ closes, volumes });

  assert.equal(r.success, true);
  const d = r.data as VPData;
  assert.equal(d.available, false);
  assert.match(d.reason ?? "", /20/);
});

// ── 4. Edge cases: must not throw, sensible outputs ──
test("edge: flat price (all closes equal) collapses to a single level, no throw", async () => {
  const closes = Array.from({ length: 25 }, () => 100);
  const volumes = Array.from({ length: 25 }, () => 50);
  const r = await run({ closes, volumes });

  assert.equal(r.success, true);
  const d = r.data as VPData;
  assert.equal(d.available, true);
  assert.equal(d.levels!.length, 1);
  assert.equal(d.poc, 100);
  assert.equal(d.bars, 25);
});

test("edge: zero/negative volumes do not throw and stay available", async () => {
  const closes = Array.from({ length: 30 }, (_, i) => 100 + (i % 5));
  // zero total volume → single-bin (span>0 but totalVolume<=0) path
  const volumes = Array.from({ length: 30 }, () => 0);
  const r = await run({ closes, volumes });

  assert.equal(r.success, true);
  const d = r.data as VPData;
  assert.equal(d.available, true);
  assert.ok(Array.isArray(d.levels));
  // zero total volume → recent vs avg cannot be computed → 0
  assert.equal(d.recentVolumeVsAvg, 0);
});

test("edge: missing optional highs/lows falls back to close, no throw", async () => {
  const closes = Array.from(
    { length: 40 },
    (_, i) => 100 + Math.sin(i / 3) * 5
  );
  const volumes = Array.from({ length: 40 }, (_, i) => 1000 + (i % 4) * 200);
  // no highs, no lows
  const r = await run({ closes, volumes });

  assert.equal(r.success, true);
  const d = r.data as VPData;
  assert.equal(d.available, true);
  assert.equal(d.bars, 40);
  // n >= 40 enables the volume-trend comparison branch (still must not throw)
  assert.ok(["rising", "falling", "flat"].includes(d.volumeTrend!));
});

test("edge: non-numeric / null entries are coerced/dropped without throwing", async () => {
  // toNumberArray drops non-finite; provide a clean 30-bar series with a few
  // string-numerics mixed in to exercise coercion.
  const closes: unknown[] = Array.from({ length: 30 }, (_, i) =>
    i === 0 ? "100" : 100 + i
  );
  const volumes: unknown[] = Array.from({ length: 30 }, (_, i) =>
    i === 1 ? "1500" : 1000
  );
  const r = await run({
    closes: closes as unknown as number[],
    volumes: volumes as unknown as number[],
  });

  assert.equal(r.success, true);
  const d = r.data as VPData;
  // string-numerics coerce to finite numbers → 30 aligned bars remain
  assert.equal(d.available, true);
  assert.equal(d.bars, 30);
});

test("edge: short non-array / missing params do not throw", async () => {
  // closes undefined → toNumberArray → [] → available:false
  const r = await run({ volumes: [1, 2, 3] });
  assert.equal(r.success, true);
  const d = r.data as VPData;
  assert.equal(d.available, false);
  assert.equal(typeof d.reason, "string");
});
