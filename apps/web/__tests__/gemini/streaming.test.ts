/**
 * Gemini Conversation / Streaming Context Tests
 *
 * Tests for pure utility functions extracted from the conversation context module:
 *   - estimateTokens: rough token estimation (1 token ≈ 4 chars)
 *   - convertToGeminiFormat: transforms ChatMessage[] to GeminiHistoryMessage[]
 *   - trimHistoryToTokenBudget: trims oldest messages to fit token budget
 *   - getContextCacheKey: generates cache key for conversation context
 *   - buildFullPrompt: assembles system prompt + history + RAG + current message
 *   - addExchangeToContext: appends user+model exchange to context
 *   - isNearTokenLimit: checks if context is approaching the token budget
 *   - createGeminiChatHistory: returns history from context (identity)
 *
 * Source: apps/web/lib/gemini/conversation.ts
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
// De-shadowed (MONEY-620): assert the REAL conversation.ts exports (this file
// and conversation.test.ts both targeted conversation.ts). Note the real
// buildFullPrompt wraps RAG context in an "EXTERNAL DATA BOUNDARY" fence
// (prompt-injection mitigation); the assertions here check inclusion/order so
// they hold against the real implementation.
import {
  estimateTokens,
  convertToGeminiFormat,
  trimHistoryToTokenBudget,
  getContextCacheKey,
  buildFullPrompt,
  createGeminiChatHistory,
  addExchangeToContext,
  isNearTokenLimit,
  type GeminiHistoryMessage,
  type ConversationContext,
} from "@/lib/gemini/conversation";
import type { ChatMessage } from "@usemoney/types";

// --- Tests ---

describe("Gemini Conversation Context", () => {
  // -- estimateTokens --

  describe("estimateTokens", () => {
    it("should estimate 1 token for 4 characters", () => {
      assert.strictEqual(estimateTokens("abcd"), 1);
    });

    it("should round up partial tokens", () => {
      // 5 chars -> ceil(5/4) = 2
      assert.strictEqual(estimateTokens("abcde"), 2);
    });

    it("should return 0 for empty string", () => {
      assert.strictEqual(estimateTokens(""), 0);
    });

    it("should handle single character", () => {
      assert.strictEqual(estimateTokens("a"), 1);
    });

    it("should handle long text", () => {
      const text = "x".repeat(400);
      assert.strictEqual(estimateTokens(text), 100);
    });

    it("should handle 8 characters as 2 tokens", () => {
      assert.strictEqual(estimateTokens("12345678"), 2);
    });

    it("should handle exactly 4000 chars as 1000 tokens", () => {
      assert.strictEqual(estimateTokens("a".repeat(4000)), 1000);
    });
  });

  // -- convertToGeminiFormat --

  describe("convertToGeminiFormat", () => {
    it("should convert user message to user role", () => {
      const messages: ChatMessage[] = [{ role: "user", content: "Hello" }];
      const result = convertToGeminiFormat(messages);
      assert.strictEqual(result.length, 1);
      assert.strictEqual(result[0].role, "user");
      assert.strictEqual(result[0].parts[0].text, "Hello");
    });

    it("should convert assistant message to model role", () => {
      const messages: ChatMessage[] = [
        { role: "assistant", content: "Hi there" },
      ];
      const result = convertToGeminiFormat(messages);
      assert.strictEqual(result[0].role, "model");
    });

    it("should handle empty array", () => {
      const result = convertToGeminiFormat([]);
      assert.strictEqual(result.length, 0);
    });

    it("should convert multiple messages preserving order", () => {
      const messages: ChatMessage[] = [
        { role: "user", content: "What is NIFTY?" },
        { role: "assistant", content: "NIFTY is an index." },
        { role: "user", content: "Tell me more." },
      ];
      const result = convertToGeminiFormat(messages);
      assert.strictEqual(result.length, 3);
      assert.strictEqual(result[0].role, "user");
      assert.strictEqual(result[1].role, "model");
      assert.strictEqual(result[2].role, "user");
    });

    it("should wrap content in parts array with single text element", () => {
      const messages: ChatMessage[] = [
        { role: "user", content: "test content" },
      ];
      const result = convertToGeminiFormat(messages);
      assert.strictEqual(result[0].parts.length, 1);
      assert.strictEqual(result[0].parts[0].text, "test content");
    });
  });

  // -- trimHistoryToTokenBudget --

  describe("trimHistoryToTokenBudget", () => {
    it("should keep all messages if within budget", () => {
      const history: GeminiHistoryMessage[] = [
        { role: "user", parts: [{ text: "Hi" }] },
        { role: "model", parts: [{ text: "Hello" }] },
      ];
      const result = trimHistoryToTokenBudget(history, 1000);
      assert.strictEqual(result.length, 2);
    });

    it("should trim oldest messages when budget exceeded", () => {
      const history: GeminiHistoryMessage[] = [
        { role: "user", parts: [{ text: "a".repeat(400) }] }, // 100 tokens
        { role: "model", parts: [{ text: "b".repeat(400) }] }, // 100 tokens
        { role: "user", parts: [{ text: "c".repeat(400) }] }, // 100 tokens
      ];
      // Budget of 200 tokens: should keep only the last 2 messages
      const result = trimHistoryToTokenBudget(history, 200);
      assert.strictEqual(result.length, 2);
      assert.strictEqual(result[0].parts[0].text, "b".repeat(400));
      assert.strictEqual(result[1].parts[0].text, "c".repeat(400));
    });

    it("should handle empty history", () => {
      const result = trimHistoryToTokenBudget([], 1000);
      assert.strictEqual(result.length, 0);
    });

    it("should return empty array if no messages fit budget", () => {
      const history: GeminiHistoryMessage[] = [
        { role: "user", parts: [{ text: "a".repeat(1000) }] }, // 250 tokens
      ];
      const result = trimHistoryToTokenBudget(history, 10);
      assert.strictEqual(result.length, 0);
    });

    it("should keep most recent messages when trimming", () => {
      const history: GeminiHistoryMessage[] = [
        { role: "user", parts: [{ text: "first" }] },
        { role: "model", parts: [{ text: "second" }] },
        { role: "user", parts: [{ text: "third" }] },
        { role: "model", parts: [{ text: "fourth" }] },
      ];
      // Each message is ~2 tokens. Budget of 4 tokens = 2 messages
      const result = trimHistoryToTokenBudget(history, 4);
      assert.strictEqual(result.length, 2);
      assert.strictEqual(result[1].parts[0].text, "fourth");
    });

    it("should handle budget of 0", () => {
      const history: GeminiHistoryMessage[] = [
        { role: "user", parts: [{ text: "hello" }] },
      ];
      const result = trimHistoryToTokenBudget(history, 0);
      assert.strictEqual(result.length, 0);
    });

    it("should handle messages with multiple parts", () => {
      const history: GeminiHistoryMessage[] = [
        {
          role: "user",
          parts: [{ text: "part1" }, { text: "part2" }],
        },
      ];
      // 5 chars + 5 chars = 10 chars -> 3 tokens total
      const result = trimHistoryToTokenBudget(history, 5);
      assert.strictEqual(result.length, 1);
    });
  });

  // -- getContextCacheKey --

  describe("getContextCacheKey", () => {
    it("should generate key with chatId", () => {
      assert.strictEqual(
        getContextCacheKey("user-123", "chat-456"),
        "context:chat-456"
      );
    });

    it("should ignore userId in key generation", () => {
      const key1 = getContextCacheKey("user-A", "chat-1");
      const key2 = getContextCacheKey("user-B", "chat-1");
      assert.strictEqual(key1, key2);
    });

    it("should produce different keys for different chatIds", () => {
      const key1 = getContextCacheKey("user-1", "chat-A");
      const key2 = getContextCacheKey("user-1", "chat-B");
      assert.notStrictEqual(key1, key2);
    });

    it("should handle empty chatId", () => {
      assert.strictEqual(getContextCacheKey("user-1", ""), "context:");
    });
  });

  // -- buildFullPrompt --

  describe("buildFullPrompt", () => {
    it("should include system prompt when present", () => {
      const context: ConversationContext = {
        history: [],
        systemPrompt: "You are a helpful assistant.",
        tokenEstimate: 0,
      };
      const result = buildFullPrompt(context, "Hello");
      assert.ok(result.includes("You are a helpful assistant."));
    });

    it("should include current user message", () => {
      const context: ConversationContext = {
        history: [],
        systemPrompt: "",
        tokenEstimate: 0,
      };
      const result = buildFullPrompt(context, "What is NIFTY?");
      assert.ok(result.includes("User: What is NIFTY?"));
    });

    it("should end with Assistant:", () => {
      const context: ConversationContext = {
        history: [],
        systemPrompt: "",
        tokenEstimate: 0,
      };
      const result = buildFullPrompt(context, "test");
      assert.ok(result.endsWith("\nAssistant:"));
    });

    it("should include conversation history", () => {
      const context: ConversationContext = {
        history: [
          { role: "user", parts: [{ text: "prev question" }] },
          { role: "model", parts: [{ text: "prev answer" }] },
        ],
        systemPrompt: "",
        tokenEstimate: 0,
      };
      const result = buildFullPrompt(context, "follow up");
      assert.ok(result.includes("## Previous Conversation:"));
      assert.ok(result.includes("User: prev question"));
      assert.ok(result.includes("Assistant: prev answer"));
    });

    it("should include RAG context from parameter", () => {
      const context: ConversationContext = {
        history: [],
        systemPrompt: "",
        tokenEstimate: 0,
      };
      const result = buildFullPrompt(context, "test", "Portfolio data here");
      assert.ok(result.includes("## Relevant User Data:"));
      assert.ok(result.includes("Portfolio data here"));
    });

    it("should include RAG context from context object", () => {
      const context: ConversationContext = {
        history: [],
        systemPrompt: "",
        ragContext: "Embedded RAG data",
        tokenEstimate: 0,
      };
      const result = buildFullPrompt(context, "test");
      assert.ok(result.includes("Embedded RAG data"));
    });

    it("should prefer ragContext parameter over context.ragContext", () => {
      const context: ConversationContext = {
        history: [],
        systemPrompt: "",
        ragContext: "context-rag",
        tokenEstimate: 0,
      };
      const result = buildFullPrompt(context, "test", "param-rag");
      assert.ok(result.includes("param-rag"));
    });

    it("should not include Previous Conversation section when history is empty", () => {
      const context: ConversationContext = {
        history: [],
        systemPrompt: "sys",
        tokenEstimate: 0,
      };
      const result = buildFullPrompt(context, "msg");
      assert.ok(!result.includes("## Previous Conversation:"));
    });

    it("should not include empty system prompt in output", () => {
      const context: ConversationContext = {
        history: [],
        systemPrompt: "",
        tokenEstimate: 0,
      };
      const result = buildFullPrompt(context, "msg");
      // The prompt should start with \nUser: since systemPrompt is empty
      assert.ok(!result.startsWith("\n\n"));
    });
  });

  // -- createGeminiChatHistory --

  describe("createGeminiChatHistory", () => {
    it("should return context history unchanged", () => {
      const history: GeminiHistoryMessage[] = [
        { role: "user", parts: [{ text: "test" }] },
      ];
      const context: ConversationContext = {
        history,
        systemPrompt: "",
        tokenEstimate: 0,
      };
      const result = createGeminiChatHistory(context);
      assert.deepStrictEqual(result, history);
    });

    it("should return empty array for empty context", () => {
      const context: ConversationContext = {
        history: [],
        systemPrompt: "",
        tokenEstimate: 0,
      };
      assert.strictEqual(createGeminiChatHistory(context).length, 0);
    });
  });

  // -- addExchangeToContext --

  describe("addExchangeToContext", () => {
    it("should append user and model messages to history", () => {
      const context: ConversationContext = {
        history: [],
        systemPrompt: "",
        tokenEstimate: 0,
      };
      const result = addExchangeToContext(context, "hello", "hi");
      assert.strictEqual(result.history.length, 2);
      assert.strictEqual(result.history[0].role, "user");
      assert.strictEqual(result.history[1].role, "model");
    });

    it("should preserve existing history", () => {
      const context: ConversationContext = {
        history: [{ role: "user", parts: [{ text: "old" }] }],
        systemPrompt: "",
        tokenEstimate: 10,
      };
      const result = addExchangeToContext(context, "new Q", "new A");
      assert.strictEqual(result.history.length, 3);
      assert.strictEqual(result.history[0].parts[0].text, "old");
    });

    it("should update token estimate", () => {
      const context: ConversationContext = {
        history: [],
        systemPrompt: "",
        tokenEstimate: 100,
      };
      // "hello" = 5 chars -> 2 tokens; "world!!" = 7 chars -> 2 tokens
      const result = addExchangeToContext(context, "hello", "world!!");
      assert.ok(result.tokenEstimate > 100);
      assert.strictEqual(
        result.tokenEstimate,
        100 + estimateTokens("hello") + estimateTokens("world!!")
      );
    });

    it("should not mutate original context", () => {
      const original: ConversationContext = {
        history: [],
        systemPrompt: "sys",
        tokenEstimate: 0,
      };
      addExchangeToContext(original, "q", "a");
      assert.strictEqual(original.history.length, 0);
      assert.strictEqual(original.tokenEstimate, 0);
    });

    it("should preserve systemPrompt", () => {
      const context: ConversationContext = {
        history: [],
        systemPrompt: "You are helpful.",
        tokenEstimate: 0,
      };
      const result = addExchangeToContext(context, "q", "a");
      assert.strictEqual(result.systemPrompt, "You are helpful.");
    });
  });

  // -- isNearTokenLimit --

  describe("isNearTokenLimit", () => {
    it("should return false when well below limit", () => {
      const context: ConversationContext = {
        history: [],
        systemPrompt: "",
        tokenEstimate: 100,
      };
      assert.strictEqual(isNearTokenLimit(context), false);
    });

    it("should return true when above 80% of budget", () => {
      const context: ConversationContext = {
        history: [],
        systemPrompt: "",
        tokenEstimate: 13000, // 13000 > 16000 * 0.8 = 12800
      };
      assert.strictEqual(isNearTokenLimit(context), true);
    });

    it("should return false at exactly 80% threshold", () => {
      const context: ConversationContext = {
        history: [],
        systemPrompt: "",
        tokenEstimate: 12800, // 12800 is not > 12800
      };
      assert.strictEqual(isNearTokenLimit(context), false);
    });

    it("should support custom threshold", () => {
      const context: ConversationContext = {
        history: [],
        systemPrompt: "",
        tokenEstimate: 10000,
      };
      // 10000 > 16000 * 0.5 = 8000
      assert.strictEqual(isNearTokenLimit(context, 0.5), true);
      // 10000 > 16000 * 0.7 = 11200
      assert.strictEqual(isNearTokenLimit(context, 0.7), false);
    });

    it("should return true when at max budget", () => {
      const context: ConversationContext = {
        history: [],
        systemPrompt: "",
        tokenEstimate: 16000,
      };
      assert.strictEqual(isNearTokenLimit(context), true);
    });

    it("should return false with zero tokens", () => {
      const context: ConversationContext = {
        history: [],
        systemPrompt: "",
        tokenEstimate: 0,
      };
      assert.strictEqual(isNearTokenLimit(context), false);
    });
  });
});
