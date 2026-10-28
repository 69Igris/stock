# Filings Sync Background Job

> 18 nodes

## Key Concepts

- **processors/filings-sync.ts** (19 connections) — `workers/src/processors/filings-sync.ts`
- **processFilingsSync()** (10 connections) — `workers/src/processors/filings-sync.ts`
- **filings-sync-logic.ts** (10 connections) — `workers/src/processors/filings-sync-logic.ts`
- **routes/filings-sync.ts** (8 connections) — `workers/src/routes/filings-sync.ts`
- **needsSymbolDiscovery()** (4 connections) — `workers/src/processors/filings-sync-logic.ts`
- **buildFilingsDiscoveryWhere()** (3 connections) — `workers/src/processors/filings-sync-logic.ts`
- **computeHotTierCutoff()** (3 connections) — `workers/src/processors/filings-sync-logic.ts`
- **resolveFilingsSyncParams()** (3 connections) — `workers/src/processors/filings-sync-logic.ts`
- **FilingsSyncMessage** (2 connections) — `workers/src/processors/filings-sync.ts`
- **loadDiscoverySymbols()** (2 connections) — `workers/src/processors/filings-sync.ts`
- **filingsSyncRoute** (2 connections) — `workers/src/routes/filings-sync.ts`
- **Db** (1 connections) — `workers/src/processors/filings-sync.ts`
- **FilingsSyncDeps** (1 connections) — `workers/src/processors/filings-sync.ts`
- **FilingsSyncResult** (1 connections) — `workers/src/processors/filings-sync.ts`
- **FilingsSyncParams** (1 connections) — `workers/src/processors/filings-sync-logic.ts`
- **DEFAULT_FILINGS_BATCH_SIZE** (1 connections) — `workers/src/processors/filings-sync-logic.ts`
- **DEFAULT_FILINGS_DELAY_MS** (1 connections) — `workers/src/processors/filings-sync-logic.ts`
- **HOT_TIER_WINDOW_DAYS** (1 connections) — `workers/src/processors/filings-sync-logic.ts`

## Relationships

- [PubSub Message Handlers](PubSub_Message_Handlers.md) (5 shared connections)
- [Datadog Telemetry Metrics](Datadog_Telemetry_Metrics.md) (3 shared connections)
- [Stock Document Synchronization](Stock_Document_Synchronization.md) (3 shared connections)
- [Portfolio Roast Agent Pipeline](Portfolio_Roast_Agent_Pipeline.md) (2 shared connections)
- [PubSub Pull Subscription Workers](PubSub_Pull_Subscription_Workers.md) (2 shared connections)
- [Content Access and Pagination](Content_Access_and_Pagination.md) (1 shared connections)
- [Database Client and Migrations](Database_Client_and_Migrations.md) (1 shared connections)

## Source Files

- `workers/src/processors/filings-sync-logic.ts`
- `workers/src/processors/filings-sync.ts`
- `workers/src/routes/filings-sync.ts`

## Audit Trail

- EXTRACTED: 44 (98%)
- INFERRED: 1 (2%)
- AMBIGUOUS: 0 (0%)

---

*Part of the graphify knowledge wiki. See [index](index.md) to navigate.*