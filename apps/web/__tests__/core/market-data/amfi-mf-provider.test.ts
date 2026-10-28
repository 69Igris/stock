/**
 * AMFI Mutual Fund Provider Tests
 *
 * Exercises the REAL parsing/detection logic from
 * packages/core/src/market-data/instruments/amfi-mf-provider.ts:
 *   - `detectCategory` (now exported; reached in prod via parseAmfiFeed)
 *   - `parseAmfiDate`  (now exported; reached in prod via parseAmfiFeed)
 *   - `parseAmfiFeed`  (extracted pure parser; `fetchAmfiNavFeed` delegates to it)
 *   - `fetchAmfiNavFeed` driven for real with a mocked global `fetch`
 *
 * De-shadow note: the inline `detectCategory`/`parseAmfiDate` copies + the
 * shadow's own `parseFeedLine`/`parseFeedText` were replaced. The per-line
 * parsing that `parseFeedLine` mirrored lives inside `parseAmfiFeed`, so
 * single-line cases are driven through `parseAmfiFeed` (one data line → a
 * 0- or 1-element array). These symbols are imported from the source file
 * directly (the market-data barrel re-exports only the async sync entry
 * points, not these pure helpers).
 *
 * Source: packages/core/src/market-data/instruments/amfi-mf-provider.ts
 */

import { describe, it, mock } from "node:test";
import assert from "node:assert/strict";

import {
  detectCategory,
  parseAmfiDate,
  parseAmfiFeed,
  fetchAmfiNavFeed,
  AmfiNavGrammarError,
} from "../../../../../packages/core/src/market-data/instruments/amfi-mf-provider";
import type {
  AmfiMutualFund,
  AmfiSyncResult,
} from "../../../../../packages/core/src/market-data/instruments/amfi-mf-provider";

/**
 * The feed's column header, in the SIX-column layout every data line in this
 * file is written against — MONEY-1403.
 *
 * Synthesised feeds below used to omit this line, because the parser inferred
 * the layout from fixed positions and did not need it. It no longer does: AMFI
 * inserted `Plan` and `Option` before `Net Asset Value` on 2026-08-19, the
 * positional read silently took `"Direct Plan"` as the NAV, and `mf-sync` wrote
 * nothing for 26 nights at exit 0. The layout is now resolved from these NAMES,
 * so a feed without them cannot be read — which is the point, and is also why
 * every fixture here has to carry the header a real AMFI file always carries.
 */
const SIX_COL_HEADER =
  "Scheme Code;ISIN Div Payout/ISIN Growth;ISIN Div Reinvestment;Scheme Name;Net Asset Value;Date";

/**
 * A row that is always valid, so the feed as a whole is always READABLE.
 *
 * Several cases below feed `parseSingleLine` something that is deliberately not
 * a data row — the column header, a blank line, a truncated line — and assert
 * it yields no fund. Without this sentinel those feeds would contain zero
 * parseable rows, which `parseAmfiFeed` now (correctly) treats as an unreadable
 * feed and throws on. The sentinel keeps "this LINE is not a row" testable
 * without colliding with "this FILE cannot be read", which is a different claim
 * and has its own cases further down.
 */
const SENTINEL_ROW =
  "999999;INF000A01AB1;-;Sentinel Fund - Direct Growth;1.0;31-Jan-2026";

/**
 * Parse a single AMFI data line through the REAL `parseAmfiFeed` by prefixing
 * the column header, an AMC header and a sentinel row. Returns the fund parsed
 * from `line` specifically, or null when `line` produced none (mirrors the old
 * `parseFeedLine` contract without reimplementing it).
 */
function parseSingleLine(line: string, amcName: string): AmfiMutualFund | null {
  const funds = parseAmfiFeed(
    `${SIX_COL_HEADER}\n${amcName}\n${SENTINEL_ROW}\n${line}`
  );
  // funds[0] is the sentinel; anything `line` produced follows it.
  return funds[1] ?? null;
}

// ── Tests ────────────────────────────────────────────────────────

describe("AMFI Mutual Fund Provider (real @usemoney/core source)", () => {
  // ────────────────────────────────────────────────────────────────
  // detectCategory - Equity categories
  // ────────────────────────────────────────────────────────────────
  describe("detectCategory - Equity categories", () => {
    it("should detect 'Large Cap' from scheme name containing 'Large Cap'", () => {
      assert.strictEqual(
        detectCategory("HDFC Large Cap Fund - Direct Plan - Growth").category,
        "Large Cap"
      );
    });

    it("should detect 'Large Cap' from scheme name containing 'Largecap'", () => {
      assert.strictEqual(
        detectCategory("SBI Bluechip LargeCap Fund - Regular Plan").category,
        "Large Cap"
      );
    });

    it("should detect 'Mid Cap' from scheme name", () => {
      assert.strictEqual(
        detectCategory("HDFC Mid Cap Opportunities Fund - Direct").category,
        "Mid Cap"
      );
    });

    it("should detect 'Mid Cap' from 'Midcap' variant", () => {
      assert.strictEqual(
        detectCategory("Axis Midcap Fund - Direct Plan - Growth").category,
        "Mid Cap"
      );
    });

    it("should detect 'Small Cap' from scheme name", () => {
      assert.strictEqual(
        detectCategory("SBI Small Cap Fund - Direct Plan").category,
        "Small Cap"
      );
    });

    it("should detect 'Small Cap' from 'Smallcap' variant", () => {
      assert.strictEqual(
        detectCategory("Nippon India Smallcap Fund - Regular").category,
        "Small Cap"
      );
    });

    it("should detect 'Flexi Cap' from scheme name", () => {
      assert.strictEqual(
        detectCategory("Parag Parikh Flexi Cap Fund - Direct").category,
        "Flexi Cap"
      );
    });

    it("should detect 'Flexi Cap' from 'Flexicap' variant", () => {
      assert.strictEqual(
        detectCategory("HDFC Flexicap Fund - Direct").category,
        "Flexi Cap"
      );
    });

    it("should detect 'Multi Cap' from scheme name", () => {
      assert.strictEqual(
        detectCategory("ICICI Prudential Multi Cap Fund - Direct").category,
        "Multi Cap"
      );
    });

    it("should detect 'Multi Cap' from 'Multicap' variant", () => {
      assert.strictEqual(
        detectCategory("Quant Multicap Fund - Direct Plan").category,
        "Multi Cap"
      );
    });

    it("should detect 'ELSS' from ELSS keyword", () => {
      assert.strictEqual(
        detectCategory("Axis ELSS Tax Saver Fund - Direct").category,
        "ELSS"
      );
    });

    it("should detect 'ELSS' from Tax keyword", () => {
      assert.strictEqual(
        detectCategory("HDFC Tax Saver Fund - Direct Plan").category,
        "ELSS"
      );
    });

    it("should detect 'Focused' category", () => {
      assert.strictEqual(
        detectCategory("Axis Focused 25 Fund - Direct Plan").category,
        "Focused"
      );
    });

    it("should detect 'Value' category", () => {
      assert.strictEqual(
        detectCategory("ICICI Prudential Value Discovery Fund").category,
        "Value"
      );
    });

    it("should detect 'Contra' category", () => {
      assert.strictEqual(
        detectCategory("SBI Contra Fund - Direct Plan - Growth").category,
        "Contra"
      );
    });

    it("should detect 'Dividend Yield' category", () => {
      assert.strictEqual(
        detectCategory("ICICI Prudential Dividend Yield Fund - Direct")
          .category,
        "Dividend Yield"
      );
    });
  });

  // ────────────────────────────────────────────────────────────────
  // detectCategory - Sectoral/Thematic
  // ────────────────────────────────────────────────────────────────
  describe("detectCategory - Sectoral/Thematic", () => {
    it("should detect 'Sectoral' from scheme name", () => {
      assert.strictEqual(
        detectCategory("ICICI Prudential Sectoral Fund").category,
        "Sectoral"
      );
    });

    it("should detect 'Sectoral' from 'Sector' keyword", () => {
      assert.strictEqual(
        detectCategory("SBI Banking Sector Fund - Direct").category,
        "Sectoral"
      );
    });

    it("should detect 'Thematic' category", () => {
      assert.strictEqual(
        detectCategory("HDFC Thematic MNC Fund - Direct Plan").category,
        "Thematic"
      );
    });
  });

  // ────────────────────────────────────────────────────────────────
  // detectCategory - Debt categories
  // ────────────────────────────────────────────────────────────────
  describe("detectCategory - Debt categories", () => {
    it("should detect 'Liquid' from scheme name", () => {
      assert.strictEqual(
        detectCategory("HDFC Liquid Fund - Direct Plan - Growth").category,
        "Liquid"
      );
    });

    it("should detect 'Ultra Short Duration'", () => {
      assert.strictEqual(
        detectCategory("ICICI Prudential Ultra Short Term Fund - Direct")
          .category,
        "Ultra Short Duration"
      );
    });

    it("should detect 'Short Duration' from 'Short Duration'", () => {
      assert.strictEqual(
        detectCategory("HDFC Short Duration Fund - Direct Plan").category,
        "Short Duration"
      );
    });

    it("should detect 'Short Duration' from 'Short Term'", () => {
      assert.strictEqual(
        detectCategory("Aditya Birla Short Term Fund - Direct").category,
        "Short Duration"
      );
    });

    it("should detect 'Medium Duration' from 'Medium Duration'", () => {
      assert.strictEqual(
        detectCategory("SBI Medium Duration Fund - Direct").category,
        "Medium Duration"
      );
    });

    it("should detect 'Medium Duration' from 'Medium Term'", () => {
      assert.strictEqual(
        detectCategory("ICICI Medium Term Fund - Direct").category,
        "Medium Duration"
      );
    });

    it("should detect 'Long Duration' from 'Long Duration'", () => {
      assert.strictEqual(
        detectCategory("ICICI Long Duration Fund - Direct").category,
        "Long Duration"
      );
    });

    it("should detect 'Long Duration' from 'Long Term'", () => {
      assert.strictEqual(
        detectCategory("Nippon India Long Term Fund - Direct").category,
        "Long Duration"
      );
    });

    it("should detect 'Corporate Bond' category", () => {
      assert.strictEqual(
        detectCategory("HDFC Corporate Bond Fund - Direct Plan - Growth")
          .category,
        "Corporate Bond"
      );
    });

    it("should detect 'Banking & PSU' from 'Banking' keyword", () => {
      assert.strictEqual(
        detectCategory("Axis Banking & PSU Debt Fund - Direct").category,
        "Banking & PSU"
      );
    });

    it("should detect 'Banking & PSU' from 'PSU Bond' keyword", () => {
      assert.strictEqual(
        detectCategory("ICICI PSU Bond Fund - Direct").category,
        "Banking & PSU"
      );
    });

    it("should detect 'Gilt' category", () => {
      assert.strictEqual(
        detectCategory("SBI Gilt Fund - Direct Plan - Growth").category,
        "Gilt"
      );
    });

    it("should detect 'Dynamic Bond' category", () => {
      assert.strictEqual(
        detectCategory("ICICI Prudential Dynamic Bond Fund - Direct").category,
        "Dynamic Bond"
      );
    });

    it("should detect 'Overnight' category", () => {
      assert.strictEqual(
        detectCategory("HDFC Overnight Fund - Direct Plan").category,
        "Overnight"
      );
    });

    it("should detect 'Money Market' category", () => {
      assert.strictEqual(
        detectCategory("Aditya Birla Sun Life Money Market Fund").category,
        "Money Market"
      );
    });

    it("should detect 'Credit Risk' category", () => {
      assert.strictEqual(
        detectCategory("HDFC Credit Risk Fund - Direct Plan").category,
        "Credit Risk"
      );
    });

    it("should detect 'Floater' category", () => {
      assert.strictEqual(
        detectCategory("ICICI Prudential Floater Fund - Direct Plan").category,
        "Floater"
      );
    });
  });

  // ────────────────────────────────────────────────────────────────
  // detectCategory - Hybrid categories
  // ────────────────────────────────────────────────────────────────
  describe("detectCategory - Hybrid categories", () => {
    it("should detect 'Aggressive Hybrid' category", () => {
      assert.strictEqual(
        detectCategory("HDFC Aggressive Hybrid Fund - Direct Plan - Growth")
          .category,
        "Aggressive Hybrid"
      );
    });

    it("should detect 'Conservative Hybrid' category", () => {
      assert.strictEqual(
        detectCategory("SBI Conservative Hybrid Fund - Direct Plan").category,
        "Conservative Hybrid"
      );
    });

    it("should detect 'Balanced Advantage' from 'Balanced Advantage'", () => {
      assert.strictEqual(
        detectCategory("ICICI Prudential Balanced Advantage Fund - Direct")
          .category,
        "Balanced Advantage"
      );
    });

    it("should detect 'Balanced Advantage' from 'BAF' keyword", () => {
      assert.strictEqual(
        detectCategory("HDFC BAF Fund - Direct Plan - Growth").category,
        "Balanced Advantage"
      );
    });

    it("should detect 'Multi Asset' category", () => {
      assert.strictEqual(
        detectCategory("ICICI Prudential Multi Asset Fund - Direct").category,
        "Multi Asset"
      );
    });

    it("should detect 'Equity Savings' category", () => {
      assert.strictEqual(
        detectCategory("HDFC Equity Savings Fund - Direct Plan").category,
        "Equity Savings"
      );
    });

    it("should detect 'Arbitrage' category", () => {
      assert.strictEqual(
        detectCategory("ICICI Prudential Arbitrage Fund - Direct").category,
        "Arbitrage"
      );
    });
  });

  // ────────────────────────────────────────────────────────────────
  // detectCategory - Index / ETF / FOF
  // ────────────────────────────────────────────────────────────────
  describe("detectCategory - Index / ETF / Fund of Funds", () => {
    it("should detect 'Index Fund' category", () => {
      assert.strictEqual(
        detectCategory("UTI Nifty 50 Index Fund - Direct Plan").category,
        "Index Fund"
      );
    });

    it("should detect 'ETF' category", () => {
      assert.strictEqual(
        detectCategory("Nippon India Nifty 50 ETF FoF - Direct").category,
        "ETF"
      );
    });

    it("should detect 'Fund of Funds' from 'Fund of Funds'", () => {
      assert.strictEqual(
        detectCategory("ICICI Prudential Fund of Funds Growth - Direct")
          .category,
        "Fund of Funds"
      );
    });

    it("should detect 'Fund of Funds' from 'FOF' keyword", () => {
      assert.strictEqual(
        detectCategory("Axis FOF Fund - Direct Plan - Growth").category,
        "Fund of Funds"
      );
    });
  });

  // ────────────────────────────────────────────────────────────────
  // detectCategory - Generic / Fallback
  // ────────────────────────────────────────────────────────────────
  describe("detectCategory - Generic and fallback", () => {
    it("should detect 'Equity' for generic equity fund", () => {
      assert.strictEqual(
        detectCategory("SBI Magnum Equity Fund - Direct Plan - Growth")
          .category,
        "Equity"
      );
    });

    it("should detect 'Debt' from 'Debt' keyword", () => {
      assert.strictEqual(
        detectCategory("Aditya Birla Sun Life Regular Debt Fund - Direct")
          .category,
        "Debt"
      );
    });

    it("should detect 'Debt' from 'Bond' keyword", () => {
      assert.strictEqual(
        detectCategory("Franklin India Bond Fund - Direct Plan - Growth")
          .category,
        "Debt"
      );
    });

    it("should detect 'Debt' from 'Income' keyword", () => {
      assert.strictEqual(
        detectCategory("ICICI Prudential Income Fund - Direct Plan").category,
        "Debt"
      );
    });

    it("should detect 'Hybrid' as a catch-all for hybrid funds", () => {
      assert.strictEqual(
        detectCategory("HDFC Hybrid Fund - Direct Plan - Growth").category,
        "Hybrid"
      );
    });

    it("should default to 'Other' for unrecognized scheme names", () => {
      assert.strictEqual(
        detectCategory("Some Obscure Fund Name - Direct Plan").category,
        "Other"
      );
    });

    it("should default to 'Other' for empty scheme name", () => {
      assert.strictEqual(detectCategory("").category, "Other");
    });
  });

  // ────────────────────────────────────────────────────────────────
  // detectCategory - Plan detection
  // ────────────────────────────────────────────────────────────────
  describe("detectCategory - Plan detection", () => {
    it("should detect DIRECT plan", () => {
      assert.strictEqual(
        detectCategory("HDFC Large Cap Fund - Direct Plan - Growth").plan,
        "DIRECT"
      );
    });

    it("should detect REGULAR plan", () => {
      assert.strictEqual(
        detectCategory("HDFC Large Cap Fund - Regular Plan - Growth").plan,
        "REGULAR"
      );
    });

    it("should return null plan when neither Direct nor Regular", () => {
      assert.strictEqual(
        detectCategory("HDFC Large Cap Fund - Growth").plan,
        null
      );
    });

    it("should be case-insensitive for plan detection", () => {
      assert.strictEqual(
        detectCategory("SBI Fund - direct plan - growth").plan,
        "DIRECT"
      );
    });
  });

  // ────────────────────────────────────────────────────────────────
  // detectCategory - Sub-category detection
  // ────────────────────────────────────────────────────────────────
  describe("detectCategory - Sub-category detection", () => {
    it("should detect 'Growth' sub-category", () => {
      assert.strictEqual(
        detectCategory("HDFC Large Cap Fund - Direct Plan - Growth")
          .subCategory,
        "Growth"
      );
    });

    it("should detect 'Dividend' sub-category from DIVIDEND keyword", () => {
      assert.strictEqual(
        detectCategory("HDFC Large Cap Fund - Regular Plan - Dividend")
          .subCategory,
        "Dividend"
      );
    });

    it("should detect 'Dividend' sub-category from IDCW keyword", () => {
      assert.strictEqual(
        detectCategory("HDFC Large Cap Fund - Direct Plan - IDCW").subCategory,
        "Dividend"
      );
    });

    it("should return null sub-category when not present", () => {
      assert.strictEqual(
        detectCategory("HDFC Large Cap Fund - Direct Plan").subCategory,
        null
      );
    });
  });

  // ────────────────────────────────────────────────────────────────
  // detectCategory - Combined fields
  // ────────────────────────────────────────────────────────────────
  describe("detectCategory - Combined fields", () => {
    it("should detect all three fields for a typical scheme name", () => {
      const result = detectCategory(
        "Axis ELSS Tax Saver Fund - Direct Plan - Growth"
      );
      assert.strictEqual(result.category, "ELSS");
      assert.strictEqual(result.plan, "DIRECT");
      assert.strictEqual(result.subCategory, "Growth");
    });

    it("should detect Mid Cap + Regular + Dividend", () => {
      const result = detectCategory(
        "SBI Midcap Fund - Regular Plan - Dividend"
      );
      assert.strictEqual(result.category, "Mid Cap");
      assert.strictEqual(result.plan, "REGULAR");
      assert.strictEqual(result.subCategory, "Dividend");
    });

    it("should detect Liquid + Direct + Growth", () => {
      const result = detectCategory("HDFC Liquid Fund - Direct Plan - Growth");
      assert.strictEqual(result.category, "Liquid");
      assert.strictEqual(result.plan, "DIRECT");
      assert.strictEqual(result.subCategory, "Growth");
    });
  });

  // ────────────────────────────────────────────────────────────────
  // parseAmfiDate
  // ────────────────────────────────────────────────────────────────
  describe("parseAmfiDate", () => {
    it("should parse '31-Jan-2026' to a valid Date", () => {
      const date = parseAmfiDate("31-Jan-2026");
      assert.ok(date instanceof Date);
      assert.strictEqual(date!.getFullYear(), 2026);
      assert.strictEqual(date!.getMonth(), 0);
      assert.strictEqual(date!.getDate(), 31);
    });

    it("should parse '15-Jun-2025' to a valid Date", () => {
      const date = parseAmfiDate("15-Jun-2025");
      assert.ok(date instanceof Date);
      assert.strictEqual(date!.getFullYear(), 2025);
      assert.strictEqual(date!.getMonth(), 5);
      assert.strictEqual(date!.getDate(), 15);
    });

    it("should parse '01-Dec-2024' to a valid Date", () => {
      const date = parseAmfiDate("01-Dec-2024");
      assert.ok(date instanceof Date);
      assert.strictEqual(date!.getFullYear(), 2024);
      assert.strictEqual(date!.getMonth(), 11);
    });

    it("should return null for empty string", () => {
      assert.strictEqual(parseAmfiDate(""), null);
    });

    it("should return null for invalid date string", () => {
      assert.strictEqual(parseAmfiDate("not-a-date"), null);
    });

    it("should return null for completely garbage input", () => {
      assert.strictEqual(parseAmfiDate("xyzzy"), null);
    });

    it("should handle ISO format dates as well", () => {
      const date = parseAmfiDate("2026-01-31");
      assert.ok(date instanceof Date);
      assert.strictEqual(date!.getFullYear(), 2026);
    });
  });

  // ────────────────────────────────────────────────────────────────
  // NAV validation (driven through real parseAmfiFeed)
  // ────────────────────────────────────────────────────────────────
  describe("NAV validation (via parseAmfiFeed)", () => {
    const amcName = "Test AMC";

    it("should accept a positive NAV", () => {
      const result = parseSingleLine(
        "100;INE001;INE002;HDFC Fund - Direct Growth;25.5;31-Jan-2026",
        amcName
      );
      assert.ok(result !== null);
      assert.strictEqual(result!.nav, 25.5);
    });

    it("should accept a large NAV", () => {
      const result = parseSingleLine(
        "101;INE001;INE002;SBI Fund - Direct Growth;5432.10;31-Jan-2026",
        amcName
      );
      assert.ok(result !== null);
      assert.strictEqual(result!.nav, 5432.1);
    });

    it("should reject NAV of 0", () => {
      assert.strictEqual(
        parseSingleLine(
          "102;INE001;INE002;HDFC Fund - Direct Growth;0;31-Jan-2026",
          amcName
        ),
        null
      );
    });

    it("should reject negative NAV", () => {
      assert.strictEqual(
        parseSingleLine(
          "103;INE001;INE002;HDFC Fund - Direct Growth;-10.5;31-Jan-2026",
          amcName
        ),
        null
      );
    });

    it("should reject non-numeric NAV (NaN)", () => {
      assert.strictEqual(
        parseSingleLine(
          "104;INE001;INE002;HDFC Fund - Direct Growth;N.A.;31-Jan-2026",
          amcName
        ),
        null
      );
    });

    it("should reject empty NAV field", () => {
      assert.strictEqual(
        parseSingleLine(
          "105;INE001;INE002;HDFC Fund - Direct Growth;;31-Jan-2026",
          amcName
        ),
        null
      );
    });
  });

  // ────────────────────────────────────────────────────────────────
  // Single-line parsing (driven through real parseAmfiFeed)
  // ────────────────────────────────────────────────────────────────
  describe("single data line parsing", () => {
    const amcName = "HDFC Mutual Fund";

    it("should parse a valid data line", () => {
      const result = parseSingleLine(
        "119551;INF179K01CQ5;INF179K01CR3;HDFC Large Cap Fund - Direct Plan - Growth;850.25;31-Jan-2026",
        amcName
      );
      assert.ok(result !== null);
      assert.strictEqual(result!.schemeCode, "119551");
      assert.strictEqual(
        result!.schemeName,
        "HDFC Large Cap Fund - Direct Plan - Growth"
      );
      assert.strictEqual(result!.amcName, "HDFC Mutual Fund");
      assert.strictEqual(result!.nav, 850.25);
      assert.strictEqual(result!.isinGrowth, "INF179K01CQ5");
      assert.strictEqual(result!.isinDividend, "INF179K01CR3");
      assert.strictEqual(result!.category, "Large Cap");
      assert.strictEqual(result!.plan, "DIRECT");
      assert.strictEqual(result!.subCategory, "Growth");
    });

    it("should set isinGrowth to null when it's a dash '-'", () => {
      const result = parseSingleLine(
        "100;-;INE002;Fund - Direct Growth;25.5;31-Jan-2026",
        amcName
      );
      assert.ok(result !== null);
      assert.strictEqual(result!.isinGrowth, null);
    });

    it("should set isinDividend to null when it's a dash '-'", () => {
      const result = parseSingleLine(
        "100;INE001;-;Fund - Direct Growth;25.5;31-Jan-2026",
        amcName
      );
      assert.ok(result !== null);
      assert.strictEqual(result!.isinDividend, null);
    });

    it("should set both ISINs to null when empty", () => {
      const result = parseSingleLine(
        "100;;;Fund - Direct Growth;25.5;31-Jan-2026",
        amcName
      );
      assert.ok(result !== null);
      assert.strictEqual(result!.isinGrowth, null);
      assert.strictEqual(result!.isinDividend, null);
    });

    it("should skip the header line", () => {
      const result = parseSingleLine(
        "Scheme Code;ISIN Div Payout/ISIN Growth;ISIN Div Reinvestment;Scheme Name;Net Asset Value;Date",
        amcName
      );
      assert.strictEqual(result, null);
    });

    it("should skip an empty line", () => {
      assert.strictEqual(parseSingleLine("", amcName), null);
    });

    it("should skip a line with fewer than 5 fields", () => {
      assert.strictEqual(
        parseSingleLine("100;INE001;INE002;Fund", amcName),
        null
      );
    });

    it("should skip a line with an invalid date", () => {
      assert.strictEqual(
        parseSingleLine(
          "100;INE001;INE002;Fund Direct Growth;25.5;invalid-date",
          amcName
        ),
        null
      );
    });
  });

  // ────────────────────────────────────────────────────────────────
  // Full feed parsing (real parseAmfiFeed)
  // ────────────────────────────────────────────────────────────────
  describe("parseAmfiFeed (full feed parsing)", () => {
    it("should parse a complete AMFI feed sample", () => {
      const feed = [
        "Scheme Code;ISIN Div Payout/ISIN Growth;ISIN Div Reinvestment;Scheme Name;Net Asset Value;Date",
        "",
        "HDFC Mutual Fund",
        "119551;INF179K01CQ5;INF179K01CR3;HDFC Large Cap Fund - Direct Plan - Growth;850.25;31-Jan-2026",
        "119552;INF179K01CS1;-;HDFC Mid Cap Fund - Regular Plan - Growth;420.10;31-Jan-2026",
        "",
        "SBI Mutual Fund",
        "130503;INF200K01RA0;-;SBI Small Cap Fund - Direct Plan - Growth;175.50;31-Jan-2026",
      ].join("\n");

      const funds = parseAmfiFeed(feed);
      assert.strictEqual(funds.length, 3);

      assert.strictEqual(funds[0]!.schemeCode, "119551");
      assert.strictEqual(funds[0]!.amcName, "HDFC Mutual Fund");
      assert.strictEqual(funds[0]!.category, "Large Cap");

      assert.strictEqual(funds[1]!.schemeCode, "119552");
      assert.strictEqual(funds[1]!.amcName, "HDFC Mutual Fund");
      assert.strictEqual(funds[1]!.category, "Mid Cap");

      assert.strictEqual(funds[2]!.schemeCode, "130503");
      assert.strictEqual(funds[2]!.amcName, "SBI Mutual Fund");
      assert.strictEqual(funds[2]!.category, "Small Cap");
    });

    it("should skip entries with invalid NAV", () => {
      const feed = [
        SIX_COL_HEADER,
        "Test AMC",
        "100;INE001;INE002;Fund A - Direct Growth;25.5;31-Jan-2026",
        "101;INE003;INE004;Fund B - Direct Growth;N.A.;31-Jan-2026",
        "102;INE005;INE006;Fund C - Direct Growth;0;31-Jan-2026",
        "103;INE007;INE008;Fund D - Direct Growth;50.0;31-Jan-2026",
      ].join("\n");

      const funds = parseAmfiFeed(feed);
      assert.strictEqual(funds.length, 2);
      assert.strictEqual(funds[0]!.schemeCode, "100");
      assert.strictEqual(funds[1]!.schemeCode, "103");
    });

    it("should track AMC context across multiple AMC headers", () => {
      const feed = [
        SIX_COL_HEADER,
        "AMC One",
        "100;INE001;;Fund A - Direct Growth;25.5;31-Jan-2026",
        "AMC Two",
        "200;INE002;;Fund B - Regular Growth;50.0;31-Jan-2026",
        "AMC Three",
        "300;INE003;;Fund C - Direct Growth;75.0;31-Jan-2026",
      ].join("\n");

      const funds = parseAmfiFeed(feed);
      assert.strictEqual(funds.length, 3);
      assert.strictEqual(funds[0]!.amcName, "AMC One");
      assert.strictEqual(funds[1]!.amcName, "AMC Two");
      assert.strictEqual(funds[2]!.amcName, "AMC Three");
    });

    // ── CONTRACT CHANGE, MONEY-1403 ──────────────────────────────────────
    //
    // These two cases asserted `length === 0`. That contract is what the
    // outage was made of: AMFI moved two columns, every row failed to parse,
    // this function returned `[]`, and `mf-sync` reported
    // `parsed=0, upserted=0, failed=0` at exit 0 for 26 nights while 14,225
    // funds went stale. An empty array cannot distinguish "AMFI published
    // nothing" — which never happens, ~14,300 schemes publish daily — from
    // "we can no longer read this file".
    //
    // So an unreadable feed is now a NAMED throw. These assertions are
    // stricter than the ones they replace: they demand a specific error type,
    // where the old ones accepted any path that produced no rows.

    it("THROWS for a feed with only headers and no rows", () => {
      assert.throws(
        () => parseAmfiFeed(SIX_COL_HEADER),
        AmfiNavGrammarError,
        "a header with no rows is a broken download, not an empty market"
      );
    });

    it("THROWS for an empty feed", () => {
      assert.throws(
        () => parseAmfiFeed(""),
        AmfiNavGrammarError,
        "zero bytes from AMFI is a failed fetch, not a quiet day"
      );
    });
  });

  // ────────────────────────────────────────────────────────────────
  // AmfiSyncResult structure
  // ────────────────────────────────────────────────────────────────
  describe("AmfiSyncResult structure", () => {
    it("should have the correct shape with all required fields", () => {
      const result: AmfiSyncResult = {
        totalParsed: 0,
        upserted: 0,
        failed: 0,
        errors: [],
      };
      assert.strictEqual(result.totalParsed, 0);
      assert.strictEqual(result.upserted, 0);
      assert.strictEqual(result.failed, 0);
      assert.ok(Array.isArray(result.errors));
      assert.strictEqual(result.errors.length, 0);
    });

    it("should allow incrementing counters", () => {
      const result: AmfiSyncResult = {
        totalParsed: 100,
        upserted: 95,
        failed: 5,
        errors: ["100001: Connection error", "100002: Timeout"],
      };
      assert.strictEqual(result.totalParsed, 100);
      assert.strictEqual(result.upserted, 95);
      assert.strictEqual(result.failed, 5);
      assert.strictEqual(result.errors.length, 2);
      assert.ok(result.errors[0]!.includes("100001"));
    });

    it("should satisfy totalParsed = upserted + failed (invariant)", () => {
      const result: AmfiSyncResult = {
        totalParsed: 500,
        upserted: 485,
        failed: 15,
        errors: [],
      };
      assert.strictEqual(result.upserted + result.failed, result.totalParsed);
    });
  });

  // ────────────────────────────────────────────────────────────────
  // fetchAmfiNavFeed (REAL function, mocked global fetch)
  // ────────────────────────────────────────────────────────────────
  describe("fetchAmfiNavFeed (real fn, mocked fetch)", () => {
    it("should fetch + parse the AMFI feed into an AmfiMutualFund array", async () => {
      const feedText = [
        "Scheme Code;ISIN Div Payout/ISIN Growth;ISIN Div Reinvestment;Scheme Name;Net Asset Value;Date",
        "",
        "Test AMC",
        "100001;INF179K01AA1;-;Test Large Cap Fund - Direct Plan - Growth;125.50;31-Jan-2026",
      ].join("\n");

      const mockFetch = mock.fn(async () => ({
        ok: true,
        text: async () => feedText,
      }));
      const originalFetch = globalThis.fetch;
      globalThis.fetch = mockFetch as unknown as typeof fetch;

      try {
        const funds = await fetchAmfiNavFeed();
        assert.strictEqual(funds.length, 1);
        assert.strictEqual(funds[0]!.schemeCode, "100001");
        assert.strictEqual(
          funds[0]!.schemeName,
          "Test Large Cap Fund - Direct Plan - Growth"
        );
        assert.strictEqual(funds[0]!.amcName, "Test AMC");
        assert.strictEqual(funds[0]!.nav, 125.5);
        assert.strictEqual(funds[0]!.category, "Large Cap");
        assert.strictEqual(funds[0]!.plan, "DIRECT");
        assert.strictEqual(funds[0]!.subCategory, "Growth");
        assert.strictEqual(funds[0]!.isinGrowth, "INF179K01AA1");
        assert.strictEqual(funds[0]!.isinDividend, null);
        assert.strictEqual(mockFetch.mock.callCount(), 1);
      } finally {
        globalThis.fetch = originalFetch;
      }
    });

    it("should throw on a non-OK response", async () => {
      const mockFetch = mock.fn(async () => ({
        ok: false,
        status: 500,
        statusText: "Internal Server Error",
      }));
      const originalFetch = globalThis.fetch;
      globalThis.fetch = mockFetch as unknown as typeof fetch;

      try {
        await assert.rejects(
          () => fetchAmfiNavFeed(),
          /Failed to fetch AMFI NAV feed/
        );
      } finally {
        globalThis.fetch = originalFetch;
      }
    });
  });
});
