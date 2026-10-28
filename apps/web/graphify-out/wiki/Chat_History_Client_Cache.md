# Chat History Client Cache

> 26 nodes

## Key Concepts

- **useChatHistoryCache.ts** (20 connections) — `hooks/useChatHistoryCache.ts`
- **useChatHistoryCache()** (12 connections) — `hooks/useChatHistoryCache.ts`
- **event-bus.ts** (11 connections) — `lib/chat-history/event-bus.ts`
- **idb-cache.ts** (11 connections) — `lib/chat-history/idb-cache.ts`
- **emitChatHistoryEvent()** (9 connections) — `lib/chat-history/event-bus.ts`
- **subscribeChatHistoryEvents()** (7 connections) — `lib/chat-history/event-bus.ts`
- **idbGet()** (6 connections) — `lib/chat-history/idb-cache.ts`
- **idb-cache.test.ts** (6 connections) — `__tests__/chat-history/idb-cache.test.ts`
- **idbClearForUser()** (5 connections) — `lib/chat-history/idb-cache.ts`
- **idbSet()** (5 connections) — `lib/chat-history/idb-cache.ts`
- **openDb()** (5 connections) — `lib/chat-history/idb-cache.ts`
- **FakeChannel** (4 connections) — `__tests__/chat-history/event-bus.test.ts`
- **buildKey()** (4 connections) — `lib/chat-history/idb-cache.ts`
- **event-bus.test.ts** (4 connections) — `__tests__/chat-history/event-bus.test.ts`
- **getChannel()** (3 connections) — `lib/chat-history/event-bus.ts`
- **idbClearAll()** (3 connections) — `lib/chat-history/idb-cache.ts`
- **rehydrateDates()** (2 connections) — `lib/chat-history/idb-cache.ts`
- **UseChatHistoryCacheOptions** (1 connections) — `hooks/useChatHistoryCache.ts`
- **UseChatHistoryCacheReturn** (1 connections) — `hooks/useChatHistoryCache.ts`
- **ChatHistoryEvent** (1 connections) — `lib/chat-history/event-bus.ts`
- **Listener** (1 connections) — `lib/chat-history/event-bus.ts`
- **CacheEntry** (1 connections) — `lib/chat-history/idb-cache.ts`
- **.close()** (1 connections) — `__tests__/chat-history/event-bus.test.ts`
- **.constructor()** (1 connections) — `__tests__/chat-history/event-bus.test.ts`
- **.postMessage()** (1 connections) — `__tests__/chat-history/event-bus.test.ts`
- *... and 1 more nodes in this community*

## Relationships

- [Chat History Views](Chat_History_Views.md) (9 shared connections)
- [Dashboard UI & Navigation](Dashboard_UI_&_Navigation.md) (7 shared connections)
- [Chat History Grouping](Chat_History_Grouping.md) (6 shared connections)
- [Dashboard Shell and Layout](Dashboard_Shell_and_Layout.md) (3 shared connections)
- [Side Chat Scopes](Side_Chat_Scopes.md) (2 shared connections)
- [Debug & UI Components](Debug_&_UI_Components.md) (1 shared connections)

## Source Files

- `__tests__/chat-history/event-bus.test.ts`
- `__tests__/chat-history/idb-cache.test.ts`
- `hooks/useChatHistoryCache.ts`
- `lib/chat-history/event-bus.ts`
- `lib/chat-history/idb-cache.ts`

## Audit Trail

- EXTRACTED: 77 (100%)
- INFERRED: 0 (0%)
- AMBIGUOUS: 0 (0%)

---

*Part of the graphify knowledge wiki. See [index](index.md) to navigate.*