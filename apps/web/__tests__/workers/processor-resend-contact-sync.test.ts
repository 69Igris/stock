/**
 * Resend Contact Sync Processor Tests (workers/src/processors/resend-contact-sync.ts)
 *
 * De-shadowed: imports the REAL pure exports from
 * `workers/src/processors/resend-contact-sync-logic.ts`, which the processor
 * itself calls. The former inline `classifySegment` / `splitName` /
 * `shouldSyncToMarketing` / `shouldLogProgress` were a shadow — and the inline
 * `shouldLogProgress` used the WRONG interval (`% 50`) while the source logs
 * every `% 100`, so it asserted a value the production code never used.
 *
 * Covers:
 *   - PAID_PLANS set membership
 *   - isPaidSubscription (active + paid plan only)
 *   - resolveTargetTier (paid / downgraded / free)
 *   - splitName (firstName / lastName)
 *   - shouldSyncToMarketing (explicit boolean consent only)
 *   - shouldLogProgress (real PROGRESS_LOG_INTERVAL = 100)
 *   - RATE_LIMIT_MS constant
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  PAID_PLANS,
  RATE_LIMIT_MS,
  PROGRESS_LOG_INTERVAL,
  isPaidSubscription,
  resolveTargetTier,
  splitName,
  shouldSyncToMarketing,
  shouldLogProgress,
} from "../../../../workers/src/processors/resend-contact-sync-logic";

describe("Workers - Processor: Resend Contact Sync", () => {
  describe("Constants (real exports)", () => {
    it("PAID_PLANS should contain PRO / PREMIUM / ULTIMATE", () => {
      assert.strictEqual(PAID_PLANS.has("PRO"), true);
      assert.strictEqual(PAID_PLANS.has("PREMIUM"), true);
      assert.strictEqual(PAID_PLANS.has("ULTIMATE"), true);
    });

    it("PAID_PLANS should NOT contain FREE / TRIAL", () => {
      assert.strictEqual(PAID_PLANS.has("FREE"), false);
      assert.strictEqual(PAID_PLANS.has("TRIAL"), false);
    });

    it("RATE_LIMIT_MS should be 125 (8 req/sec)", () => {
      assert.strictEqual(RATE_LIMIT_MS, 125);
    });
  });

  describe("isPaidSubscription (real export)", () => {
    it("ACTIVE + paid plan → true", () => {
      assert.strictEqual(
        isPaidSubscription({ planId: "PRO", status: "ACTIVE" }),
        true
      );
      assert.strictEqual(
        isPaidSubscription({ planId: "PREMIUM", status: "ACTIVE" }),
        true
      );
      assert.strictEqual(
        isPaidSubscription({ planId: "ULTIMATE", status: "ACTIVE" }),
        true
      );
    });

    it("ACTIVE FREE → false", () => {
      assert.strictEqual(
        isPaidSubscription({ planId: "FREE", status: "ACTIVE" }),
        false
      );
    });

    it("CANCELLED / EXPIRED paid plan → false", () => {
      assert.strictEqual(
        isPaidSubscription({ planId: "PRO", status: "CANCELLED" }),
        false
      );
      assert.strictEqual(
        isPaidSubscription({ planId: "PREMIUM", status: "EXPIRED" }),
        false
      );
    });

    it("null / undefined subscription → false", () => {
      assert.strictEqual(isPaidSubscription(null), false);
      assert.strictEqual(isPaidSubscription(undefined), false);
    });
  });

  describe("resolveTargetTier (real export)", () => {
    const paid = { planId: "PRO", status: "ACTIVE" };
    const free = { planId: "FREE", status: "ACTIVE" };

    it("active paid → 'paid' (regardless of payment history / config)", () => {
      assert.strictEqual(resolveTargetTier(paid, false, false), "paid");
      assert.strictEqual(resolveTargetTier(paid, true, true), "paid");
    });

    it("not-paid + has-ever-paid + downgraded configured → 'downgraded'", () => {
      assert.strictEqual(resolveTargetTier(free, true, true), "downgraded");
      assert.strictEqual(resolveTargetTier(null, true, true), "downgraded");
    });

    it("has-ever-paid but downgraded NOT configured → 'free' (stays in free)", () => {
      assert.strictEqual(resolveTargetTier(free, true, false), "free");
    });

    it("never paid → 'free'", () => {
      assert.strictEqual(resolveTargetTier(free, false, true), "free");
      assert.strictEqual(resolveTargetTier(null, false, true), "free");
    });
  });

  describe("splitName (real export)", () => {
    it("single-word name → firstName only", () => {
      const { firstName, lastName } = splitName("Shaswat");
      assert.strictEqual(firstName, "Shaswat");
      assert.strictEqual(lastName, undefined);
    });

    it("two-word name → firstName + lastName", () => {
      const { firstName, lastName } = splitName("Shaswat Deep");
      assert.strictEqual(firstName, "Shaswat");
      assert.strictEqual(lastName, "Deep");
    });

    it("multi-word last name is preserved", () => {
      const { firstName, lastName } = splitName("John van der Berg");
      assert.strictEqual(firstName, "John");
      assert.strictEqual(lastName, "van der Berg");
    });

    it("empty / null / undefined → both undefined", () => {
      for (const v of ["", null, undefined]) {
        const { firstName, lastName } = splitName(v);
        assert.strictEqual(firstName, undefined);
        assert.strictEqual(lastName, undefined);
      }
    });
  });

  describe("shouldSyncToMarketing (real export)", () => {
    it("marketingEmails === true → true", () => {
      assert.strictEqual(
        shouldSyncToMarketing({ marketingEmails: true }),
        true
      );
    });

    it("marketingEmails === false → false", () => {
      assert.strictEqual(
        shouldSyncToMarketing({ marketingEmails: false }),
        false
      );
    });

    it("null / undefined preferences → false (no consent)", () => {
      assert.strictEqual(shouldSyncToMarketing(null), false);
      assert.strictEqual(shouldSyncToMarketing(undefined), false);
    });

    it("missing key → false", () => {
      assert.strictEqual(shouldSyncToMarketing({ otherPref: true }), false);
    });

    it("STRICT boolean: truthy non-boolean ('true' / 1) → false", () => {
      assert.strictEqual(
        shouldSyncToMarketing({ marketingEmails: "true" }),
        false
      );
      assert.strictEqual(shouldSyncToMarketing({ marketingEmails: 1 }), false);
    });
  });

  describe("shouldLogProgress (real export — interval = 100, not 50)", () => {
    it("PROGRESS_LOG_INTERVAL is 100", () => {
      assert.strictEqual(PROGRESS_LOG_INTERVAL, 100);
    });

    it("logs on the 100th user (index 99) and 200th (index 199)", () => {
      assert.strictEqual(shouldLogProgress(99), true);
      assert.strictEqual(shouldLogProgress(199), true);
    });

    it("does NOT log at the 50th user (index 49) — the old shadow's wrong interval", () => {
      assert.strictEqual(shouldLogProgress(49), false);
    });

    it("does not log at index 0 / 98 / 100", () => {
      assert.strictEqual(shouldLogProgress(0), false);
      assert.strictEqual(shouldLogProgress(98), false);
      assert.strictEqual(shouldLogProgress(100), false);
    });
  });
});
