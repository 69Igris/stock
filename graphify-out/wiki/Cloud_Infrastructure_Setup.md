# Cloud Infrastructure Setup

> 11 nodes

## Key Concepts

- **setup-infra.sh** (9 connections) — `scripts/ops/setup-infra.sh`
- **setup-gcs-lifecycle.sh** (5 connections) — `scripts/ops/setup-gcs-lifecycle.sh`
- **setup-infra.sh script** (4 connections) — `scripts/ops/setup-infra.sh`
- **is_deploy_target()** (3 connections) — `scripts/ops/setup-infra.sh`
- **should_run()** (3 connections) — `scripts/ops/setup-infra.sh`
- **bucket_for()** (2 connections) — `scripts/ops/setup-gcs-lifecycle.sh`
- **setup-gcs-lifecycle.sh script** (2 connections) — `scripts/ops/setup-gcs-lifecycle.sh`
- **usage()** (2 connections) — `scripts/ops/setup-infra.sh`
- **FAILED** (1 connections) — `scripts/ops/setup-gcs-lifecycle.sh`
- **deploy_target_names()** (1 connections) — `scripts/ops/setup-infra.sh`
- **DEPLOY_TARGETS** (1 connections) — `scripts/ops/setup-infra.sh`

## Relationships

- [Database Migration Scripts](Database_Migration_Scripts.md) (2 shared connections)
- [Cloud Build Trigger Setup](Cloud_Build_Trigger_Setup.md) (1 shared connections)

## Source Files

- `scripts/ops/setup-gcs-lifecycle.sh`
- `scripts/ops/setup-infra.sh`

## Audit Trail

- EXTRACTED: 18 (100%)
- INFERRED: 0 (0%)
- AMBIGUOUS: 0 (0%)

---

*Part of the graphify knowledge wiki. See [index](index.md) to navigate.*