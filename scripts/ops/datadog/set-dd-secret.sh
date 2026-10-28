#!/usr/bin/env bash
#
# Put a Datadog key into GCP Secret Manager, having PROVEN it works first.
#
#   scripts/ops/datadog/set-dd-secret.sh DD_APP_KEY_PROD
#   (paste the key, press ctrl-D)
#
# ## Why this script exists rather than a `gcloud secrets versions add`
#
# 1. THE VALUE NEVER TOUCHES argv, A TERMINAL, OR A LOG. A command line is
#    readable by any process on the box through `ps` — this repo has already
#    been bitten by `pgrep -fl` printing a process environment.
#
#    THREE channels, and the first draft of this script left all three open
#    while this very comment claimed otherwise:
#      - the STORE: `gcloud secrets versions add --data-file=-` takes a pipe.
#      - the PROBE: `curl -K -` reads its headers from a pipe too.
#        `-H "DD-API-KEY: $KEY"` puts the credential directly on curl's own
#        command line, which is the exact exposure this paragraph was written
#        to prevent — found by review, not by writing it down.
#      - the PASTE: `read -rs` keeps it off the terminal and out of scrollback.
#
# 2. IT IS VALIDATED BEFORE IT IS STORED, and that is the whole point. A wrong
#    Datadog key does not fail loudly: the intake answers 403 and every client
#    in this estate treats a failed POST as nothing to report, so a typo'd or
#    stale key presents as a quiet, healthy-looking absence of data. That is
#    MONEY-1238's defect class arriving through the secret store instead of
#    through a monitor query.
#
#    This is not hypothetical here. Measured 2026-09-05: DD_API_KEY_PROD and
#    DD_API_KEY_QA both held the OLD us3 org's keys — 200 against us3, 403
#    against us5 — while the code had already moved to us5. Every metric, log
#    and trace POST was being refused and dropped in silence.
#
# 3. IT VALIDATES AGAINST THE SITE THE CODE ACTUALLY USES, read out of
#    packages/datadog/src/constants.ts rather than typed here. A second spelling
#    of the site is how the estate ends up authenticating against an org nobody
#    is looking at.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$HERE/lib-datadog.sh"

SECRET="${1:-}"
case "$SECRET" in
  DD_API_KEY_PROD|DD_API_KEY_QA|DD_APP_KEY_PROD|DD_APP_KEY_QA) ;;
  *)
    echo "usage: $(basename "$0") DD_{API,APP}_KEY_{PROD,QA}" >&2
    echo "  the key is read from STDIN, never from an argument" >&2
    exit 2 ;;
esac
[[ $# -eq 1 ]] || { echo "unknown argument: ${2}" >&2; exit 2; }

# The site is a fact in the TypeScript, and it is read in ONE place —
# `dd_resolve_api_host`. This file scraped it with its own `sed`, which made a
# second spelling of precisely the value that must not have two: point 3 of this
# header, contradicted four lines under itself. SITE is the bare host for the UI
# links, derived from the resolver's answer rather than parsed again.
dd_resolve_api_host || exit 1
SITE="${DD_API_HOST#api.}"

GC=(gcloud --account=founder@disdigital.in --project=stock-book-483718)
export CLOUDSDK_ACTIVE_CONFIG_NAME=stockbook

echo "secret : ${SECRET}"
echo "site   : ${SITE}  (from packages/datadog/src/constants.ts)"
# `-s` so the key never reaches the terminal. Without it the value lands in
# scrollback, on any shared screen, and in any terminal-recording tool — the
# same exposure as putting it on argv, arrived at from the other side.
echo -n "paste the key, then press ctrl-D: " >&2
# NO `< /dev/stdin`. `read` already reads standard input, and the redirect is
# not merely redundant: on Linux, opening /dev/stdin fails with "No such device
# or address" when stdin is a pipe in some sandboxes, and the script then dies
# on `KEY: unbound variable` two lines later. macOS opens it happily, so this
# was invisible locally and failed in CI.
IFS= read -rs -d '' KEY || true
KEY="${KEY//[$'\n\r\t ']/}"          # a paste picks up a trailing newline
[[ -n "$KEY" ]] || { echo "" >&2; echo "FATAL: nothing was read from stdin" >&2; exit 1; }
echo "" >&2
echo "read ${#KEY} characters"

# ---- is this even the right KIND of key? -------------------------------------
#
# The two are trivially confused: they live on adjacent pages of the same
# settings screen, both are lowercase hex, and pasting one where the other
# belongs fails with a bare 403 that says nothing about which mistake you made.
# The LENGTHS differ and are stable — 32 for an API key, 40 for an application
# key — so the wrong kind can be named before a request is even sent.
EXPECT_LEN=32; EXPECT_KIND="API key"; EXPECT_PAGE="api-keys"
if [[ "$SECRET" == DD_APP_KEY_* ]]; then
  EXPECT_LEN=40; EXPECT_KIND="APPLICATION key"; EXPECT_PAGE="application-keys"
fi
if [[ "${#KEY}" -ne "$EXPECT_LEN" ]]; then
  echo "" >&2
  echo "REFUSED — ${SECRET} wants a ${EXPECT_KIND} (${EXPECT_LEN} hex characters)," >&2
  echo "and what you pasted is ${#KEY} characters." >&2
  if [[ "${#KEY}" -eq 32 && "$EXPECT_LEN" -eq 40 ]]; then
    echo "" >&2
    echo "32 characters is an API KEY. They are different credentials on adjacent" >&2
    echo "pages of the same screen, and only the application key can read or write" >&2
    echo "monitors, SLOs and dashboards. Get one here:" >&2
    echo "    https://${SITE%%.*}.datadoghq.com/organization-settings/${EXPECT_PAGE}" >&2
  elif [[ "${#KEY}" -eq 40 && "$EXPECT_LEN" -eq 32 ]]; then
    echo "" >&2
    echo "40 characters is an APPLICATION KEY. ${SECRET} wants the API key, which is" >&2
    echo "what the SERVICES send to the intake. Get one here:" >&2
    echo "    https://${SITE%%.*}.datadoghq.com/organization-settings/${EXPECT_PAGE}" >&2
  fi
  echo "" >&2
  echo "NOTHING was written." >&2
  exit 1
fi

# ---- prove it works, on the site the code uses ------------------------------
#
# CURL_RC, and not a bare command substitution. Under `set -euo pipefail`,
# `CODE="$(curl … )"` against an unreachable host exits 6 and the script DIES
# THERE — no message, no "REFUSED", nothing; the operator has pasted a key and
# been told nothing about it. That is the defect `dd_request` was extracted into
# lib-datadog.sh to fix, and it is fixed locally here rather than by calling it
# because `dd_request` always sends BOTH headers: the api-key probe below has no
# application key to pair with, and the paired probe must send the sibling key
# rather than whatever happens to be in the environment.
CURL_RC=0
if [[ "$SECRET" == DD_API_KEY_* ]]; then
  CODE="$(printf 'header = "DD-API-KEY: %s"\n' "$KEY" \
    | curl -sS -o /dev/null -w '%{http_code}' -K - "https://${DD_API_HOST}/api/v1/validate")" \
    || CURL_RC=$?
  WHAT="api key"
else
  # An APPLICATION key cannot be validated alone — every authenticated read
  # needs an api key beside it. The sibling api key for the SAME environment is
  # the right one to pair with: if that pair cannot read, the apply scripts
  # cannot run, which is the only thing this key is for.
  SIBLING="${SECRET/APP/API}"
  if ! API_KEY="$("${GC[@]}" secrets versions access latest --secret="$SIBLING" 2>/dev/null)"; then
    echo "FATAL: ${SIBLING} does not exist yet. Store it first — an application key" >&2
    echo "       cannot be validated on its own." >&2
    exit 1
  fi
  # `/api/v2/validate_keys` is Datadog's own pair validator — documented as
  # "useful as a lightweight authentication probe before issuing other API
  # calls that require full credentials". Cheaper and clearer than listing
  # monitors, and it does not need the monitors_read scope, so a correctly
  # NARROW key still validates.
  CODE="$(printf 'header = "DD-API-KEY: %s"\nheader = "DD-APPLICATION-KEY: %s"\n' "$API_KEY" "$KEY" \
    | curl -sS -o /dev/null -w '%{http_code}' -K - "https://${DD_API_HOST}/api/v2/validate_keys")" \
    || CURL_RC=$?
  unset API_KEY
  WHAT="application key (paired with ${SIBLING})"
fi

if [[ "$CURL_RC" -ne 0 ]]; then
  echo "" >&2
  echo "REFUSED — curl exited ${CURL_RC} without an HTTP answer from ${DD_API_HOST}." >&2
  echo "That is a TRANSPORT failure (DNS, TLS, no route), not a verdict on the" >&2
  echo "key: nothing was proven either way, so NOTHING was written. Retry once" >&2
  echo "the host is reachable." >&2
  exit 1
fi

if [[ "$CODE" != "200" ]]; then
  echo "" >&2
  echo "REFUSED — the ${WHAT} did not authenticate against ${SITE} (HTTP ${CODE})." >&2
  echo "NOTHING was written. Storing it anyway is worse than storing nothing: a" >&2
  echo "bad key is answered 403 and dropped silently, so the estate would read as" >&2
  echo "an idle, healthy system with no data in it." >&2
  # The two endpoints answer DIFFERENTLY and a runbook that greps for one misses
  # the other: `/api/v1/validate` returns 403 for an invalid, missing OR
  # wrong-org api key, while `/api/v2/validate_keys` returns 401 for a bad pair.
  # Datadog documents neither as distinguishing a wrong ORG from a wrong key, so
  # this names the likely cause without claiming the status proves it.
  case "$CODE" in
    401|403) echo "That usually means the key belongs to a DIFFERENT org — we moved us3 -> us5, and the old keys still authenticate against us3." >&2 ;;
  esac
  exit 1
fi
echo "validated: ${WHAT} authenticates against ${SITE}"

# ---- store it ---------------------------------------------------------------
if "${GC[@]}" secrets describe "$SECRET" >/dev/null 2>&1; then
  printf '%s' "$KEY" | "${GC[@]}" secrets versions add "$SECRET" --data-file=- >/dev/null
  echo "stored: new version of ${SECRET}"
else
  printf '%s' "$KEY" | "${GC[@]}" secrets create "$SECRET" --replication-policy=automatic --data-file=- >/dev/null
  echo "stored: created ${SECRET}"
fi
unset KEY

"${GC[@]}" secrets versions list "$SECRET" --limit=3 \
  --format="table(name, state, createTime.date('%Y-%m-%d %H:%M'))"

echo ""
echo "NOTE: a Cloud Run service reads its secret at INSTANCE START. Warm"
echo "      instances keep the old value until they are rolled — see F5 in"
echo "      docs/reference/datadog-monitoring-plan.md."
