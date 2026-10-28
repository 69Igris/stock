/**
 * MONEY-620 — Holdings pure-logic unit tests (REAL exported helpers).
 *
 * EXERCISES THE REAL SOURCE: imports the pure, finite-guarded helpers from
 * `packages/services/src/holdings-logic.ts` — exactly the math that
 * `getHoldings` (in `packages/services/src/holdings.service.ts`, the user-facing
 * holdings money path) now calls. NO inline reimplementation of P&L / settlement
 * / grouping math; every assertion drives the shipped export (no shadow).
 *
 * The `holdings-logic` module is Prisma-free, so importing it never opens a DB
 * connection — this suite stays pure and exits cleanly (no orphan). It is
 * imported by RELATIVE path (the worker-test convention) since the
 * `@usemoney/services` barrel pulls Prisma/Redis at load.
 *
 * Bug classes pinned here (each fixture is the exact failing input the
 * finite-guard fix closes — a regression that drops a guard turns these RED):
 *   - non-finite POISON: NaN/±Infinity currentValue/quantity/avgPrice/price/
 *     unrealizedPnL must contribute 0, never NaN/Infinity, to any total/subtotal.
 *   - pnl% / summary% division-by-zero / non-finite invested → clamp to 0 / "0"
 *     (never Infinity, never the literal string "NaN"/"Infinity").
 *   - Invalid-Date createdAt → safeToDateString must return undefined, not throw.
 *   - sector/exchange grouping with missing/empty/whitespace/duplicate keys;
 *     subtotals reconcile with the grand total.
 *   - weighted-average buy price with zero/negative/NaN total quantity → 0
 *     (no Σ(qty·px)/0 = NaN/Infinity).
 *   - consumer-safety: nothing the helpers emit is NaN/Infinity at a `.toFixed`.
 *
 * Source: packages/services/src/holdings-logic.ts
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  finite,
  safeToDateString,
  computeHoldingValues,
  pnlPercentage,
  pnlPercentageString,
  summarizeHoldings,
  groupHoldingsBySector,
  groupHoldingsByExchange,
  weightedAverageBuyPrice,
  UNGROUPED_KEY,
  type HoldingValuesInput,
  type HoldingGroupInput,
  type HoldingSummaryInput,
} from "../../../../packages/services/src/holdings-logic";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function holdingValuesInput(
  overrides: Partial<HoldingValuesInput> = {}
): HoldingValuesInput {
  return {
    quantity: 10,
    t1Quantity: 0,
    averagePrice: 100,
    currentPrice: 150,
    investedValue: 1000,
    currentValue: 1500,
    unrealizedPnL: 500,
    ...overrides,
  };
}

function groupInput(
  overrides: Partial<HoldingGroupInput> = {}
): HoldingGroupInput {
  return {
    sector: "IT",
    exchange: "NSE",
    investedValue: 1000,
    currentValue: 1200,
    unrealizedPnL: 200,
    ...overrides,
  };
}

/** All the numeric outputs a downstream formatter would touch. */
function assertAllFinite(values: number[], label: string): void {
  for (const n of values) {
    assert.ok(
      Number.isFinite(n),
      `${label}: every formatted number must be finite (got ${String(n)})`
    );
    assert.notStrictEqual(
      (n as number).toFixed(2),
      "NaN",
      `${label}: .toFixed(2) must never be "NaN"`
    );
  }
}

// ---------------------------------------------------------------------------
// finite()
// ---------------------------------------------------------------------------

describe("MONEY-620 holdings-logic — finite()", () => {
  it("passes through ordinary finite numbers (incl. 0 and negatives)", () => {
    assert.strictEqual(finite(1500), 1500);
    assert.strictEqual(finite(0), 0);
    assert.strictEqual(finite(-42.5), -42.5);
  });

  it("collapses null / undefined / NaN / ±Infinity to the fallback (default 0)", () => {
    assert.strictEqual(finite(null), 0);
    assert.strictEqual(finite(undefined), 0);
    assert.strictEqual(finite(NaN), 0);
    assert.strictEqual(finite(Infinity), 0);
    assert.strictEqual(finite(-Infinity), 0);
  });

  it("honours a custom fallback", () => {
    assert.strictEqual(finite(NaN, -1), -1);
    assert.strictEqual(finite(undefined, 7), 7);
  });

  it("0 is NOT replaced by the fallback (it is a valid finite value)", () => {
    assert.strictEqual(finite(0, 99), 0);
  });
});

// ---------------------------------------------------------------------------
// safeToDateString() — Invalid-Date guard
// ---------------------------------------------------------------------------

describe("MONEY-620 holdings-logic — safeToDateString()", () => {
  it("formats a valid Date as YYYY-MM-DD", () => {
    assert.strictEqual(
      safeToDateString(new Date("2026-01-02T10:30:00Z")),
      "2026-01-02"
    );
  });

  it("returns undefined (never throws) for an Invalid Date — the .toISOString() RangeError bait", () => {
    const bad = new Date("not-a-real-date");
    assert.ok(Number.isNaN(bad.getTime()), "fixture is an Invalid Date");
    let out: string | undefined;
    assert.doesNotThrow(() => {
      out = safeToDateString(bad);
    });
    assert.strictEqual(out, undefined);
  });

  it("returns undefined for null / undefined", () => {
    assert.strictEqual(safeToDateString(null), undefined);
    assert.strictEqual(safeToDateString(undefined), undefined);
  });

  it("parses a string / epoch number without throwing", () => {
    assert.strictEqual(safeToDateString("2026-03-15T00:00:00Z"), "2026-03-15");
    assert.strictEqual(safeToDateString("garbage"), undefined);
    assert.strictEqual(safeToDateString(Date.UTC(2025, 11, 31)), "2025-12-31");
    assert.strictEqual(safeToDateString(NaN), undefined);
  });
});

// ---------------------------------------------------------------------------
// computeHoldingValues() — settlement math + finite guards
// ---------------------------------------------------------------------------

describe("MONEY-620 holdings-logic — computeHoldingValues()", () => {
  it("settled (quantity>0) TRUSTS the stored invested/current/pnl (behaviour-preserving)", () => {
    const v = computeHoldingValues(
      holdingValuesInput({
        quantity: 10,
        t1Quantity: 0,
        investedValue: 1000,
        currentValue: 1500,
        unrealizedPnL: 500,
      })
    );
    assert.strictEqual(v.investedValue, 1000);
    assert.strictEqual(v.currentValue, 1500);
    assert.strictEqual(v.unrealizedPnL, 500);
    assert.strictEqual(v.pnlPercentage, 50);
    assert.strictEqual(v.effectiveQuantity, 10);
  });

  it("unsettled (quantity=0) RECOMPUTES from T1 * price (settlement branch)", () => {
    const v = computeHoldingValues(
      holdingValuesInput({
        quantity: 0,
        t1Quantity: 5,
        averagePrice: 200,
        currentPrice: 220,
        // stale stored values — must be ignored when quantity is 0
        investedValue: 0,
        currentValue: 0,
        unrealizedPnL: 0,
      })
    );
    // effectiveQty 5 → invested 5*200=1000, current 5*220=1100, pnl 100
    assert.strictEqual(v.investedValue, 1000);
    assert.strictEqual(v.currentValue, 1100);
    assert.strictEqual(v.unrealizedPnL, 100);
    assert.strictEqual(v.t1Quantity, 5);
    assert.strictEqual(v.effectiveQuantity, 5);
  });

  it("null t1Quantity is treated as 0", () => {
    const v = computeHoldingValues(
      holdingValuesInput({ quantity: 0, t1Quantity: null, averagePrice: 100 })
    );
    // effectiveQty 0 → invested 0
    assert.strictEqual(v.effectiveQuantity, 0);
    assert.strictEqual(v.investedValue, 0);
  });

  // ── non-finite POISON on the trusted (settled) branch ──
  it("POISON: NaN stored currentValue (settled) → 0, never NaN", () => {
    const v = computeHoldingValues(
      holdingValuesInput({ quantity: 10, currentValue: NaN })
    );
    assert.strictEqual(v.currentValue, 0);
    assertAllFinite(
      [v.investedValue, v.currentValue, v.unrealizedPnL, v.pnlPercentage],
      "NaN currentValue"
    );
  });

  it("POISON: Infinity stored unrealizedPnL (settled) → 0; pnl% stays finite", () => {
    const v = computeHoldingValues(
      holdingValuesInput({
        quantity: 10,
        investedValue: 1000,
        unrealizedPnL: Infinity,
      })
    );
    assert.strictEqual(v.unrealizedPnL, 0);
    assert.ok(Number.isFinite(v.pnlPercentage));
  });

  it("POISON: Infinity stored investedValue (settled) → 0; pnl% clamps to 0 (not Infinity)", () => {
    const v = computeHoldingValues(
      holdingValuesInput({
        quantity: 10,
        investedValue: Infinity,
        unrealizedPnL: 500,
      })
    );
    assert.strictEqual(v.investedValue, 0);
    // invested 0 → pnl% must be 0, NOT 500/Infinity or 500/0.
    assert.strictEqual(v.pnlPercentage, 0);
  });

  // ── non-finite POISON on the recompute (unsettled) branch ──
  it("POISON: NaN averagePrice (unsettled recompute) → invested 0, never NaN", () => {
    const v = computeHoldingValues(
      holdingValuesInput({
        quantity: 0,
        t1Quantity: 5,
        averagePrice: NaN,
        currentPrice: 220,
      })
    );
    assert.strictEqual(v.investedValue, 0);
    assert.strictEqual(v.currentValue, 1100);
    assertAllFinite(
      [v.investedValue, v.currentValue, v.unrealizedPnL, v.pnlPercentage],
      "NaN averagePrice"
    );
  });

  it("POISON: Infinity currentPrice (unsettled recompute) → current 0, never Infinity", () => {
    const v = computeHoldingValues(
      holdingValuesInput({
        quantity: 0,
        t1Quantity: 5,
        averagePrice: 200,
        currentPrice: Infinity,
      })
    );
    assert.strictEqual(v.currentValue, 0);
    assert.ok(Number.isFinite(v.unrealizedPnL));
  });

  it("POISON: NaN quantity (settlement gate input) does not throw or poison; outputs finite", () => {
    // quantity NaN: `finite(NaN)=0` so the gate `0 > 0` is false → recompute path.
    const v = computeHoldingValues(
      holdingValuesInput({
        quantity: NaN,
        t1Quantity: 3,
        averagePrice: 100,
        currentPrice: 110,
      })
    );
    // effectiveQty = 0 + 3 = 3 → invested 300, current 330, pnl 30
    assert.strictEqual(v.effectiveQuantity, 3);
    assert.strictEqual(v.investedValue, 300);
    assert.strictEqual(v.currentValue, 330);
    assertAllFinite(
      [v.investedValue, v.currentValue, v.unrealizedPnL, v.pnlPercentage],
      "NaN quantity"
    );
  });

  it("negative quantity (short-ish corrupt row) stays finite", () => {
    const v = computeHoldingValues(
      holdingValuesInput({
        quantity: -5,
        t1Quantity: 0,
        averagePrice: 100,
        currentPrice: 90,
      })
    );
    // quantity -5 not > 0 → recompute: effectiveQty -5 → invested -500, current -450, pnl 50
    assert.strictEqual(v.investedValue, -500);
    assert.strictEqual(v.currentValue, -450);
    // invested negative → pnl% clamps to 0 (divisor must be strictly positive)
    assert.strictEqual(v.pnlPercentage, 0);
  });

  it("zero-cost holding (invested 0) → pnl% is 0, never NaN/Infinity", () => {
    const v = computeHoldingValues(
      holdingValuesInput({
        quantity: 0,
        t1Quantity: 5,
        averagePrice: 0, // zero cost basis
        currentPrice: 100,
      })
    );
    assert.strictEqual(v.investedValue, 0);
    assert.strictEqual(v.currentValue, 500);
    assert.strictEqual(v.pnlPercentage, 0);
  });

  it("very large finite sums do not overflow to Infinity", () => {
    const v = computeHoldingValues(
      holdingValuesInput({
        quantity: 0,
        t1Quantity: 1e6,
        averagePrice: 1e6,
        currentPrice: 1e6,
      })
    );
    // 1e6 * 1e6 = 1e12 — large but finite
    assert.strictEqual(v.investedValue, 1e12);
    assert.ok(Number.isFinite(v.currentValue));
  });
});

// ---------------------------------------------------------------------------
// pnlPercentage() / pnlPercentageString()
// ---------------------------------------------------------------------------

describe("MONEY-620 holdings-logic — pnlPercentage() (number)", () => {
  it("computes a positive / negative percentage", () => {
    assert.strictEqual(pnlPercentage(500, 1000), 50);
    assert.strictEqual(pnlPercentage(-250, 1000), -25);
  });

  it("returns 0 when invested is 0 (div-by-zero clamp)", () => {
    assert.strictEqual(pnlPercentage(500, 0), 0);
  });

  it("returns 0 when invested is negative", () => {
    assert.strictEqual(pnlPercentage(500, -1000), 0);
  });

  it("returns 0 when invested is non-finite (NaN/Infinity)", () => {
    assert.strictEqual(pnlPercentage(500, NaN), 0);
    assert.strictEqual(pnlPercentage(500, Infinity), 0);
  });

  it("returns 0 when the P&L itself is non-finite", () => {
    assert.strictEqual(pnlPercentage(Infinity, 1000), 0);
    assert.strictEqual(pnlPercentage(NaN, 1000), 0);
  });
});

describe("MONEY-620 holdings-logic — pnlPercentageString() (summary)", () => {
  it("formats to fixed(2)", () => {
    assert.strictEqual(pnlPercentageString(10000, 100000), "10.00");
    assert.strictEqual(pnlPercentageString(-5000, 100000), "-5.00");
    assert.strictEqual(pnlPercentageString(10000, 300000), "3.33");
  });

  it("returns the string '0' when invested is 0 / negative", () => {
    assert.strictEqual(pnlPercentageString(5000, 0), "0");
    assert.strictEqual(pnlPercentageString(5000, -1), "0");
  });

  it("NEVER returns the literal 'NaN' / 'Infinity' for non-finite operands", () => {
    assert.strictEqual(pnlPercentageString(NaN, 100000), "0");
    assert.strictEqual(pnlPercentageString(Infinity, 100000), "0");
    assert.strictEqual(pnlPercentageString(5000, Infinity), "0");
    assert.strictEqual(pnlPercentageString(5000, NaN), "0");
  });

  it("the returned string is always Number()-finite (consumer safety)", () => {
    for (const s of [
      pnlPercentageString(10000, 100000),
      pnlPercentageString(NaN, NaN),
      pnlPercentageString(Infinity, 0),
      pnlPercentageString(5000, 0),
    ]) {
      assert.ok(
        Number.isFinite(Number(s)),
        `Number("${s}") must be finite for a UI that does Number(pnlPercentage)`
      );
    }
  });
});

// ---------------------------------------------------------------------------
// summarizeHoldings()
// ---------------------------------------------------------------------------

describe("MONEY-620 holdings-logic — summarizeHoldings()", () => {
  const rows = (xs: HoldingSummaryInput[]) => xs;

  it("sums invested/current/pnl and formats the percentage", () => {
    const s = summarizeHoldings(
      rows([
        { investedValue: 100000, currentValue: 110000, unrealizedPnL: 10000 },
        { investedValue: 200000, currentValue: 180000, unrealizedPnL: -20000 },
      ])
    );
    assert.strictEqual(s.totalInvested, 300000);
    assert.strictEqual(s.totalCurrent, 290000);
    assert.strictEqual(s.totalPnL, -10000);
    // -10000 / 300000 * 100 = -3.33
    assert.strictEqual(s.pnlPercentage, "-3.33");
  });

  it("empty portfolio → zeroed summary, percentage '0'", () => {
    const s = summarizeHoldings([]);
    assert.deepStrictEqual(s, {
      totalInvested: 0,
      totalCurrent: 0,
      totalPnL: 0,
      pnlPercentage: "0",
    });
  });

  it("POISON: ONE NaN/Infinity row does NOT make any grand total NaN/Infinity", () => {
    const s = summarizeHoldings(
      rows([
        { investedValue: 450000, currentValue: 500000, unrealizedPnL: 50000 },
        // corrupt row: each field a different poison
        {
          investedValue: NaN,
          currentValue: Infinity,
          unrealizedPnL: -Infinity,
        },
      ])
    );
    // the bad row contributes 0 to every total
    assert.strictEqual(s.totalInvested, 450000);
    assert.strictEqual(s.totalCurrent, 500000);
    assert.strictEqual(s.totalPnL, 50000);
    assertAllFinite(
      [s.totalInvested, s.totalCurrent, s.totalPnL, Number(s.pnlPercentage)],
      "poisoned summary"
    );
    assert.notStrictEqual(s.pnlPercentage, "NaN");
    assert.notStrictEqual(s.pnlPercentage, "Infinity");
  });

  it("summary % stays '0' when every row's invested is poisoned (no finite divisor)", () => {
    const s = summarizeHoldings(
      rows([
        { investedValue: Infinity, currentValue: 1, unrealizedPnL: 1 },
        { investedValue: NaN, currentValue: 1, unrealizedPnL: 1 },
      ])
    );
    assert.strictEqual(s.totalInvested, 0);
    assert.strictEqual(s.pnlPercentage, "0");
  });

  it("very large finite sums stay finite (no overflow to Infinity)", () => {
    const big = {
      investedValue: 1e15,
      currentValue: 1.1e15,
      unrealizedPnL: 1e14,
    };
    const s = summarizeHoldings(rows([big, big, big]));
    assert.ok(Number.isFinite(s.totalCurrent));
    assert.strictEqual(s.totalInvested, 3e15);
  });
});

// ---------------------------------------------------------------------------
// groupHoldingsBySector() / groupHoldingsByExchange()
// ---------------------------------------------------------------------------

describe("MONEY-620 holdings-logic — sector / exchange grouping", () => {
  it("groups by sector and sums each bucket", () => {
    const groups = groupHoldingsBySector([
      groupInput({
        sector: "IT",
        currentValue: 1200,
        investedValue: 1000,
        unrealizedPnL: 200,
      }),
      groupInput({
        sector: "Energy",
        currentValue: 3000,
        investedValue: 2500,
        unrealizedPnL: 500,
      }),
      groupInput({
        sector: "IT",
        currentValue: 800,
        investedValue: 900,
        unrealizedPnL: -100,
      }),
    ]);
    const it = groups.find((g) => g.key === "IT")!;
    const energy = groups.find((g) => g.key === "Energy")!;
    assert.strictEqual(it.count, 2);
    assert.strictEqual(it.totalCurrent, 2000);
    assert.strictEqual(it.totalInvested, 1900);
    assert.strictEqual(it.totalPnL, 100);
    assert.strictEqual(energy.count, 1);
    assert.strictEqual(energy.totalCurrent, 3000);
    // largest current value first → Energy(3000) before IT(2000)
    assert.strictEqual(groups[0]!.key, "Energy");
  });

  it("missing / null / empty / whitespace sector all collapse into ONE 'Unknown' bucket (no ghost rows)", () => {
    const groups = groupHoldingsBySector([
      groupInput({
        sector: null,
        currentValue: 100,
        investedValue: 100,
        unrealizedPnL: 0,
      }),
      groupInput({
        sector: undefined,
        currentValue: 200,
        investedValue: 200,
        unrealizedPnL: 0,
      }),
      groupInput({
        sector: "",
        currentValue: 300,
        investedValue: 300,
        unrealizedPnL: 0,
      }),
      groupInput({
        sector: "   ",
        currentValue: 400,
        investedValue: 400,
        unrealizedPnL: 0,
      }),
    ]);
    assert.strictEqual(groups.length, 1, "all unknown-key rows merge");
    assert.strictEqual(groups[0]!.key, UNGROUPED_KEY);
    assert.strictEqual(groups[0]!.count, 4);
    assert.strictEqual(groups[0]!.totalCurrent, 1000);
  });

  it("a duplicate sector does not split into two buckets (trim-normalized merge)", () => {
    const groups = groupHoldingsBySector([
      groupInput({ sector: "Banking" }),
      groupInput({ sector: " Banking " }), // padded duplicate
    ]);
    assert.strictEqual(groups.length, 1);
    assert.strictEqual(groups[0]!.key, "Banking");
    assert.strictEqual(groups[0]!.count, 2);
  });

  it("RECONCILIATION: sum of every sector bucket equals the portfolio summary total", () => {
    const rows = [
      groupInput({
        sector: "IT",
        currentValue: 1200,
        investedValue: 1000,
        unrealizedPnL: 200,
      }),
      groupInput({
        sector: "Energy",
        currentValue: 3000,
        investedValue: 2500,
        unrealizedPnL: 500,
      }),
      groupInput({
        sector: null,
        currentValue: 700,
        investedValue: 800,
        unrealizedPnL: -100,
      }),
    ];
    const groups = groupHoldingsBySector(rows);
    const summary = summarizeHoldings(rows);
    const bucketCurrent = groups.reduce((a, g) => a + g.totalCurrent, 0);
    const bucketInvested = groups.reduce((a, g) => a + g.totalInvested, 0);
    const bucketPnL = groups.reduce((a, g) => a + g.totalPnL, 0);
    assert.strictEqual(bucketCurrent, summary.totalCurrent);
    assert.strictEqual(bucketInvested, summary.totalInvested);
    assert.strictEqual(bucketPnL, summary.totalPnL);
  });

  it("POISON: a NaN/Infinity holding never poisons its bucket subtotal or the bucket %", () => {
    const groups = groupHoldingsBySector([
      groupInput({
        sector: "IT",
        currentValue: 1200,
        investedValue: 1000,
        unrealizedPnL: 200,
      }),
      groupInput({
        sector: "IT",
        currentValue: Infinity,
        investedValue: NaN,
        unrealizedPnL: -Infinity,
      }),
    ]);
    const it = groups.find((g) => g.key === "IT")!;
    assert.strictEqual(it.totalCurrent, 1200);
    assert.strictEqual(it.totalInvested, 1000);
    assert.strictEqual(it.totalPnL, 200);
    assert.ok(Number.isFinite(Number(it.pnlPercentage)));
    assert.notStrictEqual(it.pnlPercentage, "NaN");
  });

  it("groups by exchange with the same missing-key + finite rules", () => {
    const groups = groupHoldingsByExchange([
      groupInput({
        exchange: "NSE",
        currentValue: 1000,
        investedValue: 1000,
        unrealizedPnL: 0,
      }),
      groupInput({
        exchange: "BSE",
        currentValue: 2000,
        investedValue: 1800,
        unrealizedPnL: 200,
      }),
      groupInput({
        exchange: null,
        currentValue: 500,
        investedValue: 500,
        unrealizedPnL: 0,
      }),
    ]);
    assert.strictEqual(groups.length, 3);
    assert.ok(groups.some((g) => g.key === "NSE"));
    assert.ok(groups.some((g) => g.key === UNGROUPED_KEY));
    // deterministic order: BSE(2000) > NSE(1000) > Unknown(500)
    assert.deepStrictEqual(
      groups.map((g) => g.key),
      ["BSE", "NSE", UNGROUPED_KEY]
    );
  });

  it("empty input → empty grouping", () => {
    assert.deepStrictEqual(groupHoldingsBySector([]), []);
    assert.deepStrictEqual(groupHoldingsByExchange([]), []);
  });
});

// ---------------------------------------------------------------------------
// weightedAverageBuyPrice()
// ---------------------------------------------------------------------------

describe("MONEY-620 holdings-logic — weightedAverageBuyPrice()", () => {
  it("computes a quantity-weighted average across lots", () => {
    // (10*100 + 30*200) / 40 = (1000+6000)/40 = 175
    assert.strictEqual(
      weightedAverageBuyPrice([
        { quantity: 10, averagePrice: 100 },
        { quantity: 30, averagePrice: 200 },
      ]),
      175
    );
  });

  it("single lot returns that lot's price", () => {
    assert.strictEqual(
      weightedAverageBuyPrice([{ quantity: 5, averagePrice: 250 }]),
      250
    );
  });

  it("ZERO total quantity → 0 (div-by-zero clamp, no NaN/Infinity)", () => {
    const out = weightedAverageBuyPrice([{ quantity: 0, averagePrice: 100 }]);
    assert.strictEqual(out, 0);
    assert.ok(Number.isFinite(out));
  });

  it("lots that net to zero quantity (full exit) → 0, not NaN", () => {
    const out = weightedAverageBuyPrice([
      { quantity: 10, averagePrice: 100 },
      { quantity: -10, averagePrice: 120 },
    ]);
    assert.strictEqual(out, 0);
  });

  it("empty lots → 0", () => {
    assert.strictEqual(weightedAverageBuyPrice([]), 0);
  });

  it("POISON: NaN quantity / NaN price contribute 0; result stays finite", () => {
    const out = weightedAverageBuyPrice([
      { quantity: NaN, averagePrice: 100 },
      { quantity: 10, averagePrice: 200 },
      { quantity: 5, averagePrice: NaN },
    ]);
    // qtys: 0 + 10 + 5 = 15; cost: 0 + 10*200 + 5*0 = 2000 → 2000/15 = 133.33…
    assert.ok(Number.isFinite(out));
    assert.ok(Math.abs(out - 2000 / 15) < 1e-9);
  });

  it("POISON: Infinity quantity is neutralised (does not make the blend Infinity)", () => {
    const out = weightedAverageBuyPrice([
      { quantity: Infinity, averagePrice: 100 },
      { quantity: 10, averagePrice: 200 },
    ]);
    // Infinity qty → 0; only the clean lot remains → 200
    assert.strictEqual(out, 200);
  });
});
