# Mutual Fund Performance Comparison

> 26 nodes

## Key Concepts

- **fund-comparison.service.ts** (25 connections) — `packages/services/src/fund-comparison.service.ts`
- **comparison-logic.ts** (16 connections) — `packages/services/src/comparison-logic.ts`
- **getMfNavHistory()** (6 connections) — `packages/core/src/market-data/prices/mf-nav-service.ts`
- **getComparisonData()** (6 connections) — `packages/services/src/fund-comparison.service.ts`
- **ComparisonData** (4 connections) — `packages/services/src/fund-comparison.service.ts`
- **ComparableFund** (4 connections) — `packages/types/src/comparison.ts`
- **buildNormalizedComparison()** (4 connections) — `packages/services/src/comparison-logic.ts`
- **NormalizedRow** (3 connections) — `packages/services/src/comparison-logic.ts`
- **rebaseSeriesTo100()** (3 connections) — `packages/services/src/comparison-logic.ts`
- **buildNavComparisonSeries()** (3 connections) — `packages/services/src/fund-comparison.service.ts`
- **fetchNavHistory()** (3 connections) — `packages/services/src/fund-comparison.service.ts`
- **src/comparison.ts** (3 connections) — `packages/types/src/comparison.ts`
- **NamedSeries** (2 connections) — `packages/services/src/comparison-logic.ts`
- **finite()** (2 connections) — `packages/services/src/comparison-logic.ts`
- **percentChange()** (2 connections) — `packages/services/src/comparison-logic.ts`
- **pickWinner()** (2 connections) — `packages/services/src/comparison-logic.ts`
- **rankInstruments()** (2 connections) — `packages/services/src/comparison-logic.ts`
- **seriesReturnPct()** (2 connections) — `packages/services/src/comparison-logic.ts`
- **fetchComparableFund()** (2 connections) — `packages/services/src/fund-comparison.service.ts`
- **RankableItem** (1 connections) — `packages/services/src/comparison-logic.ts`
- **RankedItem** (1 connections) — `packages/services/src/comparison-logic.ts`
- **RebasedPoint** (1 connections) — `packages/services/src/comparison-logic.ts`
- **SeriesPoint** (1 connections) — `packages/services/src/comparison-logic.ts`
- **ComparableAssetType** (1 connections) — `packages/types/src/comparison.ts`
- **isBest()** (1 connections) — `packages/services/src/comparison-logic.ts`
- *... and 1 more nodes in this community*

## Relationships

- [Fund Composition Extraction Logic](Fund_Composition_Extraction_Logic.md) (4 shared connections)
- [Content Access and Pagination](Content_Access_and_Pagination.md) (4 shared connections)
- [Admin Audit and Consent](Admin_Audit_and_Consent.md) (4 shared connections)
- [SEO and Chat Components](SEO_and_Chat_Components.md) (3 shared connections)
- [Mutual Fund NAV Service](Mutual_Fund_NAV_Service.md) (3 shared connections)
- [Market Discovery Positioning](Market_Discovery_Positioning.md) (2 shared connections)
- [Application Logging Framework](Application_Logging_Framework.md) (1 shared connections)
- [Database Client and Migrations](Database_Client_and_Migrations.md) (1 shared connections)
- [Content Metrics and Slugs](Content_Metrics_and_Slugs.md) (1 shared connections)

## Source Files

- `packages/core/src/market-data/prices/mf-nav-service.ts`
- `packages/services/src/comparison-logic.ts`
- `packages/services/src/fund-comparison.service.ts`
- `packages/types/src/comparison.ts`

## Audit Trail

- EXTRACTED: 62 (100%)
- INFERRED: 0 (0%)
- AMBIGUOUS: 0 (0%)

---

*Part of the graphify knowledge wiki. See [index](index.md) to navigate.*