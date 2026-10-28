/**
 * Comparison pure-logic tests (MONEY-620) — DE-SHADOWED.
 *
 * This file previously RE-IMPLEMENTED the comparison math inline
 * (`computeChartData` base-100 normalization, `isBest`, holdings/sector
 * overlap) and asserted the copies — a shadow that stayed green even if the
 * real `/compare` math broke. It now imports and exercises the REAL exported
 * symbols from the service-layer logic module
 * (`packages/services/src/comparison-logic.ts`), which the live
 * `fund-comparison.service.ts` calls (`buildNavComparisonSeries` →
 * `buildNormalizedComparison`) to derive the `normalizedSeries` the chart
 * renders. Same code in prod and under test.
 *
 * `comparison-logic` is Prisma-free, so importing it (and the
 * `buildNavComparisonSeries` re-export from the service) never opens a DB
 * connection — the suite stays pure and exits clean.
 *
 * Coverage emphasis (the four blind spots + bug-hunt):
 *   - non-finite (NaN / ±Infinity) values must NOT poison a series, the
 *     cross-instrument overlay, the best-in-row highlight, or the ranking
 *     (NaN must never sort first / be crowned winner);
 *   - rebasing div-by-zero: a 0 / missing BASE point must not spread
 *     Infinity/NaN across the series;
 *   - relative / percent return with a zero or non-finite denominator;
 *   - ranking with all-equal or NaN/missing scores (stable, deterministic,
 *     NaN-last);
 *   - empty / single-point / Invalid-Date series (no toISOString throw).
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  finite,
  rebaseSeriesTo100,
  buildNormalizedComparison,
  percentChange,
  seriesReturnPct,
  relativeReturnPct,
  isBest,
  rankInstruments,
  pickWinner,
  type SeriesPoint,
  type NamedSeries,
  type RankableItem,
} from "../../../../packages/services/src/comparison-logic";

// The live service re-exports the wrapper the chart depends on; assert THAT
// (not a copy) so the test fails if the service stops calling the logic.
import {
  buildNavComparisonSeries,
  type ComparisonData,
} from "../../../../packages/services/src/fund-comparison.service";

import type { ComparableFund } from "@usemoney/types";

// ─── Fixtures ─────────────────────────────────────────────────────

function mkFund(over: Partial<ComparableFund> = {}): ComparableFund {
  return {
    id: "119551",
    fundType: "MF",
    name: "Axis Bluechip Fund - Direct Growth",
    issuer: "Axis Mutual Fund",
    category: "Large Cap",
    riskLevel: "Moderately High",
    nav: 52.34,
    navDate: new Date("2024-12-20"),
    returns1Y: 18.5,
    returns3Y: 14.2,
    returns5Y: 12.1,
    aum: 35000,
    expenseRatio: 0.55,
    plan: "DIRECT",
    fundManager: "Shreyash Devalkar",
    crisilRating: "5",
    volatility: "Moderate",
    exchange: null,
    changePercent: null,
    ...over,
  };
}

// ============================================================================
// finite() — the non-finite guard underpinning every comparison surface
// ============================================================================

describe("finite", () => {
  it("passes finite numbers through unchanged (incl. negatives & zero)", () => {
    assert.equal(finite(42), 42);
    assert.equal(finite(-7.5), -7.5);
    assert.equal(finite(0), 0);
  });

  it("collapses NaN / ±Infinity / null / undefined to the fallback", () => {
    assert.equal(finite(NaN), 0);
    assert.equal(finite(Infinity), 0);
    assert.equal(finite(-Infinity), 0);
    assert.equal(finite(null), 0);
    assert.equal(finite(undefined), 0);
  });

  it("honours a custom fallback", () => {
    assert.equal(finite(NaN, 100), 100);
    assert.equal(finite(Infinity, -1), -1);
  });
});

// ============================================================================
// rebaseSeriesTo100 — index a single series to base 100
// ============================================================================

describe("rebaseSeriesTo100", () => {
  it("returns [] for an empty series", () => {
    assert.deepEqual(rebaseSeriesTo100([]), []);
  });

  it("indexes the first usable point to exactly 100", () => {
    const out = rebaseSeriesTo100([{ date: "2024-01-01", value: 50 }]);
    assert.equal(out.length, 1);
    assert.equal(out[0]!.value, 100);
    assert.equal(out[0]!.raw, 50);
  });

  it("reproduces the legacy 2dp base-100 numbers exactly (growth)", () => {
    // Legacy client: Math.round((value / firstValue) * 10000) / 100
    const out = rebaseSeriesTo100([
      { date: "2024-01-01", value: 80 },
      { date: "2024-02-01", value: 100 },
      { date: "2024-03-01", value: 120 },
    ]);
    assert.deepEqual(
      out.map((p) => p.value),
      [100, 125, 150]
    );
  });

  it("reproduces the legacy numbers exactly (decline)", () => {
    const out = rebaseSeriesTo100([
      { date: "2024-01-01", value: 200 },
      { date: "2024-02-01", value: 150 },
    ]);
    assert.deepEqual(
      out.map((p) => p.value),
      [100, 75]
    );
  });

  // ── div-by-zero / missing base (the legacy `firstValue ?? 1` bug) ──

  it("BUG-HUNT: a ZERO base point does not spread Infinity — it skips to the first non-zero base", () => {
    // Legacy: firstValue = 0 → value/0 = Infinity for every later point.
    const out = rebaseSeriesTo100([
      { date: "2024-01-01", value: 0 },
      { date: "2024-02-01", value: 50 },
      { date: "2024-03-01", value: 75 },
    ]);
    // First usable (non-zero) base is 50 → indexes 100, then 150. The leading
    // zero point is dropped (cannot be indexed against a not-yet-seen base).
    assert.deepEqual(
      out.map((p) => ({ date: p.date, value: p.value })),
      [
        { date: "2024-02-01", value: 100 },
        { date: "2024-03-01", value: 150 },
      ]
    );
    for (const p of out) assert.ok(Number.isFinite(p.value));
  });

  it("BUG-HUNT: an all-zero series yields [] (no Infinity line), not garbage", () => {
    const out = rebaseSeriesTo100([
      { date: "2024-01-01", value: 0 },
      { date: "2024-02-01", value: 0 },
    ]);
    assert.deepEqual(out, []);
  });

  it("BUG-HUNT: a NaN base point is skipped; base is the first finite non-zero value", () => {
    const out = rebaseSeriesTo100([
      { date: "2024-01-01", value: NaN },
      { date: "2024-02-01", value: 40 },
      { date: "2024-03-01", value: 60 },
    ]);
    assert.deepEqual(
      out.map((p) => p.value),
      [100, 150]
    );
  });

  it("BUG-HUNT: an Infinity base point is skipped (never used as divisor)", () => {
    const out = rebaseSeriesTo100([
      { date: "2024-01-01", value: Infinity },
      { date: "2024-02-01", value: 25 },
    ]);
    assert.deepEqual(
      out.map((p) => p.value),
      [100]
    );
  });

  it("BUG-HUNT: a non-finite MID-series value indexes to 0 for THAT point only, never NaN/Infinity", () => {
    const out = rebaseSeriesTo100([
      { date: "2024-01-01", value: 100 },
      { date: "2024-02-01", value: NaN },
      { date: "2024-03-01", value: Infinity },
      { date: "2024-04-01", value: 150 },
    ]);
    // Base 100 → [100, 0 (NaN→0), 0 (Inf→0), 150]. Every value stays finite.
    assert.deepEqual(
      out.map((p) => p.value),
      [100, 0, 0, 150]
    );
    for (const p of out) assert.ok(Number.isFinite(p.value));
  });

  it("series whose only finite values are zero → [] (all-NaN-or-zero)", () => {
    assert.deepEqual(
      rebaseSeriesTo100([
        { date: "2024-01-01", value: NaN },
        { date: "2024-02-01", value: 0 },
      ]),
      []
    );
  });
});

// ============================================================================
// buildNormalizedComparison — the multi-instrument overlay-chart builder
// (service-side equivalent of the client's computeChartData)
// ============================================================================

describe("buildNormalizedComparison", () => {
  it("returns [] for no instruments", () => {
    assert.deepEqual(buildNormalizedComparison([]), []);
  });

  it("returns [] when every instrument has empty history", () => {
    const series: NamedSeries[] = [{ key: "MF:f1", points: [] }];
    assert.deepEqual(buildNormalizedComparison(series), []);
  });

  it("normalizes a single instrument to base 100 (legacy parity)", () => {
    const series: NamedSeries[] = [
      {
        key: "MF:f1",
        points: [
          { date: "2024-01-01", value: 50 },
          { date: "2024-02-01", value: 75 },
        ],
      },
    ];
    const rows = buildNormalizedComparison(series);
    assert.equal(rows.length, 2);
    assert.equal(rows[0]!["fund0"], 100);
    assert.equal(rows[1]!["fund0"], 150);
  });

  it("emits one column per instrument, both based to 100 at their own first point", () => {
    const series: NamedSeries[] = [
      { key: "MF:f1", points: [{ date: "2024-03-01", value: 200 }] },
      { key: "MF:f2", points: [{ date: "2024-03-01", value: 50 }] },
    ];
    const rows = buildNormalizedComparison(series);
    assert.equal(rows.length, 1);
    assert.equal(rows[0]!["fund0"], 100);
    assert.equal(rows[0]!["fund1"], 100);
  });

  it("sorts the union of dates ascending and includes the `date` key", () => {
    const series: NamedSeries[] = [
      {
        key: "MF:f1",
        points: [
          { date: "2024-05-01", value: 120 },
          { date: "2024-01-01", value: 100 },
          { date: "2024-03-01", value: 110 },
        ],
      },
    ];
    const rows = buildNormalizedComparison(series);
    assert.deepEqual(
      rows.map((r) => r["date"]),
      ["2024-01-01", "2024-03-01", "2024-05-01"]
    );
  });

  it("omits an instrument's key on dates it has no point for (gap bridging)", () => {
    const series: NamedSeries[] = [
      {
        key: "MF:f1",
        points: [
          { date: "2024-01-01", value: 100 },
          { date: "2024-02-01", value: 110 },
        ],
      },
      { key: "MF:f2", points: [{ date: "2024-01-01", value: 50 }] },
    ];
    const rows = buildNormalizedComparison(series);
    assert.equal(rows[0]!["fund0"], 100);
    assert.equal(rows[0]!["fund1"], 100);
    assert.equal(rows[1]!["fund0"], 110);
    assert.equal(rows[1]!["fund1"], undefined); // f2 missing on date2
  });

  it("BUG-HUNT: a corrupt/empty series for ONE instrument does not alter the OTHER's line", () => {
    const series: NamedSeries[] = [
      {
        key: "MF:f1",
        points: [
          { date: "2024-01-01", value: 100 },
          { date: "2024-02-01", value: 130 },
        ],
      },
      // f2 is all non-finite → contributes no usable base → no columns.
      {
        key: "MF:f2",
        points: [
          { date: "2024-01-01", value: NaN },
          { date: "2024-02-01", value: Infinity },
        ],
      },
    ];
    const rows = buildNormalizedComparison(series);
    // f1's line is untouched and fully finite.
    assert.equal(rows[0]!["fund0"], 100);
    assert.equal(rows[1]!["fund0"], 130);
    // f2 never produced a column on any row.
    for (const r of rows) assert.equal(r["fund1"], undefined);
  });

  it("BUG-HUNT: instrument with a ZERO first NAV bases off its first non-zero point (no Infinity column)", () => {
    const series: NamedSeries[] = [
      {
        key: "MF:f1",
        points: [
          { date: "2024-01-01", value: 0 }, // legacy firstValue=0 → ÷0
          { date: "2024-02-01", value: 60 },
          { date: "2024-03-01", value: 90 },
        ],
      },
    ];
    const rows = buildNormalizedComparison(series);
    // Only the two indexable rows survive; both finite.
    assert.deepEqual(
      rows.map((r) => ({ date: r["date"], v: r["fund0"] })),
      [
        { date: "2024-02-01", v: 100 },
        { date: "2024-03-01", v: 150 },
      ]
    );
  });

  it("honours a custom key prefix", () => {
    const series: NamedSeries[] = [
      { key: "A", points: [{ date: "2024-01-01", value: 10 }] },
    ];
    const rows = buildNormalizedComparison(series, "s");
    assert.equal(rows[0]!["s0"], 100);
  });

  it("Invalid-Date string in a point does not throw and is sorted as a plain string", () => {
    // The builder never calls Date(...) — dates are opaque strings. A garbage
    // date can't crash it (the legacy client's displayDate did `new Date(...)`,
    // but the data math here is date-agnostic).
    const series: NamedSeries[] = [
      {
        key: "MF:f1",
        points: [
          { date: "not-a-date", value: 100 },
          { date: "2024-02-01", value: 150 },
        ],
      },
    ];
    assert.doesNotThrow(() => buildNormalizedComparison(series));
    const rows = buildNormalizedComparison(series);
    assert.equal(rows.length, 2);
    for (const r of rows) {
      if (r["fund0"] !== undefined) assert.ok(Number.isFinite(r["fund0"]));
    }
  });
});

// ============================================================================
// percentChange / seriesReturnPct / relativeReturnPct — return math
// ============================================================================

describe("percentChange", () => {
  it("computes a basic gain and loss", () => {
    assert.equal(percentChange(100, 150), 50);
    assert.equal(percentChange(200, 150), -25);
  });

  it("BUG-HUNT: zero denominator → null (never Infinity into toFixed)", () => {
    assert.equal(percentChange(0, 50), null);
  });

  it("BUG-HUNT: non-finite from/to → null", () => {
    assert.equal(percentChange(NaN, 50), null);
    assert.equal(percentChange(Infinity, 50), null);
    assert.equal(percentChange(100, NaN), null);
    assert.equal(percentChange(100, Infinity), null);
  });

  it("null / undefined inputs → null", () => {
    assert.equal(percentChange(null, 50), null);
    assert.equal(percentChange(100, undefined), null);
  });

  it("handles a negative base deterministically (finite result)", () => {
    // (-50 → -25): (-25 - -50)/-50 * 100 = -50
    assert.equal(percentChange(-50, -25), -50);
  });
});

describe("seriesReturnPct", () => {
  it("returns first-usable→last-finite percent change", () => {
    assert.equal(
      seriesReturnPct([
        { date: "2024-01-01", value: 100 },
        { date: "2024-02-01", value: 120 },
        { date: "2024-03-01", value: 150 },
      ]),
      50
    );
  });

  it("skips a non-finite/zero base and a non-finite tail", () => {
    assert.equal(
      seriesReturnPct([
        { date: "2024-01-01", value: 0 },
        { date: "2024-02-01", value: 100 },
        { date: "2024-03-01", value: 110 },
        { date: "2024-04-01", value: NaN },
      ]),
      10 // base 100 → last finite 110
    );
  });

  it("empty / single-non-finite / all-zero series → null", () => {
    assert.equal(seriesReturnPct([]), null);
    assert.equal(seriesReturnPct([{ date: "2024-01-01", value: NaN }]), null);
    assert.equal(
      seriesReturnPct([
        { date: "2024-01-01", value: 0 },
        { date: "2024-02-01", value: 0 },
      ]),
      null
    );
  });

  it("single finite point → 0% (base == last)", () => {
    assert.equal(seriesReturnPct([{ date: "2024-01-01", value: 75 }]), 0);
  });
});

describe("relativeReturnPct", () => {
  it("subtracts b% from a%", () => {
    assert.equal(relativeReturnPct(50, 20), 30);
    assert.equal(relativeReturnPct(-10, 5), -15);
  });

  it("BUG-HUNT: either side null/non-finite → null (no NaN in 'A beat B by X%')", () => {
    assert.equal(relativeReturnPct(null, 20), null);
    assert.equal(relativeReturnPct(50, null), null);
    assert.equal(relativeReturnPct(NaN, 20), null);
    assert.equal(relativeReturnPct(50, Infinity), null);
  });
});

// ============================================================================
// isBest — peer-relative best-in-row highlight
// ============================================================================

describe("isBest", () => {
  it("higher-is-better: true only for the max", () => {
    assert.equal(isBest([10, 20, 15], 1), true);
    assert.equal(isBest([10, 20, 15], 0), false);
    assert.equal(isBest([10, 20, 15], 2), false);
  });

  it("lower-is-better: true only for the min", () => {
    assert.equal(isBest([0.5, 0.3, 0.8], 1, false), true);
    assert.equal(isBest([0.5, 0.3, 0.8], 0, false), false);
  });

  it("all-equal values each count as best (>= / <=)", () => {
    assert.equal(isBest([10, 10, 10], 0), true);
    assert.equal(isBest([10, 10, 10], 1), true);
    assert.equal(isBest([10, 10, 10], 2), true);
  });

  it("ignores null/undefined peers; null target is never best", () => {
    assert.equal(isBest([null, 20, 15], 1), true);
    assert.equal(isBest([null, 20, 15], 0), false);
    assert.equal(isBest([null, 20, null], 1), false); // no other comparable
    assert.equal(isBest([null, null, null], 0), false);
  });

  it("BUG-HUNT: a NaN target is never highlighted as best", () => {
    assert.equal(isBest([NaN, 20, 15], 0), false);
  });

  it("BUG-HUNT: a NaN/Infinity PEER does not poison the row (Math.max(...,NaN)=NaN)", () => {
    // Without the finite filter, Math.max(20, 15, NaN) = NaN → 20 >= NaN is
    // false → the real best (20) would fail to highlight.
    assert.equal(isBest([20, 15, NaN], 0), true);
    assert.equal(isBest([20, 15, Infinity], 0, false), false); // 20<=15? no, but Inf ignored → min is 15
    assert.equal(isBest([20, 15, Infinity], 1, false), true); // 15 is the min of {20,15}
  });

  it("single comparable value → false (nothing to beat)", () => {
    assert.equal(isBest([10], 0), false);
    assert.equal(isBest([10, NaN, null], 0), false);
  });

  it("handles negative values", () => {
    assert.equal(isBest([-10, -5, -20], 1), true);
    assert.equal(isBest([-5, 10, 3], 1), true);
  });
});

// ============================================================================
// rankInstruments / pickWinner — deterministic, NaN-safe ordering
// ============================================================================

describe("rankInstruments", () => {
  it("ranks higher score first by default", () => {
    const ranked = rankInstruments([
      { label: "A", score: 10 },
      { label: "B", score: 30 },
      { label: "C", score: 20 },
    ]);
    assert.deepEqual(
      ranked.map((r) => r.label),
      ["B", "C", "A"]
    );
    assert.deepEqual(
      ranked.map((r) => r.rank),
      [1, 2, 3]
    );
  });

  it("ranks lower score first when higher=false", () => {
    const ranked = rankInstruments(
      [
        { label: "A", score: 0.8 },
        { label: "B", score: 0.3 },
        { label: "C", score: 0.5 },
      ],
      false
    );
    assert.deepEqual(
      ranked.map((r) => r.label),
      ["B", "C", "A"]
    );
  });

  it("is order-independent (same multiset → same ranking)", () => {
    const items: RankableItem[] = [
      { label: "A", score: 10 },
      { label: "B", score: 30 },
      { label: "C", score: 20 },
    ];
    const a = rankInstruments(items);
    const b = rankInstruments([...items].reverse());
    assert.deepEqual(a, b);
  });

  it("BUG-HUNT: all-equal scores → deterministic label-ascending order (stable)", () => {
    const ranked = rankInstruments([
      { label: "C", score: 5 },
      { label: "A", score: 5 },
      { label: "B", score: 5 },
    ]);
    assert.deepEqual(
      ranked.map((r) => r.label),
      ["A", "B", "C"]
    );
  });

  it("BUG-HUNT: NaN / Infinity / null scores are ranked LAST, never first", () => {
    const ranked = rankInstruments([
      { label: "good", score: 42 },
      { label: "nan", score: NaN },
      { label: "inf", score: Infinity },
      { label: "missing", score: null },
    ]);
    // Finite "good" wins; the three non-finite tie and sort by label.
    assert.equal(ranked[0]!.label, "good");
    assert.deepEqual(
      ranked.slice(1).map((r) => r.label),
      ["inf", "missing", "nan"]
    );
    // Non-finite scores are surfaced as null, not NaN/Infinity.
    for (const r of ranked.slice(1)) assert.equal(r.score, null);
  });

  it("BUG-HUNT: a NaN top score does NOT win even though raw sort would be unstable", () => {
    // Adversarial: NaN first in input. Raw `arr.sort((a,b)=>b-a)` with a NaN
    // comparator leaves NaN potentially at index 0. Here it must rank last.
    const ranked = rankInstruments([
      { label: "corrupt", score: NaN },
      { label: "real", score: 1 },
    ]);
    assert.equal(ranked[0]!.label, "real");
    assert.equal(ranked[1]!.label, "corrupt");
  });

  it("empty input → []", () => {
    assert.deepEqual(rankInstruments([]), []);
  });

  it("preserves the finite score on the ranked row", () => {
    const ranked = rankInstruments([{ label: "X", score: 73.5 }]);
    assert.equal(ranked[0]!.score, 73.5);
  });
});

describe("pickWinner", () => {
  it("returns the rank-1 finite item", () => {
    const w = pickWinner([
      { label: "A", score: 10 },
      { label: "B", score: 30 },
    ]);
    assert.ok(w);
    assert.equal(w.label, "B");
    assert.equal(w.score, 30);
  });

  it("respects lower-is-better", () => {
    const w = pickWinner(
      [
        { label: "cheap", score: 0.2 },
        { label: "dear", score: 0.9 },
      ],
      false
    );
    assert.equal(w!.label, "cheap");
  });

  it("BUG-HUNT: when EVERY score is non-finite/missing → null (no crowned corrupt row)", () => {
    assert.equal(
      pickWinner([
        { label: "A", score: NaN },
        { label: "B", score: Infinity },
        { label: "C", score: null },
      ]),
      null
    );
  });

  it("BUG-HUNT: a NaN entry never beats a finite one", () => {
    const w = pickWinner([
      { label: "nan", score: NaN },
      { label: "finite", score: -5 },
    ]);
    assert.equal(w!.label, "finite");
  });

  it("empty input → null", () => {
    assert.equal(pickWinner([]), null);
  });

  it("all-equal → lexicographically-smallest label wins (deterministic)", () => {
    const w = pickWinner([
      { label: "Z", score: 1 },
      { label: "A", score: 1 },
    ]);
    assert.equal(w!.label, "A");
  });
});

// ============================================================================
// buildNavComparisonSeries — the LIVE service wrapper the chart depends on
// (drives the real export so the test fails if the service stops calling it)
// ============================================================================

describe("buildNavComparisonSeries (live service export)", () => {
  it("keys each fund's series by `${fundType}:${id}` and bases to 100", () => {
    const funds = [
      mkFund({ id: "f1", fundType: "MF" }),
      mkFund({ id: "f2", fundType: "ETF" }),
    ];
    const navHistory = {
      "MF:f1": [
        { date: "2024-01-01", value: 50 },
        { date: "2024-02-01", value: 75 },
      ],
      "ETF:f2": [
        { date: "2024-01-01", value: 200 },
        { date: "2024-02-01", value: 180 },
      ],
    };
    const rows = buildNavComparisonSeries(funds, navHistory);
    assert.equal(rows.length, 2);
    assert.equal(rows[0]!["fund0"], 100);
    assert.equal(rows[0]!["fund1"], 100);
    assert.equal(rows[1]!["fund0"], 150); // 75/50
    assert.equal(rows[1]!["fund1"], 90); // 180/200
  });

  it("a fund with no navHistory entry contributes no column (missing key)", () => {
    const funds = [mkFund({ id: "f1", fundType: "MF" })];
    const rows = buildNavComparisonSeries(funds, {});
    assert.deepEqual(rows, []);
  });

  it("BUG-HUNT: a corrupt fund series never poisons a healthy fund's column, and stays finite", () => {
    const funds = [
      mkFund({ id: "good", fundType: "MF" }),
      mkFund({ id: "bad", fundType: "MF" }),
    ];
    const navHistory = {
      "MF:good": [
        { date: "2024-01-01", value: 100 },
        { date: "2024-02-01", value: 125 },
      ],
      "MF:bad": [
        { date: "2024-01-01", value: 0 }, // ÷0 trap
        { date: "2024-02-01", value: NaN }, // poison
      ],
    };
    const rows = buildNavComparisonSeries(funds, navHistory);
    assert.equal(rows[0]!["fund0"], 100);
    assert.equal(rows[1]!["fund0"], 125);
    for (const r of rows) {
      assert.ok(Number.isFinite(r["fund0"]));
      // bad fund had no usable base anywhere → never a finite column value.
      if (r["fund1"] !== undefined) assert.ok(Number.isFinite(r["fund1"]));
    }
  });

  it("consumer-safety: every emitted index is safe for Number(...).toFixed()", () => {
    const funds = [mkFund({ id: "f1", fundType: "MF" })];
    const navHistory = {
      "MF:f1": [
        { date: "2024-01-01", value: 10 },
        { date: "2024-02-01", value: Infinity },
        { date: "2024-03-01", value: 13 },
      ],
    };
    const rows = buildNavComparisonSeries(funds, navHistory);
    for (const r of rows) {
      const v = r["fund0"];
      if (v !== undefined) {
        // Must not throw / produce "NaN"/"Infinity".
        const s = Number(v).toFixed(2);
        assert.ok(/^-?\d+\.\d{2}$/.test(s), `bad toFixed output: ${s}`);
      }
    }
  });
});

// ============================================================================
// ComparisonData shape — the field the live service now populates
// ============================================================================

describe("ComparisonData.normalizedSeries", () => {
  it("is part of the comparison payload contract", () => {
    const data: ComparisonData = {
      funds: [],
      navHistory: {},
      compositions: {},
      normalizedSeries: [{ date: "2024-01-01", fund0: 100 }],
    };
    assert.ok(Array.isArray(data.normalizedSeries));
    assert.equal(data.normalizedSeries[0]!["fund0"], 100);
  });
});
