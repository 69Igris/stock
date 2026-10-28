# US Filing Insights Processor

> 44 nodes

## Key Concepts

- **processors/us-filing-insight.ts** (33 connections) — `workers/src/processors/us-filing-insight.ts`
- **us-filing-insight-logic.ts** (33 connections) — `workers/src/processors/us-filing-insight-logic.ts`
- **us-filing-insight-logic.test.ts** (26 connections) — `workers/__tests__/processors/us-filing-insight-logic.test.ts`
- **processUsFilingInsight()** (16 connections) — `workers/src/processors/us-filing-insight.ts`
- **CohortDocument** (9 connections) — `workers/src/processors/us-filing-insight-selectors-logic.ts`
- **decideInsightAction()** (9 connections) — `workers/src/processors/us-filing-insight-logic.ts`
- **FilingInsight** (7 connections) — `packages/core/src/market-data/filing-insight-logic.ts`
- **hasExtractedText()** (6 connections) — `workers/src/processors/us-filing-insight-selectors-logic.ts`
- **buildInsightFailureUpdate()** (5 connections) — `workers/src/processors/us-filing-insight-logic.ts`
- **buildInsightFailureWrite()** (5 connections) — `workers/src/processors/us-filing-insight-logic.ts`
- **filingTextPath()** (5 connections) — `workers/src/processors/us-filing-insight-logic.ts`
- **readSeamUsage()** (5 connections) — `workers/src/processors/us-filing-insight-logic.ts`
- **recordFailure()** (5 connections) — `workers/src/processors/us-filing-insight.ts`
- **buildInsightByDocumentWhere()** (5 connections) — `workers/src/processors/us-filing-insight-selectors-logic.ts`
- **isCohortDocument()** (5 connections) — `workers/src/processors/us-filing-insight-selectors-logic.ts`
- **SweepDocument** (4 connections) — `workers/src/processors/filing-insight-sweep-logic.ts`
- **FilingAnalyserNotWiredError** (4 connections) — `workers/src/processors/us-filing-insight-logic.ts`
- **FilingTextAnalyser** (4 connections) — `workers/src/processors/us-filing-insight-logic.ts`
- **FilingTextAnalysis** (4 connections) — `workers/src/processors/us-filing-insight-logic.ts`
- **buildInsightWrite()** (4 connections) — `workers/src/processors/us-filing-insight-logic.ts`
- **isUpstreamSeamFailure()** (4 connections) — `workers/src/processors/us-filing-insight-logic.ts`
- **notImplementedFilingAnalyser()** (4 connections) — `workers/src/processors/us-filing-insight-logic.ts`
- **upsertInsight()** (4 connections) — `workers/src/processors/us-filing-insight.ts`
- **SWEEP_ONLY_DOCUMENT_CLASS** (4 connections) — `workers/src/processors/us-filing-insight-selectors-logic.ts`
- **isSameKnownHash()** (3 connections) — `workers/src/processors/us-filing-insight-logic.ts`
- *... and 19 more nodes in this community*

## Relationships

- [US Filing Insight Selectors](US_Filing_Insight_Selectors.md) (13 shared connections)
- [Filing Insight Sweep Workers](Filing_Insight_Sweep_Workers.md) (12 shared connections)
- [US Filing Insight Analyzer](US_Filing_Insight_Analyzer.md) (8 shared connections)
- [Filing Insight Generation](Filing_Insight_Generation.md) (7 shared connections)
- [US Filing Insight E2E Tests](US_Filing_Insight_E2E_Tests.md) (4 shared connections)
- [PubSub Message Handlers](PubSub_Message_Handlers.md) (3 shared connections)
- [Vector Embeddings Service](Vector_Embeddings_Service.md) (3 shared connections)
- [Datadog Telemetry Metrics](Datadog_Telemetry_Metrics.md) (3 shared connections)
- [Gemini Filing Analysis](Gemini_Filing_Analysis.md) (2 shared connections)
- [Content Access and Pagination](Content_Access_and_Pagination.md) (1 shared connections)
- [Database Client and Migrations](Database_Client_and_Migrations.md) (1 shared connections)

## Source Files

- `packages/core/src/market-data/filing-insight-logic.ts`
- `workers/__tests__/processors/us-filing-insight-logic.test.ts`
- `workers/src/processors/filing-insight-sweep-logic.ts`
- `workers/src/processors/us-filing-insight-logic.ts`
- `workers/src/processors/us-filing-insight-selectors-logic.ts`
- `workers/src/processors/us-filing-insight.ts`

## Audit Trail

- EXTRACTED: 149 (100%)
- INFERRED: 0 (0%)
- AMBIGUOUS: 0 (0%)

---

*Part of the graphify knowledge wiki. See [index](index.md) to navigate.*