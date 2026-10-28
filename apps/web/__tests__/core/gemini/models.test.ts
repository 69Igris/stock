/**
 * Gemini Model Configuration Tests
 *
 * Exercises the REAL model configuration + helpers exported from
 * packages/core/src/gemini/models.ts (via `@usemoney/core/gemini`). No inline
 * reimplementation — `MODEL_CONFIG`, `estimateTokenCount`, and
 * `getModelNameForMode` all run the source code asserted here. (Importing the
 * gemini barrel is hermetic: the Vertex client is lazily constructed only when
 * `getVertexAIClient()` is called, never at module load.)
 *
 * Source: packages/core/src/gemini/models.ts
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  MODEL_CONFIG,
  estimateTokenCount,
  getModelNameForMode,
} from "@usemoney/core/gemini";

// ============================================================================
// Tests
// ============================================================================

describe("Gemini Model Configuration (real @usemoney/core exports)", () => {
  // --------------------------------------------------------------------------
  // MODEL_CONFIG structure
  // --------------------------------------------------------------------------
  describe("MODEL_CONFIG structure", () => {
    it("should have exactly 2 modes", () => {
      assert.strictEqual(Object.keys(MODEL_CONFIG).length, 2);
    });

    it("should have a 'fast' mode", () => {
      assert.ok(MODEL_CONFIG.fast);
    });

    it("should have an 'advanced' mode", () => {
      assert.ok(MODEL_CONFIG.advanced);
    });

    it("should have string modelName for each mode", () => {
      assert.strictEqual(typeof MODEL_CONFIG.fast.modelName, "string");
      assert.strictEqual(typeof MODEL_CONFIG.advanced.modelName, "string");
    });

    it("should have boolean enableThinking for each mode", () => {
      assert.strictEqual(typeof MODEL_CONFIG.fast.enableThinking, "boolean");
      assert.strictEqual(
        typeof MODEL_CONFIG.advanced.enableThinking,
        "boolean"
      );
    });

    it("should have generationConfig for each mode", () => {
      assert.ok(MODEL_CONFIG.fast.generationConfig);
      assert.ok(MODEL_CONFIG.advanced.generationConfig);
    });
  });

  // --------------------------------------------------------------------------
  // Fast mode configuration
  // --------------------------------------------------------------------------
  describe("Fast mode config", () => {
    const fast = MODEL_CONFIG.fast;

    it("should use 'gemini-2.5-flash' model", () => {
      assert.strictEqual(fast.modelName, "gemini-2.5-flash");
    });

    it("should have thinking disabled", () => {
      assert.strictEqual(fast.enableThinking, false);
    });

    it("should have temperature 0.7", () => {
      assert.strictEqual(fast.generationConfig.temperature, 0.7);
    });

    it("should have topP 0.95", () => {
      assert.strictEqual(fast.generationConfig.topP, 0.95);
    });

    it("should have topK 40", () => {
      assert.strictEqual(fast.generationConfig.topK, 40);
    });

    it("should have maxOutputTokens 2048", () => {
      assert.strictEqual(fast.generationConfig.maxOutputTokens, 2048);
    });

    it("should NOT have thinkingConfig", () => {
      assert.strictEqual(fast.generationConfig.thinkingConfig, undefined);
    });

    it("should have temperature in valid range [0, 2]", () => {
      assert.ok(fast.generationConfig.temperature >= 0);
      assert.ok(fast.generationConfig.temperature <= 2);
    });

    it("should have topP in valid range [0, 1]", () => {
      assert.ok(fast.generationConfig.topP >= 0);
      assert.ok(fast.generationConfig.topP <= 1);
    });

    it("should have positive maxOutputTokens", () => {
      assert.ok(fast.generationConfig.maxOutputTokens > 0);
    });

    it("should have positive topK", () => {
      assert.ok(fast.generationConfig.topK > 0);
    });
  });

  // --------------------------------------------------------------------------
  // Advanced mode configuration
  // --------------------------------------------------------------------------
  describe("Advanced mode config", () => {
    const advanced = MODEL_CONFIG.advanced;

    it("should use 'gemini-2.5-pro' model", () => {
      assert.strictEqual(advanced.modelName, "gemini-2.5-pro");
    });

    it("should have thinking enabled", () => {
      assert.strictEqual(advanced.enableThinking, true);
    });

    it("should have temperature 0.9", () => {
      assert.strictEqual(advanced.generationConfig.temperature, 0.9);
    });

    it("should have topP 0.95", () => {
      assert.strictEqual(advanced.generationConfig.topP, 0.95);
    });

    it("should have topK 40", () => {
      assert.strictEqual(advanced.generationConfig.topK, 40);
    });

    it("should have maxOutputTokens 8192", () => {
      assert.strictEqual(advanced.generationConfig.maxOutputTokens, 8192);
    });

    it("should have thinkingConfig defined", () => {
      assert.ok(advanced.generationConfig.thinkingConfig);
    });

    it("should have thinkingBudget 4096", () => {
      assert.strictEqual(
        advanced.generationConfig.thinkingConfig!.thinkingBudget,
        4096
      );
    });

    it("should have temperature in valid range [0, 2]", () => {
      assert.ok(advanced.generationConfig.temperature >= 0);
      assert.ok(advanced.generationConfig.temperature <= 2);
    });

    it("should have topP in valid range [0, 1]", () => {
      assert.ok(advanced.generationConfig.topP >= 0);
      assert.ok(advanced.generationConfig.topP <= 1);
    });

    it("should have positive maxOutputTokens", () => {
      assert.ok(advanced.generationConfig.maxOutputTokens > 0);
    });

    it("should have thinkingBudget >= 1024 (minimum)", () => {
      assert.ok(
        advanced.generationConfig.thinkingConfig!.thinkingBudget >= 1024
      );
    });

    it("should have thinkingBudget <= 24576 (maximum)", () => {
      assert.ok(
        advanced.generationConfig.thinkingConfig!.thinkingBudget <= 24576
      );
    });
  });

  // --------------------------------------------------------------------------
  // Cross-mode comparisons
  // --------------------------------------------------------------------------
  describe("Cross-mode comparisons", () => {
    it("advanced should have higher temperature than fast", () => {
      assert.ok(
        MODEL_CONFIG.advanced.generationConfig.temperature >
          MODEL_CONFIG.fast.generationConfig.temperature
      );
    });

    it("advanced should have higher maxOutputTokens than fast", () => {
      assert.ok(
        MODEL_CONFIG.advanced.generationConfig.maxOutputTokens >
          MODEL_CONFIG.fast.generationConfig.maxOutputTokens
      );
    });

    it("both modes should share the same topP", () => {
      assert.strictEqual(
        MODEL_CONFIG.fast.generationConfig.topP,
        MODEL_CONFIG.advanced.generationConfig.topP
      );
    });

    it("both modes should share the same topK", () => {
      assert.strictEqual(
        MODEL_CONFIG.fast.generationConfig.topK,
        MODEL_CONFIG.advanced.generationConfig.topK
      );
    });

    it("fast and advanced should use different model names", () => {
      assert.notStrictEqual(
        MODEL_CONFIG.fast.modelName,
        MODEL_CONFIG.advanced.modelName
      );
    });

    it("only advanced should have thinking enabled", () => {
      assert.strictEqual(MODEL_CONFIG.fast.enableThinking, false);
      assert.strictEqual(MODEL_CONFIG.advanced.enableThinking, true);
    });
  });

  // --------------------------------------------------------------------------
  // estimateTokenCount
  // --------------------------------------------------------------------------
  describe("estimateTokenCount", () => {
    it("should return 0 for empty string", () => {
      assert.strictEqual(estimateTokenCount(""), 0);
    });

    it("should return 1 for a single character", () => {
      assert.strictEqual(estimateTokenCount("a"), 1);
    });

    it("should return 1 for 2 characters", () => {
      assert.strictEqual(estimateTokenCount("ab"), 1);
    });

    it("should return 1 for 3 characters", () => {
      assert.strictEqual(estimateTokenCount("abc"), 1);
    });

    it("should return 1 for exactly 4 characters", () => {
      assert.strictEqual(estimateTokenCount("abcd"), 1);
    });

    it("should return 2 for 5 characters", () => {
      assert.strictEqual(estimateTokenCount("abcde"), 2);
    });

    it("should return 2 for 8 characters", () => {
      assert.strictEqual(estimateTokenCount("abcdefgh"), 2);
    });

    it("should return 3 for 9 characters", () => {
      assert.strictEqual(estimateTokenCount("123456789"), 3);
    });

    it("should return 25 for 100 characters", () => {
      const text = "a".repeat(100);
      assert.strictEqual(estimateTokenCount(text), 25);
    });

    it("should return 250 for 1000 characters", () => {
      const text = "x".repeat(1000);
      assert.strictEqual(estimateTokenCount(text), 250);
    });

    it("should ceil fractional results", () => {
      // 7 / 4 = 1.75 -> ceil -> 2
      assert.strictEqual(estimateTokenCount("1234567"), 2);
    });

    it("should handle whitespace-only text", () => {
      assert.strictEqual(estimateTokenCount("    "), 1);
    });

    it("should handle newlines", () => {
      assert.strictEqual(estimateTokenCount("\n\n\n\n"), 1);
    });

    it("should handle unicode characters (counted by length)", () => {
      // Each emoji is 2 chars in JS string length
      const emoji = "\u{1F600}"; // grinning face
      assert.strictEqual(estimateTokenCount(emoji), 1);
    });

    it("should scale linearly with text length", () => {
      const short = estimateTokenCount("a".repeat(100));
      const long = estimateTokenCount("a".repeat(400));
      assert.strictEqual(long, short * 4);
    });
  });

  // --------------------------------------------------------------------------
  // getModelNameForMode
  // --------------------------------------------------------------------------
  describe("getModelNameForMode", () => {
    it("should return 'gemini-2.5-flash' for fast mode", () => {
      assert.strictEqual(getModelNameForMode("fast"), "gemini-2.5-flash");
    });

    it("should return 'gemini-2.5-pro' for advanced mode", () => {
      assert.strictEqual(getModelNameForMode("advanced"), "gemini-2.5-pro");
    });

    it("should return a non-empty string for fast mode", () => {
      assert.ok(getModelNameForMode("fast").length > 0);
    });

    it("should return a non-empty string for advanced mode", () => {
      assert.ok(getModelNameForMode("advanced").length > 0);
    });

    it("fast model name should contain 'flash'", () => {
      assert.ok(getModelNameForMode("fast").includes("flash"));
    });

    it("advanced model name should contain 'pro'", () => {
      assert.ok(getModelNameForMode("advanced").includes("pro"));
    });

    it("both model names should start with 'gemini-'", () => {
      assert.ok(getModelNameForMode("fast").startsWith("gemini-"));
      assert.ok(getModelNameForMode("advanced").startsWith("gemini-"));
    });
  });

  // --------------------------------------------------------------------------
  // Generation config validation
  // --------------------------------------------------------------------------
  describe("Generation config validation", () => {
    it("fast temperature should be below 1.0 for balanced output", () => {
      assert.ok(MODEL_CONFIG.fast.generationConfig.temperature < 1.0);
    });

    it("advanced temperature should be below 1.0 for coherent output", () => {
      assert.ok(MODEL_CONFIG.advanced.generationConfig.temperature < 1.0);
    });

    it("fast maxOutputTokens should be at least 1024", () => {
      assert.ok(MODEL_CONFIG.fast.generationConfig.maxOutputTokens >= 1024);
    });

    it("advanced maxOutputTokens should be at least 4096", () => {
      assert.ok(MODEL_CONFIG.advanced.generationConfig.maxOutputTokens >= 4096);
    });

    it("topK should be a positive integer for both modes", () => {
      assert.ok(Number.isInteger(MODEL_CONFIG.fast.generationConfig.topK));
      assert.ok(Number.isInteger(MODEL_CONFIG.advanced.generationConfig.topK));
      assert.ok(MODEL_CONFIG.fast.generationConfig.topK > 0);
      assert.ok(MODEL_CONFIG.advanced.generationConfig.topK > 0);
    });

    it("maxOutputTokens should be a positive integer for both modes", () => {
      assert.ok(
        Number.isInteger(MODEL_CONFIG.fast.generationConfig.maxOutputTokens)
      );
      assert.ok(
        Number.isInteger(MODEL_CONFIG.advanced.generationConfig.maxOutputTokens)
      );
    });
  });
});
