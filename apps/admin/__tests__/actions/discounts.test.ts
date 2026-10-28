/**
 * Discounts Action Tests - Admin App
 *
 * Tests the REAL Dodo-discount create-input validation and create-params
 * builder from apps/admin/lib/actions/dodo-discounts-logic.ts (imported and
 * called by the admin discounts API route) instead of an inline copy.
 *
 * Source: apps/admin/app/api/admin/discounts/route.ts
 *
 * Note: the previous inline copy also contained `normalizeDodoDiscount`,
 * `buildUnconfiguredResult`, and `validateDiscountId`. None of those exist in
 * the real route — GET returns the raw Dodo discounts (no normalization), the
 * unconfigured path returns a 503 error (not a result object), and DELETE does
 * not validate the id beyond passing it to the Dodo client — so they could not
 * be de-shadowed against real source and were removed.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  validateCreateDiscountInput,
  buildDodoCreateParams,
  type CreateDiscountInput,
} from "@/lib/actions/dodo-discounts-logic";

// --- Mock Data ---

function createDiscountInput(
  overrides: Partial<CreateDiscountInput> = {},
): CreateDiscountInput {
  return {
    amount: 2000,
    type: "percentage",
    code: "SAVE20",
    expiresAt: "2026-06-30T23:59:59Z",
    usageLimit: 50,
    name: "Summer Sale",
    ...overrides,
  };
}

// --- Tests ---

describe("Discounts Actions", () => {
  describe("validateCreateDiscountInput", () => {
    it("should return null for valid input", () => {
      const input = createDiscountInput();
      assert.strictEqual(validateCreateDiscountInput(input), null);
    });

    it("should return error when amount is 0", () => {
      const result = validateCreateDiscountInput({ amount: 0 });
      assert.ok(result?.includes("positive number"));
    });

    it("should return error when amount is negative", () => {
      const result = validateCreateDiscountInput({ amount: -100 });
      assert.ok(result?.includes("positive number"));
    });

    it("should return error when amount is undefined", () => {
      const result = validateCreateDiscountInput({});
      assert.ok(result !== null);
    });

    it("should accept amount of 1 (minimum valid)", () => {
      assert.strictEqual(
        validateCreateDiscountInput({ amount: 1, type: "percentage" }),
        null,
      );
    });

    it("should accept large amounts", () => {
      assert.strictEqual(
        validateCreateDiscountInput({ amount: 10000, type: "percentage" }),
        null,
      );
    });
  });

  describe("buildDodoCreateParams", () => {
    it("should map all fields correctly", () => {
      const input = createDiscountInput();
      const params = buildDodoCreateParams(input);

      assert.strictEqual(params.amount, 2000);
      assert.strictEqual(params.type, "percentage");
      assert.strictEqual(params.code, "SAVE20");
      assert.strictEqual(params.expires_at, "2026-06-30T23:59:59Z");
      assert.strictEqual(params.usage_limit, 50);
      assert.strictEqual(params.name, "Summer Sale");
    });

    it("should default type to percentage when not provided", () => {
      const input = createDiscountInput();
      delete input.type;
      const params = buildDodoCreateParams(input);
      assert.strictEqual(params.type, "percentage");
    });

    it("should convert empty code to undefined", () => {
      const input = createDiscountInput({ code: "" });
      const params = buildDodoCreateParams(input);
      assert.strictEqual(params.code, undefined);
    });

    it("should convert empty expiresAt to undefined", () => {
      const input = createDiscountInput({ expiresAt: "" });
      const params = buildDodoCreateParams(input);
      assert.strictEqual(params.expires_at, undefined);
    });

    it("should convert empty name to undefined", () => {
      const input = createDiscountInput({ name: "" });
      const params = buildDodoCreateParams(input);
      assert.strictEqual(params.name, undefined);
    });

    it("should convert zero usageLimit to undefined", () => {
      const input = createDiscountInput({ usageLimit: 0 });
      const params = buildDodoCreateParams(input);
      assert.strictEqual(params.usage_limit, undefined);
    });

    it("should convert empty restrictedTo array to undefined", () => {
      const input = createDiscountInput({ restrictedTo: [] });
      const params = buildDodoCreateParams(input);
      assert.strictEqual(params.restricted_to, undefined);
    });

    it("should keep non-empty restrictedTo array", () => {
      const input = createDiscountInput({ restrictedTo: ["prod_a", "prod_b"] });
      const params = buildDodoCreateParams(input);
      assert.deepStrictEqual(params.restricted_to, ["prod_a", "prod_b"]);
    });

    it("should handle minimal input (amount + type only)", () => {
      const input: CreateDiscountInput = { amount: 500, type: "percentage" };
      const params = buildDodoCreateParams(input);
      assert.strictEqual(params.amount, 500);
      assert.strictEqual(params.type, "percentage");
      assert.strictEqual(params.code, undefined);
      assert.strictEqual(params.expires_at, undefined);
      assert.strictEqual(params.usage_limit, undefined);
      assert.strictEqual(params.restricted_to, undefined);
      assert.strictEqual(params.name, undefined);
    });
  });
});
