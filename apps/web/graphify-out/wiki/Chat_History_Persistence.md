# Chat History Persistence

> 30 nodes

## Key Concepts

- **db/chat-history.test.ts** (18 connections) — `__tests__/db/chat-history.test.ts`
- **db/chat-history.ts** (17 connections) — `lib/db/chat-history.ts`
- **convertToChatHistoryRecord()** (7 connections) — `lib/db/chat-history-logic.ts`
- **db/chat-history-logic.ts** (7 connections) — `lib/db/chat-history-logic.ts`
- **chatMatchesSearch()** (5 connections) — `lib/db/chat-history-logic.ts`
- **ChatHistoryRecord** (4 connections) — `lib/db/chat-history-logic.ts`
- **listChatHistories()** (4 connections) — `lib/db/chat-history.ts`
- **invalidateContextCache()** (4 connections) — `lib/gemini/conversation.ts`
- **paginateChats()** (3 connections) — `lib/db/chat-history-logic.ts`
- **saveChatHistory()** (3 connections) — `lib/db/chat-history.ts`
- **RawChatHistoryRow** (2 connections) — `lib/db/chat-history-logic.ts`
- **PaginatedChatHistories** (2 connections) — `lib/db/chat-history.ts`
- **getChatHistoryByPage()** (2 connections) — `lib/db/chat-history.ts`
- **convertToChatHistoryRecord()** (2 connections) — `__tests__/db/chat-history.test.ts`
- **filterBySearchQuery()** (2 connections) — `__tests__/db/chat-history.test.ts`
- **ChatHistoryPrisma** (1 connections) — `__tests__/db/chat-history.test.ts`
- **ChatHistoryRecord** (1 connections) — `__tests__/db/chat-history.test.ts`
- **ChatMessage** (1 connections) — `__tests__/db/chat-history.test.ts`
- **ListOptions** (1 connections) — `__tests__/db/chat-history.test.ts`
- **archiveChatHistory()** (1 connections) — `lib/db/chat-history.ts`
- **deleteChatHistory()** (1 connections) — `lib/db/chat-history.ts`
- **unarchiveChatHistory()** (1 connections) — `lib/db/chat-history.ts`
- **buildListWhereClause()** (1 connections) — `__tests__/db/chat-history.test.ts`
- **buildPageWhereClause()** (1 connections) — `__tests__/db/chat-history.test.ts`
- **buildSortOrder()** (1 connections) — `__tests__/db/chat-history.test.ts`
- *... and 5 more nodes in this community*

## Relationships

- [Chat History Context](Chat_History_Context.md) (4 shared connections)
- [Dashboard UI & Navigation](Dashboard_UI_&_Navigation.md) (2 shared connections)
- [Auth & Integration Routes](Auth_&_Integration_Routes.md) (1 shared connections)

## Source Files

- `__tests__/db/chat-history.test.ts`
- `lib/db/chat-history-logic.ts`
- `lib/db/chat-history.ts`
- `lib/gemini/conversation.ts`

## Audit Trail

- EXTRACTED: 51 (98%)
- INFERRED: 1 (2%)
- AMBIGUOUS: 0 (0%)

---

*Part of the graphify knowledge wiki. See [index](index.md) to navigate.*