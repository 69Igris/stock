/**
 * User Action Tests
 *
 * Tests for user-related trial logic.
 *
 * MONEY-620 DE-SHADOW: this file previously re-declared `calculateTrialInfo`
 * inline ("INLINE LOGIC (mirrors user.ts ...)") and asserted the copy — a
 * SHADOW (green while the real code could diverge). The trial math is now the
 * REAL exported `calculateTrialInfo` from the service layer
 * (`packages/services/src/user-logic.ts`), which `getAccountTrialInfo` in
 * `user.service.ts` (and `getAccountTrialInfoAction`) call in production. We
 * import and assert THAT symbol, so a regression in the live path fails here.
 *
 * Covers:
 * - Trial calculation: days since creation, remaining days (30-day boundary)
 * - Expired vs active trial
 * - Edge case: exactly 30 days
 * - Boundary conditions around trial period
 *
 * NOTE: the real `calculateTrialInfo` returns `createdAt: string | null`
 * (Invalid-Date-guarded) — identical to the old inline copy for every VALID
 * date asserted below.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { calculateTrialInfo } from "../../../../packages/services/src/user-logic";

// ============== TESTS ==============

describe("User Actions", () => {
  describe("calculateTrialInfo", () => {
    it("should show 30 remaining days for brand new account", () => {
      const now = new Date("2025-06-15T12:00:00Z");
      const createdAt = new Date("2025-06-15T12:00:00Z");
      const result = calculateTrialInfo(createdAt, now);

      assert.strictEqual(result.remainingDays, 30);
      assert.strictEqual(result.isExpired, false);
    });

    it("should show 29 remaining days after 1 day", () => {
      const createdAt = new Date("2025-06-01T00:00:00Z");
      const now = new Date("2025-06-02T00:00:00Z");
      const result = calculateTrialInfo(createdAt, now);

      assert.strictEqual(result.remainingDays, 29);
      assert.strictEqual(result.isExpired, false);
    });

    it("should show 15 remaining days halfway through trial", () => {
      const createdAt = new Date("2025-06-01T00:00:00Z");
      const now = new Date("2025-06-16T00:00:00Z");
      const result = calculateTrialInfo(createdAt, now);

      assert.strictEqual(result.remainingDays, 15);
      assert.strictEqual(result.isExpired, false);
    });

    it("should show 1 remaining day on day 29", () => {
      const createdAt = new Date("2025-06-01T00:00:00Z");
      const now = new Date("2025-06-30T00:00:00Z");
      const result = calculateTrialInfo(createdAt, now);

      assert.strictEqual(result.remainingDays, 1);
      assert.strictEqual(result.isExpired, false);
    });

    it("should show 0 remaining days and expired on exactly day 30", () => {
      const createdAt = new Date("2025-06-01T00:00:00Z");
      const now = new Date("2025-07-01T00:00:00Z");
      const result = calculateTrialInfo(createdAt, now);

      assert.strictEqual(result.remainingDays, 0);
      assert.strictEqual(result.isExpired, true);
    });

    it("should show 0 remaining days and expired after day 30", () => {
      const createdAt = new Date("2025-06-01T00:00:00Z");
      const now = new Date("2025-08-01T00:00:00Z");
      const result = calculateTrialInfo(createdAt, now);

      assert.strictEqual(result.remainingDays, 0);
      assert.strictEqual(result.isExpired, true);
    });

    it("should use floor for partial days (23h 59m = 0 full days)", () => {
      const createdAt = new Date("2025-06-01T00:00:00Z");
      const now = new Date("2025-06-01T23:59:59Z");
      const result = calculateTrialInfo(createdAt, now);

      // Math.floor of < 1 day = 0 days passed
      assert.strictEqual(result.remainingDays, 30);
      assert.strictEqual(result.isExpired, false);
    });

    it("should handle exactly 24 hours as 1 day", () => {
      const createdAt = new Date("2025-06-01T10:00:00Z");
      const now = new Date("2025-06-02T10:00:00Z");
      const result = calculateTrialInfo(createdAt, now);

      assert.strictEqual(result.remainingDays, 29);
      assert.strictEqual(result.isExpired, false);
    });

    it("should handle accounts older than 30 days with large gap", () => {
      const createdAt = new Date("2024-01-01T00:00:00Z");
      const now = new Date("2025-06-01T00:00:00Z");
      const result = calculateTrialInfo(createdAt, now);

      assert.strictEqual(result.remainingDays, 0);
      assert.strictEqual(result.isExpired, true);
    });

    it("should return correct ISO string for createdAt", () => {
      const createdAt = new Date("2025-06-15T08:30:00Z");
      const now = new Date("2025-06-20T12:00:00Z");
      const result = calculateTrialInfo(createdAt, now);

      assert.strictEqual(result.createdAt, "2025-06-15T08:30:00.000Z");
    });

    it("should handle same-day creation and check (0 days elapsed)", () => {
      const createdAt = new Date("2025-06-15T08:00:00Z");
      const now = new Date("2025-06-15T20:00:00Z");
      const result = calculateTrialInfo(createdAt, now);

      assert.strictEqual(result.remainingDays, 30);
      assert.strictEqual(result.isExpired, false);
    });

    it("should handle boundary: 29 days 23 hours (not yet 30 full days)", () => {
      const createdAt = new Date("2025-06-01T00:00:00Z");
      const now = new Date("2025-06-30T23:00:00Z");
      const result = calculateTrialInfo(createdAt, now);

      // 29 full days + 23 hours = Math.floor(29.958...) = 29 days
      assert.strictEqual(result.remainingDays, 1);
      assert.strictEqual(result.isExpired, false);
    });

    it("should treat daysSinceCreation >= 30 as expired", () => {
      // Exactly 31 days
      const createdAt = new Date("2025-06-01T00:00:00Z");
      const now = new Date("2025-07-02T00:00:00Z");
      const result = calculateTrialInfo(createdAt, now);

      assert.strictEqual(result.remainingDays, 0);
      assert.strictEqual(result.isExpired, true);
    });

    it("should not produce negative remaining days for very old accounts", () => {
      const createdAt = new Date("2020-01-01T00:00:00Z");
      const now = new Date("2025-06-01T00:00:00Z");
      const result = calculateTrialInfo(createdAt, now);

      assert.strictEqual(result.remainingDays, 0);
      assert.ok(result.remainingDays >= 0);
      assert.strictEqual(result.isExpired, true);
    });
  });
});
