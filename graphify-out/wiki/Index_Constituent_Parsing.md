# Index Constituent Parsing

> 83 nodes

## Key Concepts

- **processors/index-constituent-sync.ts** (36 connections) — `workers/src/processors/index-constituent-sync.ts`
- **backfill-symbol-aliases.ts** (24 connections) — `scripts/data/backfill-symbol-aliases.ts`
- **downloadFile()** (17 connections) — `packages/storage/src/index.ts`
- **index-constituent-list.ts** (16 connections) — `packages/core/src/market-data/index-constituent-list.ts`
- **backfill-index-membership.ts** (14 connections) — `scripts/data/backfill-index-membership.ts`
- **symbol-alias-logic.ts** (13 connections) — `packages/core/src/market-data/symbol-alias-logic.ts`
- **symbol-alias-logic.test.ts** (12 connections) — `packages/core/__tests__/market-data/symbol-alias-logic.test.ts`
- **listFiles()** (11 connections) — `packages/storage/src/index.ts`
- **parseIndexConstituentList()** (10 connections) — `packages/core/src/market-data/index-constituent-list.ts`
- **collectObservations()** (10 connections) — `scripts/data/backfill-symbol-aliases.ts`
- **index-membership-logic.ts** (10 connections) — `packages/core/src/market-data/index-membership-logic.ts`
- **dateFromArchiveKey()** (9 connections) — `packages/core/src/market-data/feed-backfill-logic.ts`
- **resolveFromArchive()** (8 connections) — `workers/src/processors/index-constituent-sync.ts`
- **index-constituent-list.test.ts** (8 connections) — `packages/core/__tests__/market-data/index-constituent-list.test.ts`
- **index-membership-logic.test.ts** (8 connections) — `packages/core/__tests__/market-data/index-membership-logic.test.ts`
- **constituentKeyDate()** (7 connections) — `packages/core/src/market-data/index-constituent-list.ts`
- **main()** (7 connections) — `scripts/data/backfill-index-membership.ts`
- **main()** (7 connections) — `scripts/data/backfill-symbol-aliases.ts`
- **planMembershipUpdate()** (6 connections) — `packages/core/src/market-data/index-membership-logic.ts`
- **aliasGroupKey()** (6 connections) — `packages/core/src/market-data/symbol-alias-logic.ts`
- **buildSymbolSpans()** (6 connections) — `packages/core/src/market-data/symbol-alias-logic.ts`
- **mergeWithSeed()** (6 connections) — `packages/core/src/market-data/symbol-alias-logic.ts`
- **loadScripToIsin()** (6 connections) — `scripts/jobs/feed-parse.ts`
- **syncIndex()** (6 connections) — `workers/src/processors/index-constituent-sync.ts`
- **pickLatestConstituentKey()** (5 connections) — `packages/core/src/market-data/index-constituent-list.ts`
- *... and 58 more nodes in this community*

## Relationships

- [Market Discovery Positioning](Market_Discovery_Positioning.md) (35 shared connections)
- [Derivatives Bhavcopy Parsing](Derivatives_Bhavcopy_Parsing.md) (11 shared connections)
- [Storage Download Budget Manager](Storage_Download_Budget_Manager.md) (8 shared connections)
- [Bhavcopy Market Data Ingestion](Bhavcopy_Market_Data_Ingestion.md) (4 shared connections)
- [Feed Backfill Logic](Feed_Backfill_Logic.md) (3 shared connections)
- [Datadog Telemetry Metrics](Datadog_Telemetry_Metrics.md) (3 shared connections)
- [PubSub Message Handlers](PubSub_Message_Handlers.md) (3 shared connections)
- [Content Access and Pagination](Content_Access_and_Pagination.md) (3 shared connections)
- [Database Client and Migrations](Database_Client_and_Migrations.md) (3 shared connections)
- [RAG Document Enqueue Service](RAG_Document_Enqueue_Service.md) (2 shared connections)
- [Databento Data Harvesting](Databento_Data_Harvesting.md) (1 shared connections)
- [XBRL Feed Archive Backfill](XBRL_Feed_Archive_Backfill.md) (1 shared connections)

## Source Files

- `packages/core/__tests__/market-data/index-constituent-list.test.ts`
- `packages/core/__tests__/market-data/index-membership-logic.test.ts`
- `packages/core/__tests__/market-data/symbol-alias-logic.test.ts`
- `packages/core/src/market-data/feed-backfill-logic.ts`
- `packages/core/src/market-data/index-constituent-list.ts`
- `packages/core/src/market-data/index-membership-logic.ts`
- `packages/core/src/market-data/symbol-alias-logic.ts`
- `packages/storage/src/index.ts`
- `scripts/data/backfill-index-membership.ts`
- `scripts/data/backfill-symbol-aliases.ts`
- `scripts/jobs/feed-parse.ts`
- `workers/src/processors/index-constituent-sync.ts`

## Audit Trail

- EXTRACTED: 236 (100%)
- INFERRED: 1 (0%)
- AMBIGUOUS: 0 (0%)

---

*Part of the graphify knowledge wiki. See [index](index.md) to navigate.*