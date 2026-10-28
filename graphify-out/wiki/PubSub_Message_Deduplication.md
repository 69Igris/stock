# PubSub Message Deduplication

> 37 nodes

## Key Concepts

- **pubsub-dedupe-logic.test.ts** (33 connections) — `workers/__tests__/lib/pubsub-dedupe-logic.test.ts`
- **pubsub-dedupe-logic.ts** (32 connections) — `workers/src/lib/pubsub-dedupe-logic.ts`
- **createDedupeMiddleware()** (8 connections) — `workers/src/lib/pubsub-dedupe-logic.ts`
- **createDedupeStore()** (6 connections) — `workers/src/lib/pubsub-dedupe-logic.ts`
- **DedupeContext** (5 connections) — `workers/src/lib/pubsub-dedupe-logic.ts`
- **DedupeStore** (5 connections) — `workers/src/lib/pubsub-dedupe-logic.ts`
- **toMarker()** (5 connections) — `workers/src/lib/pubsub-dedupe-logic.ts`
- **extractDeliveryId()** (3 connections) — `workers/src/lib/pubsub-dedupe-logic.ts`
- **parseMarkerDate()** (3 connections) — `workers/src/lib/pubsub-dedupe-logic.ts`
- **parseMarkerStatus()** (3 connections) — `workers/src/lib/pubsub-dedupe-logic.ts`
- **routeKey()** (3 connections) — `workers/src/lib/pubsub-dedupe-logic.ts`
- **DedupeMarker** (2 connections) — `workers/src/lib/pubsub-dedupe-logic.ts`
- **FakeCtx** (2 connections) — `workers/__tests__/lib/pubsub-dedupe-logic.test.ts`
- **readMarker()** (2 connections) — `workers/src/lib/pubsub-dedupe-logic.ts`
- **decideOnStoreError()** (2 connections) — `workers/src/lib/pubsub-dedupe-logic.ts`
- **.json()** (2 connections) — `workers/src/lib/pubsub-dedupe-logic.ts`
- **.claim()** (2 connections) — `workers/src/lib/pubsub-dedupe-logic.ts`
- **.release()** (2 connections) — `workers/src/lib/pubsub-dedupe-logic.ts`
- **insertSucceeded()** (2 connections) — `workers/src/lib/pubsub-dedupe-logic.ts`
- **isDuplicateKeyError()** (2 connections) — `workers/src/lib/pubsub-dedupe-logic.ts`
- **storeAt()** (2 connections) — `workers/__tests__/lib/pubsub-dedupe-logic.test.ts`
- **DEDUPE_RETENTION_MS** (2 connections) — `workers/src/lib/pubsub-dedupe-logic.ts`
- **DEDUPE_TTL_INDEX** (2 connections) — `workers/src/lib/pubsub-dedupe-logic.ts`
- **DEDUPE_UNIQUE_INDEX** (2 connections) — `workers/src/lib/pubsub-dedupe-logic.ts`
- **SELF_DEDUPING_ROUTES** (2 connections) — `workers/src/lib/pubsub-dedupe-logic.ts`
- *... and 12 more nodes in this community*

## Relationships

- [PubSub Deduplication Middleware](PubSub_Deduplication_Middleware.md) (13 shared connections)
- [DLQ Release Tests](DLQ_Release_Tests.md) (5 shared connections)
- [PubSub Message Handlers](PubSub_Message_Handlers.md) (2 shared connections)

## Source Files

- `workers/__tests__/lib/pubsub-dedupe-logic.test.ts`
- `workers/src/lib/pubsub-dedupe-logic.ts`

## Audit Trail

- EXTRACTED: 83 (100%)
- INFERRED: 0 (0%)
- AMBIGUOUS: 0 (0%)

---

*Part of the graphify knowledge wiki. See [index](index.md) to navigate.*