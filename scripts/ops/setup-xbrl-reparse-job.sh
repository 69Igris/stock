#!/bin/bash
# ============================================
# UseMoney - XBRL re-parse from the archive (Cloud Run Job) — MONEY-1252
# ============================================
# Deploys ONE Cloud Run JOB off the EXISTING stockbook-workers image:
#
#   xbrl-reparse-{env}   scripts/jobs/xbrl-reparse.ts -> dist/xbrl-reparse.js
#       Re-parses every stored `xbrl_filings` row from the XML ALREADY IN GCS
#       and rewrites both rows each document produces (the primary period via
#       `storeFiling`, and the ANNUAL companion via `storeAnnualCompanion`).
#
# ## Why this job has to exist
#
# `xbrl-financials-logic.ts` gained `bankBalanceOther` and `currentInvestments`
# in MONEY-1250, and `totalCash` became the sum of those two plus cash. The
# concepts did not exist when the ~96,000 stored filings were parsed, so their
# `facts.values` do not carry them and `totalCash` still publishes about a
# quarter of a company's cash — the F3 gate reads `totalCash` 81.5%
# disagreement. Both lines were ALWAYS in the filings; only our concept table
# was missing them. Re-parsing the same bytes with the current parser is the
# whole fix, and there is nothing upstream to ask for.
#
# Measured on prod 2026-08-25: 96,056 rows (75,238 QUARTERLY, 20,338 ANNUAL,
# 480 HALF_YEARLY), `periodEnd` 2017-06-30 to 2026-06-30.
#
# ## Why it is SAFE to provision now — it makes NO exchange requests
#
# The job reads every document with `FeedArchiveStore.get`, a bare GCS object
# read. It deliberately does NOT use `getFeedAsset` or `fetchXml`, both of which
# re-fetch from NSE on an archive miss. Archive coverage is 94,012 / 96,056
# (97.9%; 100% for period-years 2017-2025, 70% for 2026), so a fallback would
# mean ~2,000 requests at the one host this feature depends on. A miss is
# COUNTED and SKIPPED.
#
# ## What it DOES write, and the one-way door it does NOT open
#
# It writes `xbrl_filings` only — the same table, the same rows, the same
# `storeFiling` upsert the nightly ingest uses. It contains zero
# `stockFinancials` references. The one-way door (StockFinancials has no
# `source` in its unique key, so the first XBRL write to a period destroys the
# incumbent with nothing left to reconcile against) is opened by
# `xbrl-projection-drain`, not by this job.
#
# What it does do is CLEAR `projectedAt` on the rows whose facts actually moved
# — `storeFiling` does that for itself via `projectionInputChanged` — which is
# what makes the nightly projection pick them up again. Without that clear the
# corrected numbers would sit in `xbrl_filings` and never reach a reader.
#
# ## Why a JOB and not the Pub/Sub push worker
#
# The push worker is bound by Pub/Sub's un-raisable 600 s ack deadline. 96,056
# documents at one GCS read plus one parse plus two upserts apiece is hours, not
# minutes. A handler that runs past the deadline is REDELIVERED, so a second
# copy of the same run starts concurrently — see the "Job throughput" table in
# CLAUDE.md. There is no ack deadline on a Cloud Run job; the binding
# constraints here are the task timeout and the job's own `--budget-sec`, and
# both are explicit.
#
# Same image as the workers service — workers/tsup.config.ts emits
# dist/xbrl-reparse.js — so there is no separate build and no second artifact
# to keep in step.
#
# ## Why this is its OWN script
#
# `gcloud run jobs deploy --set-env-vars` REPLACES the job's env list; it does
# not merge into it. Two scripts that both deploy `xbrl-reparse-{env}` means
# "whichever ran last wins", silently — the failure that made
# `setup-xbrl-backfill-job.sh` its own file. One job, one owner.
#
# ## IMAGE: pinned from the LIVE service, and printed
#
# >>> Cloud Run JOBS pin their image at provision time. A deploy of the SERVICE
# >>> does not move them. Nothing re-points a job until somebody re-runs this
# >>> script, and nobody re-runs a setup script on a Tuesday.
#
# On 2026-08-18 `feed-parse-prod` was still on `prod-fbdc29e2` (built 14-Aug)
# while the service had moved to `prod-d7eefba7` (18-Aug). It ran nightly,
# exited 0, and skipped four bond feed families it had never heard of.
#
# For THIS job the drift is worse than usual, because the whole point of the job
# is the parser version it runs. A `xbrl-reparse-prod` pinned to a pre-
# MONEY-1250 image would re-parse all 96,056 rows with the OLD concept table,
# produce identical facts, clear no `projectedAt`, report `selected 96056,
# stored 96056, changed 0` — and look like a clean, complete run. Read the
# `[build-provenance]` line, every time.
#
#   >>> PREFLIGHT <<<  The resolved image MUST be built from a commit that has
#   the `xbrl-reparse` entry in workers/tsup.config.ts. On an older image the
#   container starts and dies instantly with
#   "Cannot find module /app/dist/xbrl-reparse.js". Merge + let the release
#   trigger rebuild BEFORE provisioning.
#
# ## DD_VERSION is deliberately NOT set here — do not "fix" that
#
# `workers/Dockerfile` declares `ARG DD_VERSION=unknown` and the cloudbuild
# specs pass `--build-arg DD_VERSION=$COMMIT_SHA` — the SAME substitution that
# forms the image tag. So `process.env.DD_VERSION` in the container is a
# property of the IMAGE LAYER and `reportBuildProvenance()` reads it with no
# help from the job spec. Passing it here would turn that SHA into a property of
# the JOB SPEC, which is exactly the forge the guard depends on being
# impossible: a job pinned to a stale image could then report a fresh SHA.
#
# Prerequisites:
#   - gcloud authenticated; Cloud Run API on
#   - stockbook-workers-{env} service already deployed (that is the image source)
#
# Usage (env is positional and REQUIRED, as in setup-infra.sh):
#   ./scripts/ops/setup-xbrl-reparse-job.sh prod
#   ./scripts/ops/setup-xbrl-reparse-job.sh qa
#   ./scripts/ops/setup-xbrl-reparse-job.sh prod --dry-run           # print, change nothing
#   ./scripts/ops/setup-xbrl-reparse-job.sh prod --image=IMG         # pin an explicit image
#   ./scripts/ops/setup-xbrl-reparse-job.sh prod --task-timeout=3600 # shorter tasks
# ============================================

set -euo pipefail

RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; BLUE='\033[0;34m'; NC='\033[0m'

PROJECT_ID="stock-book-483718"
REGION="asia-south1"
# Same SA the workers service runs as: already has Mongo egress + GCS read on
# the bucket, so the job needs no new IAM surface of its own.
JOB_SA="stockbook-api@${PROJECT_ID}.iam.gserviceaccount.com"

# Env is POSITIONAL and REQUIRED, matching setup-infra.sh / setup-scheduler.sh /
# setup-xbrl-backfill-job.sh. There is deliberately no default: this job
# rewrites every row of a real table, and every sibling ops script makes you
# name the environment out loud.
ENV=${1:-""}
shift || true

IMAGE=""
DRY_RUN=false
# 24h is the Cloud Run Jobs maximum. The job's OWN default budget is 20h
# (`--budget-sec`), deliberately inside it: a run that ends on its own budget
# prints its resume cursor and exits 1, while a run killed by the platform
# timeout prints nothing and the next operator has to reconstruct where it got
# to. Override with --task-timeout= if you want short leashed runs; pair it with
# a smaller --budget-sec on the execution so the job still lands its summary.
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
# This job only ever READS the archive, and a `FeedArchiveStore.get` behaves
# identically under both modes; what the mode actually decides is whether
# `initFeedArchive()` registers a store AT ALL (it no-ops when the mode is off).
# So the values are set to match the rest of the env rather than because this
# job needs one over the other — and the job REFUSES TO RUN with no store,
# because with none every row would report `archive-missing` and the run would
# print a confident, complete-looking "94,012 rows have no archived XML".
#
# QA reads QA's OWN bucket, which is fed by the `sync-prod-to-qa-feeds` mirror.
# A QA re-parse is therefore only meaningful for the objects that have been
# mirrored; a miss there is a mirror gap, not a data gap, and — unlike the
# ingest — it costs nothing, because this job never falls back to NSE.
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
        echo "Usage: ./scripts/ops/setup-xbrl-reparse-job.sh [qa|prod] [options]"
        echo ""
        echo "Options:"
        echo "  --image=IMG            Pin an explicit image instead of resolving it"
        echo "                         from the live stockbook-workers-{env} service"
        echo "  --task-timeout=SECS    Cloud Run task timeout (default 86400 = 24h max)"
        echo "  --dry-run              Print the gcloud calls, change nothing"
        echo ""
        echo "Deploys the Cloud Run job xbrl-reparse-{env} (MONEY-1252)."
        echo "No Scheduler trigger, ever — see the header."
        exit 1
        ;;
esac

# Cloud Run names are per-env; the deployed services are stockbook-workers-prod
# / -qa, NOT a bare stockbook-workers.
SERVICE_NAME="stockbook-workers-${ENV}"
JOB_NAME="xbrl-reparse-${ENV}"
ENTRYPOINT="dist/xbrl-reparse.js"

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
# it is — and for THIS job that means it is re-parsing with the wrong parser.
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
echo -e "   (the 'xbrl-reparse' entry in workers/tsup.config.ts) AND the"
echo -e "   MONEY-1250 concepts. On an older image the container dies with"
echo -e "   \"Cannot find module /app/${ENTRYPOINT}\"; on a pre-MONEY-1250 one it"
echo -e "   runs happily and changes NOTHING.${NC}"

# ── 2. Deploy the job ─────────────────────────────────────────────────────
echo -e "${BLUE}━━━ 2/3: Cloud Run Job — ${JOB_NAME} ━━━${NC}"

# 2Gi, not the backfill's 1Gi. This job holds a keyset page of rows plus one
# archived document plus the parsed `XbrlFinancials` for both the primary and
# the annual context, and `storeFiling` reads the incumbent row's whole `facts`
# JSON to decide the projection clear. That is the projection drain's footprint,
# not the backfill's one-document-at-a-time one.
deploy_args=(
    run jobs deploy "$JOB_NAME"
    --image="$IMAGE"
    --region="$REGION"
    --service-account="$JOB_SA"
    # The script path belongs in --command, NOT --args. `gcloud run jobs execute
    # --args=...` REPLACES the container's args rather than appending to them,
    # so with `--command=node --args=dist/xbrl-reparse.js` every parameterised
    # execution becomes `node --from=2024` and dies with "bad option".
    # `--args=""` clears the list (there is no --clear-args on jobs deploy).
    # Without it a re-deploy KEEPS the old args and the container runs
    # `node dist/xbrl-reparse.js dist/xbrl-reparse.js`.
    --command="node,$ENTRYPOINT"
    --args=""
    # A retry re-walks from the SAME cursor the failed task started at, which
    # for this job is idempotent and cheap in rows — but a task that died
    # because GCS or Mongo was refusing would be restarted straight back into
    # the service that just refused it. Re-running is a human decision, and the
    # job prints the resume cursor precisely so that decision is one command.
    --max-retries=0
    --task-timeout="$TASK_TIMEOUT"
    --memory=2Gi
    --cpu=1
    # Set EXPLICITLY, because a job spec does NOT inherit the service's env
    # block. Unset, `initFeedArchive()` registers NO store — and this job
    # refuses to run without one rather than reporting every row as
    # un-archived.
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
echo -e "   ${YELLOW}None, deliberately. This is a ONE-SHOT repair for filings"
echo -e "   parsed before MONEY-1250, not a recurring pass. Every filing"
echo -e "   ingested from now on is parsed by the current table on arrival."
echo -e "   Scheduled, it would re-read 96,000 GCS objects every night to"
echo -e "   write identical facts — and once complete it would change nothing,"
echo -e "   forever, which is indistinguishable from a broken selector.${NC}"

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
  mode   FEED_ARCHIVE_MODE=${ARCHIVE_MODE}   bucket ${BUCKET}
  retry  --max-retries=0   task-timeout ${TASK_TIMEOUT}s

VERIFY THE PIN, do not assume it. The job prints its own build as its
first line; that SHA must equal ${IMAGE_SHA} above. This is the ONE
check that can actually go red — Cloud Run JOBS pin their image at
provision time and a deploy of the SERVICE does not move them. For this
job a stale pin does not crash: it re-parses everything with the OLD
concept table and reports a clean run that changed nothing.

  gcloud run jobs execute ${JOB_NAME} --region=${REGION} --args="--limit=200"
  gcloud logging read \\
    'resource.type=cloud_run_job AND resource.labels.job_name="${JOB_NAME}" AND textPayload:"build-provenance"' \\
    --limit=5 --project=${PROJECT_ID}

The explicit timestamp term matters when you poll: --freshness does NOT
bound the query, so a wait-loop matches a PRE-EXISTING provenance line
instantly and reports the old revision as the new one. Add
timestamp>="<the ISO instant you started>".

────────────────────────────────────────────────────────────────
DRY RUN FIRST — it is the only rehearsal that answers the real question

Without --apply the job runs the REAL write path against a no-op upsert.
So the dry run reports how many rows would be written AND how many would
actually CHANGE (\`projectionReset\` — the rows whose facts moved), which
is the number that says whether the re-parse is worth its runtime.

  gcloud run jobs execute ${JOB_NAME} --region=${REGION} --args="--limit=500"

Expect \`changed\` to be a large fraction of \`selected\`. If it is ZERO,
STOP: either the image predates MONEY-1250 (check [build-provenance]) or
the rows were already re-parsed.

────────────────────────────────────────────────────────────────
THEN SHARD IT, OLDEST PERIOD FIRST

  gcloud run jobs execute ${JOB_NAME} --region=${REGION} --args="--apply,--from=2017,--to=2019"
  gcloud run jobs execute ${JOB_NAME} --region=${REGION} --args="--apply,--from=2020,--to=2022"
  gcloud run jobs execute ${JOB_NAME} --region=${REGION} --args="--apply,--from=2023,--to=2024"
  gcloud run jobs execute ${JOB_NAME} --region=${REGION} --args="--apply,--from=2025,--to=2026"

NOTE gcloud splits --args on COMMAS, so each comma starts a NEW argument
(that is why the examples read as one flag per comma).

--from/--to are PERIOD YEARS here, not broadcast months — the opposite of
xbrl-backfill.ts, whose --from=2024-05 means May 2024. Passing a
YYYY-MM to this job is a hard argument error rather than a silent
reinterpretation.

Sharding is optional: with no --from/--to the scope is EVERY stored
filing, which is the safe default because a hard-coded floor would
silently exclude rows and still report DRAINED. Shards exist so a run
fits comfortably inside one task and so the operator can watch the first
one before committing the rest.

ONE AT A TIME. Two concurrent shards write the same table through the
same upsert key only if their period windows overlap — they do not — but
they do double the Mongo write rate against a cluster the nightly chain
is also using.

Every shard is resumable: a run that stops on its budget or on --limit
prints \`--after-id=<ObjectId>\`, and re-running with that flag continues
exactly where it stopped. Re-running a completed range is harmless — the
re-parse produces identical facts, \`projectionInputChanged\` is false,
and \`projectedAt\` is left alone.

A NON-ZERO EXIT means the run stopped for a reason NOBODY ASKED FOR: the
wall-clock budget, a no-advance cursor defect, a storage read error, or
documents it could not store. Two conditions are deliberately NOT in that
set, for the same reason — a status that is red on a normal path is a
status nobody reads, and it takes the real failures down with it:

  * an archive MISS. ~2.1% of rows have no archived object, this job
    never fetches, and no re-run can close it. It warns and names the
    remedy instead. (Every row of a non-empty scope missing IS red —
    that is a broken bucket, not a data gap.)
  * a stop on --limit. You asked for exactly N rows and got exactly N
    rows; the run honoured its argument. It exits 0 and its summary
    says PARTIAL, names the row count, states that the scope is NOT
    drained, and prints the resume cursor. Before MONEY-1250 every
    bounded rehearsal above exited 1 — 7 of one day's 9 executions read
    as FAILED while all of them were healthy.

There is no separate "partial" exit code, because Cloud Run Jobs has
nowhere to put one: a task succeeds on 0 and fails on everything else,
so an exit 2 would be the same red task and the same failedCount tick as
an exit 1. Completeness is answered by the summary line and by \`stop=\`
in the job-outcome, not by the exit code.

────────────────────────────────────────────────────────────────
AFTER THE RE-PARSE — the corrected numbers are not visible yet

\`storeFiling\` cleared \`projectedAt\` on every row whose facts moved, so
the nightly \`xbrl-projection\` will re-project them. To move them sooner:

  gcloud run jobs execute xbrl-projection-drain-${ENV} --region=${REGION} \\
    --args="--apply,--period-types=ANNUAL"

and then re-read the F3 gate — \`totalCash\` is the column this whole
exercise exists to fix (81.5% disagreement before it):

  ./scripts/ops/run-market-data-job.sh xbrlrecon ${ENV}
────────────────────────────────────────────────────────────────
EOF
