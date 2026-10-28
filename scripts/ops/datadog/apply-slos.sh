#!/usr/bin/env bash
#
# SLOs as code — MONEY-1360.
#
#   ./scripts/ops/datadog/apply-slos.sh {qa|prod} [--dry-run]
#
# ## What an SLO adds that the monitors do not
#
# A monitor answers "is this broken NOW". Forty of them answer it forty times
# and never once say how much of the month the pipeline actually worked. That
# number is the one a decision is made against — whether to spend the next
# sprint on reliability or on features — and nothing in this directory produced
# it before this file.
#
# All four are 30-day and PROD-ONLY. QA's error budget is not a thing anyone
# would spend, and an SLO over an environment nobody watches is another number
# that reads healthy because nobody looks.
#
# ## It fails CLOSED, and that is the whole file
#
# A monitor-based SLO over ZERO monitors is 100% compliant forever. It renders
# green on a dashboard, burns no budget, and is indistinguishable from a
# pipeline that never failed — the exact "reads healthy because it measures
# nothing" defect MONEY-1238 was, one layer up. So:
#
#   - a pattern that resolves fewer monitors than the row declares in
#     `min_monitors` ABORTS, naming the SLO and both counts;
#   - a listing that cannot be read or is not an array ABORTS (curl exits 0 on
#     a 403, so the status has to be checked — dd_list_managed does);
#   - the metric SLO's DENOMINATOR is preflighted with dd_metric_has_points,
#     because a server span's name is a dd-trace convention rather than a
#     guarantee: a framework plugin, a loader flag or a
#     DD_TRACE_SPAN_ATTRIBUTE_SCHEMA change renames it and the ratio becomes
#     0/0, which Datadog renders as no data and a reader renders as fine.
#     MONEY-1534 is that, measured: the workers' `web.request` became
#     `hono.request` and this preflight refused the row. The denominator, and
#     never the numerator — the numerator subtracts an errors series that does
#     not exist while the service is healthy.
#
# `min_monitors` rather than a bare zero check on purpose. Zero is not the only
# bad count: a pattern narrowed from 40 monitors to 1 still resolves
# "something", and an SLO over 1/40th of the estate is the same lie with a
# smaller blast radius.
#
# ## Two ways to name monitors, and they fail closed differently
#
# `monitor_name_pattern` + `min_monitors` says "every monitor that asks this
# question, and never fewer than N of them". It is the right shape when the
# population is open-ended — a new absence monitor should join its SLO without
# an edit here.
#
# `monitor_names` says "these exact monitors". EVERY name must resolve or the
# row is refused, so a renamed template is a hard failure rather than a quiet
# narrowing. It exists because Datadog caps a monitor SLO at 20 monitor_ids
# (measured: 40 ids -> 400 "Maximum number of elements in parameter
# 'monitor_ids' should be 20"), which forces the zero-write SLO to cover a
# DECLARED subset of the estate. A subset is only honest if it is written down
# and cannot drift, and a pattern that happens to match 16 of 40 is neither.
#
# The cap is enforced HERE as well, before the request. A 400 from Datadog names
# the parameter but not the row, arrives after some rows have already been
# written, and reads like an outage; refusing locally names the SLO, the count
# and the limit, and writes nothing.
#
# ## Why the ids are resolved and not written down
#
# Datadog's SLO API takes `monitor_ids`, which are assigned at monitor-creation
# time and differ per org. A checked-in id list would be correct exactly once.
# The names are the stable key — apply-monitors.sh renders them from templates
# in this directory — so the ids are looked up on every run from the same
# managed-by tag apply-monitors.sh writes.
set -euo pipefail

ENV_ARG="${1:-}"
DRY_RUN=false
for arg in "${@:2}"; do
  case "$arg" in
    --dry-run) DRY_RUN=true ;;
    *) echo "unknown argument: ${arg}" >&2; exit 2 ;;
  esac
done
case "$ENV_ARG" in
  prod) DD_ENV_TAG="production" ;;
  qa)   DD_ENV_TAG="qa" ;;
  *) echo "usage: $0 {qa|prod} [--dry-run]" >&2; exit 2 ;;
esac

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$HERE/../../.." && pwd)"
SLOS_FILE="$HERE/slos.json"

# PROD ONLY, and said out loud. A script that accepts `qa` and silently does
# nothing is indistinguishable from one that ran and found nothing to do, which
# is the failure shape this whole epic exists to remove.
if [[ "$ENV_ARG" != "prod" ]]; then
  echo "no SLOs are defined for ${ENV_ARG} — all four are prod-only (30-day"
  echo "budgets over an environment nobody watches are numbers nobody spends)."
  echo "applied 0, skipped 0 of 0 rows (${ENV_ARG})"
  exit 0
fi

# The API host is DERIVED from the same constant the emitters use, never
# retyped. apply-monitors.sh POSTed to US1 for two releases while DD_SITE said
# otherwise, so the monitors were created in an org that never receives the
# metric (MONEY-1238 fault (d)).

if ! $DRY_RUN; then
  : "${DD_API_KEY:?export DD_API_KEY first (GCP Secret Manager: DD_API_KEY_PROD)}"
  : "${DD_APP_KEY:?export DD_APP_KEY first (GCP Secret Manager: DD_APP_KEY_PROD)}"
fi

source "$HERE/lib-datadog.sh"
dd_resolve_api_host || exit 1

# The tag apply-monitors.sh and apply-service-monitors.sh write on everything
# they create. It is how the ids are found; it is NOT what this script tags its
# own output with, and conflating the two would make the SLOs invisible to
# their own upsert.
MONITOR_TAG="managed-by:apply-monitors"
SLO_TAG="managed-by:apply-slos"

FAILED=()
APPLIED=0
SKIPPED=0
EXISTING_JSON="[]"
# Skipped on a dry run for the same reason the preflights are: there are no
# credentials there, and a dry run is a rendering check rather than a claim
# about the org. The consequence is stated in the printed output below — a dry
# run resolves zero ids and says so, so nobody reads an empty `monitor_ids` as
# a passing resolution.
$DRY_RUN || dd_list_managed "$MONITOR_TAG"

# ── Resolve + render, in one pass ────────────────────────────────────────────
#
# Node owns this because both halves are JSON work: matching a stored regex
# against monitor names, and building a body whose shape differs by `type`. It
# prints one compact JSON body per line on stdout, and an indented count line
# before each — which is the resolution evidence. A `min_monitors` shortfall
# exits non-zero here, so the command substitution below fails and `set -e`
# stops the run before anything is written.
BODIES="$(
  SLOS="$SLOS_FILE" EXISTING="$EXISTING_JSON" ENV_TAG="$DD_ENV_TAG" \
  SLO_TAG="$SLO_TAG" DRY="$($DRY_RUN && echo 1 || echo 0)" node -e '
    const fs = require("node:fs");
    const rows = JSON.parse(fs.readFileSync(process.env.SLOS, "utf8"));
    if (!Array.isArray(rows) || rows.length === 0)
      throw new Error("slos.json is not a non-empty array");
    const monitors = JSON.parse(process.env.EXISTING);
    const dry = process.env.DRY === "1";
    const out = [];
    for (const row of rows) {
      // Built field by field rather than spread-and-strip: `_why`,
      // `monitor_name_pattern` and `min_monitors` are OURS, and Datadog rejects
      // an unknown field with a 400 that names it. An explicit body cannot leak
      // one; a strip can miss a depth (lib-datadog.sh:dd_render carries that
      // scar).
      const body = {
        name: row.name,
        type: row.type,
        thresholds: row.thresholds,
        tags: [process.env.SLO_TAG, `env:${process.env.ENV_TAG}`],
      };
      // Sent when present because it is the only caveat a BOARD READER ever
      // sees: `_why` lives in this repo, and the zero-write SLO covers a
      // declared 16 of 40 monitors under a name that does not say so.
      if (row.description) body.description = row.description;
      if (row.type === "monitor") {
        // An exact NAME LIST beats the pattern when present — see the header.
        // The floor moves with it: every declared name must resolve, so the
        // "needs at least" message below is an equality for this shape.
        const wanted = Array.isArray(row.monitor_names)
          ? row.monitor_names
          : null;
        const hits = wanted
          ? monitors.filter((m) => wanted.includes(m.name))
          : monitors.filter((m) => new RegExp(row.monitor_name_pattern).test(m.name));
        const floor = wanted ? wanted.length : row.min_monitors;
        // The Datadog cap, refused here rather than discovered as a 400 after
        // some rows have already been written. NOTE this whole node program is
        // a single-quoted shell string: an apostrophe anywhere in it, comments
        // included, ends the quote and the script dies on a syntax error.
        if (hits.length > 20) {
          console.error(
            `FATAL: "${row.name}" resolved ${hits.length} monitors; Datadog ` +
              "caps a monitor SLO at 20 monitor_ids. Narrow the set (and say " +
              "so in `description`) rather than sending a request that is " +
              "refused 400 halfway through the run.",
          );
          process.exit(1);
        }
        if (!dry && hits.length < floor) {
          console.error(
            `FATAL: "${row.name}" resolved ${hits.length} monitors, needs at ` +
              `least ${floor}.\n` +
              `  ${wanted ? `names: ${wanted.join(", ")}` : `pattern: ${row.monitor_name_pattern}`}\n` +
              `  An SLO over too few monitors is compliant forever — it burns ` +
              `no budget and reads exactly like a pipeline that never failed. ` +
              `Refusing to create or update it.\n` +
              `  ${monitors.length} monitors carry the managed tag; check ` +
              `apply-monitors.sh has been applied to this org, and that the ` +
              `template name still matches the pattern.`,
          );
          process.exit(1);
        }
        body.monitor_ids = hits.map((m) => m.id);
        out.push(
          `   ${row.name}: resolved ${hits.length} monitors` +
            (dry ? " (dry run — the listing needs credentials)" : ""),
        );
      } else if (row.type === "metric") {
        body.query = row.query;
      } else {
        console.error(`FATAL: "${row.name}" has unknown type "${row.type}"`);
        process.exit(1);
      }
      out.push(JSON.stringify(body));
    }
    console.log(out.join("\n"));
  '
)" || { echo "FATAL: could not resolve the SLO set — nothing was written" >&2; exit 1; }

# ── Upsert ───────────────────────────────────────────────────────────────────
#
# By NAME, because an SLO id is assigned at creation and this file has none.
# Fails closed the same way dd_list_managed does: a search that cannot be read
# aborts the ROW rather than falling through to a POST, since a POST on a name
# that already exists creates a SECOND SLO and both then appear on the board.
upsert_slo() {
  local body="$1" name id encoded
  name="$(BODY="$body" node -e 'console.log(JSON.parse(process.env.BODY).name)')" || {
    FAILED+=("(unreadable rendered body)")
    return 1
  }

  # The denominator preflight, per row and only where there is one. Same
  # rationale as apply-service-monitors.sh's APM rows: a ratio over a series
  # nobody emits is 0/0, which renders as no data and reads as fine.
  local denom
  denom="$(BODY="$body" node -e '
    const b = JSON.parse(process.env.BODY);
    if (b.type === "metric") console.log(b.query.denominator);
  ')"
  if [[ -n "$denom" ]]; then
    dd_metric_has_points "$denom" || {
      FAILED+=("${name}: no points in 24h for ${denom} — the span name is a dd-trace convention, not a guarantee (MONEY-1534); check the service is tracing, re-measure its server span, and keep slos.json in step with DD_SERVER_SPAN in packages/datadog/src/constants.ts")
      return 1
    }
  fi

  if $DRY_RUN; then
    echo "$body"
    APPLIED=$((APPLIED + 1))
    return 0
  fi

  encoded="$(NAME="$name" node -e 'process.stdout.write(encodeURIComponent(process.env.NAME))')"
  if ! dd_request GET "https://${DD_API_HOST}/api/v1/slo?query=${encoded}"; then
    FAILED+=("${name} (search, HTTP ${RESPONSE_STATUS}) ${RESPONSE_BODY}")
    return 1
  fi
  id="$(RESP="$RESPONSE_BODY" NAME="$name" node -e '
    const d = JSON.parse(process.env.RESP).data;
    if (!Array.isArray(d)) throw new Error("slo search did not return data[]");
    const hit = d.find((s) => s.name === process.env.NAME);
    if (hit) console.log(hit.id);
  ')" || {
    FAILED+=("${name}: unparsable search response — refusing to POST a possible duplicate")
    return 1
  }

  if [[ -n "$id" ]]; then
    if dd_request PUT "https://${DD_API_HOST}/api/v1/slo/${id}" "$body"; then
      echo "   updated ${name} (#${id})"
      APPLIED=$((APPLIED + 1))
      return 0
    fi
    FAILED+=("${name} (PUT ${id}, HTTP ${RESPONSE_STATUS}) ${RESPONSE_BODY}")
  else
    if dd_request POST "https://${DD_API_HOST}/api/v1/slo" "$body"; then
      echo "   created ${name}"
      APPLIED=$((APPLIED + 1))
      return 0
    fi
    FAILED+=("${name} (POST, HTTP ${RESPONSE_STATUS}) ${RESPONSE_BODY}")
  fi
  return 1
}

ROW_COUNT="$(SLOS="$SLOS_FILE" node -e '
  console.log(JSON.parse(require("node:fs").readFileSync(process.env.SLOS, "utf8")).length);
')"

# `while read` over a HERE-STRING, not a pipe: a pipeline runs the loop body in
# a subshell and every FAILED/APPLIED increment is discarded when it exits, so
# the accounting at the bottom would pass on a run where nothing applied.
while IFS= read -r LINE; do
  [[ -n "$LINE" ]] || continue
  case "$LINE" in
    \{*) upsert_slo "$LINE" || true ;;
    *) echo "$LINE" ;;
  esac
done <<< "$BODIES"

if ((${#FAILED[@]} > 0)); then
  echo "" >&2
  echo "${#FAILED[@]} of ${ROW_COUNT} SLOs did NOT apply:" >&2
  printf '  - %s\n' "${FAILED[@]}" >&2
  exit 1
fi

# The same accounting the sibling scripts do: a row that was neither applied nor
# deliberately skipped is a silent no-op, which is the failure this whole file
# is about.
if ((APPLIED + SKIPPED != ROW_COUNT)); then
  echo "FATAL: ${APPLIED} applied + ${SKIPPED} skipped != ${ROW_COUNT} rows" >&2
  exit 1
fi
echo "applied ${APPLIED}, skipped ${SKIPPED} of ${ROW_COUNT} rows (${ENV_ARG})"
