# Peer Stock Selection Logic

> 33 nodes

## Key Concepts

- **peers-sync.service.ts** (22 connections) — `packages/services/src/peers-sync.service.ts`
- **peer-selection-logic.ts** (14 connections) — `packages/core/src/market-data/instruments/peer-selection-logic.ts`
- **peer-selection-logic.test.ts** (12 connections) — `packages/core/__tests__/market-data/peer-selection-logic.test.ts`
- **hasRealSector()** (11 connections) — `packages/core/src/market-data/instruments/peer-selection-logic.ts`
- **SECTOR_SKIPPED** (9 connections) — `packages/core/src/market-data/instruments/sector-enrichment-logic.ts`
- **selectPeers()** (8 connections) — `packages/core/src/market-data/instruments/peer-selection-logic.ts`
- **mapWithConcurrency()** (8 connections) — `packages/services/src/concurrency-logic.ts`
- **syncStockPeers()** (8 connections) — `packages/services/src/peers-sync.service.ts`
- **indexUniverse()** (7 connections) — `packages/core/src/market-data/instruments/peer-selection-logic.ts`
- **peers-sync-service.test.ts** (6 connections) — `packages/services/__tests__/peers-sync-service.test.ts`
- **loadUniverse()** (5 connections) — `packages/services/src/peers-sync.service.ts`
- **concurrency-logic.ts** (5 connections) — `packages/services/src/concurrency-logic.ts`
- **PeerCandidate** (4 connections) — `packages/core/src/market-data/instruments/peer-selection-logic.ts`
- **marketCapDistance()** (4 connections) — `packages/core/src/market-data/instruments/peer-selection-logic.ts`
- **buildRatioLookup()** (4 connections) — `packages/services/src/peers-sync.service.ts`
- **symbolExchangeKey()** (4 connections) — `packages/services/src/peers-sync.service.ts`
- **SelectedPeer** (3 connections) — `packages/core/src/market-data/instruments/peer-selection-logic.ts`
- **groupKey()** (3 connections) — `packages/core/src/market-data/instruments/peer-selection-logic.ts`
- **MAX_PEERS** (3 connections) — `packages/core/src/market-data/instruments/peer-selection-logic.ts`
- **MIN_INDUSTRY_GROUP** (3 connections) — `packages/core/src/market-data/instruments/peer-selection-logic.ts`
- **concurrency-logic.test.ts** (3 connections) — `packages/services/__tests__/concurrency-logic.test.ts`
- **PeersSyncDeps** (2 connections) — `workers/src/processors/peers-sync.ts`
- **c()** (2 connections) — `packages/core/__tests__/market-data/peer-selection-logic.test.ts`
- **group()** (2 connections) — `packages/core/__tests__/market-data/peer-selection-logic.test.ts`
- **PEERS_SOURCE** (2 connections) — `packages/services/src/peers-sync.service.ts`
- *... and 8 more nodes in this community*

## Relationships

- [Market Discovery Positioning](Market_Discovery_Positioning.md) (11 shared connections)
- [Instrument Sector Enrichment](Instrument_Sector_Enrichment.md) (6 shared connections)
- [Market Sector Performance Aggregation](Market_Sector_Performance_Aggregation.md) (4 shared connections)
- [Admin Audit and Consent](Admin_Audit_and_Consent.md) (4 shared connections)
- [PubSub Message Handlers](PubSub_Message_Handlers.md) (2 shared connections)
- [Portfolio Holdings Grouping Logic](Portfolio_Holdings_Grouping_Logic.md) (2 shared connections)
- [Broker Account Sync Decisions](Broker_Account_Sync_Decisions.md) (2 shared connections)
- [Broker Tradebook Synchronization](Broker_Tradebook_Synchronization.md) (1 shared connections)
- [NSE Sector Taxonomy](NSE_Sector_Taxonomy.md) (1 shared connections)
- [Content Access and Pagination](Content_Access_and_Pagination.md) (1 shared connections)
- [Database Client and Migrations](Database_Client_and_Migrations.md) (1 shared connections)
- [Application Logging Framework](Application_Logging_Framework.md) (1 shared connections)

## Source Files

- `packages/core/__tests__/market-data/peer-selection-logic.test.ts`
- `packages/core/src/market-data/instruments/peer-selection-logic.ts`
- `packages/core/src/market-data/instruments/sector-enrichment-logic.ts`
- `packages/services/__tests__/concurrency-logic.test.ts`
- `packages/services/__tests__/peers-sync-service.test.ts`
- `packages/services/src/concurrency-logic.ts`
- `packages/services/src/peers-sync.service.ts`
- `workers/src/processors/peers-sync.ts`

## Audit Trail

- EXTRACTED: 99 (100%)
- INFERRED: 0 (0%)
- AMBIGUOUS: 0 (0%)

---

*Part of the graphify knowledge wiki. See [index](index.md) to navigate.*