# Instrument Master Seeder

> 24 nodes

## Key Concepts

- **processors/instrument-sync.ts** (16 connections) — `workers/src/processors/instrument-sync.ts`
- **RawInstrument** (15 connections) — `packages/core/src/market-data/instruments/types.ts`
- **ZerodhaInstrumentProvider** (14 connections) — `packages/core/src/market-data/instruments/zerodha-instruments.ts`
- **processInstrumentSync()** (11 connections) — `workers/src/processors/instrument-sync.ts`
- **NseMasterInstrumentProvider** (10 connections) — `packages/core/src/market-data/instruments/nse-master-instruments.ts`
- **instrument-sync-logic.ts** (8 connections) — `workers/src/processors/instrument-sync-logic.ts`
- **.fetchInstruments()** (6 connections) — `packages/core/src/market-data/instruments/nse-master-instruments.ts`
- **hasRecentSync()** (4 connections) — `packages/core/src/market-data/instruments/instrument-sync.ts`
- **seed-instruments.ts** (4 connections) — `scripts/seed/seed-instruments.ts`
- **.fetchMaster()** (3 connections) — `packages/core/src/market-data/instruments/nse-master-instruments.ts`
- **.mapToUpdate()** (3 connections) — `packages/core/src/market-data/instruments/nse-master-instruments.ts`
- **.mapToUpsert()** (3 connections) — `packages/core/src/market-data/instruments/nse-master-instruments.ts`
- **.mapToUpdate()** (3 connections) — `packages/core/src/market-data/instruments/zerodha-instruments.ts`
- **.mapToUpsert()** (3 connections) — `packages/core/src/market-data/instruments/zerodha-instruments.ts`
- **main()** (3 connections) — `scripts/seed/seed-instruments.ts`
- **capErrorsForLog()** (3 connections) — `workers/src/processors/instrument-sync-logic.ts`
- **resolveInstrumentSyncOptions()** (3 connections) — `workers/src/processors/instrument-sync-logic.ts`
- **shouldSkipRecentSync()** (3 connections) — `workers/src/processors/instrument-sync-logic.ts`
- **toRawInstrument()** (2 connections) — `packages/core/src/market-data/instruments/nse-master-instruments.ts`
- **RECENT_SYNC_WINDOW_HOURS** (2 connections) — `workers/src/processors/instrument-sync-logic.ts`
- **ResolvedInstrumentSyncOptions** (1 connections) — `workers/src/processors/instrument-sync-logic.ts`
- **.constructor()** (1 connections) — `packages/core/src/market-data/instruments/zerodha-instruments.ts`
- **DEFAULT_INSTRUMENT_EXCHANGES** (1 connections) — `workers/src/processors/instrument-sync-logic.ts`
- **INSTRUMENT_ERROR_LOG_CAP** (1 connections) — `workers/src/processors/instrument-sync-logic.ts`

## Relationships

- [Instrument Synchronization Sweeps](Instrument_Synchronization_Sweeps.md) (12 shared connections)
- [Market Discovery Positioning](Market_Discovery_Positioning.md) (6 shared connections)
- [Bhavcopy Market Data Ingestion](Bhavcopy_Market_Data_Ingestion.md) (6 shared connections)
- [Zerodha Instrument Classification](Zerodha_Instrument_Classification.md) (6 shared connections)
- [PubSub Message Handlers](PubSub_Message_Handlers.md) (3 shared connections)
- [Exchange Instrument Classification](Exchange_Instrument_Classification.md) (2 shared connections)
- [BSE Scrip Master Enrichment](BSE_Scrip_Master_Enrichment.md) (2 shared connections)
- [PubSub Pull Subscription Workers](PubSub_Pull_Subscription_Workers.md) (2 shared connections)
- [Tiingo Instrument Ingestion](Tiingo_Instrument_Ingestion.md) (1 shared connections)
- [SEO and Chat Components](SEO_and_Chat_Components.md) (1 shared connections)

## Source Files

- `packages/core/src/market-data/instruments/instrument-sync.ts`
- `packages/core/src/market-data/instruments/nse-master-instruments.ts`
- `packages/core/src/market-data/instruments/types.ts`
- `packages/core/src/market-data/instruments/zerodha-instruments.ts`
- `scripts/seed/seed-instruments.ts`
- `workers/src/processors/instrument-sync-logic.ts`
- `workers/src/processors/instrument-sync.ts`

## Audit Trail

- EXTRACTED: 80 (98%)
- INFERRED: 2 (2%)
- AMBIGUOUS: 0 (0%)

---

*Part of the graphify knowledge wiki. See [index](index.md) to navigate.*