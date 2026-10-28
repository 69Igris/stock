/**
 * Gemini Conversation Context Tests
 *
 * Tests for the multi-turn conversation management system that handles
 * chat history, token budgeting, and prompt assembly for Gemini LLM.
 *
 * Tests cover:
 * - estimateTokens: token count estimation (1 token ~ 4 chars)
 * - convertToGeminiFormat: ChatMessage[] -> GeminiHistoryMessage[] transformation
 * - trimHistoryToTokenBudget: token-aware history trimming (keeps recent messages)
 * - buildFullPrompt: assembles system prompt + RAG context + history + current message
 * - createGeminiChatHistory: extracts history array from context
 * - addExchangeToContext: appends user+assistant exchange to context
 * - isNearTokenLimit: checks if context approaches budget threshold
 *
 * The pure functions are reimplemented inline because the source module
 * (conversation.ts) has side-effecting imports (db, cache, logger) that
 * aren't available in the unit test environment.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
// De-shadowed (MONEY-620): assert the REAL conversation.ts exports. Importing it
// is side-effect-free (DB / cache are only touched inside async functions).
// The previous inline copy DRIFTED on TWO fronts that this catches:
//   1. DEFAULT_MAX_TOKEN_BUDGET was 8000 here vs 16000 in the source, so the
//      whole isNearTokenLimit suite asserted a stale budget while green.
//   2. The copy's buildFullPrompt did NOT wrap RAG context in the
//      "EXTERNAL DATA BOUNDARY" fence the real one adds (a prompt-injection
//      mitigation); the assertions only check inclusion/order so they hold.
import {
  estimateTokens,
  convertToGeminiFormat,
  trimHistoryToTokenBudget,
  buildFullPrompt,
  createGeminiChatHistory,
  addExchangeToContext,
  isNearTokenLimit,
  shouldSkipSummarization,
  summarizeSplitPoint,
  formatConversationText,
  type GeminiHistoryMessage,
  type ConversationContext,
} from "@/lib/gemini/conversation";
import type { ChatMessage } from "@usemoney/types";
import type { ConversationState } from "@/lib/chat-tools/turn-context";

// The real buildFullPrompt accepts a ConversationState for prior-turn context.
type PriorTurnContext = ConversationState;

// ─────────────────────────────────────────────────────────────────────────────
// Factory functions
// ─────────────────────────────────────────────────────────────────────────────

function createMockContext(
  overrides: Partial<ConversationContext> = {}
): ConversationContext {
  return {
    history: [],
    systemPrompt: "",
    tokenEstimate: 0,
    ...overrides,
  };
}

function createMockMessage(
  overrides: Partial<GeminiHistoryMessage> = {}
): GeminiHistoryMessage {
  return {
    role: "user",
    parts: [{ text: "Hello" }],
    ...overrides,
  };
}

function createMockChatMessage(
  overrides: Partial<ChatMessage> = {}
): ChatMessage {
  return {
    role: "user",
    content: "Hello",
    ...overrides,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Tests
// ─────────────────────────────────────────────────────────────────────────────

describe("Gemini Conversation", () => {
  // ───────────────────── estimateTokens ─────────────────────

  describe("estimateTokens", () => {
    it("should estimate 1 token for 4 characters", () => {
      assert.strictEqual(estimateTokens("abcd"), 1);
    });

    it("should estimate 2 tokens for 8 characters", () => {
      assert.strictEqual(estimateTokens("abcdefgh"), 2);
    });

    it("should round up for non-divisible lengths (5 chars = 2 tokens)", () => {
      assert.strictEqual(estimateTokens("abcde"), 2);
    });

    it("should return 0 for empty string", () => {
      assert.strictEqual(estimateTokens(""), 0);
    });

    it("should return 1 for single character", () => {
      assert.strictEqual(estimateTokens("a"), 1);
    });

    it("should return 1 for 3 characters", () => {
      assert.strictEqual(estimateTokens("abc"), 1);
    });

    it("should handle exactly 4 characters", () => {
      assert.strictEqual(estimateTokens("1234"), 1);
    });

    it("should handle very long text (10000 chars = 2500 tokens)", () => {
      assert.strictEqual(estimateTokens("x".repeat(10000)), 2500);
    });

    it("should handle text with spaces", () => {
      const text = "Hello world test"; // 16 chars
      assert.strictEqual(estimateTokens(text), 4);
    });

    it("should handle text with newlines", () => {
      const text = "Line 1\nLine 2\n"; // 14 chars
      assert.strictEqual(estimateTokens(text), 4); // ceil(14/4) = 4
    });

    it("should handle text with special characters", () => {
      const text = "P/E: 25.5x"; // 10 chars
      assert.strictEqual(estimateTokens(text), 3); // ceil(10/4) = 3
    });

    it("should handle currency symbols and numbers", () => {
      const text = "$1,250.50"; // 9 chars
      assert.strictEqual(estimateTokens(text), 3); // ceil(9/4) = 3
    });

    it("should handle a typical user question", () => {
      const text = "What stocks should I invest in for long term wealth?";
      assert.strictEqual(estimateTokens(text), Math.ceil(text.length / 4));
    });

    it("should handle a typical LLM response", () => {
      const text =
        "Based on your portfolio, I would recommend diversifying into index funds. " +
        "Consider Nifty 50 index funds for stable long-term growth.";
      assert.strictEqual(estimateTokens(text), Math.ceil(text.length / 4));
    });
  });

  // ───────────────────── convertToGeminiFormat ─────────────────────

  describe("convertToGeminiFormat", () => {
    it("should convert user message to user role", () => {
      const messages: ChatMessage[] = [
        createMockChatMessage({ role: "user", content: "Hello" }),
      ];
      const result = convertToGeminiFormat(messages);
      assert.strictEqual(result.length, 1);
      assert.strictEqual(result[0].role, "user");
      assert.strictEqual(result[0].parts[0].text, "Hello");
    });

    it("should convert assistant message to model role", () => {
      const messages: ChatMessage[] = [
        createMockChatMessage({ role: "assistant", content: "Hi there!" }),
      ];
      const result = convertToGeminiFormat(messages);
      assert.strictEqual(result.length, 1);
      assert.strictEqual(result[0].role, "model");
      assert.strictEqual(result[0].parts[0].text, "Hi there!");
    });

    it("should convert multiple messages preserving order", () => {
      const messages: ChatMessage[] = [
        createMockChatMessage({ role: "user", content: "Question 1" }),
        createMockChatMessage({ role: "assistant", content: "Answer 1" }),
        createMockChatMessage({ role: "user", content: "Question 2" }),
        createMockChatMessage({ role: "assistant", content: "Answer 2" }),
      ];
      const result = convertToGeminiFormat(messages);
      assert.strictEqual(result.length, 4);
      assert.strictEqual(result[0].role, "user");
      assert.strictEqual(result[1].role, "model");
      assert.strictEqual(result[2].role, "user");
      assert.strictEqual(result[3].role, "model");
    });

    it("should handle empty array", () => {
      const result = convertToGeminiFormat([]);
      assert.strictEqual(result.length, 0);
    });

    it("should create parts array with single text entry", () => {
      const messages: ChatMessage[] = [
        createMockChatMessage({ content: "Test content" }),
      ];
      const result = convertToGeminiFormat(messages);
      assert.strictEqual(result[0].parts.length, 1);
      assert.strictEqual(result[0].parts[0].text, "Test content");
    });

    it("should handle messages with empty content", () => {
      const messages: ChatMessage[] = [createMockChatMessage({ content: "" })];
      const result = convertToGeminiFormat(messages);
      assert.strictEqual(result[0].parts[0].text, "");
    });

    it("should handle messages with very long content", () => {
      const longContent = "A".repeat(10000);
      const messages: ChatMessage[] = [
        createMockChatMessage({ content: longContent }),
      ];
      const result = convertToGeminiFormat(messages);
      assert.strictEqual(result[0].parts[0].text.length, 10000);
    });

    it("should handle single user message", () => {
      const messages: ChatMessage[] = [
        createMockChatMessage({ role: "user", content: "Only user" }),
      ];
      const result = convertToGeminiFormat(messages);
      assert.strictEqual(result.length, 1);
      assert.strictEqual(result[0].role, "user");
    });

    it("should handle messages with special characters", () => {
      const messages: ChatMessage[] = [
        createMockChatMessage({
          content: "What's the P/E ratio of TCS? It's at \u20B93,500.",
        }),
      ];
      const result = convertToGeminiFormat(messages);
      assert.ok(result[0].parts[0].text.includes("P/E"));
    });
  });

  // ───────────────────── trimHistoryToTokenBudget ─────────────────────

  describe("trimHistoryToTokenBudget", () => {
    it("should keep all messages when under budget", () => {
      const history: GeminiHistoryMessage[] = [
        createMockMessage({ parts: [{ text: "Hi" }] }), // ~1 token
        createMockMessage({
          role: "model",
          parts: [{ text: "Hello" }],
        }), // ~2 tokens
      ];
      const result = trimHistoryToTokenBudget(history, 100);
      assert.strictEqual(result.length, 2);
    });

    it("should trim oldest messages when over budget", () => {
      const history: GeminiHistoryMessage[] = [
        createMockMessage({
          parts: [{ text: "A".repeat(400) }],
        }), // 100 tokens
        createMockMessage({
          role: "model",
          parts: [{ text: "B".repeat(400) }],
        }), // 100 tokens
        createMockMessage({
          parts: [{ text: "C".repeat(400) }],
        }), // 100 tokens
      ];
      // Budget of 200 tokens should keep only last 2 messages
      const result = trimHistoryToTokenBudget(history, 200);
      assert.strictEqual(result.length, 2);
      assert.strictEqual(result[0].parts[0].text, "B".repeat(400));
      assert.strictEqual(result[1].parts[0].text, "C".repeat(400));
    });

    it("should return empty array when budget is 0", () => {
      const history: GeminiHistoryMessage[] = [
        createMockMessage({ parts: [{ text: "Hello" }] }),
      ];
      const result = trimHistoryToTokenBudget(history, 0);
      assert.strictEqual(result.length, 0);
    });

    it("should handle empty history", () => {
      const result = trimHistoryToTokenBudget([], 1000);
      assert.strictEqual(result.length, 0);
    });

    it("should keep only the most recent message when budget is very tight", () => {
      const history: GeminiHistoryMessage[] = [
        createMockMessage({ parts: [{ text: "A".repeat(400) }] }), // 100 tokens
        createMockMessage({ parts: [{ text: "B".repeat(40) }] }), // 10 tokens
      ];
      const result = trimHistoryToTokenBudget(history, 15);
      assert.strictEqual(result.length, 1);
      assert.strictEqual(result[0].parts[0].text, "B".repeat(40));
    });

    it("should exclude a single message that exceeds budget", () => {
      const history: GeminiHistoryMessage[] = [
        createMockMessage({ parts: [{ text: "A".repeat(2000) }] }), // 500 tokens
      ];
      const result = trimHistoryToTokenBudget(history, 100);
      assert.strictEqual(result.length, 0);
    });

    it("should handle messages with multiple parts", () => {
      const history: GeminiHistoryMessage[] = [
        {
          role: "user",
          parts: [{ text: "Part1" }, { text: "Part2" }],
        },
      ];
      // Total tokens = ceil(5/4) + ceil(5/4) = 2 + 2 = 4
      const result = trimHistoryToTokenBudget(history, 10);
      assert.strictEqual(result.length, 1);
    });

    it("should preserve message order after trimming", () => {
      const history: GeminiHistoryMessage[] = [
        createMockMessage({ parts: [{ text: "A".repeat(400) }] }),
        createMockMessage({
          role: "model",
          parts: [{ text: "B".repeat(40) }],
        }),
        createMockMessage({ parts: [{ text: "C".repeat(40) }] }),
        createMockMessage({
          role: "model",
          parts: [{ text: "D".repeat(40) }],
        }),
      ];
      const result = trimHistoryToTokenBudget(history, 50);
      assert.strictEqual(result.length, 3);
      assert.ok(result[0].parts[0].text.startsWith("B"));
      assert.ok(result[1].parts[0].text.startsWith("C"));
      assert.ok(result[2].parts[0].text.startsWith("D"));
    });

    it("should handle large history and small budget gracefully", () => {
      const history: GeminiHistoryMessage[] = Array.from(
        { length: 100 },
        (_, i) =>
          createMockMessage({
            parts: [{ text: `Message ${i}: ${"x".repeat(40)}` }],
          })
      );
      const result = trimHistoryToTokenBudget(history, 50);
      assert.ok(result.length < 100);
      assert.ok(result.length > 0);
    });

    it("should keep exactly budget-fitting messages", () => {
      // Each message is exactly 10 tokens (40 chars)
      const history: GeminiHistoryMessage[] = [
        createMockMessage({ parts: [{ text: "A".repeat(40) }] }),
        createMockMessage({ parts: [{ text: "B".repeat(40) }] }),
        createMockMessage({ parts: [{ text: "C".repeat(40) }] }),
      ];
      // Budget of 20 should fit exactly 2 messages (each 10 tokens)
      const result = trimHistoryToTokenBudget(history, 20);
      assert.strictEqual(result.length, 2);
    });
  });

  // ───────────────────── buildFullPrompt ─────────────────────

  describe("buildFullPrompt", () => {
    it("should include system prompt when present", () => {
      const context = createMockContext({
        systemPrompt: "You are a financial advisor.",
      });
      const result = buildFullPrompt(context, "Hello");
      assert.ok(result.includes("You are a financial advisor."));
    });

    it("should include current user message", () => {
      const context = createMockContext();
      const result = buildFullPrompt(context, "What stocks to buy?");
      assert.ok(result.includes("User: What stocks to buy?"));
    });

    it("should end with Assistant: marker", () => {
      const context = createMockContext();
      const result = buildFullPrompt(context, "Hello");
      assert.ok(result.endsWith("Assistant:"));
    });

    it("should include RAG context from parameter", () => {
      const context = createMockContext();
      const result = buildFullPrompt(
        context,
        "Hello",
        "Portfolio: 10 stocks worth 50L"
      );
      assert.ok(result.includes("## Relevant User Data:"));
      assert.ok(result.includes("Portfolio: 10 stocks worth 50L"));
    });

    it("should include RAG context from context object", () => {
      const context = createMockContext({
        ragContext: "User has 5 holdings",
      });
      const result = buildFullPrompt(context, "Hello");
      assert.ok(result.includes("User has 5 holdings"));
    });

    it("should prefer parameter RAG context over context.ragContext", () => {
      const context = createMockContext({
        ragContext: "Context RAG",
      });
      const result = buildFullPrompt(context, "Hello", "Parameter RAG");
      assert.ok(result.includes("Parameter RAG"));
    });

    it("should include conversation history", () => {
      const context = createMockContext({
        history: [
          { role: "user", parts: [{ text: "Previous question" }] },
          {
            role: "model",
            parts: [{ text: "Previous answer" }],
          },
        ],
      });
      const result = buildFullPrompt(context, "Follow up");
      assert.ok(result.includes("## Previous Conversation:"));
      assert.ok(result.includes("User: Previous question"));
      assert.ok(result.includes("Assistant: Previous answer"));
    });

    it("should not include history section when history is empty", () => {
      const context = createMockContext({ history: [] });
      const result = buildFullPrompt(context, "Hello");
      assert.ok(!result.includes("## Previous Conversation:"));
    });

    it("should not include system prompt section when system prompt is empty", () => {
      const context = createMockContext({ systemPrompt: "" });
      const result = buildFullPrompt(context, "Hello");
      // Should start with either RAG context or current message
      const lines = result.split("\n").filter((l) => l.trim());
      assert.ok(lines[0].includes("User:") || lines[0].includes("##"));
    });

    it("should assemble all parts in correct order", () => {
      const context = createMockContext({
        systemPrompt: "System prompt here",
        ragContext: "RAG data here",
        history: [
          { role: "user", parts: [{ text: "Q1" }] },
          { role: "model", parts: [{ text: "A1" }] },
        ],
      });
      const result = buildFullPrompt(context, "Current question");

      const systemIdx = result.indexOf("System prompt here");
      const ragIdx = result.indexOf("RAG data here");
      const historyIdx = result.indexOf("## Previous Conversation:");
      const currentIdx = result.indexOf("User: Current question");
      const assistantIdx = result.lastIndexOf("Assistant:");

      assert.ok(systemIdx < ragIdx);
      assert.ok(ragIdx < historyIdx);
      assert.ok(historyIdx < currentIdx);
      assert.ok(currentIdx < assistantIdx);
    });

    it("should handle empty current message", () => {
      const context = createMockContext();
      const result = buildFullPrompt(context, "");
      assert.ok(result.includes("User:"));
    });

    it("should join multi-part messages with newlines", () => {
      const context = createMockContext({
        history: [
          {
            role: "user",
            parts: [{ text: "Part 1" }, { text: "Part 2" }],
          },
        ],
      });
      const result = buildFullPrompt(context, "Hello");
      assert.ok(result.includes("Part 1\nPart 2"));
    });

    describe("priorTurnContext (Conversation State section)", () => {
      it("should inject Conversation State section when provided", () => {
        const context = createMockContext({
          systemPrompt: "System prompt",
        });
        const ptc: PriorTurnContext = {
          lastTurnMeta: {
            tool: "run_screener",
            intent: "screener",
          },
          activePersona: "quant_analyst",
          activeSymbols: ["TCS", "INFY"],
          turnCount: 3,
          lastUpdated: Date.now(),
        };
        const result = buildFullPrompt(
          context,
          "tighten filter",
          undefined,
          ptc
        );
        assert.ok(result.includes("## Conversation State:"));
        assert.ok(result.includes("- Last tool: run_screener"));
        assert.ok(result.includes("- Last intent: screener"));
        assert.ok(result.includes("- Active persona: quant_analyst"));
        assert.ok(result.includes("- Stocks discussed: TCS, INFY"));
      });

      it("should place Conversation State between system prompt and RAG", () => {
        const context = createMockContext({
          systemPrompt: "System",
          ragContext: "RAG data",
        });
        const ptc: PriorTurnContext = {
          lastTurnMeta: { tool: "run_screener" },
          activeSymbols: [],
          turnCount: 1,
          lastUpdated: Date.now(),
        };
        const result = buildFullPrompt(context, "msg", undefined, ptc);
        const stateIdx = result.indexOf("## Conversation State:");
        const ragIdx = result.indexOf("## Relevant User Data:");
        assert.ok(stateIdx > 0, "Conversation State should be present");
        assert.ok(
          stateIdx < ragIdx,
          "Conversation State should come before RAG"
        );
      });

      it("should NOT inject section when priorTurnContext is null", () => {
        const context = createMockContext();
        const result = buildFullPrompt(context, "hello", undefined, null);
        assert.ok(!result.includes("## Conversation State:"));
      });

      it("should NOT inject section when priorTurnContext is undefined", () => {
        const context = createMockContext();
        const result = buildFullPrompt(context, "hello");
        assert.ok(!result.includes("## Conversation State:"));
      });

      it("should include screener state with result count", () => {
        const context = createMockContext();
        const ptc: PriorTurnContext = {
          lastTurnMeta: { tool: "run_screener" },
          activeSymbols: [],
          activeScreenerState: {
            query: "RSI < 30 in Nifty 50",
            filters: [{ field: "rsi_14", operator: "lt", value: 30 }],
            resultCount: 12,
          },
          turnCount: 2,
          lastUpdated: Date.now(),
        };
        const result = buildFullPrompt(context, "yes", undefined, ptc);
        assert.ok(
          result.includes(
            'Active screener: "RSI < 30 in Nifty 50" (12 results)'
          )
        );
        assert.ok(result.includes("Filters:"));
        assert.ok(result.includes('"rsi_14"'));
      });

      it("should skip section when lastTurnMeta has no meaningful fields", () => {
        const context = createMockContext();
        const ptc: PriorTurnContext = {
          lastTurnMeta: {},
          activeSymbols: [],
          turnCount: 1,
          lastUpdated: Date.now(),
        };
        const result = buildFullPrompt(context, "hello", undefined, ptc);
        assert.ok(!result.includes("## Conversation State:"));
      });
    });
  });

  // ───────────────────── createGeminiChatHistory ─────────────────────

  describe("createGeminiChatHistory", () => {
    it("should return the history array from context", () => {
      const history: GeminiHistoryMessage[] = [
        { role: "user", parts: [{ text: "Hello" }] },
        { role: "model", parts: [{ text: "Hi!" }] },
      ];
      const context = createMockContext({ history });
      const result = createGeminiChatHistory(context);
      assert.strictEqual(result, history);
    });

    it("should return empty array for context with no history", () => {
      const context = createMockContext({ history: [] });
      const result = createGeminiChatHistory(context);
      assert.strictEqual(result.length, 0);
    });

    it("should return same reference as context.history", () => {
      const history: GeminiHistoryMessage[] = [
        { role: "user", parts: [{ text: "Test" }] },
      ];
      const context = createMockContext({ history });
      const result = createGeminiChatHistory(context);
      assert.strictEqual(result, context.history);
    });
  });

  // ───────────────────── addExchangeToContext ─────────────────────

  describe("addExchangeToContext", () => {
    it("should add user and assistant messages to history", () => {
      const context = createMockContext({ history: [] });
      const result = addExchangeToContext(
        context,
        "What is SIP?",
        "SIP stands for Systematic Investment Plan."
      );
      assert.strictEqual(result.history.length, 2);
      assert.strictEqual(result.history[0].role, "user");
      assert.strictEqual(result.history[0].parts[0].text, "What is SIP?");
      assert.strictEqual(result.history[1].role, "model");
      assert.strictEqual(
        result.history[1].parts[0].text,
        "SIP stands for Systematic Investment Plan."
      );
    });

    it("should append to existing history", () => {
      const context = createMockContext({
        history: [
          { role: "user", parts: [{ text: "Q1" }] },
          { role: "model", parts: [{ text: "A1" }] },
        ],
      });
      const result = addExchangeToContext(context, "Q2", "A2");
      assert.strictEqual(result.history.length, 4);
      assert.strictEqual(result.history[2].parts[0].text, "Q2");
      assert.strictEqual(result.history[3].parts[0].text, "A2");
    });

    it("should update token estimate", () => {
      const context = createMockContext({
        tokenEstimate: 100,
      });
      const userMsg = "A".repeat(40); // 10 tokens
      const assistantMsg = "B".repeat(80); // 20 tokens
      const result = addExchangeToContext(context, userMsg, assistantMsg);
      assert.strictEqual(result.tokenEstimate, 130);
    });

    it("should not modify original context", () => {
      const context = createMockContext({
        history: [],
        tokenEstimate: 50,
      });
      const result = addExchangeToContext(context, "Q", "A");
      assert.strictEqual(context.history.length, 0);
      assert.strictEqual(context.tokenEstimate, 50);
      assert.strictEqual(result.history.length, 2);
    });

    it("should preserve systemPrompt in new context", () => {
      const context = createMockContext({
        systemPrompt: "Finance advisor prompt",
      });
      const result = addExchangeToContext(context, "Q", "A");
      assert.strictEqual(result.systemPrompt, "Finance advisor prompt");
    });

    it("should preserve ragContext in new context", () => {
      const context = createMockContext({
        ragContext: "Portfolio data",
      });
      const result = addExchangeToContext(context, "Q", "A");
      assert.strictEqual(result.ragContext, "Portfolio data");
    });

    it("should handle empty messages", () => {
      const context = createMockContext({ tokenEstimate: 10 });
      const result = addExchangeToContext(context, "", "");
      assert.strictEqual(result.history.length, 2);
      // Empty string = 0 tokens each
      assert.strictEqual(result.tokenEstimate, 10);
    });

    it("should handle very long messages", () => {
      const context = createMockContext({ tokenEstimate: 0 });
      const longMsg = "X".repeat(40000); // 10000 tokens
      const result = addExchangeToContext(context, longMsg, "Short");
      assert.strictEqual(
        result.tokenEstimate,
        estimateTokens(longMsg) + estimateTokens("Short")
      );
    });

    it("should accumulate token estimates across multiple exchanges", () => {
      let context = createMockContext({ tokenEstimate: 0 });
      context = addExchangeToContext(context, "AAAA", "BBBB"); // 1 + 1 = 2
      context = addExchangeToContext(context, "CCCC", "DDDD"); // 1 + 1 = 2
      assert.strictEqual(context.tokenEstimate, 4);
      assert.strictEqual(context.history.length, 4);
    });
  });

  // ───────────────────── isNearTokenLimit ─────────────────────

  // NOTE: the real DEFAULT_CONFIG.maxTokenBudget is 16000 (80% threshold =
  // 12800). The old shadow asserted an 8000 budget; these are corrected.
  describe("isNearTokenLimit", () => {
    it("should return false when well under limit", () => {
      const context = createMockContext({ tokenEstimate: 1000 });
      // 1000 < 16000 * 0.8 = 12800
      assert.strictEqual(isNearTokenLimit(context), false);
    });

    it("should return true when over 80% of default budget (16000)", () => {
      const context = createMockContext({ tokenEstimate: 13000 });
      // 13000 > 16000 * 0.8 = 12800
      assert.strictEqual(isNearTokenLimit(context), true);
    });

    it("should return true when at the full budget", () => {
      const context = createMockContext({ tokenEstimate: 16000 });
      // 16000 > 12800
      assert.strictEqual(isNearTokenLimit(context), true);
    });

    it("should return false when at exactly 80% threshold", () => {
      const context = createMockContext({ tokenEstimate: 12800 });
      // 12800 > 12800 is false
      assert.strictEqual(isNearTokenLimit(context), false);
    });

    it("should return true when just above 80% threshold", () => {
      const context = createMockContext({ tokenEstimate: 12801 });
      // 12801 > 12800
      assert.strictEqual(isNearTokenLimit(context), true);
    });

    it("should return false for zero token estimate", () => {
      const context = createMockContext({ tokenEstimate: 0 });
      assert.strictEqual(isNearTokenLimit(context), false);
    });

    it("should use custom threshold when provided", () => {
      const context = createMockContext({ tokenEstimate: 9000 });
      // 9000 > 16000 * 0.5 = 8000
      assert.strictEqual(isNearTokenLimit(context, 0.5), true);
    });

    it("should return false with custom higher threshold", () => {
      const context = createMockContext({ tokenEstimate: 14000 });
      // 14000 > 16000 * 0.95 = 15200 => false
      assert.strictEqual(isNearTokenLimit(context, 0.95), false);
    });

    it("should return true with threshold of 0 (always near limit)", () => {
      const context = createMockContext({ tokenEstimate: 1 });
      // 1 > 16000 * 0 = 0
      assert.strictEqual(isNearTokenLimit(context, 0), true);
    });

    it("should return false with threshold of 1 and under budget", () => {
      const context = createMockContext({ tokenEstimate: 15999 });
      // 15999 > 16000 * 1.0 = 16000 => false
      assert.strictEqual(isNearTokenLimit(context, 1.0), false);
    });

    it("should handle very large token estimates", () => {
      const context = createMockContext({ tokenEstimate: 100000 });
      assert.strictEqual(isNearTokenLimit(context), true);
    });
  });

  // ───────────────────── summarizeOldContext ─────────────────────

  describe("summarizeOldContext", () => {
    /**
     * De-shadowed: assert the REAL deterministic pre-processing helpers the
     * source's summarizeOldContext uses. The actual function additionally calls
     * Gemini Flash, which we don't exercise here; these helpers are the pure,
     * testable seam (shouldSkipSummarization / summarizeSplitPoint /
     * formatConversationText are all real exports).
     */
    const calculateSplitPoint = summarizeSplitPoint;

    function getOlderHalf(
      history: GeminiHistoryMessage[]
    ): GeminiHistoryMessage[] {
      const splitPoint = calculateSplitPoint(history.length);
      return history.slice(0, splitPoint);
    }

    // Helper to create N messages alternating user/model
    function createHistoryOfLength(n: number): GeminiHistoryMessage[] {
      return Array.from({ length: n }, (_, i) => ({
        role: (i % 2 === 0 ? "user" : "model") as "user" | "model",
        parts: [{ text: `Message ${i}` }],
      }));
    }

    it("should return empty string when history has fewer than 6 messages", () => {
      // 0..5 messages should all skip summarization
      for (let len = 0; len <= 5; len++) {
        assert.strictEqual(
          shouldSkipSummarization(len),
          true,
          `Expected skip for length ${len}`
        );
      }
    });

    it("should return empty string for exactly 5 messages", () => {
      assert.strictEqual(shouldSkipSummarization(5), true);
    });

    it("should correctly calculate split point as floor of length/2", () => {
      assert.strictEqual(calculateSplitPoint(6), 3);
      assert.strictEqual(calculateSplitPoint(7), 3);
      assert.strictEqual(calculateSplitPoint(8), 4);
      assert.strictEqual(calculateSplitPoint(10), 5);
      assert.strictEqual(calculateSplitPoint(11), 5);
      assert.strictEqual(calculateSplitPoint(20), 10);
      assert.strictEqual(calculateSplitPoint(1), 0);
      assert.strictEqual(calculateSplitPoint(0), 0);
    });

    it("should format conversation text with User/Assistant roles", () => {
      const messages: GeminiHistoryMessage[] = [
        { role: "user", parts: [{ text: "What is SIP?" }] },
        {
          role: "model",
          parts: [{ text: "SIP is Systematic Investment Plan." }],
        },
      ];
      const formatted = formatConversationText(messages);
      assert.ok(formatted.includes("User: What is SIP?"));
      assert.ok(
        formatted.includes("Assistant: SIP is Systematic Investment Plan.")
      );
    });

    it("should handle multi-part messages by joining with newlines", () => {
      const messages: GeminiHistoryMessage[] = [
        {
          role: "user",
          parts: [{ text: "Part A" }, { text: "Part B" }, { text: "Part C" }],
        },
      ];
      const formatted = formatConversationText(messages);
      assert.ok(formatted.includes("User: Part A\nPart B\nPart C"));
    });

    it("should take older half of messages, not recent half", () => {
      const history = createHistoryOfLength(8);
      const older = getOlderHalf(history);
      // Split at 4: older = [0,1,2,3]
      assert.strictEqual(older.length, 4);
      assert.strictEqual(older[0].parts[0].text, "Message 0");
      assert.strictEqual(older[1].parts[0].text, "Message 1");
      assert.strictEqual(older[2].parts[0].text, "Message 2");
      assert.strictEqual(older[3].parts[0].text, "Message 3");
    });

    it("should work with 6 messages (minimum for summarization)", () => {
      assert.strictEqual(shouldSkipSummarization(6), false);
      const history = createHistoryOfLength(6);
      const splitPoint = calculateSplitPoint(6);
      assert.strictEqual(splitPoint, 3);
      const older = getOlderHalf(history);
      assert.strictEqual(older.length, 3);
      // Verify older half contains first 3 messages
      assert.strictEqual(older[0].parts[0].text, "Message 0");
      assert.strictEqual(older[2].parts[0].text, "Message 2");
    });

    it("should work with 10 messages", () => {
      assert.strictEqual(shouldSkipSummarization(10), false);
      const history = createHistoryOfLength(10);
      const splitPoint = calculateSplitPoint(10);
      assert.strictEqual(splitPoint, 5);
      const older = getOlderHalf(history);
      assert.strictEqual(older.length, 5);
      // Verify older half is [0..4], newer is [5..9]
      assert.strictEqual(older[4].parts[0].text, "Message 4");
    });

    it("should handle odd number of messages (floor division)", () => {
      assert.strictEqual(shouldSkipSummarization(9), false);
      const history = createHistoryOfLength(9);
      const splitPoint = calculateSplitPoint(9);
      assert.strictEqual(splitPoint, 4); // floor(9/2) = 4
      const older = getOlderHalf(history);
      assert.strictEqual(older.length, 4);
      // Newer half has 5 messages (more than older)
      const newer = history.slice(splitPoint);
      assert.strictEqual(newer.length, 5);
    });

    it("should handle messages with empty parts array", () => {
      const messages: GeminiHistoryMessage[] = [
        { role: "user", parts: [] },
        { role: "model", parts: [{ text: "Response" }] },
      ];
      const formatted = formatConversationText(messages);
      // Empty parts joined = ""
      assert.ok(formatted.includes("User: "));
      assert.ok(formatted.includes("Assistant: Response"));
    });
  });

  // ───────────────────── Integration scenarios ─────────────────────

  describe("Integration scenarios", () => {
    it("should build a prompt from scratch for a new conversation", () => {
      const context = createMockContext({
        systemPrompt: "You are UseMoney AI assistant.",
        history: [],
      });
      const prompt = buildFullPrompt(context, "What is the Nifty 50?");
      assert.ok(prompt.includes("UseMoney AI assistant"));
      assert.ok(prompt.includes("Nifty 50"));
      assert.ok(!prompt.includes("## Previous Conversation:"));
    });

    it("should build a prompt for a multi-turn conversation", () => {
      let context = createMockContext({
        systemPrompt: "Finance assistant",
      });
      context = addExchangeToContext(
        context,
        "What is FIRE?",
        "FIRE stands for Financial Independence, Retire Early."
      );
      context = addExchangeToContext(
        context,
        "How do I calculate it?",
        "You need to determine your annual expenses and multiply by 25."
      );
      const prompt = buildFullPrompt(context, "What about the 4% rule?");
      assert.ok(prompt.includes("## Previous Conversation:"));
      assert.ok(prompt.includes("What is FIRE?"));
      assert.ok(prompt.includes("Financial Independence"));
      assert.ok(prompt.includes("How do I calculate it?"));
      assert.ok(prompt.includes("4% rule"));
    });

    it("should properly trim and build prompt for token-heavy conversations", () => {
      const heavyMessages: GeminiHistoryMessage[] = Array.from(
        { length: 20 },
        (_, i) => ({
          role: (i % 2 === 0 ? "user" : "model") as "user" | "model",
          parts: [{ text: `Message ${i}: ${"x".repeat(200)}` }],
        })
      );
      const trimmed = trimHistoryToTokenBudget(heavyMessages, 500);
      const context = createMockContext({
        systemPrompt: "System",
        history: trimmed,
      });
      const prompt = buildFullPrompt(context, "Next question");
      assert.ok(prompt.includes("System"));
      assert.ok(prompt.includes("Next question"));
    });

    it("should track token estimates correctly through conversation lifecycle", () => {
      let context = createMockContext({
        systemPrompt: "A".repeat(400), // 100 tokens
        tokenEstimate: 100,
      });

      // Add exchange 1
      context = addExchangeToContext(
        context,
        "B".repeat(80), // 20 tokens
        "C".repeat(120) // 30 tokens
      );
      assert.strictEqual(context.tokenEstimate, 150);

      // Add exchange 2
      context = addExchangeToContext(
        context,
        "D".repeat(40), // 10 tokens
        "E".repeat(40) // 10 tokens
      );
      assert.strictEqual(context.tokenEstimate, 170);

      // Check near limit
      assert.strictEqual(isNearTokenLimit(context), false);
    });
  });

  // ───────────────────── Edge cases & boundary tests ─────────────────────

  describe("Edge cases", () => {
    it("should handle Unicode characters in token estimation", () => {
      const text = "₹1,500 投資 分析 P/E"; // Mixed unicode
      const tokens = estimateTokens(text);
      assert.ok(tokens > 0);
      assert.strictEqual(tokens, Math.ceil(text.length / 4));
    });

    it("should handle emoji in messages", () => {
      const text = "📈 Portfolio up 5%! 🎉";
      const tokens = estimateTokens(text);
      assert.ok(tokens > 0);
    });

    it("should handle messages with only newlines", () => {
      const messages: ChatMessage[] = [
        createMockChatMessage({ content: "\n\n\n" }),
      ];
      const result = convertToGeminiFormat(messages);
      assert.strictEqual(result[0].parts[0].text, "\n\n\n");
    });

    it("should handle very deep conversation (50 exchanges)", () => {
      let context = createMockContext({ tokenEstimate: 0 });
      for (let i = 0; i < 50; i++) {
        context = addExchangeToContext(context, `Question ${i}`, `Answer ${i}`);
      }
      assert.strictEqual(context.history.length, 100);
      assert.ok(context.tokenEstimate > 0);
    });

    it("should trim exactly at budget boundary", () => {
      // Create 5 messages each exactly 10 tokens (40 chars)
      const history: GeminiHistoryMessage[] = Array.from(
        { length: 5 },
        (_, i) =>
          createMockMessage({
            role: i % 2 === 0 ? "user" : "model",
            parts: [{ text: String.fromCharCode(65 + i).repeat(40) }],
          })
      );
      // Budget of 30 should fit exactly 3 messages (10 tokens each)
      const result = trimHistoryToTokenBudget(history, 30);
      assert.strictEqual(result.length, 3);
    });

    it("should handle buildFullPrompt with extremely long system prompt", () => {
      const longSystemPrompt = "System: " + "x".repeat(10000);
      const context = createMockContext({
        systemPrompt: longSystemPrompt,
      });
      const result = buildFullPrompt(context, "Hello");
      assert.ok(result.includes("x".repeat(100)));
      assert.ok(result.includes("User: Hello"));
    });

    it("should preserve RAG context through multi-turn conversation", () => {
      let context = createMockContext({
        systemPrompt: "Finance AI",
        ragContext: "User has 5 holdings worth 10L",
      });
      context = addExchangeToContext(context, "Q1", "A1");
      context = addExchangeToContext(context, "Q2", "A2");

      assert.strictEqual(context.ragContext, "User has 5 holdings worth 10L");
      const prompt = buildFullPrompt(context, "Q3");
      assert.ok(prompt.includes("5 holdings"));
    });

    it("should correctly handle token budget with multi-part messages", () => {
      const history: GeminiHistoryMessage[] = [
        {
          role: "user",
          parts: [
            { text: "A".repeat(20) }, // 5 tokens
            { text: "B".repeat(20) }, // 5 tokens
          ],
        }, // Total: 10 tokens
        {
          role: "model",
          parts: [{ text: "C".repeat(40) }], // 10 tokens
        },
      ];
      // Budget of 15: should fit only the model message (10 tokens)
      // since user message (10 tokens) + model (10) = 20 > 15
      const result = trimHistoryToTokenBudget(history, 15);
      assert.strictEqual(result.length, 1);
      assert.strictEqual(result[0].role, "model");
    });

    it("should handle isNearTokenLimit with negative token estimate", () => {
      const context = createMockContext({ tokenEstimate: -1 });
      assert.strictEqual(isNearTokenLimit(context), false);
    });

    it("should handle conversation context with all empty strings", () => {
      const context = createMockContext({
        systemPrompt: "",
        ragContext: "",
        history: [],
        tokenEstimate: 0,
      });
      const prompt = buildFullPrompt(context, "Hello");
      assert.ok(prompt.includes("User: Hello"));
      assert.ok(prompt.includes("Assistant:"));
    });
  });

  // ───────────────────── Functional: conversation lifecycle ─────────────────────

  describe("Functional: full conversation lifecycle", () => {
    it("should correctly flow: build → exchange → exchange → check limit → trim → build", () => {
      // 1. Start fresh conversation
      let context = createMockContext({
        systemPrompt: "You are a financial advisor for Indian markets.",
        tokenEstimate: 25, // ~100 chars
      });

      // 2. First exchange
      context = addExchangeToContext(
        context,
        "What is my portfolio worth?",
        "Based on your holdings, your portfolio is worth approximately ₹15,00,000."
      );
      assert.strictEqual(context.history.length, 2);

      // 3. Second exchange
      context = addExchangeToContext(
        context,
        "Which stocks are losing money?",
        "Currently TCS and INFY are showing losses of ₹5,000 and ₹2,000 respectively."
      );
      assert.strictEqual(context.history.length, 4);

      // 4. Third exchange
      context = addExchangeToContext(
        context,
        "Should I sell TCS?",
        "TCS is a strong long-term hold. The current dip may be temporary."
      );
      assert.strictEqual(context.history.length, 6);

      // 5. Check if near limit
      const nearLimit = isNearTokenLimit(context);
      // With these short messages, should NOT be near limit
      assert.strictEqual(nearLimit, false);

      // 6. Build final prompt
      const prompt = buildFullPrompt(context, "What about INFY?");
      assert.ok(prompt.includes("financial advisor"));
      assert.ok(prompt.includes("portfolio worth"));
      assert.ok(prompt.includes("TCS"));
      assert.ok(prompt.includes("What about INFY?"));
      assert.ok(prompt.endsWith("Assistant:"));
    });

    it("should handle near-limit scenario with trimming", () => {
      // Create a heavy context near the limit
      const heavyHistory: GeminiHistoryMessage[] = Array.from(
        { length: 20 },
        (_, i) => ({
          role: (i % 2 === 0 ? "user" : "model") as "user" | "model",
          parts: [{ text: `${"X".repeat(1600)} Message ${i}` }], // 400 tokens each
        })
      );

      const context = createMockContext({
        systemPrompt: "System prompt",
        history: heavyHistory,
        tokenEstimate: 16000, // At the real default budget (16000)
      });

      // Should be near limit
      assert.strictEqual(isNearTokenLimit(context), true);

      // Trim to fit budget
      const trimmed = trimHistoryToTokenBudget(context.history, 2000);
      assert.ok(trimmed.length < heavyHistory.length);
      assert.ok(trimmed.length > 0);

      // Build prompt with trimmed history
      const trimmedContext = {
        ...context,
        history: trimmed,
      };
      const prompt = buildFullPrompt(trimmedContext, "New question");
      assert.ok(prompt.includes("New question"));
    });
  });
});
