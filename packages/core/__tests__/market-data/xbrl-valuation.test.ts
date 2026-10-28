/**
 * `xbrl-valuation` — the leg that leaves the filing (MONEY-1115).
 *
 * These are contract tests, not fixture tests: the module takes already-joined
 * numbers, so a captured XBRL document would prove nothing about it. The
 * fixture-backed part (that `paidUpEquityShareCapital` and `faceValuePerShare`
 * are actually present) is exercised in `xbrl-projection.test.ts` against real
 * filings; here the question is what happens at the boundaries.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  deriveShareCount,
  deriveValuation,
  ttmDividendPerShare,
} from "../../src/market-data/xbrl-valuation";
import type { XbrlFinancials } from "../../src/market-data/xbrl-financials-logic";

/** Minimal XbrlFinancials carrying only the values these functions read. */
function filing(values: Record<string, number>): XbrlFinancials {
  return { values } as unknown as XbrlFinancials;
}

describe("deriveShareCount", () => {
  it("prefers the reported paid-up route", () => {
    const r = deriveShareCount(
      filing({ paidUpEquityShareCapital: 1000, faceValuePerShare: 10 }),
    );
    assert.deepEqual(r, { shares: 100, basis: "paid-up" });
  });

  it("falls back to EPS-implied and SAYS SO", () => {
    const r = deriveShareCount(filing({ profitForPeriod: 500, basicEps: 5 }));
    assert.ok(r);
    assert.equal(r.shares, 100);
    assert.equal(
      r.basis,
      "eps-implied",
      "the basis must be recorded — an eps-implied count uses a weighted " +
        "average and genuinely disagrees with the paid-up count",
    );
  });

  it("a loss still yields a POSITIVE implied count", () => {
    // Negative profit over negative EPS. The count is positive; a naive guard
    // on the numerator would reject a perfectly good derivation.
    const r = deriveShareCount(filing({ profitForPeriod: -500, basicEps: -5 }));
    assert.equal(r?.shares, 100);
  });

  it("refuses a zero or negative face value rather than returning Infinity", () => {
    assert.equal(
      deriveShareCount(
        filing({ paidUpEquityShareCapital: 1000, faceValuePerShare: 0 }),
      ),
      null,
    );
    assert.equal(
      deriveShareCount(
        filing({ paidUpEquityShareCapital: 1000, faceValuePerShare: -10 }),
      ),
      null,
    );
  });

  it("refuses zero EPS (division by zero) rather than Infinity", () => {
    assert.equal(
      deriveShareCount(filing({ profitForPeriod: 500, basicEps: 0 })),
      null,
    );
  });

  it("returns null when neither route is available", () => {
    assert.equal(deriveShareCount(filing({})), null);
  });
});

describe("deriveValuation — refusals are the point", () => {
  const base = { price: 100, shares: 1000 };

  it("market cap is in ₹ CRORE — the destination column's unit", () => {
    // price 100 x 1,000 shares = ₹100,000 = 0.01 crore.
    //
    // This previously asserted 100_000 and thereby PINNED a 1e7 overstatement.
    // `StockRatios.marketCap` is crore — per `screener.ts`'s
    // `marketCap: number | null; // crores`, `scan-filters.ts`, and
    // `formatMarketCapCrores(valueInCrores)`; prod values run 4.8 → 1.87e6.
    // Unconverted rupees still SORT correctly (the transform is monotone), so
    // every absolute threshold would silently include or exclude everything
    // while the ordering looked perfect.
    const v = deriveValuation({ ...base, ttmEps: 5, ttmDividendPerShare: 2 });
    assert.equal(v.marketCap, 0.01);
    assert.equal(v.pe, 20, "a ratio is scale-free and unaffected");
    assert.equal(v.dividendYield, 2, "in PERCENT, matching StockRatios");
  });

  it("REFUSES P/E for a loss-maker instead of returning a negative", () => {
    const v = deriveValuation({ ...base, ttmEps: -5 });
    assert.equal(
      v.pe,
      undefined,
      "a negative P/E sorts above every cheap profitable company on an " +
        "ascending screen — absent is the honest answer",
    );
  });

  it("REFUSES P/B on negative equity", () => {
    const v = deriveValuation({ ...base, totalEquity: -50_000 });
    assert.equal(v.pb, undefined);
  });

  it("computes P/B from book value per share", () => {
    // equity 50,000 / 1,000 shares = 50 book/share; price 100 -> P/B 2
    const v = deriveValuation({ ...base, totalEquity: 50_000 });
    assert.equal(v.pb, 2);
  });

  it("enterprise value may be negative, but EV/EBITDA refuses it", () => {
    // net cash exceeds market cap: a real state.
    const v = deriveValuation({
      ...base,
      totalCash: 500_000,
      totalDebt: 0,
      ttmEbitda: 10_000,
    });
    assert.ok(v.enterpriseValue !== undefined && v.enterpriseValue < 0);
    assert.equal(
      v.evToEbitda,
      undefined,
      "a negative EV over positive EBITDA sorts as 'cheapest' and means the opposite",
    );
  });

  it("no debt AND no cash yields NO enterprise value, not EV == market cap", () => {
    const v = deriveValuation({ ...base, ttmEbitda: 10_000 });
    assert.equal(v.enterpriseValue, undefined);
    assert.equal(v.evToEbitda, undefined);
  });

  it("one side present is enough; the other contributes zero", () => {
    // EV = 100,000 + 20,000 = ₹120,000 = 0.012 crore. The RATIO is computed in
    // rupees on both sides — EV in crore over EBITDA in rupees would be the
    // same 1e7 error wearing a ratio's clothes.
    const v = deriveValuation({
      ...base,
      totalDebt: 20_000,
      ttmEbitda: 10_000,
    });
    assert.equal(v.enterpriseValue, 0.012);
    assert.equal(v.evToEbitda, 12);
  });

  it("a genuine zero dividend is 0%, not absent", () => {
    const v = deriveValuation({ ...base, ttmDividendPerShare: 0 });
    assert.equal(v.dividendYield, 0, "0 is a real yield and must survive");
  });

  it("missing price yields nothing at all rather than zeros", () => {
    const v = deriveValuation({ shares: 1000, ttmEps: 5, totalEquity: 1000 });
    assert.deepEqual(v, {});
  });
});

describe("ttmDividendPerShare", () => {
  const asOf = new Date("2026-03-31T00:00:00Z");
  const d = (iso: string, amt: number | null) => ({
    exDate: new Date(`${iso}T00:00:00Z`),
    dividendPerShare: amt,
  });

  it("sums only the trailing twelve months, by ex-date", () => {
    const r = ttmDividendPerShare(
      [
        d("2026-02-01", 5),
        d("2025-07-01", 3),
        d("2025-01-01", 99), // outside the window
      ],
      asOf,
    );
    assert.equal(r.total, 8);
    assert.equal(r.counted, 2);
  });

  it("excludes an ex-date AFTER asOf", () => {
    const r = ttmDividendPerShare([d("2026-06-01", 5)], asOf);
    assert.equal(r.counted, 0);
    assert.equal(
      r.total,
      undefined,
      "nothing priced in the window is UNKNOWN, not a 0% yield",
    );
  });

  it("a null amount is SKIPPED, never treated as a zero dividend", () => {
    const r = ttmDividendPerShare(
      [d("2026-02-01", null), d("2026-01-01", 4)],
      asOf,
    );
    assert.equal(r.total, 4, "the null must not depress the sum");
    assert.equal(r.counted, 1);
    assert.equal(r.skippedNullAmount, 1);
  });

  it("a window whose ONLY actions have null amounts is UNKNOWN, not 0%", () => {
    const r = ttmDividendPerShare([d("2026-02-01", null)], asOf);
    assert.equal(
      r.total,
      undefined,
      "'declared but amount not captured' must not render as a 0% yield",
    );
    assert.equal(r.skippedNullAmount, 1);
  });

  it("no actions at all is UNKNOWN, not a real 0% yield", () => {
    // Reversed deliberately. The earlier contract returned 0, and prod
    // contradicts it: only 1,977 of 10,749 active NSE instruments have a
    // DIVIDEND action in the trailing twelve months, so "no rows" overwhelmingly
    // means our coverage does not reach the symbol. `StockRatios` already has a
    // convention — 1,161 non-null dividendYield values, exactly ONE equal to 0.
    // Writing 0 would flip INFY's real 3.61% to zero under a source stamp that
    // outranks the incumbent.
    const r = ttmDividendPerShare([], asOf);
    assert.equal(r.total, undefined);
    assert.equal(r.counted, 0);
  });

  it("collapses same-amount rows a day apart — prod inflates DPS by +56.8%", () => {
    // Measured: 642 of 1,220 symbols with a priced dividend carry a same-amount
    // twin within two days; summing as-is gives 22,338 vs 14,245. Exact-date
    // duplicates are ZERO, so a (symbol, exDate) unique key would not catch
    // these — the twins sit one day apart.
    // INFY's real shape (₹25 twice a day apart, plus a ₹23 earlier), dated
    // inside this suite's window — the pattern is the point, not the calendar.
    const r = ttmDividendPerShare(
      [d("2026-01-09", 25), d("2026-01-10", 25), d("2025-10-26", 23)],
      asOf,
    );
    assert.equal(r.total, 48, "the twin counts once: 25 + 23, not 73");
    assert.equal(r.counted, 2);
    assert.equal(r.deduped, 1);
  });

  it("two DIFFERENT amounts days apart both count (interim + special)", () => {
    const r = ttmDividendPerShare(
      [d("2026-01-09", 25), d("2026-01-10", 4)],
      asOf,
    );
    assert.equal(
      r.total,
      29,
      "dedupe keys on amount equality, not proximity alone",
    );
    assert.equal(r.deduped, 0);
  });

  it("the same amount paid QUARTERLY is not collapsed", () => {
    const r = ttmDividendPerShare(
      [
        d("2025-06-15", 5),
        d("2025-09-15", 5),
        d("2025-12-15", 5),
        d("2026-03-15", 5),
      ],
      asOf,
    );
    assert.equal(
      r.total,
      20,
      "~90-day spacing is far outside the 3-day window",
    );
    assert.equal(r.deduped, 0);
  });
});
