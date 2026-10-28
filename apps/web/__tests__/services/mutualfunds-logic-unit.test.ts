/**
 * Mutual-funds SERVICE pure-logic unit tests (MONEY-620).
 *
 * Imports the REAL exported symbols from the service-layer logic module
 * `packages/services/src/mutualfunds-logic` (via a relative path — the
 * services package is ESM and these tests run under apps/web's CJS tsx loader,
 * so we cannot go through the `@usemoney/services` barrel here without the
 * recording-prisma seam; the sibling `mutualfunds-data-e2e.test.ts` drives the
 * LIVE service through that seam). The production `getMutualFunds` /
 * `createMutualFund` in `mutualfunds.service.ts` call these SAME helpers, so a
 * regression in the math fails here too — no shadow.
 *
 * Focus: EXHAUSTIVE negative / edge / bug-hunt — non-finite poison (NaN /
 * ±Infinity in units, NAV, invested, current, gain), divide-by-zero / negative
 * invested in the return %, the `Infinity || 0 === Infinity` trap, per-fund
 * sanitisation so nothing non-finite reaches a UI `.toFixed()`/`.toLocaleString()`,
 * IDOR where-scope, very large corpora (no overflow), and fractional-unit
 * precision. Pure → exits clean (no DB/network/timers).
 *
 * Source: packages/services/src/mutualfunds-logic.ts
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  finite,
  buildMutualFundWhere,
  computeMfInvested,
  computeMfCurrentValue,
  computeMfUnrealizedGain,
  computeMfReturnPct,
  deriveMutualFundCreateFields,
  sanitizeMutualFundNumerics,
  calculateMfSummary,
  formatMfPnlPercentage,
  type MutualFundSummaryInput,
} from "../../../../packages/services/src/mutualfunds-logic";

// ── finite() — the non-finite guard ────────────────────────────────────────

describe("mutualfunds-logic — finite (real export)", () => {
  it("passes through finite numbers unchanged (incl. negatives and 0)", () => {
    assert.strictEqual(finite(123.45), 123.45);
    assert.strictEqual(finite(-99), -99);
    assert.strictEqual(finite(0), 0);
  });

  it("collapses NaN / ±Infinity / null / undefined to the fallback (default 0)", () => {
    assert.strictEqual(finite(NaN), 0);
    assert.strictEqual(finite(Infinity), 0);
    assert.strictEqual(finite(-Infinity), 0);
    assert.strictEqual(finite(null), 0);
    assert.strictEqual(finite(undefined), 0);
  });

  it("honours a custom fallback", () => {
    assert.strictEqual(finite(NaN, 7), 7);
    assert.strictEqual(finite(Infinity, -1), -1);
  });

  it("treats -0 as the finite number it is", () => {
    assert.ok(Object.is(finite(-0), -0) || finite(-0) === 0);
  });
});

// ── buildMutualFundWhere — IDOR scope + filter contract ─────────────────────

describe("mutualfunds-logic — buildMutualFundWhere (real export, IDOR)", () => {
  it("ALWAYS scopes to userId, even with no filters", () => {
    assert.deepStrictEqual(buildMutualFundWhere("user-1"), {
      userId: "user-1",
    });
    assert.deepStrictEqual(buildMutualFundWhere("user-1", {}), {
      userId: "user-1",
    });
  });

  it("keeps userId scope when a search filter is added (never widens to all users)", () => {
    const where = buildMutualFundWhere("user-1", { search: "Nifty" });
    assert.strictEqual(where.userId, "user-1");
    assert.deepStrictEqual(where.schemeName, {
      contains: "Nifty",
      mode: "insensitive",
    });
  });

  it("treats empty-string search as no filter", () => {
    const where = buildMutualFundWhere("u", { search: "" });
    assert.strictEqual(where.schemeName, undefined);
  });

  it("treats the 'all' category sentinel as no category filter", () => {
    const where = buildMutualFundWhere("u", { category: "all" });
    assert.strictEqual(where.category, undefined);
  });

  it("applies a concrete category filter verbatim (and keeps userId)", () => {
    const where = buildMutualFundWhere("u9", {
      search: "Gold",
      category: "Commodity",
    });
    assert.strictEqual(where.userId, "u9");
    assert.strictEqual(where.category, "Commodity");
    assert.deepStrictEqual(where.schemeName, {
      contains: "Gold",
      mode: "insensitive",
    });
  });

  it("does not let case-variant 'All' slip through the sentinel (only lowercase 'all' drops)", () => {
    assert.strictEqual(
      buildMutualFundWhere("u", { category: "All" }).category,
      "All"
    );
  });

  it("preserves unicode in the search term verbatim", () => {
    const where = buildMutualFundWhere("u", { search: "रिलायंस 🚀" });
    assert.deepStrictEqual(where.schemeName, {
      contains: "रिलायंस 🚀",
      mode: "insensitive",
    });
  });
});

// ── per-fund math helpers ───────────────────────────────────────────────────

describe("mutualfunds-logic — per-fund math (real exports)", () => {
  it("computeMfInvested = units * averageNav for finite inputs", () => {
    assert.strictEqual(computeMfInvested(100, 50), 5000);
    assert.strictEqual(computeMfInvested(0, 50), 0);
  });

  it("computeMfInvested neutralises a NaN/Infinity operand to a finite 0 (not NaN/Infinity)", () => {
    assert.strictEqual(computeMfInvested(NaN, 50), 0);
    assert.strictEqual(computeMfInvested(100, Infinity), 0);
    assert.strictEqual(computeMfInvested(Infinity, 0), 0); // Infinity*0 = NaN → 0
  });

  it("computeMfCurrentValue = units * currentNav, finite-guarded", () => {
    assert.strictEqual(computeMfCurrentValue(100, 55), 5500);
    assert.strictEqual(computeMfCurrentValue(100, NaN), 0);
    assert.strictEqual(computeMfCurrentValue(-Infinity, 1), 0);
  });

  it("computeMfUnrealizedGain = current - invested, finite-guarded both ways", () => {
    assert.strictEqual(computeMfUnrealizedGain(5500, 5000), 500);
    assert.strictEqual(computeMfUnrealizedGain(4000, 5000), -1000);
    // A non-finite operand collapses to a finite difference (treated as 0).
    assert.strictEqual(computeMfUnrealizedGain(NaN, 5000), -5000);
    assert.strictEqual(computeMfUnrealizedGain(5500, Infinity), 5500);
  });

  it("computeMfReturnPct = gain/invested*100 for a positive invested", () => {
    assert.strictEqual(computeMfReturnPct(500, 5000), 10);
    assert.strictEqual(computeMfReturnPct(-1000, 5000), -20);
  });

  it("computeMfReturnPct returns 0 (not Infinity/NaN) when invested is 0 — divide-by-zero clamp", () => {
    assert.strictEqual(computeMfReturnPct(500, 0), 0);
    assert.ok(Number.isFinite(computeMfReturnPct(500, 0)));
  });

  it("computeMfReturnPct returns 0 for a NEGATIVE invested (no sign-flipped pct)", () => {
    assert.strictEqual(computeMfReturnPct(1000, -1000), 0);
  });

  it("computeMfReturnPct returns 0 for a non-finite invested or gain", () => {
    assert.strictEqual(computeMfReturnPct(500, NaN), 0);
    assert.strictEqual(computeMfReturnPct(500, Infinity), 0);
    assert.strictEqual(computeMfReturnPct(NaN, 5000), 0);
  });
});

// ── deriveMutualFundCreateFields — the create path ──────────────────────────

describe("mutualfunds-logic — deriveMutualFundCreateFields (real export)", () => {
  it("derives invested/current/gain and falls back currentNav→averageNav when absent", () => {
    const d = deriveMutualFundCreateFields({ units: 100, averageNav: 50 });
    assert.strictEqual(d.currentNav, 50); // fell back to averageNav
    assert.strictEqual(d.investedAmount, 5000);
    assert.strictEqual(d.currentValue, 5000);
    assert.strictEqual(d.unrealizedGain, 0);
  });

  it("uses an explicit positive currentNav when provided", () => {
    const d = deriveMutualFundCreateFields({
      units: 100,
      averageNav: 50,
      currentNav: 55,
    });
    assert.strictEqual(d.currentNav, 55);
    assert.strictEqual(d.currentValue, 5500);
    assert.strictEqual(d.unrealizedGain, 500);
  });

  it("never persists a non-finite field even if a caller bypasses Zod (apps/api / workers)", () => {
    // The web action validates units/NAV as positive+finite, but the service is
    // also consumed by apps/api and workers. A NaN units must NOT persist NaN.
    const d = deriveMutualFundCreateFields({
      units: NaN,
      averageNav: 50,
      currentNav: 55,
    });
    assert.ok(Number.isFinite(d.investedAmount));
    assert.ok(Number.isFinite(d.currentValue));
    assert.ok(Number.isFinite(d.unrealizedGain));
    assert.strictEqual(d.investedAmount, 0);
    assert.strictEqual(d.currentValue, 0);
  });

  it("treats a 0/NaN currentNav as falsy and falls back to averageNav (mirrors `currentNav || averageNav`)", () => {
    assert.strictEqual(
      deriveMutualFundCreateFields({ units: 1, averageNav: 42, currentNav: 0 })
        .currentNav,
      42
    );
    assert.strictEqual(
      deriveMutualFundCreateFields({
        units: 1,
        averageNav: 42,
        currentNav: NaN,
      }).currentNav,
      42
    );
  });
});

// ── sanitizeMutualFundNumerics — consumer-safety (no NaN to formatters) ──────

describe("mutualfunds-logic — sanitizeMutualFundNumerics (real export)", () => {
  const baseRow = {
    id: "mf-x",
    schemeName: "Test Fund",
    category: "Equity",
    units: 100,
    averageNav: 50,
    currentNav: 55,
    investedAmount: 5000,
    currentValue: 5500,
    unrealizedGain: 500,
    xirr: 12,
  };

  it("preserves a clean row's numeric values and non-numeric fields (behaviour-preserving)", () => {
    const out = sanitizeMutualFundNumerics(baseRow);
    assert.strictEqual(out.id, "mf-x");
    assert.strictEqual(out.schemeName, "Test Fund");
    assert.strictEqual(out.category, "Equity");
    assert.strictEqual(out.units, 100);
    assert.strictEqual(out.currentNav, 55);
    assert.strictEqual(out.unrealizedGain, 500);
    assert.strictEqual(out.xirr, 12);
  });

  it("neutralises EVERY non-finite numeric field to 0 — nothing non-finite can reach toFixed/toLocaleString", () => {
    const out = sanitizeMutualFundNumerics({
      ...baseRow,
      units: NaN,
      averageNav: Infinity,
      currentNav: -Infinity,
      investedAmount: NaN,
      currentValue: Infinity,
      unrealizedGain: NaN,
      xirr: Infinity,
    });
    for (const k of [
      "units",
      "averageNav",
      "currentNav",
      "investedAmount",
      "currentValue",
      "unrealizedGain",
      "xirr",
    ] as const) {
      assert.ok(Number.isFinite(out[k]), `${k} must be finite`);
      assert.strictEqual(out[k], 0);
      // The exact thing the holdings UI does to each — must never be "NaN".
      assert.notStrictEqual(out[k].toFixed(2), "NaN");
      assert.notStrictEqual(out[k].toFixed(2), "Infinity");
    }
    // And the toLocaleString a fmtINR(Math.round(...)) call would make:
    assert.notStrictEqual(
      Math.round(out.currentValue).toLocaleString("en-IN"),
      "NaN"
    );
  });

  it("coerces a null numeric (Prisma `unrealizedGain: number | null`) to a finite 0", () => {
    const out = sanitizeMutualFundNumerics({
      ...baseRow,
      unrealizedGain: null,
    });
    assert.strictEqual(out.unrealizedGain, 0);
    assert.ok(Number.isFinite(out.unrealizedGain));
  });

  it("preserves fractional-unit precision (no rounding of clean values)", () => {
    const out = sanitizeMutualFundNumerics({ ...baseRow, units: 1250.456789 });
    assert.strictEqual(out.units, 1250.456789);
    // The UI renders units.toFixed(3) — a precise value survives.
    assert.strictEqual(out.units.toFixed(3), "1250.457");
  });
});

// ── calculateMfSummary — portfolio aggregation (the LIVE bug surface) ────────

describe("mutualfunds-logic — calculateMfSummary (real export)", () => {
  const f = (
    investedAmount: number | null,
    currentValue: number | null,
    unrealizedGain: number | null
  ): MutualFundSummaryInput => ({
    investedAmount,
    currentValue,
    unrealizedGain,
  });

  it("returns an all-zero '0'-pct summary for an empty book (no divide-by-zero)", () => {
    assert.deepStrictEqual(calculateMfSummary([]), {
      totalInvested: 0,
      totalCurrent: 0,
      totalPnL: 0,
      pnlPercentage: "0",
    });
  });

  it("computes a 2-decimal percentage string for a normal book", () => {
    const s = calculateMfSummary([f(10000, 10333, 333)]);
    assert.strictEqual(s.totalInvested, 10000);
    assert.strictEqual(s.totalCurrent, 10333);
    assert.strictEqual(s.totalPnL, 333);
    assert.strictEqual(s.pnlPercentage, "3.33");
  });

  it("sums across multiple funds and yields a 2dp pct", () => {
    const s = calculateMfSummary([f(1000, 1200, 200), f(4000, 3800, -200)]);
    assert.strictEqual(s.totalInvested, 5000);
    assert.strictEqual(s.totalCurrent, 5000);
    assert.strictEqual(s.totalPnL, 0);
    assert.strictEqual(s.pnlPercentage, "0.00");
  });

  it("treats a null unrealizedGain as 0 (no NaN leak)", () => {
    const s = calculateMfSummary([f(1000, 1500, null)]);
    assert.strictEqual(s.totalPnL, 0);
    assert.ok(!Number.isNaN(s.totalPnL));
    assert.strictEqual(s.pnlPercentage, "0.00");
  });

  // ── NON-FINITE POISON regression (the core MONEY-620 fix) ──
  // Pre-fix the service summed raw fields, so a SINGLE corrupt fund poisoned
  // the WHOLE total: `Infinity || 0 === Infinity` and `x + NaN === NaN`.

  it("a NaN invested in ONE fund does NOT poison the portfolio total (was NaN pre-fix)", () => {
    const s = calculateMfSummary([
      f(10000, 11000, 1000), // clean
      f(NaN, 5000, 500), // corrupt invested
    ]);
    assert.ok(Number.isFinite(s.totalInvested), "totalInvested must be finite");
    // corrupt invested contributes 0 → 10000 + 0
    assert.strictEqual(s.totalInvested, 10000);
    assert.strictEqual(s.totalCurrent, 16000);
    assert.strictEqual(s.totalPnL, 1500);
  });

  it("an Infinity currentValue (the `Infinity || 0 === Infinity` trap) contributes 0, not Infinity", () => {
    const s = calculateMfSummary([
      f(90000, 100000, 10000),
      f(90000, Infinity, 10000), // Infinity slips past `|| 0`
    ]);
    assert.ok(Number.isFinite(s.totalCurrent), "totalCurrent must be finite");
    // Infinity row's current → 0; invested still counts (both 90000).
    assert.strictEqual(s.totalCurrent, 100000);
    assert.strictEqual(s.totalInvested, 180000);
  });

  it("a -Infinity gain does NOT drag the PnL total to -Infinity", () => {
    const s = calculateMfSummary([f(1000, 1200, 200), f(1000, 900, -Infinity)]);
    assert.ok(Number.isFinite(s.totalPnL));
    assert.strictEqual(s.totalPnL, 200); // bad gain → 0
  });

  it("pnlPercentage is NEVER the literal 'NaN'/'Infinity' even on a fully poisoned book", () => {
    const s = calculateMfSummary([
      f(NaN, Infinity, NaN),
      f(-Infinity, NaN, Infinity),
    ]);
    assert.notStrictEqual(s.pnlPercentage, "NaN");
    assert.notStrictEqual(s.pnlPercentage, "Infinity");
    // All bad → totals 0 → pct "0".
    assert.strictEqual(s.pnlPercentage, "0");
    assert.ok(Number.isFinite(Number(s.pnlPercentage)));
  });

  it("returns '0' (not '-Infinity'/'NaN') when invested is 0 but PnL is non-zero", () => {
    const s = calculateMfSummary([f(0, 500, 500)]);
    assert.strictEqual(s.totalInvested, 0);
    assert.strictEqual(s.totalPnL, 500);
    assert.strictEqual(s.pnlPercentage, "0");
  });

  it("returns '0' for a NEGATIVE total invested (guard is `> 0`, no sign-flipped pct)", () => {
    const s = calculateMfSummary([f(-1000, 0, 1000)]);
    assert.strictEqual(s.totalInvested, -1000);
    assert.strictEqual(s.pnlPercentage, "0");
  });

  it("yields a negative percentage string for a real loss", () => {
    assert.strictEqual(
      calculateMfSummary([f(2000, 1500, -500)]).pnlPercentage,
      "-25.00"
    );
  });

  it("handles a VERY LARGE corpus without overflow (stays finite, parseable)", () => {
    // ₹50,000 cr invested, ₹60,000 cr current across 1000 funds.
    const big = Array.from({ length: 1000 }, () =>
      f(5_00_00_00_000, 6_00_00_00_000, 1_00_00_00_000)
    );
    const s = calculateMfSummary(big);
    assert.ok(Number.isFinite(s.totalInvested));
    assert.ok(Number.isFinite(s.totalCurrent));
    assert.strictEqual(s.totalInvested, 5_00_00_00_000 * 1000);
    assert.strictEqual(s.totalCurrent, 6_00_00_00_000 * 1000);
    // 20% gain.
    assert.strictEqual(s.pnlPercentage, "20.00");
    assert.ok(Number.isFinite(Number(s.pnlPercentage)));
  });

  it("a consumer doing fmtINR(Math.round(total)) never sees 'NaN' on a poisoned book", () => {
    const s = calculateMfSummary([
      f(100000, 120000, 20000),
      f(Infinity, NaN, -Infinity),
    ]);
    const inr = (n: number) => `₹${Math.round(n).toLocaleString("en-IN")}`;
    assert.strictEqual(inr(s.totalInvested), "₹1,00,000");
    assert.strictEqual(inr(s.totalCurrent), "₹1,20,000");
    assert.notStrictEqual(inr(s.totalPnL), "₹NaN");
  });
});

// ── formatMfPnlPercentage — direct edge coverage ────────────────────────────

describe("mutualfunds-logic — formatMfPnlPercentage (real export)", () => {
  it("formats a normal ratio to 2dp", () => {
    assert.strictEqual(formatMfPnlPercentage(2000, 10000), "20.00");
  });
  it("clamps non-positive invested to '0'", () => {
    assert.strictEqual(formatMfPnlPercentage(500, 0), "0");
    assert.strictEqual(formatMfPnlPercentage(500, -1), "0");
  });
  it("clamps a non-finite invested or PnL to '0' (never returns 'NaN'/'Infinity')", () => {
    assert.strictEqual(formatMfPnlPercentage(500, NaN), "0");
    assert.strictEqual(formatMfPnlPercentage(500, Infinity), "0");
    assert.strictEqual(formatMfPnlPercentage(NaN, 10000), "0");
    assert.strictEqual(formatMfPnlPercentage(Infinity, 10000), "0");
  });
});
