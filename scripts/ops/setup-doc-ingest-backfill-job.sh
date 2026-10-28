#!/bin/bash
# ============================================
# UseMoney - doc-ingest backfill (Cloud Run Job) — MONEY-1314
# ============================================
# Deploys ONE Cloud Run JOB off the EXISTING stockbook-workers image:
#
#   doc-ingest-backfill-{env}
#       scripts/jobs/doc-ingest-backfill.ts -> dist/doc-ingest-backfill.js
#       Five subcommands, chosen at EXECUTION time:
#         scan-convert  GCS PDF -> pdf-inspector -> ${gcsPath}.md + stamps
#         batch-build   converted markdown -> page-selected -> JSONL
#         batch-submit  JSONL -> Files API -> batchGenerateContent
#         batch-ingest  a finished batch -> map + grade -> upsert / --compare
#         sweep         the terminal-failure residue, via the ONLINE path
#
# ## Why this job has to exist at all
#
# Measured on prod 2026-09-01 (docs/reference/doc-ingest-population.md):
#
#   eligible for the financials parse                48,322
#   PDF rows in the archive                          79,884
#     with a usable gcsPath                          72,650
#     gcsPath EMPTY (BSE stopped serving them)        7,234
#   total bytes                                      309.8 GB
#   largest single object                            222.3 MB
#
# `scan-convert` reads that 309.8 GB. The nightly `stock-document-parse` push
# worker cannot: it is bounded by Pub/Sub's un-raisable 600 s ack deadline, and
# a handler that runs past it gets its message REDELIVERED so a second copy
# starts concurrently. `PARSE_SCAN_CAP = 40_000` is ALREADY BREACHED by the
# 48,322 eligible rows, so the nightly's breadth-first pick silently narrows to
# the oldest 40,000 today, before this branch changes anything.
#
# A Cloud Run JOB has no subscription, no message and no ack. `--task-timeout`
# below is 86400 (the 24 h maximum), matching the sibling backfills. Do not
# re-impose a 600 s budget out of habit; the binding constraints here are
# MEMORY and the run's OWN wall-clock budget (`--budget-sec`, default 6 h,
# checked BETWEEN documents), and both are explicit.
#
# ## MEMORY IS 2Gi AND 1Gi IS THE FLOOR — this is measured, not padded
#
# Peak RSS during conversion ran **2.3x to 4.8x file size** across 26 real
# filings / 1,816 pages, worst observed **618 MB for a 129.81 MB PDF**
# (docs/reference/doc-convert-decision.md §3). Node's own floor is ~68 MB.
# **109 archive objects exceed 40 MB** and the largest is 222.3 MB, which
# projects to ~1.13 GB.
#
# A 512 MiB instance dies on anything over ~100 MB — as an OOM kill, i.e. the
# task simply disappears mid-page with no summary line, which is the one
# failure mode this job cannot report on itself. So this script REFUSES an
# override under 1Gi rather than accepting a number that will kill the task on
# the 109 objects that matter most.
#
# ## THE DEFAULT IS 4Gi, AND 2Gi WAS NOT ENOUGH — MONEY-1334
#
# The measurements above are all PER FILE, and that is exactly what they
# missed. Observed on prod 2026-09-02, execution `doc-ingest-backfill-prod-qj22v`:
#
#   "page done: selected 500, converted 500, sidecars 486, read 3.383 GB,
#    elapsed 10037s"
#   "Out-of-memory event detected in container" / "Container terminated on
#    signal 9"
#
# It died at 2Gi having completed a 500-document page — no single file in it
# projects anywhere near 2 GB, so the per-file model cannot explain the kill.
# The binding term is CUMULATIVE across a page (3.383 GB read), which the
# earlier analysis never considered because it reasoned one document at a time.
#
# 4Gi is a SURVIVAL measure, not a fix: it buys headroom while the retention is
# unexplained. The real question — why a page's peak scales with the page rather
# than with its largest document — is open, and the honest place to answer it is
# a heap profile, not another guess at a number. Raising memory is safe in the
# meantime; running out is not, because the OOM is silent.
#
# ## IMAGE: pinned from the LIVE service, and printed
#
# >>> Cloud Run JOBS pin their image at provision time. A deploy of the SERVICE
# >>> does not move them. Nothing re-points a job until somebody re-runs this
# >>> script, and nobody re-runs a setup script on a Tuesday.
#
# Measured on this repo, twice. MONEY-1189's fix shipped and then sat
# un-executed on the nightly jobs. MONEY-1205: `feed-parse-prod` ran nightly on
# a 14-Aug image for 10 days, exited 0, reported SUCCEEDED_COUNT 1, and skipped
# four bond feed families it had never heard of — `bond_master` and `bond_eod`
# sat at 0 rows. And on 2026-08-19 the drift was live again:
#
#   stockbook-workers-prod SERVICE  prod-6abc3278...
#   feed-parse-prod JOB             prod-ed432f72...   (behind)
#
# So this script resolves the image off the live service, FAILS CLOSED on an
# empty resolution, and PRINTS the tag and commit SHA. Write that SHA down: it
# is what the job's own first log line must echo back.
#
# ## TWO PREFLIGHTS THAT REFUSE, rather than warn
#
# The sibling scripts print a warning about their entrypoint. A warning is what
# you read AFTER the job has been provisioned and executed. Both of these are
# checkable from the repo the script is running out of, so both are hard gates:
#
#   1. `workers/tsup.config.ts` MUST carry a `doc-ingest-backfill` entry.
#      Without it `dist/doc-ingest-backfill.js` is not in the image and the
#      container starts and dies instantly with "Cannot find module". AT THE
#      TIME OF WRITING IT DOES NOT — the entry has to be added and the release
#      trigger has to rebuild before this script can provision anything.
#
#   2. `@firecrawl/pdf-inspector` MUST be a declared dependency of
#      `workers/package.json`. Without it `scan-convert` — the subcommand that
#      does 309.8 GB of the work — cannot convert a single document. The job
#      itself fails closed on this too (`loadConverter` throws and the run exits
#      2 rather than stamping the corpus SCANNED_ONLY from an absent
#      converter), but discovering it at provision time costs nothing and
#      discovering it at 3 a.m. costs a Cloud Run execution. AT THE TIME OF
#      WRITING IT IS NOT DECLARED; it was measured at 1.17.0, ~10 MB, prebuilt
#      napi binary on musl/x64 (docs/reference/doc-convert-decision.md §1).
#
# ## THERE IS DELIBERATELY NO `--apply` FLAG IN THIS SCRIPT
#
# `--apply` belongs to the JOB and is passed per EXECUTION:
#
#   gcloud run jobs execute doc-ingest-backfill-{env} --args="scan-convert,--apply"
#
# A wrapper that consumes `--apply` on the job's behalf is how `feed-repair`
# read 41,924 rows, wrote nothing and exited 0 — the flag was swallowed by the
# layer above and the job never saw it, so a fail-SAFE default produced a
# fail-SILENT run. Nothing between the operator's keystroke and
# `parseArgs` in scripts/jobs/doc-ingest-backfill.ts may touch that flag, and
# `packages/core/__tests__/ops/doc-ingest-backfill-job-setup.test.ts` asserts
# this script never grows an `--apply)` case.
#
# ## Env: a JOB spec does NOT inherit the SERVICE's env block
#
# Every variable the run needs is stated here explicitly:
#
#   DATABASE_URL           secret. The selectors and every stamp.
#   REDIS_URL              secret. Nothing in this job reads it TODAY; it is
#                          passed because any @usemoney/* module reaching for a
#                          cache degrades SILENTLY without it, and a silent
#                          degradation inside a 6-hour run is not observable.
#   GOOGLE_GENAI_API_KEY   secret. batch-submit / batch-ingest / sweep. The
#                          Developer-API batch path is the rung this branch took
#                          (PROBED 2026-09-01); there is no fallback.
#   GCP_STORAGE_BUCKET     plain. Every GCS read and every sidecar write.
#   GCP_SERVICE_ACCOUNT_KEY_BASE64  secret. `googleCredentials()` resolves this
#                          FIRST, and prod's runtime SA is not the one the
#                          buckets were granted to — granting the runtime SA
#                          instead has already been tried and did nothing.
#   DOC_PARSE_MODEL        plain. gemini-3.7-flash, registered in
#                          packages/core/src/gemini/model-registry.ts. An
#                          UNREGISTERED id here is IGNORED with a warning and
#                          the run silently falls back to the PREMIUM chat model
#                          — which for this backfill is a 4x price difference,
#                          not a rounding error.
#
# ## DD_VERSION is deliberately NOT set here — do not "fix" that
#
# `workers/Dockerfile` declares ARG DD_VERSION / ENV DD_VERSION and
# `workers/cloudbuild.{prod,qa}.yaml` build with
# `--build-arg DD_VERSION=$COMMIT_SHA` — the SAME substitution that forms the
# image tag. So `process.env.DD_VERSION` in the container is a property of the
# IMAGE LAYER and `reportBuildProvenance()` reads it with no help from the job
# spec. Setting it here would make it a property of the JOB SPEC, i.e. exactly
# the forge the guard depends on being impossible: a job pinned to a stale image
# could report a fresh SHA because someone re-ran setup.
#
# `EXPECTED_BUILD_SHA` is refused for the reason in
# packages/core/src/ops/build-provenance.ts: it would be read from the same
# image being pinned, so it would match by construction, forever, and detect
# nothing.
#
# ## No Cloud Scheduler trigger, ever
#
# This is a FOUNDER-INVOKED backfill, not a nightly. The nightly incremental is
# already `stock-document-parse` on Pub/Sub. Scheduling a whole-corpus drain
# would spend a metered batch quota unattended — and the moment the corpus is
# converted it would select nothing every night, which is indistinguishable
# from a broken selector at a glance.
#
# Prerequisites:
#   - gcloud authenticated; Cloud Run API on
#   - stockbook-workers-{env} service already deployed (that is the image source)
#   - `doc-ingest-backfill` in workers/tsup.config.ts, and the image rebuilt
#   - `@firecrawl/pdf-inspector` in workers/package.json, and the image rebuilt
#
# Usage (env is positional and REQUIRED, as in setup-infra.sh):
#   ./scripts/ops/setup-doc-ingest-backfill-job.sh qa
#   ./scripts/ops/setup-doc-ingest-backfill-job.sh prod
#   ./scripts/ops/setup-doc-ingest-backfill-job.sh prod --dry-run
#   ./scripts/ops/setup-doc-ingest-backfill-job.sh prod --image=IMG
#   ./scripts/ops/setup-doc-ingest-backfill-job.sh prod --memory=8Gi --tasks=4
#   ./scripts/ops/setup-doc-ingest-backfill-job.sh prod --task-timeout=43200
# ============================================

set -euo pipefail

RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; BLUE='\033[0;34m'; NC='\033[0m'

PROJECT_ID="stock-book-483718"
REGION="asia-south1"
ACCOUNT="founder@disdigital.in"
# Same SA the workers service runs as: already has Mongo egress and bucket
# access, so the job needs no new IAM surface of its own.
JOB_SA="stockbook-api@${PROJECT_ID}.iam.gserviceaccount.com"

# Resolve the repo root from THIS script's location, so the two preflights read
# the tree being deployed rather than whatever directory the operator is in.
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"
TSUP_CONFIG="${REPO_ROOT}/workers/tsup.config.ts"
WORKERS_PKG="${REPO_ROOT}/workers/package.json"

# Env is POSITIONAL and REQUIRED, matching setup-infra.sh / setup-scheduler.sh /
# setup-xbrl-projection-drain-job.sh. There is deliberately no default: this job
# writes to a real database and spends a metered model quota, and every sibling
# ops script makes you name the environment out loud.
ENV=${1:-""}
if [ $# -gt 0 ]; then shift; fi

IMAGE=""
DRY_RUN=false
# 24h is the Cloud Run Jobs maximum and matches the sibling backfills. The job's
# OWN wall-clock budget defaults to 6h (--budget-sec) and is checked BETWEEN
# documents, so the worst case is budget + one document. The task timeout must
# stay comfortably above that: a task killed by Cloud Run loses the final
# SUMMARY line, which is the only artifact that says whether to re-run.
TASK_TIMEOUT="86400"
# See the header. 8Gi is what FOUR concurrent slots need, measured, not a guess.
MEMORY="8Gi"
MEMORY_FLOOR_MI=1024
# PARALLEL TASKS — MONEY-1339. Each task takes a deterministic shard of the
# corpus (a `symbol` prefix set), so four tasks convert four disjoint quarters
# with no coordination and no shared cursor. Cloud Run sets CLOUD_RUN_TASK_INDEX
# / CLOUD_RUN_TASK_COUNT on every task and the job reads them itself, which is
# what makes this expressible at all: `gcloud run jobs execute` passes ONE
# argument list to every task, so a per-task --shard flag could not be given.
TASKS="4"
# Documents in flight INSIDE one task. The per-document cost is dominated by a
# GCS download, a sidecar upload and two Mongo writes — waits, not CPU — so
# overlapping them is the actual speed-up. Measured serial rate: 1.6 s/document.
CONCURRENCY="4"
# gemini-3.7-flash is the backfill model — registered, and verified live on
# 2026-09-01 (52 models listed, generateContent 200 with a responseSchema,
# batchGenerateContent ACCEPTED).
DOC_PARSE_MODEL="gemini-3.7-flash"

while [ $# -gt 0 ]; do
    case "$1" in
        --image=*)        IMAGE="${1#*=}"; shift ;;
        --task-timeout=*) TASK_TIMEOUT="${1#*=}"; shift ;;
        --memory=*)       MEMORY="${1#*=}"; shift ;;
        --tasks=*)        TASKS="${1#*=}"; shift ;;
        --concurrency=*)  CONCURRENCY="${1#*=}"; shift ;;
        --model=*)        DOC_PARSE_MODEL="${1#*=}"; shift ;;
        # NOTE: validated below, after parsing — an unregistered id is not a
        # typo the job survives. `resolveDocParseModel` IGNORES an id the
        # registry does not know, warns once, and runs the PREMIUM chat model
        # instead: four times the batch rate across ~48,000 documents, with a
        # log line as the only symptom. This file hard-gates two other
        # preflights for smaller reasons.
        --dry-run)        DRY_RUN=true; shift ;;
        -h|--help)        grep '^#' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
        # NO --apply CASE, EVER. See the header: `--apply` is an EXECUTION
        # argument that belongs to the job, and a wrapper that eats it is how a
        # job reads 41,924 rows, writes nothing and exits 0.
        *) echo "Unknown argument: $1" >&2; exit 1 ;;
    esac
done

case "$ENV" in
    prod)
        BUCKET="stockbook-content-prod"
        DB_SECRET="DATABASE_URL_PROD"
        DD_SECRET="DD_API_KEY_PROD"
        REDIS_SECRET="REDIS_URL_PROD"
        GENAI_SECRET="GOOGLE_GENAI_API_KEY_PROD"
        ;;
    qa)
        BUCKET="stockbook-content-qa"
        DB_SECRET="DATABASE_URL_QA"
        DD_SECRET="DD_API_KEY_QA"
        REDIS_SECRET="REDIS_URL_QA"
        GENAI_SECRET="GOOGLE_GENAI_API_KEY_QA"
        ;;
    *)
        echo "Usage: ./scripts/ops/setup-doc-ingest-backfill-job.sh [qa|prod] [options]"
        echo ""
        echo "Options:"
        echo "  --image=IMG            Pin an explicit image instead of resolving it"
        echo "                         from the live stockbook-workers-{env} service"
        echo "  --memory=SIZE          Task memory (default 8Gi). Refused below 1Gi:"
        echo "                         peak RSS is 2.3-4.8x file size, measured, and"
        echo "                         109 archive objects exceed 40 MB."
        echo "  --tasks=N              Parallel Cloud Run tasks (default 4). Each takes"
        echo "                         a disjoint symbol-prefix shard. Max 36 — past the"
        echo "                         shard alphabet a task selects nothing and reports"
        echo "                         a drained queue."
        echo "  --concurrency=N        Documents in flight per task (default 4). Divides"
        echo "                         the per-slot OOM ceiling, so raising it without"
        echo "                         raising --memory shrinks the largest readable PDF."
        echo "  --model=ID             DOC_PARSE_MODEL (default gemini-3.7-flash)"
        echo "  --task-timeout=SECS    Cloud Run task timeout (default 86400 = 24h max)"
        echo "  --dry-run              Print the gcloud calls, change nothing"
        echo ""
        echo "Deploys the Cloud Run job doc-ingest-backfill-{env} (MONEY-1314)."
        echo "No Scheduler trigger, ever — see the header."
        echo "There is no --apply here: it is an EXECUTION argument."
        exit 1
        ;;
esac

# Cloud Run names are per-env; the deployed services are stockbook-workers-prod
# / -qa, NOT a bare stockbook-workers.
SERVICE_NAME="stockbook-workers-${ENV}"
JOB_NAME="doc-ingest-backfill-${ENV}"
ENTRYPOINT="dist/doc-ingest-backfill.js"
CONVERTER_PKG="@firecrawl/pdf-inspector"

# Per the repo's GCP isolation rule: never activate a config, always pass the
# account/project explicitly on each call.
GC=(env CLOUDSDK_ACTIVE_CONFIG_NAME=stockbook gcloud --project="$PROJECT_ID" --account="$ACCOUNT")

# ── 0. Preflight — refuse, do not warn ────────────────────────────────────
echo -e "${BLUE}━━━ 1/4: Preflight ━━━${NC}"

# --memory must be a Cloud Run size AND at or above the measured floor. An
# invalid string would be rejected by gcloud with a generic message; a VALID
# string below the floor would deploy cleanly and then OOM-kill the task on the
# 109 objects over 40 MB, with no summary line to say why.
if ! [[ "$MEMORY" =~ ^([0-9]+)(Mi|Gi)$ ]]; then
    echo -e "${RED}--memory=${MEMORY} is not a Cloud Run size (e.g. 1Gi, 2Gi, 3072Mi).${NC}" >&2
    exit 1
fi
MEM_NUM="${BASH_REMATCH[1]}"
MEM_UNIT="${BASH_REMATCH[2]}"
if [ "$MEM_UNIT" = "Gi" ]; then MEM_MI=$((MEM_NUM * 1024)); else MEM_MI="$MEM_NUM"; fi
if [ "$MEM_MI" -lt "$MEMORY_FLOOR_MI" ]; then
    echo -e "${RED}--memory=${MEMORY} is below the measured ${MEMORY_FLOOR_MI}Mi floor.${NC}" >&2
    echo "Peak RSS during conversion is 2.3-4.8x file size (worst observed:" >&2
    echo "618 MB for a 129.81 MB PDF). 109 archive objects exceed 40 MB and the" >&2
    echo "largest is 222.3 MB. A smaller task is OOM-killed mid-page and loses" >&2
    echo "the SUMMARY line that would have said so." >&2
    exit 1
fi
echo -e "   memory  : ${GREEN}${MEMORY}${NC} (floor ${MEMORY_FLOOR_MI}Mi, measured)"

# --tasks must be a positive integer within the SHARD ALPHABET, which is 36
# characters (0-9A-Z). Past that, a task receives an empty prefix set, selects
# NOTHING, and reports `selected=0 remaining=0` — indistinguishable from a
# drained queue on the one job whose failure mode is looking finished while work
# remains. `buildShardWhere` throws on the same condition; this refuses earlier,
# before a container is ever started.
if ! [[ "$TASKS" =~ ^[0-9]+$ ]] || [ "$TASKS" -lt 1 ] || [ "$TASKS" -gt 36 ]; then
    echo -e "${RED}--tasks=${TASKS} must be an integer in 1..36 (the shard alphabet).${NC}" >&2
    exit 1
fi
if ! [[ "$CONCURRENCY" =~ ^[0-9]+$ ]] || [ "$CONCURRENCY" -lt 1 ] || [ "$CONCURRENCY" -gt 8 ]; then
    echo -e "${RED}--concurrency=${CONCURRENCY} must be an integer in 1..8.${NC}" >&2
    echo "Each slot may hold a document peaking at 2.3-4.8x its file size." >&2
    exit 1
fi
echo -e "   tasks   : ${GREEN}${TASKS}${NC} parallel, disjoint symbol shards"
echo -e "   perTask : ${GREEN}${CONCURRENCY}${NC} documents in flight"

# ── MODEL VALIDATION ────────────────────────────────────────────────────────
#
# The id must be REGISTERED in packages/core/src/gemini/model-registry.ts.
# `resolveDocParseModel` silently ignores one that is not and falls back to the
# PREMIUM chat model — gemini-3.5-flash at $1.50/$9.00 against 3.7-flash's
# $0.75/$3.75, i.e. 4x the batch cost across the whole corpus, announced only
# by a warning nobody reads in a Cloud Run job log.
#
# Grepped rather than imported: this is a shell script and the registry is the
# single source of truth for what is callable.
# ── CONTAINER MEMORY, IN MiB ────────────────────────────────────────────────
#
# The converter sizes its OOM refusal ceiling from DOC_CONVERT_CONTAINER_MI and
# defaults to 1024 when it is absent. This job runs at 2Gi, so leaving it unset
# makes the converter budget for HALF the memory it has — and it declines
# documents by estimated peak RSS (2.3-4.8x file size). The result is the
# opposite of the intent: the large documents the 1 GiB SERVICE defers to this
# job would be declined here too, and nothing would ever read them.
#
# Derived from $MEMORY rather than hardcoded, so `--memory=` cannot move one
# without the other. Verified against the provisioned job by
# `doc-ingest-backfill-job-setup.test.ts`.
case "$MEMORY" in
  *Gi) CONTAINER_MI=$(( ${MEMORY%Gi} * 1024 )) ;;
  *Mi) CONTAINER_MI=${MEMORY%Mi} ;;
  *)   echo "FATAL: cannot read a MiB value out of --memory=${MEMORY}" >&2; exit 1 ;;
esac

# ── PER-SLOT MEMORY — MONEY-1339 ────────────────────────────────────────────
#
# The converter declines a document whose ESTIMATED peak RSS (2.3-4.8x file
# size) would not fit in DOC_CONVERT_CONTAINER_MI. With `--concurrency` slots
# running at once, the ceiling each slot may assume is the container divided by
# the number of slots — otherwise four documents each sized against the WHOLE
# container run together and the task is OOM-killed, which is precisely the
# 2026-09-02 failure this change exists to end.
#
# Derived here rather than hardcoded so `--memory` and `--concurrency` cannot
# move independently of it. At the shipped 8Gi/4 that is 2,048 MiB per slot,
# which still admits every object in the archive: 2048 / 4.8 = 426 MB against a
# 222.3 MB maximum.
SLOT_MI=$(( CONTAINER_MI / CONCURRENCY ))
# The job reads DOC_CONVERT_CONCURRENCY as its own default, so the number that
# SIZED the per-slot ceiling is the number of slots that actually run. Passing
# only DOC_CONVERT_CONTAINER_MI would let a job provisioned for 2 slots run 4,
# each assuming half the memory it really has to share.
if [ "$SLOT_MI" -lt 512 ]; then
    echo -e "${RED}--memory=${MEMORY} over ${CONCURRENCY} slots leaves ${SLOT_MI}MiB each.${NC}" >&2
    echo "Below 512MiB a slot cannot hold even a 100MB PDF at the measured 4.8x." >&2
    exit 1
fi
echo -e "   slot    : ${GREEN}${SLOT_MI}Mi${NC} per concurrent document (${CONTAINER_MI}Mi / ${CONCURRENCY})"

REGISTRY="${REPO_ROOT}/packages/core/src/gemini/model-registry.ts"
if [ ! -f "$REGISTRY" ]; then
  echo "FATAL: cannot find $REGISTRY to validate --model" >&2
  exit 1
fi
if ! grep -qE "^\\s*id: \"${DOC_PARSE_MODEL}\"," "$REGISTRY"; then
  echo "FATAL: DOC_PARSE_MODEL='${DOC_PARSE_MODEL}' is not registered in" >&2
  echo "       packages/core/src/gemini/model-registry.ts." >&2
  echo "" >&2
  echo "  resolveDocParseModel IGNORES an unregistered id and runs the PREMIUM" >&2
  echo "  chat model instead — 4x the batch rate across ~48,000 documents, with" >&2
  echo "  a single warning line as the only symptom. Refusing rather than" >&2
  echo "  provisioning a job that will quietly overspend." >&2
  echo "" >&2
  echo "  Registered ids:" >&2
  grep -oE "^\\s*id: \"[^\"]+\"" "$REGISTRY" | sed 's/.*"\(.*\)"/    \1/' >&2
  exit 1
fi

# PREFLIGHT 1 — the entrypoint must be BUILT into the image.
if [ ! -f "$TSUP_CONFIG" ]; then
    echo -e "${RED}Cannot read ${TSUP_CONFIG}.${NC}" >&2
    exit 1
fi
if ! grep -q '"doc-ingest-backfill"' "$TSUP_CONFIG"; then
    echo -e "${RED}workers/tsup.config.ts has no doc-ingest-backfill entry.${NC}" >&2
    echo "" >&2
    echo "Without it the image contains no ${ENTRYPOINT} and the container" >&2
    echo "starts and dies instantly with:" >&2
    echo "  Cannot find module /app/${ENTRYPOINT}" >&2
    echo "" >&2
    echo "Add to the \`entry\` map in workers/tsup.config.ts:" >&2
    echo '  "doc-ingest-backfill": "../scripts/jobs/doc-ingest-backfill.ts",' >&2
    echo "then let the release trigger rebuild BEFORE re-running this script." >&2
    exit 1
fi
echo -e "   entry   : ${GREEN}${ENTRYPOINT}${NC} (present in workers/tsup.config.ts)"

# PREFLIGHT 2 — the converter must be a declared dependency.
if [ ! -f "$WORKERS_PKG" ]; then
    echo -e "${RED}Cannot read ${WORKERS_PKG}.${NC}" >&2
    exit 1
fi
if ! grep -q "$CONVERTER_PKG" "$WORKERS_PKG"; then
    echo -e "${RED}${CONVERTER_PKG} is not a dependency of workers/package.json.${NC}" >&2
    echo "" >&2
    echo "scan-convert cannot convert a single document without it, and that" >&2
    echo "subcommand is 309.8 GB of this job's work. Measured at 1.17.0:" >&2
    echo "~10 MB, prebuilt napi binary on musl/x64, no postinstall, no Rust" >&2
    echo "toolchain (docs/reference/doc-convert-decision.md §1)." >&2
    echo "" >&2
    echo "Add it to workers/package.json, yarn install, and rebuild the image." >&2
    exit 1
fi
echo -e "   convert : ${GREEN}${CONVERTER_PKG}${NC} (declared in workers/package.json)"

# ── 1. Resolve the image from the live service ────────────────────────────
echo -e "${BLUE}━━━ 2/4: Resolve image from ${SERVICE_NAME} ━━━${NC}"
IMAGE_SOURCE="explicit --image"
if [ -z "$IMAGE" ]; then
    IMAGE_SOURCE="live ${SERVICE_NAME} service"
    IMAGE="$("${GC[@]}" run services describe "$SERVICE_NAME" \
        --region="$REGION" \
        --format='value(spec.template.spec.containers[0].image)' 2>/dev/null || true)"
fi

# FAILS CLOSED. An empty IMAGE must never reach `gcloud run jobs create/update`
# — it would either error out mid-deploy or, worse, be read as "keep whatever is
# there", which on a re-provision silently preserves the stale pin this script
# exists to move.
if [ -z "$IMAGE" ]; then
    echo -e "${RED}Could not resolve the ${SERVICE_NAME} image.${NC}" >&2
    echo "Is the workers service deployed to ${ENV}? Otherwise pass --image=..." >&2
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

# ── 2. Deploy the job — describe, then update; otherwise create ───────────
echo -e "${BLUE}━━━ 3/4: Cloud Run Job — ${JOB_NAME} ━━━${NC}"

# IDEMPOTENT, and stated rather than implied. `gcloud run jobs deploy` would do
# create-or-update in one call and hide which it did; knowing whether this run
# CREATED the job or MOVED an existing pin is exactly the information an
# operator needs when a job has been running on a stale image.
if "${GC[@]}" run jobs describe "$JOB_NAME" --region="$REGION" >/dev/null 2>&1; then
    ACTION="update"
    echo -e "   ${YELLOW}${JOB_NAME} exists — UPDATING (this re-pins the image)${NC}"
else
    ACTION="create"
    echo -e "   ${GREEN}${JOB_NAME} does not exist — CREATING${NC}"
fi

deploy_args=(
    run jobs "$ACTION" "$JOB_NAME"
    --image="$IMAGE"
    --region="$REGION"
    --service-account="$JOB_SA"
    # The script path belongs in --command, NOT --args. `gcloud run jobs execute
    # --args=...` REPLACES the container's args rather than appending to them,
    # so with `--command=node --args=dist/doc-ingest-backfill.js` every
    # parameterised execution becomes `node scan-convert` and dies. Keeping the
    # entrypoint in --command means execution-time args land AFTER it — which is
    # the whole point here, because the SUBCOMMAND is an execution argument.
    #
    # `--args=""` clears the list (there is no --clear-args on jobs). Without it
    # a re-provision KEEPS the old args and the container runs the previous
    # operator's subcommand.
    --command="node,$ENTRYPOINT"
    --args=""
    # NOT laziness. A retry re-runs the whole subcommand from the top with the
    # SAME arguments. For `batch-submit` that means a SECOND batch job against a
    # metered quota — the same 48k documents paid for twice — and for
    # `scan-convert` it re-runs into whatever wall killed the first attempt
    # (an OOM at a pathological object, a Mongo outage) while looking like
    # progress. Re-running is a human decision, and it is free: the stamps on
    # the rows ARE the checkpoint.
    --max-retries=0
    --task-timeout="$TASK_TIMEOUT"
    --memory="$MEMORY"
    # TWO vCPU because Cloud Run REQUIRES >= 2 above 4Gi. It is a consequence of
    # the memory choice, not an independent tuning knob — the work is I/O-bound.
    --cpu=2
    # Disjoint shards, all started together. `--parallelism` equals `--tasks`:
    # a lower value would queue shards behind each other and give back exactly
    # the wall-clock this change buys.
    --tasks="$TASKS"
    --parallelism="$TASKS"
    # Set EXPLICITLY, because a job spec does NOT inherit the service's env
    # block. DD_VERSION is absent ON PURPOSE — see the header.
    # MONEY-1278 — a Cloud Run JOB has no Datadog agent. DD_API_KEY is what makes
    # `datadog-metrics` emit at all (it no-ops without one, so `reportJobOutcome`
    # reached nobody from any of the 17 TypeScript jobs — including `feed-parse`,
    # which apply-monitors.sh monitors on both envs, so its monitor watched a series
    # that was never emitted). DD_TRACE_ENABLED=false overrides the `true` the image
    # bakes in, so dd-trace does not boot against a socket that is not there.
    --set-env-vars="GCP_PROJECT_ID=${PROJECT_ID},GCP_STORAGE_BUCKET=${BUCKET},DOC_PARSE_MODEL=${DOC_PARSE_MODEL},DOC_CONVERT_CONTAINER_MI=${SLOT_MI},DOC_CONVERT_CONCURRENCY=${CONCURRENCY},DD_ENV=${ENV},DD_TRACE_ENABLED=false"
    --set-secrets="DATABASE_URL=${DB_SECRET}:latest,REDIS_URL=${REDIS_SECRET}:latest,GOOGLE_GENAI_API_KEY=${GENAI_SECRET}:latest,GCP_SERVICE_ACCOUNT_KEY_BASE64=GCP_SERVICE_ACCOUNT_KEY_BASE64:latest,DD_API_KEY=${DD_SECRET}:latest"
)

if [ "$DRY_RUN" = true ]; then
    echo "   [dry-run] gcloud ${deploy_args[*]}"
    echo "   [dry-run] gcloud run jobs add-iam-policy-binding ${JOB_NAME} --region=${REGION} --member=serviceAccount:${JOB_SA} --role=roles/run.invoker"
else
    "${GC[@]}" "${deploy_args[@]}"
    "${GC[@]}" run jobs add-iam-policy-binding "$JOB_NAME" --region="$REGION" \
        --member="serviceAccount:${JOB_SA}" --role=roles/run.invoker \
        --quiet >/dev/null
    echo -e "   ${GREEN}${JOB_NAME} ${ACTION}d${NC}"
fi

# ── 3. No Scheduler trigger — deliberate ──────────────────────────────────
echo -e "${BLUE}━━━ 4/4: Cloud Scheduler ━━━${NC}"
echo -e "   ${YELLOW}None, deliberately. The nightly incremental is already the"
echo -e "   stock-document-parse Pub/Sub worker. Scheduling a whole-corpus"
echo -e "   backfill would spend a metered batch quota unattended — and once"
echo -e "   the corpus is converted it would select nothing every night, which"
echo -e "   reads as a broken selector at a glance.${NC}"

# ── EXECUTION ─────────────────────────────────────────────────────────────
# Unquoted heredoc so the printed commands name the env that was actually
# provisioned. A quoted one would print "-prod" verbatim even on a QA run, which
# is the single worst thing an ops script can hand you: a copy-pasteable command
# pointing at the environment you did not choose.
cat <<EOF

────────────────────────────────────────────────────────────────
Provisioned ${JOB_NAME} (${ENV}) — ${ACTION}.

  image   ${IMAGE}
  commit  ${IMAGE_SHA}
  memory  ${MEMORY}   cpu 2   tasks ${TASKS} x ${CONCURRENCY} in flight   retry --max-retries=0
  timeout ${TASK_TIMEOUT}s task timeout
  model   DOC_PARSE_MODEL=${DOC_PARSE_MODEL}
  bucket  GCP_STORAGE_BUCKET=${BUCKET}

VERIFY THE PIN, do not assume it. The job prints its own build as its
first line; that SHA must equal ${IMAGE_SHA} above. This is the ONE
check that can actually go red — Cloud Run JOBS pin their image at
provision time and a deploy of the SERVICE does not move them:

  gcloud run jobs execute ${JOB_NAME} --region=${REGION} --wait \\
    --args="scan-convert,--limit=5"
  gcloud logging read \\
    'resource.type=cloud_run_job AND resource.labels.job_name=${JOB_NAME} AND textPayload:"build-provenance"' \\
    --limit=5 --freshness=1h --project=${PROJECT_ID}

With no --apply the run is a DRY RUN: it plans one page, reports what it
WOULD write, stamps nothing and exits 0. That smoke test costs a few GCS
reads and still proves the entrypoint, the secrets, Mongo, the bucket and
the converter all work inside the container.

A dry run is ONE page on purpose. Nothing is stamped, so page 2 would
select the identical rows — the job says so ("stop=dry-run") and stops
rather than spinning to the task timeout.

NOTE gcloud splits --args on COMMAS, so each comma starts a NEW argument.
The FIRST argument must be the subcommand. An unrecognised argument is
FATAL: a mistyped --apply would otherwise run a silent dry run and exit
0, which is indistinguishable from a deliberate rehearsal.

EXIT CODES
  0  finished the work in scope — INCLUDING "there was none to do"
  1  refused to run: a bad or missing argument. Nothing ran.
  2  something the run needs is absent or broke (no converter, no
     GOOGLE_GENAI_API_KEY, a batch that is not SUCCEEDED)
  3  stopped on the wall clock or the batch cap; work remains. Re-run —
     the stamps on the rows ARE the checkpoint and resume is free.

────────────────────────────────────────────────────────────────
THE ORDER OF OPERATIONS

  # 1. CONVERT. 309.8 GB of GCS reads; the scannedPageCount stamp is the
  #    cursor, so this resumes for free and can be run in as many
  #    executions as you like.
  gcloud run jobs execute ${JOB_NAME} --region=${REGION} \\
    --args="scan-convert,--apply,--budget-sec=21600,--limit=250"

  # 2. THE PILOT — 25 documents that ALREADY hold an EXTRACTED row, so
  #    the batch has a known answer to be judged against.
  gcloud run jobs execute ${JOB_NAME} --region=${REGION} --wait \\
    --args="batch-build,--apply,--pilot-from-parsed=25,--out=/tmp/pilot.jsonl"
  gcloud run jobs execute ${JOB_NAME} --region=${REGION} --wait \\
    --args="batch-submit,--apply,--file=/tmp/pilot.jsonl"
  # ...then, once the batch reports JOB_STATE_SUCCEEDED:
  gcloud run jobs execute ${JOB_NAME} --region=${REGION} --wait \\
    --args="batch-ingest,--batch-job=batches/XXXX,--compare,--report=/tmp/pilot-report.json"

  # 3. READ THE REPORT. Not the counters — the disagreements, against the
  #    filings. Then and only then, the tail.
  #    NOTE /tmp inside a Cloud Run task does not survive the execution;
  #    a multi-execution pilot needs the JSONL on GCS or the three steps
  #    run from one long-lived execution.

  # 4. THE TAIL, in waves. Wave size follows the account's enqueued-token
  #    allowance, which is discovered by SUBMISSION — Google no longer
  #    publishes the table.
  gcloud run jobs execute ${JOB_NAME} --region=${REGION} \\
    --args="batch-build,--apply,--limit=5000,--out=/tmp/wave-01.jsonl"

  # 5. THE RESIDUE. FAILED_BATCH and FAILED_VALIDATION rows, one at a
  #    time, through the online path — the gate failures take the vision
  #    retry, which is the one case where whole-PDF tokens are worth it.
  gcloud run jobs execute ${JOB_NAME} --region=${REGION} \\
    --args="sweep,--apply,--limit=200"

────────────────────────────────────────────────────────────────
COST, so the tail is not a surprise (population doc §5)

  ~10k input tokens/doc (the 40,000-char page-selection cap), output
  bounded by the response schema. At the 3k-output target and the batch
  rate (50%): \$0.0094/doc, ~\$454 across 48,322. The founder ceiling for
  the drain is ~\$1,000. The promotional input rate expires 1 Jan 2027,
  after which input doubles — a reason to run the tail promptly.

  Output dominates at 5x the input rate, so the schema is the cost lever,
  not the batch size.
────────────────────────────────────────────────────────────────
EOF
