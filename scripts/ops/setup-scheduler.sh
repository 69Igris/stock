#!/bin/bash
# ============================================
# UseMoney - Cloud Scheduler Setup
# ============================================
# Creates (or recreates) Cloud Scheduler jobs for automated
# data syncs. Deletes any old-named jobs first to avoid duplicates.
#
# SCRAPE-ONCE-IN-PROD: external-data (scraping) jobs — listed in PROD_ONLY_JOBS
# below — are created ONLY for prod. On qa/local they are skipped AND any
# existing copy is deleted, so QA never hits third-party sources. QA gets the
# scraped reference data by copying it down from prod with
# `scripts/ops/sync-prod-to-qa.sh`. User/internal jobs run on every env.
#
# TWO KINDS OF SCHEDULE LIVE HERE:
#   1. Pub/Sub-targeted, per-env  — everything in SCHEDULER_DEFS. Name and topic
#      both get a `-${ENV}` suffix; one copy exists per environment. The SCHEDULE
#      is shared by both envs unless ENV_SCHEDULE_OVERRIDES says otherwise
#      (MONEY-1194 — QA consumes what prod produces, so a consumer job sometimes
#      has to run later on QA than on prod).
#   2. Cloud Run-targeted, singleton — the prod->QA raw-feed mirror. ONE Cloud
#      Run job (`sync-prod-to-qa-feeds`, no env suffix), TWO triggers:
#      `sync-prod-to-qa-feeds-eod` (21:15 IST Mon-Fri) and
#      `sync-prod-to-qa-feeds-daily` (00:45 IST). Both owned by the PROD pass.
#      See setup_feeds_sync_scheduler() for the full reasoning (MONEY-1156 /
#      MONEY-1194).
#
# Prerequisites:
#   - gcloud CLI installed and authenticated
#   - Pub/Sub topics created (workers/scripts/setup-pubsub.sh)
#
# Usage:
#   ./scripts/ops/setup-scheduler.sh qa        # Setup QA schedulers only
#   ./scripts/ops/setup-scheduler.sh prod      # Setup Production schedulers only
#   ./scripts/ops/setup-scheduler.sh all       # Setup both QA and Production
#   ./scripts/ops/setup-scheduler.sh prod seed # Setup prod + trigger one-time sector enrichment
# ============================================

set -e

TARGET=${1:-qa}
SEED=${2:-""}

if [ "$TARGET" != "qa" ] && [ "$TARGET" != "prod" ] && [ "$TARGET" != "all" ] && [ "$TARGET" != "local" ]; then
    echo "Usage: ./scripts/ops/setup-scheduler.sh [local|qa|prod|all] [seed]"
    echo ""
    echo "  local - No-op: local dev does not use Cloud Scheduler. Trigger jobs"
    echo "          manually via 'gcloud pubsub topics publish <topic>-local ...'"
    echo "          or via 'curl -X POST http://localhost:8081/jobs/<job>'"
    echo "  qa    - Setup QA schedulers only"
    echo "  prod  - Setup Production schedulers only"
    echo "  all   - Setup both QA and Production"
    echo "  seed  - (optional) Trigger one-time sector enrichment after setup"
    exit 1
fi

# Local mode: no Cloud Scheduler jobs needed.
# Local devs trigger work manually (gcloud publish or curl) when testing.
if [ "$TARGET" == "local" ]; then
    echo ""
    echo "╔════════════════════════════════════════════╗"
    echo "║  Cloud Scheduler Setup: local              ║"
    echo "╠════════════════════════════════════════════╣"
    echo "║  Local dev does not use Cloud Scheduler.   ║"
    echo "║  This is intentional - local should not    ║"
    echo "║  receive automated background triggers.    ║"
    echo "╚════════════════════════════════════════════╝"
    echo ""
    echo "To trigger a job manually against local pull subs:"
    echo "  gcloud pubsub topics publish mf-sync-local --message='{}'"
    echo ""
    echo "Or call the local worker HTTP endpoint directly:"
    echo "  curl -X POST http://localhost:8081/jobs/mf-sync \\"
    echo "    -H 'Content-Type: application/json' -d '{}'"
    echo ""
    exit 0
fi

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

PROJECT_ID="stock-book-483718"
REGION="asia-south1"

# ============================================
# prod->QA raw-feed mirror (Cloud Run job target) — MONEY-1085 / MONEY-1156
# ============================================
# `sync-prod-to-qa.sh --tier=feeds` rsyncs prod's archived raw exchange files
# (gs://…-prod/feeds/ -> gs://…-qa/feeds/) so QA can replay prod's exact
# bhavcopy / instrument-master bytes through its OWN ingest instead of scraping
# NSE/BSE. It touches no MongoDB collection, so nothing in QA is ever dropped.
#
# The tier, the Cloud Run job and this schedule were all implemented under
# MONEY-1085, but the only thing that created the schedule was
# `scripts/ops/setup-sync-job.sh` — a documented ONE-OFF that also rebuilds the
# container image via Cloud Build. Nobody re-ran it after the merge, so the
# trigger never existed in deployed infra and the mirror never ran once
# (MONEY-1156). Reconciling it from THIS script — the one the runbooks tell you
# to run, and the one `setup-infra.sh --only scheduler` delegates to — means the
# same drift cannot silently outlive the next scheduler pass.
#
# setup-sync-job.sh remains the sole owner of the IMAGE, the Cloud Run jobs and
# the least-privilege service account + IAM. This script only reconciles the
# trigger, so the two never fight over the same resource.
FEEDS_SYNC_JOB="sync-prod-to-qa-feeds"
FEEDS_SYNC_SCHED="sync-prod-to-qa-feeds-daily"
# 00:45 IST daily. Deliberately after prod's ENTIRE EOD chain — bhavcopy 21:00,
# instrument-sync 22:00, price-sync 23:00, price-backfill 23:15 — because those
# are the jobs that WRITE the archive. An earlier slot would mirror the previous
# trading day's files. Daily (not weekly, like the reference tier) because
# bhavcopy publishes daily. Kept identical to setup-sync-job.sh's FEEDS_SCHEDULE
# so whichever script runs last is a no-op on the other.
#
# MONEY-1194: this run is KEPT, but it is the CATCH-ALL, not the whole story.
# It is late enough for everything prod archives after the price files —
# report-archive-sync-night 21:45, instrument-sync 22:00, the NSE/api/* JSONs —
# and it is the only run on a Saturday/Sunday. What it CANNOT serve is a
# consumer that runs the same evening; see FEEDS_SYNC_SCHEDULE_EOD.
FEEDS_SYNC_SCHEDULE="45 0 * * *"
FEEDS_SYNC_DESC="MONEY-1085 nightly prod->QA raw-feed mirror (00:45 IST, after prod's whole EOD chain) - triggers Cloud Run job sync-prod-to-qa-feeds (--tier=feeds, GCS only, never touches Mongo). Catch-all for feeds prod archives after 21:15 (report-archive-night, instrument-sync, NSE JSONs). Singleton: prod-owned, not per-env."

# ── The SECOND execution: 21:15 IST Mon-Fri (MONEY-1194) ──
# The 00:45 slot above reasons ONLY about the PRODUCER. QA runs prod's identical
# EOD chain at prod's identical clock times, and the CONSUMER side was never in
# the picture — so for the highest-volume feed we have, the mirror landed
# 3h45m AFTER the consumer asked for it:
#
#   21:00 IST day D  prod bhavcopy-sync fetches + ARCHIVES day D's file
#   21:00 IST day D  QA bhavcopy-sync asks for day D's key — NOT MIRRORED YET
#   00:45 IST day D+1  the mirror finally copies it
#
# The key is date-stamped (`buildFeedArchiveKey` files a dated descriptor under
# feeds/{exchange}/{feed}/{YYYY}/{MM}/{basename-with-day-token}), so yesterday's
# object cannot satisfy today's request. Measured on QA 2026-08-13:
# replayHits=0 replayMisses=2 — a 100% miss rate on both exchanges, every
# weekday, silently, because a replay miss falls back to the exchange BY DESIGN.
#
# Contrast the BSE scrip master, which replays correctly: its descriptor passes
# no `date`, so it files under `current/` and the key never rotates.
#
# This execution slots BETWEEN prod's archive and QA's consume. It is the same
# idempotent `gcloud storage rsync -r` over the same `feeds/` prefix, minus
# `TIINGO/ws/` (MONEY-1309 — raw websocket ticks are deliberately not mirrored;
# sync-prod-to-qa.sh), so an extra run copies only that day's new objects —
# there is no "second mirror" to keep consistent, just one more tick of the
# same one. Mon-Fri only: the bhavcopy it exists to carry is a weekday file.
#
# BUDGET: 15 minutes, prod's 21:00 archive -> this 21:15 run -> QA's 21:30
# consume. The transfer itself is a handful of objects, but the rsync must LIST
# both sides first (~67k objects each as of 2026-08), so the wall clock is
# dominated by listing, not bytes. If that ever outgrows 15 min the symptom is
# NOT an error — it is QA silently going back to scraping, which is exactly what
# `feed.archive.replay.degraded` (MONEY-1194) now reports. Check the real
# duration with:
#   gcloud run jobs executions list --job=sync-prod-to-qa-feeds --region=asia-south1
FEEDS_SYNC_SCHED_EOD="sync-prod-to-qa-feeds-eod"
FEEDS_SYNC_SCHEDULE_EOD="15 21 * * 1-5"
FEEDS_SYNC_DESC_EOD="MONEY-1194 prod->QA raw-feed mirror, EOD pass (21:15 IST Mon-Fri) - runs BETWEEN prod's 21:00 bhavcopy archive and QA's 21:30 bhavcopy consume, which is the window the 00:45 nightly pass cannot serve (it lands 3h45m after QA asks). Same Cloud Run job, same idempotent rsync. Singleton: prod-owned, not per-env."
# Fallback identity only — the real one is read off the deployed job below. This
# is the least-privilege SA setup-sync-job.sh creates.
FEEDS_SYNC_SA_FALLBACK="sync-prod-to-qa@${PROJECT_ID}.iam.gserviceaccount.com"

# ============================================
# prod->QA MongoDB sync (Cloud Run job target) — MONEY-1184
# ============================================
# The DB twin of the feeds mirror above. `sync-prod-to-qa.sh` drops + restores
# QA's copy of the rate-limited-source collections (corporate_actions,
# stock_documents, ownership, financials, …) from prod, so QA never has to
# scrape NSE/BSE/Screener itself.
#
# WAS WEEKLY (`sync-prod-to-qa-weekly`, Sundays 05:00). Weekly meant QA drifted
# up to six days behind prod on every scraped collection, which is how QA came
# to hold 5,675 corporate actions against prod's 11,525 — 92 structural rows
# versus 5,150. Testing a chart feature on QA against a sixth of the data it
# will meet in prod is not a test.
#
# 01:00 IST, because it must land AFTER prod's whole EOD write chain, not
# during it: bhavcopy-sync 21:00 -> instrument-sync 22:00 -> feed-parse 22:35
# -> price-sync 23:00 -> peers-sync 23:15 -> fo-summary 23:30. Syncing mid-chain
# would copy a half-written night. It also sits after the 00:45 feeds mirror so
# the two never contend for QA.
DB_SYNC_JOB="sync-prod-to-qa"
DB_SYNC_SCHED="sync-prod-to-qa-daily"
DB_SYNC_SCHEDULE="0 1 * * *"
DB_SYNC_DESC="MONEY-1184 daily prod->QA MongoDB sync (01:00 IST, after prod's whole EOD chain and after the 00:45 feeds mirror) - triggers Cloud Run job sync-prod-to-qa. Replaces the weekly job, which left QA up to 6 days stale. Singleton: prod-owned, not per-env."
# The name the weekly schedule used. Removed by setup_db_sync_scheduler so the
# two can never both fire — a stale name that still runs is worse than none.
DB_SYNC_LEGACY_SCHED="sync-prod-to-qa-weekly"

# ============================================
# SEC EDGAR bulk feeds — MONEY-979
# ============================================
# The other members of the ":run" family. Like the feeds mirror and the DB
# sync above these target the Cloud Run Admin API rather than a Pub/Sub topic,
# for the reason that puts them in `jobs` at all: `submissions.zip` is
# 1,560,992,008 bytes and `companyfacts.zip` is 1,407,685,214 (measured, not
# documented). Streaming and iterating either is tens of minutes, against a
# Pub/Sub push ack deadline of 600s that cannot be raised.
#
# UNLIKE the feeds mirror, these are PER-ENV jobs (`-prod` suffix) and they are
# PROD-ONLY, so `setup_edgar_bulk_schedulers` skips-and-DELETES on qa rather
# than skipping quietly: a QA copy would run against SEC_EGRESS=off and fail
# every day, and QA receives the tables by copy anyway.
#
# ── WHY TWO TRIGGERS EACH, AND WHY 13:00 IST ────────────────────────────────
#
# SEC DOCUMENTS the bulk files as published "approximately 3:00 a.m. ET" but the
# MEASURED Last-Modified is 23:49 / 23:57 ET the PREVIOUS day. The two disagree
# by three hours in the direction that matters, so the schedule is deliberately
# NOT pinned to either: 13:00 IST is 03:30 ET, comfortably after both, and the
# jobs COMPARE Last-Modified/ETag against the `bulk:<feed>` cursor rather than
# trusting any clock. An unchanged file is a named `NOT_YET_PUBLISHED` outcome
# that exits 0 having downloaded nothing.
#
# That is exactly what makes a second daily attempt cheap: the 16:00 IST retry
# costs one HEAD request on a normal day, and on a day SEC published late it is
# the difference between a fresh ledger and a 24-hour hole. Same reasoning as
# `report-archive-sync`'s 19:30 + 21:45 pair — the first pass catches the prompt
# publisher, the second catches the late one.
#
# The 20-minute stagger between the two feeds is not decoration: they are the
# two largest downloads in the project and running them concurrently would put
# ~3 GB through one egress path while both compete for the same SEC fair-access
# budget, which has no header to consult and answers overuse with a block.
EDGAR_SUBMISSIONS_JOB="edgar-bulk-submissions"
EDGAR_SUBMISSIONS_SCHED_PRIMARY="edgar-bulk-submissions-daily"
EDGAR_SUBMISSIONS_SCHEDULE_PRIMARY="0 13 * * *"
EDGAR_SUBMISSIONS_DESC_PRIMARY="MONEY-979 SEC bulk submissions.zip (13:00 IST = 03:30 ET, after SEC's documented 03:00 ET AND its measured 23:5x ET the prior day) - seeds us_filings + us_filers for EVERY form, the authoritative ledger the minutely detect loop is reconciled against. HEAD-compares Last-Modified/ETag first; unchanged exits 0 NOT_YET_PUBLISHED."
EDGAR_SUBMISSIONS_SCHED_RETRY="edgar-bulk-submissions-retry"
EDGAR_SUBMISSIONS_SCHEDULE_RETRY="0 16 * * *"
EDGAR_SUBMISSIONS_DESC_RETRY="MONEY-979 SEC bulk submissions.zip - SECOND pass (16:00 IST). SEC's documented publish time (03:00 ET) and its measured Last-Modified (23:5x ET prior day) disagree by 3h, so a late publication is a real state. Costs one HEAD on a normal day because the cursor comparison short-circuits."
EDGAR_COMPANYFACTS_JOB="edgar-bulk-companyfacts"
EDGAR_COMPANYFACTS_SCHED_PRIMARY="edgar-bulk-companyfacts-daily"
EDGAR_COMPANYFACTS_SCHEDULE_PRIMARY="20 13 * * *"
EDGAR_COMPANYFACTS_DESC_PRIMARY="MONEY-979 SEC bulk companyfacts.zip (13:20 IST) - entity-wide XBRL facts to the GCS cold shards + us_company_facts + as-reported us_fundamentals. Staggered 20 min behind submissions: the two are the largest downloads in the project (~3GB combined) and share one SEC fair-access budget with no quota header to consult."
EDGAR_COMPANYFACTS_SCHED_RETRY="edgar-bulk-companyfacts-retry"
EDGAR_COMPANYFACTS_SCHEDULE_RETRY="20 16 * * *"
EDGAR_COMPANYFACTS_DESC_RETRY="MONEY-979 SEC bulk companyfacts.zip - SECOND pass (16:20 IST), holding the same 20-min stagger behind the submissions retry. Same Last-Modified/ETag short-circuit, so a no-op day costs one HEAD."

# ── Fails-to-Deliver — MONEY-979 T17 ────────────────────────────────────────
#
# The THIRD member of the `:run` family, and the one that had no trigger at all:
# `edgar-bulk-ftd` shipped as a Cloud Run job that only ever ran by hand, while
# the tier it feeds — SEC_FTD in `us_cusip_map` — is the one that resolves the
# CUSIPs the 13D/G and FIGI tiers miss. An unfed tier reports "unavailable"
# forever, which is a third value distinct from "tried and found nothing"
# precisely so this state is visible; it was visible, and nothing acted on it.
#
# ── WHY FOUR RUNS A MONTH FOR A TWICE-MONTHLY FEED ──────────────────────────
#
# SEC publishes half-month files: the first half of a month at roughly month
# end, the second half at roughly the 15th of the FOLLOWING month. "Roughly" is
# the operative word and it cannot be tightened, because there is no
# date-templated URL to aim at: the index page is the only discovery source and
# it carries 410 `cnsfails*.zip` links spread over FOUR directories, two of them
# with a `_0` suffix, so a URL built from a date is wrong for 201 of the 410.
#
# The asymmetry decides the cadence. The job is CHECKPOINTED PER PERIOD, so a
# re-run costs one index-page fetch plus only the periods not already recorded —
# roughly nothing. Missing a publication, by contrast, leaves the tier a
# fortnight stale and every 13F holding of an affected issuer symbol-less for
# that long. Over-running is cheap, under-running is not, so the schedule runs
# four times a month rather than trying to hit two publication days exactly.
#
# 19:00 IST = 08:30 ET (EST) / 09:30 ET (EDT). Deliberately NOT in the 13:00-16:20
# IST band the other two bulk jobs occupy: `submissions` has a 3h task timeout and
# `companyfacts` a 6h one, so both can still be streaming their ~1.5 GB when a
# 14:00 slot would fire. FTD's own egress is negligible by comparison — one index
# page plus ~2 files a month at ~1.6 MB each — so the separation is about not
# queueing behind them, not about bandwidth.
EDGAR_FTD_JOB="edgar-bulk-ftd"
EDGAR_FTD_SCHED_PRIMARY="edgar-bulk-ftd-semimonthly"
EDGAR_FTD_SCHEDULE_PRIMARY="0 19 3,18 * *"
EDGAR_FTD_DESC_PRIMARY="MONEY-979 SEC Fails-to-Deliver ingest (19:00 IST on the 3rd and 18th) - fills the SEC_FTD tier of us_cusip_map, the one that resolves CUSIPs the 13D/G and FIGI tiers miss. SEC publishes twice a month, first half at ~month end and second half at ~the 15th, so these two days sit a few days past each. Checkpointed per period: a repeat costs one index page and re-fetches nothing."
EDGAR_FTD_SCHED_RETRY="edgar-bulk-ftd-retry"
EDGAR_FTD_SCHEDULE_RETRY="0 19 10,25 * *"
EDGAR_FTD_DESC_RETRY="MONEY-979 SEC Fails-to-Deliver ingest - SECOND pass (19:00 IST on the 10th and 25th). The index page is the only discovery source (410 cnsfails zips across four directories, no date-templated URL to time a schedule against), so an exact publication day cannot be targeted. Over-running is cheap and under-running loses coverage, so it runs four times a month."
# Matches the --service-account in scripts/ops/setup-us-fundamentals-jobs.sh.
# Used ONLY when the deployed job reports no explicit SA (a job created without
# one runs as the project default compute SA, which we do not want minting OIDC
# tokens).
EDGAR_BULK_SA_FALLBACK="stockbook-api@${PROJECT_ID}.iam.gserviceaccount.com"

# ── Databento daily append — MONEY-1373 ─────────────────────────────────────
#
# 15:00 IST AND NOT 13:00, and the three hours are the whole point.
#
# Databento publishes a US session under a T+1 embargo: the prior session
# becomes available around 09:00 UTC, which is 14:30 IST. A 13:00 IST trigger
# would ask for a session that does not exist yet and receive an EMPTY RESULT —
# indistinguishable from a market holiday, from a symbol list that resolved to
# nothing, and from a broken query. The job also reads
# `metadata.get_dataset_range` before every append and clamps the gap to it, so
# a vendor running late produces a NAMED skip (`NOT_YET_PUBLISHED`) rather than
# a purchase of nothing — the cron is the cheap half of that guard, not the
# whole of it.
#
# TUE-SAT, not Mon-Fri. A US session closes 16:00 ET, which is after midnight
# IST on the FOLLOWING day, so Monday's US session is appended on Tuesday IST
# and Friday's on Saturday. A Mon-Fri cron would append Friday's session on the
# following Monday, three days late, and would fire on a Monday with nothing to
# do.
#
# The retry exists because a late publication is a real state, not a fault. On a
# normal evening the 18:00 run computes UP_TO_DATE from one free
# `metadata.get_dataset_range` call and exits 0 having spent nothing.
DATABENTO_APPEND_JOB="databento-append"
DATABENTO_APPEND_SCHED_PRIMARY="databento-append-daily"
# ── Tile builder — MONEY-1467 (data-platform A2) ────────────────────────────
#
# THE TIME IS THE WHOLE POINT, AND THE BRIEF GOT IT WRONG. A2 specifies 19:45
# IST "after bhavcopy-sync". `bhavcopy-sync-daily` runs at 21:00 IST on prod
# (`0 21 * * 1-5`), so 19:45 is SEVENTY-FIVE MINUTES EARLY: every weekday build
# would read the previous session and write a tile that is valid, complete,
# internally consistent and one session stale — with nothing in its output to
# say so. That is MONEY-1194 exactly.
#
# PER-ENV TIMES, for the same reason MONEY-1194 gave `bhavcopy-sync-daily` one.
# QA does not scrape: it REPLAYS prod's archived bhavcopy at 21:30, after the
# 21:15 mirror. So QA's producer finishes 30 minutes later than prod's, and one
# shared time would make QA build from yesterday every night.
#
#   21:00  prod bhavcopy   ->  21:45  prod tiles
#   21:30  qa   bhavcopy   ->  22:15  qa   tiles
#
# Both Mon-Fri: there is no Indian session to tile on a weekend.
# `corporate-actions-sync-daily` is 04:30 IST and is genuinely before both.
TILE_BUILD_JOB_IN="tile-build-d1-in"
TILE_BUILD_SCHED_IN="tile-build-d1-in-daily"
# NAMED `<JOB_ID_UPPERCASED>_SCHEDULE`, not `TILE_BUILD_CRON_IN_PROD` — MONEY-1479.
# These jobs have no SCHEDULER_DEFS row (they are Cloud Run JOBS provisioned by
# setup-tile-build-job.sh) and no `schedule_job_run` call, so `cronsForJob` in
# monitor-agreement.test.ts reaches its fourth and last lookup, which matches
# `^<JOB>_SCHEDULE(_[A-Z]+)?=`. Under the old name it found nothing, and a job
# whose crons cannot be read is a job whose absence WINDOW NOBODY SIZED — the
# shape that shipped `bhavcopy-sync` and `feed-parse` at 36h against a 72h
# weekend gap. The rename buys the generic window rule instead of an exemption.
#
# ONLY THE PROD CRON TAKES THE DISCOVERABLE NAME. The monitors are prod-only
# (`DD_QA_MONITORING` gates every QA apply), and the lookup returns EVERY match
# — so naming the QA cron the same way would fold QA's schedule into the gap a
# PROD window is sized against. More fires only ever make the computed gap
# SHORTER, which is the unsafe direction.
TILE_BUILD_D1_IN_SCHEDULE="45 21 * * 1-5"
TILE_BUILD_CRON_IN_QA="15 22 * * 1-5"
TILE_BUILD_DESC_IN="MONEY-1467 D1 tile build (India) - AFTER bhavcopy-sync (21:00 prod / 21:30 qa) and corporate-actions-sync (04:30). Reads DailyPrice + CorporateAction, writes tiles/IN/d1/ in the lake. Never calls Yahoo."

# US: the brief says 06:30 IST "after us-eod-sync". `us-eod-sync-daily` is
# 11:00 IST (`0 11 * * 2-6`), so 06:30 is FOUR AND A HALF HOURS EARLY — the
# same defect, larger. Tue-Sat because a 16:00 ET close lands after midnight
# IST on the following day.
TILE_BUILD_JOB_US="tile-build-d1-us"
TILE_BUILD_SCHED_US="tile-build-d1-us-daily"
# Discoverable name — see TILE_BUILD_D1_IN_SCHEDULE above. One cron for both
# environments here, so there is no QA spelling to keep out of the lookup.
TILE_BUILD_D1_US_SCHEDULE="45 11 * * 2-6"
TILE_BUILD_DESC_US="MONEY-1467 D1 tile build (US) - AFTER us-eod-sync (11:00 IST). Tue-Sat: a US close lands after midnight IST."

DATABENTO_APPEND_SCHEDULE_PRIMARY="0 15 * * 2-6"
DATABENTO_APPEND_DESC_PRIMARY="MONEY-1373 Databento intraday append (15:00 IST = 09:30 UTC, Tue-Sat). Extends the harvested M1/H1 history by one session. 15:00 and not 13:00 because the vendor's T+1 embargo releases the prior session at ~09:00 UTC; Tue-Sat because a US session closing 16:00 ET lands after midnight IST. Reads metadata.get_dataset_range first, so an unpublished session is a named NOT_YET_PUBLISHED skip rather than a purchase of nothing."
DATABENTO_APPEND_SCHED_RETRY="databento-append-retry"
DATABENTO_APPEND_SCHEDULE_RETRY="0 18 * * 2-6"
DATABENTO_APPEND_DESC_RETRY="MONEY-1373 Databento intraday append - SECOND pass (18:00 IST, Tue-Sat). A late vendor publication is a real state, not a fault. After a successful 15:00 run this computes UP_TO_DATE from one free metadata.get_dataset_range call and exits 0 having spent nothing."

gcloud config set project $PROJECT_ID --quiet

# ============================================
# Old scheduler names to clean up
# ============================================
OLD_SCHEDULER_PREFIXES=(
    # MONEY-1404 — etf-expense-enrichment is RETIRED. It was a GUARANTEED
    # no-op in every environment, not merely a job whose upstream had died:
    # `fetchKuveraMetadata` returns null unless MF_METADATA_PROVIDER === "kuvera"
    # and both cloudbuild specs set "amfi", so it could never reach its source —
    # and that source (mf.captnemo.in/kuvera) 404s every ISIN anyway. Its
    # `expenseRatio` now comes from AMFI's own monthly TER file, which
    # mf-metadata-weekly already parses.
    #
    # Listed HERE, not merely deleted from SCHEDULER_DEFS: removing a definition
    # stops this script CREATING the job and does nothing to the one already
    # live in Cloud Scheduler, which would keep firing weekly forever.
    "etf-expense-enrichment-weekly"
    # MONEY-1220 - financial-data-sync is RETIRED. Its only source was
    # Tickertape, which now 403s our Cloud Run egress. Statements moved to
    # xbrl-projection-daily and ratios to xbrl-ratios-daily, both derived
    # from our own archived NSE filings.
    #
    # Listed HERE, not merely deleted from SCHEDULER_DEFS: removing a
    # definition stops this script from CREATING the job, and does nothing
    # whatsoever to the one already live in Cloud Scheduler. It would keep
    # firing weekly forever against a retired route.
    "financial-data-sync-weekly"
    "ratios-sync-daily"
    "stockbook-instrument-sync"
    "stockbook-mf-sync"
    "stockbook-mf-metadata"
    "stockbook-sector-enrichment"
    "stockbook-price-sync"
    # MONEY-1098 P5.2 — renamed to corporate-actions-sync-daily. Without this
    # entry the old job survives the rename (the stale-delete pass below only
    # covers PROD_ONLY names on non-prod envs), and BOTH publish {"maxSymbols":200}
    # to the same topic: two whole-market NSE+BSE pulls plus two paced Screener
    # walks firing together every Sunday 04:30 IST — exactly the burst shape
    # those rate-limited hosts answer with 403/429. Verified ENABLED in prod.
    "corporate-actions-sync-weekly"
    # MONEY-1207 - split into ownership-sync-{shp,pit,sast,pledge}. Without this
    # entry the old job survives the rename and keeps publishing
    # {"maxSymbols":600} with NO `legs`, i.e. all four feeds in one run — which
    # now splits the budget three ways and races the four new jobs for the same
    # per-leg cursors. Verified ENABLED in prod at 20:30 IST.
    "ownership-sync-daily"
    # MONEY-1314 - the four `stock-document-parse` passes are RETIRED. The lane
    # is replaced by `stock-document-ingest`, which is ONE DOCUMENT PER MESSAGE:
    # announced at store time by the five `stock_documents` writers, and drained
    # for the historical corpus by the `doc-ingest-backfill` Cloud Run job. A
    # page-per-message lane needed a nightly cron; a document-per-message one
    # does not.
    #
    # ALL FOUR FULL NAMES, and that is not verbosity. Despite the array's name,
    # `delete_old_schedulers` builds "${PREFIX}-${ENV}" and deletes THAT EXACT
    # NAME - it is not a prefix match. "stock-document-parse" alone would delete
    # nothing and every one of these four would keep firing forever against a
    # route whose queue no longer drains.
    #
    # The PROCESSOR and its route deliberately SURVIVE this change. The old lane
    # self-chains up to 20 links, so messages are in flight when the crons stop;
    # deleting the route would 404 them into the dead-letter queue five
    # deliveries later. It is removed once the chain has drained.
    "stock-document-parse-daily"
    "stock-document-parse-morning"
    "stock-document-parse-midday"
    "stock-document-parse-evening"
)

# ============================================
# Scheduler definitions
# ============================================
# Format: NAME|SCHEDULE|TOPIC_BASE|MESSAGE|DESCRIPTION
SCHEDULER_DEFS=(
    "instrument-sync-daily|0 22 * * *|instrument-sync|{\"forceFullSync\":false}|Daily instrument sync (10:00 PM IST)"
    "mf-sync-daily|30 22 * * *|mf-sync|{\"forceFullSync\":false}|Daily MF NAV sync (10:30 PM IST)"
    "mf-metadata-weekly|0 21 * * 0|mf-metadata-sync|{\"batchSize\":500}|Weekly MF metadata enrichment (Sun 9:00 PM IST)"
    "mf-nav-propagate-daily|45 23 * * *|mf-nav-propagate|{}|Daily user MF NAV propagation from MutualFundMaster (11:45 PM IST, after mf-sync). Reads only our DB → NOT PROD_ONLY, runs on both envs (MONEY-1074)"
    "mf-nav-backfill-daily|30 23 * * *|mf-nav-backfill|{\"universe\":true,\"batchSize\":200,\"reason\":\"scheduler\"}|MONEY-1205 - nightly MFAPI.in NAV-history sweep (11:30 PM IST, after mf-sync at 22:30). THE publisher that covers the platform: mf_nav_history held 22,446 rows across 16 of 14,223 schemes because the only writer was a first-click backfill running INLINE in the page request (55-83s measured on prod). Selects schemes with no stored history, aum desc, capped at batchSize; stops on a 420s wall clock so it finishes inside the 600s ack deadline. PROD_ONLY: mf_nav_history syncs prod->QA."
    "peers-sync-daily|15 23 * * *|peers-sync|{}|Daily derived stock_peers rebuild from our own instruments+ratios+quotes (11:15 PM IST, after sector-enrichment and price-sync so it reads the day's classification and caps). Reads only our DB → NOT PROD_ONLY, runs on both envs (MONEY-1145)"
    "sector-enrichment-weekly|30 21 * * 0|sector-enrichment|{\"batchSize\":500,\"exchanges\":[\"NSE\",\"BSE\"]}|Weekly sector enrichment (Sun 9:30 PM IST)"
    "price-sync-daily|0 23 * * 1-5|price-sync|{\"source\":\"YAHOO\"}|Daily price sync Mon-Fri (11:00 PM IST)"
    "price-backfill-incremental-daily|15 23 * * 1-5|price-sync|{\"source\":\"YAHOO\",\"incremental\":true,\"incrementalDays\":30}|Daily rolling 30-day price backfill Mon-Fri (11:15 PM IST) - pre-fills DB cache so charts hit DB not Yahoo"
    "intraday-sync-daily|5 16 * * 1-5|intraday-sync|{\"intervals\":[\"5m\",\"15m\",\"60m\"],\"lookbackDays\":5}|Daily intraday bar ingest Mon-Fri (4:05 PM IST - 5 min after NSE close) for top-500 tracked symbols"
    "newsletter-publish-check|*/5 * * * *|newsletter-publish|{}|Check for scheduled newsletters every 5 minutes"
    "credit-reservation-cleanup|*/15 * * * *|l3-analysis|{\"cleanup\":true}|Cleanup expired L3 credit reservations every 15 minutes"
    "news-sync-market-hours|0 9,11,13,15 * * *|news-sync|{}|News sync 4x daily, EVERY day (9/11/13/15 IST) - markets close but news does not"
    "filings-sync-weekly|0 19 * * 0|filings-sync|{}|Weekly filings sync for hot-tier stocks (Sun 7:00 PM IST)"
    "chartink-strategy-monthly|0 22 1 * *|chartink-strategy-sync|{}|Monthly Chartink strategy scrape (1st of month 10:00 PM IST)"
    "intent-learning-daily|0 3 * * *|intent-learning|{}|Daily intent learning analysis (3:00 AM IST)"
    "stock-document-sync-tickertape-daily|30 16 * * 1-5|stock-document-sync|{\"docTypes\":[\"financial_statement\"],\"batchSize\":8000}|Daily Tickertape financial sync Mon-Fri (10:00 PM IST)"
    "stock-document-sync-weekly|0 3 * * 0|stock-document-sync|{\"batchSize\":8000}|Weekly full document sync - NSE + Screener + Tickertape (Sun 3:00 AM IST)"
    # MONEY-1259 - a DAILY screener-only pass, for the BSE-only cohort.
    # 2,423 BSE-only companies carry an ISIN and are therefore reachable via
    # the scrip-master -> screener slug join, but the screener PAGE leg runs
    # only on the weekly sync above, which covers a few hundred of its page per
    # chain: ~100 BSE-only symbols a week, so ~24 weeks to serve them all.
    # Daily brings that to ~3-4 weeks.
    # `sources` rather than `docTypes` is load-bearing: annual_report and
    # credit_rating are in BOTH NSE_ANNOUNCEMENT_DOC_TYPES and
    # SCREENER_PAGE_DOC_TYPES, so a docTypes-only payload would switch the
    # per-symbol NSE announcements fan-out on as well - load that
    # annual-reports-sync-daily already carries.
    # 08:00 IST: nothing else in this file touches screener.in then, and the
    # Sunday overlap with the weekly run is absorbed by the per-run 429 breaker
    # (API_LIMITS.screener = 500, and a broken run deliberately does not chain).
    "stock-document-sync-screener-daily|0 8 * * *|stock-document-sync|{\"sources\":[\"screener\"],\"batchSize\":8000}|MONEY-1259 daily screener-only document pass - reaches the BSE-only cohort the weekly sync cannot"
    # MONEY-1255 - was {"batchSize":50}, which with the old newest-first
    # selection could not drain a 34,790-PDF queue in under ~2 years. The
    # payload no longer carries a batch at all: the processor's own default
    # (DEFAULT_EXTRACT_BATCH_SIZE = 500) is a PAGE SIZE, the run is bounded by a
    # 420s wall clock inside the 600s ack deadline, and the run self-chains up
    # to MAX_CHAIN_DEPTH follow-ups. Pinning a number here would have to be kept
    # in step with a constant in the worker, and this file has no way to fail
    # when it drifts.
    "stock-document-extract-daily|0 22 * * *|stock-document-extract|{}|MONEY-1255 daily extraction of PENDING stock PDFs, oldest first, self-chaining until drained - feeds embed chain"
    # MONEY-1255 - the FINANCIALS-PARSE lane. A different job from the extract
    # above on the SAME documents: that one produces retrieval text, this one
    # reads FIGURES into `document_financial_extracts`. Neither implies the
    # other, which is why StockDocument carries a status per lane.
    #
    # 01:00 IST, deliberately AFTER the whole nightly chain (bhavcopy 21:00,
    # ratios 22:00, extract 22:00, xbrl-projection 23:45). Gemini calls are the
    # slowest per-item work in the repo and the PDFs are large - 22% exceed 8
    # MiB against a 5.7 MiB average - so this job is placed where it contends
    # with nothing and can self-chain for hours without delaying anything that
    # a morning reader depends on.
    #
    # Empty payload for the same reason as the extract job: the batch is a page
    # size owned by the processor, the run is bounded by a wall clock inside the
    # 600s ack deadline, and this file cannot fail when a number pinned here
    # drifts from the constant in the worker.
    # MONEY-1259 - THREE MORE TRIGGERS, and the spacing is the safety argument.
    # Throughput here cannot come from a bigger batch: the run is bounded by
    # RUN_TIME_BUDGET_MS (210s) against the 600s ack deadline, and the headroom
    # is already spent on one in-flight 240s model call. Raising either constant
    # does not make a run slow, it REDELIVERS the run and pays for every model
    # call twice. What scales safely is more RUNS.
    # A chain is at most MAX_CHAIN_DEPTH (20) links of ~600s = ~3h20m worst
    # case, so 6h spacing cannot let one trigger's chain overlap the next. The
    # MONEY-1259 claim guard makes an overlap merely wasteful rather than
    # double-billed, but the spacing is what makes it not happen.
    # PROD ONLY, unlike the 01:00 run: QA shares the model budget and gains
    # nothing from 4x the Gemini spend on a corpus it receives by copy.
    # MONEY-1255 - projects graded extracts into stock_financials. 03:00 IST,
    # two hours after the parse job starts, so a night's readings are available
    # to project. Runs whether or not it is ARMED: disarmed it still reads and
    # reports what it WOULD write, which is how an operator sees the pipeline is
    # alive BEFORE trusting it with a one-way door (StockFinancials has no
    # `source` in its unique key, so the first write to a period destroys the
    # value it replaced). DOC_FINANCIALS_APPLY, compared against the literal
    # string "true", is what turns reads into writes.
    "document-financials-projection-daily|0 3 * * *|document-financials-projection|{}|MONEY-1255 nightly projection of graded document extracts into stock_financials (inert until DOC_FINANCIALS_APPLY=true)"
    # MONEY-840/844 + MONEY-1098 (P5.2) - DAILY corporate-actions ingestion. Runs after the document sync (3:00 AM) so the two NSE/Screener jobs do not contend. Bulk NSE + BSE are whole-market and now chunk at <=180 days, so the default 7-day window is 2 HTTP calls; the per-held-symbol Screener leg still paces and is bounded by maxSymbols.

    "corporate-actions-sync-daily|30 4 * * *|corporate-actions-sync|{\"maxSymbols\":200}|MONEY-840/844 + MONEY-1098 daily corporate-actions sync (4:30 AM IST) - Screener + NSE + BSE splits/bonuses/dividends -> CorporateAction DB + per-symbol GCS JSON snapshot for held + active equities"
    # MONEY-851 - free EOD price seed from BSE+NSE bhavcopy + NSE indices. Runs after the exchange EOD files publish (~6-7 PM IST); replaces the per-symbol Yahoo loop for EOD.
    # MONEY-1194 - the 21:00 slot below is PROD's, and prod must stay FIRST: it is the PRODUCER of the archived file QA replays. QA is moved to 21:30 by ENV_SCHEDULE_OVERRIDES; do not "unify" the two.
    "bhavcopy-sync-daily|0 21 * * 1-5|bhavcopy-sync|{\"includeIndices\":true}|MONEY-851 daily EOD price seed - BSE+NSE bhavcopy + NSE indices (9:00 PM IST Mon-Fri)"

    # MONEY-980 - the nightly US price backbone (Tiingo). FOUR counted legs in
    # one job: EOD bars, mutual-fund NAVs, the corporate-actions delta DERIVED
    # from the inline divCash/splitFactor columns, and the session's USDINR
    # rate. One job rather than four because they share one upstream, one token
    # and one rate-limit budget that Tiingo reports NOTHING about (no
    # remaining-quota header; a 429 is the only feedback channel), so four jobs
    # would race for a ceiling none of them can see.
    #
    # DAY-OF-WEEK IS `2-6`, NOT `1-5`, AND THAT IS THE WHOLE POINT OF THE SLOT.
    # A US session on day D closes at 16:00 ET, which is 02:30 IST on D+1. All
    # scheduler jobs here run --time-zone=Asia/Kolkata, so the IST weekday that
    # FOLLOWS a US trading day is Tue..Sat. A `1-5` cron would fire on Monday
    # (whose preceding US day is Sunday - no session at all) and never fire on
    # Saturday, so Friday's US close would never be ingested. Same class as the
    # bhavcopy weekend gap, one timezone further out.
    #
    # 11:00 IST = 05:30 UTC = 00:30 EST / 01:30 EDT in New York, so the run is
    # gated by the LATER of the two upstream boundaries rather than the earlier:
    # equity corrections close 20:00 ET (06:30 IST), fund NAVs publish after
    # 00:00 ET (10:30 IST). It sat at 07:00 IST, which cleared the correction
    # window and missed the NAV window by three and a half hours - leg (b) would
    # have fetched an empty NAV set every night without failing. Any comment
    # here reasoning from 07:00 is stale.
    #
    # Empty payload, deliberately: the page sizes, the trailing window and the
    # chain depth are constants in `us-eod-sync-logic.ts`, and pinning a number
    # here would be a second copy of a constant this file cannot fail on when it
    # drifts (MONEY-1255). The run is bounded by a 420s wall clock inside the
    # 600s ack deadline and SELF-CHAINS up to MAX_CHAIN_DEPTH follow-ups until
    # the rotation wraps.
    #
    # THE TWO ROWS BELOW SPLIT ON PROD_ONLY, and the split is deliberate.
    # us-instrument-master-sync-daily is NOT prod-only: instrument_mappings is
    # QA-DIRECT and cannot be synced down, so QA has to run it - hence the
    # ENV_SCHEDULE_OVERRIDES entry below, which is what keeps the two envs off
    # the same paid quota at the same instant. us-eod-sync-daily IS prod-only
    # (see PROD_ONLY_JOBS): `candles` and `fx_rates` carry no ObjectId
    # reference, so they are in REFERENCE_COLLECTIONS and QA RECEIVES what prod
    # computed. Scrape-once does not apply to a paid authenticated API, but
    # copy-once does, and a replay MISS on a metered API silently spends a
    # second full copy of the quota rather than degrading.
    "us-instrument-master-sync-daily|0 10 * * 2-6|us-instrument-master-sync|{}|MONEY-980 Tiingo US security master (72,685 listings) + EDGAR ticker-CIK join (10:00 IST). Runs 1h before us-eod-sync, whose active-US population does not exist until this has written it."
    "us-eod-sync-daily|0 11 * * 2-6|us-eod-sync|{}|MONEY-980 nightly US EOD via Tiingo (11:00 IST) - after fund NAVs publish 12:00 AM ET, the later upstream boundary; equity corrections close 8:00 PM ET. Tue-Sat: a US close lands after midnight IST."

    # MONEY-980 - the hot/cold candle store's ONLY deleter, and therefore the
    # only thing that stops `candles` growing without bound. Two rules in one
    # job: a tier:"LOADED" row 30 days past its last read, and a tier:"WINDOW"
    # row whose bar year has rolled out of the 10-year window.
    #
    # 15:00 IST, DAILY (7 days, not 2-6). Unlike the two rows above it touches
    # no exchange and no upstream calendar - it reads our own `candles` table
    # and our own GCS shards - so a weekend run is a normal run, and the LOADED
    # rule is a 30-day clock that does not pause at weekends. The slot is 4h
    # after us-eod-sync's 11:00 trigger, which self-chains up to 20 x 420s
    # (~2h20m, ending by ~13:20), so the writer and the deleter never contend
    # for the same collection.
    #
    # Empty payload, deliberately: the page size, the 30-day TTL and the chain
    # depth are constants in `candle-evict-logic.ts`, and pinning a number here
    # would be a second copy of a constant this file cannot fail on when it
    # drifts (MONEY-1255).
    #
    # PROD_ONLY (see PROD_ONLY_JOBS), for a reason SPECIFIC to this job rather
    # than the usual scrape-once one: QA's bucket receives only the `feeds/`
    # prefix from the prod->QA mirror, NOT `candles/`, so every shard read in QA
    # would answer `absent`, the containment guard would refuse every row, and
    # the job would spend GCS calls to delete nothing while reporting a page of
    # alarming "no cold shard" counters. And it would be pointless even if it
    # worked: `candles` and `us_instruments` are both REFERENCE_COLLECTIONS, so
    # QA RECEIVES the post-eviction table from prod.
    "candle-evict-daily|0 15 * * *|candle-evict|{}|MONEY-980 candle eviction (15:00 IST daily) - LOADED rows 30d past their last read + WINDOW rows outside the rolling hot window. DISARMED unless CANDLE_EVICT_APPLY=true; deletes only after a cold shard is observed to hold the row."

    # MONEY-1309 - the 24x7 news poll. THE DAY FIELD IS THE WHOLE POINT.
    #
    # `*/2 * * * *` is every 2 minutes on ALL SEVEN DAYS, and that `*` is a
    # deliberate departure from every other Tiingo row in this file. The three
    # above it carry `2-6` (Tue-Sat IST) because a US SESSION closes 4:00 PM ET,
    # which lands after midnight IST the following day — the day field there
    # encodes a fact about the EXCHANGE CALENDAR. News has no exchange calendar.
    # An 8-K drops on a Sunday, a guidance cut is announced on a bank holiday,
    # and the biggest stories in the sample are the ones filed when the market
    # is shut. `news-sync-market-hours` two hundred lines up already carries
    # this exact correction in its description ("markets close but news does
    # not"); the US leg inherited the market cron instead, so a Sunday's
    # articles were picked up whenever Tuesday's run happened to reach them.
    #
    # ONE COPY OF THE TICKET'S OTHER HALF, stated here so it is not rediscovered
    # from a diff: the news leg that rides inside `us-eod-sync` (leg f) is the
    # thing this replaces. Two publishers writing `us_stock_news` on two
    # cadences is a duplicate-detection problem, not a redundancy — retiring the
    # inline leg belongs to the worker change, not to this file, and this entry
    # is inert until the route exists.
    #
    # EMPTY PAYLOAD, deliberately: the page size, the lookback window and the
    # per-run cap are constants in the worker's logic module. Pinning a number
    # here would be a second copy of a constant this file cannot fail on when it
    # drifts (MONEY-1255) — the same reasoning as the three rows above.
    #
    # NOT IN OLD_SCHEDULER_PREFIXES, and that is a decision rather than an
    # omission: nothing is being RENAMED. There has never been a Cloud Scheduler
    # job publishing to a news-poll topic, so there is no stale name to retire,
    # and a prefix listed there is DELETED on every run of this script in every
    # env — adding a speculative one is how a live job gets removed by a script
    # that was only meant to tidy up.
    #
    # 720 runs a day is the highest-frequency Pub/Sub row in this file after
    # `alert-evaluator`. It is affordable only because the poll is ONE request
    # to a market-wide endpoint, not a per-symbol fan-out; if that ever becomes
    # per-symbol, this cadence has to be re-derived, not inherited.
    "tiingo-news-poll|*/2 * * * *|tiingo-news-poll|{}|MONEY-1309 Tiingo US news poll, every 2 minutes, ALL SEVEN DAYS. The * day field is deliberate: news is not a market feed, so it does not inherit the Tue-Sat (2-6) cron the US price jobs carry, which encodes which IST days follow a US session. PROD_ONLY - Tiingo is a paid metered API whose pacer state is per-PROCESS, and QA already receives us_news_articles through sync-prod-to-qa.sh."

    # MONEY-1324 (P17) - the 8-K/6-K exhibit insight sweep.
    #
    # EVERY 10 MINUTES, ALL SEVEN DAYS, and both halves of that are derived
    # rather than copied. SEC accepts filings on business days but
    # `us_filing_documents` is written by `edgar-detect`, which runs MINUTELY
    # and whose backlog does not respect an IST calendar - measured 2026-09-01
    # the table was five days old and growing daily, all 3,054 rows PENDING. A
    # weekday-only cron would leave a Friday-evening 8-K unread until Monday for
    # no reason: this job reads OUR OWN GCS + Mongo and touches no exchange, so
    # there is no upstream schedule to inherit. It is the same call
    # `tiingo-news-poll` makes one row above, for the same reason.
    #
    # 10 minutes is the LATENCY the founder decision names for the live lane.
    # What makes that affordable is that a tick is nearly free when the queue is
    # empty (two projected Mongo reads and a diff) - the cost is per DOCUMENT,
    # and a document is analysed exactly once whatever the cadence, because the
    # sweep skips anything already READY on the same text hash.
    #
    # EMPTY-ISH PAYLOAD: `mode` is a message SHAPE, not a tuning constant. The
    # fan-out limit, the retry cooldown and the scan cap are constants in
    # `filing-insight-sweep-logic.ts`, deliberately not pinned here - this file
    # cannot fail when a number in it drifts from the worker (MONEY-1255).
    #
    # It is `mode":"sweep"` rather than `{}` because the ROUTE refuses to infer
    # a sweep from an absent field: one topic carries both the sweep and the
    # per-document leaves, and reading "no documentId" as "fan out the whole
    # cohort" would let a malformed leaf trigger a cohort of PAID model calls.
    #
    # NOT IN OLD_SCHEDULER_PREFIXES: nothing is being renamed, there has never
    # been a job publishing to this topic, and a name listed there is DELETED on
    # every run of this script in every env.
    #
    # DISARMED IS NOT INERT, and the description below has no room to say so:
    # with US_FILING_INSIGHT_APPLY unset the tick still selects, still diffs and
    # still emits its queue depth through job-outcome - it only stops short of
    # publishing. That number is what the arming decision gets made on, and a
    # lane whose off state emits no series at all is one nobody can watch fill.
    "us-filing-insight-sweep|*/10 * * * *|us-filing-insight|{\"mode\":\"sweep\"}|MONEY-1324 P17 sweep for the SEC 8-K/6-K exhibit insight lane, every 10 minutes ALL SEVEN DAYS. Diffs the EX-99* cohort of us_filing_documents against us_filing_insights and publishes one message per owed document back onto the SAME topic. Reads only our own Mongo + GCS. Also the RETRY CHANNEL: the route always ACKs, so a FAILED leaf returns only because this re-selects it after a 6h cooldown. DISARMED unless US_FILING_INSIGHT_APPLY=true. PROD_ONLY - the leaves spend PAID Gemini calls."

    # MONEY-1097 (Data Engine P2) - archive-first capture of the whole NSE/BSE
    # report set. Parses NOTHING; it exists because NSE PRUNES its archives
    # (P1 proved the PR zips 404 for 1995/2000/2010), so capturing files is
    # urgent and parsing them (P4) is not.
    #
    # TWO nightly runs on purpose: 19:30 catches the prompt publishers, 21:45
    # catches the late ones. The second run skips families the first already
    # archived but deliberately RETRIES the absent ones - a 404 at 19:30 is
    # usually "not published yet", which is the entire reason it exists.
    "report-archive-sync-evening|30 19 * * 1-5|report-archive-sync|{\"cadence\":\"daily\"}|MONEY-1097 report archive - first pass (7:30 PM IST Mon-Fri)"
    "report-archive-sync-night|45 21 * * 1-5|report-archive-sync|{\"cadence\":\"daily\"}|MONEY-1097 report archive - second pass for late publishers (9:45 PM IST Mon-Fri)"
    "report-archive-monthly|0 8 3 * *|report-archive-sync|{\"cadence\":\"monthly\"}|MONEY-1097 report archive - monthly families (3rd of month, 8:00 AM IST)"
    # Drift guard: polls NSE's own daily-reports index and warns about fileKeys
    # that appeared since the last check, so a report NSE STARTS publishing
    # shows up in the logs the week it appears. cadence=none because it fires
    # on a Saturday, when archiving anything would just manufacture 404s.
    "report-archive-drift-weekly|0 20 * * 6|report-archive-sync|{\"cadence\":\"none\",\"driftGuard\":true}|MONEY-1097 registry-vs-live drift guard (Sat 8:00 PM IST)"
    # MONEY-852 - daily BSE corporate announcements bulk ingest (all stocks, paginated) -> StockDocument + GCS.
    "bse-announcements-sync-daily|30 21 * * 1-5|bse-announcements-sync|{\"maxPages\":20}|MONEY-852 daily BSE announcements bulk ingest - all stocks (9:30 PM IST Mon-Fri)"
    # MONEY-1098 (P5.1) - daily whole-market NSE announcements bulk ingest -> StockDocument + GCS. Runs 15 min BEFORE bse-announcements-sync-daily so the BSE leg dedupes against a populated NSE side rather than racing it.
    "nse-announcements-sync-daily|15 21 * * 1-5|nse-announcements-sync|{\"windowDays\":2}|MONEY-1098 daily NSE announcements bulk ingest - all stocks, 2-day window (9:15 PM IST Mon-Fri)"
    # MONEY-1098 P5.4 / MONEY-1207 - ownership. FOUR jobs, ONE LEG EACH, and the
    # split is load-bearing rather than cosmetic.
    #
    # It used to be a single daily job sharding the NSE universe by
    # fnv1a(symbol)%7 and walking ~600 symbols. Measured over its first eight
    # prod runs: the 420s budget only ever consumed 310-410 of those 600, and the
    # window advanced by the full 600 every week regardless, so a complete NSE
    # pass took 7 WEEKS and never touched a BSE listing. NIFTY50 coverage was
    # 13/50; HDFCBANK was not reached at all.
    #
    # The processor now walks a PRIORITY QUEUE (Nifty 50 -> Nifty 100 family ->
    # Nifty 500 family -> rest of NSE -> BSE-only, 18,576 symbols) behind a
    # PER-LEG cursor that advances by symbols ACTUALLY consumed. Two consequences
    # for this file:
    #
    #   1. ONE LEG PER JOB. Per-leg budgets mean a 3-leg job splits 420s three
    #      ways (~253 symbols/leg), while a 1-leg job spends all 420s on its own
    #      feed (~760 symbols). The old interleaved walk amortised the 600ms pace
    #      across three fetches, so combining legs is now strictly slower.
    #   2. FOUR FIRES A DAY. 18,576 / (760 x 4) = 6.1 days per full pass, inside
    #      the 7-day target the processor alerts on. `runsPerDay` is passed in the
    #      payload because the processor cannot read its own cron — and it is what
    #      the COVERAGE ALERT is computed from, so it MUST be kept in step with
    #      the cron below or the alarm goes quiet.
    #
    # Slots avoid NSE market hours (09:15-15:30, when the per-symbol API is most
    # contended) and the 19:30-22:00 EOD crunch; the three legs are staggered 20
    # minutes apart so they do not overlap (a run is ~7 minutes).
    "ownership-sync-shp|0 0,5,17,23 * * *|ownership-sync|{\"legs\":[\"shareholding\"],\"runsPerDay\":4}|MONEY-1207 shareholding-pattern leg, 4x daily (00:00/05:00/17:00/23:00 IST) - priority queue Nifty50 -> Nifty100 -> Nifty500 -> rest of NSE -> BSE, cursor-resumed -> ShareholdingPattern"
    "ownership-sync-pit|20 0,5,17,23 * * *|ownership-sync|{\"legs\":[\"pit\"],\"runsPerDay\":4}|MONEY-1207 PIT insider leg, 4x daily (00:20/05:20/17:20/23:20 IST) - same priority queue, its own cursor -> InsiderEvent(PIT)"
    "ownership-sync-sast|40 0,5,17,23 * * *|ownership-sync|{\"legs\":[\"sast\"],\"runsPerDay\":4}|MONEY-1207 SAST reg29 leg, 4x daily (00:40/05:40/17:40/23:40 IST) - same priority queue, its own cursor -> InsiderEvent(SAST)"
    # Pledge is ONE bulk request for the whole market, so it needs no queue, no
    # cursor and no second slot. Kept at the original 20:30 IST.
    "ownership-sync-pledge|30 20 * * *|ownership-sync|{\"legs\":[\"pledge\"],\"runsPerDay\":1}|MONEY-1207 market-wide promoter-pledge leg, once daily (8:30 PM IST) - single bulk /api/corporate-pledgedata call -> InsiderEvent(PLEDGE)"
    # MONEY-1205 - the two legs that fill what the four above CANNOT.
    #
    # LEG 5 (shpXbrl). `ownership-sync-shp` writes a row with fiiPct and diiPct
    # NULL on every single symbol, because its endpoint does not carry them —
    # 7,953 of 7,953 prod rows, which reads as "no institutional holders" rather
    # than "never fetched". This leg fetches the XBRL filing that SAME payload
    # already links and writes the split. It walks its OWN queue: the symbols
    # that still owe a filing (440 today), not the 18,576-name universe, so its
    # cursor and its pass projection are about the work that exists.
    #   Per run: ~197 symbols x up to 4 filings = ~790 archived objects.
    #   Backlog: ~7,864 fetchable filings / 790 = ~10 runs = 2.5 days at 4/day.
    #   Steady state: one quarter-end refill (~440 filings) clears in ~1 run.
    # NOTE the projection measures QUEUE passes, not filing completion: a pass
    # clears at most 4 quarters per symbol, so a deep backfill takes several
    # passes even while `projectedPassDays` reads under a day. `legStats.shpXbrl.
    # fetched` is the filing-level number.
    "ownership-sync-shp-xbrl|10 1,6,16,22 * * *|ownership-sync|{\"legs\":[\"shpXbrl\"],\"runsPerDay\":4}|MONEY-1205 SHP XBRL leg, 4x daily (01:10/06:10/16:10/22:10 IST) - fetches the filing each stored summary row already links via its xbrl key, reconciles it against that row before writing, and fills the FII/DII split -> ShareholdingBreakdown(NSE). Own queue (symbols owing a filing), own cursor."
    # LEG 6 (bse). 8,139 BSE-only symbols have ZERO shareholding rows and always
    # will from NSE: feeds 1-4 are keyed on the NSE trading symbol. Keyed here by
    # BSE SCRIP CODE, resolved once per run from the scrip master we already
    # fetch nightly. Rows are stamped exchange:"BSE", which is what lets them
    # coexist with the NSE rows for the 2,465 dual-listed symbols instead of
    # overwriting them.
    #   SIX slots and concurrency 5, and both are load-bearing. First pass costs
    #   5 requests per scrip (1 quarter index + 2 quarters x [summary, public]):
    #   5 lanes / 1.6s per request = 0.625 scrips/s = ~262 per 420s run, so
    #   10,604 / 262 = ~41 runs. At 4/day that is 10.1 days - PAST the 7-day
    #   alert. At 6/day it is 6.7 days, inside it. Steady state is 1 request per
    #   scrip (the index alone), ~1,312 scrips/run, ~1.3 days.
    #   Archive volume is BOUNDED, unlike leg 5's: the BSE descriptors are
    #   UNDATED, so each (scrip, quarter) overwrites one object under current/
    #   rather than accumulating one per run.
    "ownership-sync-bse|50 1,4,6,16,18,22 * * *|ownership-sync|{\"legs\":[\"bse\"],\"runsPerDay\":6,\"concurrency\":5}|MONEY-1205 BSE shareholding leg, 6x daily (01:50/04:50/06:50/16:50/18:50/22:50 IST) - api.bseindia.com per scrip code at concurrency 5, own queue of 10,604 BSE actives, own cursor -> ShareholdingPattern(BSE) + ShareholdingBreakdown(BSE). Covers the 8,139 BSE-only names no NSE endpoint can reach."
    # MONEY-1098 (P5.5) - annual reports on a 7-day symbol shard (~600 NSE equities/day) + leg B, the market-wide integrated-filing-results window. 09:30 IST is deliberately PRE-market-open: the per-symbol NSE API is least contended then, and neither leg needs the day's prices.
    "annual-reports-sync-daily|30 9 * * *|annual-reports-sync|{}|MONEY-1098 P5.5 daily annual-report weekly-shard (~600 symbols) + integrated-filing window (9:30 AM IST)"
    # MONEY-1098 (P5.6) - NSE public issues -> UpcomingIpo. 09:00 IST: bidding windows open at 10:00, so the table is fresh before anyone can act on it.
    "ipo-sync-daily|0 9 * * *|ipo-sync|{}|MONEY-1098 P5.6 daily NSE IPO sync - upcoming + current + past issues (9:00 AM IST)"
    "resend-contact-sync-weekly|0 1 * * 0|resend-contact-sync|{}|Weekly Resend contact backfill (Sun 6:30 AM IST)"
    "sparkline-sync-market-hours|*/30 9-15 * * 1-5|sparkline-sync|{\"windows\":[\"1D\",\"1W\"]}|Sparkline pre-compute every 30 min during market hours Mon-Fri (9AM-4PM IST) - hot universe = indices + top 500 by volume + watchlist symbols"
    "sparkline-sync-post-close|0 16 * * 1-5|sparkline-sync|{\"windows\":[\"1D\",\"1W\",\"1M\"],\"forceRefresh\":true}|Post-close sparkline refresh Mon-Fri (4:00 PM IST) - locks in final close across all windows"
    "index-constituent-sync-weekly|0 3 * * 0|index-constituent-sync|{}|MONEY-301/MONEY-1100 P4.3 - weekly index constituent sync (Sun 03:00 IST). Archive-first: the 8 registry-archived ind_*list.csv lists (Nifty 50/Next 50/100/500/Bank/IT/Midcap 100/Smallcap 100) are parsed from the GCS feed archive into IndexConstituent; static/mcap-rank remain as fallbacks and as the only source for unarchived ids. Reads OUR bucket, never NSE - runs on both envs (QA degrades to fallbacks until the feeds/ mirror exists)."
    # MONEY-1189 P4.5 - daily NSE surveillance (ASM + GSM). 20:15 IST, after
    # NSE publishes the day's lists. UNLIKE every other feed job this one
    # CANNOT be backfilled: /api/reportASM and /api/reportGSM serve only the
    # CURRENT list, so a skipped day is gone for good and the schedule is the
    # only thing that accrues history.
    #
    # WAS `45 14 * * 1-5` with the comment "20:15 IST (14:45 UTC)". Every job
    # here is created with `--time-zone="Asia/Kolkata"`, so the cron IS already
    # IST and that UTC conversion was not just unnecessary — it MOVED the job to
    # 14:45 IST, before the 15:30 close and hours before NSE publishes. Verified
    # live 2026-08-13: nextRun 09:15 UTC = 14:45 IST. Every neighbouring entry
    # is plain IST (bhavcopy `0 21` = 21:00 IST), which is what makes the slip
    # invisible on a read-through.
    #
    # It failed SILENTLY in the worst way for this feed: the job succeeds, rows
    # are written, and the counts look right — they are just yesterday's list
    # stamped as today, because at 14:45 NSE is still serving the previous
    # publication. A feed that cannot be backfilled records the wrong day
    # forever, and no counter says so.
    "surveillance-sync-daily|15 20 * * 1-5|surveillance-sync|{}|MONEY-1189 P4.5 - daily ASM + GSM surveillance flags from NSE's live JSON reports (20:15 IST weekdays). ASM was entirely absent before this: the registered REG_IND/REG1_IND archive paths 404, so all 86,005 stored SURVEILLANCE rows were GSM-only via nse-sec-list. Scrapes NSE directly, hence prod-only; responses are archived to feeds/NSE/api/surveillance-{asm,gsm}/ for QA replay."
    # MONEY-1108 P8d - daily FII/DII institutional cash-market flows. 20:30 IST,
    # after NSE publishes the day's provisional figures and clear of
    # report-archive-sync-evening (19:30) and bhavcopy-sync (21:00).
    #
    # CANNOT be backfilled, exactly like surveillance-sync above:
    # /api/fiidiiTradeReact takes no date parameter and serves only the CURRENT
    # reading, so a skipped day is gone for good and the schedule is the only
    # thing that accrues the series.
    #
    # NOTE the cron below is IST, not UTC — every job here is created with
    # `--time-zone="Asia/Kolkata"`, so NO conversion is wanted. The surveillance
    # entry directly above shipped as `45 14` with the comment "20:15 IST
    # (14:45 UTC)" and therefore fired at 14:45 IST, before market close, for a
    # feed that cannot be backfilled. Fixed in this same branch. Write these in
    # IST and do not convert.
    "institutional-flow-sync-daily|30 20 * * 1-5|institutional-flow-sync|{}|MONEY-1108 P8d - daily FII/DII institutional cash-market flows from NSE /api/fiidiiTradeReact (20:30 IST weekdays) -> InstitutionalFlow {date, category, segment, buy/sell/net in Rs crore}. Feeds the sentiment panel and flow-vs-Nifty overlay. Scrapes NSE, hence prod-only; QA receives institutional_flows via sync-prod-to-qa.sh. Raw responses archived to feeds/NSE/api/fii-dii/ (MONEY-1195)."
    # MONEY-1198 - the EXCHANGE'S OWN top movers + live index snapshot. This is
    # the ONLY INTRADAY job in this array, and deliberately so: the datum is
    # "what is moving RIGHT NOW", and Discover was answering it from
    # latest_quotes with no freshness predicate, i.e. with the PREVIOUS
    # session's ranking labelled "today" (LAPL, Rs 128.29 +36.48% on the panel
    # vs Rs 121.88 -5.00% on its own detail page, 128.29 being yesterday's
    # close).
    #
    # CADENCE: every 3 minutes. The cron window 09:00-15:57 is DELIBERATELY
    # WIDER than the session; the processor calls getNseMarketStatus and returns
    # without making a single request unless the market is actually live, which
    # is the only way a holiday can be honoured (cron cannot know NSE's holiday
    # calendar). Real cost on a trading day: 125 polls x 3 whole-market requests
    # = 375 requests, against ONE host, with NO per-symbol fan-out. For scale,
    # alert-evaluator already runs EVERY MINUTE and sparkline-sync walks ~500
    # symbols every 30 min. Every blacklisting incident this repo has actually
    # had scaled with fan-out (Screener's 429 wall, MCX 403, NCDEX's JS
    # challenge), not with polling one whole-market endpoint.
    #
    # NOTE the cron below is IST, not UTC - every job here is created with
    # `--time-zone="Asia/Kolkata"`, so NO conversion is wanted. See the
    # surveillance-sync note above: it shipped as `45 14` under the comment
    # "20:15 IST (14:45 UTC)" and therefore fired at 14:45 IST. Write IST.
    #
    # CANNOT be backfilled: neither endpoint takes a date parameter and both
    # serve only the CURRENT snapshot, so a skipped poll is gone for good and
    # this schedule is the only thing that accrues history.
    "market-movers-sync-intraday|*/3 9-16 * * 1-5|market-movers-sync|{}|MONEY-1198/1200 - the EXCHANGE'S OWN top gainers/losers (/api/live-analysis-variations, both directions) plus the live index snapshot (/api/allIndices), every 3 min. Cron spans 09:00-16:57 IST weekdays; shouldPollMovers trims it at runtime to the session PLUS a 60-min post-close settle window (NSE still stamped 16:00 at 16:26), and skips holidays for ZERO requests. Replaces Discover ranking latest_quotes with no freshness predicate. Prod-only; QA gets both tables via sync-prod-to-qa.sh."
    # MONEY-1106 P8b - official macro series (RBI NSDP: WSS ratios/rates +
    # forex reserves + MOSPI CPI + OEA WPI). RBI publishes the Weekly
    # Statistical Supplement on FRIDAY, so the primary run is Saturday
    # 08:00 IST. Written in IST because that is the timezone the job is
    # CREATED in; see the note on institutional-flow-sync below.
    #
    # The midweek run is NOT redundancy for its own sake. The rates page shows 6
    # week-ended columns and the prices page 3 months — both self-heal across a
    # missed run — but `param=2` (forex reserves) shows exactly ONE "as on"
    # column, so a Saturday run lost to a transient failure costs that week
    # permanently. Tuesday still falls inside the same published week, so it
    # captures the same bytes. Same reasoning as report-archive-sync's two
    # nightly runs; upserting on (seriesId, period) makes the repeat a no-op.
    #
    # There is deliberately NO separate "monthly" cron for CPI/WPI. Both runs
    # already fetch the prices page, whose 3-month window covers any release
    # date; a third schedule would re-write data already captured. The cadence
    # that matters is the SERIES' (persisted as `frequency` on every row), not
    # the job's.
    "macro-sync-weekly|0 8 * * 6|macro-sync|{}|MONEY-1106 P8b - official Indian macro series (Sat 08:00 IST, after Friday's RBI Weekly Statistical Supplement). Fetches 3 RBI National Summary Data Pages - param=4 ratios+rates, param=2 forex reserves, param=15 prices (MOSPI CPI, OEA WPI) - upserting MacroSeries on (seriesId, period). Archive-first: raw HTML lands in feeds/RBI/ so QA replays rather than re-scraping. Prod-only; QA receives macro_series via sync-prod-to-qa.sh."
    "macro-sync-midweek|0 8 * * 2|macro-sync|{}|MONEY-1106 P8b - second chance for the same three pages (Tue 08:00 IST). Exists because param=2 (forex reserves) publishes a SINGLE 'as on' column: unlike the rolling rates/prices pages it cannot self-heal, so a failed Saturday run would lose that week outright. Tuesday is still inside the same published week. Idempotent by construction - the (seriesId, period) upsert makes a repeat run a no-op."
    # MONEY-1113 P10 F1 - company financials from NSE's own XBRL. 23:15 IST
    # DAILY (not weekdays): results are broadcast on weekends during earnings
    # season, and unlike the two feeds above this one CAN be backfilled, so the
    # schedule is not load-bearing. It walks a TRAILING 7-DAY window rather than
    # "today", which is what makes a missed run heal itself.
    #
    # 23:15 is clear of the whole EOD chain (bhavcopy 21:00 -> instrument-sync
    # 22:00 -> feed-parse 22:35) because this job downloads one XML per filing
    # and a heavy earnings day is thousands of them.
    "xbrl-sync-daily|15 23 * * *|xbrl-sync|{}|MONEY-1113 P10 F1 - company financials from NSE's own XBRL (23:15 IST daily). Walks /api/corporates-financial-results over a trailing 7-day window, then fetches each filing's XML from nsearchives into XbrlFiling, keyed on (symbol, exchange, periodEnd, periodType, basis, cumulative). Pre-2018 filings carry a well-formed STUB url ending in a dash that 404s, so coverage is measured on the .xml suffix, not starts-with-http. Prod-only fan-out; QA gets xbrl_filings via sync-prod-to-qa.sh."
    # >>> TEMPORARY PAYLOAD — MONEY-1235. REVERT TO {} WHEN THE DRAIN IS DONE. <<<
    #
    # The payload is `{"periodTypes":["ANNUAL"]}` and it is a stopgap, not a
    # design. Restore the empty `{}` (both buckets) once the quarterly backlog
    # has been drained by the hand-run passes in
    # docs/reference/xbrl-switchover-runbook.md step 5, and delete this comment
    # with it. Leaving it in place permanently would freeze the Quarterly tab
    # exactly as it is today.
    #
    # WHY IT IS HERE. The companion MONEY-1235 fix stops the writer stamping
    # `projectedAt` on filings whose CREATE was suppressed — correct, because a
    # suppressed filing was never decided about and must stay selectable. The
    # cost is that those filings re-enter EVERY nightly page until something
    # actually writes them. Prod holds 71,450 QUARTERLY filings against 18,381
    # ANNUAL, and selection is symbol-major (`orderBy [symbol asc, periodEnd
    # desc]`), so the two buckets INTERLEAVE: an unscoped 500-row page would be
    # ~80% never-writable quarterly rows, and the ANNUAL work the switchover
    # actually gates on would advance at a fifth of its rate, nightly, forever.
    # Scoping the nightly run to ANNUAL is what keeps that from happening while
    # the quarterly drain runs as a separate, explicitly-sized job.
    #
    # `periodTypes` is a real column filter applied at SELECTION (committed in
    # 510ea336, `xbrl-projection-writer.ts`), not a post-verdict skip — the
    # difference matters, because a post-verdict skip would still burn the page
    # on rows it then discards, which is the very problem this is solving.
    #
    # This narrows; it cannot arm. `XBRL_PROJECTION_APPLY` on the service is
    # still the only thing that turns writes on.
    "xbrl-projection-daily|45 23 * * *|xbrl-projection|{\"periodTypes\":[\"ANNUAL\"]}|MONEY-1220 nightly XBRL -> StockFinancials projection (23:45 IST, 30m after xbrl-sync). Reads our OWN xbrl_filings - no egress - but PROD_ONLY anyway: QA receives stock_financials and xbrl_filings through sync-prod-to-qa, so a QA run would write rows the next restore drops. Writes only when XBRL_PROJECTION_APPLY=true on the service; the message can narrow that, never arm it. MONEY-1235: payload TEMPORARILY scoped to ANNUAL until the quarterly drain completes."
    "xbrl-ratios-daily|0 22 * * 1-5|xbrl-ratios|{}|MONEY-1220 daily XBRL-derived ratios (22:00 IST Mon-Fri, after bhavcopy 21:00 lands the close). Owns 26 of StockRatios' 28 columns from our own filings + price history; targetPrice and recommendation are analyst opinion and are never written. PARTIAL update - a column this filing cannot support keeps its incumbent value. Universe = every NSE filer, not a tier. Armed by XBRL_RATIOS_APPLY=true (MONEY-1286 split it from the projection flag)."
    # MONEY-1105 P8a - AMC monthly portfolio disclosures. SEBI requires
    # publication within 10 days of month-end, so the 12th is the first day the
    # files can be expected to exist; the 20th is a straggler sweep, not
    # redundancy. Idempotent by construction - the (period, amc, schemeKey,
    # instrumentName) upsert makes the second run a no-op for anything the first
    # already got.
    #
    # MONTHLY, and note the cron day-of-month is what carries that: there is no
    # month field to get wrong, but a "0 30 8 12 * *" style typo silently
    # becomes "every day" here. Both entries are pinned by the golden test.
    "mf-portfolio-sync-monthly|30 8 12 * *|mf-portfolio-sync|{}|MONEY-1105 P8a - AMC monthly portfolio disclosures (12th, 08:30 IST). Downloads each AMC workbook (13 AMCs; NOT ABSL/Kotak - fetchableSources() excludes both, URLs unproven) and upserts MfPortfolioHolding on (period, amc, schemeKey, instrumentName). SEBI deadline is the 10th, so the 12th is the first safe day. NO AMFI scheme code exists in any of these files - schemeKey is our own normalisation of the printed scheme name. Prod-only; QA gets mf_portfolio_holdings via sync-prod-to-qa.sh."
    "mf-portfolio-sync-retry|30 8 20 * *|mf-portfolio-sync|{}|MONEY-1105 P8a - straggler sweep for the same five AMC workbooks (20th, 08:30 IST). Exists because AMCs miss the SEBI window and because one AMC failing must not cost the whole month: the monthly run on the 12th writes whatever it got, and this pass fills the rest. A repeat is a no-op - identity is (period, amc, schemeKey, instrumentName) and the period is the FIRST of the disclosed month, so both runs target the same rows."
    # MONEY-1187 P11 item 7 - NSE exchange circulars. 18:30 IST daily, after the
    # business day that produces them and clear of report-archive-sync-evening
    # (19:30). DAILY rather than weekdays: NSE does issue weekend circulars,
    # notably trading-holiday and system notices.
    #
    # The trailing 14-day window is wider than xbrl-sync's 7 because circulars
    # are CHEAP - one request returns the whole window with no per-record
    # fan-out - so the overlap costs a single call and buys immunity to a
    # fortnight of missed runs.
    "circulars-sync-daily|30 18 * * *|circulars-sync|{}|MONEY-1187 P11 - NSE exchange circulars (18:30 IST daily) from /api/circulars over a trailing 14-day window, upserting NseCircular on (circularNumber, department). That key is NOT redundant: NSE re-issues one circular under every department it applies to, so over a live 237-record window only 205 numbers were distinct - keying on the number alone silently drops half of every re-issued circular. Response is WRAPPED, not a bare array. Prod-only; QA gets nse_circulars via sync-prod-to-qa.sh."
    # MONEY-408 - RSS news ingestion. Two crons: every 5 min during market hours (9AM-4PM IST Mon-Fri), every 15 min off-hours.
    "news-rss-sync-market-hours|*/5 9-15 * * 1-5|news-rss-sync|{}|RSS news ingest every 5 min during market hours (9AM-4PM IST Mon-Fri)"
    "news-rss-sync-off-hours|*/15 0-8,16-23 * * *|news-rss-sync|{}|RSS news ingest every 15 min off-hours (midnight-9AM + 4PM-midnight IST)"
    # MONEY-408 - daily earnings-calendar population (UpcomingEvent). Pre-market so reminders + sector deep-dive have fresh dates.
    "events-sync-daily|0 6 * * *|events-sync|{}|MONEY-1098 daily events-calendar population (UpcomingEvent) at 6:00 AM IST - PRIMARY: NSE whole-universe corporate-board-meetings + event-calendar window (2 calls); FALLBACK: per-symbol Yahoo calendarEvents for held/watch-listed/EARNINGS_DATE-alerted symbols NSE missed - feeds earnings reminders + sector deep-dive"
    # MONEY-408 - alert engine evaluator. Every minute during market hours, every 5 min off-hours.
    "alert-evaluator-market-hours|* 9-15 * * 1-5|alert-evaluator|{}|Alert evaluator every 1 min during market hours (9AM-4PM IST Mon-Fri)"
    "alert-evaluator-off-hours|*/5 0-8,16-23 * * *|alert-evaluator|{}|Alert evaluator every 5 min off-hours"
    # MONEY-406 - weekly strategy backtest stats sync (Sun 8:00 PM IST). Populates `strategies:stats:all` in Redis for the Strategies Browse grid.
    "strategy-stats-sync-weekly|0 20 * * 0|strategy-stats-sync|{}|Weekly strategy backtest stats sync (Sun 8:00 PM IST) - populates Redis strategies:stats:all"
    # MONEY-144 - hourly Clerk-delete sweep. Purges Clerk users 24h after their account was locked so the email is released back into Clerk's signup pool.
    "clerk-delete-sweep-hourly|0 * * * *|clerk-delete-sweep|{}|Hourly Clerk-delete sweep - purges Clerk users 24h after lock (MONEY-144 lock-then-purge flow)"
    # MONEY-789 (B4) - nightly investor self-learning rollup (03:00 IST; all jobs run in --time-zone=Asia/Kolkata, so the cron is IST not UTC). Derives a PortfolioBehaviorSnapshot per active user, drifts InvestorProfile, decays stale ConceptMastery, rebuilds PortfolioInsight rows, reprojects FIRE.
    "investor-rollup-daily|0 3 * * *|investor-rollup|{}|MONEY-789 (B4) - nightly investor self-learning rollup (3:00 AM IST)"
    # MONEY-837 - broker portfolio sync. The worker skips expired-token connections
    # cheaply (no API call), so periodic runs only cost calls for users who re-authed
    # that day. Day's-data runs omit historicalDays; the weekly run backfills history.
    # MONEY-841: each carries isScheduled:true and OMITS syncBucket, so the worker
    # treats them as fan-out triggers (one Pub/Sub message published per shard →
    # parallel per-bucket syncs) rather than one serial loop over every connection.
    "broker-sync-market-hours|*/30 9-15 * * 1-5|broker-sync|{\"userId\":\"*\",\"isScheduled\":true}|MONEY-837 broker portfolio sync every 30 min during market hours Mon-Fri (9AM-4PM IST) - day's holdings/positions/trades/MF for live-token connections"
    "broker-sync-evening|0 18 * * 1-5|broker-sync|{\"userId\":\"*\",\"isScheduled\":true}|MONEY-837 broker portfolio evening sync Mon-Fri (6:00 PM IST) - the final authenticated snapshot of the day, run while the token is safely valid (well before the overnight ~6 AM expiry); live-token connections only (expired skip cheaply)"
    "broker-sync-historical-weekly|0 1 * * 0|broker-sync|{\"userId\":\"*\",\"isScheduled\":true,\"historicalDays\":30}|MONEY-837 weekly historical-tradebook catch-up (Sun 1:00 AM IST) - backfills last 30 days via the Console backoffice API to fill gaps from un-synced days (Zerodha only; heavy at scale - keep the window bounded)"

    # ── MONEY-979 — SEC EDGAR (services/us-fundamentals) ─────────────────────
    #
    # These FIVE entries — `edgar-detect-minutely`, `-reconcile-hourly`,
    # `-evict-daily`, `edgar-full-index-weekly` and `edgar-cusip-sweep-daily` —
    # target topics whose push subscription points at `us-fundamentals-${ENV}`,
    # NOT at the workers. Nothing here needs to know that: `upsert_scheduler`
    # publishes to a TOPIC, and the routing lives in
    # `workers/scripts/setup-pubsub.sh`. Named here only so the connection is
    # findable from either end.
    #
    # FIVE ENTRIES, TWO TOPICS. Four of them publish to `edgar-detect` with a
    # different `mode` in the payload ({} / efts / full-index / cusip-sweep) and
    # one to `edgar-evict`, so an audit that counts topics and an audit that
    # counts schedules get different right answers. (This comment read "these
    # three" for two tickets after T17 appended the last two below it — the
    # PROD_ONLY_JOBS block already says "ALL FIVE must be listed", which is what
    # made the undercount visible.)
    #
    # ALL THREE ARE PROD_ONLY. QA ships SEC_EGRESS=off — a QA detect run cannot
    # reach sec.gov by design and would fail every minute — and QA receives the
    # ten EDGAR `us_*` tables through sync-prod-to-qa.sh. SEC's fair-access ceiling
    # is per REQUESTER, so two environments polling independently put 2x the
    # ceiling on a host whose only feedback is a ~10-minute block.
    #
    # EVERY MINUTE, and that is the design rather than an over-eager cron.
    # Cloud Scheduler's floor IS one minute and a push handler cannot loop, so a
    # minutely trigger is the fastest detection this shape allows: filing ->
    # stored p95 ~= 60s poll + ~30s parse. PROD ships EDGAR_DETECT="on", so
    # this runs for real on deploy; QA ships it off and answers instantly at the
    # service, because QA has no SEC egress (the fair-access limit is per IP and
    # Cloud Run shares egress addresses). Sub-minute latency needs a different
    # shape entirely —
    # an always-on poller (MONEY-1271) or SEC's PDS push feed (MONEY-1272).
    "edgar-detect-minutely|* * * * *|edgar-detect|{}|MONEY-979 SEC EDGAR detection - walks the getcurrent Atom feed every minute, classifies each new filing by form and publishes it to its parser topic. Cloud Scheduler's floor is 1 min and a push handler cannot loop, so this is the fastest this shape allows. ARMED on prod (EDGAR_DETECT=on); QA ships it off because QA has no SEC egress."
    # The RECONCILE pass, same route and same topic, different mode. The Atom
    # window is ROLLING and finite (100 entries = 49 filings; at the 16:00-18:00
    # ET peak that can span minutes), so a slow minute or a failed run drops
    # filings off the end of it permanently. EFTS is date-RANGED and therefore
    # cannot: it re-asks for the last 2 hours by form class and inserts what is
    # absent. It is the SECOND of three nets — the nightly submissions.zip
    # ledger is the authoritative third.
    "edgar-reconcile-hourly|10 * * * *|edgar-detect|{\"mode\":\"efts\"}|MONEY-979 SEC EDGAR reconcile - hourly EFTS date-ranged sweep of the last 2h per form class, catching anything the ROLLING getcurrent window dropped. Insert-if-absent, so it is a no-op when detection kept up. Same route, same DISARM flag."
    # 03:30 IST = 18:00 ET the previous day, i.e. after the US filing day is
    # done, so the hot window is stable when the evictor computes it.
    "edgar-evict-daily|30 3 * * *|edgar-evict|{}|MONEY-979 13F hot/cold eviction (3:30 AM IST = 18:00 ET) - archives 13F holdings outside the 2-period hot window to a GCS shard, RE-READS the shard, and deletes only the (accession,rowIndex) rows the re-read proves are in it. Never deletes on a write's return code. DISARMED unless EDGAR_EVICT_APPLY=true."
    # ── MONEY-979 T17 — the two passes the CODE promised and nothing provided ──
    #
    # THE WEEKLY FULL-INDEX RECONCILE. `edgar_adapter.parse_daily_index` and
    # `adapter_types.DailyIndexRow` both state that DAILY index files are NEVER
    # corrected and that a post-acceptance deletion reaches only the Saturday
    # full-index REBUILD — and then nothing read it, so `us_filings.status`
    # declared a WITHDRAWN value that no code path could set. This row is the
    # reader. It also counts index-minus-stored as DETECTION GAPS, separately:
    # a filing WE hold that the rebuild dropped and a filing the rebuild lists
    # that we never stored are opposite facts, and conflating them marks live
    # filings withdrawn.
    #
    # 23:00 IST SATURDAY = 12:30 ET (EST) / 13:30 ET (EDT) the same Saturday.
    # SEC publishes the rebuild "early Saturday morning ET"; midday ET leaves
    # 6+ hours of margin under BOTH offsets, which matters because the cron is
    # fixed IST and the ET gap moves by an hour twice a year. It is also clear
    # of the two bulk downloads (13:00/13:20 primary, 16:00/16:20 retry), which
    # can run for hours and share one SEC fair-access budget with this.
    "edgar-full-index-weekly|0 23 * * 6|edgar-detect|{\"mode\":\"full-index\"}|MONEY-979 SEC EDGAR full-index reconcile (23:00 IST Sat, hours after SEC's early-Saturday-morning rebuild). Daily index files are NEVER corrected, so a post-acceptance deletion reaches only this file: it diffs a 14-day filedAt window of us_filings against the quarterly form.idx and marks vanished accessions WITHDRAWN - the only path that sets that status. index-minus-stored is counted SEPARATELY as detection gaps, never marked. Armed by EDGAR_PARSE_APPLY=true."
    # THE NIGHTLY CUSIP SWEEP. `cusip_map.py` refers to "everything the sweep
    # learned" and there was no sweep: an UNRESOLVED row was written once by
    # whichever 13F parse first met the CUSIP and never revisited, so `attempts`
    # counted to one forever and every holding of that issuer stayed
    # symbol-less. This retries them, oldest-first.
    #
    # THE SLOT COSTS NOTHING FROM SEC'S BUDGET, which is why it can sit beside a
    # minutely detect loop at all. Three of the four tiers are Mongo reads of
    # collections we already own; SEC_FTD reads one archived GCS object that
    # edgar-bulk-ftd put there; OPENFIGI is api.openfigi.com, and app/openfigi.py
    # carries its own sliding-window pacer sized from OpenFIGI's own ceilings and
    # is forbidden from touching app/sec/limiter.py. Zero requests reach sec.gov,
    # so the shared 9 req/s allowance is untouched.
    #
    # 09:30 IST is past EDGAR's 22:00 ET acceptance cutoff (23:00 ET EDT /
    # 22:00 ET EST the previous day) plus the parse lag, so the sweep sees the
    # UNRESOLVED rows the night's 13F filings just created rather than yesterday's.
    #
    # The payload carries NO `limit`, deliberately: pinning the batch here would
    # be a second copy of a constant that lives in `detect_logic.CUSIP_SWEEP_BATCH`,
    # and this file cannot fail when the two drift. Same reasoning as
    # stock-document-extract's `{}`.
    "edgar-cusip-sweep-daily|30 9 * * *|edgar-detect|{\"mode\":\"cusip-sweep\"}|MONEY-979 CUSIP map sweep (09:30 IST daily, past EDGAR's 22:00 ET cutoff so the night's 13F rows are in). Re-runs the four tiers over the least-recently-tried UNRESOLVED us_cusip_map rows - ASC on lastTriedAt so the oldest are actually reached - stamping attempts and lastTriedAt on every row VISITED and not only the ones that resolved. ZERO sec.gov requests: OpenFIGI is a separate host with its own pacer. Armed by EDGAR_PARSE_APPLY=true."
)

# ============================================
# PROD-ONLY external-data jobs (RATE-LIMITED sources only) — MONEY-855
# ============================================
# Created ONLY on prod. These hit sources that 429 / IP-block under load
# (Screener, Tickertape, NSE/BSE per-symbol + filings, Chartink, Kuvera), or
# carry rate-limited enrichment (MF: AMFI base is cheap but the Kuvera metadata
# isn't, so the whole MF pipeline stays prod-authoritative and is synced down
# WITH its enrichment). QA receives ONLY these results by copying them down from
# prod via `scripts/ops/sync-prod-to-qa.sh`, so QA never hits a throttled host
# (the Screener 429 wall that started all this).
#
# Everything NOT listed here runs on BOTH qa + prod. As of MONEY-855 that now
# includes the CHEAP / PUBLIC / TOLERANT data crons — QA fetches those itself
# (no 429 risk, and a collection QA fetches independently can't be _id-synced
# anyway, so it must NOT be in the sync):
#   instrument-sync (Zerodha public instrument dump), bhavcopy-sync (BSE/NSE
#   public EOD files), sector-enrichment / price-sync / price-backfill /
#   intraday-sync / events-sync / sparkline-sync (Yahoo, tolerant),
#   news-rss-sync (public RSS).
# Plus the usual user/internal jobs (broker sync, alerts, newsletter, credit
# cleanup, clerk sweep, strategy stats, intent learning, resend contacts).
# To move a job between tiers, add/remove its NAME here — the definition itself
# stays in SCHEDULER_DEFS.
PROD_ONLY_JOBS=(
    # MONEY-1220 - not a scraper, but QA gets these collections from the
    # prod->QA sync; a QA-side write would be dropped by the next restore.
    "xbrl-projection-daily"
    "xbrl-ratios-daily"
    # MONEY-1334 - the SAME reasoning as its two XBRL siblings above, and it was
    # the only one of the three missing from this list. It writes
    # `stock_financials`, which QA receives by restore, so a QA-side write is
    # dropped by the next sync — and its INPUT cannot be mirrored at all:
    # `document_financial_extracts` carries a REQUIRED `instrumentId` relation to
    # QA-DIRECT `instrument_mappings`, so copied rows would dangle, and a
    # dangling required relation THROWS rather than returning null.
    #
    # It must be here BEFORE DOC_FINANCIALS_APPLY is ever armed (MONEY-1335): an
    # armed QA run would spend paid Gemini-derived readings writing rows that the
    # next restore silently deletes, which reads as the projection not working.
    "document-financials-projection-daily"
    # MONEY-980 - same reasoning, and it is the FIRST price job that can use it.
    #
    # India's bhavcopy runs in BOTH envs and replays prod's archived bytes,
    # because `DailyPrice` keys on `instrumentId` and QA holds its own instrument
    # _ids — the rows are not portable, so QA has to re-INGEST rather than
    # receive. `Candle` deliberately keys on (symbol, exchange, timeframe, ts)
    # and carries NO ObjectId reference, so it IS portable and a straight
    # `mongorestore` gives QA exactly what prod computed.
    #
    # That makes prod-only strictly better here than the replay arrangement:
    # Tiingo is a PAID METERED api and a replay MISS is a soft failure by
    # design, so any drift in the mirror timing would silently spend a second
    # full copy of the quota (~73k requests) rather than degrade. Copying the
    # rows removes that failure mode instead of scheduling around it.
    #
    # `candles` and `fx_rates` are in REFERENCE_COLLECTIONS accordingly; the
    # guard in prod-only-sync-coverage.test.ts enforces that pairing.
    "us-eod-sync-daily"
    # MONEY-980 — moved here AFTER the collection split, and the reason it was
    # NOT here before is exactly what changed.
    #
    # It ran in both envs because the US master wrote into `instrument_mappings`,
    # which is QA-DIRECT (it is the FK target every India price row points at,
    # so it can never be restored over) — the columns therefore had to be
    # written in each environment rather than copied.
    #
    # US listings now live in `us_instruments`, which is nothing's FK target and
    # IS in REFERENCE_COLLECTIONS, so QA receives exactly what prod computed,
    # like the five other US tables.
    #
    # Leaving it on in QA is not merely redundant, it is EXPENSIVE: the name and
    # search legs are METERED (`/tiingo/daily/<ticker>` and
    # `/tiingo/utilities/search`, both through `paceTiingoRequest`) at ~14,000
    # requests a night, and `tiingo-pacer.ts` state is per-PROCESS — so two
    # environments pace independently against ONE account quota and put 2x the
    # COMMERCIAL ceiling on an API that publishes no quota header and gives no
    # feedback but a 429.
    #
    # The provider leg alone would have been free (supported_tickers.zip is a
    # public, unmetered file), which is what made this look harmless.
    "us-instrument-master-sync-daily"
    # MONEY-980 - and NOT for the scrape-once reason the others here share.
    # QA's bucket receives only the `feeds/` prefix from the prod->QA mirror,
    # never `candles/`, so every cold-shard read in QA answers `absent`, the
    # containment guard refuses every row, and the job deletes nothing while
    # emitting a page of "no cold shard" warnings. It would also be redundant:
    # `candles` and `us_instruments` are both in REFERENCE_COLLECTIONS, so QA
    # receives the post-eviction table from prod.
    "candle-evict-daily"
    # MONEY-1309 - the 24x7 news poll. PROD_ONLY, and this is the row where the
    # usual scrape-once wording would be WRONG in a way that matters, so it is
    # spelled out.
    #
    # Tiingo is not a scraped site; it is a PAID METERED api. What makes a QA
    # copy harmful is arithmetic, not politeness. At `*/2 * * * *` this is 720
    # runs a day; a second environment makes it 1,440 against ONE account quota,
    # and `tiingo-pacer.ts` state is MODULE SCOPE — shared inside one process,
    # shared with nothing across processes. So the two envs would pace
    # independently to 2x the COMMERCIAL ceiling on an API that publishes no
    # remaining-quota header and signals the wall only with a 429, which is the
    # one failure where a retry is actively harmful (MONEY-853). That is the
    # identical argument that put us-eod-sync-daily and
    # us-instrument-master-sync-daily here, at 1/720th of this frequency.
    #
    # AND QA LOSES NOTHING: `us_news_articles` is in sync-prod-to-qa.sh's
    # REFERENCE_COLLECTIONS. QA receives exactly what prod fetched — the
    # copy-once arrangement, not the replay one.
    #
    # NOT `us_stock_news`, which is `us-eod-sync`'s leg (f) and a DIFFERENT
    # table. This comment said so for one draft and `prod-only-sync-coverage.
    # test.ts` caught it: the poller has its own model keyed on Tiingo's
    # `tiingoId`. Naming the wrong table here would have been the whole
    # justification for prod-only resting on a row this job never writes.
    #
    # Its watermark `us_news_cursor` is deliberately NOT synced — same refusal
    # as `us_edgar_cursor`, recorded in that test's QA_DIRECT map.
    "tiingo-news-poll"
    # MONEY-1324 (P17) - and NOT for the scrape-once reason most of this list
    # shares. This job touches no third party at all: it reads `us_filing_documents`
    # and GCS text this repo already owns. What is expensive is what it CAUSES —
    # every message it fans out is one PAID Gemini call.
    #
    # QA's inputs are prod's, byte for byte: `us_filing_documents` is already in
    # REFERENCE_COLLECTIONS (QA has no SEC egress and receives them by copy). So
    # a QA sweep would buy a SECOND reading of IDENTICAL bytes and reach the
    # identical answer — the arithmetic argument that put `tiingo-news-poll` and
    # both us-eod jobs here, with the meter one layer downstream.
    #
    # AND QA LOSES NOTHING: `us_filing_insights` is in REFERENCE_COLLECTIONS too,
    # so QA receives exactly what prod read. That pairing is enforced —
    # `prod-only-sync-coverage.test.ts` fails a PROD_ONLY processor whose
    # collection is not synced, and the collection it resolves for this topic is
    # the LEAF's (`us-filing-insight.ts` writes `us_filing_insights`), which is
    # the right one: the sweep itself writes no row.
    "us-filing-insight-sweep"
    # Tickertape (rate-limited)
    "stock-document-sync-tickertape-daily"
    # Screener + NSE/BSE per-symbol + filings + Chartink (rate-limited / IP-blocked)
    "stock-document-sync-weekly"
    # MONEY-1259 - scrapes screener.in, so scrape-once applies exactly as it
    # does to the weekly sync above.
    "stock-document-sync-screener-daily"
    # MONEY-1314 - the three EXTRA `stock-document-parse` passes were listed
    # here so QA would not pay 4x the Gemini bill. All four passes are now
    # RETIRED (see OLD_SCHEDULER_PREFIXES above) and the lane is
    # `stock-document-ingest`, which has no cron at all: it is announced at
    # store time and drained by a Cloud Run job. There is nothing left here to
    # make prod-only.
    "corporate-actions-sync-daily"
    "bse-announcements-sync-daily"
    "nse-announcements-sync-daily"
    # MONEY-1098 / MONEY-1207 - per-symbol nseindia.com fan-out (~760 requests
    # per leg per run, 4 runs/day/leg). QA gets shareholding_patterns +
    # insider_events via sync-prod-to-qa.sh. ALL FOUR legs must be listed: a name
    # missing here is created on QA too, and QA would then scrape NSE 12 times a
    # day for tables it already receives by copy.
    "ownership-sync-shp"
    "ownership-sync-pit"
    "ownership-sync-sast"
    "ownership-sync-pledge"
    # MONEY-1205 - the same rule for the two new legs. shpXbrl fetches
    # nsearchives.nseindia.com per FILING and bse fetches api.bseindia.com per
    # SCRIP; QA receives shareholding_patterns + shareholding_breakdown by copy
    # (sync-prod-to-qa.sh) and replays the archived filings, so creating either
    # job on QA would scrape both exchanges a second time for tables it is
    # already given.
    "ownership-sync-shp-xbrl"
    "ownership-sync-bse"
    # MONEY-1098 P5.3 - events-sync primary source is now NSE whole-universe (board
    # meetings + event calendar); Yahoo is fallback only. Scrape-once applies.
    "events-sync-daily"
    # MONEY-1098 - NSE per-symbol annual reports + the issues/filings APIs
    "annual-reports-sync-daily"
    "ipo-sync-daily"
    "filings-sync-weekly"
    "news-sync-market-hours"
    "chartink-strategy-monthly"
    "index-constituent-sync-weekly"
    "surveillance-sync-daily"
    # MONEY-1108 P8d - scrapes nseindia.com directly. QA gets institutional_flows
    # copied down by sync-prod-to-qa.sh: the table is market-wide with no
    # instrumentId FK, so unlike daily_prices it mirrors cleanly without
    # disturbing QA's own ObjectIds.
    "institutional-flow-sync-daily"
    # MONEY-1198 - polls nseindia.com intraday. Whole-market only (3 requests
    # per poll, no per-symbol fan-out), but it is still a scrape, so scrape-once
    # applies: prod polls, QA receives `market_movers` + `index_live_snapshots`
    # via sync-prod-to-qa.sh. Both tables are market-wide; market_movers carries
    # an optional instrumentId, but the row is keyed on (exchange, direction,
    # bucket, symbol, date) and readable by symbol, so a copied-down row is
    # useful in QA even where prod's ObjectId does not resolve there.
    "market-movers-sync-intraday"
    # MONEY-1106 P8b - scrapes www.rbi.org.in. QA replays the archived HTML from
    # feeds/RBI/ and additionally receives `macro_series` through
    # sync-prod-to-qa.sh's REFERENCE_COLLECTIONS, so it is fed by two paths and
    # never has to touch RBI itself.
    "macro-sync-weekly"
    "macro-sync-midweek"
    # MONEY-1113 P10 F1 - one XML download PER FILING against nseindia.com, which
    # on a heavy earnings day is thousands of requests. Same per-symbol fan-out
    # reasoning as ownership-sync. QA receives `xbrl_filings` via
    # sync-prod-to-qa.sh.
    "xbrl-sync-daily"
    # MONEY-1105 P8a - five AMC workbooks totalling ~6 MB per run, fetched direct
    # from the AMCs. Prod-only so the bytes are fetched ONCE and archived; QA
    # additionally receives `mf_portfolio_holdings` via sync-prod-to-qa.sh, which
    # is what actually feeds it today (FEED_ARCHIVE_MODE is still unset).
    "mf-portfolio-sync-monthly"
    "mf-portfolio-sync-retry"
    # MONEY-1187 P11 - scrapes nseindia.com. QA receives `nse_circulars` via
    # sync-prod-to-qa.sh; the table is market-wide with no instrumentId FK, so
    # it mirrors cleanly.
    "circulars-sync-daily"
    # MONEY-1097 - archives raw NSE/BSE report files; QA reads the mirrored
    # `feeds/` prefix instead of scraping the exchanges a second time.
    "report-archive-sync-evening"
    "report-archive-sync-night"
    "report-archive-monthly"
    "report-archive-drift-weekly"
    # Kuvera (rate-limited) — MF base + metadata + ETF expense. Kept prod-only so
    # mutual_fund_masters stays prod-authoritative and syncs down WITH the Kuvera
    # enrichment (a base-only QA fetch couldn't be merged by the sync).
    "mf-sync-daily"
    "mf-metadata-weekly"
    # MONEY-1205 - MFAPI.in NAV-history sweep. External free API, and
    # `mf_nav_history` is already in sync-prod-to-qa.sh's REFERENCE_COLLECTIONS,
    # so QA receives the rows rather than fetching them a second time.
    "mf-nav-backfill-daily"
    # MONEY-979 - SEC EDGAR. Scrape-once, for a reason stronger than the usual
    # one: QA ships SEC_EGRESS=off, so `SecClient` RAISES on any network attempt
    # there rather than degrading. A QA detect job would therefore fail every
    # minute of every day — 1,440 failures a day, and a permanently-red job is a
    # job whose alerts get muted.
    #
    # QA IS FED BY ONE PATH: it receives the ten EDGAR `us_*` tables through
    # sync-prod-to-qa.sh's REFERENCE_COLLECTIONS (us_filers, us_filings,
    # us_fundamentals, us_company_facts, us_insider_transactions,
    # us_13f_filings, us_13f_holdings, us_beneficial_ownership,
    # us_filing_documents, us_cusip_map). Every one is market-wide with no
    # instrumentId FK, so they restore cleanly without disturbing QA's own
    # ObjectIds. `us_edgar_cursor` is deliberately excluded — restoring prod's
    # detection watermark would make a QA detect run skip every filing prod has
    # already seen and report a healthy empty run.
    #
    # THERE IS NO `edgar/` GCS MIRROR, and this comment claimed one for a
    # release. `sync-prod-to-qa.sh` hard-codes exactly two prefix pairs —
    # `feeds/` for `--tier=feeds` and `stocks/` for the reference tier — so
    # `edgar/` is in no tier and QA's bucket holds none of prod's archived
    # submission bundles. The `feeds/` arrangement is NOT the arrangement here.
    #
    # That is a difference in kind, not a gap to close: `feeds/` exists so QA
    # can RE-INGEST prod's bytes, because `DailyPrice` keys on `instrumentId`
    # and QA holds its own ids, so the ROWS are not portable. Every EDGAR table
    # keys on a natural identifier (accession, cik10, cusip), so the rows ARE
    # portable and copying them is strictly cheaper and safer than copying
    # ~330 GB/yr of raw filings for QA to re-parse. The one thing QA loses is a
    # filing to exercise the pipeline WITH, and that has its own answer:
    # scripts/ops/edgar-qa-synthetic-filing.sh places a single bundle where
    # `SecClient.fetch_bundle` looks first, so the archive hits and no fetch
    # happens.
    #
    # ALL FIVE must be listed. A name missing here is created on QA too, and
    # `edgar-detect-minutely` in particular would then be the highest-frequency
    # job in the project, failing on every single invocation.
    "edgar-detect-minutely"
    "edgar-reconcile-hourly"
    "edgar-evict-daily"
    # MONEY-979 T17. `edgar-full-index-weekly` fetches quarterly form.idx files
    # from sec.gov and is prod-only for the reason above. `edgar-cusip-sweep-daily`
    # issues ZERO sec.gov requests — but it WRITES `us_cusip_map`, which QA
    # receives through sync-prod-to-qa.sh, so a QA copy would spend an OpenFIGI
    # quota to produce rows the next restore drops. Same reasoning as
    # xbrl-projection-daily, which also reads only our own tables and is still
    # prod-only.
    "edgar-full-index-weekly"
    "edgar-cusip-sweep-daily"
    # The three bulk jobs' SIX `:run` triggers. THIS ARRAY IS NOT WHAT GATES
    # THEM — `setup_edgar_bulk_job_schedulers` carries its own
    # `if [ "$ENV" != "prod" ]` skip-and-DELETE branch, because a Cloud Run
    # `:run` trigger is provisioned by a different function than the Pub/Sub
    # loop that consults `is_prod_only`. They are named here so an audit that
    # greps this array for "edgar" finds every prod-only EDGAR schedule rather
    # than some of them, which is the "a rule written down somewhere that does
    # not cover the case" shape MONEY-1198 was.
    #
    # It listed TWO of the six until MONEY-1358 — the FTD pair only — so it was
    # doing to itself exactly what its own paragraph warns about. That stopped
    # being cosmetic when `apply-monitors.sh`'s `job_is_prod_only` grew a
    # fallback that READS this array by `<job>-` prefix: a name missing here now
    # means a QA monitor for a job QA does not run, sitting in NO DATA from
    # birth. Adding a name the scheduler loop never sees is still a no-op THERE;
    # it is no longer a no-op everywhere.
    "edgar-bulk-submissions-daily"
    "edgar-bulk-submissions-retry"
    "edgar-bulk-companyfacts-daily"
    "edgar-bulk-companyfacts-retry"
    "edgar-bulk-ftd-semimonthly"
    "edgar-bulk-ftd-retry"
    # MONEY-1373 - a PAID METERED vendor, and QA receives both of the tables it
    # writes by copy: `candles` and `databento_batch_jobs` are in
    # sync-prod-to-qa.sh's REFERENCE_COLLECTIONS. So a QA trigger would spend
    # real money to produce rows the next restore deletes.
    #
    # `setup_databento_schedulers` already skips-and-deletes on non-prod, so
    # these two entries are not what enforces it. They are here because
    # `apply-monitors.sh` parses THIS array to decide which environments a
    # monitor covers, and `job_is_prod_only` falls back to it for triggers
    # created by a function rather than declared in SCHEDULER_DEFS — so an
    # absence here would raise a QA alert for a job QA is never meant to run.
    "databento-append-daily"
    "databento-append-retry"
)

# True when $1 is a PROD-ONLY external-data job (so it's skipped/deleted on QA).
is_prod_only() {
    local name=$1
    local p
    for p in "${PROD_ONLY_JOBS[@]}"; do
        [ "$p" == "$name" ] && return 0
    done
    return 1
}

# ============================================
# Per-ENV schedule overrides — MONEY-1194
# ============================================
# A SCHEDULER_DEFS entry carries ONE schedule for every environment, which is
# right for almost everything: the two envs are independent copies of the same
# pipeline. It is wrong for a job that CONSUMES what the other env PRODUCES.
#
# `bhavcopy-sync` is that job. Under scrape-once, prod fetches the exchange file
# and archives it; QA replays prod's bytes out of the mirrored `feeds/` prefix
# instead of scraping NSE/BSE a second time. Sharing one 21:00 schedule made
# both envs ask for day D's file at the same instant — so QA's read raced prod's
# write and lost, every weekday, and fell back to scraping the exchange (a
# replay miss is a SOFT failure by design, so nothing ever said so).
#
# The ordering that has to hold, on ONE IST calendar day:
#     21:00  prod bhavcopy-sync  ARCHIVES day D
#     21:15  sync-prod-to-qa-feeds-eod  MIRRORS it into QA's bucket
#     21:30  QA bhavcopy-sync    REPLAYS it
#
# Why not simply move QA past midnight, which would need no override at all:
# `resolveTargetDay(undefined)` (workers/src/processors/bhavcopy-sync-logic.ts)
# walks back from now to the most recent non-weekend / non-holiday IST CALENDAR
# day — which on a trading weekday is TODAY, not the previous trading day. A
# 01:30 run on D+1 would therefore target D+1, whose bhavcopy the exchange has
# not published yet: 404 -> [] -> a silent zero-price no-op. That trades one
# invisible failure for a worse one, so QA's run MUST stay on IST day D.
#
# Format: NAME|ENV|SCHEDULE|WHY   (NAME is the un-suffixed SCHEDULER_DEFS name;
# WHY is appended to the deployed job's description, because the description is
# where an operator reading `gcloud scheduler jobs list` will actually look.
# Keep WHY under ~250 chars: Cloud Scheduler caps a description at 500 and the
# shared DESC is prepended to it.)
ENV_SCHEDULE_OVERRIDES=(
    "bhavcopy-sync-daily|qa|30 21 * * 1-5|MONEY-1194: QA REPLAYS prod's archived bhavcopy instead of scraping NSE/BSE, so it must follow prod's 21:00 archive and the 21:15 feeds mirror. Same IST calendar day - a post-midnight slot resolves to a day the exchange has not published."
    # MONEY-980 - QA runs the MASTER job four hours after prod, and the gap is
    # sized rather than picked. Tiingo meters per token and publishes no
    # remaining-quota header, so two envs pulling the same universe at the same
    # instant would discover the hourly ceiling as a 429 - the one failure where
    # a retry is actively harmful (MONEY-853). The pacer's state is MODULE SCOPE
    # (packages/core/src/market-data/tiingo/tiingo-pacer.ts): shared across every
    # Tiingo client inside ONE process, shared with nothing across processes. So
    # two environments pacing independently put 2x the COMMERCIAL ceiling on an
    # API that reports nothing about remaining quota, and nothing detects it.
    # This spacing is the whole mitigation. Same argument as the four
    # stock-document-parse passes (MONEY-1259).
    #
    # WHAT IT HAS TO CLEAR, corrected. This comment used to read "a prod chain
    # is at most MAX_CHAIN_DEPTH (20) links of 420s = 2h20m, so it has finished
    # by ~09:20 IST and cannot overlap a 10:00 QA start". Three things wrong,
    # and the arithmetic one understated the span:
    #   - 420s is us-eod-sync's THROUGHPUT wall (RUN_TIME_BUDGET_MS), the point
    #     past which no new SYMBOL starts. A link may still be inside a 155s
    #     upstream call at that moment and then run the whole tail. A link's real
    #     bound is the 600s Pub/Sub ack deadline, by construction of
    #     latestUpstreamCallStartMs - so 20 links is up to 3h20m, not 2h20m.
    #   - 09:20 IST was 07:00 + 2h20m, and us-eod-sync has not run at 07:00
    #     since it moved to 11:00 for the fund-NAV boundary. Worst case now:
    #     11:00 -> ~14:20 IST.
    #   - "a 10:00 QA start" is not this entry's schedule; QA's master runs at
    #     14:00 (below).
    # So the two CAN overlap in the worst case - 14:00 sits inside the chain's
    # 3h20m envelope - while a typical chain ends nearer 13:40. That is the
    # residual risk this entry buys down, stated rather than claimed away.
    #
    # The DAY field stays `2-6` in both envs: it encodes which IST weekdays
    # follow a US session, which is a fact about the exchange, not about the
    # environment.
    #
    # NOTE THE JOINT BUDGET, which the header above understates. Cloud Scheduler
    # caps a description at 500 chars and `EFF_DESC` is `DESC + ~44 chars of
    # scaffolding + WHY`, so it is the PAIR that has to fit, not the WHY alone.
    # This entry is 250 + 200 + 44 = 494. Several DESCs in SCHEDULER_DEFS are
    # already 480-493 on their own (circulars-sync-daily, market-movers-sync,
    # xbrl-sync-daily): adding an override for one of THOSE requires shortening
    # its DESC in the same edit, or `gcloud scheduler jobs create` rejects it.
)

# Echo the schedule for job $1 on env $2, defaulting to $3 (the shared one).
resolve_schedule() {
    local name=$1 env=$2 fallback=$3
    local o o_name o_env o_sched
    for o in "${ENV_SCHEDULE_OVERRIDES[@]}"; do
        IFS='|' read -r o_name o_env o_sched _ <<< "$o"
        if [ "$o_name" == "$name" ] && [ "$o_env" == "$env" ]; then
            echo "$o_sched"
            return 0
        fi
    done
    echo "$fallback"
    return 0
}

# Echo the WHY for job $1 on env $2, or nothing when there is no override.
resolve_schedule_reason() {
    local name=$1 env=$2
    local o o_name o_env o_why
    for o in "${ENV_SCHEDULE_OVERRIDES[@]}"; do
        IFS='|' read -r o_name o_env _ o_why <<< "$o"
        if [ "$o_name" == "$name" ] && [ "$o_env" == "$env" ]; then
            echo "$o_why"
            return 0
        fi
    done
    return 0
}

# ============================================
# Helper: delete old scheduler jobs
# ============================================
delete_old_schedulers() {
    local ENV=$1
    echo -e "${YELLOW}Cleaning up old scheduler jobs for ${ENV}...${NC}"

    for PREFIX in "${OLD_SCHEDULER_PREFIXES[@]}"; do
        local OLD_NAME="${PREFIX}-${ENV}"
        if gcloud scheduler jobs describe "$OLD_NAME" --location=$REGION &>/dev/null 2>&1; then
            echo -e "   Deleting old job: ${RED}${OLD_NAME}${NC}"
            # Recorded, not swallowed — MONEY-1238. `|| true` here meant a failed
            # delete left the RENAMED job in place, firing alongside its
            # replacement on the old schedule: two jobs doing one job's work,
            # with nothing said about it. stderr is deliberately no longer sent
            # to /dev/null: this delete only runs after `describe` succeeded, so
            # a failure is genuinely unexpected and its reason is worth seeing.
            if ! gcloud scheduler jobs delete "$OLD_NAME" --location=$REGION --quiet; then
                echo -e "   ${RED}✗ Failed to delete${NC} ${OLD_NAME} — it will keep firing beside its replacement"
                FAILED_JOBS+=("${OLD_NAME} (stale-job delete failed)")
            fi
        fi
    done

    echo -e "   ${GREEN}Old jobs cleaned up${NC}"
    echo ""
}

# ============================================
# Helper: create or update a scheduler job
# ============================================
# Run-to-completion accounting: a single job's failure must NOT abort the whole
# run (a transient gcloud/API error, a missing topic, or a perms blip on one job
# shouldn't strand the other ~20). We attempt EVERY job, collect failures here,
# and report + exit non-zero at the very end. `cmd || rc=$?` keeps each gcloud
# call errexit-safe under `set -e`, and the function always `return 0`s so the
# call site (last statement in the loop body) never trips errexit either.
FAILED_JOBS=()
UPSERTED_JOBS=()
# Schedules we deliberately did NOT create because their target does not exist
# yet (distinct from FAILED_JOBS: nothing errored, the prerequisite is absent).
# Reported loudly in the summary; see setup_feeds_sync_scheduler().
#
# EACH ENTRY IS `schedule-name|command that provisions its Cloud Run job`, and
# the second half is why the format exists. The summary block is SHARED by every
# pending schedule and used to print ONE hardcoded remediation —
# `./scripts/ops/setup-sync-job.sh` — which is correct for the three
# `sync-prod-to-qa*` triggers and wrong for the six EDGAR bulk ones. Running it
# for those rebuilds and redeploys an unrelated Cloud Run job, creates none of
# `edgar-bulk-{submissions,companyfacts,ftd}-prod`, and the re-run it tells you
# to do reports the same six as pending — forever, with no error anywhere. The
# right command was already printed by the EDGAR path 250 lines earlier, but the
# summary is what an operator reads. Carrying the command with the entry is what
# stops a shared summary from drifting away from half its population.
PENDING_JOBS=()

upsert_scheduler() {
    local NAME=$1
    local SCHEDULE=$2
    local TOPIC=$3
    local MESSAGE=$4
    local DESC=$5
    local rc=0

    # Which jobs may retry a failed PUBLISH — named EXPLICITLY.
    #
    # A scheduler retry re-PUBLISHES, producing a NEW messageId that the dedupe
    # middleware cannot pair with the first. So in the ambiguous case — the
    # publish landed server-side and only the response timed out — the retry is
    # a REAL second run of the job, not a redelivery the worker will recognise.
    #
    # This started as "sub-hourly schedules retry once", and that heuristic is
    # WRONG IN BOTH DIRECTIONS. Frequency is not a proxy for the cost of running
    # twice. Of the twelve sub-hourly jobs it would have covered:
    #   us-filing-insight-sweep  */10  publishes one leaf per owed document, and
    #                                  each leaf spends a PAID Gemini call. The
    #                                  documents are still owed when the retry
    #                                  sweeps, so it buys every one of them twice.
    #   tiingo-news-poll         */2   spends a METERED vendor quota.
    #   edgar-detect-minutely    *     shares ONE per-IP SEC fair-access budget
    #                                  whose penalty is a silent block.
    #   newsletter-publish-check */5   sends EMAIL.
    #
    # So this is an allow-list of EXACT NAMES, and the default is an explicit 0
    # (MONEY-1214: absent and 0 must not be the same state). Exact rather than a
    # `news-rss-sync-*` glob, so a future `news-rss-sync-backfill` calling a paid
    # enrichment does not inherit the retry silently.
    #
    # ONLY news-rss-sync, and `alert-evaluator` was REMOVED after a second look
    # even though it is one of the two jobs that actually failed. The retry's
    # whole premise is the ambiguous case — the publish landed and only the
    # response timed out — which means the second run executes CONCURRENTLY with
    # the first. `news-rss-sync` survives that: it handles the concurrent
    # duplicate explicitly, per item, with a P2002 fallback. `alert-evaluator`
    # does not: its "don't repeat" gate reads `alert.lastFiredAt` from a findMany
    # and stamps it only AFTER notifying, so two overlapping runs both pass the
    # cooldown and both notify — a duplicate alert, to a user. And the trade is
    # bad in both directions: it runs every MINUTE, so the tick it would save is
    # worth about sixty seconds, against a user-visible duplicate.
    #
    # Adding a job here is a deliberate edit that has to answer two questions:
    # what does running it twice, five seconds apart, cost — and does the job's
    # own idempotency survive two runs OVERLAPPING rather than sequential?
    local RETRY=0
    case "$NAME" in
      news-rss-sync-market-hours-prod|news-rss-sync-market-hours-qa|\
      news-rss-sync-off-hours-prod|news-rss-sync-off-hours-qa) RETRY=1 ;;
    esac

    # Idempotent UPSERT — update in place when the job exists, else create.
    # The old delete-then-create raced Cloud Scheduler's non-strongly-consistent
    # delete: a silently-failed `delete … 2>/dev/null || true` left the job in
    # place, so the following `create` aborted with ALREADY_EXISTS. `update`
    # touches the same fields with no delete, so it can't race.
    if gcloud scheduler jobs describe "$NAME" --location=$REGION &>/dev/null 2>&1; then
        echo -e "   ${YELLOW}Updating${NC} $NAME  ($DESC)"
        gcloud scheduler jobs update pubsub "$NAME" \
            --location=$REGION \
            --schedule="$SCHEDULE" \
            --time-zone="Asia/Kolkata" \
            --topic="$TOPIC" \
            --message-body="$MESSAGE" \
            --description="$DESC" \
            --max-retry-attempts="$RETRY" \
            --quiet || rc=$?
    else
        echo -e "   ${GREEN}Creating${NC} $NAME  ($DESC)"
        gcloud scheduler jobs create pubsub "$NAME" \
            --location=$REGION \
            --schedule="$SCHEDULE" \
            --time-zone="Asia/Kolkata" \
            --topic="$TOPIC" \
            --message-body="$MESSAGE" \
            --description="$DESC" \
            --max-retry-attempts="$RETRY" \
            --quiet || rc=$?
    fi

    if [ "$rc" -ne 0 ]; then
        echo -e "   ${RED}✗ Failed${NC} $NAME (exit $rc) — continuing with remaining jobs"
        FAILED_JOBS+=("$NAME")
    else
        UPSERTED_JOBS+=("$NAME")
    fi
    return 0
}

# ============================================
# Helper: upsert the prod->QA raw-feed mirror schedule — MONEY-1085 / MONEY-1156
# ============================================
# `upsert_scheduler` cannot be reused: every SCHEDULER_DEFS entry targets a
# Pub/Sub TOPIC, whereas this one POSTs to the Cloud Run Admin API `:run`
# endpoint and authenticates with an OAuth service account. That is NOT a new
# convention — it is exactly the shape `scripts/ops/setup-sync-job.sh` (steps
# 4 + 6) already uses for the two prod->QA Cloud Run jobs. Same URI template,
# same flags, same create-or-update guard; only the call site is new.
#
# WHY THE PROD PASS OWNS IT (and QA does not):
#   1. It is a SINGLETON, not per-env. Unlike every Pub/Sub job here, the name
#      carries no `-${ENV}` suffix: there is ONE prod->QA pipe in the project,
#      one Cloud Run job, one service account. So exactly one pass must own it —
#      otherwise `setup-scheduler.sh all` upserts the same resource twice and
#      "who owns this schedule" has no answer.
#   2. Prod is the PRODUCER and the only env that can satisfy the precondition.
#      sync-prod-to-qa.sh hard-codes the direction (prod reads, QA writes) and
#      there is nothing to mirror until prod has archived files with
#      FEED_ARCHIVE_MODE=archive. The 00:45 cron is defined purely by PROD's EOD
#      chain, so the schedule is only meaningful next to prod's own crons.
#   3. Arming a recurring reader of prod belongs to a prod-scoped command. The
#      trigger runs as an SA holding secretAccessor on DATABASE_URL_PROD and
#      objectViewer on the PROD bucket; `setup-scheduler.sh qa` should not be the
#      thing that switches that on.
#   4. Its sibling `sync-prod-to-qa-weekly` is likewise created by a
#      prod-authoritative, env-less script — prod-side is the consistent home.
#   The counter-argument (QA is the BENEFICIARY — the job writes QA's bucket) is
#   real but loses to (1): beneficiary is not ownership, and the whole
#   scrape-once architecture already puts the copy-down under prod's authority.
setup_db_sync_scheduler() {
    local ENV=$1
    local rc=0

    # Same rule as the feeds mirror: skip on non-prod, NEVER delete. This is how
    # QA gets its scraped reference data, so a routine `setup-scheduler.sh qa`
    # run must not tear it down.
    if [ "$ENV" != "prod" ]; then
        echo -e "   ${YELLOW}Skipping${NC} ${DB_SYNC_SCHED}  (prod-owned singleton — NOT deleted on ${ENV})"
        return 0
    fi

    # Existence gate — Cloud Scheduler will happily create an http job whose
    # target does not exist and POST a 404 every night while listing as ENABLED.
    if ! gcloud run jobs describe "$DB_SYNC_JOB" --region=$REGION &>/dev/null 2>&1; then
        echo -e "   ${RED}Not scheduled${NC} ${DB_SYNC_SCHED}  (Cloud Run job ${DB_SYNC_JOB} not found)"
        PENDING_JOBS+=("${DB_SYNC_SCHED}|./scripts/ops/setup-sync-job.sh")
        return 0
    fi

    # Read the identity off the DEPLOYED job rather than re-declaring it.
    local SA
    SA=$(gcloud run jobs describe "$DB_SYNC_JOB" --region=$REGION \
        --format='value(spec.template.spec.template.spec.serviceAccountName)' 2>/dev/null || true)
    [ -z "$SA" ] && SA="$FEEDS_SYNC_SA_FALLBACK"

    local RUN_URI="https://${REGION}-run.googleapis.com/apis/run.googleapis.com/v1/namespaces/${PROJECT_ID}/jobs/${DB_SYNC_JOB}:run"
    local SCHED_ARGS=(
        --location="$REGION"
        --schedule="$DB_SYNC_SCHEDULE"
        --time-zone="Asia/Kolkata"
        --uri="$RUN_URI"
        --http-method=POST
        --oauth-service-account-email="$SA"
        --description="$DB_SYNC_DESC"
        --project="$PROJECT_ID"
    )

    if gcloud scheduler jobs describe "$DB_SYNC_SCHED" --location=$REGION &>/dev/null 2>&1; then
        echo -e "   ${YELLOW}Updating${NC} ${DB_SYNC_SCHED}  (${DB_SYNC_SCHEDULE} IST -> Cloud Run job ${DB_SYNC_JOB})"
        gcloud scheduler jobs update http "$DB_SYNC_SCHED" "${SCHED_ARGS[@]}" --quiet || rc=$?
    else
        echo -e "   ${GREEN}Creating${NC} ${DB_SYNC_SCHED}  (${DB_SYNC_SCHEDULE} IST -> Cloud Run job ${DB_SYNC_JOB})"
        gcloud scheduler jobs create http "$DB_SYNC_SCHED" "${SCHED_ARGS[@]}" --quiet || rc=$?
    fi

    if [ "$rc" -ne 0 ]; then
        echo -e "   ${RED}✗ Failed${NC} ${DB_SYNC_SCHED} (exit $rc) — continuing with remaining jobs"
        FAILED_JOBS+=("$DB_SYNC_SCHED")
        return 0
    fi

    # Retire the weekly predecessor ONLY once the daily one is in place, so a
    # failure above never leaves the project with no prod->QA DB sync at all.
    if gcloud scheduler jobs describe "$DB_SYNC_LEGACY_SCHED" --location=$REGION &>/dev/null 2>&1; then
        echo -e "   ${YELLOW}Removing${NC} ${DB_SYNC_LEGACY_SCHED}  (superseded by ${DB_SYNC_SCHED})"
        # Recorded, not swallowed — MONEY-1238. This is the highest-stakes of
        # the three: if the weekly predecessor survives, BOTH it and the daily
        # replacement stay ENABLED, and each one runs `mongorestore --drop`
        # over QA. Note the twelve lines directly above already do this
        # correctly (`|| rc=$?` -> FAILED_JOBS); the `|| true` here was the same
        # function holding two different standards.
        if ! gcloud scheduler jobs delete "$DB_SYNC_LEGACY_SCHED" --location=$REGION --project="$PROJECT_ID" --quiet; then
            echo -e "   ${RED}✗ Failed to remove${NC} ${DB_SYNC_LEGACY_SCHED} — it and ${DB_SYNC_SCHED} will BOTH restore over QA"
            FAILED_JOBS+=("${DB_SYNC_LEGACY_SCHED} (legacy delete failed — duplicate QA restore)")
        fi
    fi
}

# Upsert ONE Cloud Run-targeted trigger for the feeds mirror.
# $1 schedule name, $2 cron, $3 description, $4 service account.
# Extracted so the two executions (21:15 EOD + 00:45 nightly, MONEY-1194) cannot
# drift apart in flags, URI or upsert semantics — the only differences between
# them are the three arguments.
upsert_feeds_sync_trigger() {
    local SCHED=$1
    local SCHEDULE=$2
    local DESC=$3
    local SA=$4
    local rc=0

    local RUN_URI="https://${REGION}-run.googleapis.com/apis/run.googleapis.com/v1/namespaces/${PROJECT_ID}/jobs/${FEEDS_SYNC_JOB}:run"
    local SCHED_ARGS=(
        --location="$REGION"
        --schedule="$SCHEDULE"
        --time-zone="Asia/Kolkata"
        --uri="$RUN_URI"
        --http-method=POST
        --oauth-service-account-email="$SA"
        --description="$DESC"
        --project="$PROJECT_ID"
    )

    # Idempotent UPSERT, same rationale as upsert_scheduler: update in place so
    # there is no delete to race.
    if gcloud scheduler jobs describe "$SCHED" --location=$REGION &>/dev/null 2>&1; then
        echo -e "   ${YELLOW}Updating${NC} ${SCHED}  (${SCHEDULE} IST -> Cloud Run job ${FEEDS_SYNC_JOB})"
        gcloud scheduler jobs update http "$SCHED" "${SCHED_ARGS[@]}" --quiet || rc=$?
    else
        echo -e "   ${GREEN}Creating${NC} ${SCHED}  (${SCHEDULE} IST -> Cloud Run job ${FEEDS_SYNC_JOB})"
        gcloud scheduler jobs create http "$SCHED" "${SCHED_ARGS[@]}" --quiet || rc=$?
    fi

    if [ "$rc" -ne 0 ]; then
        echo -e "   ${RED}✗ Failed${NC} ${SCHED} (exit $rc) — continuing with remaining jobs"
        FAILED_JOBS+=("$SCHED")
    else
        UPSERTED_JOBS+=("$SCHED")
    fi
    return 0
}

setup_feeds_sync_scheduler() {
    local ENV=$1

    # NOT is_prod_only(): that path SKIPS-AND-DELETES on a non-prod env, which is
    # correct for a scraper (stop QA hitting the throttled source) and would be
    # catastrophic here — this mirror is how QA GETS its feeds, so a routine
    # `setup-scheduler.sh qa` run must never tear it down. Skip, never delete.
    if [ "$ENV" != "prod" ]; then
        echo -e "   ${YELLOW}Skipping${NC} ${FEEDS_SYNC_SCHED_EOD} + ${FEEDS_SYNC_SCHED}  (prod-owned singleton — NOT deleted on ${ENV})"
        return 0
    fi

    # Existence gate. Cloud Scheduler will happily create an http job whose
    # target does not exist: it would POST a 404 every night at 00:45 while
    # still listing as ENABLED. That "scheduled but doing nothing" state is the
    # exact defect MONEY-1156 exists to remove, so refuse to manufacture it and
    # point at the command that provisions the job.
    if ! gcloud run jobs describe "$FEEDS_SYNC_JOB" --region=$REGION &>/dev/null 2>&1; then
        echo -e "   ${RED}Not scheduled${NC} ${FEEDS_SYNC_SCHED_EOD} + ${FEEDS_SYNC_SCHED}  (Cloud Run job ${FEEDS_SYNC_JOB} not found)"
        PENDING_JOBS+=("${FEEDS_SYNC_SCHED_EOD}|./scripts/ops/setup-sync-job.sh")
        PENDING_JOBS+=("${FEEDS_SYNC_SCHED}|./scripts/ops/setup-sync-job.sh")
        return 0
    fi

    # Read the identity off the DEPLOYED job instead of re-declaring it, so this
    # script cannot drift from the SA setup-sync-job.sh actually granted IAM to.
    local SA
    SA=$(gcloud run jobs describe "$FEEDS_SYNC_JOB" --region=$REGION \
        --format='value(spec.template.spec.template.spec.serviceAccountName)' 2>/dev/null || true)
    # Empty means the job was deployed without an explicit SA (project default
    # compute SA). Prefer the dedicated least-privilege SA over letting gcloud
    # pick the Scheduler identity for us.
    [ -z "$SA" ] && SA="$FEEDS_SYNC_SA_FALLBACK"

    # TWO executions of the SAME job. The EOD pass is upserted FIRST because it
    # is the one QA's 21:30 bhavcopy depends on; if the second call fails, the
    # run-to-completion accounting reports it and the important one is already
    # in place.
    upsert_feeds_sync_trigger "$FEEDS_SYNC_SCHED_EOD" "$FEEDS_SYNC_SCHEDULE_EOD" "$FEEDS_SYNC_DESC_EOD" "$SA"
    upsert_feeds_sync_trigger "$FEEDS_SYNC_SCHED" "$FEEDS_SYNC_SCHEDULE" "$FEEDS_SYNC_DESC" "$SA"
    return 0
}

# ============================================
# Helper: the SEC EDGAR bulk feeds — MONEY-979
# ============================================
# Upsert ONE Cloud Run-targeted trigger for one bulk job.
# $1 schedule name, $2 cron, $3 description, $4 Cloud Run job name, $5 SA.
#
# Extracted for the same reason `upsert_feeds_sync_trigger` was: FOUR triggers
# over TWO jobs cannot be allowed to drift apart in flags, URI or upsert
# semantics, and the only differences between them are these five arguments.
upsert_edgar_bulk_trigger() {
    local SCHED=$1
    local SCHEDULE=$2
    local DESC=$3
    local JOB=$4
    local SA=$5
    local rc=0

    local RUN_URI="https://${REGION}-run.googleapis.com/apis/run.googleapis.com/v1/namespaces/${PROJECT_ID}/jobs/${JOB}:run"
    local SCHED_ARGS=(
        --location="$REGION"
        --schedule="$SCHEDULE"
        --time-zone="Asia/Kolkata"
        --uri="$RUN_URI"
        --http-method=POST
        --oauth-service-account-email="$SA"
        --description="$DESC"
        --project="$PROJECT_ID"
    )

    # Idempotent UPSERT: update in place so there is no delete to race.
    if gcloud scheduler jobs describe "$SCHED" --location=$REGION &>/dev/null 2>&1; then
        echo -e "   ${YELLOW}Updating${NC} ${SCHED}  (${SCHEDULE} IST -> Cloud Run job ${JOB})"
        gcloud scheduler jobs update http "$SCHED" "${SCHED_ARGS[@]}" --quiet || rc=$?
    else
        echo -e "   ${GREEN}Creating${NC} ${SCHED}  (${SCHEDULE} IST -> Cloud Run job ${JOB})"
        gcloud scheduler jobs create http "$SCHED" "${SCHED_ARGS[@]}" --quiet || rc=$?
    fi

    if [ "$rc" -ne 0 ]; then
        echo -e "   ${RED}✗ Failed${NC} ${SCHED} (exit $rc) — continuing with remaining jobs"
        FAILED_JOBS+=("$SCHED")
    else
        UPSERTED_JOBS+=("$SCHED")
    fi
    return 0
}

# Provision both triggers for one bulk job in one env.
# $1 env, $2 job base name, $3/$4 primary sched+cron, $5 primary desc,
# $6/$7 retry sched+cron, $8 retry desc.
setup_edgar_bulk_job_schedulers() {
    local ENV=$1 BASE=$2
    local SCHED_P_BASE=$3 CRON_P=$4 DESC_P=$5
    local SCHED_R_BASE=$6 CRON_R=$7 DESC_R=$8
    # GENERIC DESPITE THE NAME. It provisions a primary + retry pair of
    # Cloud-Run-job triggers for any prod-only Cloud Run job, and MONEY-1373's
    # Databento append is its second caller. Deliberately NOT renamed: the name
    # appears in `scheduler-retirement-contract.test.ts` and in the accounting
    # output, and a rename is a diff nobody can read against a behaviour change
    # nobody made.
    #
    # $9 is the script that PROVISIONS the job, named in the "not scheduled"
    # message. It defaults to the EDGAR one so the three original calls are
    # unchanged; pointing a caller at the wrong script sends an operator to a
    # command that cannot create the job they are missing.
    local SETUP_SCRIPT="${9:-./scripts/ops/setup-us-fundamentals-jobs.sh}"
    local JOB="${BASE}-${ENV}"

    # THE TRIGGER NAMES CARRY THE ENV SUFFIX, like every other per-env scheduler
    # here and UNLIKE the two `sync-prod-to-qa-*` singletons.
    #
    # That is a safety property, not a style choice. The Cloud Run job these
    # point at IS per-env (`edgar-bulk-submissions-prod`), so the trigger has to
    # be too — and with unsuffixed names the skip-and-delete branch below would
    # be handed the PROD trigger's exact name during a `setup-scheduler.sh qa`
    # run and would delete production's schedule. A suffixed name makes that
    # impossible by construction rather than by remembering.
    local SCHED_P="${SCHED_P_BASE}-${ENV}"
    local SCHED_R="${SCHED_R_BASE}-${ENV}"

    # SKIP AND DELETE on non-prod, which is `is_prod_only`'s semantics and the
    # OPPOSITE of the feeds mirror's. The distinction is real: the mirror is how
    # QA GETS its data, so tearing it down would starve QA. These reach sec.gov,
    # and QA ships SEC_EGRESS=off — a QA copy would fail on every invocation
    # while QA already receives the ten EDGAR `us_*` tables by copy.
    if [ "$ENV" != "prod" ]; then
        local STALE
        for STALE in "$SCHED_P" "$SCHED_R"; do
            if gcloud scheduler jobs describe "$STALE" --location=$REGION &>/dev/null 2>&1; then
                echo -e "   ${RED}Deleting${NC} ${STALE}  (metered upstream → prod-only)"
                # Recorded, not swallowed — MONEY-1238. A failed delete leaves
                # this env pointed at sec.gov, which is precisely what
                # PROD_ONLY_JOBS exists to prevent.
                if ! gcloud scheduler jobs delete "$STALE" --location=$REGION --project="$PROJECT_ID" --quiet; then
                    echo -e "   ${RED}✗ Failed to delete${NC} ${STALE} — this env will keep fetching from the metered upstream"
                    FAILED_JOBS+=("${STALE} (prod-only delete failed)")
                fi
            fi
        done
        echo -e "   ${YELLOW}Skipping${NC} ${SCHED_P} + ${SCHED_R}  (metered upstream → prod-only)"
        return 0
    fi

    # Existence gate. Cloud Scheduler will happily create an http job whose
    # target does not exist: it would POST a 404 every afternoon while still
    # listing as ENABLED. "Scheduled but doing nothing" is the exact state this
    # whole file's accounting exists to remove, so refuse to manufacture it and
    # name the command that provisions the job.
    if ! gcloud run jobs describe "$JOB" --region=$REGION &>/dev/null 2>&1; then
        echo -e "   ${RED}Not scheduled${NC} ${SCHED_P} + ${SCHED_R}  (Cloud Run job ${JOB} not found)"
        echo -e "   ${YELLOW}   Provision it first: ${SETUP_SCRIPT} ${ENV}${NC}"
        PENDING_JOBS+=("${SCHED_P}|${SETUP_SCRIPT} ${ENV}")
        PENDING_JOBS+=("${SCHED_R}|${SETUP_SCRIPT} ${ENV}")
        return 0
    fi

    # Read the identity off the DEPLOYED job rather than re-declaring it, so
    # this script cannot drift from the SA setup-us-fundamentals-jobs.sh
    # actually granted run.invoker to.
    local SA
    SA=$(gcloud run jobs describe "$JOB" --region=$REGION \
        --format='value(spec.template.spec.template.spec.serviceAccountName)' 2>/dev/null || true)
    [ -z "$SA" ] && SA="$EDGAR_BULK_SA_FALLBACK"

    # PRIMARY first: if the second call fails, the run-to-completion accounting
    # reports it and the pass that matters is already in place.
    upsert_edgar_bulk_trigger "$SCHED_P" "$CRON_P" "$DESC_P" "$JOB" "$SA"
    upsert_edgar_bulk_trigger "$SCHED_R" "$CRON_R" "$DESC_R" "$JOB" "$SA"
    return 0
}

setup_edgar_bulk_schedulers() {
    local ENV=$1

    setup_edgar_bulk_job_schedulers "$ENV" "$EDGAR_SUBMISSIONS_JOB" \
        "$EDGAR_SUBMISSIONS_SCHED_PRIMARY" "$EDGAR_SUBMISSIONS_SCHEDULE_PRIMARY" "$EDGAR_SUBMISSIONS_DESC_PRIMARY" \
        "$EDGAR_SUBMISSIONS_SCHED_RETRY" "$EDGAR_SUBMISSIONS_SCHEDULE_RETRY" "$EDGAR_SUBMISSIONS_DESC_RETRY"

    # SUBMISSIONS BEFORE COMPANYFACTS, and the order is load-bearing beyond the
    # egress stagger: `submissions.zip` seeds `us_filings` / `us_filers`, and the
    # companyfacts job's statement leg is scoped to CIKs that appear in
    # `us_instruments` joined against those rows. Running companyfacts first on
    # a cold database walks a population that does not exist yet and reports a
    # perfectly healthy zero.
    setup_edgar_bulk_job_schedulers "$ENV" "$EDGAR_COMPANYFACTS_JOB" \
        "$EDGAR_COMPANYFACTS_SCHED_PRIMARY" "$EDGAR_COMPANYFACTS_SCHEDULE_PRIMARY" "$EDGAR_COMPANYFACTS_DESC_PRIMARY" \
        "$EDGAR_COMPANYFACTS_SCHED_RETRY" "$EDGAR_COMPANYFACTS_SCHEDULE_RETRY" "$EDGAR_COMPANYFACTS_DESC_RETRY"

    # FTD LAST, and it is the only one of the three whose ordering does not
    # matter: it reads SEC's own fails files and writes `us_cusip_map`, joining
    # `us_instruments` (which instrument-sync owns) rather than anything the two
    # jobs above produce. Placed last because its schedule is the sparsest — four
    # days a month against their every-day — so on 26 days of the month this call
    # is the only one that does nothing.
    setup_edgar_bulk_job_schedulers "$ENV" "$EDGAR_FTD_JOB" \
        "$EDGAR_FTD_SCHED_PRIMARY" "$EDGAR_FTD_SCHEDULE_PRIMARY" "$EDGAR_FTD_DESC_PRIMARY" \
        "$EDGAR_FTD_SCHED_RETRY" "$EDGAR_FTD_SCHEDULE_RETRY" "$EDGAR_FTD_DESC_RETRY"
    return 0
}

# ── Databento — MONEY-1373 ──────────────────────────────────────────────────
#
# Reuses `setup_edgar_bulk_job_schedulers`, which is generic despite its name:
# a primary + retry pair of OIDC triggers against one prod-only Cloud Run job,
# with the same skip-and-DELETE behaviour on qa. That behaviour is the reason
# to reuse it rather than write a second copy — QA must not have a trigger for
# this at all. Databento is a PAID METERED vendor, and QA receives `candles`
# and `databento_batch_jobs` through the prod->QA sync, so a QA copy would spend
# real money to produce rows the next restore deletes.
# ── Tile builder — MONEY-1467 ───────────────────────────────────────────────
#
# BOTH ENVIRONMENTS, unlike Databento. This job reads our OWN Mongo and spends
# nothing with any vendor, and QA holds its own `daily_prices` (a QA-DIRECT
# collection — QA re-ingests rather than receiving rows), so QA must build its
# own tiles or its charts have none.
setup_tile_build_schedulers() {
    local ENV=$1
    local CRON_IN
    if [ "$ENV" = "prod" ]; then CRON_IN="$TILE_BUILD_D1_IN_SCHEDULE"; else CRON_IN="$TILE_BUILD_CRON_IN_QA"; fi

    local JOB SA
    for SPEC in "${TILE_BUILD_JOB_IN}-${ENV}|${TILE_BUILD_SCHED_IN}-${ENV}|${CRON_IN}|${TILE_BUILD_DESC_IN}" \
                "${TILE_BUILD_JOB_US}-${ENV}|${TILE_BUILD_SCHED_US}-${ENV}|${TILE_BUILD_D1_US_SCHEDULE}|${TILE_BUILD_DESC_US}"; do
        JOB="${SPEC%%|*}"
        local REST="${SPEC#*|}"
        local SCHED="${REST%%|*}"; REST="${REST#*|}"
        local CRON="${REST%%|*}"
        local DESC="${REST#*|}"

        # READ THE DEPLOYED STATE, not a constant — the same thing the EDGAR
        # bulk triggers do. A scheduler pointed at a job that does not exist
        # creates cleanly and then fails on every fire, so absence is reported
        # as PENDING with the provisioning command rather than upserted blind.
        SA=$(gcloud run jobs describe "$JOB" --region=$REGION \
            --format='value(spec.template.spec.template.spec.serviceAccountName)' 2>/dev/null || true)
        if [ -z "$SA" ]; then
            echo -e "   ${YELLOW}PENDING${NC} ${SCHED} - Cloud Run job ${JOB} does not exist yet"
            echo -e "     ./scripts/ops/setup-tile-build-job.sh ${ENV}"
            continue
        fi
        upsert_edgar_bulk_trigger "$SCHED" "$CRON" "$DESC" "$JOB" "$SA"
    done
    return 0
}

setup_databento_schedulers() {
    local ENV=$1

    setup_edgar_bulk_job_schedulers "$ENV" "$DATABENTO_APPEND_JOB" \
        "$DATABENTO_APPEND_SCHED_PRIMARY" "$DATABENTO_APPEND_SCHEDULE_PRIMARY" "$DATABENTO_APPEND_DESC_PRIMARY" \
        "$DATABENTO_APPEND_SCHED_RETRY" "$DATABENTO_APPEND_SCHEDULE_RETRY" "$DATABENTO_APPEND_DESC_RETRY" \
        "./scripts/ops/setup-databento-jobs.sh"

    # NO TRIGGER FOR `databento-harvest`, deliberately. It is a ONE-TIME buy of
    # a fixed history, executed one manifest entry at a time by a human who has
    # read the runbook — and `--apply` without `--entry=` exits 1 precisely so a
    # scheduled bare invocation could not walk the TB-scale 1s archive. A cron
    # would be a standing authorisation to spend against a subscription that is
    # meant to be cancelled once the harvest completes.
    return 0
}

# ============================================
# Helper: setup schedulers for one environment
# ============================================
setup_env() {
    local ENV=$1

    echo ""
    echo "╔════════════════════════════════════════════╗"
    echo "║  Cloud Scheduler Setup: ${ENV}"
    echo "╚════════════════════════════════════════════╝"
    echo ""

    # Step 1: Enable Cloud Scheduler API
    gcloud services enable cloudscheduler.googleapis.com --quiet 2>/dev/null || true

    # Step 2: Delete old scheduler jobs
    delete_old_schedulers "$ENV"

    # Step 3: Create new scheduler jobs
    echo -e "${BLUE}Creating scheduler jobs for ${ENV}...${NC}"

    # Broker sync (kept with original naming). MONEY-841: the message MUST carry
    # isScheduled:true so the worker treats it as the fan-out TRIGGER (publishes
    # one message per shard) instead of serial-looping every connection in a
    # single invocation. It deliberately omits syncBucket — the worker fans out.
    local BROKER_NAME="stockbook-daily-sync-${ENV}"
    local BROKER_MSG='{"jobId":"daily-sync-'${ENV}'","userId":"*","isScheduled":true}'
    upsert_scheduler "$BROKER_NAME" "30 0 * * *" "broker-sync-${ENV}" "$BROKER_MSG" "Daily broker sync fan-out (12:30 AM IST)"

    # Data sync schedulers. External-data (scraping) jobs are PROD-ONLY: on a
    # non-prod env we DON'T create them and we DELETE any left over from before
    # this split, so QA never scrapes third-party sources (it gets the data via
    # scripts/ops/sync-prod-to-qa.sh). All other jobs run on every env.
    for DEF in "${SCHEDULER_DEFS[@]}"; do
        IFS='|' read -r NAME SCHEDULE TOPIC_BASE MESSAGE DESC <<< "$DEF"

        if is_prod_only "$NAME" && [ "$ENV" != "prod" ]; then
            local STALE="${NAME}-${ENV}"
            if gcloud scheduler jobs describe "$STALE" --location=$REGION &>/dev/null 2>&1; then
                echo -e "   ${RED}Deleting${NC} ${STALE}  (external-data scrape → prod-only)"
                # Recorded, not swallowed — MONEY-1238. A failed delete here
                # leaves QA scraping a third-party source it is explicitly not
                # allowed to touch, which is the entire point of PROD_ONLY_JOBS.
                # It fails silently and QA keeps scraping indefinitely.
                if ! gcloud scheduler jobs delete "$STALE" --location=$REGION --quiet; then
                    echo -e "   ${RED}✗ Failed to delete${NC} ${STALE} — this env will keep scraping a prod-only source"
                    FAILED_JOBS+=("${STALE} (prod-only delete failed — env still scraping)")
                fi
            else
                echo -e "   ${YELLOW}Skipping${NC} ${NAME}  (external-data scrape → prod-only)"
            fi
            continue
        fi

        # Per-env schedule (MONEY-1194). Identical to $SCHEDULE for every job
        # but the handful in ENV_SCHEDULE_OVERRIDES; the reason rides along into
        # the deployed description so the shared DESC (which names the SHARED
        # time) can't quietly describe a different clock time than the one the
        # job runs at.
        local EFF_SCHEDULE EFF_DESC WHY
        EFF_SCHEDULE=$(resolve_schedule "$NAME" "$ENV" "$SCHEDULE")
        WHY=$(resolve_schedule_reason "$NAME" "$ENV")
        EFF_DESC="$DESC"
        if [ -n "$WHY" ]; then
            EFF_DESC="${DESC} [${ENV} schedule override: ${EFF_SCHEDULE} IST - ${WHY}]"
            echo -e "   ${BLUE}Override${NC} ${NAME}-${ENV}  (${SCHEDULE} → ${EFF_SCHEDULE})"
        fi

        upsert_scheduler "${NAME}-${ENV}" "$EFF_SCHEDULE" "${TOPIC_BASE}-${ENV}" "$MESSAGE" "$EFF_DESC"
    done

    # Step 4: the Cloud Run-targeted schedules.
    #
    # The prod->QA raw-feed mirror and the DB sync run on the prod pass only and
    # on qa/local are skipped WITHOUT being deleted — they are how QA GETS its
    # data.
    setup_feeds_sync_scheduler "$ENV"
    setup_db_sync_scheduler "$ENV"
    # MONEY-979 — the SEC bulk feeds. Also prod-only, but skipped AND DELETED on
    # a non-prod env: these FETCH from sec.gov, so a stray QA copy is the
    # scrape-once violation `PROD_ONLY_JOBS` exists to prevent, not a lifeline.
    setup_edgar_bulk_schedulers "$ENV"
    setup_databento_schedulers "$ENV"
    setup_tile_build_schedulers "$ENV"

    echo ""
    echo -e "${GREEN}Finished scheduler pass for ${ENV}${NC}"
    echo ""
}

# ============================================
# Helper: trigger one-time sector enrichment
# ============================================
trigger_seed() {
    local ENV=$1

    echo ""
    echo "╔════════════════════════════════════════════╗"
    echo "║  One-Time Sector Enrichment: ${ENV}"
    echo "╚════════════════════════════════════════════╝"
    echo ""
    echo -e "${YELLOW}Sector enrichment processes 500 instruments per batch.${NC}"
    echo -e "${YELLOW}With ~8000 instruments, this needs ~16 batches.${NC}"
    echo -e "${YELLOW}Each batch takes ~4-5 min (500ms/call x 500 calls).${NC}"
    echo ""

    local BATCHES=16
    local WAIT=240  # 4 minutes between batches

    for i in $(seq 1 $BATCHES); do
        echo -e "${BLUE}Batch ${i}/${BATCHES}: Publishing to sector-enrichment-${ENV}...${NC}"
        gcloud pubsub topics publish "sector-enrichment-${ENV}" \
            --message='{"batchSize":500,"exchanges":["NSE","BSE"]}'

        if [ $? -eq 0 ]; then
            echo -e "   ${GREEN}Published${NC}"
        else
            echo -e "   ${RED}Failed to publish!${NC}"
        fi

        if [ $i -lt $BATCHES ]; then
            echo -e "   Waiting ${WAIT}s for batch to complete..."
            sleep $WAIT
        fi
    done

    echo ""
    echo -e "${GREEN}All ${BATCHES} sector enrichment batches triggered.${NC}"
    echo ""
    echo "Monitor progress:"
    echo "  gcloud run services logs read stockbook-workers-${ENV} --region=${REGION} --limit=30"
    echo ""
}

# ============================================
# Main
# ============================================
echo ""
echo "╔════════════════════════════════════════════╗"
echo "║  UseMoney Cloud Scheduler Setup           ║"
echo "╠════════════════════════════════════════════╣"
echo "║  Project: ${PROJECT_ID}"
echo "║  Region:  ${REGION}"
echo "║  Target:  ${TARGET}"
echo "╚════════════════════════════════════════════╝"

if [ "$TARGET" == "all" ]; then
    setup_env "qa"
    setup_env "prod"
elif [ "$TARGET" == "qa" ] || [ "$TARGET" == "prod" ]; then
    setup_env "$TARGET"
fi

# ============================================
# Trigger one-time seed if requested
# ============================================
if [ "$SEED" == "seed" ]; then
    if [ "$TARGET" == "all" ]; then
        echo -e "${RED}Seed can only run for one environment at a time.${NC}"
        echo "  Use: ./scripts/ops/setup-scheduler.sh prod seed"
        exit 1
    fi
    trigger_seed "$TARGET"
fi

# ============================================
# Summary
# ============================================
echo ""
echo "╔════════════════════════════════════════════╗"
echo "║  Scheduler Setup Complete!                 ║"
echo "╚════════════════════════════════════════════╝"
echo ""
echo -e "${GREEN}✓ ${#UPSERTED_JOBS[@]} job(s) created/updated${NC}"

if [ "${#FAILED_JOBS[@]}" -ne 0 ]; then
    echo -e "${RED}✗ ${#FAILED_JOBS[@]} job(s) FAILED:${NC}"
    for f in "${FAILED_JOBS[@]}"; do
        echo -e "   ${RED}- ${f}${NC}"
    done
    echo ""
    echo -e "${YELLOW}Re-run the script to retry the failed jobs (the upsert is idempotent),${NC}"
    echo -e "${YELLOW}or reconcile one job with:${NC}"
    echo "   gcloud scheduler jobs update pubsub <NAME> --location=${REGION} ..."
fi

# Schedules skipped because their Cloud Run target is not provisioned yet. Kept
# separate from FAILED_JOBS and deliberately NOT fatal: the image + job are a
# different provisioning step, and exiting non-zero here would abort
# `setup-infra.sh` before its step 4 workers deploy. Printed in the summary so
# the gap cannot scroll past unnoticed.
#
# THE REMEDIATION IS PER-ENTRY, not one command for the whole block. Two
# different scripts provision the jobs that land here — setup-sync-job.sh for
# the `sync-prod-to-qa*` triggers, setup-us-fundamentals-jobs.sh for the six
# EDGAR bulk ones — and a single hardcoded line was right for the first set and
# silently wrong for the second. Each entry therefore carries its own command;
# see the PENDING_JOBS declaration.
if [ "${#PENDING_JOBS[@]}" -ne 0 ]; then
    echo ""
    echo -e "${RED}⚠ ${#PENDING_JOBS[@]} schedule(s) NOT created — the Cloud Run job they trigger does not exist:${NC}"
    for p in "${PENDING_JOBS[@]}"; do
        P_NAME="${p%%|*}"
        if [ "$p" = "$P_NAME" ]; then
            # No command recorded. Say so instead of printing a plausible-looking
            # default — a wrong remediation is what this format exists to remove,
            # and a push site that forgot its command is a bug in THIS script.
            echo -e "   ${RED}- ${P_NAME}${NC}"
            echo -e "     ${RED}(no provisioning command recorded — bug in setup-scheduler.sh)${NC}"
        else
            echo -e "   ${RED}- ${P_NAME}${NC}"
            echo -e "     ${YELLOW}provision with: ${p#*|}${NC}"
        fi
    done
    echo ""
    echo -e "${YELLOW}Cloud Scheduler would accept a trigger pointing at a missing job and then${NC}"
    echo -e "${YELLOW}POST a 404 on every tick while still showing ENABLED, so it is not created.${NC}"
    echo -e "${YELLOW}Run the command shown against each entry (it also builds the image;${NC}"
    echo -e "${YELLOW}setup-sync-job.sh takes --skip-build to reuse the current one), then:${NC}"
    echo "   ./scripts/ops/setup-scheduler.sh ${TARGET}"
fi

echo ""
echo "Verify all jobs:"
echo "  gcloud scheduler jobs list --location=${REGION} --format='table(name,schedule,timeZone,state)'"
echo ""

# Exit non-zero if any job failed — but ONLY after every job was attempted, so a
# single failure is surfaced to CI/callers without stranding the rest of the run.
if [ "${#FAILED_JOBS[@]}" -ne 0 ]; then
    exit 1
fi
echo "Manually trigger a job:"
echo "  gcloud scheduler jobs run <JOB_NAME> --location=${REGION}"
echo ""
echo "Schedule summary:"
echo "  ┌─────────────────────────────────┬─────────────────────────┐"
echo "  │ Job                             │ Schedule (IST)          │"
echo "  ├─────────────────────────────────┼─────────────────────────┤"
echo "  │ stockbook-daily-sync-*          │ Daily 12:30 AM          │"
echo "  │ instrument-sync-daily-*         │ Daily 10:00 PM          │"
echo "  │ mf-sync-daily-*                 │ Daily 10:30 PM          │"
echo "  │ peers-sync-daily-*              │ Daily 11:15 PM          │"
echo "  │ mf-nav-propagate-daily-*        │ Daily 11:45 PM          │"
echo "  │ mf-nav-backfill-daily-*         │ Daily 11:30 PM          │"
echo "  │ mf-metadata-weekly-*            │ Sunday 9:00 PM          │"
echo "  │ sector-enrichment-weekly-*      │ Sunday 9:30 PM          │"
echo "  │ price-sync-daily-*              │ Mon-Fri 11:00 PM        │"
echo "  │ price-backfill-incremental-*    │ Mon-Fri 11:15 PM        │"
echo "  │ intraday-sync-daily-*           │ Mon-Fri 4:05 PM         │"
echo "  │ bhavcopy-sync-daily-prod        │ Mon-Fri 9:00 PM         │"
echo "  │ sync-prod-to-qa-feeds-eod       │ Mon-Fri 9:15 PM         │"
echo "  │ bhavcopy-sync-daily-qa          │ Mon-Fri 9:30 PM         │"
echo "  │ sync-prod-to-qa-feeds-daily     │ Daily 12:45 AM          │"
echo "  └─────────────────────────────────┴─────────────────────────┘"
echo "  (Both sync-prod-to-qa-feeds-* triggers are prod-owned SINGLETONS — no"
echo "   -env suffix — and fire the SAME Cloud Run job. The 9:00/9:15/9:30 PM"
echo "   trio is one ordered chain: prod ARCHIVES, the mirror COPIES, QA REPLAYS,"
echo "   all on the same IST calendar day (MONEY-1194). Do not reorder them.)"
echo ""
