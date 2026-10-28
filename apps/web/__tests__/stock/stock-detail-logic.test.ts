/**
 * Stock-detail derivation helpers (MONEY-796).
 *
 * Pure tests for the maths behind the new stock-detail cards:
 *  - periodOverPeriodPct (the financials YoY/QoQ deltas)
 *  - upsideToTargetPct   (analyst snapshot)
 *  - smaPosition / pctFromSma / rsiZone (technicals)
 *
 * Imports the REAL helpers from lib/actions/stock-detail-logic.ts (the same
 * module the action + components import) — no shadow copy. Every helper is
 * finite-guarded; these assertions pin that the bad-input paths return null
 * (never NaN / Infinity), matching the page's "real values only" convention.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  finiteOrNull,
  periodOverPeriodPct,
  upsideToTargetPct,
  smaPosition,
  pctFromSma,
  rsiZone,
  parsePeriodKey,
  comparePeriodsDesc,
} from "../../lib/actions/stock-detail-logic";

describe("finiteOrNull", () => {
  it("passes through finite numbers including 0 and negatives", () => {
    assert.equal(finiteOrNull(0), 0);
    assert.equal(finiteOrNull(-12.5), -12.5);
    assert.equal(finiteOrNull(42), 42);
  });
  it("returns null for nullish / NaN / Infinity", () => {
    assert.equal(finiteOrNull(null), null);
    assert.equal(finiteOrNull(undefined), null);
    assert.equal(finiteOrNull(NaN), null);
    assert.equal(finiteOrNull(Infinity), null);
    assert.equal(finiteOrNull(-Infinity), null);
  });
});

describe("periodOverPeriodPct", () => {
  it("computes a simple growth %", () => {
    // 120 from 100 = +20%
    assert.equal(periodOverPeriodPct(120, 100), 20);
  });
  it("computes a decline as a negative %", () => {
    assert.equal(periodOverPeriodPct(80, 100), -20);
  });
  it("scales against |previous| so a loss→profit swing reads positive", () => {
    // prior -50 (loss), latest +50 (profit): (50 - -50)/|−50| = +200%
    assert.equal(periodOverPeriodPct(50, -50), 200);
  });
  it("returns null when previous is 0 (undefined %)", () => {
    assert.equal(periodOverPeriodPct(100, 0), null);
  });
  it("returns null when either side is missing or non-finite", () => {
    assert.equal(periodOverPeriodPct(null, 100), null);
    assert.equal(periodOverPeriodPct(100, null), null);
    assert.equal(periodOverPeriodPct(NaN, 100), null);
    assert.equal(periodOverPeriodPct(100, Infinity), null);
  });
  it("treats a flat period as 0% (not null)", () => {
    assert.equal(periodOverPeriodPct(100, 100), 0);
  });
});

describe("upsideToTargetPct", () => {
  it("target above price → positive upside", () => {
    // price 100, target 130 → +30%
    assert.equal(upsideToTargetPct(100, 130), 30);
  });
  it("target below price → negative", () => {
    assert.equal(upsideToTargetPct(100, 80), -20);
  });
  it("returns null for missing / non-positive price", () => {
    assert.equal(upsideToTargetPct(0, 130), null);
    assert.equal(upsideToTargetPct(-5, 130), null);
    assert.equal(upsideToTargetPct(null, 130), null);
    assert.equal(upsideToTargetPct(100, null), null);
    assert.equal(upsideToTargetPct(100, NaN), null);
  });
});

describe("smaPosition", () => {
  it("classifies above / below / at", () => {
    assert.equal(smaPosition(110, 100), "above");
    assert.equal(smaPosition(90, 100), "below");
    assert.equal(smaPosition(100, 100), "at");
  });
  it("returns null when either input is missing / non-finite", () => {
    assert.equal(smaPosition(null, 100), null);
    assert.equal(smaPosition(100, null), null);
    assert.equal(smaPosition(Infinity, 100), null);
  });
});

describe("pctFromSma", () => {
  it("computes signed % distance from the SMA", () => {
    assert.equal(pctFromSma(110, 100), 10);
    assert.equal(pctFromSma(95, 100), -5);
  });
  it("returns null for a non-positive SMA or missing inputs", () => {
    assert.equal(pctFromSma(110, 0), null);
    assert.equal(pctFromSma(110, -10), null);
    assert.equal(pctFromSma(null, 100), null);
  });
});

describe("rsiZone", () => {
  it("labels the standard 14-period bands", () => {
    assert.equal(rsiZone(75), "overbought");
    assert.equal(rsiZone(70), "overbought");
    assert.equal(rsiZone(25), "oversold");
    assert.equal(rsiZone(30), "oversold");
    assert.equal(rsiZone(50), "neutral");
  });
  it("returns null for missing / non-finite RSI", () => {
    assert.equal(rsiZone(null), null);
    assert.equal(rsiZone(undefined), null);
    assert.equal(rsiZone(NaN), null);
  });
});

describe("SEBI — derivations are descriptive DATA, never advice", () => {
  // The whole module's contract is that it surfaces market data (positions,
  // distances, zones) but NEVER synthesizes a buy/sell/hold recommendation.
  // A regression that maps a zone → "buy"/"sell" would breach the commitment
  // the stock-detail page makes. Pin that no advice verb is ever produced.
  const ADVICE = [
    "buy",
    "sell",
    "hold",
    "accumulate",
    "exit",
    "book",
    "target",
    "recommend",
    "should",
  ];

  function assertNoAdvice(value: unknown) {
    if (value == null) return;
    const s = String(value).toLowerCase();
    for (const verb of ADVICE) {
      assert.ok(
        !s.includes(verb),
        `derivation produced an advice verb "${verb}" in "${s}"`
      );
    }
  }

  it("smaPosition only ever yields above/below/at/null", () => {
    const labels = [
      smaPosition(110, 100),
      smaPosition(90, 100),
      smaPosition(100, 100),
      smaPosition(null, 100),
    ];
    for (const l of labels) {
      assert.ok([null, "above", "below", "at"].includes(l));
      assertNoAdvice(l);
    }
  });

  it("rsiZone only ever yields overbought/oversold/neutral/null", () => {
    const labels = [rsiZone(80), rsiZone(20), rsiZone(50), rsiZone(null)];
    for (const l of labels) {
      assert.ok([null, "overbought", "oversold", "neutral"].includes(l));
      assertNoAdvice(l);
    }
  });

  it("upsideToTargetPct is a pure number (the page renders it as DATA)", () => {
    // It never decides whether the upside is 'good' — it's just (tgt-cur)/cur.
    const v = upsideToTargetPct(100, 130);
    assert.equal(typeof v, "number");
    assert.equal(v, 30);
    assertNoAdvice(v);
  });
});

describe("derivations — empty / partial data", () => {
  it("all helpers return null on a fully-empty input set", () => {
    assert.equal(periodOverPeriodPct(null, null), null);
    assert.equal(upsideToTargetPct(null, null), null);
    assert.equal(smaPosition(null, null), null);
    assert.equal(pctFromSma(null, null), null);
    assert.equal(rsiZone(null), null);
    assert.equal(finiteOrNull(null), null);
  });

  it("a single missing side of a pair still yields null (no NaN leak)", () => {
    // Partial rows (one quarter present, the prior missing) must not produce
    // NaN% — they degrade to null so the card omits the figure.
    assert.equal(periodOverPeriodPct(120, null), null);
    assert.equal(periodOverPeriodPct(null, 100), null);
    assert.equal(upsideToTargetPct(100, undefined), null);
    assert.equal(pctFromSma(110, undefined), null);
  });

  it("never returns NaN or ±Infinity for any boundary input", () => {
    const samples: Array<number | null> = [
      periodOverPeriodPct(1e308, -1e-308),
      upsideToTargetPct(1e-308, 1e308),
      pctFromSma(1e308, 1e-308),
    ];
    for (const v of samples) {
      if (v !== null) {
        assert.ok(Number.isFinite(v), `expected finite or null, got ${v}`);
      }
    }
  });
});

// ══════════════════════════════════════════════════════════════════════
// parsePeriodKey / comparePeriodsDesc (MONEY-779)
//
// `StockFinancials.period` is a free-form upstream string, so the financials
// tab orders each statement with this period-aware comparator instead of a
// lexical sort — which mis-orders 'Q4-2023' AHEAD of 'Q3-2024' and interleaves
// FY/Q rows. These pin the parse + newest-first ordering the QoQ/YoY delta
// (rows[0] vs rows[1]) and the latest-6 columns depend on.
// ══════════════════════════════════════════════════════════════════════

describe("parsePeriodKey", () => {
  it("parses a Qn-YYYY quarterly period", () => {
    assert.deepEqual(parsePeriodKey("Q3-2024"), { year: 2024, quarter: 3 });
    assert.deepEqual(parsePeriodKey("Q1 2025"), { year: 2025, quarter: 1 });
  });
  it("parses fiscal-year forms (FY2024 / FY 2024 / 2024 / Mar 2024)", () => {
    assert.deepEqual(parsePeriodKey("FY2024"), { year: 2024, quarter: null });
    assert.deepEqual(parsePeriodKey("FY 2024"), { year: 2024, quarter: null });
    assert.deepEqual(parsePeriodKey("2024"), { year: 2024, quarter: null });
    assert.deepEqual(parsePeriodKey("Mar 2024"), { year: 2024, quarter: null });
  });
  it("expands a 2-digit fiscal year and keeps the quarter", () => {
    assert.deepEqual(parsePeriodKey("Q4 FY24"), { year: 2024, quarter: 4 });
    assert.deepEqual(parsePeriodKey("FY24"), { year: 2024, quarter: null });
  });
  it("returns null/null for an unparseable / blank period", () => {
    assert.deepEqual(parsePeriodKey(""), { year: null, quarter: null });
    assert.deepEqual(parsePeriodKey("   "), { year: null, quarter: null });
    assert.deepEqual(parsePeriodKey("TTM"), { year: null, quarter: null });
  });
});

describe("comparePeriodsDesc", () => {
  it("orders quarterly periods newest-first across year boundaries", () => {
    // The exact bug from the ticket: 'Q4-2023' must NOT sort ahead of 'Q3-2024'.
    const sorted = ["Q4-2023", "Q3-2024", "Q1-2024", "Q2-2024"].sort(
      comparePeriodsDesc
    );
    assert.deepEqual(sorted, ["Q3-2024", "Q2-2024", "Q1-2024", "Q4-2023"]);
  });

  it("orders annual periods newest-first", () => {
    const sorted = ["FY2022", "FY2024", "FY2023"].sort(comparePeriodsDesc);
    assert.deepEqual(sorted, ["FY2024", "FY2023", "FY2022"]);
  });

  it("orders bare-year annual periods newest-first", () => {
    const sorted = ["2021", "2024", "2022", "2023"].sort(comparePeriodsDesc);
    assert.deepEqual(sorted, ["2024", "2023", "2022", "2021"]);
  });

  it("puts a parseable year ahead of an unparseable one (TTM trails)", () => {
    const sorted = ["TTM", "FY2024", "FY2023"].sort(comparePeriodsDesc);
    assert.deepEqual(sorted, ["FY2024", "FY2023", "TTM"]);
  });

  it("within one year, a real quarter outranks an un-quartered row", () => {
    // Defensive: even if a year-level total interleaves with its quarters in a
    // single bucket, the quarters lead so the latest column is a true quarter.
    const sorted = ["FY2024", "Q1-2024", "Q4-2024"].sort(comparePeriodsDesc);
    assert.deepEqual(sorted, ["Q4-2024", "Q1-2024", "FY2024"]);
  });

  it("is a total order — stable on a fully-tied pair (no NaN compare)", () => {
    assert.equal(comparePeriodsDesc("FY2024", "FY2024"), 0);
    // Two unparseable strings still compare deterministically (desc).
    assert.ok(comparePeriodsDesc("AAA", "BBB") > 0);
    assert.ok(comparePeriodsDesc("BBB", "AAA") < 0);
  });
});
