/**
 * DB-first data access layer — REAL source (MONEY-620 de-shadow).
 *
 * Previously this file inlined `isStale` (with its own STALENESS config),
 * `cleanSymbol`, `groupFinancials` and `mapRatioFields`, plus several
 * illustrative "data source selection / Prisma create pattern / quarter string /
 * trackAnalysis" suites that asserted hand-built mock objects (no real unit).
 *
 * It now imports the REAL `isStale` from `@usemoney/core/market-data/staleness`
 * (which `db-store.ts` itself imports) and the REAL `cleanStoreSymbol` /
 * `groupFinancials` / `mapRatioFields` from the extracted
 * `packages/research/src/data-sources/db-store-logic.ts` (which `db-store.ts`
 * now calls).
 *
 * Real-vs-shadow correction: the inline `mapRatioFields` mapped 21 fields; the
 * REAL one maps 25 — it also carries `revenueGrowth3Y/5Y` and
 * `earningsGrowth3Y/5Y`. The shadow silently dropped those. The pure mock-object
 * suites were removed rather than kept as fixtures.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { isStale } from "@usemoney/core/market-data/staleness";
import {
  cleanStoreSymbol,
  groupFinancials,
  mapRatioFields,
} from "@usemoney/research/data-sources/db-store-logic";

// ── Symbol normalization ──────────────────────────────────────────────────

describe("cleanStoreSymbol", () => {
  it("strips .NS / .BO (case-insensitive) and uppercases", () => {
    assert.strictEqual(cleanStoreSymbol("RELIANCE.NS"), "RELIANCE");
    assert.strictEqual(cleanStoreSymbol("TCS.BO"), "TCS");
    assert.strictEqual(cleanStoreSymbol("hdfc.ns"), "HDFC");
    assert.strictEqual(cleanStoreSymbol("reliance"), "RELIANCE");
    assert.strictEqual(cleanStoreSymbol("INFY"), "INFY");
  });
});

// ── Staleness (REAL @usemoney/core/market-data/staleness) ──────────────────

describe("isStale (real core staleness)", () => {
  it("treats null/undefined fetchedAt as stale", () => {
    assert.strictEqual(isStale(null, "ratios"), true);
    assert.strictEqual(isStale(undefined, "ratios"), true);
  });

  it("treats an unknown config key as stale", () => {
    assert.strictEqual(isStale(new Date(), "totally-unknown-key"), true);
  });

  it("1h-old ratios are NOT stale, 25h-old ratios ARE (24h window)", () => {
    assert.strictEqual(
      isStale(new Date(Date.now() - 3_600_000), "ratios"),
      false
    );
    assert.strictEqual(
      isStale(new Date(Date.now() - 25 * 3_600_000), "ratios"),
      true
    );
  });

  it("10min-old news is NOT stale, 31min-old news IS (30min window)", () => {
    assert.strictEqual(isStale(new Date(Date.now() - 600_000), "news"), false);
    assert.strictEqual(
      isStale(new Date(Date.now() - 31 * 60_000), "news"),
      true
    );
  });

  it("a freshly-fetched annual financial statement is NOT stale (90d window)", () => {
    assert.strictEqual(
      isStale(new Date(Date.now() - 60 * 24 * 3_600_000), "financials_annual"),
      false
    );
  });
});

// ── groupFinancials ─────────────────────────────────────────────────────────

describe("groupFinancials", () => {
  it("buckets rows by statementType", () => {
    const result = groupFinancials([
      { statementType: "INCOME", rawData: { revenue: 100 }, period: "2024" },
      {
        statementType: "BALANCE_SHEET",
        rawData: { assets: 500 },
        period: "2024",
      },
      { statementType: "CASH_FLOW", rawData: { fcf: 50 }, period: "2024" },
      { statementType: "INCOME", rawData: { revenue: 90 }, period: "2023" },
    ]);
    assert.strictEqual(result.income.length, 2);
    assert.strictEqual(result.balanceSheet.length, 1);
    assert.strictEqual(result.cashFlow.length, 1);
  });

  it("spreads rawData and prepends the period", () => {
    const result = groupFinancials([
      {
        statementType: "INCOME",
        rawData: { revenue: 100, netIncome: 20 },
        period: "2024",
      },
    ]);
    assert.strictEqual(result.income[0]!.period, "2024");
    assert.strictEqual(result.income[0]!.revenue, 100);
    assert.strictEqual(result.income[0]!.netIncome, 20);
  });

  it("handles empty input", () => {
    const result = groupFinancials([]);
    assert.strictEqual(result.income.length, 0);
    assert.strictEqual(result.balanceSheet.length, 0);
    assert.strictEqual(result.cashFlow.length, 0);
  });
});

// ── mapRatioFields (REAL — 25 fields incl. 3Y/5Y growth) ───────────────────

describe("mapRatioFields", () => {
  it("maps the full Tickertape ratio payload", () => {
    const r = mapRatioFields({
      pe: 25.5,
      pb: 3.2,
      evToEbitda: 18,
      pegRatio: 1.2,
      roe: 22,
      roa: 12,
      roce: 28,
      grossMargin: 45,
      operatingMargin: 30,
      netMargin: 20,
      revenueGrowth: 15,
      earningsGrowth: 18,
      revenueGrowth3Y: 14,
      earningsGrowth3Y: 16,
      revenueGrowth5Y: 13,
      earningsGrowth5Y: 15,
      debtToEquity: 0.5,
      currentRatio: 2.1,
      interestCoverage: 8,
      beta: 1.1,
      divYield: 1.5,
      mCap: 500000,
      enterpriseValue: 550000,
      targetPrice: 3500,
      recommendation: "BUY",
    });
    assert.strictEqual(r.pe, 25.5);
    assert.strictEqual(r.roe, 22);
    assert.strictEqual(r.dividendYield, 1.5);
    assert.strictEqual(r.marketCap, 500000);
    assert.strictEqual(r.recommendation, "BUY");
  });

  it("maps the multi-year growth fields the old 21-field shadow dropped", () => {
    const r = mapRatioFields({
      revenueGrowth3Y: 14,
      earningsGrowth3Y: 16,
      revenueGrowth5Y: 13,
      earningsGrowth5Y: 15,
    });
    assert.strictEqual(r.revenueGrowth3Y, 14);
    assert.strictEqual(r.earningsGrowth3Y, 16);
    assert.strictEqual(r.revenueGrowth5Y, 13);
    assert.strictEqual(r.earningsGrowth5Y, 15);
  });

  it("prefers divYield over dividendYield and mCap over marketCap", () => {
    const r = mapRatioFields({
      divYield: 1.5,
      dividendYield: 2.5,
      mCap: 100,
      marketCap: 200,
    });
    assert.strictEqual(r.dividendYield, 1.5);
    assert.strictEqual(r.marketCap, 100);
  });

  it("falls back to dividendYield / marketCap when the aliases are absent", () => {
    const r = mapRatioFields({ dividendYield: 2.5, marketCap: 100000 });
    assert.strictEqual(r.dividendYield, 2.5);
    assert.strictEqual(r.marketCap, 100000);
  });

  it("leaves missing fields undefined", () => {
    const r = mapRatioFields({});
    assert.strictEqual(r.pe, undefined);
    assert.strictEqual(r.roe, undefined);
    assert.strictEqual(r.marketCap, undefined);
    assert.strictEqual(r.recommendation, undefined);
    assert.strictEqual(r.revenueGrowth5Y, undefined);
  });
});
