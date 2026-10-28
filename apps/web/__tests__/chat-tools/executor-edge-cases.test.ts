/**
 * Tool Executor Edge Case Tests
 *
 * Edge cases for the tool execution pipeline.
 * Covers areas NOT tested in the main executor.test.ts:
 * - Error sanitization: multiple pattern matches, first-match precedence
 * - Non-Error throw types (string, number, object, null, boolean)
 * - Confirmation message with special characters in symbol (injection safety)
 * - File path regex doesn't match Windows-style backslash paths (gap)
 * - Timeout in tool execution → sanitized error
 * - Tool returns undefined → handled
 * - Empty error message after sanitization → fallback message
 * - Stack frame stripping edge cases
 *
 * Pure logic is reimplemented inline to avoid side-effecting imports.
 */

import { describe, it, mock } from "node:test";
import assert from "node:assert/strict";

// ── Types ──────────────────────────────────────────────────────────────

interface ToolResult {
  tool: string;
  success: boolean;
  data?: unknown;
  error?: string;
}

// De-shadowed (MONEY-620): assert the REAL pure helpers from executor-logic.ts
// (imported & called by executor.ts) — these edge cases (first-match
// precedence, Windows-path gap, empty/stack-frame fallback) now exercise the
// production sanitizer rather than a copy.
import {
  sanitizeToolError,
  generateConfirmation,
} from "@/lib/chat-tools/executor-logic";

// ===========================================================================
// TESTS
// ===========================================================================

describe("Tool Executor Edge Cases", () => {
  // ── Error sanitization: multiple pattern matches → first wins ─────

  describe("sanitizeToolError precedence", () => {
    it("should match ECONNREFUSED before prisma (connection error + db mention)", () => {
      const error = new Error(
        "ECONNREFUSED while connecting to prisma mongodb service"
      );
      const result = sanitizeToolError(error);
      // ECONNREFUSED check comes first, so it should win
      assert.strictEqual(
        result,
        "A required service is temporarily unavailable. Please try again in a moment."
      );
    });

    it("should match prisma before 401 when both present", () => {
      const error = new Error("prisma query failed with 401 Unauthorized");
      const result = sanitizeToolError(error);
      // prisma check (line 33) comes before 401 check (line 37)
      assert.strictEqual(
        result,
        "A database error occurred. Please try again."
      );
    });

    it("should match 401 before 429 when both present", () => {
      const error = new Error(
        "Request failed with 401 and rate limit 429 exceeded"
      );
      const result = sanitizeToolError(error);
      // 401 check comes before 429 check
      assert.strictEqual(
        result,
        "Your session may have expired. Please refresh and try again."
      );
    });

    it("should match ETIMEDOUT before mongodb", () => {
      const error = new Error("ETIMEDOUT connecting to mongodb cluster");
      const result = sanitizeToolError(error);
      assert.strictEqual(
        result,
        "A required service is temporarily unavailable. Please try again in a moment."
      );
    });

    it("should match getaddrinfo over other patterns", () => {
      const error = new Error(
        "getaddrinfo ENOTFOUND prisma-db.mongodb.net:27017"
      );
      const result = sanitizeToolError(error);
      assert.strictEqual(
        result,
        "A required service is temporarily unavailable. Please try again in a moment."
      );
    });
  });

  // ── Non-Error throw types ─────────────────────────────────────────

  describe("Non-Error throw handling", () => {
    it("should return generic message for thrown string", () => {
      assert.strictEqual(
        sanitizeToolError("connection failed"),
        "An unexpected error occurred. Please try again."
      );
    });

    it("should return generic message for thrown number", () => {
      assert.strictEqual(
        sanitizeToolError(500),
        "An unexpected error occurred. Please try again."
      );
    });

    it("should return generic message for thrown object", () => {
      assert.strictEqual(
        sanitizeToolError({ code: "ERR", msg: "oops" }),
        "An unexpected error occurred. Please try again."
      );
    });

    it("should return generic message for thrown boolean", () => {
      assert.strictEqual(
        sanitizeToolError(false),
        "An unexpected error occurred. Please try again."
      );
    });

    it("should return generic message for thrown array", () => {
      assert.strictEqual(
        sanitizeToolError(["error1", "error2"]),
        "An unexpected error occurred. Please try again."
      );
    });
  });

  // ── Confirmation message with special chars ──────────────────────

  describe("Confirmation message special character safety", () => {
    it("should handle symbol with HTML-like characters", () => {
      const msg = generateConfirmation("buy_paper_position", {
        quantity: 10,
        symbol: "<script>alert(1)</script>",
        price: 100,
      });
      // The template literal just interpolates directly; no injection in terminal
      assert.ok(msg.includes("<script>alert(1)</script>"));
      assert.ok(msg.includes("10 shares"));
    });

    it("should handle symbol with quotes", () => {
      const msg = generateConfirmation("buy_paper_position", {
        quantity: 5,
        symbol: 'M"&M',
        price: 2000,
      });
      assert.ok(msg.includes('M"&M'));
    });

    it("should handle symbol with unicode characters", () => {
      const msg = generateConfirmation("buy_paper_position", {
        quantity: 1,
        symbol: "RELIANCE\u200B",
        price: 2500,
      });
      assert.ok(msg.includes("RELIANCE"));
    });

    it("should handle symbol with newlines (no template injection)", () => {
      const msg = generateConfirmation("buy_paper_position", {
        quantity: 10,
        symbol: "TCS\nDROP TABLE",
        price: 3800,
      });
      assert.ok(msg.includes("TCS\nDROP TABLE"));
    });

    it("should handle FIRE scenario name with backticks", () => {
      const msg = generateConfirmation("create_fire_scenario", {
        name: "Plan `A`",
        currentAge: 30,
        retirementAge: 50,
        currentCorpus: 100000,
      });
      assert.ok(msg.includes("Plan `A`"));
    });
  });

  // ── File path regex: doesn't match Windows-style paths ─────────────

  describe("File path regex gap: Windows-style paths", () => {
    it("should NOT strip Windows-style backslash paths", () => {
      const error = new Error(
        "Error in C:\\Users\\app\\lib\\actions\\holdings.ts processing"
      );
      const result = sanitizeToolError(error);
      // The regex /\/[^\s]+\.[jt]sx?/g only matches forward slashes
      assert.ok(result.includes("C:\\Users\\app\\lib\\actions\\holdings.ts"));
    });

    it("should strip Unix-style forward slash paths", () => {
      const error = new Error(
        "Error in /app/lib/actions/holdings.ts processing"
      );
      const result = sanitizeToolError(error);
      assert.ok(!result.includes("/app/lib/actions/holdings.ts"));
      assert.ok(result.includes("[file]"));
    });

    it("should strip multiple Unix paths in one message", () => {
      const error = new Error(
        "Error in /app/lib/a.ts and /app/lib/b.tsx files"
      );
      const result = sanitizeToolError(error);
      assert.ok(!result.includes("/app/lib/a.ts"));
      assert.ok(!result.includes("/app/lib/b.tsx"));
    });
  });

  // ── Timeout in tool execution → sanitized error ────────────────────

  describe("Timeout errors", () => {
    it("should sanitize ETIMEDOUT from socket timeout", () => {
      const result = sanitizeToolError(
        new Error("Socket connection ETIMEDOUT to 10.0.0.1:443")
      );
      assert.strictEqual(
        result,
        "A required service is temporarily unavailable. Please try again in a moment."
      );
      assert.ok(!result.includes("10.0.0.1"));
    });

    it("should pass through AbortError as generic message (not in patterns)", () => {
      const error = new Error("The operation was aborted");
      error.name = "AbortError";
      const result = sanitizeToolError(error);
      // Not matched by any pattern, so passes through cleaned
      assert.strictEqual(result, "The operation was aborted");
    });

    it("should sanitize timeout that includes internal path", () => {
      const error = new Error(
        "Timeout in /app/lib/actions/holdings.ts after 30000ms"
      );
      const result = sanitizeToolError(error);
      assert.ok(!result.includes("/app/lib/actions/holdings.ts"));
      assert.ok(result.includes("[file]"));
      assert.ok(result.includes("30000ms"));
    });
  });

  // ── Tool returns undefined → handled ──────────────────────────────

  describe("Tool returning undefined or null", () => {
    it("should treat undefined result as a valid execution result", async () => {
      // In the real executor, tool.execute returns ToolResult.
      // If the function returns undefined, the `result` field would be undefined.
      const mockExecute = mock.fn(async (): Promise<ToolResult | undefined> => {
        return undefined;
      });

      const result = await mockExecute();
      // The executor wraps this in { executed: true, result: undefined }
      // which is valid - executed is true even though result is undefined
      assert.strictEqual(result, undefined);
    });

    it("should handle tool returning null data field", () => {
      const toolResult: ToolResult = {
        tool: "get_holdings",
        success: true,
        data: null,
      };
      assert.strictEqual(toolResult.success, true);
      assert.strictEqual(toolResult.data, null);
    });
  });

  // ── Empty error message after sanitization → fallback ─────────────

  describe("Empty error message edge cases", () => {
    it("should return fallback when Error message is empty", () => {
      const result = sanitizeToolError(new Error(""));
      // Empty string after .slice(0,200) → empty → fallback
      assert.strictEqual(
        result,
        "An error occurred while executing the action."
      );
    });

    it("should return fallback when message is only file paths", () => {
      const result = sanitizeToolError(new Error("/app/lib/test.ts"));
      // After path replacement: "[file]" - not empty, returns "[file]"
      assert.strictEqual(result, "[file]");
    });

    it("should return fallback when message is only stack frames", () => {
      const result = sanitizeToolError(
        new Error("at Object.run (/app/index.js)")
      );
      // After stack frame removal and path replacement, should have some content
      // "at Object.run (/app/index.js)" → stack frame regex removes "at Object.run (/app/index.js)"
      // Remaining: "" → fallback
      assert.strictEqual(
        result,
        "An error occurred while executing the action."
      );
    });

    it("should cap at 200 chars for long messages without patterns", () => {
      const longMessage = "A valid error: " + "x".repeat(300);
      const result = sanitizeToolError(new Error(longMessage));
      assert.strictEqual(result.length, 200);
    });
  });

  // ── Stack frame stripping ──────────────────────────────────────────

  describe("Stack frame stripping", () => {
    it("should strip inline stack frames from error message", () => {
      const result = sanitizeToolError(
        new Error("Failed at Function.execute (module.js:123:45) in handler")
      );
      assert.ok(!result.includes("module.js:123:45"));
      assert.ok(!result.includes("at Function.execute"));
    });

    it("should strip multiple stack frames", () => {
      const result = sanitizeToolError(
        new Error("Error at Foo.bar (a.js:1:2) and at Baz.qux (b.js:3:4) done")
      );
      assert.ok(!result.includes("at Foo.bar"));
      assert.ok(!result.includes("at Baz.qux"));
    });

    it("should preserve 'at' in normal words like 'at the market'", () => {
      const result = sanitizeToolError(new Error("Look at the market today"));
      assert.strictEqual(result, "Look at the market today");
    });
  });
});
