# Circulars Ingestion Processor

> 26 nodes

## Key Concepts

- **money1238-batch-d-signals.test.ts** (24 connections) — `workers/__tests__/processors/money1238-batch-d-signals.test.ts`
- **processors/circulars-sync.ts** (19 connections) — `workers/src/processors/circulars-sync.ts`
- **processCircularsSync()** (8 connections) — `workers/src/processors/circulars-sync.ts`
- **routes/circulars-sync.ts** (6 connections) — `workers/src/routes/circulars-sync.ts`
- **Circular** (4 connections) — `packages/core/src/market-data/circulars-logic.ts`
- **CircularsSyncDeps** (3 connections) — `workers/src/processors/circulars-sync.ts`
- **RunCounts** (2 connections) — `workers/src/processors/report-archive-sync-logic.ts`
- **istToday()** (2 connections) — `workers/src/processors/circulars-sync.ts`
- **toApiDate()** (2 connections) — `workers/src/processors/circulars-sync.ts`
- **spaces()** (2 connections) — `workers/__tests__/processors/money1238-batch-d-signals.test.ts`
- **stripComments()** (2 connections) — `workers/__tests__/processors/money1238-batch-d-signals.test.ts`
- **circularsSyncRoute** (2 connections) — `workers/src/routes/circulars-sync.ts`
- **CircularsSyncResult** (1 connections) — `workers/src/processors/circulars-sync.ts`
- **writeCirculars()** (1 connections) — `workers/src/processors/circulars-sync.ts`
- **badDateRow()** (1 connections) — `workers/__tests__/processors/money1238-batch-d-signals.test.ts`
- **blockAfter()** (1 connections) — `workers/__tests__/processors/money1238-batch-d-signals.test.ts`
- **capture()** (1 connections) — `workers/__tests__/processors/money1238-batch-d-signals.test.ts`
- **delegateThatFailsUpsert()** (1 connections) — `workers/__tests__/processors/money1238-batch-d-signals.test.ts`
- **delegateThatWorks()** (1 connections) — `workers/__tests__/processors/money1238-batch-d-signals.test.ts`
- **goodRow()** (1 connections) — `workers/__tests__/processors/money1238-batch-d-signals.test.ts`
- **issue()** (1 connections) — `workers/__tests__/processors/money1238-batch-d-signals.test.ts`
- **peersOk()** (1 connections) — `workers/__tests__/processors/money1238-batch-d-signals.test.ts`
- **read()** (1 connections) — `workers/__tests__/processors/money1238-batch-d-signals.test.ts`
- **logger** (1 connections) — `workers/src/processors/circulars-sync.ts`
- **HERE** (1 connections) — `workers/__tests__/processors/money1238-batch-d-signals.test.ts`
- *... and 1 more nodes in this community*

## Relationships

- [PubSub Message Handlers](PubSub_Message_Handlers.md) (6 shared connections)
- [Corporate Issues Logic](Corporate_Issues_Logic.md) (4 shared connections)
- [Regulatory Circulars Classification](Regulatory_Circulars_Classification.md) (3 shared connections)
- [Datadog Telemetry Metrics](Datadog_Telemetry_Metrics.md) (3 shared connections)
- [Report Family Backfill Registry](Report_Family_Backfill_Registry.md) (3 shared connections)
- [NSE Corporate Filings Client](NSE_Corporate_Filings_Client.md) (3 shared connections)
- [Market Discovery Positioning](Market_Discovery_Positioning.md) (2 shared connections)
- [Corporate Actions Windows](Corporate_Actions_Windows.md) (2 shared connections)
- [Content Access and Pagination](Content_Access_and_Pagination.md) (1 shared connections)
- [Database Client and Migrations](Database_Client_and_Migrations.md) (1 shared connections)

## Source Files

- `packages/core/src/market-data/circulars-logic.ts`
- `workers/__tests__/processors/money1238-batch-d-signals.test.ts`
- `workers/src/processors/circulars-sync.ts`
- `workers/src/processors/report-archive-sync-logic.ts`
- `workers/src/routes/circulars-sync.ts`

## Audit Trail

- EXTRACTED: 59 (100%)
- INFERRED: 0 (0%)
- AMBIGUOUS: 0 (0%)

---

*Part of the graphify knowledge wiki. See [index](index.md) to navigate.*