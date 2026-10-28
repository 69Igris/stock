/**
 * Gemini Model Configuration & Utilities Tests
 *
 * Tests for pure functions and constants from lib/gemini/models.ts:
 * - MODEL_CONFIG: Configuration for fast/advanced modes
 * - estimateTokenCount: Token estimation (Math.ceil(text.length / 4))
 * - Retry logic constants and exponential backoff formula
 * - Timeout constants
 * - GenerationConfig structure validation
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
// De-shadowed (MONEY-620): assert the REAL exported config + helpers from the
// source. models.ts has no module-load side effects (the Vertex client is
// constructed lazily inside getGeminiModel), so it imports cleanly here.
// NOTE: the previous inline copy was STALE — it asserted maxOutputTokens=8192
// and thinkingBudget=4096, but the real source uses 16384 / 8192. A shadow
// test stayed green while drifting from production: exactly the failure this
// de-shadow campaign exists to catch.
import {
  MODEL_CONFIG,
  estimateTokenCount,
  retryBackoffMs as calculateRetryDelay,
  DEFAULT_MAX_RETRIES,
  DEFAULT_TIMEOUT_MS,
  resolveMaxRetries,
  resolveTimeoutMs,
} from "@/lib/gemini/models";
import type { QueryMode } from "@/lib/gemini/types";

// ============== TESTS ==============

describe("Gemini Models Configuration", () => {
  // ───────────────────── MODEL_CONFIG structure ─────────────────────

  describe("MODEL_CONFIG", () => {
    it("should have exactly two modes: fast and advanced", () => {
      const modes = Object.keys(MODEL_CONFIG);
      assert.deepStrictEqual(modes.sort(), ["advanced", "fast"]);
    });

    describe("fast mode", () => {
      const fast = MODEL_CONFIG.fast;

      it("should use gemini-2.5-flash model", () => {
        assert.strictEqual(fast.modelName, "gemini-2.5-flash");
      });

      it("should have thinking disabled", () => {
        assert.strictEqual(fast.enableThinking, false);
      });

      it("should have temperature of 0.7", () => {
        assert.strictEqual(fast.generationConfig.temperature, 0.7);
      });

      it("should have topP of 0.95", () => {
        assert.strictEqual(fast.generationConfig.topP, 0.95);
      });

      it("should have topK of 40", () => {
        assert.strictEqual(fast.generationConfig.topK, 40);
      });

      it("should have maxOutputTokens of 2048", () => {
        assert.strictEqual(fast.generationConfig.maxOutputTokens, 2048);
      });

      it("should not have thinkingConfig", () => {
        assert.strictEqual(fast.generationConfig.thinkingConfig, undefined);
      });

      it("should have temperature in valid range [0, 1]", () => {
        assert.ok(fast.generationConfig.temperature >= 0);
        assert.ok(fast.generationConfig.temperature <= 1);
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

    describe("advanced mode", () => {
      const advanced = MODEL_CONFIG.advanced;

      it("should use gemini-2.5-pro model", () => {
        assert.strictEqual(advanced.modelName, "gemini-2.5-pro");
      });

      it("should have thinking enabled", () => {
        assert.strictEqual(advanced.enableThinking, true);
      });

      it("should have temperature of 0.9", () => {
        assert.strictEqual(advanced.generationConfig.temperature, 0.9);
      });

      it("should have topP of 0.95", () => {
        assert.strictEqual(advanced.generationConfig.topP, 0.95);
      });

      it("should have topK of 40", () => {
        assert.strictEqual(advanced.generationConfig.topK, 40);
      });

      it("should have maxOutputTokens of 16384", () => {
        assert.strictEqual(advanced.generationConfig.maxOutputTokens, 16384);
      });

      it("should have thinkingConfig defined", () => {
        assert.ok(advanced.generationConfig.thinkingConfig !== undefined);
      });

      it("should have thinkingBudget of 8192", () => {
        assert.strictEqual(
          advanced.generationConfig.thinkingConfig!.thinkingBudget,
          8192
        );
      });

      it("should have thinkingBudget within valid range [1024, 24576]", () => {
        const budget = advanced.generationConfig.thinkingConfig!.thinkingBudget;
        assert.ok(budget >= 1024);
        assert.ok(budget <= 24576);
      });

      it("should have temperature in valid range [0, 1]", () => {
        assert.ok(advanced.generationConfig.temperature >= 0);
        assert.ok(advanced.generationConfig.temperature <= 1);
      });

      it("should have higher temperature than fast mode", () => {
        assert.ok(
          advanced.generationConfig.temperature >
            MODEL_CONFIG.fast.generationConfig.temperature
        );
      });

      it("should have higher maxOutputTokens than fast mode", () => {
        assert.ok(
          advanced.generationConfig.maxOutputTokens >
            MODEL_CONFIG.fast.generationConfig.maxOutputTokens
        );
      });
    });

    describe("Cross-mode validation", () => {
      it("should use different model names for fast and advanced", () => {
        assert.notStrictEqual(
          MODEL_CONFIG.fast.modelName,
          MODEL_CONFIG.advanced.modelName
        );
      });

      it("should have same topP for both modes", () => {
        assert.strictEqual(
          MODEL_CONFIG.fast.generationConfig.topP,
          MODEL_CONFIG.advanced.generationConfig.topP
        );
      });

      it("should have same topK for both modes", () => {
        assert.strictEqual(
          MODEL_CONFIG.fast.generationConfig.topK,
          MODEL_CONFIG.advanced.generationConfig.topK
        );
      });

      it("fast mode should have lower maxOutputTokens than advanced", () => {
        assert.ok(
          MODEL_CONFIG.fast.generationConfig.maxOutputTokens <
            MODEL_CONFIG.advanced.generationConfig.maxOutputTokens
        );
      });

      it("only advanced mode should have thinking enabled", () => {
        assert.strictEqual(MODEL_CONFIG.fast.enableThinking, false);
        assert.strictEqual(MODEL_CONFIG.advanced.enableThinking, true);
      });
    });
  });

  // ───────────────────── estimateTokenCount ─────────────────────

  describe("estimateTokenCount", () => {
    it("should return 0 for empty string", () => {
      assert.strictEqual(estimateTokenCount(""), 0);
    });

    it("should return 1 for single character", () => {
      assert.strictEqual(estimateTokenCount("a"), 1);
    });

    it("should return 1 for 4 characters", () => {
      assert.strictEqual(estimateTokenCount("abcd"), 1);
    });

    it("should return 2 for 5 characters (ceiling)", () => {
      assert.strictEqual(estimateTokenCount("abcde"), 2);
    });

    it("should return 2 for 8 characters", () => {
      assert.strictEqual(estimateTokenCount("abcdefgh"), 2);
    });

    it("should return 3 for 9 characters", () => {
      assert.strictEqual(estimateTokenCount("abcdefghi"), 3);
    });

    it("should return 25 for 100 characters", () => {
      assert.strictEqual(estimateTokenCount("a".repeat(100)), 25);
    });

    it("should return 250 for 1000 characters", () => {
      assert.strictEqual(estimateTokenCount("a".repeat(1000)), 250);
    });

    it("should handle spaces as regular characters", () => {
      assert.strictEqual(estimateTokenCount("    "), 1); // 4 spaces = 1 token
    });

    it("should handle mixed content", () => {
      const text = "Hello, world! This is a test."; // 29 chars
      assert.strictEqual(estimateTokenCount(text), Math.ceil(29 / 4)); // 8
    });

    it("should handle unicode characters by string length", () => {
      // JavaScript string length counts UTF-16 code units
      const text = "Hello";
      assert.strictEqual(estimateTokenCount(text), Math.ceil(5 / 4)); // 2
    });

    it("should handle newlines as characters", () => {
      const text = "line1\nline2\nline3"; // 17 chars
      assert.strictEqual(estimateTokenCount(text), Math.ceil(17 / 4)); // 5
    });

    it("should always use ceiling division", () => {
      // For any non-empty string of length L, result should be Math.ceil(L/4)
      for (let len = 1; len <= 20; len++) {
        const text = "x".repeat(len);
        assert.strictEqual(
          estimateTokenCount(text),
          Math.ceil(len / 4),
          `Failed for length ${len}`
        );
      }
    });
  });

  // ───────────────────── Retry Logic Constants ─────────────────────

  describe("Retry Logic", () => {
    it("should have default max retries of 3", () => {
      assert.strictEqual(DEFAULT_MAX_RETRIES, 3);
    });

    it("should calculate 1000ms delay for first attempt (attempt=0)", () => {
      assert.strictEqual(calculateRetryDelay(0), 1000);
    });

    it("should calculate 2000ms delay for second attempt (attempt=1)", () => {
      assert.strictEqual(calculateRetryDelay(1), 2000);
    });

    it("should calculate 4000ms delay for third attempt (attempt=2)", () => {
      assert.strictEqual(calculateRetryDelay(2), 4000);
    });

    it("should calculate 8000ms delay for fourth attempt (attempt=3)", () => {
      assert.strictEqual(calculateRetryDelay(3), 8000);
    });

    it("should follow exponential backoff pattern (2^n * 1000)", () => {
      for (let attempt = 0; attempt < 5; attempt++) {
        assert.strictEqual(
          calculateRetryDelay(attempt),
          Math.pow(2, attempt) * 1000,
          `Failed for attempt ${attempt}`
        );
      }
    });

    it("should produce increasing delays", () => {
      let prevDelay = 0;
      for (let attempt = 0; attempt < 5; attempt++) {
        const delay = calculateRetryDelay(attempt);
        assert.ok(
          delay > prevDelay,
          `Delay for attempt ${attempt} should exceed previous`
        );
        prevDelay = delay;
      }
    });
  });

  // ───────────────────── Timeout Constants ─────────────────────

  describe("Timeout Constants", () => {
    it("should have default timeout of 30000ms", () => {
      assert.strictEqual(DEFAULT_TIMEOUT_MS, 30000);
    });

    it("should have timeout in seconds equal to 30", () => {
      assert.strictEqual(DEFAULT_TIMEOUT_MS / 1000, 30);
    });

    it("should be a positive number", () => {
      assert.ok(DEFAULT_TIMEOUT_MS > 0);
    });
  });

  // ───────────── resolveMaxRetries / resolveTimeoutMs (env-guarded) ─────────────
  // These are the REAL helpers generateWithRetry / generateWithTimeout call.

  describe("resolveMaxRetries", () => {
    it("should return the explicit argument when provided", () => {
      assert.strictEqual(resolveMaxRetries(5), 5);
    });

    it("should fall back to default when no arg and no env", () => {
      const saved = process.env.GEMINI_MAX_RETRIES;
      delete process.env.GEMINI_MAX_RETRIES;
      try {
        assert.strictEqual(resolveMaxRetries(), DEFAULT_MAX_RETRIES);
      } finally {
        if (saved === undefined) delete process.env.GEMINI_MAX_RETRIES;
        else process.env.GEMINI_MAX_RETRIES = saved;
      }
    });

    it("should read GEMINI_MAX_RETRIES env when set", () => {
      const saved = process.env.GEMINI_MAX_RETRIES;
      process.env.GEMINI_MAX_RETRIES = "7";
      try {
        assert.strictEqual(resolveMaxRetries(), 7);
      } finally {
        if (saved === undefined) delete process.env.GEMINI_MAX_RETRIES;
        else process.env.GEMINI_MAX_RETRIES = saved;
      }
    });

    it("should fall back to default for a non-numeric / non-positive env (guard)", () => {
      const saved = process.env.GEMINI_MAX_RETRIES;
      for (const bad of ["abc", "0", "-3"]) {
        process.env.GEMINI_MAX_RETRIES = bad;
        assert.strictEqual(
          resolveMaxRetries(),
          DEFAULT_MAX_RETRIES,
          `bad env "${bad}" should fall back`
        );
      }
      if (saved === undefined) delete process.env.GEMINI_MAX_RETRIES;
      else process.env.GEMINI_MAX_RETRIES = saved;
    });
  });

  describe("resolveTimeoutMs", () => {
    it("should return the explicit argument when provided", () => {
      assert.strictEqual(resolveTimeoutMs(12345), 12345);
    });

    it("should fall back to default when no arg and no env", () => {
      const saved = process.env.GEMINI_TIMEOUT_MS;
      delete process.env.GEMINI_TIMEOUT_MS;
      try {
        assert.strictEqual(resolveTimeoutMs(), DEFAULT_TIMEOUT_MS);
      } finally {
        if (saved === undefined) delete process.env.GEMINI_TIMEOUT_MS;
        else process.env.GEMINI_TIMEOUT_MS = saved;
      }
    });

    it("should fall back to default for a garbage env value (guard)", () => {
      const saved = process.env.GEMINI_TIMEOUT_MS;
      process.env.GEMINI_TIMEOUT_MS = "not-a-number";
      try {
        assert.strictEqual(resolveTimeoutMs(), DEFAULT_TIMEOUT_MS);
      } finally {
        if (saved === undefined) delete process.env.GEMINI_TIMEOUT_MS;
        else process.env.GEMINI_TIMEOUT_MS = saved;
      }
    });
  });

  // ───────────────────── GenerationConfig Validation ─────────────────────

  describe("GenerationConfig Validation", () => {
    it("fast config should have all required fields", () => {
      const config = MODEL_CONFIG.fast.generationConfig;
      assert.ok("temperature" in config);
      assert.ok("topP" in config);
      assert.ok("topK" in config);
      assert.ok("maxOutputTokens" in config);
    });

    it("advanced config should have all required fields", () => {
      const config = MODEL_CONFIG.advanced.generationConfig;
      assert.ok("temperature" in config);
      assert.ok("topP" in config);
      assert.ok("topK" in config);
      assert.ok("maxOutputTokens" in config);
      assert.ok("thinkingConfig" in config);
    });

    it("all numeric config values should be finite numbers", () => {
      for (const mode of ["fast", "advanced"] as QueryMode[]) {
        const config = MODEL_CONFIG[mode].generationConfig;
        assert.ok(
          Number.isFinite(config.temperature),
          `${mode} temperature not finite`
        );
        assert.ok(Number.isFinite(config.topP), `${mode} topP not finite`);
        assert.ok(Number.isFinite(config.topK), `${mode} topK not finite`);
        assert.ok(
          Number.isFinite(config.maxOutputTokens),
          `${mode} maxOutputTokens not finite`
        );
      }
    });

    it("maxOutputTokens should be integer values", () => {
      assert.ok(
        Number.isInteger(MODEL_CONFIG.fast.generationConfig.maxOutputTokens)
      );
      assert.ok(
        Number.isInteger(MODEL_CONFIG.advanced.generationConfig.maxOutputTokens)
      );
    });

    it("topK should be integer values", () => {
      assert.ok(Number.isInteger(MODEL_CONFIG.fast.generationConfig.topK));
      assert.ok(Number.isInteger(MODEL_CONFIG.advanced.generationConfig.topK));
    });

    it("thinkingBudget should be an integer", () => {
      assert.ok(
        Number.isInteger(
          MODEL_CONFIG.advanced.generationConfig.thinkingConfig!.thinkingBudget
        )
      );
    });

    it("model names should be non-empty strings", () => {
      assert.ok(MODEL_CONFIG.fast.modelName.length > 0);
      assert.ok(MODEL_CONFIG.advanced.modelName.length > 0);
    });

    it("model names should contain 'gemini'", () => {
      assert.ok(MODEL_CONFIG.fast.modelName.includes("gemini"));
      assert.ok(MODEL_CONFIG.advanced.modelName.includes("gemini"));
    });

    it("fast model should contain 'flash'", () => {
      assert.ok(MODEL_CONFIG.fast.modelName.includes("flash"));
    });

    it("advanced model should contain 'pro'", () => {
      assert.ok(MODEL_CONFIG.advanced.modelName.includes("pro"));
    });
  });

  // ───────────────────── Model Version Verification ─────────────────────

  describe("Model version verification", () => {
    it("should use gemini-2.5-pro and gemini-2.5-flash model names", () => {
      assert.strictEqual(MODEL_CONFIG.fast.modelName, "gemini-2.5-flash");
      assert.strictEqual(MODEL_CONFIG.advanced.modelName, "gemini-2.5-pro");
    });

    it("advanced mode should have enableThinking=true with 8192 token budget", () => {
      assert.strictEqual(MODEL_CONFIG.advanced.enableThinking, true);
      assert.strictEqual(
        MODEL_CONFIG.advanced.generationConfig.thinkingConfig?.thinkingBudget,
        8192
      );
    });

    it("fast mode should use gemini-2.5-flash, advanced should use gemini-2.5-pro", () => {
      assert.ok(MODEL_CONFIG.fast.modelName.endsWith("flash"));
      assert.ok(MODEL_CONFIG.advanced.modelName.endsWith("pro"));
    });

    it("maxOutputTokens should be 2048 for fast and 16384 for advanced", () => {
      assert.strictEqual(
        MODEL_CONFIG.fast.generationConfig.maxOutputTokens,
        2048
      );
      assert.strictEqual(
        MODEL_CONFIG.advanced.generationConfig.maxOutputTokens,
        16384
      );
    });

    it("temperature should be 0.7 for fast and 0.9 for advanced", () => {
      assert.strictEqual(MODEL_CONFIG.fast.generationConfig.temperature, 0.7);
      assert.strictEqual(
        MODEL_CONFIG.advanced.generationConfig.temperature,
        0.9
      );
    });

    it("topP should be 0.95 for both modes", () => {
      assert.strictEqual(MODEL_CONFIG.fast.generationConfig.topP, 0.95);
      assert.strictEqual(MODEL_CONFIG.advanced.generationConfig.topP, 0.95);
    });

    it("topK should be 40 for both modes", () => {
      assert.strictEqual(MODEL_CONFIG.fast.generationConfig.topK, 40);
      assert.strictEqual(MODEL_CONFIG.advanced.generationConfig.topK, 40);
    });

    it("both model names should start with 'gemini-2.5'", () => {
      assert.ok(MODEL_CONFIG.fast.modelName.startsWith("gemini-2.5"));
      assert.ok(MODEL_CONFIG.advanced.modelName.startsWith("gemini-2.5"));
    });

    it("fast mode should NOT have thinkingConfig", () => {
      assert.strictEqual(
        MODEL_CONFIG.fast.generationConfig.thinkingConfig,
        undefined
      );
    });

    it("advanced thinking budget should be half of maxOutputTokens", () => {
      const budget =
        MODEL_CONFIG.advanced.generationConfig.thinkingConfig!.thinkingBudget;
      const maxTokens = MODEL_CONFIG.advanced.generationConfig.maxOutputTokens;
      assert.strictEqual(budget, maxTokens / 2);
    });
  });
});
