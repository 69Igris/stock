#!/bin/bash
# ============================================
# UseMoney - Historical Feed Backfill + Parse (Cloud Run Jobs) — MONEY-941
# ============================================
# Deploys FOUR Cloud Run JOBS off the EXISTING stockbook-workers image:
#
#   feed-backfill   scripts/jobs/feed-backfill.ts -> dist/feed-backfill.js
#       Walks each report family BACKWARDS from today to its startDate, pulling
#       every trading day's file through getFeedAsset() so it lands in
#       gs://<bucket>/feeds/. Decades of history, so it runs for HOURS.
#
#   feed-parse      scripts/jobs/feed-parse.ts    -> dist/feed-parse.js
#       Reads what the walk archived out of GCS and writes DailyPrice
#       (BHAVCOPY_HIST) + DerivativeEOD rows. Pure GCS->Mongo, no exchange
#       traffic at all.
#
#   feed-repair     scripts/jobs/feed-repair.ts   -> dist/feed-repair.js
#       MONEY-1169 / MONEY-1317 / MONEY-1322. Strips the multipart upload
#       envelope from GCS objects written through the broken `uploadFile`, in
#       place. Dry-run by default; `--apply` writes, `--audit` is strictly
#       read-only. It got a deploy call here in MONEY-1317 because the alert
#       path already pointed at this script (build-provenance.ts) while the
#       specs said "provisioned BY HAND" and this script deployed nothing of
#       the sort — see step 4a.
#
#       MONEY-1322 gave it FEED_REPAIR_CONTAINER_MI, derived from
#       --repair-memory by `mi_of`, so the job can size its own download pool
#       instead of trusting a `--concurrency` default that does not fit the
#       task. Step 4a carries the arithmetic and what it replaced.
#
# WHY Cloud Run JOBS and not the Pub/Sub push worker: the push worker is bound
# by Pub/Sub's 600s ack deadline. These run for hours. Same image either way —
# workers/tsup.config.ts emits every entry point into dist/, so the jobs
# need no TypeScript source and no tsx in the runtime image.
#
# WHY THE WALK HAS NO CLOUD SCHEDULER TRIGGER (deliberate, do not "fix"):
#   The nightly incremental capture is already report-archive-sync (MONEY-940),
#   which grabs TODAY's file for every enabled family. feed-backfill exists to
#   fetch HISTORY — that is a one-shot per family, not a recurring task. Putting
#   it on a schedule would re-walk three decades of NSE/BSE archives every
#   single night, which is both pointless and the fastest way to get our egress
#   IP throttled off the exchange sites the whole product depends on.
#
# THE PARSE + SUMMARY JOBS DO GET NIGHTLY TRIGGERS, prod only (MONEY-1100 P4.7):
#   feed-parse is GCS→Mongo with per-file checkpoints, so a nightly no-args run
#   parses exactly the files report-archive-sync added since yesterday — zero
#   exchange traffic, minutes of work. fo-summary then derives the day's
#   DerivativeSummary rows from the freshly parsed DerivativeEOD. Without these
#   two triggers the archive grows nightly but the DB stops at the last manual
#   parse — bytes without rows. QA gets no triggers: its bucket has no feeds/
#   mirror yet (setup-sync-job.sh) and its DB has no DerivativeEOD, so both
#   jobs would no-op; provision the mirror first, then re-run this script.
#
#   fo-summary       scripts/jobs/fo-summary.ts    -> dist/fo-summary.js
#       DerivativeEOD -> DerivativeSummary per (underlying, exchange, day):
#       futures OI + change, basis, PCR, max pain, rollover, OI buildup.
#       Also takes --backfill for the one-shot historical derivation.
#
#   xbrl-backfill   scripts/jobs/xbrl-backfill.ts -> dist/xbrl-backfill.js
#       MONEY-1114 / MONEY-1220. Walks NSE's results index month by month from
#       2018 and lands every filing's XBRL into XbrlFiling, including the ANNUAL
#       row each March-quarter document carries beside its quarter.
#
#       ITS SPEC NOW LIVES IN ITS OWN SCRIPT — scripts/ops/setup-xbrl-backfill-job.sh
#       — and step 4b below DELEGATES to it rather than deploying it inline.
#       Not tidiness: `gcloud run jobs deploy --set-env-vars` REPLACES the job's
#       env list, so two scripts owning one job means "whichever ran last wins",
#       silently. And they MUST differ — that job takes FEED_ARCHIVE_MODE=replay
#       on QA (it fetches from NSE, so QA has to replay prod's archived bytes
#       rather than scrape the exchange a second time), while the four jobs
#       above take archive on both. Provisioning either script alone is
#       therefore still correct and complete for the jobs it owns.
#
# IMAGE: resolved from the LIVE stockbook-workers Cloud Run service, so the jobs
# always execute exactly the code prod is running. There is no separate build
# and therefore no way for the job image to silently drift from the service.
#
#   >>> PREFLIGHT <<<  The resolved image MUST have been built from a commit
#   that contains the job entry points in workers/tsup.config.ts. On an older
#   image the container starts and dies instantly with
#   "Cannot find module /app/dist/feed-backfill.js". Merge + let the release
#   trigger rebuild BEFORE provisioning.
#
# Prerequisites:
#   - gcloud authenticated; Cloud Run API on
#   - stockbook-workers-{env} service already deployed (that is the image source)
#
# Usage (env is positional and REQUIRED, as in setup-infra.sh):
#   ./scripts/ops/setup-feed-backfill-job.sh prod
#   ./scripts/ops/setup-feed-backfill-job.sh qa
#   ./scripts/ops/setup-feed-backfill-job.sh prod --dry-run     # print, change nothing
#   ./scripts/ops/setup-feed-backfill-job.sh prod --image=IMG   # pin an explicit image
#
# Executing a walk (NOT done by this script — see EXECUTION below):
#   gcloud run jobs execute feed-backfill-prod --region=asia-south1 \
#       --args="--families=nse-cm-legacy,--from=2024-07-05,--to=2020-01-01"
# ============================================

set -euo pipefail

RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; BLUE='\033[0;34m'; NC='\033[0m'

PROJECT_ID="stock-book-483718"
REGION="asia-south1"
# Same SA the workers service runs as: already has Mongo egress + GCS write on
# the bucket, so the jobs need no new IAM surface of their own.
JOB_SA="stockbook-api@${PROJECT_ID}.iam.gserviceaccount.com"

# Env is POSITIONAL and REQUIRED, matching setup-infra.sh / setup-scheduler.sh.
# There is deliberately no default: these jobs write to a real bucket and a real
# database, and every sibling ops script makes you name the environment out loud.
ENV=${1:-""}
shift || true

IMAGE=""
DRY_RUN=false
# MONEY-1322 — feed-repair's task memory. It is a VARIABLE rather than a literal
# because the job now derives its download pool from this exact number
# (FEED_REPAIR_CONTAINER_MI, set from it below), so moving one without the other
# is the drift the derivation exists to remove.
REPAIR_MEMORY="2Gi"
while [ $# -gt 0 ]; do
    case "$1" in
        --image=*) IMAGE="${1#*=}"; shift ;;
        --repair-memory=*) REPAIR_MEMORY="${1#*=}"; shift ;;
        --dry-run) DRY_RUN=true; shift ;;
        -h|--help) grep '^#' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
        *) echo "Unknown argument: $1"; exit 1 ;;
    esac
done

case "$ENV" in
    prod) BUCKET="stockbook-content-prod"; DB_SECRET="DATABASE_URL_PROD"; DD_SECRET="DD_API_KEY_PROD" ;;
    qa)   BUCKET="stockbook-content-qa";   DB_SECRET="DATABASE_URL_QA"; DD_SECRET="DD_API_KEY_QA" ;;
    *)
        echo "Usage: ./scripts/ops/setup-feed-backfill-job.sh [qa|prod] [options]"
        echo ""
        echo "Options:"
        echo "  --image=IMG          Pin an explicit image instead of resolving it"
        echo "                       from the live stockbook-workers-{env} service"
        echo "  --repair-memory=SIZE Task memory for feed-repair (default 2Gi). Also"
        echo "                       becomes FEED_REPAIR_CONTAINER_MI, which the job"
        echo "                       derives its download pool from (MONEY-1322)."
        echo "  --dry-run            Print the gcloud calls, change nothing"
        echo ""
        echo "Deploys the Cloud Run jobs feed-backfill-{env}, feed-parse-{env},"
        echo "fo-summary-{env} and feed-repair-{env}. Walk and repair never get a"
        echo "trigger; parse + summary get nightly prod triggers (MONEY-1100 P4.7)."
        exit 1
        ;;
esac

# Cloud Run names are per-env; the deployed services are stockbook-workers-prod
# / -qa, NOT a bare stockbook-workers.
SERVICE_NAME="stockbook-workers-${ENV}"
BACKFILL_JOB="feed-backfill-${ENV}"
PARSE_JOB="feed-parse-${ENV}"
SUMMARY_JOB="fo-summary-${ENV}"
REPAIR_JOB="feed-repair-${ENV}"
# NOTE there is deliberately no XBRL_JOB here. `xbrl-backfill-${ENV}` is named
# and specified in exactly one place — scripts/ops/setup-xbrl-backfill-job.sh —
# and step 4b delegates to it. See the header.
XBRL_SETUP="$(dirname "$0")/setup-xbrl-backfill-job.sh"

# Per the repo's GCP isolation rule: never activate a config, always pass the
# account/project explicitly on each call.
GC=(gcloud --project="$PROJECT_ID" --account=founder@disdigital.in)

# ── Cloud Run size -> MiB, REFUSING rather than defaulting ────────────────────
#
# MONEY-1322. feed-repair derives its download pool from the container's memory,
# so this number and `--memory` must be the SAME number by construction. The
# precedent is DOC_CONVERT_CONTAINER_MI in setup-doc-ingest-backfill-job.sh —
# and its MONEY-1314 lesson is the `exit 1` here: an unparseable size must FAIL,
# never fall back. `--repair-memory=2G` (the correct spelling minus one
# character) would otherwise deploy a job that budgets for the wrong container
# and gets OOM-killed with no summary line, which on Cloud Run reads as a task
# that vanished rather than a budget that was blown.
#
# The job REFUSES the same string for the same reason (parseContainerMi), so
# neither side of the pair can silently guess.
mi_of() {
    local size="$1"
    if [[ "$size" =~ ^([0-9]+)Gi$ ]]; then
        echo $(( ${BASH_REMATCH[1]} * 1024 ))
    elif [[ "$size" =~ ^([0-9]+)Mi$ ]]; then
        echo "${BASH_REMATCH[1]}"
    else
        echo -e "${RED}--repair-memory=${size} is not a Cloud Run size (e.g. 1Gi, 2Gi, 3072Mi).${NC}" >&2
        echo "Refusing to guess: feed-repair sizes its download pool from this" >&2
        echo "number, and a wrong one is an OOM kill with no DONE line." >&2
        exit 1
    fi
}
# `if !` rather than a bare assignment: `mi_of`'s `exit 1` fires inside a
# COMMAND SUBSTITUTION, which exits the subshell. It happens to abort the script
# too, but only via `set -e` — one `|| true` away from silently continuing with
# an empty MiB value. The failure is checked here explicitly instead.
if ! REPAIR_CONTAINER_MI="$(mi_of "$REPAIR_MEMORY")"; then
    exit 1
fi

# ── 1. Resolve the image from the live service ────────────────────────────
echo -e "${BLUE}━━━ 1/5: Resolve image ━━━${NC}"
if [ -z "$IMAGE" ]; then
    IMAGE="$("${GC[@]}" run services describe "$SERVICE_NAME" \
        --region="$REGION" \
        --format='value(spec.template.spec.containers[0].image)' 2>/dev/null || true)"
fi
if [ -z "$IMAGE" ]; then
    echo -e "${RED}Could not resolve the ${SERVICE_NAME} image.${NC}"
    echo "Is the workers service deployed to prod? Otherwise pass --image=..."
    exit 1
fi
echo -e "   ${GREEN}${IMAGE}${NC}"
echo -e "   ${YELLOW}PREFLIGHT: this image must contain dist/feed-backfill.js,"
echo -e "   dist/feed-parse.js, dist/fo-summary.js and dist/feed-repair.js"
echo -e "   (workers/tsup.config.ts entry points — MONEY-941 / MONEY-1100 /"
echo -e "   MONEY-1169). Step 4b's delegate states its own entry-point preflight.${NC}"

# ── 2. The backfill job ───────────────────────────────────────────────────
# task-timeout 24h = the Cloud Run Jobs maximum. The full nse-cm-legacy walk is
# ~7,700 trading days at 1 rps, so a single family alone is over two hours; the
# job is designed to be run per-shard rather than all-families-at-once.
#
# max-retries=0 is NOT laziness. The walk is checkpointed and therefore safely
# resumable, which makes a retry look free — but the job also aborts on its
# stop-loss (too many consecutive throttles from one host). An automatic retry
# would resume hammering the exact host the stop-loss just backed off, turning a
# protective abort into a tight retry loop. Re-running is a human decision.
deploy_job() {
    local name="$1" entrypoint="$2" memory="$3" timeout="$4" extra_env="${5:-}"
    # `--set-env-vars` REPLACES the list, so every var a job needs has to be in
    # ONE string. The per-job additions are appended here rather than given a
    # second flag for exactly that reason.
    # MONEY-1278 — a Cloud Run JOB has no Datadog agent. DD_API_KEY is what makes
    # `datadog-metrics` emit at all (it no-ops without one, so `reportJobOutcome`
    # reached nobody from any of the 17 TypeScript jobs — including `feed-parse`,
    # which apply-monitors.sh monitors on both envs, so its monitor watched a series
    # that was never emitted). DD_TRACE_ENABLED=false overrides the `true` the image
    # bakes in, so dd-trace does not boot against a socket that is not there.
    local env_vars="FEED_ARCHIVE_MODE=archive,GCP_STORAGE_BUCKET=${BUCKET},GCP_PROJECT_ID=${PROJECT_ID},DD_ENV=${ENV},DD_TRACE_ENABLED=false"
    # An `if`, not `[ -n "$x" ] && …`: under `set -e` the AND-OR form's exit
    # status is the test's when the test fails, and reasoning about whether
    # errexit fires there is not something a provisioning script should ask a
    # reader to do.
    if [ -n "$extra_env" ]; then
        env_vars="${env_vars},${extra_env}"
    fi
    local args=(
        run jobs deploy "$name"
        --image="$IMAGE"
        --region="$REGION"
        --service-account="$JOB_SA"
        # The script path belongs in --command, NOT --args. `gcloud run jobs
        # execute --args=...` REPLACES the container's args rather than
        # appending to them, so with `--command=node --args=dist/foo.js` every
        # parameterised execution becomes `node --dry-run` and dies with
        # "bad option". Keeping the entrypoint in --command means execution-time
        # args land AFTER it, which is the whole point of a parameterised job.
        # `--args=""` clears the list (there is no --clear-args on jobs deploy).
        # Without it, a re-deploy would KEEP the old args and the container would
        # run `node dist/feed-backfill.js dist/feed-backfill.js`.
        --command="node,$entrypoint"
        --args=""
        --max-retries=0
        --task-timeout="$timeout"
        --memory="$memory"
        --cpu=1
        # FEED_ARCHIVE_MODE is the difference between a multi-hour walk that
        # stores decades of history and one that fetches every byte and throws
        # it away: unset, getFeedAsset() passes through without writing to GCS.
        # Set explicitly here rather than inherited, because the job spec does
        # NOT pick up the service's env block.
        # NOTE archive, never replay, even on QA: replay reads from the bucket,
        # so a QA backfill in replay mode would find nothing and record the
        # entire history as MISSING.
        --set-env-vars="$env_vars"
        --set-secrets="DATABASE_URL=${DB_SECRET}:latest,GCP_SERVICE_ACCOUNT_KEY_BASE64=GCP_SERVICE_ACCOUNT_KEY_BASE64:latest,DD_API_KEY=${DD_SECRET}:latest"
    )
    if [ "$DRY_RUN" = true ]; then
        echo "   [dry-run] gcloud ${args[*]}"
        return
    fi
    "${GC[@]}" "${args[@]}"
    "${GC[@]}" run jobs add-iam-policy-binding "$name" --region="$REGION" \
        --member="serviceAccount:${JOB_SA}" --role="roles/run.invoker" \
        --quiet >/dev/null
}

echo -e "${BLUE}━━━ 2/5: Cloud Run Job — ${BACKFILL_JOB} ━━━${NC}"
deploy_job "$BACKFILL_JOB" "dist/feed-backfill.js" "1Gi" "86400"
echo -e "   ${GREEN}${BACKFILL_JOB} deployed (no schedule — manual execution only)${NC}"

# ── 3. The parse job ──────────────────────────────────────────────────────
# 2Gi: the parse pass holds a whole decompressed bhavcopy plus its parsed rows
# in memory per file, and the F&O files are the big ones (~200k rows/day).
echo -e "${BLUE}━━━ 3/5: Cloud Run Job — ${PARSE_JOB} ━━━${NC}"
deploy_job "$PARSE_JOB" "dist/feed-parse.js" "2Gi" "86400"
echo -e "   ${GREEN}${PARSE_JOB} deployed${NC}"

# ── 4. The F&O summary job (MONEY-1100 P4.7) ──────────────────────────────
# 2Gi: two full days of DerivativeEOD rows in memory (today + prev, ~300k
# slim rows each on expiry weeks). 24h timeout for the same reason as the
# parse job: the nightly increment is minutes, but --backfill walks every
# trading day since 2000 in one execution.
echo -e "${BLUE}━━━ 4/5: Cloud Run Job — ${SUMMARY_JOB} ━━━${NC}"
deploy_job "$SUMMARY_JOB" "dist/fo-summary.js" "2Gi" "86400"
echo -e "   ${GREEN}${SUMMARY_JOB} deployed${NC}"

# ── 4a. The envelope repair job (MONEY-1169 / MONEY-1317) ─────────────────
# ADDED BY MONEY-1317, and the reason is that THREE SOURCES DISAGREED about who
# owns this job and all three were readable at once:
#
#   workers/cloudbuild.{prod,qa}.yaml   "feed-repair  provisioned BY HAND —
#                                        no setup script exists"
#   packages/core/src/ops/build-provenance.ts:336
#                                       "feed-repair": "setup-feed-backfill-job.sh"
#   this script                         deployed three jobs, none of them this one
#
# So a stale `feed-repair-prod` printed a [build-provenance] alert naming a
# script that exists, that the operator can run, and that would not have created
# the job — the WORST of the three failure shapes, because the remediation looks
# like it worked. `job-build-provenance.test.ts` asserted only that every mapped
# script EXISTS on disk; existence is not deployment, which is exactly how this
# survived the guard written to prevent it.
#
# It belongs HERE rather than in a script of its own: it repairs `feeds/` (and
# `stocks/`), it takes the same bucket + credentials + archive env as the three
# jobs above, and single-ownership is only endangered when two scripts would
# need DIFFERENT env for one job — which is the xbrl case at 4b, not this one.
#
# MEMORY, AND WHY THE JOB IS NOW TOLD ABOUT IT (MONEY-1322)
#
# This comment used to read: "2Gi: the walk holds up to `--concurrency`
# (default 12) objects in memory at once, each capped at `--max-bytes` (default
# 100 MB), and stripping the envelope allocates a SECOND buffer per slot. Lower
# --concurrency rather than raising memory when a run is scoped to the large
# `stocks/` PDFs."
#
# Every clause of that is a description of a job SIZED AGAINST ITS OWN WORST
# CASE — 12 x 100 MB x 2 is ~2.4 GB against a 2Gi task — and the mitigation was
# the last sentence, encoded NOWHERE. The command this script printed for an
# operator to paste was a bare `--args="--apply"`: both prefixes, default
# concurrency, default ceiling. The widest, heaviest run available, with the
# remedy left to memory.
#
# (One detail in it was also simply wrong. `stripMultipartEnvelope` returns the
# payload as a `subarray` — a VIEW, not a second allocation. It costs the same
# in the end, because a view keeps the WHOLE downloaded object reachable, but
# the number of live buffers per slot is a thing the code should compute, not a
# thing a comment should assert.)
#
# So the job now DERIVES its pool at startup from FEED_REPAIR_CONTAINER_MI and
# `--max-bytes`, LOGS the derivation, and treats `--concurrency` as a cap it may
# lower and never raise. FEED_REPAIR_CONTAINER_MI is set from $REPAIR_MEMORY by
# the same `mi_of` that would refuse an unparseable size, so the two cannot
# drift. At the defaults (2Gi, 100 MB ceiling, 3 live buffers per slot, 256 MiB
# runtime reserve) that resolves to 5, not 12.
#
# NO SCHEDULER TRIGGER, on either env, and that is not an oversight: this is a
# one-shot repair that is dry-run by default and needs `--apply` to write
# anything. A nightly re-walk of the whole bucket would spend hours re-reading
# 23k+ objects to skip every one of them. Step 5 below is gated on
# `ENV = prod` AND names its two jobs explicitly, so nothing here reaches it.
echo -e "${BLUE}━━━ 4a/5: Cloud Run Job — ${REPAIR_JOB} ━━━${NC}"
deploy_job "$REPAIR_JOB" "dist/feed-repair.js" "$REPAIR_MEMORY" "86400" \
    "FEED_REPAIR_CONTAINER_MI=${REPAIR_CONTAINER_MI}"
echo -e "   ${GREEN}${REPAIR_JOB} deployed (no schedule — dry-run by default; --apply to write)${NC}"
echo -e "   memory ${REPAIR_MEMORY} -> FEED_REPAIR_CONTAINER_MI=${REPAIR_CONTAINER_MI};"
echo -e "   the job derives --concurrency from it and prints the arithmetic (MONEY-1322)."

# ── 4b. The XBRL history walk (MONEY-1114 / MONEY-1220) ───────────────────
# DELEGATED, not deployed here. See the header for why one job may have exactly
# one owner; the short version is that --set-env-vars REPLACES the env list and
# this job's FEED_ARCHIVE_MODE differs from the four above on QA.
#
# $IMAGE is passed through so that a single provisioning run pins every job in
# this environment to the SAME image, rather than each script re-resolving the
# service independently and straddling a deploy that landed in between.
echo -e "${BLUE}━━━ 4b/5: Cloud Run Job — xbrl-backfill-${ENV} (delegated) ━━━${NC}"
if [ ! -x "$XBRL_SETUP" ]; then
    echo -e "${RED}Missing or non-executable: ${XBRL_SETUP}${NC}"
    echo "It owns xbrl-backfill-${ENV}; without it that job is not provisioned."
    exit 1
fi
xbrl_args=("$ENV" "--image=$IMAGE")
[ "$DRY_RUN" = true ] && xbrl_args+=("--dry-run")
"$XBRL_SETUP" "${xbrl_args[@]}"

# ── 5. Nightly triggers — PROD ONLY (see header) ──────────────────────────
# Bare POST to the Jobs :run URI executes with the DEPLOYED args (empty):
# feed-parse with no --families parses every known family incrementally, and
# fo-summary defaults to the latest DerivativeEOD day. Timing rides the
# archive chain: report-archive-sync retries at 21:45 IST, parse at 22:35,
# summary at 23:30 after the parse has landed the day's F&O rows.
echo -e "${BLUE}━━━ 5/5: Cloud Scheduler nightly triggers ━━━${NC}"
schedule_job_run() {
    local sched_name="$1" job_name="$2" cron="$3" desc="$4"
    local uri="https://${REGION}-run.googleapis.com/apis/run.googleapis.com/v1/namespaces/${PROJECT_ID}/jobs/${job_name}:run"
    local sched_args=(
        --location="$REGION"
        --schedule="$cron"
        --time-zone="Asia/Kolkata"
        --uri="$uri"
        --http-method=POST
        --oauth-service-account-email="$JOB_SA"
        --description="$desc"
        --project="$PROJECT_ID"
    )
    if [ "$DRY_RUN" = true ]; then
        echo "   [dry-run] scheduler jobs create/update http $sched_name (${cron} IST) -> ${job_name}:run"
        return
    fi
    if "${GC[@]}" scheduler jobs describe "$sched_name" --location="$REGION" &>/dev/null; then
        "${GC[@]}" scheduler jobs update http "$sched_name" "${sched_args[@]}" --quiet
    else
        "${GC[@]}" scheduler jobs create http "$sched_name" "${sched_args[@]}" --quiet
    fi
    echo -e "   ${GREEN}Scheduled ${sched_name} (${cron} IST) -> ${job_name}${NC}"
}

if [ "$ENV" = "prod" ]; then
    schedule_job_run "feed-parse-nightly" "$PARSE_JOB" "35 22 * * 1-5" \
        "MONEY-1100 P4.7 - nightly incremental GCS->Mongo parse of everything report-archive-sync archived today (checkpointed; no exchange traffic)."
    schedule_job_run "fo-summary-nightly" "$SUMMARY_JOB" "30 23 * * 1-5" \
        "MONEY-1100 P4.7 - nightly DerivativeEOD -> DerivativeSummary derivation for the latest trading day (runs after feed-parse-nightly)."
else
    echo -e "   ${YELLOW}Skipped on ${ENV}: no feeds/ mirror and no DerivativeEOD rows yet — see header.${NC}"
fi

# ── EXECUTION ─────────────────────────────────────────────────────────────
# Unquoted heredoc so the printed commands name the env that was actually
# provisioned. A quoted one printed "-prod" verbatim even on a QA run, which is
# the single worst thing an ops script can hand you: a copy-pasteable command
# pointing at the environment you did not choose.
cat <<EOF

────────────────────────────────────────────────────────────────
Provisioned (${ENV}). The walk and the repair have no trigger; on prod,
feed-parse-nightly (22:35 IST) and fo-summary-nightly (23:30 IST) now run
the incremental chain.

${REPAIR_JOB} is DRY-RUN BY DEFAULT and --audit is read-only, so the
audit cannot write. Run the audit before the repair:

  gcloud run jobs execute ${REPAIR_JOB} --region=${REGION} --args="--audit"

SCOPE THE REPAIR. There is deliberately no bare --args="--apply" printed
here any more (MONEY-1322): it means BOTH prefixes at once — 425k objects,
the widest scope the job has — and it used to be the only example given,
next to a comment telling the operator to narrow it by hand.

  gcloud run jobs execute ${REPAIR_JOB} --region=${REGION} \\
      --args="--apply,--prefixes=feeds/"

  gcloud run jobs execute ${REPAIR_JOB} --region=${REGION} \\
      --args="--apply,--prefixes=stocks/"

The five oversized \`stocks/\` PDFs (103-212 MB) sit ABOVE the default
100 MB --max-bytes, so the run above skips them before the download and
the audit counts them \`envelope-too-large\`, not \`envelope-data\`
(MONEY-1323). Reach them with their own execution:

  gcloud run jobs execute ${REPAIR_JOB} --region=${REGION} \\
      --args="--apply,--prefixes=stocks/,--max-bytes=250000000"

You do NOT need to pass --concurrency with it. The job sizes its own
pool from FEED_REPAIR_CONTAINER_MI (${REPAIR_CONTAINER_MI}) and the
ceiling, and prints the derivation on its first lines; --concurrency is
only ever a cap it may lower.

Smoke-test first — costs nothing, makes zero exchange requests, and
proves the entrypoint + secrets + Mongo all work in the container:

  gcloud run jobs execute ${BACKFILL_JOB} --region=${REGION} --args="--dry-run"

NOTE gcloud splits --args on COMMAS, so each comma below starts a NEW
argument (that is why the examples read as one flag per comma). To pass
a value that itself contains a comma, e.g. two families at once, use
gcloud's alternate-delimiter form:

  --args=^:^--families=nse-cm-legacy,nse-fo-legacy:--rps=1

F&O HISTORY IS CLOSED (founder decision, 2026-08-11). Do NOT walk more
derivatives history:
  - INDEX F&O (NIFTY/BANKNIFTY/FINNIFTY...) — keep the FULL history already
    archived. Continuity is good back to 2000 and the derived signals (PCR,
    max pain, rollover percentiles) need a long distribution to mean anything.
  - STOCK F&O — 2018 onward only. Earlier data is not comparable: options were
    AMERICAN-style until Jan 2011, physical settlement phased in 2018-19, and
    lot sizes have been revised repeatedly so open interest in CONTRACTS does
    not compare across eras.
  - The pre-2018 STOCK rows were DELETED from the database on 2026-08-11
    (scripts/migrations/trim-stock-fo-pre-2018.ts, 69.0M rows + 509K derived
    summaries). The GCS bytes were NOT touched, so the delete is reversible by
    re-parsing; the cutoff is also enforced in feed-parse's writeFo and in
    fo-summary, so a re-parse cannot silently undo the policy.
  - Everything in GCS STAYS (it cost nothing to keep and NSE prunes, so
    re-fetching later is impossible).
  - New data arrives via the LIVE nightly chain — report-archive-sync ->
    feed-parse-nightly -> fo-summary-nightly — not from this job.

SHARD THE WALK. Do not execute with no --families: that plans every
family at once, serialises them, and blows past the 24h task timeout.
One family (or a few small ones) per execution:

  gcloud run jobs execute ${BACKFILL_JOB} --region=${REGION} \\
      --args="--families=nse-cm-legacy,--from=2024-07-05,--to=2020-01-01"

  gcloud run jobs execute ${BACKFILL_JOB} --region=${REGION} \\
      --args="--families=nse-fo-legacy,--from=2024-07-05,--to=2020-01-01"

Watch it, and stop it if the MISSING streak climbs — a run that is
being throttled looks exactly like a run that has reached the end of
the archive, and only the logs tell them apart:

  gcloud logging read \\
    'resource.type=cloud_run_job AND resource.labels.job_name=${BACKFILL_JOB}' \\
    --limit=50 --freshness=10m --project=${PROJECT_ID}

Then parse what landed (GCS -> Mongo only, no exchange traffic, so
this one is safe to run wide):

  gcloud run jobs execute ${PARSE_JOB} --region=${REGION} \\
      --args="--families=nse-cm-legacy"

────────────────────────────────────────────────────────────────
XBRL HISTORY (MONEY-1114 / MONEY-1220) — xbrl-backfill-${ENV}

Provisioned above by scripts/ops/setup-xbrl-backfill-job.sh, which
printed its own execution guide (FY-aligned shard list, the two repair
passes, and the build-provenance check) when step 4b ran. The commands
are NOT duplicated here: an out-of-date second copy of a shard list is
how somebody walks the wrong window.

  ./scripts/ops/setup-xbrl-backfill-job.sh ${ENV} --dry-run   # reprint it
────────────────────────────────────────────────────────────────
EOF
