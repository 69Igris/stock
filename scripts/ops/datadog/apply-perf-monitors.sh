#!/usr/bin/env bash
#
# Performance monitors over the GCP integration — MONEY-1379.
#
#   ./scripts/ops/datadog/apply-perf-monitors.sh {qa|prod} [--dry-run] [--only=verify]
#
# ## What this covers that the other two scripts do not
#
# `apply-monitors.sh` watches JOBS (did a scheduled run find work and write
# nothing, did it run at all) and `apply-service-monitors.sh` watches SERVICES
# through telemetry the app emits (APM spans, log events, RUM views). Both
# describe our code. Neither describes the PLATFORM underneath it: the Pub/Sub
# queue every worker is fed from, the Cloud Run instances that drain it, and the
# Gemini quota that ceilings anything calling a model.
#
# Those series come from Datadog's Google Cloud integration, which MONEY-1379
# installed. They are Google's OWN view, which is the point: Pub/Sub's count of
# our push endpoint failing cannot be fooled by our own error handling, and an
# instance count at maxScale is a fact about the platform that no application
# metric can express.
#
# ## Every row is PREFLIGHTED, and that is the point of the file
#
# A monitor over a series nobody emits renders as NO DATA, which is
# indistinguishable from health the moment its no-data notification is muted
# (MONEY-1238). These series are supplied by a VENDOR CRAWL rather than by our
# emitters, so there is no local constant to compare a name against — asking the
# live org whether the series has points is the only check that can exist. Each
# row asks before it writes, and `dd_metric_has_points` answers in three states:
# points (proceed), none (REFUSE this row by name, exit non-zero), or did-not-run
# (FATAL — a 403 or a rate limit must never read as "the series is empty").
#
# ## Scope is always a NAME, never `*`
#
# Two measurements force this, and a wildcard would look correct in both cases:
#
#   - `oldest_unacked_message_age by {subscription_id}` returns 190 series,
#     including `*-pull-local` subscriptions that NOTHING drains. Their oldest
#     message is always old, so a `*` monitor alerts forever on a healthy estate.
#   - `algo-api-prod` and `algo-workers-prod` are Cloud Run services in the SAME
#     project, owned by a different repo (see CLAUDE.md's ownership boundary).
#     They appear in `by {service_name}` the moment they scale above zero.
#
# The guard below refuses a `gcp.pubsub.*` or `gcp.run.*` row with a `*` scope in
# CODE, not only in the test, so it cannot be argued past in a hurry.
#
# ## It PRUNES, unlike the other two
#
# `managed-by:apply-perf-monitors` is this script's own namespace, so a monitor
# carrying it that this script did not render is an orphan by definition and is
# deleted. The other two SHARE `managed-by:apply-monitors`, so pruning from
# either would delete the other's monitors — which is why their documented
# remedy is a manual delete. `--only=verify` reports the drift without touching
# anything, and exits 3 when the repo and the org disagree.
#
# ## Known state on the day this shipped
#
# Three of these fire immediately on prod, and they are RIGHT to:
# `pubsub-dead-letter` and `workers-handler-time` on `stock-document-embed`
# (MONEY-1389 — 423 overruns in 7d against a 600s ack deadline), and
# `pubsub-handler-failure` on `broker-sync` until this branch reaches the
# release deploy. Do not mute them; they resolve when the fixes land.
#
# Needs DD_API_KEY and DD_APP_KEY (not for --dry-run). Both live in GCP Secret
# Manager as DD_API_KEY_{QA,PROD} / DD_APP_KEY_{QA,PROD}.

set -euo pipefail

ENV_ARG="${1:-}"
DRY_RUN=false
ONLY=""
for arg in "${@:2}"; do
  case "$arg" in
    --dry-run) DRY_RUN=true ;;
    --only=verify) ONLY=verify ;;
    *) echo "unknown argument: ${arg}" >&2; exit 2 ;;
  esac
done
case "$ENV_ARG" in
  prod) DD_ENV_TAG="production" ;;
  qa)   DD_ENV_TAG="qa" ;;
  *) echo "usage: $0 {qa|prod} [--dry-run] [--only=verify]" >&2; exit 2 ;;
esac

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

source "$HERE/lib-datadog.sh"
dd_resolve_api_host || exit 1

# Before the credential check, for the reason apply-service-monitors.sh gives:
# a run configured not to happen must not report a missing secret it was never
# going to use.
if [[ "$ENV_ARG" == "qa" ]] && ! dd_qa_monitoring_enabled; then
  echo "qa monitoring is disabled (DD_QA_MONITORING is not \"on\") — nothing applied."
  echo "Re-enable with: DD_QA_MONITORING=on $(basename "$0") qa"
  exit 0
fi

if ! $DRY_RUN; then
  ENV_UPPER="$(printf %s "$ENV_ARG" | tr '[:lower:]' '[:upper:]')"
  : "${DD_API_KEY:?export DD_API_KEY first (GCP Secret Manager: DD_API_KEY_${ENV_UPPER})}"
  : "${DD_APP_KEY:?export DD_APP_KEY first (GCP Secret Manager: DD_APP_KEY_${ENV_UPPER})}"
fi

NOTIFY="${DD_NOTIFY:-deepshaswat@gmail.com}"
MANAGED_TAG="managed-by:apply-perf-monitors"

# THE LISTING IS ENV-SCOPED, and that is load-bearing rather than tidy.
#
# `monitor_tags` ANDs comma-separated tags (verified against the live API:
# `managed-by:apply-monitors,env:production` returns 75, `,env:qa` returns 0).
# Without the env term the listing is CROSS-ENVIRONMENT, and a row skipped
# because it is not in this env never reaches the rendered set — so the pruner
# reads the OTHER environment's monitors as orphans. Reproduced before fixing:
# `DD_QA_MONITORING=on apply-perf-monitors.sh qa` issued two DELETEs against
# `[production]` monitors and reported `pruned 2`. The first qa run after that
# switch is flipped would have deleted every prod perf monitor, with its history
# and its mute state, and reported success.
LIST_TAG="${MANAGED_TAG},env:${DD_ENV_TAG}"

FAILED=()
APPLIED=0
SKIPPED=0
PRUNED=0
RENDERED_NAMES=()
RENDERED_QUERIES=()
EXISTING_JSON="[]"
$DRY_RUN || dd_list_managed "$LIST_TAG"

# ── The rows ────────────────────────────────────────────────────────────────
#
#   id|envs|warn|crit|window|notify_no_data
#
# ONLY the tunables live here. The query parts are in `row_spec` below, because
# three of them are 200+ characters and a fourteen-column table is not something
# a human reviews — while a threshold IS something a human tunes, and these six
# fields are what a reviewer needs side by side.
#
# `envs` is stated rather than derived. apply-monitors.sh reads prod-only-ness
# off the scheduler; a Pub/Sub subscription has no scheduler entry, so it is
# declared. A row created for an environment that does not run the thing is a
# monitor that has never once been green, and one of those is a monitor somebody
# mutes.
#
# An EMPTY `warn` means the row has no warning threshold. Row 2 is `> 0`, where a
# warning would have to be some value below zero. `dd_render` coerces a threshold
# string with Number(), and `Number("")` is 0 — so the empty field would render as
# `warning: 0` on a `> 0` monitor, which reads as a permanently-breached warning.
# The key is DELETED after rendering; see step 6 in the loop.
ROWS=(
  # Pub/Sub. Both envs: QA runs the same push subscriptions, and the QA rows are
  # skipped by the DD_QA_MONITORING gate above until the founder flips it.
  "pubsub-oldest-unacked|prod,qa|300|480|10m|true"
  "pubsub-dead-letter|prod,qa||0|5m|false"
  "pubsub-handler-failure|prod,qa|0.05|0.20|15m|false"

  # Cloud Run. Prod only — a QA worker's saturation says nothing about the
  # platform, and us-fundamentals has no QA deployment at all.
  "workers-handler-time|prod|480000|540000|15m|true"
  # notify_no_data FALSE on the two saturation rows, and it is forced by the
  # grouping rather than chosen. They group by revision_name (see row_spec), a
  # Cloud Run revision name changes on every release, and the retired revision
  # stops emitting within minutes — measured 2026-09-11: two revisions in 24h,
  # the older one's series already ended. With notify_no_data the RETIRED
  # group flips to No Data 30 minutes after each deploy and re-notifies hourly
  # for as long as Datadog retains the group (~24h, and group_retention_duration
  # is not settable on a metric monitor). That is a page on every release —
  # exactly the false page grouping by revision was meant to remove, arriving
  # through the other door.
  #
  # Nothing is lost: a stopped GCP crawl is what notify_no_data protects
  # against here, and four sibling rows (oldest-unacked, handler-time,
  # queueing, gemini-quota) still carry it and are not grouped by anything
  # ephemeral.
  #
  # ONE HALF OF THE RETENTION REMAINS, deliberately. A group that is IN ALERT
  # when it stops reporting stays in that state until retention drops it, and
  # renotify_interval keeps re-notifying — so a release made WHILE SATURATED can
  # re-notify about a revision that no longer exists. That is every release made
  # while already paged, against every release before; and
  # `group_retention_duration` is not settable on a metric monitor, so there is
  # no third option. Named here so the next reader does not diagnose it as the
  # page-on-every-deploy this row already fixed.
  "workers-saturation|prod|16|18|10m|false"
  "usfund-saturation|prod|8|9|10m|false"
  "workers-queueing|prod|1|5|10m|true"

  # One GCP project, one quota, one scheduler — these have no env dimension and
  # are created once, against prod.
  "gemini-token-quota|prod|0.70|0.85|15m|true"
  "scheduler-errors|prod|0|1|1h|false"
)

# ── Per-row query construction ──────────────────────────────────────────────
#
# Sets: TPL TIME_AGG SPACE_AGG METRIC SCOPE GROUP SUFFIX NUM DEN FAMILY LABEL
# PREFLIGHT.
#
# TIME_AGG and SPACE_AGG are separate because they are rarely the same answer —
# see the gauge template's _readme. For the ratio template only TIME_AGG is
# used; its numerator and denominator carry their own space aggregation.
#
# A PREFLIGHT never names a series whose EMPTINESS is health. Three rows would
# otherwise refuse themselves on a healthy estate: the failure ratio (no 5xx),
# the dead-letter row (measured — that series does not exist at all until
# something is parked) and the scheduler row (no errors). Each preflights a
# sibling series that proves the CRAWL is alive instead.
#
# LABEL becomes the monitor's NAME, and names must be STABLE: `dd_upsert_monitor`
# matches on the name, and `dd_prune_managed` deletes anything unmatched — so a
# name carrying a threshold would, on the day somebody tunes that threshold,
# delete the monitor along with its history and mute state and create a stranger
# in its place. None of these names contains a number.
#
# PREFLIGHT is a newline-separated list of metric queries that must have points
# before the row may be created.
row_spec() {
  TPL=""; TIME_AGG=""; SPACE_AGG=""; METRIC=""; SCOPE=""; GROUP=""; SUFFIX=""
  NUM=""; DEN=""; FAMILY=""; LABEL=""; PREFLIGHT=""
  local PUSH="subscription_id:*-${ENV_ARG}-push"
  local PRC="gcp.pubsub.subscription.push_request_count"
  local GQ="gcp.generativelanguage.quota.generate_content_paid_tier_3_input_token_count"
  local SCHED="log:cloudscheduler.googleapis.com/executions"

  case "$1" in
    pubsub-oldest-unacked)
      TPL=monitor-gcp-gauge-by-group.json
      # An AGE: `max` across series IS the question — the oldest message.
      TIME_AGG=max; SPACE_AGG=max
      METRIC=gcp.pubsub.subscription.oldest_unacked_message_age
      SCOPE="$PUSH"; GROUP=subscription_id
      FAMILY=pubsub-backlog
      LABEL="Pub/Sub — oldest unacked message age"
      PREFLIGHT="max:${METRIC}{${SCOPE}}"
      ;;
    pubsub-dead-letter)
      TPL=monitor-gcp-gauge-by-group.json
      # A COUNT, and the metric carries a `response_code` tag — sum across it.
      TIME_AGG=max; SPACE_AGG=sum
      METRIC=gcp.pubsub.subscription.dead_letter_message_count
      SCOPE="$PUSH"; GROUP=subscription_id
      FAMILY=pubsub-poison
      LABEL="Pub/Sub — dead-lettered messages"
      # NOT this row's own metric. Measured 2026-09-11: on a subscription with
      # no dead letters `dead_letter_message_count` returns NO SERIES AT ALL —
      # it is not a gauge that reports 0, it simply does not exist until
      # something is parked. Preflighting it would refuse this row on exactly
      # the healthy estate it exists to watch, and (worse) hand the pruner a
      # name it never rendered. Preflight the CRAWL instead: if push_request_count
      # is arriving for these subscriptions, Pub/Sub is being crawled and the
      # dead-letter series will arrive the moment there is one.
      PREFLIGHT="sum:${PRC}{${PUSH}}"
      ;;
    pubsub-handler-failure)
      TPL=monitor-gcp-ratio-by-group.json
      # The ratio template takes ONE aggregator and it is the TIME one; the
      # numerator and denominator carry their own space aggregation.
      TIME_AGG=sum
      METRIC="$PRC"
      SCOPE="$PUSH"; GROUP=subscription_id
      # 5xx is the route throwing; `unreachable` is the service down or timing
      # out. `remote_server_4xx` is deliberately ABSENT: that is our own
      # pubsubDedupeMiddleware answering 409 RETRY_LATER to a redelivery whose
      # claim is still live, which is the dedupe working. Counting it would put
      # a permanent floor under the ratio and force the threshold up past the
      # signal (1,622 of them on stock-document-embed in 7 days).
      NUM="sum:${PRC}{${PUSH},response_class:remote_server_5xx} by {${GROUP}}.as_count() + sum:${PRC}{${PUSH},response_class:unreachable} by {${GROUP}}.as_count()"
      DEN="sum:${PRC}{${PUSH}} by {${GROUP}}.as_count()"
      FAMILY=pubsub-failure
      LABEL="Pub/Sub — push handler failure rate"
      # The DENOMINATOR only. Preflighting the numerator would refuse this row
      # in exactly the state it exists to detect the end of: no 5xx anywhere is
      # the HEALTHY estate, and a healthy estate must not be a reason to skip
      # creating the alarm that watches for an unhealthy one.
      PREFLIGHT="sum:${PRC}{${PUSH}}"
      ;;
    workers-handler-time)
      TPL=monitor-gcp-percentile.json
      METRIC=gcp.run.request_latency.user_execution.p95
      SCOPE="service_name:stockbook-workers-${ENV_ARG}"
      FAMILY=run-latency
      LABEL="Cloud Run workers — p95 handler time"
      PREFLIGHT="avg:${METRIC}{${SCOPE}}"
      ;;
    workers-saturation)
      TPL=monitor-gcp-gauge-by-group.json
      # SUM, not max. This metric carries a `state` tag (active / idle), so
      # `max:` reads max(active, idle) — a service at its cap of 20 as 12
      # active + 8 idle evaluates to 12 and never crosses `> 18`. Measured
      # 2026-09-11: both states are live, idle peaking at 2.
      TIME_AGG=max; SPACE_AGG=sum
      METRIC=gcp.run.container.instance_count
      # Grouped by REVISION as well as service. maxScale is a per-revision
      # annotation, and two revisions overlap on every deploy — so summing them
      # into one service figure would cross 18 while neither revision is near
      # its own cap of 20, turning a silent miss into a false page every
      # rollout. Per revision, the threshold means what it was sized to mean.
      SCOPE="service_name:stockbook-workers-${ENV_ARG}"; GROUP="service_name,revision_name"
      FAMILY=run-saturation
      LABEL="Cloud Run workers — instances at maxScale"
      # Preflighted BY THE GROUP, not just by the metric. "the metric has
      # points" says nothing about whether the crawl imports `revision_name` as
      # a tag, and a `by {}` over a tag nobody emits returns ZERO series — a
      # monitor in permanent NO DATA, which is the one thing this file exists to
      # refuse. The `state` half of this row's aggregation was measured; this
      # half has to be too. (Measured 2026-09-11: 2 revision groups live.)
      PREFLIGHT="max:${METRIC}{${SCOPE}} by {${GROUP}}"
      ;;
    usfund-saturation)
      TPL=monitor-gcp-gauge-by-group.json
      # SUM across the `state` tag, grouped by revision — see workers-saturation.
      TIME_AGG=max; SPACE_AGG=sum
      METRIC=gcp.run.container.instance_count
      SCOPE="service_name:us-fundamentals-${ENV_ARG}"; GROUP="service_name,revision_name"
      FAMILY=run-saturation
      LABEL="Cloud Run us-fundamentals — instances at maxScale"
      # By the GROUP — see workers-saturation.
      PREFLIGHT="max:${METRIC}{${SCOPE}} by {${GROUP}}"
      ;;
    workers-queueing)
      TPL=monitor-gcp-gauge-by-group.json
      # SUM: Cloud Run reports this per REVISION and two overlap on every
      # deploy, so max would report the deeper queue rather than the real one.
      TIME_AGG=max; SPACE_AGG=sum
      METRIC=gcp.run.pending_queue.pending_requests
      SCOPE="service_name:stockbook-workers-${ENV_ARG}"; GROUP=service_name
      FAMILY=run-saturation
      LABEL="Cloud Run workers — requests queued"
      PREFLIGHT="max:${METRIC}{${SCOPE}}"
      ;;
    gemini-token-quota)
      TPL=monitor-gcp-ratio-by-group.json
      TIME_AGG=avg
      METRIC="${GQ}.usage"
      # The one permitted `*`, allow-listed in the scope guard below: there is
      # one GCP project and one quota, and the series carries no env dimension
      # to narrow by. Grouping is by MODEL, which is the axis that matters.
      SCOPE="*"; GROUP=model
      NUM="avg:${GQ}.usage{*} by {${GROUP}}"
      DEN="avg:${GQ}.limit{*} by {${GROUP}}"
      FAMILY=gemini-quota
      LABEL="Gemini — input-token quota utilisation"
      # BOTH sides here, unlike the failure ratio: these are quota GAUGES that
      # report every minute whether or not anything is calling the model, so an
      # empty `usage` means the crawl stopped rather than that the estate is
      # healthy. A missing `limit` is worse — the ratio would divide by nothing.
      PREFLIGHT="avg:${GQ}.usage{*}
avg:${GQ}.limit{*}"
      ;;
    scheduler-errors)
      TPL=monitor-gcp-gauge-by-group.json
      TIME_AGG=sum; SPACE_AGG=sum
      SUFFIX=".as_count()"
      METRIC=gcp.logging.log_entry_count
      SCOPE="${SCHED},severity:error,job_id:*-${ENV_ARG}"; GROUP=job_id
      FAMILY=scheduler
      LABEL="Cloud Scheduler — failed publish attempts"
      # The UN-SLICED series. Cloud Scheduler emits no Cloud Monitoring metric at
      # all, so this rides the built-in log-entry counter; the `severity:error`
      # slice is empty on a healthy day (2 entries per job per MONTH), while the
      # log itself carries one INFO entry per attempt — 5,050 in six hours. The
      # un-sliced query is what proves the crawl is alive.
      PREFLIGHT="sum:${METRIC}{${SCHED},job_id:*-${ENV_ARG}}"
      ;;
    *)
      echo "FATAL: unknown row id '$1'" >&2
      exit 1
      ;;
  esac
}

# ── What the alert SAYS at 3 a.m. ───────────────────────────────────────────
#
# NO BARE `{{value}}` ANYWHERE IN HERE, however tempting. `dd_render`'s final
# guard is `JSON.stringify(filled).match(/\{\{\w+\}\}/g)`, which runs over the
# WHOLE body after substitution — so a Datadog template variable that is a
# single word survives `fill()` and then trips that guard, and the render dies
# with "unsubstituted placeholders: {{value}}". Dotted ones are safe (`\w+`
# cannot cross a `.`), which is why the group variables below are all
# `{{something.name}}`. The threshold is stated in prose instead; `include_tags`
# already carries the group onto the notification.
message_for() {
  case "$1" in
    pubsub-oldest-unacked)
      printf '%s' "Oldest unacked message on {{subscription_id.name}} is past 480s of the 600s Pub/Sub ack deadline.

A handler is overrunning. At 600s Pub/Sub REDELIVERS while the first copy is still running; our dedupe middleware answers 409 until the lease expires, and after 5 attempts the message is DEAD-LETTERED while the original still succeeds.

Check gcp.run.request_latency.user_execution.p95 over the same window, then that handler's RUN_TIME_BUDGET_MS. stock-document-embed has none — MONEY-1389."
      ;;
    pubsub-dead-letter)
      printf '%s' "Pub/Sub dead-lettered messages on {{subscription_id.name}}.

Known causes as of 2026-09-11: stock-document-embed's 600s overrun (MONEY-1389), and broker-sync's empty-shard 500s — FIXED on fix/MONEY-1379 (task T0-B), so broker-sync appearing here AFTER that deploy means the shard guard or the Zerodha-only filter regressed.

Anything else is new. Read the [dead-letter] log line from /jobs/dead-letter for sourceJob."
      ;;
    pubsub-handler-failure)
      printf '%s' "Pub/Sub's OWN count of our push endpoint failing on {{subscription_id.name}} — 5xx + unreachable, over all delivery responses. Independent of what the app reports about itself.

remote_server_5xx is the route throwing; unreachable is the service down or timing out. 409s are excluded on purpose: those are the dedupe middleware refusing to run a redelivery twice, which is it working."
      ;;
    workers-handler-time)
      printf '%s' "p95 handler time on stockbook-workers is past 540s (540000ms). The Pub/Sub ack deadline is 600s, so the tail is already being redelivered — and a redelivery of a still-running job burns delivery attempts until it dead-letters.

Find the route:
gcloud logging read 'resource.type=\"cloud_run_revision\" AND resource.labels.service_name=\"stockbook-workers-prod\" AND httpRequest.latency>\"600s\"' --freshness=1h --format=\"value(httpRequest.requestUrl)\" | sort | uniq -c"
      ;;
    workers-saturation|usfund-saturation)
      printf '%s' "{{service_name.name}} is at or above its instance cap (stockbook-workers maxScale 20, us-fundamentals 10). New pushes queue behind it — check pending_requests on the workers-performance board.

Either the work per message is too large (the usual cause here — see MONEY-1389) or maxScale needs raising in workers/cloudbuild.prod.yaml."
      ;;
    workers-queueing)
      printf '%s' "Requests are queued on {{service_name.name}} with no instance free to take them — instances are at the cap, or cold-starting.

Pair this with instance_count and container.startup_latencies.p95 on the workers-performance board: at the cap is a sizing problem, cold starts are a warm-up problem, and they need opposite fixes."
      ;;
    gemini-token-quota)
      printf '%s' "Gemini input-token quota for {{model.name}} is past 85% of the 20,000,000 tokens/minute limit — Google's own gauge, not our accounting.

At 100% every research, analysis and chat call gets a 429 and the credit-refund path fires.

The REQUESTS quota on this tier reads INT64_MAX (unlimited), so tokens are the only real ceiling and there is deliberately no monitor over requests."
      ;;
    scheduler-errors)
      printf '%s' "Cloud Scheduler failed to publish {{job_id.name}}'s tick more than once in the last hour — DEADLINE_EXCEEDED on the Publish RPC, which is GCP-side and not our handler.

MOST JOBS DO NOT RETRY. setup-scheduler.sh sets --max-retry-attempts from a NAMED allow-list and only news-rss-sync is on it, so for every other job retryCount is an explicit 0 and each error here is ONE TICK SILENTLY LOST — not a retry that also failed. Do not read a single error as transient-and-handled unless the job is news-rss-sync.

gcloud logging read 'resource.type=\"cloud_scheduler_job\" AND severity>=ERROR' --freshness=2h"
      ;;
    *)
      echo "FATAL: no message for row '$1'" >&2
      exit 1
      ;;
  esac
}

# ── Apply ───────────────────────────────────────────────────────────────────

for ROW in "${ROWS[@]}"; do
  IFS='|' read -r ID ENVS WARN CRIT WINDOW NODATA <<< "$ROW"

  if [[ ",${ENVS}," != *",${ENV_ARG},"* ]]; then
    echo "skipping (${ENV_ARG} not in ${ENVS}): ${ID}"
    SKIPPED=$((SKIPPED + 1))
    continue
  fi

  row_spec "$ID"

  # Scope guard, in CODE and not only in the test. See the header: a `*` here
  # sweeps in 190 Pub/Sub subscriptions including undrained local ones, and two
  # Cloud Run services this repo does not own.
  case "$METRIC" in
    gcp.pubsub.*|gcp.run.*)
      if [[ -z "$SCOPE" || "$SCOPE" == "*" ]]; then
        echo "FATAL: ${ID}: a ${METRIC%%.*}.${METRIC#*.} row may not use scope '*' — it would" >&2
        echo "       sweep in subscriptions nothing drains and services this repo does not own." >&2
        exit 1
      fi
      ;;
  esac

  # Preflight. Three outcomes, never two: `dd_metric_has_points` returns 0 for
  # points, 1 for none, and 2 for did-not-run. Collapsing 1 and 2 would let a
  # bad app key or one 429 read as "the series is empty" and refuse a row on a
  # measurement that never happened.
  PREFLIGHT_FAILED=false
  while IFS= read -r Q; do
    [[ -z "$Q" ]] && continue
    rc=0
    dd_metric_has_points "$Q" 3600 || rc=$?
    case "$rc" in
      0) ;;
      1)
        FAILED+=("${ID}: no points in 1h for ${Q} — either the GCP integration's crawl has stopped or the scope names nothing. A monitor over it would sit in NO DATA, which is indistinguishable from health. Not created.")
        PREFLIGHT_FAILED=true
        break
        ;;
      *)
        echo "FATAL: ${ID}: the preflight DID NOT RUN (HTTP ${RESPONSE_STATUS})." >&2
        echo "       Check DD_APP_KEY, the site, and the rate limit. Refusing to continue —" >&2
        echo "       a query that never ran must never be read as an empty series." >&2
        exit 1
        ;;
    esac
  done <<< "$PREFLIGHT"
  $PREFLIGHT_FAILED && continue

  # no_data_timeframe = 3x the window. Long enough that one missed crawl cycle
  # does not page, short enough to notice a stopped integration within a work
  # break. The GCP integration crawls on the order of minutes.
  W="${WINDOW%m}"
  case "$WINDOW" in *h) W=$(( ${WINDOW%h} * 60 )) ;; esac
  NDT=$(( W * 3 ))

  VARS="$(
    P_ENV="$DD_ENV_TAG" P_LABEL="$LABEL" P_TIME_AGG="$TIME_AGG" \
    P_SPACE_AGG="$SPACE_AGG" P_METRIC="$METRIC" \
    P_SCOPE="$SCOPE" P_GROUP="$GROUP" P_SUFFIX="$SUFFIX" P_NUM="$NUM" P_DEN="$DEN" \
    P_WINDOW="$WINDOW" P_CRIT="$CRIT" P_WARN="$WARN" P_FAMILY="$FAMILY" \
    P_MESSAGE="$(message_for "$ID")" P_NOTIFY="$NOTIFY" \
    P_NODATA="$NODATA" P_NDT="$NDT" node -e '
      console.log(JSON.stringify({
        env: process.env.P_ENV,
        label: process.env.P_LABEL,
        agg: process.env.P_TIME_AGG,
        time_agg: process.env.P_TIME_AGG,
        space_agg: process.env.P_SPACE_AGG,
        metric: process.env.P_METRIC,
        scope: process.env.P_SCOPE,
        group: process.env.P_GROUP,
        suffix: process.env.P_SUFFIX,
        num: process.env.P_NUM,
        den: process.env.P_DEN,
        window: process.env.P_WINDOW,
        critical: process.env.P_CRIT,
        warning: process.env.P_WARN,
        family: process.env.P_FAMILY,
        message: process.env.P_MESSAGE,
        notify: process.env.P_NOTIFY,
        notify_no_data: process.env.P_NODATA,
        no_data_timeframe: process.env.P_NDT,
      }));
    '
  )"

  BODY="$(dd_render "$HERE/$TPL" "$VARS")" || {
    FAILED+=("${ID}: render failed — an unknown or unsubstituted placeholder. If the message carries a bare {{word}}, that is the cause: dd_render's final guard re-scans the rendered body.")
    continue
  }

  # Step 6: an absent warning must be ABSENT, not 0. `Number("")` is 0, and a
  # warning of 0 on a `> 0` monitor is permanently breached.
  if [[ -z "$WARN" ]]; then
    BODY="$(BODY="$BODY" node -e '
      const b = JSON.parse(process.env.BODY);
      delete b.options.thresholds.warning;
      console.log(JSON.stringify(b));
    ')"
  fi

  RENDERED_NAMES+=("$(BODY="$BODY" node -e 'console.log(JSON.parse(process.env.BODY).name)')")
  RENDERED_QUERIES+=("$(BODY="$BODY" node -e 'console.log(JSON.parse(process.env.BODY).query)')")

  if [[ "$ONLY" == verify ]]; then
    APPLIED=$((APPLIED + 1))
    continue
  fi

  dd_upsert_monitor "$ID" "$BODY" || true
done

# ── Verify: does the org match the repo? ────────────────────────────────────
if [[ "$ONLY" == verify ]]; then
  rc=0
  # Rows REFUSED by their preflight were never rendered, so they are absent
  # from BOTH sets below and the three counts do not add up to the row count
  # without this. Reporting them is what makes the arithmetic checkable — and
  # a refused row is its own answer anyway: a row whose series has no points is
  # a row whose monitor should not exist.
  if ((${#FAILED[@]} > 0)); then
    echo "${#FAILED[@]} row(s) COULD NOT BE VERIFIED — refused by their own preflight,"
    echo "so they were never rendered and appear in neither set below:"
    printf '  ! %s\n' "${FAILED[@]}"
    echo ""
  fi
  # true: managed-by:apply-perf-monitors is this script's own namespace, so an
  # unrendered monitor under it IS an orphan and does fail the check.
  dd_verify_managed "$LIST_TAG" true \
    "${RENDERED_NAMES[@]+"${RENDERED_NAMES[@]}"}" || rc=$?

  # Names alone do not settle it. A monitor edited in the Datadog UI keeps its
  # title, so the drift that matters most — somebody widening a threshold or
  # rewriting a scope in the browser — is invisible to a name comparison.
  # `dd_verify_managed` leaves EXISTING_JSON populated, so this costs no extra
  # request.
  DRIFTED="$(
    NAMES="$(printf '%s\n' "${RENDERED_NAMES[@]+"${RENDERED_NAMES[@]}"}")" \
    QUERIES="$(printf '%s\n' "${RENDERED_QUERIES[@]+"${RENDERED_QUERIES[@]}"}")" \
    EXISTING="$EXISTING_JSON" node -e '
      const names = process.env.NAMES.split("\n").filter(Boolean);
      const queries = process.env.QUERIES.split("\n");
      const live = new Map(JSON.parse(process.env.EXISTING).map((m) => [m.name, m.query]));
      names.forEach((n, i) => {
        if (!live.has(n)) return;            // already reported as "only in code"
        if (live.get(n) !== queries[i]) console.log(n);
      });
    '
  )"
  if [[ -n "$DRIFTED" ]]; then
    echo ""
    while IFS= read -r n; do
      [[ -z "$n" ]] && continue
      echo "query differs: ${n}"
    done <<< "$DRIFTED"
    echo "A monitor was edited in the Datadog UI. Re-run without --only=verify to restore the rendered query."
    rc=3
  fi
  exit $rc
fi

# ── Prune orphans ───────────────────────────────────────────────────────────
#
# Not on a dry run: a dry run never listed, so there is nothing to compare
# against and any claim about orphans would have no evidence behind it.
#
# AND NOT WHEN ANY ROW WAS REFUSED. A row whose preflight found no points
# `continue`s before it can add its name to RENDERED_NAMES, so the pruner would
# see that row's EXISTING monitor as an orphan and DELETE it. One transient hour
# of a vendor crawl not reporting would then not merely skip the row — it would
# destroy the monitor, its history and its mute state, and that deletion would
# be the only lasting effect of a run that reports failure. Refusing to prune a
# partial render is the only safe reading: the rendered set is not the whole
# set, so "not in the rendered set" does not mean orphan.
if ! $DRY_RUN; then
  if ((${#FAILED[@]} > 0)); then
    echo "   NOT pruning — ${#FAILED[@]} row(s) were refused, so the rendered set is"
    echo "   incomplete and an unrendered monitor is not evidence of an orphan."
  else
    dd_prune_managed "$LIST_TAG" "${RENDERED_NAMES[@]+"${RENDERED_NAMES[@]}"}"
  fi
fi

if ((${#FAILED[@]} > 0)); then
  echo "" >&2
  echo "${#FAILED[@]} of ${#ROWS[@]} rows did NOT apply:" >&2
  printf '  - %s\n' "${FAILED[@]}" >&2
  exit 1
fi

# Every row must have been applied or deliberately skipped. A row that fell
# through both is a silent no-op, which is the failure this whole file is about.
if ((APPLIED + SKIPPED != ${#ROWS[@]})); then
  echo "FATAL: ${APPLIED} applied + ${SKIPPED} skipped != ${#ROWS[@]} rows" >&2
  exit 1
fi
echo "applied ${APPLIED}, skipped ${SKIPPED}, pruned ${PRUNED} of ${#ROWS[@]} rows (${ENV_ARG})"
