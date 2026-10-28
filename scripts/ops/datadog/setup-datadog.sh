#!/usr/bin/env bash
#
# The whole us5 cutover, in the one order that is safe.
#
#   scripts/ops/datadog/setup-datadog.sh --dry-run     # print the plan, touch nothing
#   scripts/ops/datadog/setup-datadog.sh               # do it
#   scripts/ops/datadog/setup-datadog.sh --from=apply  # resume at a stage
#
# ## What this is, and what it deliberately is not
#
# It is a RUNNER over the scripts that already exist, not a reimplementation of
# them. Every stage below is one line calling a script with its own tests, its
# own dry run and its own fail-closed behaviour. The value this file adds is the
# ORDER and the two gates between the stages, because both are things a runbook
# states and a tired operator skips.
#
# It does NOT create the first application key: that is UI-only, verified
# against Datadog's OpenAPI rather than assumed. `POST /api/v2/application_keys`
# does not exist (the path is GET-only), the two endpoints that DO create one
# both require an existing application key in the header, and of the sixteen
# endpoints that accept an API key alone none mints a credential. Personal
# Access Tokens do not help — the docs state a PAT cannot create an application
# key. Stage 0 checks for it and tells you where to click.
#
# It does NOT touch Vercel, ever. Stage 3 prints a table for a human to paste.
#
# ## THE GATE THAT MATTERS IS STAGE 4
#
# Ingest is proven BEFORE a single monitor is created, and the run stops if it
# cannot be. Applying a monitor set to an org that is not receiving data puts
# every monitor into NO DATA on day one — and NO DATA is indistinguishable from
# health, so the set gets muted in week one and is never looked at again. That
# is MONEY-1238, the defect this entire epic exists to close, and it would be a
# fitting way to reintroduce it.
#
# It is a FUNCTION rather than a stage body, for the reason the credential
# resolution below is setup rather than a stage: a resume skips stage bodies,
# and `--from=apply` is the natural thing to type after the first cutover
# half-finished. See `prove_ingest`.
#
# ## Stages
#
#   0  preflight   secrets exist and both keys authenticate against us5
#   1  rum         create the two browser RUM applications (idempotent)
#   2  roll        restart the sidecar services so they pick up the new key
#   3  vercel      print the table (a human sets these; nothing here can)
#   4  ingest      PROVE the estate is emitting — HARD GATE
#   5  apply       monitors, service monitors, SLOs, dashboards, log config
#   6  verify      re-list what now exists, and say what is left to do by hand
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
GC=(gcloud --account=founder@disdigital.in --project=stock-book-483718)
export CLOUDSDK_ACTIVE_CONFIG_NAME=stockbook

# The request plumbing, the site and the qa switch are the LIBRARY's, not this
# file's second copy of them (MONEY-1359).
#
# `dd_request` matters here for a reason beyond tidiness. A bare `curl` inside a
# command substitution under `set -euo pipefail` does not fail loudly: on a DNS
# blip or a TLS reset it exits 6, the assignment fails, and the script dies with
# no message and no stage name. This file ran three of those, and the worst sat
# in the ingest gate — immediately AFTER six production services have been
# rolled, so the last thing an operator sees is `rolling: tiingo-realtime-qa`.
# `dd_request` captures curl's rc, spells "no HTTP response" as `000`, and
# refuses a non-2xx. The friendly handlers below can only print for a server
# that actually answered.
source "$HERE/lib-datadog.sh"

DRY_RUN=false
FROM="preflight"
STAGES=(preflight rum roll vercel ingest apply verify)
# Declared here, not defaulted at the exit with `${…:-false}`: the apply stage
# and the verify stage both set it, and a second `:-false` default is a second
# place for the two to disagree about what "clean" means.
HAD_FAILURES=false

while [[ $# -gt 0 ]]; do
  case "$1" in
    --dry-run) DRY_RUN=true ;;
    --from=*)  FROM="${1#--from=}" ;;
    *) echo "unknown argument: $1" >&2
       echo "usage: $(basename "$0") [--dry-run] [--from=$(IFS='|'; echo "${STAGES[*]}")]" >&2
       exit 2 ;;
  esac
  shift
done

# A typo'd stage must not silently run everything from the beginning.
if ! printf '%s\n' "${STAGES[@]}" | grep -qx "$FROM"; then
  echo "unknown stage: ${FROM}" >&2
  echo "stages: ${STAGES[*]}" >&2
  exit 2
fi

# ---------------------------------------------------------------------------
# RESOLVED BEFORE ANY STAGE RUNS, and deliberately NOT inside one.
#
# `--from=ingest` skips every earlier stage. When the site and the credentials
# were resolved inside `preflight`, resuming left them unbound and the run died
# at `line 211: DD_API_KEY: unbound variable` — in the stage whose entire job is
# to prove ingest, having just rolled six production services.
#
# Resuming is precisely WHEN you need them: a resume happens after something
# went wrong, which is the worst moment to discover that the resume path is the
# untested one. So this is setup, not a stage; `preflight` only reports on it.
#
# The site comes from `dd_resolve_api_host`, which is the ONE place it is read
# out of constants.ts. This file used to scrape it with its own `sed` — a
# second spelling of exactly the fact that must not have two, because a stale
# site is answered 403 and a 403 on an intake is swallowed and renders as NO
# DATA rather than as an error. SITE is the bare host, derived from the
# resolver's output rather than parsed again, for the UI links below.
dd_resolve_api_host || exit 1
SITE="${DD_API_HOST#api.}"

SECRETS=(DD_API_KEY_PROD DD_API_KEY_QA DD_APP_KEY_PROD DD_APP_KEY_QA)
MISSING=()
for s in "${SECRETS[@]}"; do
  "${GC[@]}" secrets describe "$s" >/dev/null 2>&1 || MISSING+=("$s")
done

if ((${#MISSING[@]} == 0)) && ! $DRY_RUN; then
  DD_API_KEY="$("${GC[@]}" secrets versions access latest --secret=DD_API_KEY_PROD)"
  DD_APP_KEY="$("${GC[@]}" secrets versions access latest --secret=DD_APP_KEY_PROD)"
  export DD_API_KEY DD_APP_KEY
fi

STARTED=false
stage() {                      # stage <name> <heading>
  if [[ "$1" == "$FROM" ]]; then STARTED=true; fi
  $STARTED || { echo "  (skipping ${1})"; return 1; }
  echo ""
  echo "═══ ${1} — ${2}"
  return 0
}

# `--dry-run` is a BRANCH, and this repo has shipped bugs in exactly that
# branch twice. So the flag is turned into an ARGUMENT passed down, never a
# reason to skip a call, and the child scripts do their own refusing.
# `${DR[@]+"${DR[@]}"}` and not `"${DR[@]}"`. On bash 3.2 — which is what macOS
# ships and what this runs on — expanding an EMPTY array under `set -u` is an
# "unbound variable" error. bash 4.4 fixed it; we do not have bash 4.4.
#
# It is invisible in a dry run, because DR is non-empty there. So the ONE path
# this guard could not protect was the live one, and that is precisely where it
# fired: the first real run died at stage `rum` having already validated the
# credentials. Same shape as every other `--dry-run` bug in this directory —
# the branch that is never exercised is the branch that is wrong.
DR=()
$DRY_RUN && DR=(--dry-run)

# ---------------------------------------------------------------------------
if stage preflight "the four secrets exist and authenticate against us5"; then
  echo "site: ${SITE}  (from packages/datadog/src/constants.ts)"
  for s in "${SECRETS[@]}"; do
    if printf '%s\n' ${MISSING[@]+"${MISSING[@]}"} | grep -qx "$s"; then
      echo "  MISSING: ${s}"
    else
      echo "  present: ${s}"
    fi
  done

  if ((${#MISSING[@]} > 0)); then
    echo "" >&2
    echo "STOP. ${#MISSING[@]} secret(s) are missing and nothing below can run." >&2
    echo "" >&2
    echo "The first APPLICATION key cannot be minted from a script — there is no" >&2
    echo "API for it. Create one in the UI:" >&2
    echo "" >&2
    echo "    https://${SITE%%.*}.datadoghq.com/organization-settings/application-keys" >&2
    echo "" >&2
    echo "Check whether One-Time Read mode is on BEFORE closing the tab: the value" >&2
    echo "is re-viewable only when it is off. Then store each one — the script" >&2
    echo "validates before it writes, and reads from stdin, never argv:" >&2
    echo "" >&2
    for s in ${MISSING[@]+"${MISSING[@]}"}; do echo "    scripts/ops/datadog/set-dd-secret.sh ${s}" >&2; done
    echo "" >&2
    echo "One application key covers BOTH environments — qa and prod are one us5" >&2
    echo "org separated by an env: tag — so the same value goes under both names." >&2
    exit 1
  fi

  if $DRY_RUN; then
    echo "  (dry run: not reading secret values, not authenticating)"
  else
    if ! dd_request GET "https://${DD_API_HOST}/api/v2/validate_keys"; then
      echo "" >&2
      echo "STOP. The prod key pair does not authenticate against ${SITE} (HTTP ${RESPONSE_STATUS})." >&2
      echo "401/403 here usually means the keys belong to a DIFFERENT org." >&2
      echo "000 means curl never got an answer: ${RESPONSE_BODY}" >&2
      exit 1
    fi
    echo "  prod key pair authenticates against ${SITE}"
  fi
fi

# ---------------------------------------------------------------------------
# A RESUME must not sail past a missing secret just because it skipped the stage
# that checks for them. The check is cheap and the failure it prevents is a
# half-applied org.
if ((${#MISSING[@]} > 0)); then
  echo "" >&2
  echo "STOP. ${#MISSING[@]} secret(s) are missing: ${MISSING[*]}" >&2
  echo "Run without --from to see how to create them." >&2
  exit 1
fi

if stage rum "create the two browser RUM applications"; then
  bash "$HERE/create-rum-apps.sh" ${DR[@]+"${DR[@]}"}
fi

# ---------------------------------------------------------------------------
if stage roll "restart the sidecar services onto the new key"; then
  # A Cloud Run service reads its secret at INSTANCE START, so a warm instance
  # keeps the old key until it is rolled. Without this the whole cutover looks
  # like it worked and no data arrives until the next unrelated deploy.
  for svc in stockbook-workers-prod stockbook-workers-qa \
             us-fundamentals-prod us-fundamentals-qa \
             tiingo-realtime-prod tiingo-realtime-qa; do
    if $DRY_RUN; then
      echo "  would roll: ${svc}"
    else
      echo "  rolling: ${svc}"
      "${GC[@]}" run services update "$svc" --region=asia-south1 \
        --update-labels=dd-org=us5 --quiet >/dev/null || {
          echo "  WARNING: ${svc} did not roll — it may not exist in this project" >&2
        }
    fi
  done
fi

# ---------------------------------------------------------------------------
if stage vercel "the variables a human must set"; then
  echo "  Nothing in this repo touches Vercel. The RUM ids and client tokens are"
  echo "  printed by stage 'rum' above; set them alongside these:"
  echo ""
  echo "    web  prod : DD_SERVICE=stockbook-web   DD_ENV=production  DD_TRACE_ENABLED=false"
  echo "    web  qa   : DD_SERVICE=stockbook-web   DD_ENV=qa          DD_TRACE_ENABLED=false"
  echo "    api  prod : DD_SERVICE=stockbook-api   DD_ENV=production  DD_TRACE_ENABLED=false"
  echo "    api  qa   : DD_SERVICE=stockbook-api   DD_ENV=qa          DD_TRACE_ENABLED=false"
  echo ""
  echo "  plus DD_API_KEY from the matching secret on all four."
  echo "  DD_TRACE_ENABLED is false because dd-trace needs an agent on"
  echo "  localhost:8126 and Vercel has none. Logs and metrics still go over HTTP."
fi

# ---------------------------------------------------------------------------
# THE HARD GATE, as a function, because a STAGE BODY IS SKIPPED BY A RESUME.
#
# `--from=apply` and `--from=verify` are validated, documented resume targets,
# and both used to sail straight past this. That is not hypothetical: the first
# real cutover produced exactly the state that demands a resume, and
# `--from=apply` is the obvious thing to type once rum/roll/vercel are done. If
# the roll silently failed, or the stored key is the wrong org's, every monitor
# lands in NO DATA on day one and gets muted in week one — MONEY-1238,
# reintroduced by the runner built to prevent it.
#
# So `apply` calls this itself when the stage did not run. Exactly the hoisting
# the credential resolution above got, for exactly the same reason.
INGEST_PROVEN=false
prove_ingest() {
  if $DRY_RUN; then
    echo "  would query sum:stockbook.job.selected{env:production}.as_count() over 24h"
    INGEST_PROVEN=true
    return 0
  fi
  local now q enc n
  now="$(date +%s)"
  q='sum:stockbook.job.selected{env:production}.as_count()'
  enc="$(QUERY="$q" node -e 'process.stdout.write(encodeURIComponent(process.env.QUERY))')"
  # Not `dd_metric_has_points`, which is the same request one file over: it
  # returns 1 for BOTH "the query did not run" and "the query ran and found
  # nothing", and those two need different words here. Telling an operator to
  # go and check whether a scheduled job has run, when the real answer is that
  # their app key cannot read metrics, is a wasted hour at the worst moment.
  if ! dd_request GET \
      "https://${DD_API_HOST}/api/v1/query?from=$((now - 86400))&to=${now}&query=${enc}"; then
    echo "" >&2
    echo "STOP. The metric query did not answer (HTTP ${RESPONSE_STATUS})." >&2
    echo "${RESPONSE_BODY}" >&2
    echo "Ingest is UNPROVEN — that is not the same as unproven-and-empty, so" >&2
    echo "fix the read before reading anything into it. 000 is curl never" >&2
    echo "getting an answer; 403 is usually a key that cannot read metrics." >&2
    exit 1
  fi
  n="$(BODY="$RESPONSE_BODY" node -e '
    let d; try { d = JSON.parse(process.env.BODY); } catch { console.log("-1"); process.exit(0); }
    console.log(Array.isArray(d?.series) ? d.series.length : -1);
  ')"
  echo "  series returned for ${q}: ${n}"
  if [[ "$n" == "-1" ]]; then
    echo "" >&2
    echo "STOP. The metric query did not answer with a series[] — cannot prove ingest." >&2
    exit 1
  fi
  if [[ "$n" -eq 0 ]]; then
    echo "" >&2
    echo "STOP. Nothing has been ingested in the last 24h." >&2
    echo "" >&2
    echo "Creating monitors now would put every one of them into NO DATA on day" >&2
    echo "one, and NO DATA is indistinguishable from health — the set gets muted" >&2
    echo "in week one and is never looked at again. That is MONEY-1238, which is" >&2
    echo "the defect this whole epic exists to close." >&2
    echo "" >&2
    echo "Check, in this order: the services actually rolled (stage 'roll'); the" >&2
    echo "stored API keys are the us5 ones and not the old us3 pair; a scheduled" >&2
    echo "job has run since the roll. Then re-run with --from=ingest." >&2
    exit 1
  fi
  echo "  ingest CONFIRMED — safe to create monitors"
  INGEST_PROVEN=true
}

if stage ingest "PROVE the estate is emitting — this is the hard gate"; then
  prove_ingest
fi

# ---------------------------------------------------------------------------
if stage apply "monitors, service monitors, SLOs, dashboards, log config"; then
  # NOTHING IS CREATED UNTIL INGEST IS PROVEN IN THIS RUN. On a normal run the
  # stage above already did it; on `--from=apply` it did not, and this is the
  # only thing standing between a resume and 47 monitors in NO DATA.
  #
  # `--from=verify` deliberately does NOT call it: verify creates nothing, and a
  # gate on a read-only stage would stop an operator from looking at the org.
  $INGEST_PROVEN || prove_ingest

  # EVERY script runs, even if an earlier one refused rows.
  #
  # `apply-service-monitors.sh` exits 1 when it refuses a row whose series has
  # no points — which is correct and is the whole point of the preflight — but
  # under `set -e` that stopped the runner before the SLOs, the dashboards and
  # the log config, none of which depend on it. The first real cutover created
  # 47 monitors and zero SLOs for exactly that reason.
  #
  # So failures are COLLECTED and reported at the end, and the runner still
  # exits non-zero. A refusal must be visible; it must not be contagious.
  APPLY_FAILED=()
  APPLY_TOTAL=0
  run_apply() {                      # run_apply <label> <script> [args...]
    local label="$1"; shift
    APPLY_TOTAL=$((APPLY_TOTAL + 1))
    if bash "$@"; then return 0; fi
    APPLY_FAILED+=("$label")
    echo "  (${label} reported failures — continuing; see its output above)" >&2
    return 0
  }

  # The monitors come first because the SLOs resolve their ids BY NAME.
  run_apply "job monitors"     "$HERE/apply-monitors.sh"         prod ${DR[@]+"${DR[@]}"}
  run_apply "service monitors" "$HERE/apply-service-monitors.sh" prod ${DR[@]+"${DR[@]}"}
  run_apply "SLOs"             "$HERE/apply-slos.sh"             prod ${DR[@]+"${DR[@]}"}
  run_apply "dashboards"       "$HERE/apply-dashboards.sh"       prod ${DR[@]+"${DR[@]}"}
  run_apply "log config"       "$HERE/apply-log-config.sh"            ${DR[@]+"${DR[@]}"}

  # QA MONITORING IS OFF by founder decision, and `lib-datadog.sh` says
  # "Reversal is this one variable". It was not: every child was invoked with a
  # hardcoded `prod`, so `DD_QA_MONITORING=on setup-datadog.sh` produced zero qa
  # monitors and said nothing about why. A documented off switch that cannot be
  # switched back on is worse than no switch — the operator concludes the
  # feature is broken rather than off.
  #
  # Only the two MONITOR scripts get a qa pass, and that is not an oversight:
  # `apply-slos.sh qa` declares all four SLOs prod-only and applies nothing, and
  # the dashboards are env-agnostic — a second pass would re-push the same
  # boards into the same org under different credentials.
  if dd_qa_monitoring_enabled; then
    run_apply "job monitors (qa)"     "$HERE/apply-monitors.sh"         qa ${DR[@]+"${DR[@]}"}
    run_apply "service monitors (qa)" "$HERE/apply-service-monitors.sh" qa ${DR[@]+"${DR[@]}"}
  else
    echo ""
    echo "  qa monitoring is OFF (DD_QA_MONITORING is not \"on\") — no qa rows applied."
    echo "  Re-enable with: DD_QA_MONITORING=on $(basename "$0")"
  fi

  if ((${#APPLY_FAILED[@]} > 0)); then
    echo "" >&2
    echo "${#APPLY_FAILED[@]} of ${APPLY_TOTAL} apply steps reported failures: ${APPLY_FAILED[*]}" >&2
    echo "Read their output above. A REFUSED ROW is usually correct — it means" >&2
    echo "the series that monitor would watch does not exist yet, and creating" >&2
    echo "it anyway is how a set ends up in NO DATA and gets muted." >&2
    HAD_FAILURES=true
  fi
fi

# ---------------------------------------------------------------------------
if stage verify "what exists now, and what is still a human step"; then
  VERIFY_FAILED=()
  if $DRY_RUN; then
    echo "  would count managed monitors, SLOs and dashboards"
  else
    # FAIL CLOSED, AND ASSERT. This read the two listings with a raw curl, no
    # HTTP status check, and `Array.isArray(d) ? d : (d?.data ?? [])` — so an
    # error body, which is a perfectly valid JSON object with no `data`, fell
    # open to `[]` and printed `0`. A narrow app key or one 429 made the closing
    # report of a successful cutover read "monitors now in the org: 0"
    # immediately after creating 47. And nothing asserted: any count, 0
    # included, exited 0. Every sibling in this directory fails closed here.
    for pair in "monitor:/api/v1/monitor?monitor_tags=managed-by%3Aapply-monitors" \
                "slo:/api/v1/slo"; do
      what="${pair%%:*}"; path="${pair#*:}"
      if ! dd_request GET "https://${DD_API_HOST}${path}"; then
        echo "  could NOT list ${what}s (HTTP ${RESPONSE_STATUS}): ${RESPONSE_BODY}" >&2
        VERIFY_FAILED+=("${what} listing unreadable")
        continue
      fi
      c="$(BODY="$RESPONSE_BODY" node -e '
        let d; try { d = JSON.parse(process.env.BODY); } catch { console.log("-1"); process.exit(0); }
        const arr = Array.isArray(d) ? d : d?.data;
        console.log(Array.isArray(arr) ? arr.length : "-1");
      ')"
      if [[ "$c" == "-1" ]]; then
        echo "  ${what} listing was not an array — refusing to count it" >&2
        VERIFY_FAILED+=("${what} listing not an array")
      elif [[ "$c" -eq 0 ]]; then
        echo "  ${what}s now in the org: 0" >&2
        VERIFY_FAILED+=("zero ${what}s")
      else
        echo "  ${what}s now in the org: ${c}"
      fi
    done
    if ((${#VERIFY_FAILED[@]} > 0)); then
      echo "" >&2
      echo "VERIFY FAILED: ${VERIFY_FAILED[*]}" >&2
      echo "A zero here is not a clean org — the apply above claimed to create" >&2
      echo "these. Read it as either 'the apply did not run' or 'this key cannot" >&2
      echo "read what it just wrote', and settle which before trusting the set." >&2
      HAD_FAILURES=true
    fi
  fi
  echo ""
  echo "STILL A HUMAN STEP, in this order:"
  echo "  1. Set the Vercel variables from stage 'rum' and stage 'vercel'."
  echo "  2. Fire the NEGATIVE TEST. A monitor that has never fired is a monitor"
  echo "     nobody trusts — it is the only end-to-end proof that monitor ->"
  echo "     trigger -> notify -> email works."
  if dd_qa_monitoring_enabled; then
    echo "     Post a synthetic selected=3/written=0 for feed-parse on qa, wait for"
    echo "     the ALERT and the email, then post written=3 to recover."
    echo "     It touches no real job. Commands: docs/reference/datadog-monitoring-appendix.md A13"
  else
    # Being honest about this matters more than it looks. With qa monitoring off
    # there is no qa monitor to fire, so the documented test produces NOTHING —
    # and "qa has no monitors" is indistinguishable from "the notification
    # channel is dead", which is the same unreadable silence the whole epic is
    # about.
    echo "     YOU CANNOT RUN IT AS WRITTEN. The A13 recipe posts to qa, and qa"
    echo "     monitoring is OFF — nothing would watch it, and no-alert would be"
    echo "     indistinguishable from a dead notification channel. Two options:"
    echo "       a. DD_QA_MONITORING=on $(basename "$0") --from=apply, then A13."
    echo "          Costs one qa monitor set you may not want to keep."
    echo "       b. Run A13 against PROD's feed-parse. It touches no real job, but"
    echo "          it does fire a REAL prod monitor — announce it first."
  fi
  echo "  3. Retire the bootstrap prod key — it passed through a chat transcript."
  echo "     Mint a successor, store it, roll again, then delete the old key id."
fi

echo ""
$DRY_RUN && echo "dry run complete — nothing was created, rolled or written."
$HAD_FAILURES && exit 1
exit 0
