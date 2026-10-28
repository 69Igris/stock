#!/usr/bin/env bash
#
# Create the two browser RUM applications and print what Vercel needs.
#
#   scripts/ops/datadog/create-rum-apps.sh [--dry-run]
#
# ## Why this is a script and not four curl commands in a runbook
#
# It is the ONLY remaining step of the us5 cutover with no code behind it, and
# it is the step whose output is copied by hand into another system. A runbook
# curl gives you a wall of JSON to squint at; this prints the four
# NAME=value lines and nothing else, so the transcription cannot go wrong in the
# one place a mistake is invisible — a RUM application id that belongs to the
# other environment produces sessions, dashboards and monitors that all look
# healthy while describing the wrong app.
#
# ## It takes no environment argument
#
# Both applications live in one us5 org, and which is which is decided by the
# NAME, not by an org. Same reasoning as `apply-log-config.sh`: an argument that
# is silently accepted and ignored is how a mistyped dry run made 78 live
# requests against the sibling script.
#
# ## It is idempotent, and that is load-bearing rather than polite
#
# A RUM application's `client_token` is generated once at creation. Running this
# twice without the existence check would mint a SECOND application with the same
# name and a different id, and nothing downstream would complain: the browser
# would report into one, and the credentials this script printed last time point
# at the other. So it LISTS first and creates only what is missing.
#
# The check matches on NAME **and** `type`. Datadog does not enforce unique RUM
# application names, and the types are separate namespaces — a future
# `stockbook-web` of type `ios` would otherwise be "found", reused, and its
# credentials printed into the Vercel table for the browser app.
#
# ## What the NAMES are, and what they are NOT
#
# This header used to say the names are the ones `apply-service-monitors.sh`
# queries, so a rename here silently detaches the RUM monitors. THAT IS FALSE.
# `apps/web/lib/datadog/rum-init.ts` hardcodes `service: "stockbook-web"` for
# BOTH environments and takes `env` from `NEXT_PUBLIC_DD_ENV`, so RUM events
# join on `service` + `env` and the application NAME appears in no query
# anywhere. Renaming one here costs exactly one thing: the next run of this
# script stops recognising it and mints a duplicate.
#
# The pairing that IS silent, and is the reason this prints a table rather than
# a wall of JSON, is `application_id`/`client_token` against
# `NEXT_PUBLIC_DD_ENV`. Paste the prod pair into the qa Vercel project and qa's
# sessions land in the prod application while still reporting
# `service:stockbook-web, env:qa` — so the monitors keep matching, the
# dashboards keep drawing, and NOTHING downstream can detect it. The three
# lines are printed as one block per environment for that reason, and
# `rum-apps-agreement.test.ts` pins that each block carries its own token.
#
# ## Where the values may safely go
#
# `application_id` and `client_token` are browser credentials by design — they
# ship inside the JavaScript bundle, and Datadog's own position is that API keys
# cannot be used from a browser precisely because they would be exposed, which
# is what client tokens exist to replace. A client token is WRITE-ONLY ingest: it
# cannot read a single event back out. So they belong in `NEXT_PUBLIC_*`.
#
# The API and application keys used to CREATE them are the opposite, and never
# reach a command line — see `dd_credential_config` in lib-datadog.sh.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

DRY_RUN=false
while [[ $# -gt 0 ]]; do
  case "$1" in
    --dry-run) DRY_RUN=true ;;
    *) echo "unknown argument: $1" >&2
       echo "usage: $(basename "$0") [--dry-run]   (no environment argument — both apps live in one org)" >&2
       exit 2 ;;
  esac
  shift
done

# shellcheck source=./lib-datadog.sh
source "$HERE/lib-datadog.sh"
dd_resolve_api_host || exit 1

if ! $DRY_RUN; then
  : "${DD_API_KEY:?export DD_API_KEY first (GCP Secret Manager: DD_API_KEY_PROD)}"
  : "${DD_APP_KEY:?export DD_APP_KEY first (GCP Secret Manager: DD_APP_KEY_PROD)}"
fi

# name -> the NEXT_PUBLIC_DD_ENV that environment ships.
#
# The name is how a HUMAN tells the two applications apart in the Datadog UI,
# and how THIS script recognises one it already created. It is not a join key:
# the monitors query `service:stockbook-web` + `env:…`, both of which come from
# `rum-init.ts` and Vercel, never from here.
APPS=(
  "stockbook-web|production"
  "stockbook-web-qa|qa"
)

if $DRY_RUN; then
  echo "would POST https://${DD_API_HOST}/api/v2/rum/applications for each MISSING name:"
  for row in "${APPS[@]}"; do
    IFS='|' read -r name env <<< "$row"
    NAME="$name" node -e '
      process.stdout.write(JSON.stringify({
        data: { type: "rum_application_create",
                attributes: { name: process.env.NAME, type: "browser" } },
      }) + "\n");
    '
  done
  echo ""
  echo "dry run: no request was made, and nothing was listed"
  exit 0
fi

# ---- what already exists ------------------------------------------------------
# The LIST endpoint deliberately omits `client_token`, so an existing app is
# re-read individually below rather than assumed lost.
if ! dd_request GET "https://${DD_API_HOST}/api/v2/rum/applications"; then
  echo "FATAL: could not list RUM applications (HTTP ${RESPONSE_STATUS})" >&2
  echo "${RESPONSE_BODY}" >&2
  exit 1
fi

EXISTING="$(BODY="$RESPONSE_BODY" node -e '
  let d;
  try { d = JSON.parse(process.env.BODY); } catch {
    console.error("the RUM listing was not JSON — refusing to create anything");
    process.exit(1);
  }
  if (!Array.isArray(d?.data)) {
    console.error("the RUM listing had no data[] — refusing to create anything");
    process.exit(1);
  }
  // name<TAB>type<TAB>id, one per line. The TYPE is carried because a name
  // alone is not an identity here: Datadog allows duplicate RUM application
  // names, and browser/ios/android are separate kinds of application.
  for (const a of d.data) {
    process.stdout.write(
      `${a?.attributes?.name ?? ""}\t${a?.attributes?.type ?? ""}\t${a?.id ?? ""}\n`,
    );
  }
')" || exit 1

echo "found $(printf '%s\n' "$EXISTING" | grep -c . || true) existing RUM application(s)"
echo ""

CREATED=0
REUSED=0
declare -a TABLE=()

for row in "${APPS[@]}"; do
  IFS='|' read -r name env <<< "$row"
  # Name AND type. An EMPTY type still matches, deliberately: the two failures
  # are not symmetric. Refusing to reuse an application whose type we could not
  # read mints a duplicate browser app and splits the sessions in half, while
  # accepting one is the behaviour this script already had. Only a type that is
  # PRESENT and different is a reason to create.
  id="$(printf '%s\n' "$EXISTING" \
    | awk -F'\t' -v n="$name" '$1 == n && ($2 == "browser" || $2 == "") { print $3; exit }')"

  if [[ -n "$id" ]]; then
    echo "reusing existing: ${name} (${id})"
    if ! dd_request GET "https://${DD_API_HOST}/api/v2/rum/applications/${id}"; then
      echo "FATAL: ${name} exists but could not be read back (HTTP ${RESPONSE_STATUS})" >&2
      exit 1
    fi
    REUSED=$((REUSED + 1))
  else
    echo "creating: ${name}"
    payload="$(NAME="$name" node -e '
      process.stdout.write(JSON.stringify({
        data: { type: "rum_application_create",
                attributes: { name: process.env.NAME, type: "browser" } },
      }));
    ')"
    # NOTE the success status is 200, not the 201 a create usually answers.
    if ! dd_request POST "https://${DD_API_HOST}/api/v2/rum/applications" "$payload"; then
      echo "FATAL: could not create ${name} (HTTP ${RESPONSE_STATUS})" >&2
      echo "${RESPONSE_BODY}" >&2
      exit 1
    fi
    CREATED=$((CREATED + 1))
  fi

  pair="$(BODY="$RESPONSE_BODY" NAME="$name" node -e '
    const a = JSON.parse(process.env.BODY)?.data?.attributes ?? {};
    const id = a.application_id, tok = a.client_token;
    // Refuse a half-answer rather than print an empty variable into a table
    // somebody is about to paste into Vercel. A blank NEXT_PUBLIC_DD_CLIENT_TOKEN
    // disables RUM silently — the SDK simply never sends.
    if (!id || !tok) {
      console.error(`${process.env.NAME}: response carried no application_id/client_token`);
      process.exit(1);
    }
    process.stdout.write(`${id}\t${tok}\n`);
  ')" || exit 1

  TABLE+=("${name}|${env}|${pair}")
done

echo ""
echo "created ${CREATED}, reused ${REUSED} of ${#APPS[@]}"
echo ""
echo "─────────────────────────────────────────────────────────────────────────"
echo " Set these on Vercel. Nothing in this repo touches Vercel."
echo "─────────────────────────────────────────────────────────────────────────"
for row in "${TABLE[@]}"; do
  IFS='|' read -r name env pair <<< "$row"
  IFS=$'\t' read -r appid token <<< "$pair"
  target="web prod"
  [[ "$env" == "qa" ]] && target="web qa"
  echo ""
  echo "# ${target}  (Datadog RUM application: ${name})"
  echo "NEXT_PUBLIC_DD_APPLICATION_ID=${appid}"
  echo "NEXT_PUBLIC_DD_CLIENT_TOKEN=${token}"
  echo "NEXT_PUBLIC_DD_ENV=${env}"
done
echo ""
echo "Also on both web projects: DD_SERVICE=stockbook-web, DD_TRACE_ENABLED=false,"
echo "DD_ENV matching NEXT_PUBLIC_DD_ENV, and DD_API_KEY from the matching secret."
echo "DD_TRACE_ENABLED is false because dd-trace needs a local agent on"
echo "localhost:8126 and Vercel has none; logs and metrics still go over HTTP."
