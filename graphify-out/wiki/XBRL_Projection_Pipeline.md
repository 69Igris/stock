# XBRL Projection Pipeline

> 55 nodes

## Key Concepts

- **xbrl-projection-writer.ts** (47 connections) — `workers/src/processors/xbrl-projection-writer.ts`
- **xbrl-projection-writer.test.ts** (30 connections) — `workers/__tests__/processors/xbrl-projection-writer.test.ts`
- **processors/xbrl-projection.ts** (23 connections) — `workers/src/processors/xbrl-projection.ts`
- **processXbrlProjectionWrite()** (19 connections) — `workers/src/processors/xbrl-projection-writer.ts`
- **xbrl-projection-drain.ts** (15 connections) — `scripts/jobs/xbrl-projection-drain.ts`
- **toCroreDenominated()** (10 connections) — `packages/core/src/market-data/xbrl-projection.ts`
- **processXbrlProjection()** (10 connections) — `workers/src/processors/xbrl-projection.ts`
- **routes/xbrl-projection.ts** (9 connections) — `workers/src/routes/xbrl-projection.ts`
- **ownedFields()** (8 connections) — `packages/core/src/market-data/xbrl-projection.ts`
- **main()** (7 connections) — `scripts/jobs/xbrl-projection-drain.ts`
- **describeNoWriteReason()** (7 connections) — `workers/src/processors/xbrl-projection-writer.ts`
- **observeScale()** (7 connections) — `workers/src/processors/xbrl-projection-writer.ts`
- **XbrlProjectionWriteResult** (6 connections) — `workers/src/processors/xbrl-projection-writer.ts`
- **readFacts()** (6 connections) — `workers/src/processors/xbrl-projection-writer.ts`
- **isProjectionArmed()** (5 connections) — `workers/src/processors/xbrl-projection.ts`
- **ProjectionRefusal** (4 connections) — `packages/core/src/market-data/xbrl-projection.ts`
- **resolveApply()** (4 connections) — `workers/src/processors/xbrl-projection.ts`
- **countWithheldWrites()** (4 connections) — `workers/src/processors/xbrl-projection-writer.ts`
- **summariseWriteDoors()** (4 connections) — `workers/src/processors/xbrl-projection-writer.ts`
- **filing()** (4 connections) — `workers/__tests__/processors/xbrl-projection-writer.test.ts`
- **utc()** (4 connections) — `workers/__tests__/processors/xbrl-projection-writer.test.ts`
- **FilingRow** (3 connections) — `workers/src/processors/xbrl-projection-writer.ts`
- **dropPartialTrailingSymbol()** (3 connections) — `workers/src/processors/xbrl-projection-writer.ts`
- **listWriteDoors()** (3 connections) — `workers/src/processors/xbrl-projection-writer.ts`
- **writeOneStatement()** (3 connections) — `workers/src/processors/xbrl-projection-writer.ts`
- *... and 30 more nodes in this community*

## Relationships

- [XBRL Financial Projections](XBRL_Financial_Projections.md) (23 shared connections)
- [PubSub Message Handlers](PubSub_Message_Handlers.md) (7 shared connections)
- [Financial Ratio Extraction](Financial_Ratio_Extraction.md) (6 shared connections)
- [Market Discovery Positioning](Market_Discovery_Positioning.md) (5 shared connections)
- [Datadog Telemetry Metrics](Datadog_Telemetry_Metrics.md) (5 shared connections)
- [Content Access and Pagination](Content_Access_and_Pagination.md) (4 shared connections)
- [XBRL Unit Scale Detector](XBRL_Unit_Scale_Detector.md) (4 shared connections)
- [XBRL Projection Batch Drain](XBRL_Projection_Batch_Drain.md) (3 shared connections)
- [Financial Statements Reconciliation](Financial_Statements_Reconciliation.md) (3 shared connections)
- [Worker Telemetry Log Flushing](Worker_Telemetry_Log_Flushing.md) (3 shared connections)
- [XBRL Financial Ratio Arming](XBRL_Financial_Ratio_Arming.md) (3 shared connections)
- [Database Client and Migrations](Database_Client_and_Migrations.md) (3 shared connections)

## Source Files

- `packages/core/src/market-data/xbrl-projection.ts`
- `scripts/jobs/xbrl-projection-drain-logic.mts`
- `scripts/jobs/xbrl-projection-drain.ts`
- `workers/__tests__/processors/xbrl-projection-writer.test.ts`
- `workers/src/processors/xbrl-projection-writer.ts`
- `workers/src/processors/xbrl-projection.ts`
- `workers/src/routes/xbrl-projection.ts`

## Audit Trail

- EXTRACTED: 180 (98%)
- INFERRED: 3 (2%)
- AMBIGUOUS: 0 (0%)

---

*Part of the graphify knowledge wiki. See [index](index.md) to navigate.*