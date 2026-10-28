# Database Sync Setup Scripts

> 11 nodes

## Key Concepts

- **sync-prod-to-qa.sh** (9 connections) — `scripts/ops/sync-prod-to-qa.sh`
- **sync-prod-to-qa.sh script** (6 connections) — `scripts/ops/sync-prod-to-qa.sh`
- **setup-sync-job.sh** (3 connections) — `scripts/ops/setup-sync-job.sh`
- **setup-sync-job.sh script** (2 connections) — `scripts/ops/setup-sync-job.sh`
- **upsert_feeds_trigger()** (2 connections) — `scripts/ops/setup-sync-job.sh`
- **build_sample_plan()** (2 connections) — `scripts/ops/sync-prod-to-qa.sh`
- **get_db_url()** (2 connections) — `scripts/ops/sync-prod-to-qa.sh`
- **mongo_skip_notice()** (2 connections) — `scripts/ops/sync-prod-to-qa.sh`
- **preflight()** (2 connections) — `scripts/ops/sync-prod-to-qa.sh`
- **relink_required()** (2 connections) — `scripts/ops/sync-prod-to-qa.sh`
- **mask_uri()** (1 connections) — `scripts/ops/sync-prod-to-qa.sh`

## Relationships

- [QA Universe Sample Generator](QA_Universe_Sample_Generator.md) (1 shared connections)

## Source Files

- `scripts/ops/setup-sync-job.sh`
- `scripts/ops/sync-prod-to-qa.sh`

## Audit Trail

- EXTRACTED: 17 (100%)
- INFERRED: 0 (0%)
- AMBIGUOUS: 0 (0%)

---

*Part of the graphify knowledge wiki. See [index](index.md) to navigate.*