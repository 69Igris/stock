/**
 * Chat History — pure, side-effect-free logic.
 *
 * Extracted from the demo branch of `listChatHistoriesAction`
 * (apps/web/lib/actions/chat-history.ts) so it can be unit-tested without
 * booting the `"use server"` runtime (Clerk + Prisma + demo cookie).
 *
 * The action imports `filterDemoChatHistories` and calls it directly for the
 * demo branch — there is NO dead/duplicate copy in the action.
 */

import type { ChatMessage } from "@usemoney/types";
import type {
  ChatHistoryRecord,
  ListChatHistoriesOptions,
  PaginatedChatHistories,
} from "@usemoney/services";

/**
 * Filter, search, sort and paginate a list of chat-history records using the
 * same rules the DB-backed service applies, but over an in-memory array
 * (used for the demo session where there is no DB).
 *
 * Returns `{ chats, totalCount }` where `totalCount` reflects the number of
 * matches BEFORE pagination is applied (so the UI can render page counts).
 */
export function filterDemoChatHistories(
  chats: ChatHistoryRecord[],
  options: ListChatHistoriesOptions = {}
): PaginatedChatHistories {
  let filteredChats = [...chats];

  // Filter by page path
  if (options.pagePath) {
    filteredChats = filteredChats.filter(
      (chat) => chat.pagePath === options.pagePath
    );
  }

  // Filter by archived status
  if (options.isArchived !== undefined) {
    filteredChats = filteredChats.filter(
      (chat) => chat.isArchived === options.isArchived
    );
  }

  // Filter by search query
  if (options.searchQuery && options.searchQuery.trim()) {
    const query = options.searchQuery.trim().toLowerCase();
    filteredChats = filteredChats.filter((chat) => {
      if (
        chat.pageName.toLowerCase().includes(query) ||
        chat.pagePath.toLowerCase().includes(query)
      ) {
        return true;
      }
      if (Array.isArray(chat.messages)) {
        return chat.messages.some((msg: ChatMessage) => {
          const content = msg.content || "";
          return content.toLowerCase().includes(query);
        });
      }
      return false;
    });
  }

  // Sort
  const sortBy = options.sortBy || "lastMessage";
  const order = options.order || "desc";
  filteredChats.sort((a, b) => {
    const aValue =
      sortBy === "date" ? a.createdAt.getTime() : a.lastMessageAt.getTime();
    const bValue =
      sortBy === "date" ? b.createdAt.getTime() : b.lastMessageAt.getTime();
    return order === "asc" ? aValue - bValue : bValue - aValue;
  });

  const totalCount = filteredChats.length;

  // Apply pagination
  const start = options.skip ?? 0;
  if (options.limit) {
    filteredChats = filteredChats.slice(start, start + options.limit);
  } else if (start > 0) {
    filteredChats = filteredChats.slice(start);
  }

  return { chats: filteredChats, totalCount };
}

/**
 * Find a single demo chat by id. Mirrors the `getChatHistoryByIdAction` demo
 * branch lookup.
 */
export function findDemoChatById(
  chats: ChatHistoryRecord[],
  chatId: string
): ChatHistoryRecord | undefined {
  return chats.find((c) => c.id === chatId);
}
