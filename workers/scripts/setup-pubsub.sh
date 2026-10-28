#!/bin/bash
# ============================================
# UseMoney Workers - Pub/Sub Setup
# ============================================
# Creates topics, push/pull subscriptions, and IAM bindings
# for the worker service.
#
# Three environments:
#   - local: topics + PULL subscriptions only (no Cloud Run, no push,
#            no IAM grants). Used by `tsx watch` workers on a developer's
#            machine. Isolated from QA Pub/Sub fan-out.
#   - qa:    topics + PUSH subscriptions to stockbook-workers-qa Cloud Run
#   - prod:  topics + PUSH subscriptions to stockbook-workers-prod Cloud Run
#
# Prerequisites:
#   - gcloud CLI installed and authenticated
#   - For qa/prod: workers deployed to Cloud Run (or use placeholder URL)
#   - GCP setup completed (gcp-setup.sh already creates topics)
#
# Usage:
#   ./scripts/setup-pubsub.sh local   # Setup for local dev (pull subs only)
#   ./scripts/setup-pubsub.sh qa      # Setup for QA
#   ./scripts/setup-pubsub.sh prod    # Setup for Production
# ============================================

set -e

PROJECT_ID="stock-book-483718"
REGION="asia-south1"
ENV=${1:-qa}

if [ "$ENV" != "qa" ] && [ "$ENV" != "prod" ] && [ "$ENV" != "local" ]; then
    echo "Usage: ./scripts/setup-pubsub.sh [local|qa|prod]"
    exit 1
fi

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

SA_EMAIL="stockbook-api@${PROJECT_ID}.iam.gserviceaccount.com"

echo ""
echo "╔════════════════════════════════════════════╗"
echo "║  UseMoney Pub/Sub Setup                   ║"
echo "╠════════════════════════════════════════════╣"
echo "║  Environment: ${ENV}"
echo "║  Project: ${PROJECT_ID}"
echo "║  Region: ${REGION}"
echo "╚════════════════════════════════════════════╝"
echo ""

# Set project
gcloud config set project $PROJECT_ID

# Enable Pub/Sub API
echo -e "${BLUE}1. Enabling Pub/Sub API...${NC}"
gcloud services enable pubsub.googleapis.com --quiet

# MONEY-979 — 1 only when `us-fundamentals-${ENV}` was DESCRIBED successfully.
# Initialised here so every later test reads a defined value on every path.
EDGAR_PUSH_READY=0

# MONEY-979 / T15 (revised) — THREE outcomes, because two of them are errors and
# the third is a stage of the bootstrap:
#
#   READY=1, FAILURES=0   COMPLETE          exit 0
#   FAILURES>0            BROKEN            exit 1  — a create / update / IAM
#                                           call whose precondition HELD still
#                                           failed. Something is genuinely
#                                           wrong; a caller must stop.
#   DESCRIBE_BROKEN=1     UNKNOWN           exit 1  — `run services describe`
#                                           failed for a reason that is NOT
#                                           absence, so we do not know whether
#                                           the service exists. See below.
#   READY=0               NOT YET BUILT     exit 0, unless EDGAR_PUSH_REQUIRED=1
#
# The last row USED to exit 1 unconditionally, and that made a cold environment
# impossible to bootstrap. `scripts/ops/setup-infra.sh prod` runs this script as
# step 2 under `set -e`, and step 4 is the only thing that BUILDS
# us-fundamentals-prod — so the single command the file documents as "Full setup
# for Production" aborted before the deploy that would have made this section
# succeed, taking ~65 Cloud Scheduler entries and BOTH service deploys with it.
# Nothing downstream ran, and the exit code said "broken" when the truth was
# "not built yet".
#
# "Not yet built" is a STATE OF THE LADDER. It is still reported loudly — a red
# INCOMPLETE banner, the summary lists every subscription as NOT CREATED, and
# the exact commands are printed — and the subscriptions are still NOT created
# against a guessed audience, which is the hazard the refusal exists for.
#
# EDGAR_PUSH_REQUIRED=1 turns absence back into a hard failure. setup-infra sets
# it for the step-5 re-run that happens AFTER the deploy, where the service must
# exist; so does a deliberate `--only edgar-push`. One flag, two callers, and
# the distinction the exit code could not carry before.
EDGAR_PUSH_REQUIRED="${EDGAR_PUSH_REQUIRED:-0}"

# Incremented on any EDGAR provisioning call that failed while its OWN
# precondition held — a topic create (needs nothing but a working gcloud), a
# subscription create/update or an IAM grant (needs EDGAR_PUSH_READY=1).
# Assignment form, never `((n++))`: under `set -e` that arithmetic returns 1
# when the old value was 0 and would kill the script on the FIRST failure it
# counted.
EDGAR_PUSH_FAILURES=0

# MONEY-979 round-2 — 1 when `gcloud run services describe us-fundamentals-${ENV}`
# failed for a reason that is NOT "no such service", so the ladder state is
# UNKNOWN rather than "not built yet".
#
# This exists because the previous shape used EMPTY STRING as the sole
# classifier (`... 2>/dev/null) || true` then `[ -z "$URL" ]`), which folded
# expired auth, the wrong project, a disabled run.googleapis.com, a missing
# run.services.get, a network blip AND genuine absence into one state — and that
# state reports "not found" and exits 0. On a WARM production that is a FALSE
# STATEMENT about live infrastructure: the summary prints seven EXISTING
# subscriptions as NOT CREATED, the run.invoker re-grant is skipped, and the
# ladder above it prints "Complete!". Before the NOT-YET-BUILT state was added
# this same input exited 1, so the degrade converted every non-absence cause
# from a hard failure into a silent success.
#
# Initialised here so every later test reads a defined value on every path,
# `local` included.
EDGAR_DESCRIBE_BROKEN=0

# Get Cloud Run service URL (qa/prod only - local has no Cloud Run target)
if [ "$ENV" != "local" ]; then
    echo -e "${BLUE}2. Getting Cloud Run service URL...${NC}"
    SERVICE_URL=$(gcloud run services describe stockbook-workers-${ENV} \
      --region=$REGION --format='value(status.url)' 2>/dev/null) || true

    if [ -z "$SERVICE_URL" ]; then
        echo -e "   ${YELLOW}WARNING: Cloud Run service stockbook-workers-${ENV} not found.${NC}"
        echo "   Deploy the service first, then re-run this script."
        echo "   Using placeholder URL for now."
        SERVICE_URL="https://stockbook-workers-${ENV}-placeholder.run.app"
    fi

    echo "   Service URL: ${SERVICE_URL}"

    # MONEY-979 — a SECOND push target.
    #
    # The SEC EDGAR engine is its own Cloud Run service (`us-fundamentals-{env}`,
    # Python/FastAPI), not a route family on the workers. So its subscriptions
    # need their own endpoint AND their own OIDC audience: the audience is the
    # URL a push token is minted for, and a token minted for
    # stockbook-workers-prod is REJECTED by us-fundamentals-prod. Reusing
    # SERVICE_URL here would produce subscriptions that 401 on every delivery,
    # retry five times and dead-letter — silently, because a dead-lettered
    # message looks like a failing job rather than a misconfigured audience.
    #
    # MONEY-979 / T15 — THE PLACEHOLDER IS GONE, AND ITS ABSENCE IS THE POINT.
    #
    # This block used to fall back to `https://us-fundamentals-${ENV}-placeholder.run.app`
    # and carry on. That produced seven subscriptions whose OIDC audience was a
    # hostname that does not exist, which is the WORST of the three possible
    # states — worse than having no subscriptions at all:
    #
    #   no subscription       visible as missing in `gcloud pubsub subscriptions
    #                         list` and in this script's own summary — and the
    #                         summary says so explicitly. Nothing publishes to
    #                         these topics until
    #                         EDGAR_DETECT is armed, so nothing is lost.
    #   placeholder audience  looks PRESENT and healthy from every angle. Every
    #                         delivery 401s, retries five times and dead-letters,
    #                         and the DLQ entry reads as a job that keeps
    #                         crashing rather than as a misconfigured audience.
    #
    # There is a second, live hazard the placeholder created: the loop below has
    # an UPDATE branch that re-asserts endpoint and audience on an existing
    # subscription. On a working deployment, one run of this script while the
    # describe happens to fail would have REWRITTEN seven good audiences to the
    # placeholder — turning a transient gcloud error into a silent outage of the
    # whole EDGAR ingest. Skipping the block cannot do that.
    #
    # So: no invented URL, block 4b is SKIPPED, and the script exits NON-ZERO
    # with the command to run. Everything else this script does (the worker
    # topics, subscriptions and IAM) is independent and still completes.
    # MONEY-979 round-2 — CLASSIFY ON gcloud's OWN WORDS, never on emptiness.
    #
    # stderr is CAPTURED rather than discarded, because it carries the only
    # thing that separates "you have not built it yet" from "we could not ask".
    # `2>/dev/null` threw that away and `|| true` threw the exit code away, so
    # `[ -z "$URL" ]` was the entire classifier — see EDGAR_DESCRIBE_BROKEN.
    US_FUNDAMENTALS_RC=0
    US_FUNDAMENTALS_ERRFILE=$(mktemp "${TMPDIR:-/tmp}/usf-describe.XXXXXX")
    US_FUNDAMENTALS_URL=$(gcloud run services describe us-fundamentals-${ENV} \
      --region=$REGION --format='value(status.url)' 2>"$US_FUNDAMENTALS_ERRFILE") \
      || US_FUNDAMENTALS_RC=$?
    US_FUNDAMENTALS_ERR=$(cat "$US_FUNDAMENTALS_ERRFILE" 2>/dev/null || true)
    rm -f "$US_FUNDAMENTALS_ERRFILE"

    if [ "$US_FUNDAMENTALS_RC" -eq 0 ] && [ -n "$US_FUNDAMENTALS_URL" ]; then
        EDGAR_PUSH_READY=1
        echo "   us-fundamentals URL: ${US_FUNDAMENTALS_URL}"
    elif [ "$US_FUNDAMENTALS_RC" -ne 0 ] && printf '%s' "$US_FUNDAMENTALS_ERR" \
        | grep -qE 'NOT_FOUND|[Cc]annot find service|does not exist'; then
        # GENUINE ABSENCE. The only input that means "the deploy has not run".
        EDGAR_PUSH_READY=0
        US_FUNDAMENTALS_URL=""
        echo -e "   ${RED}REFUSING: Cloud Run service us-fundamentals-${ENV} not found.${NC}"
        echo -e "   ${RED}The EDGAR push subscriptions need its URL as their OIDC audience,${NC}"
        echo -e "   ${RED}and a guessed one 401s every delivery for the life of the sub.${NC}"
        echo "   This is a LADDER STATE, not a failure: everything else in this"
        echo "   script still runs. The deploy MINTS the URL, so it must come first."
        echo "   One command does the whole ladder in order:"
        echo "     ./scripts/ops/setup-infra.sh ${ENV}          # deploys, then re-runs this step"
        echo "   Or by hand:"
        echo "     gcloud builds submit --config=services/us-fundamentals/cloudbuild.${ENV}.yaml"
        echo "     EDGAR_PUSH_REQUIRED=1 ./workers/scripts/setup-pubsub.sh ${ENV}"
    else
        # EVERYTHING ELSE, including `exit 0` with an EMPTY url — a service that
        # exists but has no ready revision reports no `status.url`, and treating
        # that as READY would create seven subscriptions with an EMPTY audience,
        # which is worse than the placeholder this script already refuses to
        # invent.
        EDGAR_PUSH_READY=0
        EDGAR_DESCRIBE_BROKEN=1
        US_FUNDAMENTALS_URL=""
        echo -e "   ${RED}BROKEN: could not determine whether us-fundamentals-${ENV} exists.${NC}"
        echo -e "   ${RED}gcloud exited ${US_FUNDAMENTALS_RC} and did not say NOT_FOUND, so this is${NC}"
        echo -e "   ${RED}NOT the bootstrap state — expired credentials, the wrong project, a${NC}"
        echo -e "   ${RED}disabled run.googleapis.com, a missing run.services.get or a network${NC}"
        echo -e "   ${RED}failure all land here. Reporting it as 'not built yet' would print${NC}"
        echo -e "   ${RED}seven LIVE subscriptions as NOT CREATED and exit 0.${NC}"
        if [ -n "$US_FUNDAMENTALS_ERR" ]; then
            echo "   gcloud said:"
            printf '     %s\n' "$US_FUNDAMENTALS_ERR"
        else
            echo "   gcloud printed nothing on stderr and returned an empty URL."
        fi
        echo "   Nothing EDGAR-specific is provisioned on this run, and it exits 1."
    fi
else
    echo -e "${BLUE}2. Skipping Cloud Run service URL (local mode)${NC}"
fi

# ============================================
# Create topics (idempotent - skips if exists)
# ============================================
echo ""
echo -e "${BLUE}3. Creating Pub/Sub topics...${NC}"

declare -a BASE_TOPICS=(
  "trade-pairing"
  "csv-import"
  "broker-sync"
  "instrument-sync"
  "price-sync"
  "intraday-sync"
  "sector-enrichment"
  "mf-sync"
  "mf-metadata-sync"
  "mf-nav-propagate"
  # MONEY-1205 - MFAPI.in NAV-history backfill, moved OFF the web request path.
  # Publishers: Cloud Scheduler `mf-nav-backfill-daily` (universe sweep) and the
  # cold-read path in @usemoney/core/market-data (single scheme, on demand).
  "mf-nav-backfill"
  "peers-sync"
  # MONEY-1098 P5.4 - weekly-sharded ownership syncs -> ShareholdingPattern + InsiderEvent
  "ownership-sync"
  # MONEY-1098 (P5.5/P5.6) - NSE annual reports + integrated filings; NSE public issues
  "annual-reports-sync"
  "ipo-sync"
  "stock-research"
  "document-process"
  "portfolio-roast"
  # MONEY-553 - async deep stock/MF comparison
  "comparison-analysis"
  "newsletter-publish"
  "l3-analysis"
  "login-briefing"
  "news-sync"
  "filings-sync"
  "chartink-strategy-sync"
  "intent-learning"
  "strategy-scan"
  "stock-document-sync"
  # MONEY-783 - Document AI / pdf-parse extraction of PENDING stock PDFs
  "stock-document-extract"
  "stock-document-parse"
  # MONEY-1314 - the unified per-document lane: convert once into a
  # `${gcsPath}.md` sidecar, then BOTH readings (RAG chunks + statement
  # extraction) run off it instead of each re-opening the PDF on its own
  # schedule. ONE plain push subscription, and deliberately NO
  # --message-filter: a Pub/Sub filter reads attributes.* only, and every
  # publisher in this repo calls publishMessage({ json }) / ({ data }), which
  # sets no attributes at all — so a filtered subscription would match zero
  # messages and DROP them, looking exactly like a quiet queue.
  "stock-document-ingest"
  "document-financials-projection"
  "stock-document-embed"
  # MONEY-840/844 - weekly corporate-actions ingestion (Screener + NSE -> DB + GCS)
  "corporate-actions-sync"
  # MONEY-851/852 - free EOD price seed (BSE/NSE bhavcopy) + BSE announcements bulk
  "bhavcopy-sync"
  "bse-announcements-sync"
  # MONEY-1098 (P5.1) - whole-market NSE announcements -> StockDocument + GCS
  "nse-announcements-sync"
  # MONEY-1097 (Data Engine P2) - archive-first capture of the NSE/BSE report set
  "report-archive-sync"
  "resend-contact-sync"
  "sparkline-sync"
  "research-preview-plan"
  "index-constituent-sync"
  "surveillance-sync"
  # MONEY-1108 (P8d) - daily FII/DII institutional cash-market flows
  "institutional-flow-sync"
  # MONEY-1198 - the exchange's OWN top gainers/losers + live index snapshot,
  # polled intraday during market hours. Whole-market, no per-symbol fan-out.
  "market-movers-sync"
  # MONEY-1106 (Data Engine P8b) - RBI/MOSPI/OEA macro series
  "macro-sync"
  # MONEY-1113 (Data Engine P10 F1) - company financials from NSE's own XBRL
  "xbrl-sync"
  "xbrl-projection"
  "xbrl-ratios"
  # MONEY-1105 (Data Engine P8a) - AMC monthly portfolio disclosures
  "mf-portfolio-sync"
  # MONEY-1187 (Data Engine P11) - NSE exchange circulars
  "circulars-sync"
  # MONEY-408 - RSS news ingestion + alert engine + earnings-calendar population
  "news-rss-sync"
  "events-sync"
  "alert-evaluator"
  # MONEY-406 - strategy backtest stats sync
  "strategy-stats-sync"
  # MONEY-391 - async account deletion (Clerk lock + snapshot + Dodo cancel + DB cascade + email)
  "account-deletion"
  # MONEY-144 - hourly Clerk-delete sweep (24h after lock)
  "clerk-delete-sweep"
  # MONEY-789 (B4) - nightly investor self-learning rollup
  "investor-rollup"
  # Content Studio - async Veo + reel render -> GCS
  "studio-render"
  # MONEY-980 - nightly Tiingo US price backbone: EOD bars + mutual-fund NAVs +
  # the corporate-actions delta DERIVED from the inline divCash/splitFactor
  # columns (the dedicated corp-actions endpoints 403 on our plan) + USDINR.
  # Route path MUST equal this base name: /jobs/us-eod-sync.
  "us-eod-sync"
  "us-instrument-master-sync"
  # MONEY-980 - the hot/cold candle store's only DELETER. Evicts a LOADED row 30
  # days after its last read and a WINDOW row whose year has rolled out of the
  # hot window. Destructive, so it is DISARMED unless CANDLE_EVICT_APPLY=true.
  # Route path MUST equal this base name: /jobs/candle-evict.
  "candle-evict"
  # MONEY-1309 - the 24x7 Tiingo news poll, every 2 minutes on ALL SEVEN DAYS.
  # Publisher is Cloud Scheduler `tiingo-news-poll-${ENV}` (prod only — the job
  # is in PROD_ONLY_JOBS because Tiingo is a paid metered API and QA receives
  # `us_news_articles` by mongorestore instead).
  #
  # The topic is created in EVERY env even so, and that is the existing
  # convention rather than an oversight: a topic costs nothing, `setup-pubsub.sh
  # local` needs one to publish to by hand, and the thing PROD_ONLY_JOBS gates
  # is the SCHEDULE, not the plumbing.
  #
  # Route path MUST equal this base name: /jobs/tiingo-news-poll. The push
  # subscription below is built as `${SERVICE_URL}/jobs/${BASE_TOPIC}`, so a
  # route registered under any other path 404s on every delivery and
  # dead-letters after 5 attempts — which reads as a failing job rather than a
  # misrouted topic.
  "tiingo-news-poll"
  # MONEY-1324 (P17) - AI readings of SEC 8-K/6-K exhibits. ONE TOPIC, TWO
  # MESSAGE SHAPES: Cloud Scheduler posts {"mode":"sweep"} every 10 minutes and
  # the sweep fans out {"documentId":...} per owed document BACK ONTO THIS
  # TOPIC, the same arrangement broker-sync uses for its shard fan-out.
  #
  # Consumed by stockbook-workers, NOT by us-fundamentals - it reads text that
  # service already wrote to GCS, so it belongs in BASE_TOPICS rather than in
  # EDGAR_TOPICS below, whose push endpoint points at a different service.
  #
  # Route path MUST equal this base name: /jobs/us-filing-insight.
  "us-filing-insight"
  # MONEY-1520 - claimed SEC filings -> InstrumentEvent. PUBLISHED BY PYTHON
  # (services/us-fundamentals, app/jobs/detect.py), consumed by the WORKERS -
  # so it belongs HERE and not in EDGAR_TOPICS below, whose push endpoints
  # point at us-fundamentals-${ENV}. Same reasoning as us-filing-insight above,
  # in the opposite direction.
  #
  # It replaces an HTTP POST to /internal/events on this same workers service,
  # which answered 404 on EVERY call: stockbook-workers-${ENV} has
  # `ingress: internal` and us-fundamentals-${ENV} has no VPC egress, so the
  # call left over the public internet and Cloud Run refused it at the EDGE.
  # Pub/Sub push is not external traffic - which is the reason every topic in
  # this array already reaches that service without trouble.
  #
  # NO NEW IAM. us-fundamentals-${ENV} runs as stockbook-api@ (the
  # serviceAccountName in services/us-fundamentals/cloudbuild.*.yaml), the same
  # SA section 5 below already grants project-level roles/pubsub.publisher to -
  # which is why its edgar-parse-* fan-out has always worked. A per-topic grant
  # here would be a second, narrower statement of a permission that is already
  # true, and the kind that drifts.
  #
  # Route path MUST equal this base name: /jobs/us-filing-events.
  "us-filing-events"
)

# MONEY-979 (SEC EDGAR / us-fundamentals) — a SECOND topic group.
#
# Kept separate from BASE_TOPICS rather than appended to it, because the two
# groups differ in the ONE field that matters: their push endpoint and audience
# point at `us-fundamentals-${ENV}`, not `stockbook-workers-${ENV}`. Merging
# them would need a per-topic target lookup inside the loop below, and the
# failure mode of getting that wrong is invisible — a subscription pushing to
# the wrong service 404s or 401s on every delivery and dead-letters, which reads
# as a failing job rather than a misrouted topic.
#
# The route path MUST equal the base name: the loop builds
# `${URL}/jobs/${BASE_TOPIC}`, and `services/us-fundamentals/app/main.py`
# registers exactly these seven under `JOB_ROUTES`.
declare -a EDGAR_TOPICS=(
  # Minutely `getcurrent` walk + the hourly EFTS reconcile pass, both on this
  # one topic (the reconcile is the same route with {"mode":"efts"}).
  "edgar-detect"
  # One parser per FORM CLASS. Separate topics rather than one `edgar-parse`
  # with a discriminator, so a poison 13F cannot stall Form 4 ingestion and each
  # class gets its own backlog, its own dead-letter accounting and its own
  # zero-write monitor.
  "edgar-parse-ownership"
  "edgar-parse-13f"
  "edgar-parse-13dg"
  "edgar-parse-8k"
  "edgar-parse-financials"
  # The 13F hot/cold evictor — the only route in that service that DELETES.
  "edgar-evict"
)

# Create env-suffixed topics (e.g. instrument-sync-qa, instrument-sync-prod)
for BASE_TOPIC in "${BASE_TOPICS[@]}"; do
  TOPIC="${BASE_TOPIC}-${ENV}"
  gcloud pubsub topics create $TOPIC 2>/dev/null \
    && echo -e "   ${YELLOW}Created topic: $TOPIC${NC}" \
    || echo -e "   ${GREEN}Topic $TOPIC already exists${NC}"
done

# EDGAR topics exist in EVERY env, local included: a topic costs nothing, and a
# developer publishing by hand needs one to publish to. Only qa/prod get PUSH
# subscriptions (below) — local dev POSTs the FastAPI service directly, so there
# is no pull subscriber to create a subscription for.
#
# MONEY-979 round-2 — `create || echo "already exists"` is the same
# emptiness-as-classifier defect one call site over. `topics create` exits 1 for
# BOTH "resource already exists" and PERMISSION_DENIED / quota / a disabled API,
# so a permission failure printed the GREEN "already exists" line and the run
# ended on "Pub/Sub Setup Complete!" — with seven EDGAR topics that do not
# exist. A topic that does not exist is not a slow subscription: publishes to it
# fail, which is how `edgar-detect-minutely-${ENV}` stops silently.
#
# So classify on the message, and count anything else as a failure. This loop
# needs no service URL, so its precondition holds in every env — hence it counts
# even when EDGAR_PUSH_READY is 0.
for BASE_TOPIC in "${EDGAR_TOPICS[@]}"; do
  TOPIC="${BASE_TOPIC}-${ENV}"
  TOPIC_RC=0
  TOPIC_ERR=$(gcloud pubsub topics create "$TOPIC" 2>&1 >/dev/null) || TOPIC_RC=$?
  if [ "$TOPIC_RC" -eq 0 ]; then
    echo -e "   ${YELLOW}Created topic: $TOPIC${NC}"
  elif printf '%s' "$TOPIC_ERR" | grep -qiE 'already exists|ALREADY_EXISTS'; then
    echo -e "   ${GREEN}Topic $TOPIC already exists${NC}"
  else
    EDGAR_PUSH_FAILURES=$((EDGAR_PUSH_FAILURES + 1))
    echo -e "   ${RED}FAILED to create topic $TOPIC (gcloud exited ${TOPIC_RC})${NC}"
    [ -n "$TOPIC_ERR" ] && printf '     %s\n' "$TOPIC_ERR"
  fi
done

# Dead letter topic - for QA/prod push subscription failures.
# Local pull subs handle their own dead-lettering in pull-subscriber.ts
# (acks after MAX_DELIVERY_ATTEMPTS), so they don't need a DL topic.
if [ "$ENV" != "local" ]; then
    DL_TOPIC="dead-letter-${ENV}"
    gcloud pubsub topics create $DL_TOPIC 2>/dev/null \
      && echo -e "   ${YELLOW}Created topic: $DL_TOPIC${NC}" \
      || echo -e "   ${GREEN}Topic $DL_TOPIC already exists${NC}"
fi

# ============================================
# Local environment: create pull subscriptions and exit
# ============================================
# Local dev workers use PULL subscriptions (push can't reach localhost).
# pull-subscriber.ts in workers/src/lib/ also auto-creates these on startup,
# but provisioning them upfront is faster and clearer.
if [ "$ENV" == "local" ]; then
    echo ""
    echo -e "${BLUE}4. Creating pull subscriptions for local dev...${NC}"

    for BASE_TOPIC in "${BASE_TOPICS[@]}"; do
        TOPIC="${BASE_TOPIC}-${ENV}"
        # Naming convention matches pull-subscriber.ts:78 - `${topicName}-pull-local`.
        # The "-pull-local" suffix tells you "this sub is consumed by a local
        # dev pull subscriber" regardless of which env's topic it's attached to.
        SUB_NAME="${TOPIC}-pull-local"

        if gcloud pubsub subscriptions describe $SUB_NAME &>/dev/null 2>&1; then
            echo -e "   ${GREEN}Pull subscription $SUB_NAME already exists${NC}"
        else
            gcloud pubsub subscriptions create $SUB_NAME \
              --topic=$TOPIC \
              --ack-deadline=600 \
              --message-retention-duration=7d \
              --quiet 2>/dev/null \
              && echo -e "   ${YELLOW}Created pull subscription: $SUB_NAME${NC}" \
              || echo -e "   ${RED}Failed to create pull subscription: $SUB_NAME${NC}"
        fi
    done

    echo ""
    echo "╔════════════════════════════════════════════╗"
    echo "║  Local Pub/Sub Setup Complete!             ║"
    echo "╚════════════════════════════════════════════╝"
    echo ""
    echo "What was set up:"
    echo "  - $((${#BASE_TOPICS[@]} + ${#EDGAR_TOPICS[@]})) topics: <name>-local"
    echo "      ${#BASE_TOPICS[@]} worker topics + ${#EDGAR_TOPICS[@]} EDGAR topics (MONEY-979)"
    echo "  - ${#BASE_TOPICS[@]} pull subscriptions: <name>-local-pull-local"
    echo ""
    echo "Skipped (not needed for local):"
    echo "  - Cloud Run service URL lookup"
    echo "  - Push subscriptions (Cloud Run can't reach localhost)"
    echo "  - Dead-letter topic (pull subscriber acks after MAX_DELIVERY_ATTEMPTS)"
    echo "  - Service account IAM grants (local uses ADC, not the SA)"
    echo "  - Pull subscriptions for the ${#EDGAR_TOPICS[@]} EDGAR topics — the TypeScript"
    echo "    pull subscriber has no EDGAR routes. Run us-fundamentals locally"
    echo "    (uvicorn app.main:app --port 8080) and POST /jobs/<topic> directly;"
    echo "    a body with no message.messageId skips dedupe by design."
    echo ""
    echo "Next steps:"
    echo "  1. Set PUBSUB_ENV=local in your local .env (if not already)"
    echo "  2. Restart workers: yarn workspace @usemoney/workers dev"
    echo "  3. The pull subscriber will pick up the new -local subs automatically"
    echo ""
    exit 0
fi

# ============================================
# Create push subscriptions (qa/prod only)
# ============================================
echo ""
echo -e "${BLUE}4. Creating push subscriptions...${NC}"

# Only create subscriptions for topics that have worker endpoints
declare -a BASE_WORKER_TOPICS=(
  "trade-pairing"
  "csv-import"
  "broker-sync"
  "instrument-sync"
  "price-sync"
  "intraday-sync"
  "sector-enrichment"
  "mf-sync"
  "mf-metadata-sync"
  "mf-nav-propagate"
  # MONEY-1205 - MFAPI.in NAV-history backfill, moved OFF the web request path.
  # Publishers: Cloud Scheduler `mf-nav-backfill-daily` (universe sweep) and the
  # cold-read path in @usemoney/core/market-data (single scheme, on demand).
  "mf-nav-backfill"
  "peers-sync"
  # MONEY-1098 P5.4 - weekly-sharded ownership syncs -> ShareholdingPattern + InsiderEvent
  "ownership-sync"
  # MONEY-1098 (P5.5/P5.6) - NSE annual reports + integrated filings; NSE public issues
  "annual-reports-sync"
  "ipo-sync"
  "stock-research"
  "document-process"
  "portfolio-roast"
  # MONEY-553 - async deep stock/MF comparison
  "comparison-analysis"
  "newsletter-publish"
  "l3-analysis"
  "login-briefing"
  "news-sync"
  "filings-sync"
  "chartink-strategy-sync"
  "intent-learning"
  "strategy-scan"
  "stock-document-sync"
  # MONEY-783 - Document AI / pdf-parse extraction of PENDING stock PDFs
  "stock-document-extract"
  "stock-document-parse"
  # MONEY-1314 - the unified per-document lane: convert once into a
  # `${gcsPath}.md` sidecar, then BOTH readings (RAG chunks + statement
  # extraction) run off it instead of each re-opening the PDF on its own
  # schedule. ONE plain push subscription, and deliberately NO
  # --message-filter: a Pub/Sub filter reads attributes.* only, and every
  # publisher in this repo calls publishMessage({ json }) / ({ data }), which
  # sets no attributes at all — so a filtered subscription would match zero
  # messages and DROP them, looking exactly like a quiet queue.
  "stock-document-ingest"
  "document-financials-projection"
  "stock-document-embed"
  # MONEY-840/844 - weekly corporate-actions ingestion (Screener + NSE -> DB + GCS)
  "corporate-actions-sync"
  # MONEY-851/852 - free EOD price seed (BSE/NSE bhavcopy) + BSE announcements bulk
  "bhavcopy-sync"
  "bse-announcements-sync"
  # MONEY-1098 (P5.1) - whole-market NSE announcements -> StockDocument + GCS
  "nse-announcements-sync"
  # MONEY-1097 (Data Engine P2) - archive-first capture of the NSE/BSE report set
  "report-archive-sync"
  "resend-contact-sync"
  "sparkline-sync"
  "research-preview-plan"
  "index-constituent-sync"
  "surveillance-sync"
  # MONEY-1108 (P8d) - daily FII/DII institutional cash-market flows
  "institutional-flow-sync"
  # MONEY-1198 - the exchange's OWN top gainers/losers + live index snapshot,
  # polled intraday during market hours. Whole-market, no per-symbol fan-out.
  "market-movers-sync"
  # MONEY-1106 (Data Engine P8b) - RBI/MOSPI/OEA macro series
  "macro-sync"
  # MONEY-1113 (Data Engine P10 F1) - company financials from NSE's own XBRL
  "xbrl-sync"
  "xbrl-projection"
  "xbrl-ratios"
  # MONEY-1105 (Data Engine P8a) - AMC monthly portfolio disclosures
  "mf-portfolio-sync"
  # MONEY-1187 (Data Engine P11) - NSE exchange circulars
  "circulars-sync"
  # MONEY-408 - RSS news ingestion + alert engine + earnings-calendar population
  "news-rss-sync"
  "events-sync"
  "alert-evaluator"
  # MONEY-406 - strategy backtest stats sync
  "strategy-stats-sync"
  # MONEY-391 - async account deletion (Clerk lock + snapshot + Dodo cancel + DB cascade + email)
  "account-deletion"
  # MONEY-144 - hourly Clerk-delete sweep (24h after lock)
  "clerk-delete-sweep"
  # MONEY-789 (B4) - nightly investor self-learning rollup
  "investor-rollup"
  # Content Studio - async Veo + reel render -> GCS
  "studio-render"
  # MONEY-980 - nightly Tiingo US price backbone: EOD bars + mutual-fund NAVs +
  # the corporate-actions delta DERIVED from the inline divCash/splitFactor
  # columns (the dedicated corp-actions endpoints 403 on our plan) + USDINR.
  # Route path MUST equal this base name: /jobs/us-eod-sync.
  "us-eod-sync"
  "us-instrument-master-sync"
  # MONEY-980 - the hot/cold candle store's only DELETER. Evicts a LOADED row 30
  # days after its last read and a WINDOW row whose year has rolled out of the
  # hot window. Destructive, so it is DISARMED unless CANDLE_EVICT_APPLY=true.
  # Route path MUST equal this base name: /jobs/candle-evict.
  "candle-evict"
  # MONEY-1309 - the 24x7 Tiingo news poll, every 2 minutes on ALL SEVEN DAYS.
  # Publisher is Cloud Scheduler `tiingo-news-poll-${ENV}` (prod only — the job
  # is in PROD_ONLY_JOBS because Tiingo is a paid metered API and QA receives
  # `us_news_articles` by mongorestore instead).
  #
  # The topic is created in EVERY env even so, and that is the existing
  # convention rather than an oversight: a topic costs nothing, `setup-pubsub.sh
  # local` needs one to publish to by hand, and the thing PROD_ONLY_JOBS gates
  # is the SCHEDULE, not the plumbing.
  #
  # Route path MUST equal this base name: /jobs/tiingo-news-poll. The push
  # subscription below is built as `${SERVICE_URL}/jobs/${BASE_TOPIC}`, so a
  # route registered under any other path 404s on every delivery and
  # dead-letters after 5 attempts — which reads as a failing job rather than a
  # misrouted topic.
  "tiingo-news-poll"
  # MONEY-1324 (P17). The push subscription is what makes the SELF-FAN-OUT work
  # at all: the sweep publishes per-document messages onto the same topic, so
  # without a subscription here the scheduler would tick, the sweep would never
  # run, and the messages it never sent would have had nowhere to land.
  "us-filing-insight"
  # MONEY-1520. The subscription is the WHOLE POINT of this entry: the topic
  # alone would accept every message and hold it until retention expires, which
  # is the same total silence the 404 produced. It takes the standard shape
  # below - push to ${SERVICE_URL}/jobs/us-filing-events, 600s ack, 7d
  # retention, 10s->600s backoff, and the SHARED dead-letter-${ENV} topic after
  # 5 attempts.
  #
  # THE DLQ IS THE RECOVERY CHANNEL HERE, and that is a deliberate difference
  # from us-filing-insight above. That lane ACKs 200 on every path because its
  # leaves spend PAID model calls and its retry channel is a status column.
  # This lane's work is a cheap idempotent Mongo upsert on a deterministic
  # eventId, so a retry costs nothing and a parked message keeps the payload -
  # which is what turns "permanently lost" into "recoverable".
  "us-filing-events"
)

# MONEY-841: every worker push subscription carries a dead-letter policy so a
# message that keeps failing (poison payload, persistent bug) is parked on the
# shared dead-letter topic after MAX_DELIVERY_ATTEMPTS instead of redelivering
# forever (a Pub/Sub backlog + repeated partial work). 5 attempts ≈ the existing
# 10s→600s backoff envelope; raise per-topic later if a job legitimately needs
# more retries. The DL_TOPIC was created above (qa/prod only).
DL_TOPIC="dead-letter-${ENV}"
DL_TOPIC_PATH="projects/${PROJECT_ID}/topics/${DL_TOPIC}"
MAX_DELIVERY_ATTEMPTS=5

for BASE_TOPIC in "${BASE_WORKER_TOPICS[@]}"; do
  TOPIC="${BASE_TOPIC}-${ENV}"
  SUB_NAME="${BASE_TOPIC}-${ENV}-push"

  if gcloud pubsub subscriptions describe $SUB_NAME &>/dev/null 2>&1; then
    echo -e "   ${GREEN}Subscription $SUB_NAME already exists${NC}"
    # Update push endpoint, audience, and dead-letter policy in case the service
    # URL changed or the DLQ was added after the sub was first created.
    gcloud pubsub subscriptions update $SUB_NAME \
      --push-endpoint="${SERVICE_URL}/jobs/${BASE_TOPIC}" \
      --push-auth-service-account=$SA_EMAIL \
      --push-auth-token-audience="${SERVICE_URL}" \
      --dead-letter-topic="$DL_TOPIC_PATH" \
      --max-delivery-attempts=$MAX_DELIVERY_ATTEMPTS \
      --quiet 2>/dev/null || true
    echo "   Updated endpoint -> ${SERVICE_URL}/jobs/${BASE_TOPIC} (audience: ${SERVICE_URL}, DLQ: ${DL_TOPIC})"
  else
    gcloud pubsub subscriptions create $SUB_NAME \
      --topic=$TOPIC \
      --push-endpoint="${SERVICE_URL}/jobs/${BASE_TOPIC}" \
      --push-auth-service-account=$SA_EMAIL \
      --push-auth-token-audience="${SERVICE_URL}" \
      --ack-deadline=600 \
      --message-retention-duration=7d \
      --min-retry-delay=10s \
      --max-retry-delay=600s \
      --dead-letter-topic="$DL_TOPIC_PATH" \
      --max-delivery-attempts=$MAX_DELIVERY_ATTEMPTS \
      --quiet 2>/dev/null \
      && echo -e "   ${YELLOW}Created subscription: $SUB_NAME -> ${SERVICE_URL}/jobs/${BASE_TOPIC} (DLQ: ${DL_TOPIC})${NC}" \
      || echo -e "   ${RED}Failed to create subscription: $SUB_NAME${NC}"
  fi
done

# ============================================
# MONEY-979 — EDGAR push subscriptions -> us-fundamentals-${ENV}
# ============================================
# A SEPARATE loop, byte-for-byte the same shape as the one above except that
# every URL is US_FUNDAMENTALS_URL. Same ack-deadline (600s, Pub/Sub's maximum),
# same 7d retention, same 10s->600s backoff, same shared DLQ and the same 5
# delivery attempts — the SEC engine has no reason to be treated differently
# from any other job consumer, and a second convention would be a second thing
# to keep in step.
#
# The AUDIENCE is what makes this loop necessary. An OIDC push token is minted
# FOR a specific audience, and `services/us-fundamentals/app/auth.py` verifies
# it against its own CLOUD_RUN_URL. A token carrying the workers' URL is
# rejected, so a subscription that inherited SERVICE_URL would 401 on every
# delivery, exhaust its five attempts and dead-letter — indistinguishable, from
# the DLQ, from a job that keeps crashing.
echo ""
echo -e "${BLUE}4b. Creating EDGAR push subscriptions (-> us-fundamentals-${ENV})...${NC}"

if [ "$EDGAR_PUSH_READY" != "1" ]; then
  echo -e "   ${RED}SKIPPED — us-fundamentals-${ENV} has no URL (see section 2).${NC}"
  echo -e "   ${RED}Creating these against a guessed audience would look like success${NC}"
  echo -e "   ${RED}and 401 every delivery. This run is INCOMPLETE.${NC}"
  if [ "$EDGAR_DESCRIBE_BROKEN" = "1" ]; then
    echo -e "   ${RED}The URL is unknown because the DESCRIBE FAILED, not because the${NC}"
    echo -e "   ${RED}service is absent. These subscriptions may well already exist and${NC}"
    echo -e "   ${RED}be healthy — this run simply could not look. Exits non-zero.${NC}"
  elif [ "$EDGAR_PUSH_REQUIRED" = "1" ]; then
    echo -e "   ${RED}EDGAR_PUSH_REQUIRED=1, so the absence is an ERROR here: the caller${NC}"
    echo -e "   ${RED}has already deployed the service. This run exits non-zero.${NC}"
  else
    echo -e "   ${YELLOW}Bootstrap run: the exit code stays 0 so the deploy that MINTS${NC}"
    echo -e "   ${YELLOW}this URL can still happen. Re-run this step afterwards.${NC}"
  fi
fi

for BASE_TOPIC in "${EDGAR_TOPICS[@]}"; do
  [ "$EDGAR_PUSH_READY" = "1" ] || continue
  TOPIC="${BASE_TOPIC}-${ENV}"
  SUB_NAME="${BASE_TOPIC}-${ENV}-push"

  if gcloud pubsub subscriptions describe $SUB_NAME &>/dev/null 2>&1; then
    echo -e "   ${GREEN}Subscription $SUB_NAME already exists${NC}"
    # Re-assert endpoint, audience and DLQ policy. This is the branch that
    # HEALS a first deploy: the service's Cloud Build resolves CLOUD_RUN_URL
    # from `services describe` and corrects it after the replace, so re-running
    # this script once the service exists rewrites the audience to match. It is
    # only reachable when EDGAR_PUSH_READY=1, so it can never overwrite a good
    # audience with a guess.
    #
    # `|| true` used to sit on the end of this call and the echo below ran
    # unconditionally, so a failed update PRINTED "Updated endpoint -> …" and
    # exited 0. That is the reporting shape this whole ticket exists to remove:
    # the audience stayed stale, every delivery kept 401ing, and the script said
    # it had corrected it.
    if gcloud pubsub subscriptions update $SUB_NAME \
      --push-endpoint="${US_FUNDAMENTALS_URL}/jobs/${BASE_TOPIC}" \
      --push-auth-service-account=$SA_EMAIL \
      --push-auth-token-audience="${US_FUNDAMENTALS_URL}" \
      --dead-letter-topic="$DL_TOPIC_PATH" \
      --max-delivery-attempts=$MAX_DELIVERY_ATTEMPTS \
      --quiet 2>/dev/null; then
      echo "   Updated endpoint -> ${US_FUNDAMENTALS_URL}/jobs/${BASE_TOPIC} (audience: ${US_FUNDAMENTALS_URL}, DLQ: ${DL_TOPIC})"
    else
      EDGAR_PUSH_FAILURES=$((EDGAR_PUSH_FAILURES + 1))
      echo -e "   ${RED}Failed to update subscription: $SUB_NAME (audience may still be stale)${NC}"
    fi
  else
    if gcloud pubsub subscriptions create $SUB_NAME \
      --topic=$TOPIC \
      --push-endpoint="${US_FUNDAMENTALS_URL}/jobs/${BASE_TOPIC}" \
      --push-auth-service-account=$SA_EMAIL \
      --push-auth-token-audience="${US_FUNDAMENTALS_URL}" \
      --ack-deadline=600 \
      --message-retention-duration=7d \
      --min-retry-delay=10s \
      --max-retry-delay=600s \
      --dead-letter-topic="$DL_TOPIC_PATH" \
      --max-delivery-attempts=$MAX_DELIVERY_ATTEMPTS \
      --quiet 2>/dev/null; then
      echo -e "   ${YELLOW}Created subscription: $SUB_NAME -> ${US_FUNDAMENTALS_URL}/jobs/${BASE_TOPIC} (DLQ: ${DL_TOPIC})${NC}"
    else
      # The service EXISTS — this loop only runs when EDGAR_PUSH_READY=1 — so a
      # failure here is BROKEN, not "not built yet", and the script exits 1.
      EDGAR_PUSH_FAILURES=$((EDGAR_PUSH_FAILURES + 1))
      echo -e "   ${RED}Failed to create subscription: $SUB_NAME${NC}"
    fi
  fi
done

# MONEY-1204: the DEAD-LETTER topic gets a consumer of its own.
#
# MONEY-841 attached a dead-letter policy to every worker subscription above, so
# a message that fails 5 deliveries is parked on `dead-letter-${ENV}` instead of
# redelivering forever. That half worked: the retry storm stopped, and so did
# any notice that a job had failed permanently — the topic had NO subscription,
# so parked messages aged out after the 7d retention unseen.
#
# Three things are deliberately DIFFERENT from the loop above:
#   1. NO --dead-letter-topic. A DLQ for the DLQ is a loop with extra steps.
#      The consumer never nacks (it returns 200 on every path, including its own
#      internal failures), so there is nothing to escalate to.
#   2. A SHORT ack deadline. The handler logs one line and writes one
#      notification; 600s of invisibility on a stuck instance buys nothing.
#   3. NO auto-retry of the original job — that is the processor's contract, not
#      the subscription's, and it is the whole point: a message here has already
#      been tried MAX_DELIVERY_ATTEMPTS times.
DL_SUB_NAME="dead-letter-${ENV}-push"
if gcloud pubsub subscriptions describe $DL_SUB_NAME &>/dev/null 2>&1; then
  echo -e "   ${GREEN}Subscription $DL_SUB_NAME already exists${NC}"
  gcloud pubsub subscriptions update $DL_SUB_NAME \
    --push-endpoint="${SERVICE_URL}/jobs/dead-letter" \
    --push-auth-service-account=$SA_EMAIL \
    --push-auth-token-audience="${SERVICE_URL}" \
    --quiet 2>/dev/null || true
  echo "   Updated endpoint -> ${SERVICE_URL}/jobs/dead-letter (audience: ${SERVICE_URL}, no DLQ of its own)"
else
  gcloud pubsub subscriptions create $DL_SUB_NAME \
    --topic=$DL_TOPIC \
    --push-endpoint="${SERVICE_URL}/jobs/dead-letter" \
    --push-auth-service-account=$SA_EMAIL \
    --push-auth-token-audience="${SERVICE_URL}" \
    --ack-deadline=60 \
    --message-retention-duration=7d \
    --min-retry-delay=10s \
    --max-retry-delay=600s \
    --quiet 2>/dev/null \
    && echo -e "   ${YELLOW}Created subscription: $DL_SUB_NAME -> ${SERVICE_URL}/jobs/dead-letter${NC}" \
    || echo -e "   ${RED}Failed to create subscription: $DL_SUB_NAME${NC}"
fi

# ============================================
# Grant IAM permissions
# ============================================
echo ""
echo -e "${BLUE}5. Granting IAM permissions...${NC}"

# Get project number (needed for Pub/Sub service agent)
PROJECT_NUMBER=$(gcloud projects describe $PROJECT_ID --format='value(projectNumber)')
PUBSUB_SA="service-${PROJECT_NUMBER}@gcp-sa-pubsub.iam.gserviceaccount.com"

# Pub/Sub Publisher role (for web app to publish messages)
gcloud projects add-iam-policy-binding $PROJECT_ID \
  --member="serviceAccount:$SA_EMAIL" \
  --role="roles/pubsub.publisher" \
  --condition=None --quiet 2>/dev/null
echo -e "   ${GREEN}Granted pubsub.publisher to $SA_EMAIL${NC}"

# Allow Pub/Sub service agent to create OIDC tokens as the SA
# (required for push subscriptions with --push-auth-service-account)
gcloud iam service-accounts add-iam-policy-binding $SA_EMAIL \
  --member="serviceAccount:$PUBSUB_SA" \
  --role="roles/iam.serviceAccountTokenCreator" \
  --quiet 2>/dev/null
echo -e "   ${GREEN}Granted iam.serviceAccountTokenCreator to Pub/Sub service agent${NC}"

# MONEY-841 dead-letter forwarding: the Pub/Sub service agent must be able to
# PUBLISH dead-lettered messages to the DL topic, and to ACK them off the source
# subscription. Without BOTH, the dead-letter policy is configured but silently
# inert (messages keep redelivering instead of being parked).
gcloud pubsub topics add-iam-policy-binding "dead-letter-${ENV}" \
  --member="serviceAccount:$PUBSUB_SA" \
  --role="roles/pubsub.publisher" \
  --quiet 2>/dev/null \
  && echo -e "   ${GREEN}Granted pubsub.publisher on dead-letter-${ENV} to Pub/Sub service agent${NC}" \
  || echo -e "   ${YELLOW}Could not grant pubsub.publisher on dead-letter-${ENV}${NC}"

for BASE_TOPIC in "${BASE_WORKER_TOPICS[@]}"; do
  SUB_NAME="${BASE_TOPIC}-${ENV}-push"
  gcloud pubsub subscriptions add-iam-policy-binding "$SUB_NAME" \
    --member="serviceAccount:$PUBSUB_SA" \
    --role="roles/pubsub.subscriber" \
    --quiet 2>/dev/null || true
done
echo -e "   ${GREEN}Granted pubsub.subscriber on worker subscriptions to Pub/Sub service agent (DLQ ack)${NC}"

# MONEY-979 — the EDGAR subscriptions need the same DLQ-ack grant. Without it
# their dead-letter policy is configured but silently INERT: messages keep
# redelivering instead of being parked, which looks like a retry storm rather
# than a missing IAM binding.
#
# MONEY-979 round-2 — this loop ended `--quiet 2>/dev/null || true` and the
# GREEN "Granted …" line below it ran UNCONDITIONALLY. That is byte-for-byte the
# reporting shape the subscription-update branch above says this ticket exists
# to remove ("a failed update PRINTED 'Updated endpoint →' and exited 0"),
# rebuilt one call site over: all seven grants could fail and the run still
# printed the grant as done and ended on "Pub/Sub Setup Complete!" with exit 0.
# The consequence is the one written three lines up — an inert dead-letter
# policy, i.e. a retry storm — so it is counted, and success is only claimed
# when every grant succeeded.
if [ "$EDGAR_PUSH_READY" = "1" ]; then
  EDGAR_ACK_GRANT_FAILURES=0
  for BASE_TOPIC in "${EDGAR_TOPICS[@]}"; do
    SUB_NAME="${BASE_TOPIC}-${ENV}-push"
    if gcloud pubsub subscriptions add-iam-policy-binding "$SUB_NAME" \
      --member="serviceAccount:$PUBSUB_SA" \
      --role="roles/pubsub.subscriber" \
      --quiet 2>/dev/null; then
      :
    else
      EDGAR_ACK_GRANT_FAILURES=$((EDGAR_ACK_GRANT_FAILURES + 1))
      EDGAR_PUSH_FAILURES=$((EDGAR_PUSH_FAILURES + 1))
      echo -e "   ${RED}FAILED to grant pubsub.subscriber on ${SUB_NAME}${NC}"
    fi
  done
  if [ "$EDGAR_ACK_GRANT_FAILURES" -eq 0 ]; then
    echo -e "   ${GREEN}Granted pubsub.subscriber on EDGAR subscriptions to Pub/Sub service agent (DLQ ack)${NC}"
  else
    echo -e "   ${RED}${EDGAR_ACK_GRANT_FAILURES} of ${#EDGAR_TOPICS[@]} EDGAR DLQ-ack grants FAILED — the${NC}"
    echo -e "   ${RED}dead-letter policy on those subscriptions is configured but INERT:${NC}"
    echo -e "   ${RED}messages redeliver forever instead of parking, which reads as a retry storm.${NC}"
  fi
else
  echo -e "   ${YELLOW}Skipped the EDGAR DLQ-ack grant — those subscriptions were not created.${NC}"
fi

# Cloud Run Invoker role (for Pub/Sub to call the Cloud Run service)
# The SA specified in --push-auth-service-account needs run.invoker on the service
gcloud run services add-iam-policy-binding stockbook-workers-${ENV} \
  --region=$REGION \
  --member="serviceAccount:$SA_EMAIL" \
  --role="roles/run.invoker" \
  --quiet 2>/dev/null \
  && echo -e "   ${GREEN}Granted run.invoker on stockbook-workers-${ENV}${NC}" \
  || echo -e "   ${YELLOW}Could not grant run.invoker (service may not exist yet)${NC}"

# MONEY-979 — the SAME grant on the SECOND service. `ingress: internal` keeps
# the public out; run.invoker is what lets the push SA in, and the two are
# independent. Missing it makes every EDGAR delivery 403 at the Cloud Run edge,
# before the OIDC gate in the app ever sees the request — so the service's own
# logs stay empty and the only evidence is a growing DLQ.
if gcloud run services add-iam-policy-binding us-fundamentals-${ENV} \
  --region=$REGION \
  --member="serviceAccount:$SA_EMAIL" \
  --role="roles/run.invoker" \
  --quiet 2>/dev/null; then
  echo -e "   ${GREEN}Granted run.invoker on us-fundamentals-${ENV}${NC}"
elif [ "$EDGAR_PUSH_READY" = "1" ]; then
  # Section 2 DESCRIBED this service, so "may not exist yet" is not available as
  # an explanation. The grant genuinely failed, and without it every EDGAR
  # delivery 403s at the Cloud Run edge before the app's OIDC gate sees it — the
  # service's own logs stay empty and the only evidence is a growing DLQ. Count
  # it, so the run exits non-zero.
  EDGAR_PUSH_FAILURES=$((EDGAR_PUSH_FAILURES + 1))
  echo -e "   ${RED}FAILED to grant run.invoker on us-fundamentals-${ENV} (the service EXISTS)${NC}"
elif [ "$EDGAR_DESCRIBE_BROKEN" = "1" ]; then
  # Section 2 could not decide whether the service exists, so neither can this.
  # Saying "not deployed yet" here would be the same false statement the
  # describe classifier exists to stop — and this branch is reached on a WARM
  # production every time credentials expire.
  echo -e "   ${RED}Could not grant run.invoker on us-fundamentals-${ENV}, and section 2${NC}"
  echo -e "   ${RED}could not determine whether the service exists. Not calling this 'not${NC}"
  echo -e "   ${RED}deployed yet' — the run already exits 1 for the describe failure.${NC}"
else
  echo -e "   ${YELLOW}Skipped run.invoker on us-fundamentals-${ENV} (service not deployed yet)${NC}"
fi

# ============================================
# Done
# ============================================
echo ""
if [ "$EDGAR_PUSH_READY" = "1" ] && [ "$EDGAR_PUSH_FAILURES" -eq 0 ] \
   && [ "$EDGAR_DESCRIBE_BROKEN" != "1" ]; then
  echo "╔════════════════════════════════════════════╗"
  echo "║  Pub/Sub Setup Complete!                   ║"
  echo "╚════════════════════════════════════════════╝"
else
  echo -e "${RED}╔════════════════════════════════════════════╗${NC}"
  echo -e "${RED}║  Pub/Sub Setup INCOMPLETE                  ║${NC}"
  echo -e "${RED}╚════════════════════════════════════════════╝${NC}"
fi
echo ""
echo "Topics:"
for BASE_TOPIC in "${BASE_TOPICS[@]}"; do
  echo "  - ${BASE_TOPIC}-${ENV}"
done
for BASE_TOPIC in "${EDGAR_TOPICS[@]}"; do
  echo "  - ${BASE_TOPIC}-${ENV}   (MONEY-979, us-fundamentals)"
done
echo "  - dead-letter-${ENV}"
echo ""
echo "Subscriptions:"
for BASE_TOPIC in "${BASE_WORKER_TOPICS[@]}"; do
  echo "  - ${BASE_TOPIC}-${ENV}-push -> ${SERVICE_URL}/jobs/${BASE_TOPIC} (DLQ: dead-letter-${ENV}, ${MAX_DELIVERY_ATTEMPTS} attempts)"
done
if [ "$EDGAR_PUSH_READY" = "1" ]; then
  for BASE_TOPIC in "${EDGAR_TOPICS[@]}"; do
    echo "  - ${BASE_TOPIC}-${ENV}-push -> ${US_FUNDAMENTALS_URL}/jobs/${BASE_TOPIC} (audience: ${US_FUNDAMENTALS_URL}, DLQ: dead-letter-${ENV})"
  done
elif [ "$EDGAR_DESCRIBE_BROKEN" = "1" ]; then
  # NOT "NOT CREATED". This run could not describe the service, so it knows
  # nothing about these subscriptions — on a warm environment they exist and are
  # healthy, and printing them as absent is a false statement about production.
  for BASE_TOPIC in "${EDGAR_TOPICS[@]}"; do
    echo "  - ${BASE_TOPIC}-${ENV}-push   UNKNOWN (could not describe us-fundamentals-${ENV}; not touched)"
  done
else
  for BASE_TOPIC in "${EDGAR_TOPICS[@]}"; do
    echo "  - ${BASE_TOPIC}-${ENV}-push   NOT CREATED (us-fundamentals-${ENV} has no URL)"
  done
fi
echo "  - dead-letter-${ENV}-push -> ${SERVICE_URL}/jobs/dead-letter (no DLQ of its own; logs + notifies, never auto-retries)"
echo ""
echo "IAM:"
echo "  - $SA_EMAIL has pubsub.publisher"
echo "  - Pub/Sub service agent can create OIDC tokens as $SA_EMAIL"
echo "  - $SA_EMAIL has run.invoker on stockbook-workers-${ENV}"
echo "  - Pub/Sub service agent has pubsub.publisher on dead-letter-${ENV} + pubsub.subscriber on the worker subs (DLQ forwarding)"
echo ""
echo "To test locally, send a Pub/Sub push message:"
echo '  curl -X POST http://localhost:8081/jobs/trade-pairing \'
echo '    -H "Content-Type: application/json" \'
echo '    -d '"'"'{"message":{"data":"eyJqb2JJZCI6InRlc3QiLCJ1c2VySWQiOiJ1MSJ9","messageId":"123","publishTime":"2026-01-30T00:00:00Z"},"subscription":"test"}'"'"
echo ""

# MONEY-979 / T15 — the exit code carries FOUR states, not two.
#
# MONEY-979 round-2 — EDGAR_PUSH_STATUS_FILE is how a CALLER learns which one
# happened without parsing this output or reading the exit code (NOT-BUILT and
# COMPLETE both exit 0, deliberately). `scripts/ops/setup-infra.sh` reads it so
# its own closing banner can stop saying "Complete!" over an unfinished ladder.
# Unset by every human caller, and writing it is never allowed to fail the run.
edgar_status_write() {
  if [ -n "${EDGAR_PUSH_STATUS_FILE:-}" ]; then
    printf '%s\n' "$1" > "$EDGAR_PUSH_STATUS_FILE" 2>/dev/null || true
  fi
  return 0
}

# UNKNOWN (exit 1). We could not establish whether us-fundamentals-${ENV}
# exists, so every EDGAR conclusion below would be a guess. Checked FIRST,
# because READY is 0 in this state and the NOT-YET-BUILT block below would
# otherwise print "the service does not exist" — the exact false statement this
# classification exists to prevent.
if [ "$EDGAR_DESCRIBE_BROKEN" = "1" ]; then
  edgar_status_write "BROKEN"
  echo -e "${RED}FAILED: could not determine the state of us-fundamentals-${ENV} (see section 2).${NC}"
  echo -e "${RED}This run touched NO EDGAR subscription. It is not a report that they are${NC}"
  echo -e "${RED}missing — on a warm environment they exist and are fine.${NC}"
  echo ""
  echo "Check the cause, then re-run:"
  echo "  gcloud auth list"
  echo "  gcloud config get-value project"
  echo "  gcloud run services describe us-fundamentals-${ENV} --region=${REGION}"
  echo ""
  exit 1
fi

# BROKEN (exit 1). A create / update / IAM call whose OWN precondition held
# still failed. Nothing about the ladder explains that, so a caller must stop: a
# stale audience 401s every delivery, a missing run.invoker 403s at the Cloud
# Run edge before the app ever logs a request, and a topic that failed to be
# created drops every publish to it.
#
# NOT gated on EDGAR_PUSH_READY. The topic-create loop needs no service URL, so
# a permission failure there is real on a cold environment too — and under the
# old `READY=1 &&` gate it would have been counted and then discarded.
if [ "$EDGAR_PUSH_FAILURES" -gt 0 ]; then
  edgar_status_write "BROKEN"
  echo -e "${RED}FAILED: ${EDGAR_PUSH_FAILURES} EDGAR provisioning operation(s) failed.${NC}"
  if [ "$EDGAR_PUSH_READY" = "1" ]; then
    echo -e "${RED}us-fundamentals-${ENV} is at ${US_FUNDAMENTALS_URL}, so this is not a bootstrap state.${NC}"
  else
    echo -e "${RED}These are operations that do not need the service URL, so 'not built yet'${NC}"
    echo -e "${RED}does not explain them.${NC}"
  fi
  echo ""
  echo "Re-run after fixing the cause (permissions, quota, a topic that is missing):"
  echo "  EDGAR_PUSH_REQUIRED=1 ./workers/scripts/setup-pubsub.sh ${ENV}"
  echo ""
  exit 1
fi

# NOT YET BUILT. The seven EDGAR push subscriptions do not exist, and neither
# does the service whose URL is BOTH their push endpoint and their OIDC
# audience. Reported loudly — but exit 0 by default, because this script runs as
# step 2 of `scripts/ops/setup-infra.sh` under `set -e` and step 4 is the only
# thing that BUILDS that service. Exiting 1 here made the documented "full
# setup" command self-blocking on exactly the environment it exists to create.
#
# The loudness is what replaces the exit code, and it is not decorative: a topic
# with NO subscription DROPS every message silently — no DLQ, no error, no
# metric — so `edgar-detect-minutely-${ENV}` firing 1,440x/day into one is
# invisible from every dashboard.
if [ "$EDGAR_PUSH_READY" != "1" ]; then
  edgar_status_write "NOT_BUILT"
  echo -e "${RED}INCOMPLETE: the ${#EDGAR_TOPICS[@]} EDGAR push subscriptions were NOT created.${NC}"
  echo -e "${RED}Reason: Cloud Run service us-fundamentals-${ENV} does not exist, so its${NC}"
  echo -e "${RED}URL — which is BOTH the push endpoint and the OIDC audience — is unknown.${NC}"
  echo -e "${RED}Until they exist, anything published to edgar-*-${ENV} is DROPPED silently.${NC}"
  echo ""
  echo "Fix, in this order (the ordering is the point — the deploy MINTS the URL):"
  echo "  ./scripts/ops/setup-infra.sh ${ENV}     # does all of it, in order, in one command"
  echo ""
  echo "…or by hand:"
  echo "  1. gcloud builds submit --config=services/us-fundamentals/cloudbuild.${ENV}.yaml"
  echo "  2. gcloud run services describe us-fundamentals-${ENV} --region=${REGION} --format='value(status.url)'"
  echo "  3. EDGAR_PUSH_REQUIRED=1 ./workers/scripts/setup-pubsub.sh ${ENV}"
  echo ""
  echo "Afterwards, confirm all THREE agree — the described URL, the service's own"
  echo "CLOUD_RUN_URL env (what app/auth.py verifies tokens against) and every"
  echo "subscription's audience. One character of disagreement is a silent 401 loop:"
  echo "  gcloud run services describe us-fundamentals-${ENV} --region=${REGION} --format='value(status.url)'"
  echo "  gcloud run services describe us-fundamentals-${ENV} --region=${REGION} \\"
  echo "    --format='value(spec.template.spec.containers[0].env.filter(\"name:CLOUD_RUN_URL\").extract(\"value\"))'"
  echo "  gcloud pubsub subscriptions list --format='value(name,pushConfig.oidcToken.audience)' | grep edgar-"
  echo ""
  if [ "$EDGAR_PUSH_REQUIRED" = "1" ]; then
    echo -e "${RED}EDGAR_PUSH_REQUIRED=1 — the caller has already deployed, so absence is an${NC}"
    echo -e "${RED}ERROR rather than a stage. Exiting non-zero.${NC}"
    echo ""
    exit 1
  fi
  echo -e "${YELLOW}Exiting 0: this is a bootstrap stage, not a failure. The rest of this${NC}"
  echo -e "${YELLOW}script completed, and the caller may now deploy and re-run this step.${NC}"
  echo ""
else
  edgar_status_write "COMPLETE"
fi
