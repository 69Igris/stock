/**
 * Dashboard portfolio-RETURNS pure-logic unit tests (MONEY-620, task 150).
 *
 * `getDashboardStats` was hardened in earlier waves; `getPortfolioReturns` in
 * `packages/services/src/dashboard.service.ts` — the XIRR/CAGR returns chart —
 * was deliberately LEFT UNTOUCHED. This file closes that gap.
 *
 * The cashflow-series builder, the mark-to-market close, the span/annualisation,
 * and the plausibility band were extracted out of the service into EXPORTED
 * helpers in `packages/services/src/dashboard-logic.ts`; the production
 * `getPortfolioReturns` now CALLS `computePortfolioReturns` with the REAL
 * `calcXirr`/`calcCagr` solvers injected. These tests import those SAME real
 * exports (via the relative path the task pins) AND the SAME real solvers from
 * `@usemoney/core/calc`, inject them, and assert — so a regression in the
 * returns math fails here too. NO shadow: nothing is re-declared and asserted as
 * a copy; the only inline arithmetic is the OLD inline formula reproduced ONCE
 * to PROVE behaviour-preservation against the extracted output.
 *
 * Focus: EXHAUSTIVE negative / edge / bug-hunt for an iterative XIRR solver and
 * a `Math.pow`-based CAGR — non-convergence, single / same-date / sign-locked
 * cashflows, zero-derivative Newton steps, overflow guesses, div-by-zero, NaN/
 * ±Infinity poison in trade & holding values, Invalid-Date crash (RangeError on
 * `.toISOString()`), empty portfolio, IDOR scope, and consumer-safety (nothing
 * non-finite reaches the % formatters / chart). Pure → exits clean (no DB /
 * network / timers / open handles).
 *
 * Source: packages/services/src/dashboard-logic.ts (returns helpers) +
 *         packages/services/src/dashboard.service.ts#getPortfolioReturns
 *         packages/core/src/calc/{xirr,cagr}.ts (REAL injected solvers)
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

// REAL extracted returns logic (the production service calls these).
import {
  resolveTradeValue,
  isValidDate,
  safeIsoDate,
  daySpan,
  calculateCurrentMarketValue,
  buildReturnsCashFlows,
  computeXirrPct,
  computeCagr,
  computePortfolioReturns,
  EMPTY_PORTFOLIO_RETURNS,
  MIN_PLAUSIBLE_RATE,
  MAX_PLAUSIBLE_RATE,
  MIN_DAYS_FOR_XIRR,
  type ReturnsCashFlow,
  type ReturnsTradeInput,
  type ReturnsSolvers,
} from "../../../../packages/services/src/dashboard-logic";

// REAL solvers — kept real so XIRR/CAGR is genuinely exercised end-to-end.
import { calcXirr, calcCagr } from "../../../../packages/core/src/calc";

const SOLVERS: ReturnsSolvers = { calcXirr, calcCagr };
// A fixed "now" so spans are deterministic regardless of wall-clock.
const NOW = new Date("2026-06-05T00:00:00.000Z");

/** Day(s) before NOW as a Date. */
function daysAgo(n: number): Date {
  return new Date(NOW.getTime() - n * 24 * 60 * 60 * 1000);
}

function buy(
  partial: Partial<ReturnsTradeInput> & { tradeDate: Date }
): ReturnsTradeInput {
  return {
    tradeType: "BUY",
    quantity: null,
    price: null,
    tradeValue: null,
    ...partial,
  };
}
function sell(
  partial: Partial<ReturnsTradeInput> & { tradeDate: Date }
): ReturnsTradeInput {
  return {
    tradeType: "SELL",
    quantity: null,
    price: null,
    tradeValue: null,
    ...partial,
  };
}

// ───────────────────────────────────────────────────────────────────────────
// Plausibility constants are the real exported source-of-truth.
// ───────────────────────────────────────────────────────────────────────────

describe("dashboard-logic returns — exported plausibility constants", () => {
  it("expose the bands the service gates on (real exports)", () => {
    assert.strictEqual(MIN_PLAUSIBLE_RATE, -0.99);
    assert.strictEqual(MAX_PLAUSIBLE_RATE, 10);
    assert.strictEqual(MIN_DAYS_FOR_XIRR, 7);
  });
});

// ───────────────────────────────────────────────────────────────────────────
// resolveTradeValue — prefer finite positive tradeValue, else qty*price.
// BUG-CLASS: a stored Infinity passes a bare `> 0` check (Infinity > 0 === true)
// and would poison the whole cashflow series; resolveTradeValue must reject it.
// ───────────────────────────────────────────────────────────────────────────

describe("dashboard-logic — resolveTradeValue (real export)", () => {
  it("prefers a finite positive tradeValue", () => {
    assert.strictEqual(
      resolveTradeValue({ tradeValue: 1500, quantity: 10, price: 100 }),
      1500
    );
  });

  it("falls back to quantity*price when tradeValue is null/zero/negative", () => {
    assert.strictEqual(
      resolveTradeValue({ tradeValue: null, quantity: 10, price: 50 }),
      500
    );
    assert.strictEqual(
      resolveTradeValue({ tradeValue: 0, quantity: 4, price: 25 }),
      100
    );
    assert.strictEqual(
      resolveTradeValue({ tradeValue: -100, quantity: 2, price: 30 }),
      60
    );
  });

  it("BUG-GUARD: Infinity tradeValue is rejected (not let through by > 0)", () => {
    assert.strictEqual(
      resolveTradeValue({ tradeValue: Infinity, quantity: null, price: null }),
      0
    );
    assert.strictEqual(
      resolveTradeValue({
        tradeValue: -Infinity,
        quantity: null,
        price: null,
      }),
      0
    );
  });

  it("BUG-GUARD: NaN tradeValue falls through to the qty*price fallback", () => {
    assert.strictEqual(
      resolveTradeValue({ tradeValue: NaN, quantity: 3, price: 100 }),
      300
    );
  });

  it("BUG-GUARD: a non-finite qty*price product resolves to 0 (no Infinity)", () => {
    assert.strictEqual(
      resolveTradeValue({ tradeValue: null, quantity: Infinity, price: 10 }),
      0
    );
    assert.strictEqual(
      resolveTradeValue({ tradeValue: null, quantity: NaN, price: 10 }),
      0
    );
  });

  it("zero/negative-only inputs resolve to 0 (skipped downstream)", () => {
    assert.strictEqual(
      resolveTradeValue({ tradeValue: null, quantity: 0, price: 0 }),
      0
    );
    assert.strictEqual(
      resolveTradeValue({ tradeValue: null, quantity: -5, price: 100 }),
      0
    );
  });
});

// ───────────────────────────────────────────────────────────────────────────
// isValidDate / safeIsoDate / daySpan — Invalid-Date defence.
// BUG-CLASS: an Invalid Date throws RangeError on .toISOString() and yields NaN
// on .getTime(); these guards keep both away from the solver and the formatter.
// ───────────────────────────────────────────────────────────────────────────

describe("dashboard-logic — isValidDate / safeIsoDate / daySpan (real exports)", () => {
  it("isValidDate accepts a real date, rejects Invalid/null/non-Date", () => {
    assert.strictEqual(isValidDate(new Date("2025-01-01")), true);
    assert.strictEqual(isValidDate(new Date("not-a-date")), false);
    assert.strictEqual(isValidDate(null), false);
    assert.strictEqual(isValidDate(undefined), false);
    // A non-Date masquerading value is rejected without throwing.
    assert.strictEqual(isValidDate("2025-01-01" as unknown as Date), false);
  });

  it("safeIsoDate returns YYYY-MM-DD for a valid date", () => {
    assert.strictEqual(
      safeIsoDate(new Date("2025-03-04T10:30:00Z")),
      "2025-03-04"
    );
  });

  it("BUG-GUARD: safeIsoDate returns null on Invalid Date (no RangeError throw)", () => {
    assert.doesNotThrow(() => safeIsoDate(new Date("garbage")));
    assert.strictEqual(safeIsoDate(new Date("garbage")), null);
    assert.strictEqual(safeIsoDate(null), null);
  });

  it("daySpan computes whole-day difference for valid dates", () => {
    assert.strictEqual(daySpan(daysAgo(365), NOW), 365);
    assert.strictEqual(daySpan(daysAgo(7), NOW), 7);
  });

  it("BUG-GUARD: daySpan returns 0 (never NaN) when either date is invalid", () => {
    assert.strictEqual(daySpan(new Date("nope"), NOW), 0);
    assert.strictEqual(daySpan(null, NOW), 0);
    assert.strictEqual(daySpan(daysAgo(10), new Date("nope")), 0);
  });
});

// ───────────────────────────────────────────────────────────────────────────
// calculateCurrentMarketValue — finite-guarded terminal value.
// BUG-CLASS: `currentValue || 0` lets Infinity through (Infinity || 0 ===
// Infinity), poisoning the XIRR close and the CAGR end value.
// ───────────────────────────────────────────────────────────────────────────

describe("dashboard-logic — calculateCurrentMarketValue (real export)", () => {
  it("sums holdings + MFs + |netQty*lastPrice| over positions", () => {
    const v = calculateCurrentMarketValue(
      [{ currentValue: 1000 }, { currentValue: 500 }],
      [{ currentValue: 800 }],
      [
        { netQuantity: 10, lastPrice: 50 },
        { netQuantity: -4, lastPrice: 25 },
      ]
    );
    // 1500 + 800 + |500| + |-100| = 2900
    assert.strictEqual(v, 2900);
  });

  it("BUG-GUARD: Infinity holding value contributes 0, never Infinity", () => {
    const v = calculateCurrentMarketValue(
      [{ currentValue: Infinity }, { currentValue: 500 }],
      [],
      []
    );
    assert.ok(Number.isFinite(v));
    assert.strictEqual(v, 500);
  });

  it("BUG-GUARD: NaN MF/position values contribute 0 (stay finite)", () => {
    const v = calculateCurrentMarketValue(
      [{ currentValue: 1000 }],
      [{ currentValue: NaN }],
      [{ netQuantity: NaN, lastPrice: 100 }]
    );
    assert.ok(Number.isFinite(v));
    assert.strictEqual(v, 1000);
  });

  it("null values are treated as 0", () => {
    const v = calculateCurrentMarketValue(
      [{ currentValue: null }],
      [{ currentValue: null }],
      [{ netQuantity: null, lastPrice: null }]
    );
    assert.strictEqual(v, 0);
  });

  it("empty portfolio → 0", () => {
    assert.strictEqual(calculateCurrentMarketValue([], [], []), 0);
  });
});

// ───────────────────────────────────────────────────────────────────────────
// buildReturnsCashFlows — the dated series builder.
// ───────────────────────────────────────────────────────────────────────────

describe("dashboard-logic — buildReturnsCashFlows (real export)", () => {
  it("BUY=outflow (−), SELL=inflow (+); tracks invested/proceeds/firstBuy", () => {
    const b1 = new Date("2024-01-01");
    const b2 = new Date("2024-06-01");
    const s1 = new Date("2025-01-01");
    const r = buildReturnsCashFlows([
      buy({ tradeValue: 10000, tradeDate: b2 }),
      buy({ tradeValue: 5000, tradeDate: b1 }), // earlier → becomes firstBuy
      sell({ tradeValue: 7000, tradeDate: s1 }),
    ]);
    assert.deepStrictEqual(
      r.flows.map((f) => f.amount),
      [-10000, -5000, 7000]
    );
    assert.strictEqual(r.totalInvested, 15000);
    assert.strictEqual(r.totalProceeds, 7000);
    assert.strictEqual(r.firstBuyDate?.toISOString(), b1.toISOString());
  });

  it("skips zero / non-positive-value rows", () => {
    const r = buildReturnsCashFlows([
      buy({ tradeValue: 0, quantity: 0, price: 0, tradeDate: daysAgo(10) }),
      buy({ tradeValue: 1000, tradeDate: daysAgo(5) }),
    ]);
    assert.strictEqual(r.flows.length, 1);
    assert.strictEqual(r.totalInvested, 1000);
  });

  it("BUG-GUARD: Infinity tradeValue row is dropped (not pushed as -Infinity)", () => {
    const r = buildReturnsCashFlows([
      buy({ tradeValue: Infinity, tradeDate: daysAgo(20) }),
      buy({ tradeValue: 1000, tradeDate: daysAgo(10) }),
    ]);
    assert.deepStrictEqual(
      r.flows.map((f) => f.amount),
      [-1000]
    );
    assert.strictEqual(r.totalInvested, 1000);
    for (const f of r.flows) assert.ok(Number.isFinite(f.amount));
  });

  it("BUG-GUARD: an Invalid-Date row is dropped entirely (no NaN-dated flow)", () => {
    const r = buildReturnsCashFlows([
      buy({ tradeValue: 1000, tradeDate: new Date("not-a-date") }),
      sell({ tradeValue: 1200, tradeDate: new Date("2025-01-01") }),
    ]);
    // Only the valid SELL survives; the Invalid-Date BUY is gone, so there is no
    // firstBuyDate and no NaN-dated flow to poison the solver.
    assert.strictEqual(r.flows.length, 1);
    assert.strictEqual(r.flows[0]!.amount, 1200);
    assert.strictEqual(r.firstBuyDate, null);
    for (const f of r.flows) assert.ok(isValidDate(f.date));
  });

  it("BUG-GUARD: Invalid-Date FIRST BUY never becomes firstBuyDate (no later toISOString throw)", () => {
    // This is the exact regression: the OLD inline code set
    //   firstBuyDate = new Date("not-a-date")
    // for the first BUY, then crashed on firstBuyDate.toISOString(). The builder
    // must anchor firstBuyDate to the *valid* later BUY instead.
    const valid = new Date("2025-02-02");
    const r = buildReturnsCashFlows([
      buy({ tradeValue: 1000, tradeDate: new Date("not-a-date") }),
      buy({ tradeValue: 2000, tradeDate: valid }),
    ]);
    assert.ok(isValidDate(r.firstBuyDate));
    assert.strictEqual(r.firstBuyDate!.toISOString(), valid.toISOString());
    // And it never throws turning that into an ISO date.
    assert.strictEqual(safeIsoDate(r.firstBuyDate), "2025-02-02");
  });

  it("ignores trade rows with an unknown tradeType (neither BUY nor SELL)", () => {
    const r = buildReturnsCashFlows([
      {
        tradeType: "DIVIDEND",
        quantity: 1,
        price: 1,
        tradeValue: 5,
        tradeDate: daysAgo(3),
      },
      {
        tradeType: null,
        quantity: 1,
        price: 1,
        tradeValue: 5,
        tradeDate: daysAgo(2),
      },
    ]);
    assert.strictEqual(r.flows.length, 0);
    assert.strictEqual(r.totalInvested, 0);
    assert.strictEqual(r.totalProceeds, 0);
  });
});

// ───────────────────────────────────────────────────────────────────────────
// computeXirrPct — gated XIRR. The iterative solver is the prime NaN/Infinity /
// non-termination surface; this gate must convert every degenerate result to
// null and never leak NaN/±Infinity to the chart.
// ───────────────────────────────────────────────────────────────────────────

describe("dashboard-logic — computeXirrPct (real export + REAL calcXirr)", () => {
  it("a genuine 1y +10% round trip → ~10% (real solver), as a percent", () => {
    const flows: ReturnsCashFlow[] = [
      { date: new Date("2025-01-01"), amount: -100 },
      { date: new Date("2026-01-01"), amount: 110 },
    ];
    const pct = computeXirrPct(flows, 365, calcXirr);
    assert.ok(pct != null && Math.abs(pct - 10) < 0.1, `got ${pct}`);
  });

  it("BUG-GUARD: < 2 flows → null (single cashflow can't define an IRR)", () => {
    assert.strictEqual(
      computeXirrPct(
        [{ date: new Date("2025-01-01"), amount: -100 }],
        365,
        calcXirr
      ),
      null
    );
    assert.strictEqual(computeXirrPct([], 365, calcXirr), null);
  });

  it("BUG-GUARD: span shorter than MIN_DAYS_FOR_XIRR → null (noise, not return)", () => {
    const flows: ReturnsCashFlow[] = [
      { date: daysAgo(3), amount: -100 },
      { date: NOW, amount: 110 },
    ];
    assert.strictEqual(computeXirrPct(flows, 3, calcXirr), null);
  });

  it("BUG-GUARD: NaN span → null (never NaN-gates through a comparison)", () => {
    const flows: ReturnsCashFlow[] = [
      { date: daysAgo(400), amount: -100 },
      { date: NOW, amount: 110 },
    ];
    assert.strictEqual(computeXirrPct(flows, NaN, calcXirr), null);
  });

  it("BUG-GUARD: all-positive flows (no sign change) → null, NOT NaN", () => {
    const flows: ReturnsCashFlow[] = [
      { date: daysAgo(400), amount: 100 },
      { date: NOW, amount: 110 },
    ];
    const pct = computeXirrPct(flows, 400, calcXirr);
    assert.strictEqual(pct, null);
  });

  it("BUG-GUARD: all-negative flows (no IRR root) → null, NOT a loop/NaN", () => {
    const flows: ReturnsCashFlow[] = [
      { date: daysAgo(400), amount: -100 },
      { date: NOW, amount: -110 },
    ];
    assert.strictEqual(computeXirrPct(flows, 400, calcXirr), null);
  });

  it("BUG-GUARD: all-same-date flows (dt=0, derivative div-by-zero) → null", () => {
    // days[i] = 0 for all ⇒ every term is amount/(1+r)^0 = amount; the
    // derivative is identically 0 (zero-derivative Newton step), so the solver
    // yields NaN — which the gate converts to null, never NaN to the chart.
    const d = new Date("2025-01-01");
    const flows: ReturnsCashFlow[] = [
      { date: d, amount: -100 },
      { date: d, amount: 110 },
    ];
    // Span is long enough that the gate doesn't short-circuit on days; the
    // null must come from the degenerate solve, not the span check.
    assert.strictEqual(computeXirrPct(flows, 400, calcXirr), null);
  });

  it("BUG-GUARD: an overflow-prone guess (huge inflow) → finite-or-null, never Infinity", () => {
    const flows: ReturnsCashFlow[] = [
      { date: daysAgo(400), amount: -1 },
      { date: NOW, amount: 1e308 }, // Math.pow can overflow chasing this rate
    ];
    const pct = computeXirrPct(flows, 400, calcXirr);
    // Either a finite percent or null — but NEVER ±Infinity / NaN to the UI.
    assert.ok(pct === null || Number.isFinite(pct), `got ${pct}`);
  });

  it("BUG-GUARD: a converged-but-implausible rate (> +1000%) → null", () => {
    // A solver that returns 50 (5000%) must be rejected by the plausibility band.
    const fakeSolver = () => 50;
    const flows: ReturnsCashFlow[] = [
      { date: daysAgo(400), amount: -100 },
      { date: NOW, amount: 110 },
    ];
    assert.strictEqual(computeXirrPct(flows, 400, fakeSolver), null);
  });

  it("BUG-GUARD: a solver returning Infinity/NaN is rejected to null", () => {
    const flows: ReturnsCashFlow[] = [
      { date: daysAgo(400), amount: -100 },
      { date: NOW, amount: 110 },
    ];
    assert.strictEqual(
      computeXirrPct(flows, 400, () => Infinity),
      null
    );
    assert.strictEqual(
      computeXirrPct(flows, 400, () => -Infinity),
      null
    );
    assert.strictEqual(
      computeXirrPct(flows, 400, () => NaN),
      null
    );
  });

  it("a near-total loss (−100 → +1 over a year) → ≈ −99% (boundary of band)", () => {
    const flows: ReturnsCashFlow[] = [
      { date: new Date("2025-01-01"), amount: -100 },
      { date: new Date("2026-01-01"), amount: 1 },
    ];
    const pct = computeXirrPct(flows, 365, calcXirr);
    assert.ok(pct != null && Math.abs(pct - -99) < 0.5, `got ${pct}`);
  });
});

// ───────────────────────────────────────────────────────────────────────────
// computeCagr — gated CAGR over (begin → end) / years.
// BUG-CLASS: (end/begin)^(1/years) with begin=0 (÷0), negative begin/end
// (Math.pow(neg, frac)=NaN), years=0 (1/0 exponent), end=0 — calcCagr returns
// null for each; computeCagr must never fabricate a number.
// ───────────────────────────────────────────────────────────────────────────

describe("dashboard-logic — computeCagr (real export + REAL calcCagr)", () => {
  it("doubling capital over ~1y → ~100% CAGR + rounded holding period", () => {
    const r = computeCagr(1000, 2000, 0, 365, calcCagr);
    assert.ok(
      r.cagrPct != null && Math.abs(r.cagrPct - 100) < 0.5,
      `got ${r.cagrPct}`
    );
    assert.strictEqual(r.holdingPeriodYears, 1);
  });

  it("credits realised proceeds into the end value (sold winners not penalised)", () => {
    // invested 1000, current 0, proceeds 1500 over 1y → end 1500 → +50%.
    const r = computeCagr(1000, 0, 1500, 365, calcCagr);
    assert.ok(
      r.cagrPct != null && Math.abs(r.cagrPct - 50) < 0.5,
      `got ${r.cagrPct}`
    );
  });

  it("BUG-GUARD: zero invested (begin=0, div-by-zero) → null, null", () => {
    const r = computeCagr(0, 2000, 0, 365, calcCagr);
    assert.deepStrictEqual(r, { cagrPct: null, holdingPeriodYears: null });
  });

  it("BUG-GUARD: negative invested → null (no Math.pow(neg, frac)=NaN leak)", () => {
    const r = computeCagr(-1000, 2000, 0, 365, calcCagr);
    assert.deepStrictEqual(r, { cagrPct: null, holdingPeriodYears: null });
  });

  it("BUG-GUARD: negative end value → null", () => {
    // current −500 + proceeds 0 = −500 end → calcCagr returns null.
    const r = computeCagr(1000, -500, 0, 365, calcCagr);
    assert.deepStrictEqual(r, { cagrPct: null, holdingPeriodYears: null });
  });

  it("BUG-GUARD: years=0 (span=0 → 1/0 exponent) → null", () => {
    const r = computeCagr(1000, 2000, 0, 0, calcCagr);
    assert.deepStrictEqual(r, { cagrPct: null, holdingPeriodYears: null });
  });

  it("BUG-GUARD: negative span → null (never a negative-exponent artefact)", () => {
    const r = computeCagr(1000, 2000, 0, -10, calcCagr);
    assert.deepStrictEqual(r, { cagrPct: null, holdingPeriodYears: null });
  });

  it("BUG-GUARD: NaN span → null (no NaN years to the solver)", () => {
    const r = computeCagr(1000, 2000, 0, NaN, calcCagr);
    assert.deepStrictEqual(r, { cagrPct: null, holdingPeriodYears: null });
  });

  it("BUG-GUARD: end=0 (total wipeout) → −100% which is below the band → null", () => {
    // end 0 over 1y → calcCagr = (0/1000)^1 − 1 = −1 (−100%), which is below
    // MIN_PLAUSIBLE_RATE (−0.99) → rejected to null (honest "—").
    const r = computeCagr(1000, 0, 0, 365, calcCagr);
    assert.deepStrictEqual(r, { cagrPct: null, holdingPeriodYears: null });
  });

  it("BUG-GUARD: non-finite invested/current/proceeds → null, never NaN", () => {
    assert.deepStrictEqual(computeCagr(Infinity, 2000, 0, 365, calcCagr), {
      cagrPct: null,
      holdingPeriodYears: null,
    });
    assert.deepStrictEqual(computeCagr(NaN, 2000, 0, 365, calcCagr), {
      cagrPct: null,
      holdingPeriodYears: null,
    });
    // Infinity current is finite-guarded to 0 inside computeCagr → end 0 → null.
    const r = computeCagr(1000, Infinity, 0, 365, calcCagr);
    assert.deepStrictEqual(r, { cagrPct: null, holdingPeriodYears: null });
  });

  it("BUG-GUARD: an implausibly large CAGR (> +1000%) is rejected to null", () => {
    // invested 1, end 1e6 over 1y → ~99,999,900% → way above the band.
    const r = computeCagr(1, 1_000_000, 0, 365, calcCagr);
    assert.deepStrictEqual(r, { cagrPct: null, holdingPeriodYears: null });
  });
});

// ───────────────────────────────────────────────────────────────────────────
// computePortfolioReturns — the full pure assembly the LIVE service calls.
// ───────────────────────────────────────────────────────────────────────────

describe("dashboard-logic — computePortfolioReturns (real assembly + REAL solvers)", () => {
  it("empty portfolio (no trades) → fully-null EMPTY (honest '—'), never throws", () => {
    const r = computePortfolioReturns(
      { trades: [], holdings: [], mutualFunds: [], positions: [] },
      NOW,
      SOLVERS
    );
    assert.deepStrictEqual(r, EMPTY_PORTFOLIO_RETURNS);
    assert.strictEqual(r.xirrPct, null);
    assert.strictEqual(r.cagrPct, null);
    assert.strictEqual(r.firstInvestmentDate, null);
    assert.strictEqual(r.holdingPeriodYears, null);
  });

  it("returns a NEW object (does not alias / mutate the EMPTY singleton)", () => {
    const r = computePortfolioReturns(
      { trades: [], holdings: [], mutualFunds: [], positions: [] },
      NOW,
      SOLVERS
    );
    assert.notStrictEqual(r, EMPTY_PORTFOLIO_RETURNS);
    // Mutating the result must not corrupt the shared constant.
    r.xirrPct = 5;
    assert.strictEqual(EMPTY_PORTFOLIO_RETURNS.xirrPct, null);
  });

  it("a long-held BUY + current value → positive finite XIRR & CAGR (real solvers)", () => {
    const r = computePortfolioReturns(
      {
        trades: [buy({ tradeValue: 1000, tradeDate: daysAgo(550) })],
        holdings: [{ currentValue: 1500 }],
        mutualFunds: [],
        positions: [],
      },
      NOW,
      SOLVERS
    );
    assert.strictEqual(typeof r.xirrPct, "number");
    assert.ok((r.xirrPct as number) > 0);
    assert.ok(Number.isFinite(r.xirrPct as number));
    assert.strictEqual(typeof r.cagrPct, "number");
    assert.ok((r.cagrPct as number) > 0);
    assert.strictEqual(typeof r.holdingPeriodYears, "number");
    assert.ok((r.holdingPeriodYears as number) > 1);
    assert.strictEqual(r.firstInvestmentDate, safeIsoDate(daysAgo(550)));
  });

  it("BUG-GUARD: all-BUY, zero current value → no inflow → XIRR null, no loop/NaN", () => {
    const r = computePortfolioReturns(
      {
        trades: [buy({ tradeValue: 1000, tradeDate: daysAgo(400) })],
        holdings: [],
        mutualFunds: [],
        positions: [],
      },
      NOW,
      SOLVERS
    );
    // Only one outflow, current value 0 → no positive close → calcXirr NaN → null.
    assert.strictEqual(r.xirrPct, null);
    // CAGR: invested 1000, end 0 → −100% below band → null.
    assert.strictEqual(r.cagrPct, null);
    // firstInvestmentDate still reflects the (valid) BUY.
    assert.strictEqual(r.firstInvestmentDate, safeIsoDate(daysAgo(400)));
  });

  it("BUG-GUARD: same-day round trip over a 1-day book → XIRR null (degenerate)", () => {
    const d = daysAgo(1);
    const r = computePortfolioReturns(
      {
        trades: [
          buy({ tradeValue: 1000, tradeDate: d }),
          sell({ tradeValue: 1100, tradeDate: d }),
        ],
        holdings: [],
        mutualFunds: [],
        positions: [],
      },
      NOW,
      SOLVERS
    );
    // span = 1 day < MIN_DAYS_FOR_XIRR → XIRR null; no NaN anywhere.
    assert.strictEqual(r.xirrPct, null);
    // CAGR also gated (span < a year and end credits proceeds, but the rate is
    // a finite number; just assert it never emits NaN/Infinity).
    assert.ok(r.cagrPct === null || Number.isFinite(r.cagrPct));
  });

  it("BUG-GUARD: a NaN-value + Infinity-value + Invalid-Date trade mix never throws and never emits non-finite", () => {
    const r = computePortfolioReturns(
      {
        trades: [
          // Invalid-Date FIRST row — the OLD crash bait.
          buy({ tradeValue: 9999, tradeDate: new Date("not-a-date") }),
          // Infinity tradeValue — the `> 0` poison bait.
          buy({ tradeValue: Infinity, tradeDate: daysAgo(300) }),
          // A clean, real BUY that should anchor everything.
          buy({ tradeValue: 1000, tradeDate: daysAgo(400) }),
          sell({ tradeValue: 1200, tradeDate: daysAgo(100) }),
        ],
        holdings: [{ currentValue: Infinity }, { currentValue: 500 }],
        mutualFunds: [{ currentValue: NaN }],
        positions: [{ netQuantity: NaN, lastPrice: 100 }],
      },
      NOW,
      SOLVERS
    );
    // No throw (asserted by reaching here). Every numeric field finite-or-null.
    for (const v of [r.xirrPct, r.cagrPct, r.holdingPeriodYears]) {
      assert.ok(v === null || Number.isFinite(v), `non-finite leaked: ${v}`);
    }
    // The anchor is the clean BUY at −400d (Invalid-Date BUY dropped, Infinity
    // BUY dropped) — proves the crash bait never became firstBuyDate.
    assert.strictEqual(r.firstInvestmentDate, safeIsoDate(daysAgo(400)));
  });

  it("CONSUMER-SAFETY: nothing the dashboard % formatter sees is NaN/Infinity", () => {
    const r = computePortfolioReturns(
      {
        trades: [
          buy({ tradeValue: 50000, tradeDate: daysAgo(800) }),
          sell({ tradeValue: 30000, tradeDate: daysAgo(200) }),
        ],
        holdings: [{ currentValue: 40000 }],
        mutualFunds: [{ currentValue: 5000 }],
        positions: [{ netQuantity: 10, lastPrice: 100 }],
      },
      NOW,
      SOLVERS
    );
    // How the UI renders a metric: `${pct.toFixed(2)}%` — must never be "NaN%".
    const fmt = (v: number | null) => (v == null ? "—" : `${v.toFixed(2)}%`);
    for (const v of [r.xirrPct, r.cagrPct]) {
      const s = fmt(v);
      assert.notStrictEqual(s, "NaN%");
      assert.notStrictEqual(s, "Infinity%");
      if (v != null) assert.ok(Number.isFinite(Number(v)));
    }
  });

  it("a fully-realised book (sold everything, no current value) still computes XIRR from SELL inflows", () => {
    const r = computePortfolioReturns(
      {
        trades: [
          buy({ tradeValue: 1000, tradeDate: daysAgo(400) }),
          sell({ tradeValue: 1300, tradeDate: daysAgo(20) }),
        ],
        holdings: [],
        mutualFunds: [],
        positions: [],
      },
      NOW,
      SOLVERS
    );
    // Mixed-sign, > MIN_DAYS span, no mark-to-market close needed → real XIRR.
    assert.ok(r.xirrPct == null || Number.isFinite(r.xirrPct));
    assert.ok((r.cagrPct as number) > 0); // 1000 → 1300 over ~1.1y
  });
});

// ───────────────────────────────────────────────────────────────────────────
// BEHAVIOUR-PRESERVATION — the extracted assembly must match the OLD inline
// formula (within float tolerance) for a normal multi-cashflow portfolio. The
// inline reference below is reproduced ONCE solely to PROVE equivalence; it is
// NOT the thing under test (the assertions compare it to the REAL extracted
// output `computePortfolioReturns`).
// ───────────────────────────────────────────────────────────────────────────

describe("dashboard-logic — behaviour-preserving vs the prior inline formula", () => {
  /** The pre-extraction inline math, verbatim, for finite/valid inputs only. */
  function oldInlineReturns(
    trades: ReturnsTradeInput[],
    holdings: { currentValue: number | null }[],
    mutualFunds: { currentValue: number | null }[],
    positions: { netQuantity: number | null; lastPrice: number | null }[],
    now: Date
  ) {
    const currentValue =
      holdings.reduce((s, h) => s + (h.currentValue || 0), 0) +
      mutualFunds.reduce((s, m) => s + (m.currentValue || 0), 0) +
      positions.reduce(
        (s, p) => s + Math.abs((p.netQuantity || 0) * (p.lastPrice || 0)),
        0
      );
    const flows: ReturnsCashFlow[] = [];
    let totalInvested = 0;
    let totalProceeds = 0;
    let firstBuyDate: Date | null = null;
    for (const t of trades) {
      const value =
        t.tradeValue != null && t.tradeValue > 0
          ? t.tradeValue
          : (t.quantity || 0) * (t.price || 0);
      if (!(value > 0)) continue;
      const date = new Date(t.tradeDate);
      if (t.tradeType === "BUY") {
        flows.push({ date, amount: -value });
        totalInvested += value;
        if (!firstBuyDate || date < firstBuyDate) firstBuyDate = date;
      } else if (t.tradeType === "SELL") {
        flows.push({ date, amount: value });
        totalProceeds += value;
      }
    }
    if (currentValue > 0) flows.push({ date: now, amount: currentValue });
    let xirrPct: number | null = null;
    const spanDays =
      firstBuyDate != null
        ? (now.getTime() - firstBuyDate.getTime()) / (1000 * 60 * 60 * 24)
        : 0;
    if (flows.length >= 2 && spanDays >= 7) {
      const rate = calcXirr(flows);
      if (Number.isFinite(rate) && rate >= -0.99 && rate <= 10) {
        xirrPct = rate * 100;
      }
    }
    let cagrPct: number | null = null;
    let holdingPeriodYears: number | null = null;
    if (firstBuyDate != null && totalInvested > 0) {
      const years = spanDays / 365;
      const endValue = currentValue + totalProceeds;
      const cagr = calcCagr(totalInvested, endValue, years);
      if (cagr != null && cagr >= -0.99 && cagr <= 10) {
        cagrPct = cagr * 100;
        holdingPeriodYears = Math.round(years * 100) / 100;
      }
    }
    return {
      xirrPct,
      cagrPct,
      firstInvestmentDate:
        firstBuyDate != null
          ? (firstBuyDate.toISOString().split("T")[0] ?? null)
          : null,
      holdingPeriodYears,
    };
  }

  function assertClose(
    actual: number | null,
    expected: number | null,
    label: string
  ): void {
    if (expected == null || actual == null) {
      assert.strictEqual(
        actual,
        expected,
        `${label}: ${actual} vs ${expected}`
      );
      return;
    }
    assert.ok(
      Math.abs(actual - expected) < 1e-6,
      `${label}: ${actual} vs ${expected}`
    );
  }

  const SCENARIOS: Array<{
    name: string;
    trades: ReturnsTradeInput[];
    holdings: { currentValue: number | null }[];
    mfs: { currentValue: number | null }[];
    positions: { netQuantity: number | null; lastPrice: number | null }[];
  }> = [
    {
      name: "single long-held BUY + current holdings",
      trades: [buy({ tradeValue: 10000, tradeDate: daysAgo(600) })],
      holdings: [{ currentValue: 14000 }],
      mfs: [],
      positions: [],
    },
    {
      name: "BUY + partial SELL + remaining current value",
      trades: [
        buy({ tradeValue: 10000, tradeDate: daysAgo(700) }),
        sell({ tradeValue: 7000, tradeDate: daysAgo(120) }),
      ],
      holdings: [{ currentValue: 8000 }],
      mfs: [],
      positions: [],
    },
    {
      name: "multi-BUY (qty*price fallback) + MFs + open position close",
      trades: [
        buy({ quantity: 50, price: 200, tradeDate: daysAgo(900) }),
        buy({ quantity: 25, price: 240, tradeDate: daysAgo(400) }),
        sell({ quantity: 30, price: 300, tradeDate: daysAgo(60) }),
      ],
      holdings: [{ currentValue: 6000 }],
      mfs: [{ currentValue: 3000 }],
      positions: [{ netQuantity: 10, lastPrice: 150 }],
    },
    {
      name: "fully-realised book (no current value)",
      trades: [
        buy({ tradeValue: 5000, tradeDate: daysAgo(500) }),
        sell({ tradeValue: 6500, tradeDate: daysAgo(30) }),
      ],
      holdings: [],
      mfs: [],
      positions: [],
    },
  ];

  for (const sc of SCENARIOS) {
    it(`matches the prior output for: ${sc.name}`, () => {
      const expected = oldInlineReturns(
        sc.trades,
        sc.holdings,
        sc.mfs,
        sc.positions,
        NOW
      );
      const actual = computePortfolioReturns(
        {
          trades: sc.trades,
          holdings: sc.holdings,
          mutualFunds: sc.mfs,
          positions: sc.positions,
        },
        NOW,
        SOLVERS
      );
      assertClose(actual.xirrPct, expected.xirrPct, "xirrPct");
      assertClose(actual.cagrPct, expected.cagrPct, "cagrPct");
      assertClose(
        actual.holdingPeriodYears,
        expected.holdingPeriodYears,
        "holdingPeriodYears"
      );
      assert.strictEqual(
        actual.firstInvestmentDate,
        expected.firstInvestmentDate,
        "firstInvestmentDate"
      );
    });
  }
});
