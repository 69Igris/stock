/**
 * Flash Prompt Tests (lib/gemini/flash-prompt.ts)
 *
 * Tests for L1 Flash mode prompt construction:
 *   - FLASH_SYSTEM_PROMPT: constant validation
 *   - buildFlashUserPrompt: user prompt assembly with/without data
 *
 * Pure functions imported directly (no side-effecting dependencies).
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
// De-shadowed (MONEY-620): import the REAL exported symbols rather than a copy.
// flash-prompt.ts is a pure, side-effect-free module so it imports cleanly here.
import {
  FLASH_SYSTEM_PROMPT,
  buildFlashUserPrompt,
} from "@/lib/gemini/flash-prompt";

// ═══════════════════════════════════════════════════════════════════════════════
// Tests
// ═══════════════════════════════════════════════════════════════════════════════

describe("Flash Prompt", () => {
  describe("FLASH_SYSTEM_PROMPT constant", () => {
    it("should be a non-empty string", () => {
      assert.ok(FLASH_SYSTEM_PROMPT.length > 0);
    });

    it("should mention equity research analyst role", () => {
      assert.ok(FLASH_SYSTEM_PROMPT.includes("equity research analyst"));
    });

    it("should mention Indian stocks", () => {
      assert.ok(FLASH_SYSTEM_PROMPT.includes("Indian stocks"));
    });

    it("should include 150 word limit rule", () => {
      assert.ok(FLASH_SYSTEM_PROMPT.includes("150 words"));
    });

    it("should include Indian number formatting rule (₹, lakhs, crores)", () => {
      assert.ok(FLASH_SYSTEM_PROMPT.includes("₹"));
      assert.ok(FLASH_SYSTEM_PROMPT.includes("lakhs"));
      assert.ok(FLASH_SYSTEM_PROMPT.includes("crores"));
    });

    it("should include follow-up question format", () => {
      assert.ok(FLASH_SYSTEM_PROMPT.includes("Want to know more?"));
    });

    it("should include never fabricate numbers rule", () => {
      assert.ok(FLASH_SYSTEM_PROMPT.includes("Never fabricate numbers"));
    });

    it("should include data-sparse fallback message", () => {
      assert.ok(FLASH_SYSTEM_PROMPT.includes("Limited data available"));
    });

    it("should include definition question handling rule", () => {
      assert.ok(FLASH_SYSTEM_PROMPT.includes("definition questions"));
    });
  });

  describe("buildFlashUserPrompt", () => {
    describe("with financial data (hasFinancialData = true)", () => {
      it("should include the user message in quotes", () => {
        const result = buildFlashUserPrompt("What is PE of TCS?", "{}", true);
        assert.ok(result.includes('"What is PE of TCS?"'));
      });

      it("should include the data JSON", () => {
        const dataJson = '{"pe": 28.5, "price": 3500}';
        const result = buildFlashUserPrompt("PE of TCS", dataJson, true);
        assert.ok(result.includes(dataJson));
      });

      it("should mention relevant financial data", () => {
        const result = buildFlashUserPrompt("test", "{}", true);
        assert.ok(result.includes("relevant financial data"));
      });

      it("should ask for 2-3 metrics", () => {
        const result = buildFlashUserPrompt("test", "{}", true);
        assert.ok(result.includes("2-3 metrics"));
      });

      it("should include data-driven instruction", () => {
        const result = buildFlashUserPrompt("test", "{}", true);
        assert.ok(result.includes("data-driven"));
      });

      it("should handle large data JSON", () => {
        const largeData = JSON.stringify({ data: "x".repeat(3000) });
        const result = buildFlashUserPrompt("test", largeData, true);
        assert.ok(result.includes(largeData));
      });
    });

    describe("without financial data (hasFinancialData = false)", () => {
      it("should include the user message in quotes", () => {
        const result = buildFlashUserPrompt("What is RSI?", "No data", false);
        assert.ok(result.includes('"What is RSI?"'));
      });

      it("should NOT include the data JSON", () => {
        const result = buildFlashUserPrompt("test", "some data", false);
        assert.ok(!result.includes("some data"));
      });

      it("should mention no financial data found", () => {
        const result = buildFlashUserPrompt("test", "", false);
        assert.ok(result.includes("No financial data was found"));
      });

      it("should mention concept/definition fallback", () => {
        const result = buildFlashUserPrompt("test", "", false);
        assert.ok(result.includes("concept/definition question"));
      });

      it("should mention limited coverage for stocks", () => {
        const result = buildFlashUserPrompt("test", "", false);
        assert.ok(result.includes("limited coverage"));
      });

      it("should ask for concise response", () => {
        const result = buildFlashUserPrompt("test", "", false);
        assert.ok(result.includes("Respond concisely"));
      });
    });

    describe("edge cases", () => {
      it("should handle empty message", () => {
        const result = buildFlashUserPrompt("", "{}", true);
        assert.ok(result.includes('""'));
      });

      it("should handle message with special characters", () => {
        const msg = 'What is "PE ratio" & market cap?';
        const result = buildFlashUserPrompt(msg, "{}", true);
        assert.ok(result.includes(msg));
      });

      it("should handle message with newlines", () => {
        const msg = "line1\nline2";
        const result = buildFlashUserPrompt(msg, "{}", true);
        assert.ok(result.includes(msg));
      });

      it("should handle empty data JSON with hasData=true", () => {
        const result = buildFlashUserPrompt("test", "", true);
        assert.ok(result.includes("relevant financial data"));
      });
    });
  });
});
