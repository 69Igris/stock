/**
 * Tool Executor Tests (lib/chat-tools/executor.ts)
 *
 * Tests for the tool execution pipeline:
 *   - generateConfirmation: user-friendly confirmation messages for write operations
 *   - simulateExecution: execution flow logic (unknown tool, invalid params, confirmation, success)
 *   - executeConfirmedTool flow: re-validates params, executes, returns ToolResult
 *
 * Pure functions extracted inline from the source (no side-effecting imports).
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

// ── Types ──────────────────────────────────────────────────────────────

interface ToolResult {
  tool: string;
  success: boolean;
  data?: unknown;
  error?: string;
}

interface ExecutionResult {
  executed: boolean;
  result?: ToolResult;
  needsConfirmation?: boolean;
  confirmationMessage?: string;
  error?: string;
}

interface MockTool {
  name: string;
  requiresConfirmation: boolean;
  execute: (
    params: Record<string, unknown>,
    userId: string
  ) => Promise<ToolResult>;
}

interface ValidationResult {
  success: boolean;
  params?: Record<string, unknown>;
  clarifyingQuestion?: string;
}

// De-shadowed (MONEY-620): import & assert the REAL pure helpers from
// executor-logic.ts (which executor.ts now imports and calls). This caught a
// drift the shadow hid: the old inline copy returned `Execute <tool>?` for the
// default confirmation and lacked the `run_research` branch entirely, while the
// real function returns `Confirm this action?` and has a research case.
import {
  sanitizeToolError,
  generateConfirmation,
} from "@/lib/chat-tools/executor-logic";

/**
 * Test harness that mirrors executeTool's branch ORDER (unknown → invalid →
 * confirm → execute). executeTool itself cannot be imported under node:test (it
 * pulls the registry's react.cache chain), so this harness drives the same
 * shape against mock tools while delegating the user-facing confirmation string
 * to the REAL generateConfirmation above.
 */
async function simulateExecution(
  tool: MockTool | null,
  toolName: string,
  params: Record<string, unknown>,
  validation: ValidationResult,
  skipConfirmation: boolean
): Promise<ExecutionResult> {
  if (!tool) {
    return { executed: false, error: `Unknown tool: ${toolName}` };
  }

  if (!validation.success) {
    return {
      executed: false,
      error: validation.clarifyingQuestion || "Invalid parameters",
    };
  }

  if (tool.requiresConfirmation && !skipConfirmation) {
    return {
      executed: false,
      needsConfirmation: true,
      confirmationMessage: generateConfirmation(toolName, validation.params!),
    };
  }

  try {
    const result = await tool.execute(validation.params!, "user-1");
    return { executed: true, result };
  } catch (error) {
    return {
      executed: false,
      error:
        error instanceof Error
          ? error.message
          : "An error occurred while executing the action",
    };
  }
}

/**
 * Simulate the executeConfirmedTool flow (for write ops after user confirms).
 */
async function simulateConfirmedExecution(
  tool: MockTool | null,
  toolName: string,
  params: Record<string, unknown>,
  validation: ValidationResult
): Promise<ToolResult> {
  if (!tool) {
    return {
      tool: toolName,
      success: false,
      error: `Unknown tool: ${toolName}`,
    };
  }

  if (!validation.success) {
    return {
      tool: toolName,
      success: false,
      error:
        validation.clarifyingQuestion || "Invalid parameters for this action",
    };
  }

  try {
    return await tool.execute(validation.params!, "user-1");
  } catch (error) {
    return {
      tool: toolName,
      success: false,
      error:
        error instanceof Error
          ? error.message
          : "An error occurred while executing the action",
    };
  }
}

// ── Helpers ────────────────────────────────────────────────────────────

function createMockTool(
  overrides: Partial<MockTool> & { name: string }
): MockTool {
  return {
    requiresConfirmation: false,
    execute: async () => ({
      tool: overrides.name,
      success: true,
      data: { mock: true },
    }),
    ...overrides,
  };
}

function validResult(params: Record<string, unknown>): ValidationResult {
  return { success: true, params };
}

function invalidResult(question?: string): ValidationResult {
  return { success: false, clarifyingQuestion: question };
}

// ======================================================================
// Tests
// ======================================================================

describe("Tool Executor", () => {
  // ── generateConfirmation ──────────────────────────────────────────

  describe("generateConfirmation", () => {
    describe("create_fire_scenario", () => {
      it("should include scenario name in confirmation", () => {
        const msg = generateConfirmation("create_fire_scenario", {
          name: "My Plan",
          currentAge: 30,
          retirementAge: 50,
          currentCorpus: 1000000,
        });
        assert.ok(msg.includes('"My Plan"'));
      });

      it("should include currentAge and retirementAge", () => {
        const msg = generateConfirmation("create_fire_scenario", {
          name: "Plan",
          currentAge: 28,
          retirementAge: 45,
          currentCorpus: 500000,
        });
        assert.ok(msg.includes("age 28"));
        assert.ok(msg.includes("45"));
      });

      it("should include corpus amount with rupee symbol", () => {
        const msg = generateConfirmation("create_fire_scenario", {
          name: "Plan",
          currentAge: 30,
          retirementAge: 50,
          currentCorpus: 2500000,
        });
        assert.ok(msg.includes("₹2500000"));
      });

      it("should produce exact expected format", () => {
        const msg = generateConfirmation("create_fire_scenario", {
          name: "Retire Early",
          currentAge: 25,
          retirementAge: 40,
          currentCorpus: 0,
        });
        assert.strictEqual(
          msg,
          'Create a new FIRE scenario "Retire Early" (age 25 → 40, corpus ₹0)?'
        );
      });

      it("should handle special characters in name", () => {
        const msg = generateConfirmation("create_fire_scenario", {
          name: 'Plan "A" & B',
          currentAge: 30,
          retirementAge: 55,
          currentCorpus: 100,
        });
        assert.ok(msg.includes('Plan "A" & B'));
      });
    });

    describe("buy_paper_position", () => {
      it("should include quantity, symbol, and price", () => {
        const msg = generateConfirmation("buy_paper_position", {
          quantity: 10,
          symbol: "RELIANCE",
          price: 2500,
        });
        assert.ok(msg.includes("10 shares"));
        assert.ok(msg.includes("RELIANCE"));
        assert.ok(msg.includes("₹2500"));
      });

      it("should produce exact expected format", () => {
        const msg = generateConfirmation("buy_paper_position", {
          quantity: 50,
          symbol: "TCS",
          price: 3800.5,
        });
        assert.strictEqual(
          msg,
          "Buy 50 shares of TCS at ₹3800.5 in paper trading?"
        );
      });

      it("should handle 1 share singular phrasing (still says shares)", () => {
        const msg = generateConfirmation("buy_paper_position", {
          quantity: 1,
          symbol: "INFY",
          price: 1500,
        });
        assert.ok(msg.includes("1 shares"));
      });

      it("should handle decimal price", () => {
        const msg = generateConfirmation("buy_paper_position", {
          quantity: 100,
          symbol: "SBIN",
          price: 612.75,
        });
        assert.ok(msg.includes("₹612.75"));
      });
    });

    describe("sell_paper_position", () => {
      it("should include exit price", () => {
        const msg = generateConfirmation("sell_paper_position", {
          price: 1800,
        });
        assert.ok(msg.includes("₹1800"));
      });

      it("should produce exact expected format", () => {
        const msg = generateConfirmation("sell_paper_position", {
          price: 2750.25,
        });
        assert.strictEqual(msg, "Sell paper position at ₹2750.25?");
      });

      it("should handle zero price", () => {
        const msg = generateConfirmation("sell_paper_position", {
          price: 0,
        });
        assert.strictEqual(msg, "Sell paper position at ₹0?");
      });
    });

    describe("run_research", () => {
      it("should label advanced research as 'comprehensive' with joined symbols", () => {
        const msg = generateConfirmation("run_research", {
          mode: "advanced",
          symbols: ["TCS", "INFY"],
        });
        assert.strictEqual(msg, "Start comprehensive research on TCS, INFY?");
      });

      it("should label non-advanced research as 'quick'", () => {
        const msg = generateConfirmation("run_research", {
          mode: "fast",
          symbols: ["TCS"],
        });
        assert.strictEqual(msg, "Start quick research on TCS?");
      });

      it("should fall back to query then 'this stock' when no symbols", () => {
        assert.strictEqual(
          generateConfirmation("run_research", { query: "Tata Motors" }),
          "Start quick research on Tata Motors?"
        );
        assert.strictEqual(
          generateConfirmation("run_research", {}),
          "Start quick research on this stock?"
        );
      });
    });

    describe("default / unknown tools", () => {
      // The REAL default is a generic "Confirm this action?" — the old shadow
      // asserted "Execute <tool>?", which never matched production.
      it("should return the generic confirmation for unknown tools", () => {
        const msg = generateConfirmation("delete_account", {});
        assert.strictEqual(msg, "Confirm this action?");
      });

      it("should return the generic confirmation for get_holdings", () => {
        const msg = generateConfirmation("get_holdings", { broker: "ZERODHA" });
        assert.strictEqual(msg, "Confirm this action?");
      });

      it("should handle empty string toolName", () => {
        const msg = generateConfirmation("", {});
        assert.strictEqual(msg, "Confirm this action?");
      });

      it("should handle toolName with special characters", () => {
        const msg = generateConfirmation("my_tool-v2.0", {});
        assert.strictEqual(msg, "Confirm this action?");
      });
    });

    describe("edge cases for params", () => {
      it("should handle empty params for create_fire_scenario (shows undefined)", () => {
        const msg = generateConfirmation("create_fire_scenario", {});
        assert.ok(msg.includes("undefined"));
      });

      it("should handle null values in params", () => {
        const msg = generateConfirmation("buy_paper_position", {
          quantity: null,
          symbol: null,
          price: null,
        });
        assert.ok(msg.includes("null shares"));
        assert.ok(msg.includes("₹null"));
      });

      it("should handle very large numbers", () => {
        const msg = generateConfirmation("create_fire_scenario", {
          name: "Big Plan",
          currentAge: 30,
          retirementAge: 65,
          currentCorpus: 999999999999,
        });
        assert.ok(msg.includes("₹999999999999"));
      });

      it("should handle params with extra fields (ignored)", () => {
        const msg = generateConfirmation("sell_paper_position", {
          price: 100,
          extraField: "ignored",
          anotherField: 42,
        });
        assert.strictEqual(msg, "Sell paper position at ₹100?");
      });
    });
  });

  // ── simulateExecution (executeTool flow) ──────────────────────────

  describe("simulateExecution (executeTool flow)", () => {
    describe("unknown tool", () => {
      it("should return error when tool is null", async () => {
        const result = await simulateExecution(
          null,
          "nonexistent_tool",
          {},
          validResult({}),
          false
        );
        assert.strictEqual(result.executed, false);
        assert.ok(result.error?.includes("Unknown tool"));
        assert.ok(result.error?.includes("nonexistent_tool"));
      });

      it("should not set needsConfirmation when tool is null", async () => {
        const result = await simulateExecution(
          null,
          "bad_tool",
          {},
          validResult({}),
          false
        );
        assert.strictEqual(result.needsConfirmation, undefined);
      });
    });

    describe("invalid params", () => {
      it("should return error when validation fails", async () => {
        const tool = createMockTool({ name: "get_holdings" });
        const result = await simulateExecution(
          tool,
          "get_holdings",
          {},
          invalidResult("Missing required field: broker"),
          false
        );
        assert.strictEqual(result.executed, false);
        assert.strictEqual(result.error, "Missing required field: broker");
      });

      it("should use default error message when no clarifying question", async () => {
        const tool = createMockTool({ name: "get_holdings" });
        const result = await simulateExecution(
          tool,
          "get_holdings",
          {},
          invalidResult(),
          false
        );
        assert.strictEqual(result.executed, false);
        assert.strictEqual(result.error, "Invalid parameters");
      });

      it("should not execute when params are invalid", async () => {
        let executeCount = 0;
        const tool = createMockTool({
          name: "get_holdings",
          execute: async () => {
            executeCount++;
            return { tool: "get_holdings", success: true };
          },
        });
        await simulateExecution(
          tool,
          "get_holdings",
          {},
          invalidResult("bad params"),
          false
        );
        assert.strictEqual(executeCount, 0);
      });
    });

    describe("confirmation required", () => {
      it("should return needsConfirmation when tool requires confirmation", async () => {
        const tool = createMockTool({
          name: "create_fire_scenario",
          requiresConfirmation: true,
        });
        const result = await simulateExecution(
          tool,
          "create_fire_scenario",
          {},
          validResult({
            name: "Plan",
            currentAge: 30,
            retirementAge: 50,
            currentCorpus: 100,
          }),
          false
        );
        assert.strictEqual(result.executed, false);
        assert.strictEqual(result.needsConfirmation, true);
        assert.ok(result.confirmationMessage);
      });

      it("should include correct confirmation message for fire scenario", async () => {
        const tool = createMockTool({
          name: "create_fire_scenario",
          requiresConfirmation: true,
        });
        const result = await simulateExecution(
          tool,
          "create_fire_scenario",
          {},
          validResult({
            name: "My FIRE",
            currentAge: 25,
            retirementAge: 40,
            currentCorpus: 500000,
          }),
          false
        );
        assert.ok(result.confirmationMessage?.includes('"My FIRE"'));
        assert.ok(result.confirmationMessage?.includes("age 25"));
        assert.ok(result.confirmationMessage?.includes("₹500000"));
      });

      it("should bypass confirmation when skipConfirmation is true", async () => {
        const tool = createMockTool({
          name: "buy_paper_position",
          requiresConfirmation: true,
        });
        const result = await simulateExecution(
          tool,
          "buy_paper_position",
          {},
          validResult({ symbol: "TCS", quantity: 10, price: 3800 }),
          true
        );
        assert.strictEqual(result.executed, true);
        assert.strictEqual(result.needsConfirmation, undefined);
      });

      it("should not require confirmation for read tools", async () => {
        const tool = createMockTool({
          name: "get_holdings",
          requiresConfirmation: false,
        });
        const result = await simulateExecution(
          tool,
          "get_holdings",
          {},
          validResult({}),
          false
        );
        assert.strictEqual(result.executed, true);
        assert.strictEqual(result.needsConfirmation, undefined);
      });
    });

    describe("successful execution", () => {
      it("should execute and return result for read tool", async () => {
        const tool = createMockTool({
          name: "get_holdings",
          execute: async () => ({
            tool: "get_holdings",
            success: true,
            data: [{ symbol: "TCS" }],
          }),
        });
        const result = await simulateExecution(
          tool,
          "get_holdings",
          {},
          validResult({}),
          false
        );
        assert.strictEqual(result.executed, true);
        assert.strictEqual(result.result?.tool, "get_holdings");
        assert.strictEqual(result.result?.success, true);
      });

      it("should pass validated params to execute", async () => {
        let receivedParams: Record<string, unknown> = {};
        const tool = createMockTool({
          name: "get_holdings",
          execute: async (params) => {
            receivedParams = params;
            return { tool: "get_holdings", success: true };
          },
        });
        await simulateExecution(
          tool,
          "get_holdings",
          { raw: "data" },
          validResult({ broker: "ZERODHA" }),
          false
        );
        assert.deepStrictEqual(receivedParams, { broker: "ZERODHA" });
      });

      it("should execute confirmed write tool when skipConfirmation is true", async () => {
        const tool = createMockTool({
          name: "sell_paper_position",
          requiresConfirmation: true,
          execute: async () => ({
            tool: "sell_paper_position",
            success: true,
            data: { closedAt: "2026-02-24" },
          }),
        });
        const result = await simulateExecution(
          tool,
          "sell_paper_position",
          {},
          validResult({ positionId: "p1", exitPrice: 1800 }),
          true
        );
        assert.strictEqual(result.executed, true);
        assert.strictEqual(result.result?.success, true);
      });
    });

    describe("execution errors", () => {
      it("should catch Error instances and return message", async () => {
        const tool = createMockTool({
          name: "get_holdings",
          execute: async () => {
            throw new Error("Database connection failed");
          },
        });
        const result = await simulateExecution(
          tool,
          "get_holdings",
          {},
          validResult({}),
          false
        );
        assert.strictEqual(result.executed, false);
        assert.strictEqual(result.error, "Database connection failed");
      });

      it("should catch non-Error throws and return generic message", async () => {
        const tool = createMockTool({
          name: "get_holdings",
          execute: async () => {
            throw "string error";
          },
        });
        const result = await simulateExecution(
          tool,
          "get_holdings",
          {},
          validResult({}),
          false
        );
        assert.strictEqual(result.executed, false);
        assert.strictEqual(
          result.error,
          "An error occurred while executing the action"
        );
      });

      it("should catch TypeError and return its message", async () => {
        const tool = createMockTool({
          name: "get_holdings",
          execute: async () => {
            throw new TypeError("Cannot read property of undefined");
          },
        });
        const result = await simulateExecution(
          tool,
          "get_holdings",
          {},
          validResult({}),
          false
        );
        assert.strictEqual(result.executed, false);
        assert.strictEqual(result.error, "Cannot read property of undefined");
      });
    });
  });

  // ── simulateConfirmedExecution (executeConfirmedTool flow) ────────

  describe("simulateConfirmedExecution (executeConfirmedTool flow)", () => {
    it("should return error for unknown tool", async () => {
      const result = await simulateConfirmedExecution(
        null,
        "nonexistent_tool",
        {},
        validResult({})
      );
      assert.strictEqual(result.success, false);
      assert.strictEqual(result.tool, "nonexistent_tool");
      assert.ok(result.error?.includes("Unknown tool"));
    });

    it("should return error for invalid params", async () => {
      const tool = createMockTool({ name: "create_fire_scenario" });
      const result = await simulateConfirmedExecution(
        tool,
        "create_fire_scenario",
        {},
        invalidResult("Please provide: name, currentAge")
      );
      assert.strictEqual(result.success, false);
      assert.strictEqual(result.tool, "create_fire_scenario");
      assert.strictEqual(result.error, "Please provide: name, currentAge");
    });

    it("should use default error when no clarifying question", async () => {
      const tool = createMockTool({ name: "buy_paper_position" });
      const result = await simulateConfirmedExecution(
        tool,
        "buy_paper_position",
        {},
        invalidResult()
      );
      assert.strictEqual(result.error, "Invalid parameters for this action");
    });

    it("should execute successfully with valid params", async () => {
      const tool = createMockTool({
        name: "create_fire_scenario",
        requiresConfirmation: true,
        execute: async (params) => ({
          tool: "create_fire_scenario",
          success: true,
          data: { id: "scenario-1", name: params.name },
        }),
      });
      const result = await simulateConfirmedExecution(
        tool,
        "create_fire_scenario",
        {},
        validResult({
          name: "My FIRE",
          currentAge: 30,
          retirementAge: 50,
          currentCorpus: 100000,
        })
      );
      assert.strictEqual(result.success, true);
      assert.strictEqual(result.tool, "create_fire_scenario");
    });

    it("should catch execution errors and return ToolResult format", async () => {
      const tool = createMockTool({
        name: "buy_paper_position",
        execute: async () => {
          throw new Error("Insufficient balance");
        },
      });
      const result = await simulateConfirmedExecution(
        tool,
        "buy_paper_position",
        {},
        validResult({ symbol: "RELIANCE", quantity: 10, price: 2500 })
      );
      assert.strictEqual(result.success, false);
      assert.strictEqual(result.tool, "buy_paper_position");
      assert.strictEqual(result.error, "Insufficient balance");
    });

    it("should catch non-Error throws in confirmed execution", async () => {
      const tool = createMockTool({
        name: "sell_paper_position",
        execute: async () => {
          throw 42;
        },
      });
      const result = await simulateConfirmedExecution(
        tool,
        "sell_paper_position",
        {},
        validResult({ positionId: "p1", exitPrice: 1800 })
      );
      assert.strictEqual(result.success, false);
      assert.strictEqual(
        result.error,
        "An error occurred while executing the action"
      );
    });

    it("should always include tool name in result", async () => {
      const tool = createMockTool({
        name: "sell_paper_position",
        execute: async () => ({ tool: "sell_paper_position", success: true }),
      });
      const result = await simulateConfirmedExecution(
        tool,
        "sell_paper_position",
        {},
        validResult({ positionId: "p1", exitPrice: 100 })
      );
      assert.strictEqual(result.tool, "sell_paper_position");
    });

    it("should re-validate params (prevent garbage data)", async () => {
      let executeCallCount = 0;
      const tool = createMockTool({
        name: "create_fire_scenario",
        execute: async () => {
          executeCallCount++;
          return { tool: "create_fire_scenario", success: true };
        },
      });
      await simulateConfirmedExecution(
        tool,
        "create_fire_scenario",
        {},
        invalidResult("Missing name")
      );
      assert.strictEqual(executeCallCount, 0);
    });
  });

  // ── Integration-style flow tests ──────────────────────────────────

  describe("full execution flow", () => {
    it("read tool: valid params → immediate execution", async () => {
      const tool = createMockTool({
        name: "get_portfolio_summary",
        requiresConfirmation: false,
        execute: async () => ({
          tool: "get_portfolio_summary",
          success: true,
          data: { totalValue: 500000 },
        }),
      });
      const result = await simulateExecution(
        tool,
        "get_portfolio_summary",
        {},
        validResult({}),
        false
      );
      assert.strictEqual(result.executed, true);
      assert.strictEqual(result.result?.success, true);
    });

    it("write tool: valid params, no skip → confirmation required", async () => {
      const tool = createMockTool({
        name: "buy_paper_position",
        requiresConfirmation: true,
      });
      const result = await simulateExecution(
        tool,
        "buy_paper_position",
        {},
        validResult({ symbol: "INFY", quantity: 5, price: 1500 }),
        false
      );
      assert.strictEqual(result.executed, false);
      assert.strictEqual(result.needsConfirmation, true);
      assert.ok(result.confirmationMessage?.includes("INFY"));
    });

    it("write tool: valid params, skip → immediate execution", async () => {
      const tool = createMockTool({
        name: "buy_paper_position",
        requiresConfirmation: true,
        execute: async () => ({
          tool: "buy_paper_position",
          success: true,
          data: { positionId: "p1" },
        }),
      });
      const result = await simulateExecution(
        tool,
        "buy_paper_position",
        {},
        validResult({ symbol: "INFY", quantity: 5, price: 1500 }),
        true
      );
      assert.strictEqual(result.executed, true);
      assert.strictEqual(result.result?.success, true);
    });

    it("invalid params take priority over confirmation check", async () => {
      const tool = createMockTool({
        name: "create_fire_scenario",
        requiresConfirmation: true,
      });
      const result = await simulateExecution(
        tool,
        "create_fire_scenario",
        {},
        invalidResult("Missing: name"),
        false
      );
      assert.strictEqual(result.executed, false);
      assert.strictEqual(result.error, "Missing: name");
      assert.strictEqual(result.needsConfirmation, undefined);
    });

    it("unknown tool check happens before param validation", async () => {
      const result = await simulateExecution(
        null,
        "missing_tool",
        { garbage: true },
        invalidResult("also invalid"),
        false
      );
      assert.ok(result.error?.includes("Unknown tool: missing_tool"));
    });
  });

  // ── sanitizeToolError ──────────────────────────────────────────────

  describe("sanitizeToolError", () => {
    describe("non-Error values", () => {
      it("should return generic message for string throws", () => {
        assert.strictEqual(
          sanitizeToolError("string error"),
          "An unexpected error occurred. Please try again."
        );
      });

      it("should return generic message for number throws", () => {
        assert.strictEqual(
          sanitizeToolError(42),
          "An unexpected error occurred. Please try again."
        );
      });

      it("should return generic message for null", () => {
        assert.strictEqual(
          sanitizeToolError(null),
          "An unexpected error occurred. Please try again."
        );
      });

      it("should return generic message for undefined", () => {
        assert.strictEqual(
          sanitizeToolError(undefined),
          "An unexpected error occurred. Please try again."
        );
      });
    });

    describe("network errors", () => {
      it("should sanitize ECONNREFUSED errors", () => {
        const result = sanitizeToolError(
          new Error("connect ECONNREFUSED 127.0.0.1:27017")
        );
        assert.ok(result.includes("temporarily unavailable"));
        assert.ok(!result.includes("127.0.0.1"));
      });

      it("should sanitize ETIMEDOUT errors", () => {
        const result = sanitizeToolError(
          new Error("connect ETIMEDOUT 10.0.0.5:5432")
        );
        assert.ok(result.includes("temporarily unavailable"));
        assert.ok(!result.includes("10.0.0.5"));
      });

      it("should sanitize DNS resolution errors", () => {
        const result = sanitizeToolError(
          new Error("getaddrinfo ENOTFOUND db.internal.service")
        );
        assert.ok(result.includes("temporarily unavailable"));
        assert.ok(!result.includes("db.internal.service"));
      });
    });

    describe("database errors", () => {
      it("should sanitize Prisma errors", () => {
        const result = sanitizeToolError(
          new Error("prisma.user.findUnique() invocation failed")
        );
        assert.strictEqual(
          result,
          "A database error occurred. Please try again."
        );
      });

      it("should sanitize MongoDB errors", () => {
        const result = sanitizeToolError(
          new Error("mongodb connection to cluster0.abc123.mongodb.net failed")
        );
        assert.strictEqual(
          result,
          "A database error occurred. Please try again."
        );
        assert.ok(!result.includes("cluster0"));
      });
    });

    describe("auth errors", () => {
      it("should sanitize 401 errors", () => {
        const result = sanitizeToolError(
          new Error("Request failed with status 401")
        );
        assert.ok(result.includes("session may have expired"));
      });

      it("should sanitize Unauthorized errors", () => {
        const result = sanitizeToolError(
          new Error("Unauthorized access to resource")
        );
        assert.ok(result.includes("session may have expired"));
      });
    });

    describe("rate limit errors", () => {
      it("should sanitize 429 errors", () => {
        const result = sanitizeToolError(
          new Error("Request failed with status 429")
        );
        assert.ok(result.includes("Too many requests"));
      });

      it("should sanitize rate limit message errors", () => {
        const result = sanitizeToolError(new Error("API rate limit exceeded"));
        assert.ok(result.includes("Too many requests"));
      });
    });

    describe("file path stripping", () => {
      it("should strip .ts file paths", () => {
        const result = sanitizeToolError(
          new Error("Error in /app/lib/actions/holdings.ts processing")
        );
        assert.ok(!result.includes("/app/lib/actions/holdings.ts"));
        assert.ok(result.includes("[file]"));
      });

      it("should strip .tsx file paths", () => {
        const result = sanitizeToolError(
          new Error("Component /src/components/Button.tsx failed")
        );
        assert.ok(!result.includes("/src/components/Button.tsx"));
      });

      it("should strip .js file paths", () => {
        const result = sanitizeToolError(
          new Error("Module /dist/server.js threw error")
        );
        assert.ok(!result.includes("/dist/server.js"));
      });
    });

    describe("message length capping", () => {
      it("should cap error messages to 200 characters", () => {
        const longMessage = "A".repeat(500);
        const result = sanitizeToolError(new Error(longMessage));
        assert.ok(result.length <= 200);
      });
    });

    describe("passthrough for safe messages", () => {
      it("should pass through a normal error message", () => {
        const result = sanitizeToolError(new Error("Invalid stock symbol"));
        assert.strictEqual(result, "Invalid stock symbol");
      });

      it("should pass through a validation error", () => {
        const result = sanitizeToolError(
          new Error("Quantity must be positive")
        );
        assert.strictEqual(result, "Quantity must be positive");
      });
    });
  });
});
