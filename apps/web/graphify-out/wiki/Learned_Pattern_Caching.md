# Learned Pattern Caching

> 10 nodes

## Key Concepts

- **learned-patterns.ts** (12 connections) — `lib/chat-tools/learned-patterns.ts`
- **loadFromRedis()** (4 connections) — `lib/chat-tools/learned-patterns.ts`
- **refreshIfStale()** (3 connections) — `lib/chat-tools/learned-patterns.ts`
- **forceRefresh()** (2 connections) — `lib/chat-tools/learned-patterns.ts`
- **getLearnedExamples()** (2 connections) — `lib/chat-tools/learned-patterns.ts`
- **FlashExample** (1 connections) — `lib/chat-tools/learned-patterns.ts`
- **LearnedRegexPattern** (1 connections) — `lib/chat-tools/learned-patterns.ts`
- **getLearnedPatterns()** (1 connections) — `lib/chat-tools/learned-patterns.ts`
- **cachedExamples** (1 connections) — `lib/chat-tools/learned-patterns.ts`
- **cachedPatterns** (1 connections) — `lib/chat-tools/learned-patterns.ts`

## Relationships

- [Redis Cache Client](Redis_Cache_Client.md) (2 shared connections)
- [Intent Mapping and Classification](Intent_Mapping_and_Classification.md) (2 shared connections)

## Source Files

- `lib/chat-tools/learned-patterns.ts`

## Audit Trail

- EXTRACTED: 16 (100%)
- INFERRED: 0 (0%)
- AMBIGUOUS: 0 (0%)

---

*Part of the graphify knowledge wiki. See [index](index.md) to navigate.*