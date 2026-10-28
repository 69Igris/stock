# Instrument Series Readiness Validator

> 23 nodes

## Key Concepts

- **reclassify-instruments.ts** (19 connections) — `scripts/data/reclassify-instruments.ts`
- **main()** (9 connections) — `scripts/data/reclassify-instruments.ts`
- **series-readiness.ts** (7 connections) — `packages/core/src/market-data/series-readiness.ts`
- **series-readiness.test.ts** (7 connections) — `packages/core/__tests__/market-data/series-readiness.test.ts`
- **judgeSeriesReadiness()** (6 connections) — `packages/core/src/market-data/series-readiness.ts`
- **SeriesReadinessRow** (3 connections) — `packages/core/src/market-data/series-readiness.ts`
- **confirmWrite()** (3 connections) — `scripts/data/reclassify-instruments.ts`
- **maskedHost()** (3 connections) — `scripts/data/reclassify-instruments.ts`
- **parseArgs()** (3 connections) — `scripts/data/reclassify-instruments.ts`
- **SeriesReadiness** (2 connections) — `packages/core/src/market-data/series-readiness.ts`
- **normalise()** (2 connections) — `packages/core/src/market-data/series-readiness.ts`
- **assertKnownFlags()** (2 connections) — `scripts/data/reclassify-instruments.ts`
- **databaseUrlForEnv()** (2 connections) — `scripts/data/reclassify-instruments.ts`
- **recordProgress()** (2 connections) — `scripts/data/reclassify-instruments.ts`
- **Options** (1 connections) — `scripts/data/reclassify-instruments.ts`
- **PrismaLike** (1 connections) — `scripts/data/reclassify-instruments.ts`
- **many()** (1 connections) — `packages/core/__tests__/market-data/series-readiness.test.ts`
- **sourced()** (1 connections) — `packages/core/__tests__/market-data/series-readiness.test.ts`
- **stamped()** (1 connections) — `packages/core/__tests__/market-data/series-readiness.test.ts`
- **GROUPS** (1 connections) — `packages/core/__tests__/market-data/series-readiness.test.ts`
- **__dirname** (1 connections) — `scripts/data/reclassify-instruments.ts`
- **KNOWN_FLAGS** (1 connections) — `scripts/data/reclassify-instruments.ts`
- **RETYPE_CLASSES** (1 connections) — `scripts/data/reclassify-instruments.ts`

## Relationships

- [Market Discovery Positioning](Market_Discovery_Positioning.md) (4 shared connections)
- [Exchange Instrument Classification](Exchange_Instrument_Classification.md) (3 shared connections)
- [Database Client and Migrations](Database_Client_and_Migrations.md) (1 shared connections)
- [BSE Scrip Master Enrichment](BSE_Scrip_Master_Enrichment.md) (1 shared connections)
- [Vertex AI RAG Retrieval](Vertex_AI_RAG_Retrieval.md) (1 shared connections)
- [Database Script Safety Tests](Database_Script_Safety_Tests.md) (1 shared connections)

## Source Files

- `packages/core/__tests__/market-data/series-readiness.test.ts`
- `packages/core/src/market-data/series-readiness.ts`
- `scripts/data/reclassify-instruments.ts`

## Audit Trail

- EXTRACTED: 45 (100%)
- INFERRED: 0 (0%)
- AMBIGUOUS: 0 (0%)

---

*Part of the graphify knowledge wiki. See [index](index.md) to navigate.*