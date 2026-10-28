# PubSub Deduplication Middleware

> 14 nodes

## Key Concepts

- **pubsub-dedupe.ts** (22 connections) — `workers/src/lib/pubsub-dedupe.ts`
- **RawCommandRunner** (4 connections) — `workers/src/lib/pubsub-dedupe-logic.ts`
- **dedupeIndexCommand()** (4 connections) — `workers/src/lib/pubsub-dedupe-logic.ts`
- **ClaimDecision** (3 connections) — `workers/src/lib/pubsub-dedupe-logic.ts`
- **FakeMongo** (3 connections) — `workers/__tests__/lib/pubsub-dedupe-logic.test.ts`
- **ensureDedupeIndexes()** (3 connections) — `workers/src/lib/pubsub-dedupe.ts`
- **DEFAULT_LEASE_MS** (3 connections) — `workers/src/lib/pubsub-dedupe-logic.ts`
- **runCommand()** (2 connections) — `workers/src/lib/pubsub-dedupe.ts`
- **pubsubDedupeMiddleware** (2 connections) — `workers/src/lib/pubsub-dedupe.ts`
- **dedupeEnabled()** (1 connections) — `workers/src/lib/pubsub-dedupe.ts`
- **leaseMs()** (1 connections) — `workers/src/lib/pubsub-dedupe.ts`
- **.run()** (1 connections) — `workers/__tests__/lib/pubsub-dedupe-logic.test.ts`
- **prismaDedupeStore** (1 connections) — `workers/src/lib/pubsub-dedupe.ts`
- **store** (1 connections) — `workers/src/lib/pubsub-dedupe.ts`

## Relationships

- [PubSub Message Deduplication](PubSub_Message_Deduplication.md) (13 shared connections)
- [Dead Letter Queue Consumer](Dead_Letter_Queue_Consumer.md) (3 shared connections)
- [PubSub Message Handlers](PubSub_Message_Handlers.md) (2 shared connections)
- [Database Client and Migrations](Database_Client_and_Migrations.md) (2 shared connections)
- [Content Access and Pagination](Content_Access_and_Pagination.md) (1 shared connections)

## Source Files

- `workers/__tests__/lib/pubsub-dedupe-logic.test.ts`
- `workers/src/lib/pubsub-dedupe-logic.ts`
- `workers/src/lib/pubsub-dedupe.ts`

## Audit Trail

- EXTRACTED: 34 (94%)
- INFERRED: 2 (6%)
- AMBIGUOUS: 0 (0%)

---

*Part of the graphify knowledge wiki. See [index](index.md) to navigate.*