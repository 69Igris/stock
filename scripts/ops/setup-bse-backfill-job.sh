#!/usr/bin/env bash
#
# setup-bse-backfill-job.sh — provision the Cloud Run job `bse-backfill-{env}`.
#
# MONEY-1258. The BSE historical results walk, moved off the operator's laptop.
#
# ── WHY A JOB AND NOT A LAPTOP RUN ────────────────────────────────────────────
#
# Measured from the live 2025 run: 122 rows across 49 symbols = 2.49 filings per
# symbol-year, over a 2,255-company cohort.
#
# MEASURED over 742 stored filings across 299 symbols in 118 minutes of a real
# run — not estimated from the pacing constants, which understate it badly:
#
#     9.5 s per filing        <- 6x PDF_PACE_MS alone; the 5.7 MB average
#                                attachment DOWNLOAD dominates, not the sleep
#    23.6 s per symbol
#     2.48 filings per symbol-year
#
#     one year over 2,255 symbols  ~= 14.8 h
#     three years                  ~= 38 h    <- OVER the 24h task cap
#     2015-2024, all ten years     ~= 148 h
#
# That is not a laptop run. `setup-xbrl-backfill-job.sh` exists for exactly this
# reason and records the cost: "two agents lost a run to machine sleep on
# 2026-08-19."
#
# ── THE 24h CAP IS BELOW THE FULL WALK. SPLIT BY YEAR. ────────────────────────
#
# ~148h EXCEEDS Cloud Run's maximum task timeout of 86,400s many times over. A
# single `--from-year=2015` execution CANNOT finish — it would be killed at 24h
# with `--max-retries=0`, having written whatever it reached.
#
# Worse than slow: a KILLED TASK CANNOT CHAIN. The follow-up execution is
# published by the job itself at the end of a successful run, so a shard that
# overruns leaves the sequence stalled with no error and no next execution —
# silent, which is the failure shape this whole ticket has been about. That is
# why shards are sized with headroom rather than to the cap.
#
# That is not data loss (see RESUMABILITY below), but it is a wasted day and a
# confusing failure. Run it in shards instead, each comfortably inside the cap.
#
# ── RUN THE SHARDS NEWEST FIRST ───────────────────────────────────────────────
#
# The walk is SCRIP-MAJOR, not year-major: for each company it issues ONE
# `fetchBSEAnnouncementsByCategory` call spanning `fromYear-01-01 .. toYear-12-31`
# and writes every filing it returns. So there is no year ordering INSIDE a run
# to tune — an interruption loses SCRIPS, not years (stop at company 800 of
# 2,255 and you hold every requested year for 800 companies and nothing for the
# rest).
#
# Recency is therefore controlled ONLY by the shard boundaries, which makes
# their ORDER the whole lever. Newest first, because that is the order the data
# becomes useful in:
#
#   - ~19 of the 26 owned StockRatios columns need only the LATEST annual
#     period. Recent shards make the ratio panel computable; older ones only
#     deepen it.
#   - The Financials tab reads most-recent-first, so the visible rows come from
#     the newest years.
#   - Growth needs 2 periods and the 3Y/5Y CAGRs need 4 and 6 — all satisfied by
#     working BACKWARDS from today, never by starting at 2015.
#
# ONE YEAR PER SHARD, ten of them, newest first — see BSE_SHARD_PLAN. At ~14.8h
# each that leaves ~9h of headroom against the cap even at the laptop bandwidth
# this was measured on; Cloud Run's egress should be faster, and being early is
# free while being late kills the chain.
#
#     2024, 2023, 2022, 2021, 2020, 2019, 2018, 2017, 2016, 2015
#
# You trigger ONLY the first. Each shard chains the next on success, so the
# whole sequence is one command.
#
# (2025 is excluded because the interactive shard already covers it.)
#
# ── RESUMABILITY IS WHAT MAKES ALL OF THIS SAFE ───────────────────────────────
#
# A row that already has bytes computes `hasBytes` true and is classified
# `skip-same`, so a re-run skips it after ONE indexed read. A 429 breaks the
# walk cleanly (`RATE LIMITED after N scrip(s) — stopping`) and keeps
# everything written. So an interrupted shard costs TIME, never work — which is
# why `--max-retries=0` is right: a retry would restart a 30-hour walk into the
# host that just throttled us.
#
# ── STORAGE ───────────────────────────────────────────────────────────────────
#
# ~4.9 MB average attachment (min 0.4, max 23.7 measured). 61,800 filings is
# roughly 300 GB into the content bucket. Know that before running all shards.
#
# ── NO SCHEDULER TRIGGER, EVER ────────────────────────────────────────────────
#
# `bse-announcements-sync` already captures NEW filings nightly. This job
# fetches HISTORY, which is one-shot per shard. A nightly re-walk of a decade is
# the fastest way to get our egress throttled off bseindia.com — and this repo
# has been 429'd by a data host before (MONEY-853).
#
# ── EGRESS IS PROVEN, NOT ASSUMED ─────────────────────────────────────────────
#
# Cloud Run CAN download BSE attachments: the nightly worker holds 822
# `stock_documents` rows with a real `gcsPath`, including a 15.2 MB PDF fetched
# from www.bseindia.com at 04:43 IST on 2026-08-27. Checked because
# api.tickertape.in answers 200 from a laptop and 403 from Cloud Run
# (MONEY-1220) — "works on my machine" is not evidence about this environment.
#
# Usage:
#   ./scripts/ops/setup-bse-backfill-job.sh prod
#   ./scripts/ops/setup-bse-backfill-job.sh prod --dry-run
#   ./scripts/ops/setup-bse-backfill-job.sh prod --image=IMG
#   ./scripts/ops/setup-bse-backfill-job.sh prod --task-timeout=43200
#
set -euo pipefail

RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; BLUE='\033[0;34m'; NC='\033[0m'

PROJECT_ID="stock-book-483718"
REGION="asia-south1"
JOB_SA="stockbook-api@${PROJECT_ID}.iam.gserviceaccount.com"

ENV=${1:-""}
shift || true

IMAGE=""
DRY_RUN=false
# 24h — Cloud Run's maximum. Deliberately the cap and not the estimate: a shard
# that finishes early exits early, and one that would overrun is better killed
# by the platform than left running past a boundary nobody is watching.
TASK_TIMEOUT="86400"

while [ $# -gt 0 ]; do
    case "$1" in
        --image=*)        IMAGE="${1#*=}"; shift ;;
        --task-timeout=*) TASK_TIMEOUT="${1#*=}"; shift ;;
        --dry-run)        DRY_RUN=true; shift ;;
        *) echo "Unknown option: $1" >&2; exit 1 ;;
    esac
done

case "$ENV" in
    prod)
        BUCKET="stockbook-content-prod"
        DB_SECRET="DATABASE_URL_PROD"
        DD_SECRET="DD_API_KEY_PROD"
        ;;
    qa)
        BUCKET="stockbook-content-qa"
        DB_SECRET="DATABASE_URL_QA"
        DD_SECRET="DD_API_KEY_QA"
        ;;
    *)
        echo "Usage: $0 {prod|qa} [--image=IMG] [--task-timeout=SECS] [--dry-run]"
        echo
        echo "Deploys the Cloud Run job bse-backfill-{env} (MONEY-1258)."
        echo "No Scheduler trigger, ever — see the header."
        exit 1
        ;;
esac

SERVICE_NAME="stockbook-workers-${ENV}"
JOB_NAME="bse-backfill-${ENV}"
ENTRYPOINT="dist/bse-backfill.js"

# Per the repo's GCP isolation rule: never activate a config, always pass the
# account/project explicitly on each call.
GC=(gcloud --project="$PROJECT_ID" --account=founder@disdigital.in)

# ── 1. Resolve the image from the live service ────────────────────────────
echo -e "${BLUE}━━━ 1/3: Resolve image from ${SERVICE_NAME} ━━━${NC}"
IMAGE_SOURCE="explicit --image"
if [ -z "$IMAGE" ]; then
    IMAGE_SOURCE="live ${SERVICE_NAME} service"
    IMAGE="$("${GC[@]}" run services describe "$SERVICE_NAME" \
        --region="$REGION" \
        --format='value(spec.template.spec.containers[0].image)' 2>/dev/null || true)"
fi

# FAILS CLOSED. An empty IMAGE must never reach `gcloud run jobs deploy`: it is
# read as "keep whatever is there", which on a re-provision silently preserves
# the stale pin this script exists to move.
if [ -z "$IMAGE" ]; then
    echo -e "${RED}Could not resolve the ${SERVICE_NAME} image.${NC}"
    echo "Is the workers service deployed to ${ENV}? Otherwise pass --image=..."
    exit 1
fi

IMAGE_TAG="${IMAGE##*:}"
IMAGE_SHA="${IMAGE_TAG#"${ENV}"-}"
echo -e "   image  : ${GREEN}${IMAGE}${NC}"
echo -e "   source : ${IMAGE_SOURCE}"
echo -e "   commit : ${GREEN}${IMAGE_SHA}${NC}"
echo -e "   ${YELLOW}PREFLIGHT: this image must contain ${ENTRYPOINT}"
echo -e "   (the 'bse-backfill' entry in workers/tsup.config.ts). On an older"
echo -e "   image the container dies instantly with"
echo -e "   \"Cannot find module /app/${ENTRYPOINT}\".${NC}"

# ── 2. Deploy the job ─────────────────────────────────────────────────────
echo -e "${BLUE}━━━ 2/3: Cloud Run Job — ${JOB_NAME} ━━━${NC}"

# 2Gi, not the 1Gi the XBRL jobs use. This one buffers a WHOLE PDF in memory
# (`Buffer.from(await res.arrayBuffer())`) before uploading, and the measured
# maximum attachment is 23.7 MB against a 4.9 MB average. 1Gi would very likely
# survive; the headroom is cheap next to losing a 24h shard to an OOM.
deploy_args=(
    run jobs deploy "$JOB_NAME"
    --image="$IMAGE"
    --region="$REGION"
    --service-account="$JOB_SA"
    # The script path belongs in --command, NOT --args. `gcloud run jobs execute
    # --args=...` REPLACES the container's args rather than appending, so with
    # the entrypoint in --args every parameterised execution would drop it and
    # run `node --from-year=2015`. `--args=""` clears the list (there is no
    # --clear-args on jobs deploy); without it a re-deploy KEEPS the old args.
    --command="node,$ENTRYPOINT"
    --args=""
    # A retry re-walks the shard from the top. Cheap in rows — a stored filing
    # costs one indexed read via `skip-same` — but NOT cheap against BSE: a task
    # killed by the 24h cap or by the 429 breaker would be restarted straight
    # back into the host that just cut us off, turning a protective abort into a
    # tight retry loop. Re-running is a human decision.
    --max-retries=0
    --task-timeout="$TASK_TIMEOUT"
    --memory=2Gi
    --cpu=1
    # Set EXPLICITLY: a job spec does NOT inherit the service's env block.
    # Without GCP_PROJECT_ID and GCP_STORAGE_BUCKET every `uploadFile` throws
    # into a best-effort catch and the whole walk writes rows with gcsPath ""
    # while reporting success — measured, 59 rows, 2026-08-27. The job's own
    # zero-attachment check now fails the run instead, but only because these
    # are here to make success possible in the first place.
    #
    # FEED_ARCHIVE_MODE is absent ON PURPOSE: this script calls `uploadFile`
    # directly and never routes through `getFeedAsset`, so archive/replay has no
    # meaning for it. Setting it would imply a coupling that does not exist.
    # MONEY-1278 — a Cloud Run JOB has no Datadog agent. DD_API_KEY is what makes
    # `datadog-metrics` emit at all (it no-ops without one, so `reportJobOutcome`
    # reached nobody from any of the 17 TypeScript jobs — including `feed-parse`,
    # which apply-monitors.sh monitors on both envs, so its monitor watched a series
    # that was never emitted). DD_TRACE_ENABLED=false overrides the `true` the image
    # bakes in, so dd-trace does not boot against a socket that is not there.
    --set-env-vars="GCP_STORAGE_BUCKET=${BUCKET},GCP_PROJECT_ID=${PROJECT_ID},DD_ENV=${ENV},DD_TRACE_ENABLED=false"
    --set-secrets="DATABASE_URL=${DB_SECRET}:latest,GCP_SERVICE_ACCOUNT_KEY_BASE64=GCP_SERVICE_ACCOUNT_KEY_BASE64:latest,DD_API_KEY=${DD_SECRET}:latest"
)

if [ "$DRY_RUN" = true ]; then
    echo "   [dry-run] gcloud ${deploy_args[*]}"
    echo "   [dry-run] gcloud run jobs add-iam-policy-binding ${JOB_NAME} --region=${REGION} --member=serviceAccount:${JOB_SA} --role=roles/run.invoker"
else
    "${GC[@]}" "${deploy_args[@]}"
    "${GC[@]}" run jobs add-iam-policy-binding "$JOB_NAME" --region="$REGION" \
        --member="serviceAccount:${JOB_SA}" --role="roles/run.invoker" \
        --quiet >/dev/null
    echo -e "   ${GREEN}${JOB_NAME} deployed${NC}"
fi

# ── 3. No Scheduler trigger — deliberate ──────────────────────────────────
echo -e "${BLUE}━━━ 3/3: Cloud Scheduler ━━━${NC}"
echo -e "   ${YELLOW}None, deliberately. bse-announcements-sync already captures"
echo -e "   NEW filings nightly; this job fetches HISTORY, which is one-shot per"
echo -e "   shard. A nightly re-walk of a decade is the fastest way to get our"
echo -e "   egress throttled off bseindia.com.${NC}"

# Unquoted heredoc so the printed commands name the env actually provisioned.
cat <<EOF

────────────────────────────────────────────────────────────────
Provisioned ${JOB_NAME} (${ENV}).

  image   ${IMAGE}
  commit  ${IMAGE_SHA}
  bucket  ${BUCKET}
  retry   --max-retries=0   task-timeout ${TASK_TIMEOUT}s
  memory  2Gi

TRIGGER ONE SHARD. Each chains the next on success, newest first:
2024 -> 2023 -> ... -> 2015, ten shards of ~14.8h. Measured 9.5s per filing
(the 5.7 MB download dominates, not PDF_PACE_MS), so a 3-year shard would be
~38h and be KILLED at the 24h cap — and a killed task cannot chain.

  gcloud run jobs execute ${JOB_NAME} --region=${REGION} \\
    --project=${PROJECT_ID} --account=founder@disdigital.in \\
    --args=--apply,--from-year,2024,--to-year,2024

--apply needs no prompt here: Cloud Run sets CLOUD_RUN_JOB, and the job
EXECUTION is the confirmation. Locally the TTY prompt still applies.

WATCH IT:
  gcloud run jobs executions list --job=${JOB_NAME} --region=${REGION} \\
    --project=${PROJECT_ID} --account=founder@disdigital.in

  gcloud logging read \\
    'resource.type="cloud_run_job" AND resource.labels.job_name="${JOB_NAME}"' \\
    --project=${PROJECT_ID} --account=founder@disdigital.in \\
    --freshness=1h --limit=30 --format='value(timestamp,textPayload)'

An interrupted shard is SAFE to re-run: stored rows are skipped after one
indexed read. Expect roughly 300 GB across all shards.
────────────────────────────────────────────────────────────────
EOF
