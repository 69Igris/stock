"use server";

import { getAuthenticatedUser } from "@/lib/auth";
import type { ChatMessage } from "@usemoney/types";
import type { ActionResponse } from "@usemoney/validation";
import {
  saveChatHistory as saveChatHistoryService,
  getChatHistoryByPage as getChatHistoryByPageService,
  listChatHistories as listChatHistoriesService,
  getChatHistoryById as getChatHistoryByIdService,
  archiveChatHistory as archiveChatHistoryService,
  unarchiveChatHistory as unarchiveChatHistoryService,
  deleteChatHistory as deleteChatHistoryService,
  renameChatHistory as renameChatHistoryService,
} from "@usemoney/services";
import type {
  ChatHistoryRecord,
  PaginatedChatHistories,
  ListChatHistoriesOptions,
} from "@usemoney/services";
import { isDemoSession } from "@/lib/demo/session";
import { demoChatHistories } from "@/lib/demo/data";
import {
  filterDemoChatHistories,
  findDemoChatById,
} from "@/lib/actions/chat-history-logic";

// Re-export types for consumers
export type {
  ChatHistoryRecord,
  PaginatedChatHistories,
  ListChatHistoriesOptions,
} from "@usemoney/services";

/**
 * Save chat history for current page
 * @param chatId - If provided, update this specific chat (continuation). If not, create new chat.
 * @param scenarioName - Optional scenario name for FIRE page chats
 */
export async function saveChatHistoryAction(
  pagePath: string,
  pageName: string,
  pageIcon: string | undefined,
  messages: ChatMessage[],
  chatId?: string,
  scenarioName?: string,
  /**
   * MONEY-1245 — raw Gemini turns for the tool-driven side chats (Ask FIRE,
   * Ask Screener), so a resumed chat replays what the model already did.
   * Omitted by StockSage, whose chats have no tool loop.
   */
  toolConversation?: unknown
): Promise<ActionResponse<{ chatId?: string }>> {
  const authUser = await getAuthenticatedUser();
  if (!authUser) {
    return { success: false, error: "Unauthorized" };
  }

  const result = await saveChatHistoryService(
    authUser.userId,
    pagePath,
    pageName,
    pageIcon,
    messages,
    chatId,
    scenarioName,
    toolConversation
  );

  if (!result?.success) {
    return { success: false, error: result?.error };
  }

  return { success: true, data: { chatId: result?.data.chatId } };
}

/**
 * Get chat history for a specific page
 */
export async function getChatHistoryByPageAction(
  pagePath: string,
  includeArchived: boolean = false
): Promise<ActionResponse<ChatHistoryRecord>> {
  const authUser = await getAuthenticatedUser();
  if (!authUser) {
    return { success: false, error: "Unauthorized" };
  }

  const result = await getChatHistoryByPageService(
    authUser.userId,
    pagePath,
    includeArchived
  );

  if (!result?.success) {
    return { success: false, error: result?.error };
  }

  if (!result?.data) {
    return { success: false, error: "Chat history not found" };
  }

  return { success: true, data: result?.data };
}

/**
 * List all chat histories with filters and pagination
 */
export async function listChatHistoriesAction(
  options: ListChatHistoriesOptions = {}
): Promise<
  ActionResponse<{
    chats: ChatHistoryRecord[];
    totalCount: number;
  }>
> {
  // Demo mode
  if (await isDemoSession()) {
    return {
      success: true,
      data: filterDemoChatHistories(demoChatHistories, options),
    };
  }

  // Authenticated user
  const authUser = await getAuthenticatedUser();
  if (!authUser) {
    return { success: false, error: "Unauthorized" };
  }

  const result = await listChatHistoriesService(authUser.userId, options);

  if (!result?.success) {
    return { success: false, error: result?.error };
  }

  return { success: true, data: result?.data };
}

/**
 * Get chat history by ID
 */
export async function getChatHistoryByIdAction(
  chatId: string
): Promise<ActionResponse<ChatHistoryRecord>> {
  // Demo mode
  if (await isDemoSession()) {
    const chat = findDemoChatById(demoChatHistories, chatId);
    if (!chat) {
      return { success: false, error: "Chat history not found" };
    }
    return { success: true, data: chat };
  }

  // Authenticated user
  const authUser = await getAuthenticatedUser();
  if (!authUser) {
    return { success: false, error: "Unauthorized" };
  }

  const result = await getChatHistoryByIdService(authUser.userId, chatId);

  if (!result?.success) {
    return { success: false, error: result?.error };
  }

  if (!result?.data) {
    return { success: false, error: "Chat history not found" };
  }

  return { success: true, data: result?.data };
}

/**
 * Archive a chat history
 */
export async function archiveChatHistoryAction(
  chatId: string
): Promise<ActionResponse<void>> {
  // Demo mode - return success but don't actually archive
  if (await isDemoSession()) {
    return { success: true };
  }

  const authUser = await getAuthenticatedUser();
  if (!authUser) {
    return { success: false, error: "Unauthorized" };
  }

  return archiveChatHistoryService(authUser.userId, chatId);
}

/**
 * Unarchive a chat history
 */
export async function unarchiveChatHistoryAction(
  chatId: string
): Promise<ActionResponse<void>> {
  // Demo mode - return success but don't actually unarchive
  if (await isDemoSession()) {
    return { success: true };
  }

  const authUser = await getAuthenticatedUser();
  if (!authUser) {
    return { success: false, error: "Unauthorized" };
  }

  return unarchiveChatHistoryService(authUser.userId, chatId);
}

/**
 * Delete a chat history
 */
export async function deleteChatHistoryAction(
  chatId: string
): Promise<ActionResponse<void>> {
  // Demo mode - return success but don't actually delete
  if (await isDemoSession()) {
    return { success: true };
  }

  const authUser = await getAuthenticatedUser();
  if (!authUser) {
    return { success: false, error: "Unauthorized" };
  }

  return deleteChatHistoryService(authUser.userId, chatId);
}

/**
 * Rename a chat history with a custom title
 */
export async function renameChatHistoryAction(
  chatId: string,
  title: string | null
): Promise<ActionResponse<void>> {
  if (await isDemoSession()) {
    return { success: true };
  }

  const authUser = await getAuthenticatedUser();
  if (!authUser) {
    return { success: false, error: "Unauthorized" };
  }

  return renameChatHistoryService(authUser.userId, chatId, title);
}
