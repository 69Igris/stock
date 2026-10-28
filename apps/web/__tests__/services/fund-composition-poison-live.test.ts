/**
 * MONEY-620 — fund-composition allocation math: POISON + EDGE, pure + on the LIVE service.
 *
 * Two layers, both NO-SHADOW:
 *
 *  A. PURE unit tests import the REAL exported allocation math from
 *     `packages/services/src/fund-composition-logic.ts` via a RELATIVE path
 *     (weight % = value/total, sector/asset/cap aggregation, normalize-to-100,
 *     reconciliation, top-N, portfolio overlap, dataAsOf/confidence safety).
 *     The SAME functions the service calls compute what we assert.
 *
 *  B. LIVE tests drive the REAL exported `getFundComposition` /
 *     `triggerCompositionExtraction` from `@usemoney/services`
 *     (`packages/services/src/fund-composition.service.ts`) — the user-facing
 *     fund-composition path (`apps/web/lib/actions/fund-composition.ts` →
 *     `getFundCompositionService` / `triggerCompositionExtractionService`) —
 *     through a RECORDING double injected at the `@usemoney/core/market-data`
 *     (DB read) / `@usemoney/core` (cache) / `@usemoney/logger` module boundary
 *     via `require.cache`. This is the proven seam from
 *     `services/holdings-poison-live.test.ts`. No inline reimplementation: the
 *     SAME code that ships computes what we assert (no shadow), and no live
 *     Mongo / Redis / Gemini is touched (pure, exits clean).
 *
 * What this pins on the LIVE service (the service-side de-shadow / finite-guard):
 *   1. WEIGHT div-by-zero / poison — a NaN/Infinity holding `weightPercent`
 *      must NOT render as `"NaN%"` nor poison the `Σ weights` coverage total;
 *      total fund value 0 → every derived weight 0 (not Infinity/NaN).
 *   2. NORMALIZE-to-100 — an all-zero composition produces no NaN; weights that
 *      don't sum to 100 are reconciled within tolerance; rescale is ÷0-safe.
 *   3. TOP-N — fewer than N returns all; a non-finite weight is ranked LAST,
 *      never the #1 holding (wrong-order class).
 *   4. OVERLAP — two funds with zero common value → 0 (not NaN); union 0 → 0.
 *   5. CONSUMER-SAFETY — every number in the returned shape is finite, so a UI
 *      `.toFixed()` / Recharts `<Pie value=…>` slice never sees NaN/Infinity;
 *      an Invalid-Date `dataAsOf` never throws / renders "Invalid Date".
 *   6. BEHAVIOUR-PRESERVING — clean finite data yields the exact prior fields.
 *
 * Runs under the default `node --import tsx --test` (CJS). CWD must be `apps/web`.
 *
 * Source: packages/services/src/fund-composition.service.ts + ./fund-composition-logic.ts
 */

import { describe, it, before, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// ── REAL pure exports (relative path — no @/ alias, no I/O at import) ────────
import {
  finite,
  round2,
  totalFundValue,
  weightFromValue,
  weightsFromValues,
  sanitizeHolding,
  sanitizeAndSortHoldings,
  topNHoldings,
  coveragePercent,
  reconcilesTo100,
  RECONCILE_TOLERANCE,
  normalizeWeightsTo100,
  aggregateByKey,
  sanitizeBreakdown,
  safeDataAsOf,
  clampConfidence,
  normalizeComposition,
  portfolioOverlap,
  type CompositionHolding,
  type RawComposition,
} from "../../../../packages/services/src/fund-composition-logic";

// MONEY-1401 F8b — the SIBLING surface, driven through its own injected deps
// (`MfPortfolioDeps`) rather than the require.cache seam below: the service was
// built with that seam for exactly this, so there is nothing to double.
import {
  getMfPortfolioSection,
  type MfPortfolioDeps,
  type MfPortfolioSectionData,
} from "../../../../packages/services/src/mf-portfolio-section.service";
import type { WithProvenance } from "../../../../packages/services/src/provenance";

// ── factories ───────────────────────────────────────────────────────────────

function hld(overrides: Partial<CompositionHolding> = {}): CompositionHolding {
  return {
    holdingName: "HDFC Bank Ltd",
    holdingSymbol: "HDFCBANK",
    isin: "INE040A01034",
    holdingType: "EQUITY",
    sector: "Financial Services",
    industry: "Banking",
    marketCap: "LARGE",
    weightPercent: 8.5,
    ...overrides,
  };
}

function rawComp(overrides: Partial<RawComposition> = {}): RawComposition {
  return {
    fundType: "MF",
    fundId: "119598",
    holdings: [
      hld({ holdingName: "Reliance", weightPercent: 7.5, sector: "Energy" }),
      hld({ holdingName: "Infosys", weightPercent: 6.3, sector: "IT" }),
    ],
    sectorBreakdown: [
      { sector: "Energy", weight: 7.5 },
      { sector: "IT", weight: 6.3 },
    ],
    capBreakdown: [{ cap: "LARGE", weight: 13.8 }],
    assetBreakdown: [{ type: "EQUITY", weight: 13.8 }],
    totalHoldings: 2,
    confidence: 0.9,
    dataAsOf: "2025-12",
    ...overrides,
  };
}

// ══════════════════════════════════════════════════════════════════════════
// A. PURE allocation math (real exports)
// ══════════════════════════════════════════════════════════════════════════

describe("MONEY-620 fund-composition-logic — finite() / round2() guard", () => {
  it("collapses null/undefined/NaN/±Infinity to the fallback", () => {
    assert.strictEqual(finite(null), 0);
    assert.strictEqual(finite(undefined), 0);
    assert.strictEqual(finite(NaN), 0);
    assert.strictEqual(finite(Infinity), 0);
    assert.strictEqual(finite(-Infinity), 0);
    assert.strictEqual(finite(NaN, -1), -1);
    assert.strictEqual(finite(12.3), 12.3);
    assert.strictEqual(finite(0), 0);
  });

  it("round2 rounds to 2dp and neutralises non-finite to 0", () => {
    assert.strictEqual(round2(8.555), 8.56);
    assert.strictEqual(round2(3.141592), 3.14);
    assert.strictEqual(round2(NaN), 0);
    assert.strictEqual(round2(Infinity), 0);
    assert.strictEqual(round2(10), 10);
  });
});

describe("MONEY-620 fund-composition-logic — weight % = value / total", () => {
  it("computes each holding weight from its value (sums ~100 for a full book)", () => {
    const out = weightsFromValues([
      { key: "A", value: 50 },
      { key: "B", value: 30 },
      { key: "C", value: 20 },
    ]);
    assert.deepStrictEqual(out, [
      { key: "A", weightPercent: 50 },
      { key: "B", weightPercent: 30 },
      { key: "C", weightPercent: 20 },
    ]);
    const sum = out.reduce((s, h) => s + h.weightPercent, 0);
    assert.ok(Math.abs(sum - 100) < 1e-9);
  });

  it("BUG-CLASS: total fund value 0 → every weight 0, never Infinity/NaN", () => {
    const out = weightsFromValues([
      { key: "A", value: 0 },
      { key: "B", value: 0 },
    ]);
    for (const h of out) {
      assert.strictEqual(h.weightPercent, 0);
      assert.ok(Number.isFinite(h.weightPercent));
    }
    // direct div-by-zero on the scalar helper
    assert.strictEqual(weightFromValue(100, 0), 0);
    assert.strictEqual(weightFromValue(100, NaN), 0);
    assert.strictEqual(weightFromValue(100, Infinity), 0);
  });

  it("BUG-CLASS: a NaN/Infinity holding value does NOT poison the total nor the other weights", () => {
    const out = weightsFromValues([
      { key: "A", value: 50 },
      { key: "B", value: NaN }, // corrupt
      { key: "C", value: Infinity }, // corrupt
      { key: "D", value: 50 },
    ]);
    // total = 50 + 0 + 0 + 50 = 100 (poison neutralised before the divide)
    const byKey = new Map(out.map((h) => [h.key, h.weightPercent]));
    assert.strictEqual(byKey.get("A"), 50);
    assert.strictEqual(byKey.get("D"), 50);
    assert.strictEqual(byKey.get("B"), 0); // corrupt value → 0 weight
    assert.strictEqual(byKey.get("C"), 0);
    for (const h of out) assert.ok(Number.isFinite(h.weightPercent));
    assert.strictEqual(
      totalFundValue([
        { key: "X", value: NaN },
        { key: "Y", value: 10 },
      ]),
      10
    );
  });

  it("empty holdings → empty weights, zero total", () => {
    assert.deepStrictEqual(weightsFromValues([]), []);
    assert.strictEqual(totalFundValue([]), 0);
  });
});

describe("MONEY-620 fund-composition-logic — sanitize + sort holdings (top holding first)", () => {
  it("sanitizeHolding finite-guards weightPercent only, preserves other fields", () => {
    const s = sanitizeHolding(hld({ weightPercent: NaN, sector: "Energy" }));
    assert.strictEqual(s.weightPercent, 0);
    assert.strictEqual(s.sector, "Energy");
    assert.strictEqual(s.holdingName, "HDFC Bank Ltd");
  });

  it("sorts by weight DESC; ties break by name ASC (deterministic)", () => {
    const sorted = sanitizeAndSortHoldings([
      hld({ holdingName: "C", weightPercent: 5 }),
      hld({ holdingName: "A", weightPercent: 10 }),
      hld({ holdingName: "B", weightPercent: 10 }), // tie with A
    ]);
    assert.deepStrictEqual(
      sorted.map((h) => h.holdingName),
      ["A", "B", "C"]
    );
  });

  it("WRONG-ORDER BUG-CLASS: a NaN/Infinity weight is ranked LAST, not first", () => {
    const sorted = sanitizeAndSortHoldings([
      hld({ holdingName: "GoodSmall", weightPercent: 2 }),
      hld({ holdingName: "Corrupt", weightPercent: NaN }),
      hld({ holdingName: "GoodBig", weightPercent: 30 }),
      hld({ holdingName: "CorruptInf", weightPercent: Infinity }),
    ]);
    assert.strictEqual(sorted[0]!.holdingName, "GoodBig"); // real #1, never the NaN
    assert.strictEqual(sorted[0]!.weightPercent, 30);
    // the two corrupt rows are at the tail (weight 0)
    assert.strictEqual(sorted[sorted.length - 1]!.weightPercent, 0);
    assert.strictEqual(sorted[sorted.length - 2]!.weightPercent, 0);
    for (const h of sorted) assert.ok(Number.isFinite(h.weightPercent));
  });
});

describe("MONEY-620 fund-composition-logic — top-N holdings", () => {
  const holdings = [
    hld({ holdingName: "A", weightPercent: 10 }),
    hld({ holdingName: "B", weightPercent: 8 }),
    hld({ holdingName: "C", weightPercent: 6 }),
  ];

  it("returns the N largest by weight", () => {
    const top2 = topNHoldings(holdings, 2);
    assert.deepStrictEqual(
      top2.map((h) => h.holdingName),
      ["A", "B"]
    );
  });

  it("fewer than N → returns ALL (no pad, no throw)", () => {
    const top10 = topNHoldings(holdings, 10);
    assert.strictEqual(top10.length, 3);
  });

  it("n <= 0 / non-finite → empty; empty holdings → empty", () => {
    assert.deepStrictEqual(topNHoldings(holdings, 0), []);
    assert.deepStrictEqual(topNHoldings(holdings, -3), []);
    assert.deepStrictEqual(topNHoldings(holdings, NaN), []);
    assert.deepStrictEqual(topNHoldings([], 5), []);
  });

  it("ties are stable by name; a NaN-weight holding never enters top-1", () => {
    const top1 = topNHoldings(
      [
        hld({ holdingName: "Corrupt", weightPercent: Infinity }),
        hld({ holdingName: "Real", weightPercent: 4 }),
      ],
      1
    );
    assert.strictEqual(top1[0]!.holdingName, "Real");
  });
});

describe("MONEY-620 fund-composition-logic — coverage Σ + reconcile-to-100", () => {
  it("coverage = Σ finite weights; a poisoned weight contributes 0", () => {
    assert.strictEqual(
      coveragePercent([
        hld({ weightPercent: 40 }),
        hld({ weightPercent: 35 }),
        hld({ weightPercent: NaN }), // → 0
        hld({ weightPercent: Infinity }), // → 0
      ]),
      75
    );
    assert.ok(
      Number.isFinite(
        coveragePercent([
          hld({ weightPercent: NaN }),
          hld({ weightPercent: Infinity }),
        ])
      )
    );
    assert.strictEqual(coveragePercent([]), 0);
  });

  it("reconcilesTo100 is a tolerance check (rounding), non-finite never reconciles", () => {
    assert.strictEqual(reconcilesTo100(100), true);
    assert.strictEqual(reconcilesTo100(99.7), true); // within 0.5 default
    assert.strictEqual(reconcilesTo100(100.4), true);
    assert.strictEqual(reconcilesTo100(95), false);
    assert.strictEqual(reconcilesTo100(NaN), false);
    assert.strictEqual(reconcilesTo100(Infinity), false);
    assert.strictEqual(reconcilesTo100(98, 2), true); // custom tol
    assert.strictEqual(RECONCILE_TOLERANCE, 0.5);
  });

  it("ASSERT Σweights ≈ 100 within tolerance for a realistic book", () => {
    const book = [
      hld({ weightPercent: 29.7 }),
      hld({ weightPercent: 25.1 }),
      hld({ weightPercent: 20.0 }),
      hld({ weightPercent: 15.2 }),
      hld({ weightPercent: 10.1 }),
    ];
    assert.ok(reconcilesTo100(coveragePercent(book)));
  });
});

describe("MONEY-620 fund-composition-logic — normalize weights to 100 (pie fill)", () => {
  it("rescales so the slices sum to exactly 100", () => {
    const out = normalizeWeightsTo100([
      { sector: "A", weight: 30 },
      { sector: "B", weight: 10 },
    ]);
    const sum = out.reduce((s, x) => s + x.weight, 0);
    assert.ok(Math.abs(sum - 100) < 1e-9);
    assert.strictEqual(out[0]!.weight, 75);
    assert.strictEqual(out[1]!.weight, 25);
  });

  it("ALL-ZERO composition → all-zero (no NaN), never ÷0 Infinity", () => {
    const out = normalizeWeightsTo100([
      { cap: "L", weight: 0 },
      { cap: "M", weight: 0 },
    ]);
    for (const s of out) {
      assert.strictEqual(s.weight, 0);
      assert.ok(Number.isFinite(s.weight));
    }
  });

  it("non-finite slice weights are neutralised before the rescale (no poison)", () => {
    const out = normalizeWeightsTo100([
      { type: "EQUITY", weight: 80 },
      { type: "DEBT", weight: NaN },
      { type: "CASH", weight: Infinity },
    ]);
    // total = 80 (only the finite one), so EQUITY → 100, others → 0
    assert.strictEqual(out[0]!.weight, 100);
    assert.strictEqual(out[1]!.weight, 0);
    assert.strictEqual(out[2]!.weight, 0);
    for (const s of out) assert.ok(Number.isFinite(s.weight));
  });

  it("empty → empty", () => {
    assert.deepStrictEqual(normalizeWeightsTo100([]), []);
  });
});

describe("MONEY-620 fund-composition-logic — aggregate by sector/asset/cap", () => {
  it("sums weights per group, sorted DESC, finite", () => {
    const out = aggregateByKey(
      [
        hld({ sector: "Financial Services", weightPercent: 10 }),
        hld({ sector: "IT", weightPercent: 8 }),
        hld({ sector: "Financial Services", weightPercent: 5 }),
      ],
      (h) => h.sector,
      "Unknown"
    );
    assert.deepStrictEqual(out, [
      { key: "Financial Services", weight: 15 },
      { key: "IT", weight: 8 },
    ]);
  });

  it("null/empty group key falls back, never drops the weight; NaN weight → 0", () => {
    const out = aggregateByKey(
      [
        hld({ sector: null, weightPercent: 12 }),
        hld({ sector: "  ", weightPercent: 3 }),
        hld({ sector: "IT", weightPercent: NaN }),
      ],
      (h) => h.sector,
      "Unknown"
    );
    const byKey = new Map(out.map((b) => [b.key, b.weight]));
    assert.strictEqual(byKey.get("Unknown"), 15); // 12 + 3
    assert.strictEqual(byKey.get("IT"), 0); // NaN → 0
    for (const b of out) assert.ok(Number.isFinite(b.weight));
  });

  it("sanitizeBreakdown finite-guards a pre-aggregated breakdown + re-sorts DESC", () => {
    const out = sanitizeBreakdown(
      [
        { sector: "A", weight: 5 },
        { sector: "B", weight: NaN },
        { sector: "C", weight: 30 },
      ],
      "sector"
    );
    assert.strictEqual(out[0]!.sector, "C");
    assert.strictEqual(out[0]!.weight, 30);
    for (const s of out) assert.ok(Number.isFinite(s.weight as number));
    // the NaN slice survived as a 0 weight (not dropped, not NaN)
    assert.ok(out.some((s) => s.sector === "B" && s.weight === 0));
  });
});

describe("MONEY-620 fund-composition-logic — dataAsOf / confidence safety", () => {
  it("safeDataAsOf: string trimmed, valid Date → YYYY-MM-DD, INVALID Date → '' (no throw)", () => {
    assert.strictEqual(safeDataAsOf("2025-12"), "2025-12");
    assert.strictEqual(safeDataAsOf("  2026-01  "), "2026-01");
    assert.strictEqual(
      safeDataAsOf(new Date("2026-01-31T00:00:00Z")),
      "2026-01-31"
    );
    // The exact failing input: an Invalid Date would throw RangeError on
    // .toISOString() if unguarded.
    assert.doesNotThrow(() => safeDataAsOf(new Date("not-a-real-date")));
    assert.strictEqual(safeDataAsOf(new Date("not-a-real-date")), "");
    assert.strictEqual(safeDataAsOf(2025 as unknown), "");
    assert.strictEqual(safeDataAsOf(null), "");
    assert.strictEqual(safeDataAsOf(undefined), "");
  });

  it("clampConfidence clamps to a finite [0,1]", () => {
    assert.strictEqual(clampConfidence(0.85), 0.85);
    assert.strictEqual(clampConfidence(0), 0);
    assert.strictEqual(clampConfidence(1), 1);
    assert.strictEqual(clampConfidence(1.4), 1); // >1 (finite) clamped down
    assert.strictEqual(clampConfidence(-0.2), 0); // <0 clamped up
    // Non-finite confidence is corrupt, not "huge" — collapse to 0 (the
    // conservative LOW-confidence choice; we must not claim high confidence
    // from garbage). This also keeps round(confidence*100) finite.
    assert.strictEqual(clampConfidence(NaN), 0);
    assert.strictEqual(clampConfidence(Infinity), 0);
    assert.strictEqual(clampConfidence(-Infinity), 0);
    assert.strictEqual(clampConfidence(null), 0);
  });
});

describe("MONEY-620 fund-composition-logic — portfolio overlap %", () => {
  it("Σ min(weightA, weightB) over shared keys; Jaccard by key", () => {
    const a = [
      { key: "HDFCBANK", weight: 10 },
      { key: "RELIANCE", weight: 8 },
      { key: "INFY", weight: 6 },
    ];
    const b = [
      { key: "HDFCBANK", weight: 5 }, // min(10,5)=5
      { key: "RELIANCE", weight: 12 }, // min(8,12)=8
      { key: "TCS", weight: 7 },
    ];
    const o = portfolioOverlap(a, b);
    assert.strictEqual(o.sharedCount, 2);
    assert.strictEqual(o.weightOverlapPercent, 13); // 5 + 8
    // union = {HDFCBANK,RELIANCE,INFY,TCS} = 4 ; shared = 2 → 50%
    assert.strictEqual(o.jaccardPercent, 50);
  });

  it("ZERO common value: two funds with no shared key → 0 everywhere (not NaN)", () => {
    const o = portfolioOverlap(
      [{ key: "A", weight: 50 }],
      [{ key: "B", weight: 50 }]
    );
    assert.strictEqual(o.sharedCount, 0);
    assert.strictEqual(o.weightOverlapPercent, 0);
    assert.strictEqual(o.jaccardPercent, 0);
    assert.ok(Number.isFinite(o.weightOverlapPercent));
    assert.ok(Number.isFinite(o.jaccardPercent));
  });

  it("DIV-BY-ZERO: two empty funds → union 0 → 0 jaccard, no NaN", () => {
    const o = portfolioOverlap([], []);
    assert.strictEqual(o.sharedCount, 0);
    assert.strictEqual(o.jaccardPercent, 0);
    assert.strictEqual(o.weightOverlapPercent, 0);
  });

  it("NON-FINITE weights on shared keys contribute 0 to the overlap (no poison)", () => {
    const o = portfolioOverlap(
      [
        { key: "X", weight: NaN },
        { key: "Y", weight: 10 },
      ],
      [
        { key: "X", weight: Infinity },
        { key: "Y", weight: 4 },
      ]
    );
    // X: min(0,0)=0 ; Y: min(10,4)=4
    assert.strictEqual(o.weightOverlapPercent, 4);
    assert.ok(Number.isFinite(o.weightOverlapPercent));
    assert.ok(Number.isFinite(o.jaccardPercent));
  });

  it("case-insensitive keys + duplicate keys summed", () => {
    const o = portfolioOverlap(
      [
        { key: "hdfcbank", weight: 4 },
        { key: "HDFCBANK", weight: 6 }, // same key after upper → 10
      ],
      [{ key: "HDFCBANK", weight: 7 }]
    );
    assert.strictEqual(o.sharedCount, 1);
    assert.strictEqual(o.weightOverlapPercent, 7); // min(10,7)
  });
});

describe("MONEY-620 fund-composition-logic — normalizeComposition (top-level)", () => {
  it("BEHAVIOUR-PRESERVING: clean finite input round-trips fields + ordering", () => {
    const out = normalizeComposition(rawComp());
    assert.strictEqual(out.fundType, "MF");
    assert.strictEqual(out.fundId, "119598");
    assert.strictEqual(out.totalHoldings, 2);
    assert.strictEqual(out.confidence, 0.9);
    assert.strictEqual(out.dataAsOf, "2025-12");
    // holdings sorted by weight DESC (Reliance 7.5 before Infosys 6.3)
    assert.strictEqual(out.holdings[0]!.holdingName, "Reliance");
    assert.strictEqual(out.holdings[1]!.holdingName, "Infosys");
    // pre-aggregated breakdown preserved (sorted DESC) + coverage
    assert.strictEqual(out.sectorBreakdown[0]!.sector, "Energy");
    assert.strictEqual(out.coveragePercent, 13.8);
    assert.ok(Number.isFinite(out.coveragePercent));
  });

  it("derives a MISSING breakdown from the holdings (never an empty/NaN pie)", () => {
    const out = normalizeComposition(
      rawComp({
        sectorBreakdown: [],
        capBreakdown: [],
        assetBreakdown: [],
        holdings: [
          hld({
            holdingName: "A",
            sector: "Energy",
            marketCap: "LARGE",
            holdingType: "EQUITY",
            weightPercent: 7.5,
          }),
          hld({
            holdingName: "B",
            sector: "IT",
            marketCap: "MID",
            holdingType: "EQUITY",
            weightPercent: 6.3,
          }),
        ],
      })
    );
    // sectorBreakdown derived from holdings, sorted DESC
    assert.deepStrictEqual(out.sectorBreakdown, [
      { sector: "Energy", weight: 7.5 },
      { sector: "IT", weight: 6.3 },
    ]);
    // assetBreakdown derived: both EQUITY → 13.8
    assert.deepStrictEqual(out.assetBreakdown, [
      { type: "EQUITY", weight: 13.8 },
    ]);
    for (const s of out.sectorBreakdown) assert.ok(Number.isFinite(s.weight));
  });

  it("CONSUMER-SAFETY: a poisoned input yields a FULLY FINITE composition, no NaN slice", () => {
    const out = normalizeComposition(
      rawComp({
        holdings: [
          hld({ holdingName: "Good", weightPercent: 40, sector: "Energy" }),
          hld({ holdingName: "BadNaN", weightPercent: NaN, sector: "IT" }),
          hld({ holdingName: "BadInf", weightPercent: Infinity, sector: null }),
        ],
        sectorBreakdown: [
          { sector: "Energy", weight: 40 },
          { sector: "IT", weight: NaN }, // poison slice
        ],
        confidence: Infinity,
        dataAsOf: new Date("garbage") as unknown as string,
        totalHoldings: NaN,
      })
    );
    // every holding weight finite; top holding is the real one
    for (const h of out.holdings) {
      assert.ok(Number.isFinite(h.weightPercent));
      assert.notStrictEqual(h.weightPercent.toFixed(2), "NaN");
    }
    assert.strictEqual(out.holdings[0]!.holdingName, "Good");
    // every breakdown slice finite (Recharts <Pie value> never NaN)
    for (const s of out.sectorBreakdown) {
      assert.ok(Number.isFinite(s.weight));
      assert.notStrictEqual((s.weight as number).toFixed(1), "NaN");
    }
    // coverage finite; confidence clamped; dataAsOf safe (no "Invalid Date")
    assert.ok(Number.isFinite(out.coveragePercent));
    assert.strictEqual(out.coveragePercent, 40); // only the good weight counted
    assert.strictEqual(out.confidence, 0); // non-finite confidence → 0 (conservative)
    assert.strictEqual(out.dataAsOf, ""); // invalid date → ""
    // totalHoldings falls back to holdings length when stored count is non-finite
    assert.strictEqual(out.totalHoldings, 3);
    // 100 - coverage (the disclaimer math) is finite
    assert.ok(Number.isFinite(100 - out.coveragePercent));
  });

  it("EMPTY composition → finite zeros, empty arrays, no throw", () => {
    const out = normalizeComposition(
      rawComp({
        holdings: [],
        sectorBreakdown: [],
        capBreakdown: [],
        assetBreakdown: [],
        totalHoldings: 0,
        confidence: 0,
        dataAsOf: "",
      })
    );
    assert.deepStrictEqual(out.holdings, []);
    assert.deepStrictEqual(out.sectorBreakdown, []);
    assert.deepStrictEqual(out.capBreakdown, []);
    assert.deepStrictEqual(out.assetBreakdown, []);
    assert.strictEqual(out.coveragePercent, 0);
    assert.strictEqual(out.totalHoldings, 0);
  });
});

// ══════════════════════════════════════════════════════════════════════════
// B. LIVE service — drive the REAL @usemoney/services export through a
//    recording @usemoney/core/market-data + @usemoney/core + @usemoney/logger
//    seam injected via require.cache (no shadow, no live I/O).
// ══════════════════════════════════════════════════════════════════════════

type ModuleCache = Record<string, { exports: unknown } | undefined>;
function moduleCache(): ModuleCache {
  return (require as unknown as { cache: ModuleCache }).cache;
}

const SILENT_LOGGER = {
  debug() {},
  error() {},
  info() {},
  warn() {},
  trace() {},
  fatal() {},
  child() {
    return SILENT_LOGGER;
  },
};

function makeLoggerStub(): Record<string, unknown> {
  const factory = () => SILENT_LOGGER;
  return new Proxy(
    { __esModule: true },
    {
      get(_t, k: string) {
        if (k === "__esModule") return true;
        if (k === "getLogger" || k === "default" || k === "createModuleLoggers")
          return factory;
        if (k === "initLogger" || k === "flushLogs")
          return async () => undefined;
        return SILENT_LOGGER;
      },
    }
  );
}

// ── recording market-data double (the DB-read functions) ────────────────────

interface MarketDataRecorder {
  fromDb: unknown; // what getCompositionFromDb returns (null by default)
  orExtract: unknown; // what getOrExtractComposition returns
  fromDbThrows?: Error;
  orExtractThrows?: Error;
  calls: Array<{ fn: string; args: unknown[] }>;
}
function freshMarketData(): MarketDataRecorder {
  return { fromDb: null, orExtract: null, calls: [] };
}

interface CacheRecorder {
  setCachedCalls: Array<{
    namespace: string;
    scope: string;
    key: string;
    value: unknown;
  }>;
  /**
   * KEYED, MONEY-1401 F5. The old recorder was a single `cacheHit` consumed by
   * the first `getCached` regardless of key, which cannot express the defect
   * this suite now has to see at all: the service reads TWO keys, one per
   * source, and "which of them was hit" is the whole question.
   */
  hits: Map<string, unknown>;
  getCachedKeys: string[];
}
function freshCache(): CacheRecorder {
  return { setCachedCalls: [], hits: new Map(), getCachedKeys: [] };
}

let activeMarketData: MarketDataRecorder = freshMarketData();
let activeCache: CacheRecorder = freshCache();

/** The REAL pure index-route helpers, loaded lazily (pure = safe to require). */
function realDiscoverSectionLogic(): unknown {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  return require("../../../../packages/core/src/market-data/discover-section-logic");
}

function makeMarketDataStub(): Record<string, unknown> {
  return new Proxy(
    { __esModule: true },
    {
      get(_t, k: string) {
        if (k === "__esModule") return true;
        if (k === "getCompositionFromDb") {
          return async (...args: unknown[]) => {
            activeMarketData.calls.push({ fn: "getCompositionFromDb", args });
            if (activeMarketData.fromDbThrows)
              throw activeMarketData.fromDbThrows;
            return activeMarketData.fromDb;
          };
        }
        if (k === "getOrExtractComposition") {
          return async (...args: unknown[]) => {
            activeMarketData.calls.push({
              fn: "getOrExtractComposition",
              args,
            });
            if (activeMarketData.orExtractThrows)
              throw activeMarketData.orExtractThrows;
            return activeMarketData.orExtract;
          };
        }
        // MONEY-1405 D5 — the ETF cross-check needs the route resolver, and a
        // hand-written fake here would be a SHADOW of the very heuristic the
        // ticket says to reuse. `discover-section-logic` is pure (no I/O at
        // import), so the double DELEGATES to the real thing.
        if (k === "normalizeIndexSlug" || k === "resolveIndexRoute") {
          return (realDiscoverSectionLogic() as Record<string, unknown>)[k];
        }
        // MONEY-1294 — `schemeCodeWhere` BUILDS THE WHERE CLAUSE, so the noop
        // below is not a harmless stub for it: it would return a Promise, and
        // `Object.entries(promise)` is `[]`, so `whereMatches` would match every
        // stored row. That silently un-does the F18 fix ("the double ANSWERS the
        // query") for `findFirst` — the service could ask for any scheme and
        // still be handed this one's. `mf-portfolio-section-logic` imports
        // NOTHING, so the double delegates to the real builder.
        if (k === "schemeCodeWhere") {
          // eslint-disable-next-line @typescript-eslint/no-require-imports
          return require("../../../../packages/core/src/market-data/mf-portfolio-section-logic")
            .schemeCodeWhere;
        }
        // A CONSTANT, read somewhere in the import chain rather than called.
        // The old fall-through handed it `async () => null` — a FUNCTION where a
        // string belongs — which is the same shape mistake as `schemeCodeWhere`
        // below, just one that happened to be harmless. Delegating keeps the
        // value real and un-driftable instead of pinning a second copy of the
        // literal here.
        //
        // MONEY-1401 L2 — this used to justify the delegation with
        // "`fii-stats-logic` has ZERO imports", which is FALSE: it imports
        // `xlsx`, `./institutional-flows` and `./market-positioning-logic`.
        // Harmless, and the reason is worth stating correctly because it is what
        // a future reader will check against: the safe property is that none of
        // those reach a DB, a cache or a network client, and that this exact
        // closure is ALREADY pulled in by `realDiscoverSectionLogic()` above —
        // `discover-section-logic.ts:60` imports `FII_STATS_METRIC` from it. A
        // module with imports is fine here; a module with I/O at import is not.
        if (k === "FII_STATS_METRIC") {
          // eslint-disable-next-line @typescript-eslint/no-require-imports
          return require("../../../../packages/core/src/market-data/fii-stats-logic")
            .FII_STATS_METRIC;
        }
        // AN UNKNOWN EXPORT IS A TEST FAILURE, NOT A NOOP — MONEY-1294.
        //
        // This used to `return async () => null` for anything unhandled, and
        // that is how `schemeCodeWhere` broke this file the day it was added:
        // the service calls it SYNCHRONOUSLY to build a `where`, so the noop
        // handed it a Promise, `Object.entries(promise)` is `[]`, and
        // `whereMatches` then matched EVERY stored row — silently disarming the
        // F18 selectivity fix while 60 of 61 cases stayed green.
        //
        // The noop is a safe stub for an async data-fetcher and an actively
        // dangerous one for a pure helper, and the double cannot tell which it
        // is being asked for. So it refuses to guess: a new export reaching here
        // fails loudly, naming itself, and whoever added it decides whether to
        // stub it or delegate to the real (pure) module as the three above do.
        //
        // Measured 2026-09-14: with every current export handled, NOTHING
        // reaches this line except symbol keys and `then`.
        //
        // HOW THIS FAILS, so the next reader is not misled: the access happens
        // at MODULE LOAD, so the throw kills whole suites during collection and
        // the run prints a REDUCED CASE COUNT with `# fail 0` — measured 34 of
        // 67 when the delegation below was removed. `grep '^not ok'` alone will
        // not see it; the case COUNT moving is the signal. That is the same
        // reporting quirk recorded against `# fail 0` elsewhere in this repo,
        // and it is still strictly better than the silent wrong answer it
        // replaces — the message names the missing export.
        if (typeof k === "symbol") return undefined;
        // `then` would make the module namespace look THENABLE and hang or
        // mangle an `await import()`. It is never a real export here.
        if (k === "then") return undefined;
        throw new Error(
          `[test double] @usemoney/core/market-data export "${String(k)}" is ` +
            `not stubbed. Do NOT add it to the noop fall-through: a pure helper ` +
            `returned as an async noop yields a Promise, which silently made ` +
            `this file's where-matcher match every row (MONEY-1294). Stub it ` +
            `explicitly, or delegate to the real module if it is pure.`
        );
      },
    }
  );
}

// ── recording @usemoney/database double (MONEY-1405 D4) ─────────────────────
//
// `getFundComposition` reads `mf_portfolio_holdings` BEFORE it reads anything
// else, so the seam this file already owns is no longer complete without a
// Prisma double. Left un-stubbed the service reaches a real client and fails
// with "Environment variable not found: DATABASE_URL" — which the service
// catches and sanitizes, so it presents as a plausible service error rather
// than as a missing stub.

interface DbRecorder {
  /**
   * Newest disclosed period for the scheme, or null = the AMC published none.
   * Convenience over {@link DbRecorder.holdings}: when set, it stamps that
   * period (and {@link DEFAULT_SCHEME_KEY}) onto every `disclosureRows` entry.
   */
  newestPeriod: Date | null;
  /** The AMFI code those rows are filed under. Must match what the test asks for. */
  schemeCode: string;
  /** Rows for that period (a `MfPortfolioHolding` subset). */
  disclosureRows: Array<Record<string, unknown>>;
  /**
   * The FULL stored table, when a case needs rows the query must NOT select —
   * another scheme's month, another schemeKey under the same code. Takes
   * precedence over `newestPeriod`/`disclosureRows`.
   */
  holdings?: Array<Record<string, unknown>>;
  /** ISIN → instrument rows for the sector/symbol join. */
  instruments: Array<Record<string, unknown>>;
  /** Index membership rows for the cap buckets. */
  constituents: Array<{ indexId: string; symbol: string }>;
  /** `mutual_fund_masters` rows — what `/compare` resolves a fund from. */
  funds: Array<Record<string, unknown>>;
  calls: string[];
  findMany?: { take?: number; orderBy?: unknown };
  throwOn?: string;
}

const DEFAULT_SCHEME_CODE = "119598";
const DEFAULT_SCHEME_KEY = "hdfc-nifty-50";
const DEFAULT_AMC = "HDFC";

function freshDb(): DbRecorder {
  return {
    newestPeriod: null,
    schemeCode: DEFAULT_SCHEME_CODE,
    disclosureRows: [],
    instruments: [],
    constituents: [],
    funds: [],
    calls: [],
  };
}
let activeDb: DbRecorder = freshDb();

/**
 * The stored `mf_portfolio_holdings` rows, assembled from whichever of the two
 * fixtures a case set. Rows get an `amfiSchemeCode`/`schemeKey`/`period` unless
 * they carry their own.
 */
function storedHoldings(): Array<Record<string, unknown>> {
  if (activeDb.holdings) return activeDb.holdings;
  if (!activeDb.newestPeriod) return [];
  return activeDb.disclosureRows.map((row) => ({
    amfiSchemeCode: activeDb.schemeCode,
    amc: DEFAULT_AMC,
    schemeKey: DEFAULT_SCHEME_KEY,
    period: activeDb.newestPeriod,
    ...row,
  }));
}

/**
 * MONEY-1401 F18 — the double ANSWERS THE QUERY.
 *
 * It used to take no arguments at all and return the same rows for every read,
 * which made eight of this file's cases vacuous: mutating the service's WHERE
 * to `{}` left every one of them green while production took the globally
 * newest period and an arbitrary 800 rows for every fund on the platform.
 * Supports only what this service issues — equality on `amfiSchemeCode`, `amc`,
 * `schemeKey`, `period`, `{ in: [...] }` on `isin`/`indexId`, `{ has }` on
 * `amfiSchemeCodes`, and the top-level `OR` that `schemeCodeWhere` builds — and
 * THROWS on anything else rather than matching it silently, because a clause
 * the double ignores is a clause the test cannot see.
 */
function whereMatches(
  row: Record<string, unknown>,
  where: Record<string, unknown> | undefined
): boolean {
  for (const [field, clause] of Object.entries(where ?? {})) {
    // MONEY-1294 — `schemeCodeWhere` returns `{ OR: [...] }`. Left unhandled it
    // falls into the object branch below and throws "unsupported", which the
    // service's own try/catch converts into a silent UNAVAILABLE.
    if (field === "OR") {
      if (!Array.isArray(clause)) {
        throw new Error("fund-composition double: OR must be an array");
      }
      if (
        !clause.some((c) =>
          whereMatches(row, c as Record<string, unknown> | undefined)
        )
      ) {
        return false;
      }
      continue;
    }
    const value = row[field];
    // OPERATOR CLAUSES FIRST, and `instanceof Date` excluded from the test —
    // MONEY-1401. The Date branch below used to run first, and its condition is
    // `value instanceof Date`, so `period: { lt: <Date> }` (which
    // `getMfPortfolioSection` issues for the prior month) compared the CLAUSE
    // OBJECT against a timestamp, never matched, and reported "this scheme
    // published one month" for every fund — silently, with no unsupported-clause
    // throw to notice.
    if (
      clause !== null &&
      typeof clause === "object" &&
      !(clause instanceof Date)
    ) {
      // `{ has: x }` — the absence-safe array test `schemeCodeWhere` uses for
      // `amfiSchemeCodes`. An absent field simply does not contain anything.
      if ("has" in (clause as Record<string, unknown>)) {
        const list = Array.isArray(value) ? value : [];
        if (!list.includes((clause as { has: unknown }).has)) return false;
        continue;
      }
      if ("lt" in (clause as Record<string, unknown>)) {
        const bound = (clause as { lt: unknown }).lt;
        const a = value instanceof Date ? value.getTime() : Number(value);
        const b = bound instanceof Date ? bound.getTime() : Number(bound);
        if (!(a < b)) return false;
        continue;
      }
      const inList = (clause as { in?: unknown[] }).in;
      if (!Array.isArray(inList)) {
        throw new Error(
          `fund-composition double: unsupported WHERE clause on "${field}": ${JSON.stringify(clause)}`
        );
      }
      if (!inList.includes(value)) return false;
      continue;
    }
    // Date equality — `typeof new Date() === "object"`, so without this a period
    // equality clause fell into the operator branch above and threw
    // "unsupported", which the service's own try/catch then converted into a
    // silent UNAVAILABLE. Six cases went red with no message anywhere.
    if (clause instanceof Date || value instanceof Date) {
      const a = clause instanceof Date ? clause.getTime() : clause;
      const b = value instanceof Date ? value.getTime() : value;
      if (a !== b) return false;
      continue;
    }
    if (value !== clause) return false;
  }
  return true;
}

type FindArgs = {
  where?: Record<string, unknown>;
  orderBy?: unknown;
  take?: number;
};

function makeDatabaseStub(): Record<string, unknown> {
  const prisma = {
    mfPortfolioHolding: {
      async findFirst(args: FindArgs = {}) {
        activeDb.calls.push("mfPortfolioHolding.findFirst");
        if (activeDb.throwOn === "mfPortfolioHolding.findFirst") {
          throw new Error("mf_portfolio_holdings unreachable");
        }
        const matched = storedHoldings().filter((r) =>
          whereMatches(r, args.where)
        );
        // The service asks for `period: "desc"`; nothing else is issued here.
        matched.sort(
          (a, b) => (b.period as Date).getTime() - (a.period as Date).getTime()
        );
        return matched[0] ?? null;
      },
      async findMany(args: FindArgs = {}) {
        activeDb.calls.push("mfPortfolioHolding.findMany");
        activeDb.findMany = { take: args.take, orderBy: args.orderBy };
        if (activeDb.throwOn === "mfPortfolioHolding.findMany") {
          throw new Error("mf_portfolio_holdings unreachable");
        }
        const matched = storedHoldings().filter((r) =>
          whereMatches(r, args.where)
        );
        matched.sort(
          (a, b) => Number(b.percentToNav ?? 0) - Number(a.percentToNav ?? 0)
        );
        return typeof args.take === "number"
          ? matched.slice(0, args.take)
          : matched;
      },
    },
    instrumentMapping: {
      async findMany(args: FindArgs = {}) {
        activeDb.calls.push("instrumentMapping.findMany");
        if (activeDb.throwOn === "instrumentMapping.findMany") {
          throw new Error("instrument_mappings unreachable");
        }
        return activeDb.instruments.filter((r) => whereMatches(r, args.where));
      },
      // MONEY-1401 F10 — `fetchComparableFund`'s ETF/INDEX/STOCK branch. Its
      // WHERE is an `OR` of `contains`, which this double does not model; those
      // branches are not what F10 is about, so it answers null and the case
      // uses MF, which is the only type carrying a scheme code anyway.
      async findFirst() {
        activeDb.calls.push("instrumentMapping.findFirst");
        return null;
      },
    },
    // MONEY-1401 F10 — `/compare` resolves each fund here before it asks for a
    // composition. Without it the access is `undefined.findFirst`, which
    // `fetchComparableFund` catches and turns into "fund not found" — so the
    // comparison would come back empty and a composition assertion would be
    // vacuous rather than red.
    mutualFundMaster: {
      async findFirst(args: FindArgs = {}) {
        activeDb.calls.push("mutualFundMaster.findFirst");
        return activeDb.funds.find((r) => whereMatches(r, args.where)) ?? null;
      },
    },
    indexConstituent: {
      async findMany(args: FindArgs = {}) {
        activeDb.calls.push("indexConstituent.findMany");
        if (activeDb.throwOn === "indexConstituent.findMany") {
          throw new Error("index_constituents unreachable");
        }
        return activeDb.constituents.filter((r) =>
          whereMatches(r as unknown as Record<string, unknown>, args.where)
        );
      },
    },
  };
  return new Proxy(
    { __esModule: true },
    {
      get(_t, k: string) {
        if (k === "__esModule") return true;
        if (k === "prisma") return prisma;
        return undefined;
      },
    }
  );
}

function makeCoreStub(): Record<string, unknown> {
  return new Proxy(
    { __esModule: true },
    {
      get(_t, k: string) {
        if (k === "__esModule") return true;
        if (k === "getCached") {
          return async (_namespace: string, _scope: string, key: string) => {
            activeCache.getCachedKeys.push(key);
            return activeCache.hits.has(key) ? activeCache.hits.get(key) : null;
          };
        }
        if (k === "setCached") {
          return async (
            namespace: string,
            scope: string,
            key: string,
            value: unknown
          ) => {
            activeCache.setCachedCalls.push({ namespace, scope, key, value });
          };
        }
        return async () => null;
      },
    }
  );
}

// ── service shape (the REAL exported functions we drive) ─────────────────────

interface CompositionShape {
  fundType: "MF" | "ETF" | "INDEX";
  fundId: string;
  holdings: CompositionHolding[];
  sectorBreakdown: Array<{ sector: string; weight: number }>;
  capBreakdown: Array<{ cap: string; weight: number }>;
  assetBreakdown: Array<{ type: string; weight: number }>;
  totalHoldings: number;
  confidence: number;
  dataAsOf: string;
  coveragePercent?: number;
  source?: "AMC_DISCLOSURE" | "GEMINI_RECALL";
}
type Result<T> =
  | { success: true; data: T; message?: string }
  | { success: false; error: string; code?: string };

interface ServicesModule {
  getFundComposition: (
    fundType: "MF" | "ETF" | "INDEX",
    fundId: string,
    schemeCode?: string
  ) => Promise<Result<CompositionShape | null>>;
  triggerCompositionExtraction: (
    fundType: "MF" | "ETF" | "INDEX",
    fundId: string,
    schemeCode?: string
  ) => Promise<Result<CompositionShape>>;
}

/** The `/compare` half of the same barrel — MONEY-1401 F10. */
interface ComparisonModule {
  getComparisonData: (funds: Array<{ type: string; id: string }>) => Promise<
    Result<{
      funds: unknown[];
      compositions: Record<string, unknown>;
      navHistory: Record<string, unknown>;
    }>
  >;
}

let servicesSingleton: ServicesModule | null = null;
const priorCacheEntries: Array<[string, { exports: unknown } | undefined]> = [];

function installServices(): ServicesModule {
  if (servicesSingleton) return servicesSingleton;
  const cache = moduleCache();
  const stub = (path: string, exports: unknown) => {
    priorCacheEntries.push([path, cache[path]]);
    cache[path] = { exports };
  };
  stub(require.resolve("@usemoney/core/market-data"), makeMarketDataStub());
  stub(require.resolve("@usemoney/core"), makeCoreStub());
  stub(require.resolve("@usemoney/logger"), makeLoggerStub());
  stub(require.resolve("@usemoney/database"), makeDatabaseStub());
  // Force a fresh load of every service/logic/index module so they bind to the
  // stubbed boundary (the proven holdings-poison-live seam).
  for (const key of Object.keys(cache)) {
    if (
      key.includes("/packages/services/src/") &&
      (key.endsWith(".service.ts") ||
        key.endsWith("-logic.ts") ||
        // MONEY-1405 D4 — `fund-composition-from-disclosure.ts` matches none of
        // the three suffixes above, so without this it would keep a binding to
        // the PRE-stub module graph while its importer was reloaded.
        key.endsWith("-from-disclosure.ts") ||
        key.endsWith("/index.ts"))
    ) {
      priorCacheEntries.push([key, cache[key]]);
      delete cache[key];
    }
  }
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  servicesSingleton = require("@usemoney/services") as ServicesModule;
  return servicesSingleton;
}

function uninstallServices(): void {
  const cache = moduleCache();
  for (const [path, prior] of priorCacheEntries) {
    if (prior === undefined) delete cache[path];
    else cache[path] = prior;
  }
  priorCacheEntries.length = 0;
  servicesSingleton = null;
}

function reset(): {
  md: MarketDataRecorder;
  cache: CacheRecorder;
  db: DbRecorder;
} {
  activeMarketData = freshMarketData();
  activeCache = freshCache();
  activeDb = freshDb();
  return { md: activeMarketData, cache: activeCache, db: activeDb };
}

function ok<T>(r: Result<T>): { success: true; data: T } {
  assert.equal(r.success, true, `expected success, got ${JSON.stringify(r)}`);
  return r as { success: true; data: T };
}

/** A raw CompositionResult as the DB/Gemini layer would return it. */
function dbResult(overrides: Partial<CompositionShape> = {}): CompositionShape {
  return {
    fundType: "MF",
    fundId: "119598",
    holdings: [
      hld({ holdingName: "Reliance", weightPercent: 40, sector: "Energy" }),
      hld({ holdingName: "Infosys", weightPercent: 35, sector: "IT" }),
    ],
    sectorBreakdown: [
      { sector: "Energy", weight: 40 },
      { sector: "IT", weight: 35 },
    ],
    capBreakdown: [{ cap: "LARGE", weight: 75 }],
    assetBreakdown: [{ type: "EQUITY", weight: 75 }],
    totalHoldings: 2,
    confidence: 0.9,
    dataAsOf: "2025-12",
    ...overrides,
  };
}

describe("MONEY-620 — fund-composition.service: LIVE behaviour-preserving (clean DB data)", () => {
  let svc: ServicesModule;
  before(() => {
    svc = installServices();
  });
  beforeEach(() => {
    reset();
  });
  after(() => {
    uninstallServices();
  });

  it("getFundComposition (cache miss → DB) returns sanitized data + caches it", async () => {
    const { md, cache } = reset();
    md.fromDb = dbResult();
    const res = ok(await svc.getFundComposition("MF", "119598"));
    assert.ok(res.data);
    assert.strictEqual(res.data!.fundType, "MF");
    assert.strictEqual(res.data!.holdings[0]!.holdingName, "Reliance"); // sorted DESC
    assert.strictEqual(res.data!.coveragePercent, 75); // 40 + 35 (new finite field)
    // computed result is cached under the right key
    assert.ok(
      cache.setCachedCalls.some(
        (c) =>
          c.namespace === "fund-composition" &&
          c.scope === "_global" &&
          // MONEY-1405 D4 — the scheme code is part of the KEY. It is part of
          // the ANSWER: the same ETF read once without one and once with would
          // otherwise be served the recollection from cache after the
          // disclosure became reachable. For an MF it equals `fundId`.
          //
          // MONEY-1401 F5 — and so is the SOURCE. A recollection may only ever
          // land in the recollection slot; `/compare` writing this exact key
          // with no scheme code is what replaced a filed SEBI disclosure with a
          // model's memory of one for 24h.
          // MUTATION: drop the `${source}` term from `compositionCacheKey` →
          //   AssertionError (the write lands on the disclosure's key).
          c.key === "MF:119598:119598:GEMINI_RECALL"
      )
    );
    // it went to the DB read (not extraction)
    assert.ok(md.calls.some((c) => c.fn === "getCompositionFromDb"));
  });

  it("getFundComposition: not-yet-extracted (DB null) → success with data:null, no cache write", async () => {
    const { md, cache } = reset();
    md.fromDb = null;
    const res = ok(await svc.getFundComposition("ETF", "NIFTYBEES"));
    assert.strictEqual(res.data, null);
    assert.strictEqual(cache.setCachedCalls.length, 0);
  });

  it("getFundComposition: cache HIT is re-normalized before return (no second DB read)", async () => {
    const { md, cache } = reset();
    cache.hits.set(
      "MF:119598:119598:GEMINI_RECALL",
      dbResult({ confidence: 0.5 })
    );
    const res = ok(await svc.getFundComposition("MF", "119598"));
    assert.ok(res.data);
    assert.strictEqual(res.data!.confidence, 0.5);
    assert.strictEqual(res.data!.coveragePercent, 75); // re-normalized on read
    // a cache hit must not hit the DB read
    assert.strictEqual(
      md.calls.filter((c) => c.fn === "getCompositionFromDb").length,
      0
    );
  });

  it("triggerCompositionExtraction (Gemini) returns sanitized data + caches it", async () => {
    const { md, cache } = reset();
    md.orExtract = dbResult();
    const res = ok(await svc.triggerCompositionExtraction("MF", "119598"));
    assert.strictEqual(res.data.coveragePercent, 75);
    assert.ok(md.calls.some((c) => c.fn === "getOrExtractComposition"));
    assert.ok(
      cache.setCachedCalls.some(
        (c) => c.key === "MF:119598:119598:GEMINI_RECALL"
      )
    );
  });

  it("triggerCompositionExtraction: null result → failure with the fund-unavailable message", async () => {
    const { md } = reset();
    md.orExtract = null;
    const res = await svc.triggerCompositionExtraction("MF", "missing");
    assert.strictEqual(res.success, false);
    assert.strictEqual(
      (res as { success: false; error: string }).error,
      "Failed to extract composition. The fund may not be available."
    );
  });
});

describe("MONEY-620 — fund-composition.service: LIVE poison never reaches a formatter", () => {
  let svc: ServicesModule;
  before(() => {
    svc = installServices();
  });
  beforeEach(() => {
    reset();
  });
  after(() => {
    uninstallServices();
  });

  it("a poisoned DB row → FULLY FINITE composition, no '₹NaN'/NaN% slice, no throw", async () => {
    const { md } = reset();
    md.fromDb = dbResult({
      holdings: [
        hld({ holdingName: "Good", weightPercent: 40, sector: "Energy" }),
        hld({ holdingName: "BadNaN", weightPercent: NaN, sector: "IT" }),
        hld({ holdingName: "BadInf", weightPercent: Infinity, sector: null }),
      ],
      sectorBreakdown: [
        { sector: "Energy", weight: 40 },
        { sector: "IT", weight: NaN }, // poison slice → would be a NaN pie wedge
      ],
      capBreakdown: [{ cap: "LARGE", weight: Infinity }],
      confidence: NaN,
      dataAsOf: new Date("not-a-real-date") as unknown as string,
      totalHoldings: Infinity,
    });

    let res!: { success: true; data: CompositionShape | null };
    await assert.doesNotReject(async () => {
      res = ok(await svc.getFundComposition("MF", "119598"));
    });
    const data = res.data!;

    // ── every holding weight finite; the UI does h.weightPercent.toFixed(2) ──
    for (const h of data.holdings) {
      assert.ok(
        Number.isFinite(h.weightPercent),
        `${h.holdingName}: ${String(h.weightPercent)} must be finite`
      );
      assert.notStrictEqual(h.weightPercent.toFixed(2), "NaN");
    }
    // top holding is the genuine one, the NaN/Infinity rows ranked last
    assert.strictEqual(data.holdings[0]!.holdingName, "Good");

    // ── every breakdown slice finite (Recharts <Pie value=…> never NaN) ──
    for (const g of [
      ...data.sectorBreakdown.map((s) => s.weight),
      ...data.capBreakdown.map((c) => c.weight),
      ...data.assetBreakdown.map((a) => a.weight),
    ]) {
      assert.ok(Number.isFinite(g), `slice ${String(g)} must be finite`);
      assert.notStrictEqual(g.toFixed(1), "NaN");
    }

    // ── coverage total + disclaimer math finite (Σweights / 100-Σ) ──
    assert.ok(Number.isFinite(data.coveragePercent));
    assert.strictEqual(data.coveragePercent, 40); // only the good weight
    assert.ok(Number.isFinite(100 - (data.coveragePercent ?? 0)));
    // the badge does coveragePercent.toFixed(1)
    assert.notStrictEqual((data.coveragePercent ?? 0).toFixed(1), "NaN");

    // ── confidence renders as round(confidence*100)% — must not be NaN% ──
    assert.ok(Number.isFinite(data.confidence));
    assert.notStrictEqual(String(Math.round(data.confidence * 100)), "NaN");

    // ── Invalid-Date dataAsOf degraded to "" (no throw, no "Invalid Date") ──
    assert.strictEqual(data.dataAsOf, "");

    // ── totalHoldings falls back to the holdings length when stored is non-finite ──
    assert.strictEqual(data.totalHoldings, 3);
  });

  it("ALL holdings corrupt → empty-but-finite coverage 0, no NaN anywhere", async () => {
    const { md } = reset();
    md.fromDb = dbResult({
      holdings: [
        hld({ holdingName: "X", weightPercent: NaN }),
        hld({ holdingName: "Y", weightPercent: Infinity }),
        hld({ holdingName: "Z", weightPercent: -Infinity }),
      ],
      sectorBreakdown: [{ sector: "IT", weight: NaN }],
    });
    const res = ok(await svc.getFundComposition("MF", "allbad"));
    const data = res.data!;
    assert.strictEqual(data.coveragePercent, 0);
    for (const h of data.holdings) assert.strictEqual(h.weightPercent, 0);
    for (const s of data.sectorBreakdown) assert.ok(Number.isFinite(s.weight));
    assert.ok(Number.isFinite(data.coveragePercent));
  });
});

describe("MONEY-620 — fund-composition.service: LIVE error sanitization", () => {
  let svc: ServicesModule;
  before(() => {
    svc = installServices();
  });
  after(() => {
    uninstallServices();
  });

  it("getFundComposition: a thrown DB error is sanitized to the service message", async () => {
    const { md } = reset();
    md.fromDbThrows = new Error(
      "E11000 duplicate key error on internal.collection"
    );
    const res = await svc.getFundComposition("MF", "119598");
    assert.strictEqual(res.success, false);
    assert.strictEqual(
      (res as { success: false; error: string }).error,
      "Failed to load composition data"
    );
  });

  it("triggerCompositionExtraction: a thrown extraction error is sanitized", async () => {
    const { md } = reset();
    md.orExtractThrows = new Error("Gemini 500 internal: stacktrace leak");
    const res = await svc.triggerCompositionExtraction("MF", "119598");
    assert.strictEqual(res.success, false);
    assert.strictEqual(
      (res as { success: false; error: string }).error,
      "Extraction failed. Please try again."
    );
  });
});

// ══════════════════════════════════════════════════════════════════════════
// C. MONEY-1405 D4/D5 — the AMC disclosure comes FIRST, and the recollection
//    is what happens when there is no filing to read.
//
//    Same seam as B: the REAL exported `getFundComposition` is driven through
//    the recording `@usemoney/database` / `@usemoney/core/market-data` doubles,
//    so the ORDER of the two reads is observed on the shipping code rather than
//    asserted about a copy of it.
// ══════════════════════════════════════════════════════════════════════════

/** One disclosure row as `MfPortfolioHolding` stores it. */
function disc(
  overrides: Partial<Record<string, unknown>> = {}
): Record<string, unknown> {
  return {
    instrumentName: "HDFC Bank Ltd",
    isin: "INE040A01034",
    holdingType: "EQUITY",
    percentToNav: 10,
    schemeName: "HDFC NIFTY 50 ETF",
    ...overrides,
  };
}

describe("MONEY-1405 D4 — getFundComposition serves the AMC disclosure first", () => {
  let svc: ServicesModule;
  before(() => {
    svc = installServices();
  });
  beforeEach(() => {
    reset();
  });
  after(() => {
    uninstallServices();
  });

  it("[regression] a disclosure exists → the Gemini-backed read is NEVER invoked", async () => {
    const { md, db } = reset();
    // A recollection IS available. Before D4 this is what shipped to the UI.
    md.fromDb = dbResult();
    db.newestPeriod = new Date(Date.UTC(2026, 6, 1));
    db.disclosureRows = [
      disc({
        instrumentName: "Reliance",
        isin: "INE002A01018",
        percentToNav: 60,
      }),
      disc({
        instrumentName: "Infosys",
        isin: "INE009A01021",
        percentToNav: 40,
      }),
    ];
    db.instruments = [
      {
        isin: "INE002A01018",
        symbol: "RELIANCE",
        exchange: "NSE",
        sector: "Energy",
        industry: null,
      },
      {
        isin: "INE009A01021",
        symbol: "INFY",
        exchange: "NSE",
        sector: "Information Technology",
        industry: null,
      },
    ];

    const res = ok(await svc.getFundComposition("MF", "119598"));
    assert.ok(res.data);
    assert.strictEqual(res.data!.source, "AMC_DISCLOSURE");
    assert.strictEqual(res.data!.holdings[0]!.holdingName, "Reliance");
    // MUTATION: delete the `if (disclosed) { … return … }` early return in
    // `compositionFromDisclosure`'s caller so the flow falls through to
    // `getCompositionFromDb`. This assertion goes red — VERIFIED.
    assert.strictEqual(
      md.calls.filter((c) => c.fn === "getCompositionFromDb").length,
      0,
      "a filed portfolio must never be second-guessed by a model recollection"
    );
    assert.ok(db.calls.includes("mfPortfolioHolding.findMany"));
  });

  it("no disclosure → falls back to the recollection, LABELLED as one", async () => {
    const { md, db } = reset();
    md.fromDb = dbResult();
    db.newestPeriod = null; // the AMC has published nothing for this scheme

    const res = ok(await svc.getFundComposition("MF", "119598"));
    assert.ok(res.data);
    assert.strictEqual(res.data!.source, "GEMINI_RECALL");
    assert.ok(md.calls.some((c) => c.fn === "getCompositionFromDb"));
  });

  it("sector donut sums to 100 ± 0.1 with ONE Unclassified slice for the cash lines", async () => {
    const { db } = reset();
    db.newestPeriod = new Date(Date.UTC(2026, 6, 1));
    db.disclosureRows = [
      disc({
        instrumentName: "HDFC Bank",
        isin: "INE040A01034",
        percentToNav: 40,
      }),
      disc({
        instrumentName: "Reliance",
        isin: "INE002A01018",
        percentToNav: 35,
      }),
      disc({
        instrumentName: "Infosys",
        isin: "INE009A01021",
        percentToNav: 24.7,
      }),
      // No ISIN at all — TREPS and net receivables are ~0.3% of every NAV and
      // are the reason the donut must COUNT what it cannot attribute.
      disc({
        instrumentName: "TREPS - Tri-party Repo",
        isin: null,
        holdingType: "CASH",
        percentToNav: 0.3,
      }),
    ];
    db.instruments = [
      {
        isin: "INE040A01034",
        symbol: "HDFCBANK",
        exchange: "NSE",
        sector: "Financial Services",
        industry: null,
      },
      {
        isin: "INE002A01018",
        symbol: "RELIANCE",
        exchange: "NSE",
        sector: "Energy",
        industry: null,
      },
      {
        isin: "INE009A01021",
        symbol: "INFY",
        exchange: "NSE",
        sector: "Information Technology",
        industry: null,
      },
    ];

    const res = ok(await svc.getFundComposition("MF", "119598"));
    const sectors = res.data!.sectorBreakdown;
    const total = sectors.reduce((s, x) => s + x.weight, 0);
    assert.ok(
      Math.abs(total - 100) <= 0.1,
      `sector donut must fill the circle; got ${total}`
    );
    // MUTATION: return an EMPTY `instrumentsByIsin` from the service (drop the
    // ISIN join) — `named` becomes [] and this goes red while the sum above
    // still reads 100. Both halves are required. VERIFIED.
    const named = sectors.filter((s) => s.sector !== "Unclassified");
    assert.deepStrictEqual(named.map((s) => s.sector).sort(), [
      "Energy",
      "Financial Services",
      "Information Technology",
    ]);
    const unclassified = sectors.filter((s) => s.sector === "Unclassified");
    assert.strictEqual(
      unclassified.length,
      1,
      "the cash line is counted, not dropped"
    );
    assert.ok(unclassified[0]!.weight > 0);
  });

  it("cap buckets come from index MEMBERSHIP, never from a weight NSE does not publish", async () => {
    const { db } = reset();
    db.newestPeriod = new Date(Date.UTC(2026, 6, 1));
    db.disclosureRows = [
      disc({
        instrumentName: "HDFC Bank",
        isin: "INE040A01034",
        percentToNav: 50,
      }),
      disc({
        instrumentName: "Midcap Co",
        isin: "INEMID000001",
        percentToNav: 50,
      }),
    ];
    db.instruments = [
      {
        isin: "INE040A01034",
        symbol: "HDFCBANK",
        exchange: "NSE",
        sector: "Financial Services",
        industry: null,
      },
      {
        isin: "INEMID000001",
        symbol: "MIDCO",
        exchange: "NSE",
        sector: "Industrials",
        industry: null,
      },
    ];
    db.constituents = [
      { indexId: "nifty50", symbol: "HDFCBANK" },
      { indexId: "niftymidcap150", symbol: "MIDCO" },
    ];

    const res = ok(await svc.getFundComposition("MF", "119598"));
    const caps = new Map(res.data!.capBreakdown.map((c) => [c.cap, c.weight]));
    // MUTATION: drop the `indexConstituent.findMany` read (empty cap map) →
    // both land in Unclassified and this goes red. VERIFIED.
    assert.strictEqual(caps.get("LARGE"), 50);
    assert.strictEqual(caps.get("MID"), 50);
    assert.strictEqual(caps.has("Unclassified"), false);
  });

  it("[regression] the scheme code is part of the CACHE KEY, not only of the lookup", async () => {
    const { md, cache, db } = reset();
    md.fromDb = dbResult();
    db.newestPeriod = null;
    await svc.getFundComposition("ETF", "NIFTYBEES", "135853");
    assert.ok(
      cache.setCachedCalls.some(
        (c) => c.key === "ETF:NIFTYBEES:135853:GEMINI_RECALL"
      ),
      "an ETF read without a scheme code must not serve the same entry as one with"
    );
  });

  it("an ETF is looked up BY SCHEME CODE — a trading symbol reaches no disclosure", async () => {
    const { md, db } = reset();
    md.fromDb = dbResult();
    db.newestPeriod = new Date(Date.UTC(2026, 6, 1));
    db.schemeCode = "135853";
    db.disclosureRows = [disc({ percentToNav: 100 })];
    db.instruments = [
      {
        isin: "INE040A01034",
        symbol: "HDFCBANK",
        exchange: "NSE",
        sector: "Financial Services",
        industry: null,
      },
    ];

    // Without the scheme code: no disclosure read at all, recollection served.
    const bare = ok(await svc.getFundComposition("ETF", "HDFCNIFETF"));
    assert.strictEqual(bare.data!.source, "GEMINI_RECALL");
    assert.strictEqual(
      activeDb.calls.filter((c) => c.startsWith("mfPortfolioHolding")).length,
      0,
      "mf_portfolio_holdings has never been keyed by a trading symbol"
    );

    // With it: the filing.
    const withCode = ok(
      await svc.getFundComposition("ETF", "HDFCNIFETF", "135853")
    );
    assert.strictEqual(withCode.data!.source, "AMC_DISCLOSURE");
  });

  it("the NSE row wins the ISIN join in EITHER order, so the cap bucket survives a BSE scrip id", async () => {
    // BOTH orders, because `findMany` does not promise one and a guard that
    // only works when the rows happen to arrive NSE-last is not a guard. This
    // test read only the BSE-first order at first and was VACUOUS: with no
    // skip at all, last-write-wins already produced the NSE row.
    const NSE = {
      isin: "INE040A01034",
      symbol: "HDFCBANK",
      exchange: "NSE",
      sector: "Financial Services",
      industry: null,
    };
    const BSE = {
      isin: "INE040A01034",
      symbol: "500180",
      exchange: "BSE",
      sector: null,
      industry: null,
    };
    for (const [label, rows] of [
      ["BSE first", [BSE, NSE]],
      ["NSE first", [NSE, BSE]],
    ] as const) {
      const { db } = reset();
      db.newestPeriod = new Date(Date.UTC(2026, 6, 1));
      db.disclosureRows = [disc({ isin: "INE040A01034", percentToNav: 100 })];
      db.instruments = [...rows];
      db.constituents = [{ indexId: "nifty50", symbol: "HDFCBANK" }];

      const res = ok(await svc.getFundComposition("MF", "119598"));
      // MUTATION: remove the `existing && row.exchange !== "NSE"` skip → the
      // NSE-first case yields symbol "500180", no cap hit. VERIFIED red.
      assert.strictEqual(
        res.data!.holdings[0]!.holdingSymbol,
        "HDFCBANK",
        label
      );
      assert.strictEqual(res.data!.capBreakdown[0]!.cap, "LARGE", label);
    }
  });

  it("[regression] MONEY-1401 F21 — NSE vs NSE is decided by a RANK, not by arrival order", async () => {
    // The reviewer named the 870 suffixed twins (`SYM-BE`/`-SM`) as the
    // population. They cannot reach this join: a suffixed twin is the row with
    // NO ISIN, and this query is `isin: { in: [...] }`. What DOES collide is a
    // RENAME — measured on prod 2026-09-13, exactly 2 ISINs carry more than one
    // NSE row, and this is one of them verbatim.
    //
    // MUTATION: in `resolveInstrumentsByIsin`, replace the rank comparison with
    // an unconditional `best.set(isin, row)` (last-write-wins, the old
    // behaviour) → the "stale first" order still passes and "stale last" yields
    // "MANBRO" with no cap bucket. Both orders are required. VERIFIED red.
    const ACTIVE = {
      isin: "INE348N01042",
      symbol: "KDGREEN",
      exchange: "NSE",
      sector: "Utilities",
      industry: null,
      isActive: true,
    };
    const RENAMED_AWAY = {
      isin: "INE348N01042",
      symbol: "MANBRO",
      exchange: "NSE",
      sector: "Utilities",
      industry: null,
      isActive: false,
    };
    for (const [label, rows] of [
      ["stale first", [RENAMED_AWAY, ACTIVE]],
      ["stale last", [ACTIVE, RENAMED_AWAY]],
    ] as const) {
      const { db } = reset();
      db.newestPeriod = new Date(Date.UTC(2026, 6, 1));
      db.disclosureRows = [disc({ isin: "INE348N01042", percentToNav: 100 })];
      db.instruments = [...rows];
      db.constituents = [{ indexId: "niftymidcap150", symbol: "KDGREEN" }];

      const res = ok(await svc.getFundComposition("MF", "119598"));
      assert.strictEqual(
        res.data!.holdings[0]!.holdingSymbol,
        "KDGREEN",
        label
      );
      assert.strictEqual(res.data!.capBreakdown[0]!.cap, "MID", label);
    }
  });

  it("[regression] MONEY-1401 F19 — a thrown index_constituents read does NOT cost the stored composition", async () => {
    // `index_constituents` only colours the cap donut. Before this, a throw
    // anywhere inside `compositionFromDisclosure` reached `getFundComposition`'s
    // OUTER catch, so `getCompositionFromDb` was never reached and the reader
    // got "Failed to load composition data" instead of a perfectly good stored
    // composition.
    //
    // MUTATION: delete the try/catch in `compositionFromDisclosure` →
    //   AssertionError: expected success, got {"success":false,...}. VERIFIED.
    const { md, db } = reset();
    md.fromDb = dbResult();
    db.newestPeriod = new Date(Date.UTC(2026, 6, 1));
    db.disclosureRows = [disc({ percentToNav: 100 })];
    db.throwOn = "indexConstituent.findMany";

    const res = ok(await svc.getFundComposition("MF", "119598"));
    assert.ok(res.data, "the stored composition still reaches the reader");
    assert.strictEqual(res.data!.source, "GEMINI_RECALL");
    assert.ok(md.calls.some((c) => c.fn === "getCompositionFromDb"));
  });

  it("[regression] MONEY-1401 F19 — a FAILED disclosure read is never cached as an absence", async () => {
    // `NONE` is determinate and cacheable; `UNAVAILABLE` is "we could not
    // tell". Writing the `{none:true}` sentinel on a throw would turn one
    // transient blip into 24h of serving a recollection over a filed
    // disclosure, with nothing to distinguish it from a scheme that never
    // filed.
    //
    // MUTATION: write the sentinel on `UNAVAILABLE` too (drop the
    // `status === "NONE"` check) → AssertionError. VERIFIED red.
    const { md, cache, db } = reset();
    md.fromDb = dbResult();
    db.throwOn = "mfPortfolioHolding.findFirst";

    ok(await svc.getFundComposition("MF", "119598"));
    assert.ok(
      !cache.setCachedCalls.some((c) => c.key.endsWith(":AMC_DISCLOSURE")),
      "a read that failed has not established that the AMC published nothing"
    );
  });

  it("[regression] MONEY-1401 F18 — the lookup is SELECTIVE: another scheme's rows are not this fund's portfolio", async () => {
    // The whole point of the argument-aware double. With `where: {}` the
    // service takes the globally newest period and an arbitrary 800 rows for
    // EVERY fund on the platform, and every case above stays green because
    // every fixture holds exactly one scheme.
    //
    // MUTATION: `where: { amfiSchemeCode: schemeCode }` → `where: {}` in
    //   `readDisclosure` → this fund is served ZEEL, the other scheme's newer
    //   row. VERIFIED red.
    // MUTATION: `where: { schemeKey: newest.schemeKey, period: newest.period }`
    //   → `where: {}` → both schemes' rows union into one portfolio,
    //   totalHoldings 3. VERIFIED red.
    const { db } = reset();
    db.holdings = [
      {
        amfiSchemeCode: "119598",
        schemeKey: "ours",
        period: new Date(Date.UTC(2026, 5, 1)),
        instrumentName: "HDFC Bank Ltd",
        isin: "INE040A01034",
        holdingType: "EQUITY",
        percentToNav: 100,
        schemeName: "Our Fund",
      },
      // A DIFFERENT scheme, a NEWER month, and a heavier line — so an
      // unconstrained findFirst picks its period and an unconstrained findMany
      // sorts it to the top.
      {
        amfiSchemeCode: "999999",
        schemeKey: "theirs",
        period: new Date(Date.UTC(2026, 6, 1)),
        instrumentName: "Zee Entertainment",
        isin: "INE256A01028",
        holdingType: "EQUITY",
        percentToNav: 100,
        schemeName: "Someone Else",
      },
      // Same code as ours, a DIFFERENT schemeKey, same month — the ~200%
      // union the second WHERE narrows away.
      {
        amfiSchemeCode: "119598",
        schemeKey: "ours-direct",
        period: new Date(Date.UTC(2026, 5, 1)),
        instrumentName: "Infosys Ltd",
        isin: "INE009A01021",
        holdingType: "EQUITY",
        percentToNav: 100,
        schemeName: "Our Fund - Direct",
      },
    ];

    const res = ok(await svc.getFundComposition("MF", "119598"));
    assert.ok(res.data);
    assert.strictEqual(res.data!.source, "AMC_DISCLOSURE");
    assert.strictEqual(res.data!.dataAsOf, "2026-06", "our scheme's month");
    assert.strictEqual(res.data!.totalHoldings, 1, "one scheme, one portfolio");
    assert.strictEqual(res.data!.holdings[0]!.holdingName, "HDFC Bank Ltd");
  });

  it("the row cap is APPLIED, so one fund cannot read the whole table", async () => {
    // MUTATION: delete `take: DISCLOSURE_ROW_CAP` → `take` is undefined and
    //   this goes red. VERIFIED.
    const { db } = reset();
    db.newestPeriod = new Date(Date.UTC(2026, 6, 1));
    db.disclosureRows = [disc({ percentToNav: 100 })];
    await svc.getFundComposition("MF", "119598");
    assert.strictEqual(db.findMany!.take, 800);
  });
});

describe("MONEY-1401 F5 — a recollection cannot occupy a disclosure's cache slot", () => {
  let svc: ServicesModule;
  before(() => {
    svc = installServices();
  });
  beforeEach(() => {
    reset();
  });
  after(() => {
    uninstallServices();
  });

  /** The two slots, spelled once so a key change breaks here and not silently. */
  const DISCLOSURE_KEY = "MF:119598:119598:AMC_DISCLOSURE";
  const RECALL_KEY = "MF:119598:119598:GEMINI_RECALL";

  function withDisclosure() {
    const ctx = reset();
    ctx.db.newestPeriod = new Date(Date.UTC(2026, 6, 1));
    ctx.db.disclosureRows = [
      disc({ instrumentName: "HDFC Bank Ltd", percentToNav: 100 }),
    ];
    ctx.db.instruments = [
      {
        isin: "INE040A01034",
        symbol: "HDFCBANK",
        exchange: "NSE",
        sector: "Financial Services",
        industry: null,
        isActive: true,
      },
    ];
    return ctx;
  }

  it("[security] /compare's recollection write does NOT land on the key /mf/[schemeCode] reads", async () => {
    // THE BUG. `/compare` calls the action with NO scheme code; for an MF the
    // service derives `resolvedSchemeCode = fundId`, and an MF `fundId` IS the
    // AMFI scheme code — so the write was byte-identical to the fund page's
    // read key and a `gemini-2.5-pro` recollection replaced a filed SEBI
    // disclosure for 24h.
    //
    // MUTATION: drop the `${source}` term from `compositionCacheKey` →
    //   AssertionError: the recollection lands on MF:119598:119598:… VERIFIED.
    const { md, cache } = reset();
    md.orExtract = dbResult();

    // Exactly how /compare calls it — `triggerCompositionExtractionAction(fundType, id)`.
    ok(await svc.triggerCompositionExtraction("MF", "119598"));

    const keys = cache.setCachedCalls.map((c) => c.key);
    assert.deepStrictEqual(keys, [RECALL_KEY]);
    assert.ok(
      !keys.includes(DISCLOSURE_KEY),
      "a model recollection may never be written into the filed-disclosure slot"
    );
  });

  it("[security] a cached recollection does NOT pre-empt a disclosure that exists", async () => {
    // The COLD case, and the one that per-source keys alone do not fix:
    // /compare runs first, so only the recollection slot is warm. Reading the
    // recall cache before looking for a disclosure would still let a /compare
    // visit decide what the fund page serves for the next 24h — the same
    // defect one layer down.
    //
    // MUTATION: move the `getCached(recallKey)` block above the disclosure
    //   lookup in `getFundComposition` →
    //   AssertionError: 'AMC_DISCLOSURE' !== 'GEMINI_RECALL'. VERIFIED red.
    const { cache } = withDisclosure();
    cache.hits.set(RECALL_KEY, dbResult({ dataAsOf: "2026-08" }));

    const res = ok(await svc.getFundComposition("MF", "119598"));
    assert.strictEqual(res.data!.source, "AMC_DISCLOSURE");
    assert.strictEqual(res.data!.holdings[0]!.holdingName, "HDFC Bank Ltd");
  });

  it("a cached DISCLOSURE is served without touching the table or the recall slot", async () => {
    // MUTATION: make the disclosure-cache hit fall through (delete the
    //   `if (cachedDisclosure && !isNoDisclosure(...)) return` branch) →
    //   `mfPortfolioHolding.findFirst` runs. VERIFIED red.
    const { md, cache, db } = reset();
    md.fromDb = dbResult();
    cache.hits.set(DISCLOSURE_KEY, {
      ...dbResult({ dataAsOf: "2026-07" }),
      source: "AMC_DISCLOSURE",
    });

    const res = ok(await svc.getFundComposition("MF", "119598"));
    assert.strictEqual(res.data!.source, "AMC_DISCLOSURE");
    assert.strictEqual(
      db.calls.filter((c) => c.startsWith("mfPortfolioHolding")).length,
      0
    );
    assert.strictEqual(
      md.calls.filter((c) => c.fn === "getCompositionFromDb").length,
      0
    );
  });

  it("a DETERMINATE absence is cached, so the next read is skipped entirely", async () => {
    // MONEY-1401 — this used to say `amfiSchemeCode` carries no index and that
    // the lookup saved is "a collection scan over 54,248 rows". Both arms of
    // `schemeCodeWhere` ARE indexed as of 8a2f8199 (`@@index([amfiSchemeCode,
    // period(sort: Desc)])` and the `amfiSchemeCodes` twin), so what is saved
    // is a round trip per view, not a scan — for the ~4 in 5 schemes with no
    // disclosure at all. The caching rule is unchanged and is the reason this
    // case exists: a DETERMINATE absence may be cached, an UNAVAILABLE may not.
    //
    // Prisma indexes reach Mongo only through a manual `prisma db push`, per
    // environment, so "indexed" is a statement about the schema until that has
    // been run.
    //
    // MUTATION: delete the `status === "NONE"` setCached → the sentinel is
    //   never written and this goes red. VERIFIED.
    const { md, cache, db } = reset();
    md.fromDb = dbResult();
    db.newestPeriod = null;

    ok(await svc.getFundComposition("MF", "119598"));
    const sentinel = cache.setCachedCalls.find((c) => c.key === DISCLOSURE_KEY);
    assert.deepStrictEqual(sentinel?.value, { none: true });

    // …and the next read honours it: no table read, straight to the recall.
    const second = reset();
    second.md.fromDb = dbResult();
    second.cache.hits.set(DISCLOSURE_KEY, { none: true });
    const res = ok(await svc.getFundComposition("MF", "119598"));
    assert.strictEqual(res.data!.source, "GEMINI_RECALL");
    assert.strictEqual(
      second.db.calls.filter((c) => c.startsWith("mfPortfolioHolding")).length,
      0,
      "the sentinel exists to skip exactly this read"
    );
  });

  it("[regression] the sentinel is not mistaken for a composition", async () => {
    // `{none:true}` has no `holdings`, so serving it would throw in the first
    // `.map()` a renderer reaches — or worse, normalize into an empty
    // composition labelled AMC_DISCLOSURE.
    //
    // MUTATION: drop `!isNoDisclosure(cachedDisclosure)` from the hit branch →
    //   TypeError / a fabricated empty disclosure. VERIFIED red.
    const { md, cache } = reset();
    md.fromDb = dbResult();
    cache.hits.set(DISCLOSURE_KEY, { none: true });

    const res = ok(await svc.getFundComposition("MF", "119598"));
    assert.strictEqual(res.data!.source, "GEMINI_RECALL");
    assert.strictEqual(res.data!.totalHoldings, 2);
  });

  it("[regression] an ETF without a scheme code reads NEITHER disclosure slot", async () => {
    // `/stock/[symbol]` and `/compare` pass no code, so there is no disclosure
    // to look up and no absence to record — recording one under
    // `ETF:NIFTYBEES::AMC_DISCLOSURE` would be an assertion about a lookup that
    // never happened.
    const { md, cache, db } = reset();
    md.fromDb = dbResult();

    ok(await svc.getFundComposition("ETF", "NIFTYBEES"));
    assert.deepStrictEqual(cache.getCachedKeys, [
      "ETF:NIFTYBEES::GEMINI_RECALL",
    ]);
    assert.strictEqual(
      db.calls.filter((c) => c.startsWith("mfPortfolioHolding")).length,
      0
    );
  });
});

// ══════════════════════════════════════════════════════════════════════════
// MONEY-1401 — the two holes the cache and the identity key left open
// ══════════════════════════════════════════════════════════════════════════

describe("MONEY-1401 F7 — the all-zero guard survives the cache HIT", () => {
  let svc: ServicesModule;
  before(() => {
    svc = installServices();
  });
  beforeEach(() => {
    reset();
  });
  after(() => {
    uninstallServices();
  });

  const DISCLOSURE_KEY = "MF:119598:119598:AMC_DISCLOSURE";

  /** A scheme whose every disclosed `percentToNav` is null — the 1403 shape. */
  function allNullRows(): Array<Record<string, unknown>> {
    return [
      disc({
        instrumentName: "HDFC Bank Ltd",
        isin: "INE040A01034",
        percentToNav: null,
      }),
      disc({
        instrumentName: "Reliance Industries Ltd",
        isin: "INE002A01018",
        percentToNav: null,
      }),
    ];
  }

  it("a portfolio with no disclosed weights renders NO donut on the MISS", async () => {
    const { db } = reset();
    db.newestPeriod = new Date(Date.UTC(2026, 6, 1));
    db.disclosureRows = allNullRows();
    db.instruments = [
      {
        isin: "INE040A01034",
        symbol: "HDFCBANK",
        exchange: "NSE",
        sector: "Financial Services",
        industry: "Banking",
      },
    ];

    const res = ok(await svc.getFundComposition("MF", "119598"));
    assert.strictEqual(res.data!.source, "AMC_DISCLOSURE");
    // The LINES still render and still count — "not disclosed" is not "absent".
    assert.strictEqual(res.data!.totalHoldings, 2);
    assert.deepStrictEqual(res.data!.sectorBreakdown, []);
    assert.deepStrictEqual(res.data!.capBreakdown, []);
    assert.deepStrictEqual(res.data!.assetBreakdown, []);
  });

  it("[regression] MONEY-1401 L1 — and on the RECALL MISS, which had no guard at all", async () => {
    // `served()` covered both cache HITs; `toServiceData` — the cache MISS that
    // falls through to the model recollection — was a bare
    // `normalizeComposition`, so an all-zero recall painted the 0.0% donut on
    // FIRST view and then, from the HIT, correctly drew nothing. Two answers to
    // one question, 24h apart.
    //
    // MUTATION: unwrap `served(...)` in `toServiceData` -> sectorBreakdown
    //   comes back length 2 (both slices weight 0). RED.
    const { md } = reset();
    md.fromDb = dbResult({
      holdings: [
        hld({ holdingName: "Reliance", weightPercent: 0, sector: "Energy" }),
        hld({ holdingName: "Infosys", weightPercent: 0, sector: "IT" }),
      ],
      sectorBreakdown: [],
      capBreakdown: [],
      assetBreakdown: [],
    });

    const res = ok(await svc.getFundComposition("MF", "119598"));
    assert.strictEqual(res.data!.source, "GEMINI_RECALL");
    assert.strictEqual(res.data!.totalHoldings, 2, "the LINES still render");
    assert.deepStrictEqual(res.data!.sectorBreakdown, []);
    assert.deepStrictEqual(res.data!.capBreakdown, []);
    assert.deepStrictEqual(res.data!.assetBreakdown, []);
  });

  it("[regression] and on the HIT — `served()` must not re-derive the zeros", async () => {
    // THE DEFECT: `served()` calls `normalizeComposition`, which DERIVES a
    // breakdown whenever the stored one is empty. Every weight is 0, so it
    // rebuilds `[{sector:"…",weight:0}, …]` with `length > 0` — and the panel
    // guards on `length`, not on any weight being non-zero. The MISS drew
    // nothing; the HIT drew an empty circle with a `0.0%` legend under a footer
    // crediting the fund house, for the next 24h.
    //
    // MUTATION: drop the three `droppingAllZero(...)` calls from `served()` in
    // `fund-composition.service.ts` → sectorBreakdown comes back length 2
    // ("Financial Services" + "Unclassified", both weight 0). VERIFIED red.
    const first = reset();
    first.db.newestPeriod = new Date(Date.UTC(2026, 6, 1));
    first.db.disclosureRows = allNullRows();
    first.db.instruments = [
      {
        isin: "INE040A01034",
        symbol: "HDFCBANK",
        exchange: "NSE",
        sector: "Financial Services",
        industry: "Banking",
      },
    ];
    ok(await svc.getFundComposition("MF", "119598"));

    // Round-trip the ACTUAL bytes the miss cached, not a hand-written fixture:
    // a fixture here would be a shadow of the thing under test.
    const written = first.cache.setCachedCalls.find(
      (c) => c.key === DISCLOSURE_KEY
    );
    assert.ok(written, "the miss must have cached a disclosure");

    const second = reset();
    second.cache.hits.set(DISCLOSURE_KEY, written!.value);
    const res = ok(await svc.getFundComposition("MF", "119598"));

    assert.strictEqual(res.data!.source, "AMC_DISCLOSURE");
    assert.strictEqual(res.data!.totalHoldings, 2);
    assert.deepStrictEqual(
      res.data!.sectorBreakdown,
      [],
      "an empty circle with a 0.0% legend is not a breakdown"
    );
    assert.deepStrictEqual(res.data!.capBreakdown, []);
    assert.deepStrictEqual(res.data!.assetBreakdown, []);
  });

  it("a REAL breakdown still round-trips the cache unchanged", async () => {
    // The guard must only fire on all-zero. `normalizeComposition` is otherwise
    // idempotent and this is what proves `droppingAllZero` did not eat a chart.
    const first = reset();
    first.db.newestPeriod = new Date(Date.UTC(2026, 6, 1));
    first.db.disclosureRows = [
      disc({
        instrumentName: "HDFC Bank Ltd",
        isin: "INE040A01034",
        percentToNav: 60,
      }),
      disc({
        instrumentName: "Reliance Industries Ltd",
        isin: "INE002A01018",
        percentToNav: 40,
      }),
    ];
    first.db.instruments = [
      {
        isin: "INE040A01034",
        symbol: "HDFCBANK",
        exchange: "NSE",
        sector: "Financial Services",
        industry: "Banking",
      },
    ];
    const missed = ok(await svc.getFundComposition("MF", "119598"));
    assert.ok(missed.data!.sectorBreakdown.length > 0);

    const written = first.cache.setCachedCalls.find(
      (c) => c.key === DISCLOSURE_KEY
    )!;
    const second = reset();
    second.cache.hits.set(DISCLOSURE_KEY, written.value);
    const hit = ok(await svc.getFundComposition("MF", "119598"));

    assert.deepStrictEqual(
      hit.data!.sectorBreakdown,
      missed.data!.sectorBreakdown
    );
    assert.deepStrictEqual(hit.data!.capBreakdown, missed.data!.capBreakdown);
    assert.deepStrictEqual(
      hit.data!.assetBreakdown,
      missed.data!.assetBreakdown
    );
  });
});

describe("MONEY-1401 F8a — one fund's holdings are never served for another", () => {
  let svc: ServicesModule;
  before(() => {
    svc = installServices();
  });
  beforeEach(() => {
    reset();
  });
  after(() => {
    uninstallServices();
  });

  it("[regression] two AMCs under one schemeKey do not union into one portfolio", async () => {
    // `mf_portfolio_holdings` is @@unique([period, amc, schemeKey,
    // instrumentName]) — `amc` is HALF the identity. `schemeKey` is a
    // normalisation of the PRINTED SCHEME NAME alone, so nothing in it is
    // unique to a filer: two AMCs printing the same name are ONE key.
    //
    // MEASURED prod 2026-09-13: 0 of 662 keys span >1 AMC today, but 9 carry no
    // AMC name at all (Shriram and Baroda BNP print the bare SEBI category
    // line, "an-open-ended-liquid-scheme-…"), which is the shape that collides
    // as coverage goes 13 filers -> 17.
    //
    // MUTATION: drop `amc: newest.amc` from the `findMany` WHERE in
    // `readDisclosure` → 4 holdings, weights summing to ~200, silently rescaled
    // back to 100 by the donut pass. VERIFIED red.
    const period = new Date(Date.UTC(2026, 6, 1));
    const shared = { schemeKey: "an-open-ended-liquid-scheme", period };
    const { db } = reset();
    db.holdings = [
      // The scheme the code resolves to.
      {
        ...shared,
        amc: "SHRIRAM",
        amfiSchemeCode: "119598",
        instrumentName: "Shriram Holding A",
        isin: null,
        holdingType: "DEBT",
        percentToNav: 70,
        schemeName: "An open ended liquid scheme",
      },
      {
        ...shared,
        amc: "SHRIRAM",
        amfiSchemeCode: "119598",
        instrumentName: "Shriram Holding B",
        isin: null,
        holdingType: "CASH",
        percentToNav: 30,
        schemeName: "An open ended liquid scheme",
      },
      // A DIFFERENT AMC's scheme, same printed name, same month, NOT asked for.
      {
        ...shared,
        amc: "BARODA_BNP",
        amfiSchemeCode: "999999",
        instrumentName: "Baroda Holding A",
        isin: null,
        holdingType: "DEBT",
        percentToNav: 55,
        schemeName: "An open ended liquid scheme",
      },
      {
        ...shared,
        amc: "BARODA_BNP",
        amfiSchemeCode: "999999",
        instrumentName: "Baroda Holding B",
        isin: null,
        holdingType: "CASH",
        percentToNav: 45,
        schemeName: "An open ended liquid scheme",
      },
    ];

    const res = ok(await svc.getFundComposition("MF", "119598"));
    assert.strictEqual(res.data!.source, "AMC_DISCLOSURE");
    assert.strictEqual(res.data!.totalHoldings, 2);
    assert.deepStrictEqual(
      res.data!.holdings.map((h) => h.holdingName).sort(),
      ["Shriram Holding A", "Shriram Holding B"]
    );
    assert.strictEqual(
      res.data!.coveragePercent,
      100,
      "a union of two schemes sums to ~200 before the donut pass hides it"
    );
  });
});

describe("MONEY-1401 F10 — /compare reads the disclosure, not a paid recall", () => {
  let svc: ComparisonModule;
  before(() => {
    installServices();
    svc = installServices() as unknown as ComparisonModule;
  });
  beforeEach(() => {
    reset();
  });
  after(() => {
    uninstallServices();
  });

  function seedDisclosedFund(db: DbRecorder): void {
    db.funds = [
      { schemeCode: "119598", schemeName: "HDFC Nifty 50 Index Fund" },
      { schemeCode: "120505", schemeName: "Some Other Fund" },
    ];
    db.newestPeriod = new Date(Date.UTC(2026, 6, 1));
    db.disclosureRows = [
      disc({
        instrumentName: "Reliance",
        isin: "INE002A01018",
        percentToNav: 60,
      }),
      disc({
        instrumentName: "Infosys",
        isin: "INE009A01021",
        percentToNav: 40,
      }),
    ];
    db.instruments = [
      {
        isin: "INE002A01018",
        symbol: "RELIANCE",
        exchange: "NSE",
        sector: "Energy",
        industry: null,
      },
    ];
  }

  it("[regression] a fund with a filed disclosure is not reported as having no composition", async () => {
    // THE DEFECT: `getComparisonData` called `getCompositionFromDb` DIRECTLY, so
    // `/compare` never looked at `mf_portfolio_holdings` at all. A fund with a
    // complete SEBI filing read as "no composition", the client's
    // `newCompositions[key]` was falsy, and "Analyse all holdings" then spent 2
    // credits and a `gemini-2.5-pro` call (up to 5 per click) recalling what the
    // AMC had already published.
    //
    // MUTATION: point `fetchComposition` back at `getCompositionFromDb` →
    //   `md.fromDb` (2 holdings, "Reliance"/"Infosys" at 40/35) is served and
    //   the source assertion goes red. VERIFIED.
    const { md, db } = reset();
    md.fromDb = dbResult(); // a recollection IS available — it must lose
    seedDisclosedFund(db);

    const res = ok(
      await svc.getComparisonData([
        { type: "MF", id: "119598" },
        { type: "MF", id: "120505" },
      ])
    );
    const comp = res.data.compositions["MF:119598"] as CompositionShape | null;
    assert.ok(comp, "a filed portfolio must reach /compare");
    assert.strictEqual(comp!.source, "AMC_DISCLOSURE");
    assert.deepStrictEqual(
      comp!.holdings.map((h) => h.holdingName),
      ["Reliance", "Infosys"]
    );
    // Scoped to THIS fund: 120505 has no disclosure in the fixture and
    // correctly falls through to the recollection, so a bare count would be 1
    // for a reason that has nothing to do with the defect.
    assert.strictEqual(
      md.calls.filter(
        (c) => c.fn === "getCompositionFromDb" && c.args[1] === "119598"
      ).length,
      0,
      "the disclosure wins here for the same reason it wins on the fund page"
    );
  });

  it("a fund with NO disclosure still falls back to the recollection", async () => {
    // The fallback is `getCompositionFromDb` — the exact call this replaced —
    // so nothing regresses for the 651 of 662 schemes that have no filing.
    const { md, db } = reset();
    md.fromDb = dbResult();
    db.funds = [
      { schemeCode: "119598", schemeName: "A" },
      { schemeCode: "120505", schemeName: "B" },
    ];
    db.newestPeriod = null;

    const res = ok(
      await svc.getComparisonData([
        { type: "MF", id: "119598" },
        { type: "MF", id: "120505" },
      ])
    );
    const comp = res.data.compositions["MF:119598"] as CompositionShape | null;
    assert.ok(comp);
    assert.strictEqual(comp!.source, "GEMINI_RECALL");
    assert.ok(md.calls.some((c) => c.fn === "getCompositionFromDb"));
  });
});

// ══════════════════════════════════════════════════════════════════════════
// MONEY-1401 F8b — the SAME defect, one service over.
// ══════════════════════════════════════════════════════════════════════════

/**
 * A fake `mfPortfolioHolding` over a fixed row set, answering the query.
 *
 * Reuses {@link whereMatches} rather than growing a second matcher: this
 * service issues the same clause vocabulary plus `period: { lt }`, which that
 * function now supports. `getMfPortfolioSection` takes its collaborators as
 * arguments (`MfPortfolioDeps`), so nothing here touches the module registry.
 */
function sectionDeps(rows: Array<Record<string, unknown>>): {
  deps: MfPortfolioDeps;
  wheres: Array<Record<string, unknown> | undefined>;
} {
  const wheres: Array<Record<string, unknown> | undefined> = [];
  const select = (args: FindArgs = {}) => {
    wheres.push(args.where);
    return rows.filter((r) => whereMatches(r, args.where));
  };
  const db = {
    mfPortfolioHolding: {
      async findFirst(args: FindArgs = {}) {
        return (
          select(args).sort(
            (a, b) =>
              (b.period as Date).getTime() - (a.period as Date).getTime()
          )[0] ?? null
        );
      },
      async findMany(args: FindArgs = {}) {
        const matched = select(args).sort(
          (a, b) => Number(b.percentToNav ?? 0) - Number(a.percentToNav ?? 0)
        );
        return typeof args.take === "number"
          ? matched.slice(0, args.take)
          : matched;
      },
    },
    // The Kuvera/AI fallback. Empty in every case here — the official side is
    // non-empty — but present so the branch resolves instead of throwing.
    fundHolding: {
      async findMany() {
        return [];
      },
    },
  };
  return {
    deps: {
      prisma: db as unknown as MfPortfolioDeps["prisma"],
      getCached: (async () => null) as never,
      setCached: (async () => undefined) as never,
      getNseMarketStatus: () => ({ isLive: false }),
    },
    wheres,
  };
}

/** Unwrap a successful section result into its provenance envelope. */
function section(
  r: Awaited<ReturnType<typeof getMfPortfolioSection>>
): WithProvenance<MfPortfolioSectionData> {
  assert.equal(r.success, true, `expected success, got ${JSON.stringify(r)}`);
  return (r as { success: true; data: WithProvenance<MfPortfolioSectionData> })
    .data;
}

const JUL = new Date(Date.UTC(2026, 6, 1));
const JUN = new Date(Date.UTC(2026, 5, 1));

/** One stored holding row. */
function hrow(
  o: Partial<Record<string, unknown>> & {
    instrumentName: string;
    percentToNav: number;
  }
): Record<string, unknown> {
  return {
    amc: "SBI",
    schemeKey: "sbi-nifty-midcap150-etf",
    period: JUL,
    amfiSchemeCode: "149385",
    amfiSchemeCodes: ["149385", "149386"],
    isin: null,
    holdingType: "EQUITY",
    quantity: null,
    marketValue: null,
    source: "AMC_DISCLOSURE",
    ...o,
  };
}

describe("MONEY-1401 F8b — getMfPortfolioSection reads ONE filed portfolio", () => {
  it("[regression] two schemeKeys under one AMFI code do not render 200%", async () => {
    // THE SHAPE, and it is produced BY DESIGN rather than by bad data.
    // `schemeKeyOf` (the STORAGE key, mf-portfolio-sync.ts) is
    // separator-SENSITIVE; `schemeFamilyKey` (which resolves the CODES,
    // amfi-scheme-bridge.ts) is separator-FREE and says so — measured, 57 of
    // 4,109 families contain members that disagree about the split, e.g.
    // `SBI Nifty Midcap150 ETF` vs `SBI Nifty Midcap 150 ETF`. One family, one
    // `amfiSchemeCodes` array, TWO storage keys.
    //
    // `buildMfPortfolioSection` takes every row in the newest period with NO
    // grouping, so unnarrowed this renders four lines summing to 200% under a
    // "SEBI disclosure" label.
    //
    // MUTATION: drop `schemeKey` from `scope` -> 4 lines / totalPct 200. RED.
    const { deps } = sectionDeps([
      hrow({ instrumentName: "Reliance Industries Ltd", percentToNav: 60 }),
      hrow({
        instrumentName: "Tata Consultancy Services Ltd",
        percentToNav: 40,
      }),
      // The SAME fund's other sheet — same AMC, same month, same code array,
      // one space different in the printed name.
      hrow({
        schemeKey: "sbi-nifty-midcap-150-etf",
        instrumentName: "Reliance Industries Ltd",
        percentToNav: 55,
      }),
      hrow({
        schemeKey: "sbi-nifty-midcap-150-etf",
        instrumentName: "Infosys Ltd",
        percentToNav: 45,
      }),
    ]);

    const env = section(
      await getMfPortfolioSection({ schemeCode: "149386" }, deps)
    );

    assert.equal(env.data.lines.length, 2, "one sheet is one portfolio");
    assert.equal(
      env.data.totals.totalPct,
      100,
      "a union of two sheets sums to ~200 and is rendered verbatim"
    );
    assert.deepEqual(
      env.data.lines.map((l) => l.name),
      ["Reliance Industries Ltd", "Tata Consultancy Services Ltd"]
    );
  });

  it("[regression] the PRIOR-month read is narrowed too, so the diff is not another sheet's", async () => {
    // The month-over-month read is the half `fund-composition.service.ts` does
    // not have. Unnarrowed it invents trades: the other sheet's exits and
    // entries are attributed to this one, and `diffMfPortfolio` keys its map on
    // `instrumentName` ALONE, so a name held by both sheets silently takes
    // whichever row was written last.
    //
    // MUTATION: drop `schemeKey` from `scope` -> entered gains "Infosys Ltd",
    //   exited gains "Wipro Ltd". RED.
    const other = { schemeKey: "sbi-nifty-midcap-150-etf" };
    const { deps } = sectionDeps([
      hrow({ instrumentName: "Reliance Industries Ltd", percentToNav: 60 }),
      hrow({
        instrumentName: "Tata Consultancy Services Ltd",
        percentToNav: 40,
      }),
      hrow({
        period: JUN,
        instrumentName: "Reliance Industries Ltd",
        percentToNav: 70,
      }),
      hrow({ period: JUN, instrumentName: "HDFC Bank Ltd", percentToNav: 30 }),
      // The other sheet, both months.
      hrow({ ...other, instrumentName: "Infosys Ltd", percentToNav: 100 }),
      hrow({
        ...other,
        period: JUN,
        instrumentName: "Wipro Ltd",
        percentToNav: 100,
      }),
    ]);

    const env = section(
      await getMfPortfolioSection({ schemeCode: "149385" }, deps)
    );

    assert.deepEqual(env.data.diff.entered, ["Tata Consultancy Services Ltd"]);
    assert.deepEqual(env.data.diff.exited, ["HDFC Bank Ltd"]);
    assert.deepEqual(env.data.diff.changed, [
      { name: "Reliance Industries Ltd", from: 70, to: 60 },
    ]);
  });

  it("[regression] `amc` is half the identity — two houses printing one name stay apart", async () => {
    // `schemeKey` normalises the PRINTED SCHEME NAME alone, so nothing in it is
    // unique to a filer. Measured prod 2026-09-13: 9 of 662 stored keys carry no
    // AMC name at all — Shriram and Baroda BNP print the bare SEBI category line
    // ("an-open-ended-liquid-scheme-…") as the scheme name.
    //
    // MUTATION: drop `amc` from `scope` -> 4 lines / totalPct 200. RED.
    const shared = {
      schemeKey: "an-open-ended-liquid-scheme",
      amfiSchemeCodes: ["149385"],
    };
    const { deps } = sectionDeps([
      hrow({
        ...shared,
        amc: "SHRIRAM",
        instrumentName: "Shriram A",
        percentToNav: 70,
      }),
      hrow({
        ...shared,
        amc: "SHRIRAM",
        instrumentName: "Shriram B",
        percentToNav: 30,
      }),
      hrow({
        ...shared,
        amc: "BARODA_BNP",
        instrumentName: "Baroda A",
        percentToNav: 55,
      }),
      hrow({
        ...shared,
        amc: "BARODA_BNP",
        instrumentName: "Baroda B",
        percentToNav: 45,
      }),
    ]);

    const env = section(
      await getMfPortfolioSection({ schemeCode: "149385" }, deps)
    );
    assert.equal(env.data.totals.totalPct, 100);
    assert.deepEqual(env.data.lines.map((l) => l.name).sort(), [
      "Shriram A",
      "Shriram B",
    ]);
  });

  it("[regression] MONEY-1401 F8c — /mf/<unknown> 404s, but a FAILED read still degrades", () => {
    // A SOURCE SCAN, and its ceiling is stated rather than implied: `MfPage` is
    // an async server component that imports `next/navigation`, a Prisma
    // client and a "use client" child, so there is no seam to drive it through
    // here. This proves the GATE's shape, not that Next renders a 404.
    //
    // Why it is in this file: it is the other half of F8b. The narrowing above
    // decides WHICH portfolio a scheme code reaches; this decides which codes
    // may ask at all. `mf-portfolio-sync.ts` records that 5 of 414 multi-code
    // families also carry a wound-up SEGREGATED PORTFOLIO's codes, mitigated by
    // "no fund page exists to ask for them by code" — which the synthesised
    // `Mutual Fund (<code>)` fallback made false the moment MONEY-1294 filled
    // `amfiSchemeCodes`.
    //
    // MUTATIONS: delete the `notFound()` call -> RED. Widen the gate to
    //   `if (!mfData) notFound();` -> RED (a Mongo blip becomes a dead link for
    //   a real fund, which is the failure the fallback exists to prevent).
    const page = readFileSync(
      join(__dirname, "../../app/mf/[schemeCode]/page.tsx"),
      "utf8"
    );
    assert.match(
      page,
      /if \(!mfData && !lookupFailed\) notFound\(\);/,
      "the 404 must be gated on a DETERMINATE miss, never on the null alone"
    );
    assert.match(
      page,
      /\/\/ DB unavailable - continue with fallback data\s*\n\s*lookupFailed = true;/,
      "only the catch may set the flag — otherwise the gate is always open"
    );
    assert.match(
      page,
      /const data = mfData \?\? \{/,
      "the degraded render must survive for the thrown-read case"
    );
  });

  it("[regression] MONEY-1401 L3 — a row reachable ONLY through `amfiSchemeCodes` is found", async () => {
    // The plan-variant arm of `schemeCodeWhere` was pinned STRUCTURALLY and
    // never behaviourally: deleting `{ amfiSchemeCodes: { has: code } }` left
    // this file 67/67 green while three of every four AMFI plans read "the AMC
    // has not published a portfolio". Note the asymmetry the review measured —
    // deleting the SCALAR arm goes 14 red on its own, because every other
    // fixture carries a matching `amfiSchemeCode`.
    //
    // MUTATION: delete the `amfiSchemeCodes` arm from `schemeCodeWhere`
    //   (mf-portfolio-section-logic.ts) -> empty section. RED.
    const { deps } = sectionDeps([
      hrow({
        // The stored PRIMARY is a different plan's code; AMFI hands out up to
        // four per filed portfolio and the caller resolved one of the others.
        amfiSchemeCode: "149385",
        amfiSchemeCodes: ["149385", "149386"],
        instrumentName: "Reliance Industries Ltd",
        percentToNav: 100,
      }),
    ]);

    const env = section(
      await getMfPortfolioSection({ schemeCode: "149386" }, deps)
    );
    assert.equal(env.data.lines.length, 1);
    assert.equal(env.empty, false);
    assert.equal(env.source, "MF_PORTFOLIO");
  });
});
