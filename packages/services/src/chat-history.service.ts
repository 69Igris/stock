/**
 * Chat History Service
 *
 * Handles AI chat history persistence: save, list, archive, and delete.
 * Source: apps/web/lib/actions/chat-history.ts + apps/web/lib/db/chat-history.ts
 */

import { prisma, Prisma } from "@usemoney/database";
import { clearChatCache, getCached, setCached } from "@usemoney/core";
import { dbLogger as logger } from "@usemoney/logger";
import type { ChatMessage } from "@usemoney/types";
import type { ServiceResult } from "./types";
import {
  clampChatPagination,
  deriveChatPreview,
  deriveChatTitle,
  paginateChatList,
  safeMessageArray,
  summarizeChatMessages,
  type ChatMessageSummary,
} from "./chat-history-logic";

// Above this row count, skip Redis caching for the list.
// Power users with huge histories fall back to direct paginated reads -
// no regression for them, no Redis bloat.
const CACHE_LIST_CAP = 500;

// ── Types ──────────────────────────────────────────────────────────

export interface ChatHistoryRecord {
  id: string;
  userId: string;
  pagePath: string;
  pageName: string;
  pageIcon?: string;
  customTitle?: string | null;
  messages: ChatMessage[];
  /**
   * MONEY-1245 — raw Gemini turns (functionCall / functionResponse) for the
   * tool-driven side chats, Ask FIRE and Ask Screener. Deliberately separate
   * from `messages`, which holds the display shape /chat-history renders.
   *
   * ABSENT on every pre-existing row (a Mongo `db push` creates indexes, not
   * fields) and on every StockSage chat, which has no tool loop. Treat missing
   * as "no tool context" and NEVER filter on it.
   */
  toolConversation?: unknown;
  isArchived: boolean;
  createdAt: Date;
  updatedAt: Date;
  lastMessageAt: Date;
  /**
   * Derived, bounded single-line title (custom title wins, else first user
   * message). Optional so existing literal-shaped consumers (demo data) stay
   * assignable; populated by `convertToChatHistoryRecord` for DB-backed rows.
   * @see chat-history-logic.deriveChatTitle
   */
  title?: string;
  /** Derived, bounded preview snippet from the first user message. */
  preview?: string;
  /** Defensive `{ total, user, assistant }` message counts. */
  messageSummary?: ChatMessageSummary;
}

export interface PaginatedChatHistories {
  chats: ChatHistoryRecord[];
  totalCount: number;
}

export interface ListChatHistoriesOptions {
  pagePath?: string;
  /**
   * MONEY-1255 — page paths to EXCLUDE.
   *
   * StockSage's history sidebar listed every chat, which was correct while it
   * was the only writer. MONEY-1245 gave Ask FIRE and Ask Screener their own
   * saved chats on the same table, and they began appearing in StockSage's
   * history. Nothing about that sidebar changed — its meaning did, because the
   * table stopped being single-tenant.
   *
   * An exclusion rather than an allowlist: StockSage is embedded across many
   * routes (dashboard, holdings, stock pages), so listing the ones it runs on
   * would silently drop a chat from history the moment a new surface embeds
   * it. Naming the two side chats fails loudly instead — a new side chat shows
   * up until it is added here.
   */
  excludePagePaths?: readonly string[];
  isArchived?: boolean;
  sortBy?: "date" | "lastMessage";
  order?: "asc" | "desc";
  limit?: number;
  skip?: number;
  searchQuery?: string;
}

// ── Helpers ────────────────────────────────────────────────────────

type ChatHistoryPrisma = Prisma.ChatHistoryGetPayload<object>;

function convertToChatHistoryRecord(
  chat: ChatHistoryPrisma,
): ChatHistoryRecord {
  // Narrow the untyped JSON `messages` blob defensively (a corrupt/legacy row
  // could be a non-array) BEFORE deriving, so the derivations never see garbage.
  const messages = safeMessageArray(chat.messages);
  return {
    ...chat,
    pageIcon: chat.pageIcon || undefined,
    messages,
    // Derived fields share the SAME exported logic the tests assert, so the
    // production list/get paths and the unit tests execute identical code.
    title: deriveChatTitle({ customTitle: chat.customTitle, messages }),
    preview: deriveChatPreview(messages),
    messageSummary: summarizeChatMessages(messages),
  };
}

// ── Service Functions ──────────────────────────────────────────────

/**
 * Save or update chat history for a user on a specific page.
 * If chatId is provided, updates that chat (continuation). Otherwise creates a new chat.
 */
export async function saveChatHistory(
  userId: string,
  pagePath: string,
  pageName: string,
  pageIcon: string | undefined,
  messages: ChatMessage[],
  chatId?: string,
  scenarioName?: string,
  /**
   * MONEY-1245 — raw Gemini turns for the tool-driven side chats. Optional:
   * StockSage passes nothing and its rows keep the field absent, which is the
   * correct representation of "this chat has no tool loop".
   */
  toolConversation?: unknown,
): Promise<ServiceResult<{ chatId: string }>> {
  try {
    // Filter out initial welcome messages (only save if there are actual user messages)
    const userMessages = messages.filter((m) => m.role === "user");
    if (userMessages.length === 0) {
      return { success: true, data: { chatId: chatId || "" } };
    }

    if (chatId) {
      // Update existing chat (continuation from chat history). IDOR-safe:
      // scope the write to {id, userId} via updateMany so a client-supplied
      // chatId can NEVER overwrite another user's chat (the row owner is the
      // only one whose chat this update can touch).
      const result = await prisma.chatHistory.updateMany({
        where: { id: chatId, userId },
        data: {
          messages: messages as unknown as Prisma.InputJsonValue[],
          lastMessageAt: new Date(),
          updatedAt: new Date(),
          // Update pageName with scenario name if provided (for FIRE)
          ...(scenarioName
            ? { pageName: `${pageName} - ${scenarioName}` }
            : {}),
          // MONEY-1245: only write when the caller supplied one. Spreading
          // `undefined` would be a no-op anyway, but being explicit keeps a
          // StockSage save from ever touching the column.
          ...(toolConversation !== undefined
            ? {
                toolConversation: toolConversation as Prisma.InputJsonValue,
              }
            : {}),
        },
      });

      if (result.count === 0) {
        return { success: false, error: "Chat history not found" };
      }

      await clearChatCache(userId);
      return { success: true, data: { chatId } };
    } else {
      // Always create new chat for each session
      const chatName = scenarioName
        ? `${pageName} - ${scenarioName}`
        : pageName;

      const created = await prisma.chatHistory.create({
        data: {
          userId,
          pagePath,
          pageName: chatName,
          pageIcon,
          messages: messages as unknown as Prisma.InputJsonValue[],
          lastMessageAt: new Date(),
          ...(toolConversation !== undefined
            ? {
                toolConversation: toolConversation as Prisma.InputJsonValue,
              }
            : {}),
        },
      });

      await clearChatCache(userId);
      return { success: true, data: { chatId: created.id } };
    }
  } catch (error) {
    logger.error(
      { error, userId, pagePath },
      "Save chat history service error",
    );
    return { success: false, error: "Failed to save chat history" };
  }
}

/**
 * Get the most recent chat history for a specific page
 */
export async function getChatHistoryByPage(
  userId: string,
  pagePath: string,
  includeArchived = false,
): Promise<ServiceResult<ChatHistoryRecord | null>> {
  try {
    const chat = await prisma.chatHistory.findFirst({
      where: {
        userId,
        pagePath,
        ...(includeArchived ? {} : { isArchived: false }),
      },
      orderBy: {
        lastMessageAt: "desc",
      },
    });

    const data = chat ? convertToChatHistoryRecord(chat) : null;
    return { success: true, data };
  } catch (error) {
    logger.error(
      { error, userId, pagePath },
      "Get chat history by page service error",
    );
    return { success: false, error: "Failed to get chat history" };
  }
}

/**
 * Filters that compose the cache key for the list.
 * Pagination + searchQuery are applied AFTER cache read, not part of the key.
 */
type ListCacheFilters = {
  pagePath?: string;
  /** Part of the cache KEY: two scopes must never share one cached list. */
  excludePagePaths?: readonly string[];
  isArchived?: boolean;
  sortBy: "date" | "lastMessage";
  order: "asc" | "desc";
};

/**
 * Fetch the full sorted chat list for a user (no pagination, no search).
 * Cached in memory + Redis under the `chat` namespace; invalidated by
 * `clearChatCache(userId)` on every mutation in this file.
 */
async function fetchAllChatsForList(
  userId: string,
  filters: ListCacheFilters,
): Promise<{ chats: ChatHistoryRecord[]; totalCount: number } | null> {
  const cached = await getCached<{
    chats: ChatHistoryRecord[];
    totalCount: number;
  }>("chat", userId, "list", filters);

  if (cached) {
    // Dates were serialized to ISO strings; rehydrate.
    const rehydrated = cached.chats.map((c) => ({
      ...c,
      createdAt: new Date(c.createdAt),
      updatedAt: new Date(c.updatedAt),
      lastMessageAt: new Date(c.lastMessageAt),
    }));
    return { chats: rehydrated, totalCount: cached.totalCount };
  }

  const where: Prisma.ChatHistoryWhereInput = { userId };
  if (filters.pagePath) where.pagePath = filters.pagePath;
  // Applied in the QUERY, not after pagination: filtering a fetched page would
  // return short pages and make `totalCount` disagree with what is shown.
  else if (filters.excludePagePaths && filters.excludePagePaths.length > 0) {
    where.pagePath = { notIn: [...filters.excludePagePaths] };
  }
  if (filters.isArchived !== undefined) where.isArchived = filters.isArchived;

  const orderBy: Prisma.ChatHistoryOrderByWithRelationInput =
    filters.sortBy === "date"
      ? { createdAt: filters.order }
      : { lastMessageAt: filters.order };

  const totalCount = await prisma.chatHistory.count({ where });
  if (totalCount > CACHE_LIST_CAP) {
    // Don't cache; signal caller to take the direct paginated path.
    return null;
  }

  const rows = await prisma.chatHistory.findMany({ where, orderBy });
  const chats = rows.map(convertToChatHistoryRecord);

  await setCached("chat", userId, "list", { chats, totalCount }, filters);
  return { chats, totalCount };
}

/**
 * List all chat histories for a user with filters, search, and pagination.
 *
 * Cache strategy:
 * - Cached path (most users): reads full sorted list from Redis/memory,
 *   then applies skip/limit/searchQuery in-process. Search piggybacks on
 *   the same cache entry.
 * - Direct path (>500 chats): falls back to current Prisma skip/take
 *   behavior with no caching.
 */
export async function listChatHistories(
  userId: string,
  options: ListChatHistoriesOptions = {},
): Promise<ServiceResult<PaginatedChatHistories>> {
  try {
    const {
      pagePath,
      excludePagePaths,
      isArchived,
      sortBy = "lastMessage",
      order = "desc",
      limit,
      skip,
      searchQuery,
    } = options;

    // excludePagePaths is part of the cache KEY, not just the query: two
    // callers with different scopes must never be served each other's list.
    const filters: ListCacheFilters = {
      pagePath,
      excludePagePaths,
      isArchived,
      sortBy,
      order,
    };
    const cached = await fetchAllChatsForList(userId, filters);

    if (cached) {
      const trimmed = searchQuery?.trim();
      const filteredChats = !trimmed
        ? cached.chats
        : cached.chats.filter((chat) => {
            if (
              chat.pageName.toLowerCase().includes(trimmed.toLowerCase()) ||
              chat.pagePath.toLowerCase().includes(trimmed.toLowerCase())
            ) {
              return true;
            }
            if (Array.isArray(chat.messages)) {
              return chat.messages.some((msg) =>
                (msg.content || "")
                  .toLowerCase()
                  .includes(trimmed.toLowerCase()),
              );
            }
            return false;
          });

      const totalCount = trimmed ? filteredChats.length : cached.totalCount;
      // Clamp untrusted skip/limit so a stray NaN/negative/huge value can't slice
      // to an empty/wrong page (mirrors notifications' clampPagination).
      const paginatedChats = paginateChatList(
        filteredChats,
        clampChatPagination(limit, skip),
      );

      return { success: true, data: { chats: paginatedChats, totalCount } };
    }

    // Direct path: too many chats to cache. Preserves prior behavior.
    const where: Prisma.ChatHistoryWhereInput = { userId };
    if (pagePath) where.pagePath = pagePath;
    // MONEY-1255: the exclusion has to be applied on BOTH paths. Omitting it
    // here would leak the side chats for users with >500 chats — the ones who
    // fall past CACHE_LIST_CAP — which is the hardest case to notice and the
    // one most likely to have them.
    else if (excludePagePaths && excludePagePaths.length > 0) {
      where.pagePath = { notIn: [...excludePagePaths] };
    }
    if (isArchived !== undefined) where.isArchived = isArchived;

    const orderBy: Prisma.ChatHistoryOrderByWithRelationInput =
      sortBy === "date" ? { createdAt: order } : { lastMessageAt: order };

    const useServerPagination = !searchQuery?.trim();

    // Clamp BEFORE the values reach Prisma. An un-clamped NaN/negative/non-int
    // `skip`/`take` makes Prisma 5 throw `Invalid value … Expected Int`, which
    // the outer catch turns into a silently-empty list for a real power user.
    const bounds = clampChatPagination(limit, skip);

    const chats = await prisma.chatHistory.findMany({
      where,
      orderBy,
      ...(useServerPagination ? { skip: bounds.skip } : {}),
      ...(useServerPagination && bounds.take !== undefined
        ? { take: bounds.take }
        : {}),
    });

    const convertedChats = chats.map(convertToChatHistoryRecord);

    if (useServerPagination) {
      const totalCount = await prisma.chatHistory.count({ where });
      return { success: true, data: { chats: convertedChats, totalCount } };
    }

    const trimmed = searchQuery!.trim().toLowerCase();
    const filteredChats = convertedChats.filter((chat) => {
      if (
        chat.pageName.toLowerCase().includes(trimmed) ||
        chat.pagePath.toLowerCase().includes(trimmed)
      ) {
        return true;
      }
      if (Array.isArray(chat.messages)) {
        return chat.messages.some((msg) =>
          (msg.content || "").toLowerCase().includes(trimmed),
        );
      }
      return false;
    });

    const totalCount = filteredChats.length;
    // In-memory search results are paginated with the same clamped bounds.
    const paginatedChats = paginateChatList(filteredChats, bounds);

    return { success: true, data: { chats: paginatedChats, totalCount } };
  } catch (error) {
    logger.error({ error, userId }, "List chat histories service error");
    return { success: true, data: { chats: [], totalCount: 0 } };
  }
}

/**
 * Get a chat history by ID (verifies ownership via userId)
 */
export async function getChatHistoryById(
  userId: string,
  chatId: string,
): Promise<ServiceResult<ChatHistoryRecord | null>> {
  try {
    const chat = await prisma.chatHistory.findFirst({
      where: {
        id: chatId,
        userId,
      },
    });

    const data = chat ? convertToChatHistoryRecord(chat) : null;
    return { success: true, data };
  } catch (error) {
    logger.error(
      { error, userId, chatId },
      "Get chat history by ID service error",
    );
    return { success: false, error: "Failed to get chat history" };
  }
}

/**
 * Soft-archive a chat history
 */
export async function archiveChatHistory(
  userId: string,
  chatId: string,
): Promise<ServiceResult<void>> {
  try {
    const result = await prisma.chatHistory.updateMany({
      where: {
        id: chatId,
        userId,
      },
      data: {
        isArchived: true,
        updatedAt: new Date(),
      },
    });

    if (result.count === 0) {
      return { success: false, error: "Chat history not found" };
    }

    await clearChatCache(userId);
    return { success: true, data: undefined };
  } catch (error) {
    logger.error(
      { error, userId, chatId },
      "Archive chat history service error",
    );
    // MONEY-1062 (Round C / C2#6): code so routes map a DB blip to 500, not 404.
    return {
      success: false,
      error: "Failed to archive chat history",
      code: "INTERNAL",
    };
  }
}

/**
 * Unarchive a chat history
 */
export async function unarchiveChatHistory(
  userId: string,
  chatId: string,
): Promise<ServiceResult<void>> {
  try {
    const result = await prisma.chatHistory.updateMany({
      where: {
        id: chatId,
        userId,
      },
      data: {
        isArchived: false,
        updatedAt: new Date(),
      },
    });

    if (result.count === 0) {
      return { success: false, error: "Chat history not found" };
    }

    await clearChatCache(userId);
    return { success: true, data: undefined };
  } catch (error) {
    logger.error(
      { error, userId, chatId },
      "Unarchive chat history service error",
    );
    // MONEY-1062 (Round C / C2#6): code so routes map a DB blip to 500, not 404.
    return {
      success: false,
      error: "Failed to unarchive chat history",
      code: "INTERNAL",
    };
  }
}

/**
 * Hard-delete a chat history
 */
export async function deleteChatHistory(
  userId: string,
  chatId: string,
): Promise<ServiceResult<void>> {
  try {
    const result = await prisma.chatHistory.deleteMany({
      where: {
        id: chatId,
        userId,
      },
    });

    if (result.count === 0) {
      return { success: false, error: "Chat history not found" };
    }

    await clearChatCache(userId);
    return { success: true, data: undefined };
  } catch (error) {
    logger.error(
      { error, userId, chatId },
      "Delete chat history service error",
    );
    // MONEY-1062 (Round C / C2#6): code so routes map a DB blip to 500, not 404.
    return {
      success: false,
      error: "Failed to delete chat history",
      code: "INTERNAL",
    };
  }
}

/**
 * Rename a chat history - set a custom user-defined title.
 * Pass null/empty to clear the custom title (reverts to auto-generated).
 */
export async function renameChatHistory(
  userId: string,
  chatId: string,
  title: string | null,
): Promise<ServiceResult<void>> {
  try {
    const cleanTitle = title?.trim() || null;

    const result = await prisma.chatHistory.updateMany({
      where: {
        id: chatId,
        userId,
      },
      data: {
        customTitle: cleanTitle,
      },
    });

    if (result.count === 0) {
      return {
        success: false,
        error: "Chat history not found",
        code: "NOT_FOUND",
      };
    }

    await clearChatCache(userId);
    return { success: true, data: undefined };
  } catch (error) {
    logger.error(
      { error, userId, chatId },
      "Rename chat history service error",
    );
    // MONEY-1062 (Round C / C2#6): code so routes map a DB blip to 500, not 404.
    return { success: false, error: "Failed to rename chat", code: "INTERNAL" };
  }
}
