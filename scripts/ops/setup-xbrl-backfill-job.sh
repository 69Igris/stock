#!/bin/bash
# ============================================
# UseMoney - XBRL history backfill (Cloud Run Job) — MONEY-1220 step E
# ============================================
# Deploys ONE Cloud Run JOB off the EXISTING stockbook-workers image:
#
#   xbrl-backfill-{env}   scripts/jobs/xbrl-backfill.ts -> dist/xbrl-backfill.js
#       Walks NSE's results index month by month and lands every filing's XBRL
#       into `xbrl_filings`, including the ANNUAL row each March-quarter
#       document carries beside its quarter.
#
# ## Why this job has to exist at all
#
# `xbrl_filings` held 2,152 rows on 2026-08-19 and every one of them was
# QUARTERLY, collected since ~14-Aug by the nightly `xbrl-sync` worker. The
# worker only ever sees the trailing window, so ANNUAL history comes from this
# backfill and from nothing else. Without ANNUAL rows the F3 reconcile
# (`scripts/data/xbrl-reconcile.ts`) has ZERO comparable pairs and the 3Y/5Y
# CAGR columns stay null forever — not wrong, just permanently empty.
#
# ## Why it is NON-DESTRUCTIVE, which is why it can be provisioned now
#
# `scripts/jobs/xbrl-backfill.ts` performs zero direct database writes and
# contains zero `stockFinancials` references. It populates `xbrl_filings` only,
# via `processXbrlSync`. The one-way door — `StockFinancials` has no `source` in
# its unique key, so the first XBRL write there destroys the incumbent
# Tickertape value with nothing left to reconcile against — is NOT opened by
# this job. That door is opened later, by the switchover, and only after
# `xbrl-reconcile.ts` has passed (docs/reference/xbrl-switchover-runbook.md).
#
# ## Why a JOB and not the Pub/Sub push worker
#
# The push worker is bound by Pub/Sub's un-raisable 600 s ack deadline. Seven
# years at ~2,500 filings a month is on the order of 200,000 downloads at 600 ms
# apiece — over a day of continuous running. Two agents lost a run to laptop
# sleep on 2026-08-19; a laptop is not an acceptable host either.
#
# Same image as the workers service — workers/tsup.config.ts emits
# dist/xbrl-backfill.js — so there is no separate build and no second artifact
# to keep in step.
#
# ## Why this is its OWN script and not another step in setup-feed-backfill-job.sh
#
# Two reasons, and the first is a correctness bug rather than tidiness.
#
#   1. `gcloud run jobs deploy --set-env-vars` REPLACES the job's env list; it
#      does not merge into it. Two scripts that both deploy `xbrl-backfill-{env}`
#      therefore means "whichever ran last wins", silently — and they MUST
#      differ, because this job wants FEED_ARCHIVE_MODE=replay on QA while the
#      feed jobs want archive on both. That is the "two setup scripts fought
#      over one schedule" failure with the loser being a whole env's archive
#      mode. `setup-feed-backfill-job.sh` now DELEGATES here instead of
#      deploying the job inline, so there is exactly one definition.
#
#   2. Blast radius. Provisioning this job through the feed script also
#      re-points feed-backfill / feed-parse / fo-summary at whatever image is
#      live today and rewrites two Cloud Scheduler triggers. "Create the XBRL
#      job" should not silently re-deploy the nightly chain.
#
# ## IMAGE: pinned from the LIVE service, and printed
#
# >>> Cloud Run JOBS pin their image at provision time. A deploy of the SERVICE
# >>> does not move them. Nothing re-points a job until somebody re-runs this
# >>> script, and nobody re-runs a setup script on a Tuesday.
#
# That is not a hypothetical: on 2026-08-18 `feed-parse-prod` was still on
# `prod-fbdc29e2` (built 14-Aug) while the service had moved to `prod-d7eefba7`
# (18-Aug). It ran nightly, exited 0, reported SUCCEEDED_COUNT 1, and skipped
# four bond feed families it had never heard of — `bond_master` and `bond_eod`
# sat at 0 rows (MONEY-1210/MONEY-1205, and MONEY-1189 was the same class one
# ticket earlier).
#
# So this script resolves the image off the live service and PRINTS the tag, the
# commit SHA inside that tag, and (best effort) the digest. Write that SHA down:
# it is what the job's own first log line must echo back.
#
#   >>> PREFLIGHT <<<  The resolved image MUST be built from a commit that has
#   the `xbrl-backfill` entry in workers/tsup.config.ts. On an older image the
#   container starts and dies instantly with
#   "Cannot find module /app/dist/xbrl-backfill.js". Merge + let the release
#   trigger rebuild BEFORE provisioning.
#
# ## DD_VERSION is deliberately NOT set here — do not "fix" that
#
# The job identifies itself already. `workers/Dockerfile` declares
# `ARG DD_VERSION=unknown` / `ENV DD_VERSION=${DD_VERSION}` and
# `workers/cloudbuild.{prod,qa}.yaml` build with
# `--build-arg DD_VERSION=$COMMIT_SHA` — the SAME substitution that forms the
# image tag. So `process.env.DD_VERSION` in the container is a property of the
# IMAGE LAYER, and `reportBuildProvenance()` reads it with no help from the job
# spec. Verified live on 2026-08-19:
#
#   feed-parse-prod  [build-provenance] WARN feed-parse is running build
#                    ed432f72500232988e6ec9300fcdad51dd1aa7eb
#
# Passing `--set-env-vars DD_VERSION=...` here would turn that SHA into a
# property of the JOB SPEC, which is exactly the forge the guard depends on
# being impossible: a job pinned to a stale image could then report a fresh SHA
# because someone re-ran setup. An ERROR from a LOCAL `npx tsx` run is not this
# bug — a laptop has no baked DD_VERSION and correctly says so.
#
# `EXPECTED_BUILD_SHA` is left unset for the reason written up in
# packages/core/src/ops/build-provenance.ts: it would be read from the same
# image being pinned, so it would match by construction, forever, and detect
# nothing. A green that cannot go red is worse than the WARN it replaces.
#
# Prerequisites:
#   - gcloud authenticated; Cloud Run API on
#   - stockbook-workers-{env} service already deployed (that is the image source)
#
# Usage (env is positional and REQUIRED, as in setup-infra.sh):
#   ./scripts/ops/setup-xbrl-backfill-job.sh prod
#   ./scripts/ops/setup-xbrl-backfill-job.sh qa
#   ./scripts/ops/setup-xbrl-backfill-job.sh prod --dry-run           # print, change nothing
#   ./scripts/ops/setup-xbrl-backfill-job.sh prod --image=IMG         # pin an explicit image
#   ./scripts/ops/setup-xbrl-backfill-job.sh prod --task-timeout=3600 # shorter tasks
# ============================================

set -euo pipefail

RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; BLUE='\033[0;34m'; NC='\033[0m'

PROJECT_ID="stock-book-483718"
REGION="asia-south1"
# Same SA the workers service runs as: already has Mongo egress + GCS write on
# the bucket, so the job needs no new IAM surface of its own.
JOB_SA="stockbook-api@${PROJECT_ID}.iam.gserviceaccount.com"

# Env is POSITIONAL and REQUIRED, matching setup-infra.sh / setup-scheduler.sh /
# setup-feed-backfill-job.sh. There is deliberately no default: this job writes
# to a real database and a real bucket, and every sibling ops script makes you
# name the environment out loud.
ENV=${1:-""}
shift || true

IMAGE=""
DRY_RUN=false
# 24h is the Cloud Run Jobs maximum and the right default here. One FY shard is
# 12 monthly windows, and xbrl-backfill.ts budgets up to 4h of downloads PER
# WINDOW (--window-budget-sec); the measured shape is ~5h for a full year. A
# 1h task-timeout would kill every FY shard about a fifth of the way in and
# surface it as a FAILED task, turning one execution per FY into five red ones.
# Resume is free (the stored rows ARE the checkpoint), so nothing is lost — but
# a red task that is actually normal progress is how people stop reading task
# status. Override with --task-timeout= if you want short leashed runs.
TASK_TIMEOUT="86400"
while [ $# -gt 0 ]; do
    case "$1" in
        --image=*)        IMAGE="${1#*=}"; shift ;;
        --task-timeout=*) TASK_TIMEOUT="${1#*=}"; shift ;;
        --dry-run)        DRY_RUN=true; shift ;;
        -h|--help)        grep '^#' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
        *) echo "Unknown argument: $1"; exit 1 ;;
    esac
done

# FEED_ARCHIVE_MODE per env — archive on prod, replay on QA.
#
# This is the scrape-once contract (MONEY-1085/1189), not a style choice: prod
# fetches each exchange file ONCE and archives it, QA replays those same bytes
# through its OWN ingest. `xbrl-sync`'s download goes through `getFeedAsset`
# since MONEY-1204, so every filing this job walks is an archiving fetch on prod
# and lands under `feeds/NSE/results-xbrl/{YYYY}/{MM}/`.
#
# >>> ORDERING IS LOAD-BEARING ON QA <<<  A QA walk in replay is only meaningful
# AFTER prod has walked the same window AND `sync-prod-to-qa-feeds` has mirrored
# the objects into QA's bucket. Run it before that and every key misses; replay
# falls back to the exchange by design, so QA scrapes NSE for the whole shard
# and persists NOTHING, while the counters report a completed walk. That is a
# soft failure with no error — the same shape MONEY-1194 measured when the
# mirror landed 3h45m after its consumer. Provision QA, but walk prod first.
#
# The apply half of `--archive-existing` refuses to run under replay outright
# (scripts/jobs/xbrl-backfill.ts) rather than reporting re-fetches it never
# made. `--dry-run` counting is allowed in any mode, because counting is a read.
case "$ENV" in
    prod)
        BUCKET="stockbook-content-prod"
        DB_SECRET="DATABASE_URL_PROD"
        DD_SECRET="DD_API_KEY_PROD"
        ARCHIVE_MODE="archive"
        ;;
    qa)
        BUCKET="stockbook-content-qa"
        DB_SECRET="DATABASE_URL_QA"
        DD_SECRET="DD_API_KEY_QA"
        ARCHIVE_MODE="replay"
        ;;
    *)
        echo "Usage: ./scripts/ops/setup-xbrl-backfill-job.sh [qa|prod] [options]"
        echo ""
        echo "Options:"
        echo "  --image=IMG            Pin an explicit image instead of resolving it"
        echo "                         from the live stockbook-workers-{env} service"
        echo "  --task-timeout=SECS    Cloud Run task timeout (default 86400 = 24h max)"
        echo "  --dry-run              Print the gcloud calls, change nothing"
        echo ""
        echo "Deploys the Cloud Run job xbrl-backfill-{env} (MONEY-1114/MONEY-1220)."
        echo "No Scheduler trigger, ever — see the header."
        exit 1
        ;;
esac

# Cloud Run names are per-env; the deployed services are stockbook-workers-prod
# / -qa, NOT a bare stockbook-workers.
SERVICE_NAME="stockbook-workers-${ENV}"
JOB_NAME="xbrl-backfill-${ENV}"
ENTRYPOINT="dist/xbrl-backfill.js"

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

# FAILS CLOSED. An empty IMAGE must never reach `gcloud run jobs deploy` — it
# would either error out mid-deploy or, worse, be read as "keep whatever is
# there", which on a re-provision silently preserves the stale pin this script
# exists to move.
if [ -z "$IMAGE" ]; then
    echo -e "${RED}Could not resolve the ${SERVICE_NAME} image.${NC}"
    echo "Is the workers service deployed to ${ENV}? Otherwise pass --image=..."
    exit 1
fi

# PRINT WHAT WAS PINNED. The tag carries the commit: workers/cloudbuild.*.yaml
# tags `stockbook-workers:{env}-$COMMIT_SHA` and bakes the SAME $COMMIT_SHA as
# DD_VERSION, so the SHA below is exactly what the job's first log line must
# report back. If they ever disagree, the job is not running the image you think
# it is.
IMAGE_TAG="${IMAGE##*:}"
IMAGE_SHA="${IMAGE_TAG#"${ENV}"-}"
echo -e "   image  : ${GREEN}${IMAGE}${NC}"
echo -e "   source : ${IMAGE_SOURCE}"
echo -e "   tag    : ${GREEN}${IMAGE_TAG}${NC}"
echo -e "   commit : ${GREEN}${IMAGE_SHA}${NC}"

# Digest is best-effort: it is the strongest identity a tag can be resolved to,
# but `container images describe` needs registry read permission that a
# Cloud-Run-only operator may not have, and failing the whole provision over a
# nice-to-have line would be absurd. `|| true` keeps it advisory.
IMAGE_DIGEST="$("${GC[@]}" container images describe "$IMAGE" \
    --format='value(image_summary.digest)' 2>/dev/null || true)"
if [ -n "$IMAGE_DIGEST" ]; then
    echo -e "   digest : ${GREEN}${IMAGE_DIGEST}${NC}"
else
    echo -e "   digest : ${YELLOW}(not resolved — tag above is the pin of record)${NC}"
fi

echo -e "   ${YELLOW}PREFLIGHT: this image must contain ${ENTRYPOINT}"
echo -e "   (the 'xbrl-backfill' entry in workers/tsup.config.ts). On an older"
echo -e "   image the container dies instantly with"
echo -e "   \"Cannot find module /app/${ENTRYPOINT}\".${NC}"

# ── 2. Deploy the job ─────────────────────────────────────────────────────
echo -e "${BLUE}━━━ 2/3: Cloud Run Job — ${JOB_NAME} ━━━${NC}"

# 1Gi: the walk holds one month's index entries (~3,000 slim records) and ONE
# XBRL document at a time — the shape of feed-backfill, not of the parse jobs
# that hold a whole decompressed bhavcopy.
deploy_args=(
    run jobs deploy "$JOB_NAME"
    --image="$IMAGE"
    --region="$REGION"
    --service-account="$JOB_SA"
    # The script path belongs in --command, NOT --args. `gcloud run jobs execute
    # --args=...` REPLACES the container's args rather than appending to them,
    # so with `--command=node --args=dist/xbrl-backfill.js` every parameterised
    # execution becomes `node --from=2018-04` and dies with "bad option".
    # Keeping the entrypoint in --command means execution-time args land AFTER
    # it, which is the whole point of a parameterised job.
    # `--args=""` clears the list (there is no --clear-args on jobs deploy).
    # Without it a re-deploy KEEPS the old args and the container runs
    # `node dist/xbrl-backfill.js dist/xbrl-backfill.js`.
    --command="node,$ENTRYPOINT"
    --args=""
    # NOT laziness, and NOT the same argument as feed-backfill's.
    #
    # A retry re-walks the SAME window from the top. That is cheap in rows (the
    # pre-download skip means a stored filing costs one indexed read) but it is
    # NOT cheap against NSE: a task killed by the 24h timeout, or by a stop-loss
    # after sustained throttling, would be restarted straight back into the host
    # that just cut us off — turning a protective abort into a tight retry loop
    # against nseindia.com, the one host this whole feature depends on.
    # Re-running is a human decision.
    --max-retries=0
    --task-timeout="$TASK_TIMEOUT"
    --memory=1Gi
    --cpu=1
    # Set EXPLICITLY, because a job spec does NOT inherit the service's env
    # block. Unset, `getFeedAsset()` passes through without touching GCS and the
    # whole multi-hour walk archives zero bytes while every counter reports
    # success. `requireArchiveWired()` in the job turns a missing store into a
    # crash on line one rather than that silent success — but only if
    # GCP_STORAGE_BUCKET is here to wire it.
    #
    # DD_VERSION is absent ON PURPOSE. It is baked into the image and must stay
    # a property of the image — see the header.
    # MONEY-1278 — a Cloud Run JOB has no Datadog agent. DD_API_KEY is what makes
    # `datadog-metrics` emit at all (it no-ops without one, so `reportJobOutcome`
    # reached nobody from any of the 17 TypeScript jobs — including `feed-parse`,
    # which apply-monitors.sh monitors on both envs, so its monitor watched a series
    # that was never emitted). DD_TRACE_ENABLED=false overrides the `true` the image
    # bakes in, so dd-trace does not boot against a socket that is not there.
    --set-env-vars="FEED_ARCHIVE_MODE=${ARCHIVE_MODE},GCP_STORAGE_BUCKET=${BUCKET},GCP_PROJECT_ID=${PROJECT_ID},DD_ENV=${ENV},DD_TRACE_ENABLED=false"
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
echo -e "   ${YELLOW}None, deliberately. The nightly xbrl-sync worker already"
echo -e "   captures NEW filings; this job fetches HISTORY, which is one-shot"
echo -e "   per shard. A nightly re-walk of eight years is the fastest way to"
echo -e "   get our egress IP throttled off nseindia.com.${NC}"

# ── EXECUTION ─────────────────────────────────────────────────────────────
# Unquoted heredoc so the printed commands name the env that was actually
# provisioned. A quoted one would print "-prod" verbatim even on a QA run, which
# is the single worst thing an ops script can hand you: a copy-pasteable command
# pointing at the environment you did not choose.
cat <<EOF

────────────────────────────────────────────────────────────────
Provisioned ${JOB_NAME} (${ENV}).

  image  ${IMAGE}
  commit ${IMAGE_SHA}
  mode   FEED_ARCHIVE_MODE=${ARCHIVE_MODE}
  retry  --max-retries=0   task-timeout ${TASK_TIMEOUT}s

VERIFY THE PIN, do not assume it. The job prints its own build as its
first line; that SHA must equal ${IMAGE_SHA} above. This is the ONE
check that can actually go red — Cloud Run JOBS pin their image at
provision time and a deploy of the SERVICE does not move them:

  gcloud run jobs execute ${JOB_NAME} --region=${REGION} --args="--dry-run"
  gcloud logging read \\
    'resource.type=cloud_run_job AND resource.labels.job_name=${JOB_NAME} AND textPayload:"build-provenance"' \\
    --limit=5 --freshness=1h --project=${PROJECT_ID}

--dry-run prints the month plan and exits WITHOUT touching NSE, so the
smoke test above costs nothing and still proves the entrypoint, the
secrets, Mongo and the archive wiring all work in the container. The
window arithmetic is where an off-by-one silently skips a month.

NOTE gcloud splits --args on COMMAS, so each comma below starts a NEW
argument (that is why the examples read as one flag per comma).

────────────────────────────────────────────────────────────────
SHARD THE WALK — FY-ALIGNED, OLDEST FIRST, ONE AT A TIME

FY-aligned (Apr→Mar) rather than calendar-aligned because that is the
period Indian filings are cut on: a March-quarter document carries the
FULL FINANCIAL YEAR as a second context, and that annual row is the
entire reason this backfill exists. A calendar shard splits the year
whose annual figure it is trying to land.

OLDEST FIRST, and this ordering is load-bearing: the projection's QoQ
and TTM derivations need the prior periods to already be present. Run
newest-first and the early shards derive against history that has not
arrived yet.

ONE AT A TIME — not in parallel. They hit the same host and the pacing
is per-process, so two concurrent shards double the request rate into
exactly the throttle the stop-loss exists to avoid.

  gcloud run jobs execute ${JOB_NAME} --region=${REGION} --args="--from=2018-04,--to=2019-03"   # FY2018-19
  gcloud run jobs execute ${JOB_NAME} --region=${REGION} --args="--from=2019-04,--to=2020-03"   # FY2019-20
  gcloud run jobs execute ${JOB_NAME} --region=${REGION} --args="--from=2020-04,--to=2021-03"   # FY2020-21
  gcloud run jobs execute ${JOB_NAME} --region=${REGION} --args="--from=2021-04,--to=2022-03"   # FY2021-22
  gcloud run jobs execute ${JOB_NAME} --region=${REGION} --args="--from=2022-04,--to=2023-03"   # FY2022-23
  gcloud run jobs execute ${JOB_NAME} --region=${REGION} --args="--from=2023-04,--to=2024-03"   # FY2023-24
  gcloud run jobs execute ${JOB_NAME} --region=${REGION} --args="--from=2024-04,--to=2025-03"   # FY2024-25
  gcloud run jobs execute ${JOB_NAME} --region=${REGION} --args="--from=2025-04,--to=2026-03"   # FY2025-26
  gcloud run jobs execute ${JOB_NAME} --region=${REGION} --args="--from=2026-04,--to=2026-08"   # FY2026-27 (partial)

2018-04 is the FLOOR and it is MEASURED, not cautious. A filing with no
XBRL still carries a well-formed URL ending in a bare dash, so a
startsWith('http') check reports ~100% coverage back to 2012. On the
.xml suffix it is 0% through Feb-2018, 89% May-2018, 97-98% from 2019.
Walking earlier costs requests and returns nothing but stubs.

Extend the last shard's --to as months pass. FY2025-26 and FY2026-27 are
the INTEGRATED-filing era, which the nightly xbrl-sync worker covers
going forward — but only from ~14-Aug-2026, when it started. Everything
before that is a hole only this walk can fill.

Every shard is resumable for FREE — a filing already in xbrl_filings is
skipped BEFORE its download — so a killed execution costs nothing but
the time already spent. There is deliberately no checkpoint table: the
rows ARE the checkpoint, at exactly the granularity that matters.

A non-zero exit means the run was INCOMPLETE — a window whose index was
unreadable, or one that hit a cap. Read the log, do not re-run blind:

  gcloud logging read \\
    'resource.type=cloud_run_job AND resource.labels.job_name=${JOB_NAME}' \\
    --limit=100 --freshness=1h --project=${PROJECT_ID}

────────────────────────────────────────────────────────────────
THE TWO REPAIR PASSES (separate from the walk, and from each other)

Rows stored before their respective fixes shipped are unreachable by a
re-run, because processXbrlSync skips a stored filing BEFORE the
download. That skip is what makes the trailing window cheap and must not
be weakened, so each repair is its own pass. Count first, then apply:

  gcloud run jobs execute ${JOB_NAME} --region=${REGION} --args="--annual-existing,--dry-run"
  gcloud run jobs execute ${JOB_NAME} --region=${REGION} --args="--annual-existing"

  gcloud run jobs execute ${JOB_NAME} --region=${REGION} --args="--archive-existing,--dry-run"
  gcloud run jobs execute ${JOB_NAME} --region=${REGION} --args="--archive-existing"

--archive-existing APPLY requires FEED_ARCHIVE_MODE=archive and so runs
on prod only; on QA it refuses rather than counting re-fetches it never
made. --dry-run counting works in either env.

Measured 2026-08-19: of 2,152 stored rows, 2,127 have periodEnd
2026-06-30 — a Q1 filing, whose year-to-date column IS its quarter, so
it carries no annual context at all. --annual-existing is therefore
small and cheap TODAY. It exists so nothing is stranded; the ANNUAL
history itself comes from the FY shards above.
────────────────────────────────────────────────────────────────
EOF
