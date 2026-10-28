# Scripts Reference

All operational scripts for the UseMoney monorepo. Scripts are idempotent - safe
to re-run.

---

## Quick Reference

| Task                       | Command                                             |
| -------------------------- | --------------------------------------------------- |
| Full infra setup (QA)      | `./scripts/ops/setup-infra.sh qa`                   |
| Full infra setup (Prod)    | `./scripts/ops/setup-infra.sh prod`                 |
| Just push DB schema        | `./scripts/ops/setup-infra.sh qa --step 1`          |
| Just create Pub/Sub topics | `./scripts/ops/setup-infra.sh qa --step 2`          |
| Just update schedulers     | `./scripts/ops/setup-infra.sh qa --step 3`          |
| Steps 2-5 (skip db push)   | `./scripts/ops/setup-infra.sh qa --from 2`          |
| Deploy BOTH services       | `./scripts/ops/setup-infra.sh qa --only deploy`     |
| Deploy workers only        | `./scripts/ops/setup-infra.sh qa --only workers`    |
| EDGAR push subs only       | `./scripts/ops/setup-infra.sh qa --only edgar-push` |
| Seed all data (QA)         | `./scripts/seed-env.sh qa`                          |
| Seed specific step         | `./scripts/seed-env.sh qa --step 3`                 |
| Deploy workers (direct)    | `./workers/scripts/deploy.sh qa`                    |

---

## Orchestration Scripts

### `scripts/ops/setup-infra.sh` - Single-command infra setup

Runs all infrastructure steps for a given environment in order:

1. **Prisma db push** - syncs schema to MongoDB (fetches `DATABASE_URL` from GCP
   Secret Manager)
2. **Pub/Sub setup** - creates topics + push subscriptions (skips existing)
3. **Cloud Scheduler** - upserts all scheduler jobs
4. **Service deploys** - Cloud Build + Cloud Run, for BOTH deployables:
   `workers` and `us-fundamentals` (MONEY-979)
5. **EDGAR push subscriptions** - the seven `edgar-*-{env}-push` subscriptions,
   which need the Cloud Run URL step 4 mints

```bash
./scripts/ops/setup-infra.sh qa                  # Full QA setup (all 5 steps)
./scripts/ops/setup-infra.sh prod                # Full prod setup
./scripts/ops/setup-infra.sh qa --skip-deploy    # Steps 1-3 only, skip Cloud Build
./scripts/ops/setup-infra.sh qa --only db        # Only push schema
./scripts/ops/setup-infra.sh qa --only deploy    # Deploy BOTH services (+ step 5)
./scripts/ops/setup-infra.sh qa --only workers   # Deploy ONLY workers (no step 5)
./scripts/ops/setup-infra.sh qa --only us-fundamentals  # That one service (+ step 5)
./scripts/ops/setup-infra.sh qa --only edgar-push       # Just the 7 EDGAR push subs
./scripts/ops/setup-infra.sh qa --step 2         # Run only step 2 (pubsub)
./scripts/ops/setup-infra.sh qa --from 3         # Run steps 3-5
```

`--step` / `--from` take **1-5**. An out-of-range or non-numeric value exits 1
with usage — it used to match no step, run nothing, and still print
"Infrastructure Setup Complete!", which is a typo that reads as a successful
run.

**"Only" has one deliberate exception:** step 5 needs the URL that deploying
`us-fundamentals` mints, so anything that deploys it also runs step 5 —
`--step 4`, `--from 4`, `--only deploy` and `--only us-fundamentals` all run
steps 4 AND 5. `--only workers` does not, because nothing minted that URL.
`--skip-deploy` suppresses step 4 and therefore step 5 too.

**A cold environment is a two-phase bootstrap, and the banner says so.** On the
first run against an environment where `us-fundamentals-{env}` does not exist
yet, step 2 cannot create the seven EDGAR push subscriptions — their push
endpoint AND their OIDC audience are both that service's URL. It reports this
loudly and exits 0 so the ladder can continue to the deploy that mints the URL;
step 5 then attaches them. If a run ends with those subscriptions unattached the
closing banner reads **"Infrastructure Setup INCOMPLETE"** and names the command
that finishes it. That matters because a topic with NO subscription DROPS every
message silently — no DLQ, no error, no metric — while
`edgar-detect-minutely-{env}` publishes 1,440 times a day.

**Prerequisites:** gcloud CLI authenticated, GCP secrets configured. No local
Docker needed - deploy uses Cloud Build.

---

### `scripts/seed-env.sh` - Multi-environment database seeding

Runs the data seeding pipeline (instruments, MFs, sectors, prices, etc.):

```bash
./scripts/seed-env.sh qa              # Seed QA database (all steps)
./scripts/seed-env.sh prod            # Seed Production database
./scripts/seed-env.sh all             # Seed both
./scripts/seed-env.sh prod --step 3   # Run only step 3 (sectors)
./scripts/seed-env.sh prod --from 3   # Run steps 3 onwards
./scripts/seed-env.sh --url "mongodb+srv://..."  # Direct URL
```

**Steps:**

1. Instruments - Zerodha dump → InstrumentMapping (~8000 stocks + ETFs)
2. Mutual Funds - AMFI NAV feed → MutualFundMaster (~14,000 active schemes)
3. Sectors - Yahoo Finance → InstrumentMapping.sector + normalize
4. MF Metadata - `MF_METADATA_PROVIDER` (AMFI) → MutualFundMaster enrichment
5. Prices - Yahoo Finance → LatestQuote
6. Stock Ratios - Tickertape → StockRatios (~3-4 hours)
7. Stock Financials - Tickertape → StockFinancials (~4 hours)
8. Stock Profiles - Yahoo Finance → StockProfile (~3 hours)
9. MF Data - Tickertape → MF overview + holdings (~2 hours)
10. ETF Data - Yahoo Finance → ETF profiles (~30 min)

**Note:** Steps 6-10 are long-running. Use `--step` or `--from` for incremental
runs.

---

### `scripts/ops/setup-scheduler.sh` - Cloud Scheduler jobs

Creates or updates all Cloud Scheduler jobs for automated syncs:

```bash
./scripts/ops/setup-scheduler.sh qa       # QA schedulers only
./scripts/ops/setup-scheduler.sh prod     # Prod schedulers only
./scripts/ops/setup-scheduler.sh all      # Both environments
```

**Scheduler jobs created:**

| Job                        | Schedule                  | Topic                  | Description                                               |
| -------------------------- | ------------------------- | ---------------------- | --------------------------------------------------------- |
| instrument-sync-daily      | 10:00 PM IST daily        | instrument-sync        | Instrument master sync                                    |
| mf-sync-daily              | 10:30 PM IST daily        | mf-sync                | MF NAV sync (MutualFundMaster)                            |
| peers-sync-daily           | 11:15 PM IST daily        | peers-sync             | Rebuild derived stock_peers from our own data (both envs) |
| mf-nav-propagate-daily     | 11:45 PM IST daily        | mf-nav-propagate       | Propagate master NAV → user MF rows (both envs)           |
| mf-metadata-weekly         | Sun 9:00 PM IST           | mf-metadata-sync       | MF metadata enrichment                                    |
| sector-enrichment-weekly   | Sun 9:30 PM IST           | sector-enrichment      | Sector data enrichment                                    |
| price-sync-daily           | 11:00 PM IST Mon-Fri      | price-sync             | Daily price sync                                          |
| newsletter-publish-check   | Every 5 min               | newsletter-publish     | Scheduled newsletter check                                |
| credit-reservation-cleanup | Every 15 min              | l3-analysis            | L3 credit cleanup                                         |
| financial-data-sync-weekly | Sun 8:00 PM IST           | financial-data-sync    | Weekly financials sync                                    |
| ratios-sync-daily          | 11:30 PM IST Mon-Fri      | financial-data-sync    | Daily ratios sync                                         |
| news-sync-market-hours     | Every 2h 9AM-4PM Mon-Fri  | news-sync              | Market hours news sync                                    |
| filings-sync-weekly        | Sun 7:00 PM IST           | filings-sync           | Weekly filings sync                                       |
| chartink-strategy-monthly  | 1st of month 10:00 PM IST | chartink-strategy-sync | Monthly Chartink scrape                                   |
| intent-learning-daily      | 3:00 AM IST daily         | intent-learning        | AI classification learning                                |

**Behavior:** Deletes old-named jobs first, then creates with current config
(upsert pattern).

---

## Worker Scripts (`workers/scripts/`)

### `workers/scripts/setup-pubsub.sh` - Pub/Sub topics + subscriptions

Creates env-suffixed Pub/Sub topics and push subscriptions pointing to the Cloud
Run workers service — and, since MONEY-979, a SECOND group of seven
`edgar-*-{env}` topics whose push subscriptions target `us-fundamentals-{env}`
instead:

```bash
./workers/scripts/setup-pubsub.sh qa    # QA topics + subscriptions
./workers/scripts/setup-pubsub.sh prod  # Prod topics + subscriptions

# After us-fundamentals-{env} has been deployed, to attach the EDGAR subs and
# make a missing service a hard failure rather than a bootstrap stage:
EDGAR_PUSH_REQUIRED=1 ./workers/scripts/setup-pubsub.sh prod
```

**The exit code carries four states, not two:**

| State         | Exit | Meaning                                                                                                                               |
| ------------- | ---- | ------------------------------------------------------------------------------------------------------------------------------------- |
| COMPLETE      | 0    | Everything provisioned, EDGAR subscriptions attached                                                                                  |
| NOT YET BUILT | 0    | `us-fundamentals-{env}` genuinely does not exist. Loud, and the rest of the script still ran. `EDGAR_PUSH_REQUIRED=1` makes it exit 1 |
| BROKEN        | 1    | A create / update / IAM call whose own precondition held still failed                                                                 |
| UNKNOWN       | 1    | `gcloud run services describe` failed for a reason that is NOT "no such service"                                                      |

That last row is the one to know about. The absence check classifies on
gcloud's own `NOT_FOUND` / `Cannot find service` wording, never on an empty
string — expired credentials, the wrong project, a disabled `run.googleapis.com`
and a missing `run.services.get` all produce an empty URL too, and reporting
them as "the service is not built yet" prints seven LIVE production
subscriptions as `NOT CREATED` and exits 0.

**Topics created** (21 total, each suffixed with `-qa` or `-prod`):
trade-pairing, csv-import, broker-sync, instrument-sync, price-sync,
sector-enrichment, mf-sync, mf-metadata-sync, stock-research, document-process,
portfolio-roast, newsletter-publish, l3-analysis,
login-briefing, financial-data-sync, news-sync,
filings-sync, chartink-strategy-sync, intent-learning

**Behavior:** Skips existing topics/subscriptions, only creates new ones. Also
creates a dead-letter topic.

---

### `workers/scripts/deploy.sh` - Deploy workers to Cloud Run (local Docker)

Builds Docker image locally, pushes to GCR, deploys to Cloud Run. **Requires
local Docker.**

```bash
./workers/scripts/deploy.sh qa    # Deploy to QA
./workers/scripts/deploy.sh prod  # Deploy to Production
```

**Prefer `setup-infra.sh --only deploy`** which uses Cloud Build (no local
Docker needed).

---

### `workers/scripts/gcp-setup.sh` - One-time GCP setup

First-time setup: enables APIs, creates service account, grants IAM roles,
creates secrets:

```bash
./workers/scripts/gcp-setup.sh
```

**Run once per project.** Not needed for ongoing operations.

---

### `workers/scripts/build.sh` - Local Docker build

Builds the workers Docker image locally (for testing):

```bash
./workers/scripts/build.sh
```

---

### `workers/scripts/seed.sh` - DEPRECATED

**Deprecated.** Forwards to `scripts/seed-env.sh`. Use `seed-env.sh` directly.

---

## Seed Scripts (`scripts/seed-*.ts`)

Individual TypeScript seed scripts used by `seed-env.sh`. Can also be run
directly:

```bash
# Requires DATABASE_URL in env
DATABASE_URL="mongodb+srv://..." npx tsx scripts/seed/seed-instruments.ts
DATABASE_URL="mongodb+srv://..." npx tsx scripts/seed/seed-sectors.ts
```

| Script                     | Purpose                                                    |
| -------------------------- | ---------------------------------------------------------- |
| `seed-instruments.ts`      | Zerodha instrument dump → InstrumentMapping                |
| `seed-mf.ts`               | AMFI NAV feed → MutualFundMaster                           |
| `seed-sectors.ts`          | Yahoo Finance → sector data                                |
| `normalize-sectors.ts`     | Yahoo GICS → canonical NSE sector names                    |
| `seed-mf-metadata.ts`      | AMFI (via `MF_METADATA_PROVIDER`) → MF metadata enrichment |
| `seed-prices.ts`           | Yahoo Finance → LatestQuote                                |
| `seed-stock-ratios.ts`     | Tickertape → StockRatios                                   |
| `seed-stock-financials.ts` | Tickertape → StockFinancials                               |
| `seed-stock-profiles.ts`   | Yahoo Finance → StockProfile                               |
| `seed-mf-tickertape.ts`    | Tickertape → MF overview + holdings                        |
| `seed-etf-data.ts`         | Yahoo Finance → ETF profiles                               |
| `seed-glossary.ts`         | Seed glossary terms                                        |
| `seed-all.ts`              | Run all seeds sequentially                                 |

---

## Folder layout

Scripts are organized by lifecycle:

| Folder                | Purpose                                                                            |
| --------------------- | ---------------------------------------------------------------------------------- |
| `scripts/` (root)     | Top-level orchestrators (`seed-env.sh`, `tsconfig.json`)                           |
| `scripts/seed/`       | Initial data bootstrap - instruments, MFs, prices, stock docs                      |
| `scripts/migrations/` | One-off data migrations (plan IDs, entitlement backfill, Resend segment bootstrap) |
| `scripts/ops/`        | Ongoing operational tools - setup-infra, setup-scheduler, reconcile, test-env      |
| `scripts/data/`       | Enrichment / fix utilities - sectors, embeddings                                   |

---

## Migration / One-off Scripts

| Script                                           | Purpose                                                                  |
| ------------------------------------------------ | ------------------------------------------------------------------------ |
| `scripts/migrations/migrate-plan-ids.ts`         | Migrate subscription plan IDs (legacy → PREMIUM / QUERY_PACK)            |
| `scripts/migrations/migrate-resend-segments.ts`  | Bootstrap Resend segments (free/paid/downgraded/security) for all users  |
| `scripts/migrations/fix-premium-enddate.ts`      | Fix premium subscription end dates (one-off bug fix)                     |
| `scripts/migrations/backfill-pro-entitlement.ts` | Backfill pro plan entitlements                                           |
| `scripts/ops/reconcile-resend-segments.ts`       | On-demand cleanup: remove users from segments that don't match their sub |
| `scripts/data/fix-missing-sectors.ts`            | Backfill missing sector data                                             |
| `scripts/data/debug-sectors.ts`                  | Debug sector assignment issues                                           |
| `scripts/ops/update-prod-analysis-engine.sh`     | Update prod analysis engine config                                       |
| `scripts/ops/test-env.sh`                        | Test environment variable resolution (fetches QA secrets from GCP)       |

---

## Common Workflows

### New feature with DB schema changes

```bash
# 1. Edit packages/database/prisma/schema.prisma
# 2. Generate client locally
yarn workspace @usemoney/database prisma generate
# 3. Push to QA + setup infra
./scripts/ops/setup-infra.sh qa --skip-deploy
# 4. Test, then push to prod
./scripts/ops/setup-infra.sh prod
```

### Add a new worker job

```bash
# 1. Create processor: workers/src/processors/my-job.ts
# 2. Create route: workers/src/routes/my-job.ts
# 3. Register in workers/src/index.ts
# 4. Add topic to workers/scripts/setup-pubsub.sh (both arrays)
# 5. Add to packages/types/src/pubsub.ts PUBSUB_TOPICS
# 6. (Optional) Add scheduler to scripts/ops/setup-scheduler.sh
# 7. Deploy
./scripts/ops/setup-infra.sh qa
```

### Emergency: redeploy workers only

```bash
./workers/scripts/deploy.sh prod
# or without local Docker:
gcloud builds submit --config=workers/cloudbuild.prod.yaml
```

---

_Last Updated: March 2026_
