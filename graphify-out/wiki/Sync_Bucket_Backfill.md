# Sync Bucket Backfill

> 9 nodes

## Key Concepts

- **backfill-syncbucket.ts** (11 connections) — `scripts/ops/backfill-syncbucket.ts`
- **getSyncBucketCount()** (5 connections) — `packages/types/src/pubsub.ts`
- **main()** (4 connections) — `scripts/ops/backfill-syncbucket.ts`
- **verifyRemainingRaw()** (2 connections) — `scripts/ops/backfill-syncbucket.ts`
- **AggregateReply** (1 connections) — `scripts/ops/backfill-syncbucket.ts`
- **FacetCount** (1 connections) — `scripts/ops/backfill-syncbucket.ts`
- **FacetDoc** (1 connections) — `scripts/ops/backfill-syncbucket.ts`
- **NO_BUCKET_OR** (1 connections) — `scripts/ops/backfill-syncbucket.ts`
- **prisma** (1 connections) — `scripts/ops/backfill-syncbucket.ts`

## Relationships

- [PubSub Message Handlers](PubSub_Message_Handlers.md) (2 shared connections)
- [Broker Connection Auth Logic](Broker_Connection_Auth_Logic.md) (2 shared connections)
- [Broker Tradebook Synchronization](Broker_Tradebook_Synchronization.md) (1 shared connections)
- [SEO and Chat Components](SEO_and_Chat_Components.md) (1 shared connections)
- [Database Client and Migrations](Database_Client_and_Migrations.md) (1 shared connections)

## Source Files

- `packages/types/src/pubsub.ts`
- `scripts/ops/backfill-syncbucket.ts`

## Audit Trail

- EXTRACTED: 17 (100%)
- INFERRED: 0 (0%)
- AMBIGUOUS: 0 (0%)

---

*Part of the graphify knowledge wiki. See [index](index.md) to navigate.*