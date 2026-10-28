/**
 * Invites Action Tests - Admin App
 *
 * Tests for invite-token CRUD validation logic, data-shape serialization,
 * create-data building, and the active toggle.
 *
 * Exercises the REAL exported helpers from
 * apps/admin/lib/actions/invites-logic.ts (imported and called by invites.ts)
 * instead of an inline copy.
 *
 * Source: apps/admin/lib/actions/invites.ts
 *
 * Note: the previous inline copy also contained `validateInviteTokenId`. The
 * real toggle/delete actions do not validate the id beyond Prisma's own
 * lookup, so there is no source counterpart to de-shadow and it was removed.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  serializeInviteToken,
  validateCreateInviteInput,
  buildInviteCreateData,
  toggleActive,
  type RawInviteToken,
  type CreateInviteInput,
} from "@/lib/actions/invites-logic";

// --- Mock Data ---

function createRawInviteToken(
  overrides: Partial<RawInviteToken> = {},
): RawInviteToken {
  return {
    id: "inv_abc123",
    token: "T0k3nAbCd12",
    planId: "PREMIUM",
    discountId: "disc_xyz",
    discountCode: "WELCOME50",
    maxUses: 10,
    usedCount: 3,
    usedBy: ["user_1", "user_2", "user_3"],
    assignedTo: "deepshaswat@gmail.com",
    expiresAt: new Date("2026-12-31T23:59:59Z"),
    createdBy: "admin_user_1",
    isActive: true,
    createdAt: new Date("2026-01-01T00:00:00Z"),
    updatedAt: new Date("2026-01-15T12:00:00Z"),
    ...overrides,
  };
}

function createInviteInput(
  overrides: Partial<CreateInviteInput> = {},
): CreateInviteInput {
  return {
    planId: "PREMIUM",
    maxUses: 5,
    assignedTo: "user@example.com",
    expiresAt: "2026-12-31T23:59:59Z",
    discountId: "disc_123",
    discountCode: "SAVE50",
    ...overrides,
  };
}

// --- Tests ---

describe("Invites Actions", () => {
  describe("serializeInviteToken", () => {
    it("should convert all Date fields to ISO strings", () => {
      const raw = createRawInviteToken();
      const result = serializeInviteToken(raw);

      assert.strictEqual(result.createdAt, "2026-01-01T00:00:00.000Z");
      assert.strictEqual(result.updatedAt, "2026-01-15T12:00:00.000Z");
      assert.strictEqual(result.expiresAt, "2026-12-31T23:59:59.000Z");
    });

    it("should convert null expiresAt to null string", () => {
      const raw = createRawInviteToken({ expiresAt: null });
      const result = serializeInviteToken(raw);
      assert.strictEqual(result.expiresAt, null);
    });

    it("should preserve all scalar fields", () => {
      const raw = createRawInviteToken();
      const result = serializeInviteToken(raw);

      assert.strictEqual(result.id, "inv_abc123");
      assert.strictEqual(result.token, "T0k3nAbCd12");
      assert.strictEqual(result.planId, "PREMIUM");
      assert.strictEqual(result.maxUses, 10);
      assert.strictEqual(result.usedCount, 3);
      assert.strictEqual(result.isActive, true);
      assert.strictEqual(result.createdBy, "admin_user_1");
    });

    it("should preserve array fields", () => {
      const raw = createRawInviteToken();
      const result = serializeInviteToken(raw);
      assert.deepStrictEqual(result.usedBy, ["user_1", "user_2", "user_3"]);
    });

    it("should preserve nullable string fields", () => {
      const raw = createRawInviteToken();
      const result = serializeInviteToken(raw);
      assert.strictEqual(result.discountId, "disc_xyz");
      assert.strictEqual(result.discountCode, "WELCOME50");
      assert.strictEqual(result.assignedTo, "deepshaswat@gmail.com");
    });

    it("should handle null discountId", () => {
      const raw = createRawInviteToken({ discountId: null });
      const result = serializeInviteToken(raw);
      assert.strictEqual(result.discountId, null);
    });

    it("should handle null discountCode", () => {
      const raw = createRawInviteToken({ discountCode: null });
      const result = serializeInviteToken(raw);
      assert.strictEqual(result.discountCode, null);
    });

    it("should handle empty usedBy array", () => {
      const raw = createRawInviteToken({ usedBy: [], usedCount: 0 });
      const result = serializeInviteToken(raw);
      assert.deepStrictEqual(result.usedBy, []);
      assert.strictEqual(result.usedCount, 0);
    });
  });

  describe("validateCreateInviteInput", () => {
    it("should return null for valid input", () => {
      const input = createInviteInput();
      assert.strictEqual(validateCreateInviteInput(input), null);
    });

    it("should return error when planId is missing", () => {
      const result = validateCreateInviteInput({ maxUses: 5 });
      assert.strictEqual(result, "planId and maxUses are required");
    });

    it("should return error when maxUses is missing", () => {
      const result = validateCreateInviteInput({ planId: "PREMIUM" });
      assert.strictEqual(result, "planId and maxUses are required");
    });

    it("should return error when both are missing", () => {
      const result = validateCreateInviteInput({});
      assert.strictEqual(result, "planId and maxUses are required");
    });

    it("should return error when planId is empty string", () => {
      const result = validateCreateInviteInput({ planId: "", maxUses: 5 });
      assert.strictEqual(result, "planId and maxUses are required");
    });

    it("should return error when maxUses is 0", () => {
      const result = validateCreateInviteInput({ planId: "PRO", maxUses: 0 });
      assert.strictEqual(result, "planId and maxUses are required");
    });
  });

  describe("buildInviteCreateData", () => {
    it("should build complete create data", () => {
      const input = createInviteInput();
      const data = buildInviteCreateData(input, "generated_token", "admin_1");

      assert.strictEqual(data.token, "generated_token");
      assert.strictEqual(data.planId, "PREMIUM");
      assert.strictEqual(data.maxUses, 5);
      assert.strictEqual(data.assignedTo, "user@example.com");
      assert.strictEqual(data.discountId, "disc_123");
      assert.strictEqual(data.discountCode, "SAVE50");
      assert.strictEqual(data.createdBy, "admin_1");
      assert.ok(data.expiresAt instanceof Date);
    });

    it("should convert empty assignedTo to null", () => {
      const input = createInviteInput({ assignedTo: "" });
      const data = buildInviteCreateData(input, "token", "admin_1");
      assert.strictEqual(data.assignedTo, null);
    });

    it("should convert undefined assignedTo to null", () => {
      const input = createInviteInput();
      delete input.assignedTo;
      const data = buildInviteCreateData(input, "token", "admin_1");
      assert.strictEqual(data.assignedTo, null);
    });

    it("should convert undefined expiresAt to null", () => {
      const input = createInviteInput();
      delete input.expiresAt;
      const data = buildInviteCreateData(input, "token", "admin_1");
      assert.strictEqual(data.expiresAt, null);
    });

    it("should convert empty discountId to null", () => {
      const input = createInviteInput({ discountId: "" });
      const data = buildInviteCreateData(input, "token", "admin_1");
      assert.strictEqual(data.discountId, null);
    });

    it("should convert empty discountCode to null", () => {
      const input = createInviteInput({ discountCode: "" });
      const data = buildInviteCreateData(input, "token", "admin_1");
      assert.strictEqual(data.discountCode, null);
    });
  });

  describe("toggleActive", () => {
    it("should toggle true to false", () => {
      assert.strictEqual(toggleActive(true), false);
    });

    it("should toggle false to true", () => {
      assert.strictEqual(toggleActive(false), true);
    });
  });
});
