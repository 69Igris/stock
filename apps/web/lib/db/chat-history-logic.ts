/**
 * Chat-history DB layer — pure logic (no Prisma / no server-only deps).
 *
 * Extracted from `lib/db/chat-history.ts` so the Prisma-row → app-record
 * mapper and the in-JS search/pagination path of `listChatHistories` can be
 * unit-tested against the REAL exported symbols instead of inline copies.
 *
 * MONEY-620 de-shadow: `__tests__/db/chat-history.test.ts` previously
 * re-declared `convertToChatHistoryRecord` (and the search filter) inline (a
 * shadow). `chat-history.ts` now imports and calls these helpers so the
 * production path and the test execute the SAME code.
 *
 * This module imports only the shared `ChatMessage` type, so the tests stay
 * pure and exit cleanly.
 *
 * @see apps/web/__tests__/db/chat-history.test.ts
 */

import type { ChatMessage } from "@usemoney/types";

export interface ChatHistoryRecord {
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

/**
 * The subset of a Prisma `ChatHistory` row the mapper reads. `messages` is
 * untyped JSON (`unknown`) as Prisma returns it; `pageIcon` may be `null`.
 */
export interface RawChatHistoryRow {
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

/**
 * Map a Prisma chat-history row → `ChatHistoryRecord`:
 *  - `pageIcon`: `null` is normalized to `undefined` (so it's omittable).
 *  - `messages`: untyped JSON narrowed to `ChatMessage[]`; a nullish value
 *    becomes `[]` (never `null`/`undefined`).
 */
export function convertToChatHistoryRecord(
  chat: RawChatHistoryRow
): ChatHistoryRecord {
  return {
    ...chat,
    pageIcon: chat.pageIcon || undefined,
    messages: (chat.messages as unknown as ChatMessage[]) || [],
  };
}

/**
 * The free-text search predicate used by `listChatHistories` when a
 * `searchQuery` is present. Matches (case-insensitively) against `pageName`,
 * `pagePath`, or any message's `content`. `query` MUST already be lowercased
 * and trimmed by the caller (mirrors the source, which lowercases once).
 *
 * A non-array `messages` (defensive — Prisma JSON could be malformed) simply
 * contributes no message matches rather than throwing.
 */
export function chatMatchesSearch(
  chat: Pick<ChatHistoryRecord, "pageName" | "pagePath" | "messages">,
  query: string
): boolean {
  if (
    chat.pageName.toLowerCase().includes(query) ||
    chat.pagePath.toLowerCase().includes(query)
  ) {
    return true;
  }
  if (Array.isArray(chat.messages)) {
    return chat.messages.some((msg) => {
      const content = msg.content || "";
      return content.toLowerCase().includes(query);
    });
  }
  return false;
}

/**
 * Slice an already-filtered chat list by the same `(skip, limit)` rules
 * `listChatHistories` applies to in-memory search results:
 *  - `skip` defaults to 0.
 *  - a falsy/0 `limit` means "no take limit" → from `skip` to the end.
 */
export function paginateChats<T>(
  chats: T[],
  skip?: number,
  limit?: number
): T[] {
  const start = skip ?? 0;
  return limit ? chats.slice(start, start + limit) : chats.slice(start);
}
