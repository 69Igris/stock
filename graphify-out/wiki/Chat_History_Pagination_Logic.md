# Chat History Pagination Logic

> 39 nodes

## Key Concepts

- **chat-history.service.ts** (36 connections) — `packages/services/src/chat-history.service.ts`
- **chat-history-logic.ts** (21 connections) — `packages/services/src/chat-history-logic.ts`
- **clearChatCache()** (10 connections) — `packages/core/src/cache/invalidation.ts`
- **convertToChatHistoryRecord()** (9 connections) — `packages/services/src/chat-history.service.ts`
- **deriveChatPreview()** (8 connections) — `packages/services/src/chat-history-logic.ts`
- **deriveChatTitle()** (8 connections) — `packages/services/src/chat-history-logic.ts`
- **safeMessageArray()** (6 connections) — `packages/services/src/chat-history-logic.ts`
- **ChatMessage** (5 connections) — `packages/types/src/analysis/index.ts`
- **listChatHistories()** (5 connections) — `packages/services/src/chat-history.service.ts`
- **clampChatPagination()** (4 connections) — `packages/services/src/chat-history-logic.ts`
- **summarizeChatMessages()** (4 connections) — `packages/services/src/chat-history-logic.ts`
- **fetchAllChatsForList()** (4 connections) — `packages/services/src/chat-history.service.ts`
- **ChatMessageSummary** (3 connections) — `packages/services/src/chat-history-logic.ts`
- **ChatHistoryRecord** (3 connections) — `packages/services/src/chat-history.service.ts`
- **collapseWhitespace()** (3 connections) — `packages/services/src/chat-history-logic.ts`
- **messageContent()** (3 connections) — `packages/services/src/chat-history-logic.ts`
- **paginateChatList()** (3 connections) — `packages/services/src/chat-history-logic.ts`
- **stripMentionPrefix()** (3 connections) — `packages/services/src/chat-history-logic.ts`
- **truncate()** (3 connections) — `packages/services/src/chat-history-logic.ts`
- **analysis/index.ts** (3 connections) — `packages/types/src/analysis/index.ts`
- **AnalysisReport** (2 connections) — `packages/types/src/analysis/index.ts`
- **toFiniteInt()** (2 connections) — `packages/services/src/chat-history-logic.ts`
- **archiveChatHistory()** (2 connections) — `packages/services/src/chat-history.service.ts`
- **deleteChatHistory()** (2 connections) — `packages/services/src/chat-history.service.ts`
- **getChatHistoryById()** (2 connections) — `packages/services/src/chat-history.service.ts`
- *... and 14 more nodes in this community*

## Relationships

- [SEO and Chat Components](SEO_and_Chat_Components.md) (5 shared connections)
- [Cache Key Management](Cache_Key_Management.md) (4 shared connections)
- [Content Access and Pagination](Content_Access_and_Pagination.md) (4 shared connections)
- [Admin Audit and Consent](Admin_Audit_and_Consent.md) (4 shared connections)
- [Application Logging Framework](Application_Logging_Framework.md) (1 shared connections)
- [Database Client and Migrations](Database_Client_and_Migrations.md) (1 shared connections)
- [Content Metrics and Slugs](Content_Metrics_and_Slugs.md) (1 shared connections)

## Source Files

- `packages/core/src/cache/invalidation.ts`
- `packages/services/src/chat-history-logic.ts`
- `packages/services/src/chat-history.service.ts`
- `packages/types/src/analysis/index.ts`

## Audit Trail

- EXTRACTED: 94 (98%)
- INFERRED: 2 (2%)
- AMBIGUOUS: 0 (0%)

---

*Part of the graphify knowledge wiki. See [index](index.md) to navigate.*