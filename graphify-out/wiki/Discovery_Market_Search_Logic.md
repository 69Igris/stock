# Discovery Market Search Logic

> 111 nodes

## Key Concepts

- **discover.service.ts** (94 connections) — `packages/services/src/discover.service.ts`
- **discover-logic.ts** (31 connections) — `packages/services/src/discover-logic.ts`
- **discover-sector-facets.test.ts** (30 connections) — `packages/services/__tests__/discover-sector-facets.test.ts`
- **singleFlight()** (25 connections) — `packages/core/src/cache/stale-while-error.ts`
- **rankGainers()** (9 connections) — `packages/services/src/discover-logic.ts`
- **fetchMoversFromQuotes()** (9 connections) — `packages/services/src/discover.service.ts`
- **fetchMoversFromSnapshot()** (9 connections) — `packages/services/src/discover.service.ts`
- **getDiscoverData()** (9 connections) — `packages/services/src/discover.service.ts`
- **buildSectorFacets()** (8 connections) — `packages/services/src/discover-logic.ts`
- **rankLosers()** (8 connections) — `packages/services/src/discover-logic.ts`
- **discover-summary.service.test.ts** (8 connections) — `packages/services/__tests__/discover-summary.service.test.ts`
- **finite()** (7 connections) — `packages/services/src/discover-logic.ts`
- **getDiscoverSummary()** (7 connections) — `packages/services/src/discover.service.ts`
- **getUniverseData()** (7 connections) — `packages/services/src/discover.service.ts`
- **richSearchInstruments()** (7 connections) — `packages/services/src/discover.service.ts`
- **toDiscoverStock()** (7 connections) — `packages/services/src/discover.service.ts`
- **dedupeDualListings()** (6 connections) — `packages/services/src/discover-logic.ts`
- **istDayKey()** (6 connections) — `packages/services/src/discover-logic.ts`
- **getCachedMovers()** (6 connections) — `packages/services/src/discover.service.ts`
- **getCachedUniverse()** (6 connections) — `packages/services/src/discover.service.ts`
- **discover-movers-freshness.test.ts** (6 connections) — `packages/services/__tests__/discover-movers-freshness.test.ts`
- **DiscoverStock** (5 connections) — `packages/services/src/discover.service.ts`
- **ScreenerServiceDeps** (5 connections) — `packages/services/src/screener.service.ts`
- **isAtlasSearchEnabled()** (5 connections) — `packages/core/src/search/atlas-gate.ts`
- **reportSearchFailure()** (5 connections) — `packages/core/src/search/atlas-gate.ts`
- *... and 86 more nodes in this community*

## Relationships

- [Content Access and Pagination](Content_Access_and_Pagination.md) (13 shared connections)
- [NSE Sector Taxonomy](NSE_Sector_Taxonomy.md) (11 shared connections)
- [Stock and Fund Screener](Stock_and_Fund_Screener.md) (9 shared connections)
- [Market Sector Performance Aggregation](Market_Sector_Performance_Aggregation.md) (7 shared connections)
- [Stale-While-Error Cache Utility](Stale-While-Error_Cache_Utility.md) (6 shared connections)
- [Atlas Search Circuit Gate](Atlas_Search_Circuit_Gate.md) (6 shared connections)
- [Admin Audit and Consent](Admin_Audit_and_Consent.md) (4 shared connections)
- [Content Metrics and Slugs](Content_Metrics_and_Slugs.md) (3 shared connections)
- [Risk and Portfolio Metrics](Risk_and_Portfolio_Metrics.md) (3 shared connections)
- [Portfolio Performance and PnL Aggregation](Portfolio_Performance_and_PnL_Aggregation.md) (2 shared connections)
- [Portfolio Holdings Grouping Logic](Portfolio_Holdings_Grouping_Logic.md) (2 shared connections)
- [Trading Position Calculations](Trading_Position_Calculations.md) (2 shared connections)

## Source Files

- `packages/core/src/cache/stale-while-error.ts`
- `packages/core/src/search/atlas-gate.ts`
- `packages/services/__tests__/discover-movers-freshness.test.ts`
- `packages/services/__tests__/discover-sector-facets.test.ts`
- `packages/services/__tests__/discover-summary.service.test.ts`
- `packages/services/__tests__/movers-source.test.ts`
- `packages/services/src/discover-logic.ts`
- `packages/services/src/discover.service.ts`
- `packages/services/src/risk.service.ts`
- `packages/services/src/screener.service.ts`

## Audit Trail

- EXTRACTED: 288 (99%)
- INFERRED: 4 (1%)
- AMBIGUOUS: 0 (0%)

---

*Part of the graphify knowledge wiki. See [index](index.md) to navigate.*