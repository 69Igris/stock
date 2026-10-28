#!/bin/bash
# ============================================
# UseMoney - Scheduled prod->qa Reference Sync (Cloud Run Job) — MONEY-855
# ============================================
# Builds the sync image, creates a least-privilege service account, and deploys
# THREE Cloud Run JOBS off that one image, each with its own Scheduler trigger(s).
# Idempotent — safe to re-run (re-builds the image + updates jobs/schedules in
# place).
#
#   sync-prod-to-qa        --tier=reference (default)   daily, 01:00 IST
#       The 13 rate-limited Mongo collections + the scraped-PDF GCS prefix.
#       WAS weekly (Sun 05:00) until MONEY-1184: six days of drift meant QA
#       held 5,675 corporate actions against prod's 11,525.
#
#   sync-prod-to-qa-feeds  --tier=feeds                 21:15 IST Mon-Fri
#                                                       + 00:45 IST daily
#       MONEY-1085. Mirrors the archived raw exchange files
#       (gs://…-prod/feeds/ -> gs://…-qa/feeds/) so QA can replay prod's exact
#       bhavcopy / instrument-master bytes instead of scraping NSE/BSE itself.
#       MONEY-1373: the same tier now ALSO mirrors `candles/`, the candle
#       warehouse's gzipped-JSONL cold shards — a SECOND rsync pair inside the
#       feeds tier rather than a third tier, because the same QA nightly chain
#       consumes both on the same clock. There is no `--tier=candles`.
#       Touches no MongoDB collection, so nothing in QA is ever dropped.
#       ONE job, TWO triggers (MONEY-1194): the 21:15 EOD pass lands between
#       prod's 21:00 bhavcopy archive and QA's 21:30 bhavcopy consume; the
#       00:45 nightly pass is the catch-all for everything prod archives after
#       that (report-archive-night 21:45, instrument-sync 22:00, NSE JSONs) and
#       the only pass at the weekend.
#
#   sync-prod-to-qa-lake   --tier=lake --apply          02:30 IST daily
#       MONEY-1610. BigQuery lake_silver_prod -> lake_silver_qa with free,
#       in-region COPY jobs (WRITE_TRUNCATE), one per table present in both.
#       Touches no Mongo and no GCS, and WRITES no bronze/private/gold dataset.
#       It READS lake_bronze_prod.partition_load: a table with a live LOADING
#       claim in prod (the loaders DELETE a month, then LOAD it) is skipped
#       with WARN SKIPPED_LOADING and keeps last night's QA copy — the 24 h
#       lake loads run at night, so a copy mid-load would otherwise hand QA an
#       empty month and pass its count check. A skip exits 0. 02:30 IST:
#       after prod's EOD chain (last scheduled writer 23:15) and the 01:00
#       reference sync, clear of event-lake-sink-qa's :10 hourly append to
#       instrument_event (the count check compares right after each copy), and
#       before the lake-gold-qa job's 06:45 IST gold run. Prod's big lake LOADS are
#       manual; a load that lands later is picked up the next night.
#
# WHY a Cloud Run Job (not the Pub/Sub worker): the sync needs mongodump /
# mongorestore / mongosh / `gcloud storage` — not the worker runtime — so it
# lives in its own container. Auth is the job's service account (no keys).
#
# ── THE IMAGE BAKES THE SCRIPT, SO EDITING THE SCRIPT IS NOT A DEPLOY ────────
#
# `scripts/ops/sync-job/Dockerfile` COPYs `sync-prod-to-qa.sh` INTO the image
# and sets it as the ENTRYPOINT. Nothing mounts it and nothing fetches it at run
# time, so a change to that file reaches the two live Cloud Run jobs ONLY when
# this script re-builds and re-deploys. That is the same class as
# `reference_cloud_run_jobs_pin_images`: the resource keeps the artefact it was
# provisioned with, exits 0 the whole time, and the only symptom is that the
# behaviour you edited never happens.
#
# Concretely, and this is why the note is here rather than in a ticket:
# MONEY-1309 added an `--exclude` so the mirror stops copying raw websocket
# ticks into QA. Until `./scripts/ops/setup-sync-job.sh` is run by the founder,
# `sync-prod-to-qa-feeds` keeps running the PREVIOUS script and keeps copying
# them — with the repo, the tests and the docs all agreeing that it does not.
#
# MONEY-1487 / MONEY-1488 are the same shape and the stakes are higher, because
# the change they make is INVISIBLE rather than merely absent: the reference
# job now walks its 54 collections least-recently-visited-first and writes an
# outcome row per collection into QA's `qa_sync_outcomes`. Until this script is
# re-run, `sync-prod-to-qa` keeps the BAKED script — the static walk that left
# 34 collections unsynced since 2026-08-31 — and writes no record at all, so
# `--status` from a laptop reports every collection NEVER and looks like the
# feature is broken rather than un-deployed. Re-provisioning is the deploy.
#
# The job's own env needs nothing new: the record lives in QA, reached through
# the DATABASE_URL_QA secret this job already mounts.
#
# MONEY-1519, same shape again: `candles` is now restored UNIQUE-KEY-FIRST (the
# script creates prod's unique index on the empty collection, then restores
# without `--drop`), and a failed index build records INDEX_BUILD_FAILED rather
# than FAILED. Until this script re-provisions, the baked script keeps running
# `mongorestore --drop` over `candles`, QA's own `tiingo-realtime-qa` writer
# keeps landing bars in the index-less window, and every night keeps ending with
# 29.6M rows and no `candles_symbol_exchange_timeframe_ts_key` — which is what
# `putCandles` assumes exists (MONEY-1485). No env, IAM or resource change: the
# pre-step reads prod and writes QA through the two URLs the job already has.
#
# Direction is hard-coded prod->qa inside sync-prod-to-qa.sh; this only schedules
# it. The job runs with --yes (non-interactive) + the drop+empty-guard mechanism,
# so an empty prod collection can never wipe QA.
#
# Prerequisites:
#   - gcloud authenticated; Cloud Build, Run, Scheduler, Secret Manager APIs on
#   - DATABASE_URL_PROD / DATABASE_URL_QA secrets exist in Secret Manager
#   - GCS buckets stockbook-content-prod / -qa exist
#
# Usage:
#   ./scripts/ops/setup-sync-job.sh                 # build + deploy + schedule
#   ./scripts/ops/setup-sync-job.sh --skip-build    # reuse the current image
#   ./scripts/ops/setup-sync-job.sh --run-now       # also trigger one run immediately
# ============================================

set -euo pipefail

SKIP_BUILD=false
RUN_NOW=false
while [ $# -gt 0 ]; do
    case "$1" in
        --skip-build) SKIP_BUILD=true; shift ;;
        --run-now) RUN_NOW=true; shift ;;
        -h|--help) grep '^#' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
        *) echo "Unknown argument: $1"; exit 1 ;;
    esac
done

RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; BLUE='\033[0;34m'; NC='\033[0m'

PROJECT_ID="stock-book-483718"
REGION="asia-south1"
IMAGE="gcr.io/${PROJECT_ID}/sync-prod-to-qa:latest"
JOB_NAME="sync-prod-to-qa"
JOB_SA_ID="sync-prod-to-qa"
JOB_SA="${JOB_SA_ID}@${PROJECT_ID}.iam.gserviceaccount.com"
# Kept IDENTICAL to setup-scheduler.sh's DB_SYNC_SCHED / DB_SYNC_SCHEDULE, the
# same way FEEDS_SCHEDULE below is. Both scripts can provision this trigger, so
# they must agree on it — they did not until MONEY-1189. setup-scheduler.sh
# renamed the trigger to `-daily` (MONEY-1184) and DELETES the `-weekly` name by
# design ("a stale name that still runs is worse than none"), while this script
# went on re-CREATING `-weekly` from the old constants. So every image rebuild
# here silently resurrected the schedule the other script had just removed, and
# the reference sync then fired twice on Sundays — 01:00 and 05:00. Observed
# live on 2026-08-13: both ENABLED, pointing at the same Cloud Run job.
SCHED_NAME="sync-prod-to-qa-daily"
SCHEDULE="0 1 * * *"              # 01:00 IST — after prod's whole EOD chain and
                                  # after the 00:45 feeds mirror, so the two
                                  # never contend for QA.
LEGACY_SCHED_NAME="sync-prod-to-qa-weekly"

# MONEY-1085: a SECOND job off the SAME image/SA that mirrors only the archived
# raw exchange files (--tier=feeds). Daily, because bhavcopy publishes daily.
# 00:45 IST clears prod's whole EOD chain (bhavcopy 21:00, instrument-sync
# 22:00, price-sync 23:00, price-backfill 23:15) — an earlier slot would ship
# the previous day's files.
#
# MONEY-1194: that reasoning is about the PRODUCER only, and it left the mirror
# landing 3h45m AFTER the consumer. QA runs prod's identical EOD chain at
# prod's identical clock times, so when QA's 21:00 bhavcopy asked for day D's
# archived object, the 00:45 mirror had not copied it yet — the key is
# date-stamped, so yesterday's object cannot satisfy today's request. QA missed
# 100% and fell back to scraping NSE + BSE, silently, every weekday.
#
# So the job now has TWO triggers. Both are the same idempotent
# `gcloud storage rsync -r` over `feeds/` MINUS `TIINGO/ws/` (MONEY-1309 — raw
# websocket ticks, deliberately not mirrored; see the exclusion block in
# sync-prod-to-qa.sh), so the extra tick copies only that day's new objects:
#   - EOD pass, 21:15 IST Mon-Fri: between prod's 21:00 archive and QA's
#     (now) 21:30 consume. The one the daily bhavcopy needs.
#   - Nightly pass, 00:45 IST: KEPT as the catch-all for everything prod
#     archives later (report-archive-night 21:45, instrument-sync 22:00, the
#     NSE/api/* JSONs) and as the only pass at the weekend.
#
# These MUST match setup-scheduler.sh's FEEDS_SYNC_SCHEDULE* / FEEDS_SYNC_SCHED*
# constants: both scripts upsert these same two triggers (this one owns the
# image + jobs + IAM, setup-scheduler.sh reconciles the triggers on every prod
# pass — MONEY-1156), so a disagreement means whichever ran last silently wins.
FEEDS_JOB_NAME="sync-prod-to-qa-feeds"
FEEDS_SCHED_NAME="sync-prod-to-qa-feeds-daily"
FEEDS_SCHEDULE="45 0 * * *"       # 00:45 IST daily — late catch-all
FEEDS_EOD_SCHED_NAME="sync-prod-to-qa-feeds-eod"
FEEDS_EOD_SCHEDULE="15 21 * * 1-5"  # 21:15 IST Mon-Fri — feeds QA's 21:30 bhavcopy
PROD_BUCKET="stockbook-content-prod"
QA_BUCKET="stockbook-content-qa"
# The tile lake is its OWN bucket pair — MONEY-1478. Spelled here beside the
# content pair so the two are visibly a set: a reader looking for "which buckets
# does the mirror touch" must not find half the answer.
LAKE_PROD_BUCKET="stockbook-lake-prod"
LAKE_QA_BUCKET="stockbook-lake-qa"
# MONEY-1610: the THIRD job off the same image/SA — BigQuery silver, prod -> qa.
# The datasets it reads and writes are named here AND inside sync-prod-to-qa.sh
# (LAKE_SRC_DATASET / LAKE_DST_DATASET); a test holds the two in agreement,
# because a grant on one dataset and a copy into another fails only at 02:30.
LAKE_JOB_NAME="sync-prod-to-qa-lake"
LAKE_SCHED_NAME="sync-prod-to-qa-lake-daily"
LAKE_SCHEDULE="30 2 * * *"        # 02:30 IST daily — see the header
LAKE_SRC_DATASET="lake_silver_prod"
LAKE_DST_DATASET="lake_silver_qa"
LAKE_LEDGER_DATASET="lake_bronze_prod"   # READ only: in-flight loads
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/../.." && pwd)"

echo ""
echo "╔════════════════════════════════════════════╗"
echo "║  Scheduled prod->qa sync (Cloud Run Job)   ║"
echo "╠════════════════════════════════════════════╣"
echo "║  Project: ${PROJECT_ID}"
echo "║  Region:  ${REGION}"
echo "║  Schedule:${SCHEDULE} (Asia/Kolkata)"
echo "╚════════════════════════════════════════════╝"
echo ""
# The one fact an operator needs BEFORE the build, not in a header they did not
# open: the image COPYs sync-prod-to-qa.sh, so every edit to that script is
# INERT on the two live jobs until this run replaces the image.
echo -e "${YELLOW}The image BAKES scripts/ops/sync-prod-to-qa.sh — this run is what deploys any edit to it.${NC}"
echo -e "${YELLOW}  Pending as of MONEY-1519, reference tier: candles is restored UNIQUE-KEY-FIRST${NC}"
echo -e "${YELLOW}  and a failed index build is recorded as INDEX_BUILD_FAILED, not FAILED.${NC}"
echo -e "${YELLOW}  Until this completes, every nightly run leaves QA's candles without${NC}"
echo -e "${YELLOW}  candles_symbol_exchange_timeframe_ts_key — the key putCandles assumes.${NC}"
echo -e "${YELLOW}  MONEY-1610: this run also creates sync-prod-to-qa-lake (--tier=lake) — the${NC}"
echo -e "${YELLOW}  baked script must carry the lake tier, or that job exits 1 on 'Unknown --tier'.${NC}"
echo ""

gcloud config set project "$PROJECT_ID" --quiet >/dev/null 2>&1 || true

# ── --skip-build CANNOT create the lake job — MONEY-1610 ─────────────────────
# `--skip-build` deploys whatever `:latest` already holds, and an image built
# before the lake tier answers `--tier=lake` with "Unknown --tier" and exit 1,
# every night, on a job this run would have just created. Reading the image's
# contents is not cheap (no Docker here); whether the lake JOB exists is. It can
# exist only if a run of this script — the version that also builds the tier
# into the image — created it, so its absence means the first deploy has not
# happened and needs a build.
if [ "$SKIP_BUILD" == "true" ] \
    && ! gcloud run jobs describe "$LAKE_JOB_NAME" --region="$REGION" --project="$PROJECT_ID" >/dev/null 2>&1; then
    echo -e "${RED}REFUSING --skip-build: ${LAKE_JOB_NAME} does not exist yet, so :latest may predate --tier=lake.${NC}" >&2
    echo -e "${RED}  Run without --skip-build once; the build is what puts the lake tier in the image.${NC}" >&2
    exit 1
fi

# ── 1. Build + push the image ──────────────────────────────────────────────
if [ "$SKIP_BUILD" != "true" ]; then
    echo -e "${BLUE}━━━ 1/8: Build image (${IMAGE}) ━━━${NC}"
    cd "$ROOT_DIR"
    gcloud builds submit --config=scripts/ops/sync-job/cloudbuild.yaml \
        --substitutions=_IMAGE="$IMAGE" --project="$PROJECT_ID" .
else
    echo -e "${YELLOW}━━━ 1/8: Build (SKIPPED --skip-build) ━━━${NC}"
fi

# ── 2. Service account + least-privilege IAM ───────────────────────────────
echo -e "${BLUE}━━━ 2/8: Service account + IAM ━━━${NC}"
gcloud iam service-accounts describe "$JOB_SA" --project="$PROJECT_ID" &>/dev/null \
    || gcloud iam service-accounts create "$JOB_SA_ID" \
         --display-name="prod->qa reference sync (Cloud Run Job)" --project="$PROJECT_ID"

# Read both DB connection strings from Secret Manager.
for SECRET in DATABASE_URL_PROD DATABASE_URL_QA; do
    gcloud secrets add-iam-policy-binding "$SECRET" \
        --member="serviceAccount:${JOB_SA}" \
        --role="roles/secretmanager.secretAccessor" \
        --project="$PROJECT_ID" --condition=None --quiet >/dev/null
done

# GCS rsync: READ prod bucket, WRITE qa bucket (least-privilege, per-bucket).
# `--condition=None`: the content buckets carry a CONDITIONAL binding
# (setup-databento-jobs.sh's `databento/`-scoped read for lake-writer@), and
# gcloud refuses an unconditioned add to a policy holding conditions unless it
# is told the new binding is deliberately unconditioned.
gcloud storage buckets add-iam-policy-binding "gs://${PROD_BUCKET}" \
    --member="serviceAccount:${JOB_SA}" --role="roles/storage.objectViewer" \
    --condition=None >/dev/null
gcloud storage buckets add-iam-policy-binding "gs://${QA_BUCKET}" \
    --member="serviceAccount:${JOB_SA}" --role="roles/storage.objectAdmin" \
    --condition=None >/dev/null

# ── THE TILE LAKE IS A SECOND BUCKET PAIR — MONEY-1478 ───────────────────────
#
# The D1 chart tiles do NOT live in `stockbook-content-*`; they live in
# `stockbook-lake-{prod,qa}`. The grants above are per-BUCKET, so they say
# nothing about the lake, and the tiles rsync would 403 on a job that had just
# reported every other prefix copied.
#
# Same least-privilege split for the same reason: the mirror must never be able
# to write to prod. A single project-level grant would be one line and would
# also hand this SA write access to every bucket in the project.
# `--condition=None` for the same reason as the content pair: neither lake
# bucket carries a conditional binding today (read 2026-09-23), and the day one
# does, an unconditioned add without it is refused and this script stops here.
gcloud storage buckets add-iam-policy-binding "gs://${LAKE_PROD_BUCKET}" \
    --member="serviceAccount:${JOB_SA}" --role="roles/storage.objectViewer" \
    --condition=None >/dev/null
gcloud storage buckets add-iam-policy-binding "gs://${LAKE_QA_BUCKET}" \
    --member="serviceAccount:${JOB_SA}" --role="roles/storage.objectAdmin" \
    --condition=None >/dev/null

# ── BIGQUERY: the lake tier's grants — MONEY-1610 ────────────────────────────
#
# DATASET-scoped, never project-level: a project dataEditor would reach every
# prod dataset and billing_export. READER (= roles/bigquery.dataViewer) on prod
# silver, WRITER (= roles/bigquery.dataEditor) on QA silver, READER on prod
# bronze (the tier reads `partition_load` to skip tables mid-load; the dataset
# holds the lake's ledger — partition_load, pipeline_run, source_object,
# quarantine — so READER there is read-only visibility of prod's load history),
# and nothing on gold, private or QA bronze. jobUser IS project-level — creating a
# copy or query job is a project operation — and confers no data access alone.
# `--condition=None`: the project policy holds conditional bindings.
#
# MERGE the dataset access list, never replace it: `bq update --source`
# rewrites the whole list, so building it from scratch would drop every other
# binding. Same pattern as setup-lake.sh's grant_dataset.
grant_dataset() {
    local DS="$1" ROLE="$2" TMP
    TMP="$(mktemp "${TMPDIR:-/tmp}/sync-ds.XXXXXX")"
    bq --project_id="$PROJECT_ID" show --format=prettyjson "${PROJECT_ID}:${DS}" > "$TMP"
    MEMBER="$JOB_SA" ROLE="$ROLE" node -e '
      const fs = require("fs");
      const f = process.argv[1];
      const ds = JSON.parse(fs.readFileSync(f, "utf8"));
      ds.access = ds.access || [];
      const want = { role: process.env.ROLE, userByEmail: process.env.MEMBER };
      const has = ds.access.some((a) => a.role === want.role && a.userByEmail === want.userByEmail);
      if (!has) ds.access.push(want);
      fs.writeFileSync(f, JSON.stringify(ds));
      console.error(has ? "     (already granted)" : "     (added)");
    ' "$TMP"
    bq --project_id="$PROJECT_ID" update --source "$TMP" "${PROJECT_ID}:${DS}" >/dev/null
    rm -f "$TMP"
}
grant_dataset "$LAKE_SRC_DATASET" "READER"
grant_dataset "$LAKE_DST_DATASET" "WRITER"
grant_dataset "$LAKE_LEDGER_DATASET" "READER"
gcloud projects add-iam-policy-binding "$PROJECT_ID" \
    --member="serviceAccount:${JOB_SA}" --role="roles/bigquery.jobUser" \
    --condition=None --quiet >/dev/null
echo -e "   ${GREEN}IAM granted (secretAccessor x2; content+lake buckets: prod=objectViewer, qa=objectAdmin;${NC}"
echo -e "   ${GREEN}  BigQuery: ${LAKE_SRC_DATASET}=READER, ${LAKE_DST_DATASET}=WRITER, ${LAKE_LEDGER_DATASET}=READER, project jobUser)${NC}"

# ── 3. Deploy the Cloud Run Job (create or update) ─────────────────────────
echo -e "${BLUE}━━━ 3/8: Cloud Run Job ━━━${NC}"
gcloud run jobs deploy "$JOB_NAME" \
    --image="$IMAGE" \
    --region="$REGION" \
    --service-account="$JOB_SA" \
    --max-retries=1 \
    --task-timeout=3600 \
    --memory=1Gi \
    --cpu=1 \
    --project="$PROJECT_ID"

# Let the job's own SA invoke it (Scheduler authenticates AS this SA).
gcloud run jobs add-iam-policy-binding "$JOB_NAME" --region="$REGION" \
    --member="serviceAccount:${JOB_SA}" --role="roles/run.invoker" \
    --project="$PROJECT_ID" --quiet >/dev/null

# ── 4. Cloud Scheduler daily trigger (create or update) ────────────────────
echo -e "${BLUE}━━━ 4/8: Cloud Scheduler trigger ━━━${NC}"
# Drop the pre-MONEY-1184 name FIRST. Cloud Scheduler keys on the job name, so
# renaming the trigger in setup-scheduler.sh did not retire the old one — it
# left an orphan pointing at the same Cloud Run job. Deleting before creating
# means a run of THIS script converges on the same single-trigger state that
# setup-scheduler.sh produces, whichever order the two are run in.
if gcloud scheduler jobs describe "$LEGACY_SCHED_NAME" --location="$REGION" &>/dev/null; then
    gcloud scheduler jobs delete "$LEGACY_SCHED_NAME" --location="$REGION" --quiet
    echo -e "   ${YELLOW}Removed legacy ${LEGACY_SCHED_NAME} (superseded by ${SCHED_NAME})${NC}"
fi
RUN_URI="https://${REGION}-run.googleapis.com/apis/run.googleapis.com/v1/namespaces/${PROJECT_ID}/jobs/${JOB_NAME}:run"
SCHED_ARGS=(
    --location="$REGION"
    --schedule="$SCHEDULE"
    --time-zone="Asia/Kolkata"
    --uri="$RUN_URI"
    --http-method=POST
    --oauth-service-account-email="$JOB_SA"
    --project="$PROJECT_ID"
)
if gcloud scheduler jobs describe "$SCHED_NAME" --location="$REGION" &>/dev/null; then
    gcloud scheduler jobs update http "$SCHED_NAME" "${SCHED_ARGS[@]}" --quiet
else
    gcloud scheduler jobs create http "$SCHED_NAME" "${SCHED_ARGS[@]}" --quiet
fi
echo -e "   ${GREEN}Scheduled ${SCHED_NAME} (${SCHEDULE} IST)${NC}"

# ── 5. The feeds job + its daily trigger (MONEY-1085) ──────────────────────
# Same image, same service account, same secrets — only the args differ. The
# feeds tier is GCS-only, so it needs no Mongo tooling budget: a smaller
# timeout is enough and keeps a slow rsync from masking a hang.
echo -e "${BLUE}━━━ 5/8: Cloud Run Job (feeds tier) ━━━${NC}"
# THERE IS NO `--tier=candles`, AND THERE MUST NOT BE ONE. MONEY-1373 added the
# candle warehouse's cold shards (`candles/`) to the mirror as a SECOND rsync
# pair INSIDE the `feeds` tier, not as a third tier: the two prefixes are
# consumed by the same QA nightly chain on the same clock, so they belong on the
# same job and the same two triggers. `--tier` accepts exactly
# reference|sample|feeds|lake and exits 1 on anything else, so inventing one here
# would leave this job failing every run. The args below are correct AS THEY
# STAND — the candles pair needs no flag, and no IAM change either (the SA is
# granted prod objectViewer / qa objectAdmin at BUCKET level in step 2, which is
# prefix-agnostic).
gcloud run jobs deploy "$FEEDS_JOB_NAME" \
    --image="$IMAGE" \
    --region="$REGION" \
    --service-account="$JOB_SA" \
    --args="--yes,--tier=feeds" \
    --max-retries=1 \
    `# MONEY-1483 — 1800s -> 3600s, the SECOND wall this job hit. Raising the` \
    `# memory to 2Gi retired the OOM and the failure mode changed to` \
    `#   Task ... failed with exit code 0 and message: The configured timeout` \
    `#   was reached.` \
    `# which is the job finally doing real work: that 30-minute run copied` \
    `# +77,816 objects / +3.3 GiB into QA, the first bytes to reach the mirror` \
    `# since 2026-08-12 (60,032 -> 137,848 of prod's 201,673).` \
    `# ` \
    `# 3600s is sized for the CATCH-UP, not the steady state. rsync skips what` \
    `# is already present, so runs resume — but the backlog was 141,641 objects` \
    `# and at the measured ~43 objects/sec one 1800s window cannot clear it.` \
    `# ` \
    `# READ THIS BEFORE RAISING IT FURTHER: the 21:15 IST trigger exists so the` \
    `# mirror lands BEFORE QA's 21:30 bhavcopy replays it (MONEY-1194). A run` \
    `# that legitimately uses the whole 3600s is still copying at 22:15 and` \
    `# defeats that ordering. That is acceptable only while catching up, because` \
    `# at parity the nightly delta is one day of files and the cost is dominated` \
    `# by LISTING both sides. If this job routinely needs more than an hour at` \
    `# parity, the answer is a narrower prefix or a manifest — not a bigger` \
    `# number, which would silently move the mirror past the consumer it feeds.` \
    --task-timeout=3600 \
    `# MONEY-1483 — 512Mi -> 2Gi. This job has succeeded EXACTLY ONCE in its` \
    `# life (2026-08-12T19:07, the manual provisioning run) and has failed` \
    `# every scheduled execution since: ~64 runs over 38 days, all OOM:` \
    `#   Out-of-memory event detected in container` \
    `#   ERROR: Worker process 40 died silently with exit code -9` \
    `#   At gs://stockbook-content-prod/feeds/**, worker ... listed 32000...` \
    `# ` \
    `# The consequence was invisible because a replay MISS is a soft failure` \
    `# by design: QA silently re-fetched from NSE/BSE and its logs read normal.` \
    `# Measured 2026-09-19 — 42 of 42 logged QA runs in 30 days report` \
    `# replayHits=0 replayMisses=3, a 100% miss rate, and every object under` \
    `# QA's feeds/NSE/ is stamped 2026-08-12T19:19:08Z. QA is short 141,641` \
    `# objects / 16.3 GiB and has been scraping the exchanges every weekday.` \
    `# ` \
    `# NOT the TIINGO/ws exclusion. That landed in MONEY-1309 and IS in the` \
    `# deployed image (verified by pulling app/sync-prod-to-qa.sh out of the` \
    `# running layer). The OOM happens WITH it active: rsync holds a listing of` \
    `# BOTH sides in memory, and the source prefix is 201,673 objects / 20.94` \
    `# GiB. Excluding one feed does not change the order of magnitude.` \
    --memory=2Gi \
    --cpu=1 \
    --project="$PROJECT_ID"

gcloud run jobs add-iam-policy-binding "$FEEDS_JOB_NAME" --region="$REGION" \
    --member="serviceAccount:${JOB_SA}" --role="roles/run.invoker" \
    --project="$PROJECT_ID" --quiet >/dev/null

echo -e "${BLUE}━━━ 6/8: Cloud Scheduler triggers (feeds tier) ━━━${NC}"
FEEDS_RUN_URI="https://${REGION}-run.googleapis.com/apis/run.googleapis.com/v1/namespaces/${PROJECT_ID}/jobs/${FEEDS_JOB_NAME}:run"

# TWO triggers on ONE job (MONEY-1194) — see the constants block for why. The
# EOD pass goes first: it is the one QA's bhavcopy depends on. The run URI is
# the third argument so the lake job's trigger (step 8) reuses this.
upsert_trigger() {
    local SCHED_NAME=$1
    local SCHEDULE=$2
    local URI=$3
    local ARGS=(
        --location="$REGION"
        --schedule="$SCHEDULE"
        --time-zone="Asia/Kolkata"
        --uri="$URI"
        --http-method=POST
        --oauth-service-account-email="$JOB_SA"
        --project="$PROJECT_ID"
    )
    if gcloud scheduler jobs describe "$SCHED_NAME" --location="$REGION" &>/dev/null; then
        gcloud scheduler jobs update http "$SCHED_NAME" "${ARGS[@]}" --quiet
    else
        gcloud scheduler jobs create http "$SCHED_NAME" "${ARGS[@]}" --quiet
    fi
    echo -e "   ${GREEN}Scheduled ${SCHED_NAME} (${SCHEDULE} IST)${NC}"
}

upsert_trigger "$FEEDS_EOD_SCHED_NAME" "$FEEDS_EOD_SCHEDULE" "$FEEDS_RUN_URI"
upsert_trigger "$FEEDS_SCHED_NAME" "$FEEDS_SCHEDULE" "$FEEDS_RUN_URI"

# ── 7. The lake job (MONEY-1610) ───────────────────────────────────────────
# `--apply` is in the DEPLOYED args because the scheduler POSTs `:run` with no
# overrides; without it every nightly run would be a plan. A human preview is
# the script itself with no --apply, or this job executed with
# `--args=--tier=lake`. Copy jobs are server-side, so the container only
# waits: 512Mi, and 1800s against a measured 14 tables / 52 GiB.
echo -e "${BLUE}━━━ 7/8: Cloud Run Job (lake tier) ━━━${NC}"
gcloud run jobs deploy "$LAKE_JOB_NAME" \
    --image="$IMAGE" \
    --region="$REGION" \
    --service-account="$JOB_SA" \
    --args="--tier=lake,--apply" \
    --max-retries=1 \
    --task-timeout=1800 \
    --memory=512Mi \
    --cpu=1 \
    --project="$PROJECT_ID"

gcloud run jobs add-iam-policy-binding "$LAKE_JOB_NAME" --region="$REGION" \
    --member="serviceAccount:${JOB_SA}" --role="roles/run.invoker" \
    --project="$PROJECT_ID" --quiet >/dev/null

echo -e "${BLUE}━━━ 8/8: Cloud Scheduler trigger (lake tier) ━━━${NC}"
upsert_trigger "$LAKE_SCHED_NAME" "$LAKE_SCHEDULE" \
    "https://${REGION}-run.googleapis.com/apis/run.googleapis.com/v1/namespaces/${PROJECT_ID}/jobs/${LAKE_JOB_NAME}:run"

# ── Optional: run once now ─────────────────────────────────────────────────
if [ "$RUN_NOW" == "true" ]; then
    echo -e "${BLUE}Triggering one run now...${NC}"
    gcloud run jobs execute "$JOB_NAME" --region="$REGION" --project="$PROJECT_ID"
fi

echo ""
echo -e "${GREEN}Done.${NC}"
echo -e "Manual run (reference, daily): gcloud run jobs execute ${JOB_NAME} --region=${REGION}"
echo -e "Manual run (feeds, daily):      gcloud run jobs execute ${FEEDS_JOB_NAME} --region=${REGION}"
echo -e "Manual run (lake, daily):       gcloud run jobs execute ${LAKE_JOB_NAME} --region=${REGION}"
echo -e "Lake PLAN (writes nothing):     gcloud run jobs execute ${LAKE_JOB_NAME} --region=${REGION} --args=--tier=lake"
echo -e "Logs:  gcloud run jobs executions list --job=${JOB_NAME} --region=${REGION}"
echo -e "       gcloud run jobs executions list --job=${FEEDS_JOB_NAME} --region=${REGION}"
echo -e "       gcloud run jobs executions list --job=${LAKE_JOB_NAME} --region=${REGION}"
echo ""
