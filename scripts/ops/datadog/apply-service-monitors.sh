#!/usr/bin/env bash
#
# Service-level monitors — MONEY-1359.
#
#   ./scripts/ops/datadog/apply-service-monitors.sh {qa|prod} [--dry-run|--only=verify]
#
# ## What this covers that apply-monitors.sh does not
#
# That script watches JOBS: did a scheduled run find work and write nothing, and
# did it run at all. Between them those answer "is the data pipeline moving".
# They answer nothing about whether the SERVICES are erroring, whether anything
# is shouting in the logs, or whether the browser is on fire — which is the
# scope of the cancelled MONEY-450/452/454, kept here and trimmed to what the
# series we actually emit can support.
#
# ## Every row is PREFLIGHTED, and that is the point of the file
#
# A monitor over a series nobody emits renders as NO DATA, which is
# indistinguishable from health the moment its no-data notification is muted.
# That is MONEY-1238's finding (a), and it shipped because nothing ever asked
# Datadog whether the series existed — the query was syntactically valid and
# permanently empty.
#
# So each row asks first: does this metric have points, do these logs exist, are
# there RUM views. A row that cannot answer yes is REFUSED BY NAME and the
# script exits non-zero. That is deliberately noisier than creating the monitor
# and hoping: a refusal is a sentence an operator can act on, and a monitor in
# NO DATA is a question nobody asks.
#
# The APM rows are where it earns its keep. The SERVER span is a per-service
# fact — `web.request` from bare dd-trace-js, `hono.request` once its Hono
# plugin fires, `fastapi.request` from ddtrace-py — declared ONCE in
# DD_SERVER_SPAN (packages/datadog/src/constants.ts) and read here by
# `dd_server_span`. It is a convention, not a guarantee: MONEY-1534 renamed one
# with a loader flag and the monitor went quiet with no error anywhere, which is
# why the preflight asks the org about the declared span on every run.
#
# Never `http.request`, which is the same library's HTTP CLIENT span — see the
# row table below.
set -euo pipefail

ENV_ARG="${1:-}"
DRY_RUN=false
# MONEY-1379. `--only=verify` RENDERS every row and writes nothing, then asks
# Datadog what it actually holds under the managed tag. It is deliberately NOT
# `--dry-run`: a dry run has no credentials, skips the listing and short-circuits
# every preflight, and a comparison against a listing it never made would be a
# claim with no evidence behind it. Verify needs the network precisely because
# the org is the half it cannot infer from the repo.
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
  *) echo "usage: $0 {qa|prod} [--dry-run|--only=verify]" >&2; exit 2 ;;
esac

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$HERE/../../.." && pwd)"

# The API host is DERIVED from the same constant the emitters use, never
# retyped. apply-monitors.sh POSTed to US1 for two releases while DD_SITE said
# otherwise, so the monitors were created in an org that never receives the
# metric (MONEY-1238 fault (d)).

source "$HERE/lib-datadog.sh"
dd_resolve_api_host || exit 1

# QA monitoring is OFF by founder decision — see `dd_qa_monitoring_enabled` in
# lib-datadog.sh. Exits 0, not 1: this is a deliberate configured state, and a
# non-zero exit here would make the cutover runner look like it failed.
#
# BEFORE the credential check, and that ordering is the point. With the checks
# first, `apply-service-monitors.sh qa` with no keys exited 1 complaining about
# a secret it was never going to use — a failure report for a run that had
# already been configured not to happen. `apply-monitors.sh` had them in this
# order; this one did not.
if [[ "$ENV_ARG" == "qa" ]] && ! dd_qa_monitoring_enabled; then
  echo "qa monitoring is disabled (DD_QA_MONITORING is not \"on\") — nothing applied."
  echo "Re-enable with: DD_QA_MONITORING=on $(basename "$0") qa"
  exit 0
fi

if ! $DRY_RUN; then
  # `${ENV_ARG^^}` is a bash-4 expansion and macOS ships bash 3.2, where it
  # renders as "bad substitution" INSIDE the very message that is supposed to
  # name the secret to fetch. `tr` is POSIX and works on both.
  ENV_UPPER="$(printf %s "$ENV_ARG" | tr '[:lower:]' '[:upper:]')"
  : "${DD_API_KEY:?export DD_API_KEY first (GCP Secret Manager: DD_API_KEY_${ENV_UPPER})}"
  : "${DD_APP_KEY:?export DD_APP_KEY first (GCP Secret Manager: DD_APP_KEY_${ENV_UPPER})}"
fi

NOTIFY="${DD_NOTIFY:-deepshaswat@gmail.com}"
MANAGED_TAG="managed-by:apply-monitors"

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
# What THIS run rendered, for `--only=verify`. Populated from the rendered BODY
# rather than from LABEL: the body's `name` is the string Datadog stores and
# therefore the only one the three-way comparison can match on.
RENDERED_NAMES=()
EXISTING_JSON="[]"
$DRY_RUN || dd_list_managed "$LIST_TAG"

# template|service|threshold|envs|preflight
#
# `envs` is which environments the row belongs in, and it is not decoration:
# apply-monitors.sh derives prod-only-ness from the scheduler, but a SERVICE has
# no scheduler entry to derive from, so it is stated. A row created for an
# environment that does not run the service is a monitor that has never once
# been green, and a monitor that has never been green is one somebody mutes.
declare -a ROWS=(
  # APM. tiingo-realtime is on the list for both envs because QA runs the
  # realtime service too (it is a deployed Cloud Run service in both).
  #
  # NO SPAN COLUMN — MONEY-1534. The metric-apm branch reads each service's
  # SERVER span from DD_SERVER_SPAN, where the measurement that chose it lives.
  # These rows restated it, so when MONEY-1380's ESM loader let dd-trace's Hono
  # plugin rename the workers' `web.request` to `hono.request`, the workers' row
  # kept querying a series that no longer existed — No Data from 2026-09-12.
  #
  # It is the SERVER span, never `http.request`: that is dd-trace-js's HTTP
  # CLIENT span (`client.http.opName` in
  # node_modules/dd-trace/packages/dd-trace/src/service-naming/schemas/v0/web.js).
  # It was here for a release and measured the WRONG DIRECTION — our OUTBOUND
  # calls to NSE, BSE, Screener, Tiingo and Gemini, not our request handling. A
  # vendor's holiday 404 storm paged, a job route 500ing on every Pub/Sub push
  # did not, and the preflight passed: the client series genuinely has points.
  "monitor-apm-error-rate.json|stockbook-workers||prod,qa|metric-apm"
  "monitor-apm-error-rate.json|us-fundamentals||prod,qa|metric-apm"
  "monitor-apm-error-rate.json|tiingo-realtime||prod,qa|metric-apm"
  # MONEY-1468 (A3) — the UDF datafeed. It could only be added once spans were
  # OBSERVED arriving on BOTH envs (MONEY-1238: instrument, observe, then
  # monitor) — and prod's did not exist under `env:production` until the DD_ENV
  # fix, because the spec said "prod".
  "monitor-apm-error-rate.json|usemoney-market-data||prod,qa|metric-apm"

  # Log volume. Thresholds differ because the healthy floors differ: the workers
  # service answers ~60 job routes, apps/api answers user requests.
  #
  # `logs-status-service`, NOT `logs-service` — MONEY-1359 finding 3. These
  # monitors query `status:error`; the old preflight asked only whether ANY log
  # existed for the service, which is a different question and one that passes
  # in the exact state the preflight exists to catch. See the case branch.
  "monitor-log-errors.json|stockbook-workers|100|prod,qa|logs-status-service"
  "monitor-log-errors.json|stockbook-web|50|prod,qa|logs-status-service"
  "monitor-log-errors.json|stockbook-api|50|prod,qa|logs-status-service"
  "monitor-log-errors.json|us-fundamentals|50|prod,qa|logs-status-service"

  # Whole-environment log rows. No service placeholder on purpose — a new
  # service is covered the day it ships.
  #
  # THE TWO USE DIFFERENT PREFLIGHTS, because their queries depend on different
  # things. `monitor-log-fatal` reads the `status` attribute
  # (`status:(fatal OR critical)`); `monitor-log-unhandled` is a free-text match
  # over the message and reads no attribute at all, so "are there logs in this
  # env" IS the question its own query asks.
  "monitor-log-fatal.json|||prod,qa|logs-status-env"
  "monitor-log-unhandled.json|||prod,qa|logs-env"

  # RUM. PROD ONLY, and not for cost: QA's web app has essentially no human
  # traffic, so both of these would sit permanently empty there.
  "monitor-rum-errors.json|stockbook-web||prod|rum"
  "monitor-rum-lcp.json|stockbook-web||prod|rum-lcp"

  # The realtime holder (MONEY-1357). Each row preflights THE SERIES ITS OWN
  # MONITOR QUERIES, which is why these are two kinds and not one:
  # `rt.health_ok` is a gauge emitted every 5s from flushTick's `finally`, so it
  # has points whenever the process is alive, while `rt.bars_closed` is a
  # counter the flush path increments only AFTER the `mayWrite` entitlement gate
  # passes (`main.ts:450`), and the emitter skips zero-valued deltas. The one
  # other increment, `closeSocket`'s drain at `main.ts:268`, fires on shutdown
  # or a step-down, so it cannot keep the series alive. Sharing one preflight
  # let the absence row
  # be created over a series nobody emits — on a fresh prod, or anywhere
  # US_MARKET_ALLOWED_EMAILS keeps `mayWrite` false — and with
  # no_data_timeframe 17280 it then sits silent for twelve days.
  "monitor-rt-health.json|tiingo-realtime||prod,qa|metric-rt"
  "monitor-rt-bars-absence.json|tiingo-realtime||prod|metric-rt-bars"

  # monitor-rt-stepdown.json IS DELIBERATELY NOT A ROW.
  #
  # It is a LOG alert on service:tiingo-realtime, and that process ships NO LOGS
  # to Datadog, for two independent reasons:
  #
  #   1. `initLogger()` — the only thing that attaches the pino -> Datadog
  #      multistream — is called in `workers/src/index.ts` and NOWHERE ELSE.
  #      `workers/src/realtime/main.ts` is its own tsup entry point
  #      (`tiingo-realtime: "src/realtime/main.ts"`) and every one of its ~9 log
  #      sites is a bare `console.*`, which pino never sees.
  #   2. Its `datadog-agent` sidecar sets DD_APM_ENABLED but neither
  #      DD_LOGS_ENABLED nor a log path, so serverless-init forwards traces
  #      only.
  #
  # So `dd_events_exist logs "service:tiingo-realtime env:..."` is empty on
  # every live run, the row is REFUSED, and this script exits 1 AFTER writing
  # the twelve rows above it — a permanent red apply that teaches an operator to
  # ignore the exit code.
  #
  # TO BRING IT BACK: land an `await initLogger()` in
  # `workers/src/realtime/main.ts` and move those `console.*` calls onto
  # `getLogger()` (the query matches the text "stepping down", so
  # `main.ts:303` is the one that must reach Datadog), then re-add
  #   "monitor-rt-stepdown.json|tiingo-realtime||prod,qa|logs-service"
  # here. `service-monitors-agreement.test.ts` fails if the row returns while
  # that file still has no initLogger call. The template is kept as-is.
)

# Print the observed LCP p75 beside the threshold — see monitor-rum-lcp.json's
# `_units_rationale`. A unit error here is a factor of a million and produces
# either a monitor that fires forever or one that never fires, and the second is
# invisible. One sampled view answers it at apply time.
#
# THIS IS A DIAGNOSTIC AND MUST NEVER STOP THE RUN. It is called under
# `set -euo pipefail` as the last command of an `&&` list, so anything that
# exits non-zero inside it — an error envelope returned with a 200, a `node`
# that is not on PATH — aborts the whole apply PART WAY THROUGH, after some
# monitors have already been written and before the rest. A report about a
# threshold killing the application of the monitors is exactly backwards, so
# every exit path inside it is 0.
#
# The TESTED guard is the `try/catch` around `JSON.parse` below — a 200 carrying
# an error envelope, or a proxy's HTML, is the reachable version of this and
# `service-monitors-agreement.test.ts` reproduces it by poisoning the third RUM
# search. The `|| true` at the call site is a structural backstop for a `node`
# that will not launch at all, and it is deliberately NOT claimed as verified:
# it cannot be exercised here, because a broken `node` kills `dd_render` several
# rows earlier. One backstop, named for what it is, rather than two that both
# read as proven.
report_lcp_magnitude() {
  $DRY_RUN && return 0
  local payload
  payload="$(Q="@type:view service:stockbook-web env:${DD_ENV_TAG} @view.largest_contentful_paint:>0" node -e '
    process.stdout.write(JSON.stringify({
      filter: { query: process.env.Q, from: "now-24h", to: "now" },
      page: { limit: 1 },
    }));
  ')"
  dd_request POST "https://${DD_API_HOST}/api/v2/rum/events/search" "$payload" || return 0
  BODY="$RESPONSE_BODY" node -e '
    let body;
    try { body = JSON.parse(process.env.BODY); } catch {
      // A 200 carrying an error envelope, or a truncated read. Say so and stop
      // — never throw, because the throw would take the apply run with it.
      console.log("   LCP magnitude: the RUM search answered something that is not JSON; skipping the unit check");
      process.exit(0);
    }
    const d = (body?.data ?? [])[0];
    const v = d?.attributes?.attributes?.view?.largest_contentful_paint;
    if (typeof v !== "number") { console.log("   LCP magnitude: no sample available"); process.exit(0); }
    const ok = v > 1e8 && v < 1e11;
    console.log(`   LCP magnitude: observed ${v} vs threshold 2500000000 — ` +
      (ok ? "nanoseconds, as the template assumes" :
            "OUT OF RANGE for nanoseconds. The threshold is probably wrong by 1e6; fix monitor-rum-lcp.json before trusting this row."));
  '
}

for ROW in "${ROWS[@]}"; do
  IFS='|' read -r TPL SERVICE THRESHOLD ENVS KIND <<< "$ROW"
  LABEL="${TPL%.json}${SERVICE:+ ${SERVICE}}"
  # Set only by the metric-apm branch, and reset here so no row renders the
  # previous row's span.
  SPAN=""

  if [[ ",${ENVS}," != *",${ENV_ARG},"* ]]; then
    echo "skipping (${ENV_ARG} not in ${ENVS}): ${LABEL}"
    SKIPPED=$((SKIPPED + 1))
    continue
  fi

  case "$KIND" in
    metric-apm)
      # The span from its one declaration (MONEY-1534), then the preflight on
      # HITS and never on errors: a healthy service has NO errors series at
      # all — measured 2026-09-23, none in 24h for any of the four APM services
      # while every hits series was live — so an errors probe would refuse
      # every healthy row, and a preflight must never name a series whose
      # emptiness is health.
      SPAN="$(dd_server_span "$SERVICE")" || {
        FAILED+=("${LABEL}: no server span declared for ${SERVICE} — measure it against the org and add it to DD_SERVER_SPAN in packages/datadog/src/constants.ts")
        continue
      }
      dd_metric_has_points "sum:trace.${SPAN}.hits{service:${SERVICE},env:${DD_ENV_TAG}}.as_count()" || {
        FAILED+=("${LABEL}: no trace.${SPAN}.hits points in 24h — the span declared for ${SERVICE} in DD_SERVER_SPAN (packages/datadog/src/constants.ts) is a dd-trace convention, not a guarantee: a framework plugin or a loader flag renames it (MONEY-1534). Check the service is tracing, then re-measure its server span")
        continue
      } ;;
    metric-rt)
      dd_metric_has_points "min:stockbook.rt.health_ok{env:${DD_ENV_TAG}}" || {
        FAILED+=("${LABEL}: stockbook.rt.health_ok has no points — is the MONEY-1357 realtime release deployed to ${ENV_ARG}?")
        continue
      } ;;
    metric-rt-bars)
      # NOT metric-rt. `rt.health_ok` is alive whenever the PROCESS is; this row
      # watches `rt.bars_closed`, which is only incremented past the `mayWrite`
      # entitlement gate and is skipped by the emitter when the delta is zero.
      # Preflighting the gauge would pass on a service that has never written a
      # bar and create the absence monitor over an empty series.
      dd_metric_has_points "sum:stockbook.rt.bars_closed{env:${DD_ENV_TAG}}.as_count()" || {
        FAILED+=("${LABEL}: stockbook.rt.bars_closed has no points — the holder is running (rt.health_ok is a separate row) but has closed no bars. Check US_MARKET_ALLOWED_EMAILS entitlement and rt.refused_no_listing before creating a 96h absence monitor over a series nobody emits.")
        continue
      } ;;
    logs-status-service)
      # THE SAME FILTER THE MONITOR QUERIES — MONEY-1359 finding 3, and the
      # log-side twin of the `metric-rt` / `metric-rt-bars` split above.
      #
      # This row's monitor is `logs("service:X env:Y status:error")`, and it was
      # preflighted with `service:X env:Y` — "does ANY log exist". Those are
      # different questions, and the gap between them is exactly the state the
      # preflight exists to refuse: our nodejs lines carry `level`, not
      # `status`, until `apply-log-config.sh` creates the status remapper — and
      # `setup-datadog.sh` runs THIS script BEFORE that one. So the row passed
      # on the presence of logs, was created against an attribute nothing
      # emitted, and sat in permanent NO DATA with `notify_no_data: false`
      # underneath it.
      #
      # `status:error` and not a broader probe like `status:*` or
      # `status:(error OR info)`: Datadog DEFAULTS an unmapped log's status to
      # `info`, so any probe that would match an info line passes whether the
      # remapper exists or not — vacuous, which is worse than absent. `error` is
      # the one value that can only come from the remapper.
      #
      # The cost is honest and bounded: a service with genuinely zero error logs
      # in 24h is refused BY NAME. This file already takes that trade over
      # creating-and-hoping, and the four services here answer job routes and
      # user traffic — a whole day with no error line is itself worth reading.
      dd_events_exist logs "service:${SERVICE} env:${DD_ENV_TAG} status:error" || {
        FAILED+=("${LABEL}: no logs matching service:${SERVICE} env:${DD_ENV_TAG} status:error in 24h. Either the service logged no errors, or — the case this preflight exists for — the \`status\` attribute is not populated yet: our nodejs lines carry \`level\` until apply-log-config.sh installs the status remapper, and setup-datadog.sh runs THIS script first. Run apply-log-config.sh, then re-run this.")
        continue
      } ;;
    logs-status-env)
      # `monitor-log-fatal.json` queries `status:(fatal OR critical)`, and the
      # probe is deliberately NOT that. A healthy environment has ZERO fatal
      # lines, so preflighting the literal filter would refuse this row forever
      # and leave the apply permanently red — which teaches an operator to
      # ignore the exit code, the reason `monitor-rt-stepdown.json` is not a row
      # at all.
      #
      # What the query actually DEPENDS on is that `status` carries our `level`,
      # and `status:error` falsifies exactly that (see the branch above: an
      # unmapped line defaults to `info`, so only `error` proves the remapper).
      # Once it does, `status:(fatal OR critical)` is a valid query that is
      # legitimately empty when nothing is on fire.
      dd_events_exist logs "env:${DD_ENV_TAG} status:error" || {
        FAILED+=("${LABEL}: no logs matching env:${DD_ENV_TAG} status:error in 24h, so the \`status\` attribute this monitor queries is not populated — our nodejs lines carry \`level\` until apply-log-config.sh installs the status remapper, and setup-datadog.sh runs THIS script first. A fatal monitor created now would sit in permanent NO DATA.")
        continue
      } ;;
    logs-service)
      # NO LIVE ROW uses this today, and it is kept for the one documented
      # re-add below: `monitor-rt-stepdown.json` matches the TEXT "stepping
      # down" and reads no attribute, so "does this service log at all" is the
      # question its own query asks. Do not point a `status:`-querying row here.
      dd_events_exist logs "service:${SERVICE} env:${DD_ENV_TAG}" || {
        FAILED+=("${LABEL}: no logs at all for service:${SERVICE} env:${DD_ENV_TAG} in 24h — a monitor over them would be NO DATA forever")
        continue
      } ;;
    logs-env)
      # `monitor-log-unhandled.json` only. Its query is a free-text match over
      # the message with no attribute in it, so this IS the series it queries.
      dd_events_exist logs "env:${DD_ENV_TAG}" || {
        FAILED+=("${LABEL}: no logs at all for env:${DD_ENV_TAG} in 24h")
        continue
      } ;;
    rum|rum-lcp)
      dd_events_exist rum "@type:view service:${SERVICE} env:${DD_ENV_TAG}" || {
        FAILED+=("${LABEL}: no RUM views in 24h — is the RUM application created and are the NEXT_PUBLIC_DD_* vars set on Vercel?")
        continue
      } ;;
    *) echo "FATAL: unknown preflight kind '${KIND}' for ${LABEL}" >&2; exit 1 ;;
  esac

  [[ "$KIND" == "rum-lcp" ]] && { report_lcp_magnitude || true; }

  VARS="$(
    P_ENV="$DD_ENV_TAG" P_SERVICE="$SERVICE" P_SPAN="$SPAN" \
    P_THRESHOLD="$THRESHOLD" P_NOTIFY="$NOTIFY" node -e '
      console.log(JSON.stringify({
        env: process.env.P_ENV,
        service: process.env.P_SERVICE,
        span: process.env.P_SPAN,
        threshold: process.env.P_THRESHOLD,
        notify: process.env.P_NOTIFY,
      }));
    '
  )"
  BODY="$(dd_render "$HERE/$TPL" "$VARS")" || {
    FAILED+=("${LABEL}: render failed — an unknown or unsubstituted placeholder")
    continue
  }
  if [[ "$ONLY" == verify ]]; then
    RENDERED_NAMES+=("$(BODY="$BODY" node -e 'console.log(JSON.parse(process.env.BODY).name)')")
    continue
  fi
  dd_upsert_monitor "$LABEL" "$BODY" || true
done

# Before the FAILED report on purpose. A row REFUSED by its preflight collected
# no name, so it shows up here as an orphan if Datadog still holds it — which is
# the honest answer: a row that cannot preflight is a row whose monitor should
# not exist. Reporting the refusal first would exit 1 and never say so.
if [[ "$ONLY" == verify ]]; then
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
  # `"${A[@]}"` on an EMPTY array is an unbound-variable error under `set -u` in
  # bash 3.2, which is what macOS ships. The `+` form expands to nothing instead.
  # false: this tag is SHARED with the sibling apply script, so a monitor
  # under it that this script did not render is not evidence of an orphan.
  dd_verify_managed "$LIST_TAG" false "${RENDERED_NAMES[@]+"${RENDERED_NAMES[@]}"}"
  exit $?
fi

if ((${#FAILED[@]} > 0)); then
  echo "" >&2
  echo "${#FAILED[@]} of ${#ROWS[@]} rows did NOT apply:" >&2
  printf '  - %s\n' "${FAILED[@]}" >&2
  exit 1
fi

# The same accounting apply-monitors.sh does: every row must have been applied or
# deliberately skipped. A row that fell through both is a silent no-op, which is
# the failure this whole file is about.
if ((APPLIED + SKIPPED != ${#ROWS[@]})); then
  echo "FATAL: ${APPLIED} applied + ${SKIPPED} skipped != ${#ROWS[@]} rows" >&2
  exit 1
fi
echo "applied ${APPLIED}, skipped ${SKIPPED} of ${#ROWS[@]} rows (${ENV_ARG})"
