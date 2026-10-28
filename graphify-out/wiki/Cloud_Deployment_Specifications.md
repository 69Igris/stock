# Cloud Deployment Specifications

> 8 nodes

## Key Concepts

- **cloudbuild.prod.yaml** (4 connections) — `workers/cloudbuild.prod.yaml`
- **cloudbuild.qa.yaml** (4 connections) — `workers/cloudbuild.qa.yaml`
- **Re-pin Cloud Run Jobs Step** (1 connections) — `workers/cloudbuild.prod.yaml`
- **Service: stockbook-workers (Prod)** (1 connections) — `workers/cloudbuild.prod.yaml`
- **Service: tiingo-realtime-prod** (1 connections) — `workers/cloudbuild.prod.yaml`
- **Re-Pin Cloud Run Jobs Step** (1 connections) — `workers/cloudbuild.qa.yaml`
- **stockbook-workers-qa (Cloud Run Service)** (1 connections) — `workers/cloudbuild.qa.yaml`
- **tiingo-realtime-qa (Cloud Run Service)** (1 connections) — `workers/cloudbuild.qa.yaml`

## Relationships

- No strong cross-community connections detected

## Source Files

- `workers/cloudbuild.prod.yaml`
- `workers/cloudbuild.qa.yaml`

## Audit Trail

- EXTRACTED: 6 (86%)
- INFERRED: 1 (14%)
- AMBIGUOUS: 0 (0%)

---

*Part of the graphify knowledge wiki. See [index](index.md) to navigate.*