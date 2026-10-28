# DLQ Release Tests

> 13 nodes

## Key Concepts

- **dead-letter-consumer-release.test.ts** (17 connections) — `workers/__tests__/processors/dead-letter-consumer-release.test.ts`
- **decideOnExistingMarker()** (3 connections) — `workers/src/lib/pubsub-dedupe-logic.ts`
- **DEDUPE_COLLECTION** (3 connections) — `workers/src/lib/pubsub-dedupe-logic.ts`
- **NotificationCreate** (1 connections) — `workers/__tests__/processors/dead-letter-consumer-release.test.ts`
- **RawCommand** (1 connections) — `workers/__tests__/processors/dead-letter-consumer-release.test.ts`
- **RunCommandRaw** (1 connections) — `workers/__tests__/processors/dead-letter-consumer-release.test.ts`
- **UserFindMany** (1 connections) — `workers/__tests__/processors/dead-letter-consumer-release.test.ts`
- **body()** (1 connections) — `workers/__tests__/processors/dead-letter-consumer-release.test.ts`
- **releaseSet()** (1 connections) — `workers/__tests__/processors/dead-letter-consumer-release.test.ts`
- **logged** (1 connections) — `workers/__tests__/processors/dead-letter-consumer-release.test.ts`
- **notificationWrites** (1 connections) — `workers/__tests__/processors/dead-letter-consumer-release.test.ts`
- **rawCommands** (1 connections) — `workers/__tests__/processors/dead-letter-consumer-release.test.ts`
- **recipients** (1 connections) — `workers/__tests__/processors/dead-letter-consumer-release.test.ts`

## Relationships

- [PubSub Message Deduplication](PubSub_Message_Deduplication.md) (5 shared connections)
- [Dead Letter Queue Consumer](Dead_Letter_Queue_Consumer.md) (2 shared connections)
- [Content Access and Pagination](Content_Access_and_Pagination.md) (1 shared connections)
- [Database Client and Migrations](Database_Client_and_Migrations.md) (1 shared connections)

## Source Files

- `workers/__tests__/processors/dead-letter-consumer-release.test.ts`
- `workers/src/lib/pubsub-dedupe-logic.ts`

## Audit Trail

- EXTRACTED: 21 (100%)
- INFERRED: 0 (0%)
- AMBIGUOUS: 0 (0%)

---

*Part of the graphify knowledge wiki. See [index](index.md) to navigate.*