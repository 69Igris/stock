#!/usr/bin/env bash
#
# Dashboards as code — MONEY-1361.
#
#   ./scripts/ops/datadog/apply-dashboards.sh {qa|prod} [--dry-run]
#
# ## Why the boards are files
#
# A dashboard edited in the UI has no diff, no review and no way to come back
# after somebody deletes a widget "temporarily". Worse, it has no way to be
# CHECKED: the failure this whole directory exists for is a query over a series
# nobody emits, which renders as an empty graph and is indistinguishable from a
# healthy quiet system. In a file, the queries can be read by a test —
# `packages/datadog/__tests__/dashboards-agreement.test.ts` asserts every metric
# named in every widget against an inventory DERIVED from the code that emits
# it. That check is the reason for the ticket; the idempotent apply below is
# just what makes the file the source of truth rather than a copy of one.
#
# ## One board, both environments
#
# Every query is scoped by the `$env` TEMPLATE VARIABLE rather than a literal
# `env:production`, so the same board answers for QA by switching the selector.
# A hardcoded env is not merely inflexible — it is a board that keeps rendering
# prod's numbers while its title says qa, which is a worse failure than an empty
# one because it looks right.
#
# ## What is idempotent, and by what
#
# By TITLE. `GET /api/v1/dashboard` lists, an exact title match becomes a
# `PUT /api/v1/dashboard/{id}`, and only a genuinely new title POSTs. Change a
# title and the next run creates a SECOND board rather than renaming the first,
# so titles are stable identifiers here and not decoration.
#
# The listing FAILS CLOSED, for the reason `dd_list_managed` does: `curl` exits
# 0 on a 403, and reading an unreadable listing as "no dashboards exist" POSTs a
# duplicate of every board on the account.
set -euo pipefail

ENV_ARG="${1:-}"
DRY_RUN=false
for arg in "${@:2}"; do
  case "$arg" in
    --dry-run) DRY_RUN=true ;;
    *) echo "unknown argument: ${arg}" >&2; exit 2 ;;
  esac
done
# The environment argument selects CREDENTIALS and nothing else, and that is
# worth saying out loud because the sibling scripts use it differently. QA and
# production share ONE Datadog org (us5) with two API keys, and every query on
# every board is scoped by the `$env` template variable — so both keys produce
# the identical board. Substituting the argument into the boards' `default`
# would be actively harmful: same title, so a `qa` run would silently flip the
# production board's selector to qa and leave it looking perfectly normal.
case "$ENV_ARG" in
  prod|qa) ;;
  *) echo "usage: $0 {qa|prod} [--dry-run]" >&2; exit 2 ;;
esac

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$HERE/../../.." && pwd)"

# DERIVED from the same constant the emitters use, never retyped —
# apply-monitors.sh POSTed to US1 for two releases while DD_SITE said otherwise.

if ! $DRY_RUN; then
  # `${ENV_ARG^^}` is a bash-4 expansion and macOS ships bash 3.2, where it
  # renders as "bad substitution" INSIDE the very message that is supposed to
  # name the secret to fetch. `tr` is POSIX and works on both.
  ENV_UPPER="$(printf %s "$ENV_ARG" | tr '[:lower:]' '[:upper:]')"
  : "${DD_API_KEY:?export DD_API_KEY first (GCP Secret Manager: DD_API_KEY_${ENV_UPPER})}"
  : "${DD_APP_KEY:?export DD_APP_KEY first (GCP Secret Manager: DD_APP_KEY_${ENV_UPPER})}"
fi

source "$HERE/lib-datadog.sh"
dd_resolve_api_host || exit 1

FAILED=()
APPLIED=0

BOARDS=("$HERE"/dashboards/*.json)
((${#BOARDS[@]} > 0)) || { echo "FATAL: no dashboards/*.json found" >&2; exit 1; }

# ── The existing boards, or an abort ────────────────────────────────────────
#
# `dd_list_managed` cannot be reused: it hits /api/v1/monitor and requires the
# body to be a bare ARRAY. The dashboard listing is `{"dashboards":[…]}`, so the
# shape check is different — but the failure mode it guards is identical, and so
# is the response to it.
#
# AND IT IS PAGED. `GET /api/v1/dashboard` with no query string returns whatever
# the server decides one page is, and the shape guard only requires an array —
# so a truncated page is a VALID one. A board missing from a short page is a
# title miss, a title miss falls through to POST, and a POST is counted as
# APPLIED: the accounting check passes, the run prints success, and the account
# gains a duplicate board. Every step of that is silent.
#
# The page size the server actually honours is not something this script can
# know, so it does not guess: it asks for a large page and keeps asking until a
# page contributes NO NEW ids. Terminating on a SHORT page would still truncate
# against a server that caps `count` below what we asked for; terminating on new
# ids is correct whatever the cap, and stops after one extra request against a
# server (or a stub) that ignores `start` entirely.
EXISTING_JSON='{"dashboards":[]}'
if ! $DRY_RUN; then
  DASH_PAGE=1000
  DASH_START=0
  while :; do
    if ! dd_request GET "https://${DD_API_HOST}/api/v1/dashboard?count=${DASH_PAGE}&start=${DASH_START}"; then
      echo "FATAL: could not list existing dashboards (HTTP ${RESPONSE_STATUS})" >&2
      echo "${RESPONSE_BODY}" >&2
      exit 1
    fi
    # One node call per page: validate the shape, merge by id, and report
    # "<returned> <new>" on the first line so the loop can advance and stop.
    PAGE="$(HAVE="$EXISTING_JSON" BODY="$RESPONSE_BODY" node -e '
      let v;
      try { v = JSON.parse(process.env.BODY); } catch { v = null; }
      if (!Array.isArray(v?.dashboards)) { console.log("UNREADABLE"); process.exit(0); }
      const have = JSON.parse(process.env.HAVE).dashboards;
      const seen = new Set(have.map((d) => d && d.id));
      const fresh = v.dashboards.filter((d) => d && !seen.has(d.id));
      console.log(`${v.dashboards.length} ${fresh.length}`);
      console.log(JSON.stringify({ dashboards: have.concat(fresh) }));
    ')" || {
      # Without this the substitution's failure aborts the run under `set -e`
      # with no message at all — the old code's `if ! … node …` at least named
      # the step.
      echo "FATAL: could not read the dashboard listing page at start=${DASH_START}" >&2
      echo "${RESPONSE_BODY}" >&2
      exit 1
    }
    if [[ "$PAGE" == "UNREADABLE" ]]; then
      echo "FATAL: dashboard listing had no dashboards[] — refusing to POST" >&2
      echo "${RESPONSE_BODY}" >&2
      exit 1
    fi
    DASH_COUNTS="${PAGE%%$'\n'*}"
    EXISTING_JSON="${PAGE#*$'\n'}"
    DASH_RETURNED="${DASH_COUNTS%% *}"
    DASH_NEW="${DASH_COUNTS##* }"
    # `[[ … ]] && break` would be a failing AND-list under `set -e` on every
    # non-final page, which kills the run inside the loop that is still working.
    if [[ "$DASH_NEW" -eq 0 ]]; then break; fi
    DASH_START=$((DASH_START + DASH_RETURNED))
  done
fi

# ── SLO references ──────────────────────────────────────────────────────────
#
# An `slo` widget needs an ID, and an ID is minted by apply-slos.sh at apply
# time — so the boards carry `{{slo:<exact SLO name>}}` and this resolves it.
# Deliberately NOT dd_render's `{{word}}` syntax: that renderer throws on a
# placeholder no variable supplies, which is right for a monitor template and
# wrong here, where the value can only come from the API.
#
# An unresolvable reference is a NAMED FAILURE, never a board applied with the
# widget quietly dropped. Datadog accepts an `slo` widget with a nonsense id and
# renders it blank, so "applied successfully" would otherwise be a lie.
resolve_slo_id() {
  local name="$1" encoded
  encoded="$(NAME="$name" node -e 'process.stdout.write(encodeURIComponent(process.env.NAME))')"
  dd_request GET "https://${DD_API_HOST}/api/v1/slo?query=${encoded}" || return 1
  BODY="$RESPONSE_BODY" NAME="$name" node -e '
    const hit = (JSON.parse(process.env.BODY).data ?? []).find(
      (s) => s.name === process.env.NAME,
    );
    if (!hit?.id) process.exit(1);
    process.stdout.write(hit.id);
  '
}

for FILE in "${BOARDS[@]}"; do
  LABEL="$(basename "$FILE" .json)"

  # dd_render strips `_`-prefixed documentation keys at EVERY depth — the boards
  # use `_why` / `_units` heavily, JSON has no comments, and Datadog rejects an
  # unknown field inside a widget definition. No `{{word}}` placeholders exist
  # in these files, so the variable set is deliberately empty.
  BODY="$(dd_render "$FILE" '{}')" || {
    FAILED+=("${LABEL}: render failed")
    continue
  }

  # Resolve every {{slo:…}} the board names.
  SLO_NAMES="$(BODY="$BODY" node -e '
    const seen = new Set();
    for (const m of process.env.BODY.matchAll(/\{\{slo:([^}]+)\}\}/g)) seen.add(m[1]);
    for (const n of seen) console.log(n);
  ')"
  RESOLVE_FAILED=false
  while IFS= read -r SLO_NAME; do
    [[ -z "$SLO_NAME" ]] && continue
    if $DRY_RUN; then
      echo "   would resolve SLO: ${SLO_NAME}" >&2
      continue
    fi
    if ! SLO_ID="$(resolve_slo_id "$SLO_NAME")" || [[ -z "$SLO_ID" ]]; then
      FAILED+=("${LABEL}: no SLO named '${SLO_NAME}' — run apply-slos.sh ${ENV_ARG} first")
      RESOLVE_FAILED=true
      break
    fi
    BODY="$(BODY="$BODY" NAME="$SLO_NAME" ID="$SLO_ID" node -e '
      const token = `{{slo:${process.env.NAME}}}`;
      process.stdout.write(process.env.BODY.split(token).join(process.env.ID));
    ')"
  done <<< "$SLO_NAMES"
  if $RESOLVE_FAILED; then continue; fi

  # A live run must never PUT a body still carrying a placeholder. In --dry-run
  # the tokens are deliberately LEFT IN, so the render shows which SLOs the
  # board depends on.
  if ! $DRY_RUN && [[ "$BODY" == *"{{"* ]]; then
    FAILED+=("${LABEL}: unsubstituted placeholder in the rendered body")
    continue
  fi

  TITLE="$(BODY="$BODY" node -e '
    const t = JSON.parse(process.env.BODY).title;
    if (!t) throw new Error("no title");
    console.log(t);
  ')" || { FAILED+=("${LABEL}: unreadable rendered body"); continue; }

  if $DRY_RUN; then
    echo "$BODY"
    APPLIED=$((APPLIED + 1))
    continue
  fi

  ID="$(EXISTING="$EXISTING_JSON" TITLE="$TITLE" node -e '
    const hit = JSON.parse(process.env.EXISTING).dashboards.find(
      (d) => d.title === process.env.TITLE,
    );
    if (hit) console.log(hit.id);
  ')"
  if [[ -n "$ID" ]]; then
    if dd_request PUT "https://${DD_API_HOST}/api/v1/dashboard/${ID}" "$BODY"; then
      echo "   updated ${LABEL} (${ID})"
      APPLIED=$((APPLIED + 1))
      continue
    fi
    FAILED+=("${LABEL} (PUT ${ID}, HTTP ${RESPONSE_STATUS}) ${RESPONSE_BODY}")
  else
    if dd_request POST "https://${DD_API_HOST}/api/v1/dashboard" "$BODY"; then
      echo "   created ${LABEL}"
      APPLIED=$((APPLIED + 1))
      continue
    fi
    FAILED+=("${LABEL} (POST, HTTP ${RESPONSE_STATUS}) ${RESPONSE_BODY}")
  fi
done

if ((${#FAILED[@]} > 0)); then
  echo "" >&2
  echo "${#FAILED[@]} of ${#BOARDS[@]} boards did NOT apply:" >&2
  printf '  - %s\n' "${FAILED[@]}" >&2
  exit 1
fi

# The same accounting the sibling scripts do: a board that fell through both the
# applied and the failed path is a silent no-op, which is the failure mode this
# whole directory is about.
if ((APPLIED != ${#BOARDS[@]})); then
  echo "FATAL: ${APPLIED} applied != ${#BOARDS[@]} boards" >&2
  exit 1
fi
echo "applied ${APPLIED} of ${#BOARDS[@]} boards (${ENV_ARG} credentials; boards are env-agnostic)"
