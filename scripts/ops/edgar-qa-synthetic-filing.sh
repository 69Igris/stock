#!/usr/bin/env bash
#
# edgar-qa-synthetic-filing.sh — prove detection -> parse -> store on QA
# WITHOUT sending a single byte to sec.gov. MONEY-979 T12.
#
# Uploads ONE committed fixture bundle to the QA archive at the exact key the
# client would read, publishes ONE `edgar-parse-ownership` message, polls
# `us_insider_transactions` for the row, prints the measured latency, and then
# asserts from the service's own logs that `SEC_EGRESS=off` produced ZERO
# network attempts.
#
# Usage:
#   ./scripts/ops/edgar-qa-synthetic-filing.sh qa
#   ./scripts/ops/edgar-qa-synthetic-filing.sh qa --dry-run
#   ./scripts/ops/edgar-qa-synthetic-filing.sh qa --timeout=300
#
# ── WHY THIS EXISTS, AND WHY IT IS QA-ONLY ────────────────────────────────────
#
# QA runs `SEC_EGRESS=off`: every client method raises `SecEgressDisabled`
# BEFORE a socket exists. That is not a convention, it is the reason two
# environments can coexist against SEC's PER-IP fair-access limit — Cloud Run
# has shared egress IPs, so two armed environments would spend one budget and
# get both blocked.
#
# The consequence is that QA cannot fetch a filing to test with. This script is
# the answer: it puts the bytes where `SecClient.fetch_bundle` looks FIRST
# (`edgar/filings/{cik10}/{accession}/submission.txt`), so the archive HITS and
# the fetch never happens. Every stage downstream of the fetch — envelope,
# OIDC, dedupe, dispatch, the ownership parser, the writer, the job outcome — is
# exercised against real SEC bytes.
#
# It refuses to run against prod. Prod fetches its own bundles; a synthetic
# filing there would put a hand-placed object into the permanent archive that
# `edgar/filings/**` is supposed to hold verbatim from SEC.
#
# ── THE ZERO-EGRESS ASSERTION NEEDS A VERIFIED CEILING ────────────────────────
#
# "grep the logs for SecEgressDisabled, find none, declare no network attempts"
# is exactly the shape that hid the Tickertape block for five months: a check
# whose PASS is indistinguishable from its never having run. Three things make
# it falsifiable here, and all three are enforced:
#
#   1. SEC_EGRESS is READ OFF THE LIVE SERVICE and must be the literal string
#      "off". If it is "archive", a zero SecEgressDisabled count means the
#      opposite of what it looks like — the fetch was ALLOWED — so the script
#      refuses rather than reporting a pass.
#   2. The log query is bounded to THIS RUN (a timestamp captured before the
#      publish), so a clean window cannot be inherited from yesterday.
#   3. A POSITIVE CONTROL: the same query must return SOME log lines for the
#      service in the window. Zero lines means the logs have not landed or the
#      filter is wrong, and the verdict is INCONCLUSIVE — never PASS.
#
# ── WHAT THIS SCRIPT WILL NOT DO ──────────────────────────────────────────────
#
# It does not arm `EDGAR_PARSE_APPLY`. With the flag at its shipped "false" the
# handler parses the filing fully, counts honestly and writes NOTHING — so the
# poll would time out on a service that is working perfectly. The script
# PREFLIGHTS the flag and prints the exact arming command rather than flipping a
# release flag as a side effect of a test.
#
# It does not delete the uploaded object afterwards. Those bytes are a real SEC
# bundle at the key prod would have archived it under; leaving it makes a re-run
# idempotent and costs one 14 KB object. There is no destructive path in this
# script at all.
#
set -uo pipefail

RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; BLUE='\033[0;34m'; NC='\033[0m'

PROJECT_ID="stock-book-483718"
REGION="asia-south1"
ACCOUNT="founder@disdigital.in"
SERVICE_PREFIX="us-fundamentals"
BASE_TOPIC="edgar-parse-ownership"

REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
FIXTURE="${REPO_ROOT}/services/us-fundamentals/tests/fixtures/form4_jefferies.txt.gz"
MANIFEST="${REPO_ROOT}/services/us-fundamentals/tests/fixtures/manifest.json"

# ── The filing, and why these two values must agree ───────────────────────────
#
# `SecClient.fetch_bundle(cik10, accession)` builds the archive key from the
# message's OWN cik10, so the object we upload and the message we publish have
# to use the same one or the read misses and — with egress off — raises
# SecEgressDisabled instead of parsing. They are one variable here so they
# cannot drift.
#
# The CIK is the FILER's (the reporting owner, Richard B Handler, 0001211677) —
# the same one in the SEC URL this fixture was captured from. The ISSUER is
# Jefferies, 0000096223, and that is what lands in `issuerCik10` on the row. The
# poll keys on the ACCESSION, which is unambiguous either way.
ACCESSION="0001214659-26-011109"
CIK10="0001211677"
FORM="4"
MANIFEST_KEY="form4_bundle"
COLLECTION="us_insider_transactions"

# Poll cadence. The reported latency is quantised to this, and the script says
# so rather than letting 2s of granularity read as 2s of pipeline latency.
POLL_INTERVAL=2
TIMEOUT=180
DRY_RUN=false

ENV="${1:-}"
shift || true

while [ $# -gt 0 ]; do
    case "$1" in
        --dry-run)     DRY_RUN=true; shift ;;
        --timeout=*)
            TIMEOUT="${1#*=}"
            # Validated, not trusted. `$((PUBLISH_EPOCH + TIMEOUT))` on a
            # non-number yields a deadline in the past, so the poll would exit
            # instantly and report "the filing never arrived" — a parser whose
            # failure mode is a WRONG ANSWER rather than an error.
            case "$TIMEOUT" in
                ''|*[!0-9]*) echo "--timeout needs whole seconds, got '${TIMEOUT}'" >&2; exit 2 ;;
            esac
            [ "$TIMEOUT" -gt 0 ] || { echo "--timeout must be > 0" >&2; exit 2; }
            shift ;;
        *) echo "Unknown option: $1" >&2; exit 2 ;;
    esac
done

if [ "$ENV" != "qa" ]; then
    cat >&2 <<EOF
Usage: $0 qa [--dry-run] [--timeout=SECS]

QA ONLY, deliberately. Prod fetches its own bundles from SEC; a synthetic
filing there would place a hand-made object inside edgar/filings/**, which is
supposed to hold SEC's bytes verbatim and forever.

  --dry-run        print every command and touch nothing
  --timeout=SECS   how long to poll ${COLLECTION} (default ${TIMEOUT})
EOF
    exit 2
fi

SERVICE="${SERVICE_PREFIX}-${ENV}"
TOPIC="${BASE_TOPIC}-${ENV}"
DB_SECRET="DATABASE_URL_QA"

# Per-command isolation: never activate a gcloud config, always pass the
# account and project explicitly.
GC=(env CLOUDSDK_ACTIVE_CONFIG_NAME=stockbook gcloud --project="$PROJECT_ID" --account="$ACCOUNT")

say()  { echo -e "$@"; }
step() { echo -e "\n${BLUE}━━━ $* ━━━${NC}"; }
die()  { echo -e "\n${RED}FAILED: $*${NC}" >&2; exit 1; }

# Render a command SHELL-QUOTED, so a dry-run line can be pasted verbatim.
# Plain "$*" mangles anything containing a space or a semicolon — the
# `--content-type=text/plain; charset=utf-8` argument would print as two
# commands, one of which is `charset=utf-8`.
quoted() {
    local out="" arg
    for arg in "$@"; do
        case "$arg" in
            # Plain enough to print bare. Anything else gets single-quoted, with
            # an embedded quote closed and reopened the only way that works.
            *[!A-Za-z0-9_@%+=:,./-]*|"")
                out="${out}'$(printf '%s' "$arg" | sed "s/'/'\\\\''/g")' " ;;
            *)  out="${out}${arg} " ;;
        esac
    done
    printf '%s' "${out% }"
}

# Print a command in dry-run, run it otherwise.
run() {
    if [ "$DRY_RUN" = true ]; then
        echo "   [dry-run] $(quoted "$@")"
        return 0
    fi
    "$@"
}

# ── 1. Local preflight ────────────────────────────────────────────────────────

step "1/7  Local preflight"

command -v gcloud  >/dev/null 2>&1 || die "gcloud is not on PATH"
command -v gunzip  >/dev/null 2>&1 || die "gunzip is not on PATH"
command -v python3 >/dev/null 2>&1 || die "python3 is not on PATH (needed to read the fixture manifest)"
if [ "$DRY_RUN" = false ]; then
    command -v mongosh >/dev/null 2>&1 || die "mongosh is not on PATH — needed to poll ${COLLECTION}"
fi

[ -f "$FIXTURE" ] || die "fixture missing: ${FIXTURE}"

# The manifest records the sha256 of the bytes as they were captured from SEC.
# Checking it here means a swapped or re-compressed fixture fails LOUDLY instead
# of being uploaded to the archive under a real accession, where it would be
# indistinguishable from the genuine filing forever.
EXPECTED_SHA=$(python3 -c "
import json,sys
m = json.load(open('${MANIFEST}'))
e = m.get('${MANIFEST_KEY}')
print(e['sha256'] if e else '')
")
[ -n "$EXPECTED_SHA" ] || die "manifest has no '${MANIFEST_KEY}' entry"

TMPDIR_RUN="$(mktemp -d)"
trap 'rm -rf "$TMPDIR_RUN"' EXIT
PLAIN="${TMPDIR_RUN}/submission.txt"

# Decompress. The archive holds RAW bundle bytes — `archive.read_bytes` returns
# them straight to the parser — so uploading the .gz would hand the parser a
# gzip stream and every field would come back empty. Uploading with
# `Content-Encoding: gzip` instead is worse: GCS may or may not transcode
# depending on the client, which makes the same object parse on one path and not
# on another.
gunzip -c "$FIXTURE" > "$PLAIN" || die "could not gunzip ${FIXTURE}"

ACTUAL_SHA=$(shasum -a 256 "$PLAIN" | awk '{print $1}')
[ "$ACTUAL_SHA" = "$EXPECTED_SHA" ] || die \
    "fixture sha256 mismatch — manifest ${EXPECTED_SHA}, decompressed ${ACTUAL_SHA}"

PLAIN_BYTES=$(wc -c < "$PLAIN" | tr -d ' ')
say "   fixture   $(basename "$FIXTURE")"
say "   sha256    ${GREEN}${ACTUAL_SHA}${NC}  (matches manifest)"
say "   bytes     ${PLAIN_BYTES} decompressed"
say "   accession ${ACCESSION}   cik10 ${CIK10}   form ${FORM}"

# ── 2. Live service preflight — the verified ceiling ─────────────────────────

step "2/7  Live service preflight (${SERVICE})"

DESCRIBE_FORMAT='value[delimiter="|"](spec.template.spec.containers[0].env.filter("name:SEC_EGRESS").extract("value").flatten(),spec.template.spec.containers[0].env.filter("name:EDGAR_PARSE_APPLY").extract("value").flatten(),spec.template.spec.containers[0].env.filter("name:GCP_STORAGE_BUCKET").extract("value").flatten())'

if [ "$DRY_RUN" = true ]; then
    echo "   [dry-run] $(quoted "${GC[@]}" run services describe "$SERVICE" --region="$REGION" --format="$DESCRIBE_FORMAT")"
    # Assumed values, and SAID to be assumed. A dry run must never look like it
    # verified the ceiling it did not read.
    SEC_EGRESS="off"; PARSE_APPLY="true"; BUCKET="stockbook-content-qa"
    say "   [dry-run] ASSUMING SEC_EGRESS=off  EDGAR_PARSE_APPLY=true  bucket=${BUCKET}"
    say "   [dry-run] a real run READS these off the live service and refuses on any other value"
else
    DESCRIBE=$("${GC[@]}" run services describe "$SERVICE" \
        --region="$REGION" --format="$DESCRIBE_FORMAT" 2>/dev/null)
    [ -n "$DESCRIBE" ] || die "could not describe ${SERVICE} in ${REGION}. Is it deployed?"
    SEC_EGRESS="$(echo "$DESCRIBE"  | cut -d'|' -f1)"
    PARSE_APPLY="$(echo "$DESCRIBE" | cut -d'|' -f2)"
    BUCKET="$(echo "$DESCRIBE"      | cut -d'|' -f3)"
fi

say "   SEC_EGRESS         ${SEC_EGRESS:-<unset>}"
say "   EDGAR_PARSE_APPLY  ${PARSE_APPLY:-<unset>}"
say "   GCP_STORAGE_BUCKET ${BUCKET:-<unset>}"

# FAIL CLOSED, on the LITERAL string. `[ -n "$SEC_EGRESS" ]` would pass for
# "archive", and `bool("false")` being true is the same family of bug this repo
# has already paid for twice.
if [ "$SEC_EGRESS" != "off" ]; then
    die "SEC_EGRESS on ${SERVICE} is '${SEC_EGRESS:-<unset>}', not 'off'.

  The whole point of this script is to assert that a parse ran with ZERO
  network attempts. With egress ALLOWED, finding no SecEgressDisabled in the
  logs means the fetch was permitted — the exact opposite of a pass, and
  indistinguishable from one. Refusing rather than reporting a green tick.

  An UNSET value is its own problem: absent and deliberately-off must not be
  the same state (MONEY-1214)."
fi

if [ "$PARSE_APPLY" != "true" ]; then
    die "EDGAR_PARSE_APPLY on ${SERVICE} is '${PARSE_APPLY:-<unset>}', not 'true'.

  With the flag off the handler parses the filing FULLY, counts honestly and
  writes NOTHING — so the poll below would time out against a service that is
  working perfectly, and read as a broken pipeline.

  This script will not arm a release flag as a side effect of a test. Arm it
  deliberately, run this, then decide whether to leave it armed:

    CLOUDSDK_ACTIVE_CONFIG_NAME=stockbook gcloud run services update ${SERVICE} \\
      --region=${REGION} --project=${PROJECT_ID} --account=${ACCOUNT} \\
      --update-env-vars=EDGAR_PARSE_APPLY=true"
fi

[ -n "$BUCKET" ] || die "GCP_STORAGE_BUCKET is unset on ${SERVICE}; the archive read has nowhere to look"

if [ "$DRY_RUN" = true ]; then
    echo "   [dry-run] $(quoted "${GC[@]}" pubsub topics describe "$TOPIC")"
else
    "${GC[@]}" pubsub topics describe "$TOPIC" >/dev/null 2>&1 \
        || die "topic ${TOPIC} does not exist. Run workers/scripts/setup-pubsub.sh ${ENV} first."
fi
say "   topic              ${GREEN}${TOPIC}${NC}"

# ── 3. The archive object ─────────────────────────────────────────────────────

step "3/7  Upload the bundle to the key the client reads FIRST"

KEY="edgar/filings/${CIK10}/${ACCESSION}/submission.txt"
URI="gs://${BUCKET}/${KEY}"
say "   ${URI}"

# `text/plain; charset=utf-8` is `archive.BUNDLE_CONTENT_TYPE` verbatim. Not
# cosmetic: it is what prod writes, so a QA object with a different type would
# make the two environments' archives subtly different objects.
run "${GC[@]}" storage cp "$PLAIN" "$URI" --content-type="text/plain; charset=utf-8" \
    || die "upload failed"

if [ "$DRY_RUN" = true ]; then
    echo "   [dry-run] $(quoted "${GC[@]}" storage ls --long "$URI")   # verify the stored byte count"
else
    REMOTE_BYTES=$("${GC[@]}" storage ls --long "$URI" 2>/dev/null | awk 'NR==1{print $1}')
    if [ "$REMOTE_BYTES" != "$PLAIN_BYTES" ]; then
        die "uploaded object is ${REMOTE_BYTES:-<absent>} bytes, expected ${PLAIN_BYTES}.
  A size mismatch here is usually GCS transcoding a gzip stream. The parser
  would receive bytes that are not the filing and report a clean parse of
  nothing."
    fi
    say "   ${GREEN}uploaded and verified ${REMOTE_BYTES} bytes${NC}"
fi

# ── 4. Baselines, captured BEFORE the publish ────────────────────────────────

step "4/7  Baselines"

# ISO-8601 UTC, to the second. Everything after this is measured against it: the
# log window and the row's own `updatedAt`. Captured BEFORE the publish so a
# clean log window can never be inherited from a previous run.
T0_ISO=$(date -u +"%Y-%m-%dT%H:%M:%SZ")
T0_EPOCH=$(date -u +%s)
say "   run marker  ${T0_ISO}"

# The row is upserted on (accession, rowIndex), so a re-run does not create new
# rows — it bumps `updatedAt`. Polling for `updatedAt > T0` therefore works on
# the first run AND on every re-run, without this script ever deleting anything.
if [ "$DRY_RUN" = true ]; then
    echo "   [dry-run] $(quoted "${GC[@]}" secrets versions access latest --secret="${DB_SECRET}")"
    echo "   [dry-run] the URL is echoed back MASKED, never raw"
else
    DB_URL=$("${GC[@]}" secrets versions access latest --secret="${DB_SECRET}" 2>/dev/null)
    [ -n "$DB_URL" ] || die "could not read ${DB_SECRET} from Secret Manager"
    # Masked, always. A redactor that prints the raw string when its pattern
    # misses is worse than none, so anything unrecognised collapses to the
    # scheme (the run-market-data-job.sh lesson).
    MASKED=$(printf '%s' "$DB_URL" | sed -E 's#^([a-z+]+://)[^:/@]+:[^@]+@([^/?,]+).*#\1***:***@\2#')
    case "$MASKED" in
        "$DB_URL") MASKED="${DB_URL%%://*}://<redacted>" ;;
    esac
    say "   database    ${MASKED}"
fi

# ── 5. Publish ────────────────────────────────────────────────────────────────

step "5/7  Publish one ${BASE_TOPIC} message"

# NO `acceptedAt`. The dispatcher falls back to the bundle's own
# <ACCEPTANCE-DATETIME> when the message omits it, and that is the honest value.
# Stamping "now" would fabricate an acceptance time, which downstream becomes a
# latency MEASUREMENT of something that never happened.
MESSAGE=$(printf '{"accession":"%s","cik10":"%s","form":"%s"}' "$ACCESSION" "$CIK10" "$FORM")
say "   ${MESSAGE}"

PUBLISH_EPOCH=$(date -u +%s)
run "${GC[@]}" pubsub topics publish "$TOPIC" --message="$MESSAGE" \
    || die "publish to ${TOPIC} failed"

# ── 6. Poll for the row ───────────────────────────────────────────────────────

step "6/7  Poll ${COLLECTION} for accession ${ACCESSION}"

if [ "$DRY_RUN" = true ]; then
    echo "   [dry-run] mongosh \"\$DATABASE_URL\" --quiet --eval \\"
    echo "       'db.${COLLECTION}.countDocuments({accession:\"${ACCESSION}\", updatedAt:{\$gt:new Date(\"${T0_ISO}\")}})'"
    echo "   [dry-run] repeated every ${POLL_INTERVAL}s for up to ${TIMEOUT}s"
    ROWS=0
    ELAPSED=0
else
    ROWS=0
    ELAPSED=0
    DEADLINE=$((PUBLISH_EPOCH + TIMEOUT))
    while [ "$(date -u +%s)" -lt "$DEADLINE" ]; do
        COUNT=$(mongosh "$DB_URL" --quiet --eval \
            "db.${COLLECTION}.countDocuments({accession:'${ACCESSION}', updatedAt:{\$gt:new Date('${T0_ISO}')}})" \
            2>/dev/null | tr -dc '0-9')
        if [ -n "$COUNT" ] && [ "$COUNT" -gt 0 ] 2>/dev/null; then
            ROWS="$COUNT"
            ELAPSED=$(( $(date -u +%s) - PUBLISH_EPOCH ))
            break
        fi
        sleep "$POLL_INTERVAL"
    done

    if [ "$ROWS" -eq 0 ]; then
        say "${RED}   no row after ${TIMEOUT}s${NC}"
        say "   Look, in this order:"
        say "     1. the push subscription's delivery attempts:"
        say "        ${GC[*]} pubsub subscriptions describe ${TOPIC}-push"
        say "     2. the service log for this accession:"
        say "        ${GC[*]} logging read 'resource.labels.service_name=\"${SERVICE}\" AND textPayload:\"${ACCESSION}\"' --freshness=10m"
        say "     3. whether the parse reported SecEgressDisabled — that means the"
        say "        archive key MISSED and it fell through to a fetch, so the object"
        say "        we uploaded is not where fetch_bundle looked. Compare:"
        say "        ${URI}"
        die "the filing never reached ${COLLECTION}"
    fi

    say "   ${GREEN}${ROWS} row(s) written${NC}"
    say "   latency     ~${ELAPSED}s from publish to first observed row"
    say "               (quantised to the ${POLL_INTERVAL}s poll interval — this is an"
    say "                UPPER bound on the pipeline's own latency, not a measurement"
    say "                of it. The metric to trust is stockbook.job.written in Datadog.)"
fi

# ── 7. The zero-egress assertion ──────────────────────────────────────────────

step "7/7  Assert SEC_EGRESS=off produced ZERO network attempts"

LOG_FILTER="resource.type=\"cloud_run_revision\" AND resource.labels.service_name=\"${SERVICE}\" AND timestamp>=\"${T0_ISO}\""

if [ "$DRY_RUN" = true ]; then
    echo "   [dry-run] $(quoted "${GC[@]}" logging read "$LOG_FILTER" --limit=1000 --format='value(textPayload,jsonPayload.message,jsonPayload.event)')"
    echo "   [dry-run] then: count total lines (positive control) and grep SecEgressDisabled"
    say "\n${YELLOW}DRY RUN — nothing was uploaded, published, read or asserted.${NC}"
    exit 0
fi

# Cloud Logging ingestion is not instant. One short wait, then read.
sleep 10

LOGS=$("${GC[@]}" logging read "$LOG_FILTER" \
    --limit=1000 \
    --format='value(textPayload,jsonPayload.message,jsonPayload.event)' 2>/dev/null)

TOTAL_LINES=$(printf '%s\n' "$LOGS" | grep -c . || true)
EGRESS_HITS=$(printf '%s\n' "$LOGS" | grep -c "SecEgressDisabled" || true)

say "   window      since ${T0_ISO}"
say "   log lines   ${TOTAL_LINES}"
say "   SecEgressDisabled occurrences: ${EGRESS_HITS}"

# THE POSITIVE CONTROL. A zero-hit grep over a zero-line window proves nothing
# at all, and reporting it as a pass is precisely how a check becomes decoration.
if [ "$TOTAL_LINES" -eq 0 ]; then
    say "\n${YELLOW}INCONCLUSIVE — the log query returned NO lines for ${SERVICE}"
    say "since ${T0_ISO}. Zero SecEgressDisabled out of zero log lines is not"
    say "evidence of anything. Either the logs have not landed yet (re-run this"
    say "step in a minute) or the filter no longer matches the service.${NC}"
    say "\n  ${GC[*]} logging read '${LOG_FILTER}' --limit=20"
    exit 1
fi

if [ "$EGRESS_HITS" -ne 0 ]; then
    say "\n${RED}NETWORK ATTEMPT DETECTED — ${EGRESS_HITS} SecEgressDisabled in the window.${NC}"
    say ""
    say "  The parse tried to FETCH. With SEC_EGRESS=off that raise is the guard"
    say "  working, but it means the archive read MISSED: the object is not at"
    say "  the key fetch_bundle built. The two spellings to compare are"
    say "    uploaded : ${KEY}"
    say "    expected : edgar/filings/<message cik10>/<accession>/submission.txt"
    say "  and the message carried cik10=${CIK10}."
    exit 1
fi

# ── Verdict ───────────────────────────────────────────────────────────────────

cat <<EOF

────────────────────────────────────────────────────────────────
${SERVICE}: detection -> parse -> store, PROVEN, with no SEC traffic.

  bundle      ${URI}
  message     ${TOPIC}  ${MESSAGE}
  rows        ${ROWS} in ${COLLECTION} (accession ${ACCESSION})
  latency     <= ${ELAPSED}s publish -> row  (${POLL_INTERVAL}s poll granularity)
  egress      SEC_EGRESS=off, ${TOTAL_LINES} log lines examined,
              0 SecEgressDisabled -> the archive HIT and no fetch was attempted

The object is left in place deliberately. It is a real SEC bundle at the key
prod would archive it under, so a re-run is idempotent and costs nothing.

REMEMBER EDGAR_PARSE_APPLY. It had to be "true" for this run. If QA is meant to
sit at its shipped "false", put it back:

  CLOUDSDK_ACTIVE_CONFIG_NAME=stockbook gcloud run services update ${SERVICE} \\
    --region=${REGION} --project=${PROJECT_ID} --account=${ACCOUNT} \\
    --update-env-vars=EDGAR_PARSE_APPLY=false
────────────────────────────────────────────────────────────────
EOF
