/**
 * Chat History DB Layer Tests
 *
 * Tests for chat-history.ts database logic including:
 * - convertToChatHistoryRecord: Maps DB record to app format
 *   - Field mapping: id, userId, pagePath, pageName, pageIcon, messages, isArchived, createdAt, updatedAt
 *   - pageIcon: null -> undefined conversion
 *   - messages: JSON -> ChatMessage[] conversion
 * - Search/filter logic from listChatHistories:
 *   - Text search matching (pageName, pagePath, message content)
 *   - isArchived filtering
 *   - pagePath filtering
 *   - Sorting (by date or lastMessage)
 *   - Limit (take)
 * - Message counting per chat
 * - Scenario name handling for FIRE page chats
 *
 * Since these functions call Prisma directly, we extract and test the
 * LOGIC portions (record conversion, search filtering, sorting) as
 * standalone pure functions mirroring the source code behavior.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
// MONEY-620 de-shadow: the row mapper and the search predicate below now
// delegate to the REAL exports that lib/db/chat-history.ts calls in production
// (previously these were re-declared inline — a shadow).
import {
  convertToChatHistoryRecord as convertToChatHistoryRecordReal,
  chatMatchesSearch,
  type RawChatHistoryRow,
} from "@/lib/db/chat-history-logic";

// ---------------------------------------------------------------------------
// Types mirroring the source
// ---------------------------------------------------------------------------

interface ChatMessage {
  role: "user" | "assistant" | "system";
  content: string;
  timestamp?: string;
}

interface ChatHistoryPrisma {
  id: string;
  userId: string;
  pagePath: string;
  pageName: string;
  pageIcon: string | null;
  messages: unknown;
  isArchived: boolean;
  createdAt: Date;
  updatedAt: Date;
  lastMessageAt: Date;
}

interface ChatHistoryRecord {
  id: string;
  userId: string;
  pagePath: string;
  pageName: string;
  pageIcon?: string;
  messages: ChatMessage[];
  isArchived: boolean;
  createdAt: Date;
  updatedAt: Date;
  lastMessageAt: Date;
}

interface ListOptions {
  pagePath?: string;
  isArchived?: boolean;
  sortBy?: "date" | "lastMessage";
  order?: "asc" | "desc";
  limit?: number;
  searchQuery?: string;
}

// ---------------------------------------------------------------------------
// Pure logic extracted from apps/web/lib/db/chat-history.ts
// ---------------------------------------------------------------------------

/**
 * De-shadowed (MONEY-620): delegates to the REAL source export so these tests
 * exercise production code. The local `ChatHistoryPrisma` is structurally a
 * `RawChatHistoryRow`.
 */
function convertToChatHistoryRecord(
  chat: ChatHistoryPrisma
): ChatHistoryRecord {
  return convertToChatHistoryRecordReal(
    chat as RawChatHistoryRow
  ) as ChatHistoryRecord;
}

/**
 * Build the where clause for listChatHistories.
 * Mirrors the filter building logic in the source.
 */
function buildListWhereClause(
  userId: string,
  options: ListOptions
): Record<string, unknown> {
  const where: Record<string, unknown> = { userId };

  if (options.pagePath) {
    where.pagePath = options.pagePath;
  }

  if (options.isArchived !== undefined) {
    where.isArchived = options.isArchived;
  }

  return where;
}

/**
 * Determine sort order for listChatHistories.
 * Mirrors the orderBy logic in the source.
 */
function buildSortOrder(
  sortBy: "date" | "lastMessage" = "lastMessage",
  order: "asc" | "desc" = "desc"
): Record<string, string> {
  if (sortBy === "date") {
    return { createdAt: order };
  }
  return { lastMessageAt: order };
}

/**
 * De-shadowed (MONEY-620): the empty-query short-circuit is the source's
 * `useServerPagination` gate; the per-chat predicate now delegates to the REAL
 * `chatMatchesSearch` export (which expects an already-lowercased query, as the
 * source lowercases once before filtering).
 */
function filterBySearchQuery(
  chats: ChatHistoryRecord[],
  searchQuery?: string
): ChatHistoryRecord[] {
  if (!searchQuery || !searchQuery.trim()) {
    return chats;
  }

  const query = searchQuery.trim().toLowerCase();
  // The local ChatHistoryRecord uses a minimal ChatMessage shape; it is
  // structurally compatible with the predicate's (pageName/pagePath/messages).
  return chats.filter((chat) =>
    chatMatchesSearch(
      chat as unknown as Parameters<typeof chatMatchesSearch>[0],
      query
    )
  );
}

/**
 * Count messages in a chat.
 */
function countMessages(chat: ChatHistoryRecord): number {
  return Array.isArray(chat.messages) ? chat.messages.length : 0;
}

/**
 * Generate chat name with scenario (for FIRE page).
 * Mirrors the naming logic in saveChatHistory.
 */
function generateChatName(pageName: string, scenarioName?: string): string {
  return scenarioName ? `${pageName} - ${scenarioName}` : pageName;
}

/**
 * Build where clause for getChatHistoryByPage.
 * Mirrors the includeArchived logic.
 */
function buildPageWhereClause(
  userId: string,
  pagePath: string,
  includeArchived: boolean
): Record<string, unknown> {
  const where: Record<string, unknown> = { userId, pagePath };
  if (!includeArchived) {
    where.isArchived = false;
  }
  return where;
}

// ---------------------------------------------------------------------------
// Mock data helpers
// ---------------------------------------------------------------------------

function createMockChatPrisma(
  overrides: Partial<ChatHistoryPrisma> = {}
): ChatHistoryPrisma {
  const now = new Date();
  return {
    id: `chat-${Math.random().toString(36).substr(2, 6)}`,
    userId: "user-1",
    pagePath: "/dashboard",
    pageName: "Dashboard",
    pageIcon: null,
    messages: [],
    isArchived: false,
    createdAt: now,
    updatedAt: now,
    lastMessageAt: now,
    ...overrides,
  };
}

function createMockChatRecord(
  overrides: Partial<ChatHistoryRecord> = {}
): ChatHistoryRecord {
  const now = new Date();
  return {
    id: `chat-${Math.random().toString(36).substr(2, 6)}`,
    userId: "user-1",
    pagePath: "/dashboard",
    pageName: "Dashboard",
    pageIcon: undefined,
    messages: [],
    isArchived: false,
    createdAt: now,
    updatedAt: now,
    lastMessageAt: now,
    ...overrides,
  };
}

function createMockMessage(overrides: Partial<ChatMessage> = {}): ChatMessage {
  return {
    role: "user",
    content: "Hello",
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("Chat History DB Logic", () => {
  // =========================================================================
  // convertToChatHistoryRecord
  // =========================================================================

  describe("convertToChatHistoryRecord", () => {
    it("should map all basic fields correctly", () => {
      const now = new Date("2025-06-01T10:00:00Z");
      const prismaChat = createMockChatPrisma({
        id: "chat-123",
        userId: "user-abc",
        pagePath: "/holdings",
        pageName: "Holdings",
        createdAt: now,
        updatedAt: now,
        lastMessageAt: now,
      });

      const record = convertToChatHistoryRecord(prismaChat);

      assert.strictEqual(record.id, "chat-123");
      assert.strictEqual(record.userId, "user-abc");
      assert.strictEqual(record.pagePath, "/holdings");
      assert.strictEqual(record.pageName, "Holdings");
      assert.strictEqual(record.createdAt, now);
      assert.strictEqual(record.updatedAt, now);
      assert.strictEqual(record.lastMessageAt, now);
    });

    it("should convert null pageIcon to undefined", () => {
      const prismaChat = createMockChatPrisma({ pageIcon: null });
      const record = convertToChatHistoryRecord(prismaChat);
      assert.strictEqual(record.pageIcon, undefined);
    });

    it("should preserve non-null pageIcon", () => {
      const prismaChat = createMockChatPrisma({ pageIcon: "chart-icon" });
      const record = convertToChatHistoryRecord(prismaChat);
      assert.strictEqual(record.pageIcon, "chart-icon");
    });

    it("should convert empty string pageIcon to undefined (falsy)", () => {
      const prismaChat = createMockChatPrisma({ pageIcon: "" });
      const record = convertToChatHistoryRecord(prismaChat);
      assert.strictEqual(record.pageIcon, undefined);
    });

    it("should convert JSON messages array to ChatMessage[]", () => {
      const messages: ChatMessage[] = [
        { role: "user", content: "Hello" },
        { role: "assistant", content: "Hi there" },
      ];
      const prismaChat = createMockChatPrisma({
        messages: messages as unknown,
      });

      const record = convertToChatHistoryRecord(prismaChat);
      assert.strictEqual(record.messages.length, 2);
      assert.strictEqual(record.messages[0]!.role, "user");
      assert.strictEqual(record.messages[0]!.content, "Hello");
      assert.strictEqual(record.messages[1]!.role, "assistant");
    });

    it("should handle null messages by defaulting to empty array", () => {
      const prismaChat = createMockChatPrisma({ messages: null });
      const record = convertToChatHistoryRecord(prismaChat);
      assert.deepStrictEqual(record.messages, []);
    });

    it("should handle empty messages array", () => {
      const prismaChat = createMockChatPrisma({ messages: [] });
      const record = convertToChatHistoryRecord(prismaChat);
      assert.deepStrictEqual(record.messages, []);
    });

    it("should preserve isArchived: false", () => {
      const prismaChat = createMockChatPrisma({ isArchived: false });
      const record = convertToChatHistoryRecord(prismaChat);
      assert.strictEqual(record.isArchived, false);
    });

    it("should preserve isArchived: true", () => {
      const prismaChat = createMockChatPrisma({ isArchived: true });
      const record = convertToChatHistoryRecord(prismaChat);
      assert.strictEqual(record.isArchived, true);
    });

    it("should handle messages with timestamps", () => {
      const messages: ChatMessage[] = [
        { role: "user", content: "Test", timestamp: "2025-06-01T10:00:00Z" },
      ];
      const prismaChat = createMockChatPrisma({
        messages: messages as unknown,
      });

      const record = convertToChatHistoryRecord(prismaChat);
      assert.strictEqual(record.messages[0]!.timestamp, "2025-06-01T10:00:00Z");
    });

    it("should handle messages with system role", () => {
      const messages: ChatMessage[] = [
        { role: "system", content: "System prompt" },
      ];
      const prismaChat = createMockChatPrisma({
        messages: messages as unknown,
      });

      const record = convertToChatHistoryRecord(prismaChat);
      assert.strictEqual(record.messages[0]!.role, "system");
    });
  });

  // =========================================================================
  // Search / Filter Logic
  // =========================================================================

  describe("filterBySearchQuery", () => {
    it("should return all chats when search query is empty", () => {
      const chats = [
        createMockChatRecord({ pageName: "Dashboard" }),
        createMockChatRecord({ pageName: "Holdings" }),
      ];
      const result = filterBySearchQuery(chats, "");
      assert.strictEqual(result.length, 2);
    });

    it("should return all chats when search query is undefined", () => {
      const chats = [createMockChatRecord(), createMockChatRecord()];
      const result = filterBySearchQuery(chats, undefined);
      assert.strictEqual(result.length, 2);
    });

    it("should return all chats when search query is whitespace", () => {
      const chats = [createMockChatRecord()];
      const result = filterBySearchQuery(chats, "   ");
      assert.strictEqual(result.length, 1);
    });

    it("should filter by pageName (case insensitive)", () => {
      const chats = [
        createMockChatRecord({
          pageName: "Dashboard Analytics",
          pagePath: "/analysis",
        }),
        createMockChatRecord({
          pageName: "Holdings View",
          pagePath: "/holdings",
        }),
        createMockChatRecord({
          pageName: "Trade Book",
          pagePath: "/tradebook",
        }),
      ];
      const result = filterBySearchQuery(chats, "dashboard");
      assert.strictEqual(result.length, 1);
      assert.strictEqual(result[0]!.pageName, "Dashboard Analytics");
    });

    it("should filter by pagePath (case insensitive)", () => {
      const chats = [
        createMockChatRecord({ pagePath: "/dashboard", pageName: "Dash" }),
        createMockChatRecord({ pagePath: "/holdings", pageName: "Hold" }),
      ];
      const result = filterBySearchQuery(chats, "/dashboard");
      assert.strictEqual(result.length, 1);
    });

    it("should filter by message content", () => {
      const chats = [
        createMockChatRecord({
          pageName: "Dashboard",
          messages: [
            createMockMessage({ content: "What is my portfolio value?" }),
            createMockMessage({
              role: "assistant",
              content: "Your portfolio is worth 10L",
            }),
          ],
        }),
        createMockChatRecord({
          pageName: "Holdings",
          messages: [
            createMockMessage({ content: "Show me my RELIANCE holding" }),
          ],
        }),
      ];

      const result = filterBySearchQuery(chats, "portfolio");
      assert.strictEqual(result.length, 1);
      assert.strictEqual(result[0]!.pageName, "Dashboard");
    });

    it("should match message content case insensitively", () => {
      const chats = [
        createMockChatRecord({
          pageName: "AI Chat",
          messages: [
            createMockMessage({ content: "What about RELIANCE stock?" }),
          ],
        }),
      ];

      const result = filterBySearchQuery(chats, "reliance");
      assert.strictEqual(result.length, 1);
    });

    it("should return empty array when no matches found", () => {
      const chats = [
        createMockChatRecord({
          pageName: "Dashboard",
          pagePath: "/dashboard",
          messages: [createMockMessage({ content: "Hello" })],
        }),
      ];

      const result = filterBySearchQuery(chats, "nonexistent");
      assert.strictEqual(result.length, 0);
    });

    it("should match partial pageName", () => {
      const chats = [createMockChatRecord({ pageName: "FIRE Calculator" })];
      const result = filterBySearchQuery(chats, "fire");
      assert.strictEqual(result.length, 1);
    });

    it("should match partial pagePath", () => {
      const chats = [createMockChatRecord({ pagePath: "/fire/scenario-1" })];
      const result = filterBySearchQuery(chats, "scenario");
      assert.strictEqual(result.length, 1);
    });

    it("should match on any message in the chat (not just first)", () => {
      const chats = [
        createMockChatRecord({
          pageName: "Chat",
          messages: [
            createMockMessage({ content: "Hello" }),
            createMockMessage({ content: "What about mutual funds?" }),
            createMockMessage({
              role: "assistant",
              content: "Here are your funds",
            }),
          ],
        }),
      ];

      const result = filterBySearchQuery(chats, "mutual");
      assert.strictEqual(result.length, 1);
    });

    it("should handle chats with empty messages array", () => {
      const chats = [
        createMockChatRecord({ pageName: "Empty Chat", messages: [] }),
      ];
      const result = filterBySearchQuery(chats, "hello");
      assert.strictEqual(result.length, 0);
    });

    it("should handle messages with empty content", () => {
      const chats = [
        createMockChatRecord({
          pageName: "Chat",
          messages: [createMockMessage({ content: "" })],
        }),
      ];
      const result = filterBySearchQuery(chats, "hello");
      assert.strictEqual(result.length, 0);
    });

    it("should trim search query before matching", () => {
      const chats = [createMockChatRecord({ pageName: "Dashboard" })];
      const result = filterBySearchQuery(chats, "  dashboard  ");
      assert.strictEqual(result.length, 1);
    });

    it("should match on pageName OR pagePath OR message content (any one)", () => {
      const chatByName = createMockChatRecord({
        pageName: "Portfolio Analysis",
        pagePath: "/other",
        messages: [],
      });
      const chatByPath = createMockChatRecord({
        pageName: "Other",
        pagePath: "/portfolio",
        messages: [],
      });
      const chatByMessage = createMockChatRecord({
        pageName: "Chat",
        pagePath: "/chat",
        messages: [createMockMessage({ content: "My portfolio is great" })],
      });
      const chatNoMatch = createMockChatRecord({
        pageName: "Settings",
        pagePath: "/settings",
        messages: [createMockMessage({ content: "Theme: dark" })],
      });

      const chats = [chatByName, chatByPath, chatByMessage, chatNoMatch];
      const result = filterBySearchQuery(chats, "portfolio");
      assert.strictEqual(result.length, 3);
    });
  });

  // =========================================================================
  // Where Clause Building
  // =========================================================================

  describe("buildListWhereClause", () => {
    it("should include only userId when no filters provided", () => {
      const where = buildListWhereClause("user-1", {});
      assert.deepStrictEqual(where, { userId: "user-1" });
    });

    it("should add pagePath filter", () => {
      const where = buildListWhereClause("user-1", {
        pagePath: "/dashboard",
      });
      assert.strictEqual(where.pagePath, "/dashboard");
    });

    it("should add isArchived filter when true", () => {
      const where = buildListWhereClause("user-1", { isArchived: true });
      assert.strictEqual(where.isArchived, true);
    });

    it("should add isArchived filter when false", () => {
      const where = buildListWhereClause("user-1", { isArchived: false });
      assert.strictEqual(where.isArchived, false);
    });

    it("should not add isArchived when undefined", () => {
      const where = buildListWhereClause("user-1", {});
      assert.strictEqual(where.isArchived, undefined);
    });

    it("should combine pagePath and isArchived filters", () => {
      const where = buildListWhereClause("user-1", {
        pagePath: "/fire",
        isArchived: false,
      });
      assert.strictEqual(where.userId, "user-1");
      assert.strictEqual(where.pagePath, "/fire");
      assert.strictEqual(where.isArchived, false);
    });
  });

  // =========================================================================
  // Sort Order Building
  // =========================================================================

  describe("buildSortOrder", () => {
    it("should default to lastMessageAt desc", () => {
      const order = buildSortOrder();
      assert.deepStrictEqual(order, { lastMessageAt: "desc" });
    });

    it("should sort by lastMessageAt when sortBy is lastMessage", () => {
      const order = buildSortOrder("lastMessage", "desc");
      assert.deepStrictEqual(order, { lastMessageAt: "desc" });
    });

    it("should sort by createdAt when sortBy is date", () => {
      const order = buildSortOrder("date", "desc");
      assert.deepStrictEqual(order, { createdAt: "desc" });
    });

    it("should support ascending order for lastMessage", () => {
      const order = buildSortOrder("lastMessage", "asc");
      assert.deepStrictEqual(order, { lastMessageAt: "asc" });
    });

    it("should support ascending order for date", () => {
      const order = buildSortOrder("date", "asc");
      assert.deepStrictEqual(order, { createdAt: "asc" });
    });
  });

  // =========================================================================
  // Message Counting
  // =========================================================================

  describe("countMessages", () => {
    it("should count messages in a chat", () => {
      const chat = createMockChatRecord({
        messages: [
          createMockMessage({ content: "Hello" }),
          createMockMessage({ role: "assistant", content: "Hi" }),
          createMockMessage({ content: "Thanks" }),
        ],
      });
      assert.strictEqual(countMessages(chat), 3);
    });

    it("should return 0 for empty messages", () => {
      const chat = createMockChatRecord({ messages: [] });
      assert.strictEqual(countMessages(chat), 0);
    });

    it("should return 1 for single message", () => {
      const chat = createMockChatRecord({
        messages: [createMockMessage()],
      });
      assert.strictEqual(countMessages(chat), 1);
    });

    it("should handle large message counts", () => {
      const messages = Array.from({ length: 100 }, (_, i) =>
        createMockMessage({ content: `Message ${i}` })
      );
      const chat = createMockChatRecord({ messages });
      assert.strictEqual(countMessages(chat), 100);
    });
  });

  // =========================================================================
  // Scenario Name
  // =========================================================================

  describe("generateChatName", () => {
    it("should return pageName when no scenarioName", () => {
      assert.strictEqual(
        generateChatName("FIRE Calculator"),
        "FIRE Calculator"
      );
    });

    it("should append scenario name with dash separator", () => {
      assert.strictEqual(
        generateChatName("FIRE Calculator", "Aggressive"),
        "FIRE Calculator - Aggressive"
      );
    });

    it("should return pageName when scenarioName is undefined", () => {
      assert.strictEqual(generateChatName("Dashboard", undefined), "Dashboard");
    });

    it("should handle empty pageName with scenario", () => {
      assert.strictEqual(generateChatName("", "Scenario"), " - Scenario");
    });

    it("should handle scenario with special characters", () => {
      assert.strictEqual(
        generateChatName("FIRE", "10L/year @ 8%"),
        "FIRE - 10L/year @ 8%"
      );
    });
  });

  // =========================================================================
  // getChatHistoryByPage Where Clause
  // =========================================================================

  describe("buildPageWhereClause", () => {
    it("should include isArchived: false when not including archived", () => {
      const where = buildPageWhereClause("user-1", "/dashboard", false);
      assert.strictEqual(where.isArchived, false);
    });

    it("should not include isArchived when including archived", () => {
      const where = buildPageWhereClause("user-1", "/dashboard", true);
      assert.strictEqual(where.isArchived, undefined);
    });

    it("should always include userId and pagePath", () => {
      const where = buildPageWhereClause("user-1", "/fire", true);
      assert.strictEqual(where.userId, "user-1");
      assert.strictEqual(where.pagePath, "/fire");
    });
  });

  // =========================================================================
  // Integration-style: Full List Filtering Simulation
  // =========================================================================

  describe("Full list filtering simulation", () => {
    const allChats = [
      createMockChatRecord({
        id: "chat-1",
        pageName: "Dashboard",
        pagePath: "/dashboard",
        isArchived: false,
        messages: [createMockMessage({ content: "Show my portfolio summary" })],
        lastMessageAt: new Date("2025-06-10T10:00:00Z"),
        createdAt: new Date("2025-06-01T10:00:00Z"),
      }),
      createMockChatRecord({
        id: "chat-2",
        pageName: "FIRE Calculator - Aggressive",
        pagePath: "/fire",
        isArchived: false,
        messages: [createMockMessage({ content: "Calculate my FIRE number" })],
        lastMessageAt: new Date("2025-06-09T10:00:00Z"),
        createdAt: new Date("2025-06-05T10:00:00Z"),
      }),
      createMockChatRecord({
        id: "chat-3",
        pageName: "Holdings Analysis",
        pagePath: "/holdings",
        isArchived: true,
        messages: [
          createMockMessage({ content: "Analyze my RELIANCE holding" }),
          createMockMessage({
            role: "assistant",
            content: "RELIANCE is up 10%",
          }),
        ],
        lastMessageAt: new Date("2025-06-08T10:00:00Z"),
        createdAt: new Date("2025-06-03T10:00:00Z"),
      }),
      createMockChatRecord({
        id: "chat-4",
        pageName: "Dashboard",
        pagePath: "/dashboard",
        isArchived: false,
        messages: [createMockMessage({ content: "What is my P&L?" })],
        lastMessageAt: new Date("2025-06-11T10:00:00Z"),
        createdAt: new Date("2025-06-08T10:00:00Z"),
      }),
    ];

    it("should filter non-archived chats", () => {
      const filtered = allChats.filter((c) => !c.isArchived);
      assert.strictEqual(filtered.length, 3);
    });

    it("should filter by pagePath", () => {
      const filtered = allChats.filter((c) => c.pagePath === "/dashboard");
      assert.strictEqual(filtered.length, 2);
    });

    it("should combine pagePath and archived filter", () => {
      const filtered = allChats.filter(
        (c) => c.pagePath === "/dashboard" && !c.isArchived
      );
      assert.strictEqual(filtered.length, 2);
    });

    it("should apply search query on top of filters", () => {
      const nonArchived = allChats.filter((c) => !c.isArchived);
      const result = filterBySearchQuery(nonArchived, "portfolio");
      assert.strictEqual(result.length, 1);
      assert.strictEqual(result[0]!.id, "chat-1");
    });

    it("should search by message content across all chats", () => {
      const result = filterBySearchQuery(allChats, "RELIANCE");
      assert.strictEqual(result.length, 1);
      assert.strictEqual(result[0]!.id, "chat-3");
    });

    it("should search by assistant message content", () => {
      const result = filterBySearchQuery(allChats, "up 10%");
      assert.strictEqual(result.length, 1);
      assert.strictEqual(result[0]!.id, "chat-3");
    });

    it("should sort by lastMessageAt desc", () => {
      const sorted = [...allChats].sort(
        (a, b) =>
          new Date(b.lastMessageAt).getTime() -
          new Date(a.lastMessageAt).getTime()
      );
      assert.strictEqual(sorted[0]!.id, "chat-4");
      assert.strictEqual(sorted[1]!.id, "chat-1");
    });

    it("should sort by createdAt desc", () => {
      const sorted = [...allChats].sort(
        (a, b) =>
          new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
      );
      assert.strictEqual(sorted[0]!.id, "chat-4");
    });

    it("should limit results", () => {
      const limited = allChats.slice(0, 2);
      assert.strictEqual(limited.length, 2);
    });

    it("should apply limit after sorting", () => {
      const sorted = [...allChats].sort(
        (a, b) =>
          new Date(b.lastMessageAt).getTime() -
          new Date(a.lastMessageAt).getTime()
      );
      const limited = sorted.slice(0, 1);
      assert.strictEqual(limited.length, 1);
      assert.strictEqual(limited[0]!.id, "chat-4");
    });

    it("should handle empty result from filter + search combo", () => {
      const fireChats = allChats.filter((c) => c.pagePath === "/fire");
      const result = filterBySearchQuery(fireChats, "portfolio");
      assert.strictEqual(result.length, 0);
    });

    it("should find FIRE scenario chats by scenario name", () => {
      const result = filterBySearchQuery(allChats, "Aggressive");
      assert.strictEqual(result.length, 1);
      assert.strictEqual(result[0]!.id, "chat-2");
    });
  });

  // =========================================================================
  // Edge Cases
  // =========================================================================

  describe("Edge cases", () => {
    it("should handle chat with very long message content", () => {
      const longContent = "a".repeat(10000);
      const chat = createMockChatRecord({
        messages: [createMockMessage({ content: longContent })],
      });
      assert.strictEqual(countMessages(chat), 1);

      const result = filterBySearchQuery([chat], "aaa");
      assert.strictEqual(result.length, 1);
    });

    it("should handle special regex characters in search query", () => {
      const chats = [
        createMockChatRecord({
          pageName: "P&L Report",
        }),
      ];
      // & and special chars should be treated literally
      const result = filterBySearchQuery(chats, "P&L");
      assert.strictEqual(result.length, 1);
    });

    it("should handle unicode in search query", () => {
      const chats = [
        createMockChatRecord({
          pageName: "Portfolio value is 10 lakh",
          messages: [createMockMessage({ content: "Value is 10L" })],
        }),
      ];
      const result = filterBySearchQuery(chats, "lakh");
      assert.strictEqual(result.length, 1);
    });

    it("should handle chat record with many messages", () => {
      const messages = Array.from({ length: 500 }, (_, i) =>
        createMockMessage({
          role: i % 2 === 0 ? "user" : "assistant",
          content: `Message number ${i}`,
        })
      );
      const chat = createMockChatRecord({ messages });
      assert.strictEqual(countMessages(chat), 500);
    });

    it("should handle conversion of chat with all optional fields as null/empty", () => {
      const prismaChat = createMockChatPrisma({
        pageIcon: null,
        messages: null,
      });
      const record = convertToChatHistoryRecord(prismaChat);
      assert.strictEqual(record.pageIcon, undefined);
      assert.deepStrictEqual(record.messages, []);
    });
  });
});
