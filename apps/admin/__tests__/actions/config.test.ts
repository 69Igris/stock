/**
 * Config Action Tests - Admin App
 *
 * Tests the REAL ServiceResult-unwrapping helpers from
 * apps/admin/lib/actions/config-logic.ts (imported and called by config.ts)
 * rather than an inline copy.
 *
 * Source: apps/admin/lib/actions/config.ts
 *
 * Note: the previous inline copy also contained `validateConfigKey`,
 * `validateProPlanMode`, and `requireAdminGuard`. Those asserted behaviour
 * that does not exist in the real source — config.ts never validates the key,
 * the real ProPlanMode enum is `"lifetime" | "annual"` (not
 * DISABLED/ENABLED/INVITE_ONLY), and admin gating is the real Clerk-backed
 * `requireAdmin()` — so they could not be de-shadowed against real source and
 * were removed.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { ServiceResult } from "@usemoney/services";
import {
  processGetConfigResult,
  processSetConfigResult,
  processSetProPlanModeResult,
} from "@/lib/actions/config-logic";

// --- Mock Data ---

function createSuccessResult<T>(data: T): ServiceResult<T> {
  return { success: true, data };
}

function createErrorResult(error: string): ServiceResult<never> {
  return { success: false, error };
}

// --- Tests ---

describe("Config Actions", () => {
  describe("processGetConfigResult", () => {
    it("should return data on success", () => {
      const result = createSuccessResult({ value: "test-value" });
      assert.deepStrictEqual(processGetConfigResult(result), {
        value: "test-value",
      });
    });

    it("should return string data on success", () => {
      const result = createSuccessResult("enabled");
      assert.strictEqual(processGetConfigResult(result), "enabled");
    });

    it("should return number data on success", () => {
      const result = createSuccessResult(42);
      assert.strictEqual(processGetConfigResult(result), 42);
    });

    it("should return boolean data on success", () => {
      const result = createSuccessResult(true);
      assert.strictEqual(processGetConfigResult(result), true);
    });

    it("should return null data when data is null", () => {
      const result = createSuccessResult(null);
      assert.strictEqual(processGetConfigResult(result), null);
    });

    it("should throw error on failure", () => {
      const result = createErrorResult("Config not found");
      assert.throws(() => processGetConfigResult(result), {
        message: "Config not found",
      });
    });

    it("should throw with specific error message", () => {
      const result = createErrorResult("Database connection failed");
      assert.throws(() => processGetConfigResult(result), {
        message: "Database connection failed",
      });
    });
  });

  describe("processSetConfigResult", () => {
    it("should not throw on success", () => {
      const result = createSuccessResult(undefined);
      assert.doesNotThrow(() => processSetConfigResult(result));
    });

    it("should throw on failure", () => {
      const result = createErrorResult("Failed to update config");
      assert.throws(() => processSetConfigResult(result), {
        message: "Failed to update config",
      });
    });

    it("should throw with specific error message", () => {
      const result = createErrorResult("Invalid config value type");
      assert.throws(() => processSetConfigResult(result), {
        message: "Invalid config value type",
      });
    });
  });

  describe("processSetProPlanModeResult", () => {
    it("should not throw on success", () => {
      const result = createSuccessResult(undefined);
      assert.doesNotThrow(() => processSetProPlanModeResult(result));
    });

    it("should throw on failure with error message", () => {
      const result = createErrorResult("Invalid pro plan mode");
      assert.throws(() => processSetProPlanModeResult(result), {
        message: "Invalid pro plan mode",
      });
    });
  });
});
