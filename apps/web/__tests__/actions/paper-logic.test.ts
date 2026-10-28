/**
 * MONEY-620 — Paper-trading pure-logic unit tests (REAL exported helpers).
 *
 * EXERCISES THE REAL SOURCE: imports the pure, finite-guarded helpers from
 * `packages/services/src/paper-logic.ts` — exactly the math the paper-trading
 * service (`packages/services/src/paper.service.ts`, the user-facing paper money
 * path: `apps/web/lib/actions/paper.ts` + `apps/api/src/routes/v1/paper.ts`) now
 * calls. NO inline reimplementation of P&L / current-value / % / portfolio
 * math; every assertion drives the shipped export (no shadow).
 *
 * This REPLACES the four pre-existing paper SHADOW suites
 * (`actions/paper.test.ts`, `actions/paper-trading.test.ts`,
 * `db/paper-fire-mf.test.ts` paper section, `security/paper-delete-idor.test.ts`)
 * that re-declared the math inline and asserted the copy — green while the real
 * service could render "₹NaN", persist Infinity, or 500 on an Invalid Date.
 *
 * The `paper-logic` module is Prisma-free, so importing it never opens a DB
 * connection — this suite stays pure and exits cleanly (no orphan). It is
 * imported by RELATIVE path (the worker-test convention) since the
 * `@usemoney/services` barrel pulls Prisma/Redis at load.
 *
 * Bug classes pinned here (each fixture is the exact failing input the
 * finite-guard fix closes — a regression that drops a guard turns these RED):
 *   - non-finite POISON: NaN/±Infinity entryPrice/ltp/exitPrice/quantity must
 *     contribute 0 / a finite value, never NaN/Infinity, to any P&L, current
 *     value, % return, or the paper portfolio total.
 *   - %-return division-by-zero / non-finite cost basis → clamp to 0 (never
 *     Infinity slipping past the `> 0` gate).
 *   - realized P&L on close stays finite for a corrupt exit/avg/qty (it is both
 *     PERSISTED and fed to `.toLocaleString()` in the success toast).
 *   - createPaperTrade normalization neutralises a NaN/Infinity that slips past
 *     a missing Zod gate (apps/api raw JSON) before it persists.
 *   - Invalid-Date entry/exit/expiry → safeToIso/safeDate return undefined,
 *     never throw on `.toISOString()`.
 *   - consumer-safety: nothing the helpers emit is NaN/Infinity at a `.toFixed`.
 *
 * Source: packages/services/src/paper-logic.ts
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  finite,
  safeToIso,
  safeDate,
  pnlPercentage,
  currentValue,
  investedValue,
  unrealizedPnL,
  markToMarket,
  realizedPnL,
  normalizeCreateValues,
  summarizePaperPortfolio,
  type PaperSummaryInput,
} from "../../../../packages/services/src/paper-logic";

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

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

function summaryRow(
  overrides: Partial<PaperSummaryInput> = {}
): PaperSummaryInput {
  return {
    status: "OPEN",
    investedValue: 25000,
    currentValue: 26000,
    ...overrides,
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// finite()
// ═══════════════════════════════════════════════════════════════════════════

describe("MONEY-620 paper-logic — finite()", () => {
  it("passes through ordinary finite numbers (incl. 0 and negatives)", () => {
    assert.strictEqual(finite(26000), 26000);
    assert.strictEqual(finite(0), 0);
    assert.strictEqual(finite(-1234.5), -1234.5);
  });

  it("collapses null / undefined / NaN / ±Infinity to the fallback (default 0)", () => {
    assert.strictEqual(finite(null), 0);
    assert.strictEqual(finite(undefined), 0);
    assert.strictEqual(finite(NaN), 0);
    assert.strictEqual(finite(Infinity), 0);
    assert.strictEqual(finite(-Infinity), 0);
  });

  it("honours a custom fallback and never replaces a real 0", () => {
    assert.strictEqual(finite(NaN, -1), -1);
    assert.strictEqual(finite(0, 99), 0);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// safeToIso() / safeDate() — Invalid-Date guards
// ═══════════════════════════════════════════════════════════════════════════

describe("MONEY-620 paper-logic — safeToIso()", () => {
  it("formats a valid Date as a full ISO string", () => {
    assert.strictEqual(
      safeToIso(new Date("2026-01-02T10:30:00.000Z")),
      "2026-01-02T10:30:00.000Z"
    );
  });

  it("returns undefined (never throws) for an Invalid Date — the .toISOString() RangeError bait", () => {
    const bad = new Date("not-a-real-date");
    assert.ok(Number.isNaN(bad.getTime()), "fixture is an Invalid Date");
    let out: string | undefined;
    assert.doesNotThrow(() => {
      out = safeToIso(bad);
    });
    assert.strictEqual(out, undefined);
  });

  it("returns undefined for null / undefined / NaN epoch", () => {
    assert.strictEqual(safeToIso(null), undefined);
    assert.strictEqual(safeToIso(undefined), undefined);
    assert.strictEqual(safeToIso(new Date(NaN)), undefined);
    assert.strictEqual(safeToIso(NaN), undefined);
  });

  it("parses a string / epoch number without throwing", () => {
    assert.strictEqual(
      safeToIso("2026-03-15T00:00:00.000Z"),
      "2026-03-15T00:00:00.000Z"
    );
    assert.strictEqual(safeToIso("garbage"), undefined);
  });
});

describe("MONEY-620 paper-logic — safeDate()", () => {
  it("returns a valid Date unchanged", () => {
    const d = new Date("2026-01-02T00:00:00.000Z");
    assert.strictEqual(safeDate(d)?.getTime(), d.getTime());
  });

  it("returns undefined for an Invalid Date string (would-be persisted Invalid Date)", () => {
    assert.strictEqual(safeDate("not-a-date"), undefined);
    assert.strictEqual(safeDate(new Date("nope")), undefined);
  });

  it("returns undefined for null / undefined", () => {
    assert.strictEqual(safeDate(null), undefined);
    assert.strictEqual(safeDate(undefined), undefined);
  });

  it("parses a valid date string into a Date", () => {
    assert.strictEqual(
      safeDate("2026-05-30T00:00:00.000Z")?.toISOString(),
      "2026-05-30T00:00:00.000Z"
    );
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// pnlPercentage()
// ═══════════════════════════════════════════════════════════════════════════

describe("MONEY-620 paper-logic — pnlPercentage()", () => {
  it("computes a positive / negative percentage (behaviour-preserving)", () => {
    assert.strictEqual(pnlPercentage(1000, 25000), 4);
    assert.strictEqual(pnlPercentage(-1000, 25000), -4);
    assert.strictEqual(pnlPercentage(25000, 25000), 100);
  });

  it("returns 0 when invested is 0 (div-by-zero clamp)", () => {
    assert.strictEqual(pnlPercentage(100, 0), 0);
    assert.strictEqual(pnlPercentage(0, 25000), 0);
  });

  it("returns 0 when invested is negative", () => {
    assert.strictEqual(pnlPercentage(500, -1000), 0);
  });

  it("returns 0 when invested is non-finite — Infinity must NOT pass the `> 0` gate", () => {
    // The exact leak: `Infinity > 0` is true, so the old gate divided by Infinity.
    assert.strictEqual(pnlPercentage(500, Infinity), 0);
    assert.strictEqual(pnlPercentage(500, NaN), 0);
  });

  it("returns 0 when the P&L itself is non-finite (finite invested, Infinity pnl)", () => {
    assert.strictEqual(pnlPercentage(Infinity, 25000), 0);
    assert.strictEqual(pnlPercentage(NaN, 25000), 0);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// currentValue() / investedValue() / unrealizedPnL()
// ═══════════════════════════════════════════════════════════════════════════

describe("MONEY-620 paper-logic — currentValue() = price * qty", () => {
  it("computes the notional and handles zero price / zero qty", () => {
    assert.strictEqual(currentValue(2600, 10), 26000);
    assert.strictEqual(currentValue(0, 10), 0);
    assert.strictEqual(currentValue(2600, 0), 0);
  });

  it("fractional price/qty", () => {
    assert.ok(Math.abs(currentValue(100.5, 10) - 1005) < 1e-9);
    assert.strictEqual(currentValue(1100, 10.5), 11550);
  });

  it("POISON: NaN/Infinity price or qty → 0, never NaN/Infinity", () => {
    assert.strictEqual(currentValue(NaN, 10), 0);
    assert.strictEqual(currentValue(2600, NaN), 0);
    assert.strictEqual(currentValue(Infinity, 10), 0);
    assert.strictEqual(currentValue(2600, Infinity), 0);
    assert.strictEqual(currentValue(Infinity, Infinity), 0);
  });

  it("very large finite product stays finite (no overflow to Infinity in fixture range)", () => {
    assert.strictEqual(currentValue(1e6, 1e6), 1e12);
    assert.ok(Number.isFinite(currentValue(1e6, 1e6)));
  });
});

describe("MONEY-620 paper-logic — investedValue() = avg * qty", () => {
  it("computes cost basis (behaviour-preserving with the service)", () => {
    assert.strictEqual(investedValue(2500, 10), 25000);
  });

  it("POISON: NaN avg / Infinity qty → 0", () => {
    assert.strictEqual(investedValue(NaN, 10), 0);
    assert.strictEqual(investedValue(2500, Infinity), 0);
  });
});

describe("MONEY-620 paper-logic — unrealizedPnL() (LONG / SHORT)", () => {
  it("LONG = currentValue - investedValue", () => {
    assert.strictEqual(unrealizedPnL("LONG", 26000, 25000), 1000);
    assert.strictEqual(unrealizedPnL("LONG", 24000, 25000), -1000);
    assert.strictEqual(unrealizedPnL("LONG", 25000, 25000), 0);
  });

  it("SHORT = investedValue - currentValue (any non-LONG type takes the short branch)", () => {
    assert.strictEqual(unrealizedPnL("SHORT", 24000, 25000), 1000);
    assert.strictEqual(unrealizedPnL("SHORT", 26000, 25000), -1000);
  });

  it("POISON: NaN/Infinity current or invested → finite, never NaN", () => {
    assert.ok(Number.isFinite(unrealizedPnL("LONG", NaN, 25000)));
    assert.strictEqual(unrealizedPnL("LONG", NaN, 25000), -25000); // 0 - 25000
    assert.strictEqual(unrealizedPnL("LONG", 26000, Infinity), 26000); // 26000 - 0
    assert.strictEqual(unrealizedPnL("SHORT", Infinity, 25000), 25000); // 25000 - 0
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// markToMarket() — the persisted price-update bundle
// ═══════════════════════════════════════════════════════════════════════════

describe("MONEY-620 paper-logic — markToMarket()", () => {
  it("LONG price increase: currentValue/unrealizedPnL/% all correct", () => {
    const m = markToMarket("LONG", 120, 10, 1000);
    assert.strictEqual(m.currentValue, 1200);
    assert.strictEqual(m.unrealizedPnL, 200);
    assert.strictEqual(m.pnlPercentage, 20);
  });

  it("LONG price decrease (loss)", () => {
    const m = markToMarket("LONG", 80, 10, 1000);
    assert.strictEqual(m.currentValue, 800);
    assert.strictEqual(m.unrealizedPnL, -200);
    assert.strictEqual(m.pnlPercentage, -20);
  });

  it("SHORT price decrease (profit) / increase (loss)", () => {
    const profit = markToMarket("SHORT", 80, 10, 1000);
    assert.strictEqual(profit.unrealizedPnL, 200);
    assert.strictEqual(profit.pnlPercentage, 20);
    const loss = markToMarket("SHORT", 120, 10, 1000);
    assert.strictEqual(loss.unrealizedPnL, -200);
    assert.strictEqual(loss.pnlPercentage, -20);
  });

  it("POISON: non-finite price → fully finite bundle, % clamps to a finite number", () => {
    const m = markToMarket("LONG", Infinity, 10, 1000);
    assertAllFinite(
      [m.currentValue, m.unrealizedPnL, m.pnlPercentage],
      "Infinity price MTM"
    );
    // currentValue → 0, pnl = 0 - 1000 = -1000, % = -1000/1000*100 = -100
    assert.strictEqual(m.currentValue, 0);
    assert.strictEqual(m.unrealizedPnL, -1000);
    assert.strictEqual(m.pnlPercentage, -100);
  });

  it("zero / non-finite cost basis → % is 0, never Infinity (the `> 0` leak)", () => {
    const zero = markToMarket("LONG", 120, 10, 0);
    assert.strictEqual(zero.pnlPercentage, 0);
    const inf = markToMarket("LONG", 120, 10, Infinity);
    assert.strictEqual(inf.pnlPercentage, 0);
    assert.ok(Number.isFinite(inf.pnlPercentage));
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// realizedPnL() — close
// ═══════════════════════════════════════════════════════════════════════════

describe("MONEY-620 paper-logic — realizedPnL() (close)", () => {
  it("LONG profit / loss / breakeven (behaviour-preserving)", () => {
    assert.strictEqual(realizedPnL("LONG", 110, 100, 10), 100);
    assert.strictEqual(realizedPnL("LONG", 90, 100, 10), -100);
    assert.strictEqual(realizedPnL("LONG", 100, 100, 10), 0);
  });

  it("SHORT profit / loss / breakeven", () => {
    assert.strictEqual(realizedPnL("SHORT", 90, 100, 10), 100);
    assert.strictEqual(realizedPnL("SHORT", 110, 100, 10), -100);
    assert.strictEqual(realizedPnL("SHORT", 100, 100, 10), 0);
  });

  it("large quantity / fractional prices stay exact-ish & finite", () => {
    assert.strictEqual(realizedPnL("LONG", 2600, 2500, 100), 10000);
    assert.ok(Math.abs(realizedPnL("LONG", 100.75, 100.25, 100) - 50) < 1e-9);
  });

  it("exit-before-entry is a legitimate LOSS, not an error (finite negative)", () => {
    // Closing a LONG below cost: a real loss, must be preserved (finite).
    assert.strictEqual(realizedPnL("LONG", 50, 100, 10), -500);
  });

  it("zero quantity → 0 P&L (finite, not NaN)", () => {
    assert.strictEqual(realizedPnL("LONG", 150, 100, 0), 0);
    assert.strictEqual(realizedPnL("SHORT", 50, 100, 0), 0);
  });

  it("negative quantity stays finite (corrupt/oversold row does not NaN)", () => {
    // (110-100) * -5 = -50 — finite; the guard's job is finiteness, not sign.
    assert.strictEqual(realizedPnL("LONG", 110, 100, -5), -50);
    assert.ok(Number.isFinite(realizedPnL("LONG", 110, 100, -5)));
  });

  it("POISON: NaN/Infinity exitPrice / averagePrice / quantity → FINITE, never NaN/Infinity (persisted + toLocaleString safe)", () => {
    // exit NaN → finite(NaN)=0 → (0-100)*10 = -1000: finite (the guard's job is
    // finiteness, not magnitude — a corrupt input yields a finite number, never NaN).
    assert.strictEqual(realizedPnL("LONG", NaN, 100, 10), -1000);
    assert.ok(Number.isFinite(realizedPnL("LONG", NaN, 100, 10)));
    assert.ok(Number.isFinite(realizedPnL("LONG", 110, NaN, 10)));
    assert.ok(Number.isFinite(realizedPnL("LONG", 110, 100, NaN)));
    assert.ok(Number.isFinite(realizedPnL("LONG", Infinity, 100, 10)));
    assert.ok(Number.isFinite(realizedPnL("SHORT", 100, Infinity, 10)));
    assert.ok(Number.isFinite(realizedPnL("LONG", 110, 100, Infinity)));
    // Each result is .toLocaleString()-safe (the web action does this).
    for (const v of [
      realizedPnL("LONG", Infinity, 100, 10),
      realizedPnL("LONG", 110, 100, Infinity),
      realizedPnL("LONG", NaN, NaN, NaN),
    ]) {
      assert.notStrictEqual(v.toLocaleString("en-IN"), "∞");
      assert.notStrictEqual(v.toLocaleString("en-IN"), "NaN");
      assert.ok(Number.isFinite(v));
    }
  });

  it("Infinity * 0 indeterminate form is neutralised to 0 (not NaN)", () => {
    // finite(Infinity)=0 FIRST, so the product is 0 — never Infinity*0 = NaN.
    // (Result may be signed -0, which is mathematically 0 and renders as "0".)
    const a = realizedPnL("LONG", Infinity, 100, 0); // (0-100)*0 = -0
    const b = realizedPnL("LONG", 100, 100, Infinity); // (100-100)*0 = 0
    assert.ok(Object.is(a, 0) || Object.is(a, -0));
    assert.ok(Object.is(b, 0) || Object.is(b, -0));
    assert.ok(Number.isFinite(a) && Number.isFinite(b));
    assert.strictEqual(a.toFixed(2), "0.00");
    assert.strictEqual((0 + a).toLocaleString("en-IN"), "0"); // +0 normalises -0
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// normalizeCreateValues() — guard the PERSISTED create write
// ═══════════════════════════════════════════════════════════════════════════

describe("MONEY-620 paper-logic — normalizeCreateValues()", () => {
  it("passes clean values through and applies the service defaults", () => {
    const v = normalizeCreateValues({
      quantity: 10,
      averagePrice: 2500,
      investedValue: 25000,
    });
    assert.strictEqual(v.quantity, 10);
    assert.strictEqual(v.averagePrice, 2500);
    assert.strictEqual(v.investedValue, 25000);
    // currentPrice defaults to averagePrice; currentValue to investedValue.
    assert.strictEqual(v.currentPrice, 2500);
    assert.strictEqual(v.currentValue, 25000);
    assert.strictEqual(v.unrealizedPnL, 0);
    assert.strictEqual(v.pnlPercentage, 0);
  });

  it("respects explicitly provided current price/value/pnl/%", () => {
    const v = normalizeCreateValues({
      quantity: 10,
      averagePrice: 2500,
      investedValue: 25000,
      currentPrice: 2600,
      currentValue: 26000,
      unrealizedPnL: 1000,
      pnlPercentage: 4,
    });
    assert.strictEqual(v.currentPrice, 2600);
    assert.strictEqual(v.currentValue, 26000);
    assert.strictEqual(v.unrealizedPnL, 1000);
    assert.strictEqual(v.pnlPercentage, 4);
  });

  it("POISON (no Zod gate / apps/api raw JSON): NaN/Infinity fields all collapse to finite, never persisted as NaN/Infinity", () => {
    const v = normalizeCreateValues({
      quantity: NaN,
      averagePrice: Infinity,
      investedValue: NaN,
      currentPrice: Infinity,
      currentValue: -Infinity,
      unrealizedPnL: NaN,
      pnlPercentage: Infinity,
    });
    assertAllFinite(
      [
        v.quantity,
        v.averagePrice,
        v.investedValue,
        v.currentPrice,
        v.currentValue,
        v.unrealizedPnL,
        v.pnlPercentage,
      ],
      "poisoned create input"
    );
    assert.strictEqual(v.quantity, 0);
    assert.strictEqual(v.averagePrice, 0);
    assert.strictEqual(v.investedValue, 0);
    // currentPrice falls back to (guarded) averagePrice = 0; currentValue to invested = 0.
    assert.strictEqual(v.currentPrice, 0);
    assert.strictEqual(v.currentValue, 0);
  });

  it("currentPrice falls back to averagePrice when currentPrice is missing/0/NaN (guarded)", () => {
    const v = normalizeCreateValues({
      quantity: 10,
      averagePrice: 2500,
      investedValue: 25000,
      currentPrice: NaN,
    });
    assert.strictEqual(v.currentPrice, 2500); // NaN → falls back to averagePrice
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// summarizePaperPortfolio()
// ═══════════════════════════════════════════════════════════════════════════

describe("MONEY-620 paper-logic — summarizePaperPortfolio()", () => {
  it("sums ONLY open positions; closed rows are counted but excluded from totals", () => {
    const s = summarizePaperPortfolio([
      summaryRow({ status: "OPEN", investedValue: 25000, currentValue: 26000 }),
      summaryRow({ status: "OPEN", investedValue: 50000, currentValue: 52000 }),
      summaryRow({
        status: "CLOSED",
        investedValue: 10000,
        currentValue: 11000,
      }),
    ]);
    assert.strictEqual(s.totalInvested, 75000);
    assert.strictEqual(s.totalCurrent, 78000);
    assert.strictEqual(s.totalPnL, 3000);
    assert.strictEqual(s.pnlPercentage, 4);
    assert.strictEqual(s.openPositions, 2);
    assert.strictEqual(s.closedPositions, 1);
  });

  it("a closed-only portfolio → zeroed totals, % 0", () => {
    const s = summarizePaperPortfolio([
      summaryRow({
        status: "CLOSED",
        investedValue: 100000,
        currentValue: 120000,
      }),
    ]);
    assert.strictEqual(s.totalInvested, 0);
    assert.strictEqual(s.totalCurrent, 0);
    assert.strictEqual(s.totalPnL, 0);
    assert.strictEqual(s.pnlPercentage, 0);
    assert.strictEqual(s.openPositions, 0);
    assert.strictEqual(s.closedPositions, 1);
  });

  it("empty portfolio → fully zeroed", () => {
    const s = summarizePaperPortfolio([]);
    assert.deepStrictEqual(s, {
      totalInvested: 0,
      totalCurrent: 0,
      totalPnL: 0,
      pnlPercentage: 0,
      openPositions: 0,
      closedPositions: 0,
    });
  });

  it("negative total P&L yields a negative percentage", () => {
    const s = summarizePaperPortfolio([
      summaryRow({ status: "OPEN", investedValue: 50000, currentValue: 45000 }),
    ]);
    assert.strictEqual(s.totalPnL, -5000);
    assert.strictEqual(s.pnlPercentage, -10);
  });

  it("POISON: ONE NaN/Infinity OPEN row does NOT make any total NaN/Infinity", () => {
    const s = summarizePaperPortfolio([
      summaryRow({ status: "OPEN", investedValue: 25000, currentValue: 26000 }),
      // corrupt open row: each field a different poison
      summaryRow({
        status: "OPEN",
        investedValue: Infinity,
        currentValue: NaN,
      }),
    ]);
    // the bad row contributes 0 to both totals
    assert.strictEqual(s.totalInvested, 25000);
    assert.strictEqual(s.totalCurrent, 26000);
    assert.strictEqual(s.totalPnL, 1000);
    assertAllFinite(
      [s.totalInvested, s.totalCurrent, s.totalPnL, s.pnlPercentage],
      "poisoned paper summary"
    );
    assert.strictEqual(s.openPositions, 2);
  });

  it("totalPnL is derived from finite totals → never Infinity - Infinity = NaN", () => {
    const s = summarizePaperPortfolio([
      summaryRow({
        status: "OPEN",
        investedValue: Infinity,
        currentValue: Infinity,
      }),
    ]);
    // both poisoned → totals 0, pnl 0 (NOT NaN from Infinity - Infinity)
    assert.strictEqual(s.totalInvested, 0);
    assert.strictEqual(s.totalCurrent, 0);
    assert.strictEqual(s.totalPnL, 0);
    assert.ok(Number.isFinite(s.totalPnL));
  });

  it("% stays 0 when every open row's invested is poisoned (no finite divisor)", () => {
    const s = summarizePaperPortfolio([
      summaryRow({ status: "OPEN", investedValue: NaN, currentValue: 1 }),
      summaryRow({ status: "OPEN", investedValue: Infinity, currentValue: 1 }),
    ]);
    assert.strictEqual(s.totalInvested, 0);
    assert.strictEqual(s.pnlPercentage, 0);
  });

  it("an unknown status (neither OPEN nor CLOSED) is ignored by both totals and counts", () => {
    const s = summarizePaperPortfolio([
      summaryRow({ status: "OPEN", investedValue: 1000, currentValue: 1100 }),
      summaryRow({
        status: "PENDING",
        investedValue: 999999,
        currentValue: 999999,
      }),
    ]);
    assert.strictEqual(s.totalInvested, 1000);
    assert.strictEqual(s.openPositions, 1);
    assert.strictEqual(s.closedPositions, 0);
  });

  it("very large finite open book stays finite (no overflow to Infinity)", () => {
    const big = summaryRow({
      status: "OPEN",
      investedValue: 1e14,
      currentValue: 1.1e14,
    });
    const s = summarizePaperPortfolio([big, big, big]);
    assert.ok(Number.isFinite(s.totalCurrent));
    assert.strictEqual(s.totalInvested, 3e14);
  });
});
