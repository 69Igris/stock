/**
 * Gemini Prompts Tests (packages/core)
 *
 * Exercises the REAL prompt utilities exported from
 * packages/core/src/gemini/prompts.ts (via `@usemoney/core/gemini`). No inline
 * reimplementation \u2014 `getSystemPrompt`, `getSupportedPages`, `hasCustomPrompt`,
 * `getBaseSystemPrompt`, `formatFireContext`, and `formatHoldingsContext` all
 * run the source code (incl. the real BASE_SYSTEM_PROMPT + PAGE_PROMPTS text)
 * asserted here. The `formatHoldingsContext` div-by-zero guard
 * (totalInvested === 0 -> "0.00%") is exercised against the real branch.
 *
 * Tests cover:
 *   - getSystemPrompt: page-specific and base prompt selection, userContext substitution
 *   - getSupportedPages: list of known page paths
 *   - hasCustomPrompt: true/false for known/unknown paths
 *   - getBaseSystemPrompt: base prompt content assertions
 *   - formatFireContext: scenario formatting with Indian number notation
 *   - formatHoldingsContext: portfolio summary calculations
 *
 * Source: packages/core/src/gemini/prompts.ts
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  getSystemPrompt,
  getSupportedPages,
  hasCustomPrompt,
  getBaseSystemPrompt,
  formatFireContext,
  formatHoldingsContext,
} from "@usemoney/core/gemini";

// Local fixture-only type aliases (mirror the source functions' inline
// parameter shapes \u2014 NOT a reimplementation of any logic).
type Holding = {
  currentValue?: number;
  investedValue?: number;
  sector?: string;
};

// ============================================================================
// Tests
// ============================================================================

describe("Gemini Prompts (real @usemoney/core exports)", () => {
  // ─────────────────── getSystemPrompt ───────────────────

  describe("getSystemPrompt", () => {
    it("should return base prompt for unknown page", () => {
      const prompt = getSystemPrompt({ pagePath: "/unknown-page" });
      assert.ok(prompt.includes("finance-focused AI assistant"));
      assert.ok(prompt.includes("CRITICAL RULES"));
    });

    it("should return base prompt for root path", () => {
      const prompt = getSystemPrompt({ pagePath: "/" });
      assert.ok(prompt.includes("finance-focused AI assistant"));
      assert.ok(!prompt.includes("CONTEXT:"));
    });

    it("should return FIRE prompt for /fire", () => {
      const prompt = getSystemPrompt({ pagePath: "/fire" });
      assert.ok(prompt.includes("FIRE Calculator Page"));
      assert.ok(prompt.includes("Financial Independence"));
      assert.ok(prompt.includes("LeanFIRE"));
      assert.ok(prompt.includes("FatFIRE"));
      assert.ok(prompt.includes("BaristaFIRE"));
      assert.ok(prompt.includes("CoastFIRE"));
      assert.ok(prompt.includes("4% rule"));
    });

    it("should return holdings prompt for /holdings", () => {
      const prompt = getSystemPrompt({ pagePath: "/holdings" });
      assert.ok(prompt.includes("Holdings Portfolio Page"));
      assert.ok(prompt.includes("Portfolio analysis"));
      assert.ok(prompt.includes("Sector allocation"));
      assert.ok(prompt.includes("Tax-loss harvesting"));
    });

    it("should return analysis prompt for /analysis", () => {
      const prompt = getSystemPrompt({ pagePath: "/analysis" });
      assert.ok(prompt.includes("AI Analysis Page"));
      assert.ok(prompt.includes("Fundamental analysis"));
      assert.ok(prompt.includes("Technical analysis"));
      assert.ok(prompt.includes("BUY/HOLD/SELL"));
    });

    it("should return tutor prompt for /tutor", () => {
      const prompt = getSystemPrompt({ pagePath: "/tutor" });
      assert.ok(prompt.includes("AI Trading Tutor Page"));
      assert.ok(prompt.includes("Socratic method"));
      assert.ok(prompt.includes("TEACHING STYLE"));
      assert.ok(prompt.includes("NO ACTIONS"));
    });

    it("should return tradebook prompt for /tradebook", () => {
      const prompt = getSystemPrompt({ pagePath: "/tradebook" });
      assert.ok(prompt.includes("Trading Journal Page"));
      assert.ok(prompt.includes("Win/loss ratio"));
      assert.ok(prompt.includes("Trading psychology"));
    });

    it("should return discover prompt for /discover", () => {
      const prompt = getSystemPrompt({ pagePath: "/discover" });
      assert.ok(prompt.includes("Stock Discovery Page"));
      assert.ok(prompt.includes("Stock screening"));
      assert.ok(prompt.includes("Small-cap/Mid-cap/Large-cap"));
    });

    it("should replace {userContext} placeholder when userContext provided", () => {
      const prompt = getSystemPrompt({
        pagePath: "/fire",
        userContext: "User is 30 years old with 5L corpus",
      });
      assert.ok(prompt.includes("User is 30 years old with 5L corpus"));
      assert.ok(!prompt.includes("{userContext}"));
    });

    it("should remove USER DATA CONTEXT section when no userContext", () => {
      const prompt = getSystemPrompt({ pagePath: "/fire" });
      assert.ok(!prompt.includes("{userContext}"));
      assert.ok(!prompt.includes("USER DATA CONTEXT:\n{userContext}"));
    });

    it("should leave userContext placeholder in pages that do not have it", () => {
      // /tradebook and /discover do not have {userContext} placeholder
      const prompt = getSystemPrompt({
        pagePath: "/tradebook",
        userContext: "some context",
      });
      // The replace call does nothing because there's no {userContext}
      assert.ok(!prompt.includes("some context"));
    });

    it("should replace userContext in /holdings prompt", () => {
      const prompt = getSystemPrompt({
        pagePath: "/holdings",
        userContext: "Total invested: 10L, PnL: +2L",
      });
      assert.ok(prompt.includes("Total invested: 10L, PnL: +2L"));
      assert.ok(!prompt.includes("{userContext}"));
    });

    it("should always include base prompt content in page-specific prompts", () => {
      const pages = [
        "/fire",
        "/holdings",
        "/analysis",
        "/tutor",
        "/tradebook",
        "/discover",
      ];
      for (const page of pages) {
        const prompt = getSystemPrompt({ pagePath: page });
        assert.ok(
          prompt.includes("CRITICAL RULES"),
          `${page} should include CRITICAL RULES`
        );
        assert.ok(
          prompt.includes("RESPONSE STYLE"),
          `${page} should include RESPONSE STYLE`
        );
      }
    });
  });

  // ─────────────────── getSupportedPages ───────────────────

  describe("getSupportedPages", () => {
    it("should return an array", () => {
      const pages = getSupportedPages();
      assert.ok(Array.isArray(pages));
    });

    it("should return exactly 6 supported pages", () => {
      const pages = getSupportedPages();
      assert.strictEqual(pages.length, 6);
    });

    it("should include /fire", () => {
      const pages = getSupportedPages();
      assert.ok(pages.includes("/fire"));
    });

    it("should include /holdings", () => {
      const pages = getSupportedPages();
      assert.ok(pages.includes("/holdings"));
    });

    it("should include /analysis", () => {
      const pages = getSupportedPages();
      assert.ok(pages.includes("/analysis"));
    });

    it("should include /tutor", () => {
      const pages = getSupportedPages();
      assert.ok(pages.includes("/tutor"));
    });

    it("should include /tradebook", () => {
      const pages = getSupportedPages();
      assert.ok(pages.includes("/tradebook"));
    });

    it("should include /discover", () => {
      const pages = getSupportedPages();
      assert.ok(pages.includes("/discover"));
    });

    it("should NOT include /dashboard", () => {
      const pages = getSupportedPages();
      assert.ok(!pages.includes("/dashboard"));
    });

    it("should NOT include root /", () => {
      const pages = getSupportedPages();
      assert.ok(!pages.includes("/"));
    });
  });

  // ─────────────────── hasCustomPrompt ───────────────────

  describe("hasCustomPrompt", () => {
    it("should return true for /fire", () => {
      assert.strictEqual(hasCustomPrompt("/fire"), true);
    });

    it("should return true for /holdings", () => {
      assert.strictEqual(hasCustomPrompt("/holdings"), true);
    });

    it("should return true for /analysis", () => {
      assert.strictEqual(hasCustomPrompt("/analysis"), true);
    });

    it("should return true for /tutor", () => {
      assert.strictEqual(hasCustomPrompt("/tutor"), true);
    });

    it("should return true for /tradebook", () => {
      assert.strictEqual(hasCustomPrompt("/tradebook"), true);
    });

    it("should return true for /discover", () => {
      assert.strictEqual(hasCustomPrompt("/discover"), true);
    });

    it("should return false for /dashboard", () => {
      assert.strictEqual(hasCustomPrompt("/dashboard"), false);
    });

    it("should return false for /settings", () => {
      assert.strictEqual(hasCustomPrompt("/settings"), false);
    });

    it("should return false for root /", () => {
      assert.strictEqual(hasCustomPrompt("/"), false);
    });

    it("should return false for empty string", () => {
      assert.strictEqual(hasCustomPrompt(""), false);
    });
  });

  // ─────────────────── getBaseSystemPrompt ───────────────────

  describe("getBaseSystemPrompt", () => {
    it("should contain CRITICAL RULES", () => {
      const prompt = getBaseSystemPrompt();
      assert.ok(prompt.includes("CRITICAL RULES"));
    });

    it("should contain RESPONSE STYLE", () => {
      const prompt = getBaseSystemPrompt();
      assert.ok(prompt.includes("RESPONSE STYLE"));
    });

    it("should mention Indian financial context", () => {
      const prompt = getBaseSystemPrompt();
      assert.ok(prompt.includes("Indian"));
      assert.ok(prompt.includes("NSE"));
      assert.ok(prompt.includes("BSE"));
    });

    it("should mention FIRE", () => {
      const prompt = getBaseSystemPrompt();
      assert.ok(prompt.includes("FIRE"));
    });

    it("should mention finance-focused AI assistant", () => {
      const prompt = getBaseSystemPrompt();
      assert.ok(prompt.includes("finance-focused AI assistant"));
    });

    it("should warn about non-finance topics", () => {
      const prompt = getBaseSystemPrompt();
      assert.ok(prompt.includes("politely decline"));
    });
  });

  // ─────────────────── formatFireContext ───────────────────

  describe("formatFireContext", () => {
    it("should return default message when no scenario", () => {
      const result = formatFireContext();
      assert.strictEqual(
        result,
        "No active scenario. User can create a new scenario."
      );
    });

    it("should return default message when scenario is undefined", () => {
      const result = formatFireContext(undefined);
      assert.strictEqual(
        result,
        "No active scenario. User can create a new scenario."
      );
    });

    it("should format scenario name", () => {
      const result = formatFireContext({ name: "My Retirement" });
      assert.ok(result.includes('Current Scenario: "My Retirement"'));
    });

    it("should format currentAge", () => {
      const result = formatFireContext({
        name: "Test",
        currentAge: 30,
      });
      assert.ok(result.includes("- Current Age: 30"));
    });

    it("should format retirementAge", () => {
      const result = formatFireContext({
        name: "Test",
        retirementAge: 55,
      });
      assert.ok(result.includes("- Retirement Age: 55"));
    });

    it("should format currentCorpus in Lakhs", () => {
      const result = formatFireContext({
        name: "Test",
        currentCorpus: 5000000, // 50 Lakhs
      });
      assert.ok(result.includes("50.00L"));
    });

    it("should format annualExpense in Lakhs", () => {
      const result = formatFireContext({
        name: "Test",
        annualExpense: 1200000, // 12 Lakhs
      });
      assert.ok(result.includes("12.00L"));
    });

    it("should format monthlySavings in K (thousands)", () => {
      const result = formatFireContext({
        name: "Test",
        monthlySavings: 50000,
      });
      assert.ok(result.includes("50K"));
    });

    it("should format fireNumber in Crores", () => {
      const result = formatFireContext({
        name: "Test",
        fireNumber: 30000000, // 3 Crore
      });
      assert.ok(result.includes("3.00Cr"));
    });

    it("should show 'Not calculated' when fireNumber is missing", () => {
      const result = formatFireContext({ name: "Test" });
      assert.ok(result.includes("FIRE Number:"));
      assert.ok(result.includes("Not calculated"));
    });

    it("should show 'Not calculated' when yearsToFire is missing", () => {
      const result = formatFireContext({ name: "Test" });
      assert.ok(result.includes("Years to FIRE: Not calculated"));
    });

    it("should format yearsToFire when provided", () => {
      const result = formatFireContext({
        name: "Test",
        yearsToFire: 15,
      });
      assert.ok(result.includes("Years to FIRE: 15"));
    });

    it("should default currentCorpus to 0 when undefined", () => {
      const result = formatFireContext({ name: "Test" });
      assert.ok(result.includes("0.00L"));
    });

    it("should default annualExpense to 0 when undefined", () => {
      const result = formatFireContext({ name: "Test" });
      // Both corpus and expense default to 0.00L
      const matches = result.match(/0\.00L/g);
      assert.ok(matches && matches.length >= 2);
    });

    it("should default monthlySavings to 0 when undefined", () => {
      const result = formatFireContext({ name: "Test" });
      assert.ok(result.includes("0K"));
    });

    it("should format a complete scenario correctly", () => {
      const result = formatFireContext({
        name: "Early Retirement",
        currentAge: 30,
        retirementAge: 45,
        currentCorpus: 2500000,
        annualExpense: 600000,
        monthlySavings: 75000,
        fireNumber: 15000000,
        yearsToFire: 12,
      });
      assert.ok(result.includes('Current Scenario: "Early Retirement"'));
      assert.ok(result.includes("- Current Age: 30"));
      assert.ok(result.includes("- Retirement Age: 45"));
      assert.ok(result.includes("25.00L"));
      assert.ok(result.includes("6.00L"));
      assert.ok(result.includes("75K"));
      assert.ok(result.includes("1.50Cr"));
      assert.ok(result.includes("Years to FIRE: 12"));
    });
  });

  // ─────────────────── formatHoldingsContext ───────────────────

  describe("formatHoldingsContext", () => {
    it("should return default message when no holdings", () => {
      const result = formatHoldingsContext();
      assert.strictEqual(
        result,
        "No holdings found. User can add holdings to their portfolio."
      );
    });

    it("should return default message for undefined", () => {
      const result = formatHoldingsContext(undefined);
      assert.strictEqual(
        result,
        "No holdings found. User can add holdings to their portfolio."
      );
    });

    it("should return default message for empty array", () => {
      const result = formatHoldingsContext([]);
      assert.strictEqual(
        result,
        "No holdings found. User can add holdings to their portfolio."
      );
    });

    it("should show total holdings count", () => {
      const holdings: Holding[] = [
        { currentValue: 100000, investedValue: 80000, sector: "IT" },
        { currentValue: 200000, investedValue: 150000, sector: "Banking" },
      ];
      const result = formatHoldingsContext(holdings);
      assert.ok(result.includes("Total Holdings: 2"));
    });

    it("should calculate total invested in Lakhs", () => {
      const holdings: Holding[] = [
        { currentValue: 300000, investedValue: 200000 },
        { currentValue: 400000, investedValue: 300000 },
      ];
      const result = formatHoldingsContext(holdings);
      // 500000 / 100000 = 5.00L
      assert.ok(result.includes("Total Invested:"));
      assert.ok(result.includes("5.00L"));
    });

    it("should calculate current value in Lakhs", () => {
      const holdings: Holding[] = [
        { currentValue: 300000, investedValue: 200000 },
        { currentValue: 400000, investedValue: 300000 },
      ];
      const result = formatHoldingsContext(holdings);
      // 700000 / 100000 = 7.00L
      assert.ok(result.includes("Current Value:"));
      assert.ok(result.includes("7.00L"));
    });

    it("should calculate P&L correctly", () => {
      const holdings: Holding[] = [
        { currentValue: 150000, investedValue: 100000 },
      ];
      const result = formatHoldingsContext(holdings);
      // PnL = 150000 - 100000 = 50000 -> 0.50L
      assert.ok(result.includes("0.50L"));
    });

    it("should calculate P&L percentage", () => {
      const holdings: Holding[] = [
        { currentValue: 150000, investedValue: 100000 },
      ];
      const result = formatHoldingsContext(holdings);
      // PnL% = (50000 / 100000) * 100 = 50.00%
      assert.ok(result.includes("50.00%"));
    });

    it("should handle negative P&L", () => {
      const holdings: Holding[] = [
        { currentValue: 80000, investedValue: 100000 },
      ];
      const result = formatHoldingsContext(holdings);
      // PnL = -20000 -> -0.20L
      assert.ok(result.includes("-0.20L"));
      assert.ok(result.includes("-20.00%"));
    });

    it("should show unique sectors", () => {
      const holdings: Holding[] = [
        { currentValue: 100000, investedValue: 80000, sector: "IT" },
        { currentValue: 200000, investedValue: 150000, sector: "Banking" },
        { currentValue: 150000, investedValue: 120000, sector: "IT" },
      ];
      const result = formatHoldingsContext(holdings);
      assert.ok(result.includes("IT"));
      assert.ok(result.includes("Banking"));
    });

    it("should show 'Not classified' when no sectors", () => {
      const holdings: Holding[] = [
        { currentValue: 100000, investedValue: 80000 },
      ];
      const result = formatHoldingsContext(holdings);
      assert.ok(result.includes("Not classified"));
    });

    it("should handle holdings with missing currentValue", () => {
      const holdings: Holding[] = [{ investedValue: 100000, sector: "IT" }];
      const result = formatHoldingsContext(holdings);
      assert.ok(result.includes("Total Holdings: 1"));
      // currentValue defaults to 0
      assert.ok(result.includes("Current Value:"));
    });

    it("should handle holdings with missing investedValue", () => {
      const holdings: Holding[] = [{ currentValue: 100000, sector: "IT" }];
      const result = formatHoldingsContext(holdings);
      assert.ok(result.includes("Total Holdings: 1"));
    });

    it("should handle zero invested value without division by zero", () => {
      const holdings: Holding[] = [{ currentValue: 100000 }];
      const result = formatHoldingsContext(holdings);
      // totalInvested = 0, pnlPercent should be "0.00"
      assert.ok(result.includes("0.00%"));
    });

    it("should filter out null/undefined sectors", () => {
      const holdings: Holding[] = [
        { currentValue: 100000, investedValue: 80000, sector: "IT" },
        { currentValue: 200000, investedValue: 150000 },
        { currentValue: 150000, investedValue: 120000, sector: undefined },
      ];
      const result = formatHoldingsContext(holdings);
      // Only "IT" should appear
      assert.ok(result.includes("IT"));
      assert.ok(!result.includes("undefined"));
    });

    it("should format a complete portfolio summary", () => {
      const holdings: Holding[] = [
        { currentValue: 500000, investedValue: 400000, sector: "IT" },
        { currentValue: 300000, investedValue: 250000, sector: "Pharma" },
        { currentValue: 200000, investedValue: 150000, sector: "Banking" },
      ];
      const result = formatHoldingsContext(holdings);
      assert.ok(result.includes("Portfolio Summary:"));
      assert.ok(result.includes("Total Holdings: 3"));
      // Invested: 800000 -> 8.00L
      assert.ok(result.includes("8.00L"));
      // Current: 1000000 -> 10.00L
      assert.ok(result.includes("10.00L"));
      // PnL: 200000 -> 2.00L
      assert.ok(result.includes("2.00L"));
      // PnL%: (200000/800000)*100 = 25.00%
      assert.ok(result.includes("25.00%"));
      assert.ok(result.includes("IT"));
      assert.ok(result.includes("Pharma"));
      assert.ok(result.includes("Banking"));
    });
  });
});
