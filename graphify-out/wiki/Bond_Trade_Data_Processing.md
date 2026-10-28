# Bond Trade Data Processing

> 116 nodes

## Key Concepts

- **bond-master-logic.ts** (31 connections) — `packages/core/src/market-data/bond-master-logic.ts`
- **bond-eod-logic.ts** (30 connections) — `packages/core/src/market-data/bond-eod-logic.ts`
- **deals.ts** (30 connections) — `packages/core/src/market-data/deals.ts`
- **deals-backfill.ts** (23 connections) — `scripts/jobs/deals-backfill.ts`
- **parseDeliveryDate()** (22 connections) — `packages/core/src/market-data/delivery.ts`
- **delivery.ts** (19 connections) — `packages/core/src/market-data/delivery.ts`
- **parseCorporateBondReport()** (17 connections) — `packages/core/src/market-data/bond-master-logic.ts`
- **parseWdmList()** (17 connections) — `packages/core/src/market-data/bond-master-logic.ts`
- **parseBulkBlockDeals()** (15 connections) — `packages/core/src/market-data/deals.ts`
- **bond-master-logic.test.ts** (15 connections) — `packages/core/__tests__/market-data/bond-master-logic.test.ts`
- **bond-eod-logic.test.ts** (13 connections) — `packages/core/__tests__/market-data/bond-eod-logic.test.ts`
- **deals.test.ts** (13 connections) — `packages/core/__tests__/market-data/deals.test.ts`
- **parseCbmTrades()** (12 connections) — `packages/core/src/market-data/bond-eod-logic.ts`
- **parseSlbOpenPositions()** (12 connections) — `packages/core/src/market-data/deals.ts`
- **delivery.test.ts** (12 connections) — `packages/core/__tests__/market-data/delivery.test.ts`
- **parseWdmTrades()** (11 connections) — `packages/core/src/market-data/bond-eod-logic.ts`
- **main()** (11 connections) — `scripts/jobs/deals-backfill.ts`
- **bond-wdm-trades.test.ts** (11 connections) — `packages/core/__tests__/market-data/bond-wdm-trades.test.ts`
- **locateHeader()** (10 connections) — `packages/core/src/market-data/deals.ts`
- **normalizeBondIsin()** (9 connections) — `packages/core/src/market-data/bond-master-logic.ts`
- **exactDealKey()** (9 connections) — `packages/core/src/market-data/deals.ts`
- **bump()** (8 connections) — `packages/core/src/market-data/bond-master-logic.ts`
- **resolveLastTraded()** (8 connections) — `packages/core/src/market-data/bond-master-logic.ts`
- **parseSecBhavdataFull()** (8 connections) — `packages/core/src/market-data/delivery.ts`
- **bondNum()** (7 connections) — `packages/core/src/market-data/bond-master-logic.ts`
- *... and 91 more nodes in this community*

## Relationships

- [Market Discovery Positioning](Market_Discovery_Positioning.md) (36 shared connections)
- [Derivatives Bhavcopy Parsing](Derivatives_Bhavcopy_Parsing.md) (25 shared connections)
- [Bhavcopy Market Data Ingestion](Bhavcopy_Market_Data_Ingestion.md) (7 shared connections)
- [Stock Surveillance Flags](Stock_Surveillance_Flags.md) (6 shared connections)
- [EGR Bhavcopy Parser](EGR_Bhavcopy_Parser.md) (3 shared connections)
- [Worker Telemetry Log Flushing](Worker_Telemetry_Log_Flushing.md) (3 shared connections)
- [AMC Signal Validation Tests](AMC_Signal_Validation_Tests.md) (2 shared connections)
- [Feed Backfill Logic](Feed_Backfill_Logic.md) (2 shared connections)
- [NSE Corporate Filings Client](NSE_Corporate_Filings_Client.md) (2 shared connections)
- [Content Access and Pagination](Content_Access_and_Pagination.md) (1 shared connections)
- [Database Client and Migrations](Database_Client_and_Migrations.md) (1 shared connections)

## Source Files

- `packages/core/__tests__/market-data/bond-eod-logic.test.ts`
- `packages/core/__tests__/market-data/bond-master-logic.test.ts`
- `packages/core/__tests__/market-data/bond-wdm-trades.test.ts`
- `packages/core/__tests__/market-data/deals.test.ts`
- `packages/core/__tests__/market-data/delivery.test.ts`
- `packages/core/src/market-data/bond-eod-logic.ts`
- `packages/core/src/market-data/bond-master-logic.ts`
- `packages/core/src/market-data/deals.ts`
- `packages/core/src/market-data/delivery.ts`
- `scripts/jobs/deals-backfill.ts`
- `scripts/jobs/feed-parse.ts`

## Audit Trail

- EXTRACTED: 317 (98%)
- INFERRED: 5 (2%)
- AMBIGUOUS: 0 (0%)

---

*Part of the graphify knowledge wiki. See [index](index.md) to navigate.*