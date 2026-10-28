import { test } from "node:test";
import assert from "node:assert/strict";

import { computeBetaTool } from "../../../../packages/research/src/tools/compute-beta";

// MONEY-407 - compute-beta pure-function tests.

async function run(args: Record<string, unknown>) {
  return computeBetaTool.execute(args);
}

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
test("reports UNAVAILABLE when paired observations < 20", async () => {
  const r = await run({
    portfolioReturns: [0.01, 0.02, -0.01],
    benchmarkReturns: [0.01, 0.02, -0.01],
  });
  assert.equal(r.success, true, "too few points is not a tool failure");
  const d = r.data as Record<string, unknown>;
  assert.equal(d.available, false);
  assert.match(String(d.reason), /20 paired daily returns/);
  assert.equal(d.beta, undefined, "must not invent a beta");
});

test("beta = 1 when portfolio returns equal benchmark returns exactly", async () => {
  const series = Array.from({ length: 30 }, (_, i) => Math.sin(i / 4) * 0.01);
  const r = await run({ portfolioReturns: series, benchmarkReturns: series });
  assert.equal(r.success, true);
  const data = r.data as { beta: number; correlation: number };
  assert.ok(
    Math.abs(data.beta - 1) < 0.01,
    `beta should be ~1, got ${data.beta}`
  );
  assert.ok(Math.abs(data.correlation - 1) < 0.01);
});

test("beta = 2 when portfolio is exactly 2× benchmark", async () => {
  const bench = Array.from({ length: 60 }, (_, i) => Math.cos(i / 3) * 0.005);
  const port = bench.map((b) => b * 2);
  const r = await run({ portfolioReturns: port, benchmarkReturns: bench });
  assert.equal(r.success, true);
  const data = r.data as { beta: number };
  assert.ok(
    Math.abs(data.beta - 2) < 0.02,
    `beta should be ~2, got ${data.beta}`
  );
});

test("beta negative when portfolio moves opposite to benchmark", async () => {
  const bench = Array.from({ length: 40 }, (_, i) => Math.sin(i / 3) * 0.01);
  const port = bench.map((b) => -b);
  const r = await run({ portfolioReturns: port, benchmarkReturns: bench });
  assert.equal(r.success, true);
  const data = r.data as { beta: number };
  assert.ok(data.beta < -0.95, `beta should be ~-1, got ${data.beta}`);
});

test("uses last N paired observations when arrays differ in length", async () => {
  const bench = Array.from({ length: 50 }, (_, i) => Math.sin(i / 4) * 0.01);
  const port = bench.slice(-25);
  const r = await run({ portfolioReturns: port, benchmarkReturns: bench });
  assert.equal(r.success, true);
  const data = r.data as { observations: number };
  assert.equal(data.observations, 25);
});

test("returns volatilities annualized (×√252)", async () => {
  const series = Array.from({ length: 30 }, (_, i) => (i % 2 ? 0.01 : -0.01));
  const r = await run({ portfolioReturns: series, benchmarkReturns: series });
  const data = r.data as { portfolioVol: number; benchmarkVol: number };
  // daily std ≈ 0.01 ; annualised ≈ 0.01 × √252 ≈ 0.1587
  assert.ok(data.portfolioVol > 0.14 && data.portfolioVol < 0.18);
  assert.equal(data.portfolioVol, data.benchmarkVol);
});
