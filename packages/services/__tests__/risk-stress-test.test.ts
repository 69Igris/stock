/**
 * Risk stress-test — REAL source negative/edge coverage (MONEY-620).
 *
 * `risk.service.ts::getPortfolioRisk` is Prisma- + cache-coupled and routes
 * almost all of its math through injected `@usemoney/research` compute tools, so
 * it can't be imported cleanly here (and the standard runner has no
 * `--experimental-test-module-mocks` to fake Prisma). The ONE piece of pure,
 * self-contained risk math is the stress-test engine, which the service calls
 * directly (`runStressTest(holdingsData)`). This suite imports the REAL exported
 * `runStressTest` / `applyScenario` / `SCENARIOS` and drives them with the
 * adversarial portfolios the service can hand them.
 *
 * Source: packages/services/src/risk-stress-test.ts
 *
 * Covered edges: empty portfolio, single holding (unknown sector → defaultImpact),
 * all-zero values, negative values (tone flip), NaN value propagation, the
 * longest-keyword sector match, and the positive (INR-depreciation) scenario.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  runStressTest,
  applyScenario,
  SCENARIOS,
  type StressScenario,
} from "../src/risk-stress-test";

interface H {
  symbol: string;
  value: number;
  sector: string;
}

const gfc = (): StressScenario => SCENARIOS.find((s) => s.id === "gfc-2008")!;
const fxUp = (): StressScenario =>
  SCENARIOS.find((s) => s.id === "inr-depreciation-5")!;

describe("runStressTest — empty portfolio", () => {
  it("returns all 6 scenarios with zero deltas and pv 0 (no divide-by-zero)", () => {
    const r = runStressTest([]);
    assert.equal(r.portfolioValue, 0);
    assert.equal(r.scenarios.length, SCENARIOS.length);
    for (const s of r.scenarios) {
      assert.equal(s.inrDelta, 0);
      assert.equal(s.pct, 0); // guarded by `totalValue > 0 ? ... : 0`
    }
  });

  it("computedAt is a valid ISO timestamp", () => {
    const r = runStressTest([]);
    assert.ok(!Number.isNaN(Date.parse(r.computedAt)));
  });
});

describe("applyScenario — single holding", () => {
  it("unknown sector falls back to the scenario defaultImpact", () => {
    const res = applyScenario(gfc(), [
      { symbol: "X", value: 100_000, sector: "Unknown" },
    ]);
    // gfc defaultImpact = -32 → -32% of 100k = -32,000
    assert.equal(res.inrDelta, -32_000);
    assert.equal(res.pct, -32);
    assert.equal(res.tone, "neg");
  });

  it("matched sector uses the specific impact, not the default", () => {
    const res = applyScenario(gfc(), [
      { symbol: "HDFCBANK", value: 100_000, sector: "Bank" },
    ]);
    // gfc bank impact = -47
    assert.equal(res.inrDelta, -47_000);
    assert.equal(res.pct, -47);
  });

  it("longest-keyword wins: 'Real Estate' beats a shorter substring", () => {
    // rate-hike scenario has both "realty" and "real estate" (-14). A
    // 'Real Estate' sector must resolve to the more specific -14, not default.
    const rate = SCENARIOS.find((s) => s.id === "rate-hike-100")!;
    const res = applyScenario(rate, [
      { symbol: "DLF", value: 100_000, sector: "Real Estate Investment" },
    ]);
    assert.ok(
      Math.abs(res.pct - -14) < 1e-9,
      `expected -14% for real estate, got ${res.pct}`,
    );
  });
});

describe("applyScenario — degenerate values", () => {
  it("all-zero values → pv 0, pct 0 (guard holds)", () => {
    const res = applyScenario(gfc(), [
      { symbol: "A", value: 0, sector: "bank" },
      { symbol: "B", value: 0, sector: "it" },
    ]);
    assert.equal(res.inrDelta, 0);
    assert.equal(res.pct, 0);
  });

  it("negative value (short / data error) flips the sign of the delta", () => {
    // A positive scenario impact (inr +6 for IT) on a NEGATIVE position value
    // yields a negative delta → tone neg. Documents sign handling.
    const res = applyScenario(fxUp(), [
      { symbol: "INFY", value: -50_000, sector: "it" },
    ]);
    // +6% of -50,000 = -3,000
    assert.equal(res.inrDelta, -3_000);
    assert.equal(res.tone, "neg");
  });

  it("positive scenario on a positive IT position → positive delta, tone pos", () => {
    const res = applyScenario(fxUp(), [
      { symbol: "INFY", value: 50_000, sector: "it" },
    ]);
    assert.equal(res.inrDelta, 3_000);
    assert.equal(res.tone, "pos");
  });

  it("NaN value propagates to inrDelta but pct guard keeps pct at 0", () => {
    // totalValue becomes NaN; `totalValue > 0` is false → pct 0. inrDelta is
    // NaN (NaN * impact). Documents current behavior — the consumer only ever
    // passes finite holding values, so this is a defensive edge, not a fix.
    const res = applyScenario(gfc(), [
      { symbol: "A", value: NaN, sector: "bank" },
    ]);
    assert.ok(Number.isNaN(res.inrDelta));
    assert.equal(res.pct, 0);
  });
});

describe("runStressTest — full portfolio", () => {
  const portfolio: H[] = [
    { symbol: "HDFCBANK", value: 300_000, sector: "Bank" },
    { symbol: "TCS", value: 200_000, sector: "IT" },
    { symbol: "RELIANCE", value: 500_000, sector: "Energy" },
  ];

  it("portfolioValue is the sum of holding values", () => {
    const r = runStressTest(portfolio);
    assert.equal(r.portfolioValue, 1_000_000);
  });

  it("every scenario yields a pct within a plausible [-100, +50] band", () => {
    const r = runStressTest(portfolio);
    for (const s of r.scenarios) {
      assert.ok(
        s.pct >= -100 && s.pct <= 50,
        `${s.id} pct out of band: ${s.pct}`,
      );
      assert.equal(s.tone, s.inrDelta >= 0 ? "pos" : "neg");
    }
  });

  it("crisis scenarios are net-negative for an equity-heavy book", () => {
    const r = runStressTest(portfolio);
    const covid = r.scenarios.find((s) => s.id === "covid-2020")!;
    assert.ok(covid.inrDelta < 0 && covid.pct < 0);
  });

  it("INR depreciation is net-positive for an IT-tilted book", () => {
    const itHeavy: H[] = [
      { symbol: "TCS", value: 600_000, sector: "IT" },
      { symbol: "INFY", value: 400_000, sector: "Technology" },
    ];
    const r = runStressTest(itHeavy);
    const fx = r.scenarios.find((s) => s.id === "inr-depreciation-5")!;
    assert.ok(fx.inrDelta > 0 && fx.tone === "pos");
  });
});
