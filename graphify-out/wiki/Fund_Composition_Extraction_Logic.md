# Fund Composition Extraction Logic

> 41 nodes

## Key Concepts

- **fund-composition-service.ts** (28 connections) — `packages/core/src/market-data/instruments/fund-composition-service.ts`
- **instruments/fund-composition-logic.ts** (25 connections) — `packages/core/src/market-data/instruments/fund-composition-logic.ts`
- **fund-composition.service.ts** (19 connections) — `packages/services/src/fund-composition.service.ts`
- **extractComposition()** (11 connections) — `packages/core/src/market-data/instruments/fund-composition-service.ts`
- **getOrExtractComposition()** (11 connections) — `packages/core/src/market-data/instruments/fund-composition-service.ts`
- **getCompositionFromDb()** (9 connections) — `packages/core/src/market-data/instruments/fund-composition-service.ts`
- **CompositionResult** (6 connections) — `packages/core/src/market-data/instruments/fund-composition-service.ts`
- **isCompositionContentStale()** (6 connections) — `packages/core/src/market-data/instruments/fund-composition-logic.ts`
- **contentStaleReason()** (5 connections) — `packages/core/src/market-data/instruments/fund-composition-logic.ts`
- **decideCompositionPersist()** (5 connections) — `packages/core/src/market-data/instruments/fund-composition-logic.ts`
- **demoteContentStale()** (5 connections) — `packages/core/src/market-data/instruments/fund-composition-service.ts`
- **getFundComposition()** (5 connections) — `packages/services/src/fund-composition.service.ts`
- **ExtractedHolding** (4 connections) — `packages/core/src/market-data/instruments/fund-composition-logic.ts`
- **monthsBehindNow()** (4 connections) — `packages/core/src/market-data/instruments/fund-composition-logic.ts`
- **markFailed()** (4 connections) — `packages/core/src/market-data/instruments/fund-composition-service.ts`
- **persistComposition()** (4 connections) — `packages/core/src/market-data/instruments/fund-composition-service.ts`
- **toServiceData()** (4 connections) — `packages/services/src/fund-composition.service.ts`
- **triggerCompositionExtraction()** (4 connections) — `packages/services/src/fund-composition.service.ts`
- **buildExtractionPrompt()** (3 connections) — `packages/core/src/market-data/instruments/fund-composition-logic.ts`
- **isCompositionStale()** (3 connections) — `packages/core/src/market-data/instruments/fund-composition-logic.ts`
- **isExtractionLockHeld()** (3 connections) — `packages/core/src/market-data/instruments/fund-composition-logic.ts`
- **isFailedRetryDue()** (3 connections) — `packages/core/src/market-data/instruments/fund-composition-logic.ts`
- **parseGeminiResponse()** (3 connections) — `packages/core/src/market-data/instruments/fund-composition-logic.ts`
- **validateHoldings()** (3 connections) — `packages/core/src/market-data/instruments/fund-composition-logic.ts`
- **buildResultFromDb()** (3 connections) — `packages/core/src/market-data/instruments/fund-composition-service.ts`
- *... and 16 more nodes in this community*

## Relationships

- [Market Discovery Positioning](Market_Discovery_Positioning.md) (7 shared connections)
- [Fund Portfolio Composition Analysis](Fund_Portfolio_Composition_Analysis.md) (5 shared connections)
- [Content Access and Pagination](Content_Access_and_Pagination.md) (5 shared connections)
- [Mutual Fund Performance Comparison](Mutual_Fund_Performance_Comparison.md) (4 shared connections)
- [Research Agent Planning](Research_Agent_Planning.md) (4 shared connections)
- [Admin Audit and Consent](Admin_Audit_and_Consent.md) (4 shared connections)
- [Database Client and Migrations](Database_Client_and_Migrations.md) (1 shared connections)
- [Gemini Model Registry](Gemini_Model_Registry.md) (1 shared connections)
- [Content Metrics and Slugs](Content_Metrics_and_Slugs.md) (1 shared connections)
- [Application Logging Framework](Application_Logging_Framework.md) (1 shared connections)

## Source Files

- `packages/core/src/market-data/instruments/fund-composition-logic.ts`
- `packages/core/src/market-data/instruments/fund-composition-service.ts`
- `packages/services/src/fund-composition.service.ts`

## Audit Trail

- EXTRACTED: 117 (100%)
- INFERRED: 0 (0%)
- AMBIGUOUS: 0 (0%)

---

*Part of the graphify knowledge wiki. See [index](index.md) to navigate.*