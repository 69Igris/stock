# ETF Expense Enrichment

> 6 nodes

## Key Concepts

- **processors/etf-expense-enrichment.ts** (12 connections) — `workers/src/processors/etf-expense-enrichment.ts`
- **fetchKuveraMetadata()** (6 connections) — `packages/core/src/market-data/instruments/mf-metadata-provider.ts`
- **processEtfExpenseEnrichment()** (5 connections) — `workers/src/processors/etf-expense-enrichment.ts`
- **isKuveraEnabled()** (4 connections) — `packages/core/src/market-data/instruments/mf-metadata-provider.ts`
- **sleep()** (2 connections) — `workers/src/processors/etf-expense-enrichment.ts`
- **RunResult** (1 connections) — `workers/src/processors/etf-expense-enrichment.ts`

## Relationships

- [Kuvera Mutual Fund Metadata](Kuvera_Mutual_Fund_Metadata.md) (4 shared connections)
- [Datadog Telemetry Metrics](Datadog_Telemetry_Metrics.md) (3 shared connections)
- [PubSub Message Handlers](PubSub_Message_Handlers.md) (3 shared connections)
- [Market Discovery Positioning](Market_Discovery_Positioning.md) (2 shared connections)
- [Content Access and Pagination](Content_Access_and_Pagination.md) (1 shared connections)
- [Database Client and Migrations](Database_Client_and_Migrations.md) (1 shared connections)
- [SEO and Chat Components](SEO_and_Chat_Components.md) (1 shared connections)
- [Content Metrics and Slugs](Content_Metrics_and_Slugs.md) (1 shared connections)

## Source Files

- `packages/core/src/market-data/instruments/mf-metadata-provider.ts`
- `workers/src/processors/etf-expense-enrichment.ts`

## Audit Trail

- EXTRACTED: 22 (96%)
- INFERRED: 1 (4%)
- AMBIGUOUS: 0 (0%)

---

*Part of the graphify knowledge wiki. See [index](index.md) to navigate.*