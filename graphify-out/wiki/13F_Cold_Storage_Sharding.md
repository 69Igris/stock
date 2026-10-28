# 13F Cold Storage Sharding

> 39 nodes

## Key Concepts

- **cold-holdings.ts** (32 connections) — `packages/core/src/us-fundamentals/cold-holdings.ts`
- **us-fundamentals/index.ts** (26 connections) — `packages/core/src/us-fundamentals/index.ts`
- **cold-shard-empty.test.ts** (18 connections) — `packages/core/__tests__/us-fundamentals/cold-shard-empty.test.ts`
- **us-cold-store-gcs.ts** (11 connections) — `workers/src/lib/us-cold-store-gcs.ts`
- **UsHoldingRow** (9 connections) — `packages/core/src/us-fundamentals/types.ts`
- **readThirteenFColdShard()** (9 connections) — `packages/core/src/us-fundamentals/cold-holdings.ts`
- **decodeThirteenFShardDetailed()** (6 connections) — `packages/core/src/us-fundamentals/cold-holdings.ts`
- **getUsColdStore()** (6 connections) — `packages/core/src/us-fundamentals/cold-holdings.ts`
- **setUsColdStore()** (6 connections) — `packages/core/src/us-fundamentals/cold-holdings.ts`
- **UsColdStore** (5 connections) — `packages/core/src/us-fundamentals/cold-holdings.ts`
- **encodeThirteenFShard()** (5 connections) — `packages/core/src/us-fundamentals/cold-holdings.ts`
- **parseThirteenFShard()** (5 connections) — `packages/core/src/us-fundamentals/cold-holdings.ts`
- **UsColdStoreUnavailableError** (4 connections) — `packages/core/src/us-fundamentals/cold-holdings.ts`
- **initUsColdStore()** (4 connections) — `workers/src/lib/us-cold-store-gcs.ts`
- **DecodedThirteenFShard** (3 connections) — `packages/core/src/us-fundamentals/cold-holdings.ts`
- **buildThirteenFColdKey()** (3 connections) — `packages/core/src/us-fundamentals/cold-holdings.ts`
- **decodeThirteenFShard()** (3 connections) — `packages/core/src/us-fundamentals/cold-holdings.ts`
- **serializeThirteenFShard()** (3 connections) — `packages/core/src/us-fundamentals/cold-holdings.ts`
- **withDeadline()** (3 connections) — `packages/core/src/us-fundamentals/cold-holdings.ts`
- **US_COLD_REASON_SHARD_EMPTY** (3 connections) — `packages/core/src/us-fundamentals/cold-holdings.ts`
- **US_COLD_REASON_SHARD_UNPARSEABLE** (3 connections) — `packages/core/src/us-fundamentals/cold-holdings.ts`
- **US_COLD_TIMEOUT_MS** (3 connections) — `packages/core/src/us-fundamentals/cold-holdings.ts`
- **UsColdHoldingsOutcome** (2 connections) — `packages/core/src/us-fundamentals/cold-holdings.ts`
- **dateOrNull()** (2 connections) — `packages/core/src/us-fundamentals/cold-holdings.ts`
- **finite()** (2 connections) — `packages/core/src/us-fundamentals/cold-holdings.ts`
- *... and 14 more nodes in this community*

## Relationships

- [Insider Holdings Repository](Insider_Holdings_Repository.md) (9 shared connections)
- [EDGAR SEC Tag Repository](EDGAR_SEC_Tag_Repository.md) (8 shared connections)
- [US Cold Store Coverage](US_Cold_Store_Coverage.md) (5 shared connections)
- [Parquet Candle Cold Storage](Parquet_Candle_Cold_Storage.md) (4 shared connections)
- [PubSub Message Handlers](PubSub_Message_Handlers.md) (2 shared connections)
- [EDGAR Filing Coverage Reports](EDGAR_Filing_Coverage_Reports.md) (1 shared connections)
- [US 13F Filing Tools](US_13F_Filing_Tools.md) (1 shared connections)
- [EDGAR US Filings Acceptance](EDGAR_US_Filings_Acceptance.md) (1 shared connections)
- [Content Access and Pagination](Content_Access_and_Pagination.md) (1 shared connections)
- [Database Client and Migrations](Database_Client_and_Migrations.md) (1 shared connections)
- [Index Constituent Parsing](Index_Constituent_Parsing.md) (1 shared connections)
- [Storage Download Budget Manager](Storage_Download_Budget_Manager.md) (1 shared connections)

## Source Files

- `packages/core/__tests__/us-fundamentals/cold-shard-empty.test.ts`
- `packages/core/src/us-fundamentals/cold-holdings.ts`
- `packages/core/src/us-fundamentals/index.ts`
- `packages/core/src/us-fundamentals/types.ts`
- `workers/src/lib/us-cold-store-gcs.ts`

## Audit Trail

- EXTRACTED: 115 (100%)
- INFERRED: 0 (0%)
- AMBIGUOUS: 0 (0%)

---

*Part of the graphify knowledge wiki. See [index](index.md) to navigate.*