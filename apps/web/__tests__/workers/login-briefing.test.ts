/**
 * Login Briefing Tests (workers/src/processors/login-briefing.ts)
 *
 * De-shadowed: imports the REAL pure exports from
 * `workers/src/processors/login-briefing-logic.ts`, which `login-briefing.ts`
 * itself calls. The former inline copies of `detectSignificantMovers` /
 * `buildPortfolioSection` were a shadow — and DROPPED the production null-guards
 * (`?? 0`, `!= null`), so they could never have caught a regression in them.
 *
 * Tests:
 *   - Portfolio summary calculation (incl. div-by-zero guard, null coalescing)
 *   - Significant mover detection (incl. null-percentage exclusion)
 *   - Section building (Indian grouping, no decimals)
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  type BriefingHolding,
  type HoldingFlagRow,
  type IndexCloseLite,
  type InstitutionalFlowReading,
  computePortfolioSummary,
  detectSignificantMovers,
  buildPortfolioSection,
  buildMoversSection,
  buildTopHoldingsSection,
  buildMarketFlowSection,
  buildVolatilitySection,
  buildHoldingFlagsSection,
  summarizeNewFlags,
  describeHoldingFlag,
  BRIEFING_FLAG_KINDS,
  SIGNIFICANT_MOVE_THRESHOLD,
} from "../../../../workers/src/processors/login-briefing-logic";

// ── Fixture helper ──────────────────────────────────────────────────

function createHolding(
  overrides: Partial<BriefingHolding> & { symbol: string }
): BriefingHolding {
  const investedValue = overrides.investedValue ?? 100_000;
  const currentValue = overrides.currentValue ?? 110_000;
  return {
    symbol: overrides.symbol,
    currentPrice: overrides.currentPrice ?? 1100,
    investedValue,
    currentValue,
    pnlPercentage:
      overrides.pnlPercentage ??
      (investedValue && investedValue > 0
        ? ((currentValue - investedValue) / investedValue) * 100
        : 0),
  };
}

// ── Tests ──────────────────────────────────────────────────────────

describe("Login Briefing", () => {
  describe("Significant mover detection (real export)", () => {
    it("should detect holdings with >5% change", () => {
      const holdings = [
        createHolding({ symbol: "TCS", pnlPercentage: 8 }),
        createHolding({ symbol: "INFY", pnlPercentage: 2 }),
        createHolding({ symbol: "RELIANCE", pnlPercentage: -7 }),
      ];
      const movers = detectSignificantMovers(holdings);
      assert.strictEqual(movers.length, 2);
      assert.strictEqual(movers[0]!.symbol, "TCS");
      assert.strictEqual(movers[1]!.symbol, "RELIANCE");
    });

    it("should return empty for no significant movers", () => {
      const holdings = [
        createHolding({ symbol: "TCS", pnlPercentage: 1 }),
        createHolding({ symbol: "INFY", pnlPercentage: -2 }),
      ];
      assert.strictEqual(detectSignificantMovers(holdings).length, 0);
    });

    it("should limit to 5 movers", () => {
      const holdings = Array.from({ length: 10 }, (_, i) =>
        createHolding({ symbol: `STOCK${i}`, pnlPercentage: 10 + i })
      );
      assert.strictEqual(detectSignificantMovers(holdings).length, 5);
    });

    it("should sort by absolute percentage (highest first)", () => {
      const holdings = [
        createHolding({ symbol: "A", pnlPercentage: 6 }),
        createHolding({ symbol: "B", pnlPercentage: -15 }),
        createHolding({ symbol: "C", pnlPercentage: 10 }),
      ];
      const movers = detectSignificantMovers(holdings);
      assert.strictEqual(movers[0]!.symbol, "B"); // -15% (abs 15)
      assert.strictEqual(movers[1]!.symbol, "C"); // 10%
      assert.strictEqual(movers[2]!.symbol, "A"); // 6%
    });

    it("treats exactly the threshold as NOT significant (strict >)", () => {
      const holdings = [
        createHolding({
          symbol: "AT",
          pnlPercentage: SIGNIFICANT_MOVE_THRESHOLD,
        }),
        createHolding({
          symbol: "BELOW",
          pnlPercentage: -SIGNIFICANT_MOVE_THRESHOLD,
        }),
      ];
      assert.strictEqual(detectSignificantMovers(holdings).length, 0);
    });

    it("EXCLUDES holdings with a null pnlPercentage (production != null guard)", () => {
      // A null percentage must never sort to the top — the shadow copy that
      // dropped the `!= null` guard would have crashed in the comparator or
      // surfaced the null row. The real export filters it out.
      const holdings = [
        { ...createHolding({ symbol: "NULLP" }), pnlPercentage: null },
        createHolding({ symbol: "REAL", pnlPercentage: 9 }),
      ];
      const movers = detectSignificantMovers(holdings);
      assert.strictEqual(movers.length, 1);
      assert.strictEqual(movers[0]!.symbol, "REAL");
    });

    it("honours a custom threshold", () => {
      const holdings = [createHolding({ symbol: "X", pnlPercentage: 12 })];
      assert.strictEqual(detectSignificantMovers(holdings, 20).length, 0);
      assert.strictEqual(detectSignificantMovers(holdings, 10).length, 1);
    });
  });

  describe("computePortfolioSummary (real export)", () => {
    it("computes totals + percent", () => {
      const summary = computePortfolioSummary([
        createHolding({
          symbol: "TCS",
          investedValue: 100_000,
          currentValue: 110_000,
        }),
      ]);
      assert.strictEqual(summary.totalValue, 110_000);
      assert.strictEqual(summary.totalInvested, 100_000);
      assert.strictEqual(summary.totalPnl, 10_000);
      assert.strictEqual(summary.totalPnlPercent, 10);
    });

    it("DIV-BY-ZERO GUARD: percent is 0 when invested is 0 (never NaN/Infinity)", () => {
      const summary = computePortfolioSummary([
        createHolding({ symbol: "FREE", investedValue: 0, currentValue: 5000 }),
      ]);
      assert.strictEqual(summary.totalInvested, 0);
      assert.strictEqual(summary.totalPnlPercent, 0);
      assert.ok(Number.isFinite(summary.totalPnlPercent));
    });

    it("coalesces null currentValue / investedValue columns to 0", () => {
      const summary = computePortfolioSummary([
        {
          symbol: "NULLS",
          currentPrice: null,
          investedValue: null,
          currentValue: null,
          pnlPercentage: null,
        },
      ]);
      assert.strictEqual(summary.totalValue, 0);
      assert.strictEqual(summary.totalInvested, 0);
      assert.strictEqual(summary.totalPnl, 0);
      assert.strictEqual(summary.totalPnlPercent, 0);
    });

    it("empty holdings → all zeros, finite percent", () => {
      const summary = computePortfolioSummary([]);
      assert.deepStrictEqual(summary, {
        totalValue: 0,
        totalInvested: 0,
        totalPnl: 0,
        totalPnlPercent: 0,
      });
    });
  });

  describe("Portfolio section building (real export)", () => {
    it("should calculate correct total value (Indian grouping, no decimals)", () => {
      const holdings = [
        createHolding({ symbol: "TCS", currentValue: 100_000 }),
        createHolding({ symbol: "INFY", currentValue: 50_000 }),
      ];
      const section = buildPortfolioSection(holdings);
      assert.ok(section.items[0]!.value.includes("1,50,000"));
    });

    it("should show stock count", () => {
      const holdings = [
        createHolding({ symbol: "TCS" }),
        createHolding({ symbol: "INFY" }),
        createHolding({ symbol: "HDFC" }),
      ];
      const section = buildPortfolioSection(holdings);
      assert.strictEqual(section.items[2]!.value, "3 stocks");
    });

    it("should include P&L change percentage", () => {
      const holdings = [
        createHolding({
          symbol: "TCS",
          investedValue: 100_000,
          currentValue: 110_000,
        }),
      ];
      const section = buildPortfolioSection(holdings);
      assert.ok(section.items[1]!.change !== undefined);
      assert.ok(section.items[1]!.change! > 0);
    });

    it("formats amounts with NO fractional digits", () => {
      const section = buildPortfolioSection([
        createHolding({
          symbol: "FRAC",
          currentValue: 1234.56,
          investedValue: 1000,
        }),
      ]);
      // maximumFractionDigits: 0 → no ".56"
      assert.ok(!section.items[0]!.value.includes("."));
    });

    it("should handle empty holdings", () => {
      const section = buildPortfolioSection([]);
      assert.strictEqual(section.items[2]!.value, "0 stocks");
    });
  });

  describe("Movers / top-holdings sections (real export)", () => {
    it("movers section carries pnlPercentage as change (null → 0)", () => {
      const section = buildMoversSection([
        createHolding({ symbol: "A", pnlPercentage: 9, currentPrice: 500 }),
        { ...createHolding({ symbol: "B" }), pnlPercentage: null },
      ]);
      assert.strictEqual(section.type, "significant_movers");
      assert.strictEqual(section.items[0]!.change, 9);
      assert.strictEqual(section.items[1]!.change, 0);
    });

    it("top-holdings section leaves change undefined for null percentage", () => {
      const section = buildTopHoldingsSection([
        { ...createHolding({ symbol: "NP" }), pnlPercentage: null },
      ]);
      assert.strictEqual(section.type, "top_holdings");
      assert.strictEqual(section.items[0]!.change, undefined);
    });
  });
});

// ── MONEY-1204 (14e.4) market-context sections ──────────────────────────────

const aug = (day: number): Date => new Date(Date.UTC(2026, 7, day));

describe("Login Briefing — market context (MONEY-1204 14e.4)", () => {
  describe("Institutional flows (FII / DII net)", () => {
    it("reports the day's net in ₹ CRORE, unrescaled, FII first", () => {
      const readings: InstitutionalFlowReading[] = [
        { date: aug(14), category: "DII", netValue: 2345.67 },
        { date: aug(14), category: "FII", netValue: -1234.5 },
        { date: aug(13), category: "FII", netValue: 999 },
      ];
      const section = buildMarketFlowSection(readings)!;
      assert.ok(section);
      assert.strictEqual(section.type, "institutional_flows");
      assert.strictEqual(section.items[0]!.label, "FII");
      // ₹ crore is NSE's own unit. 1,234.5 must NOT become 12,345,000,000.
      assert.strictEqual(section.items[0]!.value, "−₹1,235 Cr");
      assert.strictEqual(section.items[1]!.label, "DII");
      assert.strictEqual(section.items[1]!.value, "+₹2,346 Cr");
      // Only the LATEST day is used — the 13-Aug row is not mixed in.
      assert.strictEqual(section.items.length, 3);
      assert.strictEqual(section.items[2]!.label, "As of");
    });

    it("never puts a ₹ figure in `change` (the UI renders change as a PERCENT)", () => {
      const section = buildMarketFlowSection([
        { date: aug(14), category: "FII", netValue: 1234 },
      ])!;
      assert.ok(section);
      for (const item of section.items) {
        assert.strictEqual(item.change, undefined);
      }
    });

    it("returns null on no data rather than printing a zero", () => {
      // A missing flow row means NOT CAPTURED (the feed is unbackfillable),
      // which is not "the institutions did nothing".
      assert.strictEqual(buildMarketFlowSection([]), null);
      assert.strictEqual(
        buildMarketFlowSection([
          { date: aug(14), category: "FII", netValue: Number.NaN },
        ]),
        null
      );
    });
  });

  describe("India VIX", () => {
    it("reports the level and the percent change from prevClose", () => {
      const rows: IndexCloseLite[] = [
        { date: aug(14), close: 11.31, prevClose: 11.56 },
      ];
      const section = buildVolatilitySection(rows)!;
      assert.ok(section);
      assert.strictEqual(section.type, "volatility");
      assert.strictEqual(section.items[0]!.label, "India VIX");
      assert.strictEqual(section.items[0]!.value, "11.31");
      assert.ok(Math.abs(section.items[0]!.change! - -2.1626) < 0.001);
    });

    it("falls back to the previous row's close when prevClose is null", () => {
      const rows: IndexCloseLite[] = [
        { date: aug(14), close: 11.31, prevClose: null },
        { date: aug(13), close: 11.56, prevClose: null },
      ];
      const section = buildVolatilitySection(rows)!;
      assert.ok(section.items[0]!.change !== undefined);
      assert.ok(Math.abs(section.items[0]!.change! - -2.1626) < 0.001);
    });

    it("omits `change` entirely rather than fabricating one from a null/zero prior", () => {
      // A zero prevClose would render as −100%; a null must simply mean unknown.
      for (const prior of [null, 0]) {
        const section = buildVolatilitySection([
          { date: aug(14), close: 11.31, prevClose: prior },
        ])!;
        assert.ok(section);
        assert.strictEqual(section.items[0]!.change, undefined);
      }
    });

    it("returns null when there is no VIX row at all", () => {
      assert.strictEqual(buildVolatilitySection([]), null);
    });
  });

  describe("Flags on the user's holdings", () => {
    it("COLLAPSES a persisting flag to one line dated to its EARLIEST day", () => {
      // StockFlag is append-only: a fortnight under GSM is fourteen rows.
      const rows: HoldingFlagRow[] = [4, 5, 6, 7].map((d) => ({
        symbol: "XYZ",
        date: aug(d),
        kind: "SURVEILLANCE",
        value: "GSM STAGE - I",
      }));
      const summaries = summarizeNewFlags(rows);
      assert.strictEqual(summaries.length, 1);
      assert.strictEqual(summaries[0]!.since.getTime(), aug(4).getTime());

      const section = buildHoldingFlagsSection(rows)!;
      assert.strictEqual(section.type, "holding_flags");
      assert.strictEqual(section.items.length, 1);
      assert.match(section.items[0]!.value, /GSM STAGE - I since 4 Aug 2026/);
    });

    it("treats a CHANGED value as a distinct fact", () => {
      const rows: HoldingFlagRow[] = [
        {
          symbol: "XYZ",
          date: aug(4),
          kind: "SURVEILLANCE",
          value: "GSM STAGE - I",
        },
        {
          symbol: "XYZ",
          date: aug(9),
          kind: "SURVEILLANCE",
          value: "GSM STAGE - II",
        },
      ];
      assert.strictEqual(summarizeNewFlags(rows).length, 2);
    });

    it("drops the every-day-for-everything kinds (52wk, price band, short selling)", () => {
      for (const noisy of ["WK52_HIGH_LOW", "PRICE_BAND", "SHORT_SELLING"]) {
        assert.strictEqual(BRIEFING_FLAG_KINDS.includes(noisy), false);
      }
      assert.strictEqual(
        buildHoldingFlagsSection([
          { symbol: "XYZ", date: aug(4), kind: "WK52_HIGH_LOW", value: "{}" },
        ]),
        null
      );
    });

    it("returns null when nothing landed (not a reassuring empty section)", () => {
      assert.strictEqual(buildHoldingFlagsSection([]), null);
    });

    it("describes each kind readably and never throws on a malformed value", () => {
      assert.match(
        describeHoldingFlag({
          symbol: "X",
          kind: "FO_BAN",
          value: "BAN",
          since: aug(4),
        }),
        /^F&O ban since 4 Aug 2026$/
      );
      assert.match(
        describeHoldingFlag({
          symbol: "X",
          kind: "BAND_CHANGE",
          value: '{"from":"10","to":"20"}',
          since: aug(4),
        }),
        /Price band 10% → 20%/
      );
      // `sec_list` prints "No Band" for F&O names — strings, never numbers.
      assert.match(
        describeHoldingFlag({
          symbol: "X",
          kind: "BAND_CHANGE",
          value: "not json at all",
          since: aug(4),
        }),
        /Price band changed on 4 Aug 2026/
      );
      assert.match(
        describeHoldingFlag({
          symbol: "X",
          kind: "SERIES_CHANGE",
          value: '{"from":"EQ","to":"BE"}',
          since: aug(4),
        }),
        /Series EQ → BE/
      );
    });
  });
});
