# Chat History Context

> 36 nodes

## Key Concepts

- **conversation.ts** (32 connections) — `lib/gemini/conversation.ts`
- **conversation.test.ts** (22 connections) — `__tests__/gemini/conversation.test.ts`
- **buildConversationContext()** (11 connections) — `lib/gemini/conversation.ts`
- **streaming.test.ts** (11 connections) — `__tests__/gemini/streaming.test.ts`
- **buildFullPrompt()** (8 connections) — `lib/gemini/conversation.ts`
- **conversation-memory.test.ts** (7 connections) — `__tests__/gemini/conversation-memory.test.ts`
- **estimateTokens()** (6 connections) — `lib/gemini/conversation.ts`
- **summarizeOldContext()** (6 connections) — `lib/gemini/conversation.ts`
- **trimHistoryToTokenBudget()** (5 connections) — `lib/gemini/conversation.ts`
- **ConversationContext** (4 connections) — `lib/gemini/conversation.ts`
- **addExchangeToContext()** (4 connections) — `lib/gemini/conversation.ts`
- **convertToGeminiFormat()** (4 connections) — `lib/gemini/conversation.ts`
- **getContextCacheKey()** (4 connections) — `lib/gemini/conversation.ts`
- **shouldSkipSummarization()** (4 connections) — `lib/gemini/conversation.ts`
- **summarizeSplitPoint()** (4 connections) — `lib/gemini/conversation.ts`
- **GeminiHistoryMessage** (3 connections) — `lib/gemini/conversation.ts`
- **getChatHistoryById()** (3 connections) — `lib/db/chat-history.ts`
- **createGeminiChatHistory()** (3 connections) — `lib/gemini/conversation.ts`
- **formatConversationText()** (3 connections) — `lib/gemini/conversation.ts`
- **isNearTokenLimit()** (3 connections) — `lib/gemini/conversation.ts`
- **sanitizeMemoryContext()** (3 connections) — `lib/gemini/conversation.ts`
- **wrapUntrustedContext()** (2 connections) — `lib/gemini/conversation.ts`
- **MAX_MEMORY_CONTEXT_CHARS** (2 connections) — `lib/gemini/conversation.ts`
- **ConversationConfig** (1 connections) — `lib/gemini/conversation.ts`
- **PriorTurnContext** (1 connections) — `__tests__/gemini/conversation.test.ts`
- *... and 11 more nodes in this community*

## Relationships

- [Chat Narrative Routing](Chat_Narrative_Routing.md) (9 shared connections)
- [Chat History Persistence](Chat_History_Persistence.md) (4 shared connections)
- [Gemini Summarization Client](Gemini_Summarization_Client.md) (2 shared connections)

## Source Files

- `@usemoney/core`
- `__tests__/gemini/conversation-memory.test.ts`
- `__tests__/gemini/conversation.test.ts`
- `__tests__/gemini/streaming.test.ts`
- `lib/db/chat-history.ts`
- `lib/gemini/conversation.ts`

## Audit Trail

- EXTRACTED: 91 (100%)
- INFERRED: 0 (0%)
- AMBIGUOUS: 0 (0%)

---

*Part of the graphify knowledge wiki. See [index](index.md) to navigate.*