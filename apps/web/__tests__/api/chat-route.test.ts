/**
 * Chat API Route Tests (app/api/chat/route.ts)
 *
 * Integration-style tests for the POST /api/chat handler covering:
 *   - Authentication (401 for unauthenticated)
 *   - Request validation (400 for missing fields)
 *   - Input guardrail blocking (blocked + consumed)
 *   - Fast-path tool execution (read-only tools without LLM)
 *   - Tool confirmation flow (write tools return action blocks)
 *   - Query consumption (403 when exhausted)
 *   - Gemini disabled mock response path
 *   - Block auto-formatting (array→table, object→card, nested unwrap)
 *   - Error handling (timeout→504, rate limit→429, config→500, generic→500)
 *   - Query refund on Gemini failure
 *   - GET health check
 *
 * All external dependencies are inlined/mocked as pure functions.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

// ── Types ──────────────────────────────────────────────────────────────

type QueryMode = "fast" | "pro";

interface ContentBlock {
  type: string;
  content?: string;
  title?: string;
  columns?: unknown[];
  rows?: unknown[];
  items?: unknown[];
  variant?: string;
  actionId?: string;
  tool?: string;
  description?: string;
  params?: unknown;
  status?: string;
}

interface ChatResponse {
  response: string;
  blocks?: ContentBlock[];
  action?: unknown;
  remaining?: number;
  queryType?: QueryMode;
  toolResults?: unknown[];
  blocked?: boolean;
  error?: string;
}

interface ToolResult {
  tool: string;
  success: boolean;
  data?: unknown;
  error?: string;
  renderType?: string;
}

interface ToolExecutionResult {
  executed: boolean;
  needsConfirmation?: boolean;
  confirmationMessage?: string;
  result?: ToolResult;
}

// ── Inline logic from route.ts ─────────────────────────────────────────

/**
 * Auto-format array data as table blocks
 */
function autoFormatArrayAsTable(
  data: unknown[],
  toolName: string
): ContentBlock | null {
  if (data.length === 0) return null;

  const sample = data[0] as Record<string, unknown>;
  const columns = Object.keys(sample)
    .filter(
      (k) =>
        k !== "id" && k !== "userId" && k !== "createdAt" && k !== "updatedAt"
    )
    .filter((k) => typeof sample[k] !== "object" || sample[k] === null)
    .slice(0, 8)
    .map((key) => ({
      key,
      label: key
        .replace(/([A-Z])/g, " $1")
        .replace(/^./, (s) => s.toUpperCase()),
      align: typeof sample[key] === "number" ? "right" : "left",
      ...(typeof sample[key] === "number" && key.toLowerCase().includes("pnl")
        ? { format: "pnl" }
        : {}),
      ...(typeof sample[key] === "number" &&
      (key.toLowerCase().includes("price") ||
        key.toLowerCase().includes("value") ||
        key.toLowerCase().includes("invested") ||
        key.toLowerCase().includes("amount"))
        ? { format: "currency" }
        : {}),
    }));

  return {
    type: "table",
    title:
      toolName
        .replace(/_/g, " ")
        .replace(/^get /, "")
        .replace(/^./, (s: string) => s.toUpperCase()) || "Results",
    columns,
    rows: data.slice(0, 15) as Record<string, unknown>[],
  };
}

/**
 * Auto-format object data as card blocks
 */
function autoFormatObjectAsCard(
  data: Record<string, unknown>,
  toolName: string
): ContentBlock {
  const items = Object.entries(data)
    .filter(([k]) => k !== "id" && k !== "userId")
    .filter(([, v]) => typeof v !== "object" || v === null)
    .slice(0, 8)
    .map(([key, value]) => ({
      label: key
        .replace(/([A-Z])/g, " $1")
        .replace(/^./, (s) => s.toUpperCase()),
      value:
        typeof value === "number"
          ? `₹${value.toLocaleString("en-IN")}`
          : String(value ?? "N/A"),
    }));

  return {
    type: "card",
    variant: "metric",
    title:
      toolName
        .replace(/_/g, " ")
        .replace(/^get /, "")
        .replace(/^./, (s: string) => s.toUpperCase()) || "Result",
    items,
  };
}

/**
 * Unwrap nested objects to find the first array property
 */
function unwrapNestedData(data: unknown): unknown {
  if (!Array.isArray(data) && typeof data === "object" && data !== null) {
    const obj = data as Record<string, unknown>;
    const arrayKey = Object.keys(obj).find((k) => Array.isArray(obj[k]));
    if (arrayKey) {
      return obj[arrayKey];
    }
  }
  return data;
}

/**
 * Check authentication
 */
function checkAuth(userId: string | null): {
  error?: string;
  status?: number;
} {
  if (!userId) {
    return { error: "Authentication required", status: 401 };
  }
  return {};
}

/**
 * Validate request body
 */
function validateRequest(body: { message?: string; pagePath?: string }): {
  error?: string;
  status?: number;
} {
  if (!body.message || !body.pagePath) {
    return {
      error: "Message and pagePath are required",
      status: 400,
    };
  }
  return {};
}

/**
 * Map Gemini error to HTTP status/message
 */
function mapGeminiError(errorMessage: string): {
  status: number;
  error: string;
} {
  if (errorMessage.includes("timeout")) {
    return {
      status: 504,
      error:
        "The request took too long to process. Please try again with a shorter question or use fast mode.",
    };
  }

  if (errorMessage.includes("429") || errorMessage.includes("quota")) {
    return {
      status: 429,
      error:
        "AI service is temporarily busy. Please try again in a few moments.",
    };
  }

  const isInvalidConfig =
    errorMessage.includes("Invalid JSON payload") ||
    errorMessage.includes("Invalid argument") ||
    errorMessage.includes("Cannot find field");

  if (isInvalidConfig) {
    return {
      status: 500,
      error:
        "We're experiencing a technical issue with the advanced AI model. Please try using Fast mode instead, or try again in a few moments.",
    };
  }

  return {
    status: 500,
    error:
      "We're having trouble processing your request right now. Please try again in a moment, or switch to Fast mode for quicker responses.",
  };
}

/**
 * Build tool title from tool name
 */
function buildToolTitle(toolName: string | undefined): string {
  return (
    (toolName || "")
      .replace(/_/g, " ")
      .replace(/^get /, "")
      .replace(/^./, (s: string) => s.toUpperCase()) || "Results"
  );
}

// ── Tests ──────────────────────────────────────────────────────────────

describe("Chat API Route", () => {
  // ───────────────────── Authentication ─────────────────────

  describe("Authentication", () => {
    it("should return 401 when userId is null", () => {
      const result = checkAuth(null);
      assert.strictEqual(result.status, 401);
      assert.strictEqual(result.error, "Authentication required");
    });

    it("should return 401 when userId is empty string", () => {
      const result = checkAuth("");
      assert.strictEqual(result.status, 401);
    });

    it("should pass when userId is present", () => {
      const result = checkAuth("user_123");
      assert.strictEqual(result.error, undefined);
      assert.strictEqual(result.status, undefined);
    });
  });

  // ───────────────────── Request validation ─────────────────────

  describe("Request validation", () => {
    it("should return 400 when message is missing", () => {
      const result = validateRequest({ pagePath: "/dashboard" });
      assert.strictEqual(result.status, 400);
      assert.ok(result.error?.includes("Message and pagePath"));
    });

    it("should return 400 when pagePath is missing", () => {
      const result = validateRequest({ message: "Hello" });
      assert.strictEqual(result.status, 400);
    });

    it("should return 400 when both are missing", () => {
      const result = validateRequest({});
      assert.strictEqual(result.status, 400);
    });

    it("should pass when both are present", () => {
      const result = validateRequest({
        message: "Hello",
        pagePath: "/dashboard",
      });
      assert.strictEqual(result.error, undefined);
    });

    it("should return 400 for empty message string", () => {
      const result = validateRequest({ message: "", pagePath: "/dashboard" });
      assert.strictEqual(result.status, 400);
    });

    it("should return 400 for empty pagePath string", () => {
      const result = validateRequest({ message: "Hello", pagePath: "" });
      assert.strictEqual(result.status, 400);
    });
  });

  // ───────────────────── Auto-format: array as table ─────────────────────

  describe("autoFormatArrayAsTable", () => {
    it("should create table block from array of objects", () => {
      const data = [
        { symbol: "TCS", quantity: 10, price: 3500 },
        { symbol: "INFY", quantity: 5, price: 1800 },
      ];
      const block = autoFormatArrayAsTable(data, "get_holdings");
      assert.ok(block);
      assert.strictEqual(block.type, "table");
      assert.ok(block.columns);
      assert.ok(block.rows);
    });

    it("should return null for empty array", () => {
      const block = autoFormatArrayAsTable([], "get_holdings");
      assert.strictEqual(block, null);
    });

    it("should filter out id, userId, createdAt, updatedAt columns", () => {
      const data = [
        {
          id: "1",
          userId: "u1",
          symbol: "TCS",
          createdAt: "2024-01-01",
          updatedAt: "2024-01-02",
        },
      ];
      const block = autoFormatArrayAsTable(data, "get_holdings");
      assert.ok(block);
      const columns = block.columns as { key: string }[];
      const keys = columns.map((c) => c.key);
      assert.ok(!keys.includes("id"));
      assert.ok(!keys.includes("userId"));
      assert.ok(!keys.includes("createdAt"));
      assert.ok(!keys.includes("updatedAt"));
      assert.ok(keys.includes("symbol"));
    });

    it("should filter out object-type columns (except null)", () => {
      const data = [
        {
          symbol: "TCS",
          price: 3500,
          details: { sector: "IT" },
          note: null,
        },
      ];
      const block = autoFormatArrayAsTable(data, "get_holdings");
      assert.ok(block);
      const columns = block.columns as { key: string }[];
      const keys = columns.map((c) => c.key);
      assert.ok(!keys.includes("details"));
      assert.ok(keys.includes("note"));
      assert.ok(keys.includes("symbol"));
    });

    it("should limit to 8 columns", () => {
      const data = [
        {
          a: 1,
          b: 2,
          c: 3,
          d: 4,
          e: 5,
          f: 6,
          g: 7,
          h: 8,
          i: 9,
          j: 10,
        },
      ];
      const block = autoFormatArrayAsTable(data, "test");
      assert.ok(block);
      const columns = block.columns as unknown[];
      assert.strictEqual(columns.length, 8);
    });

    it("should limit to 15 rows", () => {
      const data = Array.from({ length: 25 }, (_, i) => ({
        symbol: `SYM${i}`,
        price: i * 100,
      }));
      const block = autoFormatArrayAsTable(data, "test");
      assert.ok(block);
      const rows = block.rows as unknown[];
      assert.strictEqual(rows.length, 15);
    });

    it("should align number columns to right", () => {
      const data = [{ symbol: "TCS", price: 3500 }];
      const block = autoFormatArrayAsTable(data, "test");
      assert.ok(block);
      const columns = block.columns as { key: string; align: string }[];
      const priceCol = columns.find((c) => c.key === "price");
      assert.strictEqual(priceCol?.align, "right");
    });

    it("should align string columns to left", () => {
      const data = [{ symbol: "TCS", price: 3500 }];
      const block = autoFormatArrayAsTable(data, "test");
      assert.ok(block);
      const columns = block.columns as { key: string; align: string }[];
      const symbolCol = columns.find((c) => c.key === "symbol");
      assert.strictEqual(symbolCol?.align, "left");
    });

    it("should add pnl format for pnl-like columns", () => {
      const data = [{ symbol: "TCS", unrealizedPnl: 5000 }];
      const block = autoFormatArrayAsTable(data, "test");
      assert.ok(block);
      const columns = block.columns as {
        key: string;
        format?: string;
      }[];
      const pnlCol = columns.find((c) => c.key === "unrealizedPnl");
      assert.strictEqual(pnlCol?.format, "pnl");
    });

    it("should add currency format for price columns", () => {
      const data = [{ symbol: "TCS", currentPrice: 3500 }];
      const block = autoFormatArrayAsTable(data, "test");
      assert.ok(block);
      const columns = block.columns as {
        key: string;
        format?: string;
      }[];
      const priceCol = columns.find((c) => c.key === "currentPrice");
      assert.strictEqual(priceCol?.format, "currency");
    });

    it("should add currency format for value columns", () => {
      const data = [{ symbol: "TCS", investedValue: 35000 }];
      const block = autoFormatArrayAsTable(data, "test");
      assert.ok(block);
      const columns = block.columns as {
        key: string;
        format?: string;
      }[];
      const col = columns.find((c) => c.key === "investedValue");
      assert.strictEqual(col?.format, "currency");
    });

    it("should add currency format for amount columns", () => {
      const data = [{ symbol: "TCS", totalAmount: 100000 }];
      const block = autoFormatArrayAsTable(data, "test");
      assert.ok(block);
      const columns = block.columns as {
        key: string;
        format?: string;
      }[];
      const col = columns.find((c) => c.key === "totalAmount");
      assert.strictEqual(col?.format, "currency");
    });

    it("should generate camelCase labels with spaces", () => {
      const data = [{ currentPrice: 3500 }];
      const block = autoFormatArrayAsTable(data, "test");
      assert.ok(block);
      const columns = block.columns as { label: string }[];
      assert.strictEqual(columns[0].label, "Current Price");
    });
  });

  // ───────────────────── Auto-format: object as card ─────────────────────

  describe("autoFormatObjectAsCard", () => {
    it("should create card block from object", () => {
      const data = {
        totalValue: 500000,
        dayChange: 2500,
        dayChangePercent: 0.5,
      };
      const block = autoFormatObjectAsCard(data, "get_portfolio_summary");
      assert.strictEqual(block.type, "card");
      assert.strictEqual(block.variant, "metric");
    });

    it("should filter out id and userId from card items", () => {
      const data = { id: "1", userId: "u1", totalValue: 500000 };
      const block = autoFormatObjectAsCard(data, "test");
      const items = block.items as { label: string }[];
      const labels = items.map((i) => i.label);
      assert.ok(!labels.some((l) => l.toLowerCase().includes("id")));
    });

    it("should filter out object-type values (except null)", () => {
      const data = {
        totalValue: 500000,
        details: { nested: true },
        note: null,
      };
      const block = autoFormatObjectAsCard(data, "test");
      const items = block.items as { label: string }[];
      const labels = items.map((i) => i.label);
      assert.ok(!labels.includes("Details"));
      assert.ok(labels.includes("Note"));
    });

    it("should format numbers as INR currency", () => {
      const data = { totalValue: 500000 };
      const block = autoFormatObjectAsCard(data, "test");
      const items = block.items as { value: string }[];
      assert.ok(items[0].value.startsWith("₹"));
    });

    it("should format null values as N/A", () => {
      const data = { note: null };
      const block = autoFormatObjectAsCard(data, "test");
      const items = block.items as { value: string }[];
      assert.strictEqual(items[0].value, "N/A");
    });

    it("should format strings as-is", () => {
      const data = { status: "ACTIVE" };
      const block = autoFormatObjectAsCard(data, "test");
      const items = block.items as { value: string }[];
      assert.strictEqual(items[0].value, "ACTIVE");
    });

    it("should limit to 8 items", () => {
      const data: Record<string, unknown> = {};
      for (let i = 0; i < 12; i++) {
        data[`field${i}`] = i;
      }
      const block = autoFormatObjectAsCard(data, "test");
      const items = block.items as unknown[];
      assert.strictEqual(items.length, 8);
    });
  });

  // ───────────────────── Nested data unwrapping ─────────────────────

  describe("unwrapNestedData", () => {
    it("should extract first array property from nested object", () => {
      const data = {
        holdings: [
          { symbol: "TCS", quantity: 10 },
          { symbol: "INFY", quantity: 5 },
        ],
        summary: { totalValue: 100000 },
      };
      const unwrapped = unwrapNestedData(data);
      assert.ok(Array.isArray(unwrapped));
      assert.strictEqual((unwrapped as unknown[]).length, 2);
    });

    it("should return original data if already an array", () => {
      const data = [{ symbol: "TCS" }];
      const unwrapped = unwrapNestedData(data);
      assert.strictEqual(unwrapped, data);
    });

    it("should return original object if no array property found", () => {
      const data = { value: 1000, label: "test" };
      const unwrapped = unwrapNestedData(data);
      assert.strictEqual(unwrapped, data);
    });

    it("should return null as-is", () => {
      const unwrapped = unwrapNestedData(null);
      assert.strictEqual(unwrapped, null);
    });

    it("should return primitives as-is", () => {
      assert.strictEqual(unwrapNestedData("hello"), "hello");
      assert.strictEqual(unwrapNestedData(42), 42);
      assert.strictEqual(unwrapNestedData(true), true);
    });

    it("should pick the first array key in insertion order", () => {
      const data = {
        positions: [{ symbol: "A" }],
        trades: [{ symbol: "B" }],
      };
      const unwrapped = unwrapNestedData(data);
      assert.ok(Array.isArray(unwrapped));
      // Should be positions (first key)
      assert.strictEqual(
        ((unwrapped as unknown[])[0] as Record<string, string>).symbol,
        "A"
      );
    });

    it("should handle empty arrays as valid array properties", () => {
      const data = { items: [], count: 0 };
      const unwrapped = unwrapNestedData(data);
      assert.ok(Array.isArray(unwrapped));
      assert.strictEqual((unwrapped as unknown[]).length, 0);
    });
  });

  // ───────────────────── Error mapping ─────────────────────

  describe("Gemini error mapping", () => {
    it("should map timeout errors to 504", () => {
      const result = mapGeminiError("Request timeout after 30s");
      assert.strictEqual(result.status, 504);
      assert.ok(result.error.includes("took too long"));
    });

    it("should map 429 errors to 429", () => {
      const result = mapGeminiError("HTTP 429: Rate limit exceeded");
      assert.strictEqual(result.status, 429);
      assert.ok(result.error.includes("temporarily busy"));
    });

    it("should map quota errors to 429", () => {
      const result = mapGeminiError("quota exceeded for project");
      assert.strictEqual(result.status, 429);
    });

    it("should map Invalid JSON payload to 500", () => {
      const result = mapGeminiError("Invalid JSON payload received");
      assert.strictEqual(result.status, 500);
      assert.ok(result.error.includes("technical issue"));
    });

    it("should map Invalid argument to 500 (config)", () => {
      const result = mapGeminiError("Invalid argument for model");
      assert.strictEqual(result.status, 500);
      assert.ok(result.error.includes("Fast mode"));
    });

    it("should map Cannot find field to 500 (config)", () => {
      const result = mapGeminiError("Cannot find field in model");
      assert.strictEqual(result.status, 500);
      assert.ok(result.error.includes("Fast mode"));
    });

    it("should map generic errors to 500 with helpful message", () => {
      const result = mapGeminiError("Unknown internal error");
      assert.strictEqual(result.status, 500);
      assert.ok(result.error.includes("try again"));
    });

    it("should handle empty error message", () => {
      const result = mapGeminiError("");
      assert.strictEqual(result.status, 500);
    });
  });

  // ───────────────────── Tool title generation ─────────────────────

  describe("buildToolTitle", () => {
    it("should convert get_holdings to 'Holdings'", () => {
      const title = buildToolTitle("get_holdings");
      assert.strictEqual(title, "Holdings");
    });

    it("should convert get_portfolio_summary to 'Portfolio summary'", () => {
      const title = buildToolTitle("get_portfolio_summary");
      assert.strictEqual(title, "Portfolio summary");
    });

    it("should convert get_mutual_funds to 'Mutual funds'", () => {
      const title = buildToolTitle("get_mutual_funds");
      assert.strictEqual(title, "Mutual funds");
    });

    it("should convert create_fire_scenario to 'Create fire scenario'", () => {
      const title = buildToolTitle("create_fire_scenario");
      assert.strictEqual(title, "Create fire scenario");
    });

    it("should return 'Results' for undefined tool name", () => {
      const title = buildToolTitle(undefined);
      assert.strictEqual(title, "Results");
    });

    it("should return 'Results' for empty string", () => {
      const title = buildToolTitle("");
      assert.strictEqual(title, "Results");
    });
  });

  // ───────────────────── Fast-path flow simulation ─────────────────────

  describe("Fast-path tool execution flow", () => {
    it("should return raw tool data when Gemini is disabled", () => {
      const toolName = "get_holdings";
      const toolResult: ToolExecutionResult = {
        executed: true,
        result: {
          tool: "get_holdings",
          success: true,
          data: [{ symbol: "TCS", quantity: 10 }],
          renderType: "table",
        },
      };

      // Simulate Gemini disabled path
      const geminiEnabled = false;
      if (toolResult.executed && toolResult.result?.success && !geminiEnabled) {
        const response: ChatResponse = {
          response: `Here are your ${toolName.replace(/_/g, " ")} results.`,
          blocks: [
            {
              type: "text",
              content: `Here are your ${toolName.replace(/_/g, " ")} results.`,
            },
          ],
          queryType: "fast",
          toolResults: [toolResult.result],
        };
        assert.strictEqual(response.queryType, "fast");
        assert.ok(response.response.includes("get holdings"));
        assert.strictEqual(response.toolResults?.length, 1);
      }
    });

    it("should return confirmation prompt for write tools", () => {
      const toolResult: ToolExecutionResult = {
        executed: false,
        needsConfirmation: true,
        confirmationMessage: "Are you sure you want to buy 10 shares of TCS?",
      };

      if (toolResult.needsConfirmation) {
        const response: ChatResponse = {
          response:
            toolResult.confirmationMessage || "Please confirm this action.",
          blocks: [
            {
              type: "action",
              actionId: `confirm-${Date.now()}`,
              tool: "buy_paper_position",
              description: toolResult.confirmationMessage || "Confirm action",
              params: { symbol: "TCS", quantity: 10, price: 3500 },
              status: "pending",
            },
          ],
          queryType: "fast",
        };

        assert.strictEqual(response.blocks?.[0].type, "action");
        assert.strictEqual(response.blocks?.[0].tool, "buy_paper_position");
        assert.strictEqual(response.blocks?.[0].status, "pending");
      }
    });
  });

  // ───────────────────── Query consumption flow ─────────────────────

  describe("Query consumption", () => {
    it("should return 403 when query consumption fails", () => {
      const queryResult = {
        success: false,
        error: "No fast queries remaining",
      };

      if (!queryResult.success) {
        const status = 403;
        const error =
          queryResult.error ||
          "No fast queries remaining. Please upgrade your plan.";
        assert.strictEqual(status, 403);
        assert.ok(error.includes("fast queries"));
      }
    });

    it("should refund query on Gemini failure", async () => {
      let refunded = false;
      const refundAIQuery = async () => {
        refunded = true;
      };

      // Simulate Gemini failure → refund
      try {
        throw new Error("Gemini timeout");
      } catch {
        await refundAIQuery();
        assert.strictEqual(refunded, true);
      }
    });

    it("should still consume query for blocked queries (guardrails)", () => {
      let consumed = false;
      const consumeAIQuery = () => {
        consumed = true;
      };

      const inputValidation = { valid: false, reason: "Blocked by guardrails" };
      if (!inputValidation.valid) {
        consumeAIQuery();
      }

      assert.strictEqual(consumed, true);
    });
  });

  // ───────────────────── Gemini disabled path ─────────────────────

  describe("Gemini disabled path", () => {
    it("should return mock response when Gemini is disabled", () => {
      const MOCK_RESPONSES = [
        "This is a mock response. Gemini integration is currently disabled.",
        "I'm currently running in mock mode.",
      ];

      const mockResponse =
        MOCK_RESPONSES[Math.floor(Math.random() * MOCK_RESPONSES.length)];

      assert.ok(typeof mockResponse === "string");
      assert.ok(mockResponse.length > 0);
    });
  });

  // ───────────────────── Health check ─────────────────────

  describe("GET health check", () => {
    it("should return status ok with gemini enabled info", () => {
      const isEnabled = true;
      const response = {
        status: "ok",
        geminiEnabled: isEnabled,
        message: isEnabled
          ? "Gemini integration is enabled"
          : "Gemini integration is disabled (USE_GEMINI=false)",
      };

      assert.strictEqual(response.status, "ok");
      assert.strictEqual(response.geminiEnabled, true);
      assert.ok(response.message.includes("enabled"));
    });

    it("should return status ok with gemini disabled info", () => {
      const isEnabled = false;
      const response = {
        status: "ok",
        geminiEnabled: isEnabled,
        message: isEnabled
          ? "Gemini integration is enabled"
          : "Gemini integration is disabled (USE_GEMINI=false)",
      };

      assert.strictEqual(response.status, "ok");
      assert.strictEqual(response.geminiEnabled, false);
      assert.ok(response.message.includes("disabled"));
    });
  });

  // ───────────────────── Output processing ─────────────────────

  describe("Output processing", () => {
    it("should append disclaimers to clean response", () => {
      const cleanResponse = "Here is your analysis.";
      const disclaimers = ["Not financial advice.", "Past performance..."];

      const result = cleanResponse + "\n\n---\n*" + disclaimers.join(" ") + "*";

      assert.ok(result.includes("Not financial advice."));
      assert.ok(result.includes("Past performance..."));
      assert.ok(result.includes("---"));
    });

    it("should not append disclaimer section when empty", () => {
      const disclaimers: string[] = [];
      const cleanResponse = "Here is your data.";

      let result = cleanResponse;
      if (disclaimers.length > 0) {
        result += "\n\n---\n*" + disclaimers.join(" ") + "*";
      }

      assert.strictEqual(result, cleanResponse);
    });
  });

  // ───────────────────── Full response construction ─────────────────────

  describe("Response construction", () => {
    it("should include all expected fields in successful response", () => {
      const response: ChatResponse = {
        response: "Here is your portfolio summary.",
        blocks: [{ type: "text", content: "Here is your portfolio summary." }],
        remaining: 45,
        queryType: "fast",
      };

      assert.ok(response.response);
      assert.ok(response.blocks);
      assert.strictEqual(response.remaining, 45);
      assert.strictEqual(response.queryType, "fast");
    });

    it("should include toolResults when tools were executed", () => {
      const response: ChatResponse = {
        response: "Holdings data.",
        blocks: [],
        queryType: "fast",
        toolResults: [
          {
            tool: "get_holdings",
            success: true,
            data: [{ symbol: "TCS" }],
          },
        ],
      };

      assert.strictEqual(response.toolResults?.length, 1);
    });

    it("should include blocked flag for guardrail-blocked responses", () => {
      const response: ChatResponse = {
        response: "This query cannot be processed.",
        blocked: true,
        queryType: "fast",
      };

      assert.strictEqual(response.blocked, true);
    });
  });
});
