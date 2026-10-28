/**
 * MONEY-865 — regression tests for two UI-hidden bugs: the admin coupon list
 * showing "Active" for an exhausted/expired coupon, and the Undo button on a
 * coupon free-grant (the free-forever exploit). Exercises the REAL exports.
 *
 * Source: packages/services/src/coupon-logic.ts + subscription-logic.ts
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  couponDisplayStatus,
  buildDodoDiscountParams,
} from "../src/coupon-logic.ts";
import { canUndoScheduledChange } from "../src/subscription-logic.ts";

const NOW = new Date("2026-06-23T12:00:00Z");

describe("MONEY-865 couponDisplayStatus — exhausted/expired never reads Active", () => {
  it("active coupon with usage left → 'active'", () => {
    assert.equal(
      couponDisplayStatus(
        { isActive: true, maxUsage: 5, currentUsage: 2, expiresAt: null },
        NOW,
      ),
      "active",
    );
  });

  it("exhausted (currentUsage >= maxUsage) → 'exhausted' (the reported bug)", () => {
    assert.equal(
      couponDisplayStatus(
        { isActive: true, maxUsage: 1, currentUsage: 1, expiresAt: null },
        NOW,
      ),
      "exhausted",
    );
  });

  it("expired (expiresAt in the past) → 'expired'", () => {
    assert.equal(
      couponDisplayStatus(
        {
          isActive: true,
          maxUsage: null,
          currentUsage: 0,
          expiresAt: "2026-06-01T00:00:00Z",
        },
        NOW,
      ),
      "expired",
    );
  });

  it("future expiry + usage left → 'active'", () => {
    assert.equal(
      couponDisplayStatus(
        {
          isActive: true,
          maxUsage: 10,
          currentUsage: 0,
          expiresAt: "2026-12-31T00:00:00Z",
        },
        NOW,
      ),
      "active",
    );
  });

  it("admin-paused (isActive false) overrides exhausted/expired → 'paused'", () => {
    assert.equal(
      couponDisplayStatus(
        { isActive: false, maxUsage: 1, currentUsage: 1, expiresAt: null },
        NOW,
      ),
      "paused",
    );
  });

  it("unlimited maxUsage (null) is never exhausted", () => {
    assert.equal(
      couponDisplayStatus(
        { isActive: true, maxUsage: null, currentUsage: 9999, expiresAt: null },
        NOW,
      ),
      "active",
    );
  });

  it("exhausted takes precedence over expired", () => {
    assert.equal(
      couponDisplayStatus(
        {
          isActive: true,
          maxUsage: 1,
          currentUsage: 1,
          expiresAt: "2026-06-01T00:00:00Z",
        },
        NOW,
      ),
      "exhausted",
    );
  });
});

describe("MONEY-865 canUndoScheduledChange — coupon free-grant is NOT undoable", () => {
  it("paid cancellation (FREE schedule + Dodo sub) → undoable", () => {
    assert.equal(canUndoScheduledChange("FREE", "sub_123"), true);
  });

  it("paid downgrade (PRO schedule + Dodo sub) → undoable", () => {
    assert.equal(canUndoScheduledChange("PRO", "sub_123"), true);
  });

  it("coupon free-grant (FREE schedule, NO Dodo sub) → NOT undoable (free-forever exploit)", () => {
    assert.equal(canUndoScheduledChange("FREE", null), false);
    assert.equal(canUndoScheduledChange("FREE", undefined), false);
  });

  it("no scheduled change → not undoable (nothing to undo)", () => {
    assert.equal(canUndoScheduledChange(null, "sub_123"), false);
    assert.equal(canUndoScheduledChange(null, null), false);
  });
});

describe("MONEY-872 buildDodoDiscountParams — percentage-only (flat removed)", () => {
  it("percent → subscription_cycles:1 + basis points", () => {
    const p = buildDodoDiscountParams({ discountPercent: 20, code: "X" });
    assert.equal(p.subscription_cycles, 1);
    assert.equal(p.type, "percentage");
    assert.equal(p.amount, 2000); // 20% → 2000 bp
  });

  it("percent is clamped to 100 (never >10000 bp)", () => {
    const p = buildDodoDiscountParams({ discountPercent: 150, code: "X" });
    assert.equal(p.amount, 10000);
  });

  it("non-finite / negative percent floors to 0 bp (money-safety)", () => {
    assert.equal(
      buildDodoDiscountParams({ discountPercent: Number.NaN, code: "X" })
        .amount,
      0,
    );
    assert.equal(
      buildDodoDiscountParams({ discountPercent: -10, code: "X" }).amount,
      0,
    );
  });
});
