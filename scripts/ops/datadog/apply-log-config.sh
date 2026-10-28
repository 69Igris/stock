#!/usr/bin/env bash
#
# Log index hygiene and the nodejs status remap — MONEY-1362.
#
#   ./scripts/ops/datadog/apply-log-config.sh [--dry-run]
#
# ## NO ENVIRONMENT ARGUMENT — and it REFUSES one
#
# Both things this applies are ORG-level. A log index and a log pipeline are
# properties of the Datadog organisation, not of `env:production` or `env:qa`:
# QA's lines land in the SAME `main` index, through the SAME intake pipeline,
# and are separated only by the `env` tag the transport stamps. So there is
# nothing per-environment to parameterise, and the sibling scripts' `{qa|prod}`
# would be an argument that changes nothing.
#
# An argument that changes nothing is worse than no argument. `apply-monitors.sh`
# matched one position against one exact string and let everything else through,
# so `--dryrun` ran 78 LIVE requests against this org. Every argument here is
# matched or the script exits 2 — including `prod`, which is the one somebody
# will type out of habit from the sibling scripts.
#
# ## The dangerous half
#
# `PUT /api/v1/logs/config/indexes/main` REPLACES `exclusion_filters` with the
# array it is given. It is not a merge and it is not additive. A PUT carrying
# only the two filters below silently DELETES every exclusion filter the org
# already had — a change with no error, no diff and no way to notice except a
# bill. So the existing array is read first and merged BY NAME, and the test
# has a case that fails if the pre-existing filters are dropped.
#
# Retention is echoed back EXACTLY as read. Not omitted (the API's default for
# an absent field is not something to discover on a live index), not chosen
# here: cost is a founder decision, and this script is not the place it gets
# made.
#
# ## The unverified half
#
# The status remap is conditional on a RUNTIME measurement — does `status:error`
# come back empty while `level:error` has events — and that measurement cannot
# be made until an app key exists. `@usemoney/logger` stamps `formatters.level:
# (label) => ({ level: label })`, so every line carries `"level":"error"` and NO
# `status` field, and `logger-transport.ts` stamps `ddsource: "nodejs"`. That
# makes the remap LIKELY needed and the filter `source:nodejs` correct, but
# Datadog also auto-installs its own integration pipeline for a recognised
# source, which would already do this under a name we do not check for.
#
# So the check is performed and REPORTED on every live run rather than assumed,
# and a run that cannot show the defect creates nothing. See the summary line.
#
# ## A SKIPPED run is not an APPLIED one — MONEY-1229
#
# The two things above are INDEPENDENT: an exclusion filter is a property of an
# index, a pipeline is a property of the intake. Neither needs the other, and
# they are reported separately.
#
# That was not true for a release. A missing `main` index exited 0 BEFORE both
# of them, so the whole script was a no-op that the runner counted as an applied
# step — `docs/reference/datadog-monitoring-plan.md` records the real cutover as
# "Log config — NOT YET" while `setup-datadog.sh` reported 5 of 5 steps clean.
# The cost control this file exists for was never applied and nothing said so.
#
# Two changes, and the second is the one that generalises:
#
#   - the run ends with a SUMMARY LINE naming the state of each half, and exits
#     3 when either was skipped. Non-zero is what the runner collects; 0 is a
#     claim that the org now matches this file.
#   - the missing-index message states the OBSERVATION and stops. It used to
#     assert the cause — "an org that has never ingested a log has no index" —
#     which is one of two, and picking one is how a real configuration (logs
#     routed to a custom index) gets told to "re-run once logs are flowing"
#     every night forever. The other half of the script now runs in exactly
#     that case, because logs ARE flowing and the remapper is wanted.

set -euo pipefail

DRY_RUN=false
for arg in "$@"; do
  case "$arg" in
    --dry-run) DRY_RUN=true ;;
    *)
      echo "unknown argument: ${arg}" >&2
      echo "usage: $0 [--dry-run]" >&2
      echo "  (no environment argument: the log index and its pipelines are ORG-level)" >&2
      exit 2
      ;;
  esac
done

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$HERE/../../.." && pwd)"

# DERIVED from the same constant the emitters use, never retyped —
# apply-monitors.sh POSTed to US1 for two releases while DD_SITE said otherwise.

if ! $DRY_RUN; then
  : "${DD_API_KEY:?export DD_API_KEY first (GCP Secret Manager: DD_API_KEY_PROD)}"
  : "${DD_APP_KEY:?export DD_APP_KEY first (GCP Secret Manager: DD_APP_KEY_PROD)}"
fi

source "$HERE/lib-datadog.sh"
dd_resolve_api_host || exit 1

INDEX_NAME="main"
PIPELINE_NAME="usemoney-nodejs-status"

# ── Outcome accounting ──────────────────────────────────────────────────────
#
# One line per half, and a non-zero exit when either was skipped. `run_apply` in
# setup-datadog.sh COLLECTS failures and continues, so a skip here is reported
# beside the other four steps rather than taking the cutover down — which is
# what the old `exit 0` was protecting against, at the cost of the report being
# false.
FILTERS_STATE="not reached"
REMAP_STATE="not reached"

finish() {
  echo ""
  echo "exclusion filters (${INDEX_NAME}): ${FILTERS_STATE}"
  echo "status remap (${PIPELINE_NAME}):   ${REMAP_STATE}"
  case "$FILTERS_STATE $REMAP_STATE" in
    *SKIPPED*)
      echo "" >&2
      echo "one or more steps were SKIPPED — this org does NOT yet match" >&2
      echo "apply-log-config.sh. Exiting 3 so the run is not counted as applied." >&2
      exit 3
      ;;
  esac
  exit 0
}

# `sample_rate: 1.0` is DROP ALL, not "keep all". Datadog's exclusion filter
# samples what it EXCLUDES, so 1.0 excludes every matching line and 0.5 would
# keep half of them — which is the reading that turns a cost control into a
# random 50% hole in the debug logs somebody later tries to read.
# `@level:` IS PART OF THE QUERY, and without it this filter does nothing on the
# day it is applied and everything on some later day nobody is watching.
#
# `status` does not exist on our lines until step 2 creates the remapper —
# `formatters.level: (label) => ({ level: label })` stamps `"level":"debug"` and
# no `status` field. So a `status:`-only query is a DROP-ALL that matches
# nothing, PUT unconditionally in step 1, printed as "exclusion filters
# applied". Weeks later the pipeline gets created, `status` appears on every
# nodejs line, and the dormant filter arms itself: every debug and trace line in
# the org stops being indexed, attributed to a run whose only visible action was
# creating a pipeline.
#
# The `@` is load-bearing. `level` is a top-level JSON attribute, not one of
# Datadog's reserved fields (host, source, status, service, message, trace_id),
# and a BARE `level:debug` matches a TAG of that name — which nothing here
# emits, leaving the filter exactly as dormant as before.
#
# With both halves the filter selects the same lines before and after the
# pipeline exists, so there is no arming event: it starts dropping when the run
# that applies it says it did.
DESIRED_FILTERS='[
  {"name":"debug-and-trace","is_enabled":true,"filter":{"query":"status:(debug OR trace) OR @level:(debug OR trace)","sample_rate":1.0}},
  {"name":"health-checks","is_enabled":true,"filter":{"query":"@http.url_details.path:/health*","sample_rate":1.0}}
]'

PIPELINE_BODY='{"name":"usemoney-nodejs-status","is_enabled":true,"filter":{"query":"source:nodejs"},"processors":[{"type":"status-remapper","name":"level -> status","is_enabled":true,"sources":["level"]},{"type":"service-remapper","name":"service","is_enabled":true,"sources":["service"]}]}'

print_desired_filters() {
  DESIRED="$DESIRED_FILTERS" node -e '
    for (const f of JSON.parse(process.env.DESIRED)) console.log(JSON.stringify(f));
  '
}

if $DRY_RUN; then
  echo "would PUT https://${DD_API_HOST}/api/v1/logs/config/indexes/${INDEX_NAME}"
  echo "  merged BY NAME into the org's existing exclusion_filters; retention echoed back unchanged"
  print_desired_filters
  echo "would POST https://${DD_API_HOST}/api/v1/logs/config/pipelines"
  echo "  only when no pipeline named ${PIPELINE_NAME} exists AND the runtime check shows status:error empty while level:error has events"
  echo "$PIPELINE_BODY"
  echo "dry run: no request was made"
  exit 0
fi

# ── 1. Exclusion filters ────────────────────────────────────────────────────

# FAIL CLOSED on an unreadable listing. `curl` exits 0 on a 403, so this is the
# only thing standing between a revoked key and a PUT built from an index body
# that does not exist — which would send `exclusion_filters: []` plus our two,
# i.e. delete the org's filters while reporting success.
if ! dd_request GET "https://${DD_API_HOST}/api/v1/logs/config/indexes"; then
  echo "FATAL: could not read the log index listing (HTTP ${RESPONSE_STATUS})" >&2
  echo "${RESPONSE_BODY}" >&2
  exit 1
fi

INDEX_JSON="$(BODY="$RESPONSE_BODY" NAME="$INDEX_NAME" node -e '
  let doc;
  try { doc = JSON.parse(process.env.BODY); } catch { doc = null; }
  const indexes = doc && Array.isArray(doc.indexes) ? doc.indexes : null;
  if (!indexes) {
    console.error("FATAL: the index listing was not {indexes:[...]} — refusing to PUT");
    process.exit(1);
  }
  const hit = indexes.find((i) => i && i.name === process.env.NAME);
  if (!hit) {
    // THE OBSERVATION, AND NOT A CAUSE. There are at least two, they need
    // opposite actions, and nothing in this response distinguishes them:
    // an org that has never ingested a log has no index at all (Datadog
    // creates `main` on the first line), and an org whose logs are routed to
    // a differently-named index has every log it will ever have. Asserting
    // the first tells the second to "re-run once logs are flowing" on every
    // run, forever, while the filters are never applied anywhere.
    console.error(
      `no log index named ${process.env.NAME}. Indexes present: ` +
        `${indexes.length ? indexes.map((i) => i.name).join(", ") : "(none)"}.` +
        "\n  Either this org has not ingested a log yet (Datadog creates " +
        "`main` on the first one — re-run once logs are flowing), or the " +
        "logs are routed to one of the indexes listed above, in which case " +
        "INDEX_NAME in this script is pointing at the wrong one.",
    );
    process.exit(3);
  }
  console.log(JSON.stringify(hit));
')" || {
  # Exit 3 is the node script's "no such index". NOT fatal and NOT success: the
  # filters were not applied, so it is recorded as a SKIP and the run continues
  # to the pipeline, which is an INTAKE-level resource and needs no index. The
  # summary line and a non-zero exit carry the outcome — under the old `exit 0`
  # here the whole script was a no-op the runner counted as an applied step.
  rc=$?
  if [[ "$rc" -ne 3 ]]; then
    echo "FATAL: could not read the log index (node exited ${rc})" >&2
    exit 1
  fi
  INDEX_JSON=""
  FILTERS_STATE="SKIPPED — no index named ${INDEX_NAME} (see above)"
}

# Merge, then decide. The comparison is against the array as READ, so "already
# applied" is a property of the org rather than of a marker we wrote.
if [[ -n "$INDEX_JSON" ]]; then
  PUT_BODY="$(INDEX="$INDEX_JSON" DESIRED="$DESIRED_FILTERS" node -e '
    const idx = JSON.parse(process.env.INDEX);
    const desired = JSON.parse(process.env.DESIRED);
    const existing = Array.isArray(idx.exclusion_filters) ? idx.exclusion_filters : [];

    // Replace in place by name, append what is new. Order is preserved because
    // exclusion filters are evaluated in order and reordering them is a
    // behaviour change nobody asked for.
    const merged = existing.map((f) => desired.find((d) => d.name === f?.name) ?? f);
    for (const d of desired) if (!merged.some((f) => f?.name === d.name)) merged.push(d);

    if (JSON.stringify(merged) === JSON.stringify(existing)) {
      console.log("UNCHANGED");
      process.exit(0);
    }

    // The FULL body. `filter` is required by the API; retention and the daily
    // limit are echoed back exactly as read so this script never decides cost.
    const body = { filter: idx.filter ?? { query: "" }, exclusion_filters: merged };
    if (typeof idx.num_retention_days === "number") body.num_retention_days = idx.num_retention_days;
    if (idx.disable_daily_limit === true) body.disable_daily_limit = true;
    else if (typeof idx.daily_limit === "number") body.daily_limit = idx.daily_limit;
    console.log(JSON.stringify(body));
  ')"

  if [[ "$PUT_BODY" == "UNCHANGED" ]]; then
    echo "exclusion filters unchanged (${INDEX_NAME})"
    FILTERS_STATE="unchanged — the org already carries both"
  else
    if ! dd_request PUT "https://${DD_API_HOST}/api/v1/logs/config/indexes/${INDEX_NAME}" "$PUT_BODY"; then
      echo "FATAL: PUT ${INDEX_NAME} failed (HTTP ${RESPONSE_STATUS})" >&2
      echo "${RESPONSE_BODY}" >&2
      exit 1
    fi
    echo "exclusion filters applied (${INDEX_NAME})"
    FILTERS_STATE="applied"
  fi
fi

# ── 2. The status remap, if the org needs it ────────────────────────────────
#
# REPORTED, not assumed. `dd_events_exist` is the library's helper (the design
# note calls it `dd_logs_have_events`; that function does not exist).

# A FAILED search is not an empty one. `dd_events_exist` returns 2 when the
# search did not run at all — a 403 from an app key scoped without
# `logs_read_data`, a transient 429/5xx, an unparsable body — and 2 collapsed
# into "no events" is what turns this gate inside out: BOTH conditions below are
# satisfied by absence, so an org-wide status- and service-remapper would be
# created on a measurement that never happened. Especially on the SECOND search
# alone, which needs no help from the first to pass.
LEVEL_RC=0
dd_events_exist logs "level:error service:stockbook-workers env:production" || LEVEL_RC=$?
STATUS_RC=0
dd_events_exist logs "status:error service:stockbook-workers env:production" || STATUS_RC=$?
if [[ "$LEVEL_RC" -ge 2 || "$STATUS_RC" -ge 2 ]]; then
  echo "FATAL: a log search did not run (level:error rc=${LEVEL_RC}, status:error rc=${STATUS_RC}) — refusing to decide the status remap on a measurement that never happened" >&2
  echo "  last response (HTTP ${RESPONSE_STATUS}): ${RESPONSE_BODY}" >&2
  echo "  an app key without logs_read_data returns 403 here; the exclusion filters above are already applied" >&2
  exit 1
fi
if [[ "$LEVEL_RC" -eq 0 ]]; then LEVEL_HAS_EVENTS=true; else LEVEL_HAS_EVENTS=false; fi
if [[ "$STATUS_RC" -eq 0 ]]; then STATUS_HAS_EVENTS=true; else STATUS_HAS_EVENTS=false; fi
echo "observation (24h, service:stockbook-workers env:production): level:error events=${LEVEL_HAS_EVENTS}, status:error events=${STATUS_HAS_EVENTS}"

# ORDER MATTERS, and it was the other way round.
#
# `status:error` resolving is a POSITIVE answer that needs no other
# measurement: the behaviour this remapper would create already exists, so the
# step is DONE. Checking `level:error` first meant that answer was unreachable
# in the one state it describes — once the remapper is unnecessary, `level:error`
# never has events again, so the script reported SKIPPED and exited 3 FOREVER,
# and `setup-datadog.sh` carried a permanently failing step. Measured on prod
# 2026-09-08: `level:error events=false, status:error events=true` printed, and
# the run still exited 3.
#
# The two conditions are independent. Ask the one that can settle it on its own
# first; fall back to "could not measure" only when nothing settles it.
if $STATUS_HAS_EVENTS; then
  echo "skipping the status remap: status:error already returns events, so something upstream already maps it"
  # DONE, not skipped: the org already has the behaviour this would create.
  REMAP_STATE="not needed — status:error already resolves"
  finish
fi
if ! $LEVEL_HAS_EVENTS; then
  echo "skipping the status remap: no level:error events either, so nothing was measured — re-run when the workers have logged an error"
  # A SKIP, not a pass. The gate could not be evaluated, so whether this org
  # needs the remapper is still unknown — reporting that as "applied" is the
  # same claim the missing-index branch used to make.
  REMAP_STATE="SKIPPED — nothing measured (no level:error events in 24h)"
  finish
fi

if ! dd_request GET "https://${DD_API_HOST}/api/v1/logs/config/pipelines"; then
  echo "FATAL: could not list log pipelines (HTTP ${RESPONSE_STATUS})" >&2
  echo "${RESPONSE_BODY}" >&2
  exit 1
fi
# Three outcomes, never two. "Already there" and "could not tell" both stop the
# POST, but only the second is a failure — collapsing them would report a
# broken read as a healthy no-op, which is the shape of half this directory's
# history. Fails closed on a non-array for the same reason dd_list_managed
# does: read as "no pipelines exist", every run POSTs another copy, and
# pipelines are ORDERED — a duplicate is not inert, it re-processes every line.
PIPELINE_STATE="$(EXISTING="$RESPONSE_BODY" NAME="$PIPELINE_NAME" node -e '
  let v;
  try { v = JSON.parse(process.env.EXISTING); } catch { v = null; }
  if (!Array.isArray(v)) { console.log("UNREADABLE"); process.exit(0); }
  console.log(v.some((p) => p && p.name === process.env.NAME) ? "PRESENT" : "ABSENT");
')"
case "$PIPELINE_STATE" in
  UNREADABLE)
    echo "FATAL: pipeline listing was not a JSON array — refusing to POST" >&2
    echo "${RESPONSE_BODY}" >&2
    exit 1
    ;;
  PRESENT)
    echo "pipeline ${PIPELINE_NAME} already exists"
    REMAP_STATE="already present"
    finish
    ;;
esac

if ! dd_request POST "https://${DD_API_HOST}/api/v1/logs/config/pipelines" "$PIPELINE_BODY"; then
  echo "FATAL: POST pipeline failed (HTTP ${RESPONSE_STATUS})" >&2
  echo "${RESPONSE_BODY}" >&2
  exit 1
fi
echo "created pipeline ${PIPELINE_NAME}"
REMAP_STATE="created"
finish
