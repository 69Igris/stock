# EDGAR CIK Enrichment

> 38 nodes

## Key Concepts

- **edgar-cik.ts** (20 connections) — `packages/core/src/market-data/instruments/edgar-cik.ts`
- **edgar-cik-logic.ts** (20 connections) — `packages/core/src/market-data/instruments/edgar-cik-logic.ts`
- **tiingo-instruments-logic.test.ts** (19 connections) — `packages/core/__tests__/market-data/tiingo-instruments-logic.test.ts`
- **us-cik-unmatched-report.ts** (14 connections) — `scripts/data/us-cik-unmatched-report.ts`
- **enrichUsInstrumentsWithCik()** (9 connections) — `packages/core/src/market-data/instruments/edgar-cik.ts`
- **fetchEdgarCompanyTickers()** (8 connections) — `packages/core/src/market-data/instruments/edgar-cik.ts`
- **planEdgarCikEnrichment()** (7 connections) — `packages/core/src/market-data/instruments/edgar-cik-logic.ts`
- **buildEdgarCikIndex()** (6 connections) — `packages/core/src/market-data/instruments/edgar-cik-logic.ts`
- **parseEdgarCompanyTickers()** (6 connections) — `packages/core/src/market-data/instruments/edgar-cik-logic.ts`
- **normaliseUsTicker()** (5 connections) — `packages/core/src/market-data/instruments/edgar-cik-logic.ts`
- **main()** (5 connections) — `scripts/data/us-cik-unmatched-report.ts`
- **classifyUsTickerShape()** (4 connections) — `packages/core/src/market-data/instruments/edgar-cik-logic.ts`
- **diagnoseEdgarFeed()** (4 connections) — `packages/core/src/market-data/instruments/edgar-cik-logic.ts`
- **isExchangeTestSymbol()** (4 connections) — `packages/core/src/market-data/instruments/edgar-cik-logic.ts`
- **padCik()** (4 connections) — `packages/core/src/market-data/instruments/edgar-cik-logic.ts`
- **measure()** (4 connections) — `scripts/data/us-cik-unmatched-report.ts`
- **TIINGO_SYNC_EXCHANGES** (4 connections) — `packages/core/src/market-data/instruments/tiingo-instruments-logic.ts`
- **EdgarTickerRow** (3 connections) — `packages/core/src/market-data/instruments/edgar-cik-logic.ts`
- **UsTickerShape** (3 connections) — `packages/core/src/market-data/instruments/edgar-cik-logic.ts`
- **edgarBackoffMs()** (3 connections) — `packages/core/src/market-data/instruments/edgar-cik.ts`
- **isEdgarCikEnrichDisabled()** (3 connections) — `packages/core/src/market-data/instruments/edgar-cik.ts`
- **toSecPreferredForm()** (3 connections) — `packages/core/src/market-data/instruments/edgar-cik-logic.ts`
- **toRawUsInstrument()** (3 connections) — `packages/core/src/market-data/instruments/tiingo-instruments-logic.ts`
- **UNMATCHED_SAMPLE_LIMIT** (3 connections) — `packages/core/src/market-data/instruments/edgar-cik-logic.ts`
- **US_EXCHANGE_PREFERENCE** (3 connections) — `packages/core/src/market-data/instruments/tiingo-instruments-logic.ts`
- *... and 13 more nodes in this community*

## Relationships

- [Market Discovery Positioning](Market_Discovery_Positioning.md) (20 shared connections)
- [Tiingo Instrument Ingestion](Tiingo_Instrument_Ingestion.md) (6 shared connections)
- [Tiingo EOD Data Client](Tiingo_EOD_Data_Client.md) (5 shared connections)
- [Bhavcopy Market Data Ingestion](Bhavcopy_Market_Data_Ingestion.md) (3 shared connections)
- [PubSub Enrichment Jobs](PubSub_Enrichment_Jobs.md) (2 shared connections)
- [Content Access and Pagination](Content_Access_and_Pagination.md) (2 shared connections)
- [Database Client and Migrations](Database_Client_and_Migrations.md) (2 shared connections)
- [Tiingo US News Ingestion](Tiingo_US_News_Ingestion.md) (1 shared connections)

## Source Files

- `packages/core/__tests__/market-data/tiingo-instruments-logic.test.ts`
- `packages/core/src/market-data/instruments/edgar-cik-logic.ts`
- `packages/core/src/market-data/instruments/edgar-cik.ts`
- `packages/core/src/market-data/instruments/tiingo-instruments-logic.ts`
- `scripts/data/us-cik-unmatched-report.ts`

## Audit Trail

- EXTRACTED: 116 (100%)
- INFERRED: 0 (0%)
- AMBIGUOUS: 0 (0%)

---

*Part of the graphify knowledge wiki. See [index](index.md) to navigate.*