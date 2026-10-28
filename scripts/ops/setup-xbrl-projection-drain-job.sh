#!/bin/bash
# ============================================
# UseMoney - XBRL -> stock_financials backlog drain (Cloud Run Job) — MONEY-1235
# ============================================
# Deploys ONE Cloud Run JOB off the EXISTING stockbook-workers image:
#
#   xbrl-projection-drain-{env}
#       scripts/jobs/xbrl-projection-drain.ts -> dist/xbrl-projection-drain.js
#       Pages `processXbrlProjectionWrite` until the unprojected backlog in
#       `xbrl_filings` is gone, writing `StockFinancials`.
#
# ## Why this job has to exist at all
#
# Measured on prod, 2026-08-19:
#
#   xbrl_filings       90,188 unprojected  (71,450 QUARTERLY, 18,381 ANNUAL,
#                                            357 HALF_YEARLY)
#   stock_financials        0 QUARTERLY rows
#
# Zero quarterly rows means EVERY quarterly write is a CREATE, and until
# MONEY-1235 creates were unconditionally suppressed with the opt-in
# unreachable: the Quarterly tab could not fill however long the job ran. That
# half is fixed in the writer. The other half is throughput.
#
# The nightly `xbrl-projection` push worker cannot drain this:
#
#   * its default limit is 500 (`DEFAULT_PROJECTION_LIMIT`), sized for Pub/Sub's
#     un-raisable 600 s ack deadline — a handler that runs past it gets its
#     message REDELIVERED and a second copy starts concurrently; and
#   * its scheduler payload is deliberately scoped {"periodTypes":["ANNUAL"]},
#     so unstamped quarterly filings cannot starve annual work.
#
# 71,450 quarterly filings at 500/night is ~143 nights. And no Cloud Run job ran
# the projection at all before this one: `xbrl-backfill.ts` calls only
# `processXbrlSync` and has zero `stockFinancials` references. It walks NSE and
# fills `xbrl_filings`; nothing walked `xbrl_filings` and filled
# `stock_financials`.
#
# ## Why a JOB and not the push worker — and why 600 s is NOT a constraint here
#
# Every batch size in this repo is set by that 600 s ack deadline (the "Job
# throughput" table in CLAUDE.md). A Cloud Run JOB has no subscription, no
# message and no ack: `--task-timeout` below is 86400, matching the sibling
# `xbrl-backfill-{env}`. Do not re-impose a 600 s budget out of habit; the
# binding constraints here are memory (the writer holds a whole page of `facts`
# JSON in RAM) and the run's own wall-clock budget, and both are explicit.
#
# ## THIS JOB OPENS THE ONE-WAY DOOR — which is why it ships DISARMED
#
# `StockFinancials` is @@unique([symbol, exchange, statementType, periodType,
# period]) with NO `source` in the key. Two sources describing one period are
# ONE ROW, so the moment this job writes a period the incumbent value for that
# period is gone and there is nothing left to reconcile against. That is the
# exact opposite of `xbrl-backfill-{env}`, which is non-destructive and could be
# provisioned freely.
#
# So the write needs BOTH halves, and neither is this script's to grant on its
# own behalf:
#
#   1. XBRL_PROJECTION_APPLY=true in the job's ENVIRONMENT (a re-run of this
#      script with --arm, i.e. a deliberate act), and
#   2. `--apply` on the execution's argument list.
#
# A flag can never arm a run the environment has not armed. Flipping the env is
# a deploy, which is a review; an argument is a keystroke.
#
# ## XBRL_PROJECTION_APPLY ships PRESENT and "false" — not absent
#
# Absent and "false" must NEVER be the same state. That is precisely how
# MF_METADATA_PROVIDER disabled its own job silently for months (MONEY-1214):
# nothing was set, nothing was wrong-looking, and the job ran cleanly writing
# nothing. A present "false" is a decision somebody can see in
# `gcloud run jobs describe`; an absent var is an accident that reads the same.
#
# The code compares against the LITERAL string "true", never Boolean():
# `Boolean("false")` is `true`, which would arm the job in the one configuration
# meant to keep it off.
#
# >>> PRECONDITION for --arm on prod <<<  The F3 reconcile
# >>> (`scripts/data/xbrl-reconcile.ts`) reading READY. Once XBRL writes a
# >>> period the value it replaced is destroyed, so the gate cannot be run
# >>> afterwards. See docs/reference/xbrl-switchover-runbook.md.
#
# ## IMAGE: pinned from the LIVE service, and printed
#
# >>> Cloud Run JOBS pin their image at provision time. A deploy of the SERVICE
# >>> does not move them. Nothing re-points a job until somebody re-runs this
# >>> script, and nobody re-runs a setup script on a Tuesday.
#
# Measured, twice: on 2026-08-18 `feed-parse-prod` was still on `prod-fbdc29e2`
# (built 14-Aug) while the service had moved to `prod-d7eefba7` (18-Aug). It ran
# nightly, exited 0, reported SUCCEEDED_COUNT 1, and skipped four bond feed
# families it had never heard of — `bond_master` and `bond_eod` sat at 0 rows
# (MONEY-1205; MONEY-1189 was the same class one ticket earlier).
#
# So this script resolves the image off the live service, FAILS CLOSED on an
# empty resolution, and PRINTS the tag and commit SHA. Write that SHA down: it
# is what the job's own first log line must echo back.
#
#   >>> PREFLIGHT <<<  The resolved image MUST be built from a commit that has
#   the `xbrl-projection-drain` entry in workers/tsup.config.ts. On an older
#   image the container starts and dies instantly with
#   "Cannot find module /app/dist/xbrl-projection-drain.js". Merge + let the
#   release trigger rebuild BEFORE provisioning.
#
# ## DD_VERSION is deliberately NOT set here — do not "fix" that
#
# `workers/Dockerfile` declares ARG DD_VERSION=unknown / ENV DD_VERSION and
# `workers/cloudbuild.{prod,qa}.yaml` build with
# `--build-arg DD_VERSION=$COMMIT_SHA` — the SAME substitution that forms the
# image tag. So `process.env.DD_VERSION` in the container is a property of the
# IMAGE LAYER and `reportBuildProvenance()` reads it with no help from the job
# spec. Passing --set-env-vars DD_VERSION=... here would make it a property of
# the JOB SPEC, i.e. exactly the forge the guard depends on being impossible: a
# job pinned to a stale image could report a fresh SHA because someone re-ran
# setup.
#
# `EXPECTED_BUILD_SHA` is left unset for the reason in
# packages/core/src/ops/build-provenance.ts: it would be read from the same
# image being pinned, so it would match by construction, forever, and detect
# nothing. A green that cannot go red is worse than the WARN it replaces.
#
# ## No Cloud Scheduler trigger, ever
#
# This is a FOUNDER-INVOKED drain, not a nightly. The nightly incremental is
# already `xbrl-projection` on Pub/Sub. Scheduling a whole-backlog drain would
# re-run an irreversible write path unattended — and the moment the backlog is
# gone it would select nothing every night, which is indistinguishable from a
# broken selector at a glance.
#
# Prerequisites:
#   - gcloud authenticated; Cloud Run API on
#   - stockbook-workers-{env} service already deployed (that is the image source)
#
# Usage (env is positional and REQUIRED, as in setup-infra.sh):
#   ./scripts/ops/setup-xbrl-projection-drain-job.sh qa
#   ./scripts/ops/setup-xbrl-projection-drain-job.sh prod
#   ./scripts/ops/setup-xbrl-projection-drain-job.sh prod --dry-run   # print only
#   ./scripts/ops/setup-xbrl-projection-drain-job.sh prod --arm       # writes ARMED
#   ./scripts/ops/setup-xbrl-projection-drain-job.sh prod --image=IMG
#   ./scripts/ops/setup-xbrl-projection-drain-job.sh prod --task-timeout=7200
# ============================================

set -euo pipefail

RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; BLUE='\033[0;34m'; NC='\033[0m'

PROJECT_ID="stock-book-483718"
REGION="asia-south1"
# Same SA the workers service runs as: already has Mongo egress, so the job
# needs no new IAM surface of its own.
JOB_SA="stockbook-api@${PROJECT_ID}.iam.gserviceaccount.com"

# Env is POSITIONAL and REQUIRED, matching setup-infra.sh / setup-scheduler.sh /
# setup-xbrl-backfill-job.sh. There is deliberately no default: this job writes
# to a real database through a unique key with no `source` column, and every
# sibling ops script makes you name the environment out loud.
ENV=${1:-""}
shift || true

IMAGE=""
DRY_RUN=false
# DISARMED by default. --arm is the deliberate act; see the header for the
# reconcile precondition it depends on.
ARM=false
# 24h is the Cloud Run Jobs maximum and matches xbrl-backfill-{env}. The job's
# OWN wall-clock budget defaults to 6h (--budget-sec) and is checked BETWEEN
# batches, so the worst case is budget + one batch. The task timeout must stay
# comfortably above that: a task killed by Cloud Run loses the final summary,
# which is the only artifact that says whether to re-run.
TASK_TIMEOUT="86400"
while [ $# -gt 0 ]; do
    case "$1" in
        --image=*)        IMAGE="${1#*=}"; shift ;;
        --task-timeout=*) TASK_TIMEOUT="${1#*=}"; shift ;;
        --arm)            ARM=true; shift ;;
        --dry-run)        DRY_RUN=true; shift ;;
        -h|--help)        grep '^#' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
        *) echo "Unknown argument: $1"; exit 1 ;;
    esac
done

case "$ENV" in
    prod)
        DB_SECRET="DATABASE_URL_PROD"
        DD_SECRET="DD_API_KEY_PROD"
        ;;
    qa)
        DB_SECRET="DATABASE_URL_QA"
        DD_SECRET="DD_API_KEY_QA"
        ;;
    *)
        echo "Usage: ./scripts/ops/setup-xbrl-projection-drain-job.sh [qa|prod] [options]"
        echo ""
        echo "Options:"
        echo "  --arm                  Deploy with XBRL_PROJECTION_APPLY=true."
        echo "                         Default is present-and-\"false\" — absent and"
        echo "                         \"false\" must never be the same state."
        echo "  --image=IMG            Pin an explicit image instead of resolving it"
        echo "                         from the live stockbook-workers-{env} service"
        echo "  --task-timeout=SECS    Cloud Run task timeout (default 86400 = 24h max)"
        echo "  --dry-run              Print the gcloud calls, change nothing"
        echo ""
        echo "Deploys the Cloud Run job xbrl-projection-drain-{env} (MONEY-1235)."
        echo "No Scheduler trigger, ever — see the header."
        exit 1
        ;;
esac

APPLY_ENV_VALUE="false"
if [ "$ARM" = true ]; then APPLY_ENV_VALUE="true"; fi

# Cloud Run names are per-env; the deployed services are stockbook-workers-prod
# / -qa, NOT a bare stockbook-workers.
SERVICE_NAME="stockbook-workers-${ENV}"
JOB_NAME="xbrl-projection-drain-${ENV}"
ENTRYPOINT="dist/xbrl-projection-drain.js"

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

# PRINT WHAT WAS PINNED. workers/cloudbuild.*.yaml tags
# `stockbook-workers:{env}-$COMMIT_SHA` and bakes the SAME $COMMIT_SHA as
# DD_VERSION, so the SHA below is exactly what the job's first log line must
# report back. If they ever disagree, the job is not running the image you think
# it is.
IMAGE_TAG="${IMAGE##*:}"
IMAGE_SHA="${IMAGE_TAG#"${ENV}"-}"
echo -e "   image  : ${GREEN}${IMAGE}${NC}"
echo -e "   source : ${IMAGE_SOURCE}"
echo -e "   tag    : ${GREEN}${IMAGE_TAG}${NC}"
echo -e "   commit : ${GREEN}${IMAGE_SHA}${NC}"

# Digest is best-effort: `container images describe` needs registry read
# permission a Cloud-Run-only operator may not have, and failing the whole
# provision over an advisory line would be absurd.
IMAGE_DIGEST="$("${GC[@]}" container images describe "$IMAGE" \
    --format='value(image_summary.digest)' 2>/dev/null || true)"
if [ -n "$IMAGE_DIGEST" ]; then
    echo -e "   digest : ${GREEN}${IMAGE_DIGEST}${NC}"
else
    echo -e "   digest : ${YELLOW}(not resolved — tag above is the pin of record)${NC}"
fi

echo -e "   ${YELLOW}PREFLIGHT: this image must contain ${ENTRYPOINT}"
echo -e "   (the 'xbrl-projection-drain' entry in workers/tsup.config.ts). On an"
echo -e "   older image the container dies instantly with"
echo -e "   \"Cannot find module /app/${ENTRYPOINT}\".${NC}"

# ── 2. Deploy the job ─────────────────────────────────────────────────────
echo -e "${BLUE}━━━ 2/3: Cloud Run Job — ${JOB_NAME} ━━━${NC}"

if [ "$ARM" = true ]; then
    echo -e "   ${RED}ARMED: XBRL_PROJECTION_APPLY=true.${NC}"
    echo -e "   ${YELLOW}StockFinancials has no \`source\` in its unique key, so the first"
    echo -e "   XBRL write to a period DESTROYS the incumbent value with nothing left"
    echo -e "   to reconcile against. The F3 reconcile (scripts/data/xbrl-reconcile.ts)"
    echo -e "   must read READY before this — it cannot be run afterwards.${NC}"
else
    echo -e "   ${GREEN}DISARMED: XBRL_PROJECTION_APPLY=false${NC} (present, not absent —"
    echo -e "   absent and \"false\" must never be the same state; that is how"
    echo -e "   MF_METADATA_PROVIDER disabled its job silently for months)."
fi

# 2Gi, not the sibling's 1Gi. This job's memory profile is a whole PAGE of
# filings held at once — every row's `facts` JSON plus one ScaleObservation per
# row for the scale detector's per-symbol context — at up to --limit=5000 rows.
# xbrl-backfill holds one month's slim index entries and ONE XBRL document.
deploy_args=(
    run jobs deploy "$JOB_NAME"
    --image="$IMAGE"
    --region="$REGION"
    --service-account="$JOB_SA"
    # The script path belongs in --command, NOT --args. `gcloud run jobs execute
    # --args=...` REPLACES the container's args rather than appending to them,
    # so with `--command=node --args=dist/xbrl-projection-drain.js` every
    # parameterised execution becomes `node --apply` and dies with "bad option".
    # Keeping the entrypoint in --command means execution-time args land AFTER
    # it, which is the whole point of a parameterised job.
    # `--args=""` clears the list (there is no --clear-args on jobs deploy).
    # Without it a re-deploy KEEPS the old args and the container runs
    # `node dist/xbrl-projection-drain.js dist/xbrl-projection-drain.js`.
    --command="node,$ENTRYPOINT"
    --args=""
    # NOT laziness. A retry re-runs the whole drain from the top with the SAME
    # arguments, i.e. it re-opens the irreversible write path unattended. The
    # drain is idempotent so a retry is not corrupting — the writer SKIPs a row
    # whose values already match — but an automatic retry of a task that was
    # killed for a REASON (OOM at a large --limit, a Mongo outage mid-write)
    # just re-runs into the same wall while looking like progress. Re-running is
    # a human decision, and it is free: projectedAt on the rows IS the
    # checkpoint.
    --max-retries=0
    --task-timeout="$TASK_TIMEOUT"
    --memory=2Gi
    --cpu=1
    # Set EXPLICITLY, because a job spec does NOT inherit the service's env
    # block. XBRL_PROJECTION_APPLY is PRESENT in both states on purpose.
    #
    # DD_VERSION is absent ON PURPOSE. It is baked into the image and must stay
    # a property of the image — see the header.
    # MONEY-1278 — a Cloud Run JOB has no Datadog agent. DD_API_KEY is what makes
    # `datadog-metrics` emit at all (it no-ops without one, so `reportJobOutcome`
    # reached nobody from any of the 17 TypeScript jobs — including `feed-parse`,
    # which apply-monitors.sh monitors on both envs, so its monitor watched a series
    # that was never emitted). DD_TRACE_ENABLED=false overrides the `true` the image
    # bakes in, so dd-trace does not boot against a socket that is not there.
    --set-env-vars="XBRL_PROJECTION_APPLY=${APPLY_ENV_VALUE},GCP_PROJECT_ID=${PROJECT_ID},DD_ENV=${ENV},DD_TRACE_ENABLED=false"
    --set-secrets="DATABASE_URL=${DB_SECRET}:latest,DD_API_KEY=${DD_SECRET}:latest"
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
echo -e "   ${YELLOW}None, deliberately. The nightly incremental is already the"
echo -e "   xbrl-projection Pub/Sub worker. Scheduling a whole-backlog drain"
echo -e "   would re-run an irreversible write path unattended — and once the"
echo -e "   backlog is gone it would select nothing every night, which reads as"
echo -e "   a broken selector at a glance.${NC}"

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
  arm    XBRL_PROJECTION_APPLY=${APPLY_ENV_VALUE}
  retry  --max-retries=0   task-timeout ${TASK_TIMEOUT}s   memory 2Gi

VERIFY THE PIN, do not assume it. The job prints its own build as its
first line; that SHA must equal ${IMAGE_SHA} above. This is the ONE
check that can actually go red — Cloud Run JOBS pin their image at
provision time and a deploy of the SERVICE does not move them:

  gcloud run jobs execute ${JOB_NAME} --region=${REGION} --wait
  gcloud logging read \\
    'resource.type=cloud_run_job AND resource.labels.job_name=${JOB_NAME} AND textPayload:"build-provenance"' \\
    --limit=5 --freshness=1h --project=${PROJECT_ID}

With no --args the run is a DRY RUN: --apply defaults to false, so it
plans one batch, reports what it WOULD write, stamps nothing and exits 0.
That smoke test costs nothing and still proves the entrypoint, the
secret, Mongo and the arming resolution all work in the container.

A dry run is ONE batch on purpose. Nothing is stamped, so batch 2 would
select the identical page — the job says so and stops rather than
spinning to the task timeout. "stop=dry-run" is not a truncation.

NOTE gcloud splits --args on COMMAS, so each comma below starts a NEW
argument. An unrecognised argument is FATAL here (unlike xbrl-backfill):
a mistyped --apply would otherwise run a silent dry run and exit 0,
which is indistinguishable from a deliberate rehearsal.

────────────────────────────────────────────────────────────────
THE PILOT — SCOPED, ARMED, AND CHECKED BY HAND FIRST

A CREATE is by construction a row the reconciliation never compared, and
a 100%-create run is also the exact signature of a periodLabel join bug.
prod holds ZERO quarterly stock_financials rows against 71,450 quarterly
filings, so EVERY quarterly write is a create. Check a small batch by
hand before any full drain.

  # 1. dry run, scoped — see the shape with nothing at stake
  gcloud run jobs execute ${JOB_NAME} --region=${REGION} --wait \\
    --args="--create-missing,--period-types=QUARTERLY,--limit=200,--symbols=RELIANCE,TCS,HDFCBANK,INFY,ICICIBANK,SBIN,BHARTIARTL,ITC,LT,KOTAKBANK,AXISBANK,MARUTI,ASIANPAINT,TITAN,SUNPHARMA,NESTLEIND,ULTRACEMCO,WIPRO,TATAMOTORS,BAJFINANCE"

  # 2. arm the ENVIRONMENT (a deploy, i.e. a review), then re-run WITH --apply
  ./scripts/ops/setup-xbrl-projection-drain-job.sh ${ENV} --arm
  gcloud run jobs execute ${JOB_NAME} --region=${REGION} --wait \\
    --args="--apply,--create-missing,--period-types=QUARTERLY,--limit=200,--symbols=RELIANCE,TCS,HDFCBANK,INFY,ICICIBANK,SBIN,BHARTIARTL,ITC,LT,KOTAKBANK,AXISBANK,MARUTI,ASIANPAINT,TITAN,SUNPHARMA,NESTLEIND,ULTRACEMCO,WIPRO,TATAMOTORS,BAJFINANCE"

  # 3. READ THE ROWS. Not the counters — the rows, against the filings.
  #    Then and only then, the full drain.

────────────────────────────────────────────────────────────────
THE FULL DRAIN — QUARTERLY FIRST, THEN THE REST

  gcloud run jobs execute ${JOB_NAME} --region=${REGION} \\
    --args="--apply,--create-missing,--period-types=QUARTERLY,--limit=2000"

  gcloud run jobs execute ${JOB_NAME} --region=${REGION} \\
    --args="--apply,--create-missing,--limit=2000"

ARITHMETIC, so the run's length is not a surprise. At --limit=L the loop
stamps a page per batch, so batches ~= ceil(population / L), plus a
little: a page that hits the limit DEFERS its trailing symbol
(dropPartialTrailingSymbol), which costs about half a symbol's filings
per batch.

  71,450 QUARTERLY  / 2000 = 35.7  -> ~36 batches
  90,188 unprojected/ 2000 = 45.1  -> ~46 batches
  71,450            / 5000 = 14.3  -> ~15 batches
  90,188            / 5000 = 18.0  -> ~19 batches

5000 is the ceiling (--limit is clamped to it, matching the nightly
job's own Math.min(5000,…)) and is why the job spec asks for 2Gi.

STOP REASONS, and what each one means:

  drained      no unprojected filings left in scope. Exit 0.
  dry-run      unarmed: one batch, nothing stamped. Exit 0.
  no-advance   a page read filings and the population did NOT shrink.
               The writer stamps only DECIDED filings; create-suppressed
               and no-instrument outcomes are deliberately not decisions,
               so a page made entirely of them can never advance. The job
               stops instead of spinning. Exit 1.
  max-batches  the runaway guard (default 200). Exit 1.
  budget       the 6h wall-clock budget, checked BETWEEN batches. Exit 1.

Every non-zero exit resumes for FREE. projectedAt on the rows IS the
checkpoint — there is deliberately no checkpoint table, because the
MONEY-1189 postmortem is a catalogue of checkpoints recording DONE for
work that never happened. Re-running writes nothing it already wrote.

  gcloud logging read \\
    'resource.type=cloud_run_job AND resource.labels.job_name=${JOB_NAME}' \\
    --limit=200 --freshness=6h --project=${PROJECT_ID}

────────────────────────────────────────────────────────────────
DISARM WHEN THE DRAIN IS DONE

Leave nothing armed that nobody is watching. The nightly xbrl-projection
worker keeps up with new filings on its own env flag; this job's flag
should go back to "false" once the backlog is gone:

  ./scripts/ops/setup-xbrl-projection-drain-job.sh ${ENV}
────────────────────────────────────────────────────────────────
EOF
