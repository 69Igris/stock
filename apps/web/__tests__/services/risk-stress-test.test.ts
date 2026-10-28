/**
 * MONEY-620 — stress-test compute (REAL source, current scenario catalog).
 *
 * Imports the REAL `SCENARIOS` / `applyScenario` / `runStressTest` from
 * `packages/services/src/risk-stress-test.ts` (no inline copy → not a shadow).
 *
 * This file was previously RED (7/8 failing): it asserted a stale catalog
 * (`market-crash-30` / `it-downturn` / `rate-cut-50bps`, Banking −40%, 4
 * scenarios) that the source had since replaced with the named-historical-event
 * set (`gfc-2008` / `covid-2020` / `election-2024` / `rate-hike-100` /
 * `inr-depreciation-5` / `it-shock-20`, 6 scenarios). Re-pinned to the current
 * REAL impact factors so it actually guards the engine. The deeper edge matrix
 * (empty / NaN / longest-keyword / tone) lives in
 * `packages/services/__tests__/risk-stress-test.test.ts`; this keeps the
 * consumer-side smoke assertions.
 *
 * Source: packages/services/src/risk-stress-test.ts
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  SCENARIOS,
  applyScenario,
  runStressTest,
} from "../../../../packages/services/src/risk-stress-test";

test("SCENARIOS catalog covers GFC + COVID + election + rate + INR + IT shock", () => {
  const ids = SCENARIOS.map((s) => s.id);
  assert.ok(ids.includes("gfc-2008"));
  assert.ok(ids.includes("covid-2020"));
  assert.ok(ids.includes("election-2024"));
  assert.ok(ids.includes("rate-hike-100"));
  assert.ok(ids.includes("inr-depreciation-5"));
  assert.ok(ids.includes("it-shock-20"));
  assert.equal(SCENARIOS.length, 6);
});

test("GFC applies sector-specific impact to a bank-heavy portfolio", () => {
  const gfc = SCENARIOS.find((s) => s.id === "gfc-2008")!;
  const holdings = [
    { symbol: "HDFCBANK", value: 100_000, sector: "Banking" },
    { symbol: "ICICIBANK", value: 100_000, sector: "Banking" },
  ];
  const result = applyScenario(gfc, holdings);
  // GFC bank impact = -47%, total 200k → -94k.
  assert.equal(Math.round(result.inrDelta), -94_000);
  assert.ok(result.pct < -46 && result.pct > -48);
  assert.equal(result.tone, "neg");
});

test("longest-keyword-wins resolves 'Banking & Financials' → -45% (financial)", () => {
  const gfc = SCENARIOS.find((s) => s.id === "gfc-2008")!;
  const result = applyScenario(gfc, [
    { symbol: "HDFCBANK", value: 200_000, sector: "Banking & Financials" },
  ]);
  // "financial" (-45) is longer than "bank" (-47) so financial wins.
  assert.equal(Math.round(result.inrDelta), -90_000);
});

test("rate hike +100bp drags banks but bumps IT positively", () => {
  const rate = SCENARIOS.find((s) => s.id === "rate-hike-100")!;
  const holdings = [
    { symbol: "HDFCBANK", value: 100_000, sector: "Banking" }, // -8%
    { symbol: "TCS", value: 100_000, sector: "IT" }, // +2%
  ];
  const result = applyScenario(rate, holdings);
  // -8k + 2k = -6k.
  assert.equal(Math.round(result.inrDelta), -6_000);
});

test("default impact applies when no sector keyword matches", () => {
  const gfc = SCENARIOS.find((s) => s.id === "gfc-2008")!;
  const result = applyScenario(gfc, [
    { symbol: "MYSTERY", value: 50_000, sector: "Unclassified Niche" },
  ]);
  // GFC default -32% × 50k = -16k.
  assert.equal(Math.round(result.inrDelta), -16_000);
});

test("runStressTest emits all 6 scenarios + portfolio value + ISO timestamp", () => {
  const holdings = [
    { symbol: "INFY", value: 200_000, sector: "Information Technology" },
    { symbol: "RELIANCE", value: 150_000, sector: "Energy" },
  ];
  const result = runStressTest(holdings);
  assert.equal(result.scenarios.length, 6);
  assert.equal(result.portfolioValue, 350_000);
  assert.ok(!Number.isNaN(Date.parse(result.computedAt)));
});

test("IT-heavy portfolio benefits from INR depreciation", () => {
  const inr = SCENARIOS.find((s) => s.id === "inr-depreciation-5")!;
  const holdings = [
    { symbol: "INFY", value: 100_000, sector: "Information Technology" },
    { symbol: "TCS", value: 100_000, sector: "Information Technology" },
  ];
  const result = applyScenario(inr, holdings);
  // IT +6% × 200k = 12k.
  assert.equal(Math.round(result.inrDelta), 12_000);
  assert.equal(result.tone, "pos");
});

test("empty portfolio returns zero impact, no NaN (divide-by-zero guard)", () => {
  const gfc = SCENARIOS.find((s) => s.id === "gfc-2008")!;
  const result = applyScenario(gfc, []);
  assert.equal(result.inrDelta, 0);
  assert.equal(result.pct, 0);
});
