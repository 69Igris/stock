/**
 * ChatHistorySidebar - pure logic (React-free)
 *
 * The date-grouping + kind-detection helpers live here, split out of the
 * `"use client"` `ChatHistorySidebar.tsx` (which imports Clerk, server actions
 * → `react.cache`, and lucide), so they can be unit-tested under `node:test`.
 * `ChatHistorySidebar.tsx` imports and re-exports these, so the component and
 * the tests run the SAME logic (no shadow).
 *
 * The `ChatHistoryRecord` import is type-only, so it is erased at runtime and
 * does not drag the server-action module into the test.
 */

import type { ChatHistoryRecord } from "@/lib/actions/chat-history";

/**
 * The fields these pure helpers actually read off a chat record. Typing the
 * params structurally (rather than the full `ChatHistoryRecord`) lets the
 * component pass full records and the unit tests pass minimal fixtures, while
 * still type-checking under tsc.
 */
export type GroupableChat = Pick<ChatHistoryRecord, "lastMessageAt">;
export type KindDetectableChat = Pick<ChatHistoryRecord, "messages">;

export interface GroupedChats<T extends GroupableChat = ChatHistoryRecord> {
  today: T[];
  yesterday: T[];
  lastWeek: T[];
  older: T[];
}

/** Bucket chats into today / yesterday / last-7-days / older by lastMessageAt. */
export function groupChatsByDate<T extends GroupableChat>(
  chats: T[]
): GroupedChats<T> {
  const now = new Date();
  const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const yesterdayStart = new Date(todayStart);
  yesterdayStart.setDate(yesterdayStart.getDate() - 1);
  // "Last week" = anything in the trailing 7 days (after yesterday).
  const lastWeekStart = new Date(todayStart);
  lastWeekStart.setDate(lastWeekStart.getDate() - 7);

  const groups: GroupedChats<T> = {
    today: [],
    yesterday: [],
    lastWeek: [],
    older: [],
  };

  for (const chat of chats) {
    const date = new Date(chat.lastMessageAt);
    if (date >= todayStart) {
      groups.today.push(chat);
    } else if (date >= yesterdayStart) {
      groups.yesterday.push(chat);
    } else if (date >= lastWeekStart) {
      groups.lastWeek.push(chat);
    } else {
      groups.older.push(chat);
    }
  }

  return groups;
}

export type ChatKind =
  | "roast"
  | "compare"
  | "research"
  | "portfolio"
  | "fire"
  | "screen"
  | "stock"
  | "generic";

/**
 * MONEY-231 Phase D - kind-coded icons. Detects the dominant intent from the
 * chat's first user message so the sidebar list mirrors the design's 6-icon
 * palette (research / roast / compare / portfolio / FIRE / generic).
 */
export function detectChatKind(chat: KindDetectableChat): ChatKind {
  if (!Array.isArray(chat.messages)) return "generic";
  const userMsg = chat.messages.find((m) => m.role === "user");
  if (!userMsg) return "generic";
  const raw = userMsg.content ?? "";
  const text = raw.toLowerCase();
  if (/(roast|trash|review my portfolio)/.test(text)) return "roast";
  if (/(compare|vs\.?\s|versus)/.test(text)) return "compare";
  if (/(holdings|portfolio|allocation|rebalance)/.test(text))
    return "portfolio";
  if (/(fire|retire|retirement|swr|withdrawal)/.test(text)) return "fire";
  if (/(screen|filter|find stocks where)/.test(text)) return "screen";
  if (
    /(deep[- ]?research|fundamentals|valuation|dcf|analyse|analyze)/.test(text)
  )
    return "research";
  // Stock heuristic - only fires on UPPERCASE tickers (RELIANCE, TCS) or
  // explicit @SYMBOL mentions. Lowercase inputs like "hello there" must fall
  // through to generic.
  if (/^@[A-Za-z]{2,15}\b/.test(raw)) return "stock";
  if (/^[A-Z]{2,15}\b/.test(raw)) return "stock";
  return "generic";
}

// ============== Bulk-select state machine ==============

/** Toggle a chatId in the selected set; returns a NEW set (immutable). */
export function toggleSelect(prev: Set<string>, chatId: string): Set<string> {
  const next = new Set(prev);
  if (next.has(chatId)) next.delete(chatId);
  else next.add(chatId);
  return next;
}

/** True iff select-mode is on and every chat in the list is selected. */
export function isAllSelected(
  selectMode: boolean,
  chats: { id: string }[],
  selectedIds: Set<string>
): boolean {
  return selectMode && chats.length > 0 && selectedIds.size === chats.length;
}

/**
 * Partition bulk-delete ids by the settled result of their delete action:
 * an id succeeds only if its result fulfilled with `value.success === true`.
 */
export function partitionDeleteResults(
  ids: string[],
  results: PromiseSettledResult<{ success: boolean }>[]
): { succeeded: string[]; failed: string[] } {
  const succeeded: string[] = [];
  const failed: string[] = [];
  ids.forEach((id, i) => {
    const r = results[i];
    if (r && r.status === "fulfilled" && r.value?.success) {
      succeeded.push(id);
    } else {
      failed.push(id);
    }
  });
  return { succeeded, failed };
}

/** Drop every record whose id is in `succeededIds` (post-delete list update). */
export function dropSucceeded<T extends { id: string }>(
  list: T[],
  succeededIds: Set<string>
): T[] {
  return list.filter((c) => !succeededIds.has(c.id));
}
