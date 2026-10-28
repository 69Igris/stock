/**
 * Altman Z″-Score Tool Tests
 * (packages/research/src/tools/compute-altman-z.ts)
 *
 * Pure compute tool — no network/db/io. Exercises the public
 * `computeAltmanZTool.execute(args)` contract:
 *   1. Tool metadata sanity.
 *   2. Known-value numeric assertion (hand-computed Z″) + zone.
 *   3. Distress-zone case.
 *   4. Graceful degradation → success:true + data.available:false + reason.
 *   5. Edge cases (zero denominator, empty params) — no throw.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { computeAltmanZTool } from "../../../../packages/research/src/tools/compute-altman-z";

interface AltmanData {
  available: boolean;
  reason?: string;
  symbol?: string;
  score?: number;
  zone?: "safe" | "grey" | "distress";
  model?: string;
  components?: Array<{
    key: string;
    label: string;
    value: number;
    weight: number;
  }>;
  flags?: string[];
}

async function run(args: Record<string, unknown>) {
  return computeAltmanZTool.execute(args);
}

const APPROX = 1e-9;
function near(a: number, b: number, tol = APPROX): boolean {
  return Math.abs(a - b) <= tol;
}

// ── 1. Metadata ────────────────────────────────────────────────────

test("tool exposes expected metadata", () => {
  assert.equal(computeAltmanZTool.name, "compute_altman_z");
  assert.equal(computeAltmanZTool.category, "computation");
  assert.equal(typeof computeAltmanZTool.execute, "function");
});

// ── 2. Known-value: Z″ = 8.45 (safe) ───────────────────────────────
// X1=(300-100)/1000=0.2, X2=400/1000=0.4, X3=150/1000=0.15, X4=600/400=1.5
// Z = 3.25 + 6.56*0.2 + 3.26*0.4 + 6.72*0.15 + 1.05*1.5 = 8.449 → 8.45

test("known-value: healthy balance sheet → Z 8.45, safe zone", async () => {
  const r = await run({
    symbol: "tcs.ns",
    currentAssets: 300,
    currentLiabilities: 100,
    totalAssets: 1000,
    retainedEarnings: 400,
    ebit: 150,
    totalEquity: 600,
    totalLiabilities: 400,
  });

  assert.equal(r.success, true);
  const data = r.data as AltmanData;
  assert.equal(data.available, true);
  assert.equal(data.symbol, "TCS"); // normalized
  assert.ok(near(data.score!, 8.45, 1e-9), `score=${data.score}`);
  assert.equal(data.zone, "safe");
  assert.equal(data.components?.length, 4);
  assert.ok(Array.isArray(data.flags) && data.flags!.length > 0);
  // Component values rounded to 3dp.
  const x1 = data.components!.find(
    (c) => c.key === "working_capital_to_assets"
  );
  assert.ok(near(x1!.value, 0.2, 1e-9));
});

// ── 3. Distress-zone case (Z < 1.1) ────────────────────────────────
// X1=-0.15, X2=-0.4, X3=-0.05, X4=10/990≈0.0101 → Z ≈ 0.64

test("distress: weak balance sheet → distress zone", async () => {
  const r = await run({
    currentAssets: 50,
    currentLiabilities: 200,
    totalAssets: 1000,
    retainedEarnings: -400,
    ebit: -50,
    totalEquity: 10,
    totalLiabilities: 990,
  });

  assert.equal(r.success, true);
  const data = r.data as AltmanData;
  assert.equal(data.available, true);
  assert.ok(data.score! < 1.1, `score=${data.score}`);
  assert.equal(data.zone, "distress");
  assert.ok(data.flags!.some((f) => /distress/i.test(f)));
});

// ── 4. Graceful degradation ────────────────────────────────────────

test("graceful: missing retained earnings → available:false with reason", async () => {
  const r = await run({
    currentAssets: 300,
    currentLiabilities: 100,
    totalAssets: 1000,
    // retainedEarnings missing
    ebit: 150,
    totalEquity: 600,
    totalLiabilities: 400,
  });

  assert.equal(r.success, true); // NOT success:false
  const data = r.data as AltmanData;
  assert.equal(data.available, false);
  assert.equal(typeof data.reason, "string");
  assert.ok(/retained earnings/i.test(data.reason!));
});

// ── 5. Edge cases — must not throw ─────────────────────────────────

test("edge: zero total assets → available:false (no divide-by-zero)", async () => {
  const r = await run({
    currentAssets: 300,
    currentLiabilities: 100,
    totalAssets: 0,
    retainedEarnings: 400,
    ebit: 150,
    totalEquity: 600,
    totalLiabilities: 400,
  });
  assert.equal(r.success, true);
  assert.equal((r.data as AltmanData).available, false);
});

test("edge: zero total liabilities → X4 undefined → available:false", async () => {
  const r = await run({
    currentAssets: 300,
    currentLiabilities: 100,
    totalAssets: 1000,
    retainedEarnings: 400,
    ebit: 150,
    totalEquity: 600,
    totalLiabilities: 0,
  });
  assert.equal(r.success, true);
  assert.equal((r.data as AltmanData).available, false);
});

test("edge: empty params object does not throw and degrades", async () => {
  const r = await run({});
  assert.equal(r.success, true);
  const data = r.data as AltmanData;
  assert.equal(data.available, false);
  assert.equal(typeof data.reason, "string");
});
