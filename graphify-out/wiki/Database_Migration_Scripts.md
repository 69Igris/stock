# Database Migration Scripts

> 25 nodes

## Key Concepts

- **Scripts Reference README** (42 connections) — `scripts/README.md`
- **backfill-user-isactive.ts** (6 connections) — `scripts/ops/backfill-user-isactive.ts`
- **backfill-pack-credits.ts** (5 connections) — `scripts/data/backfill-pack-credits.ts`
- **gen-chart-preload-manifest.ts** (5 connections) — `scripts/gen-chart-preload-manifest.ts`
- **update-prod-analysis-engine.sh** (5 connections) — `scripts/ops/update-prod-analysis-engine.sh`
- **set-dd-secret.sh** (4 connections) — `scripts/ops/datadog/set-dd-secret.sh`
- **update-prod-analysis-engine.sh script** (4 connections) — `scripts/ops/update-prod-analysis-engine.sh`
- **ENV_UPPER()** (3 connections) — `scripts/ops/update-prod-analysis-engine.sh`
- **get_db_url()** (3 connections) — `scripts/ops/update-prod-analysis-engine.sh`
- **creditsFromPayment()** (2 connections) — `scripts/data/backfill-pack-credits.ts`
- **main()** (2 connections) — `scripts/data/backfill-pack-credits.ts`
- **main()** (2 connections) — `scripts/gen-chart-preload-manifest.ts`
- **parsePreloadEntries()** (2 connections) — `scripts/gen-chart-preload-manifest.ts`
- **set-dd-secret.sh script** (2 connections) — `scripts/ops/datadog/set-dd-secret.sh`
- **trigger-resend-sync.sh** (2 connections) — `scripts/ops/trigger-resend-sync.sh`
- **should_run_step()** (2 connections) — `scripts/ops/update-prod-analysis-engine.sh`
- **PreloadEntry** (1 connections) — `scripts/gen-chart-preload-manifest.ts`
- **RawResult** (1 connections) — `scripts/ops/backfill-user-isactive.ts`
- **main()** (1 connections) — `scripts/ops/backfill-user-isactive.ts`
- **REPO_ROOT** (1 connections) — `scripts/gen-chart-preload-manifest.ts`
- **APPLY** (1 connections) — `scripts/ops/backfill-user-isactive.ts`
- **prisma** (1 connections) — `scripts/ops/backfill-user-isactive.ts`
- **CLOUDSDK_ACTIVE_CONFIG_NAME** (1 connections) — `scripts/ops/datadog/set-dd-secret.sh`
- **trigger-resend-sync.sh script** (1 connections) — `scripts/ops/trigger-resend-sync.sh`
- **Rollbacks README** (1 connections) — `scripts/data/rollbacks/README.md`

## Relationships

- [Monitoring and Log Scripts](Monitoring_and_Log_Scripts.md) (7 shared connections)
- [Database Client and Migrations](Database_Client_and_Migrations.md) (4 shared connections)
- [Resend Audience Segment Migration](Resend_Audience_Segment_Migration.md) (2 shared connections)
- [Document Recovery Pipeline](Document_Recovery_Pipeline.md) (2 shared connections)
- [Scheduler and Backfill Shell Scripts](Scheduler_and_Backfill_Shell_Scripts.md) (2 shared connections)
- [Cloud Infrastructure Setup](Cloud_Infrastructure_Setup.md) (2 shared connections)
- [Smoke Test Runner Harness](Smoke_Test_Runner_Harness.md) (2 shared connections)
- [Content Access and Pagination](Content_Access_and_Pagination.md) (1 shared connections)
- [Test Coverage Report Generator](Test_Coverage_Report_Generator.md) (1 shared connections)
- [Databento Data Harvesting](Databento_Data_Harvesting.md) (1 shared connections)
- [Feed Backfill Logic](Feed_Backfill_Logic.md) (1 shared connections)
- [XBRL Feed Archive Backfill](XBRL_Feed_Archive_Backfill.md) (1 shared connections)

## Source Files

- `scripts/README.md`
- `scripts/data/backfill-pack-credits.ts`
- `scripts/data/rollbacks/README.md`
- `scripts/gen-chart-preload-manifest.ts`
- `scripts/ops/backfill-user-isactive.ts`
- `scripts/ops/datadog/set-dd-secret.sh`
- `scripts/ops/trigger-resend-sync.sh`
- `scripts/ops/update-prod-analysis-engine.sh`

## Audit Trail

- EXTRACTED: 69 (99%)
- INFERRED: 1 (1%)
- AMBIGUOUS: 0 (0%)

---

*Part of the graphify knowledge wiki. See [index](index.md) to navigate.*