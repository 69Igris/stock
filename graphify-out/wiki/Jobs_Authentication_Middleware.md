# Jobs Authentication Middleware

> 28 nodes

## Key Concepts

- **repo-root.ts** (19 connections) — `workers/__tests__/_support/repo-root.ts`
- **repoRoot()** (16 connections) — `workers/__tests__/_support/repo-root.ts`
- **index-auth-logic.ts** (10 connections) — `workers/src/index-auth-logic.ts`
- **auth-middleware.test.ts** (10 connections) — `workers/__tests__/auth-middleware.test.ts`
- **write-authority-and-perscheme.test.ts** (10 connections) — `workers/__tests__/processors/write-authority-and-perscheme.test.ts`
- **createJobsAuthMiddleware()** (7 connections) — `workers/src/index-auth-logic.ts`
- **repo-root.test.ts** (5 connections) — `workers/__tests__/_support/repo-root.test.ts`
- **JobsAuthContext** (3 connections) — `workers/src/index-auth-logic.ts`
- **shouldSkipHttpOidc()** (3 connections) — `workers/src/index-auth-logic.ts`
- **assertRepoRoot()** (3 connections) — `workers/__tests__/_support/repo-root.ts`
- **JobsAuthDeps** (2 connections) — `workers/src/index-auth-logic.ts`
- **header()** (2 connections) — `workers/src/index-auth-logic.ts`
- **.json()** (2 connections) — `workers/src/index-auth-logic.ts`
- **.verifyIdToken()** (2 connections) — `workers/src/index-auth-logic.ts`
- **declaresOwnRepoRootWalk()** (2 connections) — `workers/__tests__/_support/repo-root.ts`
- **DEPLOYED_ENVS** (2 connections) — `workers/src/index-auth-logic.ts`
- **LOCAL_ENVS** (2 connections) — `workers/src/index-auth-logic.ts`
- **REPO_ROOT_WALK_PATTERNS** (2 connections) — `workers/__tests__/_support/repo-root.ts`
- **OidcSkipInput** (1 connections) — `workers/src/index-auth-logic.ts`
- **ctx()** (1 connections) — `workers/__tests__/auth-middleware.test.ts`
- **readRepoFile()** (1 connections) — `workers/__tests__/auth-middleware.test.ts`
- **REPO_ROOT** (1 connections) — `workers/__tests__/auth-middleware.test.ts`
- **FIN_SYNC_LOGIC_PATH** (1 connections) — `workers/__tests__/processors/write-authority-and-perscheme.test.ts`
- **FIN_SYNC_PATH** (1 connections) — `workers/__tests__/processors/write-authority-and-perscheme.test.ts`
- **MF_SYNC** (1 connections) — `workers/__tests__/processors/write-authority-and-perscheme.test.ts`
- *... and 3 more nodes in this community*

## Relationships

- [PubSub Message Handlers](PubSub_Message_Handlers.md) (3 shared connections)
- [Worker Telemetry Log Flushing](Worker_Telemetry_Log_Flushing.md) (2 shared connections)
- [AMC Portfolio Web Scraping](AMC_Portfolio_Web_Scraping.md) (2 shared connections)
- [Alert Delivery Evaluation Logic](Alert_Delivery_Evaluation_Logic.md) (2 shared connections)
- [Intraday Bar Data Synchronization](Intraday_Bar_Data_Synchronization.md) (2 shared connections)
- [Macro Economic Series Data](Macro_Economic_Series_Data.md) (2 shared connections)
- [MF Portfolio Sync Validation](MF_Portfolio_Sync_Validation.md) (2 shared connections)
- [Stock Document Text Extraction](Stock_Document_Text_Extraction.md) (2 shared connections)
- [Recovery Backfill Tests](Recovery_Backfill_Tests.md) (2 shared connections)
- [Price Synchronization Processor](Price_Synchronization_Processor.md) (2 shared connections)
- [US EOD Data Synchronization](US_EOD_Data_Synchronization.md) (2 shared connections)
- [XBRL Projection Pipeline](XBRL_Projection_Pipeline.md) (2 shared connections)

## Source Files

- `workers/__tests__/_support/repo-root.test.ts`
- `workers/__tests__/_support/repo-root.ts`
- `workers/__tests__/auth-middleware.test.ts`
- `workers/__tests__/processors/write-authority-and-perscheme.test.ts`
- `workers/src/index-auth-logic.ts`

## Audit Trail

- EXTRACTED: 70 (100%)
- INFERRED: 0 (0%)
- AMBIGUOUS: 0 (0%)

---

*Part of the graphify knowledge wiki. See [index](index.md) to navigate.*