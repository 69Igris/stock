# Dead Letter Queue Consumer

> 14 nodes

## Key Concepts

- **dead-letter-consumer.ts** (20 connections) — `workers/src/processors/dead-letter-consumer.ts`
- **processDeadLetter()** (8 connections) — `workers/src/processors/dead-letter-consumer.ts`
- **buildDeadLetterNotification()** (5 connections) — `workers/src/processors/dead-letter-consumer-logic.ts`
- **notifyFounders()** (5 connections) — `workers/src/processors/dead-letter-consumer.ts`
- **resolveDlqAlertEmails()** (4 connections) — `workers/src/processors/dead-letter-consumer-logic.ts`
- **dead-letter.ts** (4 connections) — `workers/src/routes/dead-letter.ts`
- **claimMessage** (3 connections) — `workers/src/lib/pubsub-dedupe.ts`
- **releaseMessage** (3 connections) — `workers/src/lib/pubsub-dedupe.ts`
- **DeadLetterRecord** (2 connections) — `workers/src/processors/dead-letter-consumer-logic.ts`
- **logRecord()** (2 connections) — `workers/src/processors/dead-letter-consumer.ts`
- **deadLetterRoute** (2 connections) — `workers/src/routes/dead-letter.ts`
- **DeadLetterOutcome** (1 connections) — `workers/src/processors/dead-letter-consumer.ts`
- **NotifyOutcome** (1 connections) — `workers/src/processors/dead-letter-consumer.ts`
- **DEAD_LETTER_ROUTE** (1 connections) — `workers/src/processors/dead-letter-consumer.ts`

## Relationships

- [Dead Letter Queue Consumer](Dead_Letter_Queue_Consumer.md) (9 shared connections)
- [Database Client and Migrations](Database_Client_and_Migrations.md) (4 shared connections)
- [PubSub Deduplication Middleware](PubSub_Deduplication_Middleware.md) (3 shared connections)
- [DLQ Release Tests](DLQ_Release_Tests.md) (2 shared connections)
- [PubSub Message Handlers](PubSub_Message_Handlers.md) (2 shared connections)
- [Content Access and Pagination](Content_Access_and_Pagination.md) (1 shared connections)

## Source Files

- `workers/src/lib/pubsub-dedupe.ts`
- `workers/src/processors/dead-letter-consumer-logic.ts`
- `workers/src/processors/dead-letter-consumer.ts`
- `workers/src/routes/dead-letter.ts`

## Audit Trail

- EXTRACTED: 41 (100%)
- INFERRED: 0 (0%)
- AMBIGUOUS: 0 (0%)

---

*Part of the graphify knowledge wiki. See [index](index.md) to navigate.*