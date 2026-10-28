#!/usr/bin/env bash
#
# kite-app-provision.sh — headless automation of the Zerodha KiteConnect
# *developer portal* (https://developers.kite.trade). Founder ops tooling.
#
# It chains ONLY the browser requests captured from the portal — no trading
# login (kite.zerodha.com), no undocumented endpoints:
#
#   GET  /login            bootstrap Django CSRF (csrftoken cookie + form token)
#   POST /login            email + password  ->  sessionid cookie
#   GET  /apps             list apps (api_key)
#   GET  /create           fresh CSRF form token
#   POST /create           multipart create  ->  302 /apps/<api_key>
#   GET  /apps/<api_key>   scrape api_key + api_secret
#
# The only "tokens" involved are Django's CSRF token and the session cookie,
# and this script scrapes/carries both itself. So the ONLY human input is
# KITE_DEV_EMAIL + KITE_DEV_PASSWORD — no manual token generation, no browser.
#
# The api_secret is rendered directly in the /apps/<api_key> HTML (the portal's
# "Show API secret" button is a client-side toggle), so reading it needs no
# regenerate — it is fetched, never rotated.
#
# Usage:
#   export KITE_DEV_EMAIL='founder@disdigital.in'
#   export KITE_DEV_PASSWORD='********'
#
#   ./kite-app-provision.sh list
#   ./kite-app-provision.sh fetch <api_key>
#   ./kite-app-provision.sh create \
#        --name 'Shaswat Deep' --client-id UN1836 \
#        --redirect http://localhost:3000/api/brokers/zerodha/callback \
#        --description 'portfolio sync' [--type personal|connect|publisher] [--postback URL]
#
# Output (fetch / create) — two lines, secret is SENSITIVE:
#   api_key=<16-char slug>
#   api_secret=<32-char secret>
#
set -euo pipefail

BASE='https://developers.kite.trade'
# A browser-like UA is required — Cloudflare fronts the portal but does not
# JS-challenge these requests when the UA looks like a real browser.
UA='Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.0.0 Safari/537.36'
JAR="$(mktemp -t kite-jar.XXXXXX)"
trap 'rm -f "$JAR"' EXIT

die() { printf '%s\n' "$*" >&2; exit 1; }

# Django renders the token single- OR double-quoted; handle both.
csrf_token() {
  grep -oE "name=['\"]csrfmiddlewaretoken['\"][^>]*value=['\"][A-Za-z0-9]+" \
    | head -1 | sed -E "s/.*value=['\"]//"
}

login() {
  : "${KITE_DEV_EMAIL:?set KITE_DEV_EMAIL}"
  : "${KITE_DEV_PASSWORD:?set KITE_DEV_PASSWORD}"
  local tok
  # 1) GET /login -> csrftoken cookie into the jar + the matching form token
  tok="$(curl -sS -A "$UA" -c "$JAR" -b "$JAR" "$BASE/login" | csrf_token)" || true
  [ -n "${tok:-}" ] || die '[login] could not read CSRF token from /login (Cloudflare?)'
  # 2) POST /login (same body shape as the captured login curl) -> sessionid
  curl -sS -A "$UA" -c "$JAR" -b "$JAR" -H "referer: $BASE/login" \
       --data-urlencode "csrfmiddlewaretoken=$tok" \
       --data-urlencode "email=$KITE_DEV_EMAIL" \
       --data-urlencode "password=$KITE_DEV_PASSWORD" \
       -o /dev/null "$BASE/login"
  # 3) verify the session: a logged-in /apps page offers "Create a new app"
  curl -sS -A "$UA" -b "$JAR" "$BASE/apps" | grep -qi 'create a new app' \
    || die '[login] failed — check KITE_DEV_EMAIL / KITE_DEV_PASSWORD'
}

# $1 = api_key -> prints api_key + api_secret (needs an active session in $JAR)
fetch_app() {
  local key="$1" html secret
  html="$(curl -sS -A "$UA" -b "$JAR" -H "referer: $BASE/apps" "$BASE/apps/$key")"
  secret="$(printf '%s' "$html" \
    | grep -oE 'api-secret-key-code[^>]*>[A-Za-z0-9]+' | head -1 \
    | grep -oE '[A-Za-z0-9]+$')" || true
  [ -n "${secret:-}" ] || die "[fetch] no api_secret on /apps/$key (bad key or session expired?)"
  printf 'api_key=%s\napi_secret=%s\n' "$key" "$secret"
}

cmd_list() {
  login
  curl -sS -A "$UA" -b "$JAR" -H "referer: $BASE/apps" "$BASE/apps" \
    | grep -oE 'data-api_key="[a-z0-9]{16}"' | grep -oE '[a-z0-9]{16}' | sort -u
}

cmd_fetch() { login; fetch_app "$1"; }

cmd_create() {
  local name='' client='' redirect='' desc='' type='personal' postback=''
  while [ $# -gt 0 ]; do
    case "$1" in
      --name)        name="$2";     shift 2;;
      --client-id)   client="$2";   shift 2;;
      --redirect)    redirect="$2"; shift 2;;
      --description) desc="$2";     shift 2;;
      --type)        type="$2";     shift 2;;
      --postback)    postback="$2"; shift 2;;
      *) die "unknown flag: $1";;
    esac
  done
  [ -n "$name" ] && [ -n "$client" ] && [ -n "$redirect" ] && [ -n "$desc" ] \
    || die 'create needs --name --client-id --redirect --description'
  login
  # GET /create -> fresh CSRF token
  local tok loc key
  tok="$(curl -sS -A "$UA" -c "$JAR" -b "$JAR" -H "referer: $BASE/apps" "$BASE/create" | csrf_token)" || true
  [ -n "${tok:-}" ] || die '[create] could not read CSRF token from /create'
  # POST /create (multipart, same fields as the captured create curl). The empty
  # "image" file part in the browser capture maps to "no icon" — omitted here as
  # it is an optional field. Capture the 302 Location to learn the new api_key.
  loc="$(curl -sS -A "$UA" -c "$JAR" -b "$JAR" -H "referer: $BASE/create" -o /dev/null -D - \
       -F "csrfmiddlewaretoken=$tok" \
       -F "type=$type" \
       -F "name=$name" \
       -F "zerodha_client_id=$client" \
       -F "redirect_url=$redirect" \
       -F "postback_url=$postback" \
       -F "description=$desc" \
       -F 'confirm=True' \
       "$BASE/create" | grep -i '^location:' | tr -d '\r' | awk '{print $2}')" || true
  key="$(printf '%s' "${loc:-}" | grep -oE '[a-z0-9]{16}' | head -1)" || true
  [ -n "${key:-}" ] || die "[create] no api_key in redirect (Location: ${loc:-<none>}) — duplicate name, or Connect app without credits?"
  fetch_app "$key"
}

case "${1:-}" in
  list)   shift; cmd_list "$@";;
  fetch)  shift; [ $# -ge 1 ] || die 'usage: fetch <api_key>'; cmd_fetch "$1";;
  create) shift; cmd_create "$@";;
  *) die "usage: $(basename "$0") {list | fetch <api_key> | create --name .. --client-id .. --redirect .. --description ..}";;
esac
