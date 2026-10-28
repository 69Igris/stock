# QA Sampling Plan Generator

> 30 nodes

## Key Concepts

- **src/ops/qa-sample-plan.ts** (16 connections) — `packages/core/src/ops/qa-sample-plan.ts`
- **qa-sample-plan.test.ts** (14 connections) — `packages/core/__tests__/market-data/qa-sample-plan.test.ts`
- **scripts/ops/qa-sample-plan.ts** (14 connections) — `scripts/ops/qa-sample-plan.ts`
- **main()** (5 connections) — `scripts/ops/qa-sample-plan.ts`
- **node:fs** (5 connections) — `node:fs`
- **assertPlanIsDeliberate()** (4 connections) — `packages/core/src/ops/qa-sample-plan.ts`
- **buildQuery()** (4 connections) — `packages/core/src/ops/qa-sample-plan.ts`
- **capUniverse()** (4 connections) — `packages/core/src/ops/qa-sample-plan.ts`
- **SampleUniverse** (3 connections) — `packages/core/src/ops/qa-sample-plan.ts`
- **SampleWindow** (3 connections) — `packages/core/src/ops/qa-sample-plan.ts`
- **node:path** (3 connections) — `node:path`
- **SAMPLE_PLAN** (3 connections) — `packages/core/src/ops/qa-sample-plan.ts`
- **estimateRows()** (2 connections) — `packages/core/src/ops/qa-sample-plan.ts`
- **universeFromManifest()** (2 connections) — `scripts/ops/qa-sample-plan.ts`
- **AllBound** (1 connections) — `packages/core/src/ops/qa-sample-plan.ts`
- **Bound** (1 connections) — `packages/core/src/ops/qa-sample-plan.ts`
- **IsinBound** (1 connections) — `packages/core/src/ops/qa-sample-plan.ts`
- **RecentBound** (1 connections) — `packages/core/src/ops/qa-sample-plan.ts`
- **SampleDescriptor** (1 connections) — `packages/core/src/ops/qa-sample-plan.ts`
- **SchemeBound** (1 connections) — `packages/core/src/ops/qa-sample-plan.ts`
- **SymbolBound** (1 connections) — `packages/core/src/ops/qa-sample-plan.ts`
- **Manifest** (1 connections) — `scripts/ops/qa-sample-plan.ts`
- **ManifestList** (1 connections) — `scripts/ops/qa-sample-plan.ts`
- **bashArray()** (1 connections) — `packages/core/__tests__/market-data/qa-sample-plan.test.ts`
- **node:url** (1 connections) — `node:url`
- *... and 5 more nodes in this community*

## Relationships

- [Screener Company Symbol Resolver](Screener_Company_Symbol_Resolver.md) (2 shared connections)
- [PubSub Enrichment Jobs](PubSub_Enrichment_Jobs.md) (2 shared connections)
- [Document Ingestion Query Selectors](Document_Ingestion_Query_Selectors.md) (1 shared connections)
- [XBRL Ratios Fallback Tests](XBRL_Ratios_Fallback_Tests.md) (1 shared connections)

## Source Files

- `node:fs`
- `node:path`
- `node:url`
- `packages/core/__tests__/market-data/qa-sample-plan.test.ts`
- `packages/core/src/ops/qa-sample-plan.ts`
- `scripts/ops/qa-sample-plan.ts`

## Audit Trail

- EXTRACTED: 52 (100%)
- INFERRED: 0 (0%)
- AMBIGUOUS: 0 (0%)

---

*Part of the graphify knowledge wiki. See [index](index.md) to navigate.*