import { prisma } from "@/lib/prisma";
import { ChatMessage } from "@usemoney/types";
import { Prisma } from "@prisma/client";
import { dbLogger as logger } from "@usemoney/logger";
import { getChatHistoryById as getChatHistoryByIdService } from "@usemoney/services";
import { invalidateContextCache } from "@/lib/gemini/conversation";
import {
  type ChatHistoryRecord,
  convertToChatHistoryRecord,
  chatMatchesSearch,
  paginateChats,
} from "./chat-history-logic";

export type { ChatHistoryRecord };

/**
 * Save or update chat history for a user on a specific page
 * @param chatId - If provided, update this specific chat (continuation). If not, create new chat.
 * @param scenarioName - Optional scenario name for FIRE page chats
 */
export async function saveChatHistory(
  userId: string,
  pagePath: string,
  pageName: string,
  pageIcon: string | undefined,
  messages: ChatMessage[],
  chatId?: string,
  scenarioName?: string
): Promise<ChatHistoryRecord | null> {
  try {
    if (chatId) {
      // Update existing chat (continuation from chat history). MONEY-599
      // (defense-in-depth): scope the write by userId so a foreign chatId is
      // rejected even if a future caller forgets to pre-verify ownership.
      // updateMany doesn't return the row, so re-read the now-owned record.
      const res = await prisma.chatHistory.updateMany({
        where: { id: chatId, userId },
        data: {
          messages: messages as unknown as Prisma.InputJsonValue[],
          lastMessageAt: new Date(),
          updatedAt: new Date(),
          // Update pageName with scenario name if provided (for FIRE)
          ...(scenarioName
            ? { pageName: `${pageName} - ${scenarioName}` }
            : {}),
        },
      });
      if (res.count === 0) return null;

      // Invalidate conversation context cache for this chat
      await invalidateContextCache(userId, chatId);

      const updated = await prisma.chatHistory.findFirst({
        where: { id: chatId, userId },
      });
      return updated ? convertToChatHistoryRecord(updated) : null;
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
        },
      });
      return convertToChatHistoryRecord(created);
    }
  } catch (error) {
    logger.error({ error }, "Error saving chat history");
    return null;
  }
}

/**
 * Get chat history for a specific page
 */
export async function getChatHistoryByPage(
  userId: string,
  pagePath: string,
  includeArchived: boolean = false
): Promise<ChatHistoryRecord | null> {
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
    return chat ? convertToChatHistoryRecord(chat) : null;
  } catch (error) {
    logger.error({ error }, "Error getting chat history");
    return null;
  }
}

export interface PaginatedChatHistories {
  chats: ChatHistoryRecord[];
  totalCount: number;
}

/**
 * List all chat histories for a user with filters and pagination
 */
export async function listChatHistories(
  userId: string,
  options: {
    pagePath?: string;
    isArchived?: boolean;
    sortBy?: "date" | "lastMessage";
    order?: "asc" | "desc";
    limit?: number;
    skip?: number;
    searchQuery?: string;
  } = {}
): Promise<PaginatedChatHistories> {
  try {
    const {
      pagePath,
      isArchived,
      sortBy = "lastMessage",
      order = "desc",
      limit,
      skip,
      searchQuery,
    } = options;

    const where: Prisma.ChatHistoryWhereInput = {
      userId,
    };

    if (pagePath) {
      where.pagePath = pagePath;
    }

    if (isArchived !== undefined) {
      where.isArchived = isArchived;
    }

    const orderBy: Prisma.ChatHistoryOrderByWithRelationInput = {};
    if (sortBy === "date") {
      orderBy.createdAt = order;
    } else {
      orderBy.lastMessageAt = order;
    }

    // When searching, we must fetch all and filter in JS (search includes JSON message content)
    // When not searching, use Prisma skip/take for efficient server-side pagination
    const useServerPagination = !searchQuery?.trim();

    const chats = await prisma.chatHistory.findMany({
      where: where as Prisma.ChatHistoryWhereInput,
      orderBy,
      ...(useServerPagination && skip !== undefined ? { skip } : {}),
      ...(useServerPagination && limit ? { take: limit } : {}),
    });

    // Convert to ChatHistoryRecord
    const convertedChats = chats.map(convertToChatHistoryRecord);

    if (useServerPagination) {
      // Get total count for pagination
      const totalCount = await prisma.chatHistory.count({
        where: where as Prisma.ChatHistoryWhereInput,
      });
      return { chats: convertedChats, totalCount };
    }

    // Search filtering: must happen in JS because we search inside JSON message arrays
    const query = searchQuery!.trim().toLowerCase();
    const filteredChats = convertedChats.filter((chat) =>
      chatMatchesSearch(chat, query)
    );

    const totalCount = filteredChats.length;

    // Apply pagination to filtered results
    const paginatedChats = paginateChats(filteredChats, skip, limit);

    return { chats: paginatedChats, totalCount };
  } catch (error) {
    logger.error({ error }, "Error listing chat histories");
    return { chats: [], totalCount: 0 };
  }
}

/**
 * Get a chat history by ID.
 *
 * MONEY-595 (A01): this legacy module duplicated the userId-scoped lookup that
 * was hardened in the canonical service (`packages/services/.../chat-history.service.ts`).
 * To keep a single source of truth for the ownership check, this now DELEGATES
 * to that service instead of issuing its own Prisma query. The `(chatId, userId)`
 * parameter order is preserved for the existing caller (`lib/gemini/conversation.ts`);
 * the canonical service uses `(userId, chatId)`, so we translate here.
 */
export async function getChatHistoryById(
  chatId: string,
  userId: string
): Promise<ChatHistoryRecord | null> {
  const result = await getChatHistoryByIdService(userId, chatId);
  return result.success ? (result.data as ChatHistoryRecord | null) : null;
}

/**
 * Archive a chat history
 */
export async function archiveChatHistory(
  chatId: string,
  userId: string
): Promise<boolean> {
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
    return result.count > 0;
  } catch (error) {
    logger.error({ error }, "Error archiving chat history");
    return false;
  }
}

/**
 * Unarchive a chat history
 */
export async function unarchiveChatHistory(
  chatId: string,
  userId: string
): Promise<boolean> {
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
    return result.count > 0;
  } catch (error) {
    logger.error({ error }, "Error unarchiving chat history");
    return false;
  }
}

/**
 * Delete a chat history
 */
export async function deleteChatHistory(
  chatId: string,
  userId: string
): Promise<boolean> {
  try {
    const result = await prisma.chatHistory.deleteMany({
      where: {
        id: chatId,
        userId,
      },
    });
    return result.count > 0;
  } catch (error) {
    logger.error({ error }, "Error deleting chat history");
    return false;
  }
}
