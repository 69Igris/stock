/**
 * Markets - IndexCard formatters (MONEY-195).
 *
 * Pure formatting helpers extracted from
 * apps/web/app/discover/markets/components/IndexCard.tsx so the visual
 * regression surface (locale-specific commas, Unicode minus, signed pct)
 * has lock-in test coverage.
 *
 * Backfilled in Wave 0.5 of the MONEY-196 bundle.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

// De-shadowed: import the REAL formatters from IndexCard.tsx instead of
// re-implementing them inline. They are pure, exported helpers.
import {
  formatIndexValue,
  formatSignedChange,
  formatPctChange,
} from "@/app/discover/markets/components/IndexCard";

// ── Tests ──────────────────────────────────────────────────────────

describe("IndexCard formatters", () => {
  describe("formatIndexValue", () => {
    it("uses en-US grouping (NIFTY 50 ~24,687.55)", () => {
      assert.strictEqual(formatIndexValue(24687.55), "24,687.55");
    });

    it("pads small values to 2 decimals", () => {
      assert.strictEqual(formatIndexValue(100), "100.00");
    });

    it("truncates trailing decimals beyond 2", () => {
      assert.strictEqual(formatIndexValue(24687.5567), "24,687.56");
    });

    it("returns em-dash for non-finite", () => {
      assert.strictEqual(formatIndexValue(NaN), "-");
      assert.strictEqual(formatIndexValue(Infinity), "-");
    });

    it("does NOT use Indian lakh-crore grouping (sanity check)", () => {
      // en-IN would render this as "24,687.55" too because it's <100k.
      // The NIFTY value 1,00,000+ is what would expose the difference.
      const big = formatIndexValue(123456.78);
      assert.ok(
        big.startsWith("123,456"),
        `got "${big}" - expected en-US grouping not en-IN "1,23,456"`
      );
    });
  });

  describe("formatSignedChange", () => {
    it("prefixes positive with ASCII +", () => {
      assert.strictEqual(formatSignedChange(201.23), "+201.2");
    });

    it("prefixes negative with Unicode minus (U+2212), not ASCII hyphen", () => {
      const out = formatSignedChange(-116.34);
      assert.ok(out.startsWith("−"), `expected U+2212 minus, got "${out}"`);
      assert.strictEqual(out, "−116.3");
    });

    it("rounds to 1 decimal place", () => {
      assert.strictEqual(formatSignedChange(50.99), "+51.0");
    });

    it("returns em-dash for non-finite", () => {
      assert.strictEqual(formatSignedChange(NaN), "-");
    });

    it("formats zero as +0.0 (treats 0 as non-negative)", () => {
      assert.strictEqual(formatSignedChange(0), "+0.0");
    });
  });

  describe("formatPctChange", () => {
    it("prefixes positive with ASCII +", () => {
      assert.strictEqual(formatPctChange(0.82), "+0.82%");
    });

    it("prefixes negative with Unicode minus", () => {
      const out = formatPctChange(-0.14);
      assert.ok(out.startsWith("−"), `expected U+2212, got "${out}"`);
      assert.strictEqual(out, "−0.14%");
    });

    it("always shows 2 decimals", () => {
      assert.strictEqual(formatPctChange(1), "+1.00%");
      assert.strictEqual(formatPctChange(0.001), "+0.00%");
    });

    it("returns em-dash for non-finite", () => {
      assert.strictEqual(formatPctChange(NaN), "-");
      assert.strictEqual(formatPctChange(Infinity), "-");
    });
  });
});
