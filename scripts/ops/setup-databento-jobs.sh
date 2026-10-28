#!/usr/bin/env bash
#
# setup-databento-jobs.sh — provision the two Databento Cloud Run jobs for one
# environment.
#
# MONEY-1373. The US minute/second-bar backbone, moved off the operator's
# laptop for the same reason every other one-shot walk in this directory was.
#
#   databento-harvest-{env}        dist/databento-harvest.js
#   databento-append-{env}         dist/databento-append.js
#   ledger-backfill-databento-{env} dist/ledger-backfill-databento.js   (B1)
#   lake-load-databento-{env}      dist/lake-load-databento.js          (B5)
#
# The last two SPEND NOTHING — they read the inventory and the archived bytes
# the first two bought — and they ride this script because they need the same
# image, service account, bucket and secrets.
#
# ── WHY JOBS AND NOT PUSH WORKERS ─────────────────────────────────────────────
#
# Every worker job in this repo arrives over a Pub/Sub PUSH subscription with a
# 600s ack deadline, which is Pub/Sub's MAXIMUM and cannot be raised. A handler
# that runs past it is not merely slow: Pub/Sub treats the message as unacked
# and REDELIVERS it, so a second copy starts while the first is still running.
#
# HARVEST submits a Databento batch job, waits for the vendor to materialise it,
# downloads hundreds of gigabytes of DBN and loads the loadable schemas. That is
# hours to days per manifest entry, not seconds. APPEND polls a batch job to
# completion and appends what it finds. Both are orders of magnitude past 600s;
# neither is a tuning problem.
#
# ── ONE MANIFEST ENTRY PER EXECUTION, AND THE JOB REFUSES OTHERWISE ───────────
#
# `scripts/data/databento-manifest.json` holds seven entries, and they differ by
# THREE ORDERS OF MAGNITUDE in size — `definition-baseline` is minutes,
# `ohlcv-1s-baseline` is TB-scale and cannot fit the 24h task timeout at all. A
# bare `--apply` that walked every entry in one execution would be killed
# part-way and surface as a FAILED task rather than as the "you asked for too
# much" it actually is.
#
# So an execution names its entry:
#
#   --args=--apply,--entry=ohlcv-1m-baseline
#
# Both the job and `run-market-data-job.sh dbharvest` refuse a scope-less
# `--apply`. Two refusals for one rule is deliberate: the wrapper's message is
# the operator-facing one and can print the entry ids, while the job's is the
# one that still fires when somebody reaches for `gcloud` directly.
#
# ── THE TWO ARM FLAGS SHIP PRESENT AND "false", ON THE JOB ────────────────────
#
# >>> AND THEY ARE **NOT** IN THE CLOUDBUILD SERVICE SPECS. <<<
#
# Two independent reasons, both measured:
#
#   (a) A Cloud Run JOB DOES NOT INHERIT THE SERVICE'S ENV BLOCK. A var set only
#       in `workers/cloudbuild.{prod,qa}.yaml` is read by NOTHING in these two
#       jobs. That is the `TIINGO_RT_EPHEMERAL_TTL_S` shape exactly — a var that
#       shipped in BOTH specs, was read by nobody, and documented a default
#       (900) that disagreed with the only live writer (600). A flag nobody
#       reads is worse than a missing flag, because flipping it looks like it
#       worked.
#
#   (b) THERE IS NO ROOM IN THE HEREDOCS. `workers/__tests__/cloudbuild-arg-limit.test.ts`
#       measures the longest inline `- |` argument against Cloud Build's 10,000
#       character per-argument ceiling and asserts 700 characters of headroom on
#       top. Prod measures 9,196 and QA 9,174, so the margins are 804 and 826 —
#       two more env entries in each spec would take that under the floor and
#       fail the test, and a spec that squeaks past the test still fails the
#       DEPLOY at `gcloud run services replace`, after the image is built.
#
# PRESENT-and-"false" rather than absent, because ABSENT and EXPLICITLY-OFF must
# not be the same state. `MF_METADATA_PROVIDER` was absent and disabled its job
# silently for months (MONEY-1214); nobody could tell "we turned it off" from
# "somebody dropped the line". Both flags are compared against the LITERAL
# string in the job — `Boolean("false")` is `true`, which would arm the walk in
# the one configuration meant to keep it off.
#
# ARMING IS A DELIBERATE, SEPARATE ACT:
#
#   gcloud run jobs update databento-harvest-prod --region=asia-south1 \
#     --update-env-vars=DATABENTO_HARVEST_APPLY=true
#
# >>> `--update-env-vars` MERGES. `--set-env-vars` REPLACES THE WHOLE BLOCK. <<<
# Using `--set-env-vars` for that one-liner would drop GCP_STORAGE_BUCKET,
# GCP_PROJECT_ID, DD_ENV, DATABENTO_ENV and the budget in the same breath — and
# the job would then run, archive nothing, and report success, because a missing
# bucket is a soft failure in the archive layer by design.
#
# ── QA NEVER SPENDS ───────────────────────────────────────────────────────────
#
# Both flags ship "false" in BOTH environments. Disarmed, the jobs QUOTE and
# REPORT: they call only `metadata.get_cost` and `metadata.get_dataset_range`,
# which are FREE on the Databento historical API, and they never reach
# `batch.submit_job`. So QA exercises the manifest, the symbology, the budget
# ledger and the archive wiring while spending nothing — which is the whole
# reason the same account key is mounted in both. There is no separate QA
# entitlement to burn; there is only one bill.
#
# ── NO FEED_ARCHIVE_MODE — DELIBERATE ─────────────────────────────────────────
#
# Every other archive-touching job here carries `FEED_ARCHIVE_MODE`. These two
# do NOT, and it is not an omission. The Databento archive lives under
# `databento/` in the bucket, OUTSIDE `feeds/`, precisely because the
# `sync-prod-to-qa-feeds` job rsyncs the WHOLE `feeds/` prefix prod -> QA twice a
# day. A TB-scale second-bar archive under that prefix would be mirrored in full,
# nightly, for a set of bytes QA has no reader for. Same call as `edgar/`
# (MONEY-979), for the same reason and at the same order of magnitude.
#
# ── CLOUD RUN JOBS PIN THEIR IMAGE AT PROVISION TIME ──────────────────────────
#
# A deploy of the `stockbook-workers-{env}` SERVICE does not move them. Nothing
# re-points a job until somebody re-runs a script, and nobody re-runs a setup
# script on a Tuesday. On 2026-08-18 `feed-parse-prod` was still on a 14-Aug
# image while the service had moved to an 18-Aug one: it ran nightly, exited 0,
# and skipped four feed families it had never heard of.
#
# THIS SCRIPT IS WHAT CREATES THEM, and re-running it is what re-pins them by
# hand. The release also re-pins both (they are in the `for BASE in …` loop in
# both cloudbuild specs, MONEY-1373), so the steady state is covered per
# release — but a job provisioned between releases is on whatever image was live
# when it was created until one of those two things happens.
#
# Usage:
#   ./scripts/ops/setup-databento-jobs.sh qa
#   ./scripts/ops/setup-databento-jobs.sh prod
#   ./scripts/ops/setup-databento-jobs.sh prod --dry-run
#   ./scripts/ops/setup-databento-jobs.sh prod --image=IMG
#   ./scripts/ops/setup-databento-jobs.sh prod --only=append
#   ./scripts/ops/setup-databento-jobs.sh prod --only=lake-load
#   ./scripts/ops/setup-databento-jobs.sh prod --harvest-tasks=4
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
ONLY=""
DISARM=false
HARVEST_TASKS="1"

# ── TASK TIMEOUTS, DERIVED PER JOB ────────────────────────────────────────────
#
# Sized from what each job WAITS ON, not copied from a sibling.
#
# HARVEST gets Cloud Run's 24h MAXIMUM. Its wall clock is dominated by two
# terms we do not control: Databento materialising a batch job (minutes to
# hours, depending on the schema and the range) and the download of the result
# (hundreds of GB for the larger entries at whatever the network gives). A
# harvest that finishes early exits early and costs nothing for the unused
# ceiling; one that is killed at 24h costs a re-run, because the job resumes
# from its own Mongo inventory rather than from the top.
#
# APPEND gets 2h and deliberately NOT 24h. It polls ONE already-submitted batch
# job and appends what it finds — minutes of real work. If it is still running
# two hours later, the vendor job is wedged or the poll loop is, and a job that
# hangs for a full DAY before anyone looks is a job whose failure nobody sees. A
# tight timeout on short work is a SIGNAL, and it is free because the append is
# resumable.
TASK_TIMEOUT_HARVEST="86400"   # 24h — Cloud Run's maximum
TASK_TIMEOUT_APPEND="7200"     # 2h

while [ $# -gt 0 ]; do
    case "$1" in
        --image=*)         IMAGE="${1#*=}"; shift ;;
        --only=*)          ONLY="${1#*=}"; shift ;;
        --harvest-tasks=*) HARVEST_TASKS="${1#*=}"; shift ;;
        --dry-run)         DRY_RUN=true; shift ;;
        --disarm)          DISARM=true; shift ;;
        *) echo "Unknown option: $1" >&2; exit 1 ;;
    esac
done

case "$ENV" in
    prod)
        BUCKET="stockbook-content-prod"
        DB_SECRET="DATABASE_URL_PROD"
        DD_SECRET="DD_API_KEY_PROD"
        DATABENTO_SECRET="DATABENTO_API_KEY_PROD"
        ;;
    qa)
        BUCKET="stockbook-content-qa"
        DB_SECRET="DATABASE_URL_QA"
        DD_SECRET="DD_API_KEY_QA"
        DATABENTO_SECRET="DATABENTO_API_KEY_QA"
        ;;
    *)
        echo "Usage: $0 {qa|prod} [--image=IMG] [--only=harvest|append|ledger-backfill] [--disarm]"
        echo "          [--harvest-tasks=N] [--dry-run]"
        echo
        echo "Deploys the two Databento Cloud Run jobs (MONEY-1373)."
        echo "The HARVEST has no Scheduler trigger; the APPEND has two"
        echo "(setup-scheduler.sh, prod-only). See the header."
        exit 1
        ;;
esac

# FAIL CLOSED on a non-integer. This value reaches `--tasks`/`--parallelism`,
# and gcloud's own error for a malformed one arrives AFTER the first job is
# already deployed — a half-provisioned pair is the state hardest to reason
# about later.
case "$HARVEST_TASKS" in
    ''|*[!0-9]*)
        echo -e "${RED}--harvest-tasks=${HARVEST_TASKS} must be a positive integer.${NC}" >&2
        exit 1
        ;;
esac
if [ "$HARVEST_TASKS" -lt 1 ]; then
    echo -e "${RED}--harvest-tasks must be >= 1.${NC}" >&2
    exit 1
fi

# The monthly ceiling the budget ledger enforces, matching
# DEFAULT_DATABENTO_MONTHLY_BUDGET_USD in
# packages/core/src/market-data/databento/databento-budget.ts. Set EXPLICITLY
# for the MONEY-1214 reason: "absent" and "explicitly 25" must not be one state.
# It is a PLAIN var and not a secret — an operator has to be able to read the
# spend ceiling at a glance, and it is read PER CALL rather than captured in a
# module const, so a redeployed value takes effect on a warm container.
DATABENTO_BUDGET_USD="25"

SERVICE_NAME="stockbook-workers-${ENV}"

# Per the repo's GCP isolation rule: never activate a config, always pass the
# account/project explicitly on each call.
GC=(gcloud --project="$PROJECT_ID" --account=founder@disdigital.in)

# ── 1. Resolve the image from the live service ────────────────────────────────
echo -e "${BLUE}━━━ 1/3: Resolve image from ${SERVICE_NAME} ━━━${NC}"
IMAGE_SOURCE="explicit --image"
if [ -z "$IMAGE" ]; then
    IMAGE_SOURCE="live ${SERVICE_NAME} service"
    IMAGE="$("${GC[@]}" run services describe "$SERVICE_NAME" \
        --region="$REGION" \
        --format='value(spec.template.spec.containers[0].image)' 2>/dev/null || true)"
fi

# FAILS CLOSED. An empty IMAGE must never reach `gcloud run jobs deploy`: gcloud
# reads an empty `--image` as "keep whatever is there", which on a re-provision
# silently preserves the stale pin this script exists to move — the one failure
# that looks exactly like success.
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
echo -e "   ${YELLOW}PREFLIGHT: this image must contain dist/databento-harvest.js and"
echo -e "   dist/databento-append.js (the two 'databento-*' entries in"
echo -e "   workers/tsup.config.ts, added by MONEY-1373). On an older image the"
echo -e "   container dies instantly with \"Cannot find module /app/dist/databento-...\".${NC}"

# ── 2. Deploy the jobs ────────────────────────────────────────────────────────
echo -e "${BLUE}━━━ 2/3: Cloud Run Jobs ━━━${NC}"

# deploy_job <job-suffix> <entrypoint> <task-timeout> <memory> <cpu> [extra gcloud args…]
deploy_job() {
    local suffix="$1" entrypoint="$2" timeout="$3" memory="$4" cpu="$5" default_args="$6"
    shift 6  # five sizing args plus the default --args value
    local job_name="${suffix}-${ENV}"
    # Per-job identity. Caller-scoped overrides (`DEPLOY_SA=… DEPLOY_SECRETS=…
    # deploy_job …`) rather than a flag appended through "$@": a repeated
    # --service-account / --set-secrets resolves by gcloud's parse order, which
    # is a rule nobody should have to remember to read this job's identity.
    local job_sa="${DEPLOY_SA:-$JOB_SA}"
    local job_secrets="${DEPLOY_SECRETS:-DATABASE_URL=${DB_SECRET}:latest,GCP_SERVICE_ACCOUNT_KEY_BASE64=GCP_SERVICE_ACCOUNT_KEY_BASE64:latest,DATABENTO_API_KEY=${DATABENTO_SECRET}:latest,DD_API_KEY=${DD_SECRET}:latest}"

    # ARMING SURVIVES A RE-PROVISION, and this is a correctness fix rather than
    # a convenience.
    #
    # `--set-env-vars` REPLACES the whole block, so every re-run reset both
    # flags to "false" — while the banner below and `setup-infra.sh` both tell
    # an operator to re-run this script after every workers deploy. Arm the
    # append per the runbook, ship a release, follow the instruction, and the
    # append is silently disarmed again. Nothing errors; the run reports
    # SUCCEEDED.
    #
    # So the LIVE value is read off the deployed job and carried forward.
    #
    # THE HARVEST DEFAULTS TO ARMED — founder decision, 2026-09-08. A first
    # deploy has no job to read; the harvest then ships "true" and the append
    # ships "false". The harvest is safe to ship armed because the env flag is
    # ONE OF TWO KEYS: nothing is bought unless an operator also runs
    # `execute --args=--apply,--entry=<id>` — a bare `--apply` is refused and
    # a missing `--apply` is a dry run — so an armed job idle in the console
    # spends nothing. The APPEND stays disarmed: it is a standing SCHEDULE with
    # no human on the trigger, and its precondition (one observed
    # eviction-planner night, a harvest high-water mark) is checked by a
    # person, never by a default. `--disarm` forces both back to false
    # deliberately.
    local harvest_arm="true" append_arm="false"
    if [ "$DISARM" != true ]; then
        local live_env
        live_env=$("${GC[@]}" run jobs describe "$job_name" --region="$REGION" \
            --format='value(spec.template.spec.template.spec.containers[0].env)' 2>/dev/null || true)
        case "$live_env" in
            *"DATABENTO_HARVEST_APPLY"*"true"*) harvest_arm="true" ;;
        esac
        case "$live_env" in
            *"DATABENTO_APPEND_APPLY"*"true"*) append_arm="true" ;;
        esac
    fi
    if [ "$harvest_arm" = "true" ] || [ "$append_arm" = "true" ]; then
        echo -e "   ${YELLOW}carrying forward the LIVE arm state${NC}: " \
            "DATABENTO_HARVEST_APPLY=${harvest_arm} DATABENTO_APPEND_APPLY=${append_arm}"
        echo -e "   ${YELLOW}pass --disarm to reset both to false.${NC}"
    fi

    local deploy_args=(
        run jobs deploy "$job_name"
        --image="$IMAGE"
        --region="$REGION"
        --service-account="$job_sa"
        # The script path belongs in --command, NOT --args. `gcloud run jobs
        # execute --args=...` REPLACES the container's args rather than
        # appending, so with the entrypoint in --args every parameterised
        # execution would drop it and run `node --apply`. `--args=""` clears the
        # list (there is no --clear-args on jobs deploy); without it a re-deploy
        # KEEPS the old args, so yesterday's `--entry=` would ride along on
        # today's execution.
        --command="node,${entrypoint}"
        --args="${default_args}"
        # A retry restarts a multi-hour walk from the top, against a PAID
        # METERED vendor whose batch jobs are billed on submission. Both jobs
        # are resumable from their own Mongo inventory, so an interruption costs
        # TIME and never WORK — which is exactly what makes re-running a HUMAN
        # decision rather than something Cloud Run does automatically at 03:00
        # into a budget nobody is watching.
        --max-retries=0
        --task-timeout="$timeout"
        --memory="$memory"
        --cpu="$cpu"
        # Set EXPLICITLY: a JOB spec does NOT inherit the service's env block.
        # Without GCP_PROJECT_ID and GCP_STORAGE_BUCKET the archive writes go
        # nowhere and the run reports success having stored no bytes — measured
        # on the BSE job, 59 rows with an empty gcsPath (MONEY-1258).
        #
        # The identity that writes those objects is NOT necessarily the
        # --service-account above: `googleCredentials()` resolves
        # GCP_SERVICE_ACCOUNT_KEY_BASE64 FIRST, so the mounted key outranks the
        # runtime SA. Grant object-write on ${BUCKET} to whichever principal
        # that key names — granting it to stockbook-api@ alone has already been
        # a no-op once (Document AI, MONEY-783).
        #
        # DD_API_KEY is what makes `datadog-metrics` emit at all — it no-ops
        # without one, so `reportJobOutcome` reached nobody from any of the 17
        # TypeScript jobs until MONEY-1278. DD_TRACE_ENABLED=false overrides the
        # `true` the image bakes in, so dd-trace does not boot against a
        # sidecar socket that a JOB does not have.
        #
        # Both APPLY flags ship PRESENT HERE, on the job — harvest "true",
        # append "false" (see the arm block above) — and are absent from the
        # cloudbuild service specs. See the header: a job does not inherit the
        # service env, and the two heredocs have 804 / 826 characters of
        # headroom against a 700-character floor.
        --set-env-vars="GCP_STORAGE_BUCKET=${BUCKET},GCP_PROJECT_ID=${PROJECT_ID},DD_ENV=${ENV},DD_TRACE_ENABLED=false,DATABENTO_ENV=${ENV},DATABENTO_HARVEST_APPLY=${harvest_arm},DATABENTO_APPEND_APPLY=${append_arm},DATABENTO_MONTHLY_BUDGET_USD=${DATABENTO_BUDGET_USD},LAKE_ENV=${ENV},LAKE_PROJECT=${PROJECT_ID}"
        # DATABENTO_API_KEY is a SECRET: it is an HTTP Basic credential (sent as
        # the username with an empty password), so a plain env var would put it
        # in every `jobs describe` and every deploy log. The client THROWS when
        # it is absent rather than fetching unauthenticated, so a missing secret
        # is a loud failure and not a job that quietly writes nothing.
        #
        # DATABENTO_MONTHLY_BUDGET_USD above is deliberately the opposite: a
        # plain var, because an operator must be able to read the spend ceiling
        # at a glance before arming anything.
        --set-secrets="$job_secrets"
        "$@"
    )

    if [ "$DRY_RUN" = true ]; then
        echo "   [dry-run] gcloud ${deploy_args[*]}"
        echo "   [dry-run] gcloud run jobs add-iam-policy-binding ${job_name} --region=${REGION} --member=serviceAccount:${job_sa} --role=roles/run.invoker"
    else
        "${GC[@]}" "${deploy_args[@]}"
        "${GC[@]}" run jobs add-iam-policy-binding "$job_name" --region="$REGION" \
            --member="serviceAccount:${job_sa}" --role=roles/run.invoker \
            --quiet >/dev/null
        echo -e "   ${GREEN}${job_name} deployed${NC}  (timeout ${timeout}s, ${memory}, cpu ${cpu})"
    fi
}

# HARVEST: 4Gi / 2 vCPU. NOT for a DBN decode buffer — we never decode DBN. The
# transfer is CSV+ZSTD (the server-side transcode is free and billing is on the
# binary size either way), so what has to fit at once is the zstd
# decompressor's window, the loader's per-symbol buffer
# (DEFAULT_MAX_BUFFERED_ROWS_PER_SYMBOL = 120,000 rows) and one write batch.
# Cloud Run REQUIRES 2 vCPU above 4Gi anyway, and the headroom is cheap next to
# losing a 24h download to an OOM.
#
# --tasks is OPT-IN and defaults to 1, unlike doc-ingest-backfill's 4. The
# sharding there is over a symbol prefix set that is disjoint by construction;
# here the unit of work is a MANIFEST ENTRY and one execution takes exactly one,
# so N tasks are N copies of the same entry unless the job itself shards inside
# the entry. Pass --harvest-tasks only for an entry whose job DOES
# (`splitSymbols: true` in the manifest), and remember the memory ceiling is
# PER SLOT: four tasks each sized against the whole container reproduce the OOM
# the 4Gi is there to prevent. `--parallelism` is set equal to `--tasks`, or the
# shards queue behind each other and the wall clock is unchanged.
#
# AND SHARDING APPLIES TO `--step=load` ONLY. The job REFUSES `--shard` with
# `--step=all`: quote, poll and download are leader-only, so the non-leader
# tasks would reach the load before anything was downloaded and exit 0 having
# done nothing. Run the download on one task, then the load on N.

# FAIL CLOSED on a mistyped --only, the same way --harvest-tasks does. Without
# this, `--only=harvst` matched neither branch, deployed nothing, and still
# printed the full "Provisioned the Databento jobs" banner with both job lines
# — the banner reports intent, not what was issued.
if [ -n "$ONLY" ] && [ "$ONLY" != "harvest" ] && [ "$ONLY" != "append" ] \
     && [ "$ONLY" != "ledger-backfill" ] && [ "$ONLY" != "lake-load" ]; then
    echo -e "${RED}--only=${ONLY} is not one of: harvest, append, ledger-backfill, lake-load.${NC}" >&2
    exit 1
fi

if [ -z "$ONLY" ] || [ "$ONLY" = "harvest" ]; then
    if [ "$HARVEST_TASKS" -gt 1 ]; then
        deploy_job "databento-harvest" "dist/databento-harvest.js" \
            "$TASK_TIMEOUT_HARVEST" "4Gi" "2" "" \
            --tasks="$HARVEST_TASKS" --parallelism="$HARVEST_TASKS"
    else
        deploy_job "databento-harvest" "dist/databento-harvest.js" \
            "$TASK_TIMEOUT_HARVEST" "4Gi" "2" ""
    fi
fi

# APPEND: 2Gi / 1 vCPU. It polls one batch job and appends a bounded delta —
# there is no full-history buffer to hold, so the harvest's ceiling would be
# paid for nothing.
#
# THE APPEND CARRIES `--apply` AS ITS DEFAULT ARG, and the harvest does not.
#
# `resolveApply` requires BOTH halves: `--apply` on the command line ASKS and
# `DATABENTO_APPEND_APPLY` ARMS. That is right for the harvest, which is a
# one-time buy a human drives. It is WRONG for the append, whose scheduled run
# IS the product and has no human to pass a flag: Cloud Scheduler POSTs
# `<job>:run` with no message body, so the container's argv was `[]` and
# `resolveApply(false, true)` returned `apply: false`. An armed append was a
# permanent dry run — and `armMissing` was false too, so the loud ARM MISSING
# warning never printed either.
#
# The env flag remains the ONLY switch, which is what the runbook documents.
# An execution that passes its own `--args` REPLACES this default, so a
# parameterised run must include `--apply` itself; the banner says so.
if [ -z "$ONLY" ] || [ "$ONLY" = "append" ]; then
    deploy_job "databento-append" "dist/databento-append.js" \
        "$TASK_TIMEOUT_APPEND" "2Gi" "1" "--apply"
fi

# MONEY-1472 (B1) — the lake ledger backfill.
#
# IT IS A JOB, and it has to be. The harvest's ledger mirror swallows a
# BigQuery failure on purpose — by then the vendor has been PAID, and throwing
# would discard a bought inventory — and its error line promises that
# `ledger-backfill-databento` will retry. A named remedy that exists only as
# `npx tsx` on somebody's laptop is not a remedy, so it is deployed here
# alongside the jobs whose failures it repairs.
#
# NO SCHEDULER, like the harvest: it is a catch-up pass an operator runs after
# a failed mirror or a schema change, not a standing nightly. A cron over it
# would re-walk the whole job table every night to write rows that are already
# there.
#
# 1 Gi / 1 CPU and a 2 h cap: it issues BigQuery MERGEs and holds no data.
# `--env ${ENV}` is passed as the default arg so an execution with no `--args`
# does the right thing; an execution that passes its own REPLACES this, so a
# parameterised run must include `--env` and `--apply` itself.
if [ -z "$ONLY" ] || [ "$ONLY" = "ledger-backfill" ]; then
    # ONE comma-joined string: `deploy_job` takes `default_args` as a SINGLE
    # positional ($6) and passes the rest to gcloud. Three separate tokens put
    # `prod --apply` AFTER `--set-secrets`, where gcloud read them as stray
    # positionals and the job would have deployed with `--args=--env` alone.
    deploy_job "ledger-backfill-databento" "dist/ledger-backfill-databento.js" \
        "7200" "1Gi" "1" "--env,${ENV},--apply"
fi

# MONEY-1505 (B5) — the lake bar loader: the Databento bars ALREADY in GCS into
# `lake_silver.trade_bar_{m1,h1}` and `spread_cost_daily`.
#
# IT SPENDS NOTHING. There is no Databento client on any path out of it — every
# byte it reads was bought and checksum-verified by the harvest — so unlike its
# three siblings a re-run costs GCS reads and free BigQuery load jobs. That is
# also why it carries NO apply env flag: the arming interlock exists to stop an
# unattended run from buying something, and this one cannot buy.
#
# 4Gi / 2 vCPU and a 6h cap. The memory is for the STAGE BUFFERS, not for a
# decode: one pass over a year fans rows out to up to twelve month partitions,
# each holding up to MAX_STAGE_ROWS (50,000) rows before it uploads — ~300 MB
# at the ceiling, plus the zstd window and the NDJSON string each flush builds.
# Cloud Run REQUIRES 2 vCPU above 4Gi anyway. The 6h cap is sized against the
# largest single execution, the M1 baseline's ~43M-row year.
#
# NO SCHEDULER, like the harvest and the ledger backfill. The replay is
# one-shot per (schema, year) and a nightly top-up is the APPEND's partition,
# which an operator runs with `--year <current> --month <YYYY-MM>` once the
# append has landed the session. A cron here would re-read the current year's
# whole file set every night to store one day.
#
# NO DEFAULT `--args`: this job REQUIRES `--schema` and `--year`, and a default
# naming either would make a bare execution silently load last year's M1
# instead of refusing.
#
# IT RUNS AS lake-writer-{env}@, NOT stockbook-api@ (MONEY-1544 branch,
# measured 2026-09-23). The first four in-region executions (ohlcv-1h
# 2023-2026) each exited 1 on their first DELETE with "Access Denied: Table
# lake_silver_prod.trade_bar_h1" — principal stockbook-api@, which lake §8 and
# setup-lake.sh deliberately grant NOTHING on BigQuery — and stranded 43
# LOADING ledger claims. So this job mounts NO GCP_SERVICE_ACCOUNT_KEY_BASE64
# (`googleCredentials()` would otherwise resolve that key FIRST and put
# stockbook-api@ back, the MONEY-783 trap) and NO DATABENTO_API_KEY (it reads
# the ARCHIVE; it buys nothing). lake-writer@ already holds
# DATABASE_URL_{ENV} and DD_API_KEY_{ENV} (setup-lake-jobs.sh), BigQuery
# dataEditor + jobUser and its own bucket (setup-lake.sh). The one grant it
# lacks is READ on the archive, scoped below to the `databento/` prefix.
if [ -z "$ONLY" ] || [ "$ONLY" = "lake-load" ]; then
    LAKE_WRITER="lake-writer-${ENV}@${PROJECT_ID}.iam.gserviceaccount.com"
    # Object reads only — the job resolves its file set from the Mongo
    # inventory and never LISTS the bucket. (A list clause would need
    # `api.getAttribute(…, "")`, whose comma breaks gcloud's KEY=VALUE parse of
    # --condition.)
    ARCHIVE_COND="expression=resource.name.startsWith(\"projects/_/buckets/${BUCKET}/objects/databento/\"),title=databento-archive-read,description=lake-load-databento reads the Databento archive only"
    if [ "$DRY_RUN" = true ]; then
        echo "   [dry-run] gcloud storage buckets add-iam-policy-binding gs://${BUCKET} --member=serviceAccount:${LAKE_WRITER} --role=roles/storage.objectViewer --condition=${ARCHIVE_COND}"
    else
        "${GC[@]}" storage buckets add-iam-policy-binding "gs://${BUCKET}" \
            --member="serviceAccount:${LAKE_WRITER}" --role=roles/storage.objectViewer \
            --condition="$ARCHIVE_COND" >/dev/null
        echo -e "   ${GREEN}objectViewer (databento/ only) on gs://${BUCKET} -> ${LAKE_WRITER}${NC}"
    fi
    DEPLOY_SA="$LAKE_WRITER" \
    DEPLOY_SECRETS="DATABASE_URL=${DB_SECRET}:latest,DD_API_KEY=${DD_SECRET}:latest" \
        deploy_job "lake-load-databento" "dist/lake-load-databento.js" \
            "21600" "4Gi" "2" ""
fi

# ── 3. Scheduler: the HARVEST has none; the APPEND has two ────────────────────
echo -e "${BLUE}━━━ 3/3: Cloud Scheduler ━━━${NC}"
echo -e "   ${YELLOW}HARVEST: none, deliberately. It buys HISTORY, which is one-shot,"
echo -e "   and a cron would be a standing authorisation to re-submit a paid"
echo -e "   batch job every night for bytes we already hold. It is a founder"
echo -e "   action against a named manifest entry."
echo
echo -e "   APPEND: TWO triggers, provisioned by setup-scheduler.sh, prod-only —"
echo -e "   databento-append-daily-prod  (0 15 * * 2-6)  15:00 IST"
echo -e "   databento-append-retry-prod  (0 18 * * 2-6)  18:00 IST"
echo -e "   Not 13:00: the vendor's T+1 embargo releases the prior session at"
echo -e "   roughly 09:00 UTC = 14:30 IST. Tue-Sat because a US session closing"
echo -e "   16:00 ET lands after midnight IST. Run setup-scheduler.sh AFTER the"
echo -e "   job exists and AFTER it is armed — a scheduled disarmed run reports"
echo -e "   selected: 0 and trips the 7d absence monitor.${NC}"

# Unquoted heredoc so the printed commands name the env actually provisioned.
cat <<EOF

────────────────────────────────────────────────────────────────
Provisioned the Databento jobs (${ENV}).

  image   ${IMAGE}
  commit  ${IMAGE_SHA}
  bucket  ${BUCKET}   archive prefix databento/  (NOT feeds/ — see the header)
  budget  \$${DATABENTO_BUDGET_USD}/month
  retry   --max-retries=0

  databento-harvest-${ENV}   timeout ${TASK_TIMEOUT_HARVEST}s   4Gi   cpu 2   tasks ${HARVEST_TASKS}
  databento-append-${ENV}    timeout ${TASK_TIMEOUT_APPEND}s    2Gi   cpu 1

THE HARVEST SHIPS ARMED, THE APPEND SHIPS DISARMED (founder decision
2026-09-08). DATABENTO_HARVEST_APPLY is PRESENT and "true", DATABENTO_APPEND_APPLY
PRESENT and "false", on the job spec — not in workers/cloudbuild.${ENV}.yaml,
because a Cloud Run JOB does not inherit the SERVICE's env block and those two
heredocs are ~800 characters from the 10,000-char wall. Armed is still
two-key: the harvest buys nothing without --args=--apply,--entry=<id> as well.

  ARM:
    gcloud run jobs update databento-harvest-${ENV} --region=${REGION} \\
      --project=${PROJECT_ID} --account=founder@disdigital.in \\
      --update-env-vars=DATABENTO_HARVEST_APPLY=true

    gcloud run jobs update databento-append-${ENV} --region=${REGION} \\
      --project=${PROJECT_ID} --account=founder@disdigital.in \\
      --update-env-vars=DATABENTO_APPEND_APPLY=true

  DISARM (same command, value false — never delete the var; absent and
  explicitly-off must not be one state, MONEY-1214):
    gcloud run jobs update databento-harvest-${ENV} --region=${REGION} \\
      --project=${PROJECT_ID} --account=founder@disdigital.in \\
      --update-env-vars=DATABENTO_HARVEST_APPLY=false

>>> USE --update-env-vars, NEVER --set-env-vars. <<<
\`--update-env-vars\` MERGES one key into the block. \`--set-env-vars\` REPLACES
the WHOLE block, so the arming one-liner would silently drop
GCP_STORAGE_BUCKET, GCP_PROJECT_ID, DD_ENV, DD_TRACE_ENABLED, DATABENTO_ENV and
the budget — and the job would then run ARMED with no bucket and no ledger,
which the archive layer treats as a soft failure and reports as success.

STEP 0 — READ THE RUNBOOK, THEN QUOTE BEFORE YOU BUY.
docs/reference/databento-harvest-runbook.md carries the entry order, the
per-entry cost quotes and the arming sequence. Disarmed, the job calls only the
FREE metadata endpoints (\`metadata.get_cost\`, \`metadata.get_dataset_range\`) and
never reaches \`batch.submit_job\`, so a dry execution is the cheapest possible
probe of the token, the symbology, the budget ledger, Prisma over the mounted
secret and the GCS archive:

  gcloud run jobs execute databento-harvest-${ENV} --region=${REGION} \\
    --project=${PROJECT_ID} --account=founder@disdigital.in \\
    --args=--entry=definition-baseline --wait

ONE ENTRY PER EXECUTION. \`--apply\` without \`--entry=\` is REFUSED by the job and
by \`run-market-data-job.sh dbharvest\`: a bare apply would walk all seven
manifest entries in one execution, including the TB-scale \`ohlcv-1s-baseline\`,
which cannot fit the 24h task timeout and would be killed part-way — surfacing
as a FAILED task rather than as "you asked for too much". The ids:

  jq -r '.entries[].id' scripts/data/databento-manifest.json

ARGV: gcloud's \`--args\` is a COMMA-separated list, so an argument CONTAINING a
comma silently becomes two. Change the delimiter with the \`^delim^\` escape:

  --args=--apply,--entry=ohlcv-1m-baseline          # fine, no commas
  --args=^:^--apply:--entry=ohlcv-1m-baseline       # the ^delim^ form

NOTE: no harvest flag takes a comma-bearing value today, so the escape above is
precautionary. \`--symbols\` in particular is NOT a flag — the earlier example
here used it and the job would have exited 1 on an unknown argument.

WATCH IT:
  gcloud run jobs executions list --job=databento-harvest-${ENV} \\
    --region=${REGION} --project=${PROJECT_ID} --account=founder@disdigital.in

  gcloud logging read \\
    'resource.type="cloud_run_job" AND resource.labels.job_name="databento-harvest-${ENV}"' \\
    --project=${PROJECT_ID} --account=founder@disdigital.in \\
    --freshness=1h --limit=30 --format='value(timestamp,textPayload)'

RE-RUN THIS SCRIPT AFTER EVERY WORKERS DEPLOY. A Cloud Run JOB keeps the image
it was provisioned with, and a deploy of stockbook-workers-${ENV} does NOT move
it. The release re-pins both jobs (they are in the \`for BASE in …\` loop in both
cloudbuild specs), so the steady state is covered per release — but a job
created between releases runs whatever was live when it was created until one of
those two things happens. Each entry point prints its commit as the FIRST line
of its own log (\`reportBuildProvenance\`); check it against ${IMAGE_SHA} above:

  gcloud logging read \\
    'resource.type="cloud_run_job" AND resource.labels.job_name="databento-append-${ENV}"' \\
    --project=${PROJECT_ID} --account=founder@disdigital.in \\
    --freshness=1h --limit=5 --format='value(textPayload)' | grep -i build

WHERE THE BYTES GO. The raw DBN lands under \`databento/\` in ${BUCKET} —
deliberately OUTSIDE \`feeds/\`, because \`sync-prod-to-qa-feeds\` rsyncs that whole
prefix prod -> QA twice daily and this archive is TB-scale. That is why no
FEED_ARCHIVE_MODE is set on either job: they do not route through the
feed-archive seam at all.

QA NEVER SPENDS. Both flags ship "false" in BOTH envs and the SAME account key
is mounted in each, because there is one bill. Disarmed, QA quotes and reports
against the free metadata endpoints; it cannot reach a paid one.
────────────────────────────────────────────────────────────────
EOF
