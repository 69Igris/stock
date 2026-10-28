/**
 * Chat History Action Tests
 *
 * Exercises the REAL pure logic behind the `listChatHistoriesAction` /
 * `getChatHistoryByIdAction` demo branches:
 *   apps/web/lib/actions/chat-history-logic.ts
 *     - filterDemoChatHistories (filter + search + sort + paginate)
 *     - findDemoChatById
 * and the REAL demo fixtures (apps/web/lib/demo/data.ts demoChatHistories)
 * that the action feeds into them.
 *
 * No inline re-implementation — the action calls these exact functions, so a
 * regression in the demo filter/sort/pagination contract fails here.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  filterDemoChatHistories,
  findDemoChatById,
} from "@/lib/actions/chat-history-logic";
import { demoChatHistories } from "@/lib/demo/data";
import type { ChatHistoryRecord } from "@usemoney/services";
import type { ChatMessage } from "@usemoney/types";

// The real demo fixtures are typed as a literal array; cast once to the
// service record type the logic functions accept (they only read the shared
// fields: pagePath / pageName / isArchived / messages / *At dates).
const demoChats = demoChatHistories as unknown as ChatHistoryRecord[];

// ============== Local message-count helpers ====================
// These are trivial assertions about the demo fixture message arrays; they do
// not re-implement any production unit (the action does not count messages).

function countAssistantMessages(messages: ChatMessage[]): number {
  return messages.filter((m) => m.role === "assistant").length;
}
function countUserMessages(messages: ChatMessage[]): number {
  return messages.filter((m) => m.role === "user").length;
}

// ============== MOCK DATA FACTORY ==============

function createChatHistory(
  overrides: Partial<ChatHistoryRecord> = {}
): ChatHistoryRecord {
  const now = new Date();
  return {
    id: `chat-${Math.random().toString(36).slice(2, 8)}`,
    userId: "test-user",
    pagePath: "/dashboard",
    pageName: "Dashboard",
    pageIcon: "Activity",
    messages: [
      { role: "user", content: "Hello" },
      { role: "assistant", content: "Hi there!" },
    ],
    isArchived: false,
    createdAt: now,
    updatedAt: now,
    lastMessageAt: now,
    ...overrides,
  };
}

// ============== TESTS ==============

describe("Chat History Actions (real demo logic)", () => {
  // -- Demo Data Structure --

  describe("Demo chat histories fixture", () => {
    it("should have 4 demo chat histories", () => {
      assert.strictEqual(demoChats.length, 4);
    });

    it("should have unique IDs", () => {
      const ids = demoChats.map((c) => c.id);
      assert.strictEqual(new Set(ids).size, ids.length);
    });

    it("should all belong to demo-user-123", () => {
      for (const chat of demoChats) {
        assert.strictEqual(chat.userId, "demo-user-123");
      }
    });

    it("should have the expected page paths", () => {
      const paths = demoChats.map((c) => c.pagePath);
      assert.ok(paths.includes("/dashboard"));
      assert.ok(paths.includes("/analysis"));
      assert.ok(paths.includes("/tutor"));
      assert.ok(paths.includes("/tradebook"));
    });
  });

  // -- Filter by Page Path --

  describe("Filter by pagePath", () => {
    it("should return only chats matching the page path", () => {
      const result = filterDemoChatHistories(demoChats, {
        pagePath: "/dashboard",
      });
      assert.strictEqual(result.chats.length, 1);
      assert.strictEqual(result.chats[0]!.id, "demo-chat-1");
    });

    it("should return empty for non-existent page path", () => {
      const result = filterDemoChatHistories(demoChats, {
        pagePath: "/settings",
      });
      assert.strictEqual(result.chats.length, 0);
    });

    it("should return all when no pagePath filter", () => {
      const result = filterDemoChatHistories(demoChats, {});
      assert.strictEqual(result.chats.length, 4);
    });

    it("should filter /analysis path correctly", () => {
      const result = filterDemoChatHistories(demoChats, {
        pagePath: "/analysis",
      });
      assert.strictEqual(result.chats.length, 1);
      assert.strictEqual(result.chats[0]!.id, "demo-chat-2");
    });

    it("should be exact match, not partial", () => {
      const result = filterDemoChatHistories(demoChats, { pagePath: "/dash" });
      assert.strictEqual(result.chats.length, 0);
    });
  });

  // -- Filter by Archived Status --

  describe("Filter by isArchived", () => {
    it("should return only non-archived chats", () => {
      const result = filterDemoChatHistories(demoChats, { isArchived: false });
      assert.strictEqual(result.chats.length, 3);
      for (const chat of result.chats) {
        assert.strictEqual(chat.isArchived, false);
      }
    });

    it("should return only archived chats", () => {
      const result = filterDemoChatHistories(demoChats, { isArchived: true });
      assert.strictEqual(result.chats.length, 1);
      assert.strictEqual(result.chats[0]!.id, "demo-chat-4");
    });

    it("should return all chats when isArchived is undefined", () => {
      const result = filterDemoChatHistories(demoChats, {});
      assert.strictEqual(result.chats.length, 4);
    });

    it("should combine pagePath and isArchived filters", () => {
      const result = filterDemoChatHistories(demoChats, {
        pagePath: "/tradebook",
        isArchived: true,
      });
      assert.strictEqual(result.chats.length, 1);
      assert.strictEqual(result.chats[0]!.id, "demo-chat-4");
    });

    it("should return empty when pagePath and isArchived exclude all", () => {
      const result = filterDemoChatHistories(demoChats, {
        pagePath: "/dashboard",
        isArchived: true,
      });
      assert.strictEqual(result.chats.length, 0);
    });
  });

  // -- Search Query Matching --

  describe("Search query matching", () => {
    it("should match by pagePath", () => {
      const result = filterDemoChatHistories(demoChats, {
        searchQuery: "/tutor",
      });
      assert.strictEqual(result.chats.length, 1);
      assert.strictEqual(result.chats[0]!.id, "demo-chat-3");
    });

    it("should match by pageName (case-insensitive)", () => {
      // chat-2's pageName is "Analysis Results" in the real fixture.
      const result = filterDemoChatHistories(demoChats, {
        searchQuery: "ANALYSIS RESULTS",
      });
      assert.strictEqual(result.chats.length, 1);
      assert.strictEqual(result.chats[0]!.id, "demo-chat-2");
    });

    it("should match by message content (case-insensitive)", () => {
      const result = filterDemoChatHistories(demoChats, {
        searchQuery: "reliance",
      });
      assert.strictEqual(result.chats.length, 1);
      assert.strictEqual(result.chats[0]!.id, "demo-chat-1");
    });

    it("should match assistant message content across multiple chats", () => {
      const result = filterDemoChatHistories(demoChats, {
        searchQuery: "stop-loss",
      });
      assert.strictEqual(result.chats.length, 2); // analysis + tradebook chats
    });

    it("should match user message content", () => {
      const result = filterDemoChatHistories(demoChats, {
        searchQuery: "entry timing",
      });
      assert.strictEqual(result.chats.length, 1);
      assert.strictEqual(result.chats[0]!.id, "demo-chat-2");
    });

    it("should return empty for no matches", () => {
      const result = filterDemoChatHistories(demoChats, {
        searchQuery: "xyznonexistent",
      });
      assert.strictEqual(result.chats.length, 0);
    });

    it("should ignore empty search query", () => {
      const result = filterDemoChatHistories(demoChats, { searchQuery: "" });
      assert.strictEqual(result.chats.length, 4);
    });

    it("should ignore whitespace-only search query", () => {
      const result = filterDemoChatHistories(demoChats, { searchQuery: "   " });
      assert.strictEqual(result.chats.length, 4);
    });

    it("should trim search query before matching", () => {
      const result = filterDemoChatHistories(demoChats, {
        searchQuery: "  /tutor  ",
      });
      assert.strictEqual(result.chats.length, 1);
    });
  });

  // -- Sorting --

  describe("Sorting", () => {
    it("should sort by lastMessage desc by default", () => {
      const result = filterDemoChatHistories(demoChats, {});
      // lastMessage order (desc): chat-2 (1d), chat-1 (2d), chat-3 (7d), chat-4 (8d)
      assert.strictEqual(result.chats[0]!.id, "demo-chat-2");
      assert.strictEqual(result.chats[1]!.id, "demo-chat-1");
      assert.strictEqual(result.chats[2]!.id, "demo-chat-3");
      assert.strictEqual(result.chats[3]!.id, "demo-chat-4");
    });

    it("should sort by lastMessage asc", () => {
      const result = filterDemoChatHistories(demoChats, {
        sortBy: "lastMessage",
        order: "asc",
      });
      assert.strictEqual(result.chats[0]!.id, "demo-chat-4");
      assert.strictEqual(result.chats[3]!.id, "demo-chat-2");
    });

    it("should sort by date (createdAt) desc", () => {
      const result = filterDemoChatHistories(demoChats, {
        sortBy: "date",
        order: "desc",
      });
      // createdAt order (desc): chat-1 (2d), chat-2 (5d), chat-3 (7d), chat-4 (10d)
      assert.strictEqual(result.chats[0]!.id, "demo-chat-1");
      assert.strictEqual(result.chats[1]!.id, "demo-chat-2");
      assert.strictEqual(result.chats[2]!.id, "demo-chat-3");
      assert.strictEqual(result.chats[3]!.id, "demo-chat-4");
    });

    it("should sort by date (createdAt) asc", () => {
      const result = filterDemoChatHistories(demoChats, {
        sortBy: "date",
        order: "asc",
      });
      assert.strictEqual(result.chats[0]!.id, "demo-chat-4");
      assert.strictEqual(result.chats[3]!.id, "demo-chat-1");
    });

    it("should distinguish createdAt from lastMessageAt correctly", () => {
      const byDate = filterDemoChatHistories(demoChats, {
        sortBy: "date",
        order: "desc",
      });
      const byLastMessage = filterDemoChatHistories(demoChats, {
        sortBy: "lastMessage",
        order: "desc",
      });
      assert.strictEqual(byDate.chats[0]!.id, "demo-chat-1");
      assert.strictEqual(byLastMessage.chats[0]!.id, "demo-chat-2");
    });
  });

  // -- Pagination (Limit / skip) --

  describe("Pagination", () => {
    it("should limit results to specified count", () => {
      const result = filterDemoChatHistories(demoChats, { limit: 2 });
      assert.strictEqual(result.chats.length, 2);
    });

    it("should return all when limit exceeds count", () => {
      const result = filterDemoChatHistories(demoChats, { limit: 100 });
      assert.strictEqual(result.chats.length, 4);
    });

    it("should return 1 when limit is 1", () => {
      const result = filterDemoChatHistories(demoChats, { limit: 1 });
      assert.strictEqual(result.chats.length, 1);
    });

    it("should apply limit after sorting", () => {
      const result = filterDemoChatHistories(demoChats, {
        sortBy: "lastMessage",
        order: "desc",
        limit: 1,
      });
      assert.strictEqual(result.chats[0]!.id, "demo-chat-2");
    });

    it("should apply limit after filtering", () => {
      const result = filterDemoChatHistories(demoChats, {
        isArchived: false,
        limit: 1,
      });
      assert.strictEqual(result.chats.length, 1);
    });

    it("should return totalCount regardless of limit", () => {
      const result = filterDemoChatHistories(demoChats, { limit: 2 });
      assert.strictEqual(result.chats.length, 2);
      assert.strictEqual(result.totalCount, 4);
    });

    it("should skip items with skip parameter", () => {
      const result = filterDemoChatHistories(demoChats, {
        sortBy: "lastMessage",
        order: "desc",
        skip: 2,
        limit: 2,
      });
      assert.strictEqual(result.chats.length, 2);
      assert.strictEqual(result.totalCount, 4);
      // Skipped first 2 (chat-2, chat-1), got (chat-3, chat-4)
      assert.strictEqual(result.chats[0]!.id, "demo-chat-3");
      assert.strictEqual(result.chats[1]!.id, "demo-chat-4");
    });

    it("should return empty page when skip exceeds total", () => {
      const result = filterDemoChatHistories(demoChats, {
        skip: 10,
        limit: 2,
      });
      assert.strictEqual(result.chats.length, 0);
      assert.strictEqual(result.totalCount, 4);
    });

    it("should handle skip without limit", () => {
      const result = filterDemoChatHistories(demoChats, {
        sortBy: "lastMessage",
        order: "desc",
        skip: 3,
      });
      assert.strictEqual(result.chats.length, 1);
      assert.strictEqual(result.totalCount, 4);
    });

    it("should paginate filtered results correctly", () => {
      const result = filterDemoChatHistories(demoChats, {
        isArchived: false,
        sortBy: "lastMessage",
        order: "desc",
        skip: 1,
        limit: 1,
      });
      // 3 non-archived sorted: chat-2, chat-1, chat-3; skip 1 → chat-1
      assert.strictEqual(result.chats.length, 1);
      assert.strictEqual(result.totalCount, 3);
      assert.strictEqual(result.chats[0]!.id, "demo-chat-1");
    });

    it("should paginate search results correctly", () => {
      const result = filterDemoChatHistories(demoChats, {
        searchQuery: "stop-loss",
        skip: 1,
        limit: 1,
      });
      assert.strictEqual(result.chats.length, 1);
      assert.strictEqual(result.totalCount, 2);
    });
  });

  // -- findDemoChatById --

  describe("findDemoChatById", () => {
    it("should find existing chat by ID", () => {
      const chat = findDemoChatById(demoChats, "demo-chat-1");
      assert.ok(chat);
      assert.strictEqual(chat.id, "demo-chat-1");
    });

    it("should return undefined for non-existent ID", () => {
      const chat = findDemoChatById(demoChats, "demo-chat-999");
      assert.strictEqual(chat, undefined);
    });

    it("should return the archived chat by ID", () => {
      const chat = findDemoChatById(demoChats, "demo-chat-4");
      assert.ok(chat);
      assert.strictEqual(chat.isArchived, true);
    });
  });

  // -- Message counting on the real fixture --

  describe("Demo fixture message counts", () => {
    it("should count assistant messages in chat-1", () => {
      assert.strictEqual(countAssistantMessages(demoChats[0]!.messages), 1);
    });

    it("should count assistant messages in chat-2 (multi-turn)", () => {
      assert.strictEqual(countAssistantMessages(demoChats[1]!.messages), 2);
    });

    it("should count user messages in chat-2 (multi-turn)", () => {
      assert.strictEqual(countUserMessages(demoChats[1]!.messages), 2);
    });

    it("should return 0 for empty messages", () => {
      assert.strictEqual(countAssistantMessages([]), 0);
      assert.strictEqual(countUserMessages([]), 0);
    });
  });

  // -- Date comparison on the real fixture --

  describe("Date relationships in fixture", () => {
    it("chat-2 lastMessageAt should be more recent than createdAt", () => {
      const chat = demoChats[1]!;
      assert.ok(chat.lastMessageAt.getTime() > chat.createdAt.getTime());
    });

    it("chat-1 lastMessageAt should equal createdAt (single conversation)", () => {
      const chat = demoChats[0]!;
      assert.strictEqual(
        chat.lastMessageAt.getTime(),
        chat.createdAt.getTime()
      );
    });
  });

  // -- Combined filter scenarios (synthetic data through real logic) --

  describe("Combined filter scenarios", () => {
    it("should combine pagePath + search + limit", () => {
      const chats = [
        createChatHistory({
          id: "c1",
          pagePath: "/dashboard",
          pageName: "Dashboard",
          messages: [{ role: "user", content: "Show my portfolio" }],
        }),
        createChatHistory({
          id: "c2",
          pagePath: "/dashboard",
          pageName: "Dashboard",
          messages: [{ role: "user", content: "What is my P&L?" }],
        }),
        createChatHistory({
          id: "c3",
          pagePath: "/analysis",
          pageName: "Analysis",
          messages: [{ role: "user", content: "Show my portfolio analysis" }],
        }),
      ];

      const result = filterDemoChatHistories(chats, {
        pagePath: "/dashboard",
        searchQuery: "portfolio",
        limit: 1,
      });
      assert.strictEqual(result.chats.length, 1);
      assert.strictEqual(result.chats[0]!.id, "c1");
    });

    it("should handle all filters returning empty", () => {
      const result = filterDemoChatHistories(demoChats, {
        pagePath: "/settings",
        isArchived: true,
        searchQuery: "nonexistent",
      });
      assert.strictEqual(result.chats.length, 0);
    });
  });

  // -- Edge Cases (synthetic data through real logic) --

  describe("Edge cases", () => {
    it("should handle chat with empty messages array", () => {
      const chats = [createChatHistory({ id: "empty", messages: [] })];
      const result = filterDemoChatHistories(chats, {
        searchQuery: "anything",
      });
      assert.strictEqual(result.chats.length, 0);
    });

    it("should handle chat with empty content strings", () => {
      const chats = [
        createChatHistory({
          id: "empty-content",
          messages: [{ role: "user", content: "" }],
        }),
      ];
      const result = filterDemoChatHistories(chats, { searchQuery: "hello" });
      assert.strictEqual(result.chats.length, 0);
    });

    it("should match pageName even if messages are empty", () => {
      const chats = [
        createChatHistory({
          id: "name-match",
          pageName: "Special Page",
          messages: [],
        }),
      ];
      const result = filterDemoChatHistories(chats, { searchQuery: "special" });
      assert.strictEqual(result.chats.length, 1);
    });
  });
});
