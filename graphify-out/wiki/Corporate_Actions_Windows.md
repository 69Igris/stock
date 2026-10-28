# Corporate Actions Windows

> 92 nodes

## Key Concepts

- **corporate-actions-sync.ts** (43 connections) — `workers/src/processors/corporate-actions-sync.ts`
- **corporate-actions.service.ts** (32 connections) — `packages/services/src/corporate-actions.service.ts`
- **corp-actions-backfill.ts** (28 connections) — `scripts/jobs/corp-actions-backfill.ts`
- **corp-actions-window.ts** (23 connections) — `packages/research/src/data-sources/corp-actions-window.ts`
- **job-outcome-reachability-behaviour.test.ts** (20 connections) — `workers/__tests__/processors/job-outcome-reachability-behaviour.test.ts`
- **corporate-actions-isin-join.test.ts** (16 connections) — `workers/__tests__/processors/corporate-actions-isin-join.test.ts`
- **processCorporateActionsSync()** (15 connections) — `workers/src/processors/corporate-actions-sync.ts`
- **corp-actions-window.test.ts** (14 connections) — `packages/research/__tests__/corp-actions-window.test.ts`
- **corporate-actions-sync-logic.ts** (13 connections) — `workers/src/processors/corporate-actions-sync-logic.ts`
- **main()** (12 connections) — `scripts/jobs/corp-actions-backfill.ts`
- **corp-actions-chunked-fetch.test.ts** (12 connections) — `packages/research/__tests__/corp-actions-chunked-fetch.test.ts`
- **CorporateActionsSyncDeps** (10 connections) — `workers/src/processors/corporate-actions-sync.ts`
- **fetchBSECorporateActions()** (10 connections) — `packages/research/src/data-sources/bse-client.ts`
- **fetchInWindows()** (9 connections) — `packages/research/src/data-sources/corp-actions-window.ts`
- **fetchNSECorporateActionsBulkWindowed()** (9 connections) — `packages/research/src/data-sources/corp-actions-window.ts`
- **upsertCorporateActionsBulk()** (9 connections) — `packages/services/src/corporate-actions.service.ts`
- **upsertCorporateActions()** (8 connections) — `packages/services/src/corporate-actions.service.ts`
- **CorporateActionInput** (7 connections) — `packages/services/src/corporate-actions.service.ts`
- **toUtcDay()** (7 connections) — `packages/research/src/data-sources/corp-actions-window.ts`
- **buildIsinIndex()** (7 connections) — `workers/src/processors/corporate-actions-sync-logic.ts`
- **corpActionIsinKey()** (7 connections) — `workers/src/processors/corporate-actions-sync-logic.ts`
- **InstrumentIsinRow** (6 connections) — `workers/src/processors/corporate-actions-sync-logic.ts`
- **describeWindows()** (6 connections) — `packages/research/src/data-sources/corp-actions-window.ts`
- **bseActionToInput()** (6 connections) — `packages/services/src/corporate-actions.service.ts`
- **nseActionToInput()** (6 connections) — `packages/services/src/corporate-actions.service.ts`
- *... and 67 more nodes in this community*

## Relationships

- [NSE Corporate Filings Client](NSE_Corporate_Filings_Client.md) (21 shared connections)
- [BSE Announcements Client](BSE_Announcements_Client.md) (11 shared connections)
- [Database Script Safety Tests](Database_Script_Safety_Tests.md) (7 shared connections)
- [Admin Audit and Consent](Admin_Audit_and_Consent.md) (7 shared connections)
- [PubSub Message Handlers](PubSub_Message_Handlers.md) (4 shared connections)
- [Datadog Telemetry Metrics](Datadog_Telemetry_Metrics.md) (3 shared connections)
- [Worker Telemetry Log Flushing](Worker_Telemetry_Log_Flushing.md) (3 shared connections)
- [Content Access and Pagination](Content_Access_and_Pagination.md) (3 shared connections)
- [Database Client and Migrations](Database_Client_and_Migrations.md) (3 shared connections)
- [Stock Document Fetching Staleness](Stock_Document_Fetching_Staleness.md) (3 shared connections)
- [Gemini AI Client Integration](Gemini_AI_Client_Integration.md) (2 shared connections)
- [Vector Embeddings Service](Vector_Embeddings_Service.md) (2 shared connections)

## Source Files

- `packages/research/__tests__/corp-actions-chunked-fetch.test.ts`
- `packages/research/__tests__/corp-actions-window.test.ts`
- `packages/research/src/data-sources/bse-client.ts`
- `packages/research/src/data-sources/corp-actions-window.ts`
- `packages/services/src/corporate-actions.service.ts`
- `scripts/jobs/corp-actions-backfill.ts`
- `workers/__tests__/processors/corporate-actions-isin-join.test.ts`
- `workers/__tests__/processors/job-outcome-reachability-behaviour.test.ts`
- `workers/src/processors/corporate-actions-sync-logic.ts`
- `workers/src/processors/corporate-actions-sync.ts`

## Audit Trail

- EXTRACTED: 276 (100%)
- INFERRED: 1 (0%)
- AMBIGUOUS: 0 (0%)

---

*Part of the graphify knowledge wiki. See [index](index.md) to navigate.*