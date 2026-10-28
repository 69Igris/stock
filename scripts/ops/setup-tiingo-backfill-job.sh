#!/usr/bin/env bash
#
# setup-tiingo-backfill-job.sh — provision the Tiingo backfill Cloud Run jobs
# for one environment.
#
# MONEY-1263 (EOD + corporate actions), MONEY-1264 (news seed) and MONEY-1472
# (the lake ledger pass). The US data backfills, moved off the operator's laptop.
#
#   tiingo-us-eod-backfill-{env}          dist/tiingo-us-backfill.js
#   tiingo-us-corp-actions-backfill-{env} dist/tiingo-us-corp-actions-backfill.js
#   tiingo-us-news-seed-{env}             dist/tiingo-us-news-seed.js
#   ledger-backfill-tiingo-{env}          dist/ledger-backfill-tiingo.js
#
# The first THREE are Tiingo WALKS and share one account-wide quota — everything
# below about pacing, argv and running-in-sequence is about them. The FOURTH
# spends no Tiingo quota at all: it reads the corp-action walk's checkpoints,
# LISTS the corp-action archive and writes BigQuery rows. It rides this script because
# it ships in the same image and needs the same LAKE_ENV/LAKE_PROJECT env, not
# because it is a fourth walk.
#
# ── WHY JOBS AND NOT A LAPTOP RUN ─────────────────────────────────────────────
#
# The EOD walk is 72,685 listings at ONE request each — a single call returns a
# symbol's ENTIRE series (AAPL: 11,517 bars, 820 KB, 2.4s), which is what turns
# hundreds of thousands of symbol-years into 72,685 requests. At the Commercial
# plan's 20,000/hour that is ~3.7 HOURS of pacing before a single byte of
# latency. A closed lid kills it mid-walk.
#
# All three are checkpointed and resumable, so an interruption costs TIME and
# never WORK — which is exactly why `--max-retries=0` is right below, and why
# being killed at a timeout is survivable rather than destructive.
#
# ── WHY A PUSH WORKER CANNOT DO THIS ──────────────────────────────────────────
#
# Every worker job arrives over a Pub/Sub PUSH subscription with a 600s ack
# deadline, which is Pub/Sub's MAXIMUM and cannot be raised. A handler that runs
# past it is not merely slow: Pub/Sub treats the message as unacked and
# REDELIVERS it, so a second walker starts on the same symbols while the first
# is still running. 3.7 hours against 600 seconds is not a tuning problem.
#
# The NIGHTLY freshness leg (`us-eod-sync`) is a worker and is a different piece
# of work: a trailing 5-day window over a rotating page, sized to fit the
# deadline. These three are the HISTORY, and history is one-shot.
#
# ── WHY THREE JOBS AND NOT ONE PARAMETERISED JOB ──────────────────────────────
#
# Considered and rejected. A single job would have to carry the script name in
# `--args`, and `gcloud run jobs execute --args=...` REPLACES the container's
# args rather than appending to them — so every parameterised execution would
# have to re-specify the entrypoint, and the one that forgot would run the WRONG
# WALK under the right job name. That is the same trap the `--command` rule
# below exists to close, reintroduced one level up.
#
# Three more reasons, each independently sufficient:
#
#   - THE THREE ARG SPECS ARE DIFFERENT and the parser REJECTS unknown flags.
#     EOD takes --symbols/--only-delisted/--only-active; corp-actions takes
#     --from/--to; news takes --from/--to/--redo. One job would mean one job
#     whose legal flag set depends on an argument, discoverable only by failing.
#   - THE REPO PATTERN IS ONE JOB PER ENTRYPOINT — feed-backfill, feed-parse,
#     feed-repair, fo-summary, xbrl-backfill, xbrl-projection-drain,
#     xbrl-reparse, bse-backfill. All eight are separate jobs.
#   - THE WALK LENGTHS DIFFER BY THREE ORDERS OF MAGNITUDE (~3.7h vs ~2 min),
#     so they cannot share one honest --task-timeout. See the sizing below.
#
# Note the ONE thing separate jobs do NOT buy: they do not stop an operator
# running two walks at once. See the QUOTA warning.
#
# ── DO NOT RUN TWO OF THESE AT ONCE ───────────────────────────────────────────
#
# The EOD and corporate-actions clients hold SEPARATE throttles against ONE
# account-wide Tiingo quota. Each paces itself to the full plan allowance, so
# two concurrent walks ask for 2x the ceiling and neither one knows. Tiingo
# reports nothing about remaining quota — there is no header (verified: a
# successful EOD call returns only `x-frame-options`) — so a 429 is the ONLY
# feedback channel, and it arrives as a stopped run rather than a warning.
#
# Run them in sequence. The banner at the end prints the order.
#
# ── THE ARGV CONTRACT: EQUALS FORM, AND IT SURVIVES gcloud's COMMA SPLIT ───────
#
# >>> READ THIS BEFORE ADDING AN EXECUTION EXAMPLE. <<<
#
# All three scripts share one `parseTiingoCliArgs` (byte-identical, pinned by
# `tiingo-script-decisions.test.ts`) which accepts ONLY `--flag` or
# `--flag=value`. The SPACE form is REFUSED, and that strictness is
# load-bearing: `--to 1999-12-31` used to fall back to the default and walk
# 1990-2026 instead of 1990-1999 — 18,600 requests from an operator who asked
# for 2,600. A parser whose failure mode is "bigger job" is worse than none.
#
# `--args` is `arg_parsers.ArgList()` — a COMMA-separated list. Verified by
# running googlecloudsdk.calliope.arg_parsers.ArgList directly, then feeding the
# result to the real parser:
#
#   --args=--apply,--from=1990-01-01,--to=1999-12-31
#       -> ["--apply", "--from=1990-01-01", "--to=1999-12-31"]      ACCEPTED
#
# So the equals form passes through the comma split UNHARMED and the two
# contracts agree. No parser change was needed or made.
#
# >>> DO NOT COPY setup-bse-backfill-job.sh's DIALECT. <<<
#
# That script's parser demands the SPACE form and REJECTS equals — the EXACT
# INVERSE of this one. Its executions read `--args=--apply,--from-year,2024`.
# Fed to a Tiingo script that becomes ["--apply","--from-year","2024"] and dies
# with "--from-year requires a value and the SPACE form is not accepted".
# MONEY-1261 lost a whole chain to this in the other direction, because two
# PRODUCERS agreed with each other and disagreed with the PARSER.
#
# >>> THE ONE REAL COLLISION: `--symbols`. <<<
#
# `--symbols` takes a COMMA-separated list, and so does `--args`. They collide:
#
#   --args=--apply,--symbols=AAPL,MSFT
#       -> ["--apply", "--symbols=AAPL", "MSFT"]                    REJECTED
#          ('Unexpected argument "MSFT"')
#
# Use gcloud's `^delim^` escape to change the list separator:
#
#   --args=^:^--apply:--symbols=AAPL,MSFT
#       -> ["--apply", "--symbols=AAPL,MSFT"]                       ACCEPTED
#
# Note this fails LOUD — exit 1 before the first request — rather than silently
# running a narrowed symbol set. The parser's strictness converts a gcloud
# quoting subtlety into an error message instead of a wrong run.
#
# ── EGRESS IS ASSUMED, NOT PROVEN — PROBE FIRST ───────────────────────────────
#
# `api.tickertape.in` answers 200 from a laptop and 403 from Cloud Run
# (MONEY-1220), and that block went unnoticed for five months. Nothing in this
# repo has yet fetched api.tiingo.com FROM Cloud Run. Tiingo is authenticated
# and paid, so a block is less likely than with a scraped host — but "less
# likely" is not a measurement.
#
# So the banner tells you to run the NEWS seed dry first: ~90 requests, ~2
# minutes, and it exercises the token, the client, Prisma over the mounted
# secret and the GCS archive. That is the cheapest possible probe of every piece
# the 3.7-hour walk depends on. MONEY-1261 found its argv defect exactly this
# way, by executing `--probe` as the job before triggering a 15-hour shard.
#
# Usage:
#   ./scripts/ops/setup-tiingo-backfill-job.sh prod
#   ./scripts/ops/setup-tiingo-backfill-job.sh qa
#   ./scripts/ops/setup-tiingo-backfill-job.sh prod --dry-run
#   ./scripts/ops/setup-tiingo-backfill-job.sh prod --image=IMG
#   ./scripts/ops/setup-tiingo-backfill-job.sh prod --only=news
#   ./scripts/ops/setup-tiingo-backfill-job.sh prod --eod-timeout=43200
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

# ── TASK TIMEOUTS, DERIVED PER JOB ────────────────────────────────────────────
#
# Sized from the REAL walk lengths, not copied from a sibling. Two terms bound
# every one of these walks and the LARGER one wins:
#
#   pacing  = requests / plan_rate         (COMMERCIAL = 20,000/hour)
#   latency = requests x per-request RTT   (serial; the scripts do not fan out)
#
# The pessimistic latency column below uses 0.5s/request, which is well above
# what a small fund series costs and well below the 2.4s measured for AAPL's
# full 11,517-bar history.
#
#                    requests   pacing    latency@0.5s   chosen    headroom
#   EOD                72,685     3.7h          10.1h       24h        ~2.4x
#   corp actions       18,600     0.9h           2.6h       12h        ~4.6x
#   news                   90      16s            45s        1h         ~80x
#
# EOD gets the 24h Cloud Run MAXIMUM. Its wall clock is LATENCY-dominated, not
# pacing-dominated, so the 3.7h figure in every doc is a floor and not an
# estimate — and the job is checkpointed, so a run that finishes early exits
# early and costs nothing for the unused ceiling.
#
# NEWS deliberately does NOT get 24h. A 90-request job is done in ~2 minutes; if
# it is still running an hour later something is wrong, and a job that hangs for
# a full day before anyone looks is a job whose failure nobody sees. A tight
# timeout on a short walk is a SIGNAL, and it costs nothing because the walk is
# resumable.
TASK_TIMEOUT_EOD="86400"    # 24h — Cloud Run's maximum
TASK_TIMEOUT_CORP="43200"   # 12h
TASK_TIMEOUT_NEWS="3600"    # 1h

while [ $# -gt 0 ]; do
    case "$1" in
        --image=*)         IMAGE="${1#*=}"; shift ;;
        --only=*)          ONLY="${1#*=}"; shift ;;
        --eod-timeout=*)   TASK_TIMEOUT_EOD="${1#*=}"; shift ;;
        --corp-timeout=*)  TASK_TIMEOUT_CORP="${1#*=}"; shift ;;
        --news-timeout=*)  TASK_TIMEOUT_NEWS="${1#*=}"; shift ;;
        --dry-run)         DRY_RUN=true; shift ;;
        *) echo "Unknown option: $1" >&2; exit 1 ;;
    esac
done

case "$ENV" in
    prod)
        BUCKET="stockbook-content-prod"
        DB_SECRET="DATABASE_URL_PROD"
        DD_SECRET="DD_API_KEY_PROD"
        TIINGO_SECRET="TIINGO_API_KEY_PROD"
        # Matches workers/cloudbuild.prod.yaml. Prod is the env that WRITES the
        # feed archive; QA replays those bytes rather than spending the quota a
        # second time.
        ARCHIVE_MODE="archive"
        ;;
    qa)
        BUCKET="stockbook-content-qa"
        DB_SECRET="DATABASE_URL_QA"
        DD_SECRET="DD_API_KEY_QA"
        TIINGO_SECRET="TIINGO_API_KEY_QA"
        ARCHIVE_MODE="replay"
        ;;
    *)
        echo "Usage: $0 {prod|qa} [--image=IMG] [--only=eod|corp|news|ledger]"
        echo "          [--eod-timeout=SECS] [--corp-timeout=SECS] [--news-timeout=SECS] [--dry-run]"
        echo
        echo "Deploys the three Tiingo backfill Cloud Run jobs (MONEY-1263 / MONEY-1264)."
        echo "No Scheduler trigger, ever — see the header."
        exit 1
        ;;
esac

# TIINGO_PLAN names which rate ceilings to obey. Set EXPLICITLY, matching both
# cloudbuild specs: "absent" and "explicitly COMMERCIAL" must not be one state
# (MONEY-1214). It resolves to COMMERCIAL — the LOWER pair — when unset or
# unrecognised, because guessing high walks a run into a 429 wall mid-universe
# while guessing low only runs slower.
TIINGO_PLAN="COMMERCIAL"

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

# >>> Cloud Run JOBS pin their image at provision time. A deploy of the SERVICE
# >>> does not move them. Nothing re-points a job until somebody re-runs this
# >>> script, and nobody re-runs a setup script on a Tuesday.
#
# On 2026-08-18 `feed-parse-prod` was still on a 14-Aug image while the service
# had moved to an 18-Aug one. It ran nightly, exited 0, and skipped four feed
# families it had never heard of.
#
# THIS SCRIPT IS THE ONLY THING THAT RE-PINS THEM. `--image` is resolved from
# the live `stockbook-workers-{env}` SERVICE (or passed explicitly) and is
# FAILS-CLOSED on empty — an empty --image is read by gcloud as "keep whatever
# is there", which on a re-provision silently preserves the stale pin. So the
# roll-a-new-build procedure is: deploy the workers service, then RE-RUN THIS
# SCRIPT. There is no other step and nothing does it on a schedule.
#
# Each of the three entry points now prints a build-provenance line as the FIRST
# thing in main() (`reportBuildProvenance`), so an operator can read the running
# commit out of the job's own log instead of re-deriving it from the job spec.
# Check it against `commit` in the banner below after any re-provision.
echo -e "   ${YELLOW}PREFLIGHT: this image must contain all three dist/tiingo-*.js"
echo -e "   entrypoints (the three 'tiingo-*' entries in workers/tsup.config.ts,"
echo -e "   added by MONEY-1263/1264). On an older image the container dies"
echo -e "   instantly with \"Cannot find module /app/dist/tiingo-...\".${NC}"

# ── 2. Deploy the jobs ────────────────────────────────────────────────────────
echo -e "${BLUE}━━━ 2/3: Cloud Run Jobs ━━━${NC}"

# deploy_job <job-suffix> <entrypoint> <task-timeout> <memory>
deploy_job() {
    local suffix="$1" entrypoint="$2" timeout="$3" memory="$4" default_args="${5:-}"
    local job_name="${suffix}-${ENV}"

    local deploy_args=(
        run jobs deploy "$job_name"
        --image="$IMAGE"
        --region="$REGION"
        --service-account="$JOB_SA"
        # The script path belongs in --command, NOT --args. `gcloud run jobs
        # execute --args=...` REPLACES the container's args rather than
        # appending, so with the entrypoint in --args every parameterised
        # execution would drop it and run `node --apply`. `--args=""` clears the
        # list (there is no --clear-args on jobs deploy); without it a re-deploy
        # KEEPS the old args.
        --command="node,${entrypoint}"
        # DEFAULT ARGV. `--args=""` ships a job that cannot run itself: a bare
        # `gcloud run jobs execute` then starts `node <entrypoint>` with no
        # arguments, and a job whose parser REQUIRES a flag fails every time,
        # with --max-retries=0, in both environments. These jobs have no
        # scheduler, so the first run is always by hand — which is exactly the
        # run that hits it. An execution's own --args still REPLACES this.
        --args="${default_args}"
        # A retry restarts a multi-hour walk from the top. Cheap in ROWS — every
        # one of these scripts checkpoints, so re-walking is mostly skips — but
        # NOT cheap against Tiingo: a task killed by the timeout or by the 429
        # breaker would be restarted straight back into the metered account that
        # just cut us off, turning a protective abort into a retry loop against
        # a paid quota with no remaining-budget header to consult. Re-running is
        # a human decision.
        --max-retries=0
        --task-timeout="$timeout"
        --memory="$memory"
        --cpu=1
        # Set EXPLICITLY: a job spec does NOT inherit the service's env block.
        # Without GCP_PROJECT_ID and GCP_STORAGE_BUCKET the archive writes go
        # nowhere and the walk reports success having stored no bytes — measured
        # on the BSE job, 59 rows with an empty gcsPath (MONEY-1258).
        #
        # GCP_STORAGE_BUCKET is doubly load-bearing for the EOD job as of
        # MONEY-980: it is also where the CANDLE COLD SHARDS go
        # (`candles/US/D1/{symbol}/{year}`), which is every year of every
        # DELISTED listing plus all pre-window history of the live ones — the
        # large majority of ~206M bars. `initCandleColdStore()` registers the
        # backend only when this is set, and the backfill REFUSES to --apply
        # without it rather than walking 72,685 symbols archiving nothing.
        #
        # The identity that writes those objects is NOT necessarily the
        # --service-account above: `googleCredentials()` resolves
        # GCP_SERVICE_ACCOUNT_KEY_BASE64 FIRST, so the mounted key wins over the
        # runtime SA. Grant object-write on ${BUCKET} to whichever principal
        # that key names — granting it to stockbook-api@ alone has already been
        # a no-op once (Document AI, MONEY-783).
        # MONEY-1278 — a Cloud Run JOB has no Datadog agent. DD_API_KEY is what makes
        # `datadog-metrics` emit at all (it no-ops without one, so `reportJobOutcome`
        # reached nobody from any of the 17 TypeScript jobs — including `feed-parse`,
        # which apply-monitors.sh monitors on both envs, so its monitor watched a series
        # that was never emitted). DD_TRACE_ENABLED=false overrides the `true` the image
        # bakes in, so dd-trace does not boot against a socket that is not there.
        --set-env-vars="FEED_ARCHIVE_MODE=${ARCHIVE_MODE},GCP_STORAGE_BUCKET=${BUCKET},GCP_PROJECT_ID=${PROJECT_ID},TIINGO_PLAN=${TIINGO_PLAN},DD_ENV=${ENV},DD_TRACE_ENABLED=false,LAKE_ENV=${ENV},LAKE_PROJECT=${PROJECT_ID}"
        # TIINGO_API_KEY is a SECRET (it is a bearer token sent as
        # `Authorization: Token <key>`); TIINGO_PLAN above is a plain var
        # because an operator must be able to read it at a glance. The client
        # THROWS when the key is absent rather than fetching unauthenticated, so
        # a missing secret is a loud failure and not a job that quietly writes
        # nothing.
        --set-secrets="DATABASE_URL=${DB_SECRET}:latest,GCP_SERVICE_ACCOUNT_KEY_BASE64=GCP_SERVICE_ACCOUNT_KEY_BASE64:latest,TIINGO_API_KEY=${TIINGO_SECRET}:latest,DD_API_KEY=${DD_SECRET}:latest"
    )

    if [ "$DRY_RUN" = true ]; then
        echo "   [dry-run] gcloud ${deploy_args[*]}"
        echo "   [dry-run] gcloud run jobs add-iam-policy-binding ${job_name} --region=${REGION} --member=serviceAccount:${JOB_SA} --role=roles/run.invoker"
    else
        "${GC[@]}" "${deploy_args[@]}"
        "${GC[@]}" run jobs add-iam-policy-binding "$job_name" --region="$REGION" \
            --member="serviceAccount:${JOB_SA}" --role=roles/run.invoker \
            --quiet >/dev/null
        echo -e "   ${GREEN}${job_name} deployed${NC}  (timeout ${timeout}s, ${memory})"
    fi
}

# 2Gi for the two long walks: each buffers a whole response before parsing and
# archiving it (AAPL's full series is 820 KB, and a market-wide corporate-actions
# day is unbounded in principle). 1Gi would very likely survive; the headroom is
# cheap next to losing a 12-24h walk to an OOM. NEWS keeps 1Gi — one day of
# articles is small and there is no long walk to protect.
# FAIL CLOSED on a mistyped --only, exactly as setup-databento-jobs.sh does.
# Without it `--only=ledgr` — or `--only=ledger-backfill`, the spelling the
# SIBLING script uses — matches no branch, deploys NOTHING, and still prints the
# full "Provisioned the Tiingo backfill jobs" banner listing every job. The
# banner reports intent, not what was issued, so the operator believes the new
# image is live while the Cloud Run job keeps running the old one.
if [ -n "$ONLY" ] && [ "$ONLY" != "eod" ] && [ "$ONLY" != "corp" ] \
     && [ "$ONLY" != "news" ] && [ "$ONLY" != "ledger" ]; then
    echo -e "${RED}--only=${ONLY} is not one of: eod, corp, news, ledger.${NC}" >&2
    exit 1
fi

if [ -z "$ONLY" ] || [ "$ONLY" = "eod" ]; then
    deploy_job "tiingo-us-eod-backfill" "dist/tiingo-us-backfill.js" "$TASK_TIMEOUT_EOD" "2Gi"
fi
if [ -z "$ONLY" ] || [ "$ONLY" = "corp" ]; then
    deploy_job "tiingo-us-corp-actions-backfill" "dist/tiingo-us-corp-actions-backfill.js" "$TASK_TIMEOUT_CORP" "2Gi"
fi
if [ -z "$ONLY" ] || [ "$ONLY" = "news" ]; then
    deploy_job "tiingo-us-news-seed" "dist/tiingo-us-news-seed.js" "$TASK_TIMEOUT_NEWS" "1Gi"
fi

# MONEY-1472 (B1) — the lake ledger backfill for the corp-action archives.
#
# 1 Gi / 30 min: it lists ~28 archived objects and writes
# BigQuery rows. It holds no data and downloads nothing.
#
# NO SCHEDULER, like its siblings above: it is a catch-up pass an operator runs
# after the corp-action walk, not a standing nightly. A cron over it would
# re-HEAD the same 22 objects every night to rewrite rows that are already
# there.
if [ -z "$ONLY" ] || [ "$ONLY" = "ledger" ]; then
    # `--archiving-since` is GONE (MONEY-1474). It bounded a defect rather than
    # fixing it: the job read `BackfillCheckpoint`, which is not an index of the
    # archive — every checkpoint was written 2026-08-29, every object 2026-08-31
    # onward by the nightly leg. It LISTS the archive now, fail-closed.
    # NOT --apply by default: the first run of any ledger pass should print
    # before it writes.
    deploy_job "ledger-backfill-tiingo" "dist/ledger-backfill-tiingo.js" "1800" "1Gi" \
        "--env,${ENV}"
fi

# ── 3. No Scheduler trigger — deliberate ──────────────────────────────────────
echo -e "${BLUE}━━━ 3/3: Cloud Scheduler ━━━${NC}"
echo -e "   ${YELLOW}None, deliberately. \`us-eod-sync\` already captures new bars,"
echo -e "   NAVs and corporate actions nightly (11:00 IST, Tue-Sat). These three"
echo -e "   fetch HISTORY, which is one-shot. A scheduled re-walk would spend"
echo -e "   72,685 requests of a PAID, metered quota every night to rewrite rows"
echo -e "   it already holds.${NC}"

# Unquoted heredoc so the printed commands name the env actually provisioned.
cat <<EOF

────────────────────────────────────────────────────────────────
Provisioned the Tiingo backfill jobs (${ENV}).

  image   ${IMAGE}
  commit  ${IMAGE_SHA}
  bucket  ${BUCKET}   archive mode ${ARCHIVE_MODE}
  plan    ${TIINGO_PLAN}
  retry   --max-retries=0

  tiingo-us-eod-backfill-${ENV}           timeout ${TASK_TIMEOUT_EOD}s   2Gi
  tiingo-us-corp-actions-backfill-${ENV}  timeout ${TASK_TIMEOUT_CORP}s   2Gi
  tiingo-us-news-seed-${ENV}              timeout ${TASK_TIMEOUT_NEWS}s    1Gi

ARGV: the EQUALS form only. "--args=--apply,--limit=500" arrives as
["--apply","--limit=500"] and parses. The SPACE form used by
setup-bse-backfill-job.sh ("--from-year,2024") is REJECTED by these scripts —
the two are exact inverses. DRY RUN IS THE DEFAULT; --apply is a BARE flag.

STEP 0 — PROBE FROM CLOUD RUN BEFORE THE LONG WALK.
Nothing in this repo has fetched api.tiingo.com from Cloud Run yet, and
api.tickertape.in answers 200 from a laptop and 403 from here. ~2 minutes:

  gcloud run jobs execute tiingo-us-news-seed-${ENV} --region=${REGION} \\
    --project=${PROJECT_ID} --account=founder@disdigital.in --wait

That is a DRY RUN (no --apply) and exercises the token, the client, Prisma over
the mounted secret and the GCS archive. If it exits 0, the transport is proven.

RUN THEM IN SEQUENCE — never two at once. The clients hold SEPARATE throttles
against ONE account-wide quota, and Tiingo publishes no remaining-quota header,
so the only signal that you overran is a 429 that stops a run.

  1. news seed          (~90 requests, ~2 min)
     gcloud run jobs execute tiingo-us-news-seed-${ENV} --region=${REGION} \\
       --project=${PROJECT_ID} --account=founder@disdigital.in --args=--apply

  2. corporate actions  (~522 requests per year of history)
     gcloud run jobs execute tiingo-us-corp-actions-backfill-${ENV} --region=${REGION} \\
       --project=${PROJECT_ID} --account=founder@disdigital.in \\
       --args=--apply,--from=1990-01-01,--to=1999-12-31

  3. EOD history        (72,685 requests, ~3.7h pacing floor)
     gcloud run jobs execute tiingo-us-eod-backfill-${ENV} --region=${REGION} \\
       --project=${PROJECT_ID} --account=founder@disdigital.in --args=--apply

  4. ledger backfill    (0 Tiingo requests — one paged LIST + BigQuery writes)
     gcloud run jobs execute ledger-backfill-tiingo-${ENV} --region=${REGION} \\
       --project=${PROJECT_ID} --account=founder@disdigital.in \\
       --args=--env,${ENV},--apply

     NOTE THE SHAPE, it differs from the three above in two ways.

     It REQUIRES --env and exits 1 without it, so a bare "--args=--apply"
     copied from step 3 fails. That refusal is deliberate: the job writes to
     whichever BigQuery dataset LAKE_ENV names, and a default would let a prod
     inventory land in lake_bronze_qa silently.

     It does NOT depend on steps 1-3. It LISTS the archive rather than reading
     any walk's checkpoints (MONEY-1474), so it records whatever is there
     whenever it runs. An EMPTY listing is a refusal, not a clean run.

     It spends NO Tiingo quota, so the "never two at once" rule above does not
     apply to it: it may overlap anything.

SCOPED EOD RUNS. --symbols COLLIDES with gcloud's own comma delimiter:
"--args=--apply,--symbols=AAPL,MSFT" arrives as ["--apply","--symbols=AAPL",
"MSFT"] and exits 1 on the stray "MSFT". Change the separator with ^:^ —

  gcloud run jobs execute tiingo-us-eod-backfill-${ENV} --region=${REGION} \\
    --project=${PROJECT_ID} --account=founder@disdigital.in \\
    --args=^:^--apply:--symbols=AAPL,MSFT

  gcloud run jobs execute tiingo-us-eod-backfill-${ENV} --region=${REGION} \\
    --project=${PROJECT_ID} --account=founder@disdigital.in \\
    --args=--apply,--only-delisted,--limit=500

WATCH IT:
  gcloud run jobs executions list --job=tiingo-us-eod-backfill-${ENV} \\
    --region=${REGION} --project=${PROJECT_ID} --account=founder@disdigital.in

  gcloud logging read \\
    'resource.type="cloud_run_job" AND resource.labels.job_name="tiingo-us-eod-backfill-${ENV}"' \\
    --project=${PROJECT_ID} --account=founder@disdigital.in \\
    --freshness=1h --limit=30 --format='value(timestamp,textPayload)'

An interrupted run is SAFE to re-run: every one of the three checkpoints, so a
re-run skips what already landed. Interruption costs time, never work.

VERIFY THE PIN. A Cloud Run JOB keeps the image it was provisioned with; a
deploy of stockbook-workers-${ENV} does NOT move it, and re-running THIS SCRIPT
is the only thing that does. Each job's first log line now reports the commit
it is actually running — check it against ${IMAGE_SHA} above:

  gcloud logging read \\
    'resource.type="cloud_run_job" AND resource.labels.job_name="tiingo-us-news-seed-${ENV}"' \\
    --project=${PROJECT_ID} --account=founder@disdigital.in \\
    --freshness=1h --limit=5 --format='value(textPayload)' | grep -i build

WHERE THE BARS GO (MONEY-980). The EOD walk splits every response: an ACTIVE
listing's last 10 years go to MongoDB \`candles\`, and everything else — every
year of every DELISTED listing, all pre-window history of the live ones — goes
to a GCS cold shard under \`candles/US/D1/{symbol}/{year}\` in ${BUCKET}.
Mutual funds go to \`us_fund_nav\` and never touch \`candles\`. So the job needs
OBJECT WRITE on that bucket for the principal named by
GCP_SERVICE_ACCOUNT_KEY_BASE64 (which outranks --service-account), and it
REFUSES to --apply if GCP_STORAGE_BUCKET is unset rather than silently
archiving nothing.
────────────────────────────────────────────────────────────────
EOF
