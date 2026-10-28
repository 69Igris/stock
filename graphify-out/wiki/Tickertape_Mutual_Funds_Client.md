# Tickertape Mutual Funds Client

> 21 nodes

## Key Concepts

- **cacheWrap()** (23 connections) — `packages/research/src/data-sources/cache.ts`
- **tickertape-mf-client.ts** (23 connections) — `packages/research/src/data-sources/tickertape-mf-client.ts`
- **fetchTickertapeMfHoldings()** (9 connections) — `packages/research/src/data-sources/tickertape-mf-client.ts`
- **fetchTickertapeMfOverview()** (9 connections) — `packages/research/src/data-sources/tickertape-mf-client.ts`
- **tickertape-mf-client-logic.ts** (9 connections) — `packages/research/src/data-sources/tickertape-mf-client-logic.ts`
- **resolveTickertapeMfSid()** (8 connections) — `packages/research/src/data-sources/tickertape-mf-client.ts`
- **fetchTickertapeMfPeers()** (7 connections) — `packages/research/src/data-sources/tickertape-mf-client.ts`
- **tickertape-mf-types.ts** (6 connections) — `packages/research/src/data-sources/tickertape-mf-types.ts`
- **seed-mf-tickertape.ts** (6 connections) — `scripts/seed/seed-mf-tickertape.ts`
- **delay()** (5 connections) — `packages/research/src/data-sources/tickertape-mf-client.ts`
- **MfOverview** (4 connections) — `packages/research/src/data-sources/tickertape-mf-types.ts`
- **MfHolding** (3 connections) — `packages/research/src/data-sources/tickertape-mf-types.ts`
- **MfPeer** (3 connections) — `packages/research/src/data-sources/tickertape-mf-types.ts`
- **mapMfHoldings()** (3 connections) — `packages/research/src/data-sources/tickertape-mf-client-logic.ts`
- **mapMfOverview()** (3 connections) — `packages/research/src/data-sources/tickertape-mf-client-logic.ts`
- **mapMfPeers()** (3 connections) — `packages/research/src/data-sources/tickertape-mf-client-logic.ts`
- **resolveSidFromSearch()** (3 connections) — `packages/research/src/data-sources/tickertape-mf-client-logic.ts`
- **main()** (3 connections) — `scripts/seed/seed-mf-tickertape.ts`
- **logger** (1 connections) — `packages/research/src/data-sources/tickertape-mf-client.ts`
- **mfSidCache** (1 connections) — `packages/research/src/data-sources/tickertape-mf-client.ts`
- **prisma** (1 connections) — `scripts/seed/seed-mf-tickertape.ts`

## Relationships

- [Tickertape Financial Data Client](Tickertape_Financial_Data_Client.md) (7 shared connections)
- [Chartink Technical Scans Library](Chartink_Technical_Scans_Library.md) (7 shared connections)
- [NSE Research Tools](NSE_Research_Tools.md) (6 shared connections)
- [Chartink Scanner and Caching](Chartink_Scanner_and_Caching.md) (5 shared connections)
- [Financial Data Source Fallbacks](Financial_Data_Source_Fallbacks.md) (5 shared connections)
- [Mutual Fund API Client](Mutual_Fund_API_Client.md) (2 shared connections)
- [Database Client and Migrations](Database_Client_and_Migrations.md) (1 shared connections)

## Source Files

- `packages/research/src/data-sources/cache.ts`
- `packages/research/src/data-sources/tickertape-mf-client-logic.ts`
- `packages/research/src/data-sources/tickertape-mf-client.ts`
- `packages/research/src/data-sources/tickertape-mf-types.ts`
- `scripts/seed/seed-mf-tickertape.ts`

## Audit Trail

- EXTRACTED: 83 (100%)
- INFERRED: 0 (0%)
- AMBIGUOUS: 0 (0%)

---

*Part of the graphify knowledge wiki. See [index](index.md) to navigate.*