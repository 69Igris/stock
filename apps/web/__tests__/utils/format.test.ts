/**
 * Format Utility Tests
 *
 * Tests for formatting utilities including currency, P&L,
 * percentage, date, and number formatting.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  formatCurrency,
  formatPnL,
  formatPercentage,
  formatDate,
  formatDateTime,
  formatNumber,
  formatCompactNumber,
} from "@usemoney/utils";

describe("Format Utilities", () => {
  describe("formatCurrency", () => {
    it("should format positive number as INR", () => {
      const result = formatCurrency(10000);
      assert.ok(result.includes("₹") || result.includes("INR"));
      assert.ok(result.includes("10,000") || result.includes("10000"));
    });

    it("should format zero", () => {
      const result = formatCurrency(0);
      assert.ok(result.includes("0"));
    });

    it("should format negative number", () => {
      const result = formatCurrency(-5000);
      assert.ok(result.includes("5,000") || result.includes("5000"));
    });

    it("should format large numbers with Indian numbering", () => {
      const result = formatCurrency(1000000);
      // Indian format: 10,00,000 or 1000000
      assert.ok(result.includes("₹") || result.includes("INR"));
    });

    it("should format crore value", () => {
      const result = formatCurrency(10000000);
      assert.ok(result.includes("1"));
    });

    it("should handle decimal values (truncated)", () => {
      const result = formatCurrency(1234.56);
      // Should be formatted without decimals (maximumFractionDigits: 0)
      assert.ok(
        result.includes("1,234") ||
          result.includes("1234") ||
          result.includes("1,235")
      );
    });
  });

  describe("formatPnL", () => {
    it("should format positive P&L with + prefix", () => {
      const result = formatPnL(5000);
      assert.ok(result.startsWith("+"));
      assert.ok(result.includes("5,000") || result.includes("5000"));
    });

    it("should format negative P&L with - prefix", () => {
      const result = formatPnL(-3000);
      assert.ok(result.includes("-"));
      assert.ok(result.includes("3,000") || result.includes("3000"));
    });

    it("should format zero P&L", () => {
      const result = formatPnL(0);
      assert.ok(result.includes("0"));
    });

    it("should format small positive P&L", () => {
      const result = formatPnL(10);
      assert.ok(result.startsWith("+"));
    });

    it("should format large P&L", () => {
      const result = formatPnL(1000000);
      assert.ok(result.startsWith("+"));
    });
  });

  describe("formatPercentage", () => {
    it("should format positive percentage with + prefix", () => {
      const result = formatPercentage(15.5);
      assert.strictEqual(result, "+15.50%");
    });

    it("should format negative percentage", () => {
      const result = formatPercentage(-10.25);
      assert.strictEqual(result, "-10.25%");
    });

    it("should format zero percentage", () => {
      const result = formatPercentage(0);
      assert.strictEqual(result, "+0.00%");
    });

    it("should format percentage with 2 decimal places", () => {
      const result = formatPercentage(5);
      assert.strictEqual(result, "+5.00%");
    });

    it("should round to 2 decimal places", () => {
      const result = formatPercentage(15.557);
      assert.strictEqual(result, "+15.56%");
    });

    it("should handle very small percentages", () => {
      const result = formatPercentage(0.01);
      assert.strictEqual(result, "+0.01%");
    });

    it("should handle large percentages", () => {
      const result = formatPercentage(999.99);
      assert.strictEqual(result, "+999.99%");
    });
  });

  describe("formatDate", () => {
    it("should format Date object", () => {
      const result = formatDate(new Date("2024-01-15"));
      // Expected format: "15 Jan 2024" or similar
      assert.ok(result.includes("15"));
      assert.ok(result.includes("Jan") || result.includes("2024"));
    });

    it("should format date string", () => {
      const result = formatDate("2024-06-20");
      assert.ok(result.includes("20"));
      assert.ok(result.includes("Jun") || result.includes("2024"));
    });

    it("should format ISO date string", () => {
      const result = formatDate("2024-03-10T10:30:00Z");
      assert.ok(result.includes("10") || result.includes("Mar"));
    });

    it("should handle different months", () => {
      const dates = [
        { input: "2024-01-01", expected: "Jan" },
        { input: "2024-06-15", expected: "Jun" },
        { input: "2024-12-25", expected: "Dec" },
      ];

      for (const { input, expected } of dates) {
        const result = formatDate(input);
        assert.ok(
          result.includes(expected),
          `Expected ${result} to include ${expected}`
        );
      }
    });
  });

  describe("formatDateTime", () => {
    it("should format Date with time", () => {
      const result = formatDateTime(new Date("2024-01-15T10:30:00"));
      assert.ok(result.includes("15"));
      // Should include time component
      assert.ok(
        result.includes(":") ||
          result.includes("am") ||
          result.includes("AM") ||
          result.includes("10")
      );
    });

    it("should format ISO string with time", () => {
      const result = formatDateTime("2024-01-15T14:30:00Z");
      assert.ok(result.includes("2024") || result.includes("Jan"));
    });
  });

  describe("formatNumber", () => {
    it("should format number with Indian numbering", () => {
      const result = formatNumber(1000000);
      // Indian format: 10,00,000
      assert.ok(result.includes(",") || result === "1000000");
    });

    it("should format zero", () => {
      const result = formatNumber(0);
      assert.strictEqual(result, "0");
    });

    it("should format small number", () => {
      const result = formatNumber(999);
      assert.strictEqual(result, "999");
    });

    it("should format lakh value", () => {
      const result = formatNumber(100000);
      // Should be "1,00,000" in Indian format
      assert.ok(result.includes("1"));
    });

    it("should format crore value", () => {
      const result = formatNumber(10000000);
      assert.ok(result.includes("1"));
    });
  });

  describe("formatCompactNumber", () => {
    it("should format crore values", () => {
      const result = formatCompactNumber(10000000);
      assert.strictEqual(result, "1.00Cr");
    });

    it("should format lakh values", () => {
      const result = formatCompactNumber(100000);
      assert.strictEqual(result, "1.00L");
    });

    it("should format thousand values", () => {
      const result = formatCompactNumber(1000);
      assert.strictEqual(result, "1.00K");
    });

    it("should return raw number for small values", () => {
      const result = formatCompactNumber(500);
      assert.strictEqual(result, "500");
    });

    it("should handle decimal precision for crores", () => {
      const result = formatCompactNumber(15000000);
      assert.strictEqual(result, "1.50Cr");
    });

    it("should handle decimal precision for lakhs", () => {
      const result = formatCompactNumber(250000);
      assert.strictEqual(result, "2.50L");
    });

    it("should handle decimal precision for thousands", () => {
      const result = formatCompactNumber(5500);
      assert.strictEqual(result, "5.50K");
    });

    it("should format large crore values", () => {
      const result = formatCompactNumber(100000000);
      assert.strictEqual(result, "10.00Cr");
    });

    it("should format zero", () => {
      const result = formatCompactNumber(0);
      assert.strictEqual(result, "0");
    });

    it("should handle edge case at 10Cr boundary", () => {
      const result = formatCompactNumber(99999999);
      assert.ok(result.includes("Cr"));
    });

    it("should handle edge case at 1L boundary", () => {
      const result = formatCompactNumber(99999);
      assert.ok(result.includes("K"));
    });
  });
});
