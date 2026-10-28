/**
 * Unit tests for the savings-format helpers used by the toggle "Save X%"
 * badge, the strikethrough monthly-annualised price on the Annual card,
 * and the cycle-aware launch-discount badge (MONEY-438 / MONEY-482).
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  formatSavingsPct,
  formatSavingsAbsolute,
  formatMonthlyAnnualised,
  formatLaunchDiscount,
} from "../../lib/pricing/savings-format";

describe("savings-format / formatSavingsPct", () => {
  it("PRO Monthly→Annual (249 vs 1999) ≈ 33%", () => {
    assert.equal(
      formatSavingsPct({ monthlyPrice: 249, annualPrice: 1999 }),
      "33%"
    );
  });

  it("Premium Monthly→Annual (1499 vs 14999) ≈ 17%", () => {
    assert.equal(
      formatSavingsPct({ monthlyPrice: 1499, annualPrice: 14999 }),
      "17%"
    );
  });

  it("returns null when annual is not actually cheaper than monthly × 12", () => {
    assert.equal(
      formatSavingsPct({ monthlyPrice: 100, annualPrice: 1500 }),
      null
    );
  });

  it("returns null for null / zero / NaN inputs", () => {
    assert.equal(
      formatSavingsPct({ monthlyPrice: null, annualPrice: 1999 }),
      null
    );
    assert.equal(formatSavingsPct({ monthlyPrice: 249, annualPrice: 0 }), null);
    assert.equal(
      formatSavingsPct({ monthlyPrice: NaN, annualPrice: 1999 }),
      null
    );
  });
});

describe("savings-format / formatSavingsAbsolute", () => {
  it("Indian-number-formatted savings", () => {
    // 249 × 12 = 2988; saved = 2988 − 1999 = 989
    assert.equal(
      formatSavingsAbsolute({ monthlyPrice: 249, annualPrice: 1999 }),
      "₹989"
    );
  });

  it("formats with lakh comma separator", () => {
    // 1499 × 12 = 17988; saved = 17988 − 14999 = 2989
    assert.equal(
      formatSavingsAbsolute({ monthlyPrice: 1499, annualPrice: 14999 }),
      "₹2,989"
    );
  });

  it("returns null when annual is not cheaper than monthly × 12", () => {
    assert.equal(
      formatSavingsAbsolute({ monthlyPrice: 100, annualPrice: 1200 }),
      null
    );
  });

  it("returns null for invalid inputs", () => {
    assert.equal(
      formatSavingsAbsolute({ monthlyPrice: 0, annualPrice: 1999 }),
      null
    );
    assert.equal(
      formatSavingsAbsolute({ monthlyPrice: 249, annualPrice: null }),
      null
    );
  });
});

describe("savings-format / formatMonthlyAnnualised", () => {
  it("249 × 12 = ₹2,988", () => {
    assert.equal(formatMonthlyAnnualised(249), "₹2,988");
  });

  it("999 × 12 = ₹11,988", () => {
    assert.equal(formatMonthlyAnnualised(999), "₹11,988");
  });

  it("returns null for null / zero / NaN", () => {
    assert.equal(formatMonthlyAnnualised(null), null);
    assert.equal(formatMonthlyAnnualised(undefined), null);
    assert.equal(formatMonthlyAnnualised(0), null);
    assert.equal(formatMonthlyAnnualised(NaN), null);
  });
});

describe("savings-format / formatLaunchDiscount", () => {
  it("PRO Monthly 249 vs 499 list = 50% OFF", () => {
    assert.equal(formatLaunchDiscount(249, 499), "50% OFF");
  });

  it("PRO Annual 1999 vs 4999 list = 60% OFF", () => {
    assert.equal(formatLaunchDiscount(1999, 4999), "60% OFF");
  });

  it("Premium Monthly 1499 vs 2999 list = 50% OFF", () => {
    assert.equal(formatLaunchDiscount(1499, 2999), "50% OFF");
  });

  it("Premium Annual 14999 vs 30000 list = 50% OFF", () => {
    assert.equal(formatLaunchDiscount(14999, 30000), "50% OFF");
  });

  it("returns null when original equals current (no discount)", () => {
    assert.equal(formatLaunchDiscount(249, 249), null);
  });

  it("returns null when original is lower than current (would be a markup)", () => {
    assert.equal(formatLaunchDiscount(499, 249), null);
  });

  it("returns null for missing or invalid inputs", () => {
    assert.equal(formatLaunchDiscount(null, 499), null);
    assert.equal(formatLaunchDiscount(249, undefined), null);
    assert.equal(formatLaunchDiscount(0, 499), null);
    assert.equal(formatLaunchDiscount(NaN, 499), null);
  });
});
