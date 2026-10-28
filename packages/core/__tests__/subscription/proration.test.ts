/**
 * Unit tests for the MONEY-482 proration helper.
 *
 * Covers each row of the worked-examples table in the ticket plus the
 * edge cases enumerated there. Numbers below mirror the launch-offer
 * list prices in packages/core/plans.ts at time of writing:
 *
 *   PRO     monthlyOriginalPrice = 499      annualOriginalPrice = 4999
 *   PREMIUM monthlyOriginalPrice = 2999     annualOriginalPrice = 30000
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  STANDARD_TERM_DAYS,
  daysRemaining,
  listPricePerDay,
  computeTierUpgradeBonusDays,
  computeCycleAppendDays,
  classifyTransition,
} from "../../src/subscription/proration";

// List prices used across the test suite. Lifted out of @usemoney/core
// so the tests stay deterministic even if marketing prices move; the
// proration contract is the *list* price, never the discounted price.
const PRO = {
  monthlyOriginalPrice: 499,
  annualOriginalPrice: 4999,
};
const PREMIUM = {
  monthlyOriginalPrice: 2999,
  annualOriginalPrice: 30000,
};

describe("proration / STANDARD_TERM_DAYS", () => {
  it("monthly is 30 days, annual is 365 days", () => {
    assert.equal(STANDARD_TERM_DAYS.monthly, 30);
    assert.equal(STANDARD_TERM_DAYS.annual, 365);
  });
});

describe("proration / daysRemaining", () => {
  const now = new Date("2026-05-01T00:00:00.000Z");

  it("returns 0 for null currentPeriodEnd", () => {
    assert.equal(daysRemaining(now, null), 0);
    assert.equal(daysRemaining(now, undefined), 0);
  });

  it("returns 0 for expired terms (already past)", () => {
    const yesterday = new Date("2026-04-30T00:00:00.000Z");
    assert.equal(daysRemaining(now, yesterday), 0);
  });

  it("returns the ceiling number of whole days remaining", () => {
    // Exactly 10 days later
    assert.equal(daysRemaining(now, new Date("2026-05-11T00:00:00.000Z")), 10);
    // 10 days + 1 hour → rounds up to 11
    assert.equal(daysRemaining(now, new Date("2026-05-11T01:00:00.000Z")), 11);
    // 365 days
    assert.equal(daysRemaining(now, new Date("2027-05-01T00:00:00.000Z")), 365);
  });
});

describe("proration / listPricePerDay", () => {
  it("PRO monthly = 499 / 30 ≈ 16.633...", () => {
    const rate = listPricePerDay(PRO, "monthly");
    assert.ok(rate != null);
    assert.ok(Math.abs(rate - 499 / 30) < 1e-9);
  });

  it("PRO annual = 4999 / 365 ≈ 13.696...", () => {
    const rate = listPricePerDay(PRO, "annual");
    assert.ok(rate != null);
    assert.ok(Math.abs(rate - 4999 / 365) < 1e-9);
  });

  it("PREMIUM monthly = 2999 / 30 ≈ 99.966...", () => {
    const rate = listPricePerDay(PREMIUM, "monthly");
    assert.ok(rate != null);
    assert.ok(Math.abs(rate - 2999 / 30) < 1e-9);
  });

  it("PREMIUM annual = 30000 / 365 ≈ 82.191...", () => {
    const rate = listPricePerDay(PREMIUM, "annual");
    assert.ok(rate != null);
    assert.ok(Math.abs(rate - 30000 / 365) < 1e-9);
  });

  it("returns null when no list price is configured", () => {
    assert.equal(
      listPricePerDay({ monthlyOriginalPrice: undefined }, "monthly"),
      null,
    );
    assert.equal(listPricePerDay({ annualOriginalPrice: 0 }, "annual"), null);
  });
});

describe("proration / computeTierUpgradeBonusDays — worked examples", () => {
  // Each entry mirrors a row of the worked-examples table in MONEY-482.

  it("Pro M (10 days left) → Premium M = 2 bonus days, 32-day term", () => {
    const r = computeTierUpgradeBonusDays({
      fromPlan: PRO,
      fromCycle: "monthly",
      toPlan: PREMIUM,
      toCycle: "monthly",
      daysRemainingOnCurrent: 10,
    });
    // remainingCredit = 10 × 16.633 ≈ 166.33
    assert.ok(Math.abs(r.remainingCredit - (10 * 499) / 30) < 1e-9);
    // bonusDays = ceil(166.33 / 99.966) = ceil(1.66...) = 2
    assert.equal(r.bonusDays, 2);
    assert.equal(r.totalTermDays, 32);
  });

  it("Pro M (10 days left) → Premium A = 3 bonus days, 368-day term", () => {
    const r = computeTierUpgradeBonusDays({
      fromPlan: PRO,
      fromCycle: "monthly",
      toPlan: PREMIUM,
      toCycle: "annual",
      daysRemainingOnCurrent: 10,
    });
    // bonusDays = ceil(166.33 / (30000/365)) = ceil(2.02) = 3
    assert.equal(r.bonusDays, 3);
    assert.equal(r.totalTermDays, 368);
  });

  it("Pro A (100 days left) → Premium A = 17 bonus days, 382-day term", () => {
    const r = computeTierUpgradeBonusDays({
      fromPlan: PRO,
      fromCycle: "annual",
      toPlan: PREMIUM,
      toCycle: "annual",
      daysRemainingOnCurrent: 100,
    });
    // remainingCredit = 100 × 13.696 ≈ 1369.59
    // bonusDays = ceil(1369.59 / 82.191) = ceil(16.66) = 17
    assert.equal(r.bonusDays, 17);
    assert.equal(r.totalTermDays, 382);
  });

  it("Pro A (100 days left) → Premium M = 14 bonus days, 44-day term", () => {
    const r = computeTierUpgradeBonusDays({
      fromPlan: PRO,
      fromCycle: "annual",
      toPlan: PREMIUM,
      toCycle: "monthly",
      daysRemainingOnCurrent: 100,
    });
    // bonusDays = ceil(1369.59 / 99.966) = ceil(13.70) = 14
    assert.equal(r.bonusDays, 14);
    assert.equal(r.totalTermDays, 44);
  });

  it("Pro M (1 day left) → Premium M = 1 bonus day (Math.ceil minimum)", () => {
    const r = computeTierUpgradeBonusDays({
      fromPlan: PRO,
      fromCycle: "monthly",
      toPlan: PREMIUM,
      toCycle: "monthly",
      daysRemainingOnCurrent: 1,
    });
    // remainingCredit = 1 × 16.633 ≈ 16.633
    // bonusDays = ceil(16.633 / 99.966) = ceil(0.166) = 1
    assert.equal(r.bonusDays, 1);
    assert.equal(r.totalTermDays, 31);
  });

  it("Zero days remaining → 0 bonus days (safe path)", () => {
    const r = computeTierUpgradeBonusDays({
      fromPlan: PRO,
      fromCycle: "monthly",
      toPlan: PREMIUM,
      toCycle: "monthly",
      daysRemainingOnCurrent: 0,
    });
    assert.equal(r.remainingCredit, 0);
    assert.equal(r.bonusDays, 0);
    assert.equal(r.totalTermDays, 30);
  });

  it("Throws on negative daysRemaining", () => {
    assert.throws(() =>
      computeTierUpgradeBonusDays({
        fromPlan: PRO,
        fromCycle: "monthly",
        toPlan: PREMIUM,
        toCycle: "monthly",
        daysRemainingOnCurrent: -3,
      }),
    );
  });

  it("Throws when either side has no list price", () => {
    assert.throws(() =>
      computeTierUpgradeBonusDays({
        fromPlan: { monthlyOriginalPrice: undefined } as never,
        fromCycle: "monthly",
        toPlan: PREMIUM,
        toCycle: "monthly",
        daysRemainingOnCurrent: 10,
      }),
    );
  });
});

describe("proration / computeCycleAppendDays (same-tier M→A)", () => {
  it("22 days remaining on monthly → annual term = 387 days", () => {
    const r = computeCycleAppendDays(22);
    assert.equal(r.bonusDays, 22);
    assert.equal(r.totalTermDays, 365 + 22);
  });

  it("0 days remaining → no append, annual term = 365 days", () => {
    const r = computeCycleAppendDays(0);
    assert.equal(r.bonusDays, 0);
    assert.equal(r.totalTermDays, 365);
  });

  it("Negative input is floored at 0 (defensive)", () => {
    const r = computeCycleAppendDays(-5);
    assert.equal(r.bonusDays, 0);
    assert.equal(r.totalTermDays, 365);
  });
});

describe("proration / classifyTransition", () => {
  it("noop for same plan+cycle", () => {
    assert.equal(
      classifyTransition("PRO", "monthly", "PRO", "monthly"),
      "noop",
    );
  });

  it("first_purchase: FREE → paid tier", () => {
    assert.equal(
      classifyTransition("FREE", null, "PRO", "monthly"),
      "first_purchase",
    );
    assert.equal(
      classifyTransition("FREE", null, "PREMIUM", "annual"),
      "first_purchase",
    );
  });

  it("cancel: any paid tier → FREE", () => {
    assert.equal(classifyTransition("PRO", "monthly", "FREE", null), "cancel");
    assert.equal(
      classifyTransition("PREMIUM", "annual", "FREE", null),
      "cancel",
    );
  });

  it("cycle_append: same tier monthly → annual", () => {
    assert.equal(
      classifyTransition("PRO", "monthly", "PRO", "annual"),
      "cycle_append",
    );
    assert.equal(
      classifyTransition("PREMIUM", "monthly", "PREMIUM", "annual"),
      "cycle_append",
    );
  });

  it("cycle_downgrade: same tier annual → monthly", () => {
    assert.equal(
      classifyTransition("PRO", "annual", "PRO", "monthly"),
      "cycle_downgrade",
    );
    assert.equal(
      classifyTransition("PREMIUM", "annual", "PREMIUM", "monthly"),
      "cycle_downgrade",
    );
  });

  it("tier_upgrade: PRO → PREMIUM (either cycle)", () => {
    assert.equal(
      classifyTransition("PRO", "monthly", "PREMIUM", "monthly"),
      "tier_upgrade",
    );
    assert.equal(
      classifyTransition("PRO", "annual", "PREMIUM", "annual"),
      "tier_upgrade",
    );
    assert.equal(
      classifyTransition("PRO", "monthly", "PREMIUM", "annual"),
      "tier_upgrade",
    );
    assert.equal(
      classifyTransition("PRO", "annual", "PREMIUM", "monthly"),
      "tier_upgrade",
    );
  });

  it("tier_downgrade: PREMIUM → PRO (either cycle)", () => {
    assert.equal(
      classifyTransition("PREMIUM", "monthly", "PRO", "monthly"),
      "tier_downgrade",
    );
    assert.equal(
      classifyTransition("PREMIUM", "annual", "PRO", "annual"),
      "tier_downgrade",
    );
  });
});
