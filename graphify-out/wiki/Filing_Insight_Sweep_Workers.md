# Filing Insight Sweep Workers

> 48 nodes

## Key Concepts

- **filing-insight-sweep.ts** (37 connections) — `workers/src/processors/filing-insight-sweep.ts`
- **filing-insight-sweep-logic.ts** (28 connections) — `workers/src/processors/filing-insight-sweep-logic.ts`
- **filing-insight-sweep-logic.test.ts** (22 connections) — `workers/__tests__/processors/filing-insight-sweep-logic.test.ts`
- **filing-insight-sweep.test.ts** (17 connections) — `workers/__tests__/processors/filing-insight-sweep.test.ts`
- **processFilingInsightSweep()** (14 connections) — `workers/src/processors/filing-insight-sweep.ts`
- **planInsightFanout()** (9 connections) — `workers/src/processors/filing-insight-sweep-logic.ts`
- **INSIGHT_STATUS** (8 connections) — `workers/src/processors/us-filing-insight-selectors-logic.ts`
- **isFilingInsightArmed()** (5 connections) — `workers/src/processors/filing-insight-sweep-logic.ts`
- **US_FILING_INSIGHT_APPLY_ENV** (5 connections) — `workers/src/processors/filing-insight-sweep-logic.ts`
- **SweepInsightRow** (4 connections) — `workers/src/processors/filing-insight-sweep-logic.ts`
- **ExistingInsight** (4 connections) — `workers/src/processors/us-filing-insight-logic.ts`
- **indexInsights()** (4 connections) — `workers/src/processors/filing-insight-sweep-logic.ts`
- **insightKey()** (4 connections) — `workers/src/processors/filing-insight-sweep-logic.ts`
- **planInsightReadChunks()** (4 connections) — `workers/src/processors/filing-insight-sweep-logic.ts`
- **resolveFanoutLimit()** (4 connections) — `workers/src/processors/filing-insight-sweep-logic.ts`
- **buildInsightCohortOrderBy()** (4 connections) — `workers/src/processors/us-filing-insight-selectors-logic.ts`
- **SWEEP_SCAN_CAP** (4 connections) — `workers/src/processors/filing-insight-sweep-logic.ts`
- **composeSkippedReason()** (3 connections) — `workers/src/processors/filing-insight-sweep.ts`
- **classifyFilingInsightMessage()** (3 connections) — `workers/src/processors/filing-insight-sweep-logic.ts`
- **isCoolingDown()** (3 connections) — `workers/src/processors/filing-insight-sweep-logic.ts`
- **FilingInsightSweepMessage** (2 connections) — `workers/src/processors/filing-insight-sweep.ts`
- **FanoutPlan** (2 connections) — `workers/src/processors/filing-insight-sweep-logic.ts`
- **errText()** (2 connections) — `workers/src/processors/filing-insight-sweep.ts`
- **parseFiledFrom()** (2 connections) — `workers/src/processors/filing-insight-sweep.ts`
- **truncationNote()** (2 connections) — `workers/src/processors/filing-insight-sweep.ts`
- *... and 23 more nodes in this community*

## Relationships

- [US Filing Insights Processor](US_Filing_Insights_Processor.md) (12 shared connections)
- [US Filing Insight Selectors](US_Filing_Insight_Selectors.md) (9 shared connections)
- [PubSub Message Handlers](PubSub_Message_Handlers.md) (8 shared connections)
- [PubSub Enrichment Jobs](PubSub_Enrichment_Jobs.md) (5 shared connections)
- [Datadog Telemetry Metrics](Datadog_Telemetry_Metrics.md) (3 shared connections)
- [Content Access and Pagination](Content_Access_and_Pagination.md) (2 shared connections)
- [Database Client and Migrations](Database_Client_and_Migrations.md) (2 shared connections)
- [US Filing Insight E2E Tests](US_Filing_Insight_E2E_Tests.md) (1 shared connections)

## Source Files

- `workers/__tests__/processors/filing-insight-sweep-logic.test.ts`
- `workers/__tests__/processors/filing-insight-sweep.test.ts`
- `workers/src/processors/filing-insight-sweep-logic.ts`
- `workers/src/processors/filing-insight-sweep.ts`
- `workers/src/processors/us-filing-insight-logic.ts`
- `workers/src/processors/us-filing-insight-selectors-logic.ts`

## Audit Trail

- EXTRACTED: 133 (100%)
- INFERRED: 0 (0%)
- AMBIGUOUS: 0 (0%)

---

*Part of the graphify knowledge wiki. See [index](index.md) to navigate.*