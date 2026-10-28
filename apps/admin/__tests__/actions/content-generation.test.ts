/**
 * Content Generation Action Tests - Admin App
 *
 * Tests the REAL async success/error wrapper from
 * apps/admin/lib/actions/content-generation-logic.ts (imported and called by
 * both generateContentAction and verifyContentAction) instead of an inline
 * copy.
 *
 * Note: the previous inline copy also contained
 * `validateContentGenerationInput`, `validateContentVerificationInput`, and a
 * "simplified for testing" `buildContentPrompt`. None of those exist in the
 * real source — the admin actions perform no field validation, and the real
 * prompt builder is private to @usemoney/content-engine with a different
 * signature — so they could not be de-shadowed against real source and were
 * removed.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { runContentAction } from "@/lib/actions/content-generation-logic";

// --- Tests ---

describe("Content Generation Actions", () => {
  describe("runContentAction", () => {
    it("should return success result on normal execution", async () => {
      const result = await runContentAction(async () => "data", "fallback");
      assert.strictEqual(result.success, true);
      assert.ok(result.success && result.data === "data");
    });

    it("should return the resolved data on success", async () => {
      const payload = { id: 1, body: "content" };
      const result = await runContentAction(async () => payload, "fallback");
      assert.ok(result.success);
      assert.deepStrictEqual(result.success && result.data, payload);
    });

    it("should return failure result with the thrown Error message", async () => {
      const result = await runContentAction(async () => {
        throw new Error("Something went wrong");
      }, "fallback");
      assert.strictEqual(result.success, false);
      assert.strictEqual(
        !result.success ? result.error : undefined,
        "Something went wrong",
      );
    });

    it("should use the fallback for non-Error throws", async () => {
      const result = await runContentAction(async () => {
        throw "string error";
      }, "Content generation failed");
      assert.strictEqual(result.success, false);
      assert.strictEqual(
        !result.success ? result.error : undefined,
        "Content generation failed",
      );
    });

    it("should use the verification fallback when provided", async () => {
      const result = await runContentAction(async () => {
        throw 42;
      }, "Content verification failed");
      assert.strictEqual(
        !result.success ? result.error : undefined,
        "Content verification failed",
      );
    });
  });
});
