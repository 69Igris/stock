/**
 * Composer-preferences model schema - MONEY-229 Phase B tests.
 *
 * Validates that:
 *   - The 5 registered model IDs pass schema validation
 *   - Unknown IDs are rejected with a clear error
 *   - Empty / null / undefined are rejected at the schema level
 *     (the caller decides whether null is the "clear" sentinel - that
 *     check lives at the action layer)
 *
 * Source: packages/services/src/preferences/composer-preferences.ts
 *         packages/core/src/gemini/model-registry.ts
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { modelPreferenceSchema } from "../src/preferences/composer-preferences";
import { REGISTERED_MODEL_IDS } from "@usemoney/core/gemini/model-registry";

describe("modelPreferenceSchema - Zod validation", () => {
  it("accepts every registered model ID", () => {
    for (const id of REGISTERED_MODEL_IDS) {
      const out = modelPreferenceSchema.safeParse(id);
      assert.equal(out.success, true, `expected ${id} to be accepted`);
    }
  });

  it("rejects unknown IDs with a clear error", () => {
    const out = modelPreferenceSchema.safeParse("claude-4-opus");
    assert.equal(out.success, false);
    if (!out.success) {
      const msg = out.error.issues[0]?.message ?? "";
      assert.ok(
        msg.includes("Unknown model id"),
        `expected helpful error, got: ${msg}`,
      );
    }
  });

  it("rejects empty string (not a valid ID)", () => {
    const out = modelPreferenceSchema.safeParse("");
    assert.equal(out.success, false);
  });

  it("rejects non-string types (number/null/undefined)", () => {
    assert.equal(modelPreferenceSchema.safeParse(42).success, false);
    assert.equal(modelPreferenceSchema.safeParse(null).success, false);
    assert.equal(modelPreferenceSchema.safeParse(undefined).success, false);
  });

  it("rejects close-but-wrong IDs (typo guard)", () => {
    // Common slips users / future code might attempt
    assert.equal(
      modelPreferenceSchema.safeParse("Gemini-2.5-Flash").success,
      false,
      "case-sensitive",
    );
    assert.equal(
      modelPreferenceSchema.safeParse("gemini-2.5-pro-exp").success,
      false,
      "experimental suffix not registered",
    );
    assert.equal(
      modelPreferenceSchema.safeParse("gemini-3.0-pro").success,
      false,
      "retired speculative id (MONEY-619 — never provisioned)",
    );
  });
});
